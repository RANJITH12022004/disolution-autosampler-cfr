#!/usr/bin/env python3
"""
disso_temp_hardware.py - UART-2 continuous temperature / status ESP.

#TEMP* / #TEMP-A-1SEC* / #STATUES*  (spelling per Auto sampler disso comm.txt)
"""

from __future__ import annotations

import os
import queue
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from flask import Response, stream_with_context

import disso_protocol as proto

try:
    import serial
except ImportError:
    serial = None

try:
    import disso_cmd_hardware as cmd_hw
except ImportError:
    cmd_hw = None

_logger = None
_config: Dict[str, Any] = {}
_port_name = "/dev/ttyAMA3"
_baud = 9600
_ser = None
_ser_lock = threading.Lock()
_rx_buffer = ""
_reader_started = False
_simulate = False
_uart_log_path = ""
_uart_log_lock = threading.Lock()
_auto_armed = False

_live_lock = threading.Lock()
_live: Dict[str, Any] = {
    "bath": None,
    "external": None,
    "vessels": [None] * 6,
    "status": {"state": "IDLE"},
    "updatedAt": None,
    "simulate": False,
}

_sse_clients: List["queue.Queue"] = []
_status_listeners: List[Callable[[Dict[str, Any]], None]] = []


def init(app, config):
    global _logger, _config, _port_name, _baud, _simulate, _uart_log_path, _reader_started
    _config = dict(config or {})
    _logger = getattr(app, "logger", None)
    _port_name = _config.get("ESP_TEMP_PORT") or os.environ.get("ESP_TEMP_PORT") or "/dev/ttyAMA3"
    _baud = int(_config.get("ESP_TEMP_BAUD") or os.environ.get("ESP_TEMP_BAUD") or 9600)
    _uart_log_path = str(_config.get("UART_LOG_PATH") or "")
    env_sim = str(os.environ.get("SIMULATE_HARDWARE", "")).strip().lower() in ("1", "true", "yes", "on")
    _simulate = bool(_config.get("SIMULATE_HARDWARE")) or env_sim
    if cmd_hw is not None and cmd_hw.is_simulate():
        _simulate = True
    if not _simulate:
        if not _open_serial():
            _simulate = True
            if _logger:
                _logger.warning("[disso_temp] serial unavailable — using SIMULATE_HARDWARE")
    with _live_lock:
        _live["simulate"] = _simulate
    if _logger:
        _logger.info("[disso_temp] init port=%s baud=%s simulate=%s", _port_name, _baud, _simulate)
    if not _reader_started:
        _reader_started = True
        threading.Thread(target=_reader_loop, daemon=True, name="disso-temp-rx").start()
        threading.Thread(target=_poll_loop, daemon=True, name="disso-temp-poll").start()


def is_simulate() -> bool:
    return bool(_simulate)


def add_status_listener(fn: Callable[[Dict[str, Any]], None]) -> None:
    if fn and fn not in _status_listeners:
        _status_listeners.append(fn)


def get_live() -> Dict[str, Any]:
    with _live_lock:
        out = dict(_live)
        out["vessels"] = list(_live.get("vessels") or [None] * 6)
        out["status"] = dict(_live.get("status") or {})
        return out


