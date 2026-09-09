#ifndef HOST_UART_H
#define HOST_UART_H

#include <Arduino.h>
#include <HardwareSerial.h>
#include "bath_uart.h"

/**
 * Host / Supervisory UART — external PLC / PC / HMI controls the whole machine
 * through this master (which already owns Sampler UART1 + Bath UART2).
 *
 * Wiring @ 9600 8N1 (crossed):
 *   Master GPIO41 (TX) → Host controller RX
 *   Master GPIO16 (RX) ← Host controller TX
 *   GND common
 *
 * Frame format (same family as bath/sampler):
 *   Host → Master : #COMMAND*
 *   Master → Host : #...,ACK*  |  #ERR,CODE,ACK*  |  async events forwarded
 *
 * Uses UART0 (USB Serial stays on CDC; UART1=sampler, UART2=bath).
 */

#define HOST_UART_TX_PIN   41
#define HOST_UART_RX_PIN   16
#define HOST_UART_BAUD     9600
#define HOST_FRAME_MAX     220

static HardwareSerial HostSerial(0);

static String g_hostLastRx = "";
static String g_hostLastAck = "";
static String g_hostState = "BOOT";
static uint32_t g_hostLastRxMs = 0;
static volatile uint32_t g_hostRxCount = 0;
static volatile uint32_t g_hostTxCount = 0;

// Provided by master_URAT.ino
extern void addLog(const String& line);
extern void uartSend(const String& bodyNoHashStar);
extern void uartSendRawFrame(const String& frame);
extern void queueSamplingCycle(float sv, float fh, int st, float flt, bool fromAuto);
extern float g_smpFillSec;
extern float g_rphFillSec;
extern float g_dclFillSec;
extern float g_tubeA, g_tubeB, g_tubeC, g_tubeD;
extern float g_airExtv;
extern bool  g_airAuto;
extern bool  g_waitingCmt;
extern String g_pendingOp;
extern String g_linkState;

typedef void (*HostLogFn)(const String& line);
static HostLogFn g_hostLogFn = nullptr;
static void hostSetLogFn(HostLogFn fn) { g_hostLogFn = fn; }

static void hostLog(const String& line) {
    if (g_hostLogFn) g_hostLogFn(line);
}

static void hostSendRaw(const String& frameIn) {
    String f = frameIn;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    HostSerial.println(f);
    g_hostTxCount++;
    g_hostLastAck = f;
    hostLog("HOST TX " + f);
}

static void hostAck(const String& body) {
    hostSendRaw(body + ",ACK");
    g_hostState = "IDLE";
}

static void hostErr(const char* code) {
    hostSendRaw(String("ERR,") + code + ",ACK");
    g_hostState = "ERROR";
}

/** Forward async events from bath/sampler up to the host controller. */
static void hostForward(const String& line) {
    if (line.length() == 0) return;
    String f = line;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    HostSerial.println(f);
    g_hostTxCount++;
    hostLog("HOST FWD " + f);
}

static float hostTagF(const String& up, const char* tag, float defVal) {
    String keyComma = String(",") + tag;
    int i = up.indexOf(keyComma);
    if (i >= 0) {
        i += keyComma.length();
        return up.substring(i).toFloat();
    }
    String key = String(tag);
    i = up.indexOf(key);
    if (i < 0) return defVal;
    i += key.length();
    return up.substring(i).toFloat();
}

static void hostMarkSamplerBusy(const char* op) {
    g_waitingCmt = true;
    g_pendingOp = op;
    g_linkState = "BUSY";
}

