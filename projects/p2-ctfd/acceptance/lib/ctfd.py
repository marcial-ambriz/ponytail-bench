"""Tiny stdlib-only HTTP client + fixtures for driving a live CTFd server.

Shared by acceptance/, hazards/, maintenance/ and seed/. No third-party imports so the
hidden suites never depend on the run's own virtualenv.
"""
import http.cookiejar
import json as _json
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ADMIN_NAME = "bench-admin"
ADMIN_EMAIL = "bench-admin@example.com"
ADMIN_PASSWORD = "bench-admin-pass-123"
PASSWORD = "player-pass-123"


class Resp:
    def __init__(self, status, body, headers):
        self.status = status
        self.body = body
        self.headers = headers

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        try:
            return _json.loads(self.body or b"null")
        except ValueError:
            return None

    def __repr__(self):
        return f"<Resp {self.status} {self.text[:200]!r}>"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    """One browser-like session (own cookie jar). Optionally token-authenticated."""

    def __init__(self, base_url, token=None):
        self.base = base_url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect()
        )
        self.token = token
        self._nonce = None
        # 127.0.0.1 is a trusted proxy in CTFd, so each simulated browser gets its own client IP
        # (keeps CTFd's per-IP rate limits from throttling the test driver itself).
        self.ip = "198.18.%d.%d" % (random.randint(0, 255), random.randint(1, 254))

    def request(self, method, path, form=None, json=None, headers=None, timeout=60):
        url = path if path.startswith("http") else self.base + path
        h = {"X-Forwarded-For": self.ip}
        h.update(headers or {})
        data = None
        if json is not None:
            data = _json.dumps(json).encode()
            h["Content-Type"] = "application/json"
        elif form is not None:
            data = urllib.parse.urlencode(form).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        if self.token:
            h["Authorization"] = f"Token {self.token}"
        elif method not in ("GET", "HEAD") and json is not None:
            h["CSRF-Token"] = self.nonce()
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return Resp(r.status, r.read(), dict(r.headers))
        except urllib.error.HTTPError as e:
            return Resp(e.code, e.read() if e.fp else b"", dict(e.headers or {}))

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def nonce(self, refresh=False):
        if self._nonce is None or refresh:
            r = self.get("/")
            if r.status != 200:
                r = self.get("/")
            self._nonce = parse_nonce(r.text)
        return self._nonce

    def logged_in(self):
        return any(c.name == "session" for c in self.jar) and self._nonce is not None

    def form_post(self, path, fields, page=None):
        """POST a classic HTML form, scraping the nonce from `page` (or `path`) first."""
        r = self.get(page or path)
        fields = dict(fields)
        fields["nonce"] = parse_nonce(r.text)
        return self.request("POST", path, form=fields)

    def api(self, method, path, json=None):
        if not path.startswith("/api/"):
            path = "/api/v1" + path
        return self.request(method, path, json=json if json is not None else ({} if method != "GET" else None))

    def login(self, name, password):
        r = self.form_post("/login", {"name": name, "password": password})
        if r.status != 302:
            raise AssertionError(f"login failed for {name}: {r}")
        self._nonce = None
        self._nonce = parse_nonce(self.get("/").text)
        return self


def parse_nonce(html):
    m = re.search(r"'csrfNonce':\s*\"([0-9a-f]+)\"", html) or re.search(
        r'name="nonce"\s+(?:type="hidden"\s+)?value="([^"]+)"', html
    ) or re.search(r'id="nonce"[^>]*value="([^"]+)"', html)
    if not m:
        raise AssertionError("could not find CSRF nonce in page")
    return m.group(1)


def wait_ready(base, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = Client(base).get("/")
            if r.status in (200, 302):
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"server at {base} not ready")


