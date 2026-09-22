#pragma once
/**
 * Master-side recipe cache + local test clock.
 * Bath is polled once at START / PF-RESUME ACK; then master counts
 * duration / step / RPM from the stored recipe (no 1 Hz GET-STATUS).
 */
#include <Arduino.h>

#ifndef MST_MAX_STEPS
#define MST_MAX_STEPS 12
#endif

enum MstTestPhase : uint8_t {
    MST_TEST_IDLE = 0,
    MST_TEST_WAIT_ACK,   // START / PF-RESUME sent — waiting bath ACK
    MST_TEST_RUNNING,
    MST_TEST_PAUSED,
    MST_TEST_DONE
};

struct MstRecipe {
    bool     loaded = false;
    float    temp   = 37.0f;
    uint8_t  steps  = 0;
    uint16_t rpm[MST_MAX_STEPS];
    uint32_t durSec[MST_MAX_STEPS];
    float    sml[MST_MAX_STEPS];
    float    fl[MST_MAX_STEPS];
    uint16_t mdv = 0;
};

struct MstTestClock {
    MstTestPhase phase = MST_TEST_IDLE;
    uint8_t  step = 1;              // 1-based
    uint16_t rpm = 0;
    uint32_t stepDurSec = 0;
    uint32_t stepRemainSec = 0;
    uint32_t totalElapsedSec = 0;
    uint32_t totalRemainSec = 0;
    uint32_t totalDurSec = 0;
    uint32_t stepStartMs = 0;
    uint32_t remainAtStartSec = 0;
    uint32_t pauseAtMs = 0;
    bool     awaitStatusOnce = false;
    bool     pfMode = false;
    uint32_t pfRemHintSec = 0;
};

static MstRecipe g_mstRecipe;
static MstTestClock g_mstTest;

static uint32_t mstParseHms(const String& tok) {
    String t = tok;
    t.trim();
    if (t.length() == 0) return 0;
    int c1 = t.indexOf(':');
    if (c1 < 0) return (uint32_t)t.toInt();
    int c2 = t.indexOf(':', c1 + 1);
    if (c2 < 0) {
        return (uint32_t)t.substring(0, c1).toInt() * 60UL +
               (uint32_t)t.substring(c1 + 1).toInt();
    }
    return (uint32_t)t.substring(0, c1).toInt() * 3600UL +
           (uint32_t)t.substring(c1 + 1, c2).toInt() * 60UL +
           (uint32_t)t.substring(c2 + 1).toInt();
}

static void mstParseIndexF(const String& csv, float* out, uint8_t n, float defVal) {
    for (uint8_t i = 0; i < n; i++) out[i] = defVal;
    int start = 0;
    String s = csv;
    s.trim();
    while (start < (int)s.length()) {
        int comma = s.indexOf(',', start);
        String part = (comma < 0) ? s.substring(start) : s.substring(start, comma);
        part.trim();
        int dash = part.indexOf('-');
        if (dash > 0) {
            int idx = part.substring(0, dash).toInt();
            float v = part.substring(dash + 1).toFloat();
            if (idx >= 1 && idx <= (int)n) out[idx - 1] = v;
        }
        if (comma < 0) break;
        start = comma + 1;
    }
}

static void mstParseIndexU16(const String& csv, uint16_t* out, uint8_t n, uint16_t defVal) {
    float tmp[MST_MAX_STEPS];
    mstParseIndexF(csv, tmp, n, (float)defVal);
    for (uint8_t i = 0; i < n; i++) out[i] = (uint16_t)constrain((int)tmp[i], 0, 9999);
}

static void mstParseIndexDur(const String& csv, uint32_t* out, uint8_t n) {
    for (uint8_t i = 0; i < n; i++) out[i] = 0;
    int start = 0;
    String s = csv;
    s.trim();
    while (start < (int)s.length()) {
        int comma = s.indexOf(',', start);
        String part = (comma < 0) ? s.substring(start) : s.substring(start, comma);
        part.trim();
        int dash = part.indexOf('-');
        if (dash > 0) {
            int idx = part.substring(0, dash).toInt();
            uint32_t sec = mstParseHms(part.substring(dash + 1));
            if (idx >= 1 && idx <= (int)n) out[idx - 1] = sec;
        }
        if (comma < 0) break;
        start = comma + 1;
    }
}

static void mstRecipeClear() {
    g_mstRecipe = MstRecipe{};
    g_mstTest = MstTestClock{};
}

