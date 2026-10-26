"""Generic run orchestration: one run = one (project, model, arm, rep) working copy built checkpoint by checkpoint.

Per checkpoint: add SPEC/<cp spec> to the working copy (later specs stay hidden: P3 requirements change at CP4), one
model turn, hidden validation, up to 3 fix turns, commit + tag `bench-<cp>`, per-checkpoint screenshots. A turn whose
arm skill did not load (or whose transcript shows a foreign skill) invalidates the run (rerun from scratch); a suite
mismatch or a test-runner error marks a harness failure (rerun from scratch, never subtracted); the per-run stop-loss
stops the run, which is scored with the checkpoints it completed.

Post phases per finished run: C6 mutations (patch mode on the reference / agent mode on model code) and the
maintenance agent. `dry_run()` runs all of it against a project's reference implementation with zero model calls.
"""

import json
import shutil
import string
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from . import agents, arms, blind, schedule, scoring, suite, visual
from .config import (GIT_IDENTITY, HARNESS, MAINTENANCE_MAX_FIXES, MAX_FIX_ATTEMPTS, MODELS,
                     PLAN_DIR, PROMPTS_DIR, Paths)
from .ledger import BudgetGuard, Ledger
from .project import load as load_project
from .ports import PortAllocator
from .validator import Validator, machine_lock, sh

_print_lock = threading.Lock()
WC_EXCLUDES = ["node_modules/", ".venv/", "__pycache__/", "data/", "*.db", "*.db-*", ".turbo/", "dist/"]


def tpl(name, **kw):
    return string.Template((PROMPTS_DIR / name).read_text()).safe_substitute(**kw).strip()


