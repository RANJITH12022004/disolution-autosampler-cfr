/**
 * Master UART controller for Dissolution Auto Sampler + Bath Unit-2
 *
 * UART1 — Sampler:
 *   Master GPIO40 (TX) → Sampler GPIO40 (RX)
 *   Master GPIO39 (RX) ← Sampler GPIO39 (TX)
 *   GND common @ 9600
 *
 * UART2 — Bath (Hardware_disso):
 *   Master GPIO17 (TX) → Bath GPIO40 (RX)
 *   Master GPIO18 (RX) ← Bath GPIO1  (TX)
 *   GND common @ 9600
 *   Protocol: #COMMAND*  (SET-TEMP / PRE-HEAT / START-TEST / …)
 *
 * UART0 — Host / Supervisory control (external PLC/PC):
 *   Master GPIO41 (TX) → Host RX
 *   Master GPIO16 (RX) ← Host TX
 *   GND common @ 9600
 *   Protocol: #COMMAND*  (full machine control — see host_uart.h)
 */
#include <WiFi.h>
#include <WebServer.h>
#include <HardwareSerial.h>
#include "web.h"
#include "bath_uart.h"
#include "host_uart.h"

const char* WIFI_SSID = "Airtel_didi_0516";
const char* WIFI_PASS = "Air@99791";

// Crossed to sampler TX=39 RX=40
#define UART_TX_PIN  40
#define UART_RX_PIN  39
#define UART_BAUD    9600

HardwareSerial SlaveSerial(1);
WebServer server(80);

// ── Session defaults (also sent before run cmds) ────────────────
float g_smpFillSec = 35;
float g_rphFillSec = 30;
float g_dclFillSec = 30;
float g_tubeA = 1.4f, g_tubeB = 1.4f, g_tubeC = 1.4f, g_tubeD = 1.4f;
float g_airExtv = 0.8f;
bool  g_airAuto = true;

// ── UART RX log / last status ───────────────────────────────────
#define LOG_MAX 48
#define LOG_LEN 120
char g_logs[LOG_MAX][LOG_LEN];
int  g_logHead = 0, g_logCount = 0;
SemaphoreHandle_t g_logMux = NULL;

String g_lastRx = "";
String g_lastAck = "";
String g_lastCmt = "";
String g_lastErr = "";
String g_linkState = "BOOT";  // BOOT / IDLE / BUSY / ERROR / DONE
uint32_t g_lastRxMs = 0;
bool g_waitingCmt = false;
String g_pendingOp = "";

// Deferred sampling cycle (same sequence as Sampling UI: FLT → gap → SMP)
struct PendingSmpCycle {
    bool active;
    uint8_t phase;      // 0 = send FLT, 1 = send SMP
    uint32_t nextAtMs;
    float sv;
    float fh;
    int st;
    float flt;
    bool fromAuto;
};
PendingSmpCycle g_pendSmp = {false, 0, 0, 10, 5, 12, 35, false};

void addLog(const String& line) {
    if (!g_logMux) return;
    if (xSemaphoreTake(g_logMux, pdMS_TO_TICKS(50)) != pdTRUE) return;
    strncpy(g_logs[g_logHead], line.c_str(), LOG_LEN - 1);
    g_logs[g_logHead][LOG_LEN - 1] = 0;
    g_logHead = (g_logHead + 1) % LOG_MAX;
    if (g_logCount < LOG_MAX) g_logCount++;
    xSemaphoreGive(g_logMux);
}

void uartSend(const String& bodyNoHashStar);  // forward decl

/** Queue a full sampling cycle identical to the Sampling section (FLT then SMP). */
void queueSamplingCycle(float sv, float fh, int st, float flt, bool fromAuto) {
    if (flt < 0) flt = g_smpFillSec;
    if (flt < 1) flt = g_smpFillSec;
    g_smpFillSec = flt;
    g_pendSmp.active = true;
    g_pendSmp.phase = 0;
    g_pendSmp.nextAtMs = millis();  // send FLT ASAP
    g_pendSmp.sv = sv;
    g_pendSmp.fh = fh;
    g_pendSmp.st = constrain(st, 1, 99);
    g_pendSmp.flt = flt;
    g_pendSmp.fromAuto = fromAuto;
    g_waitingCmt = true;
    g_pendingOp = "SMP";
    g_linkState = "BUSY";
    addLog(String(fromAuto ? "Auto" : "Manual") +
           " SMP queued FLT-" + String(flt, 0) +
           " SV-" + String(sv, 0) + " FH-" + String(fh, 0) +
           " ST-" + String(st));
}

