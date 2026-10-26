#!/usr/bin/env bash
# Hidden acceptance suite for P3 (Stockly). Runner protocol: plan/CONTRACT.md.
#
#   run.sh cpN          checkpoint N only (UI C1/C5 + API probes C2). For cp4 it also runs the migration check
#                       when a CP3 seed snapshot exists next to the database (or REUSED_DB=1).
#   run.sh cp1-cpN      checkpoints 1..N (regression run)
#   run.sh seed-cp3     seeds CP3-era data through the API and writes the snapshot the cp4 migration check reads
#                       (project.json: cp3 "seed_after"). RESULT_JSON is optional here.
#
# Env: BASE_URL (required), RESULT_JSON (required except seed-cp3), DB_PATH (the app's database),
#      SEED_MANIFEST (default "$DB_PATH.p3-seed.json": it sits next to the database, so the harness copies it
#      together with the persisted CP3 database into the CP4 run), REUSED_DB (set by the harness on reuse).
# Exit 0 even when tests fail; non-zero only for runner errors.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
if [ -z "${SEED_MANIFEST:-}" ]; then
  if [ -n "${DB_PATH:-}" ]; then SEED_MANIFEST="$DB_PATH.p3-seed.json"
  else SEED_MANIFEST="$DIR/../tmp/cp3-seed-manifest.json"; fi
fi
export SEED_MANIFEST

arg=${1:-}
case "$arg" in
  seed-cp3)
    : "${BASE_URL:?BASE_URL is required}"
    node "$DIR/../seed/seed.mjs" --stage cp3 --manifest "$SEED_MANIFEST" ${RESULT_JSON:+--result "$RESULT_JSON"} || exit 2
    exit 0 ;;
  cp[1-5]) from=${arg#cp}; to=$from ;;
  cp[1-5]-cp[1-5]) from=${arg%%-*}; from=${from#cp}; to=${arg##*-cp} ;;
  *) echo "usage: $0 cpN | cp1-cpN | seed-cp3" >&2; exit 64 ;;
esac
: "${RESULT_JSON:?RESULT_JSON is required}"

files=()
i=$from
while [ "$i" -le "$to" ]; do
  files+=("tests/cp$i.spec.ts" "tests/probes-cp$i.spec.ts")
  if [ "$i" -eq 4 ] && { [ -f "$SEED_MANIFEST" ] || [ "${REUSED_DB:-}" = "1" ]; }; then
    files+=("tests/migration-cp4.spec.ts")
  fi
  i=$((i + 1))
done
exec "$DIR/lib/run-suite.sh" "acceptance-$arg" "$DIR/tests" "${files[@]}"
