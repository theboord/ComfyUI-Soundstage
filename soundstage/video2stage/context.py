"""The Video → Stage context: one plain dict `ctx` that every stage of the pipeline reads and adds to.

This is the agreed interface between the four Video → 3D tracks (SOLVE, POSE, LAYOUT, MATCH). Keep it a plain dict
of numpy arrays, lists and numbers, so any module can be tested on a hand-made ctx.

Pixels: every pixel coordinate, mask and depth map is on the PROXY frame grid (ctx['clip']['pw'] x ['ph'], the
decoded frames, at most 768 wide). Frame indices f are STAGE frames on the 24 fps timeline (0 .. clip.frames - 1):
all_frames[f] is the source picture the stage shows at frame f.

Units: SOLVE units (frame 0's depth scale) until ctx['mpu'] (metres per unit) is set by solve.metric_scale; every
module stores raw units, and metric_scale multiplies poses, depth and points once. Read ctx['mpu'] (None before) to
convert.

Keys
  clip           {path, fps, frames, duration, w, h, pw, ph, start, end, src_frames, cap_note?}
                 w/h = source size, pw/ph = proxy size, start/end = trim in seconds, frames = stage frames.
  all_frames     [png path] per stage frame, proxy size, decoded once (frames.decode_all)
  samples        [f] the stage frames DA3 measured (sorted)
  depth          {f: HxW float32} DA3 depth on the proxy grid, straightened (only for f in samples)
  sky            {f: HxW float32 0..1}
  K              {f: 3x3 float64} per-frame intrinsics on the proxy grid (zoom moves fx = fy)
  k1             float, radial distortion of normalised coordinates (one term)
  poses          {f: 4x4 float64} WORLD-FROM-CAMERA for EVERY frame f. World = camera 0 space (OpenCV: x right,
                 y down, z forward) until solve.camera() puts gravity in: then world is Y-UP stage axes
                 (x, y up, z) with the ground at y = 0, still in solve units until mpu is applied.
  points         {'xyz': Nx3, 'rgb': Nx3 uint8, 'track': N} sparse static points of the solve (world)
  ground         {A: 3x3, b: 3} cam0 -> stage transform used by legacy code (stage = A @ p + b); after solve.camera
                 the world is already stage-aligned and A = I*mpu, b = 0.
  masks          {'people': {track_id: {f: rle}}, 'objects': {obj_id: {f: rle}}}, written by POSE and LAYOUT
  movers         set of ids (people track ids or object ids) that move
  scale_anchors  [{source, units, metres, weight, note?}]  units = the measured length in solve units
  mpu            metres per solve unit (None until solve.metric_scale)
  solve          {rms_px, per_frame_px[], confidence, mode, focal_mm[], roll_deg[], zoom, notes[]}
  notes          [{level: info|warn|red, text, fix?: {action, label}}]
  opts           the route options {quality, samples, trim, people, mode, vlm, backdrop, ...}
  timings        {step: ms}
  surfaces       [{id, kind, plane, polygon}] (LAYOUT -> POSE)
  inventory      [...] (LAYOUT -> MATCH)

Modules expose:
  graph(ctx) -> prompt dict | None     a ComfyUI prompt to queue (core nodes + registered Soundstage nodes)
  collect(ctx, outputs)                read that prompt's outputs into ctx
  and plain CPU functions the pipeline calls in this order:
    frames -> (DA3 || layout.inventory_graph -> layout.segment_graph || people.graph) -> solve.camera(ctx)
    -> people.measure(ctx) + layout.measure(ctx) -> solve.metric_scale(ctx) -> layout.assemble(ctx)
    -> people.attach(scene, ctx) -> backdrop.build(scene, ctx) -> write
A missing or failed module adds a note (see call()) and the pipeline carries on.
"""
from __future__ import annotations

import importlib
import logging
import time
import traceback

import numpy as np

