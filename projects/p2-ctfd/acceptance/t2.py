"""T2 - a challenge never counts twice for the same team (spec/t2.md)."""
from ctfd import attempt, simultaneously

suite = globals()["suite"]
ROUNDS = 4


def _race_teammates(w, kind="standard", members=8):
    t = w.team(members=members)
    c = w.challenge(value=100, kind=kind)
    clients = [w.login(u) for u in t["users"]]
    res = simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
    return t, c, res


@suite.test("t2.concurrent.teammates_one_solve", "R2.1")
def _(w):
    for i in range(ROUNDS):
        t, c, res = _race_teammates(w)
        n = len(w.solves(t["id"]))
        assert n == 1, f"round {i}: {n} solves recorded for one team on one challenge ({res})"
        assert w.score(t["id"]) == 100, f"round {i}: team score {w.score(t['id'])}, expected 100"
        assert w.scoreboard_score(t["id"]) == 100, f"round {i}: scoreboard shows {w.scoreboard_score(t['id'])}"


@suite.test("t2.concurrent.responses_sane", "R2.2")
def _(w):
    t, c, res = _race_teammates(w)
    for r in res:
        assert not isinstance(r, Exception), f"request crashed: {r}"
        status, outcome = r
        assert status < 500, f"a simultaneous correct submission got HTTP {status}"
        assert outcome in ("correct", "already_solved"), f"unexpected outcome {outcome!r}"
    assert sum(1 for r in res if r[1] == "correct") >= 1, f"nobody was told correct: {res}"


@suite.test("t2.sequential.resubmit_already_solved", "R2.2")
def _(w):
    t = w.team(members=2)
    c = w.challenge(value=50)
    a, b = (w.login(u) for u in t["users"])
    assert attempt(a, c["id"], c["flag"])[1] == "correct"
    assert attempt(b, c["id"], c["flag"])[1] == "already_solved"
    assert len(w.solves(t["id"])) == 1 and w.score(t["id"]) == 50


@suite.test("t2.admin.mark_teammate_wrong_as_correct", "R2.3")
def _(w):
    t = w.team(members=2)
    c = w.challenge(value=100)
    a, b = (w.login(u) for u in t["users"])
    assert attempt(b, c["id"], "flag{typo}")[1] == "incorrect"
    assert attempt(a, c["id"], c["flag"])[1] == "correct"
    r = w.admin.api("GET", f"/submissions?challenge_id={c['id']}&type=incorrect")
    subs = [s for s in r.json()["data"] if s["team_id"] == t["id"]] if r.status == 200 else []
    assert subs, f"could not find the wrong submission: {r}"
    w.admin.api("PATCH", f"/submissions/{subs[0]['id']}", {"type": "correct"})
    n = len(w.solves(t["id"]))
    assert n == 1, f"admin 'mark as correct' on a teammate's wrong answer created {n} solves"
    assert w.score(t["id"]) == 100, f"team score became {w.score(t['id'])}"


@suite.test("t2.admin.create_duplicate_correct_submission", "R2.3")
def _(w):
    t = w.team(members=2)
    c = w.challenge(value=100)
    a = w.login(t["users"][0])
    assert attempt(a, c["id"], c["flag"])[1] == "correct"
    w.admin.api(
        "POST",
        "/submissions",
        {
            "challenge_id": c["id"],
            "user_id": t["users"][1]["id"],
            "team_id": t["id"],
            "type": "correct",
            "provided": "admin-added",
            "ip": "127.0.0.1",
        },
    )
    n = len(w.solves(t["id"]))
    assert n == 1, f"admin-created correct submission produced {n} solves for the team"
    assert w.score(t["id"]) == 100


@suite.test("t2.concurrent.dynamic_value_decays_once", "R2.4")
def _(w):
    for i in range(ROUNDS):
        t, c, res = _race_teammates(w, kind="dynamic")
        n = len(w.solves(t["id"]))
        val = w.admin.api("GET", f"/challenges/{c['id']}").json()["data"]["value"]
        assert n == 1, f"round {i}: dynamic challenge recorded {n} solves for one team"
        assert val == 100, f"round {i}: dynamic value decayed to {val} after a single team solve"
