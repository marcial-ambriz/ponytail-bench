"""Hidden-suite validation of one working copy at one checkpoint (CONTRACT runner protocol; gaps 8, 9, 10, 19).

Order: verify the frozen suite hash -> setup/install -> lint/own tests -> boot (fresh DB, or a copy of a persisted one)
-> acceptance of every checkpoint <= current (cumulative; deduplicated by test id) -> hazards for the current
checkpoint (a failing concurrency hazard is re-run once) -> optional seed + DB persistence -> stop.
Boot through stop runs under the machine-wide `validation` lock (one app stack under test per machine; model turns
and setup/lint/own tests stay concurrent). The app's ports must be free before boot; teardown kills only the
processes the app launched (tracked PIDs), never a foreign listener.
Only acceptance failures (plus boot/lint/test output) are reported back to the model; hazard results never are.
"""

import contextlib
import fcntl
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import suite
from .agents import base_env
from .config import RACE_RETRIES, global_dir
from .ports import port_free
from .project import expand

def tests_due(deferred, rec, final=False):
    """Own tests run every validation unless the project defers them (P2: CTFd's suite takes most of a validation);
    deferred tests run once acceptance is green, and always on a checkpoint's last validation."""
    if not deferred or final:
        return True
    acc = rec["acceptance"]
    return bool(rec["booted"] and acc and not rec["runner_errors"]
                and all(t.get("status") in ("pass", "passed") for t in acc))


def sh(cmd, cwd, env, timeout=1800, log=None):
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, shell=isinstance(cmd, str), capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        out, code = (r.stdout or "") + (r.stderr or ""), r.returncode
    except subprocess.TimeoutExpired as e:
        out, code = f"timeout after {timeout}s\n{e.stdout or ''}", 124
    if log:
        with open(log, "a") as f:
            f.write(f"$ {cmd if isinstance(cmd, str) else ' '.join(cmd)}  (exit {code}, {time.time() - t0:.1f}s)\n"
                    f"{out[-20000:]}\n")
    return code, out


def _ps_table():
    r = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid="], capture_output=True, text=True)
    rows = []
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3 and all(x.isdigit() for x in parts):
            rows.append(tuple(int(x) for x in parts))
    return rows


def owned_pids(root_pid):
    """Live processes started by `root_pid`: its descendants plus every member of its process group."""
    rows = _ps_table()
    children = {}
    out = set()
    for pid, ppid, pgid in rows:
        children.setdefault(ppid, []).append(pid)
        if pgid == root_pid:
            out.add(pid)
    stack, seen = [root_pid, *out], set()  # walk from the root and from every group member
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        out.add(cur)
        stack.extend(children.get(cur, []))
    alive = {pid for pid, _, _ in rows}
    return out & alive


def listeners(port):
    r = subprocess.run(["lsof", "-nP", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    return {int(x) for x in r.stdout.split() if x.isdigit()}


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class ProcessTracker:
    """Records every PID the app launched (sampled while it runs) so teardown kills exactly those and nothing else.

    Detached children (own session, reparented) stay tracked once seen; processes this run did not start are never
    signalled, even when they listen on our ports.
    """

    def __init__(self, root_pid, interval=0.5):
        self.root, self.pids, self._stop = root_pid, {root_pid}, threading.Event()
        self._t = threading.Thread(target=self._loop, args=(interval,), daemon=True)
        self._t.start()

    def sample(self):
        with contextlib.suppress(OSError):
            self.pids |= owned_pids(self.root)

    def _loop(self, interval):
        while not self._stop.wait(interval):
            self.sample()

    def stop(self):
        self._stop.set()
        self._t.join(timeout=5)
        self.sample()
        return set(self.pids)


def terminate_owned(proc, tracked, ports, log=None, grace=15):
    """SIGTERM then SIGKILL the app's process group and every tracked PID; never touch foreign processes."""
    for port in ports:  # listeners on our ports that descend from the app (e.g. a dev server's worker)
        for pid in listeners(port):
            if pid in tracked:
                continue
            if log:
                log(f"port {port}: listener pid {pid} was not started by this run; left alone")
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGTERM)
    for pid in tracked:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=grace)
    deadline = time.time() + 5
    while time.time() < deadline and any(_alive(p) for p in tracked if p != proc.pid):
        time.sleep(0.2)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)
    for pid in tracked:
        if _alive(pid):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)
    deadline = time.time() + 10
    while time.time() < deadline and not all(port_free(p) for p in ports):
        time.sleep(0.2)


