#!/usr/bin/env bash
# Hidden acceptance suite for P2 (CTFd brownfield).
# Usage: acceptance/run.sh <t1|t2|t3|t4|t5|all>
# Env: BASE_URL (live server), RESULT_JSON (output path). WORKDIR/API_URL unused.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TASK="${1:-all}"
PY="${PYTHON:-python3}"
exec "$PY" -I "$HERE/main.py" "$TASK"