// ── Command dispatch ────────────────────────────────────────────
static void hostHandleLine(String line) {
    line.trim();
    if (line.length() == 0) return;
    g_hostLastRx = line;
    g_hostLastRxMs = millis();
    g_hostRxCount++;
    hostLog("HOST RX " + line);

    String body = line;
    if (body.startsWith("#")) body = body.substring(1);
    if (body.endsWith("*")) body = body.substring(0, body.length() - 1);
    body.trim();
    if (body.length() == 0) { hostErr("EMPTY"); return; }

    String up = body;
    up.toUpperCase();
    g_hostState = "BUSY";

    // ── System ──────────────────────────────────────────────────
    if (up == "PING" || up == "HELLO") {
        hostAck("PING");
        return;
    }
    if (up == "READY" || up == "WHO") {
        hostAck("READY,MASTER");
        return;
    }
    if (up == "STATUS" || up == "GET-STATUS" || up == "SYS-STATUS") {
        char buf[96];
        snprintf(buf, sizeof(buf), "STATUS,SAMPLER-%s,BATH-%s,PEND-%s",
                 g_linkState.c_str(), g_bathState.c_str(),
                 g_pendingOp.length() ? g_pendingOp.c_str() : "NONE");
        hostAck(String(buf));
        return;
    }
    if (up == "HELP") {
        hostAck("HELP,SEE-DOCS");
        return;
    }

    // ── Machine-wide E-stop ─────────────────────────────────────
    if (up == "ALL-ESTOP" || up == "M-ESTOP" || up == "ESTOP-ALL") {
        uartSend("ESTOP");
        g_waitingCmt = false;
        g_linkState = "IDLE";
        bathEstop();
        hostAck("ALL-ESTOP");
        return;
    }

    // ── Sampler: init / motion / status ─────────────────────────
    if (up == "INI" || up == "INIT" || up == "SMP-INI") {
        uartSend("INI");
        hostMarkSamplerBusy("INI");
        hostAck("INI");
        return;
    }
    if (up == "HOME" || up == "SMP-HOME") {
        uartSend("HOME");
        g_linkState = "BUSY";
        hostAck("HOME");
        return;
    }
    if (up == "SMP-ESTOP" || up == "ESTOP") {
        // Bare ESTOP stops sampler; use ALL-ESTOP for both
        uartSend("ESTOP");
        g_waitingCmt = false;
        g_linkState = "IDLE";
        hostAck("ESTOP");
        return;
    }
    if (up == "RESUME" || up == "SMP-RESUME") {
        uartSend("RESUME");
        hostAck("RESUME");
        return;
    }
    if (up == "SMP-STATUS" || up == "SAMPLER-STATUS") {
        uartSend("STATUS");
        hostAck("SMP-STATUS");
        return;
    }
    if (up == "AUTO") {
        g_airAuto = true;
        uartSend("AUTO");
        hostAck("AUTO");
        return;
    }
    if (up == "MANUAL") {
        g_airAuto = false;
        uartSend("MANUAL");
        hostAck("MANUAL");
        return;
    }

    // #TB,A-1.4,B-1.4,C-1.4,D-1.4*
    if (up.startsWith("TB")) {
        float a = hostTagF(up, "A-", g_tubeA);
        float b = hostTagF(up, "B-", g_tubeB);
        float c = hostTagF(up, "C-", g_tubeC);
        float d = hostTagF(up, "D-", g_tubeD);
        g_tubeA = a; g_tubeB = b; g_tubeC = c; g_tubeD = d;
        char buf[80];
        snprintf(buf, sizeof(buf), "TB,A-%.1f,B-%.1f,C-%.1f,D-%.1f", a, b, c, d);
        uartSend(String(buf));
        hostAck(String(buf));
        return;
    }

    // Sampling cycle: #SMP,FLT-35*  or  #SMP,SV-10,FH-5,ST-12*  (same as Sampling UI)
    if (up.startsWith("SMP") && !up.startsWith("SMP-STATUS") && !up.startsWith("SMP-HOME") &&
        !up.startsWith("SMP-ESTOP") && !up.startsWith("SMP-INI") && !up.startsWith("SMP-RESUME") &&
        !up.startsWith("SMP-RAW") && !up.startsWith("SMP-AUTO")) {
        if (up.indexOf("FLT-") >= 0 && up.indexOf("SV-") < 0) {
            g_smpFillSec = hostTagF(up, "FLT-", g_smpFillSec);
            char buf[32];
            snprintf(buf, sizeof(buf), "SMP,FLT-%.0f", g_smpFillSec);
            uartSend(String(buf));
            hostAck(String(buf));
            return;
        }
        float sv = hostTagF(up, "SV-", 10);
        float fh = hostTagF(up, "FH-", 5);
        int st = (int)constrain((int)hostTagF(up, "ST-", 12), 1, 99);
        float flt = g_smpFillSec;
        if (up.indexOf("FLT-") >= 0) flt = hostTagF(up, "FLT-", g_smpFillSec);
        queueSamplingCycle(sv, fh, st, flt, false);
        char buf[48];
        snprintf(buf, sizeof(buf), "SMP,SV-%.0f,FH-%.0f,ST-%d", sv, fh, st);
        hostAck(String(buf));
        return;
    }

    // Replenishment: #RPH,FLT-30*  #RPH,LW*  #RPH,SV-10*
    if (up.startsWith("RPH") || up.startsWith("REPLENISH")) {
        if (up.indexOf("FLT-") >= 0 && up.indexOf("SV-") < 0 && up.indexOf(",LW") < 0 && up != "RPH,LW") {
            g_rphFillSec = hostTagF(up, "FLT-", g_rphFillSec);
            char buf[32];
            snprintf(buf, sizeof(buf), "RPH,FLT-%.0f", g_rphFillSec);
            uartSend(String(buf));
            hostAck(String(buf));
            return;
        }
        if (up.indexOf("FLT-") >= 0) {
            g_rphFillSec = hostTagF(up, "FLT-", g_rphFillSec);
            char fbuf[32];
            snprintf(fbuf, sizeof(fbuf), "RPH,FLT-%.0f", g_rphFillSec);
            uartSend(String(fbuf));
            delay(25);
        }
        if (up.indexOf(",LW") >= 0 || up.endsWith("LW") || up.indexOf("SV-") < 0) {
            uartSend("RPH,LW");
            hostMarkSamplerBusy("RPH");
            hostAck("RPH,LW");
            return;
        }
        float sv = hostTagF(up, "SV-", 10);
        char buf[32];
        snprintf(buf, sizeof(buf), "RPH,SV-%.0f", sv);
        uartSend(String(buf));
        hostMarkSamplerBusy("RPH");
        hostAck(String(buf));
        return;
    }

    // D-Clean: #DCL,FLT-30*  #DCL,SV-10,NC-4*
    if (up.startsWith("DCL") || up.startsWith("D-CLEAN") || up.startsWith("DCLEAN")) {
        if (up.indexOf("FLT-") >= 0 && up.indexOf("SV-") < 0) {
            g_dclFillSec = hostTagF(up, "FLT-", g_dclFillSec);
            char buf[32];
            snprintf(buf, sizeof(buf), "DCL,FLT-%.0f", g_dclFillSec);
            uartSend(String(buf));
            hostAck(String(buf));
            return;
        }
        float sv = hostTagF(up, "SV-", 10);
        int nc = (int)constrain((int)hostTagF(up, "NC-", 4), 1, 20);
        if (up.indexOf("FLT-") >= 0) {
            g_dclFillSec = hostTagF(up, "FLT-", g_dclFillSec);
            char fbuf[32];
            snprintf(fbuf, sizeof(fbuf), "DCL,FLT-%.0f", g_dclFillSec);
            uartSend(String(fbuf));
            delay(25);
        }
        char buf[40];
        snprintf(buf, sizeof(buf), "DCL,SV-%.0f,NC-%d", sv, nc);
        uartSend(String(buf));
        hostMarkSamplerBusy("DCL");
        hostAck(String(buf));
        return;
    }

    // Air clean: #AC,EXTV-0.8*  #AC,EXTV-0.8,SRC-C*  #AC,EXTV-0.8,SRC-D*
    if (up.startsWith("AC") || up.startsWith("AIR")) {
        g_airExtv = hostTagF(up, "EXTV-", g_airExtv);
        char buf[48];
        if (up.indexOf("SRC-D") >= 0)
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f,SRC-D", g_airExtv);
        else if (up.indexOf("SRC-C") >= 0)
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f,SRC-C", g_airExtv);
        else
            snprintf(buf, sizeof(buf), "AC,EXTV-%.1f", g_airExtv);
        uartSend(String(buf));
        hostMarkSamplerBusy("AC");
        hostAck(String(buf));
        return;
    }

    // ── Bath recipe / test ──────────────────────────────────────
    if (up.startsWith("SET-TEMP-")) {
        float t = up.substring(9).toFloat();
        if (t < 20.0f || t > 50.0f) { hostErr("TEMP"); return; }
        bathSetTemp(t);
        hostAck(up);
        return;
    }
    if (up.startsWith("TS-")) {
        uint8_t n = (uint8_t)constrain(up.substring(3).toInt(), 1, 12);
        bathSetSteps(n);
        hostAck(up);
        return;
    }
    if (up.startsWith("RPM,")) {
        bathSetRpmList(up.substring(4));
        hostAck("RPM");
        return;
    }
    if (up.startsWith("DUR,")) {
        bathSetDurList(up.substring(4));
        hostAck("DUR");
        return;
    }
    if (up.startsWith("SML,")) {
        bathSetSmlList(up.substring(4));
        hostAck("SML");
        return;
    }
    if (up.startsWith("FL,") && !up.startsWith("FLT")) {
        bathSetFlList(up.substring(3));
        hostAck("FL");
        return;
    }

    // One-shot recipe (lists keep internal commas):
    // #RECIPE,TEMP-37.0,TS-03,RPM-1-100,2-150,DUR-1-00:05,2-00:10,SML-1-10,2-15,FL-1-2,2-3*
    if (up.startsWith("RECIPE,")) {
        float temp = hostTagF(up, "TEMP-", 37.0f);
        uint8_t ts = (uint8_t)constrain((int)hostTagF(up, "TS-", 1), 1, 12);

        auto sectionAfter = [&](const char* tag) -> String {
            String key = String(tag);
            int i = up.indexOf(key);
            if (i < 0) return "";
            i += key.length();
            int end = (int)up.length();
            const char* nxt[] = {",TEMP-", ",TS-", ",RPM-", ",DUR-", ",SML-", ",FL-"};
            for (int t = 0; t < 6; t++) {
                // skip the same tag family
                if (String(nxt[t] + 1) == key) continue;
                int j = up.indexOf(nxt[t], i);
                if (j >= 0 && j < end) end = j;
            }
            return up.substring(i, end);
        };

        String rpm = sectionAfter("RPM-");
        String dur = sectionAfter("DUR-");
        String sml = sectionAfter("SML-");
        String fl  = sectionAfter("FL-");
        if (rpm.length() == 0 || dur.length() == 0 || sml.length() == 0 || fl.length() == 0) {
            hostErr("RECIPE");
            return;
        }
        bathLoadRecipeSeq(temp, ts, rpm, dur, sml, fl);
        hostAck("RECIPE");
        return;
    }

    if (up == "PRE-HEAT" || up == "PREHEAT") {
        bathPreHeat();
        hostAck("PRE-HEAT");
        return;
    }
    if (up == "START-TEST" || up == "RUN-TEST" || up == "TEST-START") {
        bathStartTest();
        hostAck("START-TEST");
        return;
    }
    if (up == "PAUSE-TEST" || up == "PAUSE") {
        bathPauseTest();
        hostAck("PAUSE-TEST");
        return;
    }
    if (up == "RESUME-TEST") {
        bathResumeTest();
        hostAck("RESUME-TEST");
        return;
    }
    if (up == "STOP-TEST" || up == "TEST-STOP") {
        bathStopTest();
        hostAck("STOP-TEST");
        return;
    }
    if (up == "BATH-ESTOP") {
        bathEstop();
        hostAck("BATH-ESTOP");
        return;
    }
    if (up == "BATH-STATUS" || up == "GET-BATH-STATUS") {
        bathGetStatus();
        hostAck("BATH-STATUS");
        return;
    }
    if (up == "CLR-RECIPE" || up == "CLEAR-RECIPE") {
        bathClrRecipe();
        hostAck("CLR-RECIPE");
        return;
    }
    if (up == "AUTO-DROP-ON") {
        bathAutoDropOn();
        hostAck("AUTO-DROP-ON");
        return;
    }
    if (up == "AUTO-DROP-OFF") {
        bathAutoDropOff();
        hostAck("AUTO-DROP-OFF");
        return;
    }
    if (up.startsWith("START-PLD-")) {
        uint16_t rpm = (uint16_t)constrain(up.substring(10).toInt(), 10, 300);
        bathStartPld(rpm);
        hostAck(up);
        return;
    }
    if (up == "STOP-PLD") {
        bathStopPld();
        hostAck("STOP-PLD");
        return;
    }
    if (up == "LF-CU-UP" || up == "LIFT-UP" || up == "ARM-UP") {
        bathLiftUp();
        hostAck("LF-CU-UP");
        return;
    }
    if (up == "LF-CU-DOWN" || up == "LIFT-DOWN" || up == "ARM-DOWN") {
        bathLiftDown();
        hostAck("LF-CU-DOWN");
        return;
    }
    if (up == "LF-CU-STOP" || up == "LIFT-STOP" || up == "ARM-STOP") {
        bathLiftStop();
        hostAck("LF-CU-STOP");
        return;
    }

    // Raw passthrough to sampler: #SMP-RAW,#INI*  or #RAW-SMP,INI
    if (up.startsWith("RAW-SMP,") || up.startsWith("SMP-RAW,")) {
        String rest = body.substring(body.indexOf(',') + 1);
        rest.trim();
        uartSendRawFrame(rest);
        hostAck("RAW-SMP");
        return;
    }
    if (up.startsWith("RAW-BATH,") || up.startsWith("BATH-RAW,")) {
        String rest = body.substring(body.indexOf(',') + 1);
        rest.trim();
        bathSendRawFrame(rest);
        hostAck("RAW-BATH");
        return;
    }

    hostErr("UNK");
}

static void hostPoll() {
    static char buf[HOST_FRAME_MAX];
    static size_t len = 0;
    while (HostSerial.available()) {
        char c = (char)HostSerial.read();
        if (c == '\n' || c == '\r') {
            if (len > 0) {
                buf[len] = 0;
                hostHandleLine(String(buf));
                len = 0;
            }
        } else if (len + 1 < sizeof(buf)) {
            buf[len++] = c;
        } else {
            len = 0;
            hostErr("OVF");
        }
    }
}

static void hostUartBegin() {
    HostSerial.setRxBufferSize(1024);
    HostSerial.setTxBufferSize(512);
    HostSerial.begin(HOST_UART_BAUD, SERIAL_8N1, HOST_UART_RX_PIN, HOST_UART_TX_PIN);
    HostSerial.setTimeout(10);
    g_hostState = "IDLE";
    hostLog("Host UART ready @9600 TX41/RX16");
    hostAck("READY,MASTER");
}

#endif
