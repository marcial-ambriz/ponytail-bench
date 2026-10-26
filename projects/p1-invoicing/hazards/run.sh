#!/usr/bin/env bash
# Hidden hazards suite for P1. See support/run-suite.sh for env (BASE_URL, API_URL, WORKDIR, RESULT_JSON) and arguments.
exec "$(cd "$(dirname "$0")/.." && pwd)/support/run-suite.sh" hazards "$@"
