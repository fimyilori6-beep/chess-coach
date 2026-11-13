#!/usr/bin/env python3
"""Local server for Chess Coach.

Serves the app and keeps your progress in data/state.json on this machine.
Listens on 127.0.0.1 only, so nothing is reachable from other devices.
The data/ folder is git-ignored and never leaves your computer.
"""
import json
import os
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
STATE = os.path.join(DATA_DIR, "state.json")
MAX_BYTES = 5 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _json(self, code, body):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/state":
            if os.path.exists(STATE):
                with open(STATE, "rb") as f:
                    return self._json(200, f.read())
            return self._json(200, "null")
        if self.path.startswith("/data"):
            return self._json(404, '{"error":"not found"}')
        return super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/state":
            return self._json(404, '{"error":"not found"}')
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, '{"error":"bad size"}')
        raw = self.rfile.read(n)
        try:
            json.loads(raw)
        except ValueError:
            return self._json(400, '{"error":"invalid json"}')
        os.makedirs(DATA_DIR, exist_ok=True)
        # Write atomically so a crash mid-save can't corrupt your progress
        fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp, STATE)
        return self._json(200, '{"ok":true}')

    def end_headers(self):
        # Always serve fresh JS/CSS while developing locally
        if not self.path.startswith("/lib/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/state" not in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3300
    print(f"Chess Coach running at http://localhost:{port}  (progress saved to data/state.json)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
