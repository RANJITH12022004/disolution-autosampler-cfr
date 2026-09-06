#!/usr/bin/env python3
"""
disso_cmd_hardware.py - UART-1 command / auto-sampler ESP.

Protocol: Auto sampler disso comm.txt (#...* frames with ACK).
Supports SIMULATE_HARDWARE for Windows / no-serial development.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import disso_protocol as proto

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config: Dict[str, Any] = {}
_port_name = "/dev/serial0"
_baud = 9600
_ser = None
_ser_lock = threading.Lock()
_rx_buffer = ""
_reader_started = False
_simulate = False
_uart_log_path = ""
_uart_log_lock = threading.Lock()

# Async events from ESP (END-TEST, LF-CL-HOME, CL FSH)
_event_listeners: List[Callable[[Dict[str, Any]], None]] = []
_pending_acks: "queue.Queue[str]" = queue.Queue()

# Simulator state shared with temp ESP via module hooks
_sim_lock = threading.Lock()
_sim = {
    "recipe_steps": [],
    "running": False,
    "paused": False,
    "step_index": 0,  # 0-based within uploaded remaining steps
    "step_total": 0,
    "step_set_sec": 0,
    "step_rem_sec": 0,
    "rpm": 0,
}


def init(app, config):
    global _logger, _config, _port_name, _baud, _simulate, _uart_log_path, _reader_started
    _config = dict(config or {})
    _logger = getattr(app, "logger", None)
    _port_name = (
        _config.get("ESP_CMD_PORT")
        or _config.get("ESP_PORT")
        or os.environ.get("ESP_CMD_PORT")
        or "/dev/serial0"
    )
    _baud = int(_config.get("ESP_CMD_BAUD") or _config.get("ESP_BAUD") or 9600)
    _uart_log_path = str(_config.get("UART_LOG_PATH") or "")
    env_sim = str(os.environ.get("SIMULATE_HARDWARE", "")).strip().lower() in ("1", "true", "yes", "on")
    _simulate = bool(_config.get("SIMULATE_HARDWARE")) or env_sim
    if not _simulate:
        opened = _open_serial()
        if not opened:
            _simulate = True
            if _logger:
                _logger.warning("[disso_cmd] serial unavailable — using SIMULATE_HARDWARE")
    if _logger:
        _logger.info("[disso_cmd] init port=%s baud=%s simulate=%s", _port_name, _baud, _simulate)
    if not _reader_started:
        _reader_started = True
        threading.Thread(target=_reader_loop, daemon=True, name="disso-cmd-rx").start()
        threading.Thread(target=_sim_tick_loop, daemon=True, name="disso-cmd-sim").start()


def is_simulate() -> bool:
    return bool(_simulate)


def get_sim_state() -> Dict[str, Any]:
    with _sim_lock:
        return dict(_sim)


def add_event_listener(fn: Callable[[Dict[str, Any]], None]) -> None:
    if fn and fn not in _event_listeners:
        _event_listeners.append(fn)


_recent_events: List[Dict[str, Any]] = []
_recent_events_lock = threading.Lock()
_RECENT_EVENTS_MAX = 50


def _emit_event(evt: Dict[str, Any]) -> None:
    payload = dict(evt or {})
    payload["ts"] = time.time()
    with _recent_events_lock:
        _recent_events.append(payload)
        while len(_recent_events) > _RECENT_EVENTS_MAX:
            _recent_events.pop(0)
    for fn in list(_event_listeners):
        try:
            fn(payload)
        except Exception:
            if _logger:
                _logger.exception("[disso_cmd] event listener failed")


def pop_events() -> List[Dict[str, Any]]:
    """Return and clear recent async ESP events."""
    with _recent_events_lock:
        out = list(_recent_events)
        _recent_events.clear()
        return out


def peek_events() -> List[Dict[str, Any]]:
    with _recent_events_lock:
        return list(_recent_events)


def _log_uart(direction: str, text: str) -> None:
    if not _uart_log_path:
        return
    try:
        with _uart_log_lock:
            with open(_uart_log_path, "a", encoding="utf-8") as f:
                f.write("{} CMD {} {}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), direction, text))
    except Exception:
        pass


def _open_serial() -> bool:
    global _ser
    if serial is None:
        return False
    try:
        if not os.path.exists(_port_name) and not str(_port_name).upper().startswith("COM"):
            return False
        _ser = serial.Serial(port=_port_name, baudrate=_baud, timeout=0.2)
        return True
    except Exception as exc:
        if _logger:
            _logger.warning("[disso_cmd] open failed: %s", exc)
        _ser = None
        return False


def _reader_loop() -> None:
    global _rx_buffer
    while True:
        try:
            if _simulate or _ser is None:
                time.sleep(0.2)
                continue
            with _ser_lock:
                raw = _ser.read(256) if _ser else b""
            if not raw:
                time.sleep(0.02)
                continue
            try:
                chunk = raw.decode("utf-8", "replace")
            except Exception:
                chunk = raw.decode("latin-1", "replace")
            _rx_buffer += chunk
            frames, _rx_buffer = proto.parse_frames(_rx_buffer)
            # Also accept bare CSV? command port uses frames only
            for inner in frames:
                _log_uart("RX", "#" + inner + "*")
                _handle_rx_inner(inner)
        except Exception:
            if _logger:
                _logger.exception("[disso_cmd] reader error")
            time.sleep(0.5)


def _handle_rx_inner(inner: str) -> None:
    upper = (inner or "").upper()
    if "END-TEST" in upper:
        with _sim_lock:
            _sim["running"] = False
            _sim["paused"] = False
        _emit_event({"type": "END-TEST", "raw": inner})
    elif "PRE-DONE" in upper:
        _emit_event({"type": "PRE-DONE", "raw": inner})
    elif upper.startswith("RECIPE") or ",RECIPE" in upper or upper == "RECIPE,ACK":
        _emit_event({"type": "RECIPE", "raw": inner})
    elif "ERR,RCP" in upper or "ERR,RCP" in upper.replace(" ", ""):
        _emit_event({"type": "ERR-RCP", "raw": inner})
    elif "LF-CL-HOME" in upper or "LF-CU-HOME" in upper:
        _emit_event({"type": "LIFT-HOME", "raw": inner})
    elif ",FSH,ACK" in upper or upper.endswith("FSH,ACK"):
        _emit_event({"type": "CLEAN-DONE", "raw": inner})
    elif "ENT-TSML-VL" in upper:
        _emit_event({"type": "SAMPLE-CAL-READY", "raw": inner})
    # Always enqueue for ACK waiters
    try:
        _pending_acks.put_nowait(inner)
    except Exception:
        pass


def _drain_pending(max_wait: float = 0.0) -> List[str]:
    """Clear queued RX frames. If max_wait > 0, also collect trailing frames briefly."""
    drained: List[str] = []
    while True:
        try:
            drained.append(_pending_acks.get_nowait())
        except queue.Empty:
            break
    if max_wait > 0:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            try:
                drained.append(_pending_acks.get(timeout=0.05))
            except queue.Empty:
                continue
    return drained


def _tx(frame: str, wait_ack: bool = True, timeout: float = 3.0, expect_prefix: Optional[str] = None) -> Dict[str, Any]:
    frame = frame if frame.startswith("#") else proto.wrap(frame)
    _log_uart("TX", frame)
    _drain_pending(0)

    if _simulate:
        ack_inner = _simulate_handle_tx(frame)
        if wait_ack:
            return {"ok": True, "simulate": True, "tx": frame, "ack": ack_inner}
        return {"ok": True, "simulate": True, "tx": frame}

    if _ser is None and not _open_serial():
        return {"ok": False, "error": "command ESP serial not open", "tx": frame}

    try:
        data = (frame if frame.endswith("\n") else frame + "\n").encode("utf-8")
        with _ser_lock:
            _ser.write(data)
            _ser.flush()
    except Exception as exc:
        return {"ok": False, "error": str(exc), "tx": frame}

    if not wait_ack:
        return {"ok": True, "tx": frame}

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            inner = _pending_acks.get(timeout=0.2)
        except queue.Empty:
            continue
        if proto.is_error_response(inner):
            return {"ok": False, "error": inner, "tx": frame, "ack": inner}
        if expect_prefix and not proto.is_ack(inner, expect_prefix):
            # keep looking unless it is clearly an ack for something else useful
            if proto.is_ack(inner):
                return {"ok": True, "tx": frame, "ack": inner}
            continue
        if proto.is_ack(inner, expect_prefix):
            return {"ok": True, "tx": frame, "ack": inner}
        if proto.is_ack(inner):
            return {"ok": True, "tx": frame, "ack": inner}
    return {"ok": False, "error": "ACK timeout", "tx": frame}


def _simulate_handle_tx(frame: str) -> str:
    inner = proto.unwrap(frame) or frame.strip("#*")
    upper = inner.upper()
    # Recipe upload bookkeeping
    if upper.startswith("SET-TEMP-"):
        return "SET-TEMP-" + upper.split("SET-TEMP-", 1)[1] + (",ACK" if ",ACK" not in upper else "")
    if upper.startswith("TS-"):
        try:
            n = int(upper.split("-", 1)[1])
        except ValueError:
            n = 0
        with _sim_lock:
            _sim["step_total"] = n
            _sim["recipe_steps"] = [{"index": i + 1} for i in range(n)]
        return inner + ",ACK"
    if upper.startswith("RPM,"):
        return inner + ",ACK" if not inner.upper().endswith("ACK") else inner
    if upper.startswith("DUR,"):
        # Parse first duration for step 1
        parts = inner.split(",")
        rem = 60
        if len(parts) > 1:
            token = parts[1]
            if "-" in token:
                token = token.split("-", 1)[1]
            rem = proto.hms_to_seconds(token) or 60
        with _sim_lock:
            _sim["step_set_sec"] = rem
            _sim["step_rem_sec"] = rem
            _sim["step_index"] = 0
        return inner + (",ACK" if ",ACK" not in upper else "")
    if upper.startswith("SML,") or upper.startswith("FL-"):
        return inner + (",ACK" if ",ACK" not in upper else "")
    if upper in ("AUTO-DROP-ON", "AUTO-DROP-OFF"):
        # After full recipe, firmware emits RECIPE,ACK
        threading.Timer(0.2, lambda: _handle_rx_inner("RECIPE,ACK")).start()
        return upper + ",ACK"
    if upper == "PRE-HEAT":
        threading.Timer(0.6, lambda: _handle_rx_inner("PRE-DONE,ACK")).start()
        return "PRE-HEATTING,ACK"
    if upper == "START-TEST":
        with _sim_lock:
            _sim["running"] = True
            _sim["paused"] = False
            if _sim["step_rem_sec"] <= 0:
                _sim["step_rem_sec"] = max(1, int(_sim.get("step_set_sec") or 5))
        return "START-TEST,ACK"
    if upper == "PAUSE-TEST":
        with _sim_lock:
            _sim["paused"] = True
        return "PAUSE-TEST,ACK"
    if upper == "STOP-TEST":
        with _sim_lock:
            _sim["running"] = False
            _sim["paused"] = False
        return "STOP-TEST,ACK"
    if upper == "INIT":
        with _sim_lock:
            _sim["running"] = False
            _sim["paused"] = False
            _sim["rpm"] = 0
            _sim["step_index"] = 0
            _sim["step_rem_sec"] = 0
        return "INIT,ACK"
    if upper == "BEEP" or upper.startswith("BEEP-"):
        return ("BEEP" if upper == "BEEP" else upper) + ",ACK"
    if upper.startswith("START-PLD-") or upper.startswith("START-RPM-"):
        try:
            key = "START-PLD-" if "START-PLD-" in upper else "START-RPM-"
            rpm = int(upper.split(key)[1].split(",")[0])
        except ValueError:
            rpm = 0
        with _sim_lock:
            _sim["rpm"] = rpm
        return ("START-PLD-{}".format(rpm) if "START-PLD-" in upper else inner) + ",ACK"
    if upper == "STOP-PLD" or upper.startswith("STOP-RPM"):
        with _sim_lock:
            _sim["rpm"] = 0
        return "STOP-PLD,ACK"
    if upper.startswith("LF-CU-"):
        ack = inner + ",ACK"
        if "DOWN" in upper:
            threading.Timer(0.5, lambda: _handle_rx_inner("LF-CL-HOME,ACK")).start()
        return ack
    if upper.startswith("CL,"):
        ack = inner + ",ACK"
        threading.Timer(0.8, lambda i=inner: _handle_rx_inner(i + ",FSH,ACK" if "FSH" not in i.upper() else i)).start()
        return ack
    if upper.startswith("CAL,"):
        if "TSML-VL" in upper and "TSML-VL," not in upper.replace(" ", ""):
            threading.Timer(0.3, lambda: _handle_rx_inner("ENT-TSML-VL,ACK")).start()
        return inner + ",ACK"
    return inner + ",ACK"


def _sim_tick_loop() -> None:
    while True:
        time.sleep(1.0)
        if not _simulate:
            continue
        end_now = False
        with _sim_lock:
            if not _sim["running"] or _sim["paused"]:
                continue
            _sim["step_rem_sec"] = max(0, int(_sim["step_rem_sec"]) - 1)
            if _sim["step_rem_sec"] <= 0:
                _sim["step_index"] += 1
                if _sim["step_index"] >= max(1, int(_sim["step_total"] or 1)):
                    _sim["running"] = False
                    end_now = True
                else:
                    # advance to next simulated step with same duration for simplicity
                    dur = max(1, int(_sim.get("step_set_sec") or 5))
                    _sim["step_rem_sec"] = dur
                    _sim["step_set_sec"] = dur
        if end_now:
            _handle_rx_inner("END-TEST,ACK")


def _wait_for_recipe_complete(timeout: float = 5.0) -> Dict[str, Any]:
    """Wait for final #RECIPE,ACK* after recipe frames (or fail on #ERR,RCP*)."""
    if _simulate:
        # Simulator emits RECIPE,ACK shortly after AUTO-DROP ACK
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                inner = _pending_acks.get(timeout=0.2)
            except queue.Empty:
                continue
            upper = (inner or "").upper()
            if "ERR,RCP" in upper:
                return {"ok": False, "error": inner, "ack": inner}
            if upper.startswith("RECIPE") or "RECIPE,ACK" in upper:
                return {"ok": True, "ack": inner}
        # Soft-ok if sim already drained RECIPE into event without leaving ack
        return {"ok": True, "ack": "RECIPE,ACK", "simulate": True}

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            inner = _pending_acks.get(timeout=0.2)
        except queue.Empty:
            continue
        upper = (inner or "").upper()
        if "ERR,RCP" in upper:
            return {"ok": False, "error": inner or "ERR,RCP", "ack": inner}
        if proto.is_error_response(inner) and "RCP" in upper:
            return {"ok": False, "error": inner, "ack": inner}
        if upper.startswith("RECIPE") or "RECIPE,ACK" in upper:
            return {"ok": True, "ack": inner}
    return {"ok": False, "error": "RECIPE,ACK timeout"}


