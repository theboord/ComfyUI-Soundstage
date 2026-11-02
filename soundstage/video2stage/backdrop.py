"""Video → Stage backdrop: the real location, fused from every depth sample, as a photographic set scan.

CPU only (numpy + OpenCV). Reads the shared Video → 3D context (soundstage/video2stage/context.py, see
docs/video2stage.md) and writes three things next to the job's other outputs:

- a 3D Gaussian splat (.ply, the standard 3DGS layout) of the static set, for Color view. It loads through the stage's
  existing splat path (Spark, web/stage/stage.mjs _attachSplat);
- a fused triangle mesh (.glb, vertex colours) of the same surfaces, cut at depth discontinuities and split into
  floor / walls / ceiling / building / road pieces: the clay, depth and ID stand-in (and what the bench and the
  in-canvas match chips score);
- the plate's sky colours (top and horizon) for the sky.

People, objects (ctx['masks']) and sky are left out: they are rebuilt as their own actors. Points that float in free
space (seen through by another sample) or sit more than 3 sigma off the fused surface are culled, so there are no
shards. Everything is in stage metres (the scene's video2stage.xform maps the context's world units to the stage).

Entry point: build(scene, ctx) -> {"actors": [...], "notes": [...], "stats": {...}}; it also edits the scene in place
(adds the actors, drops the old frame-0 relief). ctx_from_legacy() adapts the pre-context pipeline's arrays.
"""
from __future__ import annotations

import json
import math
import os
import struct

import numpy as np

SPLAT_C0 = 0.28209479177387814          # SH band-0 constant (3DGS f_dc <-> RGB)
BASE_VOX = 0.02                         # 2 cm voxels at 2 m from the nearest camera ...
VOX_PER_M = 0.01                        # ... about 1 % of range further out
EDGE_REL = 0.04                         # a 4 % break in the surface (beyond what its own plane predicts) is an edge
MAX_TRIS = 400_000
MAX_SPLATS = 1_500_000
MAX_Y = 58.0                            # the stage re-fits any model taller than 60 m: cull the very top instead
SCAN_ID = "v2s_scan"


# ---------------------------------------------------------------------------------------------------- masks (RLE)
def rle_decode(rle, shape=None) -> np.ndarray | None:
    """A mask from COCO RLE ({size:[h,w], counts: list | compressed str}), a bool/0-1 array, or None."""
    if rle is None:
        return None
    if isinstance(rle, np.ndarray):
        return rle.astype(bool)
    if isinstance(rle, (list, tuple)) and rle and isinstance(rle[0], (list, tuple)):
        return np.asarray(rle, bool)
    if not isinstance(rle, dict):
        return None
    h, w = (rle.get("size") or shape or (0, 0))[:2]
    counts = rle.get("counts")
    if isinstance(counts, (bytes, str)):
        counts = _coco_counts(counts.encode() if isinstance(counts, str) else counts)
    if not counts:
        return np.zeros((h, w), bool)
    flat = np.zeros(h * w, bool)
    pos, val = 0, False
    for c in counts:
        c = int(c)
        if val:
            flat[pos:pos + c] = True
        pos += c
        val = not val
    return flat.reshape((w, h)).T          # COCO runs are column-major


def _coco_counts(s: bytes) -> list[int]:
    """pycocotools' compressed RLE string -> run lengths (its LEB128-like 6-bit encoding)."""
    out, p = [], 0
    while p < len(s):
        x, k, more = 0, 0, True
        while more:
            c = s[p] - 48
            x |= (c & 0x1F) << (5 * k)
            more = bool(c & 0x20)
            p += 1
            k += 1
            if not more and (c & 0x10):
                x |= -1 << (5 * k)
        if len(out) > 2:
            x += out[-2]
        out.append(x)
    return out


def rle_encode(mask: np.ndarray) -> dict:
    """bool HxW -> COCO uncompressed RLE {size:[h,w], counts:[...]} (column-major, starts with a zero run)."""
    m = np.asarray(mask, bool)
    flat = m.T.ravel()
    if flat.size == 0:
        return {"size": list(m.shape), "counts": []}
    change = np.flatnonzero(np.diff(flat.astype(np.int8))) + 1
    bounds = np.concatenate([[0], change, [flat.size]])
    runs = np.diff(bounds).tolist()
    if flat[0]:
        runs = [0] + runs
    return {"size": [int(m.shape[0]), int(m.shape[1])], "counts": [int(r) for r in runs]}


def _resize_mask(m: np.ndarray, hw) -> np.ndarray:
    if m.shape == tuple(hw):
        return m
    import cv2
    return cv2.resize(m.astype(np.uint8), (hw[1], hw[0]), interpolation=cv2.INTER_NEAREST).astype(bool)


def moving_mask(ctx: dict, f: int, hw, grow_px: int = 3) -> np.ndarray:
    """Union of every person and object mask on frame f (resized to hw, grown a little so edges don't bleed in)."""
    out = np.zeros(hw, bool)
    masks = ctx.get("masks") or {}
    for group in ("people", "objects"):
        for tracks in (masks.get(group) or {}).values():
            m = rle_decode((tracks or {}).get(f, (tracks or {}).get(str(f))), hw)
            if m is not None and m.size:
                out |= _resize_mask(m, hw)
    if grow_px and out.any():
        import cv2
        out = cv2.dilate(out.astype(np.uint8), np.ones((2 * grow_px + 1,) * 2, np.uint8)).astype(bool)
    return out


