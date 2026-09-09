#ifndef BATH_UART_H
#define BATH_UART_H

#include <Arduino.h>
#include <HardwareSerial.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// Master ↔ Unit-2 Dissolution Bath (Hardware_disso)
// Cross TX/RX @ 9600:
//   Master GPIO17 (TX) → Bath GPIO40 (RX)
//   Master GPIO18 (RX) ← Bath GPIO1  (TX)
// Bath protocol: #COMMAND*  (see Hardware_disso/commands.h)
//
// TX is queued + sent from a high-priority FreeRTOS task so WiFi/Web
// cannot delay bath commands.

#define BATH_UART_TX_PIN   17
#define BATH_UART_RX_PIN   18
#define BATH_UART_BAUD     9600
#define BATH_TXQ_LEN       24
#define BATH_FRAME_MAX     160
#define BATH_GAP_MS        25   // gap between queued frames (bath needs time to ACK)

struct BathTxItem {
    char frame[BATH_FRAME_MAX];
    uint16_t gapMs;
};

static HardwareSerial BathSerial(2);
static QueueHandle_t bathTxQ = nullptr;
static TaskHandle_t bathTaskHandle = nullptr;

static String g_bathLastRx = "";
static String g_bathLastAck = "";
static String g_bathLastErr = "";
static String g_bathState = "BOOT";
static uint32_t g_bathLastRxMs = 0;
static volatile uint32_t g_bathTxQueued = 0;
static volatile uint32_t g_bathTxSent = 0;

typedef void (*BathLogFn)(const String& line);
typedef void (*BathSampleStartFn)(uint8_t step, float sampleMl, float flushMl);
typedef void (*BathEventFn)(const String& line);

static BathLogFn g_bathLogFn = nullptr;
static BathSampleStartFn g_bathSampleStartFn = nullptr;
static BathEventFn g_bathEventFn = nullptr;

static void bathSetLogFn(BathLogFn fn) { g_bathLogFn = fn; }
static void bathSetSampleStartFn(BathSampleStartFn fn) { g_bathSampleStartFn = fn; }
static void bathSetEventFn(BathEventFn fn) { g_bathEventFn = fn; }

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
        g_bathState = "ERROR";
        return;
    }

    // Bath probe arm DOWN → start liquid sampling cycle on sampler UART
    // Format: #SMP-START,ST-1,SV-10.0,FH-2.0*
    if (up.startsWith("SMP-START")) {
        g_bathLastAck = line;
        g_bathState = "BUSY";
        uint8_t step = (uint8_t)constrain((int)bathParseTaggedFloat(up, "ST-", 1), 1, 12);
        float sv = bathParseTaggedFloat(up, "SV-", 10.0f);
        float fh = bathParseTaggedFloat(up, "FH-", 2.0f);
        if (sv <= 0.0f) sv = 10.0f;
        if (fh <= 0.0f) fh = 2.0f;
        if (g_bathSampleStartFn) g_bathSampleStartFn(step, sv, fh);
        return;
    }

    if (up.indexOf(",ACK") >= 0 || up.endsWith("ACK") ||
        up.startsWith("PRE-DONE") || up.startsWith("END-TEST") ||
        up.startsWith("LF-CL-HOME") || up.startsWith("RECIPE") ||
        up.startsWith("READY") || up.startsWith("STATUS")) {
        g_bathLastAck = line;
        if (up.startsWith("END-TEST")) g_bathState = "DONE";
        else if (up.startsWith("PRE-DONE")) g_bathState = "READY";
        else g_bathState = "IDLE";
    }
}

static void bathPollRx() {
    static char buf[256];
    static size_t len = 0;
    while (BathSerial.available()) {
        char c = (char)BathSerial.read();
        if (c == '\n' || c == '\r') {
            if (len > 0) {
                buf[len] = 0;
                bathHandleLine(String(buf));
                len = 0;
            }
        } else if (len + 1 < sizeof(buf)) {
            buf[len++] = c;
        } else {
            len = 0;
        }
    }
}

static bool bathEnqueueFrame(const String& frameIn, uint16_t gapMs = BATH_GAP_MS) {
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

    if (xQueueSend(bathTxQ, &item, pdMS_TO_TICKS(50)) != pdTRUE) {
        bathLog("BATH TXQ FULL — drop " + f);
        return false;
    }
    g_bathTxQueued++;
    return true;
}

static void bathSendNow(const char* frame) {
    BathSerial.print(frame);
    BathSerial.print('\n');
    BathSerial.flush();
    g_bathTxSent++;
    bathLog(String("BATH TX ") + frame);
}

static void bathTaskFn(void* arg) {
    (void)arg;
    BathTxItem item;
    for (;;) {
        bathPollRx();

        if (xQueueReceive(bathTxQ, &item, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (item.gapMs > 0) {
                // Keep reading RX during inter-frame gap
                uint32_t start = millis();
                while ((millis() - start) < item.gapMs) {
                    bathPollRx();
                    vTaskDelay(pdMS_TO_TICKS(2));
                }
            }
            bathSendNow(item.frame);
            bathPollRx();
        }
    }
}

static void bathUartBegin() {
    BathSerial.setRxBufferSize(1024);
    BathSerial.setTxBufferSize(512);
    BathSerial.begin(BATH_UART_BAUD, SERIAL_8N1, BATH_UART_RX_PIN, BATH_UART_TX_PIN);
    BathSerial.setTimeout(10);

    bathTxQ = xQueueCreate(BATH_TXQ_LEN, sizeof(BathTxItem));
    // Core 0, high priority — independent of WiFi/Web (core 1)
    xTaskCreatePinnedToCore(bathTaskFn, "bathUart", 4096, nullptr, 6, &bathTaskHandle, 0);

    g_bathState = "IDLE";
    bathLog("Bath UART ready @9600 TX17/RX18 (queued task)");
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

/** Queue full recipe frames (no HTTP blocking delays). */
static void bathLoadRecipeSeq(float temp, uint8_t steps,
                              const String& rpmCsv, const String& durCsv,
                              const String& smlCsv, const String& flCsv) {
    char tbuf[32], sbuf[16];
    snprintf(tbuf, sizeof(tbuf), "SET-TEMP-%.1f", temp);
    snprintf(sbuf, sizeof(sbuf), "TS-%02u", (unsigned)steps);
    bathSendBodyGap(String(tbuf), 10);
    bathSendBodyGap(String(sbuf), 35);
    bathSendBodyGap("RPM," + rpmCsv, 35);
    bathSendBodyGap("DUR," + durCsv, 35);
    bathSendBodyGap("SML," + smlCsv, 35);
    bathSendBodyGap("FL," + flCsv, 35);
}

static void bathPreHeat()      { bathSendBody("PRE-HEAT"); }
static void bathStartTest() {
    // Immediate / short-gap — do not sit behind a long queue delay
    bathEnqueueFrame("#START-TEST*", 5);
    g_bathState = "BUSY";
}
static void bathPauseTest()    { bathSendBody("PAUSE-TEST"); }
static void bathResumeTest()   { bathSendBody("RESUME-TEST"); }
static void bathStopTest()     { bathSendBody("STOP-TEST"); }
static void bathEstop() {
    // ESTOP: flush queue and send immediately
    if (bathTxQ) xQueueReset(bathTxQ);
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

#endif