FPS = 24
LEVELS = ("info", "warn", "red")

log = logging.getLogger("soundstage.video2stage")


def new(clip: dict, opts: dict | None = None) -> dict:
    return {"clip": dict(clip), "all_frames": [], "samples": [], "depth": {}, "sky": {}, "K": {}, "k1": 0.0,
            "poses": {}, "points": None, "ground": None, "masks": {"people": {}, "objects": {}}, "movers": set(),
            "scale_anchors": [], "mpu": None, "solve": {}, "notes": [], "opts": dict(opts or {}), "timings": {},
            "surfaces": [], "inventory": []}


def note(ctx: dict, text: str, level: str = "info", fix: dict | None = None) -> dict:
    """Add a note once (same text = same note). fix = {action: 'lock_camera'|'retry_quality'|..., label}."""
    level = level if level in LEVELS else "info"
    for n in ctx.setdefault("notes", []):
        if n.get("text") == text:
            return n
    n = {"level": level, "text": str(text)}
    if fix:
        n["fix"] = dict(fix)
    ctx["notes"].append(n)
    return n


def note_texts(ctx: dict) -> list[str]:
    return [n["text"] for n in ctx.get("notes") or []]


def anchor(ctx: dict, source: str, units: float, metres: float, weight: float = 1.0, note_text: str = "") -> None:
    """A scale anchor: something `metres` long in reality measured as `units` long in the solve."""
    if not (units and metres and np.isfinite(units) and np.isfinite(metres) and units > 0 and metres > 0):
        return
    a = {"source": source, "units": float(units), "metres": float(metres), "weight": float(weight)}
    if note_text:
        a["note"] = note_text
    ctx.setdefault("scale_anchors", []).append(a)


# ------------------------------------------------------------------------------------------------ masks (RLE)
def rle_encode(mask: np.ndarray) -> dict:
    """Bool HxW -> {size: [h, w], counts: [run lengths, column-major, starting with a run of 0s]} (COCO-style
    uncompressed RLE, so pycocotools-style tools and the browser can read it)."""
    m = np.asarray(mask, bool)
    h, w = m.shape
    flat = m.T.reshape(-1).astype(np.int8)
    d = np.diff(np.concatenate([[0], flat, [0]]))
    idx = np.flatnonzero(d)
    counts = np.diff(np.concatenate([[0], idx, [flat.size]])).tolist()   # 0-run, 1-run, 0-run ... sums to h*w
    if len(counts) > 1 and counts[-1] == 0:
        counts.pop()
    return {"size": [int(h), int(w)], "counts": [int(c) for c in counts]}


def rle_decode(rle: dict) -> np.ndarray:
    h, w = rle["size"]
    flat = np.zeros(h * w, bool)
    pos, val = 0, False
    for c in rle["counts"]:
        if val:
            flat[pos:pos + c] = True
        pos += c
        val = not val
    return flat.reshape(w, h).T


def mask_at(ctx: dict, f: int, groups=("people", "objects"), ids=None, movers_only: bool = False) -> np.ndarray | None:
    """Union of the masks of frame f (proxy grid), or None when no module wrote any."""
    out = None
    movers = ctx.get("movers") or set()
    for g in groups:
        for tid, per in ((ctx.get("masks") or {}).get(g) or {}).items():
            if ids is not None and tid not in ids:
                continue
            if movers_only and g == "objects" and tid not in movers:
                continue
            r = per.get(f) if isinstance(per, dict) else None
            if r is None and isinstance(per, dict):
                r = per.get(str(f))
            if r is None:
                continue
            m = rle_decode(r)
            out = m if out is None else (out | m)
    return out


def has_masks(ctx: dict) -> bool:
    m = ctx.get("masks") or {}
    return any(m.get(g) for g in ("people", "objects"))


