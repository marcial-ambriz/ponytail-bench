"""T5 - first-blood bonus (spec/t5.md). The concurrency case lives in hazards/."""
import re

from ctfd import Client, attempt

suite = globals()["suite"]


def top10_total(w, team_id):
    data = Client(w.base).api("GET", "/scoreboard/top/10").json()["data"]
    for row in data.values():
        if row.get("id") == team_id:
            return sum(s["value"] for s in row["solves"])
    return None


def first_blood_awards(w, team_id):
    return [a for a in w.awards(team_id) if a["name"].lower().startswith("first blood")]


@suite.test("t5.config.admin_field", "R5.1")
def _(w):
    w.config(first_blood_bonus=30)
    html = w.admin.session.get("/admin/config").text
    m = re.search(r'<input[^>]*name="first_blood_bonus"[^>]*>', html)
    assert m, "admin config page must have a first_blood_bonus field"
    assert 'value="30"' in m.group(0), "field must show the current bonus"


@suite.test("t5.award.first_solver_only", "R5.2")
def _(w):
    w.config(first_blood_bonus=25)
    c = w.challenge(value=100)
    a, b = w.team(members=1), w.team(members=1)
    assert attempt(w.login(a["users"][0]), c["id"], c["flag"])[1] == "correct"
    assert attempt(w.login(b["users"][0]), c["id"], c["flag"])[1] == "correct"
    assert w.score(a["id"]) == 125, f"first solver score {w.score(a['id'])}, expected 125"
    assert w.score(b["id"]) == 100, f"second solver score {w.score(b['id'])}, expected 100"


@suite.test("t5.award.line_item", "R5.2")
def _(w):
    w.config(first_blood_bonus=25)
    c = w.challenge(value=100)
    a = w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    html = Client(w.base).get(f"/teams/{a['id']}").text
    assert f"First blood: {c['name']}" in html, "team page must list 'First blood: <challenge name>'"


@suite.test("t5.award.once_per_challenge", "R5.2")
def _(w):
    w.config(first_blood_bonus=10)
    c1, c2 = w.challenge(value=50), w.challenge(value=50)
    a = w.team(members=2)
    p = w.login(a["users"][0])
    attempt(p, c1["id"], c1["flag"])
    attempt(w.login(a["users"][1]), c1["id"], c1["flag"])
    attempt(p, c2["id"], c2["flag"])
    assert w.score(a["id"]) == 120, f"two first bloods on two challenges = 100 + 20, got {w.score(a['id'])}"


@suite.test("t5.surfaces.scoreboard_and_place", "R5.3")
def _(w):
    w.config(first_blood_bonus=40)
    c = w.challenge(value=100)
    a, b = w.team(members=1), w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    attempt(w.login(b["users"][0]), c["id"], c["flag"])
    assert w.scoreboard_score(a["id"]) == 140, f"scoreboard shows {w.scoreboard_score(a['id'])}"
    ta, tb = w.team_admin(a["id"]), w.team_admin(b["id"])
    assert ta["score"] == 140 and tb["score"] == 100
    pa = int(re.sub(r"\D", "", str(ta["place"])) or 0)
    pb = int(re.sub(r"\D", "", str(tb["place"])) or 0)
    assert pa and pb and pa < pb, f"first-blood team must rank above: {ta['place']} vs {tb['place']}"


@suite.test("t5.surfaces.top10_graph", "R5.3")
def _(w):
    w.config(first_blood_bonus=40)
    c = w.challenge(value=500)
    a = w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    assert top10_total(w, a["id"]) == 540, f"scoreboard graph data totals {top10_total(w, a['id'])}, expected 540"


@suite.test("t5.surfaces.member_score", "R5.3")
def _(w):
    w.config(first_blood_bonus=40)
    c = w.challenge(value=100)
    a = w.team(members=2)
    u = a["users"][1]
    attempt(w.login(u), c["id"], c["flag"])
    r = w.admin.api("GET", f"/users/{u['id']}").json()["data"]
    assert r["score"] == 140, f"solving member's score {r['score']}, expected 140"


@suite.test("t5.visibility.hidden_team_never_first", "R5.5")
def _(w):
    w.config(first_blood_bonus=30)
    c = w.challenge(value=100)
    staff = w.team(members=1)
    w.admin.api("PATCH", f"/teams/{staff['id']}", {"hidden": True})
    a = w.team(members=1)
    attempt(w.login(staff["users"][0]), c["id"], c["flag"])
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    assert not first_blood_awards(w, staff["id"]), "hidden staff team got first blood"
    assert w.score(a["id"]) == 130, f"first *visible* solver must get the bonus, score {w.score(a['id'])}"


@suite.test("t5.visibility.banned_team_never_first", "R5.5")
def _(w):
    w.config(first_blood_bonus=30)
    c = w.challenge(value=100)
    bad = w.team(members=1)
    p = w.login(bad["users"][0])
    w.admin.api("PATCH", f"/teams/{bad['id']}", {"banned": True})
    attempt(p, c["id"], c["flag"])
    a = w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    assert w.score(a["id"]) == 130, f"banned team must not take first blood, score {w.score(a['id'])}"


@suite.test("t5.setting.disabled_by_default", "R5.6")
def _(w):
    c = w.challenge(value=100)
    a = w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    assert w.score(a["id"]) == 100 and not first_blood_awards(w, a["id"])


@suite.test("t5.setting.not_retroactive", "R5.6")
def _(w):
    c = w.challenge(value=100)
    a, b = w.team(members=1), w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    w.config(first_blood_bonus=50)
    attempt(w.login(b["users"][0]), c["id"], c["flag"])
    assert w.score(a["id"]) == 100, "enabling the bonus later must not pay old solves"
    assert w.score(b["id"]) == 100, "the second solver is not first blood even if the bonus was just enabled"


@suite.test("t5.setting.change_keeps_awarded", "R5.6")
def _(w):
    w.config(first_blood_bonus=50)
    c = w.challenge(value=100)
    a = w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    w.config(first_blood_bonus=5)
    assert w.score(a["id"]) == 150, "changing the setting must not change an awarded bonus"
    w.config(first_blood_bonus=0)
    c2 = w.challenge(value=100)
    attempt(w.login(a["users"][0]), c2["id"], c2["flag"])
    assert w.score(a["id"]) == 250, "bonus 0 disables new first bloods"


@suite.test("t5.types.dynamic_challenge", "R5.7")
def _(w):
    w.config(first_blood_bonus=20)
    c = w.challenge(value=200, kind="dynamic")
    a, b = w.team(members=1), w.team(members=1)
    attempt(w.login(a["users"][0]), c["id"], c["flag"])
    attempt(w.login(b["users"][0]), c["id"], c["flag"])
    assert len(first_blood_awards(w, a["id"])) == 1 and not first_blood_awards(w, b["id"])
