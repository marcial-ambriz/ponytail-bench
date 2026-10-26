#!/usr/bin/env python3
"""Round-2 ponytail benchmark harness CLI (stdlib only; run with python3 -I benchctl.py <command>).

  validate                        validate every projects/<id>/project.json against the contract
  freeze --commit SHA [--prices F] freeze suites, prices, skills, harness code, seed, schedule, alias map (hash only)
  schedule                        print the frozen rep-major schedule (block order, arm start order, aliases)
  preflight [--pilot ...]         credentials present (names only), CLI versions, isolation, frozen integrity; no model call
  dry-run [--project ID] [--no-visual]   full pipeline on the reference implementation(s), zero model calls
  selftest [--no-visual]          dry-run every project and fail unless the reference scores as expected (gap 22)
  run [--pilot --model M --project P] [--blocks ID,...] [--publish]   paid runs (budget-guarded)
  post [RUN_ID ...]               C6 mutation agent + maintenance agent for finished runs (paid, guarded)
  judge prepare | judge run --kind code|visual [--judge opus|sol]     blinded bundles / non-subject judges (paid)
  ux run ALIAS CP                 exploratory UX agent on one run/checkpoint (paid, guarded)
  score                           scores/scores.json + table (success rule, permutation, bootstrap, review queue)
  budget status | budget ack 50|80 | budget reconcile --invoice F
  export DST                      scrubbed copy of states/transcripts for publication (no credentials)
  status | deviation "text"
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench import agents, arms, blind, ports, project, report, runner, sandbox, schedule, suite, usage  # noqa: E402
from bench.config import (ARMS, HARNESS, JUDGES, MAINTENANCE_AGENT, MAX_CONCURRENT_BLOCKS, MODELS, PLAN_DIR,  # noqa
                          PROJECTS, PROJECTS_DIR, REPS, SKILLS_DIR, Paths)
from bench.ledger import BudgetGuard, Ledger  # noqa: E402

PATHS = Paths()
FREEZE = PATHS.frozen / "freeze.json"
POST_ESTIMATE_PER_RUN_USD = 1.0  # maintenance + mutation + judges share per run (plan §10: 40-60 USD / 54 runs)
CODE_FILES = ["benchctl.py", "capture-screens.mjs", "bench/*.py", "prompts/*.md", "skills/*/SKILL.md",
              "skills/MANIFEST.json"]


def harness_sha():
    h = hashlib.sha256()
    for pat in CODE_FILES:
        for f in sorted(HARNESS.glob(pat)):
            h.update(f.relative_to(HARNESS).as_posix().encode() + b"\0" + f.read_bytes())
    return h.hexdigest()


def load_projects(ids=None, strict=True):
    out = {}
    for d in project.discover(PROJECTS_DIR):
        p = project.load(d, strict=strict)
        if ids is None or p.id in ids:
            out[p.id] = p
    return out


def ledger_guard():
    """One study-wide ledger (pilot, runs, judges, UX, maintenance all count against the 600 USD cap)."""
    state = HARNESS / ".state"
    lg = Ledger(state / "ledger.jsonl")
    return lg, BudgetGuard(lg, state / "budget-state.json")


def require_freeze():
    if not FREEZE.exists():
        sys.exit("not frozen: run `benchctl.py freeze --commit <pre-registration commit>` first")
    fz = json.loads(FREEZE.read_text())
    if fz["harness_sha256"] != harness_sha():
        sys.exit("harness code changed since freeze: log a deviation and re-freeze before running")
    return fz


# ---------------------------------------------------------------- commands
def cmd_validate(a):
    bad = 0
    for d in project.discover(PROJECTS_DIR):
        p = project.load(d, strict=False)
        probs = project.validate(p)
        if (p.get("mutations") or {}).get("count") not in (4, 5):
            probs.append("mutations.count should be 4 (CONTRACT) or 5 (plan §6.1)")
        print(f"{p.id or d.name}: {'ok' if not probs else '; '.join(probs)}")
        bad += bool(probs)
    if not project.discover(PROJECTS_DIR):
        print(f"no projects under {PROJECTS_DIR}")
    return 1 if bad else 0


def cmd_freeze(a):
    projects = load_projects()
    missing = [p for p in PROJECTS if p not in projects]
    if missing and not a.allow_missing:
        sys.exit(f"projects missing or invalid: {missing}")
    PATHS.frozen.mkdir(parents=True, exist_ok=True)
    man = arms.manifest()
    placebo = (PLAN_DIR / "placebo-SKILL.md").read_bytes()
    if hashlib.sha256(placebo).hexdigest() != man["steady"]["sha256"]:
        sys.exit("plan/placebo-SKILL.md differs from the vendored skills/steady/SKILL.md: re-vendor (and re-hash) first")
    prices = usage.load_prices(a.prices)
    shutil.copyfile(a.prices, PATHS.frozen / "prices.json")
    suites = {}
    for pid, p in projects.items():
        m = suite.freeze(p)
        suite.save(m, PATHS.frozen / "suites" / f"{pid}.json")
        suites[pid] = m["sha256"]
    seed = schedule.seed_from_commit(a.commit)
    sched = schedule.build_schedule(seed, list(MODELS), sorted(projects), list(ARMS), reps=list(REPS))
    aliases = schedule.aliases(sched)
    PATHS.state.mkdir(parents=True, exist_ok=True)
    alias_blob = json.dumps(aliases, sort_keys=True, indent=1).encode()
    (PATHS.state / "aliases.json").write_bytes(alias_blob)  # private until scores are locked; publish the hash only
    fz = {"frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "commit": a.commit, "seed": seed,
          "suites": suites, "prices_sha256": prices["sha256"], "skills": man, "harness_sha256": harness_sha(),
          "alias_map_sha256": hashlib.sha256(alias_blob).hexdigest(),
          "schedule": [{"block_id": b["block_id"], "rep": b["rep"], "arm_order": [r["arm"] for r in b["runs"]]}
                       for b in sched["blocks"]]}
    FREEZE.write_text(json.dumps(fz, indent=2) + "\n")
    print(json.dumps({k: fz[k] for k in ("commit", "seed", "suites", "prices_sha256", "harness_sha256",
                                         "alias_map_sha256")}, indent=2))
    return 0


def frozen_schedule(fz, models=None, projects=None, reps=None):
    s = schedule.build_schedule(fz["seed"], list(MODELS), sorted(fz["suites"]), list(ARMS), reps=list(REPS))
    s["blocks"] = [b for b in s["blocks"] if (not models or b["model"] in models)
                   and (not projects or b["project"] in projects) and (not reps or b["rep"] in reps)]
    return s


def cmd_schedule(a):
    fz = require_freeze()
    for b in frozen_schedule(fz)["blocks"]:
        print(f"r{b['rep']} {b['block_id']:<28} " + " ".join(f"{r['arm']}" for r in b["runs"]))
    return 0


def fence_canary(prov, cfg, home):
    """The subject fence must block the hidden suites and other runs while the CLI itself still starts."""
    if not sandbox.available():
        return ["sandbox-exec not available"]
    probs, deny, allow = [], [*sandbox.STUDY_ROOTS, PATHS.runs], [cfg, home]
    hidden = sorted(PROJECTS_DIR.glob("*/acceptance/**/*.*"))[:1] + [PLAN_DIR / "plan.md"]
    for f in hidden:
        r = subprocess.run(sandbox.wrap(["cat", str(f)], deny, allow), cwd=cfg, capture_output=True, text=True)
        if r.returncode == 0:
            probs.append(f"readable through the fence: {f}")
    r = subprocess.run(sandbox.wrap(["sh", "-c", "echo ok > fence.txt && cat fence.txt"], deny, allow), cwd=cfg,
                       capture_output=True, text=True)
    if r.stdout.strip() != "ok":
        probs.append(f"own config dir not writable through the fence: {r.stderr.strip()[:120]}")
    r = subprocess.run(sandbox.wrap([prov, "--version"], deny, allow), cwd=cfg, capture_output=True, text=True,
                       env=agents.base_env())
    if r.returncode != 0:
        probs.append(f"{prov} does not start inside the fence: {(r.stderr or r.stdout).strip()[:120]}")
    return probs


def cmd_preflight(a):
    fz = require_freeze()
    ok = True
    for prov in ("claude", "codex"):
        mode, _ = agents.credentials(prov)
        print(f"{prov}: billing_mode={mode or 'MISSING (set ' + ' or '.join(agents.CRED_ENV[prov].values()) + ')'}")
        ok &= mode is not None
        if mode == "subscription":
            print(f"  warning: {prov} subscription billing -> billed_usd=0, only list-price estimates (plan wants API)")
        r = subprocess.run([prov, "--version"], capture_output=True, text=True)
        print(f"  {prov} --version: {(r.stdout or r.stderr).strip()[:80]}")
    for pid in fz["suites"]:
        p = project.load(PROJECTS_DIR / pid)
        m = json.loads((PATHS.frozen / "suites" / f"{pid}.json").read_text())
        try:
            suite.verify(p, m)
            print(f"{pid}: suite ok {m['sha256'][:12]}")
        except suite.SuiteMismatch as e:
            ok = False
            print(e)
    usage.load_prices(PATHS.frozen / "prices.json")
    with_tmp = PATHS.state / "preflight"
    for prov in ("claude", "codex"):
        for arm in ARMS:
            cfg = with_tmp / prov / arm
            shutil.rmtree(cfg, ignore_errors=True)
            arms.install(arm, prov, cfg)
            cfg.mkdir(parents=True, exist_ok=True)
            home = with_tmp / prov / f"{arm}-home"
            home.mkdir(parents=True, exist_ok=True)
            if prov == "claude":
                (cfg / "settings.json").write_text(json.dumps(arms.claude_settings(PATHS.runs / "x" / "wc")))
            probs = arms.verify_isolation(prov, arm, cfg, home if prov == "codex" else None, PATHS.runs / "x" / "wc")
            print(f"isolation {prov}/{arm}: {'ok' if not probs else probs}")
            ok &= not probs
            fence = fence_canary(prov, cfg, home)
            print(f"fence {prov}/{arm}: {'ok' if not fence else fence}")
            ok &= not fence
    print(json.dumps(ledger_guard()[1].status(), indent=1))
    return 0 if ok else 1


def cmd_dry_run(a):
    ids = [a.project] if a.project else None
    if getattr(a, "project_dir", None):
        found = {(pp := project.load(a.project_dir)).id: pp}
    else:
        found = load_projects(ids)
    if not found:
        sys.exit(f"no valid project found ({a.project or PROJECTS_DIR}); run `benchctl.py validate`")
    worst = 0
    for pid, p in found.items():
        root = HARNESS / ".dryrun" / pid
        shutil.rmtree(root, ignore_errors=True)
        out = runner.dry_run(p.dir, Paths(root=root), visual=not a.no_visual, log=print if a.verbose else None)
        (root / "dry-run.json").write_text(json.dumps(out, indent=2, default=str))
        print(f"{pid}: model_calls={out['model_calls']} selftest={'ok' if out['selftest']['ok'] else 'FAIL'}")
        for prob in out["selftest"]["problems"]:
            print(f"  - {prob}")
        for rid, r in out["runs"].items():
            print(f"  {rid}: S={r['total']['S']} PR={r['PR_final']} C6={(r.get('c6') or {}).get('rating')} "
                  f"pending={r['total']['pending']}")
        worst |= not out["selftest"]["ok"]
    return 1 if worst else 0


def run_block(block, fz, projects, lg, guard, pool, prices, publish):
    """`pool` is a ports.PortAllocator: every run leases its own machine-wide port range for the whole block."""
    p = projects[block["project"]]
    manifest = json.loads((PATHS.frozen / "suites" / f"{p.id}.json").read_text())
    slots = []
    try:
        for spec in block["runs"]:
            slots.append(pool.acquire(f"run:{spec['run_id']}"))
        runs = [runner.Run(p, spec, PATHS, manifest, lg, guard, prices, slot, publish=publish)
                for spec, slot in zip(block["runs"], slots)]
        for r in runs:  # setup in the seeded start order, then launch together
            r.setup()
        threads = [threading.Thread(target=r.execute, name=r.id) for r in runs]
        for t in threads:
            t.start()
            time.sleep(2)
        for t in threads:
            t.join()
        for r in runs:
            post_run(r, lg, guard, prices)
        return {r.id: r.load()["status"] for r in runs}
    finally:
        for s in slots:
            pool.release(s)


def post_run(r, lg, guard, prices):
    st = r.load()
    if st["status"] not in ("done", "stopped"):
        return

    def mut_agent(mwc, mid):
        return agents.CliAgent(MAINTENANCE_AGENT["provider"], MAINTENANCE_AGENT["model"], MAINTENANCE_AGENT["effort"],
                               mwc, r.state_dir / "mutation-agent" / mid, r.state_dir / "mutation-turns", lg, guard,
                               prices, r.id, "sonnet", kind="mutation").scope_roots([PATHS.runs])

    def maint_agent(mwc):
        cfg = r.state_dir / "maintenance-agent"
        cfg.mkdir(parents=True, exist_ok=True)
        (cfg / "settings.json").write_text(json.dumps(arms.claude_settings(mwc)))
        return agents.CliAgent(MAINTENANCE_AGENT["provider"], MAINTENANCE_AGENT["model"], MAINTENANCE_AGENT["effort"],
                               mwc, cfg, r.state_dir / "maintenance-turns", lg, guard, prices, r.id, "sonnet",
                               kind="maintenance").scope_roots([PATHS.runs])
    if not st.get("c6"):
        runner.run_mutations(r, mode="agent", agent_factory=mut_agent)
    if not st.get("maintenance"):
        runner.run_maintenance(r, agent_factory=maint_agent)


def cmd_run(a):
    global PATHS
    fz = require_freeze()
    projects = load_projects(list(fz["suites"]))
    for pid, p in projects.items():
        suite.verify(p, json.loads((PATHS.frozen / "suites" / f"{pid}.json").read_text()))
    prices = usage.load_prices(PATHS.frozen / "prices.json")
    if a.pilot:
        if not (a.model and a.project):
            sys.exit("--pilot needs --model and --project (1 model x 1 project x 3 arms)")
        sched = frozen_schedule(fz, [a.model], [a.project], [1])
        PATHS = Paths(root=HARNESS / ".pilot", frozen_root=PATHS.root)  # own states; main frozen files and ledger
    else:
        sched = frozen_schedule(fz)
    if a.blocks:
        sched["blocks"] = [b for b in sched["blocks"] if b["block_id"] in a.blocks.split(",")]
    aliases = json.loads((HARNESS / ".state" / "aliases.json").read_text())
    for b in sched["blocks"]:
        for r in b["runs"]:
            r["alias"] = aliases.get(r["run_id"], r["alias"])
    lg, guard = ledger_guard()
    pool = ports.PortAllocator()

    def can_launch(b):
        proj = guard.estimate_block_cost(b["model"]) + POST_ESTIMATE_PER_RUN_USD * len(b["runs"])
        ok, why = guard.check_launch(proj)
        print(f"launch {b['block_id']}: projection {proj:.2f} USD -> {why}")
        return ok, why

    res = schedule.execute(sched, lambda b: run_block(b, fz, projects, lg, guard, pool, prices, a.publish),
                           max_concurrent_blocks=MAX_CONCURRENT_BLOCKS, can_launch=can_launch)
    print(json.dumps(res, indent=1))
    print(json.dumps(guard.status(), indent=1))
    return 0


def all_states(paths=None):
    paths = paths or PATHS
    return [json.loads(f.read_text()) for f in sorted(paths.state.glob("*/state.json"))]


def cmd_post(a):
    fz = require_freeze()
    projects = load_projects(list(fz["suites"]))
    prices = usage.load_prices(PATHS.frozen / "prices.json")
    lg, guard = ledger_guard()
    for st in all_states():
        if a.run_ids and st["run_id"] not in a.run_ids:
            continue
        p = projects[st["project"]]
        manifest = json.loads((PATHS.frozen / "suites" / f"{p.id}.json").read_text())
        with ports.PortAllocator().lease(f"post:{st['run_id']}") as slot:
            r = runner.Run(p, {"run_id": st["run_id"], "arm": st["arm"], "model": st["model"], "rep": st["rep"],
                               "alias": st["alias"]}, PATHS, manifest, lg, guard, prices, slot)
            post_run(r, lg, guard, prices)
    return 0


def blind_dir():
    return PATHS.scores / "blind"


def cmd_judge(a):
    fz = require_freeze()
    projects = load_projects(list(fz["suites"]))
    if a.action == "prepare":
        out = blind_dir()
        for st in all_states():
            if st["status"] not in ("done", "stopped"):
                continue
            p = projects[st["project"]]
            wc = PATHS.run_dir(st["run_id"]) / "wc"
            spec_dir = out / "spec" / p.id
            spec_dir.mkdir(parents=True, exist_ok=True)
            for s in p.spec_paths():
                shutil.copy2(p.path(s), spec_dir / Path(s).name)
            for cp, rec in st["checkpoints"].items():
                if not rec.get("commit"):
                    continue
                d = out / st["alias"]
                d.mkdir(parents=True, exist_ok=True)
                excl = [f":(exclude){x}" for x in ["SPEC", "**/pnpm-lock.yaml", "**/package-lock.json",
                                                    "**/yarn.lock", "**/uv.lock", "**/poetry.lock",
                                                    *(p.get("generated") or [])]]
                diff = subprocess.run(["git", "-C", str(wc), "diff", "bench-base", f"bench-{cp}", "--", ".", *excl],
                                      capture_output=True, text=True).stdout
                (d / f"{cp}.diff").write_text(blind.blind_text(diff))
                shots = PATHS.run_state(st["run_id"]) / "screens" / cp
                if shots.exists():
                    sd = d / "screens" / cp
                    shutil.rmtree(sd, ignore_errors=True)
                    shutil.copytree(shots, sd, ignore=shutil.ignore_patterns("*.log", "*.db*", "screens.json"))
        print(f"blinded bundles in {out}")
        return 0
    prices = usage.load_prices(PATHS.frozen / "prices.json")
    lg, guard = ledger_guard()
    judges = [a.judge] if a.judge else list(JUDGES)
    out = blind_dir()
    for alias_dir in sorted(d for d in out.iterdir() if d.is_dir() and d.name != "spec"):
        alias = alias_dir.name
        st = next((s for s in all_states() if s["alias"] == alias), None)
        if not st:
            continue
        for j in judges:
            jc = JUDGES[j]
            res_dir = PATHS.scores / ("judges" if a.kind == "code" else "visual") / j
            res_dir.mkdir(parents=True, exist_ok=True)
            res_file = res_dir / f"{alias}.json"
            results = json.loads(res_file.read_text()) if res_file.exists() else {}
            for cp in sorted(f.stem for f in alias_dir.glob("*.diff")):
                if cp in results:
                    continue
                ok, why = guard.check_launch(1.0)
                if not ok:
                    print(f"judge stopped: {why}")
                    return 1
                tmp_out = alias_dir / f"{a.kind}-{j}-{cp}.json"
                if a.kind == "code":
                    prompt = runner.tpl("code-judge.md", alias=alias, cp_id=cp, diff_path=f"{cp}.diff",
                                        spec_dir=f"../spec/{st['project']}", judge=j, out_path=tmp_out.name)
                else:
                    anchors = (projects[st["project"]].get("visual") or {}).get("anchors")
                    if not anchors:
                        print(f"{st['project']}: visual.anchors missing; visual judging skipped")
                        break
                    prompt = runner.tpl("visual-judge.md", alias=alias, cp_id=cp, shots_dir=f"screens/{cp}",
                                        index_path=f"screens/{cp}/index.json",
                                        anchors_dir=str(projects[st["project"]].path(anchors)), judge=j,
                                        out_path=tmp_out.name)
                cfg = PATHS.state / "judges" / j
                cfg.mkdir(parents=True, exist_ok=True)
                ag = agents.CliAgent(jc["provider"], jc["model"], jc["effort"], alias_dir, cfg,
                                     PATHS.state / "judges" / f"{j}-turns" / alias, lg, guard, prices,
                                     f"judge:{alias}:{cp}", j, kind="judge",
                                     fake_home=cfg / "home" if jc["provider"] == "codex" else None)
                ag.turn(f"{a.kind}-{cp}", prompt)
                if tmp_out.exists():
                    results[cp] = json.loads(tmp_out.read_text())
                    res_file.write_text(json.dumps(results, indent=2))
    return 0


def cmd_ux(a):
    require_freeze()
    st = next((s for s in all_states() if s["alias"] == a.alias), None)
    if not st:
        sys.exit(f"unknown alias {a.alias}")
    p = load_projects([st["project"]])[st["project"]]
    tasks = (p.get("ux") or {}).get("tasks")
    if not tasks:
        sys.exit(f"{p.id}: project.json has no ux.tasks")
    prices = usage.load_prices(PATHS.frozen / "prices.json")
    lg, guard = ledger_guard()
    ok, why = guard.check_launch(2.0)
    if not ok:
        sys.exit(why)
    manifest = json.loads((PATHS.frozen / "suites" / f"{p.id}.json").read_text())
    wc = PATHS.run_dir(st["run_id"]) / "wc"
    work = PATHS.state / "ux" / f"{a.alias}-{a.cp}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    app_wc = work / "app"
    subprocess.run(["git", "-C", str(wc), "worktree", "add", "--detach", str(app_wc), f"bench-{a.cp}"], check=True)
    v = runner.Validator(p, manifest, work)
    allocator = ports.PortAllocator()
    slot = allocator.acquire(f"ux:{a.alias}:{a.cp}")
    try:
        with v.app(app_wc, slot, work / "ux.db", work) as (booted, env, err):
            if not booted:
                sys.exit(f"app did not boot: {err}")
            if (p.get("visual") or {}).get("seed"):
                runner.sh(p.script_argv(p["visual"]["seed"]), p.dir, env)
            jc = JUDGES["opus"]
            ag = agents.CliAgent(jc["provider"], jc["model"], jc["effort"], work, work / "cfg", work / "turns", lg,
                                 guard, prices, f"ux:{a.alias}:{a.cp}", "opus", kind="ux")
            (work / "cfg").mkdir(exist_ok=True)
            shutil.copy2(p.path(tasks), work / "ux-tasks.md")
            ag.turn("ux", runner.tpl("ux-agent.md", alias=a.alias, cp_id=a.cp, base_url=env["BASE_URL"],
                                      tasks_path="ux-tasks.md", out_path="ux-report.json"))
    finally:
        allocator.release(slot)
        subprocess.run(["git", "-C", str(wc), "worktree", "remove", "--force", str(app_wc)])
    rep = work / "ux-report.json"
    if rep.exists():
        uxf = PATHS.scores / "ux.json"
        data = json.loads(uxf.read_text()) if uxf.exists() else {}
        data.setdefault(a.alias, {})[a.cp] = json.loads(rep.read_text()).get("usability_rating")
        uxf.parent.mkdir(parents=True, exist_ok=True)
        uxf.write_text(json.dumps(data, indent=2))
    return 0


def cmd_score(a):
    fz = json.loads(FREEZE.read_text()) if FREEZE.exists() else {"seed": 0, "suites": {}}
    states = all_states()
    projects = load_projects(sorted({s["project"] for s in states}) or None, strict=False)
    scored = report.score_runs(states, projects, PATHS, seed=fz["seed"])
    PATHS.scores.mkdir(parents=True, exist_ok=True)
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "freeze": fz.get("commit"),
           "harness_sha256": harness_sha(), "budget": ledger_guard()[1].status(), **scored}
    (PATHS.scores / "scores.json").write_text(json.dumps(out, indent=2, default=str))
    print(report.table(scored))
    for prob in scored["problems"]:
        print(f"  - {prob}")
    print(f"wrote {PATHS.scores / 'scores.json'}")
    return 0


def cmd_budget(a):
    lg, guard = ledger_guard()
    if a.action == "ack":
        guard.ack(int(a.level))
    if a.action == "reconcile":
        inv = json.loads(Path(a.invoice).read_text())  # {"anthropic": usd, "openai": usd} from the usage/cost reports
        prov = {"anthropic": 0.0, "openai": 0.0}
        for e in lg.entries():
            m = e.get("model") or ""
            prov["anthropic" if m.startswith("claude") else "openai"] += e["billed_usd"]
        for k, v in prov.items():
            print(k, usage.reconcile(v, inv.get(k)))
    print(json.dumps(guard.status(), indent=1))
    return 0


def cmd_export(a):
    dst = Path(a.dst)
    for st in all_states():
        src = PATHS.run_state(st["run_id"])
        blind.export_scrubbed(src, dst / st["alias"])
    if (PATHS.scores / "scores.json").exists():
        blind.export_scrubbed(PATHS.scores, dst / "scores")
    print(f"exported to {dst}")
    return 0


def cmd_status(a):
    for st in all_states():
        cps = {cp: ("ok" if r.get("final", {}).get("ok") else "fail" if r.get("final") else "...")
               for cp, r in st["checkpoints"].items()}
        print(f"{st['run_id']:<38} {st['status']:<16} {cps}")
    print(json.dumps(ledger_guard()[1].status(), indent=1))
    return 0


def cmd_deviation(a):
    f = PATHS.state / "deviations.jsonl"
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "a") as fh:
        fh.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "text": a.text}) + "\n")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate")
    f = sub.add_parser("freeze")
    f.add_argument("--commit", required=True)
    f.add_argument("--prices", default=str(HARNESS / "prices.json"))
    f.add_argument("--allow-missing", action="store_true")
    sub.add_parser("schedule")
    sub.add_parser("preflight")
    d = sub.add_parser("dry-run")
    d.add_argument("--project")
    d.add_argument("--project-dir", help="any folder with a project.json (e.g. a test fixture)")
    d.add_argument("--no-visual", action="store_true")
    d.add_argument("--verbose", action="store_true")
    s = sub.add_parser("selftest")
    s.add_argument("--no-visual", action="store_true")
    s.add_argument("--verbose", action="store_true")
    r = sub.add_parser("run")
    r.add_argument("--pilot", action="store_true")
    r.add_argument("--model", choices=list(MODELS))
    r.add_argument("--project")
    r.add_argument("--blocks")
    r.add_argument("--publish", action="store_true")
    po = sub.add_parser("post")
    po.add_argument("run_ids", nargs="*")
    j = sub.add_parser("judge")
    j.add_argument("action", choices=["prepare", "run"])
    j.add_argument("--kind", choices=["code", "visual"], default="code")
    j.add_argument("--judge", choices=list(JUDGES))
    u = sub.add_parser("ux")
    u.add_argument("action", choices=["run"])
    u.add_argument("alias")
    u.add_argument("cp")
    sub.add_parser("score")
    b = sub.add_parser("budget")
    b.add_argument("action", choices=["status", "ack", "reconcile"])
    b.add_argument("level", nargs="?")
    b.add_argument("--invoice")
    e = sub.add_parser("export")
    e.add_argument("dst")
    sub.add_parser("status")
    dv = sub.add_parser("deviation")
    dv.add_argument("text")
    a = ap.parse_args(argv)
    if a.cmd == "selftest":
        a.project = None
        return cmd_dry_run(a)
    return {"validate": cmd_validate, "freeze": cmd_freeze, "schedule": cmd_schedule, "preflight": cmd_preflight,
            "dry-run": cmd_dry_run, "run": cmd_run, "post": cmd_post, "judge": cmd_judge, "ux": cmd_ux,
            "score": cmd_score, "budget": cmd_budget, "export": cmd_export, "status": cmd_status,
            "deviation": cmd_deviation}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
