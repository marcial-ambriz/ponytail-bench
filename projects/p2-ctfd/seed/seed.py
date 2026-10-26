"""Mock data for screenshots / UX: users, teams, challenges, hints, submissions.

Usage: BASE_URL=http://localhost:4000 python3 -I seed/seed.py
Runs the setup wizard if needed (teams mode, admin bench-admin / bench-admin-pass-123). Works on the base and on any
task stage: task-specific fields (member_limit, penalty, first_blood_bonus) are only sent when the server supports them.
Fixed logins (password player-pass-123): alice (captain of NullPointers), bob, carol, dave (no team).
Idempotent: does nothing if user "alice" already exists.
"""
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "acceptance", "lib"))

from ctfd import PASSWORD, World, attempt, wait_ready  # noqa: E402

TEAMS = [
    ("NullPointers", ["alice", "bob", "carol"]),
    ("Segfault Society", ["erin", "frank"]),
    ("Root Beer", ["grace", "heidi", "ivan"]),
    ("Staff", ["staffer"]),
]
CHALLENGES = [
    # name, category, value, flag, kind, penalty
    ("Warmup", "Misc", 50, "flag{hello}", "standard", 0),
    ("Baby RSA", "Crypto", 200, "flag{small_e}", "standard", 20),
    ("Cookie Monster", "Web", 150, "flag{cookies}", "standard", 10),
    ("Stack Smash", "Pwn", 300, "flag{ret2win}", "dynamic", 0),
    ("Lost in Logs", "Forensics", 100, "flag{grep_it}", "standard", 0),
    ("Regex Golf", "Misc", 120, "flag{^golf$}", "standard", 5),
]


def main():
    base = os.environ.get("BASE_URL", "http://localhost:4000")
    wait_ready(base)
    w = World(base)
    if w.admin.api("GET", "/users?q=alice&field=name").json().get("data"):
        print("already seeded")
        return 0
    w.admin.api("PATCH", "/configs", {"ctf_name": "Bench CTF 2026", "incorrect_submissions_per_min": 1000})
    users, teams = {}, {}
    for tname, members in TEAMS:
        r = w.admin.api("POST", "/teams", {"name": tname, "password": "teampass", "affiliation": "Bench University"})
        t = r.json()["data"]
        teams[tname] = t
        for n in members:
            u = w.admin.api("POST", "/users", {"name": n, "email": f"{n}@example.com", "password": PASSWORD}).json()["data"]
            u["password"] = PASSWORD
            users[n] = u
            w.admin.api("POST", f"/teams/{t['id']}/members", {"user_id": u["id"]})
        w.admin.api("PATCH", f"/teams/{t['id']}", {"captain_id": users[members[0]]["id"]})
    users["dave"] = w.admin.api("POST", "/users", {"name": "dave", "email": "dave@example.com",
                                                   "password": PASSWORD}).json()["data"]
    users["dave"]["password"] = PASSWORD

    features = "member_limit" in w.team_admin(teams["NullPointers"]["id"])
    if features:
        w.admin.api("PATCH", f"/teams/{teams['NullPointers']['id']}", {"member_limit": 4})
        w.admin.api("PATCH", "/configs", {"first_blood_bonus": 25})
    w.admin.api("PATCH", "/configs", {"team_size": 5})

    chals = {}
    for name, cat, value, flag, kind, penalty in CHALLENGES:
        extra = {"description": f"**{name}**: find the flag. Format `flag{{...}}`."}
        c = w.challenge(value=value, flag=flag, kind=kind, category=cat, name=name, **extra)
        if features and penalty:
            w.admin.api("PATCH", f"/challenges/{c['id']}", {"penalty": penalty})
        chals[name] = c
    w.admin.api("POST", "/hints", {"challenge_id": chals["Baby RSA"]["id"], "content": "e is very small", "cost": 50})
    w.admin.api("POST", "/hints", {"challenge_id": chals["Warmup"]["id"], "content": "read the rules", "cost": 0})

    def play(user, chal, sub):
        attempt(w.login(users[user]), chals[chal]["id"], sub)

    play("staffer", "Warmup", "flag{hello}")
    play("staffer", "Baby RSA", "flag{small_e}")
    w.admin.api("PATCH", f"/teams/{teams['Staff']['id']}", {"hidden": True})
    play("alice", "Warmup", "flag{hello}")
    play("erin", "Warmup", "flag{hello}")
    play("grace", "Warmup", "flag{hello}")
    play("bob", "Cookie Monster", "flag{cookie}")
    play("bob", "Cookie Monster", "flag{cookies}")
    play("frank", "Baby RSA", "flag{big_e}")
    play("frank", "Baby RSA", "flag{small_e}")
    play("heidi", "Stack Smash", "flag{ret2libc}")
    play("ivan", "Stack Smash", "flag{ret2win}")
    play("carol", "Regex Golf", "flag{golf}")
    play("alice", "Lost in Logs", "flag{grep_it}")
    print(f"seeded {len(users)} users, {len(teams)} teams, {len(chals)} challenges (task features: {features})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
