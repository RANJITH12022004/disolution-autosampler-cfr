#!/usr/bin/env python3
"""
report_service.py - Dissolution Tester report generation and context.
"""

import html as html_module
import json
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional, List

import data_service

_config = {}
_reports_dir = None
_storage_dir = None


def init(config):
    global _config, _reports_dir, _storage_dir
    _config = dict(config)
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _reports_dir.mkdir(parents=True, exist_ok=True)


def generate_report(
    test_data: Dict[str, Any],
    recipe: Optional[Dict[str, Any]] = None,
    factory_settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    report = dict(test_data)
    if recipe:
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName"),
            "productName": recipe.get("productName"),
            "batchNumber": recipe.get("batchNumber"),
            "unit": recipe.get("unit"),
        }
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    report["factorySettings"] = enrich_factory_settings(factory_settings or {})
    if not report.get("createdAt"):
        report["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not report.get("completedAt"):
        report["completedAt"] = report["createdAt"]
    report = enrich_report_context(report)
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any]) -> Dict[str, Any]:
    """Merge live validation dates into full factory settings (preserve limits like maxQa)."""
    enriched = dict(factory_settings or {})
    if not enriched.get("companyName"):
        enriched["companyName"] = "N/A"
    if not enriched.get("modelNo"):
        enriched["modelNo"] = "N/A"
    if not enriched.get("serialNo"):
        enriched["serialNo"] = "N/A"
    if not (enriched.get("companyLocation") or enriched.get("location")):
        enriched["companyLocation"] = "N/A"
    elif not enriched.get("companyLocation") and enriched.get("location"):
        enriched["companyLocation"] = enriched.get("location")
    if not enriched.get("instrumentId"):
        enriched["instrumentId"] = "N/A"
    dates = _resolve_validation_dates(enriched)
    enriched["lastValidationDate"] = dates.get("lastValidationDate") or enriched.get("lastValidationDate") or "N/A"
    enriched["nextValidationDate"] = dates.get("nextValidationDate") or enriched.get("nextValidationDate") or "N/A"
    return enriched


