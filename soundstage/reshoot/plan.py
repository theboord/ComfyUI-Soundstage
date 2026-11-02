"""Reshoot: put the camera somewhere else on a take you already have (docs/reshoot.md). The maths, CPU only.

The take is measured as a 3D scene, frame by frame (Depth Anything 3 depth, the same model Video -> Stage uses), and the
camera is re-aimed *relative to the original camera on every frame*, so the original move (a pan, a push, handheld)
is kept and offset:

  orbit   the camera swings around the subject (the depth at the middle of the frame), left or right, up to +-15 deg
  tilt    the camera rises or drops around the subject (a small jib), up to +-8 deg
  dolly   the camera moves in or out along its axis, up to 25% of the subject distance
  lens    a longer or wider lens on the same spot, 0.7x - 1.6x the focal length

Everything is a ratio of the subject distance, so the per-frame scale of mono depth never matters. Beyond these caps
the new view sees around things the original camera never saw and the render has to invent them; the caps are where
the result stays real (PLAN.md flaw 4). The App says so and clamps.

warp() forward-splats every frame into the new camera with a z-buffer, then fills what the new camera sees but the
old one didn't from the background side (the far neighbour), which is how a set extension is painted. The warped
depth becomes the union-control guide; the warped frame 1 becomes the render's first frame.
"""
from __future__ import annotations

import math

import numpy as np

LIMITS = {"orbit_deg": (-15.0, 15.0), "tilt_deg": (-8.0, 8.0), "dolly": (-0.25, 0.25), "lens": (0.7, 1.6)}
DEFAULT = {"orbit_deg": 0.0, "tilt_deg": 0.0, "dolly": 0.0, "lens": 1.0}
FAR = 40.0       # past 40x the subject distance = at infinity (sky, far hills)
INF = 1e4
CRACK = 2        # gaps this thin are splat cracks, not disocclusions
PRESETS = {
    "orbit_left": {"orbit_deg": -10.0}, "orbit_right": {"orbit_deg": 10.0},
    "push_in": {"dolly": 0.15}, "pull_out": {"dolly": -0.15},
    "longer_lens": {"lens": 1.35}, "wider_lens": {"lens": 0.8},
    "higher": {"tilt_deg": 6.0}, "lower": {"tilt_deg": -6.0},
}


def clamp(move: dict | None) -> tuple[dict, list[str]]:
    """A move inside the safe range, plus what was clamped (plain words)."""
    out, notes = dict(DEFAULT), []
    for k, (lo, hi) in LIMITS.items():
        try:
            v = float((move or {}).get(k, DEFAULT[k]))
        except (TypeError, ValueError):
            v = DEFAULT[k]
        if not math.isfinite(v):
            v = DEFAULT[k]
        if v < lo or v > hi:
            notes.append(f"{k.replace('_deg', '')} {v:g} is past the range that stays real; held at {min(hi, max(lo, v)):g}")
        out[k] = min(hi, max(lo, v))
    return out, notes


def is_identity(move: dict) -> bool:
    return all(abs(move[k] - DEFAULT[k]) < 1e-6 for k in DEFAULT)


def describe(move: dict) -> str:
    """The move in film words, for the prompt and the take label."""
    parts = []
    if abs(move["orbit_deg"]) > 0.05:
        parts.append(f"orbits {abs(move['orbit_deg']):.0f} degrees to the {'right' if move['orbit_deg'] > 0 else 'left'} around the subject")
    if abs(move["tilt_deg"]) > 0.05:
        parts.append(f"rises {move['tilt_deg']:.0f} degrees" if move["tilt_deg"] > 0 else f"drops {-move['tilt_deg']:.0f} degrees")
    if abs(move["dolly"]) > 0.005:
        parts.append(f"dollies in {move['dolly'] * 100:.0f}%" if move["dolly"] > 0
                     else f"dollies out {abs(move['dolly']) * 100:.0f}%")
    if abs(move["lens"] - 1) > 0.005:
        parts.append(f"a {'longer' if move['lens'] > 1 else 'wider'} lens ({move['lens']:.2f}x)")
    return ", ".join(parts) or "the same camera"


