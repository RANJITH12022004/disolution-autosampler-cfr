# Dissolution Autosampler — ESP ↔ Raspberry Pi Command Set

**Product:** Dissolution Tester (CFR kiosk)  
**Audience:** ESP32 firmware team  
**Frame format:** every command/reply uses `#` … `*`  
**Baud:** 9600 (both UARTs unless factory wiring says otherwise)

---

## 1. Dual UART overview

| Channel | Role | Pi device (default) | ESP responsibility |
|--------|------|---------------------|--------------------|
| **UART-1** | Commands / recipe / test / lift / clean / cal / init / beep | `/dev/serial0` (GPIO 14/15) | Parse `#…*`, act, reply with ACK or async events |
| **UART-2** | Continuous temperature + run status | `/dev/ttyAMA3` (ex-thermal port) | Reply to poll / stream temps + statues |

Do **not** mix roles: recipe/test frames only on UART-1; temperature CSV only on UART-2.

---

## 2. Framing rules (both ESPs)

1. Pi → ESP: `#PAYLOAD*`
2. ESP → Pi (ACK): usually `#PAYLOAD,ACK*` or echo of command plus `,ACK`
3. Payload must **not** contain `#` or `*`
4. Case: treat as case-insensitive; Pi sends uppercase keywords
5. After a command that expects ACK, ESP must reply promptly (Pi timeout ~3 s)
6. Async events (no prior poll) are allowed on UART-1 when hardware finishes an action (see §4)

**ACK examples accepted by Pi:**
- `#START-TEST,ACK*`
- `#TS-03ACK*` (ACK stuck to payload without comma — also accepted)
- `#BEEP,ACK*`

---

## 3. UART-1 — Command ESP

### 3.1 Recipe upload (before start / after power-loss resume)

Pi uploads **remaining** steps only, renumbered `1…N` (max **12** steps).

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#SET-TEMP-37.0*` | `#SET-TEMP-37.0,ACK*` | Set bath temperature first |
| 2 | `#TS-03*` | `#TS-03ACK*` or `#TS-03,ACK*` | Total step count (`NN` = 2-digit, e.g. `01`…`12`) |
| 3 | `#RPM,1-100,2-150,3-300*` | `#RPM,1-100,2-150,3-300,ACK*` (or echo+ACK) | RPM per step: `stepIndex-rpm` |
| 4 | `#DUR,1-00:01,00:15,00:55*` | `#DUR,…,ACK*` | Duration per step. **First** token is `index-MM:SS` (or `HH:MM:SS`); later tokens are times only |
| 5 | `#SML,1-10,2-15,3-13*` | `#SML,…,ACK*` | Sample volume (ml) per step: `index-volume` |
| 6 | `#FL-2ml*` | `#FL-2ml,ACK*` | Flush / rinse volume for the run |
| 7 | `#AUTO-DROP-ON*` or `#AUTO-DROP-OFF*` | `#AUTO-DROP-ON,ACK*` / `#AUTO-DROP-OFF,ACK*` | Sample Drop Auto / Manual |
| — | *(async after full recipe)* | `#RECIPE,ACK*` | Full recipe accepted |
| — | *(async on bad recipe)* | `#ERR,RCP,ACK*` | Recipe rejected |

**Notes for firmware**
- Temperature **must** be sent first (`#SET-TEMP-…*`).
- After all recipe frames ACK, ESP must emit `#RECIPE,ACK*` (or `#ERR,RCP,ACK*` on failure).
- Store the uploaded recipe until `#START-TEST*` or a new upload replaces it.
- On power-loss resume, Pi re-uploads remaining steps (possibly shortened first-step duration) then `#START-TEST*` again. ESP does **not** keep mid-test recipe across power loss.

---

### 3.2 Test control

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#PRE-HEAT*` | `#PRE-HEATTING,ACK*` then async `#PRE-DONE,ACK*` | Preheat until set temperature reached |
| 2 | `#START-TEST*` | `#START-TEST,ACK*` | Start (or resume after re-upload) using last recipe |
| 3 | `#PAUSE-TEST*` | `#PAUSE-TEST,ACK*` | Pause timers / motion as designed |
| 4 | `#STOP-TEST*` | `#STOP-TEST,ACK*` | Abort / stop test |
| 5 | *(async)* | `#END-TEST,ACK*` | **Unsolicited:** ESP finished all steps normally |

---

