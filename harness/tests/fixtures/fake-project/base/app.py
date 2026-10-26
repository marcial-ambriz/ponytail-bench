import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(b"ok")


ThreadingHTTPServer(("127.0.0.1", int(os.environ["WEB_PORT"])), H).serve_forever()
