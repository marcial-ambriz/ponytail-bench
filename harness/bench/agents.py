"""Model turns (gaps 4, 6, 7, 20, 25).

CliAgent runs one headless turn of Claude Code or Codex CLI. Each attempt (a rate-limit retry, an interrupted or a
timed-out attempt included) streams into its own file and is priced and appended to the ledger immediately, so no
attempt's tokens can be lost or overwritten. The budget guard is checked before every attempt; Claude gets the run's
remaining stop-loss as `--max-budget-usd`, and a watchdog kills either CLI when the running estimate passes it
(Codex reports usage only at turn.completed, so its watchdog estimates output from streamed text: ~4 chars/token).

ReferenceAgent and NullAgent make zero model calls (dry run / self-test).
"""

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import sandbox, usage
from .config import CRED_ENV, NODE_BIN, TURN_TIMEOUT_S


class StopTurn(RuntimeError):
    pass


def base_env(extra_path=()):
    e = {k: v for k, v in os.environ.items()
         if not k.startswith(("ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "BENCH_"))}
    e["PATH"] = ":".join([*map(str, extra_path), str(NODE_BIN), e.get("PATH", "")])
    return e


def credentials(provider):
    """(billing_mode, env additions). Reads only environment variables, never credential files."""
    api = os.environ.get(CRED_ENV[provider]["api"])
    if api:
        if provider == "claude":
            return "api", {"ANTHROPIC_API_KEY": api}
        return "api", {"OPENAI_API_KEY": api, "CODEX_API_KEY": api}
    sub = os.environ.get(CRED_ENV[provider]["subscription"])
    if sub:
        if provider == "claude":
            return "subscription", {"CLAUDE_CODE_OAUTH_TOKEN": sub}
        return "subscription", {}  # BENCH_CODEX_AUTH_JSON is written to CODEX_HOME/auth.json at setup
    return None, {}


class CliAgent:
    """One subject/judge/maintenance agent bound to an isolated config dir and a working directory."""

    def __init__(self, provider, model, effort, cwd, cfg_dir, transcripts_dir, ledger, guard, prices, run_id,
                 model_key, kind="model", fake_home=None, env_extra=None, timeout_s=TURN_TIMEOUT_S, log=print,
                 read_scope=None):
        self.provider, self.model, self.effort = provider, model, effort
        self.cwd, self.cfg_dir, self.dir = Path(cwd), Path(cfg_dir), Path(transcripts_dir)
        self.ledger, self.guard, self.prices = ledger, guard, prices
        self.run_id, self.model_key, self.kind = run_id, model_key, kind
        self.fake_home, self.env_extra, self.timeout_s, self.log = fake_home, env_extra or {}, timeout_s, log
        self.billing_mode, self.cred_env = credentials(provider)
        self.read_scope = read_scope  # (allow, deny) roots: fence the CLI with sandbox-exec
        self.calls = 0

    # ---- environment
    def env(self):
        e = base_env()
        e.update(self.env_extra)
        e.update(self.cred_env)
        if self.provider == "claude":
            e["CLAUDE_CONFIG_DIR"] = str(self.cfg_dir)
        else:
            e["CODEX_HOME"] = str(self.cfg_dir)
            if self.fake_home:
                e["HOME"] = str(self.fake_home)
        return e

    def prepare_codex_home(self):
        auth = os.environ.get(CRED_ENV["codex"]["subscription"])
        if self.provider == "codex" and auth and self.billing_mode == "subscription":
            f = self.cfg_dir / "auth.json"
            f.write_text(auth)
            f.chmod(0o600)

    def command(self, prompt, session_id, budget_usd):
        if self.provider == "claude":
            cmd = ["claude", "-p", prompt, "--model", self.model, "--effort", self.effort,
                   "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
                   "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome"]
            if self.billing_mode == "api" and budget_usd is not None:
                cmd += ["--max-budget-usd", f"{max(budget_usd, 0.01):.2f}"]
            if session_id:
                cmd += ["--resume", session_id]
            return self._fence(cmd)
        base = ["codex", "exec"] + (["resume"] if session_id else [])
        cmd = base + ["-m", self.model, "-c", f"model_reasoning_effort={self.effort}", "--json",
                      "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
        return self._fence(cmd + ([session_id, prompt] if session_id else [prompt]))

    def _fence(self, cmd):
        if not self.read_scope:
            return cmd
        allow, deny = self.read_scope
        return sandbox.wrap(cmd, deny, allow)

    def scope_roots(self, deny_extra=()):
        """Default fence for subject-facing agents: own working copy, config, home and transcripts only."""
        own = [self.cwd, self.cfg_dir, self.dir, *([self.fake_home] if self.fake_home else [])]
        self.read_scope = (own, [*sandbox.STUDY_ROOTS, *deny_extra])
        return self

    # ---- one turn = one or more attempts
    def turn(self, label, prompt, session_id=None, codex_prev=None):
        if self.billing_mode is None:
            raise StopTurn(f"no credentials in env ({CRED_ENV[self.provider]}) for {self.provider}")
        attempts, t_start = [], time.time()
        while True:
            ok, why = self.guard.check_turn(self.run_id, self.model_key) if self.kind == "model" else \
                self.guard.check_launch(0.0) if self.guard else (True, "ok")
            if not ok:
                return self._result(label, attempts, session_id, t_start, stopped=why)
            budget = self.guard.run_remaining(self.run_id, self.model_key) if self.kind == "model" else None
            path = usage.next_attempt_path(self.dir, label)
            a = self._attempt(path, self.command(prompt, session_id, budget), budget, session_id, codex_prev)
            attempts.append(a)
            session_id = a.get("session_id") or session_id
            if a["provider_view"].get("cumulative") is not None:
                codex_prev = a["provider_view"]
            if a.get("rate_limited_until") and not a.get("killed"):
                wait = max(60, float(a["rate_limited_until"]) - time.time() + 60)
                self.log(f"{self.run_id} {label}: rate limited, sleeping {int(wait)}s (attempt kept: {path.name})")
                time.sleep(wait)
                continue
            if a.get("killed"):
                return self._result(label, attempts, session_id, t_start, stopped=a["killed"], codex_prev=codex_prev)
            return self._result(label, attempts, session_id, t_start, codex_prev=codex_prev)

    def _attempt(self, path, cmd, budget, session_id, codex_prev):
        self.calls += 1
        t0 = time.time()
        killed = {"reason": None}
        with open(path, "w") as out:
            proc = subprocess.Popen(cmd, cwd=self.cwd, env=self.env(), stdout=out, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
            stop = threading.Event()
            watchdog = threading.Thread(target=self._watch, args=(proc, path, budget, killed, stop), daemon=True)
            watchdog.start()
            try:
                proc.wait(timeout=self.timeout_s)
            except subprocess.TimeoutExpired:
                killed["reason"] = f"turn timeout {self.timeout_s}s"
                self._kill(proc)
            stop.set()
            watchdog.join(timeout=5)
        lines = path.read_text(errors="replace").splitlines()
        if self.provider == "claude":
            view = usage.parse_claude_stream(lines)
            u = view["totals"]
        else:
            view = usage.parse_codex_stream(lines)
            prev = [codex_prev] if codex_prev and codex_prev.get("session_id") == view.get("session_id") else []
            u = usage.codex_deltas(prev + [view])[-1]
        model_ids = view.get("model_ids") or [self.model]
        p = usage.model_prices(self.prices, model_ids[0] if model_ids else self.model) if self.prices else None
        usd = usage.price(u, p) if p else 0.0
        cost = usage.split_cost(usd, self.billing_mode)
        a = {"file": path.name, "cmd": [c if len(c) < 120 else "<prompt>" for c in cmd], "exit": proc.returncode,
             "wall_s": round(time.time() - t0, 1), "usage": u, "complete": view.get("complete"),
             "session_id": view.get("session_id") or session_id, "model_ids": model_ids,
             "rate_limited_until": view.get("rate_limited_until"), "killed": killed["reason"],
             "final_message": view.get("final_message"), "reported_cost_usd": view.get("reported_cost_usd"),
             "result_usage": view.get("result_usage"), "provider_view": {k: view.get(k) for k in ("session_id",
                                                                                                   "cumulative")},
             **cost}
        if self.ledger is not None:
            self.ledger.append({"run_id": self.run_id, "kind": self.kind, "attempt_id": f"{self.run_id}/{path.name}",
                                "model": model_ids[0] if model_ids else self.model, "tokens": u,
                                "billed_usd": cost["billed_usd"], "list_estimate_usd": cost["list_estimate_usd"],
                                "billing_mode": cost["billing_mode"]})
        return a

    def _watch(self, proc, path, budget, killed, stop):
        if budget is None or not self.prices:
            return
        p = usage.model_prices(self.prices, self.model)
        while not stop.wait(15):
            if proc.poll() is not None:
                return
            try:
                lines = path.read_text(errors="replace").splitlines()
            except OSError:
                continue
            if self.provider == "claude":
                est = usage.price(usage.parse_claude_stream(lines)["totals"], p)
            else:
                chars = sum(len(x) for x in lines)
                est = (chars / 4) * float(p["output"]) / 1e6
            if self.billing_mode == "api" and est >= budget:
                killed["reason"] = f"stop-loss watchdog: running estimate {est:.2f} >= remaining {budget:.2f} USD"
                self._kill(proc)
                return

    @staticmethod
    def _kill(proc):
        try:
            os.killpg(proc.pid, 15)
            proc.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired, PermissionError):
            try:
                os.killpg(proc.pid, 9)
            except ProcessLookupError:
                pass

    def _result(self, label, attempts, session_id, t_start, stopped=None, codex_prev=None):
        return {"label": label, "attempts": attempts, "session_id": session_id,
                "usage": usage.sum_usage(a["usage"] for a in attempts),
                "billed_usd": sum(a["billed_usd"] for a in attempts),
                "list_estimate_usd": sum(a["list_estimate_usd"] for a in attempts),
                "wall_s": round(sum(a["wall_s"] for a in attempts), 1), "elapsed_s": round(time.time() - t_start, 1),
                "final_message": attempts[-1]["final_message"] if attempts else None,
                "model_ids": sorted({m for a in attempts for m in a["model_ids"]}),
                "stopped": stopped, "codex_prev": codex_prev, "dry_run": False}


def zero_turn(label, note):
    a = {"file": None, "exit": 0, "wall_s": 0.0, "usage": usage.zero(), "complete": True, "session_id": None,
         "model_ids": [], "killed": None, "final_message": note, "billed_usd": 0.0, "list_estimate_usd": 0.0,
         "billing_mode": "none"}
    return {"label": label, "attempts": [a], "session_id": None, "usage": usage.zero(), "billed_usd": 0.0,
            "list_estimate_usd": 0.0, "wall_s": 0.0, "elapsed_s": 0.0, "final_message": note, "model_ids": [],
            "stopped": None, "codex_prev": None, "dry_run": True}


class ReferenceAgent:
    """Dry run: the 'model' writes the project's reference implementation. Zero model calls.

    With `stages` ({cp_id: dir}, see runner.reference_stages) the first turn of each checkpoint switches the working
    copy to that checkpoint's reference state (files of the previous state that the new one lacks are removed), so
    persisted-DB migrations between checkpoints run for real. Without stages the final reference is written once.
    """

    calls = 0
    SKIP = ("node_modules", ".git", "__pycache__", ".venv", "data")

    def __init__(self, reference_dir, wc, stages=None, cp_ids=None):
        self.reference_dir, self.wc = Path(reference_dir), Path(wc)
        self.stages, self.cp_ids = stages or {}, list(cp_ids or [])
        self.done = False
        self.current, self.written = None, set()

    def _files(self, src):
        for p in sorted(Path(src).rglob("*")):
            rel = p.relative_to(src)
            if any(part in self.SKIP for part in rel.parts):
                continue
            yield rel, p

    def _write(self, src):
        new = set()
        for rel, p in self._files(src):
            dst = self.wc / rel
            if p.is_dir() and not p.is_symlink():
                dst.mkdir(parents=True, exist_ok=True)
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.is_symlink() or (dst.exists() and not dst.is_dir()):
                dst.unlink()
            shutil.copy2(p, dst, follow_symlinks=False)
            new.add(rel)
        for rel in sorted(self.written - new, key=lambda r: len(r.parts), reverse=True):
            dst = self.wc / rel
            if dst.is_file() or dst.is_symlink():
                dst.unlink()
            parent = dst.parent
            while parent != self.wc and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        self.written = new
        self.current = Path(src)

    def turn(self, label, prompt, session_id=None, codex_prev=None):
        cp = label.split("-", 1)[0]
        if self.stages and cp in self.stages:
            src = Path(self.stages[cp])
            if src != self.current:
                self._write(src)
                self.done = True
                return zero_turn(label, f"reference state for {cp} written (dry run)")
            return zero_turn(label, "reference unchanged (dry run)")
        if not self.done:
            self._write(self.reference_dir)
            self.done = True
        return zero_turn(label, "reference implementation copied (dry run)")


class NullAgent:
    calls = 0

    def turn(self, label, prompt, session_id=None, codex_prev=None):
        return zero_turn(label, "no-op agent (dry run)")
