#!/bin/bash
# Full-screen Chromium for the Dissolution Tester kiosk (labwc autostart).
set -euo pipefail

KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
CHROME_BIN=""
if command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="chromium"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="chromium-browser"
else
  echo "chromium not found" >&2
  exit 1
fi

exec "$CHROME_BIN" \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --force-device-scale-factor=1 \
  --kiosk \
  --incognito \
  --disable-session-crashed-bubble \
  --touch-events=enabled \
  --enable-touch-drag-drop \
  --disable-features=TranslateUI,TouchpadAndWheelScrollLatching,AsyncWheelEvents \
  --disable-translate \
  --disable-save-password-bubble \
  --disable-notifications \
  --no-first-run \
  --check-for-update-interval=31536000 \
  --window-size=1024,600 \
  --app="${KIOSK_URL%/}"
