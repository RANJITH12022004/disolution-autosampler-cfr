#!/usr/bin/env bash
# Force WaveShare (HDMI-A-2) as the only enabled head at 0,0.
# Phantom HDMI-A-1 (empty EDID) must stay disabled or Chromium opens off-screen
# and the kiosk looks stuck on a blank/terminal display.
set -euo pipefail

LOG_TAG="set_kiosk_display"
prefer="${KIOSK_DISPLAY_MODE:-1024x600}"
REAL_OUT="${KIOSK_REAL_OUTPUT:-HDMI-A-2}"
PHANTOM_OUT="${KIOSK_PHANTOM_OUTPUT:-HDMI-A-1}"

log() { echo "$LOG_TAG: $*"; }

if ! command -v wlr-randr >/dev/null 2>&1; then
  log "wlr-randr missing; leaving mode unchanged"
  exit 0
fi

# Retry briefly — outputs appear a moment after labwc starts.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  out="$(wlr-randr 2>/dev/null || true)"
  if printf '%s\n' "$out" | grep -q "^${REAL_OUT} "; then
    break
  fi
  sleep 0.5
done

out="$(wlr-randr 2>/dev/null || true)"
if [[ -z "$out" ]]; then
  log "no wlr-randr outputs yet"
  exit 0
fi

# Always park the phantom head first so Chromium cannot land on it.
if printf '%s\n' "$out" | grep -q "^${PHANTOM_OUT} "; then
  wlr-randr --output "$PHANTOM_OUT" --off 2>/dev/null || true
  log "disabled $PHANTOM_OUT"
fi

if ! printf '%s\n' "$out" | grep -q "^${REAL_OUT} "; then
  # Fallback: first non-phantom head
  REAL_OUT="$(printf '%s\n' "$out" | awk -v phantom="$PHANTOM_OUT" '/^[A-Za-z0-9-]+ /{ if ($1 != phantom) { print $1; exit } }')"
  if [[ -z "${REAL_OUT:-}" ]]; then
    log "no real output found"
    exit 0
  fi
  log "using fallback output $REAL_OUT"
fi

# Preferred mode, then first listed mode for that output.
if wlr-randr --output "$REAL_OUT" --on --mode "$prefer" --pos 0,0 --transform normal 2>/dev/null; then
  log "set $REAL_OUT to $prefer @ 0,0"
elif wlr-randr --output "$REAL_OUT" --on --preferred --pos 0,0 --transform normal 2>/dev/null; then
  log "set $REAL_OUT to preferred @ 0,0"
else
  mode="$(printf '%s\n' "$out" | awk -v o="$REAL_OUT" '
    $0 ~ "^"o" " {p=1; next}
    p && /^[A-Za-z0-9-]+ / {exit}
    p && /px,/ { gsub(/px.*/,""); gsub(/^ +/,""); print $1; exit }
  ')"
  if [[ -n "${mode:-}" ]] && wlr-randr --output "$REAL_OUT" --on --mode "$mode" --pos 0,0 --transform normal 2>/dev/null; then
    log "set $REAL_OUT to $mode (fallback) @ 0,0"
  else
    log "failed to configure $REAL_OUT"
    exit 0
  fi
fi

# Re-assert phantom off after mode changes (some stacks re-enable it).
wlr-randr --output "$PHANTOM_OUT" --off 2>/dev/null || true
exit 0
