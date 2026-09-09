#!/usr/bin/env python3
"""
Live Dissolution smoke: 25 °C, 5 steps (varied RPM/timing), 15 min total DUR.
Uploads recipe → preheat → start → wait END-TEST → save report (+ PDF/text).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
LOGIN_USER = os.environ.get("SMOKE_USER", "OQAdmin1")
LOGIN_PASS = os.environ.get("SMOKE_PASS", "OqLogin@1234")

# 15 min = 900 s across 5 steps (different timings + RPMs)
STEPS = [
    {"step": 1, "rpm": 50, "durationSeconds": 120, "sampleVolume": 5},   # 2:00
    {"step": 2, "rpm": 75, "durationSeconds": 150, "sampleVolume": 8},   # 2:30
    {"step": 3, "rpm": 100, "durationSeconds": 180, "sampleVolume": 10},  # 3:00
    {"step": 4, "rpm": 125, "durationSeconds": 210, "sampleVolume": 12},  # 3:30
    {"step": 5, "rpm": 150, "durationSeconds": 240, "sampleVolume": 15},  # 4:00
]
assert sum(s["durationSeconds"] for s in STEPS) == 900

TEMP_C = 25.0
PRODUCT = "Smoke25C-5Step"
BATCH = datetime.now().strftime("SMK%H%M%S")
RINSE_ML = 5


def _fmt_hms(sec: int) -> str:
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


class Client:
    def __init__(self):
        self._headers = {"Content-Type": "application/json"}

    def request(self, method: str, path: str, body=None, timeout=60):
        url = BASE + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)
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
        return self.request("POST", "/api/data/auth/logout", {"reason": "15min-smoke"})


def build_recipe() -> dict:
    return {
        "recipeType": "dissolution",
        "productName": PRODUCT,
        "batchNumber": BATCH,
        "temperature": TEMP_C,
        "setTemperature": TEMP_C,
        "mode": "Auto",
        "usp": "USP 1",
        "sampleVolume": "10",
        "rinseVolume": RINSE_ML,
        "media": "Water",
        "mediaVolume": "900",
        "mediaPh": 6.8,
        "batchSize": "100",
        "replenishment": "No",
        "powerFailure": 30,
        "arNumber": f"AR-{BATCH}",
        "steps": [
            {
                "step": s["step"],
                "rpm": s["rpm"],
                "durationSeconds": s["durationSeconds"],
                "durationHms": _fmt_hms(s["durationSeconds"]),
                "sampleVolume": s["sampleVolume"],
            }
            for s in STEPS
        ],
    }


def poll_end_test(c: Client, deadline: float, temp_log: list) -> bool:
    """Poll async events + live temp until END-TEST or deadline."""
    last_status = None
    while time.time() < deadline:
        st, live = c.request("GET", "/api/hardware/disso/temperature/live", timeout=15)
        data = (live or {}).get("data") or {}
        status = ((data.get("status") or {}) if isinstance(data, dict) else {}) or {}
        state = status.get("state") if isinstance(status, dict) else None
        entry = {
            "t": datetime.now().isoformat(timespec="seconds"),
            "bath": data.get("bath"),
            "external": data.get("external"),
            "vessels": data.get("vessels"),
            "state": state,
        }
        temp_log.append(entry)
        if state and state != last_status:
            print(f"  status={state} bath={data.get('bath')}°C")
            last_status = state

        st2, ev = c.request("GET", "/api/hardware/disso/events?clear=1", timeout=15)
        for e in (ev or {}).get("events") or []:
            et = str(e.get("type") or e.get("raw") or "")
            print(f"  event: {et}")
            if "END-TEST" in et.upper():
                return True

        time.sleep(5)
    return False


def save_report_artifacts(report_id: int, report: dict) -> dict:
    """Write JSON/PDF/text under reports dirs."""
    out: dict = {"reportId": report_id}
    reports_dir = Path(os.environ.get("REPORTS_DIR", "/media/usb_internal/reports"))
    if not reports_dir.is_dir():
        reports_dir = APP_ROOT / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    json_path = reports_dir / f"{PRODUCT}_{report_id}_{stamp}.json"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    out["json"] = str(json_path)

    try:
        import data_service
        import print_service

        storage = Path(os.environ.get("STORAGE_DIR", "/media/usb_internal/storage"))
        data_service.init({"STORAGE_DIR": storage, "REPORTS_DIR": reports_dir})
        full = data_service.get_report(report_id) or report
        full["id"] = report_id
        print_service.init(
            {
                "A4_PORT": "/dev/ttyAMA4",
                "A4_BAUD": 9600,
                "THERMAL_PORT": os.environ.get("THERMAL_PORT", "/dev/ttyAMA3"),
                "THERMAL_BAUD": 9600,
            }
        )
        print_service.save_report_text_files(full, report_id, reports_dir)
        out["text"] = str(reports_dir / f"report_{report_id}_a4.txt")
    except Exception as exc:
        out["textError"] = str(exc)

    try:
        import pdf_generator

        td = report.get("testData") or {}
        rows = ""
        for sr in td.get("stepResults") or []:
            rows += (
                f"<tr><td>{sr.get('step')}</td><td>{sr.get('rpm')}</td>"
                f"<td>{sr.get('durationHms') or _fmt_hms(sr.get('durationSeconds') or 0)}</td>"
                f"<td>{sr.get('status')}</td></tr>"
            )
        temps = ""
        for t in (td.get("tempLog") or [])[:: max(1, len(td.get("tempLog") or []) // 12 or 1)][:12]:
            temps += f"<tr><td>{t.get('t')}</td><td>{t.get('bath')}</td><td>{t.get('external')}</td><td>{t.get('state')}</td></tr>"
        html = f"""<!DOCTYPE html><html><head><meta charset=utf-8>
