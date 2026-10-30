"""Camera trajectory from per-frame depth (CPU: numpy + OpenCV; the depth itself came through the queue).

Conventions: OpenCV camera space (x right, y down, z forward). A pose is a world-to-camera [R|t] (3x4) in the
FIRST camera's space, so pose[0] = [I|0]. Distances are in the first frame's depth units until
world_frame() scales them to metres.

Two paths:
- multi-view DA3 (Small/Base) gives extrinsics directly: we re-base them on frame 0;
- mono DA3 (what the pod has): track corners with pyramidal Lucas-Kanade, lift them to 3D with frame i's
  depth, solvePnPRansac into frame i+1, and re-scale frame i+1's depth to agree with the chain (mono depth is
  only known up to a per-frame scale). Moving things are RANSAC outliers.
"""
from __future__ import annotations

import math

import numpy as np


def unproject(uv: np.ndarray, z: np.ndarray, K: np.ndarray) -> np.ndarray:
    """Pixels (N,2) with depth (N,) -> points (N,3) in camera space."""
    x = (uv[:, 0] - K[0, 2]) / K[0, 0] * z
    y = (uv[:, 1] - K[1, 2]) / K[1, 1] * z
    return np.stack([x, y, z], 1)


def sample_depth(depth: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w = depth.shape
    u = np.clip(np.round(uv[:, 0]).astype(int), 0, w - 1)
    v = np.clip(np.round(uv[:, 1]).astype(int), 0, h - 1)
    return depth[v, u]


def valid_mask(depth: np.ndarray, sky: np.ndarray | None = None) -> np.ndarray:
    m = np.isfinite(depth) & (depth > 0)
    if sky is not None:
        m &= sky < 0.5
    if m.any():
        m &= depth < np.percentile(depth[m], 98) * 1.5
    return m


def fit_ground(depth: np.ndarray, K: np.ndarray, mask: np.ndarray, iters: int = 300, seed: int = 0):
    """RANSAC plane through the lower part of the frame. Returns (n, d, inlier_ratio) with n·p + d = 0, n pointing
    up (toward -y in camera space) and d > 0 the camera's height above it; or None."""
    h, w = depth.shape
    vs, us = np.mgrid[int(h * 0.45):h:4, 0:w:4]
    uv = np.stack([us.ravel(), vs.ravel()], 1).astype(np.float64)
    keep = mask[uv[:, 1].astype(int), uv[:, 0].astype(int)]
    uv = uv[keep]
    if len(uv) < 50:
        return None
    P = unproject(uv, sample_depth(depth, uv).astype(np.float64), K)
    rng = np.random.default_rng(seed)
    scale = float(np.median(P[:, 2]))
    tol = 0.02 * scale
    best = None
    for _ in range(iters):
        a, b, c = P[rng.choice(len(P), 3, replace=False)]
        n = np.cross(b - a, c - a)
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n /= nn
        if n[1] > 0:
            n = -n
        if -n[1] < math.cos(math.radians(60)):   # a ground must face up-ish
            continue
        d = -float(n @ a)
        if d <= 0:
            continue
        inl = np.abs(P @ n + d) < tol
        if best is None or inl.sum() > best[2].sum():
            best = (n, d, inl)
    if best is None:
        return None
    n, d, inl = best
    if inl.sum() >= 3:   # least-squares refit on the inliers
        Q = P[inl]
        c = Q.mean(0)
        _, _, vt = np.linalg.svd(Q - c)
        n2 = vt[-1]
        if n2[1] > 0:
            n2 = -n2
        n, d = n2, -float(n2 @ c)
    ratio = float(inl.mean())
    if d <= 0 or ratio < 0.25:
        return None
    return n, d, ratio


def _track(cv2, g0, g1, mask0, max_pts=1500):
    pts = cv2.goodFeaturesToTrack(g0, maxCorners=max_pts, qualityLevel=0.005, minDistance=6,
                                  mask=mask0.astype(np.uint8) * 255, blockSize=7)
    if pts is None or len(pts) < 12:
        return None, None
    lk = dict(winSize=(31, 31), maxLevel=5, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))
    p1, st, _ = cv2.calcOpticalFlowPyrLK(g0, g1, pts, None, **lk)
    p0b, st2, _ = cv2.calcOpticalFlowPyrLK(g1, g0, p1, None, **lk)
    ok = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((pts - p0b).reshape(-1, 2), axis=1) < 1.0)
    return pts.reshape(-1, 2)[ok], p1.reshape(-1, 2)[ok]


