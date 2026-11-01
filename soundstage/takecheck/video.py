"""Read a take's frames with ffmpeg (no ComfyUI, no torch): small grey frames for the fast checks, colour frames
for the face and car checks."""
from __future__ import annotations

import json
import shutil
import subprocess

import numpy as np


def _exe(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} is not installed (the take checks need ffmpeg and ffprobe)")
    return path


def probe(path: str) -> dict:
    """{width, height, fps, frames, duration, tags} of the first video stream."""
    out = subprocess.run([_exe("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration:format_tags",
                          "-of", "json", path], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe could not read {path}: {out.stderr.strip()[:200]}")
    d = json.loads(out.stdout or "{}")
    st = (d.get("streams") or [{}])[0]
    fmt = d.get("format") or {}

    def rate(s):
        try:
            a, b = str(s).split("/")
            return float(a) / float(b) if float(b) else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0
    fps = rate(st.get("r_frame_rate")) or rate(st.get("avg_frame_rate")) or 24.0
    dur = float(st.get("duration") or fmt.get("duration") or 0)
    n = int(st.get("nb_frames") or 0) or int(round(dur * fps))
    return {"width": int(st.get("width") or 0), "height": int(st.get("height") or 0), "fps": fps, "frames": n,
            "duration": dur, "tags": fmt.get("tags") or {}}


def read_frames(path: str, width: int = 256, gray: bool = True, every: int = 1, info: dict | None = None) -> np.ndarray:
    """All frames (or every Nth) scaled to `width` px: [N,H,W] uint8 when gray, else [N,H,W,3] RGB uint8."""
    info = info or probe(path)
    w0, h0 = info["width"], info["height"]
    if not w0 or not h0:
        raise RuntimeError("no video stream")
    width = int(min(width, w0)) // 2 * 2
    height = max(2, int(round(h0 * width / w0 / 2)) * 2)
    vf = f"scale={width}:{height}:flags=area"
    if every > 1:
        vf = f"select='not(mod(n\\,{int(every)}))',{vf}"
    pix, ch = ("gray", 1) if gray else ("rgb24", 3)
    base = [_exe("ffmpeg"), "-v", "error", "-i", path, "-an", "-vf", vf]
    tail = ["-f", "rawvideo", "-pix_fmt", pix, "-"]
    # Every Nth frame: no duplicated frames to fill the gaps (-fps_mode on ffmpeg 5.1+, -vsync before).
    opts = [["-fps_mode", "passthrough"], ["-vsync", "0"]] if every > 1 else [[]]
    for o in opts:
        out = subprocess.run(base + o + tail, capture_output=True, timeout=300)
        if out.returncode == 0 or out.stdout:
            break
    if out.returncode != 0 and not out.stdout:
        raise RuntimeError(f"ffmpeg could not decode {path}: {out.stderr.decode(errors='ignore').strip()[:200]}")
    size = width * height * ch
    n = len(out.stdout) // size
    arr = np.frombuffer(out.stdout[: n * size], dtype=np.uint8)
    return arr.reshape((n, height, width) if gray else (n, height, width, 3))