_lock_meta = threading.Lock()
_thread_locks = {}
_held = threading.local()


@contextlib.contextmanager
def machine_lock(name, log=print, who=None):
    """Exclusive machine-wide lock (flock in global_dir(), shared by every process and checkout). Reentrant per
    thread. Logs a line naming the current holder while waiting."""
    path = global_dir() / f"{name}.lock"
    key = str(path)
    held = getattr(_held, "names", None)
    if held is None:
        held = _held.names = {}
    if held.get(key):
        held[key] += 1
        try:
            yield
        finally:
            held[key] -= 1
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock_meta:
        tl = _thread_locks.setdefault(key, threading.Lock())
    holder = path.with_suffix(".holder")
    f = open(path, "a+")
    try:
        got = tl.acquire(blocking=False)
        if got:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                tl.release()
                got = False
        if not got:
            try:
                info = holder.read_text().strip()
            except OSError:
                info = "unknown holder"
            t0 = time.time()
            if log:
                log(f"waiting for machine-wide {name} lock ({path}); held by {info}")
            tl.acquire()
            try:
                fcntl.flock(f, fcntl.LOCK_EX)
            except BaseException:
                tl.release()
                raise
            if log:
                log(f"acquired machine-wide {name} lock after {time.time() - t0:.1f}s")
        held[key] = 1
        with contextlib.suppress(OSError):
            holder.write_text(f"{who or 'unnamed'} (pid {os.getpid()}, since {time.strftime('%H:%M:%S')})\n")
        try:
            yield
        finally:
            held[key] = 0
            fcntl.flock(f, fcntl.LOCK_UN)
            tl.release()
    finally:
        f.close()


@contextlib.contextmanager
def race_lock(lock_path=None):
    """Kept for compatibility: race retries now run under the machine-wide validation lock."""
    with machine_lock("validation", log=None, who="race retry"):
        yield


