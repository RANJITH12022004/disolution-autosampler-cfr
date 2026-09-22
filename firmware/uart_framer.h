#ifndef UART_FRAMER_H
#define UART_FRAMER_H

#include <Arduino.h>

/**
 * Byte-wise "#...*" frame extractor shared by the sampler, bath and host links.
 *
 * Everything outside a frame (line noise, debug text, a frame that lost its
 * '*') is dropped silently and only counted. Line-based parsing used to turn
 * such bytes into "bad" commands / bogus ERR lines that aborted the chain.
 */
struct UartFramer {
    char buf[220];
    size_t len = 0;
    bool inFrame = false;
    uint32_t junk = 0;

    // Returns true when `out` holds a complete "#...*" frame.
    bool feed(char c, String& out) {
        if (c == '#') {                       // (re)start — recovers from a lost '*'
            if (inFrame && len > 1) junk++;
            inFrame = true;
            len = 0;
            buf[len++] = '#';
            return false;
        }
        if (!inFrame) {
            if (c != '\r' && c != '\n' && c != ' ' && c != 0) junk++;
            return false;
        }
        if (c == '*') {
            buf[len++] = '*';
            buf[len] = 0;
            out = buf;
            inFrame = false;
            len = 0;
            return true;
        }
        if (c == '\r' || c == '\n' || len + 2 >= sizeof(buf)) {   // broken frame
            inFrame = false;
            len = 0;
            junk++;
            return false;
        }
        buf[len++] = c;
        return false;
    }
};

/** "#CMD,a,b*" → "CMD" ; "#TS-03*" → "TS-03" (upper-case, no #/*). */
static inline String uartFrameKey(const String& frameIn) {
    String b = frameIn;
    b.trim();
    if (b.startsWith("#")) b = b.substring(1);
    if (b.endsWith("*")) b = b.substring(0, b.length() - 1);
    int c = b.indexOf(',');
    if (c >= 0) b = b.substring(0, c);
    b.trim();
    b.toUpperCase();
    return b;
}

#endif
