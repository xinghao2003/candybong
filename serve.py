# Minimal dev server for the Candybong web app. Plain `python -m http.server`
# sends no cache headers, so browsers can serve stale ES modules without
# revalidation after an edit — which surfaces as confusing runtime errors like
# "The requested module ... does not provide an export named ...". This server
# sends Cache-Control: no-cache so every module is revalidated on reload.
#
# Usage (from the repository root): python serve.py [port]

import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        print(f"Serving {WEB_DIR} at http://127.0.0.1:{PORT}/")
        httpd.serve_forever()
