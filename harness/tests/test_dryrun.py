"""End-to-end: the whole pipeline against the fixture project's reference, zero model calls."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from bench import agents, config, runner

FIX = Path(__file__).parent / "fixtures" / "fake-project"


@pytest.fixture
def no_models(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("a model CLI was invoked during a dry run")
    monkeypatch.setattr(agents.CliAgent, "turn", boom)
    real_run = subprocess.run

    def guarded(cmd, *a, **k):
        exe = Path(str(cmd[0] if isinstance(cmd, (list, tuple)) else str(cmd).split()[0])).name
        assert exe not in ("claude", "codex"), f"model CLI invoked: {cmd}"
        return real_run(cmd, *a, **k)
    monkeypatch.setattr(subprocess, "run", guarded)


def paths(tmp_path):
    return config.Paths(root=tmp_path / "work", port_base=41000 + (hash(str(tmp_path)) % 400) * 20)


def test_dry_run_reference_scores_full_marks_with_zero_model_calls(tmp_path, no_models):
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    out = runner.dry_run(proj, paths(tmp_path), visual=False)
    assert out["model_calls"] == 0
    assert out["selftest"]["ok"], out["selftest"]["problems"]
    assert len(out["runs"]) == 3  # one block, all three arms
    run = next(iter(out["runs"].values()))
    cp1, cp2 = run["checkpoints"]["cp1"], run["checkpoints"]["cp2"]
    for cp in (cp1, cp2):
        assert cp["criteria"]["C1"]["rating"] == pytest.approx(5)
        assert cp["criteria"]["C2"]["rating"] == pytest.approx(5)
    assert cp2["pr"]["pr"] == 100 and set(cp2["pr"]["by_category"]) == {"concurrency", "validation"}
    # cp2 reused the DB seeded after cp1: the migration check ran and passed
    assert any(t["id"] == "cp2-migrated-data" and t["status"] == "pass" for t in cp2["acceptance_tests"])
    assert run["c6"]["valid"] == 2 and run["c6"]["caught"] == 1  # own tests cover validation only
    assert run["total"]["S"] is not None
    assert run["suite_sha256"] == out["suite_sha256"]
    assert out["ledger"]["billed_usd"] == 0
    st = json.loads(Path(out["state_dir"], run["run_id"], "state.json").read_text())
    assert st["checkpoints"]["cp1"]["validations"][0]["suite_sha256"] == out["suite_sha256"]
    assert st["checkpoints"]["cp1"]["turns"][0]["attempts"][0]["usage"]["input"] == 0


def test_hidden_suite_never_copied_into_working_copies(tmp_path, no_models):
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    out = runner.dry_run(proj, paths(tmp_path), visual=False)
    for rid in out["runs"]:
        wc = Path(out["runs_dir"], rid, "wc")
        names = {p.name for p in wc.rglob("*")}
        assert "check.py" not in names and "m1.patch" not in names and "task.md" not in names
        assert (wc / "SPEC" / "cp2.md").exists()


def test_selftest_fails_when_reference_breaks_a_protection(tmp_path, no_models):
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    subprocess.run(["git", "apply", "--directory=reference", str(proj / "mutations/m2.patch")], cwd=proj, check=True)
    out = runner.dry_run(proj, paths(tmp_path), visual=False, arms_subset=["base"])
    assert not out["selftest"]["ok"]
    assert any("PR" in p or "acceptance" in p for p in out["selftest"]["problems"])


def _add_cp1_stage(proj):
    """Give the fixture a real per-checkpoint reference state: the cp1-era code keeps a legacy table that only the
    final reference migrates, so the cp2 migration check passes only if cp1 really ran the cp1-era code."""
    ref = proj / "reference"
    logic = ref / "logic.py"
    final_src = logic.read_text()
    migrate = (
        "    if db.execute(\"SELECT 1 FROM sqlite_master WHERE name='legacy_cp1'\").fetchone():\n"
        "        db.execute(\"INSERT INTO items (name, qty) VALUES ('migrated-from-cp1', 1)\")\n"
        "        db.execute('DROP TABLE legacy_cp1')\n"
        "    return db\n")
    logic.write_text(final_src.replace("    return db\n", migrate, 1))
    (ref / "FINAL_ONLY.md").write_text("added after cp1\n")
    stg = proj / "stg"
    shutil.copytree(ref, stg, ignore=shutil.ignore_patterns("__pycache__"))
    legacy = ("    db.execute('CREATE TABLE IF NOT EXISTS legacy_cp1 (x INTEGER)')\n"
              "    return db\n")
    (stg / "logic.py").write_text(final_src.replace("    return db\n", legacy, 1))
    (stg / "STAGE_MARKER").write_text("cp1-era reference\n")
    (stg / "FINAL_ONLY.md").unlink()
    (proj / "stages").mkdir()
    d = subprocess.run(["diff", "-ruN", "-x", "__pycache__", "reference", "stg"], cwd=proj, capture_output=True,
                       text=True)
    (proj / "stages" / "cp1.patch").write_text(d.stdout)
    shutil.rmtree(stg)
    chk = proj / "acceptance" / "check.py"
    chk.write_text(chk.read_text().replace(
        '        check("cp2-migrated-data", "R2.4", "C1", migrated)\n',
        '        check("cp2-migrated-data", "R2.4", "C1", migrated)\n'
        '        check("cp2-stage-migrated", "R2.5", "C1", lambda: (any(i.get("name") == "migrated-from-cp1"\n'
        '              for i in call("GET", "/items")[1] or []), "cp1-era table migrated"))\n'
        '        check("cp2-seed-snapshot", "R2.6", "C1", lambda: (os.path.exists(os.environ["DB_PATH"]\n'
        '              + ".p3-seed.json"), "seed snapshot travelled with the DB"))\n'))
    seed = proj / "migration" / "seed.sh"
    seed.write_text(seed.read_text().replace("exec python3", 'echo \'{"seeded":1}\' > "$DB_PATH.p3-seed.json"\n'
                                                           "exec python3"))


def test_dry_run_applies_per_checkpoint_reference_states(tmp_path, no_models):
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    _add_cp1_stage(proj)
    out = runner.dry_run(proj, paths(tmp_path), visual=False, arms_subset=["base"])
    assert out["selftest"]["ok"], out["selftest"]["problems"]
    run = next(iter(out["runs"].values()))
    cp2 = run["checkpoints"]["cp2"]
    ids = {t["id"]: t["status"] for t in cp2["acceptance_tests"]}
    assert ids.get("cp2-stage-migrated") == "pass" and ids.get("cp2-seed-snapshot") == "pass", ids
    wc = Path(out["runs_dir"], run["run_id"], "wc")
    files_at = lambda tag: subprocess.run(["git", "-C", str(wc), "ls-tree", "-r", "--name-only", tag],
                                          capture_output=True, text=True).stdout.split()
    assert "STAGE_MARKER" in files_at("bench-cp1") and "FINAL_ONLY.md" not in files_at("bench-cp1")
    assert "STAGE_MARKER" not in files_at("bench-cp2") and "FINAL_ONLY.md" in files_at("bench-cp2")


def test_dry_run_leases_ports_and_releases_them(tmp_path, no_models, monkeypatch):
    gdir = tmp_path / "global"
    monkeypatch.setenv("BENCH_GLOBAL_DIR", str(gdir))
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    out = runner.dry_run(proj, config.Paths(root=tmp_path / "work"), visual=False, arms_subset=["base"])
    assert out["selftest"]["ok"], out["selftest"]["problems"]
    log = Path(out["state_dir"], "px-fake-sonnet-base-r1", "orchestrator.log").read_text()
    assert "ports={'api_port': 4700" not in log
    assert (gdir / "ports").is_dir() and not list((gdir / "ports").glob("*.json"))


def test_benchctl_dry_run_does_not_pin_a_port_base(tmp_path, monkeypatch):
    import benchctl
    seen = {}

    def fake(project_dir, paths, **kw):
        seen["paths"] = paths
        Path(paths.root).mkdir(parents=True, exist_ok=True)
        return {"selftest": {"ok": True, "problems": []}, "runs": {}, "model_calls": 0}
    monkeypatch.setattr(benchctl.runner, "dry_run", fake)
    monkeypatch.setattr(benchctl, "HARNESS", tmp_path)
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    assert benchctl.main(["dry-run", "--project-dir", str(proj), "--no-visual"]) == 0
    assert seen["paths"].port_base is None
