from pathlib import Path

from bench.config import HARNESS, Paths


def test_pilot_paths_keep_main_frozen_dir():
    main = Paths()
    pilot = Paths(root=HARNESS / ".pilot", frozen_root=main.root)
    assert pilot.frozen == main.frozen
    assert pilot.state == HARNESS / ".pilot" / ".state"


def test_default_frozen_follows_root(tmp_path):
    assert Paths(root=tmp_path).frozen == Path(tmp_path) / "frozen"