# ---------------------------------------------------------------------------------------------------- geometry
def _pose(ctx: dict, f: int) -> np.ndarray:
    """World-from-camera 4x4 for frame f (the context convention)."""
    P = (ctx.get("poses") or {})
    P = P.get(f, P.get(str(f))) if isinstance(P, dict) else P[f]
    P = np.asarray(P, np.float64)
    if P.shape == (3, 4):
        P = np.vstack([P, [0, 0, 0, 1]])
    return P


def _K(ctx: dict, f: int, wh) -> np.ndarray:
    """3x3 intrinsics for frame f at the depth map's own resolution (ctx K is at the proxy-frame resolution)."""
    Ks = ctx.get("K") or {}
    K = Ks.get(f, Ks.get(str(f))) if isinstance(Ks, dict) else Ks[f]
    K = np.asarray(K, np.float64).copy()
    clip = ctx.get("clip") or {}
    fw = float(ctx.get("frame_w") or clip.get("proxy_w") or 0)
    if fw and abs(fw - wh[0]) > 1:
        s = wh[0] / fw
        K[:2] *= s
    return K


def stage_xform(scene: dict, ctx: dict):
    """(A 3x3, b 3): stage = A @ world + b. From the scene (video2stage.xform: whatever placed the camera keys, recentring
    included), else the context's (ctx['xform'] or ctx['ground']), else identity (a world already in stage metres)."""
    xf = (scene.get("video2stage") or {}).get("xform") or ctx.get("xform") or ctx.get("ground")
    if xf:
        return np.asarray(xf["A"], np.float64), np.asarray(xf["b"], np.float64)
    return np.eye(3), np.zeros(3)


def _cam_points(depth: np.ndarray, K: np.ndarray):
    h, w = depth.shape
    u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    z = depth.astype(np.float64)
    x = (u - K[0, 2]) / K[0, 0] * z
    y = (v - K[1, 2]) / K[1, 1] * z
    return np.stack([x, y, z], -1)


def _normals(P: np.ndarray) -> np.ndarray:
    """Per-pixel camera-space normals from a point grid, facing the camera."""
    dx = np.zeros_like(P)
    dy = np.zeros_like(P)
    dx[:, 1:-1] = P[:, 2:] - P[:, :-2]
    dy[1:-1] = P[2:] - P[:-2]
    n = np.cross(dx, dy)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-12)
    flip = (n * P).sum(-1) > 0
    n[flip] *= -1
    return n


def edge_mask(depth: np.ndarray, rel: float = EDGE_REL, stride: int = 1) -> np.ndarray:
    """Pixels on a depth discontinuity. Planes are linear in 1/z, so a break is a second difference of inverse depth
    larger than `rel` of the inverse depth itself (a far floor seen at a grazing angle is NOT an edge)."""
    inv = 1.0 / np.maximum(depth.astype(np.float64), 1e-6)
    e = np.zeros(depth.shape, bool)
    s = stride
    if depth.shape[1] > 2 * s:
        d2 = np.abs(inv[:, 2 * s:] - 2 * inv[:, s:-s] + inv[:, :-2 * s])
        e[:, s:-s] |= d2 > rel * inv[:, s:-s]
    if depth.shape[0] > 2 * s:
        d2 = np.abs(inv[2 * s:] - 2 * inv[s:-s] + inv[:-2 * s])
        e[s:-s] |= d2 > rel * inv[s:-s]
    return e


def _vox_keys(pts: np.ndarray, centres: np.ndarray, fine: float = 1.0):
    """Distance-scaled voxel hash: 2 cm at 2 m from the nearest camera, ~1 % of range beyond. Returns (int64 keys,
    voxel sizes). Sizes come in powers of two, so the same place gets the same key from every sample."""
    d = np.full(len(pts), np.inf)
    for c in centres:
        d = np.minimum(d, np.linalg.norm(pts - c, axis=1))
    size = np.maximum(BASE_VOX, VOX_PER_M * d) * fine
    lvl = np.clip(np.round(np.log2(size / (BASE_VOX * fine))), 0, 15).astype(np.int64)
    vs = BASE_VOX * fine * (2.0 ** lvl)
    q = np.floor(pts / vs[:, None]).astype(np.int64) + (1 << 19)
    q = np.clip(q, 0, (1 << 20) - 1)
    keys = (lvl << 60) | (q[:, 0] << 40) | (q[:, 1] << 20) | q[:, 2]
    return keys, vs


# ---------------------------------------------------------------------------------------------------- fusion
def _load_rgb(path, hw):
    import cv2
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return np.full(hw + (3,), 128, np.uint8)
    if img.shape[:2] != tuple(hw):
        img = cv2.resize(img, (hw[1], hw[0]), interpolation=cv2.INTER_AREA)
    return img[..., ::-1].copy()


def _samples(ctx: dict) -> list[int]:
    s = ctx.get("samples")
    if s is None:
        s = sorted(int(k) for k in (ctx.get("depth") or {}))
    return [int(i) for i in s if int(i) in {int(k) for k in (ctx.get("depth") or {})}]


def _get(d: dict, f):
    return d.get(f, d.get(str(f))) if isinstance(d, dict) else d[f]


def _maybe(d, f):
    """d[f] (int or str key, or a list index) or None."""
    if d is None:
        return None
    if isinstance(d, dict):
        return d.get(f, d.get(str(f)))
    return d[f] if 0 <= f < len(d) else None


