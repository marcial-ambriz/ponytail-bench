"""Arm injection (plan §4; gaps 3, 25).

base: no skill. ponytail: vendored skills/ponytail/SKILL.md. placebo: vendored skills/steady/SKILL.md (plan Annex A).
Both skill arms use the same mechanism and position: the file is installed at <isolated config>/skills/<name>/SKILL.md
(CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex) and the prompt starts with "<sigil><name> full" followed by a
blank line and the task. Integrity: every install re-hashes the vendored file against skills/MANIFEST.json.
Activation: each turn must grow the arm's own marker count in the session transcripts and no other arm's marker.
"""

import fnmatch
import hashlib
import json
import shutil
from pathlib import Path

from .config import SKILLS_DIR

ARMS = {
    "base": None,
    "ponytail": {"skill": "ponytail", "marker": "You are a lazy senior developer"},
    "placebo": {"skill": "steady", "marker": "You are a steady developer"},
}
SIGIL = {"claude": "/", "codex": "$"}
LEVEL = "full"
INSTRUCTION_FILES = ("CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.override.md")


class SkillIntegrityError(RuntimeError):
    pass


def invocation(arm, provider):
    a = ARMS[arm]
    return None if a is None else f"{SIGIL[provider]}{a['skill']} {LEVEL}"


def build_prompt(arm, provider, body):
    inv = invocation(arm, provider)
    return body if inv is None else f"{inv}\n\n{body}"


def manifest():
    return json.loads((SKILLS_DIR / "MANIFEST.json").read_text())


def install(arm, provider, cfg_dir):
    """Install the arm's skill into the isolated config dir. Returns None for base."""
    a = ARMS[arm]
    if a is None:
        return None
    name = a["skill"]
    m = manifest()[name]
    src = SKILLS_DIR / m["path"]
    data = src.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != m["sha256"]:
        raise SkillIntegrityError(f"{src}: sha256 {digest} != manifest {m['sha256']}")
    dst = Path(cfg_dir) / "skills" / name / "SKILL.md"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.chmod(0o644)
    shutil.copyfile(src, dst)
    dst.chmod(0o444)
    return {"skill": name, "sha256": digest, "path": dst, "provider": provider}


def expected_skills(arm):
    a = ARMS[arm]
    return set() if a is None else {a["skill"]}


def _ancestor_instruction_files(wc):
    wc = Path(wc).resolve() if Path(wc).exists() else Path(wc).absolute()
    out = []
    for d in wc.parents:
        for n in INSTRUCTION_FILES:
            if (d / n).is_file():
                out.append(d / n)
    return out


def verify_isolation(provider, arm, cfg_dir, fake_home, wc):
    """Structural check that no user-level skill, plugin or instruction file can reach the session."""
    probs = []
    cfg = Path(cfg_dir)
    skills = cfg / "skills"
    present = {p.name for p in skills.iterdir()} if skills.is_dir() else set()
    for extra in sorted(present - expected_skills(arm)):
        probs.append(f"foreign skill in {skills}: {extra}")
    for missing in sorted(expected_skills(arm) - present):
        probs.append(f"arm skill not installed: {missing}")
    for n in INSTRUCTION_FILES:
        if (cfg / n).exists():
            probs.append(f"instruction file in isolated config: {cfg / n}")
    if (cfg / "plugins").exists():
        probs.append(f"plugins dir in isolated config: {cfg / 'plugins'}")
    if fake_home is not None:
        h = Path(fake_home)
        for rel in (".agents", ".config/agents", ".codex", ".claude", "AGENTS.md", "CLAUDE.md"):
            if (h / rel).exists():
                probs.append(f"user-level agent config reachable through fake HOME: {h / rel}")
    excludes = []
    settings = cfg / "settings.json"
    if settings.exists():
        excludes = json.loads(settings.read_text()).get("claudeMdExcludes") or []
    for f in _ancestor_instruction_files(wc):
        if provider == "codex" and (Path(wc) / ".git").exists():
            continue  # Codex reads AGENTS.md only from the git root down; the working copy is its own repo
        if provider == "claude" and any(fnmatch.fnmatch(str(f), pat) for pat in excludes):
            continue
        probs.append(f"instruction file in a working-copy ancestor: {f}")
    return probs


def claude_settings(wc):
    """Isolated Claude settings: exclude every user-level and ancestor instruction file."""
    home = str(Path.home())
    ex = [f"{home}/.claude/**", f"{home}/CLAUDE.md", f"{home}/AGENTS.md"]
    ex += [str(f) for f in _ancestor_instruction_files(wc) if str(f) not in ex]
    return {"claudeMdExcludes": ex}


def marker_counts(transcript_root):
    root = Path(transcript_root)
    counts = {a["skill"]: 0 for a in ARMS.values() if a}
    if not root.exists():
        return counts
    files = [root] if root.is_file() else root.rglob("*.jsonl")
    for p in files:
        text = p.read_text(errors="replace")
        for a in ARMS.values():
            if a:
                counts[a["skill"]] += text.count(a["marker"])
    return counts


def activation_ok(arm, before, after):
    grew = {k for k in after if after[k] > before.get(k, 0)}
    want = expected_skills(arm)
    if grew - want:
        return False, f"foreign skill marker appeared: {sorted(grew - want)}"
    if want - grew:
        return False, f"skill {sorted(want)[0]} was not loaded in this turn"
    return True, "ok"
