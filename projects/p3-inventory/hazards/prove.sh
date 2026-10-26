#!/usr/bin/env bash
# Proves that every hazard test fails against a deliberately unsafe variant (plan/CONTRACT.md; PROOF.md).
#   hazards/prove.sh [scratch-dir]      (default: <project>/tmp/prove)
# For the reference and for each hazards/unsafe/uNN-*.patch: clone reference/ (with node_modules), apply the patch,
# boot on a fresh DB (u11: on a CP3 database written by reference+stages/cp3.patch, seeded with run.sh seed-cp3),
# run hazards/run.sh cp5 and record the failing hazard ids in <scratch>/summary.json.
set -u
HZ=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$HZ/.." && pwd)
OUT=${1:-$P/tmp/prove}
API=4320 WEB=4321
APP="$P/tools/app.sh"
NODE22="$HOME/.nvm/versions/node/v22.23.3/bin"
[ -d "$NODE22" ] && export PATH="$NODE22:$PATH"
[ -z "${ONLY:-}" ] && rm -rf "$OUT"; mkdir -p "$OUT"

clone() { # clone <src> <dst>: copy-on-write copy including node_modules
  cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"
}

# CP3-era database for the migration hazard.
CP3="$OUT/cp3"
rm -rf "$CP3"
clone "$P/reference" "$CP3"
(cd "$CP3" && patch -p1 -E -s <"$P/stages/cp3.patch") || { echo "stages/cp3.patch failed" >&2; exit 2; }
mkdir -p "$OUT/cp3db"
"$APP" start "$CP3" $API $WEB "$OUT/cp3db/app.db" "$OUT/cp3-app.log" || { echo "stage cp3 did not boot" >&2; exit 2; }
BASE_URL="http://localhost:$WEB" DB_PATH="$OUT/cp3db/app.db" RESULT_JSON="$OUT/cp3-seed.json" "$P/acceptance/run.sh" seed-cp3
"$APP" stop $API $WEB

run_variant() { # run_variant <name> <patch|-> <db: fresh|cp3>
  local name=$1 patch=$2 db=$3 dir="$OUT/$1"
  clone "$P/reference" "$dir/app" 2>/dev/null || { mkdir -p "$dir"; clone "$P/reference" "$dir/app"; }
  if [ "$patch" != "-" ]; then (cd "$dir/app" && patch -p1 --forward -s <"$patch") || { echo "$name: patch failed" >&2; return; }; fi
  mkdir -p "$dir/db"
  if [ "$db" = cp3 ]; then
    for f in "$OUT"/cp3db/app.db*; do cp "$f" "$dir/db/"; done
  fi
  if ! "$APP" start "$dir/app" $API $WEB "$dir/db/app.db" "$dir/app.log"; then
    echo "{\"variant\":\"$name\",\"booted\":false}" >"$dir/result.json"; "$APP" stop $API $WEB; return
  fi
  local extra=""
  [ "$db" = cp3 ] && extra="REUSED_DB=1"
  env $extra BASE_URL="http://localhost:$WEB" DB_PATH="$dir/db/app.db" RESULT_JSON="$dir/hazards.json" "$HZ/run.sh" cp5
  "$APP" stop $API $WEB
  rm -rf "$dir/app"
}

# ONLY="u03 u05" limits the run to those variants (the reference baseline is skipped then).
if [ -z "${ONLY:-}" ]; then mkdir -p "$OUT/reference"; run_variant reference - cp3; fi
for patch in "$HZ"/unsafe/u*.patch; do
  name=$(basename "$patch" .patch)
  if [ -n "${ONLY:-}" ] && ! echo " $ONLY " | grep -q " ${name%%-*} "; then continue; fi
  mkdir -p "$OUT/$name"
  case "$name" in u11-*) db=cp3 ;; *) db=fresh ;; esac
  run_variant "$name" "$patch" "$db"
done

node - "$OUT" <<'NODE'
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const summary = {};
for (const d of fs.readdirSync(out)) {
  const f = path.join(out, d, 'hazards.json');
  if (!fs.existsSync(f)) continue;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  summary[d] = { passed: r.passed, total: r.total, failed: r.tests.filter((t) => t.status !== 'pass').map((t) => t.id) };
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${v.passed}/${v.total} failed=[${v.failed.join(',')}]`);
NODE
