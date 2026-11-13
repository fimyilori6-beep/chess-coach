#!/usr/bin/env python3
"""Local server for Chess Coach.

Serves the app and keeps your progress in data/state.json on this machine.
Listens on 127.0.0.1 only, so nothing is reachable from other devices.
The data/ folder is git-ignored and never leaves your computer.
"""
import errno
import json
import os
import sys
import tempfile
import urllib.request
import webbrowser
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


def already_running(port):
    """True if Chess Coach itself is already serving on this port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    open_browser = "--open" in sys.argv
    port = int(args[0]) if args else 3300
    url = f"http://localhost:{port}"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        if e.errno == errno.EADDRINUSE and already_running(port):
            print(f"Chess Coach is already running at {url} — opening it.")
            webbrowser.open(url)
            sys.exit(0)
        if e.errno == errno.EADDRINUSE:
            sys.exit(f"Port {port} is used by another program. Try: python3 server.py {port + 1}")
        raise
    print(f"Chess Coach running at {url}  (progress saved to data/state.json)")
    print("Press Ctrl+C to stop.")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped. Your progress is saved.")
