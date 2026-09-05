#!/usr/bin/env python3
"""disso_temp_hardware.py - UART-2 temperature ESP (stub until dual-ESP phase lands)."""

_logger = None
_config = {}


def init(app, config):
    global _logger, _config
    _config = dict(config or {})
    _logger = getattr(app, "logger", None)
    if _logger:
        _logger.info("[disso_temp] stub init (ESP_TEMP_PORT=%s)", _config.get("ESP_TEMP_PORT"))


def get_live_temperatures():
    return {
        "bath": None,
        "external": None,
        "vessels": [None] * 6,
        "simulate": bool(_config.get("SIMULATE_HARDWARE")),
    }
