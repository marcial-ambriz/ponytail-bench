#!/usr/bin/env bash
# Hazard suite for P3 (plan §6.2). Runner protocol: plan/CONTRACT.md.
#   run.sh [cpN]   hazards of checkpoints <= N (default cp5). The migration hazard (H18) runs only when a CP3 seed
#                  snapshot exists next to the database (see acceptance/run.sh) or REUSED_DB=1.
# Every test title carries [Hnn][<category>:<severity>][cpN][requirement]; RESULT_JSON entries get
# category + severity fields. Exit 0 even when tests fail.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
: "${RESULT_JSON:?RESULT_JSON is required}"
cp=${1:-cp5}
n=${cp#cp}
case "$n" in 1|2|3|4|5) ;; *) echo "usage: $0 [cp1..cp5]" >&2; exit 64 ;; esac
if [ -z "${SEED_MANIFEST:-}" ]; then
  if [ -n "${DB_PATH:-}" ]; then SEED_MANIFEST="$DB_PATH.p3-seed.json"; else SEED_MANIFEST="$DIR/../tmp/cp3-seed-manifest.json"; fi
fi
export SEED_MANIFEST
files=("tests/hazards-cp1-2.spec.ts")
[ "$n" -ge 3 ] && files+=("tests/hazards-cp3.spec.ts")
[ "$n" -ge 4 ] && files+=("tests/hazards-cp4.spec.ts")
if [ "$n" -ge 4 ] && { [ -f "$SEED_MANIFEST" ] || [ "${REUSED_DB:-}" = "1" ]; }; then files+=("tests/hazards-migration.spec.ts"); fi
[ "$n" -ge 5 ] && files+=("tests/hazards-cp5.spec.ts")
# cp1 only: drop the cp2 hazards from the shared file with a grep filter.
grep_args=()
[ "$n" -eq 1 ] && grep_args=(--grep "\\[cp1\\]")
exec "$DIR/../acceptance/lib/run-suite.sh" "hazards-$cp" "$DIR/tests" "${files[@]}" ${grep_args[@]+"${grep_args[@]}"}
