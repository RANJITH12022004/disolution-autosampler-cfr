#!/usr/bin/env python3
"""
bridge.py - Kiosk entry point for Tap Density. Sets APP_ROOT and runs Flask app.
"""

import os
import pathlib
import sys

if sys.platform == "win32" and not os.environ.get("SIMULATE_HARDWARE"):
    os.environ.setdefault("SIMULATE_HARDWARE", "1")

if "APP_ROOT" not in os.environ:
    _script_dir = pathlib.Path(__file__).resolve().parent
    if str(_script_dir).startswith("/opt/kiosk"):
        os.environ.setdefault("APP_ROOT", "/opt/kiosk")
    else:
        os.environ.setdefault("APP_ROOT", str(_script_dir))

from app import app

if __name__ == "__main__":
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", "5000"))
    app.run(host=host, port=port, debug=False)
