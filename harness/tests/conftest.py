import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _private_global_dir(tmp_path, monkeypatch):
    """Machine-wide locks and port leases live in BENCH_GLOBAL_DIR; tests use their own."""
    monkeypatch.setenv("BENCH_GLOBAL_DIR", str(tmp_path / "bench-global"))
