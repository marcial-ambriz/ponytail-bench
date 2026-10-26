# Round 2 shared contract (harness <-> projects)

Repo: ~/Projects/ponytail-bench-r2 (local only; nobody pushes or commits — the coordinator commits).
Round 1 harness for reference (read-only): ~/Projects/ponytail-bench-worktrees/.harness/ and base app repo ~/Projects/ponytail-bench (read-only).
Never read, copy or print ~/Projects/ponytail-bench-worktrees/.homes/ (credentials). No paid API calls, no benchmark runs.

## Layout
- plan/        plan.md, placebo-SKILL.md, harness-gaps.md, CONTRACT.md
- harness/     generic runner, scoring, cost accounting (owned by harness agent)
- projects/<id>/  one folder per project (p1-invoicing, p2-ctfd, p3-inventory), owned by its project agent

## projects/<id>/project.json
{
  "id": "p1-invoicing",
  "language": "typescript" | "python",
  "base": {"type": "dir", "path": "base/"} | {"type": "git", "repo": "<url>", "commit": "<sha>"},
  "setup": ["<shell cmd run in the working copy>"],
  "start": {"cmd": "<shell cmd>", "env": ["API_PORT", "WEB_PORT", "DB_PATH"], "health_url": "http://localhost:${WEB_PORT}/"},
  "checkpoints": [
    {"id": "cp1", "weight": 10, "spec": "spec/cp1.md", "acceptance": "acceptance/run.sh cp1"}
  ],
  "hazards": {"run": "hazards/run.sh", "categories": ["concurrency", "idempotency", "authz", "validation", "data-loss"]},
  "mutations": {"dir": "mutations/", "count": 4},
  "maintenance": {"task": "maintenance/task.md", "acceptance": "maintenance/run.sh"},
  "visual": {"screens": "screens.json"},
  "reference": "reference/"
}
Checkpoint weights sum to 100. P2 (brownfield) uses tasks instead of checkpoints but keeps the same "checkpoints" array (one entry per task group, weights sum to 100).

## Test runner protocol (acceptance, hazards, maintenance)
- Invoked as `<script> [args]` with env BASE_URL (web), API_URL, WORKDIR (the run's working copy) and RESULT_JSON (output path).
- Writes RESULT_JSON: {"passed": n, "total": n, "tests": [{"id": "...", "requirement": "R1.3", "category": "...", "status": "pass"|"fail", "message": "..."}]}
- Exit code 0 even when tests fail (non-zero only for runner errors). Hidden from the model: these folders are never copied into the run's working copy.
- Every project must ship a reference implementation that passes 100% of acceptance and hazard tests, and must prove each hazard test fails against a deliberately unsafe variant (document in hazards/PROOF.md).

## screens.json
[{"id": "login", "title_es": "Inicio de sesión", "role": "anon|member|admin", "path": "/login", "actions": "optional playwright steps"}]

## mutations/
Exactly 4 patch files (`m1.patch`..`m4.patch`) applied to the reference server code paths that a sane implementation must have; each with a one-line description in mutations/README.md. Used to score C6 against the model's own tests (applied by behavior description, not by line, since run code differs — follow round 1's mutation-prompt.md approach).
