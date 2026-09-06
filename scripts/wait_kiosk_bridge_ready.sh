#!/usr/bin/env bash
# Wait until Flask kiosk UI + health + CSS are ready (used by labwc autostart).
set -euo pipefail

KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
KIOSK_URL="${KIOSK_URL%/}/"
MAX_SEC="${KIOSK_READY_WAIT_SEC:-90}"

for _ in $(seq 1 "$MAX_SEC"); do
  if curl -sf --connect-timeout 1 "${KIOSK_URL}" >/dev/null 2>&1 \
    && curl -sf --connect-timeout 1 "${KIOSK_URL}api/health" >/dev/null 2>&1; then
    css="$(curl -sf --connect-timeout 2 "${KIOSK_URL}styles.css" 2>/dev/null || true)"
    if [[ -n "$css" && ${#css} -gt 1000 ]]; then
      exit 0
    fi
  fi
  sleep 1
done

echo "wait_kiosk_bridge_ready: timed out after ${MAX_SEC}s for ${KIOSK_URL}" >&2
exit 1
