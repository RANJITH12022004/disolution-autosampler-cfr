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
#include <Preferences.h>
#include "web.h"
#include "uart_framer.h"
#include "bath_uart.h"
#include "host_uart.h"
#include "master_pf.h"

const char* WIFI_SSID = "Airtel_didi_0516";
const char* WIFI_PASS = "Air@99791";

// Crossed to sampler TX=39 RX=40
#define UART_TX_PIN  40
#define UART_RX_PIN  39
#define UART_BAUD    9600

HardwareSerial SlaveSerial(1);
WebServer server(80);

// Buzzer on master GPIO42 (active HIGH)
#define BUZZER_PIN  42
static uint32_t g_buzzerOffAt = 0;

void buzzerBeepMs(uint32_t ms) {
    if (ms < 20) ms = 20;
    if (ms > 10000) ms = 10000;
    digitalWrite(BUZZER_PIN, HIGH);
    g_buzzerOffAt = millis() + ms;
}

void pollBuzzer() {
    if (g_buzzerOffAt == 0) return;
    if ((int32_t)(millis() - g_buzzerOffAt) >= 0) {
        digitalWrite(BUZZER_PIN, LOW);
        g_buzzerOffAt = 0;
    }
}

// ── Session defaults (also sent before run cmds) ────────────────
float g_smpFillSec = 35;
float g_rphFillSec = 30;
float g_dclFillSec = 30;
float g_tubeA = 1.4f, g_tubeB = 1.4f, g_tubeC = 1.4f, g_tubeD = 1.4f;
float g_airExtv = 0.8f;
bool  g_airAuto = false;  // MANUAL default — master owns Air during test chain

// ── UART RX log / last status ───────────────────────────────────
#define LOG_MAX 32
#define LOG_LEN 100
char g_logs[LOG_MAX][LOG_LEN];
int  g_logHead = 0, g_logCount = 0;
uint32_t g_logSeq = 0;   // bumps on each log — web can poll lite until seq changes
SemaphoreHandle_t g_logMux = NULL;

String g_lastRx = "";
String g_lastAck = "";
String g_lastCmt = "";
String g_lastErr = "";
String g_linkState = "BOOT";  // BOOT / IDLE / BUSY / ERROR / DONE
uint32_t g_lastRxMs = 0;
uint32_t g_lastCmtMs = 0;
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

// After auto sampling during test:
//   SMP → Air B → RPH,LW → Air C (SRC-C) → bath #RPH-DONE* (probe UP)
bool g_autoSmpChain = false;
struct PendingRphCycle {
    bool active;
    uint8_t phase;   // 0 = FLT, 1 = LW
    uint32_t nextAtMs;
};
PendingRphCycle g_pendRph = {false, 0, 0};
struct PendingAirClean {
    bool active;
    char src;          // 'B' or 'C'
    uint32_t nextAtMs;
};
PendingAirClean g_pendAir = {false, 'B', 0};

// Bath asked for the next step's sample while the previous step's chain
// (SMP→AirB→RPH→AirC) is still running on the sampler. Run it right after the
// chain instead of dropping it — the probe is already DOWN and stays DOWN.
struct QueuedSmpStart {
    bool valid;
    uint8_t step;
    float sv;
    float fh;
};
QueuedSmpStart g_queuedSmp = {false, 0, 10.0f, 2.0f};

// ── Power-fail chain checkpoint (NVS "mst_pf") ─────────────────
Preferences g_prefs;
static void mstPfClear() {
    g_prefs.begin("mst_pf", false);
    g_prefs.clear();
    g_prefs.end();
}
static void mstPfSave() {
    if (!g_autoSmpChain && !g_pendSmp.active && !g_pendAir.active && !g_pendRph.active) {
        mstPfClear();
        return;
    }
    MasterCheckpoint c;
    memset(&c, 0, sizeof(c));
    c.magic = MST_PF_MAGIC;
    c.version = 1;
    c.active = 1;
    c.autoChain = g_autoSmpChain ? 1 : 0;
    strncpy(c.pendingOp, g_pendingOp.c_str(), sizeof(c.pendingOp) - 1);
    c.waitingCmt = g_waitingCmt ? 1 : 0;
    c.sv = g_pendSmp.sv; c.fh = g_pendSmp.fh; c.flt = g_pendSmp.flt;
    c.st = (int16_t)g_pendSmp.st;
    c.airExtv = g_airExtv; c.rphFlt = g_rphFillSec;
    c.airSrc = g_pendAir.src;
    c.pendSmpPhase = g_pendSmp.phase;
    c.pendRphPhase = g_pendRph.phase;
    c.pendAirActive = g_pendAir.active ? 1 : 0;
    c.pendSmpActive = g_pendSmp.active ? 1 : 0;
    c.pendRphActive = g_pendRph.active ? 1 : 0;
    // Prefer live SV/ST from last queue even if pend cleared
    if (!c.pendSmpActive && g_autoSmpChain) {
        // keep last known from pendingOp context — use g_pendSmp fields still filled
        c.sv = g_pendSmp.sv > 0 ? g_pendSmp.sv : c.sv;
        c.st = g_pendSmp.st > 0 ? (int16_t)g_pendSmp.st : c.st;
        c.fh = g_pendSmp.fh > 0 ? g_pendSmp.fh : c.fh;
        c.flt = g_smpFillSec;
    }
    g_prefs.begin("mst_pf", false);
    g_prefs.putBytes("ckpt", &c, sizeof(c));
    g_prefs.end();
}
static bool mstPfLoad(MasterCheckpoint& c) {
    g_prefs.begin("mst_pf", true);
    size_t n = g_prefs.getBytesLength("ckpt");
    if (n != sizeof(c)) { g_prefs.end(); return false; }
    memset(&c, 0, sizeof(c));
    g_prefs.getBytes("ckpt", &c, sizeof(c));
    g_prefs.end();
    return (c.magic == MST_PF_MAGIC && c.version == 1 && c.active);
}
static uint32_t g_cmtWaitSinceMs = 0;
static bool g_pfMissedCmtGuard = false;

