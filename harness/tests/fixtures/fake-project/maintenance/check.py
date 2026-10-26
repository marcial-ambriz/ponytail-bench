"""Hidden tests for the maintenance feature of the fake project."""
import json
import os
import urllib.error
import urllib.request

API = os.environ["API_URL"]
try:
    with urllib.request.urlopen(API + "/items/count", timeout=10) as r:
        ok, msg = r.status == 200 and "count" in json.loads(r.read()), "ok"
except (urllib.error.URLError, ValueError) as e:
    ok, msg = False, repr(e)
with open(os.environ["RESULT_JSON"], "w") as f:
    json.dump({"passed": int(ok), "total": 1, "tests": [{"id": "m-count", "requirement": "M1", "category": "C1",
                                                         "status": "pass" if ok else "fail", "message": msg}]}, f)
