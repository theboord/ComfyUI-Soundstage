"""LAYOUT, step 5: things that move, on EVERY frame, as keyed paths with heading.

CPU only. For every frame a mover's mask is seen, its ground contact (the bottom of the mask, cast through that
frame's solved camera onto the ground plane y = 0) plus half its measured footprint along the view gives the box
centre; frames where the contact is hidden (cut by the frame edge, or something airborne) fall back to the DA3 depth
of the nearest sample, scaled by the mask's size. The path is smoothed lightly (a 5-frame median, then [1 2 1]).

Heading: vehicles point along the motion, but a car may reverse (a J-turn): of the motion direction and its reverse,
the one closer to the previous heading wins, starting from the measured long axis. Animals and others follow motion.

Keys: every frame, then simplified with a 5 cm / 2 deg tolerance (Ramer-Douglas-Peucker on position and heading);
keys carry heading_deg (unwrapped), so the stage plays the nose exactly as solved. A thing that enters or leaves
mid-shot is parked off-frame on its entry / exit ray (keyed only while visible): the stage shows nothing that is not
in the plate. Works in METRES (assemble() calls it after the scale is known).
"""
from __future__ import annotations

import math

import numpy as np

from . import context as X
from . import measure as M

FPS = 24


def _ray(ctx, f, uv):
    K = X.K_at(ctx, f)
    P = X.pose_at(ctx, f)
    d = np.linalg.inv(K) @ np.array([uv[0], uv[1], 1.0])
    d = P[:3, :3] @ d
    return P[:3, 3].copy(), d / np.linalg.norm(d)


def ground_hit(ctx, f, uv, y: float = 0.0, max_dist: float = 600.0):
    o, d = _ray(ctx, f, uv)
    if d[1] >= -1e-4:
        return None, d
    t = (y - o[1]) / d[1]
    if not (0 < t < max_dist):
        return None, d
    return o + d * t, d


def centre_at(ctx: dict, f: int, st: dict, rec: dict, mpu: float) -> np.ndarray | None:
    """Box centre (world, metres) at frame f from the mask stats {bbox, c, bottom, edge} and the measured box."""
    x0, y0, x1, y1 = st["bbox"]
    ph = ctx["clip"]["ph"]
    hidden_bottom = y1 >= ph - 2
    dims = np.array(rec["dims"], float) * mpu
    if not hidden_bottom and rec.get("grounded", True):
        p, d = ground_hit(ctx, f, (st["c"][0], st.get("bottom", y1)))
        if p is not None:
            hz = np.array([d[0], 0.0, d[2]])
            hz /= (np.linalg.norm(hz) or 1)
            half = 0.5 * min(dims[0], dims[2])
            c = p + hz * half
            c[1] = dims[1] / 2
            return c
    # Depth: the nearest DA3 sample's depth of this thing, carried by how much bigger / smaller it looks now.
    zs = rec.get("zs") or {}
    if zs:
        s = min(zs, key=lambda k: abs(int(k) - f))
        z_s, a_s = zs[s]
        z = z_s * mpu * math.sqrt(max(a_s, 1.0) / max(float(st["area"]), 1.0))
    else:   # no sample: its height in pixels against its measured height
        K = X.K_at(ctx, f)
        z = K[1, 1] * dims[1] / max(2.0, y1 - y0)
    o, d = _ray(ctx, f, st["c"])
    Pc = np.linalg.inv(X.pose_at(ctx, f))
    zc = (Pc[:3, :3] @ d)[2]
    c = o + d * (z / max(zc, 1e-3))
    if rec.get("grounded", True):
        c[1] = dims[1] / 2
    return c


def _median5(a: np.ndarray) -> np.ndarray:
    if len(a) < 5:
        return a
    out = a.copy()
    for i in range(len(a)):
        lo, hi = max(0, i - 2), min(len(a), i + 3)
        out[i] = np.median(a[lo:hi], 0)
    return out


def _smooth(a: np.ndarray) -> np.ndarray:
    if len(a) < 3:
        return a
    out = a.copy()
    out[1:-1] = (a[:-2] + 2 * a[1:-1] + a[2:]) / 4
    return out


def wrap(d: float) -> float:
    return (d + 180.0) % 360.0 - 180.0


