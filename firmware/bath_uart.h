#ifndef BATH_UART_H
#define BATH_UART_H

#include <Arduino.h>
#include <HardwareSerial.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include "uart_framer.h"

// Master ↔ Unit-2 Dissolution Bath (Hardware_disso)
// Cross TX/RX @ 9600:
//   Master GPIO17 (TX) → Bath GPIO40 (RX)
//   Master GPIO18 (RX) ← Bath GPIO1  (TX)
// Bath protocol: #COMMAND*  (see Hardware_disso/commands.h)
//
// TX: queued, sent from a FreeRTOS task, STOP-AND-WAIT — the next command
//     goes out only after the bath ACKed the previous one (or 3 tries failed).
//     No ACK / #ERR,BAD* → automatic re-send.
// RX: parsed in loop() only (it drives master state); the task never touches
//     the RX buffer. Reading RX from two cores used to shred frames.

#define BATH_UART_TX_PIN   17
#define BATH_UART_RX_PIN   18
#define BATH_UART_BAUD     9600
#define BATH_TXQ_LEN       24
#define BATH_FRAME_MAX     160
#define BATH_GAP_MS        25   // gap between queued frames (bath needs time to ACK)
#define BATH_ACK_TIMEOUT_MS 1500UL
#define BATH_MAX_TRIES      3

struct BathTxItem {
    char frame[BATH_FRAME_MAX];
    uint16_t gapMs;
    bool expectAck;
};

static HardwareSerial BathSerial(2);
static QueueHandle_t bathTxQ = nullptr;
static TaskHandle_t bathTaskHandle = nullptr;

// Command awaiting its ACK (written by the TX task, flags set by loop RX)
static char g_bathPendKey[48] = {0};
static volatile bool g_bathPendActive = false;
static volatile bool g_bathPendAcked = false;
static volatile bool g_bathPendNack = false;     // #ERR,BAD* → re-send now
static volatile bool g_bathPendReject = false;   // other #ERR → stop retrying
static volatile uint32_t g_bathRetries = 0;
static volatile uint32_t g_bathTxFailed = 0;
static UartFramer g_bathFramer;
static uint8_t  g_bathSmpLastStep = 0;   // duplicate SMP-START (bath re-send) filter
static uint32_t g_bathSmpLastMs = 0;

static String g_bathLastRx = "";
static String g_bathLastAck = "";
static String g_bathLastErr = "";
static String g_bathState = "BOOT";
static uint32_t g_bathLastRxMs = 0;
static volatile uint32_t g_bathTxQueued = 0;
static volatile uint32_t g_bathTxSent = 0;
static bool g_bathPfPending = false;
static uint8_t g_bathPfStep = 0;
static bool g_bathPfProbeDown = false;
static bool g_bathPfHoldRph = false;

// Media volume recipe parameter (#MDV-500* / #MDV-900*) — bath must ACK it
#define BATH_MDV_ACK_TIMEOUT_MS 2500UL
#define BATH_MDV_MAX_TRIES      3
static uint16_t g_bathMediaVol = 900;      // last value the bath confirmed
static uint16_t g_mdvPendingVol = 0;       // 0 = not waiting
static uint32_t g_mdvSentMs = 0;
static uint8_t  g_mdvTries = 0;

typedef void (*BathLogFn)(const String& line);
typedef void (*BathSampleStartFn)(uint8_t step, float sampleMl, float flushMl);
typedef void (*BathEventFn)(const String& line);
typedef void (*BathNewTestFn)();
typedef void (*BathMdvTimeoutFn)(uint16_t ml);

static BathLogFn g_bathLogFn = nullptr;
static BathSampleStartFn g_bathSampleStartFn = nullptr;
static BathEventFn g_bathEventFn = nullptr;
static BathNewTestFn g_bathNewTestFn = nullptr;
static BathMdvTimeoutFn g_bathMdvTimeoutFn = nullptr;