void pollPendingSampling() {
    if (!g_pendSmp.active) return;
    if ((int32_t)(millis() - g_pendSmp.nextAtMs) < 0) return;

    if (g_pendSmp.phase == 0) {
        // 1) Fill time — same as Sampling UI
        char fbuf[32];
        snprintf(fbuf, sizeof(fbuf), "SMP,FLT-%.0f", g_pendSmp.flt);
        uartSend(String(fbuf));
        g_pendSmp.phase = 1;
        g_pendSmp.nextAtMs = millis() + 40;  // gap so sampler accepts FLT before run
        return;
    }

    // 2) Run cycle — same frame as Sampling UI
    char buf[48];
    snprintf(buf, sizeof(buf), "SMP,SV-%.0f,FH-%.0f,ST-%d",
             g_pendSmp.sv, g_pendSmp.fh, g_pendSmp.st);
    uartSend(String(buf));
    g_waitingCmt = true;
    g_pendingOp = "SMP";
    g_linkState = "BUSY";

    if (g_pendSmp.fromAuto) {
        char hbuf[72];
        snprintf(hbuf, sizeof(hbuf), "#SMP-AUTO,ST-%d,SV-%.0f,FH-%.0f,FLT-%.0f*",
                 g_pendSmp.st, g_pendSmp.sv, g_pendSmp.fh, g_pendSmp.flt);
        hostForward(String(hbuf));
    }

    g_pendSmp.active = false;
}

void onBathSampleStart(uint8_t step, float sampleMl, float flushMl) {
    // Same path as Sampling section: FLT (session fill time) then SMP run
    queueSamplingCycle(sampleMl, flushMl, (int)step, g_smpFillSec, true);
}

void uartSend(const String& bodyNoHashStar) {
    String frame = "#" + bodyNoHashStar + "*";
    SlaveSerial.println(frame);
    addLog("TX " + frame);
}

void uartSendRawFrame(const String& frame) {
    String f = frame;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    SlaveSerial.println(f);
    addLog("TX " + f);
}

void handleSlaveLine(String line) {
    line.trim();
    if (line.length() == 0) return;
    g_lastRx = line;
    g_lastRxMs = millis();
    addLog("RX " + line);
    hostForward(line);  // mirror sampler events to host controller

    String body = line;
    if (body.startsWith("#")) body = body.substring(1);
    if (body.endsWith("*")) body = body.substring(0, body.length() - 1);
    body.trim();
    body.toUpperCase();

    if (body.startsWith("ERR")) {
        g_lastErr = line;
        g_linkState = "ERROR";
        g_waitingCmt = false;
        return;
    }
    if (body.indexOf(",ACK") >= 0 || body.endsWith("ACK")) {
        g_lastAck = line;
        if (body.indexOf("CMT") >= 0 || body.startsWith("CMT") || body.startsWith("INI,CMT")) {
            g_lastCmt = line;
            g_linkState = "DONE";
            g_waitingCmt = false;
            g_pendingOp = "";
        } else if (g_waitingCmt) {
            g_linkState = "BUSY";
        } else {
            g_linkState = "IDLE";
        }
        return;
    }
    if (body.startsWith("CMT") || body.indexOf(",CMT") >= 0) {
        g_lastCmt = line;
        g_linkState = "DONE";
        g_waitingCmt = false;
        g_pendingOp = "";
    }
}

void pollSlave() {
    static String buf;
    while (SlaveSerial.available()) {
        char c = (char)SlaveSerial.read();
        if (c == '\n' || c == '\r') {
            if (buf.length() > 0) { handleSlaveLine(buf); buf = ""; }
        } else if (buf.length() < 192) buf += c;
    }
}