def clone_tree(src, dst):
    """APFS clone when available (fast, keeps node_modules symlinks), else a plain copy."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["cp", "-cR", str(src), str(dst)], capture_output=True)
    if r.returncode != 0:
        shutil.copytree(src, dst, symlinks=True)


class HarnessFailure(RuntimeError):
    pass


class Run:
    def __init__(self, project, spec, paths, manifest, ledger, guard, prices, slot, dry_run=False, log=None,
                 visual_capture=True, publish=False):
        self.p, self.spec, self.paths, self.manifest = project, spec, paths, manifest
        self.ledger, self.guard, self.prices, self.slot = ledger, guard, prices, slot
        self.dry_run, self.visual_capture, self.publish_prs = dry_run, visual_capture, publish
        self.id, self.arm, self.model_key, self.rep = spec["run_id"], spec["arm"], spec["model"], spec["rep"]
        self.alias = spec.get("alias")
        self.mcfg = MODELS[self.model_key]
        self.provider = self.mcfg["provider"]
        self.state_dir = paths.run_state(self.id)
        self.wc = paths.run_dir(self.id) / "wc"
        self.cfg = self.state_dir / "agent-config"
        self.home = self.state_dir / "home"
        self.turns_dir = self.state_dir / "turns"
        self.validator = Validator(project, manifest, self.state_dir, log=self.log)
        self._log = log
        self.agent = None

    # ---------------------------------------------------------------- utils
    def log(self, msg):
        line = f"{time.strftime('%H:%M:%S')} [{self.id}] {msg}"
        with _print_lock:
            (self._log or print)(line)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with open(self.state_dir / "orchestrator.log", "a") as f:
            f.write(line + "\n")

    def load(self):
        f = self.state_dir / "state.json"
        if f.exists():
            return json.loads(f.read_text())
        return {"run_id": self.id, "alias": self.alias, "project": self.p.id, "model": self.model_key,
                "model_id": self.mcfg["model"], "provider": self.provider, "arm": self.arm, "rep": self.rep,
                "status": "new", "dry_run": self.dry_run, "session_id": None, "codex_prev": None, "checkpoints": {},
                "activation": [], "model_ids": [], "problems": [], "suite_sha256": self.manifest["sha256"]}

    def save(self, st):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_dir / "state.json.tmp"
        tmp.write_text(json.dumps(st, indent=2, default=str))
        tmp.replace(self.state_dir / "state.json")

    def git(self, *args, check=True, cwd=None):
        r = subprocess.run(["git", *GIT_IDENTITY, "-C", str(cwd or self.wc), *args], capture_output=True, text=True)
        if check and r.returncode != 0:
            raise HarnessFailure(f"git {' '.join(args)}: {r.stderr[-500:]}")
        return r.stdout.strip()

    def ports(self):
        return {"api_port": self.slot["api_port"], "web_port": self.slot["web_port"]}

    # ---------------------------------------------------------------- setup
    def setup(self):
        st = self.load()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if not self.wc.exists():
            base = self.p["base"]
            if base["type"] == "dir":
                shutil.copytree(self.p.path(base["path"]), self.wc, symlinks=True,
                                ignore=shutil.ignore_patterns("node_modules", ".venv", "__pycache__", ".git"))
                self.git("init", "-q", "-b", "main")
            else:
                subprocess.run(["git", "clone", "-q", base["repo"], str(self.wc)], check=True)
                self.git("checkout", "-q", "-B", "main", base["commit"])
                self.git("remote", "remove", "origin", check=False)
            excl = self.wc / ".git" / "info" / "exclude"
            excl.parent.mkdir(parents=True, exist_ok=True)
            excl.write_text((excl.read_text() if excl.exists() else "") + "\n".join(WC_EXCLUDES) + "\n")
            self.git("add", "-A")
            self.git("commit", "-q", "--allow-empty", "-m", "chore: starting scaffold")
            self.git("tag", "-f", "bench-base")
        st["base_commit"] = self.git("rev-parse", "bench-base")
        leaks = suite.leaks(self.wc, self.manifest)
        if leaks:
            raise HarnessFailure(f"hidden files present in the working copy: {leaks}")
        self.cfg.mkdir(parents=True, exist_ok=True)
        if self.provider == "claude":
            (self.cfg / "settings.json").write_text(json.dumps(arms.claude_settings(self.wc), indent=2))
        else:
            self.home.mkdir(exist_ok=True)
            node = 'export PATH="{}:$PATH"\n'.format(agents.NODE_BIN)
            for rc in (".zprofile", ".zshrc", ".bash_profile", ".bashrc"):
                (self.home / rc).write_text(node)
        st["skill"] = None
        inst = arms.install(self.arm, self.provider, self.cfg)
        if inst:
            st["skill"] = {"name": inst["skill"], "sha256": inst["sha256"], "invocation":
                           arms.invocation(self.arm, self.provider)}
        st["isolation_problems"] = arms.verify_isolation(self.provider, self.arm, self.cfg,
                                                         self.home if self.provider == "codex" else None, self.wc)
        if st["isolation_problems"] and not self.dry_run:
            self.save(st)
            raise HarnessFailure(f"isolation check failed: {st['isolation_problems']}")
        self.save(st)
        self.log(f"setup ok: wc={self.wc} ports={self.ports()} arm={self.arm} skill={st['skill']}")

    def make_agent(self):
        if self.dry_run:
            return agents.ReferenceAgent(self.p.path(self.p["reference"]), self.wc,
                                         stages=getattr(self, "reference_stages", None), cp_ids=self.p.cp_ids())
        a = agents.CliAgent(self.provider, self.mcfg["model"], self.mcfg["effort"], self.wc, self.cfg, self.turns_dir,
                            self.ledger, self.guard, self.prices, self.id, self.model_key, kind="model",
                            fake_home=self.home if self.provider == "codex" else None,
                            env_extra={"API_PORT": str(self.slot["api_port"]), "WEB_PORT": str(self.slot["web_port"])},
                            log=self.log)
        a.prepare_codex_home()
        return a

    # ---------------------------------------------------------------- prompts
    def rules(self):
        cmds = [c for k in ("lint", "test") for c in (self.p.get(k) or [])]
        checks = f" Before finishing make sure {' and '.join(f'`{c}`' for c in cmds)} pass." if cmds else ""
        return tpl("rules.md", api_port=self.slot["api_port"], web_port=self.slot["web_port"], checks=checks)

    def prompt(self, cp, fix_report=None):
        idx = self.p.cp_ids().index(cp)
        if fix_report:
            body = tpl("fix.md", cp_id=cp, report=fix_report, rules=self.rules())
        else:
            prev = self.p.cp_ids()[:idx]
            keep = f" Keep {', '.join(prev)} working." if prev else ""
            body = tpl("checkpoint.md", cp_id=cp, cp_title=self.p.title(cp),
                       spec_file=Path(self.p.cp(cp)["spec"]).name, keep=keep, rules=self.rules())
        return arms.build_prompt(self.arm, self.provider, body)

    def add_spec(self, cp):
        src = self.p.path(self.p.cp(cp)["spec"])
        dst = self.wc / "SPEC" / src.name
        dst.parent.mkdir(exist_ok=True)
        shutil.copy2(src, dst)

    # ---------------------------------------------------------------- turns
    def transcripts_root(self):
        return self.cfg / ("projects" if self.provider == "claude" else "sessions")

    def do_turn(self, st, rec, label, prompt):
        before = arms.marker_counts(self.transcripts_root())
        t = self.agent.turn(label, prompt, st.get("session_id"), st.get("codex_prev"))
        rec["turns"].append({k: v for k, v in t.items() if k != "codex_prev"})
        st["session_id"] = t.get("session_id") or st.get("session_id")
        st["codex_prev"] = t.get("codex_prev") or st.get("codex_prev")
        st["model_ids"] = sorted(set(st["model_ids"]) | set(t.get("model_ids") or []))
        if self.dry_run:
            st["activation"].append({"turn": label, "ok": None, "why": "not checked (dry run)"})
        else:
            ok, why = arms.activation_ok(self.arm, before, arms.marker_counts(self.transcripts_root()))
            st["activation"].append({"turn": label, "ok": ok, "why": why})
            if not ok:
                st["status"], st["status_reason"] = "invalid", f"{label}: {why}"
        if t.get("stopped"):
            st["status"], st["status_reason"] = "stopped", f"{label}: {t['stopped']}"
        self.save(st)
        self.log(f"{label}: billed={t['billed_usd']:.4f} list={t['list_estimate_usd']:.4f} usage={t['usage']} "
                 f"attempts={len(t['attempts'])} stopped={t.get('stopped')}")
        return st["status"] == "running"

    def tamper_scan(self):
        """Paths a subject must never touch: hidden suites, harness code, plan, other runs' working copies."""
        needles = [str(self.p.dir), str(HARNESS / "bench"), str(HARNESS / "tests"), str(HARNESS / "prompts"),
                   str(PLAN_DIR)]
        hits = set()
        files = list(self.turns_dir.glob("*.jsonl")) + list(self.transcripts_root().rglob("*.jsonl"))
        runs_root = str(self.paths.runs)
        for f in files:
            text = f.read_text(errors="replace")
            for n in needles:
                if n in text:
                    hits.add(n)
            idx = text.find(runs_root + "/")
            while idx >= 0:
                other = text[idx + len(runs_root) + 1:].split("/", 1)[0]
                if other and other != self.id:
                    hits.add(f"{runs_root}/{other}")
                idx = text.find(runs_root + "/", idx + 1)
        return sorted(hits)

    # ---------------------------------------------------------------- main loop
    def execute(self):
        st = self.load()
        if st["status"] in ("done", "invalid", "harness_failure", "stopped"):
            return st
        st["status"] = "running"
        st.setdefault("started_at", time.time())
        self.save(st)
        self.agent = self.make_agent()
        try:
            for cp in self.p.cp_ids():
                rec = st["checkpoints"].get(cp)
                if rec and rec.get("commit"):
                    continue
                if not self.run_checkpoint(st, cp):
                    break
            if st["status"] == "running":
                st["status"] = "done"
        except suite.SuiteMismatch as e:
            st["status"], st["status_reason"] = "harness_failure", str(e)
        except HarnessFailure as e:
            st["status"], st["status_reason"] = "harness_failure", str(e)
        st["finished_at"] = time.time()
        st["tamper_suspected"] = [] if self.dry_run else self.tamper_scan()
        self.save(st)
        if self.guard is not None and st["status"] in ("done", "stopped"):
            self.guard.mark_run_finished(self.id)
        self.log(f"run {st['status']}: {st.get('status_reason', '')}")
        return st

    def run_checkpoint(self, st, cp):
        c = self.p.cp(cp)
        rec = st["checkpoints"].setdefault(cp, {"turns": [], "validations": [], "fix_attempts": 0,
                                                "started_at": time.time()})
        self.add_spec(cp)
        if not rec["turns"] and not self.do_turn(st, rec, f"{cp}-impl", self.prompt(cp)):
            return False
        db_from = None
        if c.get("reuse_db_from"):
            db_from = st["checkpoints"][c["reuse_db_from"]]["final"].get("persisted_db")
            if not db_from:
                raise HarnessFailure(f"{cp}: no persisted DB from {c['reuse_db_from']}")
        while True:
            label = f"{cp}-v{rec['fix_attempts']}"
            v = self.validator.validate(self.wc, cp, label, self.ports(), db_from=db_from,
                                        seed=bool(c.get("persist_db")))
            if v["runner_errors"]:
                rec["validations"].append(v)
                raise HarnessFailure(f"{label}: test runner error: {v['runner_errors']}")
            rec["validations"].append(v)
            self.save(st)
            self.log(f"{label}: ok={v['ok']} acceptance={v['acceptance_total'] - v['acceptance_failed']}/"
                     f"{v['acceptance_total']} hazards={sum(scoring.passed(t) for t in v['hazards'])}/"
                     f"{len(v['hazards'])} booted={v['booted']} lint={v['lint_ok']} test={v['test_ok']}")
            if v["ok"] or rec["fix_attempts"] >= MAX_FIX_ATTEMPTS:
                break
            rec["fix_attempts"] += 1
            if not self.do_turn(st, rec, f"{cp}-fix{rec['fix_attempts']}", self.prompt(cp, v["report"])):
                return False
        rec["final"] = {"label": v["label"], "ok": v["ok"], "persisted_db": v.get("persisted_db"),
                        "exhausted": (not v["ok"]) and rec["fix_attempts"] >= MAX_FIX_ATTEMPTS}
        if v.get("persisted_db"):
            keep = self.state_dir / "persisted" / f"{cp}.db"
            keep.parent.mkdir(exist_ok=True)
            for f in Path(v["persisted_db"]).parent.glob("app.db*"):
                shutil.copy2(f, keep.parent / f.name.replace("app.db", f"{cp}.db"))
            rec["final"]["persisted_db"] = str(keep)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", f"feat({cp}): {self.p.title(cp).lower()}")
        self.git("tag", "-f", f"bench-{cp}")
        rec["commit"] = self.git("rev-parse", "HEAD")
        rec["finished_at"] = time.time()
        if self.visual_capture:
            rec["visual"] = visual.capture(self.p, self.validator, self.wc, cp, self.ports(),
                                           self.state_dir / "screens" / cp, log=self.log)
        if self.publish_prs:
            rec["pr_url"] = publish(self, cp)
        self.save(st)
        return True


