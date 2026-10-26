"""CTFd's own test suite (as shipped in the base) run against the working copy's code.

The working copy's tests/ folder is replaced by the pristine base copy, so edited or deleted upstream tests
cannot hide a regression. Runs in <project>/tmp/ (the only place hidden runners may write besides RESULT_JSON).
"""
import os
import re
import shutil
import subprocess
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
PRISTINE_TESTS = os.path.join(PROJECT, "base", "ctfd", "tests")
SKIP = {".git", ".venv", "node_modules", "__pycache__", ".data", ".pytest_cache", "tests"}


def run(timeout=1500):
    entry = {"id": "hz.regression.ctfd_suite", "requirement": "REG", "category": "regression", "severity": 3}
    wc = os.environ.get("WORKDIR")
    py = os.path.join(wc or "", ".venv", "bin", "python")
    if not wc or not os.path.exists(py):
        entry.update(status="fail", message=f"WORKDIR venv missing ({py}); setup must create .venv")
        return entry
    tmp = os.path.join(PROJECT, "tmp", f"regression-{uuid.uuid4().hex[:8]}")
    t0 = time.time()
    try:
        def ignore(d, names):
            top = os.path.abspath(d) == os.path.abspath(wc)
            return [n for n in names if (top and n in SKIP) or n in ("__pycache__", "node_modules")]

        shutil.copytree(wc, tmp, ignore=ignore, symlinks=True)
        shutil.copytree(PRISTINE_TESTS, os.path.join(tmp, "tests"))
        env = {k: v for k, v in os.environ.items() if k not in ("DATABASE_URL", "REDIS_URL")}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        workers = str(min(8, os.cpu_count() or 2))
        cmd = [py, "-m", "pytest", "-q", "-p", "no:randomly", "-p", "no:sugar", "-p", "no:cacheprovider",
               "-n", workers, "-W", "ignore::DeprecationWarning", "tests"]
        try:
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=timeout)
            out = (r.stdout or "") + (r.stderr or "")
            code = r.returncode
        except subprocess.TimeoutExpired:
            out, code = "timeout", 124
        summary = next((ln for ln in reversed(out.splitlines()) if re.search(r"\d+ (passed|failed|error)", ln)), "")
        failed = re.findall(r"^FAILED (\S+)", out, re.M)
        ok = code == 0 and "passed" in summary and "failed" not in summary and "error" not in summary
        entry["status"] = "pass" if ok else "fail"
        entry["message"] = (summary.strip("= ") + (f"; failed: {failed[:10]}" if failed else "")
                            + ("" if summary else out[-400:]))[:500]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        entry["seconds"] = round(time.time() - t0, 1)
    return entry
