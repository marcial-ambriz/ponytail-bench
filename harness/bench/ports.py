"""Machine-wide port leases (one disjoint range per run; dry runs, pilots and real runs share one registry).

A lease is a file `<index>.json` created with O_EXCL in the registry directory; range `index` covers
[base + index*block, base + (index+1)*block). A range is leased only if every port in it is free right now (nothing
listening on 127.0.0.1/::1 and bindable). Leases whose owner process is gone are reclaimed.
"""

import contextlib
import json
import os
import socket
import time
from pathlib import Path

from .config import PORT_RANGE, global_dir


class NoFreePorts(RuntimeError):
    pass


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, ValueError, TypeError):
        return True


def port_free(port):
    for fam, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        with contextlib.suppress(OSError), socket.socket(fam, socket.SOCK_STREAM) as c:
            c.settimeout(0.3)
            if c.connect_ex((host, port)) == 0:
                return False
    for fam, host in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
        try:
            with socket.socket(fam, socket.SOCK_STREAM) as s:
                # SO_REUSEADDR: TIME_WAIT leftovers of a stopped server do not count as "in use" (servers set it too)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((host, port))
        except OSError as e:
            if fam == socket.AF_INET6 and e.errno in (47, 97, 99):  # no IPv6 on this host
                continue
            return False
    return True


class PortAllocator:
    def __init__(self, registry=None, base=None, block=None, count=None):
        self.dir = Path(registry or global_dir() / "ports")
        self.base = base if base is not None else PORT_RANGE["base"]
        self.block = block or PORT_RANGE["block"]
        self.count = count or PORT_RANGE["count"]

    def _range(self, i):
        lo = self.base + i * self.block
        return lo, lo + self.block

    def _try_claim(self, i, key):
        f = self.dir / f"{i}.json"
        if f.exists():
            try:
                owner = json.loads(f.read_text()).get("pid")
            except (OSError, ValueError):
                owner = None  # being written right now, or garbage: treat as taken unless old
                if time.time() - f.stat().st_mtime < 60:
                    return None
            if owner is not None and _pid_alive(owner):
                return None
            with contextlib.suppress(FileNotFoundError):
                f.unlink()  # stale lease of a dead process
        try:
            fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return None
        lo, hi = self._range(i)
        lease = {"index": i, "key": key, "pid": os.getpid(), "range": [lo, hi], "api_port": lo, "web_port": lo + 1,
                 "file": str(f), "created": time.time()}
        with os.fdopen(fd, "w") as out:
            json.dump(lease, out)
        return lease

    def acquire(self, key):
        self.dir.mkdir(parents=True, exist_ok=True)
        for i in range(self.count):
            lease = self._try_claim(i, key)
            if lease is None:
                continue
            lo, hi = self._range(i)
            if all(port_free(p) for p in range(lo, hi)):
                return lease
            self.release(lease)  # something foreign listens in this range: leave it alone, try the next one
        raise NoFreePorts(f"no free port range of {self.block} in {self.base}-{self.base + self.count * self.block}")

    def release(self, lease):
        f = Path(lease["file"])
        with contextlib.suppress(FileNotFoundError, ValueError, OSError):
            if json.loads(f.read_text()).get("pid") == os.getpid():
                f.unlink()

    @contextlib.contextmanager
    def lease(self, key):
        lease = self.acquire(key)
        try:
            yield lease
        finally:
            self.release(lease)
