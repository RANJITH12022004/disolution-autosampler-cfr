#!/usr/bin/env python3
"""
Live primary-ESP smoke test (command ESP on /dev/serial0).
Skips temperature ESP (/dev/ttyAMA3) — not connected yet.

Verifies SIMULATE_HARDWARE is off and exercises INIT, BEEP, RPM, lift, clean,
sample-volume cal, short recipe upload/start/stop, plus app OQ (login/recipe/report/audit).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
FACTORY_USER = "RLERLT"
FACTORY_PASS = os.environ.get("FACTORY_PASS", "Rahul")
LOGIN_PASS = "OqLogin@1234"
INITIAL_PASS = "OqInit@1234"


class RunResult:
    def __init__(self):
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.warnings: list[str] = []

    def ok(self, msg: str) -> None:
        self.passed.append(msg)
        print("  OK   ", msg)

    def fail(self, msg: str) -> None:
        self.failed.append(msg)
        print("  FAIL ", msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)
        print("  WARN ", msg)


class Client:
    def __init__(self):
        self._headers = {"Content-Type": "application/json"}

    def request(self, method: str, path: str, body=None, headers=None, timeout=60, params=None):
        url = BASE + path
        if params:
            qs = "&".join(
                f"{urllib.parse.quote(str(k))}={urllib.parse.quote(str(v))}"
                for k, v in params.items()
                if v is not None
            )
            if qs:
                url += ("&" if "?" in url else "?") + qs
        data = json.dumps(body).encode("utf-8") if body is not None else None
        hdrs = dict(self._headers)
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw.decode("utf-8") or "{}") if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                body_json = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body_json = {"error": raw}
            return e.code, body_json

    def login(self, u, p):
        return self.request("POST", "/api/data/auth/login", {"username": u, "password": p})

    def logout(self):
        return self.request("POST", "/api/data/auth/logout", {"reason": "live-smoke"})


def expect(res: RunResult, ok: bool, msg: str) -> None:
    if ok:
        res.ok(msg)
    else:
        res.fail(msg)


def sample_recipe(name: str, duration_sec: int = 5) -> dict:
    return {
        "recipeType": "dissolution",
        "productName": name,
        "temperature": 37.0,
        "mode": "Auto",
        "usp": "USP 1",
        "sampleVolume": "5",
        "rinseVolume": "5",
        "media": "Water",
        "mediaVolume": "900",
        "mediaPh": 6.8,
        "batchSize": "100",
        "replenishment": "No",
        "powerFailure": 30,
        "steps": [{"step": 1, "rpm": 50, "durationSeconds": duration_sec, "sampleVolume": "5"}],
    }


def not_sim(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return True
    if payload.get("simulate") is True:
        return False
    # Nested
    for k in ("upload", "start", "hw", "state"):
        v = payload.get(k)
        if isinstance(v, dict) and v.get("simulate") is True:
            return False
    return True


def run() -> int:
    res = RunResult()
    c = Client()
    stamp = datetime.now().strftime("%H%M%S")
    print("=== LIVE primary-ESP smoke @", BASE, "===")
    print("Temp ESP: SKIPPED (not connected)")
    print()

    st, data = c.login(FACTORY_USER, FACTORY_PASS)
    expect(res, st == 200 and data.get("success"), f"factory login ({st})")
    if st != 200:
        return 1

    # --- Confirm simulation is OFF ---
    st, init_r = c.request("POST", "/api/hardware/disso/init", {})
    expect(res, st == 200 and init_r.get("ok"), f"INIT ({st} {init_r})")
    expect(res, not_sim(init_r), f"INIT not simulated (got simulate={init_r.get('simulate')})")
    if init_r.get("simulate"):
        res.fail("ABORT: still in SIMULATE_HARDWARE — fix service env and restart")
        _write(res, stamp)
        return 1

    st, beep = c.request("POST", "/api/hardware/disso/beep", {"count": 1})
    expect(res, st == 200 and beep.get("ok") is not False, f"BEEP ({st} {beep})")
    expect(res, not_sim(beep), "BEEP not simulated")

    # RPM / paddle validation path (START-PLD / STOP-PLD)
    st, rpm_on = c.request("POST", "/api/hardware/disso/rpm/start", {"rpm": 50})
    expect(res, st == 200 and rpm_on.get("ok") is not False, f"START-PLD-50 ({st} {rpm_on})")
    expect(res, not_sim(rpm_on), "PLD start not simulated")
    time.sleep(2.0)
    st, rpm_off = c.request("POST", "/api/hardware/disso/rpm/stop", {"rpm": 50})
    expect(res, st == 200 and rpm_off.get("ok") is not False, f"STOP-PLD ({st} {rpm_off})")

    # Lift (best-effort — some firmware variants)
    for action in ("up", "down"):
        st, lift = c.request("POST", f"/api/hardware/disso/lift/{action}", {})
        if st == 200 and lift.get("ok") is not False:
            res.ok(f"lift {action} ({lift.get('ack') or 'ok'})")
        else:
            res.warn(f"lift {action} skipped/failed ({st} {lift})")

    # Clean channel A small volume
    st, clean = c.request("POST", "/api/hardware/disso/clean", {"channel": "A", "volumeMl": 5})
    if st == 200 and clean.get("ok") is not False:
        res.ok(f"clean A 5mL ({clean.get('ack') or 'ok'})")
        expect(res, not_sim(clean), "clean not simulated")
    else:
        res.warn(f"clean failed ({st} {clean})")

    # Sample volume cal (cmd ESP) — start + value
    st, sv1 = c.request("POST", "/api/hardware/disso/cal/sample-volume", {"phase": "start"})
    expect(res, st == 200 and sv1.get("ok") is not False, f"SV cal start ({st} {sv1})")
    expect(res, not_sim(sv1), "SV cal not simulated")
    st, sv2 = c.request("POST", "/api/hardware/disso/cal/sample-volume", {"value": 5.0})
    if st == 200 and sv2.get("ok") is not False:
        res.ok(f"SV cal value ({sv2.get('ack') or 'ok'})")
    else:
        res.warn(f"SV cal value ({st} {sv2})")

    # Temp ESP intentionally skipped — expect live may be empty/fail without failing whole smoke
    st, live = c.request("GET", "/api/hardware/disso/temperature/live")
    if st == 200 and live.get("ok") is not False and (live.get("bath") is not None or live.get("external") is not None):
        res.warn(f"temp live unexpectedly present (temp ESP said not connected): {live}")
    else:
        res.ok(f"temp ESP skipped/absent as expected ({st})")

    st, cal_bt = c.request("POST", "/api/hardware/disso/cal/temp", {"target": "BT", "value": 37.0})
    if st == 200 and cal_bt.get("ok") and not_sim(cal_bt):
        res.warn(f"temp cal BT responded (temp ESP may be on cmd channel): {cal_bt}")
    else:
        res.ok(f"temp cal skipped/failed without temp ESP ({st})")

    # Short live test via disso_test_service
    quick = sample_recipe(f"LIVE-Quick-{stamp}", duration_sec=5)
    st, tr = c.request(
        "POST",
        "/api/disso/test/start",
        {"recipe": quick, "arNumber": f"LAR-{stamp}", "batchNumber": f"LB-{stamp}"},
    )
    expect(res, st == 200 and tr.get("ok"), f"live quick test start ({st} {tr.get('error') if isinstance(tr, dict) else tr})")
    expect(res, not_sim(tr), "quick test not simulated")
    time.sleep(2.0)
    st, stt = c.request("GET", "/api/disso/test/state")
    expect(res, st == 200, f"test state ({st})")
    active = (stt.get("state") or stt).get("active") if isinstance(stt, dict) else None
    if active is not None:
        res.ok(f"test active={active}")
    st, ab = c.request("POST", "/api/disso/test/abort", {})
    if st >= 400:
        st, ab = c.request("POST", "/api/disso/test/claim-abort", {})
    expect(res, st == 200 and (ab.get("ok") is not False), f"abort live test ({st})")

    # Direct recipe upload + start/stop on cmd ESP
    st, up = c.request("POST", "/api/hardware/disso/recipe/upload", {"recipe": sample_recipe(f"LIVE-Up-{stamp}", 4)})
    expect(res, st == 200 and up.get("ok") is not False, f"recipe upload ({st} {up.get('error') if isinstance(up, dict) else up})")
    expect(res, not_sim(up), "recipe upload not simulated")
    st, start = c.request("POST", "/api/hardware/disso/test/start", {})
    expect(res, st == 200 and start.get("ok") is not False, f"ESP START-TEST ({st} {start})")
    time.sleep(1.5)
    st, pause = c.request("POST", "/api/hardware/disso/test/pause", {})
    if st == 200 and pause.get("ok") is not False:
        res.ok(f"ESP PAUSE ({pause.get('ack') or 'ok'})")
    else:
        res.warn(f"ESP PAUSE ({st} {pause})")
    st, stop = c.request("POST", "/api/hardware/disso/test/stop", {})
    expect(res, st == 200 and stop.get("ok") is not False, f"ESP STOP-TEST ({st} {stop})")

    # Stream / status / events
    st, stream = c.request("GET", "/api/hardware/disso/stream")
    expect(res, st == 200, f"disso stream ({st})")
    st, events = c.request("GET", "/api/hardware/disso/events")
    expect(res, st == 200, f"disso events ({st})")
    st, hstat = c.request("GET", "/api/hardware/status")
    expect(res, st == 200, f"hardware status ({st})")

    # Soft OQ: recipe create (factory auto-approve), report, audit
    st, fr = c.request("POST", "/api/data/recipes", sample_recipe(f"LIVE-Factory-{stamp}", 4))
    expect(res, st in (200, 201), f"create recipe ({st})")
    recipe_id = fr.get("id")

    report = {
        "type": "test",
        "name": f"LIVE-Rpt-{stamp}",
        "status": "completed",
        "result": "PASS",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "recipe": {"productName": "Quick Test", "id": recipe_id},
        "testData": {"productName": "Quick Test", "oqLive": True, "durationSeconds": 5},
    }
    st, rr = c.request("POST", "/api/data/reports", report)
    expect(res, st in (200, 201), f"save test report ({st})")

    for action, details in (
        ("Entered screen", "Live smoke Home"),
        ("Test started", "Live primary ESP smoke"),
        ("Test finished", "Live primary ESP smoke"),
    ):
        st, ev = c.request(
            "POST",
            "/api/data/audit-log/event",
            {"action": action, "details": details, "eventType": "lifecycle"},
        )
        expect(res, st == 200, f"audit {action}")

    st, aud = c.request("GET", "/api/data/audit-log", params={"log_view": "1"})
    entries = (aud or {}).get("entries") or []
    expect(res, st == 200 and len(entries) > 0, f"audit list ({len(entries)})")
    actions = {str(e.get("action") or "") for e in entries}
    expect(res, "Test started" in actions, "audit has Test started")

    st, listing = c.request("GET", "/api/data/reports", params={"filter": "all"})
    expect(res, st == 200 and len((listing or {}).get("reports") or []) >= 1, "list reports")

    st, sinfo = c.request("GET", "/api/system/info")
    expect(res, st == 200 and "error" not in (sinfo or {}), f"system info ({st})")
    # system info may show simulate flags — note them
    if isinstance(sinfo, dict):
        sim_bits = {k: sinfo.get(k) for k in sinfo if "sim" in k.lower()}
        if sim_bits:
            res.warn(f"system info sim fields: {sim_bits}")

    c.logout()
    c.login(FACTORY_USER, FACTORY_PASS)

    print("\n=== SUMMARY ===")
    print(f"passed: {len(res.passed)}  failed: {len(res.failed)}  warnings: {len(res.warnings)}")
    for m in res.failed:
        print("  FAIL:", m)
    for m in res.warnings:
        print("  WARN:", m)
    _write(res, stamp)
    return 1 if res.failed else 0


def _write(res: RunResult, stamp: str) -> None:
    out = APP_ROOT / "scripts" / f"live_esp_smoke_result_{stamp}.json"
    out.write_text(json.dumps({"passed": res.passed, "failed": res.failed, "warnings": res.warnings}, indent=2))
    print("wrote", out)


if __name__ == "__main__":
    sys.exit(run())
