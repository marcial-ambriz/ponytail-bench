"""Per-checkpoint screenshots and automated C10 checks (gap 13). Judging happens later on blinded copies."""

import json
import shutil
from pathlib import Path

from .config import HARNESS, NODE_BIN, PLAYWRIGHT_DIR
from .validator import machine_lock, sh

SCRIPT = HARNESS / "capture-screens.mjs"


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
        if vis.get("seed"):
            code, out = sh(project.script_argv(vis["seed"]), project.dir, env, log=out_dir / "seed.log")
            if code != 0:
                log(f"visual seed failed (exit {code})")
        cmd = [str(node), str(SCRIPT), str(out_dir / "screens.json"), env["BASE_URL"], str(out_dir)]
        if vis.get("auth"):
            cmd.append(str(project.path(vis["auth"])))
        e = dict(env, BENCH_PLAYWRIGHT_DIR=str(PLAYWRIGHT_DIR), HOME=str(Path.home()))
        code, out = sh(cmd, HARNESS, e, timeout=900, log=out_dir / "capture.log")
    idx = out_dir / "index.json"
    if code != 0 or not idx.exists():
        return {"unavailable": f"capture failed (exit {code}): {out[-300:]}"}
    data = json.loads(idx.read_text())
    return {"screens": len(data["screens"]), "checks": data["summary"], "index": str(idx)}
