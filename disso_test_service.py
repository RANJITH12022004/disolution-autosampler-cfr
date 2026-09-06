#!/usr/bin/env python3
"""
disso_test_service.py - Server-authoritative Dissolution test + power-loss resume.
"""

from __future__ import annotations

import copy
import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import data_service
import disso_cmd_hardware as cmd_hw
import disso_protocol as proto
import disso_temp_hardware as temp_hw

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


def _persist():
    with _lock:
        payload = copy.deepcopy(_run)
    if payload.get("active") and payload.get("runStatus") in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "PREHEAT", "READY"):
        payload["type"] = "test"
        payload["lastHeartbeatRtc"] = _now_iso()
        data_service.save_test_run_data(payload)
    elif not payload.get("active"):
        data_service.clear_test_run_data()


def _load_checkpoint() -> Dict[str, Any]:
    cp = data_service.get_test_run_data()
    return cp if isinstance(cp, dict) else {}


_TEMP_LOG_MAX = 3600  # ~1 hour at 1 sample/sec if polled that often


def _append_temp_log_sample() -> None:
    """Append one continuous bath sample while a test is running."""
    live = {}
    try:
        live = temp_hw.query_live_temp_now(wait_sec=0.4) or {}
    except Exception:
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


def _heartbeat_loop():
    while True:
        time.sleep(1.0)
        try:
            with _lock:
                active = _run.get("active")
                status = _run.get("runStatus")
            if active and status in ("RUNNING", "PAUSED"):
                _append_temp_log_sample()
            if active and status in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING"):
                with _lock:
                    _run["lastHeartbeatRtc"] = _now_iso()
                _persist()
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
        if status.get("state") == "TEST-RUNNING":
            if status.get("stepCurrent") is not None:
                rem_base = int(_run.get("resumeFromStepIndex") or _run.get("stepIndex") or 0)
                cur = int(status["stepCurrent"]) - 1
                new_idx = rem_base + max(0, cur)
                if new_idx != _run.get("stepIndex"):
                    changed = True
                _run["stepIndex"] = new_idx
            if status.get("remainingTime"):
                rem = proto.hms_to_seconds(status.get("remainingTime"))
                if rem != _run.get("remainingSecInStep"):
                    changed = True
                _run["remainingSecInStep"] = rem
            if status.get("setTime"):
                _run["setSecInStep"] = proto.hms_to_seconds(status.get("setTime"))
            if _run.get("runStatus") not in ("PAUSED", "ABORTED", "COMPLETE"):
                if _run.get("runStatus") != "RUNNING":
                    changed = True
                _run["runStatus"] = "RUNNING"
            _run["espStatus"] = status
            _run["lastHeartbeatRtc"] = _now_iso()
    if changed:
        _persist()


def _on_cmd_event(evt: Dict[str, Any]):
    if not evt:
        return
    if evt.get("type") == "END-TEST":
        _complete(aborted=False)


def start(recipe: Dict[str, Any], user: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    meta = meta or {}
    with _lock:
        if _run.get("active") and _run.get("runStatus") in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING"):
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

    # Recipe frames (SET-TEMP → TS → RPM → DUR → SML → FL → AUTO-DROP) are uploaded on Load.
    # Start only sends #START-TEST*.
    start_res = cmd_hw.start_test()
    if not start_res.get("ok"):
        err = start_res.get("error") or "ESP START-TEST failed"
        out = {"ok": False, "error": err, "start": start_res}
        if start_res.get("errorCode"):
            out["errorCode"] = start_res.get("errorCode")
        return out

    with _lock:
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
                "testData": {
                    "productName": recipe.get("productName") or recipe.get("name"),
                    "powerFailure": pf,
                    "steps": recipe.get("steps"),
                    "arNumber": meta.get("arNumber") or recipe.get("arNumber"),
                    "batchNumber": meta.get("batchNumber") or recipe.get("batchNumber"),
                    "tempLog": [],
                },
            }
        )
    _persist()
    _audit("Test started", "{} | steps {}".format(started.get("name"), len(steps)))
    _audit("ESP START-TEST", "ok")
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
        if user:
            _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
    _persist()
    _audit("Test paused", "")
    return {"ok": True, "state": get_state()}