static void mstPfResume() {
    MasterCheckpoint c;
    if (!mstPfLoad(c)) return;
    addLog("PF: Master chain resume op=" + String(c.pendingOp));
    g_autoSmpChain = c.autoChain != 0;
    g_pendingOp = String(c.pendingOp);
    g_waitingCmt = c.waitingCmt != 0;
    g_airExtv = c.airExtv > 0.01f ? c.airExtv : g_airExtv;
    g_rphFillSec = c.rphFlt > 0 ? c.rphFlt : g_rphFillSec;
    g_smpFillSec = c.flt > 0 ? c.flt : g_smpFillSec;
    g_pendSmp.sv = c.sv; g_pendSmp.fh = c.fh; g_pendSmp.st = c.st;
    g_pendSmp.flt = c.flt; g_pendSmp.fromAuto = true;
    g_linkState = "BUSY";
    g_cmtWaitSinceMs = millis();
    g_pfMissedCmtGuard = true;

    // Re-issue the command the master was waiting on / about to send
    String op = g_pendingOp;
    if (c.pendSmpActive) {
        g_pendSmp.active = true;
        g_pendSmp.phase = c.pendSmpPhase;
        g_pendSmp.nextAtMs = millis() + 200;
        g_pfMissedCmtGuard = false;  // we re-send; normal CMT path
        addLog("PF: Re-queue SMP");
    } else if (op == "SMP") {
        // Sampler may still be running — wait for CMT; if already done we'll timeout later
        g_waitingCmt = true;
        addLog("PF: Wait SMP CMT (sampler may still be resuming)");
    } else if (op == "AC-B" || (c.pendAirActive && c.airSrc == 'B')) {
        g_pendAir.active = true; g_pendAir.src = 'B';
        g_pendAir.nextAtMs = millis() + 500;
        g_pendingOp = "AC-B";
        g_pfMissedCmtGuard = false;
        addLog("PF: Re-queue Air B");
    } else if (op == "RPH" || c.pendRphActive) {
        g_pendRph.active = true; g_pendRph.phase = 0;
        g_pendRph.nextAtMs = millis() + 500;
        g_pendingOp = "RPH";
        g_pfMissedCmtGuard = false;
        addLog("PF: Re-queue RPH");
    } else if (op == "AC-C" || (c.pendAirActive && c.airSrc == 'C')) {
        g_pendAir.active = true; g_pendAir.src = 'C';
        g_pendAir.nextAtMs = millis() + 500;
        g_pendingOp = "AC-C";
        g_pfMissedCmtGuard = false;
        addLog("PF: Re-queue Air C");
    } else {
        addLog("PF: Master ckpt idle/unknown — clear");
        mstPfClear();
        g_autoSmpChain = false;
        g_linkState = "IDLE";
        g_pfMissedCmtGuard = false;
    }
}

void addLog(const String& line) {
    if (!g_logMux) return;
    if (xSemaphoreTake(g_logMux, pdMS_TO_TICKS(50)) != pdTRUE) return;
    strncpy(g_logs[g_logHead], line.c_str(), LOG_LEN - 1);
    g_logs[g_logHead][LOG_LEN - 1] = 0;
    g_logHead = (g_logHead + 1) % LOG_MAX;
    if (g_logCount < LOG_MAX) g_logCount++;
    g_logSeq++;
    xSemaphoreGive(g_logMux);
}

void uartSend(const String& bodyNoHashStar);  // forward decl

void queueSamplingCycle(float sv, float fh, int st, float flt, bool fromAuto);  // forward decl

/** Start the sample the bath asked for while the previous chain was busy. */
static bool startQueuedSmpIfAny(const char* why, uint32_t delayMs = 0) {
    if (!g_queuedSmp.valid) return false;
    QueuedSmpStart q = g_queuedSmp;
    g_queuedSmp.valid = false;
    addLog(String("Queued SMP ST-") + String(q.step) + " starts now (" + (why ? why : "") + ")");
    queueSamplingCycle(q.sv, q.fh, (int)q.step, g_smpFillSec, true);
    if (delayMs) g_pendSmp.nextAtMs = millis() + delayMs;
    return true;
}

