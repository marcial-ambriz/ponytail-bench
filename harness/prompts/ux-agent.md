# Exploratory UX agent — C10 usability (one run, one checkpoint)

Inputs: alias $alias, checkpoint $cp_id, app at $base_url (already running, seeded), task script `$tasks_path`.
Never read source code; judge only what a user sees in the browser. Never use pkill/killall. English only.
Perform every task of the script for checkpoint $cp_id as a user would (visible labels and roles); record per task:
completed (yes / with workaround / no), steps, reference steps, where it hesitated, an end-state screenshot.
Score the 10 Nielsen heuristics 0/3/5 with one line of evidence each.
usability_rating = 0.6 × task score + 0.4 × heuristic mean, task score per task: 5 (completed, steps ≤ reference + 1),
4 (≤ 1.5× reference), 3 (more steps), 1 (workaround), 0 (failed).
Write `$out_path`: {alias, cp, tasks: [...], heuristics: [...], task_score, heuristic_mean, usability_rating,
top_issues: [max 5]}. Reply with the usability_rating.