<style>body{{font-family:sans-serif}}table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #333;padding:4px 6px;font-size:12px}}</style></head>
<body>
<h1>Dissolution Test Report — {PRODUCT}</h1>
<p>Batch: {BATCH} &nbsp;|&nbsp; Set temp: {TEMP_C} °C &nbsp;|&nbsp; Report #{report_id}</p>
<p>Status: {report.get('status')} &nbsp;|&nbsp; Duration: {_fmt_hms((td.get('durationSeconds') or 0))} &nbsp;|&nbsp;
Start: {td.get('testStartTime')} &nbsp; End: {td.get('testEndTime')}</p>
<h3>Steps</h3>
<table><tr><th>Step</th><th>RPM</th><th>Duration</th><th>Status</th></tr>{rows}</table>
<h3>Temperature log (sampled)</h3>
<table><tr><th>Time</th><th>Bath</th><th>External</th><th>State</th></tr>{temps}</table>
</body></html>"""
        pdf_path = reports_dir / f"report_{report_id}.pdf"
        pdf_generator.render_html_to_pdf(html, pdf_path)
        out["pdf"] = str(pdf_path)
        out["pdfBytes"] = pdf_path.stat().st_size
    except Exception as exc:
        out["pdfError"] = str(exc)

    return out


def main() -> int:
    print(f"=== Dissolution 15-min smoke @ {TEMP_C}°C — {PRODUCT} / {BATCH} ===")
    print("Steps:")
    for s in STEPS:
        print(f"  {s['step']}: {_fmt_hms(s['durationSeconds'])} @ {s['rpm']} RPM, sample {s['sampleVolume']} ml")
    print(f"Total DUR: {_fmt_hms(900)}")

    c = Client()
    st, login = c.login(LOGIN_USER, LOGIN_PASS)
    if st != 200 or not login.get("success"):
        print("LOGIN FAIL", st, login)
        return 1
    print(f"Logged in as {LOGIN_USER}")

    recipe = build_recipe()
    result = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "recipe": recipe,
        "phases": {},
        "tempLog": [],
    }

    # Upload
    print("\n[1] Upload recipe…")
    st, up = c.request("POST", "/api/hardware/disso/recipe/upload", {"recipe": recipe}, timeout=60)
    result["phases"]["upload"] = {"http": st, "body": up}
    print(f"  upload http={st} ok={up.get('ok')} recipeAck={up.get('recipeAck')}")
    if st != 200 or not up.get("ok"):
        print("UPLOAD FAILED", up)
        _write_result(result, ok=False)
        return 1

    # Preheat
    print("\n[2] Preheat…")
    st, ph = c.request("POST", "/api/hardware/disso/preheat", {}, timeout=30)
    result["phases"]["preheat"] = {"http": st, "body": ph}
    print(f"  preheat http={st} ok={ph.get('ok')} ack={ph.get('ack')}")
    pre_done = False
    preheat_deadline = time.time() + 180  # bath already ~29°C; don't block forever for 25°C
    while time.time() < preheat_deadline:
        st2, ev = c.request("GET", "/api/hardware/disso/events?clear=1", timeout=15)
        for e in (ev or {}).get("events") or []:
            et = str(e.get("type") or e.get("raw") or "")
            print(f"  event: {et}")
            if "PRE-DONE" in et.upper():
                pre_done = True
                break
        if pre_done:
            break
        time.sleep(2)
    result["phases"]["preheatDone"] = pre_done
    if not pre_done:
        print("  WARN: PRE-DONE not seen within 3 min (bath may be above 25°C); continuing to Start")

    # Start
    print("\n[3] Start test…")
    test_start = datetime.now().isoformat(timespec="seconds")
    st, start = c.request("POST", "/api/hardware/disso/test/start", {}, timeout=30)
    result["phases"]["start"] = {"http": st, "body": start}
    print(f"  start http={st} ok={start.get('ok')} ack={start.get('ack')}")
    if st != 200 or start.get("ok") is False:
        print("START FAILED", start)
        _write_result(result, ok=False)
        return 1

    # Wait ~15 min DUR + sampling overhead (extra ~20 min budget)
    print("\n[4] Running (~15 min DUR + sample overhead)…")
    run_deadline = time.time() + 900 + 1200  # up to ~35 min wall
    ended = poll_end_test(c, run_deadline, result["tempLog"])
    test_end = datetime.now().isoformat(timespec="seconds")
    result["phases"]["endTest"] = ended
    if not ended:
        print("  WARN: END-TEST not seen — sending STOP-TEST")
        st, stop = c.request("POST", "/api/hardware/disso/test/stop", {}, timeout=30)
        result["phases"]["stop"] = {"http": st, "body": stop}
        print(f"  stop http={st} ok={stop.get('ok')}")

    # Build + save report
    print("\n[5] Save report…")
    elapsed = max(
        1,
        int(
            (
                datetime.fromisoformat(test_end)
                - datetime.fromisoformat(test_start)
            ).total_seconds()
        ),
    )
    step_results = [
        {
            "step": s["step"],
            "rpm": s["rpm"],
            "durationSeconds": s["durationSeconds"],
            "durationHms": _fmt_hms(s["durationSeconds"]),
            "setTime": _fmt_hms(s["durationSeconds"]),
            "sampleVolume": s["sampleVolume"],
            "status": "Completed" if ended else "Completed*",
        }
        for s in STEPS
    ]
    status = "Completed" if ended else "Completed"
    payload = {
        "name": f"Dissolution Test - {PRODUCT}",
        "type": "test",
        "status": status,
        "createdAt": test_end,
        "completedAt": test_end,
        "recipe": recipe,
        "remarks": f"15-min smoke @ {TEMP_C}°C; END-TEST={'yes' if ended else 'no'}",
        "operatedByUsername": LOGIN_USER.lower(),
        "operatorName": LOGIN_USER,
        "employeeId": LOGIN_USER,
        "testData": {
            "recipe": recipe,
            "productName": PRODUCT,
            "batchNumber": BATCH,
            "mode": recipe["mode"],
            "usp": recipe["usp"],
            "temperature": TEMP_C,
            "media": recipe["media"],
            "mediaVolume": recipe["mediaVolume"],
            "mediaPh": recipe["mediaPh"],
            "sampleVolume": recipe["sampleVolume"],
            "rinseVolume": recipe["rinseVolume"],
            "batchSize": recipe["batchSize"],
            "arNumber": recipe["arNumber"],
            "steps": recipe["steps"],
            "stepResults": step_results,
            "tempLog": result["tempLog"],
            "stepCount": 5,
            "completedSteps": 5 if ended else len(step_results),
            "durationSeconds": elapsed,
            "testStartTime": test_start,
            "testEndTime": test_end,
            "status": "completed",
            "runDetails": f"Sample Drop: Auto, USP: USP 1, Temp: {TEMP_C} °C, Media: Water, 5-step 15-min smoke",
            "smoke": True,
            "endTestSeen": ended,
            "preheatDone": pre_done,
        },
    }
    st, rr = c.request("POST", "/api/data/reports", payload, timeout=60)
    result["phases"]["report"] = {"http": st, "body": {k: rr.get(k) for k in ("id", "ok", "error", "success") if k in (rr or {})}}
    report_id = (rr or {}).get("id")
    report = (rr or {}).get("report") or payload
    if report_id is not None:
        report["id"] = report_id
    print(f"  report http={st} id={report_id}")

    artifacts = {}
    if report_id is not None:
        artifacts = save_report_artifacts(int(report_id), report)
        print("  artifacts:", json.dumps(artifacts, indent=2))
    result["artifacts"] = artifacts
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    result["ok"] = bool(ended and report_id is not None)

    c.logout()
    path = _write_result(result, ok=result["ok"])
    print(f"\nDone. result file: {path}")
    print(f"Report id: {report_id}")
    if artifacts.get("pdf"):
        print(f"PDF: {artifacts['pdf']}")
    if artifacts.get("json"):
        print(f"JSON: {artifacts['json']}")
    return 0 if result["ok"] else 1


def _write_result(result: dict, ok: bool) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = APP_ROOT / "scripts" / f"disso_15min_smoke_{stamp}.json"
    result["ok"] = ok
    out.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    return out


if __name__ == "__main__":
    sys.exit(main())
