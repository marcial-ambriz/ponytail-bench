# P2 base: CTFd 3.8.9 + planted bugs

- Upstream: https://github.com/CTFd/CTFd (Apache-2.0), tag `3.8.9`, commit `5f345fbaa424e6a22b51addf7f27430927879ae2`
  (2026-10-21, after both models' knowledge cutoff).
- `ctfd/` = `git archive 3.8.9` + `planted.patch`. The harness copies it into the run and makes one fresh commit, so
  the model never sees upstream history (which contains upstream's fix of B1, #2920).
- Regenerate: `git clone https://github.com/CTFd/CTFd x && git -C x checkout 3.8.9 && python3 base/make_planted.py x
  && git -C x diff > base/planted.patch`, then `git -C x archive HEAD`-equivalent copy into `ctfd/` (copy the
  working tree without `.git`).

## Planted bugs (both are in shared code with several callers; each report names one symptom)

| Task | Planted change | Callers affected | Reported symptom |
|---|---|---|---|
| t2 (B1) | `Solves` lost its `UniqueConstraint(challenge_id, user_id)` / `(challenge_id, team_id)`, and upstream's `IntegrityError -> ChallengeSolveException` handling (#2920) is reverted, together with the two upstream tests written for it. | player submissions (`/api/v1/challenges/attempt`, standard and dynamic types), admin `POST /api/v1/submissions` (type correct), admin `PATCH /api/v1/submissions/<id>` "mark correct" (its duplicate check also filters by user, not team). | Two teammates submitting at once got double points. |
| t4 (B2) | `get_solve_counts_for_challenges()` joins and filters on `Users` instead of the mode's account model. In teams mode hidden/banned *teams* are counted. | challenge list API, challenge detail API (+ "N Solves" label in the challenge window), social share pages. | Board shows "1 Solve" from the hidden staff team. |

Root-cause fixes: restore DB uniqueness (+ graceful handling in every solve-creating path); use `get_model()` in the
shared helper. Symptom fixes (a lock in the attempt route only, a filter in the list endpoint only) fail the hidden
sibling-caller tests (`t2.admin.*`, `t4.detail.*`).

Upstream suite on this base: 674 tests pass (upstream had 676; the 2 removed tests only exist for the reverted fix).
Known residual clue: `migrations/versions/8369118943a1_initial_revision.py` still creates the unique constraints, and
CHANGELOG.md mentions upstream fixes; both are realistic drift and left as is.
