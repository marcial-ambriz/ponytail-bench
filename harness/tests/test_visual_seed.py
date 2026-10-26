import os
import sys

from bench.visual import run_seed

FLAKY = """import sys
from pathlib import Path
c = Path(sys.argv[1])
n = int(c.read_text()) if c.exists() else 0
c.write_text(str(n + 1))
sys.exit(0 if n + 1 >= int(sys.argv[2]) else int(sys.argv[3]))
"""


def _seed(tmp_path, succeed_on, fail_code=75):
    script = tmp_path / "seed.py"
    script.write_text(FLAKY)
    return [sys.executable, "-I", str(script), str(tmp_path / "count"), str(succeed_on), str(fail_code)]


def test_seed_retries_until_the_api_answers(tmp_path):
    res = run_seed(_seed(tmp_path, 3), tmp_path, dict(os.environ), tmp_path / "seed.log", waits=(0, 0, 0))
    assert res == {"ok": True, "attempts": 3}


def test_seed_reports_failure_after_last_attempt(tmp_path):
    res = run_seed(_seed(tmp_path, 9), tmp_path, dict(os.environ), tmp_path / "seed.log", waits=(0, 0))
    assert res == {"ok": False, "attempts": 3}


def test_seed_is_not_rerun_after_a_real_failure(tmp_path):
    # a non-temporary failure may have seeded part of the data; running again would duplicate it
    res = run_seed(_seed(tmp_path, 3, fail_code=1), tmp_path, dict(os.environ), tmp_path / "seed.log", waits=(0, 0, 0))
    assert res == {"ok": False, "attempts": 1}