/** Abort auto chain and always raise probe so bath is not stuck DOWN. */
void abortAutoChain(const char* reason) {
    bool was = g_autoSmpChain;
    g_autoSmpChain = false;
    g_pendRph.active = false;
    g_pendSmp.active = false;
    g_pendAir.active = false;
    g_waitingCmt = false;
    g_pendingOp = "";
    g_linkState = "ERROR";
    // A sample request arrived during the failed chain — give it one attempt
    // (probe is still DOWN). If that also fails there is no queue left and
    // RPH-DONE below raises the probe.
    if (was && !g_bathPfPending && g_queuedSmp.valid) {
        addLog(String("Chain abort (") + (reason ? reason : "?") + ") — retry with queued SMP");
        mstPfClear();
        startQueuedSmpIfAny("after abort", 3000UL);  // let the sampler settle first
        return;
    }
    g_queuedSmp.valid = false;
    if (was) {
        // Only a real pending power-fail resume may keep the probe DOWN. A stale
        // probeDown/hold flag must not stop RPH-DONE, or the bath can never
        // sample again on the following test.
        if (!g_bathPfPending) {
            bathSendBody("RPH-DONE");
            g_bathPfProbeDown = false;
            g_bathPfHoldRph = false;
            addLog(String("Chain abort → bath #RPH-DONE* (") + (reason ? reason : "?") + ")");
            hostForward("#RPH-DONE,PROBE-UP,ABORT*");
        } else {
            addLog(String("Chain abort — probe stays DOWN (PF resume pending) (") +
                   (reason ? reason : "?") + ")");
        }
    }
    mstPfClear();
}

/** Clear everything the previous test left behind, just before #START-TEST*. */
void resetChainForNewTest() {
    bool stale = g_autoSmpChain || g_waitingCmt || g_pendSmp.active ||
                 g_pendAir.active || g_pendRph.active;
    g_autoSmpChain = false;
    g_waitingCmt = false;
    g_pendingOp = "";
    g_pendSmp.active = false;
    g_pendSmp.phase = 0;
    g_pendAir.active = false;
    g_pendRph.active = false;
    g_pendRph.phase = 0;
    g_queuedSmp.valid = false;
    g_cmtWaitSinceMs = 0;
    g_pfMissedCmtGuard = false;
    g_linkState = "IDLE";
    mstPfClear();
    if (stale) addLog("New test — cleared stale sampling chain");
}

/** Queue a full sampling cycle identical to the Sampling section (FLT then SMP). */
void queueSamplingCycle(float sv, float fh, int st, float flt, bool fromAuto) {
    if (flt < 0) flt = g_smpFillSec;
    if (flt < 1) flt = g_smpFillSec;
    g_smpFillSec = flt;

    // Master owns Air B / RPH / Air C during test — disable sampler-local AUTO air
    if (fromAuto) {
        g_airAuto = false;
        uartSend("MANUAL");
    }

    g_pendSmp.active = true;
    g_pendSmp.phase = 0;
    g_pendSmp.nextAtMs = millis() + (fromAuto ? 60UL : 0UL);  // let MANUAL ACK settle
    g_pendSmp.sv = sv;
    g_pendSmp.fh = fh;
    g_pendSmp.st = constrain(st, 1, 99);
    g_pendSmp.flt = flt;
    g_pendSmp.fromAuto = fromAuto;
    g_autoSmpChain = fromAuto;  // SMP → Air B → RPH → Air C → probe UP
    g_pendAir.active = false;
    g_pendRph.active = false;
    g_waitingCmt = true;
    g_pendingOp = "SMP";
    g_linkState = "BUSY";
    addLog(String(fromAuto ? "Auto" : "Manual") +
           " SMP queued FLT-" + String(flt, 0) +
           " SV-" + String(sv, 0) + " FH-" + String(fh, 0) +
           " ST-" + String(st));
    if (fromAuto) mstPfSave();
}

void queueAutoRphLw() {
    // #RPH,LW* using last withdraw from sampling (probe stays DOWN)
    g_pendRph.active = true;
    g_pendRph.phase = 0;
    g_pendRph.nextAtMs = millis() + 250UL;  // gap after Air B CMT
    g_waitingCmt = true;
    g_pendingOp = "RPH";
    g_linkState = "BUSY";
    addLog("Auto RPH,LW queued (probe stays DOWN)");
    mstPfSave();
}

/** src 'B' = after sampling, 'C' = after replenish (SRC-C). Deferred so sampler is IDLE. */
void queueAutoAirClean(char src) {
    g_pendAir.active = true;
    g_pendAir.src = (src == 'C') ? 'C' : 'B';
    g_pendAir.nextAtMs = millis() + 400UL;
    g_waitingCmt = true;
    g_pendingOp = (g_pendAir.src == 'C') ? "AC-C" : "AC-B";
    g_linkState = "BUSY";
    addLog(String("Auto Air ") + g_pendAir.src + " queued (after settle)");
    mstPfSave();
}

void pollPendingAir() {
    if (!g_pendAir.active) return;
    if ((int32_t)(millis() - g_pendAir.nextAtMs) < 0) return;

    char buf[48];
    if (g_pendAir.src == 'C') {
        snprintf(buf, sizeof(buf), "AC,EXTV-%.1f,SRC-C", g_airExtv);
        g_pendingOp = "AC-C";
        hostForward("#AC-AUTO,SRC-C*");
        addLog("Auto Air C after RPH (EXTV-" + String(g_airExtv, 1) + ")");
    } else {
        snprintf(buf, sizeof(buf), "AC,EXTV-%.1f", g_airExtv);  // SRC-B default
        g_pendingOp = "AC-B";
        hostForward("#AC-AUTO,SRC-B*");
        addLog("Auto Air B after SMP (EXTV-" + String(g_airExtv, 1) + ")");
    }
    uartSend(String(buf));
    g_pendAir.active = false;
    g_waitingCmt = true;
    g_linkState = "BUSY";
    g_cmtWaitSinceMs = millis();
    mstPfSave();
}