// ── HTTP helpers ────────────────────────────────────────────────
float jf(const String& body, const char* k, float d) {
    String s = String("\"") + k + "\"";
    int i = body.indexOf(s);
    if (i < 0) return d;
    int c2 = body.indexOf(':', i + s.length());
    if (c2 < 0) return d;
    int v = c2 + 1;
    while (v < (int)body.length() && (body[v] == ' ' || body[v] == '\t')) v++;
    return body.substring(v).toFloat();
}
uint32_t ju(const String& body, const char* k, uint32_t d) {
    return (uint32_t)jf(body, k, (float)d);
}
String js(const String& body, const char* k, const String& d) {
    String s = String("\"") + k + "\"";
    int i = body.indexOf(s);
    if (i < 0) return d;
    int c2 = body.indexOf(':', i + s.length());
    if (c2 < 0) return d;
    int q1 = body.indexOf('"', c2 + 1);
    if (q1 < 0) return d;
    int q2 = body.indexOf('"', q1 + 1);
    if (q2 < 0) return d;
    return body.substring(q1 + 1, q2);
}

void sendCORS() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    server.send(204);
}

void handleRoot() { server.send_P(200, "text/html", MASTER_HTML); }

void handleStatus() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Cache-Control", "no-cache");
    String logsJson = "[";
    if (g_logMux && xSemaphoreTake(g_logMux, pdMS_TO_TICKS(80)) == pdTRUE) {
        int start = (g_logCount < LOG_MAX) ? 0 : g_logHead;
        int n = g_logCount;
        for (int i = 0; i < n; i++) {
            int idx = (start + i) % LOG_MAX;
            if (i) logsJson += ",";
            String e = g_logs[idx];
            e.replace("\\", "\\\\"); e.replace("\"", "\\\"");
            logsJson += "\"" + e + "\"";
        }
        xSemaphoreGive(g_logMux);
    }
    logsJson += "]";

    auto esc=[&](String s)->String{
        s.replace("\\","\\\\"); s.replace("\"","'"); s.replace("\n"," "); s.replace("\r"," ");
        return s;
    };
    String j = "{";
    j += "\"state\":\"" + esc(g_linkState) + "\",";
    j += "\"waiting\":" + String(g_waitingCmt ? "true" : "false") + ",";
    j += "\"pending\":\"" + esc(g_pendingOp) + "\",";
    j += "\"lastRx\":\"" + esc(g_lastRx) + "\",";
    j += "\"lastAck\":\"" + esc(g_lastAck) + "\",";
    j += "\"lastCmt\":\"" + esc(g_lastCmt) + "\",";
    j += "\"lastErr\":\"" + esc(g_lastErr) + "\",";
    j += "\"lastRxAgeMs\":" + String(g_lastRxMs ? (millis() - g_lastRxMs) : 0) + ",";
    j += "\"airAuto\":" + String(g_airAuto ? "true" : "false") + ",";
    j += "\"smpFillSec\":" + String(g_smpFillSec, 1) + ",";
    j += "\"rphFillSec\":" + String(g_rphFillSec, 1) + ",";
    j += "\"dclFillSec\":" + String(g_dclFillSec, 1) + ",";
    j += "\"airExtv\":" + String(g_airExtv, 2) + ",";
    j += "\"tubeA\":" + String(g_tubeA, 2) + ",\"tubeB\":" + String(g_tubeB, 2) + ",";
    j += "\"tubeC\":" + String(g_tubeC, 2) + ",\"tubeD\":" + String(g_tubeD, 2) + ",";
    j += "\"wifi\":\"" + WiFi.localIP().toString() + "\",";
    j += "\"bathState\":\"" + esc(g_bathState) + "\",";
    j += "\"bathLastRx\":\"" + esc(g_bathLastRx) + "\",";
    j += "\"bathLastAck\":\"" + esc(g_bathLastAck) + "\",";
    j += "\"bathLastErr\":\"" + esc(g_bathLastErr) + "\",";
    j += "\"bathLastRxAgeMs\":" + String(g_bathLastRxMs ? (millis() - g_bathLastRxMs) : 0) + ",";
    j += "\"bathTxQueued\":" + String((unsigned long)g_bathTxQueued) + ",";
    j += "\"bathTxSent\":" + String((unsigned long)g_bathTxSent) + ",";
    j += "\"bathQDepth\":" + String(bathTxQ ? (int)uxQueueMessagesWaiting(bathTxQ) : 0) + ",";
    j += "\"hostState\":\"" + esc(g_hostState) + "\",";
    j += "\"hostLastRx\":\"" + esc(g_hostLastRx) + "\",";
    j += "\"hostLastAck\":\"" + esc(g_hostLastAck) + "\",";
    j += "\"hostLastRxAgeMs\":" + String(g_hostLastRxMs ? (millis() - g_hostLastRxMs) : 0) + ",";
    j += "\"hostRxCount\":" + String((unsigned long)g_hostRxCount) + ",";
    j += "\"hostTxCount\":" + String((unsigned long)g_hostTxCount) + ",";
    j += "\"logs\":" + logsJson;
    j += "}";
    server.send(200, "application/json", j);
}

