import hashlib
import json
import shutil
from pathlib import Path

import pytest

from bench import arms, project, suite

FIX = Path(__file__).parent / "fixtures" / "fake-project"
HARNESS = Path(__file__).resolve().parents[1]


def copy_fixture(tmp_path):
    dst = tmp_path / "px-fake"
    shutil.copytree(FIX, dst)
    return dst


# ---------------------------------------------------------------- project.json
def test_fixture_project_loads_and_validates():
    p = project.load(FIX)
    assert p.id == "px-fake"
    assert [c["id"] for c in p.checkpoints] == ["cp1", "cp2"]
    assert p.weights == {"cp1": 40, "cp2": 60}
    assert project.validate(p) == []


def test_validation_catches_weights_missing_scripts_and_keys(tmp_path):
    d = copy_fixture(tmp_path)
    data = json.loads((d / "project.json").read_text())
    data["checkpoints"][0]["weight"] = 10
    data["hazards"]["run"] = "hazards/missing.sh"
    del data["start"]
    (d / "project.json").write_text(json.dumps(data))
    probs = project.validate(project.load(d, strict=False))
    assert any("sum to 100" in x for x in probs)
    assert any("hazards/missing.sh" in x for x in probs)
    assert any("start" in x for x in probs)
    with pytest.raises(project.ProjectError):
        project.load(d)


def test_command_resolution_is_relative_to_project_dir():
    p = project.load(FIX)
    argv = p.script_argv("acceptance/run.sh cp1")
    assert argv[0] == "bash" and argv[1] == str(FIX / "acceptance/run.sh") and argv[2] == "cp1"


# ---------------------------------------------------------------- arms: identical injection
def test_skill_arms_use_identical_mechanism_and_position(tmp_path):
    body = "Implement checkpoint cp1."
    for prov in ("claude", "codex"):
        pp = arms.build_prompt("ponytail", prov, body)
        pl = arms.build_prompt("placebo", prov, body)
        assert pp.endswith("\n\n" + body) and pl.endswith("\n\n" + body)
        assert pp.split("\n\n")[0].split()[1:] == pl.split("\n\n")[0].split()[1:] == ["full"]
        assert arms.build_prompt("base", prov, body) == body
    assert arms.invocation("ponytail", "claude") == "/ponytail full"
    assert arms.invocation("placebo", "codex") == "$steady full"

    a = arms.install("ponytail", "claude", tmp_path / "a")
    b = arms.install("placebo", "claude", tmp_path / "b")
    assert a["path"].relative_to(tmp_path / "a") == Path("skills/ponytail/SKILL.md")
    assert b["path"].relative_to(tmp_path / "b") == Path("skills/steady/SKILL.md")
    assert arms.install("base", "claude", tmp_path / "c") is None
    assert not (tmp_path / "c" / "skills").exists()


def test_vendored_skill_hashes_match_manifest_and_plan_placebo():
    man = json.loads((HARNESS / "skills/MANIFEST.json").read_text())
    for name, m in man.items():
        assert hashlib.sha256((HARNESS / "skills" / m["path"]).read_bytes()).hexdigest() == m["sha256"]
    assert man["ponytail"]["sha256"] == "3d413849a55a3bdd8b01c860b5ae4a2f2b0cacfe1bfc0c97439ecc05e92219d7"


def test_install_refuses_tampered_skill(tmp_path, monkeypatch):
    fake = tmp_path / "skills"
    shutil.copytree(HARNESS / "skills", fake)
    p = fake / "ponytail" / "SKILL.md"
    p.chmod(0o644)
    p.write_text(p.read_text() + "\nextra")
    monkeypatch.setattr(arms, "SKILLS_DIR", fake)
    with pytest.raises(arms.SkillIntegrityError):
        arms.install("ponytail", "codex", tmp_path / "home")


def test_isolation_detects_foreign_skills_and_agent_files(tmp_path):
    cfg = tmp_path / "cfg"
    arms.install("ponytail", "codex", cfg)
    assert arms.verify_isolation("codex", "ponytail", cfg, tmp_path / "home", tmp_path / "wc") == []
    (cfg / "skills" / "ponytail-gain").mkdir()
    (tmp_path / "home" / ".agents" / "skills").mkdir(parents=True)
    (cfg / "AGENTS.md").write_text("x")
    probs = arms.verify_isolation("codex", "ponytail", cfg, tmp_path / "home", tmp_path / "wc")
    assert any("ponytail-gain" in x for x in probs)
    assert any(".agents" in x for x in probs)
    assert any("AGENTS.md" in x for x in probs)


def test_isolation_flags_instruction_files_in_working_copy_ancestors(tmp_path):
    wc = tmp_path / "a" / "b" / "wc"
    wc.mkdir(parents=True)
    (tmp_path / "a" / "CLAUDE.md").write_text("x")
    probs = arms.verify_isolation("claude", "base", tmp_path / "cfg", None, wc)
    assert any("CLAUDE.md" in x for x in probs)


def test_activation_check_per_arm(tmp_path):
    root = tmp_path / "t"
    root.mkdir()
    f = root / "s.jsonl"
    f.write_text("")
    before = arms.marker_counts(root)
    f.write_text("... You are a lazy senior developer. Lazy means ...")
    after = arms.marker_counts(root)
    assert arms.activation_ok("ponytail", before, after)[0]
    assert not arms.activation_ok("placebo", before, after)[0]
    assert not arms.activation_ok("base", before, after)[0]  # contamination
    assert arms.activation_ok("base", before, before)[0]


# ---------------------------------------------------------------- hidden-suite freeze
def test_freeze_manifest_excludes_base_and_spec_and_detects_changes(tmp_path):
    d = copy_fixture(tmp_path)
    p = project.load(d)
    m = suite.freeze(p)
    files = set(m["files"])
    assert "acceptance/check.py" in files and "hazards/check.py" in files and "mutations/m1.patch" in files
    assert not any(f.startswith("base/") or f.startswith("spec/") for f in files)
    suite.verify(p, m)
    (d / "acceptance/check.py").write_text((d / "acceptance/check.py").read_text() + "\n# edited\n")
    with pytest.raises(suite.SuiteMismatch):
        suite.verify(p, m)


def test_leak_check_finds_hidden_test_files_in_working_copy(tmp_path):
    d = copy_fixture(tmp_path)
    p = project.load(d)
    m = suite.freeze(p)
    wc = tmp_path / "wc"
    shutil.copytree(d / "base", wc)
    assert suite.leaks(wc, m) == []
    shutil.copy(d / "hazards/check.py", wc / "renamed.py")
    assert suite.leaks(wc, m) == ["renamed.py"]


def test_runner_scratch_and_seed_snapshots_stay_outside_the_hashed_suite(tmp_path):
    import shutil as _sh
    from bench import project as _project, suite as _suite
    fix = Path(__file__).parent / "fixtures" / "fake-project"
    proj = tmp_path / "px-fake"
    _sh.copytree(fix, proj)
    p = _project.load(proj)
    m = _suite.freeze(p)
    (proj / "tmp").mkdir()
    (proj / "tmp" / "cp3-seed-manifest.json").write_text("{}")  # P3 fallback when DB_PATH is unset
    (proj / "acceptance" / "node_modules").mkdir()
    (proj / "acceptance" / "node_modules" / "x.js").write_text("x")
    (proj / "acceptance" / "test-results").mkdir()
    (proj / "acceptance" / "test-results" / "r.json").write_text("{}")
    assert _suite.verify(p, m) == m["sha256"]