void pollPendingRph() {
    if (!g_pendRph.active) return;
    if ((int32_t)(millis() - g_pendRph.nextAtMs) < 0) return;

    if (g_pendRph.phase == 0) {
        char fbuf[32];
        snprintf(fbuf, sizeof(fbuf), "RPH,FLT-%.0f", g_rphFillSec);
        uartSend(String(fbuf));
        g_pendRph.phase = 1;
        g_pendRph.nextAtMs = millis() + 80;
        return;
    }

    // Prefer explicit SV (survives sampler reboot); LW uses sampler lastWithdraw
    if (g_pendSmp.sv > 0.01f) {
        char buf[32];
        snprintf(buf, sizeof(buf), "RPH,SV-%.0f", g_pendSmp.sv);
        uartSend(String(buf));
        addLog(String("Auto RPH,SV-") + String(g_pendSmp.sv, 0));
    } else {
        uartSend("RPH,LW");
        addLog("Auto RPH,LW");
    }
    g_waitingCmt = true;
    g_pendingOp = "RPH";
    g_linkState = "BUSY";
    g_cmtWaitSinceMs = millis();
    g_pendRph.active = false;
    hostForward("#RPH-AUTO,LW*");
    mstPfSave();
}

/** What the sampler says it finished: SMP / AC / RPH / DCL / INI ("" = not a CMT). */
static String cmtKindFromBody(const String& body) {
    if (body.startsWith("INI")) return "INI";
    if (body.indexOf("CMT,AC") >= 0) return "AC";
    if (body.indexOf("CMT,RPH") >= 0) return "RPH";
    if (body.indexOf("CMT,DCL") >= 0) return "DCL";
    if (body.indexOf("CMT") >= 0) return "SMP";   // #CMT,SV-..,FH-..,ST-..,ACK*
    return "";
}

/** Called when sampler CMT arrives — may continue auto chain. */
void onSamplerCmt(const String& body) {
    String finished = g_pendingOp;

    // Route by what the sampler actually completed, not just by what we were
    // waiting for. A late CMT from an earlier (dropped) chain must not be taken
    // as completion of the current op — that used to fire Air B while the sampler
    // was still sampling → BUSY error → chain abort → probe raised mid-sample.
    if (g_autoSmpChain && finished.length() > 0) {
        String kind = cmtKindFromBody(body);
        bool pendIsAir = (finished == "AC" || finished == "AC-B" || finished == "AC-C");
        bool match = (kind == "") ||
                     (kind == "SMP" && finished == "SMP") ||
                     (kind == "AC"  && pendIsAir) ||
                     (kind == "RPH" && finished == "RPH") ||
                     (kind == "DCL" && finished == "DCL") ||
                     (kind == "INI" && finished == "INI");
        if (!match) {
            addLog("Stale CMT (" + kind + ") while waiting " + finished + " — ignored");
            return;
        }
    }

    g_waitingCmt = false;
    g_cmtWaitSinceMs = 0;
    g_pfMissedCmtGuard = false;
    g_pendingOp = "";
    g_linkState = "DONE";

    // Normalize air CMT: sampler sends CMT,AC,... while pending was AC-B / AC-C
    if (finished == "AC" && g_autoSmpChain) {
        if (body.indexOf("SRC-C") >= 0) finished = "AC-C";
        else finished = "AC-B";
    }

    if (g_autoSmpChain && finished == "SMP") {
        // Sampling complete → Air B (after sampling)
        queueAutoAirClean('B');
        return;
    }
    if (g_autoSmpChain && finished == "AC-B") {
        // Air B done → replenish with last withdraw
        queueAutoRphLw();
        return;
    }
    if (g_autoSmpChain && finished == "RPH") {
        // #CMT,RPH,LW,ACK* → Air C (after replenish)
        queueAutoAirClean('C');
        return;
    }
    if (g_autoSmpChain && finished == "AC-C") {
        g_autoSmpChain = false;
        // Bath already asked for the next step's sample — keep the probe DOWN and
        // run it straight away instead of raising and losing that step.
        if (startQueuedSmpIfAny("chain finished", 500UL)) return;
        // Air C done → raise Sample Probe Arm on bath
        bathSendBody("RPH-DONE");
        g_bathPfProbeDown = false;
        g_bathPfHoldRph = false;
        addLog("Auto Air C done → bath #RPH-DONE* (probe UP)");
        hostForward("#RPH-DONE,PROBE-UP*");
        g_linkState = "IDLE";
        mstPfClear();
        return;
    }
    // Manual / non-chain ops
    if (g_autoSmpChain) mstPfSave();
    (void)body;
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
        g_pendSmp.nextAtMs = millis() + 80;  // gap so sampler accepts FLT before run
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
    g_cmtWaitSinceMs = millis();

    if (g_pendSmp.fromAuto) {
        char hbuf[72];
        snprintf(hbuf, sizeof(hbuf), "#SMP-AUTO,ST-%d,SV-%.0f,FH-%.0f,FLT-%.0f*",
                 g_pendSmp.st, g_pendSmp.sv, g_pendSmp.fh, g_pendSmp.flt);
        hostForward(String(hbuf));
    }

    g_pendSmp.active = false;
    mstPfSave();
}