class Validator:
    def __init__(self, project, manifest, state_dir, log=print, boot_timeout_s=None):
        self.p, self.manifest, self.state_dir, self.log = project, manifest, Path(state_dir), log
        self.boot_timeout_s = boot_timeout_s or (project.get("start") or {}).get("timeout_s", 180)

    def env(self, wc, ports, db_path, results):
        e = base_env()
        e.update({"API_PORT": str(ports["api_port"]), "WEB_PORT": str(ports["web_port"]), "DB_PATH": str(db_path),
                  "PORT": str(ports["web_port"]), "WORKDIR": str(wc), "TZ": "UTC", "CI": "1"})
        e["API_URL"] = self.p.url("api_url", e)
        e["BASE_URL"] = self.p.url("base_url", e)
        e["RESULTS_DIR"] = str(results)
        return e

    @contextlib.contextmanager
    def app(self, wc, ports, db_path, results, env_extra=None):
        """Boot the app; yields (booted, env, boot_error)."""
        env = self.env(wc, ports, db_path, results)
        env.update(env_extra or {})
        own_ports = sorted({ports["api_port"], ports["web_port"]})
        busy = []
        for _ in range(20):  # a just-stopped app of ours may still be releasing its socket
            busy = [p for p in own_ports if not port_free(p)]
            if not busy:
                break
            time.sleep(0.5)
        if busy:
            pids = sorted({pid for p in busy for pid in listeners(p)})
            err = (f"port(s) {busy} in use by another process (pids {pids or 'unknown'}); refusing to start and "
                   f"not killing processes this run did not start")
            (results / "app.log").write_text(err + "\n")
            if self.log:
                self.log(err)
            yield False, env, err
            return
        logf = open(results / "app.log", "w")
        proc = subprocess.Popen(self.p["start"]["cmd"], shell=True, cwd=wc, env=env, stdout=logf,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        tracker = ProcessTracker(proc.pid)
        url = expand(self.p["start"]["health_url"], env)
        booted, err, t0 = False, None, time.time()
        try:
            while time.time() - t0 < self.boot_timeout_s:
                if proc.poll() is not None:
                    err = f"app exited with code {proc.returncode} before becoming healthy"
                    break
                try:
                    with urllib.request.urlopen(url, timeout=3) as r:
                        if r.status < 500:
                            booted = True
                            break
                except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
                    pass
                time.sleep(0.5)
            else:
                err = f"health check {url} not ready after {self.boot_timeout_s}s"
            tracker.sample()
            yield booted, env, err
        finally:
            terminate_owned(proc, tracker.stop(), own_ports, log=self.log)
            logf.close()

    def _own_checks(self, keys, wc, env, log, rec, report):
        for key in keys:
            cmds = self.p.get(key) or []
            if cmds:
                oks = []
                for cmd in cmds:
                    code, out = sh(cmd, wc, env, log=log)
                    oks.append(code == 0)
                    if code != 0:
                        report.append(f"`{cmd}` failed:\n{out[-3000:]}")
                rec[f"{key}_ok"] = all(oks)

    def run_script(self, cmd, env, results, name):
        out = results / f"{name}.json"
        e = dict(env, RESULT_JSON=str(out))
        code, text = sh(self.p.script_argv(cmd), cwd=self.p.dir, env=e, timeout=3600, log=results / "runners.log")
        try:
            data = json.loads(out.read_text())
            tests = data.get("tests") if isinstance(data, dict) else None
            if not isinstance(tests, list):
                raise ValueError("no tests[] in RESULT_JSON")
        except (OSError, ValueError) as ex:
            return [], f"{name}: runner error (exit {code}): {ex}; {text[-500:]}"
        if code != 0:
            return tests, f"{name}: runner exit {code} (contract: non-zero only for runner errors)"
        return tests, None

    def validate(self, wc, cp_id, label, ports, db_from=None, seed=False, hazards=True, extra_env=None,
                 run_own_checks=True, final=False):
        wc = Path(wc)
        results = self.state_dir / "validations" / label
        if results.exists():
            shutil.rmtree(results)
        results.mkdir(parents=True)
        rec = {"label": label, "cp": cp_id, "started_at": time.time(), "results_dir": str(results),
               "runner_errors": [], "acceptance": [], "hazards": [], "booted": False, "setup_ok": True,
               "lint_ok": None, "test_ok": None, "persisted_db": None, "reused_db": bool(db_from)}
        rec["suite_sha256"] = suite.verify(self.p, self.manifest)  # raises SuiteMismatch: never run a changed suite
        db_dir = results / "db"
        db_dir.mkdir()
        db_path = db_dir / "app.db"
        env_extra = dict(extra_env or {})
        if db_from:
            for f in Path(db_from).parent.glob(Path(db_from).name + "*"):
                shutil.copy2(f, db_dir / f.name.replace(Path(db_from).name, "app.db"))
            env_extra["REUSED_DB"] = "1"
        env0 = self.env(wc, ports, db_path, results)
        env0.update(env_extra)
        log = results / "build.log"
        report = []
        for cmd in self.p.setup_cmds():
            code, out = sh(cmd, wc, env0, log=log)
            if code != 0:
                rec["setup_ok"] = False
                report.append(f"Setup command `{cmd}` failed:\n{out[-3000:]}")
                break
        deferred = bool(self.p.get("defer_test"))
        if run_own_checks and rec["setup_ok"]:
            self._own_checks(("lint",) if deferred else ("lint", "test"), wc, env0, log, rec, report)
        if rec["setup_ok"]:
            with machine_lock("validation", log=self.log, who=f"{self.state_dir.name}:{label}"), \
                    self.app(wc, ports, db_path, results, env_extra) as (booted, env, err):
                rec["booted"] = booted
                if not booted:
                    tail = (results / "app.log").read_text(errors="replace")[-3000:]
                    report.insert(0, f"The app did not boot with `{self.p['start']['cmd']}` ({err}):\n{tail}")
                else:
                    seen = set()
                    for c in self.p.checkpoints:
                        tests, error = self.run_script(c["acceptance"], dict(env, CHECKPOINT=c["id"]), results,
                                                       f"acceptance-{c['id']}")
                        if error:
                            rec["runner_errors"].append(error)
                        for t in tests:
                            if t.get("id") not in seen:
                                seen.add(t.get("id"))
                                rec["acceptance"].append({**t, "cp": c["id"]})
                        if c["id"] == cp_id:
                            break
                    if hazards:
                        rec["hazards"], herr = self._hazards(cp_id, env, results)
                        if herr:
                            rec["runner_errors"].append(herr)
                    if seed and self.p.cp(cp_id).get("seed_after"):
                        code, out = sh(self.p.script_argv(self.p.cp(cp_id)["seed_after"]), self.p.dir, env,
                                       log=results / "runners.log")
                        if code != 0:
                            rec["runner_errors"].append(f"seed_after failed (exit {code}): {out[-500:]}")
            if seed and rec["booted"] and self.p.cp(cp_id).get("persist_db"):
                rec["persisted_db"] = str(db_path)  # copied after the app stopped: consistent SQLite file(s)
        if run_own_checks and rec["setup_ok"] and deferred:
            if tests_due(True, rec, final=final):
                self._own_checks(("test",), wc, env0, log, rec, report)
            else:
                rec["test_deferred"] = True
        failed = [t for t in rec["acceptance"] if t.get("status") not in ("pass", "passed")]
        for t in failed:
            msg = (t.get("message") or "").strip().splitlines()
            report.append(f"- Acceptance check failed: {t.get('id')} ({t.get('requirement')})"
                          + (f" — {msg[0][:300]}" if msg else ""))
        rec["acceptance_total"], rec["acceptance_failed"] = len(rec["acceptance"]), len(failed)
        rec["ok"] = (rec["booted"] and rec["setup_ok"] and rec["lint_ok"] is not False and rec["test_ok"] is not False
                     and len(rec["acceptance"]) > 0 and not failed and not rec["runner_errors"])
        rec["report"] = "\n".join(report)
        rec["finished_at"] = time.time()
        (results / "record.json").write_text(json.dumps(rec, indent=2, default=str))
        return rec

    def _hazards(self, cp_id, env, results):
        hz = self.p.get("hazards") or {}
        if not hz.get("run"):
            return [], None
        cmd = f"{hz['run']} {cp_id}"
        tests, err = self.run_script(cmd, dict(env, CHECKPOINT=cp_id), results, "hazards")
        races = [t for t in tests if t.get("category") == "concurrency" and t.get("status") not in ("pass", "passed")]
        for _ in range(RACE_RETRIES if races else 0):
            with machine_lock("validation", log=self.log, who=f"{self.state_dir.name}:race-retry"):
                retry, err2 = self.run_script(cmd, dict(env, CHECKPOINT=cp_id, RACE_RETRY="1"), results,
                                              "hazards-race-retry")
            by_id = {t.get("id"): t for t in retry}
            for t in tests:
                if t in races and t.get("id") in by_id:
                    t["first_status"] = t.get("status")
                    t["status"] = by_id[t["id"]].get("status")
                    t["retried"] = True
            err = err or err2
        return [{**t, "cp": cp_id} for t in tests], err
