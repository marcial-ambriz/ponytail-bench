#!/usr/bin/env bash
# Shared runner for the P1 hidden suites (CONTRACT.md "Test runner protocol").
#
#   support/run-suite.sh <acceptance|hazards|maintenance> [cpN | --only cpN]
#
# The app must already be running (the harness starts it with project.json "start"). Env:
#   BASE_URL     web origin, e.g. http://localhost:5173 (required by the protocol; default http://localhost:5173)
#   API_URL      API origin (informational: every request goes through BASE_URL's /api proxy, as a browser would)
#   WORKDIR      the run's working copy (informational; the suites are black-box)
#   RESULT_JSON  output path (default results/<RUN_ID>/<suite>/result.json)
#   RUN_ID       label for the artifacts folder results/<RUN_ID>/ (default: a unique id per invocation, so concurrent
#                validations never share a folder). Runners write only to RESULT_JSON and results/.
# acceptance and hazards are cumulative: "cp3" runs cp1..cp3 (regression check); "--only cp3" runs cp3 alone.
# maintenance ignores the checkpoint argument.
# Writes RESULT_JSON = {passed, total, suite, scope, suite_sha256, tests:[{id, requirement, category, severity?,
# checkpoint, title, status: pass|fail, message}]}. Exit 0 even when tests fail; non-zero only for runner errors.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SUITE=${1:-}
shift || true
case "$SUITE" in acceptance|hazards|maintenance) ;; *) echo "usage: $0 <acceptance|hazards|maintenance> [cpN|--only cpN]" >&2; exit 64 ;; esac

ONLY=0
TARGET=cp5
if [ "${1:-}" = "--only" ]; then ONLY=1; shift; fi
[ -n "${1:-}" ] && TARGET=$1
case "$TARGET" in cp1|cp2|cp3|cp4|cp5) ;; *) echo "checkpoint must be cp1..cp5, got $TARGET" >&2; exit 64 ;; esac
N=${TARGET#cp}

export BASE_URL=${BASE_URL:-http://localhost:5173}
export RUN_ID=${RUN_ID:-run-$(date +%Y%m%d%H%M%S)-$$}
export SUITE
OUT="$ROOT/results/$RUN_ID/$SUITE"
RESULT_JSON=${RESULT_JSON:-$OUT/result.json}
rm -rf "$OUT"
mkdir -p "$OUT" "$(dirname "$RESULT_JSON")"
export PW_OUT="$OUT"

if [ ! -d "$ROOT/node_modules/@playwright/test" ]; then
  (cd "$ROOT" && npm ci --no-audit --no-fund) >"$OUT/install.log" 2>&1 || { echo "suite npm ci failed (see $OUT/install.log)" >&2; exit 2; }
fi

FILES=""
case "$SUITE" in
  acceptance)
    i=1; [ $ONLY -eq 1 ] && i=$N
    while [ "$i" -le "$N" ]; do
      for f in "acceptance/tests/cp$i.spec.ts" "acceptance/tests/probes-cp$i.spec.ts"; do [ -f "$ROOT/$f" ] && FILES="$FILES $f"; done
      i=$((i + 1))
    done ;;
  hazards)
    i=1; [ $ONLY -eq 1 ] && i=$N
    while [ "$i" -le "$N" ]; do [ -f "$ROOT/hazards/tests/cp$i.spec.ts" ] && FILES="$FILES hazards/tests/cp$i.spec.ts"; i=$((i + 1)); done ;;
  maintenance)
    FILES=$(cd "$ROOT" && ls maintenance/tests/*.spec.ts | tr '\n' ' ') ;;
esac
SCOPE="$TARGET"; [ $ONLY -eq 1 ] && SCOPE="only-$TARGET"; [ "$SUITE" = maintenance ] && SCOPE=all

(cd "$ROOT" && npx playwright test $FILES) >"$OUT/playwright.log" 2>&1
PW_EXIT=$?

node "$ROOT/support/to-result.js" "$OUT/report.json" "$RESULT_JSON" "$SUITE" "$SCOPE" "$ROOT" || {
  echo "no usable report (playwright exit $PW_EXIT); see $OUT/playwright.log" >&2
  exit 1
}
node -e 'const r=require(process.argv[1]);console.log(`passed=${r.passed} failed=${r.total-r.passed} total=${r.total}`)' "$RESULT_JSON"
exit 0
