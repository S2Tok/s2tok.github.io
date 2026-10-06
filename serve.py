#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Local preview server for the research website template.

Serves the repository root over HTTP with no build step and no caching, so a
browser refresh always shows your latest edit. Binds 0.0.0.0, so the preview is
reachable on every interface (localhost, LAN, Tailscale, ...).

    uv run serve.py            # serve on 0.0.0.0:8888
    uv run serve.py --port N   # override the port
    python3 serve.py           # (works too — no third-party deps)

The site is fully static; just refresh the browser after editing files.
"""

import argparse
import functools
import http.server
import os
import socket

DEFAULT_PORT = 8888
HOST = "0.0.0.0"
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler rooted at the repo, with no-cache so edits show on reload."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".woff2": "font/woff2",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("  %s - %s" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to bind (default {DEFAULT_PORT})")
    args = parser.parse_args()

    handler = functools.partial(Handler, directory=ROOT)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer((HOST, args.port), handler) as httpd:
        print(f"Research website template serving on {HOST}:{args.port} (root: {ROOT})")
        print(f"  local:      http://127.0.0.1:{args.port}/")
        print(f"  components:  http://127.0.0.1:{args.port}/components.html")
        print(f"  network:     http://{socket.gethostname()}:{args.port}/")
        print("  press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