# ---------------------------------------------------------------- publishing (optional, gap 24)
def publish(run, cp, attempts=8):
    pub = run.p.get("publish") or {}
    remote, repo = pub.get("remote"), pub.get("repo")
    if not remote:
        return None
    ids = run.p.cp_ids()
    branch = f"run/{run.alias or run.id}/{cp}"
    base = pub.get("base", "main") if ids.index(cp) == 0 else f"run/{run.alias or run.id}/{ids[ids.index(cp) - 1]}"
    run.git("branch", "-f", branch, "HEAD")
    for i in range(attempts):
        r = subprocess.run(["git", "-C", str(run.wc), "push", "-f", remote, branch], capture_output=True, text=True)
        if r.returncode == 0:
            break
        time.sleep(min(300, 15 * 2 ** i))
    else:
        run.log(f"push failed for {branch}")
        return None
    for i in range(attempts):
        r = subprocess.run(["gh", "pr", "create", "--repo", repo, "--base", base, "--head", branch,
                            "--title", f"[{run.alias}] {cp}", "--body", f"Benchmark run {run.alias}, {cp}."],
                           capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
        time.sleep(min(300, 15 * 2 ** i))
    return None


# ---------------------------------------------------------------- C6 mutations
def run_mutations(run, mode="patch", agent_factory=None):
    st = run.load()
    final_cp = [cp for cp in run.p.cp_ids() if st["checkpoints"].get(cp, {}).get("commit")]
    if not final_cp:
        return None
    cp = final_cp[-1]
    base_v = st["checkpoints"][cp]["validations"][-1]
    baseline = {t["id"]: scoring.passed(t) for t in base_v["acceptance"] + base_v["hazards"]}
    mu = run.p["mutations"]
    mdir = run.p.path(mu.get("dir", "mutations/"))
    descr = {}
    readme = mdir / "README.md"
    for line in (readme.read_text().splitlines() if readme.exists() else []):
        if ":" in line:
            k, v = line.split(":", 1)
            descr[k.strip().lstrip("-* ").strip("`")] = v.strip()
    own_cmds = run.p.get("test") or []
    results = []
    out_dir = run.state_dir / "mutations"
    out_dir.mkdir(exist_ok=True)
    db_from = st["checkpoints"][run.p.cp(cp)["reuse_db_from"]]["final"]["persisted_db"] \
        if run.p.cp(cp).get("reuse_db_from") else None
    baseline_ok = None
    for i in range(1, (mu.get("count") or 0) + 1):
        mid = f"m{i}"
        with tempfile.TemporaryDirectory(prefix=f"mut-{mid}-", dir=run.paths.runs) as tmp:
            mwc = Path(tmp) / "wc"
            clone_tree(run.wc, mwc)
            patch = mdir / f"{mid}.patch"
            entry = {"id": mid, "description": descr.get(mid, ""), "mode": mode}
            if mode == "patch":
                r = subprocess.run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=mwc, capture_output=True,
                                   text=True)
                entry["applied"] = r.returncode == 0
                entry["apply_error"] = r.stderr[-500:] if r.returncode else None
            else:
                agent = agent_factory(mwc, mid)
                prompt = tpl("mutation-agent.md", mutation_id=mid, mutation_description=descr.get(mid, ""),
                             reference_patch=patch.read_text())
                t = agent.turn(f"mutation-{mid}", prompt)
                entry["agent_turn"] = {k: t[k] for k in ("billed_usd", "list_estimate_usd", "usage", "final_message")}
                entry["applied"] = "NOT_APPLICABLE" not in (t.get("final_message") or "")
            diff = subprocess.run(["git", "-C", str(mwc), "diff"], capture_output=True, text=True).stdout
            (out_dir / f"{mid}.applied.patch").write_text(diff)
            entry["stored_patch"] = str(out_dir / f"{mid}.applied.patch")
            if not entry["applied"] or not diff.strip():
                entry.update(hidden_failed=0, own_failed=None, note="not applied: discarded")
                results.append(entry)
                continue
            v = run.validator.validate(mwc, cp, f"mutation-{mid}", run.ports(), db_from=db_from,
                                       run_own_checks=False)
            now = {t["id"]: scoring.passed(t) for t in v["acceptance"] + v["hazards"]}
            entry["hidden_failed"] = sum(1 for k, ok in baseline.items() if ok and now.get(k) is False)
            entry["hidden_failed_ids"] = [k for k, ok in baseline.items() if ok and now.get(k) is False]
            if own_cmds:
                env = run.validator.env(mwc, run.ports(), mwc / "mut.db", Path(v["results_dir"]))
                codes = [sh(c, mwc, env, log=Path(v["results_dir"]) / "own-tests.log")[0] for c in own_cmds]
                entry["own_failed"] = any(c != 0 for c in codes)
            else:
                entry["own_failed"] = None
            results.append(entry)
    if own_cmds:
        env = run.validator.env(run.wc, run.ports(), run.wc / "baseline.db", out_dir)
        baseline_ok = all(sh(c, run.wc, env, log=out_dir / "baseline-own-tests.log")[0] == 0 for c in own_cmds)
    c6 = scoring.c6_from_mutations(results, baseline_ok=bool(baseline_ok)) if own_cmds else \
        {"valid": None, "caught": None, "rating": None, "note": "project has no own-test command"}
    out = {"checkpoint": cp, "mode": mode, "mutations": results, "baseline_ok": baseline_ok, **c6}
    (out_dir / "c6.json").write_text(json.dumps(out, indent=2))
    st["c6"] = out
    run.save(st)
    return out


