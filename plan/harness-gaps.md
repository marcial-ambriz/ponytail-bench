# Harness gaps for round 2

Round 1 harness: `~/Projects/ponytail-bench-worktrees/.harness/`. Each item names the current behavior (file) and the
required change. Ordered by how badly it blocks the pre-registered design.

## A. Blocking: the design cannot run without these

1. **Run matrix is hard-coded to 4 models × 2 arms.** `orchestrate.py` `MODELS`, `ARMS = ("skill", "base")`,
   `RUN_IDS`; `score.py` `MODELS`, `RUNS`. Change to `sonnet`, `luna` × `base`, `ponytail`, `placebo` × `p1..p3` × `r1..r3`
   with run id `{project}-{model}-{arm}-r{rep}`. `Run.__init__` splits on the last `-` and derives ports from
   `RUN_IDS.index` (3200 + idx×10): both break with 54 ids. Use a slot-based port pool.
2. **Single project, single repo, pnpm-only.** `REPO`, `CHECKPOINTS`, the `docs/SPEC.md` prompt, `pnpm lint/test/dev` in
   `_validate` and `run-acceptance.sh` are fixed. Add a per-project config (repo, spec path, checkpoint/task list and
   weights, lint/test/dev/install commands, ports env names). P2 needs a Python runner (uv/pip install, pytest, its own
   dev server command).
3. **Third arm (placebo).** `INVOCATION` and `SKILL_MARKER` are per provider, not per arm; `prompt()` only prefixes for
   `arm == "skill"`; `setup()` copies only `PONYTAIL_SKILLS`. Make both maps per arm (`/steady full`, `$steady full`,
   placebo marker text) and copy the placebo skill dir for that arm. Invalidate a run when any turn's marker check is
   false (today it is only recorded in the PR body).
4. **Billing is not real API billing.** Claude runs use `CLAUDE_CODE_OAUTH_TOKEN` (subscription); `total_cost_usd` is a
   client-side estimate. Codex copies `~/.codex/auth.json`. `score.py` `PRICING` is a placeholder
   (`PRICING_IS_PLACEHOLDER = True`). Switch to API keys in a dedicated Anthropic workspace and OpenAI project used only by
   the study, pull invoiced usage from the providers' usage/cost reports per day, and reconcile with token×list-price
   per run (report > 5% drift). Delete the placeholder table.
5. **Cost excludes harness-failure turns.** `collect()` builds `cost_usd_adjusted` by dropping fix turns matched to
   `INCIDENTS`; C8 uses the adjusted value. Round 2: C8 uses all turns. Harness bugs invalidate and rerun the whole run
   instead of being subtracted. Keep the incident classifier only for the deviations log.
6. **Rate-limit retries lose cost.** `turn()` reruns the command after a rate limit and reopens the `.jsonl` with `"w"`,
   so the partial attempt's tokens are overwritten and never counted. Append per attempt and sum all attempts.
7. **No budget guard.** There is no global ledger, no 50%/80% alert, no per-run stop-loss. Add a ledger
   (`.state/ledger.json`, every model/judge/maintenance/UX call) checked before every turn; pause at 300 and 480 USD;
   stop-loss Sonnet 15 / luna 25 USD per run; refuse to launch a block whose projection exceeds 600. Mid-turn: Claude
   stream-json gives running usage; Codex emits usage only at `turn.completed`, so the per-turn ceiling there is the
   90-min timeout plus a token-rate watchdog on streamed items. Check whether each CLI has a native budget flag and use
   it if it does.
8. **Hidden suite can change mid-study.** CP1 had 25 tests for Sonnet and 17 for others because the suite was edited
   between runs. Freeze: a sha256 manifest of every test file, published before running; `run-acceptance.sh` refuses to
   run on a mismatch and writes the manifest hash into `summary.json`; `score.py` asserts one hash per checkpoint across
   all runs. Replace the time-window incident cut-offs in `score.py` `INCIDENTS` with this policy.
