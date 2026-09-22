#!/usr/bin/env python3
"""
disso_test_service.py - Server-authoritative Dissolution test + power-loss resume.
"""

from __future__ import annotations

import copy
import math
import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import data_service
import disso_cmd_hardware as cmd_hw
import disso_protocol as proto
import disso_temp_hardware as temp_hw

try:
    import print_service
except ImportError:
    print_service = None

try:
    import rtc_service
except ImportError:
    rtc_service = None

_logger = None
_config: Dict[str, Any] = {}
_lock = threading.Lock()
_audit_fn: Optional[Callable] = None
_save_report_fn: Optional[Callable] = None
_watchdog_started = False
_last_persist_mono = 0.0
_PERSIST_MIN_INTERVAL_SEC = 5.0
_END_TEST_TIMEOUT_SEC = 45.0
_end_test_wait_mono: Optional[float] = None
_last_elapsed_mono: Optional[float] = None
_INTERVAL_LOG_MAX = 500
_interval_print_busy = False
_last_interval_print_fail_audit_mono = 0.0

STATES = (
    "IDLE",
    "PREHEAT",
    "READY",
    "RUNNING",
    "PAUSED",
    "COMPLETE",
    "ABORTED",
    "POWER_RESUME_PENDING",
)

_run: Dict[str, Any] = {
    "runStatus": "IDLE",
    "active": False,
}


def init(logger=None, config=None, audit_fn=None, save_report_fn=None):
    global _logger, _config, _audit_fn, _save_report_fn, _watchdog_started
    _logger = logger
    _config = dict(config or {})
    if audit_fn is not None:
        _audit_fn = audit_fn
    if save_report_fn is not None:
        _save_report_fn = save_report_fn
    cmd_hw.add_event_listener(_on_cmd_event)
    temp_hw.add_status_listener(_on_status)
    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_heartbeat_loop, daemon=True, name="disso-test-hb").start()
    if _logger:
        _logger.info("[disso_test] init")


def set_callbacks(audit_fn=None, save_report_fn=None):
    global _audit_fn, _save_report_fn
    if audit_fn is not None:
        _audit_fn = audit_fn
    if save_report_fn is not None:
        _save_report_fn = save_report_fn


def _now_iso() -> str:
    if rtc_service is not None:
        try:
            dt = rtc_service.read_rtc_wall_datetime()
            if dt is not None:
                return dt.strftime("%Y-%m-%dT%H:%M:%S")
        except Exception:
            pass
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _parse_iso(s: Any) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", ""))
    except Exception:
        return None


def _audit(action: str, details: str = "", **extra):
    if not _audit_fn:
        return
    try:
        _audit_fn(action, details, **extra)
    except Exception:
        if _logger:
            _logger.exception("[disso_test] audit failed")


def _operator_entry(user: Dict[str, Any], action: str) -> Dict[str, Any]:
    return {
        "username": (user or {}).get("username") or "",
        "name": (user or {}).get("name") or (user or {}).get("username") or "",
        "role": (user or {}).get("role") or "",
        "action": action,
        "at": _now_iso(),
    }


def get_state(public: bool = False) -> Dict[str, Any]:
    with _lock:
        st = copy.deepcopy(_run)
    # Never expose monotonic deadline to clients / public JSON.
    st.pop("stepDeadlineMono", None)
    live = temp_hw.get_live()
    st["temps"] = live
    st["simulate"] = bool(live.get("simulate") or cmd_hw.is_simulate())
    if public and st.get("active"):
        # slim payload for login modal
        return {
            "active": True,
            "runStatus": st.get("runStatus"),
            "startedBy": st.get("startedBy"),
            "productName": (st.get("recipe") or {}).get("productName") or (st.get("recipe") or {}).get("name"),
            "stepIndex": st.get("stepIndex"),
            "stepCount": st.get("stepCount"),
            "remainingSecInStep": st.get("remainingSecInStep"),
            "powerFailureMinutes": st.get("powerFailureMinutes"),
            "needsClaim": True,
        }
    return st


def _set_step_deadline_locked(remaining_sec: Optional[int]) -> None:
    """Caller must hold _lock. Sets wall-clock deadline for RUNNING countdown."""
    rem = max(0, int(remaining_sec or 0))
    _run["remainingSecInStep"] = rem
    if (
        rem > 0
        and _run.get("active")
        and _run.get("runStatus") == "RUNNING"
        and not _run.get("paused")
    ):
        _run["stepDeadlineMono"] = time.monotonic() + float(rem)
    else:
        _run.pop("stepDeadlineMono", None)


