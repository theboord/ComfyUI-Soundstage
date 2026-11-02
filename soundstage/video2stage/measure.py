"""LAYOUT, step 3: each tracked thing -> a gravity-aligned oriented box with real dimensions, colour and material.

CPU only. For every masklet (segment.py) on every DA3 sample, the mask (eroded 2 px so depth edges do not bleed in)
is lifted through that sample's straightened depth and the solved pose into world points; a static thing gathers
points over all its samples. Then:

- footprint: cv2.minAreaRect on the x/z points; height: robust y percentiles 2 / 98, standing on the ground (y = 0)
  unless it clearly floats (a picture, a window, a book on a shelf);
- what the camera cannot see (the back of a sofa seen from the front, anything cut by the frame edge or hidden
  behind a nearer mask) is completed from the class's typical proportions, and the thing carries a 'partly seen' note;
- yaw: the long axis, then the facing: seats, shelves, screens and benches face into the room (toward the camera);
- colour: the median Lab of the unshadowed pixels (luma above the 30th percentile), white-balanced against a grey
  estimate of the plate; material from the vision model;
- known classes become scale anchors (car width 1.8 m, door 2.03 m, table 0.75 m, chair 0.88 m), and seats, tables,
  saddles and vehicle seats become ctx['surfaces'] for POSE.

World is the solve's Y-up stage frame with the ground at y = 0, in SOLVE units (ctx['mpu'] converts later). Writes
ctx['layout'] = {'objects': {id: record}, 'units': 'solve'}.
"""
from __future__ import annotations

import math
import re

import numpy as np

from . import context as X

# Typical size (metres) as [width x (across the facing), height y, depth z (along the facing)].
PRIORS = {
    "sofa": (2.0, 0.85, 0.9), "couch": (2.0, 0.85, 0.9), "armchair": (0.85, 0.9, 0.85), "chair": (0.48, 0.88, 0.52),
    "stool": (0.4, 0.65, 0.4), "bench": (1.8, 0.85, 0.6), "table": (1.4, 0.75, 0.85), "coffee table": (1.1, 0.45, 0.6),
    "side table": (0.5, 0.55, 0.5), "desk": (1.4, 0.75, 0.7), "shelf": (1.0, 1.8, 0.35), "bookshelf": (1.0, 1.8, 0.35),
    "cabinet": (1.0, 0.9, 0.45), "bed": (1.6, 0.6, 2.1), "lamp": (0.4, 1.6, 0.4), "floor lamp": (0.4, 1.6, 0.4),
    "plant": (0.5, 0.9, 0.5), "box": (0.5, 0.4, 0.4), "crate": (0.6, 0.6, 0.6), "bag": (0.4, 0.45, 0.25),
    "rug": (2.0, 0.015, 1.4), "carpet": (2.0, 0.015, 1.4), "door": (0.9, 2.03, 0.06), "window": (1.2, 1.3, 0.06),
    "picture": (0.8, 0.6, 0.04), "painting": (0.8, 0.6, 0.04), "tv": (1.2, 0.7, 0.08), "television": (1.2, 0.7, 0.08),
    "car": (1.8, 1.45, 4.5), "sedan": (1.8, 1.45, 4.6), "taxi": (1.8, 1.5, 4.6), "suv": (1.9, 1.7, 4.7),
    "pickup": (2.0, 1.85, 5.4), "van": (2.0, 2.1, 5.2), "truck": (2.4, 2.8, 7.0), "bus": (2.55, 3.2, 12.0),
    "motorcycle": (0.7, 1.15, 2.1), "bicycle": (0.6, 1.05, 1.75), "boat": (2.3, 1.4, 6.0), "horse": (0.6, 1.6, 2.4),
    "dog": (0.3, 0.6, 0.9), "cat": (0.18, 0.3, 0.45), "tree": (3.0, 6.5, 3.0), "bush": (1.3, 1.1, 1.3),
    "sign": (0.75, 2.4, 0.08), "stop sign": (0.75, 2.4, 0.08), "pole": (0.25, 4.5, 0.25), "street light": (0.4, 5.0, 0.4),
    "streetlight": (0.4, 5.0, 0.4), "bin": (0.6, 1.0, 0.6), "trash can": (0.6, 1.0, 0.6), "hydrant": (0.4, 0.8, 0.4),
    "bollard": (0.25, 1.0, 0.25), "barrier": (2.0, 1.0, 0.5), "fence": (3.0, 1.2, 0.08), "mailbox": (0.5, 1.2, 0.5),
    "bottle": (0.08, 0.3, 0.08), "cup": (0.09, 0.1, 0.09), "book": (0.16, 0.24, 0.04), "vase": (0.2, 0.35, 0.2),
    "cushion": (0.45, 0.15, 0.45), "pillow": (0.5, 0.15, 0.35), "furniture": (1.0, 0.8, 0.6), "vehicle": (1.8, 1.5, 4.5),
    "animal": (0.4, 0.7, 1.0), "object": (0.5, 0.5, 0.5),
}
# Things that do not stand on the floor (keep their measured height off the ground).
FLOATING = {"picture", "painting", "window", "tv", "television", "book", "cup", "bottle", "vase", "cushion", "pillow",
            "sign", "clock", "mirror", "shelf"}   # shelf: wall shelves; a bookcase on the floor still lands (bottom ~ 0)