def fuse(ctx: dict, A: np.ndarray, b: np.ndarray, *, stride: int = 1, notes: list | None = None) -> dict:
    """Every sample's depth (minus people, objects, sky and depth edges) -> one voxel-fused, colour-averaged point set
    in stage metres. Returns {pos, rgb, normal, conf, support, vox, per_sample:[...], centres}."""
    notes = notes if notes is not None else []
    samples = _samples(ctx)
    frames = ctx.get("all_frames") or []
    centres = []
    for f in samples:
        P = _pose(ctx, f)
        centres.append(A @ P[:3, 3] + b)
    centres = np.array(centres) if centres else np.zeros((1, 3))
    Rw = A / max(1e-12, float(np.linalg.norm(A[0])))
    acc_keys, acc_pos, acc_rgb, acc_n, acc_w, acc_s, per = [], [], [], [], [], [], []
    for si, f in enumerate(samples):
        depth = np.asarray(_get(ctx["depth"], f), np.float32)
        h, w = depth.shape
        K = _K(ctx, f, (w, h))
        P = _pose(ctx, f)
        ok = np.isfinite(depth) & (depth > 0)
        sky = _maybe(ctx.get("sky"), f)
        if sky is not None:
            ok &= ~(_resize_mask(np.asarray(sky) > 0.5, (h, w)))
        mov = moving_mask(ctx, f, (h, w))
        ok &= ~mov
        ok &= ~edge_mask(depth)
        if ok.sum() < 50:
            notes.append(f"backdrop: sample at frame {f} had no usable depth")
            continue
        Pc = _cam_points(depth, K)
        Nc = _normals(Pc)
        fp = _maybe(frames, f)
        rgb = _load_rgb(fp, (h, w)) if fp else np.full((h, w, 3), 128, np.uint8)
        sel = np.zeros_like(ok)
        sel[::stride, ::stride] = True
        m = ok & sel
        pc, nc = Pc[m], Nc[m]
        ray = pc / np.maximum(np.linalg.norm(pc, axis=1, keepdims=True), 1e-9)
        frontal = np.clip(-(ray * nc).sum(1), 0.05, 1.0)
        Rwc, twc = P[:3, :3], P[:3, 3]
        pw = pc @ Rwc.T + twc
        ps = pw @ A.T + b
        ns = (nc @ Rwc.T) @ Rw.T
        z = pc[:, 2]
        wgt = frontal ** 2 / (1.0 + z / max(1e-6, float(np.median(z))))
        keys, _ = _vox_keys(ps, centres)
        acc_keys.append(keys)
        acc_pos.append(ps * wgt[:, None])
        acc_rgb.append(rgb[m].astype(np.float64) * wgt[:, None])
        acc_n.append(ns * wgt[:, None])
        acc_w.append(wgt)
        acc_s.append(np.full(len(keys), si, np.int64))
        per.append({"frame": f, "K": K, "P": P, "hw": (h, w), "depth": depth, "valid": ok, "moving": mov, "rgb": rgb})
    if not acc_keys:
        return {"pos": np.zeros((0, 3)), "rgb": np.zeros((0, 3)), "normal": np.zeros((0, 3)), "conf": np.zeros(0),
                "support": np.zeros(0, int), "vox": np.zeros(0), "keys": np.zeros(0, np.int64), "per_sample": per,
                "centres": centres}
    keys = np.concatenate(acc_keys)
    uk, inv = np.unique(keys, return_inverse=True)
    W = np.bincount(inv, np.concatenate(acc_w), len(uk))
    pos = np.stack([np.bincount(inv, c, len(uk)) for c in np.concatenate(acc_pos).T], 1) / W[:, None]
    rgb = np.stack([np.bincount(inv, c, len(uk)) for c in np.concatenate(acc_rgb).T], 1) / W[:, None]
    nrm = np.stack([np.bincount(inv, c, len(uk)) for c in np.concatenate(acc_n).T], 1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    # support = distinct samples that saw the voxel
    pair = np.unique(inv * 4096 + np.concatenate(acc_s))
    support = np.bincount(pair // 4096, minlength=len(uk))
    lvl = (uk >> 60).astype(np.int64)
    vox = BASE_VOX * (2.0 ** lvl)
    conf = np.clip(W / np.maximum(1, support) * 0.6 + 0.15 * np.minimum(support, 4), 0.0, 1.0)
    return {"pos": pos, "rgb": np.clip(rgb, 0, 255), "normal": nrm, "conf": conf, "support": support, "vox": vox,
            "keys": uk, "per_sample": per, "centres": centres}


def cull_ghosts(F: dict, A: np.ndarray, b: np.ndarray, sigma_k: float = 3.0) -> np.ndarray:
    """Keep mask over fused points. A point is a ghost when another sample looks straight through it (free space)
    more often than it is confirmed, or when its depth residual against the samples that see it is more than
    sigma_k robust sigmas off the fused surface."""
    pos = F["pos"]
    n = len(pos)
    if n == 0:
        return np.zeros(0, bool)
    viol = np.zeros(n, np.int32)
    conf = np.zeros(n, np.int32)
    res_sum = np.zeros(n)
    res_n = np.zeros(n)
    Ainv = np.linalg.inv(A)
    pw = (pos - b) @ Ainv.T
    for s in F["per_sample"]:
        P, K, (h, w), depth = s["P"], s["K"], s["hw"], s["depth"]
        Pinv = np.linalg.inv(P)
        pc = pw @ Pinv[:3, :3].T + Pinv[:3, 3]
        z = pc[:, 2]
        front = z > 1e-3
        u = np.full(n, -1.0)
        v = np.full(n, -1.0)
        u[front] = K[0, 0] * pc[front, 0] / z[front] + K[0, 2]
        v[front] = K[1, 1] * pc[front, 1] / z[front] + K[1, 2]
        inside = front & (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
        ui, vi = np.floor(u[inside]).astype(int), np.floor(v[inside]).astype(int)
        # the 2x2 neighbourhood: a point is only "in front" of a surface if it is in front of all four pixels around it
        # (pixel quantisation on a grazing floor is not a floating point), and confirmed if it is near any of them
        quad = np.stack([depth[vi, ui], depth[vi, ui + 1], depth[vi + 1, ui], depth[vi + 1, ui + 1]], 1).astype(np.float64)
        vq = np.stack([s["valid"][vi, ui], s["valid"][vi, ui + 1], s["valid"][vi + 1, ui], s["valid"][vi + 1, ui + 1]], 1)
        quad = np.where(vq & np.isfinite(quad) & (quad > 0), quad, np.nan)
        good = np.isfinite(quad).any(1)
        idx = np.flatnonzero(inside)[good]
        quad, zz = quad[good], z[inside][good]
        with np.errstate(invalid="ignore"):
            dmin, dmax = np.nanmin(quad, 1), np.nanmax(quad, 1)
            rq = (zz[:, None] - quad) / quad
        tol = 0.06
        viol[idx[zz < (1 - tol) * dmin]] += 1          # the sample sees a surface BEHIND this point: it floats in front
        ra = np.nanmin(np.abs(rq), 1)
        near = ra <= tol
        r = np.take_along_axis(rq, np.nanargmin(np.abs(rq), 1)[:, None], 1)[:, 0]
        conf[idx[near]] += 1
        res_sum[idx[near]] += r[near]
        res_n[idx[near]] += 1
    keep = ~((viol >= 2) & (viol > conf))
    mean_r = np.where(res_n > 0, res_sum / np.maximum(res_n, 1), 0.0)
    if (res_n > 0).sum() > 20:
        med = np.median(mean_r[res_n > 0])
        sig = max(1.4826 * float(np.median(np.abs(mean_r[res_n > 0] - med))), 0.01)   # depth noise floor: 1 %
        keep &= np.abs(mean_r - med) <= sigma_k * sig
    keep &= np.isfinite(pos).all(1)
    return keep


# ---------------------------------------------------------------------------------------------------- structure
def floor_height(pos: np.ndarray, nrm: np.ndarray, cam_y: float) -> float:
    """The floor's height in the scan: the densest level of up-facing points below the camera (0 when none)."""
    up = (nrm[:, 1] > 0.85) & (pos[:, 1] < cam_y - 0.3)
    if up.sum() < max(100, 0.03 * len(pos)):
        return 0.0
    y = pos[up, 1]
    lo, hi = np.percentile(y, [1, 99])
    if hi - lo < 1e-3:
        return float(np.median(y))
    hist, edges = np.histogram(y, bins=max(10, int((hi - lo) / 0.05)), range=(lo, hi))
    k = int(np.argmax(hist))
    sel = (y >= edges[k] - 0.05) & (y <= edges[k + 1] + 0.05)
    return float(np.median(y[sel]))


def label_structure(pos: np.ndarray, nrm: np.ndarray, centres: np.ndarray, seed: int = 0, max_walls: int = 6):
    """Fused points -> labels: 0 rest, 1 floor/ground, 2 ceiling, 3.. vertical planes (walls / building faces).
    Returns (labels, interior: bool, planes: [{label, normal, d, share}])."""
    n = len(pos)
    lab = np.zeros(n, np.int32)
    if n < 100:
        return lab, False, [], 0.0
    cam_y = float(np.median(centres[:, 1])) if len(centres) else 1.6
    dist = np.min(np.linalg.norm(pos[:, None, :] - centres[None, :min(len(centres), 16)], axis=2), axis=1)
    tol = 0.06 + 0.01 * dist
    floor_y = floor_height(pos, nrm, cam_y)
    floor = (np.abs(pos[:, 1] - floor_y) < np.maximum(0.12, 0.6 * tol)) & (nrm[:, 1] > 0.8)
    lab[floor] = 1
    ceil = (nrm[:, 1] < -0.8) & (pos[:, 1] > max(1.9, cam_y + 0.3))
    lab[ceil] = 2
    planes = []
    rng = np.random.default_rng(seed)
    vert = np.flatnonzero((lab == 0) & (np.abs(nrm[:, 1]) < 0.35))
    for k in range(max_walls):
        if len(vert) < max(200, 0.02 * n):
            break
        best, best_in = None, None
        for _ in range(160):
            i = rng.choice(vert)
            nn = nrm[i].copy()
            nn[1] = 0.0
            if np.linalg.norm(nn) < 1e-6:
                continue
            nn /= np.linalg.norm(nn)
            d = -float(nn @ pos[i])
            r = np.abs(pos[vert] @ nn + d)
            inl = (r < tol[vert]) & (np.abs(nrm[vert] @ nn) > 0.8)
            if best_in is None or inl.sum() > best_in.sum():
                best, best_in = (nn, d), inl
        if best is None or best_in.sum() < max(200, 0.02 * n):
            break
        idx = vert[best_in]
        # refit on the inliers (horizontal normal kept: walls are plumb)
        c = pos[idx].mean(0)
        X = pos[idx][:, [0, 2]] - c[[0, 2]]
        _, _, vt = np.linalg.svd(X, full_matrices=False)
        nn = np.array([vt[-1, 0], 0.0, vt[-1, 1]])
        d = -float(nn @ c)
        lab[idx] = 3 + k
        planes.append({"label": 3 + k, "normal": nn.round(4).tolist(), "d": round(d, 4), "share": round(len(idx) / n, 4)})
        vert = vert[~best_in]
    interior = bool((lab == 2).mean() > 0.02 or ((lab >= 3).mean() > 0.25 and len(planes) >= 2 and pos[:, 1].max() < 6.0))
    if not interior:
        lab[lab == 2] = 0      # outdoors, a down-facing surface overhead is an awning or a car's underside, not a ceiling
    return lab, interior, planes, floor_y


# ---------------------------------------------------------------------------------------------------- mesh
def mesh_from_samples(F: dict, A: np.ndarray, b: np.ndarray, keep_keys: np.ndarray, *, max_tris: int = MAX_TRIS,
                      notes: list | None = None):
    """Per-sample grid triangulation (cut at depth breaks, people / objects / sky left out), adding only what earlier
    samples did not already cover, then welded and decimated by voxel clustering to <= max_tris.
    Returns (verts Nx3 stage, colours Nx3 uint8, faces Mx3 int, vertex voxel keys)."""
    notes = notes if notes is not None else []
    per = F["per_sample"]
    if not per:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), np.int64), np.zeros(0, np.int64)
    h, w = per[0]["hw"]
    stride = max(2, int(math.ceil(math.sqrt(h * w * 2 / 160_000))))
    covered = np.zeros(0, np.int64)
    V, C, Fc, KK = [], [], [], []
    base = 0
    keep_set = np.sort(keep_keys)
    for si, s in enumerate(per):
        depth, K, P = s["depth"], s["K"], s["P"]
        gy, gx = np.arange(0, h, stride), np.arange(0, w, stride)
        dg = depth[np.ix_(gy, gx)].astype(np.float64)
        okg = s["valid"][np.ix_(gy, gx)] & np.isfinite(dg) & (dg > 0)
        okg &= ~edge_mask(np.where(np.isfinite(dg) & (dg > 0), dg, 1e6), EDGE_REL * 1.5)
        u, v = np.meshgrid(gx.astype(np.float64), gy.astype(np.float64))
        pc = np.stack([(u - K[0, 2]) / K[0, 0] * dg, (v - K[1, 2]) / K[1, 1] * dg, dg], -1)
        pw = pc @ P[:3, :3].T + P[:3, 3]
        ps = pw @ A.T + b
        gh, gw = dg.shape
        keys, _ = _vox_keys(ps.reshape(-1, 3), F["centres"])
        kept = np.isin(keys, keep_set, assume_unique=False).reshape(gh, gw)
        okg &= kept
        ckeys, _ = _vox_keys(ps.reshape(-1, 3), F["centres"], fine=2.0)
        cov = np.isin(ckeys, covered).reshape(gh, gw) if len(covered) else np.zeros((gh, gw), bool)
        idx = np.arange(gh * gw).reshape(gh, gw)
        a, bq, c, d = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
        tris = np.concatenate([np.stack([a, c, bq], -1).reshape(-1, 3), np.stack([bq, c, d], -1).reshape(-1, 3)])
        okf = okg.ravel()
        tv = okf[tris].all(1)
        # relative depth jump along the triangle's edges, beyond what a plane through it predicts (1/z linear)
        inv = 1.0 / np.maximum(dg.ravel(), 1e-6)
        ti = inv[tris]
        spread = (ti.max(1) - ti.min(1)) / ti.max(1)
        tv &= spread < 0.25
        if si > 0:   # only the reveal: regions no earlier sample covered
            cf = cov.ravel()[tris]
            tv &= cf.sum(1) <= 1
        tris = tris[tv]
        if not len(tris):
            continue
        used = np.unique(tris)
        remap = np.full(gh * gw, -1, np.int64)
        remap[used] = np.arange(len(used)) + base
        V.append(ps.reshape(-1, 3)[used])
        img = s.get("rgb")
        if img is None:
            col = np.full((len(used), 3), 160, np.uint8)
        else:
            col = img[np.ix_(gy, gx)].reshape(-1, 3)[used]
        C.append(col.astype(np.uint8))
        Fc.append(remap[tris])
        KK.append(keys[used])
        base += len(used)
        covered = np.union1d(covered, ckeys[used])
    if not V:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), np.int64), np.zeros(0, np.int64)
    V, C, Fc, KK = np.concatenate(V), np.concatenate(C), np.concatenate(Fc), np.concatenate(KK)
    # weld + decimate: cluster vertices by voxel (finer first), drop collapsed triangles
    fine = 1.0
    while True:
        ck, _ = _vox_keys(V, F["centres"], fine=fine)
        uk, inv = np.unique(ck, return_inverse=True)
        cnt = np.bincount(inv, minlength=len(uk)).astype(np.float64)
        Vn = np.stack([np.bincount(inv, V[:, i], len(uk)) for i in range(3)], 1) / cnt[:, None]
        Cn = np.stack([np.bincount(inv, C[:, i].astype(np.float64), len(uk)) for i in range(3)], 1) / cnt[:, None]
        Fn = inv[Fc]
        good = (Fn[:, 0] != Fn[:, 1]) & (Fn[:, 1] != Fn[:, 2]) & (Fn[:, 0] != Fn[:, 2])
        Fn = Fn[good]
        if len(Fn):
            s3 = np.sort(Fn, 1)
            _, first = np.unique(s3, axis=0, return_index=True)
            Fn = Fn[np.sort(first)]
        if len(Fn) <= max_tris or fine > 64:
            break
        fine *= 1.5
    if fine > 1.0:
        notes.append(f"backdrop: mesh decimated to {len(Fn):,} triangles (voxels x{fine:.1f})")
    # first vertex key of each cluster (for structure labels)
    kfirst = np.zeros(len(uk), np.int64)
    kfirst[inv] = KK
    return Vn, np.clip(Cn, 0, 255).astype(np.uint8), Fn.astype(np.int64), kfirst