void onBathMdvTimeout(uint16_t ml) {
    addLog("Media volume " + String(ml) + " ml — no bath ACK");
    hostForward("#ERR,MDV,ACK*");
}

void onBathSampleStart(uint8_t step, float sampleMl, float flushMl) {
    // Previous step's chain still running on the sampler (short steps / long
    // fill times). Sending SMP now would get ERR:BUSY and abort everything, so
    // queue it — it runs right after Air C, probe stays DOWN the whole time.
    if (g_autoSmpChain && (g_waitingCmt || g_pendSmp.active ||
                           g_pendAir.active || g_pendRph.active)) {
        if (g_queuedSmp.valid && g_queuedSmp.step == step) {
            addLog("SMP-START ST-" + String(step) + " repeated — already queued");
            return;
        }
        g_queuedSmp.valid = true;
        g_queuedSmp.step = step;
        g_queuedSmp.sv = sampleMl;
        g_queuedSmp.fh = flushMl;
        addLog("SMP-START ST-" + String(step) + " — chain busy (" + g_pendingOp +
               "), queued after Air C");
        hostForward("#SMP-QUEUED,ST-" + String(step) + "*");
        return;
    }
    // Not in a chain but a manual op is outstanding — clear bookkeeping only.
    if (g_waitingCmt || g_pendAir.active || g_pendRph.active) {
        addLog("SMP-START ST-" + String(step) + " — clearing stale op " + g_pendingOp);
        g_pendAir.active = false;
        g_pendRph.active = false;
        g_waitingCmt = false;
        g_pendingOp = "";
        g_pfMissedCmtGuard = false;
        g_cmtWaitSinceMs = 0;
    }
    g_queuedSmp.valid = false;
    // Same path as Sampling section: FLT (session fill time) then SMP run
    queueSamplingCycle(sampleMl, flushMl, (int)step, g_smpFillSec, true);
}

// ── Sampler link: ACK-checked send queue (stop-and-wait) ───────────────
// Every command waits for the sampler's #OPCODE,...,ACK*. Silence, a garbled
// reply (#ERR,001/004*) or a bath-style #ERR,BAD* → automatic re-send, up to
// SLV_MAX_TRIES. Only then is it reported as a link failure.
#define SLV_ACK_TIMEOUT_MS 1500UL
#define SLV_MAX_TRIES      3
#define SLV_TXQ_LEN        12
static String   g_slvQ[SLV_TXQ_LEN];
static bool     g_slvQAck[SLV_TXQ_LEN];
static uint8_t  g_slvQHead = 0, g_slvQCount = 0;
static String   g_slvPendFrame;
static String   g_slvPendKey;
static bool     g_slvPendActive = false;
static uint32_t g_slvPendSentMs = 0;
static uint8_t  g_slvPendTries = 0;
static uint32_t g_slvRetries = 0;
static uint32_t g_slvTxFailed = 0;
static UartFramer g_slvFramer;

/** One write() per frame. */
static void slvWriteNow(const String& frame) {
    String f = frame;
    f += '\n';
    SlaveSerial.print(f);
    addLog("TX " + frame);
}

static void slvQueuePush(const String& frame, bool expectAck) {
    if (g_slvQCount >= SLV_TXQ_LEN) {
        addLog("Sampler TXQ FULL — drop " + frame);
        return;
    }
    uint8_t idx = (uint8_t)((g_slvQHead + g_slvQCount) % SLV_TXQ_LEN);
    g_slvQ[idx] = frame;
    g_slvQAck[idx] = expectAck;
    g_slvQCount++;
}

static void slvClearPending() {
    g_slvPendActive = false;
    g_slvPendKey = "";
    g_slvPendFrame = "";
}

/** Re-send the outstanding command right now (NACK from the sampler). */
static bool slvResendPending(const char* why) {
    if (!g_slvPendActive) return false;
    if (g_slvPendTries >= SLV_MAX_TRIES) return false;
    g_slvPendTries++;
    g_slvRetries++;
    g_slvPendSentMs = millis();
    addLog(String("Sampler re-send ") + g_slvPendTries + "/" + SLV_MAX_TRIES +
           " (" + why + ") " + g_slvPendFrame);
    slvWriteNow(g_slvPendFrame);
    return true;
}

/** loop(): retry on timeout, then send the next queued frame. */
static void slvTxPoll() {
    if (g_slvPendActive) {
        if ((millis() - g_slvPendSentMs) < SLV_ACK_TIMEOUT_MS) return;
        if (slvResendPending("no ACK")) return;
        g_slvTxFailed++;
        addLog("Sampler NO ACK after " + String(SLV_MAX_TRIES) + " tries: " + g_slvPendFrame);
        g_linkState = "NOLINK";
        slvClearPending();
    }
    if (g_slvQCount == 0) return;
    String frame = g_slvQ[g_slvQHead];
    bool expectAck = g_slvQAck[g_slvQHead];
    g_slvQ[g_slvQHead] = "";
    g_slvQHead = (uint8_t)((g_slvQHead + 1) % SLV_TXQ_LEN);
    g_slvQCount--;
    if (expectAck) {
        g_slvPendFrame = frame;
        g_slvPendKey = uartFrameKey(frame);
        g_slvPendTries = 1;
        g_slvPendSentMs = millis();
        g_slvPendActive = true;
    }
    slvWriteNow(frame);
}

