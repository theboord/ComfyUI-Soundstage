"""Run today's Video -> Stage pipeline on one clip, the way the App does it (stdlib only).

  python3 tools/v2s_bench/pod.py <clip.mp4> <out_dir> [--name v2sbench_x.mp4] [--server http://127.0.0.1:8189]

1. POST /upload/image (type=input, the input root: Video -> Stage and LoadVideo read the root only);
2. POST /soundstage/video2stage {video};
3. poll /soundstage/video2stage/job until done (the job runs its GPU steps as ordinary queued prompts, so it waits its
   turn behind other people's work and never touches their queue items);
4. save the result to <out_dir>/recon_result.json and each mocap take the scene names to <out_dir>/takes/.

It never queues anything else, never cancels or reorders, and only reads /view for its own outputs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid


def _req(url: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 120.0):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def upload(server: str, path: str, name: str) -> str:
    """Multipart upload to the input root (overwrite). Returns the server-side name."""
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        blob = f.read()
    parts = []
    for k, v in (("type", "input"), ("overwrite", "true")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
                 f'Content-Type: video/mp4\r\n\r\n'.encode() + blob + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    st, body = _req(f"{server}/upload/image", b"".join(parts),
                    {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=600)
    if st != 200:
        raise RuntimeError(f"upload failed ({st}): {body[:200]!r}")
    j = json.loads(body)
    return (j.get("subfolder") + "/" if j.get("subfolder") else "") + j["name"]


def run(server: str, video: str, log=print, timeout_s: float = 3600.0, body: dict | None = None) -> dict:
    payload = {"video": video, **(body or {})}
    st, b = _req(f"{server}/soundstage/video2stage", json.dumps(payload).encode(), {"Content-Type": "application/json"})
    job = json.loads(b).get("job")
    if not job:
        raise RuntimeError(f"video2stage refused: {b[:300]!r}")
    log(f"  job {job}")
    t0, last, misses = time.time(), "", 0
    while time.time() - t0 < timeout_s:
        time.sleep(3.0)
        try:
            st, b = _req(f"{server}/soundstage/video2stage/job?id={job}", timeout=60)
            s = json.loads(b)
            misses = 0
        except Exception as exc:  # noqa: BLE001 - a busy server answers late; keep waiting
            misses += 1
            if misses > 60:
                raise RuntimeError(f"lost the server for 3 min ({exc})") from exc
            continue
        if s.get("error") == "no such job":
            raise RuntimeError("the server forgot the job (ComfyUI restarted?)")
        step = f"{s.get('step')} {s.get('progress')}"
        if step != last:
            log(f"  [{time.time() - t0:5.0f}s] {s.get('state')}: {step}")
            last = step
        if s.get("state") == "error":
            raise RuntimeError(s.get("error"))
        if s.get("state") == "done":
            res = s["result"]
            res["_bench"] = {"job": job, "wall_s": round(time.time() - t0, 1), "server": server, "video": video,
                             "when": time.strftime("%Y-%m-%d %H:%M:%S")}
            return res
    raise TimeoutError(f"job {job} not done after {timeout_s:.0f} s")


def fetch_takes(server: str, result: dict, out_dir: str) -> list[str]:
    """Save every mocap take the scene names (soundstage/mocap/<name>.json in the output folder)."""
    got = []
    for a in (result.get("scene") or {}).get("actors") or []:
        f = (a.get("mocap") or {}).get("file")
        if not f:
            continue
        i = f.rfind("/")
        q = urllib.parse.urlencode({"filename": f[i + 1:], "subfolder": f[:i] if i > 0 else "", "type": "output"})
        st, b = _req(f"{server}/view?{q}", timeout=300)
        dst = os.path.join(out_dir, "takes", f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as fh:
            fh.write(b)
        got.append(f)
    return got


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip")
    ap.add_argument("out_dir")
    ap.add_argument("--name", default=None, help="server-side file name (default v2sbench_<basename>)")
    ap.add_argument("--server", default=os.environ.get("SS_URL", "http://127.0.0.1:8189"))
    a = ap.parse_args(argv)
    os.makedirs(a.out_dir, exist_ok=True)
    name = a.name or "v2sbench_" + os.path.basename(a.clip)
    print(f"upload {a.clip} -> input/{name}")
    video = upload(a.server, a.clip, name)
    res = run(a.server, video)
    takes = fetch_takes(a.server, res, a.out_dir)
    res["_bench"]["takes"] = takes
    with open(os.path.join(a.out_dir, "recon_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    print(f"done in {res['_bench']['wall_s']} s: {res.get('summary')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
