"""Machine-wide port allocation: disjoint ranges per (project, arm, run), verified free, released on exit."""
import json
import socket

import pytest

from bench import ports


def alloc(tmp_path, **kw):
    kw.setdefault("base", 46000)
    kw.setdefault("block", 10)
    kw.setdefault("count", 40)
    return ports.PortAllocator(tmp_path / "leases", **kw)


def span(lease):
    return set(range(lease["range"][0], lease["range"][1]))


def test_leases_are_disjoint_across_allocators_sharing_the_registry(tmp_path):
    a, b = alloc(tmp_path), alloc(tmp_path)  # two processes = two allocator instances on one registry
    got = [a.acquire("p1-sonnet-base-r1"), b.acquire("p2-sonnet-base-r1"), a.acquire("p1-sonnet-ponytail-r1"),
           b.acquire("p1-sonnet-base-r1")]
    for i, x in enumerate(got):
        assert x["api_port"] in span(x) and x["web_port"] in span(x) and x["api_port"] != x["web_port"]
        for y in got[i + 1:]:
            assert not span(x) & span(y)


def test_busy_ports_are_skipped(tmp_path):
    a = alloc(tmp_path)
    s = socket.socket()
    s.bind(("127.0.0.1", 46000 + 1))
    s.listen()
    try:
        lease = a.acquire("k")
        assert 46001 not in span(lease)
    finally:
        s.close()


def test_release_frees_the_range_and_stale_leases_of_dead_owners_are_reclaimed(tmp_path):
    a = alloc(tmp_path, count=1)
    lease = a.acquire("k1")
    with pytest.raises(ports.NoFreePorts):
        a.acquire("k2")
    a.release(lease)
    again = a.acquire("k2")
    assert again["range"] == lease["range"]
    # a lease left behind by a process that died is reclaimed
    f = tmp_path / "leases" / f"{again['index']}.json"
    data = json.loads(f.read_text())
    data["pid"] = 999999
    f.write_text(json.dumps(data))
    assert alloc(tmp_path, count=1).acquire("k3")["range"] == lease["range"]


def test_context_manager_releases(tmp_path):
    a = alloc(tmp_path, count=1)
    with a.lease("k") as l1:
        assert l1["api_port"]
    with a.lease("k2") as l2:
        assert l2["range"] == l1["range"]