void handleCommand() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    String body = server.hasArg("plain") ? server.arg("plain") : "";
    if (body.length() == 0) { server.send(400, "application/json", "{\"error\":\"Empty\"}"); return; }

    String cv = js(body, "cmd", "");
    cv.trim(); cv.toUpperCase();
    if (cv.length() == 0) { server.send(400, "application/json", "{\"error\":\"No cmd\"}"); return; }

    String target = js(body, "target", "");
    target.trim(); target.toUpperCase();
    bool toBath = (target == "BATH" || target == "DISSO" || target == "UNIT2" ||
                   cv.startsWith("BATH_") || cv == "BATH");

    // ── Bath (Hardware_disso) UART2 ─────────────────────────────
    if (toBath) {
        if (cv == "BATH") cv = js(body, "op", js(body, "frame", ""));
        cv.trim(); cv.toUpperCase();
        // Strip BATH_ prefix if present
        if (cv.startsWith("BATH_")) cv = cv.substring(5);

        if (cv == "RAW" || cv == "UART") {
            String frame = js(body, "frame", "");
            if (frame.length() == 0) frame = js(body, "data", "");
            if (frame.length() == 0) { server.send(400, "application/json", "{\"error\":\"No frame\"}"); return; }
            bathSendRawFrame(frame);
            g_bathState = "BUSY";
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }

        if (cv == "SET_TEMP" || cv == "SET-TEMP") {
            float t = jf(body, "temp", 37.0f);
            bathSetTemp(t);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "TS" || cv == "STEPS") {
            uint8_t n = (uint8_t)constrain((int)ju(body, "steps", ju(body, "n", 1)), 1, 12);
            bathSetSteps(n);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "RPM") {
            String list = js(body, "list", js(body, "rpm", ""));
            if (list.length() == 0) { server.send(400, "application/json", "{\"error\":\"No rpm list\"}"); return; }
            bathSetRpmList(list);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "DUR" || cv == "DURATION") {
            String list = js(body, "list", js(body, "dur", ""));
            if (list.length() == 0) { server.send(400, "application/json", "{\"error\":\"No dur list\"}"); return; }
            bathSetDurList(list);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "SML") {
            String list = js(body, "list", js(body, "sml", ""));
            if (list.length() == 0) { server.send(400, "application/json", "{\"error\":\"No sml list\"}"); return; }
            bathSetSmlList(list);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "FL" || cv == "FLUSH") {
            String list = js(body, "list", js(body, "fl", ""));
            if (list.length() == 0) { server.send(400, "application/json", "{\"error\":\"No fl list\"}"); return; }
            bathSetFlList(list);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "LOAD_RECIPE" || cv == "RECIPE") {
            float t = jf(body, "temp", jf(body, "targetTemp", 37.0f));
            uint8_t n = (uint8_t)constrain((int)ju(body, "steps", 1), 1, 12);
            String rpm = js(body, "rpm", "");
            String dur = js(body, "dur", "");
            String sml = js(body, "sml", "");
            String fl = js(body, "fl", "");
            if (rpm.length() == 0 || dur.length() == 0 || sml.length() == 0 || fl.length() == 0) {
                server.send(400, "application/json", "{\"error\":\"Need rpm+dur+sml+fl lists\"}");
                return;
            }
            bathLoadRecipeSeq(t, n, rpm, dur, sml, fl);
            g_bathState = "BUSY";
            server.send(200, "application/json", "{\"status\":\"queued\",\"target\":\"bath\",\"msg\":\"recipe sequence\"}");
            return;
        }
        if (cv == "PREHEAT" || cv == "PRE-HEAT" || cv == "INIT") {
            bathPreHeat();
            g_bathState = "BUSY";
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\",\"frame\":\"#PRE-HEAT*\"}");
            return;
        }
        if (cv == "START" || cv == "START-TEST" || cv == "TEST_START") {
            bathStartTest();
            g_bathState = "BUSY";
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "PAUSE" || cv == "PAUSE-TEST") {
            bathPauseTest();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "RESUME" || cv == "RESUME-TEST") {
            bathResumeTest();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "STOP" || cv == "STOP-TEST") {
            bathStopTest();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "ESTOP") {
            bathEstop();
            g_bathState = "IDLE";
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "STATUS" || cv == "GET-STATUS") {
            bathGetStatus();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "CLR" || cv == "CLR-RECIPE" || cv == "CLEAR") {
            bathClrRecipe();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "AUTO-DROP-ON" || cv == "AUTO_DROP_ON") {
            bathAutoDropOn();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "AUTO-DROP-OFF" || cv == "AUTO_DROP_OFF") {
            bathAutoDropOff();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "START-PLD" || cv == "MOTOR_START" || cv == "PLD") {
            uint16_t rpm = (uint16_t)constrain((int)ju(body, "rpm", 100), 10, 300);
            bathStartPld(rpm);
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "STOP-PLD" || cv == "MOTOR_STOP") {
            bathStopPld();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "LF-CU-UP" || cv == "ARM_UP" || cv == "LIFT_UP") {
            bathLiftUp();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "LF-CU-DOWN" || cv == "ARM_DOWN" || cv == "LIFT_DOWN") {
            bathLiftDown();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }
        if (cv == "LF-CU-STOP" || cv == "ARM_STOP" || cv == "LIFT_STOP") {
            bathLiftStop();
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\"}");
            return;
        }

        // Passthrough: treat cmd as raw body of #cmd*
        if (cv.length() > 0 && cv != "BATH") {
            bathSendBody(cv);
            g_bathState = "BUSY";
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\",\"frame\":\"#" + cv + "*\"}");
            return;
        }

        server.send(400, "application/json", "{\"error\":\"Unknown bath cmd\"}");
        return;
    }

    // Raw frame passthrough
    if (cv == "RAW" || cv == "UART") {
        String frame = js(body, "frame", "");
        if (frame.length() == 0) frame = js(body, "data", "");
        if (frame.length() == 0) { server.send(400, "application/json", "{\"error\":\"No frame\"}"); return; }
        uartSendRawFrame(frame);
        g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }

    if (cv == "INI" || cv == "INIT") {
        uartSend("INI");
        g_waitingCmt = true; g_pendingOp = "INI"; g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\",\"frame\":\"#INI*\"}");
        return;
    }
    if (cv == "HOME") {
        uartSend("HOME");
        g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "ESTOP" || cv == "STOP") {
        uartSend("ESTOP");
        g_waitingCmt = false; g_linkState = "IDLE";
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "RESUME") {
        uartSend("RESUME");
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "STATUS" || cv == "STS") {
        uartSend("STATUS");
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }

    if (cv == "TB" || cv == "TUBES") {
        g_tubeA = jf(body, "a", jf(body, "tubeA", g_tubeA));
        g_tubeB = jf(body, "b", jf(body, "tubeB", g_tubeB));
        g_tubeC = jf(body, "c", jf(body, "tubeC", g_tubeC));
        g_tubeD = jf(body, "d", jf(body, "tubeD", g_tubeD));
        char buf[80];
        snprintf(buf, sizeof(buf), "TB,A-%.1f,B-%.1f,C-%.1f,D-%.1f",
                 g_tubeA, g_tubeB, g_tubeC, g_tubeD);
        uartSend(String(buf));
        server.send(200, "application/json", "{\"status\":\"sent\",\"frame\":\"#" + String(buf) + "*\"}");
        return;
    }

    if (cv == "SMP_FLT" || cv == "SMP_FILL") {
        g_smpFillSec = jf(body, "fillTime", jf(body, "flt", g_smpFillSec));
        char buf[32];
        snprintf(buf, sizeof(buf), "SMP,FLT-%.0f", g_smpFillSec);
        uartSend(String(buf));
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "SMP" || cv == "SAMPLING" || cv == "SAMPLING_CYCLE") {
        float sv = jf(body, "ml", jf(body, "sv", 10));
        float fh = jf(body, "flush", jf(body, "fh", 5));
        int st = (int)ju(body, "step", ju(body, "st", 12));
        float flt = jf(body, "fillTime", jf(body, "flt", g_smpFillSec));
        queueSamplingCycle(sv, fh, st, flt, false);
        char buf[48];
        snprintf(buf, sizeof(buf), "SMP,SV-%.0f,FH-%.0f,ST-%d", sv, fh, st);
        server.send(200, "application/json",
                    "{\"status\":\"queued\",\"frame\":\"#" + String(buf) + "*\"}");
        return;
    }

    if (cv == "RPH_FLT" || cv == "RPH_FILL") {
        g_rphFillSec = jf(body, "fillTime", jf(body, "flt", g_rphFillSec));
        char buf[32];
        snprintf(buf, sizeof(buf), "RPH,FLT-%.0f", g_rphFillSec);
        uartSend(String(buf));
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "RPH" || cv == "REPLENISH" || cv == "REPLENISH_CYCLE") {
        float flt = jf(body, "fillTime", jf(body, "flt", g_rphFillSec));
        if (flt >= 0) {
            g_rphFillSec = flt;
            char fbuf[32];
            snprintf(fbuf, sizeof(fbuf), "RPH,FLT-%.0f", g_rphFillSec);
            uartSend(String(fbuf));
            delay(30);
        }
        bool useLw = true;
        String mode = js(body, "mode", "LW");
        mode.toUpperCase();
        float sv = jf(body, "ml", jf(body, "sv", 0));
        if (mode == "SV" || sv > 0.01f) useLw = false;
        if (useLw) uartSend("RPH,LW");
        else {
            char buf[32];
            snprintf(buf, sizeof(buf), "RPH,SV-%.0f", sv);
            uartSend(String(buf));
        }
        g_waitingCmt = true; g_pendingOp = "RPH"; g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }

    if (cv == "DCL_FLT" || cv == "DCL_FILL") {
        g_dclFillSec = jf(body, "fillTime", jf(body, "flt", g_dclFillSec));
        char buf[32];
        snprintf(buf, sizeof(buf), "DCL,FLT-%.0f", g_dclFillSec);
        uartSend(String(buf));
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "DCL" || cv == "D_CLEAN" || cv == "D_CLEAN_CYCLE") {
        float sv = jf(body, "ml", jf(body, "sv", 10));
        int nc = (int)ju(body, "cycles", ju(body, "nc", 4));
        float flt = jf(body, "fillTime", jf(body, "flt", g_dclFillSec));
        if (flt >= 0) {
            g_dclFillSec = flt;
            char fbuf[32];
            snprintf(fbuf, sizeof(fbuf), "DCL,FLT-%.0f", g_dclFillSec);
            uartSend(String(fbuf));
            delay(30);
        }
        char buf[40];
        snprintf(buf, sizeof(buf), "DCL,SV-%.0f,NC-%d", sv, nc);
        uartSend(String(buf));
        g_waitingCmt = true; g_pendingOp = "DCL"; g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\",\"frame\":\"#" + String(buf) + "*\"}");
        return;
    }

    if (cv == "AUTO") {
        g_airAuto = true;
        uartSend("AUTO");
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "MANUAL") {
        g_airAuto = false;
        uartSend("MANUAL");
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }
    if (cv == "AC" || cv == "AIR" || cv == "AIR_CLEAN" || cv == "CLEAN_CYCLE") {
        g_airExtv = jf(body, "extra", jf(body, "extv", g_airExtv));
        String src = js(body, "src", js(body, "mode", "B"));
        src.toUpperCase();
        char buf[48];
        if (src.indexOf("C") >= 0 && src.indexOf("D") < 0 && src != "B")
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f,SRC-C", g_airExtv);
        else if (src.indexOf("D") >= 0 || src.indexOf("DCLEAN") >= 0)
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f,SRC-D", g_airExtv);
        else
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f", g_airExtv);
        uartSend(String(buf));
        g_waitingCmt = true; g_pendingOp = "AC"; g_linkState = "BUSY";
        server.send(200, "application/json", "{\"status\":\"sent\"}");
        return;
    }

    server.send(400, "application/json", "{\"error\":\"Unknown cmd\"}");
}

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.println(F("========================================"));
    Serial.println(F("  MASTER UART — Sampler + Bath Unit-2"));
    Serial.println(F("  Board target: ESP32-S3 N16R8"));
    Serial.println(F("========================================"));

