"""Fix a visible loop seam, in this order, reporting the seam before and after each try (never a crossfade):

  1. trim    cut the clip to the frame pair (start s, end e) whose wrap step e -> s looks most like an ordinary
             in-clip step (CPU, seconds). Keeps at least MIN_KEEP of the clip.
  2. bridge  render a short LTX bridge from the clip's last frame to its first (loop/graphs.build with two pictures)
             and append it: the wrap then happens inside a real render (GPU, about a minute).
  3. reseed  render the loop again with another seed (GPU).

Pure helpers + ffmpeg (no ComfyUI imports): tests/test_loop_fix.py.
"""
from __future__ import annotations

import os
import shutil
import subprocess

import numpy as np

from . import seam as S

MIN_KEEP = 0.6           # a trim keeps at least 60% of the clip
HEAD = 0.2               # the new start is in the first 20% ...
TAIL = 0.6               # ... and the new end in the last 40%
BRIDGE_SECONDS = 1.0
ORDER = ("trim", "bridge", "reseed")


def _ff() -> str:
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("ffmpeg is not installed")
    return ff


def best_pair(frames, *, drop_duplicate: bool = True) -> dict:
    """The (start, end) frame pair with the least visible wrap: frame `start` most like the frame after `end`. Cost =
    that pixel and edge difference over the clip's median step (0 = the clip naturally continues into its start).
    frames: [N,H,W(,3)]."""
    fr = S.prepare(frames)
    n = len(fr)
    if n < 8:
        raise ValueError("too short to trim")
    pix = [float(np.abs(fr[i] - fr[i + 1]).mean()) for i in range(n - 1)]
    med_pix = max(float(np.median(pix)), 0.002)
    last = n - 2 if drop_duplicate and S.is_duplicate(fr[0], fr[-1], med_pix) else n - 1
    edges = [S.sobel(f) for f in fr]
    med_edge = max(float(np.median([1 - S.ssim(edges[i], edges[i + 1]) for i in range(0, n - 1, max(1, n // 24))])), 0.002)
    best = None
    s_max = int(n * HEAD)
    # The wrap e -> s reads as an ordinary step when frame s looks like the frame that would have come after e.
    for s in range(0, s_max + 1):
        for e in range(max(int(n * TAIL), s + int(n * MIN_KEEP)), last):
            p = float(np.abs(fr[e + 1] - fr[s]).mean()) / med_pix
            if best is not None and p > best["cost"]:
                continue          # the edge term only adds: no need to compute it
            c = max(p, (1 - S.ssim(edges[e + 1], edges[s])) / med_edge)
            if best is None or c < best["cost"]:
                best = {"start": s, "end": e, "cost": round(c, 3)}
    best["frames"] = n
    best["kept"] = best["end"] - best["start"] + 1
    return best


def clean_end(frames, played: int | None = None, tail: int = 16, jump: float = 4.0) -> int:
    """The last frame before a snap in the tail. An end guide can pull the last latent block onto the target picture
    in one jump (seen on the first loop render: one step 10x the median, 3 frames from the end). A bridge must start
    before that snap, or it carries it. Returns the index of the last clean frame."""
    fr = S.prepare(frames)
    n = len(fr) if played is None else int(played)
    pix = np.array([float(np.abs(fr[i] - fr[i + 1]).mean()) for i in range(n - 1)])
    med = max(float(np.median(pix)), 0.0015)
    for i in range(n - 2, max(0, n - 1 - tail) - 1, -1):
        if pix[i] > jump * med:
            return i
    return n - 1


def _run(cmd: list[str], timeout: int = 600):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "ffmpeg failed")


def trim(src: str, dst: str, start: int, end: int, fps: float) -> str:
    """Frames start..end (inclusive) of src, with the sound cut to the same span. H.264 CRF 14, tags kept."""
    t0, t1 = start / fps, (end + 1) / fps
    vf = f"trim=start_frame={int(start)}:end_frame={int(end) + 1},setpts=PTS-STARTPTS"
    af = f"atrim=start={t0:.6f}:end={t1:.6f},asetpts=PTS-STARTPTS"
    has_audio = _has_audio(src)
    cmd = [_ff(), "-v", "error", "-y", "-i", src, "-map_metadata", "0", "-filter_complex",
           f"[0:v]{vf}[v]" + (f";[0:a]{af}[a]" if has_audio else ""), "-map", "[v]"]
    if has_audio:
        cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-movflags", "use_metadata_tags+faststart", dst]
    _run(cmd)
    return dst


def join(clip: str, bridge: str, dst: str, clip_end: int, fps: float) -> str:
    """clip frames 0..clip_end, then the bridge without its first frame (= the clip's last) and without its last
    (= the clip's first, which the wrap shows next). Sound follows the pictures. No dissolve anywhere."""
    nb = _frames(bridge, fps)
    if nb < 3:
        raise ValueError("the bridge is too short")
    a_ok = _has_audio(clip) and _has_audio(bridge)
    ci = _probe(clip)
    v = (f"[0:v]trim=start_frame=0:end_frame={clip_end + 1},setpts=PTS-STARTPTS,setsar=1[v0];"
         f"[1:v]trim=start_frame=1:end_frame={nb - 1},setpts=PTS-STARTPTS,"
         f"scale={ci['width']}:{ci['height']}:flags=lanczos,setsar=1[v1];")
    if a_ok:
        a = (f"[0:a]atrim=start=0:end={(clip_end + 1) / fps:.6f},asetpts=PTS-STARTPTS[a0];"
             f"[1:a]atrim=start={1 / fps:.6f}:end={(nb - 1) / fps:.6f},asetpts=PTS-STARTPTS[a1];"
             "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    else:
        a = "[v0][v1]concat=n=2:v=1:a=0[v]"
        maps = ["-map", "[v]"]
    _run([_ff(), "-v", "error", "-y", "-i", clip, "-i", bridge, "-map_metadata", "0", "-filter_complex", v + a, *maps,
          "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p",
          "-movflags", "use_metadata_tags+faststart", dst])
    return dst


def frame_png(src: str, index: int, dst: str) -> str:
    """One frame as a PNG (the bridge's two pictures)."""
    _run([_ff(), "-v", "error", "-y", "-i", src, "-vf", f"select=eq(n\\,{int(index)})", "-frames:v", "1", dst])
    if not os.path.isfile(dst):
        raise RuntimeError(f"frame {index} not found")
    return dst


def _probe(path: str) -> dict:
    from ..takecheck import video as V
    return V.probe(path)


def _frames(path: str, fps: float) -> int:
    return int(_probe(path)["frames"])


def _has_audio(path: str) -> bool:
    fp = shutil.which("ffprobe")
    if not fp:
        return False
    r = subprocess.run([fp, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=60)
    return bool(r.stdout.strip())


def summary(before: dict, after: dict | None, how: str) -> dict:
    """What the App shows: before -> after, plain words."""
    out = {"how": how, "before": before.get("badge"), "before_seam": before.get("seam")}
    if after:
        out.update(after=after.get("badge"), after_seam=after.get("seam"), fixed=after.get("verdict") == "seamless")
    return out


def next_step(tried: list[str]) -> str | None:
    """The next fix to try after `tried` (trim -> bridge -> reseed), or None when all were tried."""
    for k in ORDER:
        if k not in tried:
            return k
    return None
