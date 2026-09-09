#!/usr/bin/env python3
"""
disso_protocol.py - Dissolution dual-ESP frame codec (Auto sampler disso comm.txt).

UART-1 (command): #...# frames with ACK replies.
UART-2 (temp/status): #TEMP* / #TEMP-A-1SEC* / #STATUES* and CSV replies.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Tuple


FRAME_RE = re.compile(r"#([^#*\r\n]*)\*")


def wrap(payload: str) -> str:
    """Wrap inner payload as #payload* (payload must not include # or *)."""
    inner = (payload or "").strip().lstrip("#").rstrip("*").strip()
    return "#{}*".format(inner)


def unwrap(line: str) -> Optional[str]:
    """Extract first #...# frame inner text, or None."""
    if not line:
        return None
    s = str(line).strip()
    m = FRAME_RE.search(s)
    if m:
        return m.group(1).strip()
    # Bare CSV temperature reply (no framing): bath,ext,v1..v6
    if re.match(r"^-?\d+(\.\d+)?(,\s*-?\d+(\.\d+)?){7}\*?$", s.rstrip("*")):
        return s.rstrip("*").strip()
    return None


def parse_frames(buffer: str) -> Tuple[List[str], str]:
    """Pull complete #...* frames from a serial buffer. Returns (inners, remainder)."""
    frames: List[str] = []
    pos = 0
    while True:
        start = buffer.find("#", pos)
        if start < 0:
            return frames, buffer[pos:]
        end = buffer.find("*", start + 1)
        if end < 0:
            return frames, buffer[start:]
        frames.append(buffer[start + 1 : end].strip())
        pos = end + 1


def _fmt_hms_mmss(seconds: int) -> str:
    seconds = max(0, int(seconds))
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return "{:02d}:{:02d}:{:02d}".format(h, m, s)
    return "{:02d}:{:02d}".format(m, s)


def _step_duration_seconds(step: Dict[str, Any]) -> int:
    if step is None:
        return 0
    if step.get("durationSeconds") is not None:
        try:
            return max(0, int(float(step.get("durationSeconds"))))
        except (TypeError, ValueError):
            pass
    raw = step.get("duration") or step.get("time") or "00:00"
    parts = str(raw).strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(float(parts[0]))
    except (TypeError, ValueError):
        return 0


def _step_rpm(step: Dict[str, Any]) -> int:
    try:
        return int(float(step.get("rpm") or step.get("RPM") or 0))
    except (TypeError, ValueError):
        return 0


def _step_sample_ml(step: Dict[str, Any], default: Optional[float] = None) -> float:
    for key in ("sampleVolume", "sampleMl", "sample", "sml"):
        if step.get(key) is not None:
            try:
                return float(step.get(key))
            except (TypeError, ValueError):
                pass
    if default is not None:
        return float(default)
    return 0.0


def normalize_steps(recipe: Dict[str, Any]) -> List[Dict[str, Any]]:
    steps = recipe.get("steps") if isinstance(recipe, dict) else None
    if not isinstance(steps, list):
        return []
    out: List[Dict[str, Any]] = []
    for i, raw in enumerate(steps):
        if not isinstance(raw, dict):
            continue
        out.append(
            {
                "index": i + 1,
                "rpm": _step_rpm(raw),
                "durationSeconds": _step_duration_seconds(raw),
                "sampleVolume": _step_sample_ml(raw, recipe.get("sampleVolume")),
                "raw": raw,
            }
        )
    return out


def remaining_steps(recipe: Dict[str, Any], from_step_index: int) -> List[Dict[str, Any]]:
    """from_step_index is 0-based index into recipe steps (current / interrupted step)."""
    steps = normalize_steps(recipe)
    if from_step_index < 0:
        from_step_index = 0
    remaining = steps[from_step_index:]
    renumbered: List[Dict[str, Any]] = []
    for i, st in enumerate(remaining):
        item = dict(st)
        item["index"] = i + 1
        item["originalIndex"] = st["index"]
        renumbered.append(item)
    return renumbered