def _persist(force: bool = False):
    """Checkpoint to USB. Debounced while RUNNING unless force=True."""
    global _last_persist_mono
    now = time.monotonic()
    with _lock:
        payload = copy.deepcopy(_run)
        status = str(payload.get("runStatus") or "")
        active = bool(payload.get("active"))
    if active and status in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "PREHEAT", "READY"):
        if not force and status == "RUNNING" and (now - _last_persist_mono) < _PERSIST_MIN_INTERVAL_SEC:
            return
        payload["type"] = "test"
        payload["lastHeartbeatRtc"] = _now_iso()
        # Slim disk payload: deadline is memory-only; tempLog stays in RAM for the report.
        payload.pop("stepDeadlineMono", None)
        payload.pop("tempLog", None)
        td = payload.get("testData")
        if isinstance(td, dict):
            td = dict(td)
            td.pop("tempLog", None)
            payload["testData"] = td
        data_service.save_test_run_data(payload, compact=True)
        _last_persist_mono = now
    elif not active:
        data_service.clear_test_run_data()
        _last_persist_mono = now


def _load_checkpoint() -> Dict[str, Any]:
    cp = data_service.get_test_run_data()
    return cp if isinstance(cp, dict) else {}


_TEMP_LOG_MAX = 3600  # ~1 hour at 1 sample/sec if polled that often


def _append_temp_log_sample() -> None:
    """Append one continuous bath sample while a test is running.

    Uses the cached UART-2 live snapshot only — never blocks the heartbeat
    thread on a fresh TEMP query (that starved /api/disso/test/state and froze
    the Step Timer UI).
    """
    live = {}
    try:
        live = temp_hw.get_live() or {}
    except Exception:
        live = {}
    bath = live.get("bath") if isinstance(live, dict) else None
    if bath is None:
        return
    with _lock:
        if not _run.get("active") or _run.get("runStatus") not in ("RUNNING", "PAUSED"):
            return
        recipe = _run.get("recipe") or {}
        try:
            set_temp = float(recipe.get("temperature"))
        except (TypeError, ValueError):
            set_temp = None
        step_idx = int(_run.get("stepIndex") or 0)
        steps = _run.get("remainingStepsPayload")
        if not isinstance(steps, list) or not steps:
            steps = proto.normalize_steps(recipe) if recipe else []
        rpm = None
        if 0 <= step_idx < len(steps):
            rpm = steps[step_idx].get("rpm")
        try:
            bath_f = float(bath)
        except (TypeError, ValueError):
            return
        deviation = None
        if set_temp is not None:
            deviation = round(bath_f - set_temp, 2)
        sample = {
            "time": _now_iso(),
            "rpm": rpm,
            "setTemp": set_temp,
            "bathTemp": round(bath_f, 2),
            "deviation": deviation,
        }
        log = _run.setdefault("tempLog", [])
        if not isinstance(log, list):
            log = []
            _run["tempLog"] = log
        log.append(sample)
        while len(log) > _TEMP_LOG_MAX:
            log.pop(0)
        td = _run.setdefault("testData", {})
        if isinstance(td, dict):
            td["tempLog"] = list(log)


def _arm_print_interval_locked() -> None:
    """Caller must hold _lock. Arm next interval slip from current system settings."""
    try:
        iv = int(data_service.get_print_interval_seconds() or 0)
    except Exception:
        iv = 0
    _run["printIntervalSec"] = max(0, iv)
    if iv > 0:
        _run["nextPrintAtMono"] = time.monotonic() + float(iv)
    else:
        _run.pop("nextPrintAtMono", None)


def _clear_print_interval_locked() -> None:
    """Caller must hold _lock."""
    _run.pop("nextPrintAtMono", None)


def _build_interval_snapshot_locked() -> Dict[str, Any]:
    """Caller must hold _lock. Deterministic RUNNING snapshot for A4 + log."""
    recipe = _run.get("recipe") or {}
    step_idx = int(_run.get("stepIndex") or 0)
    steps = _run.get("remainingStepsPayload")
    if not isinstance(steps, list) or not steps:
        steps = proto.normalize_steps(recipe) if recipe else []
    rpm = None
    if 0 <= step_idx < len(steps):
        rpm = steps[step_idx].get("rpm")
    bath = None
    try:
        live = temp_hw.get_live() or {}
        if isinstance(live, dict) and live.get("bath") is not None:
            bath = round(float(live.get("bath")), 2)
    except Exception:
        bath = None
    product = recipe.get("productName") or recipe.get("name") or ""
    return {
        "time": _now_iso(),
        "rtc": _now_iso(),
        "kind": "intervalPrint",
        "step": step_idx + 1,
        "remainingSec": int(_run.get("remainingSecInStep") or 0),
        "bathTemp": bath,
        "rpm": rpm,
        "status": str(_run.get("runStatus") or "RUNNING"),
        "productName": product,
    }


