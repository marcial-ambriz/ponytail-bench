"""Seeded, rep-major schedule (plan §3, §9; gaps 1, 19, 21).

Block = (model, project, rep) with exactly one run per arm, launched together. All rep-1 blocks run before any rep-2
block (a barrier per rep), so a budget stop leaves complete, balanced repetitions. At most 2 blocks run at once.
The seed (first 8 bytes of the pre-registration commit hash) fixes the block order inside each rep, the arm start
order inside each block and the blind aliases. Ports come from the machine-wide lease registry (bench/ports.py);
SlotPool is kept for tests and callers that want a fixed in-process pool.
"""

import queue
import random
import re
import string
import threading
from concurrent.futures import ThreadPoolExecutor

RUN_ID = re.compile(r"^(?P<project>.+)-(?P<model>[a-z0-9]+)-(?P<arm>base|ponytail|placebo)-r(?P<rep>\d+)$")
ALIAS_CHARS = string.ascii_lowercase + string.digits


def seed_from_commit(commit_hash):
    h = commit_hash.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{16,64}", h):
        raise ValueError(f"not a commit hash: {commit_hash!r}")
    return int(h[:16], 16)


def run_id(project, model, arm, rep):
    return f"{project}-{model}-{arm}-r{rep}"


def parse_run_id(rid):
    m = RUN_ID.match(rid)
    if not m:
        raise ValueError(f"bad run id {rid!r} (expected <project>-<model>-<arm>-r<rep>)")
    d = m.groupdict()
    d["rep"] = int(d["rep"])
    return d


def _aliases(rng, n):
    out = set()
    while len(out) < n:
        out.add("".join(rng.choice(ALIAS_CHARS) for _ in range(6)))
    return out


def build_schedule(seed, models, projects, arms, reps=(1, 2, 3)):
    rng = random.Random(seed)
    blocks = []
    for rep in reps:
        cells = [(m, p) for m in models for p in projects]
        rng.shuffle(cells)
        for m, p in cells:
            order = list(arms)
            rng.shuffle(order)
            blocks.append({"block_id": f"{p}-{m}-r{rep}", "model": m, "project": p, "rep": rep,
                           "runs": [{"run_id": run_id(p, m, a, rep), "model": m, "project": p, "arm": a, "rep": rep,
                                     "start_order": i} for i, a in enumerate(order)]})
    # aliases are drawn after the order so adding a rep never changes earlier aliases' generation order per seed
    pool = sorted(_aliases(rng, sum(len(b["runs"]) for b in blocks)))
    rng.shuffle(pool)
    it = iter(pool)
    for b in blocks:
        for r in b["runs"]:
            r["alias"] = next(it)
    return {"seed": seed, "models": list(models), "projects": list(projects), "arms": list(arms), "reps": list(reps),
            "blocks": blocks}


def aliases(sched):
    return {r["run_id"]: r["alias"] for b in sched["blocks"] for r in b["runs"]}


class SlotPool:
    """Fixed set of port slots (one per concurrently running run); a run takes a slot and returns it when done."""

    def __init__(self, slots=6, seed=0, api_base=3200, web_base=5400, step=10):
        offsets = list(range(slots))
        random.Random(seed).shuffle(offsets)
        self._all = [{"slot": i, "api_port": api_base + o * step, "web_port": web_base + o * step}
                     for i, o in enumerate(offsets)]
        self._q = queue.Queue()
        for s in self._all:
            self._q.put(s)

    def acquire(self, block=True, timeout=None):
        try:
            return self._q.get(block=block, timeout=timeout)
        except queue.Empty:
            raise RuntimeError("no free port slot") from None

    def release(self, slot):
        self._q.put(slot)


def execute(sched, run_block, max_concurrent_blocks=2, can_launch=None, on_refuse=None):
    """Run blocks rep by rep (barrier between reps), at most `max_concurrent_blocks` at once.

    `can_launch(block) -> (ok, reason)` is checked right before each launch; the first refusal stops all further
    launches (blocks already running finish). Returns {block_id: result | {"skipped": reason}}.
    """
    results, stop = {}, threading.Event()
    lock = threading.Lock()
    for rep in sorted({b["rep"] for b in sched["blocks"]}):
        todo = [b for b in sched["blocks"] if b["rep"] == rep]
        gate = threading.Semaphore(max_concurrent_blocks)

        def launch(b):
            try:
                with lock:
                    if stop.is_set():
                        results[b["block_id"]] = {"skipped": "launches stopped"}
                        return
                    if can_launch:
                        ok, why = can_launch(b)
                        if not ok:
                            stop.set()
                            results[b["block_id"]] = {"skipped": why}
                            if on_refuse:
                                on_refuse(b, why)
                            return
                res = run_block(b)
                with lock:
                    results[b["block_id"]] = res
            finally:
                gate.release()

        with ThreadPoolExecutor(max_workers=max_concurrent_blocks) as ex:
            futs = []
            for b in todo:  # submit in schedule order; the semaphore keeps launch order == schedule order
                gate.acquire()
                futs.append(ex.submit(launch, b))
            for f in futs:
                f.result()
        if stop.is_set():
            for b in sched["blocks"]:
                results.setdefault(b["block_id"], {"skipped": "launches stopped"})
            break
    return results
