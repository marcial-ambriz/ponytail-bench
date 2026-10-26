import threading
import time

import pytest

from bench import schedule

MODELS = ["sonnet", "luna"]
PROJECTS = ["p1-invoicing", "p2-ctfd", "p3-inventory"]
ARMS = ["base", "ponytail", "placebo"]


def full(seed=0xABCDEF0123456789):
    return schedule.build_schedule(seed, MODELS, PROJECTS, ARMS, reps=[1, 2, 3])


def test_seed_is_first_8_bytes_of_commit_hash():
    assert schedule.seed_from_commit("abcdef0123456789ffff0000") == 0xABCDEF0123456789
    with pytest.raises(ValueError):
        schedule.seed_from_commit("xyz")


def test_full_design_is_54_runs_in_18_blocks_of_3_arms():
    s = full()
    assert len(s["blocks"]) == 18
    runs = [r for b in s["blocks"] for r in b["runs"]]
    assert len(runs) == 54 and len({r["run_id"] for r in runs}) == 54
    for b in s["blocks"]:
        assert sorted(r["arm"] for r in b["runs"]) == sorted(ARMS)
        assert {r["model"] for r in b["runs"]} == {b["model"]}
        assert {r["project"] for r in b["runs"]} == {b["project"]}


def test_rep_major_order_and_each_cell_once_per_rep():
    s = full()
    reps = [b["rep"] for b in s["blocks"]]
    assert reps == sorted(reps)
    for rep in (1, 2, 3):
        cells = [(b["model"], b["project"]) for b in s["blocks"] if b["rep"] == rep]
        assert sorted(cells) == sorted((m, p) for m in MODELS for p in PROJECTS)


def test_schedule_is_deterministic_and_seed_sensitive():
    assert full() == full()
    other = full(seed=12345)
    assert [b["block_id"] for b in other["blocks"]] != [b["block_id"] for b in full()["blocks"]] or \
        [r["alias"] for b in other["blocks"] for r in b["runs"]] != [r["alias"] for b in full()["blocks"] for r in b["runs"]]


def test_blind_aliases_unique_six_chars():
    aliases = [r["alias"] for b in full()["blocks"] for r in b["runs"]]
    assert len(set(aliases)) == 54
    assert all(len(a) == 6 and a.isalnum() and a.islower() for a in aliases)


def test_run_id_format_and_parse_roundtrip():
    rid = schedule.run_id("p1-invoicing", "sonnet", "ponytail", 2)
    assert rid == "p1-invoicing-sonnet-ponytail-r2"
    assert schedule.parse_run_id(rid) == {"project": "p1-invoicing", "model": "sonnet", "arm": "ponytail", "rep": 2}
    with pytest.raises(ValueError):
        schedule.parse_run_id("sonnet-skill")


def test_pilot_is_one_block_three_arms():
    s = schedule.build_schedule(1, ["sonnet"], ["p1-invoicing"], ARMS, reps=[1])
    assert len(s["blocks"]) == 1 and len(s["blocks"][0]["runs"]) == 3


def test_slot_pool_ports_unique_and_reused():
    pool = schedule.SlotPool(slots=6, seed=3)
    got = [pool.acquire() for _ in range(6)]
    ports = [p for s in got for p in (s["api_port"], s["web_port"])]
    assert len(set(ports)) == 12
    with pytest.raises(RuntimeError):
        pool.acquire(block=False)
    pool.release(got[0])
    assert pool.acquire(block=False) == got[0]


def test_executor_caps_two_blocks_and_never_mixes_reps():
    s = full()
    lock = threading.Lock()
    active, peak, events = [], [0], []

    def run_block(b):
        with lock:
            active.append(b["rep"])
            peak[0] = max(peak[0], len(active))
            assert len(set(active)) == 1, "blocks from different reps overlapped"
            events.append(b["rep"])
        time.sleep(0.01)
        with lock:
            active.remove(b["rep"])
        return "ok"

    out = schedule.execute(s, run_block, max_concurrent_blocks=2)
    assert peak[0] == 2
    assert events == sorted(events)
    assert len(out) == 18


def test_executor_stops_launching_when_guard_refuses():
    s = full()
    launched = []

    def guard(block):
        return len(launched) < 4, "budget"

    schedule.execute(s, lambda b: launched.append(b["block_id"]), max_concurrent_blocks=1, can_launch=guard)
    assert len(launched) == 4