/** Does this sampler reply acknowledge the outstanding command? */
static bool slvAckMatches(const String& up) {
    if (!g_slvPendActive || g_slvPendKey.length() == 0) return false;
    if (up.indexOf("ACK") < 0) return false;
    if (g_slvPendKey == "STATUS" || g_slvPendKey == "STS")
        return up.startsWith("STS") || up.startsWith("STATUS");
    return up.startsWith(g_slvPendKey);
}

void uartSend(const String& bodyNoHashStar) {
    String frame = "#" + bodyNoHashStar + "*";
    String key = uartFrameKey(frame);
    if (key == "ESTOP" || key == "STOP") {
        // Emergency: jump the queue, drop whatever was waiting
        g_slvQHead = 0; g_slvQCount = 0;
        slvClearPending();
        slvWriteNow(frame);
        return;
    }
    slvQueuePush(frame, true);
}

void uartSendRawFrame(const String& frame) {
    String f = frame;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    slvQueuePush(f, true);
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
        // #ERR,00N,...*  001 gen 002 busy 003 not-init 004 bad-param 005 fail …
        int code = -1;
        if (body.length() >= 7 && body.charAt(3) == ',') code = body.substring(4, 7).toInt();
        bool unreadable = (code == 1 || code == 4 || body.indexOf("BAD") >= 0);
        if (g_slvPendActive) {
            if (unreadable) {
                // Our frame reached the sampler damaged → send it again
                if (slvResendPending("sampler could not read frame")) return;
            } else if (code == 2 && g_slvPendTries > 1) {
                // BUSY answering a RE-SEND: the first copy was accepted, only its
                // ACK got lost. The cycle is running — keep waiting for its CMT.
                addLog("Sampler BUSY on re-send → command already running, continue");
                slvClearPending();
                return;
            }
            slvClearPending();
        }
        if (body.indexOf("M2") >= 0 || body.indexOf("DOWN") >= 0)
            addLog("Sampler M2 fault: " + line);
        abortAutoChain(line.c_str());
        return;
    }
    if (body.indexOf(",ACK") >= 0 || body.endsWith("ACK")) {
        g_lastAck = line;
        if (slvAckMatches(body)) slvClearPending();
        if (body.indexOf("CMT") >= 0 || body.startsWith("CMT") || body.startsWith("INI,CMT")) {
            // Confirm receipt — the sampler re-sends a CMT until it sees this
            slvWriteNow("#CMT,RCVD,ACK*");
            if (line == g_lastCmt && (millis() - g_lastCmtMs) < 6000UL) {
                addLog("Duplicate CMT (sampler re-send) — ignored");
                return;
            }
            g_lastCmt = line;
            g_lastCmtMs = millis();
            onSamplerCmt(body);
        } else if (g_waitingCmt) {
            g_linkState = "BUSY";
        } else {
            g_linkState = "IDLE";
        }
        return;
    }
    if (body.startsWith("CMT") || body.indexOf(",CMT") >= 0) {
        slvWriteNow("#CMT,RCVD,ACK*");
        if (line == g_lastCmt && (millis() - g_lastCmtMs) < 6000UL) {
            addLog("Duplicate CMT (sampler re-send) — ignored");
            return;
        }
        g_lastCmt = line;
        g_lastCmtMs = millis();
        onSamplerCmt(body);
    }
}