# ---------------------------------------------------------------------------------------------------- writers
def write_glb(path: str, verts: np.ndarray, colours: np.ndarray, faces: np.ndarray, name: str = "Set scan") -> int:
    """A minimal glTF 2.0 binary: one mesh, POSITION + COLOR_0 (uint8 normalised) + uint32 indices, double-sided,
    rough unlit-looking material. numpy only. Returns the byte size."""
    verts = np.ascontiguousarray(verts, np.float32)
    cols = np.ascontiguousarray(np.concatenate([colours.astype(np.uint8), np.full((len(colours), 1), 255, np.uint8)], 1))
    idx = np.ascontiguousarray(faces, np.uint32).ravel()
    if len(verts) == 0:   # glTF needs at least one primitive: a single degenerate triangle at the origin
        verts = np.zeros((3, 3), np.float32)
        cols = np.full((3, 4), 255, np.uint8)
        idx = np.array([0, 1, 2], np.uint32)
    pad = lambda bts, c=b"\x00": bts + c * ((4 - len(bts) % 4) % 4)  # noqa: E731
    bpos, bcol, bidx = verts.tobytes(), cols.tobytes(), idx.tobytes()
    o_pos, o_col = 0, len(pad(bpos))
    o_idx = o_col + len(pad(bcol))
    binary = pad(bpos) + pad(bcol) + pad(bidx)
    lo, hi = verts.min(0).tolist(), verts.max(0).tolist()
    gl = {
        "asset": {"version": "2.0", "generator": "Soundstage video2stage backdrop"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"name": "scan", "doubleSided": True,
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.95}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": o_pos, "byteLength": len(bpos), "target": 34962},
                        {"buffer": 0, "byteOffset": o_col, "byteLength": len(bcol), "target": 34962},
                        {"buffer": 0, "byteOffset": o_idx, "byteLength": len(bidx), "target": 34963}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(verts), "type": "VEC3", "min": lo, "max": hi},
                      {"bufferView": 1, "componentType": 5121, "normalized": True, "count": len(cols), "type": "VEC4"},
                      {"bufferView": 2, "componentType": 5125, "count": len(idx), "type": "SCALAR"}],
    }
    js = pad(json.dumps(gl, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)
    return total


def _quat_from_z(n: np.ndarray) -> np.ndarray:
    """Quaternions (w, x, y, z) turning +Z onto each normal (so a flat splat lies on its surface)."""
    z = np.array([0.0, 0.0, 1.0])
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    c = n @ z
    ax = np.cross(np.broadcast_to(z, n.shape), n)
    w = 1.0 + c
    q = np.concatenate([w[:, None], ax], 1)
    bad = w < 1e-6
    q[bad] = [0.0, 1.0, 0.0, 0.0]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def write_splat_ply(path: str, pos: np.ndarray, rgb: np.ndarray, conf: np.ndarray, size_m: np.ndarray,
                    normal: np.ndarray | None = None) -> int:
    """The standard 3DGS PLY (x y z nx ny nz f_dc_0-2 opacity scale_0-2 rot_0-3, binary little-endian float32).
    Colour is band-0 SH only; opacity is logit(confidence); a splat is a disc on its surface (thin along the normal)."""
    n = len(pos)
    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    head = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n%send_header\n" % (
        n, "".join(f"property float {p}\n" for p in props))
    a = np.clip(0.25 + 0.7 * np.asarray(conf, np.float64), 0.05, 0.98)
    data = np.zeros((n, len(props)), np.float32)
    data[:, 0:3] = pos
    if normal is not None:
        data[:, 3:6] = normal
    data[:, 6:9] = (np.asarray(rgb, np.float64) / 255.0 - 0.5) / SPLAT_C0
    data[:, 9] = np.log(a / (1 - a))
    s = np.log(np.maximum(np.asarray(size_m, np.float64), 1e-5))
    data[:, 10] = s
    data[:, 11] = s
    data[:, 12] = s + (math.log(0.25) if normal is not None else 0.0)
    data[:, 13:17] = _quat_from_z(normal) if normal is not None else [1.0, 0.0, 0.0, 0.0]
    with open(path, "wb") as f:
        f.write(head.encode())
        f.write(data.tobytes())
    return len(head) + data.nbytes


