import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import logic

DB = os.environ["DB_PATH"]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        try:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
        except ValueError:
            return None

    def do_GET(self):
        db = logic.connect(DB)
        if self.path == "/health":
            return self.reply(200, "ok", "text/plain")
        if self.path == "/items":
            return self.reply(200, [{"id": i, "name": n, "qty": q} for i, n, q in db.execute("SELECT * FROM items")])
        if self.path == "/total":
            return self.reply(200, {"total": db.execute("SELECT COALESCE(SUM(qty), 0) FROM items").fetchone()[0]})
        if self.path == "/":
            rows = db.execute("SELECT name, qty FROM items").fetchall()
            lis = "".join(f"<li>{n}: {q}</li>" for n, q in rows) or "<p>No items</p>"
            return self.reply(200, f"<!doctype html><title>Items</title><h1>Items</h1><ul>{lis}</ul>", "text/html")
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        db = logic.connect(DB)
        d = self.body()
        if self.path == "/items":
            err = logic.validate_item(d)
            if err:
                return self.reply(422, {"error": err})
            cur = db.execute("INSERT INTO items (name, qty) VALUES (?, ?)", (d["name"], d["qty"]))
            return self.reply(201, {"id": cur.lastrowid})
        m = re.fullmatch(r"/items/(\d+)/take", self.path)
        if m:
            q = (d or {}).get("qty") if isinstance(d, dict) else None
            if not isinstance(q, int) or isinstance(q, bool) or q <= 0:
                return self.reply(422, {"error": "qty must be a positive integer"})
            return self.reply(logic.take(db, int(m.group(1)), q), {})
        self.reply(404, {"error": "not found"})


ThreadingHTTPServer(("127.0.0.1", int(os.environ["WEB_PORT"])), H).serve_forever()
