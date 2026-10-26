"""Live-server hazard tests. Id prefix hz.<task>. selects which tasks' hazards run; severity 1-3."""
from ctfd import Client, attempt, invite_code, join_by_invite, join_by_password, simultaneously

ROUNDS = 6


def member_count(w, team):
    return len(w.members(team["id"]))


def register(suite):
    T = suite.test

    # ------------------------------------------------------------------ t1 seat limits
    @T("hz.t1.concurrent_join_password", "R1.4", "concurrency", 3)
    def _(w):
        for i in range(ROUNDS):
            t = w.team(members=1, member_limit=4)
            clients = [w.login(w.user()) for _ in range(12)]
            simultaneously([lambda c=c: join_by_password(c, t) for c in clients])
            n = member_count(w, t)
            assert n == 4, f"round {i}: 12 simultaneous joins into 3 free seats left {n} members (expected 4)"

    @T("hz.t1.concurrent_join_invite", "R1.4", "concurrency", 3)
    def _(w):
        for i in range(ROUNDS):
            t = w.team(members=1, member_limit=3)
            code = invite_code(w, t)
            clients = [w.login(w.user()) for _ in range(12)]
            simultaneously([lambda c=c: join_by_invite(c, code) for c in clients])
            n = member_count(w, t)
            assert n == 3, f"round {i}: invite-link rush left {n} members (expected 3)"

    @T("hz.t1.concurrent_join_global_size", "R1.4", "concurrency", 3)
    def _(w):
        w.config(team_size=3)
        for i in range(ROUNDS):
            t = w.team(members=1)
            clients = [w.login(w.user()) for _ in range(12)]
            simultaneously([lambda c=c: join_by_password(c, t) for c in clients])
            n = member_count(w, t)
            assert n == 3, f"round {i}: global team size 3 but {n} members after simultaneous joins"

    @T("hz.t1.captain_cannot_set_limit", "R1.6", "authz", 3)
    def _(w):
        t = w.team(members=2, member_limit=2)
        cap = w.login(t["users"][0])
        r = cap.api("PATCH", "/teams/me", {"member_limit": 50})
        assert not (r.status == 200 and (r.json() or {}).get("success") and w.team_admin(t["id"]).get("member_limit") != 2), r
        assert w.team_admin(t["id"]).get("member_limit") == 2, "captain changed the team's member limit"
        r = cap.api("PATCH", f"/teams/{t['id']}", {"member_limit": 50})
        assert r.status in (401, 403, 404), f"player reached the admin team endpoint: {r}"
        assert w.team_admin(t["id"]).get("member_limit") == 2
        u = w.user()
        join_by_password(w.login(u), t)
        assert member_count(w, t) == 2

    @T("hz.t1.invalid_limits_rejected", "R1.5", "validation", 2)
    def _(w):
        t = w.team(members=1, member_limit=3)
        for bad in (0, -1, 2.5, "abc", True, "3.5", 10 ** 9):
            r = w.admin.api("PATCH", f"/teams/{t['id']}", {"member_limit": bad})
            assert r.status == 400, f"member_limit={bad!r} answered {r.status}, expected 400"
            assert w.team_admin(t["id"]).get("member_limit") == 3, f"member_limit={bad!r} changed the team"
        r = w.admin.api("POST", "/teams", {"name": w.uniq("t"), "password": "x", "member_limit": -2})
        assert r.status == 400, f"creating a team with member_limit=-2 answered {r.status}"

    @T("hz.t1.lowering_limit_keeps_members", "R1.7", "data-loss", 2)
    def _(w):
        t = w.team(members=4, member_limit=5)
        r = w.admin.api("PATCH", f"/teams/{t['id']}", {"member_limit": 2})
        assert r.status == 200, r
        assert member_count(w, t) == 4, "lowering the limit removed members"
        join_by_password(w.login(w.user()), t)
        assert member_count(w, t) == 4, "over-full team accepted another member"

    # ------------------------------------------------------------------ t2 single solve per team
    @T("hz.t2.same_member_double_submit", "R2.1", "concurrency", 3)
    def _(w):
        for i in range(ROUNDS):
            t = w.team(members=1)
            c = w.challenge(value=100)
            u = t["users"][0]
            clients = [w.login(u) for _ in range(6)]
            simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
            n = len(w.solves(t["id"]))
            assert n == 1, f"round {i}: one player double-submitting produced {n} solves"
            assert w.score(t["id"]) == 100

    @T("hz.t2.different_teams_all_count", "R2.1", "concurrency", 2)
    def _(w):
        c = w.challenge(value=100)
        teams = [w.team(members=1) for _ in range(6)]
        clients = [w.login(t["users"][0]) for t in teams]
        res = simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
        for t, r in zip(teams, res):
            assert len(w.solves(t["id"])) == 1, f"team {t['name']} lost its solve ({r})"

    # ------------------------------------------------------------------ t3 penalties
    def scored_team(w, points, members=1):
        t = w.team(members=members)
        seed = w.challenge(value=points)
        clients = [w.login(u) for u in t["users"]]
        assert attempt(clients[0], seed["id"], seed["flag"])[1] == "correct"
        return t, clients

    @T("hz.t3.simultaneous_wrong_never_negative", "R3.4", "concurrency", 3)
    def _(w):
        for i in range(ROUNDS):
            t, _ = scored_team(w, 30, members=8)
            c = w.challenge(value=100, penalty=25)
            clients = [w.login(u) for u in t["users"]]
            simultaneously([lambda cl=cl, k=k: attempt(cl, c["id"], f"wrong-{k}") for k, cl in enumerate(clients)])
            s = w.score(t["id"])
            assert s == 0, f"round {i}: 8 simultaneous wrong answers (30 pts, penalty 25) left score {s}, expected 0"

    @T("hz.t3.simultaneous_identical_wrong_once", "R3.3", "idempotency", 3)
    def _(w):
        for i in range(ROUNDS):
            t, _ = scored_team(w, 100, members=10)
            c = w.challenge(value=100, penalty=10)
            clients = [w.login(u) for u in t["users"]]
            simultaneously([lambda cl=cl: attempt(cl, c["id"], "flag{same-guess}") for cl in clients])
            s = w.score(t["id"])
            assert s == 90, f"round {i}: one wrong answer sent 10x at once cost {100 - s} points, expected 10"

    @T("hz.t3.invalid_penalty_rejected", "R3.8", "validation", 2)
    def _(w):
        c = w.challenge(value=100, penalty=5)
        for bad in (-1, 2.5, "abc", True, "-3"):
            r = w.admin.api("PATCH", f"/challenges/{c['id']}", {"penalty": bad})
            assert r.status == 400, f"penalty={bad!r} answered {r.status}, expected 400"
            got = w.admin.api("GET", f"/challenges/{c['id']}").json()["data"].get("penalty")
            assert got == 5, f"penalty={bad!r} changed the challenge to {got!r}"
        name = w.uniq("badchal")
        r = w.admin.api("POST", "/challenges", {"name": name, "category": "x", "description": "x", "value": 10,
                                                "state": "visible", "type": "standard", "penalty": -4})
        assert r.status == 400, f"creating a challenge with penalty -4 answered {r.status}"
        rows = w.admin.api("GET", "/challenges?view=admin").json()["data"]
        assert not any(x["name"] == name for x in rows), "invalid challenge was stored"

    @T("hz.t3.player_cannot_change_penalty", "R3.10", "authz", 3)
    def _(w):
        t, (p,) = scored_team(w, 10)
        c = w.challenge(value=100, penalty=10)
        r = p.api("PATCH", f"/challenges/{c['id']}", {"penalty": 0})
        assert r.status in (401, 403, 404), f"player PATCH challenge answered {r.status}"
        assert w.admin.api("GET", f"/challenges/{c['id']}").json()["data"].get("penalty") == 10

    @T("hz.t3.penalty_keeps_history", "R3.4", "data-loss", 2)
    def _(w):
        t, (p,) = scored_team(w, 20)
        r = w.admin.api("POST", "/awards", {"user_id": t["users"][0]["id"], "team_id": t["id"], "name": "Bonus",
                                            "value": 15, "category": "x", "description": "x"})
        assert r.status == 200, r
        c = w.challenge(value=100, penalty=50)
        for k in range(3):
            attempt(p, c["id"], f"w{k}")
        assert len(w.solves(t["id"])) == 1, "penalties must not remove solves"
        assert any(a["name"] == "Bonus" and a["value"] == 15 for a in w.awards(t["id"])), "penalty altered an award"
        assert w.score(t["id"]) == 0
        assert attempt(p, c["id"], c["flag"])[1] == "correct"
        assert w.score(t["id"]) == 100

    # ------------------------------------------------------------------ t4 solve counts
    @T("hz.t4.hidden_team_not_exposed", "R4.1", "authz", 2)
    def _(w):
        c = w.challenge(value=100)
        staff = w.team(members=1)
        attempt(w.login(staff["users"][0]), c["id"], c["flag"])
        w.admin.api("PATCH", f"/teams/{staff['id']}", {"hidden": True})
        p = w.login(w.team(members=1)["users"][0])
        names = [s["name"] for s in p.api("GET", f"/challenges/{c['id']}/solves").json()["data"]]
        assert staff["name"] not in names, "hidden team listed as a solver"
        rows = p.api("GET", "/challenges").json()["data"]
        assert next(r["solves"] for r in rows if r["id"] == c["id"]) == 0
        assert Client(w.base).get(f"/teams/{staff['id']}").status == 404, "hidden team page is public"

    # ------------------------------------------------------------------ t5 first blood
    def fb_awards(w, team_id):
        return [a for a in w.awards(team_id) if a["name"].lower().startswith("first blood")]

    @T("hz.t5.simultaneous_first_solves_one_bonus", "R5.4", "concurrency", 3)
    def _(w):
        w.config(first_blood_bonus=50)
        for i in range(ROUNDS):
            c = w.challenge(value=100)
            teams = [w.team(members=1) for _ in range(6)]
            clients = [w.login(t["users"][0]) for t in teams]
            simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
            winners = [t for t in teams if any(c["name"] in a["name"] for a in fb_awards(w, t["id"]))]
            assert len(winners) == 1, f"round {i}: {len(winners)} teams got first blood for one challenge"
            first = min(teams, key=lambda t: min(s["id"] for s in w.solves(t["id"])))
            assert winners[0]["id"] == first["id"], f"round {i}: first blood went to a team that solved later"

    @T("hz.t5.same_team_race_one_bonus", "R5.4", "idempotency", 3)
    def _(w):
        w.config(first_blood_bonus=50)
        for i in range(ROUNDS):
            c = w.challenge(value=100)
            t = w.team(members=6)
            clients = [w.login(u) for u in t["users"]]
            simultaneously([lambda cl=cl: attempt(cl, c["id"], c["flag"]) for cl in clients])
            n = len(fb_awards(w, t["id"]))
            assert n == 1 and w.score(t["id"]) == 150, f"round {i}: {n} bonuses, score {w.score(t['id'])}"

    @T("hz.t5.player_cannot_change_bonus", "R5.1", "authz", 3)
    def _(w):
        w.config(first_blood_bonus=20)
        t = w.team(members=1)
        p = w.login(t["users"][0])
        r = p.api("PATCH", "/configs", {"first_blood_bonus": 100000})
        assert r.status in (401, 403, 404), f"player PATCH configs answered {r.status}"
        r = w.admin.api("GET", "/configs/first_blood_bonus").json()
        assert str((r.get("data") or {}).get("value")) == "20", r
