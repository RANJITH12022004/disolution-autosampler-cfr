#!/usr/bin/env python3
"""disso_cmd_hardware.py - UART-1 command ESP (stub until dual-ESP phase lands)."""

_logger = None
_config = {}


def init(app, config):
    global _logger, _config
    _config = dict(config or {})
    _logger = getattr(app, "logger", None)
    if _logger:
        _logger.info("[disso_cmd] stub init (ESP_CMD_PORT=%s)", _config.get("ESP_CMD_PORT"))


def is_simulate() -> bool:
    return bool(_config.get("SIMULATE_HARDWARE"))