def headings(pos: np.ndarray, start_deg: float | None, vehicle: bool, still: float = 0.25 / FPS) -> list[float]:
    """Unwrapped heading (deg) per frame: along the motion; a vehicle may drive backwards (the closer of motion and
    its reverse to the previous heading); held while (nearly) still."""
    n = len(pos)
    v = np.zeros((n, 2))
    if n > 1:
        # Velocity over +-4 frames (a mask centroid jitters frame to frame, a car's nose does not), but never across
        # a stop: a car that halts and reverses must not average the two directions into a sideways slide.
        inst = np.zeros(n)
        inst[1:-1] = np.linalg.norm(pos[2:, [0, 2]] - pos[:-2, [0, 2]], axis=1) / 2
        inst[0], inst[-1] = inst[min(1, n - 1)], inst[max(n - 2, 0)]
        # a stop: the speed's local minimum below 40 % of the run's speed, or nearly still
        stop = inst < still
        for i in range(1, n - 1):
            if inst[i] <= inst[i - 1] and inst[i] <= inst[i + 1] and inst[i] < 0.4 * max(inst[max(0, i - 6):i + 7].max(), 1e-9):
                stop[i] = True
        run = np.cumsum(stop)
        k = min(4, max(1, (n - 1) // 2))
        for i in range(n):
            a, b = max(0, i - k), min(n - 1, i + k)
            while a < i and run[a] != run[i]:
                a += 1
            while b > i and run[b] != run[i]:
                b -= 1
            if b == a:
                a, b = max(0, i - 1), min(n - 1, i + 1)
            if b > a:
                v[i] = (pos[b, [0, 2]] - pos[a, [0, 2]]) / (b - a)
    sp = np.linalg.norm(v, axis=1)
    out = []
    prev = start_deg
    for i in range(n):
        if sp[i] > still:
            h = math.degrees(math.atan2(v[i, 0], v[i, 1]))
            if prev is None:
                prev = h
            if vehicle:
                alt = h + 180.0
                h = h if abs(wrap(h - prev)) <= abs(wrap(alt - prev)) else alt
            prev = prev + wrap(h - prev)
        out.append(prev if prev is not None else (start_deg or 0.0))
    # Before the first motion: the first moving heading.
    first = next((i for i in range(n) if sp[i] > still), None)
    if first is not None:
        for i in range(first):
            out[i] = out[first]
    return out


def simplify(frames: list[int], pos: np.ndarray, hdg: list[float], pos_tol: float = 0.05, ang_tol: float = 2.0) -> list[int]:
    """Indices to keep (RDP on position + heading, linear interpolation in frames)."""
    n = len(frames)
    if n <= 2:
        return list(range(n))
    H = np.array(hdg, float)

    def err(a, z, i):
        u = (frames[i] - frames[a]) / max(1e-6, frames[z] - frames[a])
        pe = float(np.linalg.norm(pos[a] + (pos[z] - pos[a]) * u - pos[i]))
        he = abs(H[a] + (H[z] - H[a]) * u - H[i])
        return max(pe / pos_tol, he / ang_tol)

    keep = {0, n - 1}
    stack = [(0, n - 1)]
    while stack:
        a, z = stack.pop()
        if z - a < 2:
            continue
        e, i = max((err(a, z, i), i) for i in range(a + 1, z))
        if e > 1:
            keep.add(i)
            stack += [(a, i), (i, z)]
    return sorted(keep)


def in_view(ctx, f, p, margin: float = 0.0) -> bool:
    uv, z = X.world_to_pixel(ctx, f, np.asarray(p, float)[None])
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    return bool(z[0] > 0 and -margin * pw <= uv[0, 0] <= pw * (1 + margin) and -margin * ph <= uv[0, 1] <= ph * (1 + margin))


def park(ctx, f, p, vel, extent: float, steps: int = 60) -> np.ndarray:
    """Slide p back along -vel (or on along +vel) until it is out of camera f's view, beyond its own size."""
    v = np.array([vel[0], 0.0, vel[2]])
    if np.linalg.norm(v) < 1e-6:
        return np.asarray(p, float)
    v /= np.linalg.norm(v)
    q = np.asarray(p, float).copy()
    stepm = max(0.5, extent)
    for _ in range(steps):
        if not in_view(ctx, f, q, margin=0.05) and not in_view(ctx, f, q + v * extent / 2, 0.05) \
                and not in_view(ctx, f, q - v * extent / 2, 0.05):
            return q + v * extent   # one more body length: no corner pokes in
        q = q + v * stepm
    return q


def path(ctx: dict, oid: str, rec: dict, mpu: float, kind: str) -> dict | None:
    """-> {frames, pos (n,3) metres, heading_deg, keys, coverage, entered, left}."""
    seg = (ctx.get("seg") or {}).get(oid)
    if not seg:
        return None
    fr = sorted(seg["frames"])
    pts, keep = [], []
    for f in fr:
        c = centre_at(ctx, f, seg["frames"][f], rec, mpu)
        if c is not None and np.all(np.isfinite(c)):
            pts.append(c)
            keep.append(f)
    if len(pts) < 2:
        return None
    pos = _smooth(_median5(np.array(pts)))
    vehicle = M.base_kind(kind) in M.VEHICLE
    hdg = headings(pos, rec.get("yaw_deg"), vehicle)
    idx = simplify(keep, pos, hdg)
    keys = [{"frame": int(keep[i]), "position": [round(float(pos[i][0]), 3), 0.0, round(float(pos[i][2]), 3)],
             "heading_deg": round(float(hdg[i]), 1)} for i in idx]
    n_frames = int(ctx["clip"]["frames"])
    ext = float(max(rec["dims"][0], rec["dims"][2]) * mpu)
    entered = keep[0] > 0
    left = keep[-1] < n_frames - 1
    if entered:
        v = pos[min(3, len(pos) - 1)] - pos[0]
        p0 = park(ctx, 0, pos[0], -v, ext)
        keys.insert(0, {"frame": 0, "position": [round(float(p0[0]), 3), 0.0, round(float(p0[2]), 3)],
                        "heading_deg": round(float(hdg[0]), 1)})
        if keep[0] > 1:   # stays parked until just before it shows
            keys.insert(1, dict(keys[0], frame=int(keep[0]) - 1))
    if left:
        v = pos[-1] - pos[max(0, len(pos) - 4)]
        p1 = park(ctx, n_frames - 1, pos[-1], v, ext)
        if keep[-1] < n_frames - 2:
            keys.append({"frame": int(keep[-1]) + 1, "position": [round(float(p1[0]), 3), 0.0, round(float(p1[2]), 3)],
                         "heading_deg": round(float(hdg[-1]), 1)})
        keys.append({"frame": n_frames - 1, "position": [round(float(p1[0]), 3), 0.0, round(float(p1[2]), 3)],
                     "heading_deg": round(float(hdg[-1]), 1)})
    return {"frames": keep, "pos": pos, "heading_deg": hdg, "keys": keys, "coverage": len(keep) / max(1, n_frames),
            "entered": entered, "left": left}