void pollSlave() {
    static String frame;
    while (SlaveSerial.available()) {
        char c = (char)SlaveSerial.read();
        if (g_slvFramer.feed(c, frame)) handleSlaveLine(frame);
    }
    slvTxPoll();
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

/** Fast JSON status. ?lite=1 skips logs (keeps web responsive). */
void handleStatus() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Cache-Control", "no-cache");

    const bool lite = server.hasArg("lite") && server.arg("lite") != "0";
    // 32 log lines × 100 chars alone can reach ~3.3 KB; a truncated buffer means
    // the closing "]}" is dropped → invalid JSON → UI stops updating.
    static char buf[6144];
    size_t n = 0;

    auto ap = [&](const char* s) {
        if (!s) return;
        size_t L = strlen(s);
        if (n + L >= sizeof(buf) - 1) return;
        memcpy(buf + n, s, L); n += L;
    };
    auto apEsc = [&](const String& s) {
        for (size_t i = 0; i < s.length() && n + 2 < sizeof(buf); i++) {
            char c = s[i];
            if (c == '"' || c == '\\') { buf[n++] = '\\'; buf[n++] = c; }
            else if (c == '\n' || c == '\r') { buf[n++] = ' '; }
            else buf[n++] = c;
        }
    };
    auto apNum = [&](unsigned long v) {
        char t[16]; snprintf(t, sizeof(t), "%lu", v); ap(t);
    };
    auto apF = [&](float v, int dec) {
        char t[24]; dtostrf(v, 0, dec, t); ap(t);
    };

    ap("{\"state\":\""); apEsc(g_linkState);
    ap("\",\"waiting\":"); ap(g_waitingCmt ? "true" : "false");
    ap(",\"pending\":\""); apEsc(g_pendingOp);
    ap("\",\"lastRx\":\""); apEsc(g_lastRx);
    ap("\",\"lastAck\":\""); apEsc(g_lastAck);
    ap("\",\"lastCmt\":\""); apEsc(g_lastCmt);
    ap("\",\"lastErr\":\""); apEsc(g_lastErr);
    ap("\",\"lastRxAgeMs\":"); apNum(g_lastRxMs ? (millis() - g_lastRxMs) : 0);
    ap(",\"airAuto\":"); ap(g_airAuto ? "true" : "false");
    ap(",\"autoChain\":"); ap(g_autoSmpChain ? "true" : "false");
    ap(",\"smpQueuedStep\":"); apNum((unsigned long)(g_queuedSmp.valid ? g_queuedSmp.step : 0));
    ap(",\"smpFillSec\":"); apF(g_smpFillSec, 1);
    ap(",\"rphFillSec\":"); apF(g_rphFillSec, 1);
    ap(",\"dclFillSec\":"); apF(g_dclFillSec, 1);
    ap(",\"airExtv\":"); apF(g_airExtv, 2);
    ap(",\"tubeA\":"); apF(g_tubeA, 2);
    ap(",\"tubeB\":"); apF(g_tubeB, 2);
    ap(",\"tubeC\":"); apF(g_tubeC, 2);
    ap(",\"tubeD\":"); apF(g_tubeD, 2);
    ap(",\"wifi\":\""); ap(WiFi.localIP().toString().c_str());
    ap("\",\"bathState\":\""); apEsc(g_bathState);
    ap("\",\"bathPf\":"); ap(g_bathPfPending ? "true" : "false");
    ap(",\"bathPfStep\":"); apNum((unsigned long)g_bathPfStep);
    ap(",\"bathPfProbeDown\":"); ap(g_bathPfProbeDown ? "true" : "false");
    ap(",\"bathPfHold\":"); ap(g_bathPfHoldRph ? "true" : "false");
    ap(",\"bathMediaVol\":"); apNum((unsigned long)g_bathMediaVol);
    ap(",\"mdvWaitAck\":"); ap(bathMediaVolumePending() ? "true" : "false");
    ap(",\"bathLastRx\":\""); apEsc(g_bathLastRx);
    ap("\",\"bathLastAck\":\""); apEsc(g_bathLastAck);
    ap("\",\"bathLastErr\":\""); apEsc(g_bathLastErr);
    ap("\",\"bathLastRxAgeMs\":"); apNum(g_bathLastRxMs ? (millis() - g_bathLastRxMs) : 0);
    ap(",\"bathTxQueued\":"); apNum((unsigned long)g_bathTxQueued);
    ap(",\"bathTxSent\":"); apNum((unsigned long)g_bathTxSent);
    ap(",\"bathQDepth\":"); apNum(bathTxQ ? (unsigned long)uxQueueMessagesWaiting(bathTxQ) : 0);
    // Link health: re-sends / failures / dropped junk bytes per link
    ap(",\"bathRetries\":"); apNum((unsigned long)g_bathRetries);
    ap(",\"bathTxFailed\":"); apNum((unsigned long)g_bathTxFailed);
    ap(",\"bathJunk\":"); apNum((unsigned long)g_bathFramer.junk);
    ap(",\"bathWaitAck\":"); ap(g_bathPendActive ? "true" : "false");
    ap(",\"slvRetries\":"); apNum((unsigned long)g_slvRetries);
    ap(",\"slvTxFailed\":"); apNum((unsigned long)g_slvTxFailed);
    ap(",\"slvJunk\":"); apNum((unsigned long)g_slvFramer.junk);
    ap(",\"slvWaitAck\":"); ap(g_slvPendActive ? "true" : "false");
    ap(",\"slvQDepth\":"); apNum((unsigned long)g_slvQCount);
    ap(",\"hostUart\":"); ap(HOST_UART_ENABLED ? "true" : "false");
    ap(",\"hostState\":\""); apEsc(g_hostState);
    ap("\",\"hostLastRx\":\""); apEsc(g_hostLastRx);
    ap("\",\"hostLastAck\":\""); apEsc(g_hostLastAck);
    ap("\",\"hostLastRxAgeMs\":"); apNum(g_hostLastRxMs ? (millis() - g_hostLastRxMs) : 0);
    ap(",\"hostRxCount\":"); apNum((unsigned long)g_hostRxCount);
    ap(",\"hostTxCount\":"); apNum((unsigned long)g_hostTxCount);
    ap(",\"logSeq\":"); apNum((unsigned long)g_logSeq);
    ap(",\"heap\":"); apNum((unsigned long)ESP.getFreeHeap());

    if (lite) {
        ap(",\"logs\":[]}");
    } else {
        ap(",\"logs\":[");
        if (g_logMux && xSemaphoreTake(g_logMux, pdMS_TO_TICKS(40)) == pdTRUE) {
            int start = (g_logCount < LOG_MAX) ? 0 : g_logHead;
            int cnt = g_logCount;
            for (int i = 0; i < cnt; i++) {
                int idx = (start + i) % LOG_MAX;
                // Always leave room for a full escaped line plus the closing "]}"
                if (n + (LOG_LEN * 2) + 8 >= sizeof(buf)) break;
                if (i) ap(",");
                ap("\"");
                // escape log line in place
                const char* e = g_logs[idx];
                for (; *e && n + 3 < sizeof(buf); e++) {
                    if (*e == '"' || *e == '\\') { buf[n++] = '\\'; buf[n++] = *e; }
                    else buf[n++] = *e;
                }
                ap("\"");
            }
            xSemaphoreGive(g_logMux);
        }
        ap("]}");
    }
    buf[n] = 0;
    server.send(200, "application/json", buf);
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
        if (cv == "MDV" || cv == "MEDIA_VOLUME" || cv == "MEDIA-VOL") {
            uint16_t ml = (uint16_t)ju(body, "mediaVolume", ju(body, "mdv", ju(body, "vol", 0)));
            if (!bathSetMediaVolume(ml)) {
                server.send(400, "application/json", "{\"error\":\"Media volume must be 500 or 900\"}");
                return;
            }
            addLog("Media volume " + String(ml) + " ml → bath (awaiting ACK)");
            server.send(200, "application/json",
                        "{\"status\":\"sent\",\"target\":\"bath\",\"frame\":\"#MDV-" + String(ml) + "*\"}");
            return;
        }
        if (cv == "LOAD_RECIPE" || cv == "RECIPE") {
            float t = jf(body, "temp", jf(body, "targetTemp", 37.0f));
            uint8_t n = (uint8_t)constrain((int)ju(body, "steps", 1), 1, 12);
            String rpm = js(body, "rpm", "");
            String dur = js(body, "dur", "");
            String sml = js(body, "sml", "");
            String fl = js(body, "fl", "");
            uint16_t mdv = (uint16_t)ju(body, "mediaVolume", ju(body, "mdv", 0));
            if (rpm.length() == 0 || dur.length() == 0 || sml.length() == 0 || fl.length() == 0) {
                server.send(400, "application/json", "{\"error\":\"Need rpm+dur+sml+fl lists\"}");
                return;
            }
            bathLoadRecipeSeq(t, n, rpm, dur, sml, fl, mdv);
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
        if (cv == "PF-RESUME" || cv == "PF-RESUME-TEST" || cv == "PF_RESUME") {
            // Continue bath timer from checkpoint; keep probe DOWN if sampling chain active
            bathPfResumeTest();
            if (g_autoSmpChain || g_pendSmp.active || g_pendAir.active || g_pendRph.active ||
                g_waitingCmt) {
                addLog("PF Resume: bath continued — sampler chain still active (probe stays DOWN)");
            } else if (g_bathPfHoldRph || g_bathPfProbeDown) {
                // Sampler idle but probe was held — re-check / wait; do NOT force RPH-DONE
                addLog("PF Resume: probe was DOWN — waiting sampler or manual RPH-DONE");
                bathPfStatus();
            }
            g_bathPfPending = false;
            server.send(200, "application/json", "{\"status\":\"sent\",\"target\":\"bath\",\"frame\":\"#PF-RESUME-TEST*\"}");
            return;
        }
        if (cv == "PF-STATUS") {
            bathPfStatus();
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
    bathSetNewTestFn(resetChainForNewTest);
    bathSetMdvTimeoutFn(onBathMdvTimeout);
    hostSetLogFn(addLog);

    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);

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
#if HOST_UART_ENABLED
    Serial.println(F("UART0 Host:    TX=41 RX=16 @9600 (supervisory control)"));
    Serial.println(F("  → External controller RX←41  TX→16 (crossed)"));
#else
    Serial.println(F("UART0:         serial monitor (host link OFF — enable 'USB CDC On Boot' for GPIO41/16 host UART)"));
#endif
    Serial.println(F("Buzzer:        GPIO42  (#BEEP* / #BEEP-1* / #BEEP-2*)"));
    addLog("Buzzer GPIO42 ready");

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
    // Master owns test air/replenish chain — sampler MANUAL by default
    uartSend("MANUAL");
    g_airAuto = false;
    addLog("Sampler MANUAL — test chain: SMP→AirB→RPH→AirC→probe UP");
    // Restore interrupted auto chain if any
    mstPfResume();
    // Ask bath if a mid-test checkpoint exists (probe may be DOWN)
    bathPfStatus();
}

// ── Loop ────────────────────────────────────────────────────────
void loop() {
    // Keep web responsive without starving UART (was 6× every loop → lag under load)
    server.handleClient();
    server.handleClient();
    pollSlave();
    bathPoll();
    hostPoll();
    pollPendingSampling();   // FLT → SMP
    pollPendingAir();        // Air B / Air C (deferred)
    pollPendingRph();        // FLT → RPH,LW
    bathMdvPoll();           // re-send media volume until bath ACKs
    // CMT watchdog for the test chain: a lost/garbled CMT line (or a sampler that
    // finished while we were rebooting after power-fail) must not freeze the chain
    // with the probe DOWN forever. Limits are well above real cycle times.
    if (g_autoSmpChain && g_waitingCmt && g_cmtWaitSinceMs != 0 &&
        !g_pendSmp.active && !g_pendAir.active && !g_pendRph.active) {
        String op = g_pendingOp;
        uint32_t lim = (op == "SMP") ? 600000UL :          // fill wait + 12 tubes
                       (op == "RPH") ? 300000UL : 180000UL; // Air B / Air C
        if ((millis() - g_cmtWaitSinceMs) > lim) {
            addLog(String(g_pfMissedCmtGuard ? "PF: " : "") + "CMT wait timeout op=" + op +
                   " — assume done, continue chain");
            g_pfMissedCmtGuard = false;
            onSamplerCmt(String("CMT,") + op + ",ACK");
        }
    }
    pollBuzzer();
    yield();

    static uint32_t lastWC = 0;
    if (millis() - lastWC > 15000UL) {
        lastWC = millis();
        if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    }
}