def upload_recipe(recipe: Dict[str, Any], from_step_index: int = 0, remaining_sec_in_step: Optional[int] = None) -> Dict[str, Any]:
    """
    Recipe load order:
      #SET-TEMP-* → #TS-NN* → #RPM,…* → #DUR,…* → #SML,…* → #FL-Nml* → #AUTO-DROP-*
    then wait for final #RECIPE,ACK* (fail on #ERR,RCP*).
    """
    frames = proto.build_recipe_frames(recipe, from_step_index=from_step_index, remaining_sec_in_step=remaining_sec_in_step)
    results = []
    prefixes = ["SET-TEMP", "TS-", "RPM", "DUR", "SML", "FL-", "AUTO-DROP"]
    for i, frame in enumerate(frames):
        expect = prefixes[i] if i < len(prefixes) else None
        res = _tx(frame, wait_ack=True, timeout=4.0, expect_prefix=expect)
        results.append(res)
        if not res.get("ok"):
            return {
                "ok": False,
                "error": res.get("error") or "recipe upload failed at frame " + str(frame),
                "results": results,
                "failedFrame": frame,
                "failedIndex": i,
            }
        trailing = _drain_pending(0.15)
        if trailing and _logger:
            for t in trailing:
                tu = (t or "").upper()
                if "ERR,RCP" in tu:
                    return {
                        "ok": False,
                        "error": t,
                        "results": results,
                        "failedFrame": frame,
                        "failedIndex": i,
                    }
                # RECIPE may arrive immediately after AUTO-DROP ACK
                if tu.startswith("RECIPE") or "RECIPE,ACK" in tu:
                    with _sim_lock:
                        steps = proto.remaining_steps(recipe, from_step_index)
                        _sim["step_total"] = len(steps)
                        _sim["step_index"] = 0
                        if steps:
                            dur = steps[0]["durationSeconds"]
                            if remaining_sec_in_step is not None:
                                dur = max(1, int(remaining_sec_in_step))
                            _sim["step_set_sec"] = dur
                            _sim["step_rem_sec"] = dur
                            _sim["rpm"] = steps[0].get("rpm") or 0
                    return {"ok": True, "frames": frames, "results": results, "recipeAck": t}
            _logger.info("[disso_cmd] post-ack drain after %s: %s", frame, trailing)
        time.sleep(0.15)

    recipe_ack = _wait_for_recipe_complete(timeout=5.0)
    results.append(recipe_ack)
    if not recipe_ack.get("ok"):
        return {
            "ok": False,
            "error": recipe_ack.get("error") or "RECIPE,ACK missing",
            "results": results,
            "failedFrame": "RECIPE",
        }

    with _sim_lock:
        steps = proto.remaining_steps(recipe, from_step_index)
        _sim["step_total"] = len(steps)
        _sim["step_index"] = 0
        if steps:
            dur = steps[0]["durationSeconds"]
            if remaining_sec_in_step is not None:
                dur = max(1, int(remaining_sec_in_step))
            _sim["step_set_sec"] = dur
            _sim["step_rem_sec"] = dur
            _sim["rpm"] = steps[0].get("rpm") or 0
    return {"ok": True, "frames": frames, "results": results, "recipeAck": recipe_ack.get("ack")}


