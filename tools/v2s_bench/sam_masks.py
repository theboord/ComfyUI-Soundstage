"""SAM 3.1 masks of the source, for clips whose truth is not pixel-exact (stdlib only).

  python3 tools/v2s_bench/sam_masks.py <clip_dir> --prompts car,person [--server http://127.0.0.1:8189]

A stage clip that a video model re-rendered (st_jturn, st_chase) has a known stage scene, but the video model only
follows it as closely as its adherence: the car in the video is not exactly where the stage's ID pass puts it. For
those clips the silhouettes come from the source itself: SAM 3.1 (checkpoints/sam3.1_multiplex_fp16.safetensors,
already on the pod) tracks every instance of each text prompt through the clip, and metrics.py gives each track to
the true object it overlaps most.

The graph is ONE ordinary queued prompt (LoadVideo -> GetVideoComponents -> resize -> CheckpointLoaderSimple(sam3.1)
-> CLIPTextEncode + SAM3_VideoTrack per prompt -> SAM3_TrackToMask per track -> MaskToImage -> SaveImage). It waits its
turn behind everyone else's work; nothing is cancelled or reordered. Out-of-range track indices come back empty and
are empty (metrics.py ignores empty tracks). Writes <clip_dir>/sam/<prompt>_w<start>_<k>/NNNN.png (NNNN = the clip's
frame; white = the object) and <clip_dir>/sam/sam.json.
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

SAM_CKPT = "sam3.1_multiplex_fp16.safetensors"
MAX_TRACKS = 6


def _req(url, data=None, headers=None, timeout=120.0):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def graph(video: str, prompts: list[str], tag: str, n_frames: int, window: int = 40, shorter: int = 544,
          threshold: float = 0.4) -> tuple[dict, dict]:
    """(API prompt, {SaveImage node id: "<prompt>_w<start>_<k>"}). The clip is tracked in windows of `window` frames:
    on ComfyUI v0.43.0 SAM3_VideoTrack returned masks for only the first 96 of 120 frames (st_jturn), so a long
    clip is split and each window's tracks are matched to the truth on their own."""
    g: dict = {}
    keys: dict = {}

    def node(cls, **inputs):
        nid = str(len(g) + 1)
        g[nid] = {"class_type": cls, "inputs": inputs}
        return nid

    v = node("LoadVideo", file=video)
    comp = node("GetVideoComponents", video=[v, 0])
    img = node("ResizeImageMaskNode", input=[comp, 0], scale_method="area", resize_type="scale shorter dimension",
               **{"resize_type.shorter_size": int(shorter)})
    ck = node("CheckpointLoaderSimple", ckpt_name=SAM_CKPT)
    for p in prompts:
        cond = node("CLIPTextEncode", text=p, clip=[ck, 1])
        for start in range(0, n_frames, window):
            win = node("ImageFromBatch", image=[img, 0], batch_index=start, length=min(window, n_frames - start))
            tr = node("SAM3_VideoTrack", images=[win, 0], model=[ck, 0], detection_threshold=float(threshold),
                      max_objects=MAX_TRACKS, detect_interval=1, conditioning=[cond, 0])
            for k in range(MAX_TRACKS):
                m = node("SAM3_TrackToMask", track_data=[tr, 0], object_indices=str(k))
                im = node("MaskToImage", mask=[m, 0])
                key = f"{p.replace(' ', '-')}_w{start:04d}_{k}"
                keys[node("SaveImage", images=[im, 0], filename_prefix=f"v2sbench_sam/{tag}_{key}")] = key
    return g, keys


def run(server: str, video: str, prompts: list[str], out_dir: str, tag: str, n_frames: int, log=print,
        timeout_s: float = 3600.0) -> dict:
    g, keys = graph(video, prompts, tag, n_frames)
    body = json.dumps({"prompt": g, "client_id": "v2sbench-" + uuid.uuid4().hex[:8]}).encode()
    pid = json.loads(_req(f"{server}/prompt", body, {"Content-Type": "application/json"}))["prompt_id"]
    log(f"  SAM 3.1 prompt {pid} queued ({len(prompts)} prompts x {MAX_TRACKS} tracks)")
    t0 = time.time()
    hist = None
    while time.time() - t0 < timeout_s:
        time.sleep(4.0)
        try:
            h = json.loads(_req(f"{server}/history/{pid}", timeout=60))
        except Exception:  # noqa: BLE001 - a busy server answers late
            continue
        if pid in h:
            hist = h[pid]
            st = (hist.get("status") or {}).get("status_str")
            if st == "error":
                msgs = [m for m in (hist.get("status") or {}).get("messages") or [] if m[0] == "execution_error"]
                raise RuntimeError(f"SAM 3.1 graph failed: {json.dumps(msgs)[:800]}")
            if (hist.get("status") or {}).get("completed"):
                break
    if not hist:
        raise TimeoutError(f"SAM 3.1 prompt {pid} not done after {timeout_s:.0f} s")
    log(f"  done in {time.time() - t0:.0f} s; fetching masks")
    saved = {}
    for nid, o in (hist.get("outputs") or {}).items():
        if nid in keys:
            saved[keys[nid]] = list(o.get("images") or [])
    os.makedirs(out_dir, exist_ok=True)
    tracks = {}
    for key, ims in sorted(saved.items()):
        ims.sort(key=lambda m: m["filename"])
        d = os.path.join(out_dir, key)
        os.makedirs(d, exist_ok=True)
        start = int(key.rsplit("_w", 1)[1].split("_")[0])
        for i, im in enumerate(ims):
            f = start + i
            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
            blob = _req(f"{server}/view?{q}", timeout=120)
            with open(os.path.join(d, f"{f:04d}.png"), "wb") as fh:
                fh.write(blob)
        tracks[key] = {"prompt": key.rsplit("_w", 1)[0].replace("-", " "), "first_frame": start, "frames": len(ims)}
    info = {"model": SAM_CKPT, "prompt_id": pid, "prompts": prompts, "tracks": tracks, "video": video,
            "when": time.strftime("%Y-%m-%d %H:%M:%S"), "wall_s": round(time.time() - t0, 1)}
    with open(os.path.join(out_dir, "sam.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    log(f"  {len(tracks)} SAM 3.1 tracks: {', '.join(tracks)}")
    return info


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip_dir")
    ap.add_argument("--prompts", default="car")
    ap.add_argument("--video", default=None, help="file in the server's input folder (default v2sbench_<clip>.mp4)")
    ap.add_argument("--server", default=os.environ.get("SS_URL", "http://127.0.0.1:8189"))
    a = ap.parse_args(argv)
    clip = os.path.basename(a.clip_dir.rstrip("/"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import imgio
    n = imgio.probe(os.path.join(a.clip_dir, "source.mp4"))[2]
    run(a.server, a.video or f"v2sbench_{clip}.mp4", [p.strip() for p in a.prompts.split(",") if p.strip()],
        os.path.join(a.clip_dir, "sam"), clip, n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
