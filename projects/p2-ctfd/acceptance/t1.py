"""T1 - per-team member limits (spec/t1.md). Concurrency/authz/validation live in hazards/."""
import re

from ctfd import Client, invite_code, join_by_invite, join_by_password

suite = globals()["suite"]


def member_ids(w, team):
    return {m["id"] if isinstance(m, dict) else m for m in w.members(team["id"])}


def fresh_players(w, n):
    users = [w.user() for _ in range(n)]
    return users, [w.login(u) for u in users]


@suite.test("t1.api.create_with_limit", "R1.1")
def _(w):
    t = w.team(members=0, member_limit=5)
    assert w.team_admin(t["id"]).get("member_limit") == 5, w.team_admin(t["id"])


@suite.test("t1.api.patch_number_string_null", "R1.1")
def _(w):
    t = w.team(members=1)
    r = w.admin.api("PATCH", f"/teams/{t['id']}", {"member_limit": 3})
    assert r.status == 200, r
    assert w.team_admin(t["id"]).get("member_limit") == 3
    r = w.admin.api("PATCH", f"/teams/{t['id']}", {"member_limit": "6"})
    assert r.status == 200, f"numeric string from the admin form must be accepted: {r}"
    assert w.team_admin(t["id"]).get("member_limit") == 6
    r = w.admin.api("PATCH", f"/teams/{t['id']}", {"member_limit": None})
    assert r.status == 200, r
    assert w.team_admin(t["id"]).get("member_limit") in (None, 0, ""), w.team_admin(t["id"])


@suite.test("t1.limit.override_beats_global", "R1.2")
def _(w):
    w.config(team_size=2)
    t = w.team(members=1, member_limit=4)
    users, clients = fresh_players(w, 4)
    for c in clients:
        join_by_password(c, t)
    got = member_ids(w, t)
    assert len(got) == 4, f"team with its own limit 4 (global 2) should end with 4 members, got {len(got)}"
    assert users[3]["id"] not in got, "the 5th person must be refused"


@suite.test("t1.limit.override_smaller_than_global", "R1.2")
def _(w):
    w.config(team_size=6)
    t = w.team(members=1, member_limit=2)
    _, clients = fresh_players(w, 3)
    for c in clients:
        join_by_password(c, t)
    assert len(member_ids(w, t)) == 2, "per-team limit 2 must win over a larger global size"


@suite.test("t1.limit.global_without_override", "R1.2")
def _(w):
    w.config(team_size=2)
    t = w.team(members=1)
    _, clients = fresh_players(w, 3)
    for c in clients:
        join_by_password(c, t)
    assert len(member_ids(w, t)) == 2, "global team size still applies to teams without their own limit"


@suite.test("t1.limit.unlimited_when_unset", "R1.2")
def _(w):
    t = w.team(members=1)
    _, clients = fresh_players(w, 4)
    for c in clients:
        join_by_password(c, t)
    assert len(member_ids(w, t)) == 5, "no team limit and no global size means no limit"


@suite.test("t1.join.password_refused_when_full", "R1.3")
def _(w):
    t = w.team(members=2, member_limit=2)
    u = w.user()
    c = w.login(u)
    join_by_password(c, t)
    assert u["id"] not in member_ids(w, t), "full team accepted a new member via /teams/join"
    r = w.admin.api("GET", f"/users/{u['id']}")
    assert r.json()["data"].get("team_id") is None, "refused user must stay without a team"


@suite.test("t1.join.invite_refused_when_full", "R1.3")
def _(w):
    t = w.team(members=2, member_limit=2)
    code = invite_code(w, t)
    u = w.user()
    join_by_invite(w.login(u), code)
    assert u["id"] not in member_ids(w, t), "full team accepted a new member via invite link"


@suite.test("t1.join.invite_accepted_with_free_seat", "R1.3")
def _(w):
    t = w.team(members=1, member_limit=2)
    code = invite_code(w, t)
    u = w.user()
    join_by_invite(w.login(u), code)
    assert u["id"] in member_ids(w, t), "invite link must still work while seats are free"


@suite.test("t1.ui.public_team_page_seats", "R1.8")
def _(w):
    t = w.team(members=3, member_limit=4)
    html = Client(w.base).get(f"/teams/{t['id']}").text
    assert re.search(r"\b3\s*/\s*4\s+members\b", html, re.I), "public team page must show '3 / 4 members'"


@suite.test("t1.ui.own_team_page_seats_global", "R1.8")
def _(w):
    w.config(team_size=5)
    t = w.team(members=2)
    html = w.login(t["users"][1]).get("/team").text
    assert re.search(r"\b2\s*/\s*5\s+members\b", html, re.I), "own team page must show '2 / 5 members'"


@suite.test("t1.ui.no_seat_text_without_limit", "R1.8")
def _(w):
    t = w.team(members=2)
    html = Client(w.base).get(f"/teams/{t['id']}").text
    assert not re.search(r"\b2\s*/\s*\d+\s+members\b", html, re.I), "no seat usage text when no limit applies"


@suite.test("t1.ui.admin_form_field", "R1.1")
def _(w):
    t = w.team(members=1, member_limit=3)
    html = w.admin.session.get(f"/admin/teams/{t['id']}").text
    assert re.search(r'name="member_limit"', html), "admin team edit form must have a member_limit field"
    m = re.search(r'<input[^>]*name="member_limit"[^>]*>', html)
    assert m and 'value="3"' in m.group(0), "edit form must be pre-filled with the current limit"
