#!/usr/bin/env python3
"""Serve Harbour locally so the browser can fetch the bundled Access database."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765


class LocalHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[harbour] " + fmt % args)


if __name__ == "__main__":
    print(f"Harbour is running at http://127.0.0.1:{PORT}")
    print("Keep this window open while using the app. Press Ctrl+C to stop.")
    ThreadingHTTPServer(("127.0.0.1", PORT), LocalHandler).serve_forever()