def ensure_setup(base):
    """Run the setup wizard (teams mode) if needed; return an admin token client."""
    c = Client(base)
    r = c.get("/setup")
    if r.status == 200 and "setup" in r.text.lower() and 'name="ctf_name"' in r.text:
        nonce = parse_nonce(r.text)
        r = c.request(
            "POST",
            "/setup",
            form={
                "ctf_name": "Bench CTF",
                "ctf_description": "benchmark",
                "user_mode": "teams",
                "challenge_visibility": "private",
                "account_visibility": "public",
                "score_visibility": "public",
                "registration_visibility": "public",
                "verify_emails": "false",
                "team_size": "",
                "name": ADMIN_NAME,
                "email": ADMIN_EMAIL,
                "password": ADMIN_PASSWORD,
                "ctf_theme": "core",
                "start": "",
                "end": "",
                "nonce": nonce,
                "_submit": "Finish",
            },
        )
        if r.status not in (200, 302):
            raise RuntimeError(f"setup failed: {r}")
    admin = Client(base).login(ADMIN_NAME, ADMIN_PASSWORD)
    r = admin.api("POST", "/tokens", {"description": "bench"})
    tok = (r.json() or {}).get("data", {}).get("value")
    if not tok:
        raise RuntimeError(f"could not create admin token: {r}")
    a = Client(base, token=tok)
    a.session = admin
    return a


class World:
    """Fixture factory. Every object gets a unique name so suites can share a database."""

    def __init__(self, base):
        self.base = base.rstrip("/")
        self.admin = ensure_setup(self.base)
        self.tag = uuid.uuid4().hex[:6]
        self.n = 0
        self.lock = threading.Lock()

    def uniq(self, prefix):
        with self.lock:
            self.n += 1
            return f"{prefix}-{self.tag}-{self.n}"

    # ---- config
    def config(self, **kv):
        r = self.admin.api("PATCH", "/configs", kv)
        assert r.status == 200, f"config patch failed: {r}"

    def reset_config(self):
        self.config(
            team_size=None,
            first_blood_bonus=None,
            incorrect_submissions_per_min=100000,
            freeze=None,
            paused=False,
        )

    # ---- accounts
    def user(self, name=None, **extra):
        name = name or self.uniq("u")
        body = {"name": name, "email": f"{name}@example.com", "password": PASSWORD}
        body.update(extra)
        r = self.admin.api("POST", "/users", body)
        assert r.status == 200, f"create user failed: {r}"
        d = r.json()["data"]
        d["password"] = PASSWORD
        return d

    def login(self, user):
        return Client(self.base).login(user["name"], user["password"])

    def team(self, members=0, name=None, password="teampass", **extra):
        name = name or self.uniq("t")
        body = {"name": name, "password": password}
        body.update(extra)
        r = self.admin.api("POST", "/teams", body)
        assert r.status == 200, f"create team failed: {r}"
        t = r.json()["data"]
        t["password"] = password
        t["users"] = []
        for _ in range(members):
            u = self.user()
            self.add_member(t, u)
        if t["users"]:
            self.admin.api("PATCH", f"/teams/{t['id']}", {"captain_id": t["users"][0]["id"]})
        return t

    def add_member(self, team, user):
        r = self.admin.api("POST", f"/teams/{team['id']}/members", {"user_id": user["id"]})
        assert r.status == 200, f"add member failed: {r}"
        team["users"].append(user)

    def team_admin(self, team_id):
        r = self.admin.api("GET", f"/teams/{team_id}")
        assert r.status == 200, f"get team failed: {r}"
        return r.json()["data"]

    def members(self, team_id):
        r = self.admin.api("GET", f"/teams/{team_id}/members")
        assert r.status == 200, f"get members failed: {r}"
        return r.json()["data"]

    def score(self, team_id):
        return self.team_admin(team_id)["score"]

    def awards(self, team_id):
        r = self.admin.api("GET", f"/teams/{team_id}/awards")
        assert r.status == 200, r
        return r.json()["data"]

    def solves(self, team_id):
        r = self.admin.api("GET", f"/teams/{team_id}/solves")
        assert r.status == 200, r
        return r.json()["data"]

    def scoreboard_score(self, team_id):
        r = Client(self.base).api("GET", "/scoreboard")
        for row in (r.json() or {}).get("data", []):
            if row.get("account_id") == team_id:
                return row.get("score")
        return None

    # ---- challenges
    def challenge(self, value=100, flag="flag{ok}", kind="standard", **extra):
        body = {
            "name": self.uniq("chal"),
            "category": "bench",
            "description": "benchmark challenge",
            "value": value,
            "state": "visible",
            "type": kind,
        }
        if kind == "dynamic":
            body.update({"initial": value, "minimum": 10, "decay": 10, "function": "linear"})
        body.update(extra)
        r = self.admin.api("POST", "/challenges", body)
        assert r.status == 200, f"create challenge failed: {r}"
        c = r.json()["data"]
        if flag:
            r = self.admin.api("POST", "/flags", {"challenge": c["id"], "content": flag, "type": "static"})
            assert r.status == 200, f"create flag failed: {r}"
        c["flag"] = flag
        return c


