"""Re-runs the hazard proof: every hazard must FAIL on its deliberately unsafe variant.

Usage: python3 -I hazards/proof/prove.py <venv-python-dir> [variant ...]
  <venv-python-dir>: a CTFd virtualenv (e.g. a working copy's .venv) reused for every variant.
Builds each variant under <project>/tmp/proof-<name>/ (base/ctfd + reference overlay [+ variant patch]),
boots it with gunicorn exactly like project.json "start", runs the listed hazard ids, and prints a table.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
PORT = 4791

VARIANTS = [
    # name, tree, patch, hazard ids that must fail
    ("v_t1_racy_join", "reference", "v_t1_racy_join.patch",
     ["hz.t1.concurrent_join_password", "hz.t1.concurrent_join_invite", "hz.t1.concurrent_join_global_size"]),
    ("v_t1_captain_limit", "reference", "v_t1_captain_limit.patch", ["hz.t1.captain_cannot_set_limit"]),
    ("v_t1_no_validation", "reference", "v_t1_no_validation.patch", ["hz.t1.invalid_limits_rejected"]),
    ("v_t1_lower_trims", "reference", "v_t1_lower_trims.patch", ["hz.t1.lowering_limit_keeps_members"]),
    ("planted_base", "base", None,
     ["hz.t1.concurrent_join_global_size", "hz.t2.same_member_double_submit", "hz.t4.hidden_team_not_exposed"]),
    ("v_t2_overstrict", "reference", "v_t2_overstrict.patch", ["hz.t2.different_teams_all_count"]),
    ("v_t3_nolock", "reference", "v_t3_nolock.patch",
     ["hz.t3.simultaneous_wrong_never_negative", "hz.t3.simultaneous_identical_wrong_once"]),
    ("v_t3_no_validation", "reference", "v_t3_no_validation.patch", ["hz.t3.invalid_penalty_rejected"]),
    ("v_t3_open_patch", "reference", "v_t3_open_patch.patch", ["hz.t3.player_cannot_change_penalty"]),
    ("v_t3_mutate_award", "reference", "v_t3_mutate_award.patch", ["hz.t3.penalty_keeps_history"]),
    ("v_t5_racy", "reference", "v_t5_racy.patch", ["hz.t5.simultaneous_first_solves_one_bonus"]),
    ("v_t5_racy_no_unique", "reference", "v_t5_racy_no_unique.patch", ["hz.t5.same_team_race_one_bonus"]),
    ("v_t5_open_configs", "reference", "v_t5_open_configs.patch", ["hz.t5.player_cannot_change_bonus"]),
    ("v_regression", "reference", "v_regression.patch", ["hz.regression.ctfd_suite"]),
]


def build(name, tree, patch, venv):
    dst = os.path.join(PROJECT, "tmp", f"proof-{name}")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(os.path.join(PROJECT, "base", "ctfd"), dst)
    if tree == "reference":
        ref = os.path.join(PROJECT, "reference")
        for root, _dirs, files in os.walk(ref):
            for f in files:
                src = os.path.join(root, f)
                rel = os.path.relpath(src, ref)
                os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
                shutil.copy2(src, os.path.join(dst, rel))
    if patch:
        # dst lives inside the bench repo, so give it its own repo or git apply silently skips the paths
        subprocess.run(["git", "init", "-q"], cwd=dst, check=True)
        subprocess.run(["git", "apply", "--verbose", os.path.join(HERE, patch)], cwd=dst, check=True,
                       capture_output=True)
    os.symlink(venv, os.path.join(dst, ".venv"))
    return dst


def boot(wc, db):
    subprocess.run(["bash", "-c", f"lsof -ti tcp:{PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null"], check=False)
    env = dict(os.environ, DATABASE_URL=f"sqlite:///{db}")
    log = open(db + ".log", "w")
    proc = subprocess.Popen([os.path.join(wc, ".venv", "bin", "python"), "-m", "gunicorn", "CTFd:create_app()",
                             "--bind", f"127.0.0.1:{PORT}", "--worker-class", "gthread", "--workers", "1",
                             "--threads", "16", "--timeout", "120"], cwd=wc, env=env, stdout=log, stderr=log,
                            start_new_session=True)
    for _ in range(120):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=2)
            return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("variant did not boot")


def main():
    venv = os.path.abspath(sys.argv[1])
    wanted = set(sys.argv[2:])
    rows = []
    for name, tree, patch, ids in VARIANTS:
        if wanted and name not in wanted:
            continue
        wc = build(name, tree, patch, venv)
        db = os.path.join(wc, "proof.db")
        proc = boot(wc, db)
        out = os.path.join(wc, "result.json")
        try:
            env = dict(os.environ, BASE_URL=f"http://127.0.0.1:{PORT}", WORKDIR=wc, RESULT_JSON=out,
                       HZ_ONLY=",".join(ids))
            subprocess.run([sys.executable, "-I", os.path.join(PROJECT, "hazards", "main.py"), "all"], env=env,
                           capture_output=True, text=True)
            res = {t["id"]: t for t in json.load(open(out))["tests"]}
        finally:
            os.killpg(proc.pid, 15)
            proc.wait()
        for i in ids:
            st = res.get(i, {}).get("status", "missing")
            rows.append((name, i, st, (res.get(i, {}).get("message") or "")[:110]))
            print(f"{name:22} {i:45} {'FAILS (ok)' if st == 'fail' else 'PASSES (BAD)'}  {rows[-1][3]}", flush=True)
        shutil.rmtree(wc, ignore_errors=True)
    bad = [r for r in rows if r[2] != "fail"]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} hazards fail on their unsafe variant")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