9. **Hazard suite does not exist.** Add a `[H:<category>:<severity>]` title tag, separate spec files per checkpoint,
   `summary.json` counts per category, cumulative per checkpoint, never counted in C1/C2. `score.py` computes PR (§6.2 of
   the plan).
10. **Fresh DB on every validation.** `run-acceptance.sh` does `rm -rf "$DB_DIR"` each time. P3-CP4 migration tests need
    a seeded DB carried from the CP3 validation into CP4: add a "persist seed" step at the end of CP3 and a
    `--reuse-db` mode for the CP4 migration specs.
11. **Maintenance phase does not exist.** New orchestrator command: copy the blinded final tree, fresh Sonnet session, no
    skill, fixed prompt, 1 turn + ≤ 2 fixes with the feature's hidden tests, record cost/turns/pass/regressions, rerun the
    hazard suite after it.
12. **Statistics assume pairs.** `score.py` `pair_metrics` (C8 geomean of 2 arms), `deltas()`, the round-1 win rule
    (`total ≥ +5 and correctness ≥ −3`). Replace with block-level (3-arm) geomean, the 3-condition success rule,
    sign-flip permutation (512 per model), stratified block bootstrap, and per-cell median/range output.

## B. Scoring method changes

13. **C10 visual was judged once and copied to every checkpoint.** `visual-c10.json` has the same value for CP1–CP5
    (e.g. run-A 3.5 everywhere) and was judged side by side across the 8 runs (relative). Judge each checkpoint against
    fixed anchor screenshots (absolute 0/3/5), and add automated checks (overflow at 390 px already in
    `screens/index.json`; add axe contrast, target size ≥ 24 px, empty/error state presence). New formula
    `C10v = 3×judge/5 + 2×checks`. Screen lists per project.
14. **C6 mutations were applied freely by an agent** (`mutation-prompt.md`). Make them predefined per project (4–5),
    store each applied patch, and accept a mutant only if it fails at least one hidden test (validity check).
15. **C3/C4 are labeled "human, blind" but were AI-proposed + human-confirmed.** Make the procedure explicit: two
    non-subject judges, disagreement threshold 1.5, human review per the sampling plan, kappa reported.
16. **C9 stays "provisional".** Feed the human dependency review (`human-c3c4.json` `c9_unjustified`) for every run; for
    P2 the baseline is the project's own lockfile, not an empty scaffold.
17. **Blinding strips only `ponytail:` comments.** Also strip `steady`/placebo log formats and the structured summary
    shape from any artifact judges see; regenerate `aliases.json` from the seed and publish only its hash.
18. **UX agent task script is Bookly-only** (`ux-tasks.md`, `ux-inputs.py`, `capture-screens.mjs` seed users). Write per
    project scripts and seeds; count its cost in the ledger.

## C. Reliability and hygiene

19. **Concurrent runs share one machine.** Round 1 launched all runs in parallel threads; race probes and boot timing
    depend on load. Cap at 2 blocks (6 runs); retry a failing race probe once on an idle machine before recording it.
20. **Model snapshot not recorded.** Store the model id each response reports; flag a mid-study change.
21. **Randomization does not exist.** Add a seeded scheduler (block order per rep, arm start order, ports, aliases) and
    the rep-major execution order.
22. **Pre-flight dry run.** Add a `selftest` command that scores the reference implementations and known-mutated copies
    with no model, and fails if scores fall outside expected bands.
23. **Publication scrubbing.** Transcripts contain absolute home paths, tokens in env dumps, machine names. Add a
    scrubber before export; never publish `claude-token` or `auth.json` contents.
24. **PR volume.** 54 runs × 5 PRs = 270 chained PRs; add backoff and allow one repo per project.
25. **Session isolation for Codex** relies on a fake `HOME`; verify no user-level skills, plugins or `AGENTS.md` reach any
    arm (round 1 incident 1 came from this fake HOME). Same check for `claudeMdExcludes` on the Claude side.