def _ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def new_camera(move: dict, pivot_z: float) -> tuple[np.ndarray, np.ndarray]:
    """(R, C): the new camera's axes (columns, in the old camera's space; OpenCV x right, y down, z forward) and its
    centre C. Points map old -> new as X' = R.T @ (X - C). The pivot (0, 0, pivot_z) stays in the middle of the frame
    for orbit and tilt. +orbit = the camera moves to its right, +tilt = it rises, +dolly = it moves in."""
    P = np.array([0.0, 0.0, float(pivot_z)])
    R = _ry(-math.radians(move["orbit_deg"])) @ _rx(-math.radians(move["tilt_deg"]))
    C = P + R @ (-P)
    C = C + R @ np.array([0.0, 0.0, move["dolly"] * float(pivot_z)])
    return R, C


def pivot_depth(depth: np.ndarray) -> float:
    """The subject distance: the near side (35th percentile) of the depth in the middle of the frame (the middle
    half across, the middle 60% down), so the orbit turns around the people, not the ground or the hills behind."""
    h, w = depth.shape
    mid = depth[int(h * 0.2): int(h * 0.8), w // 4: 3 * w // 4]
    v = mid[np.isfinite(mid) & (mid > 0)]
    if v.size == 0:
        v = depth[np.isfinite(depth) & (depth > 0)]
    return float(np.percentile(v, 35)) if v.size else 1.0


def smooth(values, k: int = 25) -> np.ndarray:
    """Running median (the pivot must not jitter frame to frame)."""
    a = np.asarray(values, np.float64)
    r = k // 2
    p = np.pad(a, r, mode="edge")
    return np.array([np.median(p[i:i + k]) for i in range(len(a))])


def intrinsics(width: int, height: int, hfov_deg: float = 50.0) -> np.ndarray:
    f = 0.5 * width / math.tan(math.radians(hfov_deg) / 2)
    return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1.0]])