### 3.3 Stirrer / paddle (manual / validation)

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#START-PLD-150*` | `#START-PLD-150,ACK*` | Run stirrer / paddle at given RPM (integer) |
| 2 | `#STOP-PLD*` | `#STOP-PLD,ACK*` | Stop stirrer |

---

### 3.4 Lifting column

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#LF-CU-UP*` | `#LF-CU-UP,ACK*` | Move lift up |
| 2 | `#LF-CU-DOWN*` | `#LF-CU-DOWN,ACK*` | Move lift down |
| 3 | `#LF-CU-STOP*` | `#LF-CU-STOP,ACK*` | Stop lift motion |
| 4 | *(async)* | `#LF-CL-HOME,ACK*` | **Unsolicited:** stirrer/lift reached home |

---

### 3.5 Hardware initialise

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#INIT*` | `#INIT,ACK*` | Enter **safe idle**: stop test motion, stop RPM, home/safe lift as firmware defines, clear volatile run state |

Pi will not send `#INIT*` while a kiosk test is `RUNNING`/`PAUSED`. Still treat `#INIT*` as highest-priority safe state on ESP.

---

### 3.6 Beep / buzzer

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#BEEP*` | `#BEEP,ACK*` | Single beep |
| 2 | `#BEEP-3*` | `#BEEP-3,ACK*` | `N` beeps (`N` ≥ 2). Optional; if unsupported, treat `#BEEP-N*` as one beep and still ACK |

Tone / duration is firmware-defined; ACK means “beep sequence accepted/started”.

---

### 3.7 Sampling cleaning cycle

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#CL,CH-A,5ml*` | `#CL,CH-A,5ml,ACK*` | Clean channel A with volume |
| 2 | `#CL,CH-B,5ml*` | `#CL,CH-B,5ml,ACK*` | Channel B |
| 3 | `#CL,CH-C,5ml*` | `#CL,CH-C,5ml,ACK*` | Channel C |
| 4 | `#CL,CH-D,5ml*` | `#CL,CH-D,5ml,ACK*` | Channel D |
| 5 | `#CL,CH-E,5ml*` | `#CL,CH-E,5ml,ACK*` | Channel E |
| 6 | `#CL,CH-X,5ml*` | `#CL,CH-X,5ml,ACK*` | **All** channels (`X` = ALL) |
| 7 | *(async)* | `#CL,CH-X,5ml,FSH,ACK*` | **Unsolicited:** cleaning finished (`FSH` = finish). Channel/volume should match the active clean |

Channels: `A`–`E` or `X` (all). Volume is numeric + `ml` suffix.

---

### 3.8 Temperature calibration (command ESP applies offset / store)

Pi sends **one sensor per frame**. Value = operator **actual** °C.

| # | Pi → ESP | ESP → Pi | Sensor |
|---|----------|----------|--------|
| 1 | `#CAL,BT-36.5*` | `#CAL,BT-36.5,ACK*` | Bath |
| 2 | `#CAL,EXT-36.5*` | `#CAL,EXT-36.5,ACK*` | External |
| 3 | `#CAL,VSL1-36.5*` … `#CAL,VSL6-36.5*` | matching `,ACK*` | Vessel 1–6 |

---

### 3.9 Sample-volume calibration

| # | Pi → ESP | ESP → Pi | Meaning |
|---|----------|----------|---------|
| 1 | `#CAL,TSML-VL*` | `#CAL,TSML-VL,ACK*` | Start sample-volume cal mode |
| 2 | *(async)* | `#ENT-TSML-VL,ACK*` | ESP ready for operator to enter measured volume |
| 3 | `#CAL,TSML-24.1*` | `#CAL,TSML-24.1,ACK*` | Measured volume in ml (float allowed) |

---

## 4. UART-1 — Async events summary (ESP → Pi, unsolicited)

| Frame | When |
|-------|------|
| `#END-TEST,ACK*` | Multi-step test completed all steps |
| `#LF-CL-HOME,ACK*` | Lift/stirrer reached home |
| `#CL,CH-…,…ml,FSH,ACK*` | Cleaning cycle finished |
| `#ENT-TSML-VL,ACK*` | Sample-volume cal ready for measured value |

---

## 5. UART-2 — Temperature / status ESP

### 5.1 Temperature poll

| Pi → ESP | ESP → Pi | Meaning |
|----------|----------|---------|
| `#TEMP*` | `#36.5,30.2,26.1,27.2,29.1,26.5,28.2,26.2*` | One-shot reading |
| `#TEMP-A-1SEC*` | same CSV form (stream ~1 Hz) | Auto stream every 1 second until stopped by firmware policy / power cycle |

