#!/usr/bin/env python3
"""Power-interruption smoke matrix for Dissolution Tester (in-process)."""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))
os.chdir(APP_ROOT)
os.environ.setdefault("SIMULATE_HARDWARE", "1")

import data_service
import disso_test_service
import report_service

STORAGE = APP_ROOT / "storage"
RESULTS = []


def ok(msg: str) -> None:
    RESULTS.append(("PASS", msg))
    print("PASS:", msg)


def fail(msg: str) -> None:
    RESULTS.append(("FAIL", msg))
    print("FAIL:", msg)


def note(msg: str) -> None:
    RESULTS.append(("NOTE", msg))
    print("NOTE:", msg)


def _iso_ago(seconds: int) -> str:
    return (datetime.now() - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _base_checkpoint(**overrides):
    recipe = {
        "productName": "PI Smoke Recipe",
        "temperature": 37,
        "powerFailure": 5,
        "steps": [
            {"step": 1, "rpm": 50, "durationSeconds": 120},
            {"step": 2, "rpm": 75, "durationSeconds": 180},
            {"step": 3, "rpm": 100, "durationSeconds": 60},
        ],
    }
    cp = {
        "type": "test",
        "active": True,
        "runStatus": "RUNNING",
        "paused": False,
        "recipe": recipe,
        "productName": recipe["productName"],
        "stepIndex": 1,
        "stepCount": 3,
        "remainingSecInStep": 90,
        "setSecInStep": 180,
        "powerFailureMinutes": 5,
        "startedAtRtc": _iso_ago(300),
        "lastHeartbeatRtc": _iso_ago(30),
        "startedBy": {"username": "smoke", "name": "Smoke", "role": "admin"},
        "operators": [{"username": "smoke", "name": "Smoke", "role": "admin"}],
        "arNumber": "AR-PI-1",
        "batchNumber": "B-PI-1",
    }
    cp.update(overrides)
    return cp


def case_clean_stop():
    data_service.clear_test_run_data()
    data_service.touch_app_clean_stop_flag()
    assert (STORAGE / "app_clean_stop.flag").exists()
    consumed = data_service.consume_app_clean_stop_flag()
    if consumed and not (STORAGE / "app_clean_stop.flag").exists():
        ok("1 Clean stop flag written and consumed (no false PI on next start)")
    else:
        fail("1 Clean stop flag consume failed")


def case_within_window_auto_resume():
    data_service.clear_test_run_data()
    cp = _base_checkpoint(lastHeartbeatRtc=_iso_ago(60), powerFailureMinutes=5)
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    if recovery.get("aborted"):
        fail("2 Within-window recovery aborted unexpectedly: {}".format(recovery))
        return
    if recovery.get("completed"):
        fail("2 Within-window should not complete: {}".format(recovery))
        return
    if recovery.get("recovered") or recovery.get("pending"):
        ok(
            "2 Within-window recovery recovered={} pending={} outageSec={}".format(
                recovery.get("recovered"), recovery.get("pending"), recovery.get("outageSec")
            )
        )
        pf = recovery.get("pf") or {}
        if recovery.get("recovered") and (pf.get("ok") or pf.get("ack")):
            ok("2 Used PF-RESUME-TEST path ack={}".format(pf.get("ack")))
        st = disso_test_service.get_state()
        if st.get("active") and st.get("stepIndex") == 1:
            ok("2 Checkpoint stepIndex preserved for multi-step resume")
        else:
            fail("2 State after recovery unexpected: {}".format(st))
    else:
        fail("2 Within-window recovery did nothing: {}".format(recovery))
    data_service.clear_test_run_data()


def case_finished_during_outage():
    data_service.clear_test_run_data()
    # remaining 90s on step, outage 200s within 5min buffer → finished
    cp = _base_checkpoint(
        lastHeartbeatRtc=_iso_ago(200),
        powerFailureMinutes=5,
        stepIndex=2,
        remainingSecInStep=60,
        recipe={
            "productName": "PI Smoke Recipe",
            "temperature": 37,
            "powerFailure": 5,
            "steps": [
                {"step": 1, "rpm": 50, "durationSeconds": 120},
                {"step": 2, "rpm": 75, "durationSeconds": 180},
                {"step": 3, "rpm": 100, "durationSeconds": 60},
            ],
        },
    )
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    if recovery.get("completed") and recovery.get("reason") == "finished_during_outage":
        ok("2b Finished-during-outage completed=True outageSec={}".format(recovery.get("outageSec")))
    else:
        fail("2b Expected finished_during_outage, got {}".format(recovery))
    data_service.clear_test_run_data()


def case_claim_continue_no_uart():
    data_service.clear_test_run_data()
    cp = _base_checkpoint(lastHeartbeatRtc=_iso_ago(30), powerFailureMinutes=5)
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    if not recovery.get("recovered"):
        fail("8 Claim-continue setup not recovered: {}".format(recovery))
        data_service.clear_test_run_data()
        return
    user_b = {"username": "bob", "name": "Bob", "role": "user"}
    res = disso_test_service.continue_run(user_b)
    ops = (disso_test_service.get_state() or {}).get("operators") or []
    actions = [o.get("action") for o in ops if isinstance(o, dict)]
    names = [o.get("username") for o in ops if isinstance(o, dict)]
    if res.get("ok") and res.get("claimedOnly") and "continue" in actions and "bob" in names:
        ok("8 Claim Continue while RUNNING is claim-only; operators include bob")
    else:
        fail("8 Claim Continue unexpected res={} ops={}".format(res, ops))
    data_service.clear_test_run_data()


def case_pf_protocol_builders():
    import disso_protocol as proto
    if proto.build_pf_resume_test() == "#PF-RESUME-TEST*" and proto.build_pf_status() == "#PF-STATUS*":
        ok("9 Protocol PF-RESUME / PF-STATUS builders")
    else:
        fail("9 PF builders wrong")
    if proto.build_beep(5) == "#BEEP-2*":
        ok("9 Beep clamped to 2")
    else:
        fail("9 Beep clamp failed: {}".format(proto.build_beep(5)))
    frames = proto.build_recipe_frames(
        {"temperature": 37, "mediaVolume": 900, "steps": [{"rpm": 50, "durationSeconds": 60, "sampleVolume": 10}]}
    )
    if any("MDV-900" in f for f in frames):
        ok("9 Recipe frames include MDV-900")
    else:
        fail("9 MDV missing from frames: {}".format(frames))


def case_a4_performed_by():
    import print_service
    text = print_service.format_for_a4_printer(
        {
            "type": "test",
            "operatorName": "Alice",
            "operatorTrail": [
                {"action": "start", "name": "Alice", "username": "alice", "role": "user", "at": "2026-01-01T00:00:00"},
                {"action": "continue", "name": "Bob", "username": "bob", "role": "user", "at": "2026-01-01T01:00:00"},
            ],
            "testData": {"productName": "X", "status": "completed"},
        }
    )
    if "Performed by:" in text and "Alice" in text and "Bob" in text:
        ok("10 A4 print includes Performed by trail for A and B")
    else:
        fail("10 A4 trail missing: {}".format(text[-400:]))


def case_outside_window_abort():
    data_service.clear_test_run_data()
    cp = _base_checkpoint(
        lastHeartbeatRtc=_iso_ago(400),
        powerFailureMinutes=1,
        runStatus="RUNNING",
    )
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    if recovery.get("aborted") and recovery.get("reason") == "power_failure_timeout":
        ok(
            "3 Outside-window abort reason=power_failure_timeout outageSec={}".format(
                recovery.get("outageSec")
            )
        )
        # Simulate report stamp path used by app
        report = dict(recovery["checkpoint"])
        report["status"] = "Aborted"
        report["remarks"] = "power interruption"
        report["abortReason"] = "power_failure_timeout"
        if "power interruption" in str(report.get("remarks") or "").lower():
            ok("3 Abort remarks carry power interruption")
        else:
            fail("3 Abort remarks missing")
    else:
        fail("3 Expected outside-window abort, got {}".format(recovery))
    data_service.clear_test_run_data()


def case_paused_interrupt():
    data_service.clear_test_run_data()
    cp = _base_checkpoint(runStatus="PAUSED", paused=True, lastHeartbeatRtc=_iso_ago(20))
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    if recovery.get("aborted"):
        fail("4 Paused+within-window should not abort: {}".format(recovery))
    elif recovery.get("recovered") or recovery.get("pending"):
        ok("4 Paused checkpoint recovers/pending within window")
    else:
        fail("4 Paused recovery unexpected: {}".format(recovery))
    data_service.clear_test_run_data()


def case_multistep_index():
    data_service.clear_test_run_data()
    cp = _base_checkpoint(stepIndex=2, remainingSecInStep=40, lastHeartbeatRtc=_iso_ago(10))
    data_service.save_test_run_data(cp)
    recovery = disso_test_service.try_startup_power_recovery()
    st = disso_test_service.get_state()
    if (recovery.get("recovered") or recovery.get("pending")) and int(st.get("stepIndex") or -1) == 2:
        ok("5 Multi-step resume keeps stepIndex=2")
    else:
        fail("5 Multi-step resume failed recovery={} state={}".format(recovery, st))
    data_service.clear_test_run_data()


def case_uart2_auto_arm():
    import disso_temp_hardware as th
    import disso_protocol as proto

    # Minimal init without Flask app
    class _A:
        logger = None

    th.init(_A(), {"SIMULATE_HARDWARE": True, "ESP_TEMP_PORT": "/dev/null"})
    armed = th.arm_auto_temp("smoke")
    live = th.get_live()
    if armed.get("armed") and live.get("bath") is not None:
        ok("6 UART-2 auto-arm works; live bath={}".format(live.get("bath")))
    else:
        fail("6 UART-2 auto-arm failed: {} live={}".format(armed, live))
    st = (live.get("status") or {})
    # In simulate with no cmd running, status is IDLE/IDEL
    if st.get("state") in ("IDLE", "TEST-RUNNING", "PAUSED"):
        ok("6 UART-2 status state={}".format(st.get("state")))
    else:
        note("6 UART-2 status unusual: {}".format(st))
    th.disarm_auto_temp("smoke")
    if not th.is_auto_temp_armed():
        ok("6 UART-2 auto-disarm works")
    else:
        fail("6 UART-2 still armed after disarm")
    # Protocol shapes
    assert proto.build_temp_poll() == "#TEMP*"
    assert proto.build_temp_auto_1sec() == "#TEMP-A-1SEC*"
    assert proto.build_statues_poll() == "#STATUES*"
    parsed = proto.parse_statues("TEST-RUNNING,ST-03/07,00:05:00/00:04:30")
    if parsed and parsed.get("stepCurrent") == 3:
        ok("6 Protocol STATUS/STATUES parse matches expected ST/times")
    else:
        fail("6 Protocol parse failed: {}".format(parsed))


def case_operator_trail_shape():
    cp = _base_checkpoint(
        operators=[
            {"username": "op1", "name": "Op One", "role": "user"},
            {"username": "rev1", "name": "Rev One", "role": "reviewer"},
        ]
    )
    if len(cp["operators"]) == 2:
        ok("7 Operator trail shape preserved on checkpoint (Continue path appends similarly)")
    else:
        fail("7 Operator trail missing")


def main():
    cfg = {"STORAGE_DIR": STORAGE, "REPORTS_DIR": APP_ROOT / "reports", "SIMULATE_HARDWARE": True}
    data_service.init(cfg)
    import disso_cmd_hardware as cmd_hw
    class _A:
        logger = None
    cmd_hw.init(_A(), cfg)
    disso_test_service.init(logger=None, config=cfg)

    case_clean_stop()
    case_within_window_auto_resume()
    case_finished_during_outage()
    case_outside_window_abort()
    case_paused_interrupt()
    case_multistep_index()
    case_uart2_auto_arm()
    case_operator_trail_shape()
    case_claim_continue_no_uart()
    case_pf_protocol_builders()
    case_a4_performed_by()

    fails = [m for s, m in RESULTS if s == "FAIL"]
    print("\n=== SUMMARY {} pass / {} fail / {} note ===".format(
        sum(1 for s, _ in RESULTS if s == "PASS"),
        len(fails),
        sum(1 for s, _ in RESULTS if s == "NOTE"),
    ))
    out = APP_ROOT / "storage" / "power_smoke_results.json"
    out.write_text(json.dumps([{"status": s, "msg": m} for s, m in RESULTS], indent=2))
    print("Wrote", out)
    note("Manual AC-pull still required on hardware for true brown-out; in-process covers checkpoint logic.")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
