"""Hidden acceptance checks for the fake project (harness self-test only)."""
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ["API_URL"]
CP = sys.argv[1]
results = []


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw.decode())
    except urllib.error.HTTPError as e:
        return e.code, None


def check(id, req, crit, fn, **extra):
    try:
        ok, msg = fn()
    except Exception as e:  # a crash in one check fails only that check
        ok, msg = False, repr(e)
    results.append({"id": id, "requirement": req, "category": crit, "criterion": crit,
                    "status": "pass" if ok else "fail", "message": msg, **extra})


def create():
    s, b = call("POST", "/items", {"name": "apple", "qty": 3})
    return s == 201 and isinstance(b, dict) and "id" in b, f"status {s}"


def listing():
    call("POST", "/items", {"name": "pear", "qty": 2})
    s, b = call("GET", "/items")
    return s == 200 and any(i.get("name") == "pear" for i in b or []), f"status {s}"


def invalid():
    codes = [call("POST", "/items", {"name": "x", "qty": q})[0] for q in (0, -2)]
    return codes == [422, 422], f"codes {codes}"


def page():
    s, b = call("GET", "/")
    return s == 200 and "<ul>" in str(b) or "No items" in str(b), f"status {s}"


def total():
    _, before = call("GET", "/total")
    call("POST", "/items", {"name": "t", "qty": 4})
    s, after = call("GET", "/total")
    return s == 200 and after["total"] == before["total"] + 4, f"{before} -> {after}"


def take():
    _, b = call("POST", "/items", {"name": "k", "qty": 5})
    s, _ = call("POST", f"/items/{b['id']}/take", {"qty": 2})
    _, items = call("GET", "/items")
    left = [i["qty"] for i in items if i["id"] == b["id"]]
    return s == 200 and left == [3], f"status {s} left {left}"


def overtake():
    _, b = call("POST", "/items", {"name": "o", "qty": 1})
    s, _ = call("POST", f"/items/{b['id']}/take", {"qty": 2})
    _, items = call("GET", "/items")
    left = [i["qty"] for i in items if i["id"] == b["id"]]
    return s == 409 and left == [1], f"status {s} left {left}"


def migrated():
    _, items = call("GET", "/items")
    return any(i.get("name") == "seeded-before-cp2" for i in items or []), "seed row present after cp2"


if CP == "cp1":
    check("cp1-create", "R1.1", "C1", create)
    check("cp1-list", "R1.2", "C1", listing, gate="auth")
    check("cp1-invalid-qty", "R1.3", "C2", invalid)
    check("cp1-page", "R1.4", "C5", page)
elif CP == "cp2":
    check("cp2-total", "R2.1", "C1", total)
    check("cp2-take", "R2.2", "C1", take)
    check("cp2-overtake", "R2.3", "C2", overtake)
    if os.environ.get("REUSED_DB") == "1":
        check("cp2-migrated-data", "R2.4", "C1", migrated)
else:
    sys.exit(f"unknown checkpoint {CP}")

with open(os.environ["RESULT_JSON"], "w") as f:
    json.dump({"passed": sum(r["status"] == "pass" for r in results), "total": len(results), "tests": results}, f)
