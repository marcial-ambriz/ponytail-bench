"""Blinding for judges/maintenance (plan §9; gap 17) and publication scrubbing (gap 23)."""

import getpass
import os
import re
import shutil
import socket
from pathlib import Path

ARM_COMMENT = re.compile(r"\s*(?://|#|<!--|/\*|--)\s*(?:ponytail|steady)\b[:\s].*$", re.I)
ARM_WORD = re.compile(r"\b(?:ponytail|steady)\b", re.I)
SUMMARY_LINE = re.compile(r"^\s*[-*]?\s*(?:\*\*)?(?:Goal|Items|Assumptions?|Open points?)(?:\*\*)?\s*:", re.I)
RUN_REF = re.compile(r"(?:run/)?[a-z0-9][a-z0-9-]*-(?:sonnet|luna|opus|sol)-(?:base|ponytail|placebo)-r\d+(?:/cp\d+)?")
MODEL_WORD = re.compile(r"\b(?:sonnet|luna|claude|codex|gpt-6[\w-]*|opus|anthropic|openai)\b", re.I)

TOKEN_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9_\-\.=]{12,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]*"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)(\"?\s*[:=]\s*\"?)[^\s\"',]{8,}"),
]
CREDENTIAL_NAMES = {"auth.json", "claude-token", ".credentials.json", "credentials.json", ".env"}


def blind_text(text):
    out = []
    for line in text.splitlines():
        if SUMMARY_LINE.match(line):
            continue
        stripped = ARM_COMMENT.sub("", line)
        if line.strip() and not stripped.strip():
            continue  # the whole line was an arm comment
        stripped = RUN_REF.sub("[run]", stripped)
        stripped = ARM_WORD.sub("[x]", stripped)
        out.append(stripped)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def blind_tree(src, dst, exclude=(".git", "node_modules", ".venv", "SPEC")):
    """Copy a working tree for judges / the maintenance agent with arm tells removed from text files."""
    src, dst = Path(src), Path(dst)
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if any(part in exclude for part in rel.parts):
            continue
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            text = p.read_text()
        except (UnicodeDecodeError, OSError):
            shutil.copy2(p, target)
            continue
        target.write_text(blind_text(text))
        shutil.copymode(p, target)
    return dst


def scrub(text):
    home = os.path.expanduser("~")
    text = text.replace(home, "~")
    for pat in TOKEN_PATTERNS:
        text = pat.sub(lambda m: (m.group(1) + m.group(2) + "[redacted]") if m.re.groups >= 2 else "[redacted]", text)
    for word in {socket.gethostname(), socket.gethostname().split(".")[0]}:
        if word and len(word) > 2:
            text = text.replace(word, "[host]")
    user = getpass.getuser()
    if user and len(user) > 2:
        text = re.sub(rf"\b{re.escape(user)}\b", "[user]", text)
    return text


def export_scrubbed(src, dst):
    src, dst = Path(src), Path(dst)
    copied = []
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(src)
        if p.name in CREDENTIAL_NAMES or any(part in (".homes", "codex-home", "claude-config", "home")
                                             for part in rel.parts[:-1]):
            continue
        if rel.parts and rel.parts[0] == dst.name:
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.write_text(scrub(p.read_text()))
        except UnicodeDecodeError:
            continue  # binary files are not exported
        copied.append(target)
    return copied
