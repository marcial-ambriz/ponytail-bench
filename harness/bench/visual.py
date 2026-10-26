"""Per-checkpoint screenshots and automated C10 checks (gap 13). Judging happens later on blinded copies."""

import json
import shutil
import time
from pathlib import Path

from .config import HARNESS, NODE_BIN, PLAYWRIGHT_DIR
from .validator import machine_lock, sh

SCRIPT = HARNESS / "capture-screens.mjs"
SEED_WAITS = (5, 15, 30)  # a dev server answers on the web port before its API proxy target is up (pilot: 502s)
SEED_TEMPFAIL = 75  # seeds exit EX_TEMPFAIL when the API never answered, before writing anything


def run_seed(argv, cwd, env, log_path, waits=SEED_WAITS):
    """Run the seed script, retrying only temporary failures (a rerun after a real one would duplicate data);
    the result travels with the capture so C10 knows."""
    for attempt in range(1, len(waits) + 2):
        code, _ = sh(argv, cwd, env, log=log_path)
        if code == 0:
            return {"ok": True, "attempts": attempt}
        if code != SEED_TEMPFAIL:
            return {"ok": False, "attempts": attempt}
        if attempt <= len(waits):
            time.sleep(waits[attempt - 1])
    return {"ok": False, "attempts": len(waits) + 1}


def screens_for(project, cp):
    screens = json.loads(project.path(project["visual"]["screens"]).read_text())
    order = project.cp_ids()
    upto = order.index(cp)
    return [s for s in screens if order.index(s.get("cp", order[0])) <= upto]


def capture(project, validator, wc, cp, ports, out_dir, log=print):
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    node = NODE_BIN / "node"
    if not node.exists():
        node = Path(shutil.which("node") or "node")
    if not (PLAYWRIGHT_DIR / "node_modules" / "playwright").exists():
        return {"unavailable": f"playwright not found under {PLAYWRIGHT_DIR} (set BENCH_PLAYWRIGHT_DIR)"}
    screens = screens_for(project, cp)
    if not screens:
        return {"screens": 0, "checks": {"passed": 0, "total": 0}}
    (out_dir / "screens.json").write_text(json.dumps(screens, indent=2))
    vis = project["visual"]
    db = out_dir / "visual.db"
    with machine_lock("validation", log=log, who=f"{validator.state_dir.name}:visual-{cp}"), \
            validator.app(wc, ports, db, out_dir) as (booted, env, err):
        if not booted:
            return {"unavailable": f"app did not boot for capture: {err}"}
        seed = None
        if vis.get("seed"):
            seed = run_seed(project.script_argv(vis["seed"]), project.dir, dict(env, CHECKPOINT=cp),
                            out_dir / "seed.log")
            if not seed["ok"]:
                log(f"visual seed failed after {seed['attempts']} attempts")
        cmd = [str(node), str(SCRIPT), str(out_dir / "screens.json"), env["BASE_URL"], str(out_dir)]
        if vis.get("auth"):
            cmd.append(str(project.path(vis["auth"])))
        e = dict(env, BENCH_PLAYWRIGHT_DIR=str(PLAYWRIGHT_DIR), HOME=str(Path.home()))
        code, out = sh(cmd, HARNESS, e, timeout=900, log=out_dir / "capture.log")
    idx = out_dir / "index.json"
    if code != 0 or not idx.exists():
        return {"unavailable": f"capture failed (exit {code}): {out[-300:]}"}
    data = json.loads(idx.read_text())
    return {"screens": len(data["screens"]), "checks": data["summary"], "index": str(idx), "seed": seed}