ON_SOMETHING = FLOATING | {"box", "bag", "laptop", "bowl", "plate", "phone", "toy", "basket", "lamp shade", "clock",
                           "mirror", "crate", "object", "speaker", "candle", "remote", "keyboard", "monitor"}
# Facing into the room: their front looks at the camera that films them.
FACES_CAMERA = {"sofa", "couch", "armchair", "chair", "bench", "shelf", "bookshelf", "cabinet", "tv", "television",
                "picture", "painting", "sign", "stop sign", "window", "door", "desk", "bed"}
VARIABLE = {"rug", "carpet", "table", "dining table", "coffee table", "desk", "shelf", "bookshelf", "sofa", "couch",
            "building", "fence", "bench", "cabinet", "bed", "tree", "bush", "window", "picture", "painting", "plant",
            "barrier", "furniture", "object", "boat", "bus", "truck"}
ROUND = {"plant", "tree", "bush", "lamp", "floor lamp", "pole", "street light", "streetlight", "hydrant", "bollard",
         "bin", "trash can", "vase", "stool", "cup", "bottle"}
VEHICLE = {"car", "sedan", "taxi", "suv", "pickup", "van", "truck", "bus", "motorcycle", "bicycle", "boat", "vehicle"}
ANIMAL = {"horse", "dog", "cat", "animal"}
ANCHORS = {"car": ("width", 1.8, 1.0), "sedan": ("width", 1.8, 1.0), "taxi": ("width", 1.8, 1.0),
           "suv": ("width", 1.9, 0.8), "door": ("height", 2.03, 0.8), "table": ("height", 0.75, 0.5),
           "chair": ("height", 0.88, 0.35), "bench": ("height", 0.85, 0.3), "hydrant": ("height", 0.8, 0.3),
           "stop sign": ("height", 2.4, 0.3)}
SEATS = {"sofa": 0.48, "couch": 0.48, "armchair": 0.5, "chair": 0.52, "stool": 1.0, "bench": 0.53, "bed": 0.9}


def prior(kind: str) -> tuple:
    k = (kind or "").lower().strip()
    if k in PRIORS:
        return PRIORS[k]
    last = k.split(" ")[-1] if k else ""
    return PRIORS.get(last, PRIORS["object"])


def base_kind(kind: str) -> str:
    k = (kind or "").lower().strip()
    if k in PRIORS:
        return k
    last = k.split(" ")[-1] if k else ""
    return last if last in PRIORS else k


# ---------------------------------------------------------------------------------------------- pixels -> world
def _erode(m: np.ndarray, px: int = 2) -> np.ndarray:
    import cv2
    if px <= 0:
        return m
    k = np.ones((2 * px + 1, 2 * px + 1), np.uint8)
    return cv2.erode(m.astype(np.uint8), k).astype(bool)


def _depth_edges(d: np.ndarray, rel: float = 0.04) -> np.ndarray:
    """Pixels on a depth discontinuity (relative jump above `rel` to a 4-neighbour)."""
    e = np.zeros(d.shape, bool)
    dd = np.where(np.isfinite(d) & (d > 0), d, np.nan)
    for ax in (0, 1):
        g = np.abs(np.diff(dd, axis=ax)) / np.fmax(np.minimum(dd[:-1] if ax == 0 else dd[:, :-1],
                                                               dd[1:] if ax == 0 else dd[:, 1:]), 1e-6)
        j = np.nan_to_num(g, nan=1.0) > rel
        if ax == 0:
            e[:-1] |= j
            e[1:] |= j
        else:
            e[:, :-1] |= j
            e[:, 1:] |= j
    return e