static void bathSetLogFn(BathLogFn fn) { g_bathLogFn = fn; }
static void bathSetSampleStartFn(BathSampleStartFn fn) { g_bathSampleStartFn = fn; }
static void bathSetEventFn(BathEventFn fn) { g_bathEventFn = fn; }
/** Called right before #START-TEST* so the master can reset stale chain state. */
static void bathSetNewTestFn(BathNewTestFn fn) { g_bathNewTestFn = fn; }
/** Called when the bath never acknowledged a media volume after all retries. */
static void bathSetMdvTimeoutFn(BathMdvTimeoutFn fn) { g_bathMdvTimeoutFn = fn; }

static void bathLog(const String& line) {
    if (g_bathLogFn) g_bathLogFn(line);
}

static float bathParseTaggedFloat(const String& up, const char* tag, float defVal) {
    // Prefer ",TAG" so "ST-" is not confused with "START"
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

static bool bathEnqueueFrame(const String& frameIn, uint16_t gapMs, bool expectAck);
static void bathSendNow(const char* frame);

/** Immediate ACK for a bath event (#SMP-START,ST-n,ACK* …). Not a command, so
 *  it bypasses the stop-and-wait queue; the bath re-sends events until it sees this. */
static void bathAckEvent(const String& body) {
    String f = "#" + body + ",ACK*";
    bathSendNow(f.c_str());
}

/** Does this bath reply acknowledge the command we are waiting for? */
static bool bathAckMatches(const String& up) {
    if (!g_bathPendActive || g_bathPendKey[0] == 0) return false;
    if (up.indexOf("ACK") < 0) return false;
    String key(g_bathPendKey);
    if (key == "GET-STATUS") return up.startsWith("STATUS");
    return up.startsWith(key);            // PRE-HEAT → PRE-HEATTING,ACK ; TS-03 → TS-03ACK
}

static void bathHandleLine(String line) {
    line.trim();
    if (line.length() == 0) return;
    g_bathLastRx = line;
    g_bathLastRxMs = millis();
    bathLog("BATH RX " + line);
    if (g_bathEventFn) g_bathEventFn(line);

    String body = line;
    if (body.startsWith("#")) body = body.substring(1);
    if (body.endsWith("*")) body = body.substring(0, body.length() - 1);
    body.trim();
    String up = body;
    up.toUpperCase();

    if (up.startsWith("ERR")) {
        g_bathLastErr = line;
        if (g_bathPendActive) {
            // BAD = the bath could not read our frame → send it again.
            // Anything else (LOCK/TMP/NRCP/TST…) is a real answer → stop retrying.
            if (up.indexOf("BAD") >= 0) g_bathPendNack = true;
            else g_bathPendReject = true;
        }
        g_bathState = "ERROR";
        if (up.indexOf("MDV") >= 0) {
            g_mdvPendingVol = 0;
            g_mdvTries = 0;
            bathLog("BATH rejected media volume");
        }
        return;
    }

    if (bathAckMatches(up)) g_bathPendAcked = true;

    // #BOOT,N-<count>,RST-<reason>,ACK* — bath (re)started. Mid-test this is the
    // evidence for "stirrer stopped / sampling stopped": the bath rebooted.
    if (up.startsWith("BOOT")) {
        g_bathLastAck = line;
        bool midTest = (g_bathState == "BUSY" || g_bathState == "READY");
        bathLog(String(midTest ? "BATH REBOOTED MID-TEST: " : "BATH boot: ") + body);
        // It may hold a power-fail checkpoint — ask (our boot-time query was
        // probably sent before the bath was listening)
        bathEnqueueFrame("#PF-STATUS*", 200, true);
        return;
    }

    // Bath: probe DOWN early (#PROBE-DOWN) — liquid sample starts at T-1s via #SMP-START
    // Format: #SMP-START,ST-1,SV-10.0,FH-2.0*
    if (up.startsWith("SMP-START")) {
        g_bathLastAck = line;
        g_bathState = "BUSY";
        uint8_t step = (uint8_t)constrain((int)bathParseTaggedFloat(up, "ST-", 1), 1, 12);
        float sv = bathParseTaggedFloat(up, "SV-", 10.0f);
        float fh = bathParseTaggedFloat(up, "FH-", 2.0f);
        if (sv <= 0.0f) sv = 10.0f;
        if (fh <= 0.0f) fh = 2.0f;
        bathAckEvent("SMP-START,ST-" + String(step));
        // The bath re-sends until ACKed — the same step again within a minute
        // is that retry, not a new sample request.
        if (step == g_bathSmpLastStep && (millis() - g_bathSmpLastMs) < 60000UL) {
            bathLog("BATH SMP-START ST-" + String(step) + " repeated — already handled");
            return;
        }
        g_bathSmpLastStep = step;
        g_bathSmpLastMs = millis();
        if (g_bathSampleStartFn) g_bathSampleStartFn(step, sv, fh);
        return;
    }

    if (up.startsWith("PROBE-DOWN")) {
        g_bathLastAck = line;
        int st = (int)bathParseTaggedFloat(up, "ST-", 0);
        bathAckEvent(st > 0 ? "PROBE-DOWN,ST-" + String(st) : String("PROBE-DOWN"));
        return;
    }

    // #MDV-500,ACK* / #MDV-900,ACK* — media volume confirmed by the bath
    if (up.startsWith("MDV-")) {
        g_bathLastAck = line;
        uint16_t v = (uint16_t)up.substring(4).toInt();
        if (v == 500 || v == 900) {
            g_bathMediaVol = v;
            if (g_mdvPendingVol == v) {
                g_mdvPendingVol = 0;
                g_mdvTries = 0;
                bathLog("BATH media volume ACK " + String(v) + " ml");
            }
        }
        if (!g_bathPfPending) g_bathState = "IDLE";
        return;
    }

    if (up.startsWith("PF-STATUS")) {
        g_bathLastAck = line;
        g_bathPfPending = ((int)bathParseTaggedFloat(up, "PEND-", 0) != 0);
        g_bathPfStep = (uint8_t)constrain((int)bathParseTaggedFloat(up, "ST-", 1), 1, 12);
        g_bathPfProbeDown = ((int)bathParseTaggedFloat(up, "PD-", 0) != 0);
        g_bathPfHoldRph = ((int)bathParseTaggedFloat(up, "HOLD-", 0) != 0);
        if (g_bathPfPending) g_bathState = "PF_WAIT";
        else if (g_bathState == "PF_WAIT") g_bathState = "IDLE";
        bathLog(g_bathPfPending
                    ? "BATH PF status: interrupted test at step " + String(g_bathPfStep) +
                          (g_bathPfProbeDown ? " (probe DOWN)" : "") + " — PF Resume available"
                    : String("BATH PF status: no interrupted test"));
        return;
    }

    // Bath rebooted mid-test — probe may still be DOWN; wait for user PF Resume
    if (up.startsWith("PF-TEST")) {
        g_bathLastAck = line;
        g_bathPfPending = true;
        g_bathPfStep = (uint8_t)constrain((int)bathParseTaggedFloat(up, "ST-", 1), 1, 12);
        g_bathPfProbeDown = ((int)bathParseTaggedFloat(up, "PD-", 0) != 0);
        g_bathPfHoldRph = ((int)bathParseTaggedFloat(up, "HOLD-", 0) != 0);
        g_bathState = "PF_WAIT";
        bathAckEvent("PF-TEST,ST-" + String(g_bathPfStep));
        bathLog("BATH PF-TEST pending step=" + String(g_bathPfStep) +
                " probeDown=" + String(g_bathPfProbeDown ? 1 : 0));
        return;
    }

    // Test-flow events the bath re-sends until we confirm them
    if (up.startsWith("PRE-DONE")) bathAckEvent("PRE-DONE");
    else if (up.startsWith("END-TEST")) bathAckEvent("END-TEST");

    if (up.startsWith("PF-RESUME-TEST")) {
        g_bathLastAck = line;
        g_bathPfPending = false;
        g_bathState = "BUSY";
        return;
    }

    if (up.indexOf(",ACK") >= 0 || up.endsWith("ACK") ||
        up.startsWith("PRE-DONE") || up.startsWith("END-TEST") ||
        up.startsWith("LF-CL-HOME") || up.startsWith("RECIPE") ||
        up.startsWith("READY") || up.startsWith("STATUS") ||
        up.startsWith("PF-STATUS")) {
        g_bathLastAck = line;
        if (up.startsWith("END-TEST")) g_bathState = "DONE";
        else if (up.startsWith("PRE-DONE")) g_bathState = "READY";
        else if (up.startsWith("READY") && g_bathPfPending) g_bathState = "PF_WAIT";
        else if (!g_bathPfPending) g_bathState = "IDLE";
    }
}

/** loop() only. Complete #...* frames are handled; everything else is dropped. */
static void bathPollRx() {
    static String frame;
    while (BathSerial.available()) {
        char c = (char)BathSerial.read();
        if (g_bathFramer.feed(c, frame)) bathHandleLine(frame);
    }
}

static bool bathEnqueueFrame(const String& frameIn, uint16_t gapMs, bool expectAck) {
    if (!bathTxQ) return false;
    String f = frameIn;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    if (f.length() >= BATH_FRAME_MAX) return false;

    BathTxItem item;
    memset(&item, 0, sizeof(item));
    strncpy(item.frame, f.c_str(), BATH_FRAME_MAX - 1);
    item.gapMs = gapMs;
    item.expectAck = expectAck;

    if (xQueueSend(bathTxQ, &item, pdMS_TO_TICKS(50)) != pdTRUE) {
        bathLog("BATH TXQ FULL — drop " + f);
        return false;
    }
    g_bathTxQueued++;
    return true;
}
static bool bathEnqueueFrame(const String& frameIn, uint16_t gapMs = BATH_GAP_MS) {
    return bathEnqueueFrame(frameIn, gapMs, true);
}

/** One write() per frame (called from loop and from the TX task). */
static void bathSendNow(const char* frame) {
    char out[BATH_FRAME_MAX + 2];
    size_t n = strlen(frame);
    if (n > BATH_FRAME_MAX) n = BATH_FRAME_MAX;
    memcpy(out, frame, n);
    out[n++] = '\n';
    BathSerial.write((const uint8_t*)out, n);
    g_bathTxSent++;
    bathLog(String("BATH TX ") + frame);
}

/** Stop-and-wait sender: send, wait for the matching ACK, re-send on silence
 *  or #ERR,BAD*, give up after BATH_MAX_TRIES. */
static void bathTaskFn(void* arg) {
    (void)arg;
    BathTxItem item;
    for (;;) {
        if (xQueueReceive(bathTxQ, &item, portMAX_DELAY) != pdTRUE) continue;
        if (item.gapMs > 0) vTaskDelay(pdMS_TO_TICKS(item.gapMs));

        if (!item.expectAck) {
            bathSendNow(item.frame);
            continue;
        }

        String key = uartFrameKey(String(item.frame));
        strncpy(g_bathPendKey, key.c_str(), sizeof(g_bathPendKey) - 1);
        g_bathPendKey[sizeof(g_bathPendKey) - 1] = 0;

        bool done = false;
        for (uint8_t tries = 1; tries <= BATH_MAX_TRIES && !done; tries++) {
            g_bathPendAcked = false;
            g_bathPendNack = false;
            g_bathPendReject = false;
            g_bathPendActive = true;
            if (tries > 1) {
                g_bathRetries = g_bathRetries + 1;
                bathLog(String("BATH re-send ") + tries + "/" + BATH_MAX_TRIES + " " + item.frame);
            }
            bathSendNow(item.frame);

            uint32_t t0 = millis();
            while ((millis() - t0) < BATH_ACK_TIMEOUT_MS) {
                if (g_bathPendAcked || g_bathPendReject || g_bathPendNack) break;
                vTaskDelay(pdMS_TO_TICKS(5));
            }
            g_bathPendActive = false;
            if (g_bathPendAcked || g_bathPendReject) done = true;
            else if (g_bathPendNack) vTaskDelay(pdMS_TO_TICKS(60));   // bath said BAD → retry
            // else: silence → retry
        }
        if (!done) {
            g_bathTxFailed = g_bathTxFailed + 1;
            bathLog(String("BATH NO ACK after ") + BATH_MAX_TRIES + " tries: " + item.frame);
            g_bathState = "NOLINK";
        }
        g_bathPendKey[0] = 0;
    }
}

static void bathUartBegin() {
    BathSerial.setRxBufferSize(1024);
    BathSerial.setTxBufferSize(512);
    BathSerial.begin(BATH_UART_BAUD, SERIAL_8N1, BATH_UART_RX_PIN, BATH_UART_TX_PIN);
    BathSerial.setTimeout(10);

    bathTxQ = xQueueCreate(BATH_TXQ_LEN, sizeof(BathTxItem));
    // Core 0, high priority — independent of WiFi/Web (core 1). TX only.
    xTaskCreatePinnedToCore(bathTaskFn, "bathUart", 4096, nullptr, 6, &bathTaskHandle, 0);

    g_bathState = "IDLE";
    bathLog("Bath UART ready @9600 TX17/RX18 (ACK-checked queue)");
}

// Non-blocking API used by HTTP handlers — enqueue only
static void bathSendBody(const String& bodyNoHashStar) {
    bathEnqueueFrame("#" + bodyNoHashStar + "*", BATH_GAP_MS);
    g_bathState = "BUSY";
}

static void bathSendRawFrame(const String& frameIn) {
    bathEnqueueFrame(frameIn, BATH_GAP_MS);
    g_bathState = "BUSY";
}

static void bathSendBodyGap(const String& bodyNoHashStar, uint16_t gapMs) {
    bathEnqueueFrame("#" + bodyNoHashStar + "*", gapMs);
    g_bathState = "BUSY";
}

// Keep for loop() compatibility (RX also handled in task)
static void bathPoll() {
    bathPollRx();
}

static void bathSetTemp(float t) {
    char buf[32];
    snprintf(buf, sizeof(buf), "SET-TEMP-%.1f", t);
    bathSendBody(String(buf));
}

static void bathSetSteps(uint8_t n) {
    char buf[16];
    snprintf(buf, sizeof(buf), "TS-%02u", (unsigned)n);
    bathSendBody(String(buf));
}

static void bathSetRpmList(const String& rpmCsv) {
    bathSendBody("RPM," + rpmCsv);
}

static void bathSetDurList(const String& durCsv) {
    bathSendBody("DUR," + durCsv);
}

static void bathSetSmlList(const String& smlCsv) {
    bathSendBody("SML," + smlCsv);
}

static void bathSetFlList(const String& flCsv) {
    bathSendBody("FL," + flCsv);
}

/** Media volume recipe parameter — only 500 or 900. Bath replies #MDV-nnn,ACK*. */
static bool bathSetMediaVolume(uint16_t ml) {
    if (ml != 500 && ml != 900) return false;
    char buf[16];
    snprintf(buf, sizeof(buf), "MDV-%u", (unsigned)ml);
    bathSendBodyGap(String(buf), 35);
    g_mdvPendingVol = ml;
    g_mdvSentMs = millis();
    g_mdvTries = 1;
    return true;
}

/** Re-send the media volume if the bath never acknowledged it. */
static void bathMdvPoll() {
    if (g_mdvPendingVol == 0) return;
    if ((millis() - g_mdvSentMs) < BATH_MDV_ACK_TIMEOUT_MS) return;
    if (g_mdvTries >= BATH_MDV_MAX_TRIES) {
        bathLog("BATH media volume ACK timeout — giving up");
        uint16_t failed = g_mdvPendingVol;
        g_mdvPendingVol = 0;
        g_mdvTries = 0;
        if (g_bathMdvTimeoutFn) g_bathMdvTimeoutFn(failed);
        return;
    }
    char buf[16];
    snprintf(buf, sizeof(buf), "MDV-%u", (unsigned)g_mdvPendingVol);
    bathSendBodyGap(String(buf), 20);
    g_mdvSentMs = millis();
    g_mdvTries++;
    bathLog("BATH media volume retry " + String(g_mdvTries));
}

static bool bathMediaVolumePending() { return g_mdvPendingVol != 0; }

/** Queue full recipe frames (no HTTP blocking delays). mdv 0 = leave unchanged. */
static void bathLoadRecipeSeq(float temp, uint8_t steps,
                              const String& rpmCsv, const String& durCsv,
                              const String& smlCsv, const String& flCsv,
                              uint16_t mdv = 0) {
    char tbuf[32], sbuf[16];
    snprintf(tbuf, sizeof(tbuf), "SET-TEMP-%.1f", temp);
    snprintf(sbuf, sizeof(sbuf), "TS-%02u", (unsigned)steps);
    bathSendBodyGap(String(tbuf), 10);
    bathSendBodyGap(String(sbuf), 35);
    if (mdv == 500 || mdv == 900) bathSetMediaVolume(mdv);
    bathSendBodyGap("RPM," + rpmCsv, 35);
    bathSendBodyGap("DUR," + durCsv, 35);
    bathSendBodyGap("SML," + smlCsv, 35);
    bathSendBodyGap("FL," + flCsv, 35);
}

static void bathPreHeat()      { bathSendBody("PRE-HEAT"); }
static void bathStopHeat()     { bathSendBody("STOP-HEAT"); }
static void bathStartTest() {
    // Drop any chain/PF state left behind by the previous test before it can
    // mis-route the first CMT of this one
    if (g_bathNewTestFn) g_bathNewTestFn();
    g_bathPfPending = false;
    g_bathPfProbeDown = false;
    g_bathPfHoldRph = false;
    g_bathSmpLastStep = 0;
    g_bathSmpLastMs = 0;
    // Immediate / short-gap — do not sit behind a long queue delay
    bathEnqueueFrame("#START-TEST*", 5);
    g_bathState = "BUSY";
}
static void bathPauseTest()    { bathSendBody("PAUSE-TEST"); }
static void bathResumeTest()   { bathSendBody("RESUME-TEST"); }
static void bathPfResumeTest() {
    // Continue interrupted test — do NOT raise probe; sampler chain may still be active
    bathEnqueueFrame("#PF-RESUME-TEST*", 5);
    g_bathPfPending = false;
    g_bathState = "BUSY";
}
static void bathPfStatus()     { bathSendBody("PF-STATUS"); }
static void bathStopTest()     { bathSendBody("STOP-TEST"); }
static void bathEstop() {
    // ESTOP: flush queue, cancel any ACK wait and send immediately
    if (bathTxQ) xQueueReset(bathTxQ);
    g_bathPendReject = true;
    bathSendNow("#ESTOP*");
    g_bathState = "IDLE";
}
static void bathGetStatus()    { bathSendBody("GET-STATUS"); }
static void bathClrRecipe()    { bathSendBody("CLR-RECIPE"); }
static void bathAutoDropOn()   { bathSendBody("AUTO-DROP-ON"); }
static void bathAutoDropOff()  { bathSendBody("AUTO-DROP-OFF"); }
static void bathStartPld(uint16_t rpm) {
    char buf[24];
    snprintf(buf, sizeof(buf), "START-PLD-%u", (unsigned)rpm);
    bathSendBody(String(buf));
}
static void bathStopPld()      { bathSendBody("STOP-PLD"); }
static void bathLiftUp()       { bathSendBody("LF-CU-UP"); }
static void bathLiftDown()     { bathSendBody("LF-CU-DOWN"); }
static void bathLiftStop()     { bathSendBody("LF-CU-STOP"); }
static void bathSampleHomeAfterRph() { bathSendBody("RPH-DONE"); }

#endif