def _fmt_set_temp(recipe: Dict[str, Any]) -> str:
    """Format recipe temperature for #SET-TEMP-37.0*."""
    raw = None
    if isinstance(recipe, dict):
        raw = recipe.get("temperature")
        if raw is None:
            raw = recipe.get("setTemp")
    try:
        t = float(raw)
    except (TypeError, ValueError):
        t = 37.0
    # One decimal when needed (37.0), otherwise compact
    if abs(t - round(t)) < 1e-9:
        return "{:.1f}".format(t)
    return "{:.1f}".format(t)


def recipe_auto_drop_on(recipe: Dict[str, Any]) -> bool:
    """
    Sample Drop Auto → AUTO-DROP-ON; Manual → OFF.
    Also accepts legacy autoDispense boolean.
    """
    if not isinstance(recipe, dict):
        return False
    mode = str(recipe.get("mode") or recipe.get("sampleDrop") or "").strip().lower()
    if mode == "auto":
        return True
    if mode == "manual":
        return False
    if recipe.get("autoDispense") is True:
        return True
    if recipe.get("autoDispense") is False:
        return False
    return False


def build_set_temp(temperature: Any = None) -> str:
    try:
        t = float(temperature)
    except (TypeError, ValueError):
        t = 37.0
    return wrap("SET-TEMP-{:.1f}".format(t))


def build_auto_drop(on: bool) -> str:
    return wrap("AUTO-DROP-ON" if on else "AUTO-DROP-OFF")


def build_recipe_frames(
    recipe: Dict[str, Any],
    *,
    from_step_index: int = 0,
    remaining_sec_in_step: Optional[int] = None,
) -> List[str]:
    """
    Build UART-1 recipe upload frames for remaining steps (renumbered 1..N).

    Order: SET-TEMP → TS → RPM → DUR → SML → FL → AUTO-DROP
    Final #RECIPE,ACK* is waited separately after these frames.
    """
    steps = remaining_steps(recipe, from_step_index)
    if not steps:
        raise ValueError("No remaining steps to upload")
    if remaining_sec_in_step is not None and steps:
        steps[0] = dict(steps[0])
        steps[0]["durationSeconds"] = max(1, int(remaining_sec_in_step))

    n = len(steps)
    frames = [wrap("SET-TEMP-{}".format(_fmt_set_temp(recipe)))]
    frames.append(wrap("TS-{:02d}".format(n)))

    rpm_parts = ["{}-{}".format(st["index"], st["rpm"]) for st in steps]
    frames.append(wrap("RPM," + ",".join(rpm_parts)))

    # Firmware: #DUR,1-00:05,2-00:10* (every step indexed)
    dur_tokens: List[str] = []
    for st in steps:
        token = _fmt_hms_mmss(st["durationSeconds"])
        dur_tokens.append("{}-{}".format(st["index"], token))
    frames.append(wrap("DUR," + ",".join(dur_tokens)))

    sml_parts = []
    for st in steps:
        vol = st["sampleVolume"]
        if float(vol) == int(vol):
            sml_parts.append("{}-{}".format(st["index"], int(vol)))
        else:
            sml_parts.append("{}-{}".format(st["index"], vol))
    frames.append(wrap("SML," + ",".join(sml_parts)))

    flush = recipe.get("rinseVolume")
    if flush is None:
        flush = recipe.get("flushVolume")
    if flush is None:
        flush = recipe.get("sampleVolume") or 0
    try:
        flush_f = float(flush)
        flush_s = str(int(flush_f)) if flush_f == int(flush_f) else str(flush_f)
    except (TypeError, ValueError):
        flush_s = "0"
    # Firmware: #FL,1-2,2-3* (per-step flush ml; recipe rinse applies to each step)
    fl_parts = ["{}-{}".format(st["index"], flush_s) for st in steps]
    frames.append(wrap("FL," + ",".join(fl_parts)))

    frames.append(build_auto_drop(recipe_auto_drop_on(recipe)))
    return frames


