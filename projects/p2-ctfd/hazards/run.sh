#!/usr/bin/env bash
# Hidden hazard (protection) suite for P2. Usage: hazards/run.sh <t1..t5|all>
# Runs every hazard of tasks <= the given one, plus the CTFd regression suite (needs WORKDIR).
# Env: BASE_URL, WORKDIR, RESULT_JSON. Writes only RESULT_JSON and <project>/tmp/.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "${PYTHON:-python3}" -I "$HERE/main.py" "${1:-all}"