**CSV order (exactly 8 floats):**

1. Bath  
2. External  
3. Vessel 1  
4. Vessel 2  
5. Vessel 3  
6. Vessel 4  
7. Vessel 5  
8. Vessel 6  

Reply may be `#csv*` or bare `csv*` — Pi accepts both.

---

### 5.2 Status / statues poll

| Pi → ESP | ESP → Pi | Meaning |
|----------|----------|---------|
| `#STATUES*` | `#IDEL*` | Idle (**spelling `IDEL` is intentional** in this protocol; `IDLE` also accepted by Pi) |
| `#STATUES*` | `#TEST-RUNNING,ST-03/07,00:05:00/00:04:30*` | Test running |

**`TEST-RUNNING` fields:**
- `ST-current/total` — e.g. step 3 of 7  
- `setTime/remainingTime` — e.g. `00:05:00/00:04:30` (MM:SS or HH:MM:SS)

---

## 6. Typical sequences

### Start a dissolution test
1. Upload recipe: `TS` → `RPM` → `DUR` → `SML` → `FL` (ACK each)  
2. `#START-TEST*` → ACK  
3. UART-2: `#TEMP-A-1SEC*` and/or `#STATUES*` while running  
4. On finish: ESP sends `#END-TEST,ACK*`

### Pause / resume
1. `#PAUSE-TEST*` → ACK  
2. `#START-TEST*` again **or** Pi may re-upload then start (resume-after-power path always re-uploads)

### Power-loss recovery (Pi-owned)
1. Pi decides within power-failure window  
2. Pi re-uploads remaining steps (shortened first duration if needed)  
3. `#START-TEST*`  
ESP must not assume old RAM recipe survived brown-out.

### Hardware initialise
1. `#INIT*` → safe idle → `#INIT,ACK*`

### Temperature calibration
1. For each sensor: `#CAL,BT-xx*`, `#CAL,EXT-xx*`, `#CAL,VSL1-xx*` … `#CAL,VSL6-xx*` with ACK each

### Sample volume calibration
1. `#CAL,TSML-VL*` → ACK  
2. ESP → `#ENT-TSML-VL,ACK*` when ready  
3. `#CAL,TSML-<measured>*` → ACK

---

## 7. Quick reference — all Pi → ESP frames

```
#TS-NN*
#RPM,1-rrr,2-rrr,…*
#DUR,1-MM:SS,MM:SS,…*
#SML,1-v,2-v,…*
#FL-Vml*
#START-TEST*
#PAUSE-TEST*
#STOP-TEST*
#START-RPM-<n>*
#STOP-RPM-<n>*
#LF-CU-UP*
#LF-CU-DOWN*
#LF-CU-STOP*
#INIT*
#BEEP*
#BEEP-<n>*
#CL,CH-A|B|C|D|E|X,<v>ml*
#CAL,BT-<deg>*
#CAL,EXT-<deg>*
#CAL,VSL1-<deg>* … #CAL,VSL6-<deg>*
#CAL,TSML-VL*
#CAL,TSML-<ml>*
#TEMP*
#TEMP-A-1SEC*
#STATUES*
```

---

## 8. Quick reference — ESP → Pi frames

```
…,ACK*                         (command acknowledgements)
#END-TEST,ACK*
#LF-CL-HOME,ACK*
#CL,CH-…,…ml,FSH,ACK*
#ENT-TSML-VL,ACK*
#bath,ext,v1,v2,v3,v4,v5,v6*   (temps)
#IDEL*
#TEST-RUNNING,ST-cc/tt,set/rem*
```

---

## 9. Implementation checklist for firmware

- [ ] Parse `#…*` on both UARTs independently  
- [ ] Recipe store + replace on new `TS` upload  
- [ ] Max 12 steps  
- [ ] `START` / `PAUSE` / `STOP` + async `END-TEST`  
- [ ] Lift + async `LF-CL-HOME`  
- [ ] `#INIT*` safe idle  
- [ ] `#BEEP*` / `#BEEP-N*`  
- [ ] Clean channels A–E and X + async `FSH`  
- [ ] Temp cal BT/EXT/VSL1–6  
- [ ] Sample cal VL → ENT → measured  
- [ ] UART-2: 8-float CSV + `IDEL` / `TEST-RUNNING` statues  
- [ ] No reliance on retaining recipe across power loss  

---

*Source of truth on Pi: `Auto sampler disso comm.txt`, `disso_protocol.py`, `disso_cmd_hardware.py`, `disso_temp_hardware.py`.*
