#!/usr/bin/env bash
# Shared Playwright runner for acceptance/, hazards/ and maintenance/.
#   run-suite.sh <suite-name> <test-dir> <spec files...>
# Env (runner protocol, plan/CONTRACT.md): BASE_URL (web origin, required), RESULT_JSON (output path, required);
# API_URL and WORKDIR are informational (every call goes through the web proxy, like the app's own UI).
# Writes only RESULT_JSON and a private scratch dir under <project>/tmp/ (removed afterwards unless KEEP_PW=1),
# plus acceptance/node_modules on first use (npm ci). Exit 0 even when tests fail; non-zero only for runner errors.
set -u
SUITE=$1; TEST_DIR=$2; shift 2
LIB_DIR=$(cd "$(dirname "$0")" && pwd)
ACC_DIR=$(cd "$LIB_DIR/.." && pwd)
PROJECT_DIR=$(cd "$ACC_DIR/.." && pwd)
: "${BASE_URL:?BASE_URL is required}"
: "${RESULT_JSON:?RESULT_JSON is required}"
mkdir -p "$PROJECT_DIR/tmp" "$(dirname "$RESULT_JSON")"
OUT_DIR=$(mktemp -d "$PROJECT_DIR/tmp/$SUITE-XXXXXX")
cleanup() { [ "${KEEP_PW:-0}" = "1" ] || rm -rf "$OUT_DIR"; }
trap cleanup EXIT

if [ ! -d "$ACC_DIR/node_modules/@playwright/test" ]; then
  (cd "$ACC_DIR" && npm ci --no-audit --no-fund) >"$OUT_DIR/npm.log" 2>&1 || { cat "$OUT_DIR/npm.log" >&2; echo "npm ci failed" >&2; exit 2; }
fi

if [ $# -eq 0 ]; then
  echo '{"suite":"'"$SUITE"'","passed":0,"total":0,"error":null,"tests":[]}' >"$RESULT_JSON"
  echo "$SUITE: no spec files selected"; exit 0
fi

# Specs outside acceptance/ resolve @playwright/test and the shared support code through NODE_PATH.
(cd "$ACC_DIR" && NODE_PATH="$ACC_DIR/node_modules" PW_TEST_DIR="$TEST_DIR" PW_OUT="$OUT_DIR" BASE_URL="$BASE_URL" \
  npx playwright test --config "$ACC_DIR/playwright.config.ts" "$@") >"$OUT_DIR/playwright.log" 2>&1
if [ ! -f "$OUT_DIR/report.json" ]; then
  tail -n 40 "$OUT_DIR/playwright.log" >&2
fi
node "$LIB_DIR/to-result.cjs" "$OUT_DIR/report.json" "$RESULT_JSON" "$SUITE" || exit 2
[ "${KEEP_PW:-0}" = "1" ] && echo "playwright output kept in $OUT_DIR"
exit 0
