"""Clip probing, decoding and sampling with ffmpeg (CPU only, no ComfyUI imports).

Every source frame in the trim is decoded ONCE at proxy size (<= 768 wide) and mapped onto the stage's 24 fps
timeline: all_frames[f] is the source picture at time start + f / 24 (nearest source frame). A 24 fps clip of 121
frames gives 121 stage frames; a 30 fps clip of 5 s gives floor(5 * 24) + 1 = 121.
"""
from __future__ import annotations

import glob
import json
import math
import os
import subprocess

import numpy as np

FPS = 24
MAX_FRAMES = 2400          # 100 s at 24 fps: the rebuild's cap (noted when a clip is longer)
PROXY_W = 768


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


def proxy_size(w: int, h: int, max_w: int = PROXY_W) -> tuple[int, int]:
    pw = min(max_w, w)
    pw -= pw % 2
    ph = int(round(h * pw / w))
    ph -= ph % 2
    return pw, ph


def stage_frames(n_src: int, fps: float, cap: int = MAX_FRAMES) -> tuple[int, int]:
    """(stage frames, uncapped stage frames) for n_src source frames at fps: floor(span * 24) + 1, end inclusive."""
    if n_src <= 0:
        return 0, 0
    span = (n_src - 1) / max(fps, 1e-6)
    full = int(math.floor(span * FPS + 1e-6)) + 1
    return min(full, cap), full


def source_index(f: int, fps: float, n_src: int) -> int:
    """The source frame (0-based within the trim) the stage shows at stage frame f."""
    return int(min(n_src - 1, max(0, round(f / FPS * fps))))


def trim_window(clip: dict, trim) -> tuple[float, float]:
    """[in, out] seconds from the route (None / bad values = the whole clip)."""
    dur = float(clip.get("duration") or 0)
    try:
        a, b = (float(trim[0]), float(trim[1])) if trim else (0.0, dur)
    except (TypeError, ValueError, IndexError):
        a, b = 0.0, dur
    a = min(max(0.0, a), dur)
    b = min(max(a, b if b > 0 else dur), dur)
    if b - a < 2.0 / max(clip.get("fps") or 24, 1):
        a, b = 0.0, dur
    return round(a, 4), round(b, 4)


def decode_all(path: str, out_dir: str, clip: dict, trim=None, max_w: int = PROXY_W, cap: int = MAX_FRAMES) -> dict:
    """Decode every source frame in the trim once (PNG, proxy size), then map them onto the 24 fps timeline.

    Returns {all_frames: [png per stage frame], src_files, pw, ph, start, end, frames, src_frames, fps, cap_note}."""
    os.makedirs(out_dir, exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "s_*.png")):
        os.remove(f)
    start, end = trim_window(clip, trim)
    fps = float(clip.get("fps") or 24.0)
    pw, ph = proxy_size(int(clip["width"]), int(clip["height"]), max_w)
    # cap the decode itself (a long clip at 60 fps would otherwise write thousands of PNGs we never use)
    max_src = int(math.ceil((cap - 1) / FPS * fps)) + 2
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if start > 0:
        cmd += ["-ss", f"{start:.4f}"]
    cmd += ["-i", path, "-t", f"{max(0.01, end - start + 0.5 / fps):.4f}", "-frames:v", str(max_src),
            "-vf", f"scale={pw}:{ph}:flags=area", "-fps_mode", "passthrough", "-start_number", "0",
            os.path.join(out_dir, "s_%05d.png")]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    src = sorted(glob.glob(os.path.join(out_dir, "s_*.png")))
    if r.returncode != 0 and not src:
        raise RuntimeError(f"ffmpeg could not decode the clip ({r.stderr.strip()[:200]})")
    if not src:
        raise RuntimeError("the clip decoded to no frames")
    n, full = stage_frames(len(src), fps, cap)
    files = [src[source_index(f, fps, len(src))] for f in range(n)]
    cap_note = (f"the clip is {full} frames at 24 fps; rebuilt the first {n} ({n / FPS:.0f} s cap)"
                if full > n else "")
    return {"all_frames": files, "src_files": src, "pw": pw, "ph": ph, "start": start, "end": end, "frames": n,
            "src_frames": len(src), "fps": fps, "cap_note": cap_note}


# ------------------------------------------------------------------------------------------------ sampling
QUALITY = {"fast": 16, "standard": 32, "max": 64}


def auto_samples(duration: float, motion_px: float | None = None) -> int:
    """clamp(dur * 8, 24, 64), raised on fast moves (median image motion per frame > 6 px at proxy size)."""
    n = duration * 8.0
    if motion_px is not None and motion_px > 6:
        n *= min(2.0, motion_px / 6.0)
    return int(min(64, max(24, round(n))))


def pick_samples(n_frames: int, count: int, motion: np.ndarray | None = None) -> list[int]:
    """`count` stage frames for DA3, spread by accumulated image motion (more samples where the camera moves fast),
    always including the first and last frame."""
    count = int(max(2, min(count, n_frames)))
    if n_frames <= count:
        return list(range(n_frames))
    if motion is None or len(motion) != n_frames - 1 or not np.isfinite(motion).all() or motion.sum() <= 0:
        return sorted(set(int(round(i * (n_frames - 1) / (count - 1))) for i in range(count)))
    # half the samples evenly in time, half evenly in accumulated motion
    m = np.concatenate([[0.0], np.cumsum(np.maximum(motion, 0) + 1e-3)])
    m = m / m[-1]
    t = np.linspace(0, 1, n_frames)
    w = 0.5 * m + 0.5 * t
    want = np.linspace(0, 1, count)
    out = sorted(set(int(np.argmin(np.abs(w - x))) for x in want))
    k = 0
    while len(out) < count and k < n_frames:   # fill gaps left by rounding onto the same frame
        gaps = np.diff(out)
        i = int(np.argmax(gaps))
        mid = (out[i] + out[i + 1]) // 2
        if mid not in out:
            out = sorted(out + [mid])
        k += 1
    return out


def batches(items: list, size: int = 16) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


# ------------------------------------------------------------------------------------------------ legacy
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
            cmd = ["ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", path, "-update", "1",
                   "-vf", f"scale='min({max_w},iw)':-2", f]
            subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if not os.path.exists(f):
            raise RuntimeError(f"ffmpeg could not read the frame at {t:.2f} s")
        files.append(f)
    return files
