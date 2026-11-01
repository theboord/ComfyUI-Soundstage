#!/usr/bin/env python3
"""Serve the repo for render_clay.html and save the PNGs it posts into out/frames_clay/.

  python3 tools/physbench/render_clay_server.py [port]      (default 8765, localhost only)
  then open http://localhost:8765/tools/physbench/render_clay.html?runs=out/ss_after.json,out/bl_default.json
  in any WebGL browser; it prints DONE when every frame is saved.
"""
import http.server, os, sys, urllib.parse

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, "..", ".."))
dest = os.path.join(here, "out", "frames_clay")


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=root, **k)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        name = urllib.parse.parse_qs(u.query).get("name", [""])[0]
        path = os.path.abspath(os.path.join(dest, name))
        if u.path != "/save" or not name.endswith(".png") or not path.startswith(dest + os.sep):
            self.send_error(400); return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200); self.end_headers()

    def log_message(self, *a):
        pass


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f"serving {root} on http://localhost:{port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