def is_error_response(inner: str) -> bool:
    s = (inner or "").strip().upper()
    return "ERR" in s or "BAD" in s or "FAIL" in s or "NRCP" in s


def is_lift_position_error(inner: str) -> bool:
    """True when ESP rejects START/action because lifting column is not ready."""
    s = (inner or "").strip().upper()
    if not s:
        return False
    keys = ("LIFT", "LF-", "LF,", "COLUMN", "COLUM", "HOME", "POS", "SHAFT")
    if any(k in s for k in keys):
        return True
    # Common compact firmware codes seen with lift/position faults
    if "ERR,LF" in s or "ERR,LFT" in s or "ERR,HOME" in s or "ERR,POS" in s:
        return True
    return False


def is_ack(inner: str, expect_prefix: Optional[str] = None) -> bool:
    s = (inner or "").strip()
    if not s:
        return False
    upper = s.upper()
    if is_error_response(upper):
        return False
    if expect_prefix:
        ep = expect_prefix.upper().rstrip(",").rstrip("*")
        if not upper.startswith(ep.upper().rstrip(",")):
            # Allow exact START-TEST,ACK style
            if ep not in upper:
                return False
    return upper.endswith(",ACK") or upper.endswith("ACK") or ",ACK" in upper


def parse_temperature_csv(inner_or_line: str) -> Optional[Dict[str, Any]]:
    """Parse bath,ext,v1..v6 (8 floats)."""
    s = (inner_or_line or "").strip().rstrip("*").lstrip("#")
    if not s or s.upper().startswith("TEMP"):
        return None
    parts = [p.strip() for p in s.split(",") if p.strip() != ""]
    if len(parts) < 8:
        return None
    try:
        vals = [float(parts[i]) for i in range(8)]
    except ValueError:
        return None
    return {
        "bath": vals[0],
        "external": vals[1],
        "vessels": vals[2:8],
        "v1": vals[2],
        "v2": vals[3],
        "v3": vals[4],
        "v4": vals[5],
        "v5": vals[6],
        "v6": vals[7],
        "raw": s,
    }


def parse_statues(inner: str) -> Optional[Dict[str, Any]]:
    """
    Parse #STATUES* / #STATUS* replies:
      IDEL / IDLE
      TEST-RUNNING,ST-03/07,00:05:00/00:04:30
    """
    s = (inner or "").strip()
    if not s:
        return None
    upper = s.upper()
    # Bare ACK / command echo — not a status payload
    if upper in ("STATUES", "STATUS", "TEMP", "TEMP-A-1SEC"):
        return None
    if upper in ("IDEL", "IDLE"):
        return {"state": "IDLE", "raw": s}
    if upper.startswith("TEST-RUNNING") or upper.startswith("TEST_RUNNING"):
        # TEST-RUNNING,ST-03/07,00:05:00/00:04:30
        step_cur = None
        step_total = None
        set_time = None
        rem_time = None
        parts = s.split(",")
        for p in parts[1:]:
            p = p.strip()
            if p.upper().startswith("ST-"):
                frac = p[3:]
                if "/" in frac:
                    a, b = frac.split("/", 1)
                    try:
                        step_cur = int(a)
                        step_total = int(b)
                    except ValueError:
                        pass
            elif "/" in p and ":" in p:
                left, right = p.split("/", 1)
                set_time = left.strip()
                rem_time = right.strip()
        return {
            "state": "TEST-RUNNING",
            "stepCurrent": step_cur,
            "stepTotal": step_total,
            "setTime": set_time,
            "remainingTime": rem_time,
            "raw": s,
        }
    return {"state": s, "raw": s}


def hms_to_seconds(hms: Optional[str]) -> Optional[int]:
    if not hms:
        return None
    parts = str(hms).strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(float(parts[0]))
    except (TypeError, ValueError):
        return None


def build_start_test() -> str:
    return wrap("START-TEST")


def build_pause_test() -> str:
    return wrap("PAUSE-TEST")