def attempt(client, challenge_id, submission):
    r = client.api("POST", "/challenges/attempt", {"challenge_id": challenge_id, "submission": submission})
    d = r.json() or {}
    return r.status, (d.get("data") or {}).get("status")


def simultaneously(fns, timeout=60):
    """Run callables at the same instant (barrier) on separate threads; return results/exceptions."""
    barrier = threading.Barrier(len(fns))
    out = [None] * len(fns)

    def run(i, fn):
        try:
            barrier.wait(timeout)
            out[i] = fn()
        except Exception as e:  # noqa: BLE001
            out[i] = e

    ts = [threading.Thread(target=run, args=(i, f)) for i, f in enumerate(fns)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout)
    return out


# ---------------------------------------------------------------- test runner
class Suite:
    def __init__(self, name):
        self.name = name
        self.tests = []

    def test(self, tid, requirement, category="acceptance", severity=None):
        def deco(fn):
            self.tests.append((tid, requirement, category, severity, fn))
            return fn

        return deco

    def run(self, only=None):
        base = os.environ.get("BASE_URL", "http://127.0.0.1:4000")
        results = []
        try:
            wait_ready(base)
            world = World(base)
        except Exception as e:  # runner error -> every test fails, still a valid result file
            world = None
            setup_err = f"setup error: {e}"
        for tid, req, cat, sev, fn in self.tests:
            if only and not any(tid.startswith(o) for o in only):
                continue
            entry = {"id": tid, "requirement": req, "category": cat}
            if sev:
                entry["severity"] = sev
            if world is None:
                entry.update(status="fail", message=setup_err)
            else:
                t0 = time.time()
                try:
                    world.reset_config()
                    fn(world)
                    entry.update(status="pass", message="")
                except AssertionError as e:
                    entry.update(status="fail", message=str(e)[:500])
                except Exception as e:  # noqa: BLE001
                    entry.update(status="fail", message=f"{type(e).__name__}: {e}"[:500])
                entry["seconds"] = round(time.time() - t0, 2)
            results.append(entry)
            print(f"[{entry['status']}] {tid} ({req}) {entry.get('message','')}", flush=True)
        return results


def write_result(results, extra=None):
    out = {
        "passed": sum(1 for r in results if r["status"] == "pass"),
        "total": len(results),
        "tests": results,
    }
    if extra:
        out.update(extra)
    path = os.environ.get("RESULT_JSON")
    if path:
        with open(path, "w") as f:
            _json.dump(out, f, indent=2)
    print(f"{out['passed']}/{out['total']} passed")
    return out


# ---------------------------------------------------------------- team-join helpers
def join_by_password(client, team):
    return client.form_post(
        "/teams/join", {"name": team["name"], "password": team["password"]}, page="/teams/join"
    )


def invite_code(world, team):
    """Invite code generated by the team's captain from the team page."""
    cap = world.login(team["users"][0])
    r = cap.api("POST", "/teams/me/members")
    assert r.status == 200, f"captain could not create invite code: {r}"
    return r.json()["data"]["code"]


def join_by_invite(client, code):
    path = "/teams/invite?code=" + urllib.parse.quote(code)
    return client.form_post(path, {}, page=path)
