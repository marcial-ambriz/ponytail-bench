"""T3 - wrong-answer penalties (spec/t3.md). Concurrency/validation/authz live in hazards/."""
import re

from ctfd import Client, attempt

suite = globals()["suite"]


def team_with_points(w, points=50, members=2):
    """A team that already earned `points` by solving a plain challenge."""
    t = w.team(members=members)
    seed = w.challenge(value=points)
    clients = [w.login(u) for u in t["users"]]
    assert attempt(clients[0], seed["id"], seed["flag"])[1] == "correct"
    assert w.score(t["id"]) == points
    return t, clients


@suite.test("t3.api.penalty_roundtrip", "R3.1")
def _(w):
    c = w.challenge(value=100, penalty=15)
    d = w.admin.api("GET", f"/challenges/{c['id']}").json()["data"]
    assert d.get("penalty") == 15, f"admin view: {d.get('penalty')!r}"
    r = w.admin.api("PATCH", f"/challenges/{c['id']}", {"penalty": "20"})
    assert r.status == 200, f"numeric string from the admin form must be accepted: {r}"
    assert w.admin.api("GET", f"/challenges/{c['id']}").json()["data"].get("penalty") == 20


@suite.test("t3.api.default_zero", "R3.1")
def _(w):
    c = w.challenge(value=100)
    assert w.admin.api("GET", f"/challenges/{c['id']}").json()["data"].get("penalty") in (0, None)


@suite.test("t3.api.dynamic_challenge_penalty", "R3.1")
def _(w):
    c = w.challenge(value=100, kind="dynamic", penalty=7)
    t, (a, _b) = team_with_points(w, 40)
    attempt(a, c["id"], "wrong")
    assert w.score(t["id"]) == 33, f"dynamic challenge penalty not applied: score {w.score(t['id'])}"


@suite.test("t3.deduct.basic", "R3.2")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=10)
    assert attempt(a, c["id"], "wrong-1")[1] == "incorrect"
    assert w.score(t["id"]) == 40, f"team API score {w.score(t['id'])}, expected 40"
    assert w.scoreboard_score(t["id"]) == 40, f"scoreboard {w.scoreboard_score(t['id'])}, expected 40"


@suite.test("t3.deduct.distinct_answers_each_cost", "R3.2")
def _(w):
    t, (a, b) = team_with_points(w, 100)
    c = w.challenge(value=100, penalty=10)
    attempt(a, c["id"], "w1")
    attempt(b, c["id"], "w2")
    attempt(a, c["id"], "w3")
    assert w.score(t["id"]) == 70, f"three distinct wrong answers should cost 30, score {w.score(t['id'])}"


@suite.test("t3.once.same_answer_same_member", "R3.3")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=10)
    for _ in range(3):
        attempt(a, c["id"], "same-wrong")
    assert w.score(t["id"]) == 40, f"repeating one wrong answer must cost once, score {w.score(t['id'])}"


@suite.test("t3.once.same_answer_teammate_and_whitespace", "R3.3")
def _(w):
    t, (a, b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=10)
    attempt(a, c["id"], "flag{nope}")
    attempt(b, c["id"], "  flag{nope} ")
    assert w.score(t["id"]) == 40, f"same answer by a teammate / with spaces must not cost again, score {w.score(t['id'])}"


@suite.test("t3.once.per_challenge", "R3.3")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c1 = w.challenge(value=100, penalty=10)
    c2 = w.challenge(value=100, penalty=10)
    attempt(a, c1["id"], "guess")
    attempt(a, c2["id"], "guess")
    assert w.score(t["id"]) == 30, "the same text on two different challenges is two wrong answers"


@suite.test("t3.floor.capped_at_score", "R3.4")
def _(w):
    t, (a, _b) = team_with_points(w, 15)
    c = w.challenge(value=100, penalty=10)
    attempt(a, c["id"], "w1")
    attempt(a, c["id"], "w2")
    assert w.score(t["id"]) == 0, f"score must stop at 0, got {w.score(t['id'])}"
    attempt(a, c["id"], "w3")
    assert w.score(t["id"]) == 0, f"team at 0 must not go negative, got {w.score(t['id'])}"


