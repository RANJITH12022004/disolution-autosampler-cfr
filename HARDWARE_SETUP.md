# Hardware Setup - Dissolution Tester (Dual ESP)

Pin mapping and configuration for Raspberry Pi with **two ESP32 UARTs**, A4 printer, biometric, and RTC.

---

## Pin Mapping

### UART-1 — Command / Auto-sampler ESP

| Raspberry Pi       | ESP32  | Notes                    |
|--------------------|--------|--------------------------|
| GPIO14 (Pin 8)     | RX     | Pi TX -> ESP32 RX        |
| GPIO15 (Pin 10)    | TX     | Pi RX -> ESP32 TX        |
| GND                | GND    | Common ground            |

**Device:** `/dev/serial0` (`ESP_CMD_PORT`, baud 9600)

Protocol frames: `#TS-*`, `#RPM,*`, `#DUR,*`, `#SML,*`, `#FL-*`, `#START-TEST*`, `#PAUSE-TEST*`, `#STOP-TEST*`, lift/clean/cal. See `Auto sampler disso comm.txt`.

### UART-2 — Temperature / Status ESP

| Raspberry Pi   | ESP32 | Device Node   |
|----------------|-------|---------------|
| GPIO 4 (TX)    | RX    |               |
| GPIO 5 (RX)    | TX    | `/dev/ttyAMA3`|
| GND            | GND   |               |

**Env:** `ESP_TEMP_PORT=/dev/ttyAMA3`, `ESP_TEMP_BAUD=9600`

Commands: `#TEMP*`, `#TEMP-A-1SEC*`, `#STATUES*` — replies are bath,EXT,VSL1..6 (8 floats).

> Note: This port was previously used for a thermal printer. Dissolution has **no thermal printer**.

### A4 Printer

| Raspberry Pi   | Printer | Device Node   |
|----------------|---------|---------------|
| GPIO 8 (TX)    | RX      | `/dev/ttyAMA4`|
| GPIO 9 (RX)    | TX      |               |
| GND            | GND     |               |

### R307 Fingerprint

| Raspberry Pi       | R307 | Device Node   |
|--------------------|------|---------------|
| GPIO12 (Pin 32)    | RX   | `/dev/ttyAMA5`|
| GPIO13 (Pin 33)    | TX   |               |

### RTC (DS1307)

I2C on GPIO2/3 — `dtoverlay=i2c-rtc,ds1307`

---

## Environment Variables

| Variable       | Default        | Description                    |
|----------------|----------------|--------------------------------|
| ESP_CMD_PORT   | /dev/serial0   | Command ESP UART               |
| ESP_CMD_BAUD   | 9600           | Command ESP baud               |
| ESP_TEMP_PORT  | /dev/ttyAMA3   | Temperature ESP UART           |
| ESP_TEMP_BAUD  | 9600           | Temperature ESP baud           |
| A4_PORT        | /dev/ttyAMA4   | A4 printer UART                |
| BIOMETRIC_PORT | /dev/ttyAMA5   | R307 fingerprint               |
| SIMULATE_HARDWARE | 0           | `1` = in-memory dual-ESP sim   |

---

## Raspberry Pi config.txt

```txt
enable_uart=1
dtoverlay=uart3,txd4_pin=4,rxd5_pin=5
dtoverlay=uart4,txd8_pin=8,rxd9_pin=9
dtoverlay=uart5,txd12_pin=12,rxd13_pin=13
dtoverlay=i2c-rtc,ds1307
```

---

## Power failure resume

Recipe field `powerFailure` (1–60 min). On unclean restart within that window the Pi auto re-uploads remaining steps and `#START-TEST*` without login. On any login, Continue/Abort modal records multi-operator trail on the report.
