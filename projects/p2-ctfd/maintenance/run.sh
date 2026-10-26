#!/usr/bin/env bash
# Hidden tests for the maintenance feature (task.md). Env: BASE_URL, RESULT_JSON.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "${PYTHON:-python3}" -I "$HERE/main.py"
