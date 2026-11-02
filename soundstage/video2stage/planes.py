"""LAYOUT, step 4: the structure (floor, walls, ceiling, kerbs, sidewalks, building faces) as measured planes.

CPU only. Every DA3 sample's static pixels (not an object, a person or sky; no depth edges) are lifted to world
points with a surface normal from the depth's own gradient. Then, sequentially:

- horizontal surfaces are peaks of the height histogram of the up-facing points: the floor / road at y = 0, a raised
  sidewalk 8-35 cm above it (its road-side edge is the kerb), a ceiling above the camera;
- vertical surfaces are RANSAC lines through the side-facing points seen from above (walls, building faces), each
  with its measured extent along the wall and its height;
- road and pavement at the same height split by colour (2-means on Lab when the two halves are spatially apart).

Each plane is a thin box with measured extents and colour. An interior (a ceiling, or walls on three sides, and no
sky) gets no terrain slab, sky or road. Works in METRES (assemble() calls it after solve.metric_scale).
"""
from __future__ import annotations

import math

import numpy as np

from . import context as X
from . import measure as M

LOW = 4


def _normals(Xc: np.ndarray) -> np.ndarray:
    """Per-pixel camera-space normals (H, W, 3) from a point map, by central differences (smoothed)."""
    import cv2
    P = np.stack([cv2.GaussianBlur(Xc[..., i].astype(np.float32), (5, 5), 0) for i in range(3)], -1)
    du = np.zeros_like(P)
    dv = np.zeros_like(P)
    du[:, 1:-1] = P[:, 2:] - P[:, :-2]
    dv[1:-1] = P[2:] - P[:-2]
    n = np.cross(du, dv)
    nn = np.linalg.norm(n, axis=-1, keepdims=True)
    n = n / np.maximum(nn, 1e-9)
    # Face the camera (camera at the origin).
    flip = (n * P).sum(-1) > 0
    n[flip] = -n[flip]
    return n


def static_points(ctx: dict, stride: int = LOW, max_samples: int = 12):
    """(world xyz (N,3), world normals (N,3), rgb (N,3) uint8, sample f (N,), pixel (N,2) on the proxy grid)."""
    samples = sorted((ctx.get("depth") or {}).keys())
    if len(samples) > max_samples:
        samples = [samples[int(round(i * (len(samples) - 1) / (max_samples - 1)))] for i in range(max_samples)]
    out = [[], [], [], [], []]
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    for f in samples:
        d = np.asarray(ctx["depth"][f], np.float32)
        h, w = d.shape
        ok = np.isfinite(d) & (d > 0) & ~M._depth_edges(d, 0.06)
        mov = X.mask_at(ctx, f)
        if mov is not None:
            ok &= M._erode(~M._resize_to(mov, d.shape), 3)   # grown masks: no object fringe on the walls
        sky = (ctx.get("sky") or {}).get(f)
        if sky is not None:
            ok &= ~(M._resize_to(np.asarray(sky) > 0.5, d.shape))
        K = X.K_at(ctx, f).copy()
        sx, sy = w / pw, h / ph
        K[0] *= sx
        K[1] *= sy
        vs, us = np.mgrid[0:h, 0:w]
        Xc = np.stack([(us - K[0, 2]) / K[0, 0] * d, (vs - K[1, 2]) / K[1, 1] * d, d], -1)
        N = _normals(Xc)
        sel = ok[::stride, ::stride]
        ys, xs = np.nonzero(sel)
        ys, xs = ys * stride, xs * stride
        if len(xs) < 20:
            continue
        P = X.pose_at(ctx, f)
        R, t = P[:3, :3], P[:3, 3]
        out[0].append(Xc[ys, xs] @ R.T + t)
        out[1].append(N[ys, xs] @ R.T)
        img = M.frame_rgb(ctx, f)
        if img is not None:
            iy = np.clip((ys / sy).astype(int), 0, img.shape[0] - 1)
            ix = np.clip((xs / sx).astype(int), 0, img.shape[1] - 1)
            out[2].append(img[iy, ix])
        else:
            out[2].append(np.full((len(xs), 3), 128, np.uint8))
        out[3].append(np.full(len(xs), f))
        out[4].append(np.stack([xs / sx, ys / sy], 1))
    if not out[0]:
        return None
    return tuple(np.concatenate(a) for a in out)