def _resize_to(m: np.ndarray, shape) -> np.ndarray:
    if m.shape == tuple(shape):
        return m
    import cv2
    return cv2.resize(m.astype(np.uint8), (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)


def lift(ctx: dict, f: int, mask: np.ndarray, stride: int = 2, erode: int = 2, max_pts: int = 4000):
    """Mask pixels of sample f -> (world points (N,3), pixel uv (N,2)); depth edges and invalid depth dropped."""
    d = (ctx.get("depth") or {}).get(f)
    if d is None:
        return None, None
    d = np.asarray(d, np.float32) * float((ctx.get("depth_scale") or {}).get(f, 1.0))   # SOLVE's per-sample scale
    m = _resize_to(mask, d.shape)
    m = _erode(m, erode) if m.sum() > 400 else m
    m &= np.isfinite(d) & (d > 0)
    m &= ~_depth_edges(d)
    ys, xs = np.nonzero(m[::stride, ::stride])
    if len(xs) < 8:
        ys, xs = np.nonzero(m)
        if len(xs) < 3:
            return None, None
    else:
        ys, xs = ys * stride, xs * stride
    if len(xs) > max_pts:
        sel = np.linspace(0, len(xs) - 1, max_pts).astype(int)
        ys, xs = ys[sel], xs[sel]
    z = d[ys, xs].astype(np.float64)
    # Depth grid -> proxy grid (they are the same in the agreed context; scale K if not).
    sy = ctx["clip"]["ph"] / d.shape[0]
    sx = ctx["clip"]["pw"] / d.shape[1]
    uv = np.stack([(xs + 0.5) * sx - 0.5, (ys + 0.5) * sy - 0.5], 1)
    return X.pixel_to_world(ctx, f, uv, z), uv


def _robust(P: np.ndarray, k: float = 2.0) -> np.ndarray:
    """Drop flying depth pixels: points further from the median (x/z) than k x the 80th-percentile distance. A long
    flat thing (a table seen edge-on) keeps its ends; a pixel that bled onto the far wall does not."""
    if len(P) < 10:
        return P
    med = np.median(P, 0)
    r = np.hypot(P[:, 0] - med[0], P[:, 2] - med[2])
    return P[r <= k * np.percentile(r, 80) + 1e-6]


# ---------------------------------------------------------------------------------------------- the box
def obb(P: np.ndarray, kind: str = "", ground: bool = True) -> dict | None:
    """Gravity-aligned box of world points (Y up): centre, size [along u, height, along v], yaw of the u axis (deg),
    and how much of it is measured (not completed)."""
    import cv2
    if P is None or len(P) < 6:
        return None
    xz = P[:, [0, 2]].astype(np.float32)
    (cx, cz), (w, l), ang = cv2.minAreaRect(xz)
    y0, y1 = (float(v) for v in np.percentile(P[:, 1], [2, 98]))
    # u axis = minAreaRect's 'width' edge direction.
    a = math.radians(ang)
    u = np.array([math.cos(a), math.sin(a)])
    return {"c": [float(cx), float((y0 + y1) / 2), float(cz)], "w": float(w), "l": float(l), "y0": y0, "y1": y1,
            "u": u.tolist(), "n": int(len(P))}


def _yaw_of(v) -> float:
    """Stage heading (deg) of a horizontal direction (x, z): 0 faces +Z."""
    return math.degrees(math.atan2(float(v[0]), float(v[1])))


def finish_box(box: dict, kind: str, cam_xz, truncated: bool, notes: list, name: str = "") -> dict:
    """Measured footprint + class proportions -> {centre, dims [x, y, z], yaw_deg} in the thing's own frame
    (rotation_deg 0 faces +Z; dims[2] is along the facing). Completes what the camera could not see."""
    k = base_kind(kind)
    pw_, ph_, pd_ = prior(k)
    u = np.array(box["u"], float)
    v = np.array([-u[1], u[0]])
    e_u, e_v = box["w"], box["l"]
    c = np.array([box["c"][0], box["c"][2]], float)
    y0, y1 = box["y0"], box["y1"]
    # Furniture, vehicles and plants stand on the floor (a chair half hidden behind a table still does); small props,
    # pictures and windows only when their underside is down there.
    grounded = (k not in ON_SOMETHING) or y0 < 0.3 * max(y1 - y0, 1e-6)
    if grounded:
        y0 = 0.0
    h = max(y1 - y0, 1e-4)
    # Which measured axis is the thing's width (across its facing)? The prior says which is longer.
    if (pw_ >= pd_) == (e_u >= e_v):
        across, along, ax_across, ax_along = e_u, e_v, u, v
    else:
        across, along, ax_across, ax_along = e_v, e_u, v, u
    partly = []
    to_cam = np.asarray(cam_xz, float) - c
    dist = float(np.linalg.norm(to_cam)) or 1.0
    view = to_cam / dist
    # The hidden depth: mono depth sees one face. Whichever axis points most at the camera is under-measured.
    if abs(ax_along @ view) >= abs(ax_across @ view):
        want = max(along, pd_ / max(pw_, 1e-6) * across if k not in ROUND else across)
        if want > along * 1.15:
            c = c - view * (want - along) / 2   # the box grows away from the camera
            partly.append("depth")
            along = want
    else:
        want = max(across, pw_ / max(pd_, 1e-6) * along if k not in ROUND else along)
        if want > across * 1.15:
            c = c - view * (want - across) / 2
            partly.append("depth")
            across = want
    if truncated:
        # Cut by the frame edge: complete toward the class proportions, never past 1.3x the typical size.
        longest = max(across, along)
        if k in PRIORS and k not in ("rug", "carpet", "object"):
            want_h = ph_ / max(pw_, pd_, 1e-6) * longest
            if h < 0.6 * want_h:
                h = min(want_h, 2.0 * h)
                partly.append("height")
    if k in ROUND:
        r = max(across, along)
        across = along = r
    # Facing: into the room for seats and screens; else along the long axis away from the camera.
    fwd = ax_along / (np.linalg.norm(ax_along) or 1)
    if k in FACES_CAMERA:
        fwd = fwd if fwd @ view >= 0 else -fwd
    elif k in VEHICLE or k in ANIMAL:
        fwd = fwd if fwd @ view <= 0 else -fwd   # a parked car shown nose-away; movers.py replaces it from motion
    yaw = _yaw_of(fwd)
    if partly:
        what = "the back" if partly == ["depth"] else "what the frame edge cuts off"
        notes.append(f"partly seen, {what} completed from a typical {k or 'object'}")
    return {"centre": [float(c[0]), float((y0 + y0 + h) / 2), float(c[1])], "dims": [float(across), float(h), float(along)],
            "yaw_deg": round(yaw, 1), "grounded": bool(grounded), "bottom": float(y0), "partly": partly}


# ---------------------------------------------------------------------------------------------- colour
def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def _lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    inv = lambda t: np.where(t ** 3 > 0.008856, t ** 3, (t - 16 / 116) / 7.787)  # noqa: E731
    xyz = np.stack([inv(fx), inv(fy), inv(fz)], -1) * np.array([0.95047, 1.0, 1.08883])
    M = np.linalg.inv(np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]))
    c = np.clip(xyz @ M.T, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def white_balance(img: np.ndarray) -> np.ndarray:
    """Per-channel gains (3,) that make the plate's near-grey pixels neutral, clamped to ±20 % (a grey world on the
    unsaturated mid-tones only: a sunset stays warm, a fluorescent green cast goes)."""
    x = img.reshape(-1, 3).astype(np.float64) / 255.0
    mx, mn = x.max(1), x.min(1)
    lum = x.mean(1)
    sel = (mx - mn < 0.12 * np.maximum(mx, 1e-6) + 0.02) & (lum > 0.15) & (lum < 0.9)
    if sel.sum() < 200:
        return np.ones(3)
    m = x[sel].mean(0)
    g = m.mean() / np.maximum(m, 1e-6)
    return np.clip(g, 0.8, 1.25)


def colour_of(pixels: np.ndarray, gains=None) -> str | None:
    """Median Lab of the unshadowed pixels (luma above the 30th percentile) -> #rrggbb."""
    if pixels is None or len(pixels) < 4:
        return None
    x = pixels.astype(np.float64) / 255.0
    if gains is not None:
        x = np.clip(x * np.asarray(gains)[None], 0, 1)
    lum = x @ np.array([0.2126, 0.7152, 0.0722])
    x = x[lum >= np.percentile(lum, 30)]
    lab = np.median(_srgb_to_lab(x), 0)
    rgb = _lab_to_srgb(lab)
    return "#" + "".join(f"{int(round(v * 255)):02x}" for v in rgb)


_FRAME_CACHE: dict = {}


def frame_rgb(ctx: dict, f: int) -> np.ndarray | None:
    frames = ctx.get("all_frames") or []
    if not (0 <= f < len(frames)):
        return None
    p = frames[f]
    if p in _FRAME_CACHE:
        return _FRAME_CACHE[p]
    import cv2
    im = cv2.imread(p, cv2.IMREAD_COLOR)
    if im is None:
        return None
    im = im[..., ::-1]
    if len(_FRAME_CACHE) > 48:
        _FRAME_CACHE.clear()
    _FRAME_CACHE[p] = im
    return im


# ---------------------------------------------------------------------------------------------- per object
def _kind_of(o: dict) -> str:
    k = (o.get("item") or {}).get("kind") or o.get("concept") or "object"
    k = re.sub(r"[^a-z ]", " ", str(k).lower()).strip()
    return re.sub(r"\s+", " ", k) or "object"


def _cam_xz(ctx, f) -> np.ndarray:
    P = X.pose_at(ctx, f)
    return np.array([P[0, 3], P[2, 3]])


NEVER_MOVES = {"chair", "armchair", "stool", "rug", "carpet", "shelf", "bookshelf", "window", "door", "picture", "painting", "tree", "sign",
               "stop sign", "pole", "street light", "streetlight", "hydrant", "bench", "sofa", "couch", "table",
               "coffee table", "side table", "dining table", "desk", "cabinet", "bed", "lamp", "floor lamp", "plant",
               "bush", "bin", "trash can", "building", "fence", "mailbox", "bollard", "tv", "television"}


def _moves(per: list, kind: str, item: dict) -> bool:
    """Does the thing move? Its world footprint at the start and at the end of what was seen no longer overlap and
    its centre travelled more than its own size (a static thing seen from new angles shifts its visible centroid,
    but its footprint stays put). Fixed furniture needs the vision model to say it moves too."""
    if len(per) < 2:
        return False
    k = base_kind(kind)
    thirds = max(1, len(per) // 3)
    A = np.concatenate([P for _, P in per[:thirds]])
    Bp = np.concatenate([P for _, P in per[-thirds:]])
    ca, cb = np.median(A[:, [0, 2]], 0), np.median(Bp[:, [0, 2]], 0)
    one = float(np.median([np.ptp(P[:, [0, 2]], 0).max() for _, P in per if len(P) > 3] or [0.0])) or 1e-6
    lo_a, hi_a = np.percentile(A[:, [0, 2]], 10, 0), np.percentile(A[:, [0, 2]], 90, 0)
    lo_b, hi_b = np.percentile(Bp[:, [0, 2]], 10, 0), np.percentile(Bp[:, [0, 2]], 90, 0)
    apart = bool(np.any(hi_a < lo_b) or np.any(hi_b < lo_a))
    far = float(np.linalg.norm(cb - ca)) > 1.0 * one
    # Lifted / carried: its height off the floor changes by more than half its own height.
    ha = float(np.median([np.ptp(P[:, 1]) for _, P in per if len(P) > 3] or [0.0])) or 1e-6
    lift_ = abs(float(np.median(Bp[:, 1]) - np.median(A[:, 1]))) > 0.5 * ha + 0.02 * one
    if lift_ and k not in NEVER_MOVES:
        return True
    if k in NEVER_MOVES:
        return bool(item.get("moving")) and apart and float(np.linalg.norm(cb - ca)) > 3.0 * one
    if item.get("moving") and (k in VEHICLE or k in ANIMAL):
        return far or apart
    if item.get("moving") is False:   # the vision model saw it standing: it takes a clear move to overrule that
        return apart and float(np.linalg.norm(cb - ca)) > 2.5 * one
    return apart and far


def measure_object(ctx: dict, oid: str, o: dict, gains=None) -> dict | None:
    masks = ((ctx.get("masks") or {}).get("objects") or {}).get(oid) or {}
    depth = ctx.get("depth") or {}
    samples = [f for f in (ctx.get("samples") or sorted(depth.keys())) if f in o["frames"] and f in depth]
    kind = _kind_of(o)
    item = o.get("item") or {}
    notes: list = []
    seen = sorted(o["frames"])
    per, pix, edges, zs = [], [], 0, {}
    for s in samples:
        r = masks.get(s) or masks.get(str(s))
        if r is None:
            continue
        m = X.rle_decode(r)
        area = int(m.sum())
        P, uv = lift(ctx, s, m, erode=2 if area > 3000 else 1 if area > 300 else 0)
        if P is None:
            continue
        per.append((s, _robust(P)))
        dz = np.asarray(depth[s], np.float32)[_resize_to(m, np.asarray(depth[s]).shape)] * \
            float((ctx.get("depth_scale") or {}).get(s, 1.0))
        dz = dz[np.isfinite(dz) & (dz > 0)]
        if len(dz):
            zs[s] = (float(np.median(dz)), float(o["frames"][s]["area"]))
        if o["frames"][s]["edge"]:
            edges += 1
    for f in sorted(seen, key=lambda f: -o["frames"][f]["area"])[:4]:   # colour from the biggest views
        r = masks.get(f) or masks.get(str(f))
        img = frame_rgb(ctx, f)
        if r is None or img is None:
            continue
        mm = _erode(_resize_to(X.rle_decode(r), img.shape[:2]), 1)
        px = img[mm]
        if len(px) > 3000:
            px = px[np.linspace(0, len(px) - 1, 3000).astype(int)]
        pix.append(px)
    colour = colour_of(np.concatenate(pix), gains) if pix else None
    if not per:
        return from_ground(ctx, oid, o, kind, item, colour, notes)
    moving = _moves(per, kind, item)
    if moving:
        # One box per sample (it moves): the median size, the middle sample's place.
        boxes = [obb(P, kind) for _, P in per]
        boxes = [b for b in boxes if b is not None]
        if not boxes:
            return None
        box = dict(boxes[len(boxes) // 2])
        big = sorted(boxes, key=lambda b: b["n"])[-max(1, len(boxes) // 2):]
        box["w"], box["l"] = float(np.median([max(b["w"], b["l"]) for b in big])), float(np.median([min(b["w"], b["l"]) for b in big]))
        if boxes[len(boxes) // 2]["w"] < boxes[len(boxes) // 2]["l"]:
            box["w"], box["l"] = box["l"], box["w"]
        box["y0"] = float(np.median([b["y0"] for b in big]))
        box["y1"] = float(np.median([b["y1"] for b in big]))
        pts_sample = per[len(per) // 2][0]
        pts = per[len(per) // 2][1]
    else:
        pts = _robust(np.concatenate([P for _, P in per]), k=3.5)   # per-sample trimmed already: keep parts few saw
        pts_sample = per[0][0]
        box = obb(pts, kind)
    if box is None:
        return None
    truncated = edges >= max(1, (len(per) + 1) // 2) and all(o["frames"][f]["edge"] for f in seen[:: max(1, len(seen) // 8)])
    fin = finish_box(box, kind, _cam_xz(ctx, pts_sample), truncated, notes, item.get("name") or "")
    return {"id": oid, "kind": kind, "concept": o["concept"], "name": item.get("name") or "",
            "material": (item.get("material") or "").lower(), "vlm_color": item.get("color"), "colour": colour,
            "centre": fin["centre"], "dims": fin["dims"], "yaw_deg": fin["yaw_deg"], "grounded": fin["grounded"],
            "bottom": fin["bottom"], "partly": fin["partly"], "truncated": bool(truncated), "moving": moving,
            "seen_frames": [seen[0], seen[-1]], "n_frames": len(seen), "samples": [s for s, _ in per],
            "n_points": int(len(pts)), "notes": notes, "how": "depth", "zs": zs,
            "area_px": float(np.median([st["area"] for st in o["frames"].values()]))}


def from_ground(ctx: dict, oid: str, o: dict, kind: str, item: dict, colour, notes: list) -> dict | None:
    """Seen only between the depth samples: stand it where its mask meets the ground (the solved camera's ray onto
    y = 0) and size it from its pixel size at that distance, the hidden depth from the class proportions."""
    seen = sorted(o["frames"])
    f = max(seen, key=lambda f: o["frames"][f]["area"])
    st = o["frames"][f]
    x0, y0, x1, y1 = st["bbox"]
    if y1 >= ctx["clip"]["ph"] - 2:
        return None
    P = X.pose_at(ctx, f)
    K = X.K_at(ctx, f)
    d = P[:3, :3] @ (np.linalg.inv(K) @ np.array([st["c"][0], st.get("bottom", y1), 1.0]))
    o_ = P[:3, 3]
    if d[1] >= -1e-4 or o_[1] <= 0:
        return None
    t = -o_[1] / d[1]
    hit = o_ + d * t
    zc = float((np.linalg.inv(P)[:3, :3] @ (hit - o_))[2])
    if zc <= 0:
        return None
    w = (x1 - x0) / K[0, 0] * zc
    h = (y1 - y0) / K[1, 1] * zc
    k = base_kind(kind)
    pw_, ph_, pd_ = prior(k)
    dd = pd_ / max(pw_, 1e-6) * w
    view = np.array([d[0], d[2]])
    view /= (np.linalg.norm(view) or 1)
    c = np.array([hit[0], hit[2]]) + view * dd / 2
    fwd = -view if k in FACES_CAMERA else view
    notes.append(f"seen only between depth samples; placed on the ground, the depth from a typical {k}")
    return {"id": oid, "kind": kind, "concept": o["concept"], "name": item.get("name") or "",
            "material": (item.get("material") or "").lower(), "vlm_color": item.get("color"), "colour": colour,
            "centre": [float(c[0]), float(h / 2), float(c[1])], "dims": [float(w), float(h), float(dd)],
            "yaw_deg": round(_yaw_of(fwd), 1), "grounded": True, "bottom": 0.0, "partly": ["depth"],
            "truncated": bool(st["edge"]), "moving": False, "seen_frames": [seen[0], seen[-1]], "n_frames": len(seen),
            "samples": [], "n_points": 0, "notes": notes, "how": "ground",
            "area_px": float(np.median([s["area"] for s in o["frames"].values()]))}


def orient(ctx: dict) -> None:
    """Seats face what they serve: a chair the nearest table (within 1.5 x its size), a sofa or armchair the room's
    middle (the coffee table, else the centroid of the furniture), else the camera (finish_box's default)."""
    objs = (ctx.get("layout") or {}).get("objects") or {}
    tables = [r for r in objs.values() if base_kind(r["kind"]) in ("table", "coffee table", "dining table", "desk", "side table")]
    furn = [r for r in objs.values() if not r["moving"]]
    mid = np.mean([[r["centre"][0], r["centre"][2]] for r in furn], 0) if furn else None
    for r in objs.values():
        k = base_kind(r["kind"])
        if r["moving"] or k not in ("chair", "armchair", "sofa", "couch", "bench", "stool"):
            continue
        c = np.array([r["centre"][0], r["centre"][2]])
        target = None
        if tables:
            t = min(tables, key=lambda t: np.hypot(t["centre"][0] - c[0], t["centre"][2] - c[1]))
            dist = float(np.hypot(t["centre"][0] - c[0], t["centre"][2] - c[1]))
            reach = 0.75 * max(t["dims"][0], t["dims"][2]) + 0.9 * max(r["dims"][0], r["dims"][2])
            if dist < reach and (k in ("chair", "stool") or base_kind(t["kind"]) == "coffee table"):
                target = np.array([t["centre"][0], t["centre"][2]])
        if target is None and k in ("sofa", "couch", "armchair") and mid is not None:
            target = mid
        if target is None:
            continue
        v = target - c
        if np.linalg.norm(v) < 1e-6:
            continue
        a = math.radians(r["yaw_deg"])
        fwd = np.array([math.sin(a), math.cos(a)])
        right = np.array([fwd[1], -fwd[0]])
        # Keep the measured axes: pick the one of the 4 axis directions closest to the target.
        cands = [fwd, -fwd, right, -right] if k in ("chair", "stool", "armchair") else [fwd, -fwd]
        i = int(np.argmax([float(u @ v) for u in cands]))
        if i >= 2:   # it faces along its measured width: the box turns a quarter
            r["dims"][0], r["dims"][2] = r["dims"][2], r["dims"][0]
        r["yaw_deg"] = round(_yaw_of(cands[i]), 1)


def measure(ctx: dict) -> dict:
    """Every tracked thing -> ctx['layout']['objects']; scale anchors and surfaces. Returns ctx['layout']."""
    seg = ctx.get("seg") or {}
    lay = ctx.setdefault("layout", {"objects": {}, "units": "solve"})
    lay.setdefault("objects", {})
    gains = None
    s0 = (ctx.get("samples") or [0])[0]
    img = frame_rgb(ctx, s0)
    if img is not None:
        gains = white_balance(img)
    dropped = []
    for oid, o in seg.items():
        try:
            rec = measure_object(ctx, oid, o, gains)
        except Exception as exc:  # noqa: BLE001 - one bad mask never stops the set
            X.note(ctx, f"layout: could not measure {o.get('concept')} ({exc})", "warn")
            rec = None
        if rec is None:
            dropped.append(o.get("concept") or oid)
            continue
        lay["objects"][oid] = rec
        if rec["moving"]:
            ctx.setdefault("movers", set()).add(oid)
    if dropped:
        X.note(ctx, f"layout: no depth on {len(dropped)} tracked thing(s) ({', '.join(sorted(set(dropped))[:6])}); "
                    "not rebuilt", "warn")
    orient(ctx)
    anchors(ctx)
    surfaces(ctx)
    return lay


def anchors(ctx: dict) -> int:
    """Known-size classes -> ctx['scale_anchors'] (units measured, metres known). Fully seen, static ones only."""
    n = 0
    for rec in (ctx.get("layout") or {}).get("objects", {}).values():
        k = base_kind(rec["kind"])
        if k not in ANCHORS or rec["truncated"] or (rec["partly"] and rec["partly"] != ["depth"]):
            continue
        what, metres, w = ANCHORS[k]
        units = rec["dims"][0] if what == "width" else rec["dims"][1]
        if what == "height" and not rec["grounded"]:
            continue
        X.anchor(ctx, f"layout:{k}", units, metres, w * min(1.0, rec["n_points"] / 300), f"{rec['id']} {what}")
        n += 1
    return n


def surfaces(ctx: dict) -> list:
    """Seats, tables, beds and vehicle seats as horizontal planes with their footprint polygon (world, solve units)."""
    out = []
    for rec in (ctx.get("layout") or {}).get("objects", {}).values():
        k = base_kind(rec["kind"])
        if k in SEATS:
            kind, hfrac = "seat", SEATS[k]
        elif k in ("table", "coffee table", "side table", "desk"):
            kind, hfrac = "table", 1.0
        elif k in ("car", "sedan", "taxi", "suv", "pickup", "van", "truck", "bus"):
            kind, hfrac = "vehicle_seat", 0.35
        elif k in ("horse",):
            kind, hfrac = "saddle", 0.82
        else:
            continue
        y = rec["bottom"] + rec["dims"][1] * hfrac
        out.append({"id": rec["id"], "kind": kind, "plane": [0.0, 1.0, 0.0, -float(y)],
                    "polygon": footprint(rec, y), "moving": rec["moving"], "source": "layout"})
    ctx["surfaces"] = [s for s in ctx.get("surfaces") or [] if s.get("source") != "layout"] + out
    return out


def footprint(rec: dict, y: float = 0.0) -> list:
    """The box's 4 ground corners [[x, y, z]] (world)."""
    a = math.radians(rec["yaw_deg"])
    fwd = np.array([math.sin(a), math.cos(a)])
    right = np.array([fwd[1], -fwd[0]])
    c = np.array([rec["centre"][0], rec["centre"][2]])
    w, d = rec["dims"][0] / 2, rec["dims"][2] / 2
    pts = [c + sx * w * right + sz * d * fwd for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return [[round(float(p[0]), 4), round(float(y), 4), round(float(p[1]), 4)] for p in pts]


def sanity(rec: dict, s: float) -> list:
    """In metres (s = metres per unit): a thing of a fixed size (a door, a chair, a car) cannot measure 2.5x its
    class; the mask or the depth caught more. Clamps those dimensions to 1.3x typical and says so."""
    k = base_kind(rec.get("kind"))
    if k not in PRIORS or k in VARIABLE:
        return []
    typ = prior(k)
    out = []
    for i in range(3):
        v = rec["dims"][i] * s
        if typ[i] > 0.05 and v > 2.5 * typ[i]:
            rec["dims"][i] = 1.3 * typ[i] / s
            out.append(("width", "height", "depth")[i])
    if out:
        if rec.get("grounded", True):
            rec["centre"][1] = rec["dims"][1] / 2 + rec.get("bottom", 0.0)
        rec.setdefault("notes", []).append(f"{' and '.join(out)} implausible for a {k} (the mask caught more); "
                                           f"set to a typical {k}'s")
    return out