def format_duration_hhmmss(seconds_val: Any) -> str:
    """Format elapsed seconds as HH:MM:SS for reports."""
    if seconds_val is None:
        return "--"
    try:
        total_s = int(seconds_val)
    except (TypeError, ValueError):
        return "--"
    if total_s < 0:
        return "--"
    h, rem = divmod(total_s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def test_duration_seconds(td: Dict[str, Any]) -> Optional[int]:
    """Resolve test duration in seconds from stored testData."""
    if not isinstance(td, dict):
        return None
    sec = td.get("durationSeconds")
    if sec is not None:
        try:
            return max(0, int(sec))
        except (TypeError, ValueError):
            pass
    start_raw = td.get("testStartTime")
    end_raw = td.get("testEndTime")
    if start_raw and end_raw:
        try:
            start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
            return max(0, int((end - start).total_seconds()))
        except Exception:
            pass
    return None


def _parse_density_number(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _stat_display_value(val: Dict[str, Any]) -> Any:
    if val.get("value") is not None:
        return val.get("value")
    if val.get("mean") is not None:
        mean = val.get("mean")
        min_v = val.get("min")
        max_v = val.get("max")
        if min_v is not None or max_v is not None:
            return "Avg: {} | Min: {} | Max: {}".format(
                mean,
                min_v if min_v is not None else "--",
                max_v if max_v is not None else "--",
            )
        return mean
    if val.get("Mean") is not None:
        mean = val.get("Mean")
        min_v = val.get("Min")
        max_v = val.get("Max")
        if min_v is not None or max_v is not None:
            return "Avg: {} | Min: {} | Max: {}".format(
                mean,
                min_v if min_v is not None else "--",
                max_v if max_v is not None else "--",
            )
        return mean
    return None


def _recipe_total_tap_count(recipe: Dict[str, Any]) -> Optional[int]:
    if not isinstance(recipe, dict):
        return None
    ct = recipe.get("customTotalTaps")
    if ct is not None and ct != "":
        try:
            n = int(ct)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    total = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        try:
            total += int(step.get("tapCount") or 0)
        except (TypeError, ValueError):
            pass
    return total if total > 0 else None


def _agg_mean_min_max(values: List[float]) -> Dict[str, float]:
    if not values:
        return {}
    return {
        "mean": round(sum(values) / len(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
    }


def _parse_float(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _format_derived_number(val: Any, decimals: int = 3) -> str:
    if val is None:
        return "--"
    try:
        f = float(val)
        if decimals <= 0:
            return str(int(round(f)))
        fmt = f"{{:.{decimals}f}}"
        s = fmt.format(f)
        return s.rstrip("0").rstrip(".") if "." in s else s
    except (TypeError, ValueError):
        return str(val)


def _report_print_timestamp() -> Dict[str, str]:
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        return {
            "printDate": str(payload.get("date") or "--"),
            "printTime": str(payload.get("time") or "--"),
        }
    except Exception:
        now = datetime.now()
        return {
            "printDate": now.strftime("%d-%m-%Y"),
            "printTime": now.strftime("%H:%M:%S"),
        }


def _test_type_label(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    mode = str(recipe.get("uspMode") or td.get("uspMode") or "").strip().upper()
    if mode == "USP1":
        return "USP 1"
    if mode == "USP2":
        return "USP 2"
    if mode == "CUSTOM":
        return "Custom"
    usp = str(recipe.get("usp") or td.get("usp") or "").strip()
    if not usp:
        return "--"
    u = usp.upper().replace("  ", " ")
    if u in ("USP1", "USP 1"):
        return "USP 1"
    if u in ("USP2", "USP 2"):
        return "USP 2"
    if "CUSTOM" in u:
        return "Custom"
    return usp


def _test_method_label(recipe: Dict[str, Any], td: Dict[str, Any], test_type: str) -> str:
    recipe = recipe or {}
    td = td or {}
    cyl = recipe.get("cylinder") if isinstance(recipe.get("cylinder"), dict) else {}
    cyl_ml = cyl.get("volume") or cyl.get("volumeMl") or td.get("sampleVolumeMl")
    parts = [test_type] if test_type and test_type != "--" else []
    if cyl_ml not in (None, "", "--"):
        parts.append(f"{cyl_ml} ml cylinder")
    return ", ".join(parts) if parts else "--"


def _drop_height_display(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    dh = recipe.get("dropHeight")
    steps = recipe.get("steps") or td.get("steps") or []
    if dh is None and isinstance(steps, list) and steps and isinstance(steps[0], dict):
        dh = steps[0].get("dropHeight")
    if dh is None and isinstance(td, dict):
        dh = td.get("dropHeight")
    if dh is None or dh == "":
        return "--"
    try:
        mm = float(dh)
        return f"{_format_derived_number(mm, 0)} mm +/- 0.2 mm"
    except (TypeError, ValueError):
        return str(dh)


def build_test_report_derived(
    td: Optional[Dict[str, Any]],
    recipe: Optional[Dict[str, Any]] = None,
    report_id: Any = None,
) -> Dict[str, Any]:
    """Dissolution test report derived fields (no friability weights/drums)."""
    td = td if isinstance(td, dict) else {}
    recipe = recipe if isinstance(recipe, dict) else {}
    if not recipe and isinstance(td.get("recipe"), dict):
        recipe = td.get("recipe") or {}

    duration_sec = test_duration_seconds(td)
    ts = _report_print_timestamp()
    return {
        **ts,
        "testType": recipe.get("usp") or td.get("usp") or "Dissolution",
        "testMethod": td.get("mode") or recipe.get("mode") or "--",
        "rpm": td.get("rpm") if td.get("rpm") is not None else "--",
        "durationSeconds": duration_sec,
        "durationFormatted": format_duration_hhmmss(duration_sec),
        "batchNumber": td.get("batchNumber") or recipe.get("batchNumber"),
        "productName": recipe.get("productName") or td.get("productName"),
        "temperature": td.get("temperature") if td.get("temperature") is not None else recipe.get("temperature"),
    }


def compute_test_report_statistics(test_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Dissolution: no friability weight statistics."""
    return None


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    if not report_data:
        return report_data
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    for k, default in [
        ("companyName", "N/A"),
        ("modelNo", "N/A"),
        ("serialNo", "N/A"),
        ("companyLocation", "N/A"),
        ("instrumentId", "N/A"),
    ]:
        if not fs.get(k):
            fs[k] = factory_settings.get(k) or default
    dates = _resolve_validation_dates({**factory_settings, **fs})
    if dates.get("lastValidationDate"):
        fs["lastValidationDate"] = dates["lastValidationDate"]
    if dates.get("nextValidationDate"):
        fs["nextValidationDate"] = dates["nextValidationDate"]
    report_data["factorySettings"] = fs
    if str(report_data.get("type") or "").strip().lower() == "test":
        td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else report_data
        if isinstance(td, dict):
            td_remarks = td.get("remarks")
            if td_remarks not in (None, "") and not report_data.get("remarks"):
                report_data["remarks"] = td_remarks
        recipe = report_data.get("recipe") if isinstance(report_data.get("recipe"), dict) else {}
        report_data["reportDerived"] = build_test_report_derived(
            td if isinstance(td, dict) else {},
            recipe,
            report_data.get("id"),
        )
    return report_data


def _parse_report_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _parse_display_date(value: Any) -> Optional[datetime]:
    """Parse DD-MM-YYYY, DD/MM/YYYY, or ISO datetime strings."""
    s = str(value or "").strip()
    if not s or s.upper() == "N/A":
        return None
    for fmt in ("%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s[:10], fmt)
        except Exception:
            continue
    return _parse_report_datetime(value)


def _add_years(dt: datetime, years: int = 1) -> datetime:
    """Add calendar years; Feb 29 rolls to Feb 28 on non-leap years."""
    try:
        return dt.replace(year=dt.year + int(years or 1))
    except ValueError:
        return dt.replace(month=2, day=28, year=dt.year + int(years or 1))


def _validation_dates_from_last(dt: datetime) -> Dict[str, str]:
    """Last validation date and next due exactly one calendar year later."""
    next_dt = _add_years(dt, 1)
    return {
        "lastValidationDate": dt.strftime("%d-%m-%Y"),
        "nextValidationDate": next_dt.strftime("%d-%m-%Y"),
    }


def _resolve_validation_dates(factory_settings: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Single source for validation dates: latest validation report, else stored last; next always +1 year."""
    computed = _compute_validation_dates_from_reports()
    if computed.get("lastValidationDate"):
        return computed
    fs = factory_settings or {}
    last_dt = _parse_display_date(fs.get("lastValidationDate"))
    if last_dt:
        return _validation_dates_from_last(last_dt)
    return {}


def sync_factory_validation_dates() -> Dict[str, str]:
    """Persist resolved validation dates into factory settings storage."""
    stored = data_service.get_factory_settings() or {}
    dates = _resolve_validation_dates(stored)
    if not dates:
        return {}
    updated = dict(stored)
    updated["lastValidationDate"] = dates["lastValidationDate"]
    updated["nextValidationDate"] = dates["nextValidationDate"]
    data_service.save_factory_settings(updated)
    return dates


def _compute_validation_dates_from_reports() -> Dict[str, str]:
    reports = data_service.list_reports("validation")
    latest_dt = None
    for report in reports or []:
        if str(report.get("type") or "").strip().lower() != "validation":
            continue
        td = report.get("testData") or {}
        status_raw = str(td.get("status") or report.get("status") or "").strip().lower()
        if status_raw == "aborted":
            continue
        dt = _parse_report_datetime(
            td.get("completedAt")
            or report.get("completedAt")
            or td.get("createdAt")
            or report.get("createdAt")
        )
        if not dt:
            continue
        if latest_dt is None or dt > latest_dt:
            latest_dt = dt
    if latest_dt is None:
        return {}
    return _validation_dates_from_last(latest_dt)


def get_report_preview_data(report: Dict[str, Any]) -> Dict[str, Any]:
    report = enrich_report_context(dict(report or {}))
    td = report.get("testData") or report
    remarks = report.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    preview = {
        "id": report.get("id"),
        "type": report.get("type", "test"),
        "createdAt": report.get("createdAt"),
        "completedAt": report.get("completedAt"),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", report),
        "statistics": {},
        "status": report.get("status", "PASS"),
        "remarks": remarks,
        "approvedBy": report.get("approvedBy"),
        "approvedAt": report.get("approvedAt"),
        "reportApprovalStatus": report.get("reportApprovalStatus"),
        "approvalPassFail": report.get("approvalPassFail"),
        "drumPassFail": report.get("drumPassFail") or (td.get("drumPassFail") if isinstance(td, dict) else None),
        "approvalRemarks": report.get("approvalRemarks"),
        "operatedByUsername": report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None)
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "operatorName": report.get("operatorName")
        or (td.get("operatorName") if isinstance(td, dict) else None),
        "employeeId": report.get("employeeId")
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "reportDerived": report.get("reportDerived")
        or build_test_report_derived(
            td if isinstance(td, dict) else {},
            report.get("recipe") if isinstance(report.get("recipe"), dict) else {},
            report.get("id"),
        ),
    }
    if report.get("type") == "validation":
        preview["validationSubtype"] = report.get("validationSubtype") or (
            td.get("validationSubtype") if isinstance(td, dict) else None
        )
        preview["usp"] = report.get("usp")
        preview["rpm"] = report.get("rpm")
        preview["currentRpm"] = report.get("currentRpm")
        preview["rpmTolerance"] = report.get("rpmTolerance")
        preview["rpmPass"] = report.get("rpmPass")
        preview["delta"] = report.get("delta") if report.get("delta") is not None else (
            td.get("delta") if isinstance(td, dict) else None
        )
        preview["setpoint"] = report.get("setpoint")
        preview["tolerance"] = report.get("tolerance")
        preview["temperatureChannels"] = report.get("temperatureChannels") or (
            td.get("temperatureChannels") if isinstance(td, dict) else None
        )
        preview["sampleVolumeTarget"] = report.get("sampleVolumeTarget") or (
            td.get("sampleVolumeTarget") if isinstance(td, dict) else None
        )
        preview["sampleVolumeMeasured"] = report.get("sampleVolumeMeasured") or (
            td.get("sampleVolumeMeasured") if isinstance(td, dict) else None
        )
        preview["sampleVolumeTolerance"] = report.get("sampleVolumeTolerance") or (
            td.get("sampleVolumeTolerance") if isinstance(td, dict) else None
        )
        preview["sampleVolumePass"] = report.get("sampleVolumePass") if report.get("sampleVolumePass") is not None else (
            td.get("sampleVolumePass") if isinstance(td, dict) else None
        )
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
    return preview


def _html_esc(value: Any) -> str:
    if value is None or value == "":
        return "N/A"
    return html_module.escape(str(value))


def _format_report_ts(value: Any) -> str:
    s = str(value or "").strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt = datetime.fromisoformat(clean)
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _report_step_row_count(td: Dict[str, Any]) -> int:
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    try:
        cs = int(td.get("completedSteps") or 0)
        return max(0, cs)
    except (TypeError, ValueError):
        return 0


def _validation_details_table_html(preview: Dict[str, Any]) -> str:
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else preview
    if not isinstance(td, dict):
        td = {}
    sub = str(td.get("validationSubtype") or preview.get("validationSubtype") or "").strip().lower()
    start_str = _format_report_ts(
        td.get("validationStartTime")
        or td.get("testStartTime")
        or preview.get("validationStartTime")
        or preview.get("createdAt")
    )
    date_str = _format_report_ts(
        td.get("validationEndTime")
        or td.get("testEndTime")
        or td.get("completedAt")
        or preview.get("completedAt")
        or preview.get("createdAt")
    )
    status = td.get("status") or preview.get("status") or "--"
    rows = []
    rows.append('<tr><th>Start Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(start_str)))
    rows.append('<tr><th>End Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))

    if sub == "temperature":
        tolerance = td.get("tolerance", preview.get("tolerance"))
        rows.append(
            "<tr><th>Type</th><td>Temperature</td><th>Status</th><td>{}</td></tr>".format(_html_esc(status))
        )
        rows.append(
            "<tr><th>Tolerance (± °C)</th><td colspan=\"3\">{}</td></tr>".format(
                _html_esc(tolerance if tolerance is not None else "--")
            )
        )
        channels = td.get("temperatureChannels") or preview.get("temperatureChannels") or []
        if isinstance(channels, list):
            for ch in channels:
                if not isinstance(ch, dict):
                    continue
                label = ch.get("label") or "--"
                live = ch.get("live")
                reference = ch.get("reference")
                try:
                    live_s = "{:.1f}".format(float(live)) if live is not None else "--"
                except (TypeError, ValueError):
                    live_s = str(live) if live is not None else "--"
                try:
                    ref_s = "{:.1f}".format(float(reference)) if reference is not None else "--"
                except (TypeError, ValueError):
                    ref_s = str(reference) if reference is not None else "--"
                try:
                    dlt_n = float(ch.get("delta"))
                    dlt_s = "{:+.2f}".format(dlt_n)
                except (TypeError, ValueError):
                    dlt_s = "--"
                rows.append(
                    "<tr><th>{}</th><td colspan=\"3\">Live {} / Ref {} / Δ {}</td></tr>".format(
                        _html_esc(label), _html_esc(live_s), _html_esc(ref_s), _html_esc(dlt_s)
                    )
                )
    elif sub == "rpm":
        rpm_target = td.get("rpm", preview.get("rpm"))
        rpm_live = td.get("currentRpm", preview.get("currentRpm"))
        rpm_delta = td.get("delta", preview.get("delta"))
        try:
            dlt_s = "{:+.2f}".format(float(rpm_delta)) if rpm_delta is not None else "--"
        except (TypeError, ValueError):
            dlt_s = "--"
        rows.append(
            "<tr><th>Type</th><td>RPM</td><th>Status</th><td>{}</td></tr>".format(_html_esc(status))
        )
        rows.append(
            "<tr><th>Target RPM</th><td colspan=\"3\">{}</td></tr>".format(
                _html_esc(rpm_target if rpm_target is not None else "--")
            )
        )
        rows.append(
            "<tr><th>Live RPM</th><td>{}</td><th>Δ vs target</th><td>{}</td></tr>".format(
                _html_esc(rpm_live if rpm_live is not None else "--"),
                _html_esc(dlt_s),
            )
        )
    elif sub in ("sample-volume", "sample_volume"):
        sv_target = td.get("sampleVolumeTarget", preview.get("sampleVolumeTarget"))
        sv_tol = td.get("sampleVolumeTolerance", preview.get("sampleVolumeTolerance"))
        sv_measured = td.get("sampleVolumeMeasured", preview.get("sampleVolumeMeasured"))
        sv_delta = td.get("delta", preview.get("delta"))
        sv_pass = td.get("sampleVolumePass", preview.get("sampleVolumePass"))
        sv_pass_label = "Pass" if sv_pass is True else ("Fail" if sv_pass is False else "--")
        try:
            dlt_s = "{:+.2f}".format(float(sv_delta)) if sv_delta is not None else "--"
        except (TypeError, ValueError):
            dlt_s = "--"
        rows.append(
            "<tr><th>Type</th><td>Sample Volume</td><th>Status</th><td>{}</td></tr>".format(_html_esc(status))
        )
        rows.append(
            "<tr><th>Target (mL)</th><td>{}</td><th>Tolerance (± mL)</th><td>{}</td></tr>".format(
                _html_esc(sv_target if sv_target is not None else "--"),
                _html_esc(sv_tol if sv_tol is not None else "--"),
            )
        )
        rows.append(
            "<tr><th>Measured (mL)</th><td>{}</td><th>Δ vs target</th><td>{}</td></tr>".format(
                _html_esc(sv_measured if sv_measured is not None else "--"),
                _html_esc(dlt_s),
            )
        )
        rows.append(
            "<tr><th>Channel</th><td>Sample volume</td><th>Result</th><td>{}</td></tr>".format(
                _html_esc(sv_pass_label)
            )
        )
    else:
        rows.append(
            "<tr><th>Type</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                _html_esc(td.get("usp") or sub or "Validation"),
                _html_esc(status),
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="4">No validation data</td></tr>'


def _derived_summary_html(derived: Dict[str, Any]) -> str:
    """Dissolution: no friability / tap-density summary block."""
    return ""


def _derived_test_result_html(derived: Dict[str, Any]) -> str:
    """Dissolution: no friability / tap-density result block."""
    return ""


def build_report_pdf_html(report: Dict[str, Any]) -> str:
    """
    Build PDF HTML from the A4 text formatter output (====, ----, ****).
    Omits the printed date/time footer used on dot-matrix A4 printouts.
    """
    import print_service

    enriched = enrich_report_context(dict(report or {}))
    a4_text = print_service.format_for_a4_printer(
        enriched, include_printed_timestamp=False
    ).rstrip()
    escaped = html_module.escape(a4_text)

    css = (
        "@page{size:A4;margin:8mm 8mm;}"
        "body{margin:0;color:#000;background:#fff;font-family:'Courier New',Courier,monospace;font-size:9.5pt;line-height:1.15;}"
        "pre{margin:0;white-space:pre;tab-size:4;letter-spacing:0;}"
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>'
        '<style>{}</style></head><body><pre>{}</pre></body></html>'
    ).format(css, escaped)


def create_pdf_report(report_data: Dict[str, Any], template_type: str = "standard") -> Optional[pathlib.Path]:
    try:
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        recipe_name = report_data.get("recipe", {}).get("productName", "report")
        safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
        filename = f"{safe_name}_{timestamp}.json"
        pdf_path = _reports_dir / filename
        with open(pdf_path, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
        return pdf_path
    except Exception:
        return None


def export_reports_to_usb(report_ids: List[int], export_path: str) -> Dict[str, Any]:
    try:
        export_dir = pathlib.Path(export_path)
        export_dir.mkdir(parents=True, exist_ok=True)
        exported_files = []
        for report_id in report_ids:
            report = data_service.get_report(report_id)
            if not report:
                continue
            timestamp = report.get("createdAt", datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
            safe_ts = "".join(c for c in str(timestamp) if c.isalnum() or c in "-_.T")
            recipe_name = report.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            filename = f"{safe_name}_{report_id}_{safe_ts}.json"
            export_file = export_dir / filename
            with open(export_file, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            exported_files.append(str(export_file))
        return {"success": True, "exported_files": exported_files, "count": len(exported_files)}
    except Exception as e:
        return {"success": False, "error": str(e)}