static void mstRecipeStore(float temp, uint8_t steps,
                           const String& rpmCsv, const String& durCsv,
                           const String& smlCsv, const String& flCsv,
                           uint16_t mdv = 0) {
    steps = (uint8_t)constrain((int)steps, 1, MST_MAX_STEPS);
    g_mstRecipe.loaded = true;
    g_mstRecipe.temp = temp;
    g_mstRecipe.steps = steps;
    g_mstRecipe.mdv = mdv;
    for (uint8_t i = 0; i < MST_MAX_STEPS; i++) {
        g_mstRecipe.rpm[i] = 0;
        g_mstRecipe.durSec[i] = 0;
        g_mstRecipe.sml[i] = 0;
        g_mstRecipe.fl[i] = 0;
    }
    mstParseIndexU16(rpmCsv, g_mstRecipe.rpm, steps, 100);
    mstParseIndexDur(durCsv, g_mstRecipe.durSec, steps);
    mstParseIndexF(smlCsv, g_mstRecipe.sml, steps, 10.0f);
    mstParseIndexF(flCsv, g_mstRecipe.fl, steps, 2.0f);

    g_mstTest.totalDurSec = 0;
    for (uint8_t i = 0; i < steps; i++) g_mstTest.totalDurSec += g_mstRecipe.durSec[i];
}

static void mstTestApplyStep(uint8_t step1, uint32_t remainSec) {
    if (!g_mstRecipe.loaded || g_mstRecipe.steps == 0) {
        g_mstTest.step = step1 ? step1 : 1;
        g_mstTest.stepRemainSec = remainSec;
        g_mstTest.remainAtStartSec = remainSec;
        g_mstTest.stepStartMs = millis();
        return;
    }
    if (step1 < 1) step1 = 1;
    if (step1 > g_mstRecipe.steps) step1 = g_mstRecipe.steps;
    g_mstTest.step = step1;
    g_mstTest.rpm = g_mstRecipe.rpm[step1 - 1];
    g_mstTest.stepDurSec = g_mstRecipe.durSec[step1 - 1];
    if (remainSec == 0 && g_mstTest.stepDurSec > 0) remainSec = g_mstTest.stepDurSec;
    if (g_mstTest.stepDurSec > 0 && remainSec > g_mstTest.stepDurSec)
        remainSec = g_mstTest.stepDurSec;
    g_mstTest.remainAtStartSec = remainSec;
    g_mstTest.stepRemainSec = remainSec;
    g_mstTest.stepStartMs = millis();

    uint32_t elapsed = 0;
    for (uint8_t i = 0; i + 1 < step1; i++) elapsed += g_mstRecipe.durSec[i];
    elapsed += (g_mstTest.stepDurSec > remainSec) ? (g_mstTest.stepDurSec - remainSec) : 0;
    g_mstTest.totalElapsedSec = elapsed;
    g_mstTest.totalRemainSec = (g_mstTest.totalDurSec > elapsed)
                                   ? (g_mstTest.totalDurSec - elapsed) : 0;
}

static void mstTestArmStart(bool pf, uint8_t pfStepHint) {
    g_mstTest.pfMode = pf;
    g_mstTest.phase = MST_TEST_WAIT_ACK;
    g_mstTest.awaitStatusOnce = true;
    if (!pf) {
        uint32_t rem = (g_mstRecipe.loaded && g_mstRecipe.steps > 0)
                           ? g_mstRecipe.durSec[0] : 0;
        mstTestApplyStep(1, rem);
    } else {
        uint8_t st = pfStepHint ? pfStepHint : 1;
        uint32_t rem = g_mstTest.pfRemHintSec;
        if (rem == 0 && g_mstRecipe.loaded && st >= 1 && st <= g_mstRecipe.steps)
            rem = g_mstRecipe.durSec[st - 1];
        mstTestApplyStep(st, rem);
    }
}

static void mstTestBeginRunning() {
    g_mstTest.phase = MST_TEST_RUNNING;
    g_mstTest.stepStartMs = millis();
}

static void mstTestPauseLocal() {
    if (g_mstTest.phase != MST_TEST_RUNNING) return;
    uint32_t elapsed = (millis() - g_mstTest.stepStartMs) / 1000UL;
    if (elapsed >= g_mstTest.remainAtStartSec) g_mstTest.stepRemainSec = 0;
    else g_mstTest.stepRemainSec = g_mstTest.remainAtStartSec - elapsed;
    g_mstTest.remainAtStartSec = g_mstTest.stepRemainSec;
    g_mstTest.phase = MST_TEST_PAUSED;
    g_mstTest.pauseAtMs = millis();
}

static void mstTestResumeLocal() {
    if (g_mstTest.phase != MST_TEST_PAUSED) return;
    g_mstTest.phase = MST_TEST_RUNNING;
    g_mstTest.stepStartMs = millis();
}

static void mstTestStopLocal(bool done) {
    g_mstTest.phase = done ? MST_TEST_DONE : MST_TEST_IDLE;
    g_mstTest.awaitStatusOnce = false;
    if (!done) {
        g_mstTest.stepRemainSec = 0;
        g_mstTest.totalRemainSec = 0;
    }
}