def _append_interval_log_locked(row: Dict[str, Any]) -> None:
    """Caller must hold _lock."""
    log = _run.setdefault("intervalLog", [])
    if not isinstance(log, list):
        log = []
        _run["intervalLog"] = log
    log.append(dict(row))
    while len(log) > _INTERVAL_LOG_MAX:
        log.pop(0)
    td = _run.setdefault("testData", {})
    if isinstance(td, dict):
        td["intervalLog"] = list(log)
    # Mirror into tempLog so reports that only read tempLog still see the row.
    tlog = _run.setdefault("tempLog", [])
    if not isinstance(tlog, list):
        tlog = []
        _run["tempLog"] = tlog
    tlog.append(dict(row))
    while len(tlog) > _TEMP_LOG_MAX:
        tlog.pop(0)
    if isinstance(td, dict):
        td["tempLog"] = list(tlog)


def _emit_interval_print_async(snap: Dict[str, Any]) -> None:
    """Queue A4 print off the heartbeat thread; audit failures without stalling the timer."""
    global _interval_print_busy, _last_interval_print_fail_audit_mono

    def _worker():
        global _interval_print_busy, _last_interval_print_fail_audit_mono
        try:
            if print_service is None:
                raise RuntimeError("print_service unavailable")
            result = print_service.print_interval_a4(snap)
            if not (isinstance(result, dict) and result.get("success")):
                err = (result or {}).get("error") if isinstance(result, dict) else "print failed"
                now = time.monotonic()
                if (now - _last_interval_print_fail_audit_mono) >= 30.0:
                    _last_interval_print_fail_audit_mono = now
                    _audit("Interval print failed", str(err or "A4 print failed"))
        except Exception as exc:
            now = time.monotonic()
            if (now - _last_interval_print_fail_audit_mono) >= 30.0:
                _last_interval_print_fail_audit_mono = now
                _audit("Interval print failed", str(exc))
            if _logger:
                _logger.exception("[disso_test] interval print failed")
        finally:
            _interval_print_busy = False

    _interval_print_busy = True
    threading.Thread(target=_worker, daemon=True, name="disso-interval-print").start()


def _maybe_interval_print() -> None:
    """If RUNNING and interval due, log snapshot and queue A4 slip (non-blocking)."""
    global _interval_print_busy
    snap = None
    with _lock:
        if not _run.get("active") or _run.get("runStatus") != "RUNNING":
            return
        interval_sec = int(_run.get("printIntervalSec") or 0)
        if interval_sec <= 0:
            return
        next_at = _run.get("nextPrintAtMono")
        now = time.monotonic()
        if next_at is None:
            _run["nextPrintAtMono"] = now + float(interval_sec)
            return
        if now < float(next_at):
            return
        # Advance schedule; skip catch-up bursts — one slip per due tick.
        nxt = float(next_at) + float(interval_sec)
        while nxt <= now:
            nxt += float(interval_sec)
        _run["nextPrintAtMono"] = nxt
        snap = _build_interval_snapshot_locked()
        _append_interval_log_locked(snap)
        if _interval_print_busy:
            snap = None  # logged; skip overlapping printer jobs
    if snap:
        _emit_interval_print_async(snap)