# ---------------------------------------------------------------------------------------------------- sky
def sky_colours(ctx: dict) -> dict | None:
    """The plate's sky gradient: median colour of the top and the horizon band of the sky mask, over the samples."""
    sky = ctx.get("sky") or {}
    frames = ctx.get("all_frames") or []
    tops, hors = [], []
    for f in _samples(ctx)[:8]:
        m = _maybe(sky, f)
        if m is None or not _maybe(frames, f):
            continue
        m = np.asarray(m) > 0.5
        if m.mean() < 0.01:
            continue
        img = _load_rgb(frames[f], m.shape)
        rows = np.flatnonzero(m.any(1))
        r0, r1 = rows.min(), rows.max()
        top = m.copy()
        top[r0 + max(1, (r1 - r0) // 4):] = False
        hor = m.copy()
        hor[:max(r0, r1 - max(1, (r1 - r0) // 5))] = False
        if top.any():
            tops.append(np.median(img[top], 0))
        if hor.any():
            hors.append(np.median(img[hor], 0))
    if not tops:
        return None
    hexc = lambda c: "#%02x%02x%02x" % tuple(int(round(v)) for v in c)  # noqa: E731
    return {"top": hexc(np.median(tops, 0)), "horizon": hexc(np.median(hors or tops, 0))}


# ---------------------------------------------------------------------------------------------------- build
def _scan_actor(aid, name, url, fmt="glb", **extra):
    a = {"id": aid, "name": name, "kind": "glb", "format": fmt, "url": url, "position": [0, 0, 0],
         "keys": [{"frame": 0, "position": [0, 0, 0]}], "height_m": 1.7, "rotation_deg": 0,
         "set_xform": {"flip_xyz": [1, 1, 1], "scale": 1.0, "offset": [0, 0, 0], "quat": [0, 0, 0, 1]},
         "look_at": False, "scan": True}
    a.update(extra)
    return a


def _out(ctx: dict):
    """(directory, url builder) for this job's files."""
    o = ctx.get("out") or {}
    d = o.get("dir")
    sub = o.get("subfolder")
    typ = o.get("type", "output")
    if not d:
        import folder_paths
        sub = sub or f"soundstage_v2s/{ctx.get('tag') or 'scan'}"
        d = os.path.join(folder_paths.get_output_directory(), sub)
    os.makedirs(d, exist_ok=True)

    def url(fn):
        from urllib.parse import quote
        return f"/view?filename={quote(fn)}&subfolder={quote(sub or '')}&type={typ}"
    return d, url


def piece_names(labels: np.ndarray, interior: bool) -> dict:
    """Structure label -> actor name. Names carry a class word the bench and the outliner both understand."""
    names = {0: "Set scan (from clip)", 1: "Set scan floor" if interior else "Set scan ground", 2: "Set scan ceiling"}
    walls = sorted(int(x) for x in np.unique(labels) if x >= 3)
    for i, k in enumerate(walls):
        names[k] = (f"Set scan wall {i + 1}" if interior else f"Set scan building {i + 1}")
    return names


GROUND_WORDS = {"road", "terrain", "sidewalk", "pavement", "grass", "floor", "ground", "kerb", "curb", "plaza", "beach", "lane",
                "verge", "street", "rug", "carpet", "field", "sand"}


def has_ground_pieces(scene: dict) -> bool:
    """Does the rebuilt set already stand on its own ground pieces (road, floor, terrain…)? Then the scan's ground stays
    in the splat (Color) only: two floors in the clay / ID passes would fight, and people stand on the set's."""
    for a in scene.get("actors") or []:
        if a.get("scan") or not (a.get("set_piece") or a.get("structure")):
            continue
        words = set(str(a.get("name") or "").lower().replace("(", " ").replace(")", " ").split()) | {str(a.get("kind") or "").lower()}
        if words & GROUND_WORDS:
            return True
    return False


def build(scene: dict, ctx: dict, *, min_piece_tris: int = 400) -> dict:
    """Fuse the clip's depth into a set scan and add it to the scene. Returns {actors, notes, stats}."""
    notes: list = []
    A, b = stage_xform(scene, ctx)
    F = fuse(ctx, A, b, notes=notes)
    stats = {"samples": len(F["per_sample"]), "points_fused": int(len(F["pos"]))}
    if len(F["pos"]) < 200:
        notes.append("backdrop: not enough clean depth to fuse a set scan; the set is built from primitives only")
        return {"actors": [], "notes": notes, "stats": stats}
    keep = cull_ghosts(F, A, b)
    stats["ghosts_culled"] = int((~keep).sum())
    stats["ghost_share"] = round(float((~keep).mean()), 4)
    pos, rgb, nrm, conf, vox, keys = (F[k][keep] for k in ("pos", "rgb", "normal", "conf", "vox", "keys"))
    support = F["support"][keep]
    lab, interior, planes, floor_y = label_structure(pos, nrm, F["centres"])
    stats.update(interior=interior, planes=planes, floor_y=round(floor_y, 3))
    if abs(floor_y) > 0.15:
        notes.append(f"backdrop: the clip's own floor sits {abs(floor_y):.2f} m {'above' if floor_y > 0 else 'below'} the "
                     "stage floor: the solved camera height is off by that much")
    out_dir, url = _out(ctx)
    tag = ctx.get("tag") or "scan"
    # --- mesh: clay, depth and ID stand-in, split into structure pieces
    verts, cols, faces, vkeys = mesh_from_samples(F, A, b, keys, notes=notes)
    key_lab = dict(zip(keys.tolist(), lab.tolist())) if len(keys) < 3_000_000 else {}
    vlab = np.array([key_lab.get(int(k), 0) for k in vkeys], np.int32) if len(vkeys) else np.zeros(0, np.int32)
    names = piece_names(lab, interior)
    actors = []
    stats["mesh_tris"] = int(len(faces))
    if len(faces):
        flab = np.array([np.bincount(r, minlength=1).argmax() for r in vlab[faces]]) if len(faces) < 50_000 else \
            np.where(vlab[faces[:, 0]] == vlab[faces[:, 1]], vlab[faces[:, 0]], vlab[faces[:, 2]])
        counts = {int(k): int((flab == k).sum()) for k in np.unique(flab)}
        for k, c in counts.items():   # tiny pieces go back into the rest
            if k and c < min_piece_tris:
                flab[flab == k] = 0
        skip_ground = has_ground_pieces(scene)
        if skip_ground and (flab == 1).any():
            notes.append("backdrop: the set has its own ground pieces, so the scanned ground shows in Color view only")
        for k in sorted(int(x) for x in np.unique(flab)):
            if k == 1 and skip_ground:
                continue
            fk = faces[flab == k]
            used = np.unique(fk)
            remap = np.full(len(verts), -1, np.int64)
            remap[used] = np.arange(len(used))
            fn = f"{tag}_scan_{k}.glb"
            write_glb(os.path.join(out_dir, fn), verts[used], cols[used], remap[fk], names[k])
            aid = SCAN_ID if k == 0 else f"{SCAN_ID}_{k}"
            actors.append(_scan_actor(aid, names[k], url(fn), structure=("rest" if k == 0 else names[k].split()[2])))
    # --- splat: Color view
    above = pos[:, 1] > MAX_Y
    below = pos[:, 1] < -0.25
    sp = ~(above | below)
    if above.any():
        notes.append(f"backdrop: {int(above.sum())} scan points above {MAX_Y:.0f} m left out of the splat")
    pos_s = pos[sp].copy()
    pos_s[:, 1] = np.maximum(pos_s[:, 1], 0.0)   # the splat sits on the stage floor (y >= 0)
    rgb_s, conf_s, nrm_s, vox_s = rgb[sp], conf[sp], nrm[sp], vox[sp]
    if len(pos_s) > MAX_SPLATS:
        top = np.argsort(-conf_s)[:MAX_SPLATS]
        pos_s, rgb_s, conf_s, nrm_s, vox_s = pos_s[top], rgb_s[top], conf_s[top], nrm_s[top], vox_s[top]
    # Spark centres a splat on its bounding box (centres only) and stands it on its lowest point: two invisible anchor
    # splats make that box symmetric about the origin and floor-level, so the scan lands exactly in stage metres.
    if len(pos_s):
        X = float(np.abs(pos_s[:, 0]).max()) + 0.5
        Z = float(np.abs(pos_s[:, 2]).max()) + 0.5
        Y = max(0.1, float(pos_s[:, 1].max()))
        anc = np.array([[-X, 0.0, -Z], [X, Y, Z]])
        pos_w = np.concatenate([pos_s, anc])
        rgb_w = np.concatenate([rgb_s, np.zeros((2, 3))])
        conf_w = np.concatenate([conf_s, [-1.0, -1.0]])   # opacity clamps to 0.05 ...
        size_w = np.concatenate([0.75 * vox_s, [1e-5, 1e-5]])  # ... and a 10 micron splat: invisible
        nrm_w = np.concatenate([nrm_s, [[0, 1, 0], [0, 1, 0]]])
        sfn = f"{tag}_scan_points.ply"
        write_splat_ply(os.path.join(out_dir, sfn), pos_w, rgb_w, conf_w, size_w, nrm_w)
        pfn = f"{tag}_scan_proxy.glb"
        write_glb(os.path.join(out_dir, pfn), np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), np.int64))
        actors.append(_scan_actor(f"{SCAN_ID}_points", "Set scan points", url(sfn), fmt="ply", splat_up="y",
                                  proxy_url=url(pfn), structure="splat"))
        stats["splats"] = int(len(pos_s))
    stats["support_median"] = int(np.median(support)) if len(support) else 0
    sky = sky_colours(ctx)
    # --- the scene: the old frame-0 relief goes, the scan comes in
    scene["actors"] = [a for a in scene.get("actors", []) if a.get("id") != "v2s_backdrop" and not a.get("scan")] + actors
    v2s = scene.setdefault("video2stage", {})
    v2s["backdrop"] = {"stats": stats, "sky": sky, "pieces": [a["name"] for a in actors]}
    if sky:
        v2s["sky"] = sky
    notes.append(f"backdrop: set scan fused from {stats['samples']} samples ({stats['points_fused']:,} points, "
                 f"{stats['ghosts_culled']:,} floating points culled, {stats.get('mesh_tris', 0):,} triangles"
                 f"{', interior' if interior else ''})")
    return {"actors": actors, "notes": notes, "stats": stats}


# ---------------------------------------------------------------------------------------------------- legacy
def ctx_from_legacy(*, depths, poses_cw, K, sample_frames, frame_files, skies=None, frame_w=None, tag="scan",
                    out=None, masks=None) -> dict:
    """The pre-context pipeline's arrays -> a context build() reads. poses_cw: 3x4 camera-from-world per sample (the
    old track.py convention); sample_frames: the clip frame index of each sample; frame_files: the sample PNGs."""
    ctx = {"samples": [], "depth": {}, "poses": {}, "K": {}, "sky": {}, "all_frames": {}, "tag": tag, "masks": masks or {}}
    nmax = max(sample_frames) + 1 if sample_frames else 0
    frames = [""] * nmax
    for i, f in enumerate(sample_frames):
        P = np.asarray(poses_cw[i], np.float64)
        R, t = P[:, :3], P[:, 3]
        W = np.eye(4)
        W[:3, :3] = R.T
        W[:3, 3] = -R.T @ t
        ctx["samples"].append(int(f))
        ctx["depth"][int(f)] = np.asarray(depths[i], np.float32)
        ctx["poses"][int(f)] = W
        Ki = np.asarray(K[i] if np.ndim(K) == 3 else K, np.float64)
        ctx["K"][int(f)] = Ki
        if skies is not None:
            ctx["sky"][int(f)] = np.asarray(skies[i], np.float32)
        frames[int(f)] = frame_files[i]
    ctx["all_frames"] = frames
    if frame_w:
        ctx["frame_w"] = frame_w
    if out:
        ctx["out"] = out
    return ctx
