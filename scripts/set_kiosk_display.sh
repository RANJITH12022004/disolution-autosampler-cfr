#!/usr/bin/env bash
# Best-effort kiosk display mode for WaveShare / labwc.
# Autostart calls this; missing file caused boot log noise and wrong modes.
set -euo pipefail

LOG_TAG="set_kiosk_display"
prefer="${KIOSK_DISPLAY_MODE:-1024x600}"

if command -v wlr-randr >/dev/null 2>&1; then
  out="$(wlr-randr 2>/dev/null || true)"
  if [[ -n "$out" ]]; then
    # Pick first connected output name
    output="$(printf '%s\n' "$out" | awk '/^[A-Za-z0-9-]+ /{print $1; exit}')"
    if [[ -n "${output:-}" ]]; then
      if wlr-randr --output "$output" --mode "$prefer" 2>/dev/null; then
        echo "$LOG_TAG: set $output to $prefer"
        exit 0
      fi
      # Fall back to first listed mode line if preferred fails
      mode="$(printf '%s\n' "$out" | awk '/px,/{gsub(/px.*/,""); gsub(/^ +/,""); print $1; exit}')"
      if [[ -n "${mode:-}" ]] && wlr-randr --output "$output" --mode "$mode" 2>/dev/null; then
        echo "$LOG_TAG: set $output to $mode (fallback)"
        exit 0
      fi
    fi
  fi
fi

if command -v xrandr >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  if xrandr --output HDMI-1 --mode "$prefer" 2>/dev/null \
    || xrandr --output HDMI-A-1 --mode "$prefer" 2>/dev/null; then
    echo "$LOG_TAG: xrandr set $prefer"
    exit 0
  fi
fi

echo "$LOG_TAG: no compositor display tool available; leaving mode unchanged"
exit 0
