#!/usr/bin/env python3
"""
Operation Qualification (OQ) smoke test for Dissolution kiosk.

Exercises factory settings (incl. maxQa), members with 1/2/3 permission cards,
recipe create → approve → disable → enable, hardware sim init/RPM/cal,
quick test + recipe test, profile/password edits.

Uses the same HTTP API the UI uses (file-backed session).
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

INITIAL_PASS = "OqInit@1234"
LOGIN_PASS = "OqLogin@1234"
CHANGED_PASS = "OqChanged@99"

PERM_1 = ["perm_test_access"]
PERM_2 = ["perm_test_access", "perm_recipe_manage"]
PERM_3 = ["perm_test_access", "perm_recipe_manage", "perm_recipe_approve"]
PERM_ADMIN_FULL = [
    "perm_test_access",
    "perm_test_report_approve",
    "perm_recipe_manage",
    "perm_recipe_approve",
    "perm_profile_admin",
    "perm_validation_test",
    "perm_validation_report_approve",
    "perm_calibration_access",
    "perm_calibration_report_approve",
    "perm_reports_view",
    "perm_audit_view",
]
PERM_APPROVER = ["perm_recipe_approve", "perm_test_report_approve", "perm_reports_view"]
PERM_OPERATOR = [
    "perm_test_access",
    "perm_recipe_manage",
    "perm_validation_test",
    "perm_calibration_access",
    "perm_reports_view",
    "perm_audit_view",
]

# UI lifecycle actions mirrored for audit coverage (same labels as script.js)
UI_AUDIT_EVENTS = [
    ("Entered screen", "Home", "navigation"),
    ("Opened Quick Test", "Quick Test screen opened", "navigation"),
    ("Entered screen", "Quick Test", "navigation"),
    ("Quick test started", "Quick Test, USP 1, 1 step(s)", "lifecycle"),
    ("Entered screen", "Test Run", "navigation"),
    ("Test started", "Quick Test, USP 1, 1 step(s)", "lifecycle"),
    ("Test finished", "Test run completed, 1 step(s) recorded", "lifecycle"),
    ("Exited screen", "Test Run", "navigation"),
    ("Opened Load Recipe", "Load Recipe list opened", "navigation"),
    ("Loaded recipe", "Recipe loaded for test", "lifecycle"),
    ("Validation started", "Combined validation suite", "lifecycle"),
    ("Validation finished", "Combined validation suite completed", "lifecycle"),
    ("Entered USP 1 validation", "RPM validation", "navigation"),
    ("Calibration started", "Temperature calibration", "lifecycle"),
    ("Calibration finished", "Temperature calibration completed", "lifecycle"),
    ("Audit log viewed", "Audit log viewed in UI", "navigation"),
]


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

    def login(self, username: str, password: str):
        return self.request("POST", "/api/data/auth/login", {"username": username, "password": password})

    def logout(self):
        return self.request("POST", "/api/data/auth/logout", {"reason": "oq-smoke"})

    def mandatory_reset(self, username: str, old_password: str, new_password: str):
        return self.request(
            "POST",
            "/api/data/auth/mandatory-password-reset",
            {"username": username, "oldPassword": old_password, "newPassword": new_password},
        )


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
        "steps": [
            {"step": 1, "rpm": 50, "durationSeconds": duration_sec, "sampleVolume": "5"},
        ],
    }


def expect(res: RunResult, ok: bool, msg: str) -> None:
    if ok:
        res.ok(msg)
    else:
        res.fail(msg)


def activate_member(c: Client, res: RunResult, username: str, member_id: int | None = None) -> str:
    """Complete mandatory first password change; return usable password."""
    for candidate in (LOGIN_PASS, CHANGED_PASS, INITIAL_PASS):
        st2, data2 = c.login(username, candidate)
        if st2 == 200 and data2.get("success"):
            res.warn(f"{username}: already active")
            c.logout()
            return candidate
        if st2 == 403 and "locked" in str((data2 or {}).get("error") or "").lower():
            # Unlock as factory then continue
            c.login(FACTORY_USER, FACTORY_PASS)
            if member_id:
                c.request("POST", f"/api/data/members/{member_id}/unlock", {})
            # Also reset password via factory PUT
            if member_id:
                c.request(
                    "PUT",
                    f"/api/data/members/{member_id}",
                    {
                        "id": member_id,
                        "username": username,
                        "name": username,
                        "role": "user",
                        "password": INITIAL_PASS,
                        "status": "active",
                        "featureOverrides": {"allow": list(PERM_OPERATOR), "deny": []},
                    },
                )
            c.logout()
            st, data = c.mandatory_reset(username, INITIAL_PASS, LOGIN_PASS)
            if st == 200 and data.get("ok"):
                res.ok(f"unlocked + password reset: {username}")
                return LOGIN_PASS
            res.fail(f"unlock flow {username}: {data}")
            return LOGIN_PASS
        if st2 == 403 and (data2 or {}).get("passwordChangeRequired"):
            break
    st, data = c.mandatory_reset(username, INITIAL_PASS, LOGIN_PASS)
    if st == 200 and data.get("ok"):
        res.ok(f"mandatory password reset: {username}")
        return LOGIN_PASS
    for old in (CHANGED_PASS, LOGIN_PASS):
        st, data = c.mandatory_reset(username, old, LOGIN_PASS)
        if st == 200 and data.get("ok"):
            res.ok(f"mandatory password reset: {username}")
            return LOGIN_PASS
    st2, data2 = c.login(username, CHANGED_PASS)
    if st2 == 200 and data2.get("success"):
        res.warn(f"{username}: login with CHANGED_PASS")
        c.logout()
        return CHANGED_PASS
    res.fail(f"activate {username}: reset={data} login={data2}")
    return LOGIN_PASS


def create_member(c: Client, res: RunResult, *, username: str, name: str, role: str, allow: list) -> int | None:
    payload = {
        "username": username,
        "name": name,
        "role": role,
        "password": INITIAL_PASS,
        "featureOverrides": {"allow": list(allow), "deny": []},
        "status": "active",
    }
    st, data = c.request("POST", "/api/data/members", payload)
    if st in (200, 201) and data.get("id"):
        res.ok(f"create {role} {username} ({len(allow)} perm card(s)) id={data['id']}")
        return int(data["id"])
    # Idempotent: if exists, find id
    err = str((data or {}).get("error") or "")
    if "already uses" in err.lower() or st == 400:
        st2, listing = c.request("GET", "/api/data/members")
        members = (listing or {}).get("members") or listing if isinstance(listing, list) else (listing or {}).get("members") or []
        if isinstance(listing, dict) and "members" not in listing and isinstance(listing.get("data"), list):
            members = listing["data"]
        st2, listing = c.request("GET", "/api/data/members")
        body = listing if isinstance(listing, dict) else {}
        members = body.get("members") or body.get("data") or []
        for m in members:
            if str(m.get("username", "")).strip().lower() == username.lower():
                mid = int(m["id"])
                # Update permissions
                m2 = dict(m)
                m2["featureOverrides"] = {"allow": list(allow), "deny": []}
                m2["role"] = role
                m2["name"] = name
                if "password" in m2:
                    del m2["password"]
                st3, _ = c.request("PUT", f"/api/data/members/{mid}", m2)
                res.warn(f"reuse existing member {username} id={mid} (update HTTP {st3})")
                return mid
        res.fail(f"create {username}: {st} {data}")
        return None
    res.fail(f"create {username}: {st} {data}")
    return None


def approval_token(c: Client, username: str, password: str, purpose: str = "recipe") -> str | None:
    st, data = c.request(
        "POST",
        "/api/data/auth/approval-verify",
        {"method": "credentials", "purpose": purpose, "username": username, "password": password},
    )
    if st == 200 and data.get("token"):
        return data["token"]
    if st == 200 and data.get("ok") and data.get("verifyToken"):
        return data["verifyToken"]
    # Some builds return token under different key
    for k in ("token", "verifyToken", "approvalToken"):
        if data.get(k):
            return data[k]
    print("    approval-verify failed:", st, data)
    return None


def run() -> int:
    res = RunResult()
    c = Client()
    stamp = datetime.now().strftime("%H%M%S")
    print("=== OQ smoke @", BASE, "===")

    # --- Factory login + settings ---
    st, data = c.login(FACTORY_USER, FACTORY_PASS)
    expect(res, st == 200 and data.get("success"), f"factory login ({st})")
    if st != 200:
        print(json.dumps(res.__dict__, indent=2))
        return 1

    # Ensure any active test left over from previous runs is aborted
    c.request("POST", "/api/disso/test/abort")

    st, fs = c.request("GET", "/api/data/factory-settings")
    settings = (fs or {}).get("settings") or fs or {}
    settings = dict(settings)
    settings.update(
        {
            "companyName": settings.get("companyName") or "MSN",
            "companyLocation": settings.get("companyLocation") or "G Block",
            "maxUsers": 50,
            "maxAdmins": 50,
            "maxSupervisors": 50,
            "maxQa": 10,
            "maxRecipes": 150,
            "passwordResetPeriodDays": 365,
            "autoLogoutMinutes": 0,
        }
    )
    st, saved = c.request("POST", "/api/data/factory-settings", settings)
    expect(res, st == 200, f"save factory settings with maxQa={settings['maxQa']} ({st})")
    st, fs2 = c.request("GET", "/api/data/factory-settings")
    got = (fs2 or {}).get("settings") or fs2 or {}
    expect(res, int(got.get("maxQa") or 0) == 10, f"maxQa persisted = {got.get('maxQa')}")

    # Hardware simulate probe
    st, init_r = c.request("POST", "/api/hardware/disso/init", {})
    expect(res, st == 200 and (init_r.get("ok") is not False), f"ESP init simulate ({st} {init_r})")
    st, beep = c.request("POST", "/api/hardware/disso/beep", {"count": 1})
    expect(res, st == 200, f"ESP beep ({st})")

    members_spec = [
        ("OQAdmin1", "OQ Admin One", "admin", PERM_1),
        ("OQAdmin2", "OQ Admin Two", "admin", PERM_2),
        ("OQAdmin3", "OQ Admin Three", "admin", PERM_3),
        ("OQAdminFull", "OQ Admin Full", "admin", PERM_ADMIN_FULL),
        ("OQUser1", "OQ User One", "user", PERM_1),
        ("OQUser2", "OQ User Two", "user", PERM_2),
        ("OQUser3", "OQ User Three", "user", PERM_3),
        ("OQRev1", "OQ Reviewer One", "supervisor", PERM_1),
        ("OQRev2", "OQ Reviewer Two", "supervisor", PERM_2),
        ("OQRev3", "OQ Reviewer Three", "supervisor", PERM_APPROVER),
        ("OQQa1", "OQ QA One", "qa", PERM_1),
        ("OQQa2", "OQ QA Two", "qa", PERM_2),
        ("OQQa3", "OQ QA Three", "qa", PERM_APPROVER),
        ("OQOp", "OQ Operator", "user", PERM_OPERATOR),
    ]
    ids: dict[str, int] = {}
    for uname, name, role, allow in members_spec:
        mid = create_member(c, res, username=uname, name=name, role=role, allow=allow)
        if mid:
            ids[uname] = mid

    c.logout()

    # Activate all created members
    passwords: dict[str, str] = {}
    for uname, *_ in members_spec:
        if uname in ids:
            passwords[uname] = activate_member(c, res, uname, ids.get(uname))

    # --- Recipe create (pending) as operator, approve as reviewer ---
    op_user = "OQOp"
    appr_user = "OQRev3"
    st, _ = c.login(op_user, passwords.get(op_user, LOGIN_PASS))
    expect(res, st == 200, f"login operator {op_user}")
    rname = f"OQ-Recipe-{stamp}"
    st, rdata = c.request("POST", "/api/data/recipes", sample_recipe(rname, duration_sec=5))
    expect(res, st in (200, 201) and rdata.get("id"), f"create recipe pending ({st})")
    recipe_id = rdata.get("id")
    recipe_obj = rdata.get("recipe") or {}
    status = recipe_obj.get("recipeApprovalStatus")
    expect(res, status == "pending", f"recipe approval status pending (got {status})")
    c.logout()

    # Approve
    st, _ = c.login(appr_user, passwords.get(appr_user, LOGIN_PASS))
    expect(res, st == 200, f"login approver {appr_user}")
    token = approval_token(c, appr_user, passwords.get(appr_user, LOGIN_PASS), "recipe")
    expect(res, bool(token), "issue recipe approval verify token")
    if token and recipe_id:
        st, adata = c.request(
            "POST",
            f"/api/data/recipes/{recipe_id}/approve",
            {"remarks": "OQ smoke approve"},
            headers={"X-Approval-Verify-Token": token},
        )
        expect(res, st == 200 and (adata.get("ok") or (adata.get("recipe") or {}).get("recipeApprovalStatus") == "approved"), f"approve recipe ({st})")
    c.logout()

    # Factory also creates auto-approved recipe
    st, _ = c.login(FACTORY_USER, FACTORY_PASS)
    st, fr = c.request("POST", "/api/data/recipes", sample_recipe(f"OQ-Factory-{stamp}", duration_sec=4))
    expect(res, st in (200, 201), f"factory auto-approved recipe ({st})")
    factory_recipe_id = fr.get("id")
    factory_status = (fr.get("recipe") or {}).get("recipeApprovalStatus")
    expect(res, factory_status == "approved", f"factory recipe approved (got {factory_status})")

    # Disable / enable (enable re-POSTs snapshot)
    disable_id = factory_recipe_id or recipe_id
    snapshot = None
    if disable_id:
        st, got = c.request("GET", f"/api/data/recipes/{disable_id}")
        snapshot = (got or {}).get("recipe")
        st, _ = c.request("DELETE", f"/api/data/recipes/{disable_id}")
        expect(res, st == 200, f"disable recipe id={disable_id}")
        st, listing = c.request("GET", "/api/data/recipes")
        recipes = (listing or {}).get("recipes") or []
        still = any(int(r.get("id") or 0) == int(disable_id) for r in recipes)
        expect(res, not still, "disabled recipe removed from active list")
        if snapshot:
            payload = dict(snapshot)
            payload.pop("id", None)
            payload["productName"] = (snapshot.get("productName") or "OQ") + "-ReEnabled"
            st, en = c.request("POST", "/api/data/recipes", payload)
            expect(res, st in (200, 201), f"enable/recreate recipe ({st})")
            disable_id = en.get("id")

    # Validation / calibration reports + hardware cal
    st, _ = c.request("POST", "/api/hardware/disso/rpm/start", {"rpm": 50})
    expect(res, st == 200, f"RPM validation start ({st})")
    time.sleep(0.5)
    st, _ = c.request("POST", "/api/hardware/disso/rpm/stop", {"rpm": 50})
    expect(res, st == 200, f"RPM validation stop ({st})")

    st, cal_bt = c.request("POST", "/api/hardware/disso/cal/temp", {"target": "BT", "value": 37.0})
    expect(res, st == 200 and cal_bt.get("ok") is not False, f"temp cal BT ({st} {cal_bt})")
    st, cal_ext = c.request("POST", "/api/hardware/disso/cal/temp", {"target": "EXT", "value": 37.0})
    expect(res, st == 200 and cal_ext.get("ok") is not False, f"temp cal EXT ({st} {cal_ext})")
    st, sv = c.request("POST", "/api/hardware/disso/cal/sample-volume", {"phase": "start"})
    expect(res, st == 200, f"sample volume cal start ({st})")
    st, sv2 = c.request("POST", "/api/hardware/disso/cal/sample-volume", {"value": 5.0})
    expect(res, st == 200, f"sample volume cal value ({st})")

    # Persist validation + calibration reports (as UI would)
    for rtype, name in (("validation", f"OQ-Val-{stamp}"), ("calibration", f"OQ-Cal-{stamp}")):
        report = {
            "type": rtype,
            "name": name,
            "status": "completed",
            "result": "PASS",
            "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "testData": {"suite": ["rpm", "physical", "sample-volume", "temperature"], "oq": True},
        }
        st, rr = c.request("POST", "/api/data/reports", report)
        expect(res, st in (200, 201), f"save {rtype} report ({st})")

    c.logout()

    # --- Quick test + recipe test (short) ---
    st, _ = c.login(op_user, passwords.get(op_user, LOGIN_PASS))
    expect(res, st == 200, "login operator for tests")
    c.request("POST", "/api/disso/test/abort", {})
    quick = sample_recipe(f"OQ-Quick-{stamp}", duration_sec=3)
    st, tr = c.request(
        "POST",
        "/api/disso/test/start",
        {"recipe": quick, "arNumber": f"AR-{stamp}", "batchNumber": f"B-{stamp}"},
    )
    expect(res, st == 200 and tr.get("ok"), f"quick test start ({st} {tr.get('error') if isinstance(tr, dict) else tr})")
    time.sleep(1.5)
    st, stt = c.request("GET", "/api/disso/test/state")
    expect(res, st == 200, f"test state ({st})")
    st, ab = c.request("POST", "/api/disso/test/abort", {})
    # claim-abort alias
    if st >= 400:
        st, ab = c.request("POST", "/api/disso/test/claim-abort", {})
    expect(res, st == 200 and (ab.get("ok") is not False), f"abort quick test ({st})")

    # Recipe test if we have an approved recipe id
    use_id = disable_id or recipe_id
    if use_id:
        st, gr = c.request("GET", f"/api/data/recipes/{use_id}")
        recipe = (gr or {}).get("recipe")
        if recipe:
            # Ensure short duration for smoke
            for step in recipe.get("steps") or []:
                step["durationSeconds"] = 3
            st, tr2 = c.request(
                "POST",
                "/api/disso/test/start",
                {"recipe": recipe, "arNumber": f"AR2-{stamp}", "batchNumber": f"B2-{stamp}"},
            )
            expect(res, st == 200 and tr2.get("ok"), f"recipe test start ({st})")
            time.sleep(1.0)
            st, ab2 = c.request("POST", "/api/disso/test/abort", {})
            if st >= 400:
                st, ab2 = c.request("POST", "/api/disso/test/claim-abort", {})
            expect(res, st == 200, f"abort recipe test ({st})")

    # --- Profile / password edit ---
    mid = ids.get(op_user)
    if mid:
        st, mem = c.request("GET", f"/api/data/members/{mid}")
        member = (mem or {}).get("member") or {}
        member = dict(member)
        member["id"] = mid
        member["username"] = op_user
        member["name"] = "OQ Operator Edited"
        member["password"] = CHANGED_PASS
        c.logout()
        c.login(FACTORY_USER, FACTORY_PASS)
        st, upd = c.request("PUT", f"/api/data/members/{mid}", member)
        expect(res, st == 200, f"edit profile/password ({st} {upd if st >= 400 else ''})")
        c.logout()
        # After admin password set, mustChangePassword is required
        st, reset = c.mandatory_reset(op_user, CHANGED_PASS, LOGIN_PASS)
        if st == 200:
            res.ok("re-activate after admin password edit")
            passwords[op_user] = LOGIN_PASS
        else:
            st2, _ = c.login(op_user, CHANGED_PASS)
            if st2 == 200:
                res.ok("login with changed password")
                passwords[op_user] = CHANGED_PASS
                c.logout()
            else:
                st3, _ = c.login(op_user, LOGIN_PASS)
                expect(res, st3 == 200, f"login after profile edit ({st3})")
                c.logout()

    # Permission spot-check: User with 1 perm cannot create recipes
    st, _ = c.login("OQUser1", passwords.get("OQUser1", LOGIN_PASS))
    st, denied = c.request("POST", "/api/data/recipes", sample_recipe(f"ShouldFail-{stamp}"))
    expect(res, st in (401, 403), f"user with 1 perm denied recipe create ({st})")
    c.logout()

    # --- Recurring password reset cycle ---
    c.login(FACTORY_USER, FACTORY_PASS)
    st, fs = c.request("GET", "/api/data/factory-settings")
    settings = (fs or {}).get("settings") or (fs if isinstance(fs, dict) else {}) or {}
    settings = dict(settings)
    settings["passwordResetPeriodDays"] = 1
    if not settings.get("installationDate"):
        settings["installationDate"] = "2020-01-01"
    st, _ = c.request("PUT", "/api/data/factory-settings", settings)
    expect(res, st == 200, f"set passwordResetPeriodDays=1 ({st})")
    # Force OQOp passwordLastChangedAt far in the past via factory member update
    mid = ids.get(op_user)
    if mid:
        st, mem = c.request("GET", f"/api/data/members/{mid}")
        member = dict((mem or {}).get("member") or {})
        member["id"] = mid
        member["username"] = op_user
        member["passwordLastChangedAt"] = "2020-01-02T00:00:00"
        member["mustChangePassword"] = False
        # Keep a known password without triggering mandatory-only path if possible
        st, _ = c.request("PUT", f"/api/data/members/{mid}", member)
        expect(res, st == 200, f"backdate passwordLastChangedAt ({st})")
        c.logout()
        st, login_exp = c.login(op_user, passwords.get(op_user, LOGIN_PASS))
        expired = st == 403 and bool((login_exp or {}).get("passwordExpired") or (login_exp or {}).get("passwordChangeRequired"))
        # Some builds use passwordExpired key
        if not expired and st == 403:
            expired = "expired" in str(login_exp).lower() or "password" in str(login_exp).lower()
        expect(res, expired or st == 403, f"login blocked by password cycle ({st})")
        if st == 403:
            st, reset = c.request(
                "POST",
                "/api/data/auth/password-expired-reset",
                {
                    "username": op_user,
                    "oldPassword": passwords.get(op_user, LOGIN_PASS),
                    "newPassword": CHANGED_PASS,
                },
            )
            if st != 200:
                st, reset = c.mandatory_reset(op_user, passwords.get(op_user, LOGIN_PASS), CHANGED_PASS)
            expect(res, st == 200, f"password cycle reset ({st})")
            passwords[op_user] = CHANGED_PASS
            st, _ = c.login(op_user, CHANGED_PASS)
            expect(res, st == 200, f"login after cycle reset ({st})")
            c.logout()
            # Second cycle: backdate again and expect another expiry
            c.login(FACTORY_USER, FACTORY_PASS)
            st, mem = c.request("GET", f"/api/data/members/{mid}")
            member = dict((mem or {}).get("member") or {})
            member["id"] = mid
            member["username"] = op_user
            member["passwordLastChangedAt"] = "2020-06-01T00:00:00"
            member["mustChangePassword"] = False
            c.request("PUT", f"/api/data/members/{mid}", member)
            c.logout()
            st, login_exp2 = c.login(op_user, CHANGED_PASS)
            expect(res, st == 403, f"second password cycle expiry ({st})")
            if st == 403:
                st, reset2 = c.request(
                    "POST",
                    "/api/data/auth/password-expired-reset",
                    {
                        "username": op_user,
                        "oldPassword": CHANGED_PASS,
                        "newPassword": LOGIN_PASS,
                    },
                )
                if st != 200:
                    st, reset2 = c.mandatory_reset(op_user, CHANGED_PASS, LOGIN_PASS)
                expect(res, st == 200, f"second cycle reset ({st})")
                passwords[op_user] = LOGIN_PASS
        # Restore longer period
        c.login(FACTORY_USER, FACTORY_PASS)
        settings["passwordResetPeriodDays"] = 365
        c.request("PUT", "/api/data/factory-settings", settings)
        c.logout()

    # QA with approver perms can verify recipe
    st, _ = c.login("OQQa3", passwords.get("OQQa3", LOGIN_PASS))
    tok = approval_token(c, "OQQa3", passwords.get("OQQa3", LOGIN_PASS), "recipe")
    expect(res, bool(tok), "QA with recipe-approve can get verify token")
    c.logout()

    # ========== FULL: reports, audits, exports, system ==========
    print("\n--- Reports / Audits / Exports ---")
    audit_since_ms = int(time.time() * 1000) - 2000

    st, _ = c.login(op_user, passwords.get(op_user, LOGIN_PASS))
    expect(res, st == 200, "login operator for reports/audits")

    # Client audit events (UI navigation / lifecycle)
    for action, details, etype in UI_AUDIT_EVENTS:
        st, ev = c.request(
            "POST",
            "/api/data/audit-log/event",
            {"action": action, "details": details, "eventType": etype, "outcome": "success"},
        )
        expect(res, st == 200 and ev.get("ok") is not False, f"audit event: {action}")

    # Test report (pending approval) — Quick Test naming triggers Quick test performed audit
    test_report = {
        "type": "test",
        "name": f"OQ-TestRpt-{stamp}",
        "status": "completed",
        "result": "PASS",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "recipe": {"productName": "Quick Test", "usp": "USP 1", "mode": "Auto"},
        "testData": {
            "productName": "Quick Test",
            "arNumber": f"AR-{stamp}",
            "batchNumber": f"B-{stamp}",
            "durationSeconds": 3,
            "steps": [{"step": 1, "rpm": 50, "durationSeconds": 3}],
            "oq": True,
        },
    }
    st, trpt = c.request("POST", "/api/data/reports", test_report)
    expect(res, st in (200, 201) and trpt.get("id"), f"create pending test report ({st})")
    test_report_id = trpt.get("id")
    expect(
        res,
        (trpt.get("report") or {}).get("reportApprovalStatus") == "pending",
        "test report pending approval",
    )

    # Validation report pending
    val_report = {
        "type": "validation",
        "name": f"OQ-ValRpt-{stamp}",
        "status": "completed",
        "result": "PASS",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "testData": {
            "suite": ["rpm", "physical", "sample-volume", "temperature"],
            "oq": True,
            "channels": [{"label": "Bath", "pass": True}],
        },
    }
    st, vrpt = c.request("POST", "/api/data/reports", val_report)
    expect(res, st in (200, 201) and vrpt.get("id"), f"create pending validation report ({st})")
    val_report_id = vrpt.get("id")

    # Calibration report
    cal_report = {
        "type": "calibration",
        "name": f"OQ-CalRpt-{stamp}",
        "status": "completed",
        "result": "PASS",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "testData": {"measured": 37.0, "targets": ["BT", "EXT"], "oq": True},
    }
    st, crpt = c.request("POST", "/api/data/reports", cal_report)
    expect(res, st in (200, 201) and crpt.get("id"), f"create calibration report ({st})")
    cal_report_id = crpt.get("id")

    # List / filter reports
    for filt in ("all", "test", "validation", "calibration"):
        st, listing = c.request("GET", "/api/data/reports", params={"filter": filt})
        reports = (listing or {}).get("reports") or []
        expect(res, st == 200, f"list reports filter={filt} count={len(reports)} ({st})")

    if test_report_id:
        st, one = c.request("GET", f"/api/data/reports/{test_report_id}")
        expect(res, st == 200 and (one.get("report") or one).get("id"), f"get report {test_report_id}")

    c.logout()

    # Approve test report as reviewer (not operator)
    st, _ = c.login(appr_user, passwords.get(appr_user, LOGIN_PASS))
    expect(res, st == 200, "login reviewer for report approve")
    if test_report_id:
        token = approval_token(c, appr_user, passwords.get(appr_user, LOGIN_PASS), "report")
        expect(res, bool(token), "issue report approval verify token")
        if token:
            st, appr = c.request(
                "POST",
                f"/api/data/reports/{test_report_id}/approve",
                {"passFail": "PASS", "remarks": "Full smoke approve"},
                headers={"X-Approval-Verify-Token": token},
            )
            expect(
                res,
                st == 200 and (appr.get("ok") or (appr.get("report") or {}).get("reportApprovalStatus") == "approved"),
                f"approve test report ({st})",
            )
    # Factory can approve validation without token
    c.logout()
    st, _ = c.login(FACTORY_USER, FACTORY_PASS)
    if val_report_id:
        st, vap = c.request(
            "POST",
            f"/api/data/reports/{val_report_id}/approve",
            {"passFail": "PASS", "remarks": "Factory OQ approve validation"},
        )
        expect(res, st == 200 and vap.get("ok") is not False, f"factory approve validation report ({st})")

    # Log in as operator OQOp for audit log viewing so event is not suppressed by factory filter
    c.login("OQOp", CHANGED_PASS)
    st, aud = c.request("GET", "/api/data/audit-log", params={"log_view": "1"})
    entries = (aud or {}).get("entries") or []
    expect(res, st == 200 and isinstance(entries, list), f"audit log list ({st}, {len(entries)} entries)")
    time.sleep(0.3)
    st, aud_refresh = c.request("GET", "/api/data/audit-log")
    if st == 200:
        entries = (aud_refresh or {}).get("entries") or entries
    actions = {str(e.get("action") or "").strip() for e in entries}
    for need in (
        "Login",
        "Recipe created",
        "Recipe approved",
        "Quick test started",
        "Test started",
        "Test finished",
        "Validation started",
        "Validation finished",
        "Audit log viewed",
    ):
        expect(res, need in actions, f"audit contains '{need}'")

    # Recent-window sanity: at least some events after audit_since_ms
    recent = [e for e in entries if int(e.get("timestamp") or 0) >= audit_since_ms]
    expect(res, len(recent) >= 5, f"recent audit events >= 5 (got {len(recent)})")

    # Filter by action
    st, aud2 = c.request("GET", "/api/data/audit-log", params={"action": "Login"})
    login_entries = (aud2 or {}).get("entries") or []
    expect(res, st == 200 and len(login_entries) >= 1, f"audit filter action=Login ({len(login_entries)})")

    # Export staging
    st, astage = c.request("POST", "/api/audit/export/stage", {"filters": {}})
    expect(
        res,
        st == 200 and astage.get("success") and astage.get("batchId"),
        f"audit export stage ({st} {astage.get('error') or astage.get('batchId')})",
    )
    report_ids = [i for i in (test_report_id, val_report_id, cal_report_id) if i]
    if report_ids:
        st, rstage = c.request("POST", "/api/reports/export/stage", {"report_ids": report_ids})
        expect(
            res,
            st == 200 and rstage.get("success") and rstage.get("batchId"),
            f"reports export stage ({st} {rstage.get('error') or rstage.get('batchId')})",
        )

    # System info + print status (smoke)
    st, sinfo = c.request("GET", "/api/system/info")
    expect(res, st == 200 and isinstance(sinfo, dict) and "error" not in sinfo, f"system info ({st})")
    st, pstat = c.request("GET", "/api/print/status")
    expect(res, st == 200, f"print status ({st})")

    # Hardware stream/status briefly
    st, hstat = c.request("GET", "/api/hardware/status")
    expect(res, st in (200, 403), f"hardware status ({st})")
    st, live = c.request("GET", "/api/hardware/disso/temperature/live")
    expect(res, st == 200, f"temp live ({st})")

    # Logout audit
    st, _ = c.request("POST", "/api/data/auth/logout", {"reason": "user"})
    expect(res, st == 200, "logout")

    # Restore factory session for kiosk UI
    c.login(FACTORY_USER, FACTORY_PASS)
    st, aud3 = c.request("GET", "/api/data/audit-log", params={"action": "Logout"})
    expect(res, st == 200 and len((aud3 or {}).get("entries") or []) >= 1, "audit contains Logout")

    print("\n=== SUMMARY ===")
    print(f"passed: {len(res.passed)}  failed: {len(res.failed)}  warnings: {len(res.warnings)}")
    for m in res.failed:
        print("  FAIL:", m)
    out_path = APP_ROOT / "scripts" / f"full_smoke_result_{stamp}.json"
    out_path.write_text(
        json.dumps(
            {
                "passed": res.passed,
                "failed": res.failed,
                "warnings": res.warnings,
                "memberIds": ids,
                "reportIds": {
                    "test": test_report_id,
                    "validation": val_report_id,
                    "calibration": cal_report_id,
                },
                "auditEntryCount": len(entries),
            },
            indent=2,
        )
    )
    print("wrote", out_path)
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(run())
