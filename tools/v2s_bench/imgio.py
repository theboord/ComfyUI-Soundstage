"""Image I/O for the bench with numpy only: PIL when it is installed, otherwise ffmpeg pipes (Blender's bundled Python on
the Mac mini has numpy but no PIL). Images are uint8 arrays, H x W x C."""
from __future__ import annotations

import glob
import os
import subprocess

import numpy as np

try:  # pragma: no cover - depends on the machine
    from PIL import Image
except Exception:  # noqa: BLE001
    Image = None

FFMPEG = os.environ.get("FFMPEG") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg")
                                           if os.path.exists(p)), "ffmpeg")
FFPROBE = FFMPEG.replace("ffmpeg", "ffprobe")


def probe(path: str) -> tuple[int, int, int]:
    """(width, height, frames) of a video or image."""
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=width,height,nb_read_packets", "-of", "csv=p=0", path], capture_output=True, text=True)
    w, h, n = (out.stdout.strip().split(",") + ["0", "0", "0"])[:3]
    return int(w), int(h), int(n or 0)


def read(path: str, channels: int = 3) -> np.ndarray:
    if Image is not None:
        im = Image.open(path).convert("RGBA" if channels == 4 else "RGB")
        return np.asarray(im)
    w, h, _ = probe(path)
    fmt = "rgba" if channels == 4 else "rgb24"
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", fmt, "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, channels)


def write(path: str, img: np.ndarray, quality: int = 88) -> None:
    img = np.ascontiguousarray(img.astype(np.uint8))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if Image is not None:
        im = Image.fromarray(img)
        if path.lower().endswith((".jpg", ".jpeg")):
            im.convert("RGB").save(path, quality=quality)
        else:
            im.save(path)
        return
    h, w = img.shape[:2]
    fmt = {3: "rgb24", 4: "rgba"}[img.shape[2]]
    q = ["-q:v", str(max(2, min(31, int(round((100 - quality) / 3)))))] if path.lower().endswith((".jpg", ".jpeg")) else []
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{w}x{h}", "-i", "-", *q, path],
                   input=img.tobytes(), check=True)


def video_frames(path: str, frames: list[int], width: int | None = None) -> dict[int, np.ndarray]:
    """The listed frames (0-based) of a video as RGB, scaled to `width` (aspect kept) when given."""
    want = sorted(set(int(f) for f in frames))
    if not want:
        return {}
    w0, h0, _ = probe(path)
    if width:
        h = int(round(h0 * width / w0))
        w = width
    else:
        w, h = w0, h0
    sel = "+".join(f"eq(n\\,{f})" for f in want)
    vf = f"select='{sel}'" + (f",scale={w}:{h}:flags=area" if width else "")
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    arr = np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)
    return {f: arr[i] for i, f in enumerate(want[:n])}


def listing(directory: str) -> dict[int, str]:
    """frame number -> file for NNNN.png / NNNN.jpg files in a directory."""
    out = {}
    for p in glob.glob(os.path.join(directory, "*")):
        stem = os.path.splitext(os.path.basename(p))[0]
        if stem.isdigit():
            out[int(stem)] = p
    return out


def fit_width(img: np.ndarray, W: int, H: int, nearest: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Place an image into a W x H frame the way the stage frames a clip of another aspect: same horizontal extent
    (the stage keeps the horizontal field of view), centred vertically. Returns (image, valid mask)."""
    h0, w0 = img.shape[:2]
    s = W / float(w0)
    h1 = max(1, int(round(h0 * s)))
    if (w0, h0) != (W, h1):
        ys = np.clip(((np.arange(h1) + 0.5) / s - 0.5).round().astype(int), 0, h0 - 1)
        xs = np.clip(((np.arange(W) + 0.5) / s - 0.5).round().astype(int), 0, w0 - 1)
        if nearest or img.dtype != np.uint8 or img.ndim == 2:
            img = img[ys][:, xs]
        else:   # area-ish: average a 2x2 neighbourhood when downscaling
            y2 = np.clip(ys + 1, 0, h0 - 1)
            x2 = np.clip(xs + 1, 0, w0 - 1)
            a = img[ys][:, xs].astype(np.float32) + img[y2][:, xs] + img[ys][:, x2] + img[y2][:, x2]
            img = (a / 4).astype(np.uint8)
    out = np.zeros((H, W) + img.shape[2:], img.dtype)
    valid = np.zeros((H, W), bool)
    y0 = (H - h1) // 2
    src0, dst0 = max(0, -y0), max(0, y0)
    n = min(h1 - src0, H - dst0)
    out[dst0:dst0 + n] = img[src0:src0 + n]
    valid[dst0:dst0 + n] = True
    return out, valid
