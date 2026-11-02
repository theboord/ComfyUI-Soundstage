"""A LAYOUT context with a known answer: ray-cast boxes (the bench's truth.json, or a hand-made list) through known
cameras into depth, ID masks and flat-colour frames, exactly the shape the pipeline hands LAYOUT (context.py).

Used by tests/test_v2s_layout.py (small hand-made rooms) and by the oracle check (a bench clip's own truth: with a
perfect camera and perfect masks, how close does LAYOUT's measuring get?).
"""
from __future__ import annotations

import math
import os

import numpy as np

STRUCT = {"floor", "ceiling", "wall", "road", "sidewalk", "kerb", "ground", "building", "marking", "terrain"}
PEOPLE = {"person", "man", "woman", "child"}


def hex_rgb(h):
    h = (h or "#808080").lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.uint8)


def box_at(o: dict, f: int):
    fr = o.get("frames") or []
    if len(fr) == 1 and int(fr[0].get("f", -1)) < 0:
        return fr[0]
    for e in fr:
        if int(e["f"]) == f:
            return e
    return None


def raycast(origin, dirs, boxes):
    """dirs (N,3); boxes [(c, yaw_deg, size)] -> (t (N,), index (N,) or -1)."""
    N = len(dirs)
    best_t = np.full(N, np.inf)
    best_i = np.full(N, -1)
    for i, (c, yaw, size) in enumerate(boxes):
        a = math.radians(yaw)
        ca, sa = math.cos(a), math.sin(a)
        # world -> local (stage: local x -> (c, -s), local z -> (s, c))
        def to_local(v):
            return np.stack([v[..., 0] * ca - v[..., 2] * sa, v[..., 1], v[..., 0] * sa + v[..., 2] * ca], -1)
        o = to_local(np.asarray(origin, float) - np.asarray(c, float))
        d = to_local(dirs)
        h = np.asarray(size, float) / 2
        with np.errstate(divide="ignore", invalid="ignore"):
            t1 = (-h - o) / d
            t2 = (h - o) / d
        tmin = np.nanmax(np.minimum(t1, t2), axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        hit = (tmax >= np.maximum(tmin, 1e-4)) & np.isfinite(tmin)
        t = np.where(tmin > 1e-4, tmin, tmax)
        better = hit & (t < best_t)
        best_t[better] = t[better]
        best_i[better] = i
    return best_t, best_i


def cam_pose(cam: dict) -> np.ndarray:
    """truth camera (three.js R columns: right, up, back) -> world-from-camera 4x4 (OpenCV)."""
    R = np.asarray(cam["R"], float) @ np.diag([1.0, -1.0, -1.0])
    P = np.eye(4)
    P[:3, :3] = R
    P[:3, 3] = cam["pos"]
    return P


def build(truth: dict, out_dir: str, pw: int = 256, frames=None, sample_every: int = 8, sky_colour="#9cc3e6"):
    """-> ctx (context.py shape) with depth/sky on samples, masks for every non-structure thing (people under
    'people'), seg stats, a vision-model inventory naming each thing (frame 0 boxes), flat-colour PNG frames."""
    import cv2
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from soundstage.video2stage import context as X
    from soundstage.video2stage import segment as SG
    W, H = int(truth["width"]), int(truth["height"])
    ph = int(round(pw * H / W / 2) * 2)
    n = int(truth["frames"])
    frames = list(range(n)) if frames is None else frames
    cams = {int(c["f"]): c for c in truth["camera"]}
    objs = truth["objects"]
    clip = {"path": "synthetic.mp4", "video": "synthetic.mp4", "fps": 24.0, "w": W, "h": H, "pw": pw, "ph": ph,
            "frames": n, "start": 0.0, "end": (n - 1) / 24, "src_frames": n, "duration": (n - 1) / 24}
    ctx = X.new(clip, {})
    os.makedirs(out_dir, exist_ok=True)
    samples = sorted(set(list(range(0, n, sample_every)) + [n - 1]))
    ctx["samples"] = samples
    vs, us = np.mgrid[0:ph, 0:pw]
    seg = {}
    masks_obj, masks_ppl = {}, {}
    items = []
    for f in range(n):
        cam = cams.get(f) or cams[min(cams, key=lambda k: abs(k - f))]
        P = cam_pose(cam)
        s = pw / W
        K = np.array([[cam["fx"] * s, 0, cam["cx"] * s], [0, cam["fy"] * s, cam["cy"] * s], [0, 0, 1]])
        ctx["poses"][f] = P
        ctx["K"][f] = K
        if f not in frames and f not in samples:
            ctx["all_frames"].append("")
            continue
        rays = np.stack([(us - K[0, 2]) / K[0, 0], (vs - K[1, 2]) / K[1, 1], np.ones_like(us, float)], -1).reshape(-1, 3)
        dw = rays @ P[:3, :3].T
        boxes, live = [], []
        for i, o in enumerate(objs):
            b = box_at(o, f)
            if b is None:
                continue
            boxes.append((b["c"], b.get("yaw", 0.0), b.get("size") or o["size"]))
            live.append(i)
        t, idx = raycast(P[:3, 3], dw, boxes)
        idx = np.where(idx >= 0, np.array(live + [-1])[idx], -1).reshape(ph, pw)
        z = (t.reshape(ph, pw))  # ray z component is 1 in camera space -> t is camera depth
        img = np.zeros((ph, pw, 3), np.uint8)
        img[:] = hex_rgb(sky_colour)
        for i in np.unique(idx[idx >= 0]):
            shade = 1.0
            img[idx == i] = np.clip(hex_rgb(objs[i]["color"]) * shade, 0, 255).astype(np.uint8)
        fp = os.path.join(out_dir, f"s_{f:05d}.png")
        cv2.imwrite(fp, img[..., ::-1])
        ctx["all_frames"].append(fp)
        if f in samples:
            ctx["depth"][f] = np.where(idx >= 0, z, 0.0).astype(np.float32)
            ctx["sky"][f] = (idx < 0).astype(np.float32)
        for i in np.unique(idx[idx >= 0]):
            o = objs[i]
            cls = (o.get("cls") or "").lower()
            if cls in STRUCT:
                continue
            m = idx == i
            st = SG._stats(m)
            if st is None:
                continue
            if cls in PEOPLE:
                masks_ppl.setdefault(o["id"], {})[f] = X.rle_encode(m)
                continue
            rec = seg.setdefault(o["id"], {"id": o["id"], "concept": cls, "source": "vlm", "frames": {}, "_low": {}})
            rec["frames"][f] = st
            rec["_low"][f] = SG._low(m)
            masks_obj.setdefault(o["id"], {})[f] = X.rle_encode(m)
            if f == 0 or (not any(it["_id"] == o["id"] for it in items)):
                b = st["bbox"]
                items.append({"_id": o["id"], "name": o.get("label") or cls, "kind": cls, "material": "",
                              "color": o.get("color"), "moving": bool(o.get("dynamic")), "frame": f, "count": 1,
                              "bbox": [b[0] / pw * 1000, b[1] / ph * 1000, b[2] / pw * 1000, b[3] / ph * 1000]})
    for o in seg.values():
        it = next((x for x in items if x["_id"] == o["id"]), None)
        if it:
            o["item"] = {k: it[k] for k in ("name", "kind", "material", "color", "moving")}
    ctx["seg"] = seg
    ctx["masks"] = {"objects": masks_obj, "people": masks_ppl}
    interior = truth.get("scene") == "interior"
    ctx["vlm_inventory"] = {"setting": truth.get("scene", ""), "interior": interior, "time": "day", "camera": {},
                            "items": items, "kinds": {}, "surfaces": [{"kind": "floor" if interior else "road"}]}
    ctx["mpu"] = None
    return ctx
