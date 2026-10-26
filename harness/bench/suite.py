"""Hidden-suite freeze (gap 8): a sha256 manifest of every hidden file of a project.

Hidden = everything in projects/<id>/ except the base scaffold and the checkpoint specs (which the model receives).
Every validation verifies the manifest first and refuses to run on a mismatch, and records the manifest hash.
"""

import hashlib
import json
from pathlib import Path

JUNK = {"node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", "results", "test-results", "tmp", ".git",
        ".DS_Store", "playwright-report", ".turbo", "dist"}
LEAK_MIN_BYTES = 64


class SuiteMismatch(RuntimeError):
    pass


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _walk(root):
    for p in sorted(Path(root).rglob("*")):
        rel = p.relative_to(root)
        if any(part in JUNK for part in rel.parts) or not p.is_file():
            continue
        yield rel.as_posix(), p


def hidden_files(project):
    excluded_dirs = []
    base = project.get("base") or {}
    if base.get("type") == "dir":
        excluded_dirs.append(Path(base["path"]).as_posix().rstrip("/") + "/")
    specs = {Path(s).as_posix() for s in project.spec_paths()}
    for rel, p in _walk(project.dir):
        if rel in specs or any(rel.startswith(d) for d in excluded_dirs):
            continue
        yield rel, p


def freeze(project):
    files = {rel: _sha(p) for rel, p in hidden_files(project)}
    digest = hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in sorted(files.items())).encode()).hexdigest()
    return {"project": project.id, "files": files, "sha256": digest}


def verify(project, manifest):
    now = freeze(project)
    if now["sha256"] == manifest["sha256"]:
        return now["sha256"]
    old, new = manifest["files"], now["files"]
    changed = sorted(k for k in old.keys() & new.keys() if old[k] != new[k])
    raise SuiteMismatch(f"{project.id}: hidden suite changed since freeze: changed={changed} "
                        f"added={sorted(new.keys() - old.keys())} removed={sorted(old.keys() - new.keys())}")


def leaks(wc, manifest):
    """Working-copy files whose bytes equal a hidden test file (reference solution excluded: it may share base code)."""
    hidden = {}
    for rel, sha in manifest["files"].items():
        if rel.startswith("reference/") or rel == "project.json":
            continue
        hidden[sha] = rel
    out = []
    for rel, p in _walk(wc):
        if p.stat().st_size < LEAK_MIN_BYTES:
            continue
        if _sha(p) in hidden:
            out.append(rel)
    return out


def save(manifest, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
