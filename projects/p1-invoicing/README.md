# P1 Ledgerly: multi-tenant invoicing and payments (greenfield with traps)

Round-2 benchmark project. `project.json` is the harness entry point (plan/CONTRACT.md plus harness extensions).

| Path | What it is | Given to the model? |
|---|---|---|
| `base/` | Starting scaffold (round 1's Bookly scaffold, renamed; no features) | yes (working copy) |
| `spec/cp1.md`..`cp5.md` | Checkpoint specs with requirement IDs; the harness copies each into `SPEC/` | yes, one per checkpoint |
| `reference/` | Complete implementation of all checkpoints, no skill | no |
| `acceptance/` | Hidden UI (C1/C5) + API probe (C2) Playwright tests, `run.sh [--only] cpN` | no |
| `hazards/` | Hidden hazard tests `[H:category:severity]`, `run.sh cpN` (cumulative), `PROOF.md` | no |
| `mutations/` | `m1..m4.patch` + README (C6) | no |
| `maintenance/` | `task.md` (credit notes), hidden tests, `run.sh`, `solution.patch` (validates the tests) | task only |
| `screens.json`, `visual/` | 20 screens with `cp`, auth module, anchors 0/3/5 | no |
| `seed/seed.py` | Deterministic mock data through the public API (any checkpoint) | no |
| `ux-tasks.md` | UX agent task script (CP3, CP5) | no |
| `support/`, `playwright.config.ts`, `package.json` | Shared test kit and runner (`support/run-suite.sh`) | no |

Runners follow CONTRACT.md: env `BASE_URL`, `API_URL`, `WORKDIR`, `RESULT_JSON`; they write only `RESULT_JSON` and
`results/`. Install the kit once with `npm ci` here (Playwright 1.64.1, Chromium).