def _heartbeat_loop():
    """Wall-clock step countdown. Persist is debounced so USB I/O never stretches ticks."""
    global _end_test_wait_mono, _last_elapsed_mono
    while True:
        time.sleep(0.2)
        try:
            force_persist = False
            need_complete = False
            with _lock:
                active = _run.get("active")
                status = _run.get("runStatus")
                if active and status == "RUNNING":
                    rem_prev = int(_run.get("remainingSecInStep") or 0)
                    deadline = _run.get("stepDeadlineMono")
                    if deadline is None and rem_prev > 0:
                        _run["stepDeadlineMono"] = time.monotonic() + float(rem_prev)
                        deadline = _run["stepDeadlineMono"]
                    now_m = time.monotonic()
                    if _last_elapsed_mono is None:
                        _last_elapsed_mono = now_m
                    else:
                        delta = int(now_m - _last_elapsed_mono)
                        if delta > 0:
                            _run["elapsedSec"] = int(_run.get("elapsedSec") or 0) + delta
                            _last_elapsed_mono += float(delta)
                    if deadline is not None:
                        rem = max(0, int(math.ceil(float(deadline) - now_m)))
                        if rem != rem_prev:
                            _run["remainingSecInStep"] = rem
                        if rem <= 0:
                            steps = _run.get("remainingStepsPayload")
                            if not isinstance(steps, list) or not steps:
                                steps = proto.normalize_steps(_run.get("recipe") or {})
                            idx = int(_run.get("stepIndex") or 0)
                            if idx + 1 < len(steps):
                                nxt = steps[idx + 1]
                                dur = max(0, int(nxt.get("durationSeconds") or 0))
                                _run["stepIndex"] = idx + 1
                                _run["setSecInStep"] = dur
                                _set_step_deadline_locked(dur)
                                _end_test_wait_mono = None
                                force_persist = True
                            else:
                                _run["remainingSecInStep"] = 0
                                _run.pop("stepDeadlineMono", None)
                                if _end_test_wait_mono is None:
                                    _end_test_wait_mono = now_m
                                elif (now_m - _end_test_wait_mono) >= _END_TEST_TIMEOUT_SEC:
                                    need_complete = True
                    _run["lastHeartbeatRtc"] = _now_iso()
                else:
                    _last_elapsed_mono = None
                    if active and status in ("PAUSED", "POWER_RESUME_PENDING", "FINALIZING"):
                        _run["lastHeartbeatRtc"] = _now_iso()

            if need_complete:
                _complete(aborted=False, reason="end_test_timeout")
                continue

            if active and status in ("RUNNING", "PAUSED"):
                _append_temp_log_sample()
            if active and status == "RUNNING":
                _maybe_interval_print()
            if active and status in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "FINALIZING"):
                _persist(force=force_persist or status != "RUNNING")
        except Exception:
            if _logger:
                _logger.exception("[disso_test] heartbeat failed")


def _on_status(status: Dict[str, Any]):
    if not status:
        return
    changed = False
    with _lock:
        if not _run.get("active"):
            return
        state = str(status.get("state") or "").upper()
        if state in ("TEST-RUNNING", "TEST_RUNNING"):
            if status.get("stepCurrent") is not None:
                rem_base = int(_run.get("resumeFromStepIndex") or 0)
                cur = int(status["stepCurrent"]) - 1
                new_idx = rem_base + max(0, cur)
                if new_idx != _run.get("stepIndex"):
                    changed = True
                _run["stepIndex"] = new_idx
            if status.get("remainingTime"):
                rem = proto.hms_to_seconds(status.get("remainingTime"))
                if rem is not None and rem != _run.get("remainingSecInStep"):
                    changed = True
                    _set_step_deadline_locked(rem)
            if status.get("setTime"):
                set_s = proto.hms_to_seconds(status.get("setTime"))
                if set_s is not None:
                    _run["setSecInStep"] = set_s
            if _run.get("runStatus") not in ("PAUSED", "ABORTED", "COMPLETE"):
                if _run.get("runStatus") != "RUNNING":
                    changed = True
                _run["runStatus"] = "RUNNING"
                _run["paused"] = False
                if _run.get("stepDeadlineMono") is None and int(_run.get("remainingSecInStep") or 0) > 0:
                    _set_step_deadline_locked(int(_run.get("remainingSecInStep") or 0))
            _run["espStatus"] = status
            _run["lastHeartbeatRtc"] = _now_iso()
        elif state == "PAUSED":
            if _run.get("runStatus") == "RUNNING":
                _run["runStatus"] = "PAUSED"
                _run["paused"] = True
                _run.pop("stepDeadlineMono", None)
                changed = True
            _run["espStatus"] = status
    if changed:
        _persist(force=True)


def _on_cmd_event(evt: Dict[str, Any]):
    if not evt:
        return
    if evt.get("type") == "END-TEST":
        _complete(aborted=False)


