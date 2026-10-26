#!/usr/bin/env bash
# Contract runner: env API_URL, BASE_URL, WORKDIR, RESULT_JSON; arg = checkpoint id. Exit 0 even when tests fail.
exec python3 -I "$(dirname "$0")/check.py" "$@"
