#!/usr/bin/env bash
# Reference self-test for P3, including a REAL v3 -> v4 migration (the harness dry run copies only the final
# reference, so its CP3 database is already v4). Mirrors the harness order per validation.
#   tools/selftest.sh [scratch-dir]      (default <project>/tmp/selftest)
#   1. CP3 reference (reference + stages/cp3.patch), fresh DB: acceptance cp1, cp2, cp3 + hazards cp3, then seed-cp3
#   2. final reference on a copy of that DB (REUSED_DB=1): acceptance cp1..cp4 + hazards cp4
#   3. final reference, fresh DB: acceptance cp1..cp5 + hazards cp5
#   4. reference + maintenance/reference.patch, fresh DB: maintenance + acceptance cp1..cp5 + hazards cp5
set -u
P=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$P/tmp/selftest}
API=4360 WEB=4361
APP="$P/tools/app.sh"
NODE22="$HOME/.nvm/versions/node/v22.23.3/bin"
[ -d "$NODE22" ] && export PATH="$NODE22:$PATH"
rm -rf "$OUT"; mkdir -p "$OUT"
export BASE_URL="http://localhost:$WEB" API_URL="http://localhost:$API"
clone() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }
summary=()
record() { summary+=("$1: $(node -e 'const r=require(process.argv[1]);const f=r.tests.filter(t=>t.status!=="pass").map(t=>t.id);console.log(`${r.passed}/${r.total}`+(f.length?` FAILED ${f.join(",")}`:""))' "$2")"); }

acc() { # acc <label> <cp> <db>
  DB_PATH="$3" RESULT_JSON="$OUT/$1-$2.json" "$P/acceptance/run.sh" "$2" >/dev/null && record "$1 acceptance $2" "$OUT/$1-$2.json"
}
haz() {
  DB_PATH="$3" RESULT_JSON="$OUT/$1-hazards-$2.json" "$P/hazards/run.sh" "$2" >/dev/null && record "$1 hazards $2" "$OUT/$1-hazards-$2.json"
}

# 1. CP3-era reference
clone "$P/reference" "$OUT/cp3"
(cd "$OUT/cp3" && patch -p1 -E -s <"$P/stages/cp3.patch") || exit 2
mkdir -p "$OUT/db3"
"$APP" start "$OUT/cp3" $API $WEB "$OUT/db3/app.db" "$OUT/cp3.log" || exit 2
for cp in cp1 cp2 cp3; do acc stage3 $cp "$OUT/db3/app.db"; done
haz stage3 cp3 "$OUT/db3/app.db"
DB_PATH="$OUT/db3/app.db" RESULT_JSON="$OUT/seed.json" "$P/acceptance/run.sh" seed-cp3 >/dev/null && record "stage3 seed-cp3" "$OUT/seed.json"
"$APP" stop $API $WEB

# 2. final reference on the migrated CP3 database
mkdir -p "$OUT/db4"
cp "$OUT"/db3/app.db* "$OUT/db4/"
"$APP" start "$P/reference" $API $WEB "$OUT/db4/app.db" "$OUT/cp4.log" || exit 2
export REUSED_DB=1
for cp in cp1 cp2 cp3 cp4; do acc migrated $cp "$OUT/db4/app.db"; done
haz migrated cp4 "$OUT/db4/app.db"
unset REUSED_DB
"$APP" stop $API $WEB

# 3. final reference, fresh database
mkdir -p "$OUT/db5"
"$APP" start "$P/reference" $API $WEB "$OUT/db5/app.db" "$OUT/cp5.log" || exit 2
for cp in cp1 cp2 cp3 cp4 cp5; do acc fresh $cp "$OUT/db5/app.db"; done
haz fresh cp5 "$OUT/db5/app.db"
"$APP" stop $API $WEB

# 4. maintenance reference
clone "$P/reference" "$OUT/maint"
(cd "$OUT/maint" && patch -p1 -s <"$P/maintenance/reference.patch") || exit 2
mkdir -p "$OUT/dbm"
"$APP" start "$OUT/maint" $API $WEB "$OUT/dbm/app.db" "$OUT/maint.log" || exit 2
DB_PATH="$OUT/dbm/app.db" RESULT_JSON="$OUT/maintenance.json" "$P/maintenance/run.sh" >/dev/null && record "maintenance feature" "$OUT/maintenance.json"
for cp in cp1 cp2 cp3 cp4 cp5; do acc maint $cp "$OUT/dbm/app.db"; done
haz maint cp5 "$OUT/dbm/app.db"
"$APP" stop $API $WEB
rm -rf "$OUT/cp3" "$OUT/maint"

printf '%s\n' "${summary[@]}" | tee "$OUT/summary.txt"