@suite.test("t3.floor.zero_score_team", "R3.4")
def _(w):
    t = w.team(members=1)
    a = w.login(t["users"][0])
    c = w.challenge(value=100, penalty=25)
    attempt(a, c["id"], "w")
    assert w.score(t["id"]) == 0, f"team with no points went to {w.score(t['id'])}"
    attempt(a, c["id"], c["flag"])
    assert w.score(t["id"]) == 100, "a later solve must be worth its full value"


@suite.test("t3.none.correct_and_already_solved", "R3.5")
def _(w):
    t, (a, b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=10)
    assert attempt(a, c["id"], c["flag"])[1] == "correct"
    assert w.score(t["id"]) == 150
    attempt(b, c["id"], "wrong-after-solve")
    assert w.score(t["id"]) == 150, "no penalty once the challenge is solved"


@suite.test("t3.none.zero_penalty_challenge", "R3.5")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100)
    attempt(a, c["id"], "wrong")
    assert w.score(t["id"]) == 50


@suite.test("t3.none.ratelimited", "R3.5")
def _(w):
    w.config(incorrect_submissions_per_min=2)
    t, (a, _b) = team_with_points(w, 100)
    c = w.challenge(value=100, penalty=10)
    outcomes = [attempt(a, c["id"], f"w{i}")[1] for i in range(5)]
    charged = 100 - w.score(t["id"])
    wrong = outcomes.count("incorrect")
    assert "ratelimited" in outcomes, f"expected rate limiting to kick in: {outcomes}"
    assert charged == 10 * wrong, f"only accepted wrong answers may cost points ({outcomes}, charged {charged})"


@suite.test("t3.history.line_item_on_team_page", "R3.6")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=10)
    attempt(a, c["id"], "wrong")
    html = Client(w.base).get(f"/teams/{t['id']}").text
    assert f"Penalty: {c['name']}" in html, "team page must list 'Penalty: <challenge name>'"
    html = a.get("/team").text
    assert f"Penalty: {c['name']}" in html, "own team page must list the penalty"


@suite.test("t3.view.players_warned", "R3.7")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100, penalty=12)
    d = a.api("GET", f"/challenges/{c['id']}").json()["data"]
    assert d.get("penalty") == 12, f"players must see the penalty in the challenge API, got {d.get('penalty')!r}"
    assert re.search(r"\b12\b", d["view"]) and re.search(r"penalt", d["view"], re.I), "challenge view must mention the 12 point penalty"


@suite.test("t3.view.no_warning_without_penalty", "R3.7")
def _(w):
    t, (a, _b) = team_with_points(w, 50)
    c = w.challenge(value=100)
    d = a.api("GET", f"/challenges/{c['id']}").json()["data"]
    assert not re.search(r"penalt", d["view"], re.I), "no penalty text for challenges without a penalty"


@suite.test("t3.ui.admin_form_field", "R3.1")
def _(w):
    c = w.challenge(value=100, penalty=9)
    html = w.admin.session.get(f"/admin/challenges/{c['id']}").text
    m = re.search(r'<input[^>]*name="penalty"[^>]*>', html)
    assert m, "admin challenge edit form must have a penalty field"
    assert 'value="9"' in m.group(0), "penalty field must be pre-filled"


@suite.test("t3.history.change_is_not_retroactive", "R3.9")
def _(w):
    t, (a, _b) = team_with_points(w, 100)
    c = w.challenge(value=100, penalty=10)
    attempt(a, c["id"], "w1")
    w.admin.api("PATCH", f"/challenges/{c['id']}", {"penalty": 30})
    assert w.score(t["id"]) == 90, "raising the penalty must not re-charge old answers"
    attempt(a, c["id"], "w2")
    assert w.score(t["id"]) == 60