def start(recipe: Dict[str, Any], user: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    meta = meta or {}
    with _lock:
        if _run.get("active") and _run.get("runStatus") in (
            "RUNNING", "PAUSED", "POWER_RESUME_PENDING", "FINALIZING"
        ):
            return {"ok": False, "error": "A test is already active", "state": copy.deepcopy(_run)}

    recipe = dict(recipe or {})
    steps = proto.normalize_steps(recipe)
    if not steps:
        return {"ok": False, "error": "Recipe has no steps"}

    try:
        pf = int(float(recipe.get("powerFailure") or meta.get("powerFailure") or 30))
    except (TypeError, ValueError):
        pf = 30
    pf = max(1, min(60, pf))

    op = _operator_entry(user, "start")
    started = {
        "username": op["username"],
        "name": op["name"],
        "role": op["role"],
        "at": op["at"],
    }

    # Recipe frames (AUTO-DROP → SET-TEMP → TS → RPM → DUR → SML → FL) are uploaded on Load.
    # Start: shaft DOWN → wait LF-CL-HOME → #START-TEST* (timer / run state begin only after ACK).
    start_res = cmd_hw.start_test()
    if not start_res.get("ok"):
        err = start_res.get("error") or "ESP START-TEST failed"
        out = {"ok": False, "error": err, "start": start_res}
        if start_res.get("errorCode"):
            out["errorCode"] = start_res.get("errorCode")
        if start_res.get("phase"):
            out["phase"] = start_res.get("phase")
        return out

    with _lock:
        global _end_test_wait_mono, _last_elapsed_mono
        _end_test_wait_mono = None
        _last_elapsed_mono = time.monotonic()
        _run.clear()
        _run.update(
            {
                "type": "test",
                "active": True,
                "runStatus": "RUNNING",
                "recipe": recipe,
                "mode": recipe.get("mode"),
                "usp": recipe.get("usp"),
                "arNumber": meta.get("arNumber") or recipe.get("arNumber"),
                "batchNumber": meta.get("batchNumber") or recipe.get("batchNumber"),
                "powerFailureMinutes": pf,
                "startedAtRtc": _now_iso(),
                "lastHeartbeatRtc": _now_iso(),
                "stepIndex": 0,
                "stepCount": len(steps),
                "remainingSecInStep": steps[0]["durationSeconds"],
                "setSecInStep": steps[0]["durationSeconds"],
                "elapsedSec": 0,
                "paused": False,
                "startedBy": started,
                "operators": [op],
                "resumeFromStepIndex": 0,
                "remainingStepsPayload": steps,
                "tempLog": [],
                "intervalLog": [],
                "testData": {
                    "productName": recipe.get("productName") or recipe.get("name"),
                    "powerFailure": pf,
                    "steps": recipe.get("steps"),
                    "arNumber": meta.get("arNumber") or recipe.get("arNumber"),
                    "batchNumber": meta.get("batchNumber") or recipe.get("batchNumber"),
                    "tempLog": [],
                    "intervalLog": [],
                },
            }
        )
        _set_step_deadline_locked(steps[0]["durationSeconds"])
        _arm_print_interval_locked()
    _persist(force=True)
    product = recipe.get("productName") or recipe.get("name") or started.get("name") or "Recipe"
    _audit(
        "Test started",
        "{} | {} step(s)".format(product, len(steps)),
    )
    return {"ok": True, "state": get_state()}


def pause(user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    with _lock:
        if not _run.get("active") or _run.get("runStatus") != "RUNNING":
            return {"ok": False, "error": "No running test to pause"}
    res = cmd_hw.pause_test()
    if not res.get("ok"):
        return {"ok": False, "error": res.get("error") or "PAUSE failed", "hw": res}
    with _lock:
        _run["runStatus"] = "PAUSED"
        _run["paused"] = True
        _run.pop("stepDeadlineMono", None)
        _clear_print_interval_locked()
        if user:
            _run.setdefault("operators", []).append(_operator_entry(user, "pause"))
    _persist(force=True)
    _audit("Test paused", "")
    return {"ok": True, "state": get_state()}


def resume_esp(user: Optional[Dict[str, Any]] = None, force_reupload: bool = False) -> Dict[str, Any]:
    """
    Soft pause → #RESUME-TEST*.
    force_reupload is legacy; power-claim uses continue_run / PF-RESUME.
    """
    with _lock:
        if not _run.get("active"):
            return {"ok": False, "error": "No paused test to resume"}
        status = str(_run.get("runStatus") or "")

    if status == "RUNNING" and user and force_reupload:
        with _lock:
            _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
        _persist(force=True)
        _audit("Test continued", "already RUNNING | claim only")
        return {"ok": True, "state": get_state(), "claimedOnly": True}

    if status == "POWER_RESUME_PENDING":
        return _retry_pf_resume(user)

    if status != "PAUSED":
        return {"ok": False, "error": "No paused test to resume"}

    start_res = cmd_hw.resume_test()
    if not start_res.get("ok"):
        out = {"ok": False, "error": start_res.get("error") or "RESUME-TEST failed", "start": start_res}
        if start_res.get("errorCode"):
            out["errorCode"] = start_res.get("errorCode")
        return out

    with _lock:
        global _end_test_wait_mono, _last_elapsed_mono
        _end_test_wait_mono = None
        _last_elapsed_mono = time.monotonic()
        _run["runStatus"] = "RUNNING"
        _run["paused"] = False
        _run["resumeFromStepIndex"] = int(_run.get("stepIndex") or 0)
        rem_now = int(_run.get("remainingSecInStep") or 0)
        _set_step_deadline_locked(rem_now)
        _arm_print_interval_locked()
        if user:
            _run.setdefault("operators", []).append(_operator_entry(user, "resume"))
    _persist(force=True)
    _audit("Test resumed", "")
    return {"ok": True, "state": get_state()}


def _retry_pf_resume(user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Retry power-loss resume when boot auto-resume left POWER_RESUME_PENDING."""
    pf_res = cmd_hw.pf_resume_test()
    if not pf_res.get("ok"):
        _audit("Power resume failed", str(pf_res.get("error") or "failed"))
        return {
            "ok": False,
            "error": pf_res.get("error") or "Power resume failed",
            "pf": pf_res,
        }
    with _lock:
        global _end_test_wait_mono, _last_elapsed_mono
        _end_test_wait_mono = None
        _last_elapsed_mono = time.monotonic()
        _run["runStatus"] = "RUNNING"
        _run["paused"] = False
        rem_now = int(_run.get("remainingSecInStep") or 0)
        _set_step_deadline_locked(rem_now)
        _arm_print_interval_locked()
        if user:
            _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
    _persist(force=True)
    _audit("Test continued", "Resumed after power interruption")
    return {"ok": True, "state": get_state()}


def _hydrate_active_from_checkpoint_if_needed() -> bool:
    """Restore in-memory run from test_run.json when bridge memory is empty."""
    with _lock:
        if _run.get("active"):
            return True
    cp = _load_checkpoint()
    if not isinstance(cp, dict) or cp.get("type") != "test":
        return False
    status = str(cp.get("runStatus") or "").upper()
    if not (
        cp.get("active")
        or status in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "READY", "PREHEAT", "FINALIZING")
    ):
        return False
    hydrate_from_checkpoint_without_hw(cp)
    return True


def continue_run(user: Dict[str, Any]) -> Dict[str, Any]:
    """User claims an active/auto-resumed run after login (power-cut path)."""
    if not _hydrate_active_from_checkpoint_if_needed():
        return {"ok": False, "error": "No active test"}
    with _lock:
        if not _run.get("active"):
            return {"ok": False, "error": "No active test"}
        status = str(_run.get("runStatus") or "")

    if status == "RUNNING":
        with _lock:
            _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
        _persist(force=True)
        _audit("Test continued", "already RUNNING | claim only | no UART")
        return {"ok": True, "state": get_state(), "claimedOnly": True}

    if status == "POWER_RESUME_PENDING":
        return _retry_pf_resume(user)

    if status == "PAUSED":
        return resume_esp(user, force_reupload=False)

    return {"ok": False, "error": "No claimable test (status={})".format(status)}


def abort(user: Optional[Dict[str, Any]] = None, reason: str = "user_abort") -> Dict[str, Any]:
    with _lock:
        if not _run.get("active"):
            return {"ok": False, "error": "No active test"}
    cmd_hw.stop_test()
    return _complete(aborted=True, user=user, reason=reason)


def claim_abort(user: Dict[str, Any]) -> Dict[str, Any]:
    if not _hydrate_active_from_checkpoint_if_needed():
        return {"ok": False, "error": "No active test"}
    return abort(user=user, reason="user_abort")


def _complete(aborted: bool = False, user: Optional[Dict[str, Any]] = None, reason: str = "") -> Dict[str, Any]:
    """Finish run, save report, then publish COMPLETE/ABORTED with lastReportId.

    Important: never expose COMPLETE/ABORTED to /state without reportId — the UI
    opens the pending pre-approval preview from that id and would latch closed
    forever if it sees COMPLETE first without an id.
    """
    global _end_test_wait_mono, _last_elapsed_mono
    with _lock:
        status_now = str(_run.get("runStatus") or "")
        if not _run.get("active") and status_now in ("COMPLETE", "ABORTED", "IDLE"):
            return {"ok": True, "state": copy.deepcopy(_run)}
        if status_now == "FINALIZING":
            # Another END-TEST / abort is already saving the report.
            return {"ok": True, "state": get_state()}
        if not _run.get("active") and status_now not in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "READY", "PREHEAT"):
            return {"ok": True, "state": copy.deepcopy(_run)}
        run = copy.deepcopy(_run)
        if user:
            run.setdefault("operators", []).append(_operator_entry(user, "abort" if aborted else "continue"))
        run.pop("stepDeadlineMono", None)
        # Hold UI on "still finishing" until report id is attached.
        _run["runStatus"] = "FINALIZING"
        _run["paused"] = False
        _run.pop("stepDeadlineMono", None)
        _clear_print_interval_locked()
        _end_test_wait_mono = None
        _last_elapsed_mono = None

    report_id = None
    if _save_report_fn:
        try:
            report_id = _save_report_fn(run, aborted=aborted)
        except Exception:
            if _logger:
                _logger.exception("[disso_test] save report failed")
    data_service.clear_test_run_data()

    with _lock:
        run["active"] = False
        run["runStatus"] = "ABORTED" if aborted else "COMPLETE"
        run["paused"] = False
        run["completedAtRtc"] = _now_iso()
        run["abortReason"] = reason if aborted else None
        run.pop("stepDeadlineMono", None)
        run["lastReportId"] = report_id
        run["reportId"] = report_id
        _run.clear()
        _run.update(run)
    _audit("Test aborted" if aborted else "Test finished", "report id {}".format(report_id or "—"))
    return {"ok": True, "aborted": aborted, "reportId": report_id, "state": get_state()}


def _remaining_recipe_seconds(cp: Dict[str, Any]) -> int:
    """Total seconds left in recipe from stepIndex + remainingSecInStep + later steps."""
    recipe = cp.get("recipe") or {}
    steps = proto.normalize_steps(recipe) if recipe else []
    if not steps:
        return max(0, int(cp.get("remainingSecInStep") or 0))
    idx = max(0, int(cp.get("stepIndex") or 0))
    rem = max(0, int(cp.get("remainingSecInStep") or 0))
    total = rem
    for i in range(idx + 1, len(steps)):
        total += max(0, int(steps[i].get("durationSeconds") or 0))
    return total


def _apply_outage_to_checkpoint(cp: Dict[str, Any], outage_sec: int) -> Dict[str, Any]:
    """
    Subtract outage wall time from remaining recipe time.
    Returns a deep-copied checkpoint with adjusted stepIndex / remainingSecInStep.
    """
    out = copy.deepcopy(cp)
    recipe = out.get("recipe") or {}
    steps = proto.normalize_steps(recipe) if recipe else []
    if not steps:
        rem = max(0, int(out.get("remainingSecInStep") or 0) - max(0, int(outage_sec)))
        out["remainingSecInStep"] = rem
        return out
    idx = max(0, min(int(out.get("stepIndex") or 0), len(steps) - 1))
    rem = max(0, int(out.get("remainingSecInStep") or 0))
    left = max(0, int(outage_sec))
    while left > 0 and idx < len(steps):
        if rem <= left:
            left -= rem
            idx += 1
            if idx >= len(steps):
                rem = 0
                idx = len(steps) - 1
                break
            rem = max(0, int(steps[idx].get("durationSeconds") or 0))
        else:
            rem -= left
            left = 0
    out["stepIndex"] = idx
    out["remainingSecInStep"] = rem
    out["setSecInStep"] = max(0, int(steps[idx].get("durationSeconds") or 0)) if steps else rem
    out["stepCount"] = len(steps)
    rem_steps = steps[idx:]
    if rem_steps:
        rem_steps = [dict(s) for s in rem_steps]
        rem_steps[0]["durationSeconds"] = rem
        for i, s in enumerate(rem_steps):
            s["index"] = i + 1
        out["remainingStepsPayload"] = rem_steps
    return out


def try_startup_power_recovery() -> Dict[str, Any]:
    """
    Called on unclean boot.
    Within powerFailure window:
      - if remaining recipe time exhausted during outage → completed (finished_during_outage)
      - else #PF-RESUME-TEST* (no login, no re-upload)
    Over window → abort_needed for app abort report.
    FINALIZING without report → needs_finalize.
    """
    cp = _load_checkpoint()
    if not cp or cp.get("type") != "test":
        return {"recovered": False, "aborted": False, "reason": "no_checkpoint"}

    status = (cp.get("runStatus") or "").upper()
    if status == "FINALIZING" and not cp.get("lastReportId") and not cp.get("reportId"):
        return {
            "recovered": False,
            "aborted": False,
            "completed": False,
            "needs_finalize": True,
            "reason": "finalizing_no_report",
            "checkpoint": cp,
        }
    if status in ("COMPLETE", "ABORTED", "IDLE"):
        data_service.clear_test_run_data()
        return {"recovered": False, "aborted": False, "reason": "inactive_checkpoint"}
    if status not in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "READY", "PREHEAT", "FINALIZING"):
        data_service.clear_test_run_data()
        return {"recovered": False, "aborted": False, "reason": "inactive_checkpoint"}

    pf = int(cp.get("powerFailureMinutes") or (cp.get("recipe") or {}).get("powerFailure") or 30)
    pf = max(1, min(60, pf))
    last = _parse_iso(cp.get("lastHeartbeatRtc") or cp.get("startedAtRtc"))
    now = _parse_iso(_now_iso()) or datetime.now()
    if last is None:
        outage_sec = pf * 60 + 1
    else:
        outage_sec = max(0, int((now - last).total_seconds()))

    if outage_sec > pf * 60:
        return {
            "recovered": False,
            "aborted": True,
            "reason": "power_failure_timeout",
            "outageSec": outage_sec,
            "powerFailureMinutes": pf,
            "checkpoint": cp,
        }

    remaining_before = _remaining_recipe_seconds(cp)
    adjusted = _apply_outage_to_checkpoint(cp, outage_sec)
    remaining_after = _remaining_recipe_seconds(adjusted)

    if remaining_before <= 0 or remaining_after <= 0:
        return {
            "recovered": False,
            "aborted": False,
            "completed": True,
            "reason": "finished_during_outage",
            "outageSec": outage_sec,
            "powerFailureMinutes": pf,
            "remainingBeforeSec": remaining_before,
            "checkpoint": adjusted,
        }

    pf_res = cmd_hw.pf_resume_test()
    with _lock:
        global _end_test_wait_mono, _last_elapsed_mono
        _run.clear()
        _run.update(adjusted)
        _run["active"] = True
        _run["lastHeartbeatRtc"] = _now_iso()
        _run["resumeFromStepIndex"] = int(_run.get("stepIndex") or 0)
        _run.pop("stepDeadlineMono", None)
        if pf_res.get("ok"):
            _run["runStatus"] = "RUNNING"
            _run["paused"] = False
            rem_now = int(_run.get("remainingSecInStep") or 0)
            _set_step_deadline_locked(rem_now)
            _end_test_wait_mono = None
            _last_elapsed_mono = time.monotonic()
            _arm_print_interval_locked()
            recovered = True
            pending = False
        else:
            _run["runStatus"] = "POWER_RESUME_PENDING"
            _run.pop("stepDeadlineMono", None)
            recovered = False
            pending = True
    _persist(force=True)
    if pf_res.get("ok"):
        _audit(
            "Power auto-resume",
            "outage {}s | step {} | resumed".format(outage_sec, adjusted.get("stepIndex")),
        )
    else:
        _audit("Power resume failed", str(pf_res.get("error") or "failed"))
        _audit(
            "Power resume pending",
            "outage {}s | waiting for operator continue".format(outage_sec),
        )
        _audit(
            "Power auto-resume",
            "outage {}s | pending operator action".format(outage_sec),
        )
    return {
        "recovered": recovered,
        "aborted": False,
        "pending": pending,
        "completed": False,
        "outageSec": outage_sec,
        "powerFailureMinutes": pf,
        "state": get_state(),
        "pf": pf_res,
    }


def hydrate_from_checkpoint_without_hw(cp: Dict[str, Any]) -> None:
    global _end_test_wait_mono, _last_elapsed_mono
    with _lock:
        _run.clear()
        _run.update(copy.deepcopy(cp))
        _run["active"] = True
        _run.pop("stepDeadlineMono", None)
        if _run.get("runStatus") == "RUNNING" and not _run.get("paused"):
            rem_now = int(_run.get("remainingSecInStep") or 0)
            _set_step_deadline_locked(rem_now)
            _last_elapsed_mono = time.monotonic()
            _end_test_wait_mono = None
            _arm_print_interval_locked()
        else:
            _last_elapsed_mono = None
            _end_test_wait_mono = None
            _clear_print_interval_locked()