def pre_heat(timeout: float = 120.0) -> Dict[str, Any]:
    """Send #PRE-HEAT* and wait for #PRE-DONE,ACK* (after #PRE-HEATTING,ACK*)."""
    _drain_pending(0.1)
    res = _tx(proto.build_pre_heat(), timeout=5.0, expect_prefix="PRE-HEAT")
    if not res.get("ok"):
        # Accept PRE-HEATTING,ACK as the immediate ack
        ack = str(res.get("ack") or res.get("error") or "")
        if "PRE-HEAT" not in ack.upper() and "PRE-HEATTING" not in ack.upper():
            return res

    deadline = time.time() + max(5.0, float(timeout or 120.0))
    while time.time() < deadline:
        try:
            inner = _pending_acks.get(timeout=0.5)
        except queue.Empty:
            if _simulate:
                # Sim already scheduled PRE-DONE; keep waiting briefly
                continue
            continue
        upper = (inner or "").upper()
        if "PRE-DONE" in upper:
            return {"ok": True, "ack": inner, "tx": proto.build_pre_heat()}
        if proto.is_error_response(inner):
            return {"ok": False, "error": inner, "ack": inner, "tx": proto.build_pre_heat()}
    return {"ok": False, "error": "PRE-DONE,ACK timeout", "tx": proto.build_pre_heat()}