def track_mono(grays: list[np.ndarray], depths: list[np.ndarray], K: np.ndarray, skies=None, seed: int = 0):
    """Chain PnP poses through the frames. Returns (poses [N,3,4], scales [N], notes). scales[i] multiplies
    depths[i] into frame-0 units."""
    import cv2
    cv2.setRNGSeed(seed)
    n = len(grays)
    poses = [np.hstack([np.eye(3), np.zeros((3, 1))])]
    scales = [1.0]
    notes = []
    Kd = K.astype(np.float64)
    for i in range(n - 1):
        T_prev = poses[-1]
        m0 = valid_mask(depths[i], None if skies is None else skies[i])
        if m0.any():   # the farthest quarter is soft, aliased detail that biases the pose; track what is nearer
            m0 &= depths[i] < np.percentile(depths[i][m0], 75)
        p0, p1 = _track(cv2, grays[i], grays[i + 1], m0)
        R, t, used = None, None, 0
        if p0 is not None and len(p0) >= 12:
            z0 = sample_depth(depths[i], p0).astype(np.float64) * scales[i]
            good = np.isfinite(z0) & (z0 > 0)
            P = unproject(p0[good].astype(np.float64), z0[good], Kd)
            q = p1[good].astype(np.float64)
            if len(P) >= 12:
                ok, rv, tv, inl = cv2.solvePnPRansac(P, q, Kd, None, iterationsCount=400, reprojectionError=2.5,
                                                     confidence=0.999, flags=cv2.SOLVEPNP_SQPNP)
                if ok and inl is not None and len(inl) >= 10:
                    idx = inl.ravel()
                    ok, rv, tv = cv2.solvePnP(P[idx], q[idx], Kd, None, rv, tv, True, cv2.SOLVEPNP_ITERATIVE)
                    R, _ = cv2.Rodrigues(rv)
                    t, used = tv.reshape(3), len(idx)
                    # Re-scale frame i+1's depth so it agrees with the chain.
                    zp = (P[idx] @ R.T + t)[:, 2]
                    z1 = sample_depth(depths[i + 1], q[idx]).astype(np.float64)
                    r = zp / np.where(z1 > 0, z1, np.nan)
                    near = zp <= np.percentile(zp, 60)   # far texture is soft and aliased: measure scale up close
                    r = r[near & np.isfinite(r) & (r > 0)]
                    scales.append(float(np.median(r)) if len(r) >= 5 else scales[i])
        if R is None:
            notes.append(f"frames {i}->{i + 1}: not enough trackable detail; held the camera")
            R, t = np.eye(3), np.zeros(3)
            scales.append(scales[i])
        # world(cam0) -> cam_{i+1} = [R|t] o T_prev
        Rp, tp = T_prev[:, :3], T_prev[:, 3]
        poses.append(np.hstack([R @ Rp, (R @ tp + t).reshape(3, 1)]))
        _ = used
    return np.array(poses), np.array(scales), notes


def rebase_extrinsics(ext: np.ndarray) -> np.ndarray:
    """Multi-view world-to-camera [R|t] (N,3,4) -> the same poses in camera 0's space."""
    E0 = np.vstack([ext[0], [0, 0, 0, 1]])
    E0i = np.linalg.inv(E0)
    out = []
    for E in ext:
        M = np.vstack([E, [0, 0, 0, 1]]) @ E0i
        out.append(M[:3])
    return np.array(out)


def camera_center(pose: np.ndarray) -> np.ndarray:
    R, t = pose[:, :3], pose[:, 3]
    return -R.T @ t


def camera_forward(pose: np.ndarray) -> np.ndarray:
    return pose[:, :3].T @ np.array([0.0, 0.0, 1.0])


def world_frame(ground, metres_per_unit: float, default_height_units: float = 1.0):
    """cam0 space -> stage space (metres, Y up, ground y=0, camera 0 looking along +Z, +X screen-left).

    Returns (A 3x3, b 3) with stage = A @ p_cam0 + b. Without a ground plane the first camera is taken as
    level, `default_height_units` above the floor."""
    if ground is not None:
        n, d = np.asarray(ground[0], float), float(ground[1])
    else:
        n, d = np.array([0.0, -1.0, 0.0]), float(default_height_units)
    y = n / np.linalg.norm(n)
    f = np.array([0.0, 0.0, 1.0])
    z = f - (f @ y) * y
    if np.linalg.norm(z) < 1e-6:   # looking straight down: screen-up becomes north
        z = np.array([0.0, -1.0, 0.0]) - (np.array([0.0, -1.0, 0.0]) @ y) * y
    z /= np.linalg.norm(z)
    x = np.cross(y, z)
    Rw = np.stack([x, y, z])          # rows: stage axes in cam0 coordinates
    A = metres_per_unit * Rw
    b = np.array([0.0, metres_per_unit * d, 0.0])
    return A, b


def ray_to_ground(origin: np.ndarray, direction: np.ndarray, max_dist: float = 400.0):
    """Stage-space ray -> its y=0 hit, or None when it misses or lands beyond max_dist."""
    if direction[1] >= -1e-6:
        return None
    s = -origin[1] / direction[1]
    if s <= 0:
        return None
    hit = origin + s * direction
    if np.hypot(hit[0] - origin[0], hit[2] - origin[2]) > max_dist:
        return None
    return hit


