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

Reading the ID pass (id_masks) must not invent objects. The stage canvas is antialiased, so every edge between two
ID colours is a 1-px seam of blends, and with 14+ golden-ratio hues some blend lands on a third object's colour: in
the crate crash the yellow and green crates' seams are the sports car's colour. Plain nearest-colour labelling gave the
far, half-hidden sports car a box from the crate pyramid to the end of the street, the prompt said "a sports car close
to the camera, half the frame wide", and Klein painted a ghost red car in the foreground (M27) or over the pyramid
(M28) - share/GhostCar_DetailLoss. Now an object is only where its colour is solid (a pixel whose 8 neighbours are the
same flat colour) and what is joined to that; seams go to the object they border.

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
FLAT = 0.08               # an ID pixel this close (RGB distance, 0..1) to a palette colour is that flat colour
MIN_FILL = 0.03           # a box its own pixels fill less than this is strewn pixels, not an object (the ghost: 0.014)
_N8 = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def stage_denoise(v) -> float:
    """The img2img denoise for a frame from the stage; 1.0 (or anything missing) = from noise, the pre-lock way."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 1.0
    return round(max(MIN_DENOISE, min(1.0, x)), 3)


def _srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)


def _nearest(img: np.ndarray, pal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(index of the nearest palette entry, its squared distance) per pixel, in chunks of rows (a 960x512 frame x 20
    colours stays small)."""
    label = np.empty(img.shape[:2], np.int64)
    dist = np.empty(img.shape[:2], np.float32)
    for y in range(0, img.shape[0], 128):
        d = ((img[y:y + 128, :, None, :3] - pal[None, None]) ** 2).sum(-1)
        label[y:y + 128] = d.argmin(-1)
        dist[y:y + 128] = d.min(-1)
    return label, dist


def id_masks(id_rgb: np.ndarray, id_colors: dict) -> dict[str, np.ndarray]:
    """id -> HxW bool mask. id_rgb: HxWx3 in 0..1 (or 0..255); black is the background.

    1. One encoding. The stage sets its ID colours in linear space and the canvas writes them as sRGB (a pass saved
       another way stays linear): whichever palette the pass's flat pixels hit is the one in use. Both at once
       doubled the palette and put one object's linear colour on the blend of two others.
    2. Solid patches. An object is seeded only where its colour is flat and solid: the pixel and its 8 neighbours.
       Antialiased seams are 1-2 px wide, so a blend that happens to equal a third object's colour never seeds it.
    3. Grown through pixels of its own flat colour (8-connected), so thin parts joined to a patch stay (a far
       person's legs). Never through blends: a seam under a crate would run the crate's box down the pyramid.
    4. The leftover edge pixels (seams, fringes) go to the bordering object nearest in colour, one pixel deep."""
    ids = [i for i, c in (id_colors or {}).items() if c is not None]
    if not ids:
        return {}
    img = np.asarray(id_rgb, dtype=np.float32)[..., :3]
    if img.max() > 1.5:
        img = img / 255.0
    H, W = img.shape[:2]
    raw = np.asarray([id_colors[i] for i in ids], dtype=np.float32) / 255.0
    black = np.zeros((1, 3), np.float32)
    hits = []
    for enc in (_srgb(raw), raw):                      # ties (pure primaries look the same both ways) read as sRGB
        lab, d = _nearest(img[::2, ::2], np.concatenate([black, enc], 0))
        hits.append(int(((lab > 0) & (d <= FLAT ** 2)).sum()))
    obj = (_srgb(raw) if hits[0] >= hits[1] else raw).astype(np.float32)
    label, dist = _nearest(img, np.concatenate([black, obj], 0))
    label -= 1                                         # -1 = background
    flat = np.where((label >= 0) & (dist <= FLAT ** 2), label, -2)
    p = np.pad(flat, 1, mode="edge")                   # an object cut by the frame edge is still solid at the edge
    solid = flat >= 0
    for dy, dx in _N8:
        solid &= p[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] == flat
    # grow the solid patches through pixels of the same flat colour, a ring at a time (only thin parts move)
    Wp = W + 2
    keep = np.full((H + 2, Wp), -1, np.int64)
    keep[1:-1, 1:-1] = np.where(solid, label, -1)
    fl = np.full((H + 2, Wp), -1, np.int64)
    fl[1:-1, 1:-1] = np.maximum(flat, -1)
    kf, ff = keep.ravel(), fl.ravel()
    offs = np.asarray([dy * Wp + dx for dy, dx in _N8])
    cand = np.flatnonzero((kf == -1) & (ff >= 0))
    while cand.size:
        hit = (kf[cand[:, None] + offs] == ff[cand][:, None]).any(1)
        if not hit.any():
            break
        kf[cand[hit]] = ff[cand[hit]]
        cand = cand[~hit]
    cand = np.flatnonzero((kf == -1) & (np.pad(label, 1, constant_values=-1).ravel() >= 0))
    if cand.size:                                      # seams and fringes: the bordering object nearest in colour
        nb = kf[cand[:, None] + offs]
        rgb = np.pad(img, ((1, 1), (1, 1), (0, 0))).reshape(-1, 3)[cand]
        d = ((rgb[:, None, :] - obj[np.clip(nb, 0, None)]) ** 2).sum(-1)
        d[nb < 0] = np.inf
        best = d.argmin(1)
        ok = np.isfinite(d[np.arange(cand.size), best])
        kf[cand[ok]] = nb[np.flatnonzero(ok), best[ok]]
    who = keep[1:-1, 1:-1]
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
        if n < MIN_FILL * (xs[-1] + 1 - xs[0]) * (ys[-1] + 1 - ys[0]):
            continue          # pixels strewn across the frame, not one object: the prompt falls back to the 3D guess
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