# ------------------------------------------------------------------------------------------------ modules
def optional(name: str):
    """Import a sibling module (people, segment, measure, planes, movers, backdrop, ...) or None if it is not there."""
    try:
        return importlib.import_module(f"{__package__}.{name}")
    except ImportError:
        return None


def call(ctx: dict, module, fn: str, *args, what: str = "", **kw):
    """module.fn(*args) with a note instead of a crash. Returns the result, or None when missing / failed."""
    label = what or f"{getattr(module, '__name__', module)}.{fn}".split(".")[-2:]
    label = label if isinstance(label, str) else ".".join(label)
    if module is None or not hasattr(module, fn):
        log.info("video2stage: %s not available", label)
        return None
    t0 = time.perf_counter()
    try:
        return getattr(module, fn)(*args, **kw)
    except Exception as exc:  # noqa: BLE001 - one module never stops the rebuild
        log.warning("video2stage: %s failed: %s\n%s", label, exc, traceback.format_exc())
        note(ctx, f"{label}: failed ({type(exc).__name__}: {exc})", "warn")
        return None
    finally:
        ctx.setdefault("timings", {})[f"{label}_ms"] = round((time.perf_counter() - t0) * 1000)


# ------------------------------------------------------------------------------------------------ helpers
def K_at(ctx: dict, f: int) -> np.ndarray:
    K = ctx.get("K") or {}
    if f in K:
        return np.asarray(K[f], float)
    if not K:
        c = ctx["clip"]
        fx = 0.7 * c["pw"]
        return np.array([[fx, 0, (c["pw"] - 1) / 2], [0, fx, (c["ph"] - 1) / 2], [0, 0, 1.0]])
    near = min(K, key=lambda k: abs(k - f))
    return np.asarray(K[near], float)


def pose_at(ctx: dict, f: int) -> np.ndarray:
    """World-from-camera 4x4 at stage frame f (nearest solved frame when f itself is missing)."""
    P = ctx.get("poses") or {}
    if f in P:
        return np.asarray(P[f], float)
    if not P:
        return np.eye(4)
    near = min(P, key=lambda k: abs(k - f))
    return np.asarray(P[near], float)


def world_to_pixel(ctx: dict, f: int, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """World points (N,3) -> proxy pixels (N,2) and camera depth (N,) at frame f (k1 applied)."""
    T = np.linalg.inv(pose_at(ctx, f))
    Xc = np.asarray(X, float) @ T[:3, :3].T + T[:3, 3]
    z = Xc[:, 2]
    zs = np.where(np.abs(z) < 1e-9, 1e-9, z)
    xn = Xc[:, :2] / zs[:, None]
    k1 = float(ctx.get("k1") or 0.0)
    if k1:
        xn = xn * (1 + k1 * (xn ** 2).sum(1))[:, None]
    K = K_at(ctx, f)
    uv = np.stack([K[0, 0] * xn[:, 0] + K[0, 2], K[1, 1] * xn[:, 1] + K[1, 2]], 1)
    return uv, z


def pixel_to_world(ctx: dict, f: int, uv: np.ndarray, depth: np.ndarray) -> np.ndarray:
    """Proxy pixels (N,2) at camera depth (N,) of frame f -> world points (N,3) (k1 ignored: it is small)."""
    K = K_at(ctx, f)
    uv = np.asarray(uv, float)
    z = np.asarray(depth, float)
    Xc = np.stack([(uv[:, 0] - K[0, 2]) / K[0, 0] * z, (uv[:, 1] - K[1, 2]) / K[1, 1] * z, z], 1)
    P = pose_at(ctx, f)
    return Xc @ P[:3, :3].T + P[:3, 3]


def jsonable(x):
    """ctx pieces -> JSON (numpy arrays to lists, sets to sorted lists, int keys kept as strings)."""
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, set):
        return sorted(jsonable(v) for v in x)
    if isinstance(x, np.ndarray):
        return x.tolist()
    if isinstance(x, np.generic):
        return x.item()
    return x