def ground_heights(depths, skies, K, scales, poses, A, max_tilt: float = 15.0, seed: int = 0) -> list:
    """Each frame's own floor fit -> its camera height in stage metres (None where there is no floor, or the floor
    disagrees with frame 0's up by more than max_tilt degrees)."""
    mpu = float(np.linalg.norm(A[0]))
    Rw = A / mpu
    out = []
    for i, d in enumerate(depths):
        g = fit_ground(d, K, valid_mask(d, None if skies is None else skies[i]), seed=seed)
        if g is None:
            out.append(None)
            continue
        up = Rw @ (poses[i][:, :3].T @ g[0])
        tilt = math.degrees(math.acos(min(1.0, max(-1.0, float(up[1])))))
        out.append(float(g[1] * scales[i] * mpu) if tilt <= max_tilt else None)
    return out


def repin_heights(poses, heights, A, b):
    """Mono depth drifts in scale along a PnP chain. Where a frame measured its own camera height, trust it: pin the
    camera's height there and scale the travel since the previous frame by the same correction. Returns
    (poses, corrections)."""
    centers = [A @ camera_center(P) + b for P in poses]
    ys = [c[1] for c in centers]
    r = []
    for H, y in zip(heights, ys):
        r.append(H / y if (H is not None and y > 1e-3) else None)
    r[0] = 1.0
    known = [i for i, v in enumerate(r) if v is not None]
    vals = np.interp(range(len(r)), known, [r[i] for i in known])
    if len(vals) >= 3:   # one bad floor fit must not kink the path
        vals = np.array([vals[0]] + [float(np.median(vals[max(0, i - 1):i + 2])) for i in range(1, len(vals) - 1)]
                        + [vals[-1]])
    new = [centers[0]]
    for i in range(1, len(centers)):
        k = (vals[i - 1] + vals[i]) / 2
        new.append(new[-1] + k * (centers[i] - centers[i - 1]))
        if heights[i] is not None:
            new[-1][1] = heights[i]
    Ainv = np.linalg.inv(A)
    out = []
    for P, c in zip(poses, new):
        C = Ainv @ (c - b)
        R = P[:, :3]
        out.append(np.hstack([R, (-R @ C).reshape(3, 1)]))
    return np.array(out), [round(float(v), 3) for v in vals]


def horizon_row(sky: np.ndarray, min_cols: float = 0.15):
    """Where the horizon crosses the image, from the sky mask: the bottom of the sky in each column, taken from the
    lowest quarter (terrain only ever raises it; open sea or plain gives the true line). None without enough sky."""
    s = sky >= 0.5
    h, w = s.shape
    top = s[0]
    if top.mean() < min_cols:
        return None
    first_ground = np.argmax(~s, axis=0).astype(float)   # first non-sky row from the top
    first_ground[~top] = np.nan
    first_ground[s.all(axis=0)] = np.nan
    v = first_ground[np.isfinite(first_ground)]
    if len(v) < min_cols * w:
        return None
    return float(np.percentile(v, 80))


def ground_from_horizon(v_h: float, K: np.ndarray, height_units: float):
    """Floor plane (n, d) for a camera whose horizon sits at row v_h (no roll): depth-free, so it does not inherit
    mono depth's non-linear compression (DA3 mono flattens far ground, which levels a depth-fitted plane)."""
    theta = math.atan2(K[1, 2] - v_h, K[1, 1])   # > 0: looking down
    n = np.array([0.0, -math.cos(theta), -math.sin(theta)])
    return n, float(height_units), 1.0


def linearize(depth: np.ndarray, v_h: float | None, K: np.ndarray, mask: np.ndarray):
    """Mono depth -> depth proportional to true depth, using the floor: below a level-ish horizon, true inverse
    depth on flat ground grows linearly with the rows under the horizon, so fit depth^p to it on the bottom-centre
    ground. Returns (depth, p); p = 1 (unchanged) when there is no horizon or no clean floor."""
    if v_h is None:
        return depth, 1.0
    h, w = depth.shape
    v0 = int(max(v_h + 0.25 * (h - v_h), v_h + 8))
    if v0 >= h - 8:
        return depth, 1.0
    vs, us = np.mgrid[v0:h:3, int(w * 0.3):int(w * 0.7):3]
    d = depth[vs, us]
    ok = mask[vs, us] & np.isfinite(d) & (d > 0)
    if ok.sum() < 60:
        return depth, 1.0
    x = np.log(d[ok])
    y = np.log(1.0 / (vs[ok] - v_h))
    A = np.vstack([x, np.ones_like(x)]).T
    for _ in range(2):   # trim off-floor pixels (kerbs, cars) and refit
        c, *_ = np.linalg.lstsq(A, y, rcond=None)
        r = np.abs(A @ c - y)
        keep = r < max(np.percentile(r, 80), 1e-6)
        A, y = A[keep], y[keep]
    c, *_ = np.linalg.lstsq(A, y, rcond=None)
    p = float(c[0])
    corr = float(np.corrcoef(A[:, 0], y)[0, 1]) if len(y) > 2 else 0.0
    if not (0.3 <= p <= 3.0) or corr < 0.9:
        return depth, 1.0
    out = np.where(np.isfinite(depth) & (depth > 0), np.power(np.maximum(depth, 1e-9), p), depth)
    return out.astype(np.float32), p