def warp(rgb: np.ndarray, depth: np.ndarray, K: np.ndarray, move: dict, pivot_z: float,
         fill: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One frame into the new camera. rgb [H,W,3] uint8, depth [H,W] (any scale). Returns (rgb, depth, hole) at the
    same size; hole = True where the new camera sees what the old one didn't (filled from the background side)."""
    h, w = depth.shape
    R, C = new_camera(move, pivot_z)
    K2 = K.copy()
    K2[0, 0] *= move["lens"]
    K2[1, 1] *= move["lens"]
    # supersample when the new view magnifies (longer lens, dolly in), so the splat has no cracks
    mag = move["lens"] / max(0.3, 1 - move["dolly"])
    k = int(math.ceil(mag * 1.25)) if mag > 1.05 else 1     # small orbits: the few cracks are filled below
    if k > 1:
        rgb_s = np.repeat(np.repeat(rgb, k, 0), k, 1)
        dep_s = np.repeat(np.repeat(depth, k, 0), k, 1)
        ys, xs = np.mgrid[0:h * k, 0:w * k].astype(np.float64)
        xs, ys = (xs + 0.5) / k - 0.5, (ys + 0.5) / k - 0.5
    else:
        rgb_s, dep_s = rgb, depth
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    z = dep_s.astype(np.float64).ravel()
    # Sky and anything past FAR x the subject distance (or with no depth) is at infinity: it only turns with the
    # camera, it never slides. Mono depth puts the sky at some large, noisy number, which would smear it.
    far = ~(np.isfinite(z) & (z > 0)) | (z > FAR * pivot_z)
    z = np.where(far, INF * pivot_z, z)
    x = (xs.ravel() - K[0, 2]) / K[0, 0] * z
    y = (ys.ravel() - K[1, 2]) / K[1, 1] * z
    X = np.stack([x, y, z], 1)
    col = rgb_s.reshape(-1, 3)
    Xn = (X - C) @ R            # == (R.T @ (X - C).T).T
    zn = Xn[:, 2]
    front = zn > 1e-6
    Xn, zn, col = Xn[front], zn[front], col[front]
    u = np.round(K2[0, 0] * Xn[:, 0] / zn + K2[0, 2]).astype(np.int64)
    v = np.round(K2[1, 1] * Xn[:, 1] / zn + K2[1, 2]).astype(np.int64)
    inside = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    u, v, zn, col = u[inside], v[inside], zn[inside], col[inside]
    order = np.argsort(-zn)                       # far first, near last: the near point wins
    idx = v[order] * w + u[order]
    out_z = np.full(h * w, np.inf)
    out_c = np.zeros((h * w, 3), np.uint8)
    out_z[idx] = zn[order]
    out_c[idx] = col[order]
    out_z = out_z.reshape(h, w)
    out_c = out_c.reshape(h, w, 3)
    hole = ~np.isfinite(out_z)
    if fill:
        # cracks (1-2 px gaps between splatted points where the view stretches) are not invented picture: close them
        # first, so `hole` is only what the original camera never saw
        out_c, out_z2, hole = _fill_iter(out_c, out_z, hole, CRACK, near=True)
        out_c, out_z = fill_background(out_c, out_z2)
    return out_c, out_z, hole


def _fill_iter(c, z, hole, iters, near=False):
    """Up to `iters` rings: each hole pixel next to a filled one takes its farthest neighbour's depth and colour.
    Propagates source indices (one int per pixel), so the colour is gathered once at the end."""
    H, W = z.shape
    idx = np.arange(H * W, dtype=np.int64).reshape(H, W)
    sgn = -1.0 if near else 1.0            # near: the closest neighbour wins (a crack inside a surface)
    zz = np.where(hole, -np.inf, sgn * z).astype(np.float32)
    for _ in range(iters):
        if not hole.any():
            break
        zp = np.pad(zz, 1, constant_values=-np.inf)
        ip = np.pad(idx, 1)
        best_z = np.full((H, W), -np.inf, np.float32)
        best_i = idx.copy()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            sz = zp[1 + dy: 1 + dy + H, 1 + dx: 1 + dx + W]
            take = sz > best_z
            best_z[take] = sz[take]
            best_i[take] = ip[1 + dy: 1 + dy + H, 1 + dx: 1 + dx + W][take]
        grow = hole & np.isfinite(best_z)
        if not grow.any():
            break
        zz[grow] = best_z[grow]
        idx[grow] = best_i[grow]
        hole = hole & ~grow
    c = c.reshape(-1, 3)[idx.ravel()].reshape(H, W, 3)
    z = np.where(hole, np.inf, sgn * zz).astype(np.float64)
    return c, z, hole


def fill_background(rgb: np.ndarray, depth: np.ndarray, rings: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Fill the holes (depth inf) from the background side: a few rings of farthest-neighbour growth at full size
    (thin disocclusions keep their edges), then what's left from a half-size copy filled the same way, recursively
    (wide frame-edge reveals), so the cost stays linear in the picture."""
    c = rgb.copy()
    z = depth.astype(np.float64).copy()
    hole = ~np.isfinite(z)
    if not hole.any():
        return c, z
    c, z, hole = _fill_iter(c, z, hole, rings)
    if hole.any():
        H, W = z.shape
        if min(H, W) < 8:
            c, z, hole = _fill_iter(c, z, hole, max(H, W))
        else:
            h2, w2 = (H + 1) // 2, (W + 1) // 2
            zp = np.pad(np.where(hole, -np.inf, z), ((0, h2 * 2 - H), (0, w2 * 2 - W)), constant_values=-np.inf)
            cp = np.pad(c, ((0, h2 * 2 - H), (0, w2 * 2 - W), (0, 0)))
            blocks = zp.reshape(h2, 2, w2, 2).transpose(0, 2, 1, 3).reshape(h2, w2, 4)
            k = blocks.argmax(-1)                                  # the farthest valid pixel of each 2x2
            zs = np.take_along_axis(blocks, k[..., None], -1)[..., 0]
            cb = cp.reshape(h2, 2, w2, 2, 3).transpose(0, 2, 1, 3, 4).reshape(h2, w2, 4, 3)
            cs = np.take_along_axis(cb, k[..., None, None], 2)[:, :, 0]
            zs = np.where(np.isfinite(zs), zs, np.inf)
            cs, zs = fill_background(cs, zs, rings)
            up_z = np.repeat(np.repeat(zs, 2, 0), 2, 1)[:H, :W]
            up_c = np.repeat(np.repeat(cs, 2, 0), 2, 1)[:H, :W]
            z = np.where(hole, up_z, z)
            c = np.where(hole[..., None], up_c, c)
    if not np.isfinite(z).all():
        fin = np.isfinite(z)
        z = np.where(fin, z, z[fin].max() if fin.any() else 1.0)
    return c, z


def depth_image(depth: np.ndarray, near: float, far: float) -> np.ndarray:
    """Depth as the union-control guide picture: inverse depth, near = white, one scale for the whole clip."""
    inv = 1.0 / np.maximum(depth, 1e-6)
    lo, hi = 1.0 / far, 1.0 / near
    g = np.clip((inv - lo) / max(hi - lo, 1e-9), 0, 1)
    return (g * 255 + 0.5).astype(np.uint8)


def clip_range(depths) -> tuple[float, float]:
    """(near, far) for depth_image over a whole clip (2nd / 98th percentile), so the guide does not flicker."""
    v = np.concatenate([d[np.isfinite(d) & (d > 0)].ravel()[::7] for d in depths])
    return float(np.percentile(v, 2)), float(np.percentile(v, 98))


def hole_share(holes) -> float:
    """How much of the new view had to be invented (0..1, the mean over the frames)."""
    return float(np.mean([h.mean() for h in holes])) if len(holes) else 0.0


def edge_image(rgb: np.ndarray, lo: int = 60, hi: int = 140) -> np.ndarray:
    """The union-control guide as edges (Canny on the warped frame): it carries hat brims, faces, reins and set lines
    that a depth map smooths away. White edges on black."""
    try:
        import cv2
        g = cv2.cvtColor(np.ascontiguousarray(rgb), cv2.COLOR_RGB2GRAY)
        g = cv2.GaussianBlur(g, (3, 3), 0)
        return cv2.Canny(g, lo, hi)
    except ImportError:
        g = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
        p = np.pad(g, 1, mode="edge")
        m = np.hypot(p[1:-1, 2:] - p[1:-1, :-2], p[2:, 1:-1] - p[:-2, 1:-1])
        return np.where(m > hi * 0.5, 255, 0).astype(np.uint8)


def auto_frame(holes, edge: float = 0.02, max_zoom: float = 1.25) -> float:
    """The extra lens factor that pushes the frame-edge reveals out of the picture: the smallest centred crop (same
    aspect) whose border columns and rows were seen by the original camera on (almost) every frame. 1.0 = no crop."""
    if not len(holes):
        return 1.0
    h = np.mean(np.stack(holes).astype(np.float32), axis=0)
    H, W = h.shape
    cols, rows = h.mean(0), h.mean(1)
    bad_c = cols > edge
    bad_r = rows > edge
    l = int(np.argmax(~bad_c)) if bad_c[0] else 0
    r = int(np.argmax(~bad_c[::-1])) if bad_c[-1] else 0
    t = int(np.argmax(~bad_r)) if bad_r[0] else 0
    b = int(np.argmax(~bad_r[::-1])) if bad_r[-1] else 0
    need = max(2 * max(l, r) / W, 2 * max(t, b) / H)    # a centred crop loses the same on both sides
    return float(min(max_zoom, 1.0 / max(1e-6, 1.0 - need))) if need > 0 else 1.0
