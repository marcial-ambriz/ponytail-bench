"""projects/<id>/project.json loading and validation (plan/CONTRACT.md; gap 2).

Harness extensions on top of the contract (all optional):
  "api_url" / "base_url": URL templates (default http://localhost:${API_PORT} / ${WEB_PORT})
  "lint", "test": lists of shell commands run in the working copy ("test" = the model's own tests, used by the
                  lint/test gate and by C6); "install" alias of "setup"
  "generated": glob list excluded from code metrics (besides lockfiles)
  checkpoints[]: "persist_db": true + "seed_after": "<script>"  -> after validating this checkpoint the harness
                  seeds data through the API and keeps the DB; a later checkpoint with "reuse_db_from": "<cp id>"
                  validates on a copy of it (env REUSED_DB=1); "title": short name used in prompts/commits
  "visual": {"screens": "...", "seed": "<script run before capture>", "auth": "<js module: login(page, role, base)>",
             "anchors": "<dir with 0.png 3.png 5.png>"}
  "ux": {"tasks": "<md>", "checkpoints": ["cp3", "cp5"]}
  "maintenance": {"task", "acceptance", "regression_hazards": true}
"""

import json
import shlex
import sys
from pathlib import Path

REQUIRED = ("id", "language", "base", "start", "checkpoints", "hazards", "mutations", "maintenance", "visual",
            "reference")


class ProjectError(ValueError):
    pass


class Project:
    def __init__(self, directory, data):
        self.dir = Path(directory).resolve()
        self.data = data
        self.id = data.get("id")
        self.language = data.get("language")
        self.checkpoints = data.get("checkpoints") or []
        self.weights = {c.get("id"): c.get("weight") for c in self.checkpoints}

    def __getitem__(self, k):
        return self.data[k]

    def get(self, k, default=None):
        return self.data.get(k, default)

    def path(self, rel):
        return self.dir / rel

    def cp(self, cp_id):
        for c in self.checkpoints:
            if c["id"] == cp_id:
                return c
        raise KeyError(cp_id)

    def cp_ids(self):
        return [c["id"] for c in self.checkpoints]

    def script_argv(self, cmd):
        parts = shlex.split(cmd)
        script = self.path(parts[0])
        if script.suffix == ".sh":
            return ["bash", str(script), *parts[1:]]
        if script.suffix == ".py":
            return [sys.executable, "-I", str(script), *parts[1:]]
        return [str(script), *parts[1:]]

    def script_path(self, cmd):
        return self.path(shlex.split(cmd)[0])

    def setup_cmds(self):
        return list(self.data.get("setup") or self.data.get("install") or [])

    def url(self, kind, env):
        default = {"api_url": "http://localhost:${API_PORT}", "base_url": "http://localhost:${WEB_PORT}"}[kind]
        return expand(self.data.get(kind) or default, env)

    def spec_paths(self):
        return [c.get("spec") for c in self.checkpoints if c.get("spec")]

    def title(self, cp_id):
        return self.cp(cp_id).get("title") or cp_id


def expand(template, env):
    out = template
    for k, v in env.items():
        out = out.replace("${" + k + "}", str(v))
    return out


def load(directory, strict=True):
    directory = Path(directory)
    try:
        data = json.loads((directory / "project.json").read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise ProjectError(f"{directory}/project.json: {e}") from e
    p = Project(directory, data)
    if strict:
        probs = validate(p)
        if probs:
            raise ProjectError(f"{directory}: " + "; ".join(probs))
    return p


def validate(p):
    probs = []
    d = p.data
    for k in REQUIRED:
        if k not in d:
            probs.append(f"missing key {k!r}")
    if d.get("language") not in ("typescript", "python", None):
        probs.append(f"language must be typescript or python, got {d.get('language')!r}")
    base = d.get("base") or {}
    if base.get("type") == "dir":
        if not p.path(base.get("path", "")).is_dir():
            probs.append(f"base dir {base.get('path')} not found")
    elif base.get("type") == "git":
        if not base.get("repo") or not base.get("commit"):
            probs.append("git base needs repo and commit")
    elif "base" in d:
        probs.append("base.type must be dir or git")
    start = d.get("start") or {}
    if "start" in d and (not start.get("cmd") or not start.get("health_url")):
        probs.append("start needs cmd and health_url")
    cps = p.checkpoints
    if "checkpoints" in d:
        if not cps:
            probs.append("checkpoints is empty")
        ids = [c.get("id") for c in cps]
        if len(set(ids)) != len(ids):
            probs.append("checkpoint ids must be unique")
        if sum(c.get("weight") or 0 for c in cps) != 100:
            probs.append(f"checkpoint weights must sum to 100 (got {sum(c.get('weight') or 0 for c in cps)})")
        seen = []
        for c in cps:
            for key in ("spec", "acceptance"):
                if not c.get(key):
                    probs.append(f"{c.get('id')}: missing {key}")
            if c.get("spec") and not p.path(c["spec"]).is_file():
                probs.append(f"{c.get('id')}: spec {c['spec']} not found")
            if c.get("acceptance") and not p.script_path(c["acceptance"]).is_file():
                probs.append(f"{c.get('id')}: acceptance script {shlex.split(c['acceptance'])[0]} not found")
            if c.get("seed_after") and not p.script_path(c["seed_after"]).is_file():
                probs.append(f"{c.get('id')}: seed_after script {c['seed_after']} not found")
            src = c.get("reuse_db_from")
            if src and not any(s.get("id") == src and s.get("persist_db") for s in seen):
                probs.append(f"{c.get('id')}: reuse_db_from {src!r} must name an earlier checkpoint with persist_db")
            seen.append(c)
    hz = d.get("hazards") or {}
    if "hazards" in d:
        if not hz.get("run") or not p.script_path(hz["run"]).is_file():
            probs.append(f"hazards run script {hz.get('run')} not found")
    mu = d.get("mutations") or {}
    if "mutations" in d:
        n = mu.get("count") or 0
        mdir = p.path(mu.get("dir", "mutations/"))
        for i in range(1, n + 1):
            if not (mdir / f"m{i}.patch").is_file():
                probs.append(f"mutation patch {mu.get('dir')}m{i}.patch not found")
        if not (mdir / "README.md").is_file():
            probs.append(f"{mu.get('dir')}README.md (one line per mutation) not found")
    mt = d.get("maintenance") or {}
    if "maintenance" in d:
        if not mt.get("task") or not p.path(mt["task"]).is_file():
            probs.append(f"maintenance task {mt.get('task')} not found")
        if not mt.get("acceptance") or not p.script_path(mt["acceptance"]).is_file():
            probs.append(f"maintenance acceptance {mt.get('acceptance')} not found")
    vis = d.get("visual") or {}
    if "visual" in d:
        sp = p.path(vis.get("screens", ""))
        try:
            screens = json.loads(sp.read_text())
            if not isinstance(screens, list) or not all(isinstance(s, dict) and s.get("id") and s.get("path")
                                                        for s in screens):
                probs.append("screens.json must be a list of {id, path, role, ...}")
        except (OSError, json.JSONDecodeError) as e:
            probs.append(f"visual screens {vis.get('screens')}: {e}")
    if "reference" in d and not p.path(d["reference"]).is_dir():
        probs.append(f"reference dir {d['reference']} not found")
    return probs


def discover(projects_dir):
    out = []
    for f in sorted(Path(projects_dir).glob("*/project.json")):
        out.append(f.parent)
    return out
