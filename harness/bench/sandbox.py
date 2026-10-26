"""Filesystem fence for agents that touch subject code (pilot finding: an unsandboxed subject read the hidden suite).

macOS `sandbox-exec` with an SBPL profile: everything stays allowed except reading contents of, listing or writing
the denied roots (the study repo, other runs, round 1); the run's own roots are allowed back (last matching rule
wins). Metadata stays readable so getcwd/realpath keep working on parent directories.
"""

import os
import shutil
from pathlib import Path

from .config import REPO

# Roots a subject must never read: this study, round 1 and its worktrees (code, homes, tokens).
STUDY_ROOTS = (REPO, Path.home() / "Projects" / "ponytail-bench", Path.home() / "Projects" / "ponytail-bench-worktrees")


def available():
    return shutil.which("sandbox-exec") is not None


def _lit(p):
    return '"' + os.path.realpath(p).replace("\\", "\\\\").replace('"', '\\"') + '"'


def profile(deny, allow):
    ops = "file-read-data file-write*"
    lines = ["(version 1)", "(allow default)"]
    lines += [f"(deny {ops} (subpath {_lit(d)}))" for d in deny]
    lines += [f"(allow {ops} (subpath {_lit(a)}))" for a in allow]
    return "\n".join(lines)


def wrap(cmd, deny, allow):
    return ["sandbox-exec", "-p", profile(deny, allow), *cmd]