# ---------------------------------------------------------------- maintenance (plan §6.3; gap 11)
def run_maintenance(run, agent_factory=None):
    st = run.load()
    done = [cp for cp in run.p.cp_ids() if st["checkpoints"].get(cp, {}).get("commit")]
    if not done:
        return None
    cp = done[-1]
    mt = run.p["maintenance"]
    mdir = run.paths.run_dir(run.id) / "maintenance-wc"
    if mdir.exists():
        shutil.rmtree(mdir)
    blind.blind_tree(run.wc, mdir, exclude=(".git", "node_modules", ".venv", "__pycache__"))
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=mdir, check=True)
    subprocess.run(["git", *GIT_IDENTITY, "add", "-A"], cwd=mdir, check=True)
    subprocess.run(["git", *GIT_IDENTITY, "commit", "-q", "-m", "handover"], cwd=mdir, check=True)
    agent = agent_factory(mdir) if agent_factory else agents.NullAgent()
    task = run.p.path(mt["task"]).read_text()
    rules = run.rules()
    before_v = st["checkpoints"][cp]["validations"][-1]
    before = before_v["acceptance"] + before_v["hazards"]
    db_from = st["checkpoints"][run.p.cp(cp)["reuse_db_from"]]["final"]["persisted_db"] \
        if run.p.cp(cp).get("reuse_db_from") else None
    turns, session = [], None
    prompt = tpl("maintenance.md", task=task, rules=rules)
    v = feat = None
    for k in range(MAINTENANCE_MAX_FIXES + 1):
        t = agent.turn(f"maintenance-{k}", prompt, session)
        session = t.get("session_id") or session
        turns.append({k2: t[k2] for k2 in ("label", "billed_usd", "list_estimate_usd", "usage", "wall_s", "stopped")})
        v = run.validator.validate(mdir, cp, f"maintenance-v{k}", run.ports(), db_from=db_from)
        feat, err = _maintenance_tests(run, mdir, cp, db_from, k)
        if err:
            v["runner_errors"].append(err)
        if (feat and all(scoring.passed(x) for x in feat)) or t.get("stopped") or t.get("dry_run") \
                or k == MAINTENANCE_MAX_FIXES:
            break
        failed = [x for x in feat if not scoring.passed(x)]
        prompt = "The new feature still fails these hidden checks. Fix them, keeping everything else working.\n\n" + \
            "\n".join(f"- {x.get('id')}: {(x.get('message') or '')[:300]}" for x in failed) + "\n\n" + rules
    after = v["acceptance"] + v["hazards"]
    cost_b = sum(t["billed_usd"] for t in turns)
    cost_l = sum(t["list_estimate_usd"] for t in turns)
    m_pass = sum(scoring.passed(x) for x in feat) / len(feat) if feat else 0.0
    reg = scoring.regressions(before, after)
    pr_b = scoring.protection_retention(before_v["hazards"])["pr"]
    pr_a = scoring.protection_retention(v["hazards"])["pr"]
    cost = cost_b or cost_l
    out = {"checkpoint": cp, "turns": turns, "M_turns": len(turns), "M_cost_billed": cost_b, "M_cost_list": cost_l,
           "M_pass": m_pass, "M_regression": reg["rate"], "regressed": reg["ids"],
           "delta_PR": (pr_a - pr_b) if pr_a is not None and pr_b is not None else None,
           "M": scoring.maintenance_metric(m_pass, reg["rate"], cost), "feature_tests": feat,
           "runner_errors": v["runner_errors"]}
    st["maintenance"] = out
    run.save(st)
    return out


