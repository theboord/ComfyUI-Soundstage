"""Clip probing and frame sampling with ffmpeg (CPU only, no ComfyUI imports)."""
from __future__ import annotations

import json
import os
import subprocess


def probe(path: str) -> dict:
    """{width, height, fps, duration, frames} of the first video stream."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration",
                          "-of", "json", path], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise ValueError(f"not a readable video ({out.stderr.strip()[:200]})")
    j = json.loads(out.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    if not st.get("width"):
        raise ValueError("the file has no video stream")

    def rate(s):
        try:
            a, b = str(s).split("/")
            return float(a) / float(b) if float(b) else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0
    fps = rate(st.get("avg_frame_rate")) or rate(st.get("r_frame_rate")) or 24.0
    dur = float(st.get("duration") or (j.get("format") or {}).get("duration") or 0)
    n = int(st.get("nb_frames") or 0) or int(round(dur * fps))
    if not dur and n:
        dur = n / fps
    return {"width": int(st["width"]), "height": int(st["height"]), "fps": round(fps, 3), "duration": round(dur, 3),
            "frames": n}


def sample_times(duration: float, fps: float, n: int) -> list[float]:
    """n times from the first to the last frame, evenly spaced (n >= 2)."""
    last = max(0.0, duration - 1.0 / max(fps, 1.0))
    n = max(2, int(n))
    return [round(last * i / (n - 1), 4) for i in range(n)]


def extract(path: str, out_dir: str, times: list[float], max_w: int = 768) -> list[str]:
    """One PNG per time, at most max_w wide (even sizes). Returns the file paths."""
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i, t in enumerate(times):
        f = os.path.join(out_dir, f"f_{i:02d}.png")
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.4f}", "-i", path, "-frames:v", "1",
               "-vf", f"scale='min({max_w},iw)':-2", f]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(f):
            # Seeking past the last decodable frame: take the final frame instead.
            cmd = ["ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", path, "-update", "1",
                   "-vf", f"scale='min({max_w},iw)':-2", f]
            subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if not os.path.exists(f):
            raise RuntimeError(f"ffmpeg could not read the frame at {t:.2f} s")
        files.append(f)
    return files
