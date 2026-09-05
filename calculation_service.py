#!/usr/bin/env python3
"""
calculation_service.py - Dissolution Tester recipe validation and form processing.
"""

from datetime import datetime
from typing import Dict, Any, List


def init():
    pass


def _is_dissolution_recipe(recipe_data: Dict[str, Any]) -> bool:
    rtype = str(recipe_data.get("recipeType") or "").strip().lower()
    if rtype == "dissolution":
        return True
    steps = recipe_data.get("steps")
    if isinstance(steps, list) and steps and recipe_data.get("temperature") is not None:
        return True
    return False


def _validate_dissolution_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    errors: List[str] = []
    name = (recipe_data.get("productName") or recipe_data.get("name") or "").strip()
    if not name:
        errors.append("Recipe name is required")

    try:
        temperature = float(recipe_data.get("temperature"))
        if temperature < 20 or temperature > 50:
            errors.append("Temperature must be between 20 and 50 °C")
    except (TypeError, ValueError):
        errors.append("Temperature (°C) is required")

    mode = str(recipe_data.get("mode") or "").strip()
    if mode not in ("Auto", "Manual"):
        errors.append("Mode must be Auto or Manual")

    usp = str(recipe_data.get("usp") or recipe_data.get("uspMode") or "").strip()
    if usp not in ("USP 1", "USP 2"):
        errors.append("USP must be USP 1 or USP 2")

    sample_volume = str(recipe_data.get("sampleVolume") or "").strip()
    steps = recipe_data.get("steps")
    has_step_sample = isinstance(steps, list) and any(
        str((s or {}).get("sampleVolume") or "").strip() for s in steps
    )
    if not sample_volume and not has_step_sample:
        errors.append("Sample volume is required")

    rinse_volume = str(recipe_data.get("rinseVolume") or "").strip()
    if not rinse_volume:
        errors.append("Flush volume is required")

    media_volume = str(recipe_data.get("mediaVolume") or "").strip()
    if not media_volume:
        errors.append("Media volume is required")

    batch_size = str(recipe_data.get("batchSize") or "").strip()
    if not batch_size:
        errors.append("Batch size is required")

    # AR number / batch number are entered at Load / test start, not on recipe save.

    replenishment = str(recipe_data.get("replenishment") or "").strip()
    if replenishment not in ("Yes", "No"):
        errors.append("Replenishment must be Yes or No")

    power_failure_raw = recipe_data.get("powerFailure")
    try:
        power_failure_min = int(float(power_failure_raw))
        if power_failure_min < 1 or power_failure_min > 60:
            errors.append("Power Failure must be between 1 and 60 minutes")
    except (TypeError, ValueError):
        errors.append("Power Failure (minutes) is required")

    if not isinstance(steps, list) or not steps:
        errors.append("At least one step is required")
    else:
        if len(steps) > 12:
            errors.append("Number of steps must be between 1 and 12")
        for i, step in enumerate(steps):
            label = "Step {}".format((step or {}).get("step") or (i + 1))
            if not isinstance(step, dict):
                errors.append("{} is invalid".format(label))
                continue
            try:
                rpm = float(step.get("rpm"))
                if rpm <= 0:
                    errors.append("{}: RPM must be greater than 0".format(label))
            except (TypeError, ValueError):
                errors.append("{}: RPM is required".format(label))
            try:
                duration = int(float(step.get("durationSeconds")))
                if duration < 1:
                    errors.append("{}: duration must be at least 1 second".format(label))
            except (TypeError, ValueError):
                errors.append("{}: duration (HH:MM:SS) is required".format(label))
            step_sample = str(step.get("sampleVolume") or "").strip()
            if not step_sample and not sample_volume:
                errors.append("{}: sample volume is required".format(label))

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True}


def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate Dissolution recipe data.
    Friability / drum payloads are rejected.
    """
    if _is_dissolution_recipe(recipe_data):
        return _validate_dissolution_recipe(recipe_data)
    return {
        "valid": False,
        "error": "Only Dissolution recipes are supported (Friability/drum recipes are not allowed)",
    }


def _format_hms(seconds: int) -> str:
    total = max(0, int(seconds))
    hh = total // 3600
    mm = (total % 3600) // 60
    ss = total % 60
    return "{:02d}:{:02d}:{:02d}".format(hh, mm, ss)


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize recipe form data for storage."""
    recipe = dict(form_data)
    name = (recipe.get("productName") or recipe.get("name") or "").strip()
    if name:
        recipe["productName"] = name
        recipe["name"] = name

    if _is_dissolution_recipe(recipe):
        recipe["recipeType"] = "dissolution"
        try:
            recipe["temperature"] = float(recipe.get("temperature"))
        except (TypeError, ValueError):
            pass
        mode = str(recipe.get("mode") or "").strip()
        if mode in ("Auto", "Manual"):
            recipe["mode"] = mode
        usp = str(recipe.get("usp") or recipe.get("uspMode") or "").strip()
        if usp in ("USP 1", "USP 2"):
            recipe["usp"] = usp
            recipe["uspMode"] = usp
        recipe["sampleVolume"] = str(recipe.get("sampleVolume") or "").strip()
        recipe["rinseVolume"] = str(recipe.get("rinseVolume") or "").strip()
        recipe["media"] = str(recipe.get("media") or "").strip()
        recipe["mediaVolume"] = str(recipe.get("mediaVolume") or "").strip()
        recipe["batchSize"] = str(recipe.get("batchSize") or "").strip()
        # Optional at save time — collected when loading/starting a test
        if "arNumber" in recipe:
            recipe["arNumber"] = str(recipe.get("arNumber") or "").strip()
        else:
            recipe.pop("arNumber", None)
        replenishment = str(recipe.get("replenishment") or "").strip()
        if replenishment in ("Yes", "No"):
            recipe["replenishment"] = replenishment
        try:
            power_failure_min = int(float(recipe.get("powerFailure")))
            if power_failure_min < 1 or power_failure_min > 60:
                power_failure_min = None
        except (TypeError, ValueError):
            power_failure_min = None
        if power_failure_min is not None:
            recipe["powerFailure"] = power_failure_min
        steps_in = recipe.get("steps") if isinstance(recipe.get("steps"), list) else []
        normalized_steps = []
        for i, step in enumerate(steps_in):
            if not isinstance(step, dict):
                continue
            try:
                rpm = float(step.get("rpm"))
            except (TypeError, ValueError):
                rpm = None
            try:
                duration = int(float(step.get("durationSeconds")))
            except (TypeError, ValueError):
                duration = None
            entry = {
                "step": int(step.get("step") or (i + 1)),
                "rpm": rpm,
                "durationSeconds": duration,
                "durationHms": step.get("durationHms") or (_format_hms(duration) if duration is not None else None),
                "temperature": recipe.get("temperature"),
            }
            step_sample = str(step.get("sampleVolume") or "").strip()
            if step_sample:
                entry["sampleVolume"] = step_sample
            normalized_steps.append(entry)
        recipe["steps"] = normalized_steps
        recipe["stepCount"] = len(normalized_steps)
        if normalized_steps and not str(recipe.get("sampleVolume") or "").strip():
            first_sv = str(normalized_steps[0].get("sampleVolume") or "").strip()
            if first_sv:
                recipe["sampleVolume"] = first_sv

    if "createdAt" not in recipe:
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe.get("createdAt", "")
    return recipe
