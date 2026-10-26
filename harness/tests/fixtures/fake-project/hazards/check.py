"""Hidden hazard (protection) checks for the fake project. Titles carry [H:<category>:<severity>]."""
import concurrent.futures
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ["API_URL"]
CP = sys.argv[1] if len(sys.argv) > 1 else "cp2"
results = []


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def check(id, cat, sev, fn):
    try:
        ok, msg = fn()
    except Exception as e:
        ok, msg = False, repr(e)
    results.append({"id": f"[H:{cat}:{sev}] {id}", "requirement": id, "category": cat, "severity": sev,
                    "status": "pass" if ok else "fail", "message": msg})


def string_qty():
    s, _ = call("POST", "/items", {"name": "s", "qty": "3"})
    return s == 422, f"status {s}"


def fractional_qty():
    s, _ = call("POST", "/items", {"name": "f", "qty": 1.5})
    return s == 422, f"status {s}"


def parallel_take():
    _, b = call("POST", "/items", {"name": "race", "qty": 5})
    with concurrent.futures.ThreadPoolExecutor(20) as ex:
        codes = list(ex.map(lambda _: call("POST", f"/items/{b['id']}/take", {"qty": 1})[0], range(20)))
    _, items = call("GET", "/items")
    left = [i["qty"] for i in items if i["id"] == b["id"]]
    return codes.count(200) == 5 and left == [0], f"200s={codes.count(200)} left={left}"


check("string qty rejected", "validation", 2, string_qty)
check("fractional qty rejected", "validation", 1, fractional_qty)
if CP == "cp2":
    check("20 parallel takes of the last 5 units", "concurrency", 3, parallel_take)

with open(os.environ["RESULT_JSON"], "w") as f:
    json.dump({"passed": sum(r["status"] == "pass" for r in results), "total": len(results), "tests": results}, f)