def build_stop_test() -> str:
    return wrap("STOP-TEST")


def build_init() -> str:
    """Hardware initialise — ESP should enter safe idle and ACK."""
    return wrap("INIT")


def build_beep(count: int = 1) -> str:
    """
    Request audible beep on command ESP.
    count=1 → #BEEP*
    count>1 → #BEEP-N* (N beeps)
    """
    n = max(1, int(count or 1))
    if n <= 1:
        return wrap("BEEP")
    return wrap("BEEP-{}".format(n))


def build_pre_heat() -> str:
    return wrap("PRE-HEAT")


def build_stop_heat() -> str:
    """Stop bath heater / circulation heat (#STOP-HEAT*)."""
    return wrap("STOP-HEAT")


def build_start_pld(rpm: int) -> str:
    """Start stirrer / paddle motor at RPM (#START-PLD-150*)."""
    return wrap("START-PLD-{}".format(int(rpm)))


def build_stop_pld() -> str:
    """Stop stirrer / paddle motor (#STOP-PLD*)."""
    return wrap("STOP-PLD")


def build_start_rpm(rpm: int) -> str:
    """Alias for build_start_pld (legacy name)."""
    return build_start_pld(rpm)


def build_stop_rpm(rpm: int = 0) -> str:
    """Alias for build_stop_pld (legacy name; rpm ignored)."""
    return build_stop_pld()


def build_lift(action: str) -> str:
    a = (action or "").strip().lower()
    if a == "up":
        return wrap("LF-CU-UP")
    if a == "down":
        return wrap("LF-CU-DOWN")
    if a == "stop":
        return wrap("LF-CU-STOP")
    raise ValueError("lift action must be up|down|stop")


def build_clean(channel: str, volume_ml: float) -> str:
    ch = (channel or "").strip().upper()
    if ch in ("ALL", "X"):
        ch = "X"
    if ch not in ("A", "B", "C", "D", "E", "X"):
        raise ValueError("channel must be A-E or ALL")
    try:
        v = float(volume_ml)
        vs = str(int(v)) if v == int(v) else str(v)
    except (TypeError, ValueError):
        vs = "0"
    return wrap("CL,CH-{},{}ml".format(ch, vs))


def build_cal_temp(target: str, value: float) -> str:
    """Bath (BT) and External (EXT) only — vessel CAL is not supported."""
    t = (target or "").strip().upper()
    mapping = {
        "BATH": "BT",
        "BT": "BT",
        "EXT": "EXT",
        "EXTERNAL": "EXT",
    }
    key = mapping.get(t)
    if not key:
        raise ValueError("unknown cal target (only BT and EXT are supported)")
    return wrap("CAL,{}-{}".format(key, value))


def build_cal_sample_start() -> str:
    return wrap("CAL,TSML-VL")


def build_cal_sample_value(ml: float) -> str:
    return wrap("CAL,TSML-{}".format(ml))


def build_temp_poll() -> str:
    return wrap("TEMP")


def build_temp_auto_1sec() -> str:
    return wrap("TEMP-A-1SEC")


def build_statues_poll() -> str:
    """Firmware spelling is STATUES (Auto sampler disso comm.txt)."""
    return wrap("STATUES")


def build_status_poll() -> str:
    """Alias TX for hosts that speak STATUS; firmware expects STATUES."""
    return build_statues_poll()


def is_temp_ack(inner: str) -> bool:
    upper = (inner or "").strip().upper()
    return upper in ("TEMP", "TEMP-A-1SEC", "STATUES", "STATUS")


def is_status_frame(inner: str) -> bool:
    """True when inner looks like a statues/status payload (not a bare ACK name)."""
    upper = (inner or "").strip().upper()
    if not upper or upper in ("TEMP", "TEMP-A-1SEC", "STATUES", "STATUS"):
        return False
    if upper in ("IDEL", "IDLE", "PAUSED"):
        return True
    if upper.startswith("TEST-RUNNING") or upper.startswith("TEST_RUNNING"):
        return True
    return False
