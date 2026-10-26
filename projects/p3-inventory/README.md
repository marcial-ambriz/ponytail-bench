# P3 — Stockly: inventory with evolving requirements (TypeScript)

Pre-registration: `plan/plan.md` §5 P3. Contract: `plan/CONTRACT.md`. Same stack and scaffold as round 1 (pnpm +
Turbo, Hono + Zod, React 19 + Vite + Tailwind 4 + TanStack, SQLite, better-auth). Weights 10/15/20/35/20: CP4 changes
the data model (warehouses + variants) and must migrate the CP3 database in place, so it measures the cost of change.

| Path | What |
|---|---|
| `base/` | Starting scaffold (round-1 scaffold renamed "Stockly"; no spec inside: the harness adds `spec/cpN.md`). |
| `spec/cp1..cp5.md` | Checkpoint specs, revealed one at a time. Requirement ids `R<cp>.<n>`. CP4 is not hinted earlier. |
| `reference/` | Full reference implementation at CP5, including the v3 → v4 migration (`apps/api/src/db.ts`). |
| `stages/cp3.patch` | Turns a copy of `reference/` into the CP3-era reference (real CP3 schema), for migration proofs. |
| `acceptance/` | Hidden Playwright suite. `run.sh cpN` (one checkpoint; the harness runs every cp ≤ current), `run.sh seed-cp3`. Titles `[cpN.nn][R..][C2|C5]`. |
| `acceptance/tests/migration-cp4.spec.ts` | CP4 check that the data seeded through the CP3 API survived the migration. |
| `seed/seed.mjs` | API-only seed. `--stage cp3 --manifest <file>`: CP3-era data + snapshot of the app's answers. Default stage `screens`: fixed demo data/users for screenshots and the UX agent. |
| `hazards/` | Hazard suite (`run.sh [cpN]`, titles `[Hnn][category:severity][cpN][R..]`), `PROOF.md`, unsafe variants in `unsafe/`, `prove.sh`. |
| `mutations/` | `m1..m4.patch` + `README.md` (C6). |
| `maintenance/` | `task.md` (cycle counts), hidden tests (`run.sh`), `reference.patch` (implementation used to validate them). |
| `screens.json`, `visual/` | Screens per checkpoint (`cp` field), auth module, absolute anchors 0/3/5. |
| `ux-tasks.md` | UX agent script. |
| `tools/` | `app.sh` (local boot), `selftest.sh` (reference self-test incl. real migration), `anchors.mjs`. |

## Migration flow (harness)

`cp3` has `persist_db` + `seed_after: acceptance/run.sh seed-cp3`: after the CP3 validation the seed runs against the
model's CP3 app and writes its snapshot to `$DB_PATH.p3-seed.json`, i.e. next to the database, so it travels with the
persisted `app.db*` files into the CP4 validation (`reuse_db_from: cp3`, `REUSED_DB=1`). There, `acceptance/run.sh cp4`
adds `migration-cp4.spec.ts` and `hazards/run.sh cp4` adds H18 whenever that snapshot exists or `REUSED_DB=1` (a
missing snapshot then fails loudly). On a fresh database (CP5, mutations, maintenance) both are skipped.

Runners write only `RESULT_JSON`, a scratch dir under `<project>/tmp/` (deleted after the run), the seed snapshot next
to `DB_PATH`, and `acceptance/node_modules` on first use (`npm ci`). Node 22 is expected on PATH.
