#!/usr/bin/env python3
"""Smoke matrix: permission cards are source of truth (DT-aligned)."""

from __future__ import annotations

import sys

import rbac_service as r


def member(role: str, allow: list) -> dict:
    return {
        "username": "testuser",
        "role": role,
        "featureOverrides": {"allow": list(allow), "deny": []},
        "permissionsVersion": 2,
    }


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    empty = member("User", [])
    expect(r.member_has_internal(empty, "dashboard"), "empty: dashboard always-on")
    expect(r.member_has_internal(empty, "settings"), "empty: settings always-on")
    expect(not r.member_has_internal(empty, "quick-test"), "empty: no quick-test")
    expect(not r.member_has_internal(empty, "reports-view"), "empty: no reports")
    expect(not r.member_has_internal(empty, "heater-control"), "empty: no heater")
    expect(not r.member_has_internal(empty, "factory-settings"), "empty: no factory-settings")

    test_only = member("User", ["perm_test_access"])
    keys = r.member_expanded_internal_keys(test_only)
    expect("quick-test" in keys and "recipe-test" in keys, "test card expands tests")
    expect("heater-control" in keys and "shaft-control" in keys, "test card expands heater/shaft")
    expect(r.member_has_internal(test_only, "heater-control"), "test card: heater")
    expect(not r.member_has_internal(test_only, "reports-view"), "test card: no reports")

    reports = member("Admin", ["perm_reports_view"])
    expect(r.member_has_internal(reports, "reports-view"), "reports card")
    expect(not r.member_has_internal(reports, "quick-test"), "reports: no test")

    val = member("User", ["perm_validation_test"])
    expect(r.member_has_internal(val, "validation-test"), "validation card")
    expect(r.member_has_internal(val, "validate-menu"), "validation expands menu")

    # Card grants datetime even for User (role must not revoke).
    dt = member("User", ["perm_datetime"])
    expect(r.member_has_internal(dt, "edit-datetime"), "user+datetime card grants access")

    # Supervisor soft-cap is UI-only; server still grants card-backed user-manage.
    sup = member("Supervisor", ["perm_profile_admin"])
    expect(r.member_has_internal(sup, "user-manage"), "supervisor+profile card grants manage")
    expect(r.get_role_soft_cap("supervisor", "user-manage") == "view-only", "supervisor soft-cap view-only")
    expect(not r.member_has_internal(sup, "factory-settings"), "supervisor no factory-settings")

    fac = member("factory", [])
    expect(r.member_has_internal(fac, "factory-settings"), "factory full")
    expect(r.member_has_internal(fac, "quick-test"), "factory full tests")

    print("rbac_card_smoke: OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print("rbac_card_smoke: FAIL:", exc, file=sys.stderr)
        sys.exit(1)
