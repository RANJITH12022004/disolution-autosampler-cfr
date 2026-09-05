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


def build_recipe_frames(
    recipe: Dict[str, Any],
    *,
    from_step_index: int = 0,
    remaining_sec_in_step: Optional[int] = None,
) -> List[str]:
    """
    Build UART-1 recipe upload frames for remaining steps (renumbered 1..N).
    If remaining_sec_in_step is set, first remaining step duration is shortened.
    """
    steps = remaining_steps(recipe, from_step_index)
    if not steps:
        raise ValueError("No remaining steps to upload")
    if remaining_sec_in_step is not None and steps:
        steps[0] = dict(steps[0])
        steps[0]["durationSeconds"] = max(1, int(remaining_sec_in_step))

    n = len(steps)
    frames = [wrap("TS-{:02d}".format(n))]

    rpm_parts = ["{}-{}".format(st["index"], st["rpm"]) for st in steps]
    frames.append(wrap("RPM," + ",".join(rpm_parts)))

    # Doc: #DUR,1-00:01,00:15,00:55*  (first has index- prefix)
    dur_tokens: List[str] = []
    for i, st in enumerate(steps):
        token = _fmt_hms_mmss(st["durationSeconds"])
        if i == 0:
            dur_tokens.append("{}-{}".format(st["index"], token))
        else:
            dur_tokens.append(token)
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
    frames.append(wrap("FL-{}ml".format(flush_s)))
    return frames


def is_ack(inner: str, expect_prefix: Optional[str] = None) -> bool:
    s = (inner or "").strip()
    if not s:
        return False
    upper = s.upper()
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
    Parse #STATUES* replies:
      IDEL
      TEST-RUNNING,ST-03/07,00:05:00/00:04:30
    """
    s = (inner or "").strip()
    if not s:
        return None
    upper = s.upper()
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


def build_start_rpm(rpm: int) -> str:
    return wrap("START-RPM-{}".format(int(rpm)))


def build_stop_rpm(rpm: int) -> str:
    return wrap("STOP-RPM-{}".format(int(rpm)))


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
    t = (target or "").strip().upper()
    mapping = {
        "BATH": "BT",
        "BT": "BT",
        "EXT": "EXT",
        "EXTERNAL": "EXT",
        "V1": "VSL1",
        "V2": "VSL2",
        "V3": "VSL3",
        "V4": "VSL4",
        "V5": "VSL5",
        "V6": "VSL6",
        "VSL1": "VSL1",
        "VSL2": "VSL2",
        "VSL3": "VSL3",
        "VSL4": "VSL4",
        "VSL5": "VSL5",
        "VSL6": "VSL6",
    }
    key = mapping.get(t)
    if not key:
        raise ValueError("unknown cal target")
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
    return wrap("STATUES")
