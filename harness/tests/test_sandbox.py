import subprocess

import pytest

from bench import sandbox
from bench.agents import CliAgent

pytestmark = pytest.mark.skipif(not sandbox.available(), reason="sandbox-exec not available")


@pytest.fixture
def tree(tmp_path):
    study = tmp_path / "study"
    (study / "projects" / "p1" / "acceptance").mkdir(parents=True)
    (study / "projects" / "p1" / "acceptance" / "cp1.spec.ts").write_text("hidden")
    (study / "runs" / "other" / "wc").mkdir(parents=True)
    (study / "runs" / "other" / "wc" / "app.ts").write_text("other run")
    wc = study / "runs" / "mine" / "wc"
    wc.mkdir(parents=True)
    (wc / "app.ts").write_text("my code")
    return study, wc


def run(cmd, deny, allow, cwd):
    return subprocess.run(sandbox.wrap(cmd, deny, allow), cwd=cwd, capture_output=True, text=True)


def test_own_working_copy_is_readable_and_writable(tree):
    study, wc = tree
    assert run(["cat", "app.ts"], [study], [wc], wc).stdout == "my code"
    assert run(["sh", "-c", "echo x > new.txt"], [study], [wc], wc).returncode == 0
    assert (wc / "new.txt").read_text() == "x\n"


def test_hidden_suite_and_other_runs_are_not_readable(tree):
    study, wc = tree
    assert run(["cat", str(study / "projects/p1/acceptance/cp1.spec.ts")], [study], [wc], wc).returncode != 0
    assert run(["cat", str(study / "runs/other/wc/app.ts")], [study], [wc], wc).returncode != 0
    assert run(["ls", str(study / "projects")], [study], [wc], wc).returncode != 0


def test_writes_outside_the_allowed_roots_are_blocked(tree):
    study, wc = tree
    assert run(["sh", "-c", f"echo x > {study}/projects/planted.txt"], [study], [wc], wc).returncode != 0
    assert not (study / "projects" / "planted.txt").exists()


def test_agent_command_is_wrapped_only_when_scoped(tmp_path):
    kw = dict(transcripts_dir=tmp_path / "t", ledger=None, guard=None, prices=None, run_id="r", model_key="sonnet")
    plain = CliAgent("claude", "m", "medium", tmp_path, tmp_path / "cfg", **kw)
    assert plain.command("hi", None, None)[0] == "claude"
    scoped = CliAgent("claude", "m", "medium", tmp_path, tmp_path / "cfg", read_scope=([tmp_path / "x"], []), **kw)
    cmd = scoped.command("hi", None, None)
    assert cmd[0] == "sandbox-exec" and "claude" in cmd