#if CONFIG_SPIRAM
    Serial.printf("PSRAM: %u bytes free\n", (unsigned)ESP.getFreePsram());
#else
    Serial.println(F("PSRAM: not enabled — set Tools→PSRAM→OPI PSRAM"));
#endif
    Serial.printf("Heap:  %u bytes free\n", (unsigned)ESP.getFreeHeap());
    Serial.printf("Flash: %u bytes\n", (unsigned)ESP.getFlashChipSize());

    g_logMux = xSemaphoreCreateMutex();
    bathSetLogFn(addLog);
    bathSetSampleStartFn(onBathSampleStart);
    bathSetEventFn(hostForward);
    hostSetLogFn(addLog);

    // Sampler UART — larger buffers so RX not lost while web is busy
    SlaveSerial.setRxBufferSize(1024);
    SlaveSerial.setTxBufferSize(512);
    SlaveSerial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
    delay(20);
    Serial.println(F("UART1 Sampler: TX=40 RX=39 @9600"));
    addLog("Master UART1 sampler @9600 TX40/RX39");

    bathUartBegin();
    Serial.println(F("UART2 Bath:    TX=17 RX=18 @9600 (FreeRTOS TX queue)"));
    Serial.println(F("  → Bath Unit-2 RX=40 TX=1 (crossed)"));

    hostUartBegin();
    Serial.println(F("UART0 Host:    TX=41 RX=16 @9600 (supervisory control)"));
    Serial.println(F("  → External controller RX←41  TX→16 (crossed)"));
    addLog("Host UART0 @9600 TX41/RX16");

    Serial.print(F("WiFi connecting to: "));
    Serial.println(WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);           // lower latency for local control
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    int att = 0;
    while (WiFi.status() != WL_CONNECTED && att < 40) {
        delay(250);
        Serial.print('.');
        att++;
    }
    Serial.println();

    server.on("/", HTTP_GET, handleRoot);
    server.on("/status", HTTP_GET, handleStatus);
    server.on("/cmd", HTTP_POST, handleCommand);
    server.on("/cmd", HTTP_OPTIONS, sendCORS);
    server.on("/status", HTTP_OPTIONS, sendCORS);
    server.onNotFound([]() {
        server.sendHeader("Access-Control-Allow-Origin", "*");
        server.send(404, "application/json", "{\"error\":\"not found\"}");
    });
    server.begin();

    if (WiFi.status() == WL_CONNECTED) {
        String ip = WiFi.localIP().toString();
        Serial.println(F("----------------------------------------"));
        Serial.println(F("  WiFi CONNECTED"));
        Serial.print(F("  Open web UI:  http://"));
        Serial.println(ip);
        Serial.println(F("----------------------------------------"));
        addLog("WiFi OK " + ip);
    } else {
        Serial.println(F("  WiFi FAILED — check SSID/password"));
        addLog("WiFi FAIL");
    }
    g_linkState = "IDLE";
}

// ── Loop ────────────────────────────────────────────────────────
void loop() {
    // Drain web quickly; bath TX/RX runs on dedicated core-0 task
    for (int i = 0; i < 6; i++) {
        server.handleClient();
    }
    pollSlave();
    bathPoll();              // extra RX drain from loop (task also polls)
    hostPoll();              // supervisory host UART (GPIO41/16)
    pollPendingSampling();   // FLT → SMP (manual UI + auto during test)
    yield();

    static uint32_t lastWC = 0;
    if (millis() - lastWC > 15000UL) {
        lastWC = millis();
        if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    }
}