def _maintenance_tests(run, wc, cp, db_from, k):
    results = run.state_dir / "validations" / f"maintenance-feature-{k}"
    if results.exists():
        shutil.rmtree(results)
    results.mkdir(parents=True)
    db = results / "app.db"
    extra = {}
    if db_from:
        shutil.copy2(db_from, db)
        extra["REUSED_DB"] = "1"
    with machine_lock("validation", log=run.log, who=f"{run.id}:maintenance-feature-{k}"), \
            run.validator.app(wc, run.ports(), db, results, extra) as (booted, env, err):
        if not booted:
            return [{"id": "maintenance-boot", "status": "fail", "message": err}], None
        tests, error = run.validator.run_script(run.p["maintenance"]["acceptance"], env, results, "maintenance")
    return tests, error


# ---------------------------------------------------------------- dry run / self-test (plan §10 last rule; gap 22)
def reference_stages(p, work_dir):
    """Per-checkpoint reference states: {cp_id: dir}. A project provides them as `stages/<cp>.patch` (or
    project.json "reference_stages": {cp: patch}), each turning a copy of the final reference into the reference as
    it was at the end of that checkpoint (`patch -p1 -E`). Checkpoint X uses the first stage at or after X; with no
    later stage it uses the final reference. Without stages every checkpoint gets the final reference."""
    declared = p.get("reference_stages") or {}
    patches = {}
    for cp in p.cp_ids():
        rel = declared.get(cp) or f"stages/{cp}.patch"
        if p.path(rel).is_file():
            patches[cp] = p.path(rel)
    if not patches:
        return None
    ref = p.path(p["reference"])
    work_dir = Path(work_dir)
    if work_dir.exists():
        shutil.rmtree(work_dir)
    built = {}
    for cp, patch in patches.items():
        dst = work_dir / cp
        shutil.copytree(ref, dst, symlinks=True,
                        ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__", ".venv", "data"))
        with open(patch) as f:
            r = subprocess.run(["patch", "-p1", "-E", "-s"], cwd=dst, stdin=f,
                               capture_output=True, text=True)
        if r.returncode != 0:
            raise HarnessFailure(f"reference stage {patch}: patch failed: {(r.stdout + r.stderr)[-500:]}")
        built[cp] = dst
    ids = p.cp_ids()
    out = {}
    for i, cp in enumerate(ids):
        later = [c for c in ids[i:] if c in built]
        out[cp] = built[later[0]] if later else ref
    return out


def dry_run(project_dir, paths=None, visual=True, arms_subset=None, model="sonnet", log=None):
    paths = paths or Paths(root=HARNESS / ".dryrun")
    p = load_project(project_dir)
    manifest = suite.freeze(p)
    ledger = Ledger(paths.state / "ledger.jsonl")
    guard = BudgetGuard(ledger, paths.state / "budget-state.json")
    sched = schedule.build_schedule(0, [model], [p.id], list(arms_subset or ("base", "ponytail", "placebo")), reps=[1])
    stages = reference_stages(p, paths.root / "reference-stages")
    allocator = PortAllocator()
    runs, calls = [], 0
    for spec in sched["blocks"][0]["runs"]:
        with allocator.lease(f"dry-run:{spec['run_id']}") as slot:
            r = Run(p, spec, paths, manifest, ledger, guard, None, slot, dry_run=True, log=log or (lambda m: None),
                    visual_capture=visual)
            r.reference_stages = stages
            r.setup()
            r.execute()
            run_mutations(r, mode="patch")
            run_maintenance(r)
        calls += getattr(r.agent, "calls", 0) or 0
        runs.append(r)
    from . import report
    scored = report.score_runs([r.load() for r in runs], {p.id: p}, paths)
    problems = selftest_problems(p, scored, manifest)
    return {"project": p.id, "suite_sha256": manifest["sha256"], "model_calls": calls, "runs": scored["runs"],
            "success": scored["success"], "selftest": {"ok": not problems, "problems": problems},
            "ledger": {"billed_usd": ledger.total_billed(), "list_estimate_usd": ledger.total_list_estimate()},
            "state_dir": str(paths.state), "runs_dir": str(paths.runs)}


def selftest_problems(p, scored, manifest):
    probs = []
    for rid, r in scored["runs"].items():
        if r["status"] != "done":
            probs.append(f"{rid}: status {r['status']} ({r.get('status_reason')})")
            continue
        for cp, c in r["checkpoints"].items():
            failed = [t["id"] for t in c["acceptance_tests"] if not scoring.passed(t)]
            if failed:
                probs.append(f"{rid} {cp}: reference fails acceptance {failed}")
        last = r["checkpoints"][p.cp_ids()[-1]]
        if last["pr"]["pr"] != 100:
            probs.append(f"{rid}: reference PR {last['pr']['pr']} != 100 (failed {last['pr']['failed']})")
        c6 = r.get("c6") or {}
        for m in c6.get("mutations", []):
            if not m.get("hidden_failed"):
                probs.append(f"{rid}: mutation {m['id']} breaks no hidden test (invalid mutant: {m.get('note', '')})")
        if r["suite_sha256"] != manifest["sha256"]:
            probs.append(f"{rid}: suite hash mismatch")
    return probs
