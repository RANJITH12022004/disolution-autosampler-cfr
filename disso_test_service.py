#!/usr/bin/env python3
"""disso_test_service.py - Server-authoritative dissolution test (stub until phase 2)."""

_logger = None
_config = {}


def init(logger=None, config=None):
    global _logger, _config
    _logger = logger
    _config = dict(config or {})
    if _logger:
        _logger.info("[disso_test] stub init")


def get_state():
    return {"active": False, "runStatus": "IDLE"}


def try_startup_power_recovery():
    """Called on unclean boot; full auto-resume lands in phase 3."""
    return {"recovered": False, "aborted": False}
