"""Code metrics from each run's own git history (plan §6.4, C9, P3 change cost; gap 16)."""

import fnmatch
import json
import re
import subprocess
import tomllib
from pathlib import Path

from .config import GIT_IDENTITY

LOCKFILES = {"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock", "uv.lock", "poetry.lock",
             "Pipfile.lock"}
EXCLUDE_DIRS = ("SPEC/",)
BLANKET = re.compile(r"(?:eslint|oxlint)-disable(?:-next-line|-line)?\s*(?:\*/)?\s*$|@ts-ignore|@ts-nocheck"
                     r"|#\s*type:\s*ignore\s*$|#\s*noqa\s*$|#\s*pylint:\s*disable=all")
# Runtime deps a fixed stack mandates; listed but never counted as unjustified (per language).
STACK_REQUIRED = {"typescript": {"better-auth", "better-sqlite3", "sqlite3", "@libsql/client", "libsql"},
                  "python": set()}


def git(wc, *args, check=False):
    r = subprocess.run(["git", *GIT_IDENTITY, "-C", str(wc), *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr[-500:]}")
    return r.stdout if r.returncode == 0 else None


def excluded(path, generated=()):
    name = Path(path).name
    return (name in LOCKFILES or any(path.startswith(d) for d in EXCLUDE_DIRS)
            or any(fnmatch.fnmatch(path, g) for g in generated))


def diff_stats(wc, a, b, generated=()):
    st = {"files_changed": 0, "files_added": 0, "files_deleted": 0, "loc_added": 0, "loc_removed": 0,
          "binary_files": 0, "excluded": {"files": 0, "loc_added": 0, "loc_removed": 0}}
    for line in (git(wc, "diff", "--numstat", a, b) or "").splitlines():
        ad, rm, f = line.split("\t", 2)
        bucket = st["excluded"] if excluded(f, generated) else st
        if ad == "-":
            st["binary_files"] += 1
            continue
        if bucket is st:
            st["files_changed"] += 1
        else:
            bucket["files"] += 1
        bucket["loc_added"] += int(ad)
        bucket["loc_removed"] += int(rm)
    for line in (git(wc, "diff", "--name-status", a, b) or "").splitlines():
        kind, *ps = line.split("\t")
        if not excluded(ps[-1], generated):
            st["files_added"] += kind == "A"
            st["files_deleted"] += kind == "D"
    return st


def blanket_disables(wc, a, b):
    out, cur = [], None
    for line in (git(wc, "diff", "-U0", a, b) or "").splitlines():
        if line.startswith("+++ "):
            cur = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and BLANKET.search(line):
            if cur and "node_modules" not in cur:
                out.append(f"{cur}: {line[1:].strip()[:120]}")
    return out


def _files(wc, ref):
    return (git(wc, "ls-tree", "-r", "--name-only", ref) or "").splitlines()


def _show(wc, ref, path):
    return git(wc, "show", f"{ref}:{path}")


def runtime_deps(wc, ref, language):
    deps = set()
    for f in _files(wc, ref):
        if "node_modules/" in f:
            continue
        name = Path(f).name
        text = None
        if name == "package.json":
            text = _show(wc, ref, f)
            try:
                deps |= {f"npm:{d}" for d in (json.loads(text or "{}").get("dependencies") or {})}
            except json.JSONDecodeError:
                pass
        elif name == "pyproject.toml":
            try:
                d = tomllib.loads(_show(wc, ref, f) or "")
            except tomllib.TOMLDecodeError:
                continue
            for spec in (d.get("project") or {}).get("dependencies") or []:
                deps.add("py:" + re.split(r"[<>=!~;\[ ]", spec, maxsplit=1)[0].lower())
            for k in ((d.get("tool") or {}).get("poetry") or {}).get("dependencies") or {}:
                if k.lower() != "python":
                    deps.add("py:" + k.lower())
        elif re.fullmatch(r"requirements(?:[-_.][\w-]+)?\.txt", name) and "dev" not in name and "test" not in name:
            for line in (_show(wc, ref, f) or "").splitlines():
                line = line.split("#", 1)[0].strip()
                if line and not line.startswith("-"):
                    deps.add("py:" + re.split(r"[<>=!~;\[ ]", line, maxsplit=1)[0].lower())
    return deps


def deps_added(wc, base_ref, ref, language):
    """Runtime deps added vs the project's own baseline (P2: its own lockfile/manifests, not an empty scaffold)."""
    added = sorted(runtime_deps(wc, ref, language) - runtime_deps(wc, base_ref, language))
    required = STACK_REQUIRED.get(language, set())
    return {"added": added, "counted": [d for d in added if d.split(":", 1)[1] not in required]}
