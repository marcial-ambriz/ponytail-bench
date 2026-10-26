"""Maintenance feature: first blood per bracket (task.md)."""
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "acceptance", "lib"))

from ctfd import Suite, attempt, simultaneously, write_result  # noqa: E402

suite = Suite("maintenance")


def bracket(w, name):
    r = w.admin.api("POST", "/brackets", {"name": w.uniq(name), "description": name, "type": "teams"})
    assert r.status == 200, f"could not create bracket: {r}"
    return r.json()["data"]["id"]


def fb(w, team):
    return [a for a in w.awards(team["id"]) if a["name"].lower().startswith("first blood")]


def solve(w, team, c):
    assert attempt(w.login(team["users"][0]), c["id"], c["flag"])[1] == "correct"


@suite.test("mt.bracket.one_per_bracket", "M1")
def _(w):
    w.config(first_blood_bonus=30)
    s, p = bracket(w, "Students"), bracket(w, "Pros")
    c = w.challenge(value=100)
    p1, s1, p2, s2 = (w.team(members=1, bracket_id=b) for b in (p, s, p, s))
    for t in (p1, s1, p2, s2):
        solve(w, t, c)
    assert len(fb(w, p1)) == 1 and len(fb(w, s1)) == 1, "first solver of each bracket must get first blood"
    assert not fb(w, p2) and not fb(w, s2), "later solvers in a bracket must not get first blood"
    assert w.score(s1["id"]) == 130 and w.score(s2["id"]) == 100


@suite.test("mt.bracket.no_bracket_group", "M1")
def _(w):
    w.config(first_blood_bonus=30)
    s = bracket(w, "Students")
    c = w.challenge(value=100)
    loose, s1, loose2 = w.team(members=1), w.team(members=1, bracket_id=s), w.team(members=1)
    for t in (loose, s1, loose2):
        solve(w, t, c)
    assert len(fb(w, loose)) == 1 and len(fb(w, s1)) == 1 and not fb(w, loose2)


@suite.test("mt.bracket.line_item_and_scoreboard", "M2")
def _(w):
    w.config(first_blood_bonus=25)
    s, p = bracket(w, "Students"), bracket(w, "Pros")
    c = w.challenge(value=100)
    p1, s1 = w.team(members=1, bracket_id=p), w.team(members=1, bracket_id=s)
    solve(w, p1, c)
    solve(w, s1, c)
    assert [a["name"] for a in fb(w, s1)] == [f"First blood: {c['name']}"]
    assert w.scoreboard_score(s1["id"]) == 125


@suite.test("mt.bracket.concurrent_same_bracket", "M3", "concurrency")
def _(w):
    w.config(first_blood_bonus=40)
    s = bracket(w, "Students")
    for i in range(3):
        c = w.challenge(value=100)
        teams = [w.team(members=1, bracket_id=s) for _ in range(6)]
        clients = [w.login(t["users"][0]) for t in teams]
        simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
        winners = [t for t in teams if fb(w, t)]
        assert len(winners) == 1, f"round {i}: {len(winners)} first bloods in one bracket"


@suite.test("mt.bracket.hidden_never_first", "M4")
def _(w):
    w.config(first_blood_bonus=30)
    s = bracket(w, "Students")
    c = w.challenge(value=100)
    staff, s1 = w.team(members=1, bracket_id=s), w.team(members=1, bracket_id=s)
    w.admin.api("PATCH", f"/teams/{staff['id']}", {"hidden": True})
    solve(w, staff, c)
    solve(w, s1, c)
    assert not fb(w, staff) and len(fb(w, s1)) == 1


@suite.test("mt.regression.no_brackets_unchanged", "M4")
def _(w):
    w.config(first_blood_bonus=30)
    c = w.challenge(value=100)
    a, b = w.team(members=1), w.team(members=1)
    solve(w, a, c)
    solve(w, b, c)
    assert len(fb(w, a)) == 1 and not fb(w, b)


if __name__ == "__main__":
    write_result(suite.run(), {"suite": "maintenance"})
