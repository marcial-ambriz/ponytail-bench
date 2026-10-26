"""T4 - challenge solve counts must ignore hidden/banned teams everywhere (spec/t4.md)."""
import re

from ctfd import attempt

suite = globals()["suite"]


def scenario(w, hidden=1, visible=2, flag_field="hidden"):
    """`hidden` staff teams and `visible` normal teams all solve one challenge."""
    c = w.challenge(value=100)
    staff = [w.team(members=1) for _ in range(hidden)]
    normal = [w.team(members=1) for _ in range(visible)]
    for t in staff + normal:
        assert attempt(w.login(t["users"][0]), c["id"], c["flag"])[1] == "correct"
    for t in staff:
        r = w.admin.api("PATCH", f"/teams/{t['id']}", {flag_field: True})
        assert r.status == 200, r
    viewer = w.team(members=1)
    return c, normal, w.login(viewer["users"][0])


def board_count(player, cid):
    rows = player.api("GET", "/challenges").json()["data"]
    return next(r["solves"] for r in rows if r["id"] == cid)


def detail(player, cid):
    return player.api("GET", f"/challenges/{cid}").json()["data"]


@suite.test("t4.board.hidden_team_not_counted", "R4.1")
def _(w):
    c, normal, p = scenario(w, hidden=1, visible=2)
    assert board_count(p, c["id"]) == 2, f"challenge board counts {board_count(p, c['id'])} solves, expected 2"


@suite.test("t4.detail.hidden_team_not_counted", "R4.1")
def _(w):
    c, normal, p = scenario(w, hidden=2, visible=1)
    assert detail(p, c["id"])["solves"] == 1, f"challenge detail says {detail(p, c['id'])['solves']} solves, expected 1"


@suite.test("t4.detail.view_label", "R4.1")
def _(w):
    c, normal, p = scenario(w, hidden=1, visible=1)
    view = detail(p, c["id"])["view"]
    assert re.search(r"\b1 Solve\b", view), "challenge window must say '1 Solve'"


@suite.test("t4.board.banned_team_not_counted", "R4.2")
def _(w):
    c, normal, p = scenario(w, hidden=1, visible=2, flag_field="banned")
    assert board_count(p, c["id"]) == 2, "banned team's solve still counted on the board"
    assert detail(p, c["id"])["solves"] == 2, "banned team's solve still counted in the challenge detail"


@suite.test("t4.consistent.count_matches_solver_list", "R4.3")
def _(w):
    c, normal, p = scenario(w, hidden=1, visible=3)
    listed = len(p.api("GET", f"/challenges/{c['id']}/solves").json()["data"])
    assert listed == 3
    assert board_count(p, c["id"]) == listed and detail(p, c["id"])["solves"] == listed, (
        f"board={board_count(p, c['id'])} detail={detail(p, c['id'])['solves']} list={listed}"
    )


@suite.test("t4.consistent.unhide_counts_again", "R4.4")
def _(w):
    c = w.challenge(value=100)
    staff = w.team(members=1)
    assert attempt(w.login(staff["users"][0]), c["id"], c["flag"])[1] == "correct"
    w.admin.api("PATCH", f"/teams/{staff['id']}", {"hidden": True})
    p = w.login(w.team(members=1)["users"][0])
    assert board_count(p, c["id"]) == 0
    w.admin.api("PATCH", f"/teams/{staff['id']}", {"hidden": False})
    assert board_count(p, c["id"]) == 1 and detail(p, c["id"])["solves"] == 1, "un-hiding must count the solve again"


@suite.test("t4.regression.visible_solves_counted", "R4.3")
def _(w):
    c, normal, p = scenario(w, hidden=0, visible=3)
    assert board_count(p, c["id"]) == 3 and detail(p, c["id"])["solves"] == 3
