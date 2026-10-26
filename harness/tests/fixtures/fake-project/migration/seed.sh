#!/usr/bin/env bash
# Seeds data through the API at the end of cp1; the harness keeps this DB for cp2 (reuse_db_from).
exec python3 -I -c '
import json, os, urllib.request
req = urllib.request.Request(os.environ["API_URL"] + "/items", method="POST",
      data=json.dumps({"name": "seeded-before-cp2", "qty": 7}).encode(), headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=10).read()
'
