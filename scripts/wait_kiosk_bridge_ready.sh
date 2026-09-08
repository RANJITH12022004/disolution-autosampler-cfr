#!/usr/bin/env bash
# Wait until Flask kiosk UI + health + CSS are ready (used by labwc autostart).
set -euo pipefail

KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
KIOSK_URL="${KIOSK_URL%/}/"
MAX_SEC="${KIOSK_READY_WAIT_SEC:-90}"
WARN_SEC="${KIOSK_READY_WARN_SEC:-15}"

log() { echo "$(date -Iseconds) wait_kiosk_bridge_ready: $*" >&2; }

log "waiting up to ${MAX_SEC}s for ${KIOSK_URL}"

for i in $(seq 1 "$MAX_SEC"); do
  if curl -sf --connect-timeout 1 "${KIOSK_URL}" >/dev/null 2>&1 \
    && curl -sf --connect-timeout 1 "${KIOSK_URL}api/health" >/dev/null 2>&1; then
    css="$(curl -sf --connect-timeout 2 "${KIOSK_URL}styles.css" 2>/dev/null || true)"
    if [[ -n "$css" && ${#css} -gt 1000 ]]; then
      log "ready after ${i}s (ui+health+css)"
      exit 0
    fi
    if (( i == WARN_SEC || i % 15 == 0 )); then
      log "ui/health ok but styles.css not ready yet (${i}s)"
    fi
  else
    if (( i == WARN_SEC || i % 15 == 0 )); then
      bridge_state="$(systemctl is-active kiosk-bridge 2>/dev/null || echo unknown)"
      log "bridge not ready yet (${i}s) kiosk-bridge=${bridge_state}"
    fi
  fi
  sleep 1
done

bridge_state="$(systemctl is-active kiosk-bridge 2>/dev/null || echo unknown)"
log "timed out after ${MAX_SEC}s for ${KIOSK_URL} (kiosk-bridge=${bridge_state})"
exit 1