def start_test() -> Dict[str, Any]:
    _drain_pending(0.1)
    res = _tx(proto.build_start_test(), timeout=5.0, expect_prefix="START-TEST")
    if not res.get("ok"):
        err = str(res.get("error") or res.get("ack") or "")
        if proto.is_lift_position_error(err):
            res["errorCode"] = "lift_position"
            res["error"] = (
                "Lifting column is not in position. "
                "Move the lifting column Down, then press Start again."
            )
    return res


def pause_test() -> Dict[str, Any]:
    res = _tx(proto.build_pause_test(), expect_prefix="PAUSE-TEST")
    if res.get("ok"):
        with _sim_lock:
            _sim["paused"] = True
    return res


def stop_test() -> Dict[str, Any]:
    res = _tx(proto.build_stop_test(), expect_prefix="STOP-TEST")
    if res.get("ok"):
        with _sim_lock:
            _sim["running"] = False
            _sim["paused"] = False
    return res


def initialise() -> Dict[str, Any]:
    """Send #INIT* and wait for #INIT,ACK*. Resets simulator to safe idle."""
    res = _tx(proto.build_init(), expect_prefix="INIT")
    if res.get("ok"):
        with _sim_lock:
            _sim["running"] = False
            _sim["paused"] = False
            _sim["rpm"] = 0
            _sim["step_index"] = 0
            _sim["step_rem_sec"] = 0
    return res


