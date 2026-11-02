"""Refocus: where the focus is on every frame (docs/refocus.md). Pure numpy (+ OpenCV for the point tracker).

A focus puller's pull, not a jump: hold on mark A, pull to mark B over the chosen part of the take, settle and hold.
Both marks are tracked through the take (an actor who walks stays sharp until the pull leaves them), the distance under
each is read every frame and smoothed, and the pull eases between the two IN DIOPTERS (1/m), the way a focus ring's
travel runs. The quintic ease (zero speed and acceleration at both ends, no overshoot) is the one Hero Frame Rig's
optical plan uses (hfr_core/optical.py make_plan, MIT); the start and landing are ours to set instead of fixed shares.
"""
from __future__ import annotations

import numpy as np

T_STOPS = (1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0)
LIMITS = {"t_stop": (0.7, 32.0), "focal_mm": (8.0, 300.0), "sensor_mm": (8.0, 70.0), "subject_m": (0.2, 200.0)}


def parse_point(v, default=None):
    """'0.42,0.6' | [0.42, 0.6] | {x, y} -> (x, y) in 0..1, or default."""
    try:
        if isinstance(v, dict):
            x, y = v.get("x"), v.get("y")
        elif isinstance(v, (list, tuple)):
            x, y = v[0], v[1]
        else:
            x, y = str(v).replace(";", ",").split(",")[:2]
        x, y = float(x), float(y)
    except (TypeError, ValueError, IndexError, AttributeError):
        return default
    if not (np.isfinite(x) and np.isfinite(y)):
        return default
    return (min(1.0, max(0.0, x)), min(1.0, max(0.0, y)))


def bounded(v, key: str, default: float) -> float:
    lo, hi = LIMITS[key]
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if not np.isfinite(x) else min(hi, max(lo, x))


def quintic(t):
    """0 -> 1 with zero velocity and acceleration at both ends (no overshoot)."""
    t = np.clip(np.asarray(t, np.float64), 0, 1)
    return t * t * t * (10 + t * (-15 + 6 * t))


def window(start: float, land: float) -> tuple[float, float, list[str]]:
    """The pull's start and landing as shares of the take, kept sane (a pull needs some time)."""
    notes = []
    try:
        s, e = float(start), float(land)
    except (TypeError, ValueError):
        s, e = 0.25, 0.75
    s, e = min(0.95, max(0.0, s)), min(1.0, max(0.05, e))
    if e - s < 0.05:
        e = min(1.0, s + 0.05)
        s = e - 0.05
        notes.append("the pull needs at least 5% of the take: the landing moved")
    return s, e, notes


def focus_curve(d_a, d_b, start: float, land: float) -> np.ndarray:
    """Focus in diopters per frame: A's distance until `start`, eased to B's by `land`, then B's. d_a / d_b are the
    per-frame distances (diopters) under the tracked marks (a scalar holds a fixed mark)."""
    a = np.atleast_1d(np.asarray(d_a, np.float64))
    b = np.atleast_1d(np.asarray(d_b, np.float64))
    n = max(len(a), len(b))
    a = np.broadcast_to(a, (n,)) if len(a) == 1 else a
    b = np.broadcast_to(b, (n,)) if len(b) == 1 else b
    t = np.linspace(0, 1, n) if n > 1 else np.zeros(1)
    e = quintic((t - start) / max(1e-6, land - start))
    return a * (1 - e) + b * e


def patch_level(d: np.ndarray, x: int, y: int, r: int = 4) -> float:
    """Trimmed mean of a (2r+1)^2 patch: the distance under a mark, steady against single noisy pixels.
    From Hero Frame Rig's hfr_core/_support.py patch_level (MIT)."""
    p = np.sort(d[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1].ravel())
    k = len(p) // 4
    return float(p[k:len(p) - k].mean())


def sample_series(depth: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """The distance under a moving mark on every frame. depth [N,H,W]; pts [N,2] normalised x, y."""
    n, h, w = depth.shape
    out = np.empty(n, np.float64)
    for i in range(n):
        x, y = pts[min(i, len(pts) - 1)]
        out[i] = patch_level(depth[i], int(round(x * (w - 1))), int(round(y * (h - 1))), r=max(2, min(h, w) // 120))
    return out


def smooth_series(v: np.ndarray, size: int = 9) -> np.ndarray:
    """A 5-frame median (drops a frame where the mark slipped onto the background) then a centred mean over `size`
    frames (a focus puller's hand is not a step function)."""
    v = np.asarray(v, np.float64)
    n = len(v)
    if n < 3:
        return v.copy()
    k = 2
    p = np.pad(v, k, mode="edge")
    med = np.median(np.stack([p[i:i + n] for i in range(2 * k + 1)]), 0)
    k = min(size // 2, (n - 1) // 2)
    if k < 1:
        return med
    p = np.pad(med, k, mode="edge")
    return np.convolve(p, np.ones(2 * k + 1) / (2 * k + 1), mode="valid")


def track_point(grays: list[np.ndarray] | np.ndarray, x: float, y: float, frame: int) -> np.ndarray:
    """A mark tapped on `frame`, followed forward and backward through the take with pyramidal Lucas-Kanade (a small
    patch around the mark, forward-backward checked). Where it is lost it holds its last good place. -> [N,2] in 0..1.
    Without OpenCV the mark stays where it was tapped."""
    n = len(grays)
    pts = np.tile(np.array([[x, y]], np.float64), (n, 1))
    if n < 2:
        return pts
    try:
        import cv2
    except Exception:  # noqa: BLE001
        return pts
    h, w = grays[0].shape[:2]
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    # a few points around the mark, so one bad match does not drag it off
    off = np.array([[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4]], np.float32)

    def run(order):
        cur = np.array([[x * (w - 1), y * (h - 1)]], np.float32) + off
        prev_i = order[0]
        for i in order[1:]:
            g0, g1 = grays[prev_i], grays[i]
            p1, st, _ = cv2.calcOpticalFlowPyrLK(g0, g1, cur.reshape(-1, 1, 2), None, **lk)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(g1, g0, p1, None, **lk)
            ok = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm(back.reshape(-1, 2) - cur, axis=1) < 1.0)
            if ok.sum() >= 2:
                shift = np.median(p1.reshape(-1, 2)[ok] - cur[ok], 0)
                cur = cur + shift
            c = cur[0]
            pts[i] = (min(1, max(0, c[0] / (w - 1))), min(1, max(0, c[1] / (h - 1))))
            prev_i = i

    frame = int(min(n - 1, max(0, frame)))
    run(list(range(frame, n)))
    run(list(range(frame, -1, -1)))
    return pts


def sharpness(gray: np.ndarray, x: float, y: float, r: int = 12) -> float:
    """Detail around a point (variance of a 4-neighbour Laplacian), relative to the whole frame's. Under ~0.35 the
    spot is already soft in the picture: a pull that lands there lands on blur the generation baked in."""
    g = np.asarray(gray, np.float32)
    lap = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])
    h, w = lap.shape
    cx, cy = int(round(x * (w - 1))), int(round(y * (h - 1)))
    patch = lap[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
    ref = float(np.percentile(lap, 90)) + 1e-6
    return float(np.percentile(patch, 90)) / ref if patch.size else 0.0
