#!/usr/bin/env bash
# Hidden tests of the maintenance feature (task.md: cycle counts). Runner protocol: plan/CONTRACT.md.
# Env: BASE_URL, RESULT_JSON (required). Exit 0 even when tests fail.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/../acceptance/lib/run-suite.sh" maintenance "$DIR/tests" "tests/cycle-counts.spec.ts"
