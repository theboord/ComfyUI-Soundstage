"""④ Frame follows the stage exactly: what the ID pass says is in frame 1, and how hard the image model is held to it.

Two things made FLUX 3 Klein frames drift off the clay (docs/decisions.md 2026-11-01, share/FirstFrame_Gaze):

1. Klein only SAW the stage. The Color pass went in as an edit reference and the latent started from noise, so the
   model recomposed the shot: the car-chase hero car (57 % of the frame wide on the stage) came out small and far
   down the street, a second red car appeared behind it. Klein (FLUX.3) has no positional knob for its references
   and no depth/edge control is installed for it, so the lock is img2img: the latent starts from the Color pass
   blurred to its layout (INIT_DOWN) and VAE-encoded at the reference's size, at a denoise below 1: `stage_denoise`
   on the frame node, which the
   App's "Follow the clay" slider sets. 1.0 is the old behaviour, so a frame picked before this change reproduces.
2. The prompt guessed sizes from the camera. A car is short, so "seen whole in the middle distance" for a car that
   fills half the frame. Here every actor's real box in frame 1 comes from the ID pass the stage already renders
   (frame1_layout in the scene JSON) and the still prompt states it: "in the left half of frame, close to the
   camera, half the frame wide".

Pure numpy; the 3D Stage node calls frame1_layout() and the router reads stage_denoise().
"""
from __future__ import annotations

import math

import numpy as np

VERSION = 2               # web/pipeline/pipeline.mjs LOOK_START: frames made from 2 on carry the lock and the layout
DEFAULT_DENOISE = 0.90    # the frame node's stage_denoise default (measured: share/FirstFrame_Gaze/REPORT.txt)
INIT_DOWN = 16            # the latent starts from the Color pass shrunk 16x and blown back up: layout and colour only.
                          # A sharp start (tested at 0.75) made Klein keep the clay mannequins; from noise it recomposed.
MIN_DENOISE = 0.3
MIN_AREA = 0.0006         # an actor smaller than this fraction of the frame is not stated (a far police light bar)


def stage_denoise(v) -> float:
    """The img2img denoise for a frame from the stage; 1.0 (or anything missing) = from noise, the pre-lock way."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 1.0
    return round(max(MIN_DENOISE, min(1.0, x)), 3)


def _srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)


def id_masks(id_rgb: np.ndarray, id_colors: dict) -> dict[str, np.ndarray]:
    """id -> HxW bool mask. id_rgb: HxWx3 in 0..1 (or 0..255). Nearest colour against the stage palette in both
    encodings (linear and sRGB), with black as the background, so antialiased edges classify one way."""
    ids = [i for i, c in (id_colors or {}).items() if c is not None]
    if not ids:
        return {}
    img = np.asarray(id_rgb, dtype=np.float32)
    if img.max() > 1.5:
        img = img / 255.0
    raw = np.asarray([id_colors[i] for i in ids], dtype=np.float32) / 255.0
    pal = np.concatenate([np.zeros((1, 3), np.float32), raw, _srgb(raw)], 0)
    owner = np.asarray([-1] + list(range(len(ids))) * 2)
    # nearest palette entry per pixel, in chunks of rows (a 960x512 frame x 20 colours stays small)
    label = np.empty(img.shape[:2], np.int64)
    for y in range(0, img.shape[0], 128):
        blk = img[y:y + 128, :, :3]
        label[y:y + 128] = ((blk[..., None, :] - pal[None, None]) ** 2).sum(-1).argmin(-1)
    who = owner[label]
    return {i: who == k for k, i in enumerate(ids) if (who == k).any()}


def _mount_host(scene: dict, a: dict) -> str | None:
    """The car / horse a person sits in at frame 1 (a timed mount, mount_at > 0, is still on foot then)."""
    m = a.get("mount_id")
    return m if isinstance(m, str) and not float(a.get("mount_at") or 0) > 0 else None


def frame1_layout(id_rgb: np.ndarray, scene: dict) -> dict:
    """{actor_id: {"box": [x0, y0, x1, y1] (0..1 of the frame), "area": fraction of the frame}} for every actor the
    ID pass shows in frame 1. A person seated in a car or on a horse is merged into the host (from outside a car
    the driver is part of the car's silhouette), and also listed on their own."""
    masks = id_masks(id_rgb, scene.get("id_colors") or {})
    if not masks:
        return {}
    H, W = next(iter(masks.values())).shape
    actors = {a.get("id"): a for a in scene.get("actors") or [] if a.get("id")}
    merged = {k: v.copy() for k, v in masks.items()}
    for aid, m in masks.items():
        host = _mount_host(scene, actors.get(aid) or {})
        if host and host in merged:
            merged[host] |= m
    out = {}
    for aid, m in merged.items():
        n = int(m.sum())
        if n / (H * W) < MIN_AREA:
            continue
        ys = np.flatnonzero(m.any(1))
        xs = np.flatnonzero(m.any(0))
        out[aid] = {"box": [round(float(xs[0]) / W, 4), round(float(ys[0]) / H, 4), round(float(xs[-1] + 1) / W, 4),
                            round(float(ys[-1] + 1) / H, 4)], "area": round(n / (H * W), 5)}
    return out


# ---- words --------------------------------------------------------------------------------------------------------

_FRACS = ((1.0, "the full"), (0.75, "three quarters of the"), (0.66, "two thirds of the"), (0.5, "half the"),
          (0.33, "a third of the"), (0.25, "a quarter of the"), (0.2, "a fifth of the"), (0.1, "a tenth of the"),
          (0.05, "a twentieth of the"))


def frac_words(v: float) -> str:
    """0.52 -> 'half the' (nearest in log space)."""
    v = max(0.02, min(1.0, v))
    return min(_FRACS, key=lambda f: abs(math.log(v / f[0])))[1]


def where_words(box) -> str:
    """Horizontal place of a box, by its centre, in thirds."""
    x0, _, x1, _ = box
    cx = (x0 + x1) / 2
    if x1 - x0 >= 0.8:
        return "across the whole frame"
    if cx < 0.2:
        return "on the left edge of frame"
    if cx < 0.4:
        return "in the left third of frame" if x1 - x0 < 0.4 else "in the left half of frame"
    if cx <= 0.6:
        return "in the centre of frame"
    if cx <= 0.8:
        return "in the right third of frame" if x1 - x0 < 0.4 else "in the right half of frame"
    return "on the right edge of frame"


def size_words(box, tall: bool) -> str:
    """How big and how near it reads. tall: people and animals are measured by height, vehicles by width."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    dim, word = (h, "tall") if tall else (w, "wide")
    if (tall and h >= 0.6) or (not tall and (w >= 0.4 or h >= 0.5)):
        near = "close to the camera"
    elif (tall and h >= 0.3) or (not tall and w >= 0.15):
        near = "in the middle ground"
    else:
        near = "small in the distance"
    bits = [near, f"{frac_words(dim)} frame {word}"]
    if tall and y1 >= 0.985 and h >= 0.45:
        bits.append("cut off by the bottom of frame")
    if x0 <= 0.005 and w < 0.8:
        bits.append("cut off by the left edge")
    elif x1 >= 0.995 and w < 0.8:
        bits.append("cut off by the right edge")
    return ", ".join(bits)


def union(boxes: list) -> list:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