def _peaks(y: np.ndarray, lo: float, hi: float, bin_m: float = 0.02, min_share: float = 0.01):
    """Heights of density peaks of y in [lo, hi] (each at least min_share of the points)."""
    if len(y) < 30 or hi <= lo:
        return []
    bins = np.arange(lo, hi + bin_m, bin_m)
    hist, edges = np.histogram(y, bins)
    if not hist.any():
        return []
    k = np.array([1, 2, 3, 2, 1], float)
    hs = np.convolve(hist, k / k.sum(), "same")
    out = []
    for i in range(1, len(hs) - 1):
        if hs[i] >= hs[i - 1] and hs[i] >= hs[i + 1] and hist[max(0, i - 2):i + 3].sum() >= min_share * len(y):
            out.append((float((edges[i] + edges[i + 1]) / 2), int(hist[max(0, i - 2):i + 3].sum())))
    out.sort(key=lambda p: -p[1])
    merged = []
    for yv, n in out:
        if all(abs(yv - m[0]) > 4 * bin_m for m in merged):
            merged.append((yv, n))
    return merged


def _extent(P: np.ndarray, lo: float = 1, hi: float = 99):
    """minAreaRect footprint of points (robust): centre xz, size (a, b), angle of a (deg)."""
    import cv2
    xz = P[:, [0, 2]]
    q0, q1 = np.percentile(xz, lo, 0), np.percentile(xz, hi, 0)
    keep = np.all((xz >= q0) & (xz <= q1), 1)
    xz = xz[keep] if keep.sum() > 10 else xz
    (cx, cz), (a, b), ang = cv2.minAreaRect(xz.astype(np.float32))
    return (float(cx), float(cz)), (float(a), float(b)), float(ang)


def _colour(rgb: np.ndarray) -> str | None:
    if rgb is None or len(rgb) < 10:
        return None
    if len(rgb) > 20000:
        rgb = rgb[np.linspace(0, len(rgb) - 1, 20000).astype(int)]
    return M.colour_of(rgb)


def _line_ransac(xz: np.ndarray, tol: float, iters: int = 400, seed: int = 0):
    """Best 2D line (point, unit direction, inliers) through xz points."""
    rng = np.random.default_rng(seed)
    best = None
    n = len(xz)
    for _ in range(iters):
        i, j = rng.choice(n, 2, replace=False)
        d = xz[j] - xz[i]
        L = np.linalg.norm(d)
        if L < 1e-6:
            continue
        d /= L
        nrm = np.array([-d[1], d[0]])
        inl = np.abs((xz - xz[i]) @ nrm) < tol
        c = inl.sum()
        if best is None or c > best[2].sum():
            best = (xz[i], d, inl)
    if best is None:
        return None
    p, d, inl = best
    Q = xz[inl]
    if len(Q) >= 3:   # refit by PCA
        c = Q.mean(0)
        _, _, vt = np.linalg.svd(Q - c, full_matrices=False)
        d = vt[0]
        nrm = np.array([-d[1], d[0]])
        inl = np.abs((xz - c) @ nrm) < tol
        p = c
    return p, d, inl