def resume_esp(user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Resume after PAUSE (not power-loss). Re-issues START-TEST if firmware needs it."""
    with _lock:
        if not _run.get("active") or _run.get("runStatus") not in ("PAUSED", "POWER_RESUME_PENDING"):
            return {"ok": False, "error": "No paused test to resume"}
        recipe = copy.deepcopy(_run.get("recipe") or {})
        step_index = int(_run.get("stepIndex") or 0)
        rem = _run.get("remainingSecInStep")
    upload = cmd_hw.upload_recipe(recipe, from_step_index=step_index, remaining_sec_in_step=rem)
    if not upload.get("ok"):
        return {"ok": False, "error": upload.get("error") or "re-upload failed", "upload": upload}
    start_res = cmd_hw.start_test()
    if not start_res.get("ok"):
        out = {"ok": False, "error": start_res.get("error") or "START-TEST failed", "start": start_res}
        if start_res.get("errorCode"):
            out["errorCode"] = start_res.get("errorCode")
        return out
    with _lock:
        _run["runStatus"] = "RUNNING"
        _run["paused"] = False
        _run["resumeFromStepIndex"] = int(_run.get("stepIndex") or 0)
        if user:
            _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
    _persist()
    _audit("Test resumed", "")
    return {"ok": True, "state": get_state()}


def continue_run(user: Dict[str, Any]) -> Dict[str, Any]:
    """User claims an active/auto-resumed run after login."""
    with _lock:
        if not _run.get("active"):
            return {"ok": False, "error": "No active test"}
        _run.setdefault("operators", []).append(_operator_entry(user, "continue"))
        if _run.get("runStatus") == "POWER_RESUME_PENDING":
            # try hardware resume now
            pass
    st = get_state()
    if st.get("runStatus") == "POWER_RESUME_PENDING":
        return resume_esp(user)
    _persist()
    _audit("Test continued", (user or {}).get("username") or "")
    return {"ok": True, "state": get_state()}


def abort(user: Optional[Dict[str, Any]] = None, reason: str = "user_abort") -> Dict[str, Any]:
    with _lock:
        if not _run.get("active"):
            return {"ok": False, "error": "No active test"}
    cmd_hw.stop_test()
    return _complete(aborted=True, user=user, reason=reason)


def claim_abort(user: Dict[str, Any]) -> Dict[str, Any]:
    return abort(user=user, reason="user_abort")


def _complete(aborted: bool = False, user: Optional[Dict[str, Any]] = None, reason: str = "") -> Dict[str, Any]:
    with _lock:
        if not _run.get("active") and _run.get("runStatus") in ("COMPLETE", "ABORTED", "IDLE"):
            return {"ok": True, "state": copy.deepcopy(_run)}
        run = copy.deepcopy(_run)
        if user:
            run.setdefault("operators", []).append(_operator_entry(user, "abort" if aborted else "continue"))
        run["active"] = False
        run["runStatus"] = "ABORTED" if aborted else "COMPLETE"
        run["paused"] = False
        run["completedAtRtc"] = _now_iso()
        run["abortReason"] = reason if aborted else None
        _run.clear()
        _run.update(run)

    report_id = None
    if _save_report_fn:
        try:
            report_id = _save_report_fn(run, aborted=aborted)
        except Exception:
            if _logger:
                _logger.exception("[disso_test] save report failed")
    data_service.clear_test_run_data()
    _audit("Test aborted" if aborted else "Test finished", "report id {}".format(report_id or "—"))
    if not aborted:
        _audit("ESP END-TEST", "ok")
    return {"ok": True, "aborted": aborted, "reportId": report_id, "state": get_state()}


def try_startup_power_recovery() -> Dict[str, Any]:
    """
    Called on unclean boot.
    If checkpoint within powerFailure window: auto re-upload remaining steps + START-TEST (no login).
    Else: return abort_needed so app can save aborted report.
    """
    cp = _load_checkpoint()
    if not cp or cp.get("type") != "test":
        return {"recovered": False, "aborted": False, "reason": "no_checkpoint"}

    status = (cp.get("runStatus") or "").upper()
    if status not in ("RUNNING", "PAUSED", "POWER_RESUME_PENDING", "READY", "PREHEAT"):
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
        # Over window — caller should abort-report from checkpoint
        return {
            "recovered": False,
            "aborted": True,
            "reason": "power_failure_timeout",
            "outageSec": outage_sec,
            "powerFailureMinutes": pf,
            "checkpoint": cp,
        }

    recipe = cp.get("recipe") or {}
    step_index = int(cp.get("stepIndex") or 0)
    rem = cp.get("remainingSecInStep")
    upload = cmd_hw.upload_recipe(recipe, from_step_index=step_index, remaining_sec_in_step=rem)
    start_res = None
    if upload.get("ok"):
        start_res = cmd_hw.start_test()

    with _lock:
        _run.clear()
        _run.update(copy.deepcopy(cp))
        _run["active"] = True
        _run["lastHeartbeatRtc"] = _now_iso()
        _run["resumeFromStepIndex"] = step_index
        if upload.get("ok") and start_res and start_res.get("ok"):
            _run["runStatus"] = "RUNNING"
            _run["paused"] = False
            recovered = True
            pending = False
        else:
            _run["runStatus"] = "POWER_RESUME_PENDING"
            recovered = False
            pending = True
    _persist()
    _audit(
        "Power auto-resume",
        "outage {}s <= {}min | recovered={} pending={}".format(outage_sec, pf, recovered, pending),
    )
    return {
        "recovered": recovered,
        "aborted": False,
        "pending": pending,
        "outageSec": outage_sec,
        "powerFailureMinutes": pf,
        "state": get_state(),
        "upload": upload,
        "start": start_res,
    }


def hydrate_from_checkpoint_without_hw(cp: Dict[str, Any]) -> None:
    with _lock:
        _run.clear()
        _run.update(copy.deepcopy(cp))
        _run["active"] = True
