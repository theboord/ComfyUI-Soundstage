"""Refocus depth: every frame of the take as inverse distance in diopters (1/m, 0 = infinity). Pure numpy.

Two sources (docs/refocus.md):
  stage  the open shot's own 3D set, rendered by the App in a refocus-only pass (web/stage/stage.mjs "depth16"):
         inverse distance packed in 16 bits (R = high byte, G = low byte, full scale DMAX diopters, black = infinity),
         one sprite sheet for the shot. Real metres, but it is the clay set, not the generated pixels (hair, clothes,
         anything the model added beyond the set).
  da3    Depth Anything 3 (mono) on the take's own pixels, queued on this ComfyUI. Relative depth only: its scale is
         fixed by one known distance (the stage's distance at mark A, or the card's "distance to A"), so the T-stop
         means "about this much blur".

Steadying a mono depth video: each frame's overall scale drifts, so the frame's median log depth is smoothed over 9
frames and every frame is put back on that smoothed scale (slow real changes kept, frame-to-frame pumping removed); then
HFR's gated 3-frame filter (hfr_core/optical.py smooth_depth, MIT, adapted to diopters) and its colour-guided edge
repair (_edge_depth, ported to numpy). Full size: bilinear up, then every depth step made hard again (snap_edges), so a
silhouette has no in-between distances that would be blurred into the background with the subject's colour.
"""
from __future__ import annotations

import math

import numpy as np

from .optics import resize_bilinear

DMAX = 10.0        # diopters at full scale of the stage pass (0.1 m): the App's encoder uses the same number


# ------------------------------------------------------------------------------------------------ the stage pass

