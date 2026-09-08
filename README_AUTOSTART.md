# Kiosk Autostart (Dissolution Tester)

Production boot is **CLI / terminal mode**, not the full Raspberry Pi desktop.

## Boot model

1. `systemd` default target: **`multi-user.target`** (console)
2. `getty@tty1` autologins user `rle`
3. `/home/rle/.bash_profile` starts **labwc** in a restart loop (Wayland kiosk seat)
4. `~/.config/labwc/autostart` runs kanshi + display fix, waits for Flask, launches Chromium
5. Flask API/UI: **`kiosk-bridge.service`** → `/opt/kiosk/run_hardness_bridge.sh` → `bridge.py` / `app.py` on `:5000`

Do **not** enable `graphical.target` / LightDM for this machine. LightDM should stay disabled so it cannot fight the console kiosk path.

## Key files

| Role | Path |
|------|------|
| Console → labwc | `/home/rle/.bash_profile` |
| Labwc autostart | `/home/rle/.config/labwc/autostart` |
| Bridge unit | `/etc/systemd/system/kiosk-bridge.service` (source: `/opt/kiosk/kiosk-bridge.service`) |
| Ready wait | `/opt/kiosk/scripts/wait_kiosk_bridge_ready.sh` |
| Chromium | `/opt/kiosk/scripts/launch_chromium_kiosk.sh` |
| Display | `/opt/kiosk/scripts/set_kiosk_display.sh`, `~/.config/kanshi/config` |

## Service commands

```bash
sudo systemctl status kiosk-bridge
sudo systemctl restart kiosk-bridge
journalctl -u kiosk-bridge -n 80 --no-pager
tail -f ~/kiosk_bridge.log ~/kiosk_chrome.log ~/kiosk_wayland.log
```

## Blank screen troubleshooting

1. Confirm CLI boot: `systemctl get-default` → `multi-user.target`
2. Confirm bridge: `systemctl is-active kiosk-bridge`
3. Confirm compositor: `pgrep -a labwc`
4. Confirm browser: `pgrep -a chromium`
5. Read `~/kiosk_wayland.log` (labwc DRM/seat failures used to exit once and leave a blank tty; the bash_profile loop now restarts labwc)

WaveShare is on **HDMI-A-2** at position 0,0. Phantom **HDMI-A-1** (empty EDID) must stay **disabled** — if it stays enabled at (0,0), Chromium opens on the phantom head and the physical panel looks like a blank terminal. `set_kiosk_display.sh` and kanshi enforce this; cmdline must not force `video=HDMI-A-1`.

## Notes

- There is no `kiosk.service` that starts Chromium. Only `kiosk-bridge.service` is systemd-managed for the app; the GUI depends on tty1 + labwc.
- Orphan helpers (`start_kiosk.sh`, `.xinitrc`) are not the production path.
