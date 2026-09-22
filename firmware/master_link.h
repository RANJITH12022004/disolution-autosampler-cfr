#pragma once
/**
 * Production link reliability — send once, wait for expected ACK/CMT,
 * retry on timeout (sampler UART1 + bath UART2).
 */
#include <Arduino.h>

#ifndef MST_LINK_MAX_TRIES
#define MST_LINK_MAX_TRIES 3
#endif
#ifndef MST_LINK_DEFAULT_TO_MS
#define MST_LINK_DEFAULT_TO_MS 8000UL
#endif

enum MstLinkTarget : uint8_t { MST_LINK_NONE = 0, MST_LINK_SMP = 1, MST_LINK_BATH = 2 };

struct MstLinkSlot {
    bool     active = false;
    uint8_t  target = MST_LINK_NONE;
    char     frame[120];
    char     expect[40];   // substring match on RX (uppercased), e.g. "CMT" or "RPH-DONE"
    uint8_t  tries = 0;
    uint8_t  maxTries = MST_LINK_MAX_TRIES;
    uint32_t sentAtMs = 0;
    uint32_t timeoutMs = MST_LINK_DEFAULT_TO_MS;
};

static MstLinkSlot g_mstLink;

typedef void (*MstLinkTxFn)(const String& frame);
typedef void (*MstLinkLogFn)(const String& line);

static MstLinkTxFn g_mstLinkTxSmp = nullptr;
static MstLinkTxFn g_mstLinkTxBath = nullptr;
static MstLinkLogFn g_mstLinkLog = nullptr;

static void mstLinkSetTx(MstLinkTxFn smp, MstLinkTxFn bath, MstLinkLogFn logFn) {
    g_mstLinkTxSmp = smp;
    g_mstLinkTxBath = bath;
    g_mstLinkLog = logFn;
}

static void mstLinkClear() {
    g_mstLink.active = false;
    g_mstLink.target = MST_LINK_NONE;
    g_mstLink.frame[0] = 0;
    g_mstLink.expect[0] = 0;
    g_mstLink.tries = 0;
}

static void mstLinkDoSend() {
    if (!g_mstLink.active) return;
    String f = String(g_mstLink.frame);
    if (g_mstLink.target == MST_LINK_SMP && g_mstLinkTxSmp) g_mstLinkTxSmp(f);
    else if (g_mstLink.target == MST_LINK_BATH && g_mstLinkTxBath) g_mstLinkTxBath(f);
    g_mstLink.sentAtMs = millis();
    g_mstLink.tries++;
    if (g_mstLinkLog) {
        char b[96];
        snprintf(b, sizeof(b), "LINK TX try %u/%u → %s",
                 (unsigned)g_mstLink.tries, (unsigned)g_mstLink.maxTries,
                 g_mstLink.frame);
        g_mstLinkLog(String(b));
    }
}

/** Arm a reliable send. frame includes #…* ; expect is uppercase match key. */
static void mstLinkArm(uint8_t target, const String& frameIn, const char* expect,
                       uint32_t timeoutMs = MST_LINK_DEFAULT_TO_MS,
                       uint8_t maxTries = MST_LINK_MAX_TRIES) {
    String f = frameIn;
    f.trim();
    if (!f.startsWith("#")) f = "#" + f;
    if (!f.endsWith("*")) f += "*";
    if (f.length() >= (int)sizeof(g_mstLink.frame)) return;

    g_mstLink.active = true;
    g_mstLink.target = target;
    strncpy(g_mstLink.frame, f.c_str(), sizeof(g_mstLink.frame) - 1);
    g_mstLink.frame[sizeof(g_mstLink.frame) - 1] = 0;
    strncpy(g_mstLink.expect, expect ? expect : "ACK", sizeof(g_mstLink.expect) - 1);
    g_mstLink.expect[sizeof(g_mstLink.expect) - 1] = 0;
    g_mstLink.tries = 0;
    g_mstLink.maxTries = maxTries ? maxTries : MST_LINK_MAX_TRIES;
    g_mstLink.timeoutMs = timeoutMs ? timeoutMs : MST_LINK_DEFAULT_TO_MS;
    mstLinkDoSend();
}

/** Call on every RX line (sampler or bath). Returns true if this cleared the wait. */
static bool mstLinkOnRx(uint8_t target, const String& lineIn) {
    if (!g_mstLink.active || g_mstLink.target != target) return false;
    String up = lineIn;
    up.toUpperCase();
    if (up.indexOf(g_mstLink.expect) < 0) return false;
    if (g_mstLinkLog)
        g_mstLinkLog(String("LINK OK expect=") + g_mstLink.expect + " got " + lineIn);
    mstLinkClear();
    return true;
}

/** Poll timeouts — retry or fail. Returns true if still waiting. */
static bool mstLinkPoll() {
    if (!g_mstLink.active) return false;
    if ((int32_t)(millis() - g_mstLink.sentAtMs) < (int32_t)g_mstLink.timeoutMs)
        return true;
    if (g_mstLink.tries < g_mstLink.maxTries) {
        if (g_mstLinkLog)
            g_mstLinkLog(String("LINK TIMEOUT — retry ") + g_mstLink.frame);
        mstLinkDoSend();
        return true;
    }
    if (g_mstLinkLog)
        g_mstLinkLog(String("LINK FAIL after retries: ") + g_mstLink.frame);
    mstLinkClear();
    return false;
}

static bool mstLinkBusy() { return g_mstLink.active; }