def fit(ctx: dict, notes: list | None = None, seed: int = 0) -> dict:
    """-> {planes: [...], interior: bool, sky_share, masks: {f: low-res bool of plane pixels}}. World = metres."""
    notes = notes if notes is not None else []
    pts = static_points(ctx)
    res = {"planes": [], "interior": False, "sky_share": 0.0, "masks": {}}
    skies = [np.mean(np.asarray(s) > 0.5) for s in (ctx.get("sky") or {}).values()]
    res["sky_share"] = float(np.mean(skies)) if skies else 0.0
    if pts is None:
        notes.append("structure: no static depth to fit floors and walls on")
        return res
    P, N, rgb, F, UV = pts
    cams = np.array([X.pose_at(ctx, f)[:3, 3] for f in sorted(ctx.get("poses") or {0: None})]) \
        if ctx.get("poses") else np.zeros((1, 3))
    cam_y = float(np.median(cams[:, 1])) if len(cams) else 1.6
    cam_y = cam_y if cam_y > 0.2 else 1.6
    dist = np.linalg.norm(P - np.median(cams, 0), axis=1)
    tol_h = np.clip(0.012 * dist, 0.025, 0.25)
    up = N[:, 1] > 0.85
    down = N[:, 1] < -0.85
    side = np.abs(N[:, 1]) < 0.3
    used = np.zeros(len(P), bool)
    planes = []

    def add(kind, sel, box, name=None, extra=None):
        used[sel] = True
        col = _colour(rgb[sel])
        pl = {"kind": kind, "name": name or kind.capitalize(), "colour": col, "n_points": int(sel.sum()), **box}
        if extra:
            pl.update(extra)
        planes.append(pl)
        for f in np.unique(F[sel]):
            m = res["masks"].setdefault(int(f), np.zeros((ctx["clip"]["ph"] // LOW + 1, ctx["clip"]["pw"] // LOW + 1), bool))
            uv = UV[sel & (F == f)]
            m[np.clip((uv[:, 1] / LOW).astype(int), 0, m.shape[0] - 1), np.clip((uv[:, 0] / LOW).astype(int), 0, m.shape[1] - 1)] = True
        return pl

    # --- the floor / road at y = 0 (the solve put the ground there), and a raised sidewalk / kerb top
    floor_sel = up & (np.abs(P[:, 1]) < np.clip(tol_h, 0.03, 0.06))
    floor = None
    if floor_sel.sum() > 30:
        (cx, cz), (a, b), ang = _extent(P[floor_sel])
        floor = add("floor", floor_sel, {"centre": [cx, -0.01, cz], "size": [a, 0.02, b], "yaw_deg": _yaw_rect(ang)})
        # Outdoors the ground is road AND pavement AND verge: split the floor by colour into its own patches.
        if res["sky_share"] > 0.01 or (ctx.get("vlm_inventory") or {}).get("interior") is False:
            for patch in split_ground(P[floor_sel], rgb[floor_sel]):
                planes.append(patch)
    for yv, n in _peaks(P[up & ~used, 1], 0.06, 0.4, min_share=0.004)[:2]:
        sel = up & ~used & (np.abs(P[:, 1] - yv) < 0.03)
        if sel.sum() < 30:
            continue
        (cx, cz), (a, b), ang = _extent(P[sel])
        sw = add("sidewalk", sel, {"centre": [cx, yv / 2, cz], "size": [a, yv, b], "yaw_deg": _yaw_rect(ang)},
                 extra={"height": round(yv, 3)})
        kerb = _kerb(sw, np.median(cams, 0))
        if kerb:
            planes.append(kerb)
    # --- the ceiling: down-facing points above the camera
    pk = _peaks(P[down & ~used, 1], cam_y + 0.2, cam_y + 6.0, bin_m=0.03, min_share=0.004)
    if pk:
        yv = pk[0][0]
        sel = down & ~used & (np.abs(P[:, 1] - yv) < 0.06)
        if sel.sum() > 30:
            (cx, cz), (a, b), ang = _extent(P[sel])
            add("ceiling", sel, {"centre": [cx, yv + 0.01, cz], "size": [a, 0.02, b], "yaw_deg": _yaw_rect(ang)})
    # --- walls / building faces: vertical planes as lines from above
    rest = side & ~used
    for k in range(10):
        idx = np.flatnonzero(rest)
        if len(idx) < 60:
            break
        xz = P[idx][:, [0, 2]]
        tol = float(np.clip(np.median(tol_h[idx]) * 1.5, 0.04, 0.4))
        r = _line_ransac(xz, tol, seed=seed + k)
        if r is None:
            break
        p0, d, inl = r
        if inl.sum() < max(60, 0.04 * side.sum()):
            break
        sel_idx = idx[inl]
        # One wall is one CONTIGUOUS run along its line: two building fronts across a street line up, but the
        # road between them is not a wall.
        tq_all = (P[sel_idx][:, [0, 2]] - p0) @ d
        order = np.argsort(tq_all)
        ts = tq_all[order]
        gap = max(1.0, 0.04 * float(ts[-1] - ts[0]))
        cuts = np.flatnonzero(np.diff(ts) > gap)
        bounds = np.concatenate([[0], cuts + 1, [len(ts)]])
        seg_i = int(np.argmax(np.diff(bounds)))
        keep = order[bounds[seg_i]:bounds[seg_i + 1]]
        if len(keep) < 60:
            rest[sel_idx[order[bounds[seg_i]:bounds[seg_i + 1]]]] = False
            continue
        sel_idx = sel_idx[keep]
        sel = np.zeros(len(P), bool)
        sel[sel_idx] = True
        Q = P[sel]
        tq = (Q[:, [0, 2]] - p0) @ d
        t0, t1 = np.percentile(tq, [1, 99])
        y0 = 0.0 if np.percentile(Q[:, 1], 2) < 0.4 else float(np.percentile(Q[:, 1], 2))
        y1 = float(np.percentile(Q[:, 1], 99))
        if t1 - t0 < 0.3 or y1 - y0 < 0.3:
            rest[sel_idx] = False
            continue
        nrm = np.array([-d[1], d[0]])
        c2 = p0 + d * (t0 + t1) / 2
        cam2 = np.median(cams, 0)[[0, 2]]
        if (cam2 - c2) @ nrm < 0:
            nrm = -nrm
        tall = y1 - y0
        kind = "wall"
        th = 0.12
        if res["sky_share"] > 0.01 or not (ctx.get("vlm_inventory") or {}).get("interior", True):
            kind, th = ("building", 0.6) if tall > 2.6 else ("wall", 0.2)
        centre2 = c2 - nrm * th / 2   # the box's front face on the measured plane
        add(kind, sel, {"centre": [float(centre2[0]), (y0 + y1) / 2, float(centre2[1])],
                        "size": [float(t1 - t0), float(tall), th], "yaw_deg": round(math.degrees(math.atan2(nrm[0], nrm[1])), 1)},
            name="Building front" if kind == "building" else "Wall", extra={"normal": [float(nrm[0]), 0.0, float(nrm[1])]})
        rest &= ~sel
    planes = merge_walls(planes)
    walls = [p for p in planes if p["kind"] in ("wall",)]
    res["_enclose"] = walls
    dirs = {int(round(((p["yaw_deg"] % 360) / 90))) % 4 for p in walls}
    vlm_int = (ctx.get("vlm_inventory") or {}).get("interior")
    res["interior"] = bool(res["sky_share"] < 0.01 and (any(p["kind"] == "ceiling" for p in planes) or len(dirs) >= 3
                                                         or (vlm_int and len(walls) >= 1)))
    if res["interior"] and floor is not None:
        floor["name"] = "Floor"
        enclose(planes, [p for p in planes if p["kind"] in ("floor", "ceiling")], walls)
    elif floor is not None:
        surf = {s["kind"] for s in (ctx.get("vlm_inventory") or {}).get("surfaces") or []}
        floor["kind"], floor["name"] = ("road", "Road") if "road" in surf or "street" in surf else ("ground", "Ground")
    res.pop("_enclose", None)
    res["planes"] = planes
    notes.append("structure: " + (", ".join(f"{sum(p['kind'] == k for p in planes)} {k}{'s' if sum(p['kind'] == k for p in planes) > 1 else ''}"
                                            for k in ("floor", "road", "ground", "sidewalk", "kerb", "wall", "building", "ceiling")
                                            if any(p["kind"] == k for p in planes)) or "nothing fitted")
                 + (" (interior: no sky, terrain or road)" if res["interior"] else ""))
    return res


def _yaw_rect(ang: float) -> float:
    return round(-float(ang), 1)


def _kerb(sw: dict, cam) -> dict | None:
    """The sidewalk box's edge nearest the camera (the road side) as a 15 cm kerb stone."""
    a = math.radians(sw["yaw_deg"])
    ax_u = np.array([math.cos(a), -math.sin(a)])      # stage rotation of the box's local x
    ax_v = np.array([math.sin(a), math.cos(a)])
    c = np.array([sw["centre"][0], sw["centre"][2]])
    su, sv = sw["size"][0], sw["size"][2]
    cam2 = np.array([cam[0], cam[2]])
    best = None
    for ax, half, along in ((ax_u, su / 2, sv), (-ax_u, su / 2, sv), (ax_v, sv / 2, su), (-ax_v, sv / 2, su)):
        e = c + ax * half
        dd = float(np.linalg.norm(cam2 - e))
        if best is None or dd < best[0]:
            best = (dd, e, ax, along)
    if best is None:
        return None
    _, e, ax, along = best
    h = float(sw.get("height") or sw["size"][1])
    yaw = math.degrees(math.atan2(ax[0], ax[1]))
    return {"kind": "kerb", "name": "Kerb", "colour": "#a7a49d", "n_points": 0,
            "centre": [float(e[0]), h / 2, float(e[1])], "size": [float(along), h + 0.01, 0.15], "yaw_deg": round(yaw, 1)}


def merge_walls(planes: list, ang_tol: float = 12.0, off_tol: float = 0.25) -> list:
    """Two pieces of one wall (split by a doorway, a window or a shelf in front) -> one, with the joint extent."""
    vert = [p for p in planes if p["kind"] in ("wall", "building")]
    rest = [p for p in planes if p["kind"] not in ("wall", "building")]
    out: list = []
    for p in sorted(vert, key=lambda p: -p["size"][0] * p["size"][1]):
        a = math.radians(p["yaw_deg"])
        n = np.array([math.sin(a), math.cos(a)])
        t = np.array([n[1], -n[0]])
        c = np.array([p["centre"][0], p["centre"][2]])
        merged = False
        for q in out:
            b = math.radians(q["yaw_deg"])
            nq = np.array([math.sin(b), math.cos(b)])
            if abs(((p["yaw_deg"] - q["yaw_deg"] + 180) % 360) - 180) > ang_tol:
                continue
            cq = np.array([q["centre"][0], q["centre"][2]])
            if abs((c - cq) @ nq) > off_tol:
                continue
            tq = np.array([nq[1], -nq[0]])
            ends = [(cq - cq) @ tq - q["size"][0] / 2, (cq - cq) @ tq + q["size"][0] / 2,
                    (c - cq) @ tq - p["size"][0] / 2, (c - cq) @ tq + p["size"][0] / 2]
            lo, hi = min(ends), max(ends)
            mid = cq + tq * (lo + hi) / 2
            y0 = min(q["centre"][1] - q["size"][1] / 2, p["centre"][1] - p["size"][1] / 2)
            y1 = max(q["centre"][1] + q["size"][1] / 2, p["centre"][1] + p["size"][1] / 2)
            q["centre"] = [float(mid[0]), (y0 + y1) / 2, float(mid[1])]
            q["size"] = [float(hi - lo), float(y1 - y0), q["size"][2]]
            q["n_points"] += p["n_points"]
            merged = True
            break
        if not merged:
            out.append(dict(p))
    return rest + out


def _box_contains(P: np.ndarray, pl: dict, tol: np.ndarray) -> np.ndarray:
    a = math.radians(pl.get("yaw_deg") or 0.0)
    ca, sa = math.cos(a), math.sin(a)
    d = P - np.asarray(pl["centre"], float)
    lx = d[:, 0] * ca - d[:, 2] * sa
    lz = d[:, 0] * sa + d[:, 2] * ca
    h = np.asarray(pl["size"], float) / 2
    return (np.abs(lx) <= h[0] + tol) & (np.abs(d[:, 1]) <= h[1] + tol) & (np.abs(lz) <= h[2] + tol)


def coverage(ctx: dict, planes: list, f: int, shape) -> np.ndarray | None:
    """Low-res map (shape) of sample f's pixels whose depth lands on a fitted plane box (within 6 cm + 1.5 %)."""
    d = (ctx.get("depth") or {}).get(f)
    if d is None or not planes:
        return None
    d = np.asarray(d, np.float32)
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    hh, ww = shape
    vs = (np.arange(hh) * LOW + LOW // 2).clip(0, ph - 1)
    us = (np.arange(ww) * LOW + LOW // 2).clip(0, pw - 1)
    V, U = np.meshgrid(vs, us, indexing="ij")
    di = d[np.clip((V * d.shape[0] / ph).astype(int), 0, d.shape[0] - 1), np.clip((U * d.shape[1] / pw).astype(int), 0, d.shape[1] - 1)]
    ok = np.isfinite(di) & (di > 0)
    out = np.zeros(shape, bool)
    if not ok.any():
        return out
    uv = np.stack([U[ok], V[ok]], 1).astype(float)
    P = X.pixel_to_world(ctx, f, uv, di[ok].astype(float))
    cam = X.pose_at(ctx, f)[:3, 3]
    tol = 0.06 + 0.015 * np.linalg.norm(P - cam, axis=1)
    hit = np.zeros(len(P), bool)
    for pl in planes:
        hit |= _box_contains(P, pl, tol)
    out[ok] = hit
    return out


def _corners(p: dict) -> np.ndarray:
    a = math.radians(p.get("yaw_deg") or 0.0)
    ax = np.array([math.cos(a), -math.sin(a)])
    az = np.array([math.sin(a), math.cos(a)])
    c = np.array([p["centre"][0], p["centre"][2]])
    return np.array([c + sx * ax * p["size"][0] / 2 + sz * az * p["size"][2] / 2 for sx in (-1, 1) for sz in (-1, 1)])


def enclose(planes: list, flats: list, walls: list) -> None:
    """An interior's floor and ceiling run to its walls (the camera sees a patch of floor; the room is bigger)."""
    if not walls:
        return
    for fl in flats:
        a = math.radians(fl.get("yaw_deg") or 0.0)
        ax = np.array([math.cos(a), -math.sin(a)])
        az = np.array([math.sin(a), math.cos(a)])
        c0 = np.array([fl["centre"][0], fl["centre"][2]])
        pts = np.concatenate([_corners(fl)] + [_corners(w) for w in walls])
        u = (pts - c0) @ ax
        v = (pts - c0) @ az
        lo_u, hi_u, lo_v, hi_v = u.min(), u.max(), v.min(), v.max()
        # never more than 3x what was measured (a stray wall far away is not this room's)
        if (hi_u - lo_u) > 3 * fl["size"][0] + 2 or (hi_v - lo_v) > 3 * fl["size"][2] + 2:
            continue
        c = c0 + ax * (lo_u + hi_u) / 2 + az * (lo_v + hi_v) / 2
        fl["centre"] = [float(c[0]), fl["centre"][1], float(c[1])]
        fl["size"] = [float(hi_u - lo_u), fl["size"][1], float(hi_v - lo_v)]


def split_ground(P: np.ndarray, rgb: np.ndarray, cell: float = 0.5, min_pts: int = 80) -> list:
    """Ground points -> patches of one colour each (2-means in Lab, then connected cells on a 0.5 m grid): the dark
    one is road, a green one grass, the light one pavement. [] when the ground is all one colour."""
    import cv2
    if len(P) < 4 * min_pts:
        return []
    lab = M._srgb_to_lab(rgb.astype(np.float64) / 255.0)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5)
    _, lbl, cen = cv2.kmeans(lab.astype(np.float32), 2, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    lbl = lbl.ravel()
    if np.linalg.norm(cen[0] - cen[1]) < 12 or min((lbl == 0).mean(), (lbl == 1).mean()) < 0.08:
        return []
    out = []
    lo = P[:, [0, 2]].min(0)
    for k in (0, 1):
        Q = P[lbl == k]
        if len(Q) < min_pts:
            continue
        ij = np.floor((Q[:, [0, 2]] - lo) / cell).astype(int)
        H, W = ij[:, 1].max() + 1, ij[:, 0].max() + 1
        if H * W > 4_000_000:
            continue
        grid = np.zeros((H, W), np.uint8)
        grid[ij[:, 1], ij[:, 0]] = 1
        grid = cv2.morphologyEx(grid, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        n, lab_g = cv2.connectedComponents(grid, connectivity=8)
        comp = lab_g[ij[:, 1], ij[:, 0]]
        L, a, b = (float(x) for x in cen[k])
        green = a < -8 and b > 5
        kind = "grass" if green else ("road" if L < float(cen[1 - k][0]) else "sidewalk")
        for c in range(1, n):
            sel = comp == c
            if sel.sum() < min_pts:
                continue
            (cx, cz), (sa, sb), ang = _extent(Q[sel], 0.5, 99.5)
            if sa * sb < 2.0:
                continue
            col = M.colour_of(rgb[lbl == k][sel]) if sel.sum() > 10 else None
            y = 0.0 if kind == "road" else 0.005
            out.append({"kind": kind, "name": {"road": "Road", "grass": "Grass verge", "sidewalk": "Pavement"}[kind],
                        "colour": col, "n_points": int(sel.sum()), "centre": [cx, y, cz], "size": [sa, 0.02, sb],
                        "yaw_deg": _yaw_rect(ang)})
    return out