static void mstTestTick() {
    if (g_mstTest.phase != MST_TEST_RUNNING) return;

    uint32_t elapsed = (millis() - g_mstTest.stepStartMs) / 1000UL;
    if (elapsed >= g_mstTest.remainAtStartSec) {
        g_mstTest.stepRemainSec = 0;
        if (g_mstRecipe.loaded && g_mstTest.step < g_mstRecipe.steps) {
            mstTestApplyStep((uint8_t)(g_mstTest.step + 1),
                             g_mstRecipe.durSec[g_mstTest.step]);
            g_mstTest.phase = MST_TEST_RUNNING;
        } else {
            g_mstTest.totalElapsedSec = g_mstTest.totalDurSec;
            g_mstTest.totalRemainSec = 0;
        }
    } else {
        g_mstTest.stepRemainSec = g_mstTest.remainAtStartSec - elapsed;
    }

    if (!g_mstRecipe.loaded || g_mstRecipe.steps == 0) return;

    uint32_t donePrev = 0;
    for (uint8_t i = 0; i + 1 < g_mstTest.step; i++) donePrev += g_mstRecipe.durSec[i];
    uint32_t into = (g_mstTest.stepDurSec > g_mstTest.stepRemainSec)
                        ? (g_mstTest.stepDurSec - g_mstTest.stepRemainSec) : 0;
    g_mstTest.totalElapsedSec = donePrev + into;
    uint32_t after = 0;
    for (uint8_t i = g_mstTest.step; i < g_mstRecipe.steps; i++) after += g_mstRecipe.durSec[i];
    g_mstTest.totalRemainSec = g_mstTest.stepRemainSec + after;
    g_mstTest.rpm = g_mstRecipe.rpm[g_mstTest.step - 1];
}

static void mstFmtHms(uint32_t sec, char* buf, size_t n) {
    if (!buf || n < 9) return;
    uint32_t h = sec / 3600UL;
    uint32_t m = (sec % 3600UL) / 60UL;
    uint32_t s = sec % 60UL;
    snprintf(buf, n, "%02lu:%02lu:%02lu",
             (unsigned long)h, (unsigned long)m, (unsigned long)s);
}

static const char* mstTestPhaseStr() {
    switch (g_mstTest.phase) {
        case MST_TEST_WAIT_ACK: return "WAIT_ACK";
        case MST_TEST_RUNNING:  return "RUNNING";
        case MST_TEST_PAUSED:   return "PAUSED";
        case MST_TEST_DONE:     return "DONE";
        default:                return "IDLE";
    }
}

/** Sync from one-shot STATUS / PF-STATUS fields. */
static void mstTestSyncFromBath(uint8_t step1, uint32_t remSec, bool running) {
    if (step1 < 1) step1 = 1;
    uint32_t rem = remSec;
    if (rem == 0 && g_mstRecipe.loaded && step1 <= g_mstRecipe.steps)
        rem = g_mstRecipe.durSec[step1 - 1];
    mstTestApplyStep(step1, rem);
    if (running) g_mstTest.phase = MST_TEST_RUNNING;
}

static void mstTestNotePfRem(uint32_t remSec) {
    g_mstTest.pfRemHintSec = remSec;
    g_mstTest.pfMode = true;
}

/**
 * Handle bath ACK / events. Returns:
 *  0 = none
 *  1 = queue one GET-STATUS
 *  2 = queue one PF-STATUS
 */
static int mstTestOnBathFrame(const String& up) {
    if (up.startsWith("START-TEST") && up.indexOf("ACK") >= 0) {
        if (g_mstRecipe.loaded)
            mstTestApplyStep(1, g_mstRecipe.durSec[0]);
        mstTestBeginRunning();
        g_mstTest.pfMode = false;
        if (g_mstTest.awaitStatusOnce) {
            g_mstTest.awaitStatusOnce = false;
            return 1;
        }
        return 0;
    }
    if (up.startsWith("PF-RESUME-TEST") && up.indexOf("ACK") >= 0) {
        uint8_t st = g_mstTest.step ? g_mstTest.step : 1;
        uint32_t rem = g_mstTest.pfRemHintSec;
        if (rem == 0 && g_mstRecipe.loaded && st <= g_mstRecipe.steps)
            rem = g_mstRecipe.durSec[st - 1];
        mstTestApplyStep(st, rem);
        mstTestBeginRunning();
        if (g_mstTest.awaitStatusOnce) {
            g_mstTest.awaitStatusOnce = false;
            return 2;
        }
        return 0;
    }
    if (up.startsWith("PAUSE-TEST") && up.indexOf("ACK") >= 0) {
        mstTestPauseLocal();
        return 0;
    }
    if (up.startsWith("RESUME-TEST") && up.indexOf("ACK") >= 0) {
        mstTestResumeLocal();
        return 0;
    }
    if (up.startsWith("STOP-TEST") || (up.startsWith("ESTOP") && up.indexOf("ACK") >= 0)) {
        mstTestStopLocal(false);
        return 0;
    }
    if (up.startsWith("END-TEST")) {
        mstTestStopLocal(true);
        return 0;
    }
    if (up.startsWith("CLR-RECIPE") || up.startsWith("RECIPE,ACK") || up == "RECIPE,ACK") {
        // keep stored recipe on master; bath ACK only
        return 0;
    }
    return 0;
}