def decode_sheet(rgb: np.ndarray, *, cols: int, frames: int, tile: tuple[int, int], dmax: float = DMAX) -> np.ndarray:
    """A depth16 sprite sheet ([H,W,3+] uint8, row-major tiles) -> [frames, th, tw] diopters."""
    tw, th = int(tile[0]), int(tile[1])
    a = np.asarray(rgb)
    if a.ndim != 3 or a.shape[2] < 2:
        raise ValueError("the stage depth sheet must be an RGB picture")
    cols = max(1, int(cols))
    out = np.empty((int(frames), th, tw), np.float32)
    for i in range(int(frames)):
        x, y = (i % cols) * tw, (i // cols) * th
        t = a[y:y + th, x:x + tw]
        if t.shape[:2] != (th, tw):
            raise ValueError(f"the stage depth sheet is too small for frame {i}")
        q = t[..., 0].astype(np.float32) * 256.0 + t[..., 1].astype(np.float32)
        out[i] = q / 65535.0 * float(dmax)
    return out


def encode16(diopters: np.ndarray, dmax: float = DMAX) -> np.ndarray:
    """The App's encoding, for tests: diopters -> [H,W,3] uint8 (R high byte, G low byte)."""
    q = np.round(np.clip(np.asarray(diopters, np.float64) / dmax, 0, 1) * 65535).astype(np.int64)
    return np.stack([(q >> 8).astype(np.uint8), (q & 255).astype(np.uint8), np.zeros(q.shape, np.uint8)], -1)


def center_crop(a: np.ndarray, aspect: float) -> np.ndarray:
    """Centre-crop [..., H, W] to width/height = aspect (the crop the Ladder and the router use for a take)."""
    h, w = a.shape[-2:]
    if w / h > aspect + 1e-3:
        w2 = max(1, int(round(h * aspect)))
        x0 = (w - w2) // 2
        return a[..., :, x0:x0 + w2]
    if w / h < aspect - 1e-3:
        h2 = max(1, int(round(w / aspect)))
        y0 = (h - h2) // 2
        return a[..., y0:y0 + h2, :]
    return a


def time_map(n_take: int, fps_take: float, n_src: int, fps_src: float) -> np.ndarray:
    """For each take frame, the depth frame at the same moment (the take and the shot can differ in fps and length)."""
    t = np.arange(int(n_take)) / max(1e-6, float(fps_take))
    return np.clip(np.round(t * float(fps_src)).astype(int), 0, max(0, int(n_src) - 1))


def fit_frames(d: np.ndarray, width: int, height: int) -> np.ndarray:
    """[N,H,W] -> the take's aspect (centre crop), resized to width x height (the working size)."""
    d = center_crop(np.asarray(d, np.float32), width / height)
    return np.stack([resize_bilinear(f, int(height), int(width)) for f in d]).astype(np.float32)


def working_size(width: int, height: int, long: int = 1024) -> tuple[int, int]:
    """The size depth is kept at (and DA3 is fed): long side at most `long`, even numbers."""
    k = min(1.0, long / max(width, height))
    return max(16, int(round(width * k / 2)) * 2), max(16, int(round(height * k / 2)) * 2)


# ------------------------------------------------------------------------------------------------ Depth Anything 3

def steady_scale(depth: np.ndarray, sky: np.ndarray | None = None, size: int = 9) -> np.ndarray:
    """Remove frame-to-frame scale drift from relative depth [N,H,W] (z-like, larger = farther). Returns the scale
    factor per frame that was applied."""
    n = len(depth)
    keep = np.ones(depth.shape, bool) if sky is None else sky < 0.5
    m = np.array([np.median(np.log(np.maximum(depth[i][keep[i]], 1e-6))) if keep[i].any() else 0.0 for i in range(n)])
    k = min(size // 2, max(0, (n - 1) // 2))
    if k < 1:
        return np.ones(n)
    p = np.pad(m, k, mode="edge")
    sm = np.convolve(p, np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
    f = np.exp(sm - m)
    depth *= f[:, None, None].astype(depth.dtype)
    return f


def da3_inverse(depth: np.ndarray, sky: np.ndarray | None = None, steady: bool = True) -> np.ndarray:
    """Relative DA3 depth [N,H,W] -> relative inverse depth (sky = 0 = infinity), scale steadied across frames."""
    d = np.array(depth, np.float32, copy=True)
    if d.ndim == 2:
        d = d[None]
    s = None if sky is None else np.asarray(sky, np.float32).reshape(d.shape)
    if steady and len(d) > 2:
        steady_scale(d, s)
    inv = 1.0 / np.maximum(d, 1e-6)
    if s is not None:
        inv[s >= 0.5] = 0.0
    return inv.astype(np.float32)


def anchor(inv: np.ndarray, x: float, y: float, metres: float, frame: int = 0) -> tuple[np.ndarray, float]:
    """Scale relative inverse depth so the patch under (x, y) on `frame` is `metres` away. -> (diopters, scale)."""
    from .plan import patch_level
    n, h, w = inv.shape
    v = patch_level(inv[frame], int(round(x * (w - 1))), int(round(y * (h - 1))))
    if not v > 0:
        v = float(np.median(inv[frame][inv[frame] > 0])) if (inv[frame] > 0).any() else 1.0
    s = (1.0 / max(0.05, float(metres))) / v
    return (inv * s).astype(np.float32), float(s)


# ------------------------------------------------------------------------------------------------ steadying + edges

def smooth_depth(d: np.ndarray, gray: np.ndarray, amount: float = 0.5) -> np.ndarray:
    """Centred 3-frame filter gated by colour AND depth agreement: moving silhouettes and cuts reset locally, no
    optical flow, and the pictures themselves are never blended. Adapted from HFR's smooth_depth (MIT): gray instead of
    RGB, and the depth gate relative (4% of the distance) because these are diopters, not 0-1."""
    d = np.asarray(d, np.float32)
    if not amount or len(d) < 2:
        return d.copy()
    g = np.asarray(gray, np.float32)
    g = g / 255.0 if g.max() > 1.5 else g
    out = np.empty_like(d)
    for i in range(len(d)):
        res = np.zeros_like(d[i])
        wt = np.ones_like(d[i])
        for j in (i - 1, i + 1):
            if not 0 <= j < len(d):
                continue
            cd = np.abs(g[i] - g[j])
            dd = np.abs(d[i] - d[j]) / (0.04 * np.maximum(d[i], d[j]) + 1e-3)
            gate = np.clip(1 - cd / 0.06, 0, 1) * np.clip(1 - dd, 0, 1) * amount
            res += gate * (d[j] - d[i])
            wt += gate
        out[i] = d[i] + res / wt
    return out


def edge_depth(d: np.ndarray, gray: np.ndarray, strength: float = 0.5) -> np.ndarray:
    """Small colour-guided depth repair: same-colour neighbours (8, out to 2 px) support a depth edge without pulling
    depth across a strong colour edge. HFR's _edge_depth (MIT), ported to numpy, on gray."""
    if not strength:
        return d
    g = np.asarray(gray, np.float32)
    g = g / 255.0 if g.max() > 1.5 else g
    h, w = d.shape
    dp = np.pad(d, 2, mode="edge")
    gp = np.pad(g, 2, mode="edge")
    total, weight = d.copy(), np.ones_like(d)
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-2, 0), (2, 0), (0, -2), (0, 2)):
        nb = gp[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
        sup = np.exp(-np.abs(g - nb) / 0.035) * (0.6 if abs(dx) + abs(dy) == 2 else 1.0)
        total += sup * dp[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
        weight += sup
    return (d + (total / weight - d) * strength).astype(np.float32)


def _run_extreme(a: np.ndarray, r: int, axis: int, fn) -> np.ndarray:
    """Running max or min (fn = np.maximum / np.minimum) over 2r+1 samples along one axis, edges clamped."""
    if r < 1:
        return a
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r, r)
    p = np.pad(a, pad, mode="edge")
    n = a.shape[axis]
    out = np.take(p, range(0, n), axis=axis).copy()
    for k in range(1, 2 * r + 1):
        fn(out, np.take(p, range(k, k + n), axis=axis), out=out)
    return out


def local_max(a: np.ndarray, r: int) -> np.ndarray:
    return _run_extreme(_run_extreme(a, r, 0, np.maximum), r, 1, np.maximum)


def local_min(a: np.ndarray, r: int) -> np.ndarray:
    return _run_extreme(_run_extreme(a, r, 0, np.minimum), r, 1, np.minimum)


EDGE_RATIO = 1.25     # a depth edge: within the window the near side is 25% nearer than the far side...
EDGE_FLOOR = 0.02     # ...and at least this many diopters nearer...
EDGE_STEEP = 0.7      # ...and the change is a step, not a slope: the window holds this much of what twice the window holds
EDGE_BIAS = 0.4       # a pixel in the edge's ramp goes to the near side once it is 40% of the way there


def _edge_gate(d: np.ndarray, reach: int, pool: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Where a (2*reach+1)^2 window holds a depth STEP (EDGE_RATIO, EDGE_FLOOR, EDGE_STEEP: a receding floor or a wall
    at an angle changes as much again over twice the window, a step does not), and the step's height there. Worked
    out on a max/min pool of `pool` px (a little wider than exact, ~10x cheaper at 1080p). -> (gate, height)."""
    h, w = d.shape
    k = pool if min(h, w) >= 8 * pool else 1
    h2, w2 = -(-h // k) * k, -(-w // k) * k
    p = np.pad(d, ((0, h2 - h), (0, w2 - w)), mode="edge").reshape(h2 // k, k, w2 // k, k)
    pmx, pmn = p.max((1, 3)), p.min((1, 3))
    rr = int(math.ceil(reach / k))
    mx, mn = local_max(pmx, rr), local_min(pmn, rr)
    wide = local_max(pmx, 2 * rr) - local_min(pmn, 2 * rr)
    height = mx - mn
    g = (mx > mn * EDGE_RATIO) & (height > EDGE_FLOOR) & (height >= EDGE_STEEP * wide)
    if k > 1:
        g = np.repeat(np.repeat(g, k, 0), k, 1)[:h, :w]
        height = np.repeat(np.repeat(height, k, 0), k, 1)[:h, :w]
    return g, height


def snap_edges(d: np.ndarray, reach: int, step: int = 2, bias: float = EDGE_BIAS) -> np.ndarray:
    """Depth edges made hard again after upsampling: a pixel in the soft ramp between two surfaces gets one surface's
    distance, never an in-between one (an in-between distance is neither in focus nor in the background: it was being
    blurred into the background with the subject's colour, a glow round a sharp subject). Only where the (2*reach+1)^2
    window holds a real depth step (_edge_gate), and only pixels on its ramp (a local change of at least a fifth of
    the step): a receding floor, a wall at an angle or the far distance are left as they are. A toggle filter (Kramer &
    Bruckner): each pass moves a ramp pixel to the nearer of its small window's max and min, so the ramp closes in from
    both ends onto one edge, and a surface between two others keeps its own distance. Near-ties go to the nearer
    surface (bias < 0.5): a sliver of background pasted sharp beside a sharp subject reads as its edge; the subject's
    colour smeared into the background reads as a glow."""
    d = np.asarray(d, np.float32)
    gate, height = _edge_gate(d, reach)
    if not gate.any():
        return d
    rows, cols = np.flatnonzero(gate.any(1)), np.flatnonzero(gate.any(0))
    y0, y1 = max(0, rows[0] - step), min(d.shape[0], rows[-1] + 1 + step)
    x0, x1 = max(0, cols[0] - step), min(d.shape[1], cols[-1] + 1 + step)
    out = d.copy()
    sub, g, need = out[y0:y1, x0:x1], gate[y0:y1, x0:x1], 0.2 * height[y0:y1, x0:x1]
    for _ in range(int(math.ceil(reach / step)) + 1):
        hi, lo = local_max(sub, step), local_min(sub, step)
        span = hi - lo
        ramp = g & (span > need) & (sub > lo) & (sub < hi)
        if not ramp.any():
            break
        t = (sub - lo) / np.maximum(span, 1e-9)
        sub = np.where(ramp, np.where(t >= bias, hi, lo), sub)
    out[y0:y1, x0:x1] = sub
    return out


def full_size(d_small: np.ndarray, gray_full: np.ndarray | None = None, *, native_long: int = 0,
              size: tuple[int, int] | None = None) -> np.ndarray:
    """One frame's working-size diopters -> the take's full size (gray_full's shape, or size = (h, w)): bilinear, then
    the depth steps made hard again (snap_edges: no in-between distances along a silhouette). native_long: the long side
    the depth was measured at, when smaller than d_small (DA3 sees 504 px): its steps are that much softer.

    No guided filter any more (review 2026-11-02): snapping its output to the picture's edges copied texture into the
    depth near every silhouette and moved the edge (2-4% of the pixels landed on the wrong side, against 0-0.1% for
    bilinear + snap on the same tests). The edge sits where the depth put it: as accurate as DA3 at 504 px."""
    h, w = size if size is not None else gray_full.shape
    up = resize_bilinear(d_small, h, w)
    soft = max(h, w) / max(1, min(max(d_small.shape), native_long or max(d_small.shape)))
    if soft <= 1.01:
        return up
    return snap_edges(up, int(math.ceil(2 * soft)) + 2)
