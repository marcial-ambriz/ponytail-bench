# P2 — CTFd brownfield (Python)

Upstream CTFd 3.8.9 (`5f345fbaa424e6a22b51addf7f27430927879ae2`, Apache-2.0, Flask + SQLAlchemy, SQLite) with two
planted bugs (see `base/README.md`). Five tasks, fixed order, 20 points each:

| id | type | spec | what it measures |
|---|---|---|---|
| t1 | feature | spec/t1.md | per-team member limit; atomic seat check under simultaneous joins; UI (team pages, admin form) |
| t2 | bug B1 | spec/t2.md | double points from simultaneous correct submissions; root cause = DB uniqueness, sibling callers = admin submission tools (H9) |
| t3 | feature | spec/t3.md | wrong-answer penalty: never negative, never charged twice (concurrency + idempotency) |
| t4 | bug B2 | spec/t4.md | hidden/banned teams counted in solve counts; root cause in a shared helper, report names one caller (H9) |
| t5 | feature | spec/t5.md | first-blood bonus; best solved by reusing Configs + Awards so every score surface updates (H8) |

## Layout

- `base/ctfd/` planted tree given to the model; `base/planted.patch`, `base/make_planted.py`, `base/README.md`.
- `spec/` the five issues. `reference/` overlay implementing all tasks (+ `REFERENCE.patch`, `REFERENCE.md`).
- `acceptance/` hidden tests (`run.sh <t1..t5|all>`, stdlib only, live server via BASE_URL; shared client in `lib/ctfd.py`).
- `hazards/` hidden protection tests (`run.sh <task>`: live hazards of tasks <= task + CTFd's own suite as
  `hz.regression.ctfd_suite`, run from the pristine `base/ctfd/tests` against WORKDIR's code inside `tmp/`),
  `PROOF.md`, `proof/` (unsafe variants + `prove.py`).
- `mutations/` m1..m4 + README. `maintenance/` follow-up feature (first blood per bracket) + hidden tests (+ its
  `REFERENCE.patch`). `seed/seed.py` mock data. `screens.json`, `visual/` (auth module, anchors), `ux/tasks.md`.

## Exact setup (in the working copy)

    uv venv -q --python 3.11 .venv          # CTFd pins are compiled for Python 3.11
    uv pip install -q --python .venv/bin/python -r development.txt
    # run (what the harness does; DB_PATH and WEB_PORT come from the harness):
    rm -rf .data/filesystem_cache
    DATABASE_URL="sqlite:///$DB_PATH" .venv/bin/python -m gunicorn 'CTFd:create_app()' \
      --bind 127.0.0.1:$WEB_PORT --worker-class gthread --workers 1 --threads 64 --timeout 120
    # CTFd's own suite:
    .venv/bin/python -m pytest -q -p no:randomly -n 4 tests

Notes: real threads (gthread) are required, with gevent the SQLite races never interleave and the concurrency
tests would be meaningless; 64 threads because every open page holds one for CTFd's `/events` stream. The filesystem
cache lives in `.data/` of the working copy and is cleared at start (it caches config and sessions per DB).
The test driver sends a per-client `X-Forwarded-For` (127.0.0.1 is a trusted proxy in CTFd) so CTFd's per-IP rate
limits do not throttle the driver itself. A fresh DB per validation is assumed (harness default).

## Verified (reference, 2026-10-25)

See the final report; numbers are recorded in `hazards/PROOF.md` and the harness dry-run.
