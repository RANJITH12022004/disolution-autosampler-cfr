#!/usr/bin/env bash
# Soft repair stub for internal USB mount path.
# Real recovery (fsck/remount) is handled by systemd mount units when present.
set -euo pipefail

INTERNAL="${INTERNAL_USB_PATH:-/media/usb_internal}"
echo "kiosk_repair_internal_usb: ensuring mount point exists at $INTERNAL"
mkdir -p "$INTERNAL" "${STORAGE_DIR:-$INTERNAL/storage}" "${REPORTS_DIR:-$INTERNAL/reports}" "${AUDIT_DB_DIR:-$INTERNAL/db}" 2>/dev/null || true

# Try a non-destructive remount if already mounted read-only.
if mountpoint -q "$INTERNAL" 2>/dev/null; then
  if findmnt -no OPTIONS "$INTERNAL" 2>/dev/null | grep -q '\bro\b'; then
    echo "kiosk_repair_internal_usb: attempting remount rw"
    mount -o remount,rw "$INTERNAL" 2>/dev/null || true
  fi
  exit 0
fi

# Best-effort: ask systemd to start the mount unit if defined.
systemctl start media-usb_internal.mount 2>/dev/null || true
systemctl start kiosk-internal-usb-mount.service 2>/dev/null || true
exit 0