def initialize() -> Dict[str, Any]:
    return initialise()


def beep(count: int = 1) -> Dict[str, Any]:
    """Send #BEEP* or #BEEP-N* and wait for ACK."""
    frame = proto.build_beep(count)
    expect = "BEEP"
    return _tx(frame, expect_prefix=expect)


DISSOLUTION_RPM_MIN = 20
DISSOLUTION_RPM_MAX = 300


def start_pld(rpm: int) -> Dict[str, Any]:
    try:
        r = int(rpm)
    except (TypeError, ValueError):
        return {"ok": False, "error": "rpm must be an integer"}
    if r < DISSOLUTION_RPM_MIN or r > DISSOLUTION_RPM_MAX:
        return {
            "ok": False,
            "error": f"rpm must be between {DISSOLUTION_RPM_MIN} and {DISSOLUTION_RPM_MAX}",
        }
    return _tx(proto.build_start_pld(r), expect_prefix="START-PLD")


def stop_pld(rpm: int = 0) -> Dict[str, Any]:
    return _tx(proto.build_stop_pld(), expect_prefix="STOP-PLD")


def start_rpm(rpm: int) -> Dict[str, Any]:
    """Legacy alias → START-PLD."""
    return start_pld(rpm)


def stop_rpm(rpm: int = 0) -> Dict[str, Any]:
    """Legacy alias → STOP-PLD."""
    return stop_pld(rpm)


def lift(action: str) -> Dict[str, Any]:
    return _tx(proto.build_lift(action), expect_prefix="LF-CU")


def clean(channel: str, volume_ml: float) -> Dict[str, Any]:
    return _tx(proto.build_clean(channel, volume_ml), expect_prefix="CL,")


def cal_temp(target: str, value: float) -> Dict[str, Any]:
    return _tx(proto.build_cal_temp(target, value), expect_prefix="CAL,")


def cal_sample_start() -> Dict[str, Any]:
    return _tx(proto.build_cal_sample_start(), expect_prefix="CAL,TSML-VL")


def cal_sample_value(ml: float) -> Dict[str, Any]:
    return _tx(proto.build_cal_sample_value(ml), expect_prefix="CAL,TSML")


def send_raw(frame: str) -> Dict[str, Any]:
    return _tx(frame, wait_ack=True)