def _log_uart(direction: str, text: str) -> None:
    if not _uart_log_path:
        return
    try:
        with _uart_log_lock:
            with open(_uart_log_path, "a", encoding="utf-8") as f:
                f.write("{} TEMP {} {}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), direction, text))
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
            _logger.warning("[disso_temp] open failed: %s", exc)
        _ser = None
        return False


def _tx(frame: str) -> None:
    frame = frame if frame.startswith("#") else proto.wrap(frame)
    _log_uart("TX", frame)
    if _simulate or _ser is None:
        return
    try:
        data = (frame if frame.endswith("\n") else frame + "\n").encode("utf-8")
        with _ser_lock:
            _ser.write(data)
            _ser.flush()
    except Exception as exc:
        if _logger:
            _logger.warning("[disso_temp] TX failed: %s", exc)


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
            chunk = raw.decode("utf-8", "replace")
            _rx_buffer += chunk
            # Prefer framed messages; also accept bare 8-value CSV lines
            frames, rem = proto.parse_frames(_rx_buffer)
            _rx_buffer = rem
            for inner in frames:
                _log_uart("RX", "#" + inner + "*")
                _ingest(inner)
            # bare CSV lines ending with * or newline already handled by parse_frames remainder
            if "," in _rx_buffer and ("\n" in _rx_buffer or _rx_buffer.endswith("*")):
                line, _, rest = _rx_buffer.replace("\r", "").partition("\n")
                if not line and "*" in _rx_buffer:
                    line, _, rest = _rx_buffer.partition("*")
                    line = line + "*"
                if line:
                    _rx_buffer = rest
                    stripped = line.strip().rstrip("*")
                    if proto.parse_temperature_csv(stripped):
                        _log_uart("RX", stripped)
                        _ingest(stripped)
        except Exception:
            if _logger:
                _logger.exception("[disso_temp] reader error")
            time.sleep(0.5)


def _ingest(inner: str) -> None:
    temps = proto.parse_temperature_csv(inner)
    if temps:
        with _live_lock:
            _live["bath"] = temps["bath"]
            _live["external"] = temps["external"]
            _live["vessels"] = list(temps["vessels"])
            _live["updatedAt"] = time.time()
        _broadcast({"kind": "temperature", "data": get_live()})
        return
    upper = (inner or "").upper()
    if proto.is_temp_ack(inner):
        return
    st = proto.parse_statues(inner)
    if st:
        with _live_lock:
            _live["status"] = st
            _live["updatedAt"] = time.time()
        for fn in list(_status_listeners):
            try:
                fn(st)
            except Exception:
                pass
        _broadcast({"kind": "status", "data": st})


def arm_auto_temp(reason: str = "") -> Dict[str, Any]:
    """Arm UART-2 #TEMP-A-1SEC* streaming (and periodic #STATUES*)."""
    global _auto_armed
    _auto_armed = True
    if _logger:
        _logger.info("[disso_temp] auto-temp ARMED (%s)", reason or "api")
    if not _simulate:
        _tx(proto.build_temp_auto_1sec())
        _tx(proto.build_statues_poll())
    else:
        _simulate_tick()
    return {"ok": True, "armed": True, "reason": reason or ""}


def disarm_auto_temp(reason: str = "") -> Dict[str, Any]:
    """Stop automatic UART-2 streaming; on-demand #TEMP* still works."""
    global _auto_armed
    was = bool(_auto_armed)
    _auto_armed = False
    if _logger:
        _logger.info("[disso_temp] auto-temp DISARMED (%s) was=%s", reason or "api", was)
    return {"ok": True, "armed": False, "wasArmed": was, "reason": reason or ""}


def is_auto_temp_armed() -> bool:
    return bool(_auto_armed)


def query_live_temp_now(wait_sec: float = 1.2) -> Dict[str, Any]:
    """One-shot #TEMP* poll; wait briefly for RX ingest."""
    if _simulate:
        _simulate_tick()
        return get_live()
    before = None
    with _live_lock:
        before = _live.get("updatedAt")
    _tx(proto.build_temp_poll())
    deadline = time.time() + max(0.2, float(wait_sec))
    while time.time() < deadline:
        with _live_lock:
            after = _live.get("updatedAt")
        if after and after != before:
            break
        time.sleep(0.05)
    return get_live()


def query_live_status_now(wait_sec: float = 1.2) -> Dict[str, Any]:
    """One-shot #STATUES* poll (STATUS alias maps to same TX)."""
    if _simulate:
        _simulate_tick()
        return get_live()
    before = None
    with _live_lock:
        before = _live.get("updatedAt")
    _tx(proto.build_statues_poll())
    deadline = time.time() + max(0.2, float(wait_sec))
    while time.time() < deadline:
        with _live_lock:
            after = _live.get("updatedAt")
        if after and after != before:
            break
        time.sleep(0.05)
    return get_live()


def _poll_loop() -> None:
    """When armed: keep #TEMP-A-1SEC* + #STATUES* alive; otherwise idle."""
    last_auto_tx = 0.0
    last_status_tx = 0.0
    while True:
        try:
            if _simulate:
                _simulate_tick()
                time.sleep(1.0)
                continue
            now = time.time()
            if _auto_armed:
                # Re-arm auto stream periodically in case ESP reset; CSV arrives async on UART-2.
                if now - last_auto_tx >= 30.0:
                    _tx(proto.build_temp_auto_1sec())
                    last_auto_tx = now
                if now - last_status_tx >= 2.0:
                    _tx(proto.build_statues_poll())
                    last_status_tx = now
                time.sleep(0.5)
            else:
                last_auto_tx = 0.0
                last_status_tx = 0.0
                time.sleep(1.0)
        except Exception:
            if _logger:
                _logger.exception("[disso_temp] poll error")
            time.sleep(1.0)


def _simulate_tick() -> None:
    import math
    import random

    t = time.time()
    base = 37.0 + 0.2 * math.sin(t / 15.0)
    vessels = [round(base + random.uniform(-0.3, 0.3), 2) for _ in range(6)]
    bath = round(base + 0.1, 2)
    ext = round(base - 0.4, 2)
    status = {"state": "IDLE", "raw": "IDEL"}
    if cmd_hw is not None:
        sim = cmd_hw.get_sim_state()
        if sim.get("running"):
            cur = int(sim.get("step_index") or 0) + 1
            total = max(1, int(sim.get("step_total") or 1))
            set_s = int(sim.get("step_set_sec") or 0)
            rem_s = int(sim.get("step_rem_sec") or 0)
            status = {
                "state": "TEST-RUNNING",
                "stepCurrent": cur,
                "stepTotal": total,
                "setTime": proto._fmt_hms_mmss(set_s),
                "remainingTime": proto._fmt_hms_mmss(rem_s),
                "raw": "TEST-RUNNING,ST-{:02d}/{:02d},{}".format(
                    cur, total, proto._fmt_hms_mmss(set_s) + "/" + proto._fmt_hms_mmss(rem_s)
                ),
            }
        elif sim.get("paused"):
            status = {"state": "PAUSED", "raw": "PAUSED"}
    with _live_lock:
        _live["bath"] = bath
        _live["external"] = ext
        _live["vessels"] = vessels
        _live["status"] = status
        _live["updatedAt"] = time.time()
        _live["simulate"] = True
    _broadcast({"kind": "temperature", "data": get_live()})
    for fn in list(_status_listeners):
        try:
            fn(status)
        except Exception:
            pass
    _broadcast({"kind": "status", "data": status})


def _broadcast(payload: Dict[str, Any]) -> None:
    dead = []
    for q in list(_sse_clients):
        try:
            q.put_nowait(payload)
        except Exception:
            dead.append(q)
    for q in dead:
        try:
            _sse_clients.remove(q)
        except ValueError:
            pass


def start_sse_stream() -> Response:
    q: "queue.Queue" = queue.Queue(maxsize=50)
    _sse_clients.append(q)

    @stream_with_context
    def gen():
        try:
            yield "data: {}\n\n".format(__import__("json").dumps({"kind": "hello", "data": get_live()}))
            while True:
                try:
                    item = q.get(timeout=15.0)
                    yield "data: {}\n\n".format(__import__("json").dumps(item))
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            try:
                _sse_clients.remove(q)
            except ValueError:
                pass

    return Response(gen(), mimetype="text/event-stream")
