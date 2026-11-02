"""Pack one real Video -> 3D run for the try-it demo's replay (shell/scripts/api.js answers Rebuild with it).

  python3 tools/tryit/pack_v2s.py <devrun clip folder> --clip jturn_night_street.mp4 --glb <the run's set GLB>

Reads <folder>/recon_result.json (the route's result) and <folder>/run.log (the measured step times), writes
<media>/r/canned/v2s_run.json and the set GLB as <media>/r/<name>.glb.b64.txt (the host serves web types only).
The result is shipped as the server returned it, except that file URLs point at the shipped copies.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MEDIA = os.path.join(os.path.expanduser("~"), "OpenHiggsfieldContest", "tryit_media")


def steps_from_log(text: str, total_s: float) -> list[dict]:
    """'[16:47:17] 0.08 Measuring depth' lines -> [{name, s}] with each step's measured seconds."""
    rows = []
    for m in re.finditer(r"^\[(\d+):(\d+):(\d+)\]\s+[\d.]+\s+(.+)$", text, re.M):
        h, mi, se, name = int(m[1]), int(m[2]), int(m[3]), m[4].strip()
        rows.append((h * 3600 + mi * 60 + se, name))
    out = []
    for (t, name), nxt in zip(rows, rows[1:] + [(None, None)]):
        if name.lower() == "done":
            continue
        s = (nxt[0] - t) if nxt[0] is not None else 1.0
        out.append({"name": name, "s": max(1.0, float(s % 86400))})
    if out and total_s:
        k = total_s / sum(x["s"] for x in out)
        for x in out:
            x["s"] = round(x["s"] * k, 1)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", help="devrun clip folder (recon_result.json, run.log)")
    ap.add_argument("--clip", required=True, help="the demo clip's file name (the replay answers only this clip)")
    ap.add_argument("--glb", default="", help="the run's set GLB, copied from the pod's output folder")
    ap.add_argument("--plate", default="", help="the run's first sample frame (f_00.png), the plate behind an unscanned set")
    ap.add_argument("--media", default=DEFAULT_MEDIA)
    a = ap.parse_args(argv)
    res = json.load(open(os.path.join(a.run, "recon_result.json")))
    total = float(res.get("timings", {}).get("total_ms", 0)) / 1000
    steps = steps_from_log(open(os.path.join(a.run, "run.log")).read(), total)
    scene = res["scene"]
    for act in scene.get("actors", []):
        u = act.get("url") or ""
        m = re.search(r"filename=([^&]+)", u)
        if act.get("kind") == "glb" and m:
            act["url"] = f"/view?filename={m[1]}&type=output"   # api.js maps /view?filename=X to r/X
    scene.pop("_bench", None)
    ref = scene.get("reference") or {}
    for k in ("source",):
        if isinstance(ref.get(k), dict):
            ref[k].pop("path", None)   # the pod's own path: not the visitor's business
    out = {"clip": a.clip, "secs": (ref.get("duration") or 5.0), "samples": len(ref.get("samples") or []) or 16,
           "total_s": round(total, 1), "steps": steps,
           "result": {"scene": scene, "notes": res.get("notes", []), "summary": res.get("summary", {})}}
    dst = os.path.join(a.media, "r", "canned", "v2s_run.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump(out, open(dst, "w"))
    print("wrote", dst, f"{len(steps)} steps, {total:.0f} s")
    if a.glb:
        name = os.path.basename(a.glb)
        g = os.path.join(a.media, "r", name + ".b64.txt")
        open(g, "w").write(base64.b64encode(open(a.glb, "rb").read()).decode())
        print("wrote", g)
    # Motion-capture takes the scene points at (the App loads them by file name).
    import glob
    for t in glob.glob(os.path.join(a.run, "takes", "**", "*.json"), recursive=True):
        tdst = os.path.join(a.media, "r", os.path.basename(t))
        open(tdst, "w").write(open(t).read())
        print("wrote", tdst)
    if a.plate:
        import subprocess
        s0 = ((ref.get("samples") or [{}])[0].get("filename") or "f_00.png")
        p = os.path.join(a.media, "r", re.sub(r"\.png$", ".jpg", s0, flags=re.I))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.plate, "-q:v", "4", p], check=True)
        print("wrote", p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
