"""Validation never kills processes it did not start, and validation phases are serialized machine-wide."""
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from bench import project, suite, validator

FIX = Path(__file__).parent / "fixtures" / "fake-project"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_validator(tmp_path, cmd=None):
    proj = tmp_path / "px-fake"
    shutil.copytree(FIX, proj)
    p = project.load(proj)
    if cmd:
        p.data["start"]["cmd"] = cmd
    logs = []
    v = validator.Validator(p, suite.freeze(p), tmp_path / "state" / "run", log=logs.append, boot_timeout_s=15)
    return p, v, logs


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def test_app_refuses_busy_port_and_leaves_foreign_listener_alive(tmp_path):
    port = free_port()
    foreign = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            with socket.socket() as c:
                if c.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.1)
        _, v, _ = make_validator(tmp_path)
        res = tmp_path / "res"
        res.mkdir()
        ports = {"api_port": port, "web_port": port}
        with v.app(tmp_path / "px-fake" / "reference", ports, res / "app.db", res) as (booted, env, err):
            assert not booted
            assert "in use" in err
        assert foreign.poll() is None and alive(foreign.pid), "validator killed a process it did not start"
    finally:
        foreign.kill()
        foreign.wait()


def test_app_kills_every_process_it_started_including_detached_children(tmp_path):
    port = free_port()
    pidfile = tmp_path / "child.pid"
    # the child escapes the process group (setsid): only PID tracking can find it
    cmd = (f"{sys.executable} -c \"import os,time; os.setsid(); open('{pidfile}','w').write(str(os.getpid())); "
           f"time.sleep(300)\" & exec python3 app.py")
    p, v, _ = make_validator(tmp_path, cmd=cmd)
    res = tmp_path / "res"
    res.mkdir()
    with v.app(p.dir / "reference", {"api_port": port, "web_port": port}, res / "app.db", res) as (booted, _, err):
        assert booted, err
        for _ in range(50):
            if pidfile.exists() and pidfile.read_text():
                break
            time.sleep(0.1)
    child = int(pidfile.read_text())
    for _ in range(50):
        if not alive(child):
            break
        time.sleep(0.1)
    assert not alive(child)


def test_machine_lock_is_exclusive_reentrant_and_logs_while_waiting(tmp_path, monkeypatch):
    monkeypatch.setenv("BENCH_GLOBAL_DIR", str(tmp_path / "global"))
    held, events, logs = threading.Event(), [], []

    def holder():
        with validator.machine_lock("validation", log=lambda m: None, who="holder"):
            held.set()
            time.sleep(0.8)
            events.append(("holder-release", time.time()))

    t = threading.Thread(target=holder)
    t.start()
    held.wait()
    with validator.machine_lock("validation", log=logs.append, who="me"):
        events.append(("me-acquired", time.time()))
        with validator.machine_lock("validation", log=logs.append, who="me"):  # reentrant: no deadlock
            pass
    t.join()
    assert events[0][0] == "holder-release" and events[1][0] == "me-acquired"
    assert any("waiting for machine-wide validation lock" in m and "holder" in m for m in logs)


def test_machine_lock_is_shared_across_processes(tmp_path, monkeypatch):
    gdir = tmp_path / "global"
    monkeypatch.setenv("BENCH_GLOBAL_DIR", str(gdir))
    harness = Path(validator.__file__).resolve().parents[1]
    code = ("import sys,time; sys.path.insert(0, %r); from bench import validator\n"
            "with validator.machine_lock('validation', log=print, who='other-process'):\n"
            "    print('locked', flush=True); time.sleep(1.0)\n") % str(harness)
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True,
                            env=dict(os.environ, BENCH_GLOBAL_DIR=str(gdir)))
    assert proc.stdout.readline().strip() == "locked"
    logs = []
    t0 = time.time()
    with validator.machine_lock("validation", log=logs.append, who="me"):
        waited = time.time() - t0
    proc.wait()
    assert waited > 0.5
    assert any("waiting" in m for m in logs)


def test_validate_runs_under_the_machine_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("BENCH_GLOBAL_DIR", str(tmp_path / "global"))
    p, v, logs = make_validator(tmp_path)
    seen = []
    real = validator.machine_lock

    def spy(name, log=print, who=None):
        seen.append(name)
        return real(name, log=log, who=who)
    monkeypatch.setattr(validator, "machine_lock", spy)
    port = free_port()
    rec = v.validate(p.dir / "reference", "cp1", "cp1-v0", {"api_port": port, "web_port": port})
    assert rec["booted"] and rec["acceptance"]
    assert "validation" in seen


def test_owned_pids_follows_children_that_start_their_own_process_group(monkeypatch):
    # root 10 (group 10) -> 11 (group 10) -> 12 (own group 12, like a pnpm/turbo worker) -> 13 listener (group 12)
    table = [(10, 1, 10), (11, 10, 10), (12, 11, 12), (13, 12, 12), (99, 1, 99)]
    monkeypatch.setattr(validator, "_ps_table", lambda: table)
    assert validator.owned_pids(10) == {10, 11, 12, 13}
