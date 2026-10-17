#!/bin/bash
# Double-click in Finder to start Storyboard and open it in your browser.
# Keep the Terminal window open while you work; close it to stop.
cd "$(dirname "$0")" || exit 1
if [ -x ../.venv/bin/python3 ]; then PY=../.venv/bin/python3; else PY=python3; fi
exec "$PY" server.py "$@"
