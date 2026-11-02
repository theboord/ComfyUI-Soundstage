"""Score a Video -> Stage reconstruction against the clip's known 3D answer (numpy only; scipy is optional).

  python3 tools/v2s_bench/metrics.py <clip_dir> [--every 2] [--sheet]

<clip_dir> holds (schema v2s-bench/1, see README.md):
  truth.json + truth_id/        the answer: per-frame camera, every object's box/heading/colour, people's COCO-18 joints,
                                and an ID pass (each object one flat colour)
  recon.json + recon_id/ +      the reconstruction played by the real stage from its solved camera (harness/probe.mjs):
  recon_color/                  the same fields, plus its ID and Color passes
  source.mp4                    the clip itself (for the colour comparison and the sheets)
  recon_result.json             what POST /soundstage/video2stage returned (notes, timings) - optional

Writes metrics.json (and sheet.jpg with --sheet). Every number is explained in README.md.

Frames: frame f of every file is time f / 24 s. The recon frame is the stage frame (e.g. 1024 x 576 for 16:9); the
truth and the source are placed into it the way the stage frames a clip: same horizontal extent, centred vertically.
Alignment (the stage contract: Y up, ground at y = 0, metres): a yaw about Y = the yaw-only chordal mean of
R_true R_recon^T; scale by least squares on the camera centres (or, for a camera that hardly moves or a solved path
nothing like the true one, from the camera's height over the ground); translation along the ground only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgio  # noqa: E402

COCO = ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "r_hip", "r_knee", "r_ankle",
        "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear"]
BODY = list(range(14))                       # nose .. ankles (eyes and ears are left out of the pose numbers)
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13), (1, 0)]

# ------------------------------------------------------------------------------------------------ classes
CANON = {
    "man": "person", "woman": "person", "child": "person", "person": "person", "performer": "person", "rider": "person",
    "cyclist": "person", "pedestrian": "person",
    "car": "car", "sports_car": "car", "police_car": "car", "hatchback": "car", "sedan": "car", "suv": "car", "taxi": "car",
    "truck": "truck", "van": "truck", "pickup": "truck", "bus": "truck",
    "bicycle": "bicycle", "bike": "bicycle", "motorcycle": "bicycle",
    "horse": "horse", "dog": "dog",
    "chair": "chair", "armchair": "chair", "stool": "chair", "table": "table", "coffee_table": "table",
    "dining_table": "table", "desk": "table", "sofa": "sofa", "couch": "sofa", "shelf": "shelf", "bookshelf": "shelf",
    "bookcase": "shelf", "lamp": "light", "floor_lamp": "light", "pole": "light", "streetlight": "light",
    "plant": "plant", "tree": "tree", "trees": "tree", "shrubs": "plant", "sign": "sign", "bin": "bin", "bench": "bench",
    "hydrant": "hydrant", "box": "box", "crate": "box", "flashlight": "box",
    "building": "building", "house": "building", "facade": "building", "road": "road", "sidewalk": "sidewalk",
    "kerb": "kerb", "curb": "kerb", "ground": "ground", "terrain": "ground", "grass": "ground", "plaza": "ground",
    "beach": "ground", "floor": "floor", "wall": "wall", "guardrail": "wall", "ceiling": "ceiling", "window": "window",
    "door": "door", "rug": "rug", "picture": "picture", "marking": "marking", "bike_lane": "road", "mountains": "mountain",
    "hills": "mountain", "mountain": "mountain", "ocean": "water", "lake": "water", "river": "water", "cliff": "ground",
    "rocks": "rock", "bank": "ground",
}
GROUP = {"car": "vehicle", "truck": "vehicle", "bicycle": "vehicle", "chair": "furniture", "table": "furniture",
         "sofa": "furniture", "shelf": "furniture", "bench": "furniture", "plant": "flora", "tree": "flora",
         "road": "ground", "sidewalk": "ground", "kerb": "ground", "ground": "ground", "floor": "ground", "marking": "ground",
         "wall": "structure", "building": "structure", "window": "structure", "door": "structure", "ceiling": "structure"}
STRUCTURE = {"road", "sidewalk", "kerb", "ground", "floor", "wall", "building", "ceiling", "window", "door", "marking",
             "mountain", "water", "rock"}


def canon(o: dict) -> str:
    for key in (o.get("cls"), o.get("kind")):
        k = str(key or "").lower().strip()
        if k in CANON:
            return CANON[k]
    words = " ".join(str(o.get(k) or "") for k in ("label", "cls", "kind")).lower().replace("(", " ").replace(")", " ")
    for w in words.replace("_", " ").split():
        if w in CANON:
            return CANON[w]
    return str(o.get("cls") or o.get("kind") or "object").lower()


def class_penalty(a: str, b: str) -> float:
    if a == b:
        return 0.0
    if GROUP.get(a) and GROUP.get(a) == GROUP.get(b):
        return 0.5
    return math.inf


# ------------------------------------------------------------------------------------------------ geometry
def rot_angle(R) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def chordal_mean(Rs) -> np.ndarray:
    U, _, Vt = np.linalg.svd(np.sum(Rs, axis=0))
    D = np.diag([1.0, 1.0, np.sign(np.linalg.det(U @ Vt)) or 1.0])
    return U @ D @ Vt


def yaw_of_forward(v) -> float:
    return math.degrees(math.atan2(v[0], v[2]))


def ang_diff(a: float, b: float, period: float = 360.0) -> float:
    d = (a - b) % period
    return min(d, period - d)


def hex_to_lab(h: str | None):
    if not h:
        return None
    h = h.lstrip("#")
    rgb = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)[None, None] / 255.0
    return rgb_to_lab(rgb)[0, 0]


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0..1, ... x 3) -> CIELAB (D65)."""
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


# ------------------------------------------------------------------------------------------------ loading
def by_frame(entries):
    return {int(e["f"]): e for e in entries}


class Track:
    """An object's per-frame box (centre, yaw, size); static objects have one entry (f = -1)."""

    def __init__(self, o: dict):
        self.o = o
        fr = o.get("frames") or []
        self.static = len(fr) == 1 and int(fr[0].get("f", -1)) < 0
        self.fr = by_frame(fr) if not self.static else {}
        self.keys = sorted(self.fr)
        self.first = fr[0] if fr else None

    def at(self, f: int):
        if self.static or not self.keys:
            return self.first
        if f in self.fr:
            return self.fr[f]
        i = int(np.searchsorted(self.keys, f))
        cands = [self.keys[j] for j in (i - 1, i) if 0 <= j < len(self.keys)]
        k = min(cands, key=lambda k: abs(k - f))
        return self.fr[k] if abs(k - f) <= 2 else None


# ------------------------------------------------------------------------------------------------ alignment
def yaw_mean(Rs) -> np.ndarray:
    """The rotation about Y (up) closest to the given rotations (chordal mean restricted to yaw)."""
    M = np.sum(Rs, axis=0)
    a = math.atan2(M[0, 2] - M[2, 0], M[0, 0] + M[2, 2])
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def align(gt_cams: dict, rc_cams: dict, frames: list[int]) -> dict:
    """Stage-contract alignment (both worlds are Y up with the ground at y = 0, in metres): a yaw about Y, one scale,
    and a translation along the ground only. A wrong tilt, roll or camera height is therefore NOT aligned away: it
    shows up in the rotation error and the ATE (a free Sim(3) would hide a camera that looks at the sky)."""
    Rg = np.array([gt_cams[f]["R"] for f in frames], float)
    Rr = np.array([rc_cams[f]["R"] for f in frames], float)
    Ra = yaw_mean([g @ r.T for g, r in zip(Rg, Rr)])
    Cg = np.array([gt_cams[f]["pos"] for f in frames], float)
    Cr0 = np.array([rc_cams[f]["pos"] for f in frames], float)
    Cr = Cr0 @ Ra.T
    dg, dr = Cg - Cg.mean(0), Cr - Cr.mean(0)
    spread = float(np.sqrt((dg ** 2).sum(1).mean()))
    hg, hr = float(Cg[:, 1].mean()), float(Cr0[:, 1].mean())
    mode, s, s_path = "path", None, None
    if spread > 0.25 and (dr ** 2).sum() > 1e-6:
        s = s_path = float((dr * dg).sum() / (dr ** 2).sum())
    if s is None or not 0.05 < s < 20.0:
        # A camera that hardly moves, or a solved path that is nothing like the true one (a hood camera the
        # pipeline held still): a least-squares scale is meaningless, so the camera's height sets the scale.
        mode, s = "height", (hg / hr if hr > 0.05 else 1.0)
    t = Cg.mean(0) - s * Cr.mean(0)
    t[1] = 0.0                                   # the ground stays at y = 0
    return {"s": s, "R": Ra, "t": t, "mode": mode, "path_scale": s_path, "gt_spread_m": spread,
            "cam_height_true_m": hg, "cam_height_recon_m": hr}


def apply(A: dict, p) -> np.ndarray:
    return A["s"] * (A["R"] @ np.asarray(p, float)) + A["t"]


def aligned_yaw(A: dict, yaw_deg: float) -> float:
    y = math.radians(yaw_deg)
    return yaw_of_forward(A["R"] @ np.array([math.sin(y), 0.0, math.cos(y)]))


# ------------------------------------------------------------------------------------------------ camera
def camera_metrics(truth, recon, gt_cams, rc_cams, frames, A) -> dict:
    W_t, W_r = float(truth["width"]), float(recon["width"])
    pe, re, fe, rolls_g, rolls_r = [], [], [], [], []
    for f in frames:
        cg, cr = gt_cams[f], rc_cams[f]
        pe.append(float(np.linalg.norm(apply(A, cr["pos"]) - np.asarray(cg["pos"], float))))
        Rg, Rr = np.asarray(cg["R"], float), A["R"] @ np.asarray(cr["R"], float)
        re.append(rot_angle(Rg.T @ Rr))
        fg, fr = cg["fx"] / W_t, cr["fx"] / W_r
        fe.append(abs(fr - fg) / fg * 100)
        rolls_g.append(math.degrees(math.asin(max(-1, min(1, cg["R"][1][0])))))
        rolls_r.append(math.degrees(math.asin(max(-1, min(1, cr["R"][1][0])))))
    Cg = np.array([gt_cams[f]["pos"] for f in frames], float)
    path = float(np.linalg.norm(np.diff(Cg, axis=0), axis=1).sum()) if len(frames) > 1 else 0.0
    ate = float(np.sqrt(np.mean(np.square(pe))))
    roll_err = [abs(a - b) for a, b in zip(rolls_g, rolls_r)]
    return {"ate_m": round(ate, 3), "ate_pct_of_path": round(100 * ate / path, 1) if path > 0.2 else None,
            "path_m": round(path, 2), "rot_err_deg": round(float(np.mean(re)), 2), "rot_err_deg_max": round(float(np.max(re)), 2),
            "focal_err_pct": round(float(np.mean(fe)), 1), "focal_true_mm": round(gt_cams[frames[0]]["fx"] / W_t * 36, 1),
            "focal_recon_mm": round(rc_cams[frames[0]]["fx"] / W_r * 36, 1),
            "roll_err_deg": round(float(np.mean(roll_err)), 2), "roll_err_deg_max": round(float(np.max(roll_err)), 2),
            "roll_true_range_deg": [round(min(rolls_g), 1), round(max(rolls_g), 1)],
            "align_mode": A["mode"]}


# ------------------------------------------------------------------------------------------------ ID passes
def decode_ids(img: np.ndarray, palette: dict, tol: float = 26.0) -> np.ndarray:
    """RGB(A) ID image -> index into list(palette) per pixel, -1 where no object (black, transparent or a blend)."""
    ids = list(palette)
    if not ids:
        return np.full(img.shape[:2], -1, np.int32)
    pal = np.array([palette[i] for i in ids], float)
    rgb = img[..., :3].astype(np.int64)
    packed = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    if img.shape[-1] == 4:
        packed = np.where(img[..., 3] < 128, -1, packed)
    uniq, inv = np.unique(packed, return_inverse=True)
    lab = np.full(len(uniq), -1, np.int32)
    ok = uniq >= 0
    if ok.any():
        u = uniq[ok]
        cols = np.stack([(u >> 16) & 255, (u >> 8) & 255, u & 255], 1).astype(float)
        d = np.linalg.norm(cols[:, None, :] - pal[None], axis=2)
        j = d.argmin(1)
        good = (d[np.arange(len(u)), j] <= tol) & (cols.sum(1) > 30)
        lab[np.where(ok)[0][good]] = j[good]
    return lab[inv.reshape(packed.shape)]


def srgb_encoded(palette: dict) -> dict:
    """The stage draws ID colours as linear values that the renderer then encodes to sRGB (74 -> 147)."""
    enc = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055  # noqa: E731
    return {k: [int(round(255 * enc(c / 255.0))) for c in rgb] for k, rgb in palette.items()}


def pick_palette(imgs: list, palette: dict) -> dict:
    """Whichever of the palette and its sRGB-encoded twin labels more pixels in a few sample frames."""
    best, best_n = palette, -1
    for cand in (palette, srgb_encoded(palette)):
        tol = palette_tolerance(cand)
        n = sum(int((decode_ids(im, cand, tol) >= 0).sum()) for im in imgs)
        if n > best_n:
            best, best_n = cand, n
    return best


def palette_tolerance(palette: dict) -> float:
    pal = np.array(list(palette.values()), float)
    if len(pal) < 2:
        return 40.0
    d = np.linalg.norm(pal[:, None] - pal[None], axis=2)
    d[np.arange(len(pal)), np.arange(len(pal))] = 1e9
    return float(max(6.0, min(40.0, 0.45 * d.min())))


# ------------------------------------------------------------------------------------------------ matching
def diag_xz(size) -> float:
    return math.hypot(float(size[0]), float(size[2]))


def match_objects(gts, rcs, A, frames, img_iou=None):
    """Which reconstructed object IS each true object? Class-compatible pairs; the cost is the better of
    (1 - mean silhouette IoU from the solved camera) and (mean ground distance / 3 tolerances), plus a class penalty;
    greedy one-to-one, accepted below 1. Whether it is also well PLACED is scored separately. {gt_i: (rc_j, cost)}."""
    cands = []
    for i, (g, gc, gtk) in enumerate(gts):
        for j, (r, rcl, rtk) in enumerate(rcs):
            pen = class_penalty(gc, rcl)
            if not math.isfinite(pen):
                continue
            ds = []
            for f in frames:
                eg, er = gtk.at(f), rtk.at(f)
                if eg is None or er is None:
                    continue
                p = apply(A, er["c"])
                ds.append(math.hypot(p[0] - eg["c"][0], p[2] - eg["c"][2]))
            if not ds:
                continue
            gsize = (gtk.first or {}).get("size") or g.get("size") or [1, 1, 1]
            rsize = (rtk.first or {}).get("size") or [1, 1, 1]
            if gc in STRUCTURE:
                tau = max(2.0, 0.5 * max(diag_xz(gsize), A["s"] * diag_xz(rsize)))
            else:
                tau = max(1.0, 0.5 * diag_xz(gsize))
            c3 = float(np.mean(ds)) / (3 * tau)
            ci = 1.0 - (img_iou(g["id"], r["id"]) if img_iou else 0.0)
            cost = min(c3, ci) + pen
            cands.append((cost, i, j, float(np.mean(ds))))
    cands.sort()
    gi, rj, out = set(), set(), {}
    for cost, i, j, d in cands:          # strict: real overlap from the camera, or within 3 tolerances on the ground
        if cost >= 0.95 or i in gi or j in rj:
            continue
        gi.add(i)
        rj.add(j)
        out[i] = (j, cost, False)
    for cost, i, j, d in sorted(cands, key=lambda c: (c[0] - min(c[0], 1.0), c[3])):   # weak: same class, anywhere
        if i in gi or j in rj or cost - min(cost, 1.0) > 0:
            continue
        gi.add(i)
        rj.add(j)
        out[i] = (j, cost, True)
    return out


# ------------------------------------------------------------------------------------------------ people
def project(J, cam, W):
    """World points -> width-normalised image coords (x - W/2) / W, (y - H/2) / W; None behind the camera."""
    R, C = np.asarray(cam["R"], float), np.asarray(cam["pos"], float)
    out = []
    for p in J:
        if p is None:
            out.append(None)
            continue
        q = R.T @ (np.asarray(p, float) - C)        # camera space: x right, y up, z back
        if q[2] > -0.05:
            out.append(None)
            continue
        x = cam["fx"] * q[0] / -q[2]
        y = -cam["fy"] * q[1] / -q[2]
        out.append(np.array([x / W, y / W]))
    return out


def procrustes(X, Y):
    """Similarity-align X to Y (n x 3); returns aligned X."""
    mx, my = X.mean(0), Y.mean(0)
    X0, Y0 = X - mx, Y - my
    U, S, Vt = np.linalg.svd(X0.T @ Y0)
    d = np.sign(np.linalg.det(U @ Vt)) or 1.0
    D = np.diag([1, 1, d])
    R = (U @ D @ Vt).T
    s = (S * np.diag(D)).sum() / max((X0 ** 2).sum(), 1e-9)
    return s * X0 @ R.T + my


def contacts(J_frames, fps_step: float):
    """Per frame and foot (r, l): planted when the ankle is within 6 cm of its lowest point and moving < 0.4 m/s."""
    ank = np.array([[J[10] if J[10] is not None else [np.nan] * 3, J[13] if J[13] is not None else [np.nan] * 3] for J in J_frames], float)
    if len(ank) < 2:
        return np.zeros((len(ank), 2), bool), ank
    low = np.nanpercentile(ank[:, :, 1], 5, axis=0)
    v = np.zeros(ank.shape[:2])
    v[1:] = np.linalg.norm(np.diff(ank[:, :, [0, 2]], axis=0), axis=2) / fps_step
    v[0] = v[1]
    return ((ank[:, :, 1] - low) < 0.06) & (v < 0.4), ank


def pose_metrics(truth, recon, gt_cams, rc_cams, frames, A, gmatch, gts, rcs, fps=24.0):
    gp = {p["object_id"]: p for p in truth.get("people") or []}
    rp = {p["object_id"]: p for p in recon.get("people") or []}
    W_t, W_r = float(truth["width"]), float(recon["width"])
    rows = []
    step = (frames[1] - frames[0]) / fps if len(frames) > 1 else 1 / fps
    gt_people = [i for i, (g, gc, _) in enumerate(gts) if gc == "person" and g["id"] in gp]
    for i in gt_people:
        g = gts[i][0]
        row = {"id": g["id"], "label": g.get("label"), "matched": False}
        if i in gmatch:
            j, _, weak = gmatch[i]
            r = rcs[j][0]
            if r["id"] in rp:
                row.update(matched=True, weak=weak, recon_id=r["id"], recon_label=r.get("label"), mocap=bool(r.get("mocap")))
                G, Rr = by_frame(gp[g["id"]]["frames"]), by_frame(rp[r["id"]]["frames"])
                fs = [f for f in frames if f in G and f in Rr]
                mp, pa, rp2, root, gJs, rJs = [], [], [], [], [], []
                for f in fs:
                    Jg = G[f]["J"]
                    Jr = Rr[f]["J"]
                    if any(Jg[k] is None or Jr[k] is None for k in BODY):
                        continue
                    jg = np.array([Jg[k] for k in BODY], float)
                    jr = np.array([apply(A, Jr[k]) for k in BODY], float)
                    jr_unscaled = np.array([A["R"] @ np.asarray(Jr[k], float) for k in BODY])
                    rg = (jg[8] + jg[11]) / 2
                    rr_u = (jr_unscaled[8] + jr_unscaled[11]) / 2
                    mp.append(float(np.linalg.norm((jr_unscaled - rr_u) - (jg - rg), axis=1).mean()))
                    pa.append(float(np.linalg.norm(procrustes(jr, jg) - jg, axis=1).mean()))
                    rr = (jr[8] + jr[11]) / 2
                    root.append(math.hypot(rr[0] - rg[0], rr[2] - rg[2]))
                    pg = project(Jg, gt_cams[f], W_t)
                    pr = project(Jr, rc_cams[f], W_r)
                    errs = [np.linalg.norm(pg[k] - pr[k]) for k in BODY if pg[k] is not None and pr[k] is not None
                            and abs(pg[k][0]) <= 0.5 and abs(pg[k][1]) <= 0.5 * truth["height"] / W_t]
                    if errs:
                        rp2.append(float(np.mean(errs)) * 1024)
                    gJs.append(Jg)
                    rJs.append([list(apply(A, p)) if p is not None else None for p in Jr])
                if mp:
                    cg, _ = contacts(gJs, step)
                    cr, ankr = contacts(rJs, step)
                    tp = int((cg & cr).sum())
                    prec = tp / max(1, int(cr.sum()))
                    rec = tp / max(1, int(cg.sum()))
                    f1 = 0 if tp == 0 else 2 * prec * rec / (prec + rec)
                    v = np.zeros(ankr.shape[:2])
                    v[1:] = np.linalg.norm(np.diff(ankr[:, :, [0, 2]], axis=0), axis=2) / step
                    slide = float(np.nanmean(v[cg])) if cg.any() else None
                    row.update(frames=len(mp), mpjpe_mm=round(1000 * float(np.mean(mp)), 0), pa_mpjpe_mm=round(1000 * float(np.mean(pa)), 0),
                               reproj_px_at_1024=round(float(np.mean(rp2)), 1) if rp2 else None, root_err_m=round(float(np.mean(root)), 2),
                               contact_f1=round(f1, 2), foot_slide_cm_s=round(100 * slide, 1) if slide is not None and np.isfinite(slide) else None,
                               true_contact_share=round(float(cg.mean()), 2))
        rows.append(row)
    m = [r for r in rows if r.get("mpjpe_mm") is not None]
    mean = lambda k: round(float(np.mean([r[k] for r in m if r.get(k) is not None])), 2) if any(r.get(k) is not None for r in m) else None  # noqa: E731
    return {"people_true": len(rows), "people_matched": len(m), "recall": round(len(m) / len(rows), 2) if rows else None,
            "mpjpe_mm": mean("mpjpe_mm"), "pa_mpjpe_mm": mean("pa_mpjpe_mm"), "reproj_px_at_1024": mean("reproj_px_at_1024"),
            "root_err_m": mean("root_err_m"), "contact_f1": mean("contact_f1"), "foot_slide_cm_s": mean("foot_slide_cm_s"),
            "per_person": rows}


# ------------------------------------------------------------------------------------------------ SAM 3.1 truth masks
def sam_truth(sam_dir: str, gt_maps: dict, gids: list, objects: list, W: int, H: int) -> dict:
    """Clips whose truth is a video-model re-render: the silhouettes come from SAM 3.1 tracks of the source
    (sam_masks.py). Each track goes to the class-compatible true object whose stage ID mask it overlaps most
    (mean IoU over the frames both are seen, at least 0.1); that object's stage pixels are then replaced by the
    track's pixels on every frame the track covers. Tracks that overlap nothing in the stage truth (something
    the video model added) are reported, not scored. Edits gt_maps in place; returns a summary."""
    info = json.load(open(os.path.join(sam_dir, "sam.json")))
    objs = {o["id"]: o for o in objects}
    gk_cls = {k: canon(objs.get(g) or {"cls": "thing"}) for k, g in enumerate(gids)}
    frames = sorted(gt_maps)
    tracks = {}
    for key, t in sorted((info.get("tracks") or {}).items()):
        files = imgio.listing(os.path.join(sam_dir, key))
        ms = {}
        for f in frames:
            if f in files:
                m = imgio.read(files[f], 3)[..., 0] > 127
                m, ok = imgio.fit_width(m.astype(np.uint8), W, H, nearest=True)
                ms[f] = (m > 0) & ok
        if ms and sum(int(m.sum()) for m in ms.values()) >= 0.0005 * W * H * len(ms):
            tracks[key] = (t.get("prompt") or "thing", ms)
    assigned, unassigned = {}, []
    for key, (prompt, ms) in tracks.items():
        pc = canon({"cls": prompt, "label": prompt})
        best, best_iou = None, 0.1
        for k in range(len(gids)):
            if not math.isfinite(class_penalty(gk_cls[k], pc)):
                continue
            ious = []
            for f, m in ms.items():
                g = gt_maps[f][0] == k
                if g.any() or m.any():
                    ious.append((m & g).sum() / max(1, (m | g).sum()))
            iou = float(np.mean(ious)) if ious else 0.0
            if iou > best_iou:
                best, best_iou = k, iou
        if best is None:
            unassigned.append({"track": key, "prompt": prompt, "mean_share": round(float(np.mean([m.mean() for m in ms.values()])), 4)})
        else:
            assigned.setdefault(best, []).append((key, ms, best_iou))
    for k, lst in assigned.items():
        for key, ms, _ in lst:
            for f, m in ms.items():
                lab, valid = gt_maps[f]
                lab[lab == k] = -1
        for key, ms, _ in lst:
            for f, m in ms.items():
                lab, valid = gt_maps[f]
                lab[m & valid & (lab < 0)] = k
    return {"source": "SAM 3.1 tracks of the source (" + info.get("model", "sam3.1") + ")", "prompts": info.get("prompts"),
            "assigned": {objs.get(gids[k], {}).get("label") or gids[k]: [(key, round(iou, 3)) for key, _, iou in lst]
                         for k, lst in assigned.items()},
            "unassigned": unassigned}


# ------------------------------------------------------------------------------------------------ main scoring
def score(clip_dir: str, every: int = 2, sheet: bool = False) -> dict:
    J = lambda *p: os.path.join(clip_dir, *p)  # noqa: E731
    truth = json.load(open(J("truth.json")))
    recon = json.load(open(J("recon.json")))
    result = json.load(open(J("recon_result.json"))) if os.path.exists(J("recon_result.json")) else {}
    gt_cams, rc_cams = by_frame(truth["camera"]), by_frame(recon["camera"])
    gt_ids = imgio.listing(J(truth.get("id_dir") or "truth_id"))
    rc_ids = imgio.listing(J(recon.get("id_dir") or "recon_id"))
    rc_cols = imgio.listing(J(recon.get("color_dir") or "recon_color"))
    n_src = imgio.probe(J("source.mp4"))[2] if os.path.exists(J("source.mp4")) else 10 ** 6
    frames = sorted(f for f in gt_cams if f in rc_cams and f % every == 0 and f < n_src)
    if len(frames) < 2:
        raise SystemExit(f"{clip_dir}: fewer than 2 common frames")
    A = align(gt_cams, rc_cams, frames)
    cam = camera_metrics(truth, recon, gt_cams, rc_cams, frames, A)

    # Objects in the frame: the truth's ID pass decides what is visible.
    W, H = int(recon["width"]), int(recon["height"])
    gpal, rpal = truth.get("id_palette") or {}, recon.get("id_palette") or {}
    gids, rids = list(gpal), list(rpal)
    img_frames = [f for f in frames if f in gt_ids and f in rc_ids]
    probe_f = img_frames[:: max(1, len(img_frames) // 4)][:4]
    gpal = pick_palette([imgio.read(gt_ids[f], 4) for f in probe_f], gpal)
    rpal = pick_palette([imgio.read(rc_ids[f], 4) for f in probe_f], rpal)
    gtol, rtol = palette_tolerance(gpal), palette_tolerance(rpal)
    src = imgio.video_frames(J("source.mp4"), img_frames, width=W) if os.path.exists(J("source.mp4")) else {}
    vis_px = {}                       # gt id -> max visible share
    gt_maps, rc_maps = {}, {}
    nG, nR = len(gids), len(rids)
    iou_sum = np.zeros((nG, nR))
    vis_n = np.zeros(nG)
    for f in img_frames:
        g_img = imgio.read(gt_ids[f], 4)
        g_lab = decode_ids(g_img, gpal, gtol)
        g_lab, valid = imgio.fit_width(g_lab, W, H, nearest=True)
        g_lab[~valid] = -1
        gt_maps[f] = (g_lab.astype(np.int16), valid)
    truth_masks = {"source": "stage ID pass" if truth.get("exact", True) else "stage ID pass (video-model re-render: approximate)"}
    if not truth.get("exact", True) and os.path.isdir(J("sam")):
        truth_masks = sam_truth(J("sam"), gt_maps, gids, truth["objects"], W, H)
    for f in img_frames:
        g_lab, valid = gt_maps[f]
        g_lab = g_lab.astype(np.int32)
        r_lab = decode_ids(imgio.read(rc_ids[f], 4), rpal, rtol)
        gt_maps[f], rc_maps[f] = (g_lab, valid), r_lab
        cnt = np.bincount(g_lab[g_lab >= 0].ravel(), minlength=len(gids))
        tot = max(1, int(valid.sum()))
        for k, c in enumerate(cnt):
            if c:
                vis_px[gids[k]] = max(vis_px.get(gids[k], 0.0), c / tot)
        if nG and nR:
            rv = np.where(valid, r_lab, -1)
            joint = np.bincount(((g_lab + 1) * (nR + 1) + (rv + 1)).ravel(), minlength=(nG + 1) * (nR + 1)).reshape(nG + 1, nR + 1)
            inter = joint[1:, 1:].astype(float)
            ag, ar = joint[1:, :].sum(1).astype(float), joint[:, 1:].sum(0).astype(float)
            seen = ag >= 0.00005 * tot
            iou_sum[seen] += inter[seen] / np.maximum(1, ag[seen, None] + ar[None, :] - inter[seen])
            vis_n[seen] += 1
    MIN_SHARE = 0.0001                # about 60 px at 1024 x 576: a cyclist seen from a 20 m drone counts
    gobjs = {o["id"]: o for o in truth["objects"]}
    gts = [(o, canon(o), Track(o)) for o in truth["objects"] if vis_px.get(o["id"], 0) >= MIN_SHARE]
    rcs = [(o, canon(o), Track(o)) for o in recon["objects"]]
    gk_of = {g: k for k, g in enumerate(gids)}
    rk_of = {r: k for k, r in enumerate(rids)}

    def img_iou(gid, rid):
        k, j = gk_of.get(gid), rk_of.get(rid)
        if k is None or j is None or vis_n[k] == 0:
            return 0.0
        return float(iou_sum[k, j] / vis_n[k])
    gmatch = match_objects(gts, rcs, A, frames, img_iou)
    rmatched = {v[0] for v in gmatch.values()}
    rstrict = {v[0] for v in gmatch.values() if not v[2]}

    # Layout numbers.
    def layout(kind):
        sel = [i for i, (o, c, _) in enumerate(gts) if (c in STRUCTURE) == (kind == "structure")]
        rsel = [j for j, (o, c, _) in enumerate(rcs) if (c in STRUCTURE) == (kind == "structure")]
        rows, size_e, size_p, place, orient, dE, cover, head = [], [], [], [], [], [], [], []
        for i in sel:
            g, gc, gt = gts[i]
            row = {"id": g["id"], "label": g.get("label"), "cls": gc, "visible_share": round(vis_px.get(g["id"], 0), 4)}
            if i in gmatch:
                j, cost, weak = gmatch[i]
                r, rc_, rt = rcs[j]
                row.update(recon_id=r["id"], recon_label=r.get("label"), recon_cls=rc_, weak=weak)
                ds, d3 = [], []
                for f in frames:
                    eg, er = gt.at(f), rt.at(f)
                    if eg is None or er is None:
                        continue
                    p = apply(A, er["c"])
                    d3.append(float(np.linalg.norm(p - np.asarray(eg["c"], float))))
                    ds.append(math.hypot(p[0] - eg["c"][0], p[2] - eg["c"][2]))
                gs = np.asarray((gt.first or {}).get("size") or g.get("size"), float)
                rs = np.asarray((rt.first or {}).get("size"), float)       # the reconstruction's own metres: real size
                gsz = np.array([min(gs[0], gs[2]), gs[1], max(gs[0], gs[2])])
                rsz = np.array([min(rs[0], rs[2]), rs[1], max(rs[0], rs[2])])
                err = np.abs(rsz - gsz)
                tau_p = max(1.0, 0.5 * diag_xz(gs)) if kind == "thing" else max(2.0, 0.5 * diag_xz(gs))
                row["placed"] = bool(ds) and float(np.mean(ds)) <= tau_p
                row["image_iou"] = round(img_iou(g["id"], r["id"]), 3)
                row.update(place_err_m=round(float(np.mean(d3)), 2) if d3 else None, place_err_ground_m=round(float(np.mean(ds)), 2) if ds else None,
                           size_true=[round(v, 2) for v in gsz], size_recon=[round(v, 2) for v in rsz],
                           size_err_m=[round(v, 2) for v in err], size_err_pct=round(float(np.mean(err / np.maximum(gsz, 0.05))) * 100, 0))
                if kind == "thing":
                    size_e.append(err)
                    size_p.append(float(np.mean(err / np.maximum(gsz, 0.05))) * 100)
                    if d3:
                        place.append(float(np.mean(d3)))
                    sym = g.get("sym") or ("none" if gc in ("person", "car", "truck", "bicycle", "horse", "dog", "chair", "sofa", "bench") else "2")
                    if sym != "round":
                        period = {"none": 360.0, "2": 180.0, "4": 90.0}.get(sym, 360.0)
                        e0, e1 = gt.at(frames[0]), rt.at(frames[0])
                        if e0 is not None and e1 is not None:
                            oe = ang_diff(aligned_yaw(A, e1["yaw"]), e0["yaw"], period)
                            orient.append(oe)
                            row["orient_err_deg"] = round(oe, 1)
                    rcol = (r.get("appearance") or {}).get("color") or r.get("color")
                    gcol = (g.get("appearance") or {}).get("color") or g.get("color")    # a painted car: its paint, not its tyres
                    la, lb = hex_to_lab(gcol), hex_to_lab(rcol)
                    if la is not None and lb is not None:
                        de = float(np.linalg.norm(la - lb))
                        dE.append(de)
                        row["colour_dE"] = round(de, 1)
                        row["colour_true"], row["colour_recon"] = gcol, rcol
            else:
                row["missing"] = True
            # Movers: did the reconstruction follow the path, facing the right way?
            if g.get("dynamic") and not gt.static and len(gt.keys) > 1:
                pts = np.array([gt.fr[k]["c"] for k in gt.keys], float)
                plen = float(np.linalg.norm(np.diff(pts[:, [0, 2]], axis=0), axis=1).sum())
                if plen > 1.0:
                    tau = max(1.0, 0.5 * diag_xz(gs if i in gmatch else (gt.first or {}).get("size") or [1, 1, 1]))
                    hit, hd, n = 0, [], 0
                    for f in frames:
                        eg = gt.at(f)
                        if eg is None:
                            continue
                        n += 1
                        if i in gmatch:
                            er = rcs[gmatch[i][0]][2].at(f)
                            if er is not None:
                                p = apply(A, er["c"])
                                if math.hypot(p[0] - eg["c"][0], p[2] - eg["c"][2]) <= tau:
                                    hit += 1
                                eprev = gt.at(f - 1) or gt.at(f - 2)
                                if eprev is not None and math.hypot(eg["c"][0] - eprev["c"][0], eg["c"][2] - eprev["c"][2]) * 24 / max(1, f - eprev.get("f", f - 1)) > 0.3:
                                    hd.append(ang_diff(aligned_yaw(A, er["yaw"]), eg["yaw"], 360))
                    row["path_m"] = round(plen, 1)
                    row["path_coverage"] = round(hit / max(1, n), 2)
                    row["heading_err_deg"] = round(float(np.mean(hd)), 1) if hd else None
                    cover.append(hit / max(1, n))
                    if hd:
                        head.append(float(np.mean(hd)))
            rows.append(row)
        matched = sum(1 for i in sel if i in gmatch)
        rec_n = len(rsel)
        rec_m = sum(1 for j in rsel if j in rmatched)
        placed = sum(1 for r in rows if r.get("placed"))
        strict = sum(1 for i in sel if i in gmatch and not gmatch[i][2])
        rec_s = sum(1 for j in rsel if j in rstrict)
        out = {"true_in_frame": len(sel), "recon": rec_n, "matched": strict, "class_matched": matched, "placed": placed,
               "recall": round(strict / len(sel), 3) if sel else None, "class_recall": round(matched / len(sel), 3) if sel else None,
               "placed_recall": round(placed / len(sel), 3) if sel else None,
               "precision": round(rec_s / rec_n, 3) if rec_n else None}
        if kind == "thing":
            se = np.array(size_e) if size_e else None
            out.update(size_err_m={"short": round(float(se[:, 0].mean()), 2), "height": round(float(se[:, 1].mean()), 2),
                                   "long": round(float(se[:, 2].mean()), 2)} if se is not None else None,
                       size_err_pct=round(float(np.mean(size_p)), 0) if size_p else None,
                       place_err_m=round(float(np.mean(place)), 2) if place else None,
                       orient_err_deg=round(float(np.mean(orient)), 1) if orient else None,
                       colour_dE=round(float(np.mean(dE)), 1) if dE else None,
                       movers=len(cover), mover_path_coverage=round(float(np.mean(cover)), 2) if cover else None,
                       mover_heading_err_deg=round(float(np.mean(head)), 1) if head else None)
        out["missing"] = [r["label"] for r in rows if r.get("missing") or r.get("weak")]   # not found where it is
        out["weak"] = [r["label"] for r in rows if r.get("weak")]
        out["objects"] = rows
        return out

    things, structure = layout("thing"), layout("structure")
    extra = [rcs[j][0].get("label") for j in range(len(rcs)) if j not in rmatched]
    mover_rows = [o for o in things["objects"] if o.get("path_m")]
    pose = pose_metrics(truth, recon, gt_cams, rc_cams, frames, A, gmatch, gts, rcs)

    # IDENTICAL: the reconstruction played from its own solved camera against the source, frame by frame.
    gindex = {gid: k for k, gid in enumerate(gids)}
    rindex = {rid: k for k, rid in enumerate(rids)}
    pairs = []
    for i, (j, _, weak) in gmatch.items():
        gid, rid = gts[i][0]["id"], rcs[j][0]["id"]
        if gid in gindex and rid in rindex:
            pairs.append((gid, gindex[gid], rindex[rid]))
    pair_of = {gid: rk for gid, gk, rk in pairs}
    in_frame_ids = {o["id"] for o, _, _ in gts}
    obj_iou = {gid: [] for gid in in_frame_ids}
    frame_rows = []
    for f in img_frames:
        g_lab, valid = gt_maps[f]
        r_lab = rc_maps[f]
        tot = max(1, int(valid.sum()))
        gcount = np.bincount(g_lab[g_lab >= 0].ravel(), minlength=len(gids))
        ious, ious_things, inter_sum = [], [], 0
        for gid in in_frame_ids:
            gk = gindex.get(gid)
            if gk is None or gcount[gk] < MIN_SHARE * tot * 0.5:
                continue
            mg = g_lab == gk
            if gid in pair_of:
                mr = (r_lab == pair_of[gid]) & valid
                inter = int((mg & mr).sum())
                iou = inter / max(1, int((mg | mr).sum()))
                inter_sum += inter
            else:
                iou = 0.0
            ious.append(iou)
            obj_iou[gid].append(iou)
            if canon(gobjs[gid]) not in STRUCTURE:
                ious_things.append(iou)
        g_any = int((g_lab >= 0).sum())
        r_obj = (r_lab >= 0) & valid
        matched_r = np.isin(r_lab, [rk for _, _, rk in pairs])
        ghost_px = int((r_obj & ~matched_r).sum())
        for gid, gk, rk in pairs:
            ghost_px += int(((r_lab == rk) & valid & (g_lab != gk)).sum())
        colour = None
        if f in src and f in rc_cols:
            s_img, s_valid = imgio.fit_width(src[f], W, H)
            r_img = imgio.read(rc_cols[f], 3)
            if r_img.shape[:2] == (H, W):
                m = s_valid & valid
                d = np.linalg.norm(rgb_to_lab(s_img[m] / 255.0) - rgb_to_lab(r_img[m] / 255.0), axis=-1)
                colour = float(np.clip(1 - d / 50.0, 0, 1).mean())
        miou = float(np.mean(ious)) if ious else 0.0
        explained = inter_sum / max(1, g_any)
        fr = {"f": f, "miou": round(miou, 3), "miou_things": round(float(np.mean(ious_things)), 3) if ious_things else None,
              "explained": round(explained, 3), "ghost": round(ghost_px / max(1, int(r_obj.sum())), 3) if r_obj.any() else 0.0,
              "colour_sim": round(colour, 3) if colour is not None else None,
              "objects_in_frame": len(ious), "frame_share_objects": round(g_any / tot, 3)}
        fr["match"] = round(100 * (0.5 * miou + 0.3 * explained + 0.2 * (colour if colour is not None else 0.0)), 1)
        frame_rows.append(fr)
    mean = lambda k: round(float(np.mean([r[k] for r in frame_rows if r.get(k) is not None])), 3) if any(r.get(k) is not None for r in frame_rows) else None  # noqa: E731
    per_obj = sorted(((gobjs[g].get("label") or g, round(float(np.mean(v)), 3)) for g, v in obj_iou.items() if v), key=lambda x: -x[1])
    identical = {"frames": len(frame_rows), "match_score": round(float(np.mean([r["match"] for r in frame_rows])), 1) if frame_rows else None,
                 "miou": mean("miou"), "miou_things": mean("miou_things"), "explained": mean("explained"), "ghost": mean("ghost"),
                 "colour_sim": mean("colour_sim"), "frame_share_objects": mean("frame_share_objects"),
                 "per_object_iou": dict(per_obj), "per_frame": frame_rows,
                 "formula": "100 x (0.5 mIoU + 0.3 explained + 0.2 colour), averaged over frames"}

    scale = {"recon_m_per_true_m": round(1 / A["s"], 3), "scale_err_pct": round(abs(1 / A["s"] - 1) * 100, 1),
             "from": A["mode"], "cam_height_true_m": round(A["cam_height_true_m"], 2), "cam_height_recon_m": round(A["cam_height_recon_m"], 2)}
    out = {"clip": truth.get("clip") or os.path.basename(clip_dir.rstrip("/")), "kind": truth.get("kind"), "exact_truth": truth.get("exact", True),
           "truth_masks": truth_masks,
           "frames_scored": len(frames), "image_frames": len(img_frames), "frame_size": [W, H],
           "camera": cam, "scale": scale, "layout": {"things": things, "structure": structure, "extra_recon": extra},
           "pose": pose, "identical": identical,
           "pipeline": {"wall_s": (result.get("_bench") or {}).get("wall_s"), "summary": result.get("summary"), "notes": result.get("notes"),
                        "timings": result.get("timings")}}
    with open(J("metrics.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    if sheet:
        make_sheet(clip_dir, truth, recon, gt_maps, rc_maps, src, rc_cols, pairs, gids, rids, gt_cams, rc_cams, img_frames, W, H, out)
    return out


# ------------------------------------------------------------------------------------------------ sheets
def _line(img, p, q, col, w=2):
    n = int(max(abs(q[0] - p[0]), abs(q[1] - p[1]))) + 1
    xs = np.linspace(p[0], q[0], n).round().astype(int)
    ys = np.linspace(p[1], q[1], n).round().astype(int)
    for dx in range(-(w // 2), w - w // 2):
        for dy in range(-(w // 2), w - w // 2):
            x, y = xs + dx, ys + dy
            ok = (x >= 0) & (x < img.shape[1]) & (y >= 0) & (y < img.shape[0])
            img[y[ok], x[ok]] = col


def _skeleton(img, pts, col):
    H, W = img.shape[:2]
    P = [None if p is None else (W / 2 + p[0] * W, H / 2 + p[1] * W) for p in pts]
    for a, b in LIMBS:
        if P[a] is not None and P[b] is not None:
            _line(img, P[a], P[b], col, 3)


def make_sheet(clip_dir, truth, recon, gt_maps, rc_maps, src, rc_cols, pairs, gids, rids, gt_cams, rc_cams, frames, W, H, out, n=6):
    """Rows of [source | reconstruction (Color pass) | overlay: recon objects tinted over the source, truth outlines in
    white, truth skeletons green, recon skeletons red]."""
    pick = [frames[int(round(i * (len(frames) - 1) / max(1, n - 1)))] for i in range(min(n, len(frames)))]
    tw = 512
    th = int(round(H * tw / W))
    rows = []
    rng = np.random.default_rng(3)
    rcol = (rng.uniform(60, 255, (len(rids) + 1, 3))).astype(np.uint8)
    gp = {p["object_id"]: by_frame(p["frames"]) for p in truth.get("people") or []}
    rp = {p["object_id"]: by_frame(p["frames"]) for p in recon.get("people") or []}
    for f in pick:
        s_img = imgio.fit_width(src[f], W, H)[0] if f in src else np.zeros((H, W, 3), np.uint8)
        r_img = imgio.read(rc_cols[f], 3) if f in rc_cols else np.zeros((H, W, 3), np.uint8)
        g_lab, valid = gt_maps[f]
        r_lab = rc_maps[f]
        ov = (s_img.astype(np.float32) * 0.55).astype(np.uint8)
        m = r_lab >= 0
        ov[m] = (0.45 * ov[m] + 0.55 * rcol[r_lab[m]]).astype(np.uint8)
        edge = np.zeros_like(m)
        edge[1:, :] |= g_lab[1:, :] != g_lab[:-1, :]
        edge[:, 1:] |= g_lab[:, 1:] != g_lab[:, :-1]
        edge &= valid
        ov[edge] = (255, 255, 255)
        for pid, fr in gp.items():
            if f in fr:
                _skeleton(ov, project(fr[f]["J"], gt_cams[f], float(truth["width"])), (60, 230, 90))
        for pid, fr in rp.items():
            if f in fr:
                _skeleton(ov, project(fr[f]["J"], rc_cams[f], float(recon["width"])), (240, 60, 50))
        tiles = []
        for t in (s_img, r_img, ov):
            ys = (np.arange(th) * H / th).astype(int)
            xs = (np.arange(tw) * W / tw).astype(int)
            tiles.append(t[ys][:, xs])
        row = np.concatenate([tiles[0], np.full((th, 4, 3), 20, np.uint8), tiles[1], np.full((th, 4, 3), 20, np.uint8), tiles[2]], 1)
        rows.append(row)
        rows.append(np.full((4, row.shape[1], 3), 20, np.uint8))
    sheet = np.concatenate(rows[:-1], 0)
    imgio.write(os.path.join(clip_dir, "sheet.jpg"), sheet, quality=86)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip_dir", nargs="+")
    ap.add_argument("--every", type=int, default=2)
    ap.add_argument("--sheet", action="store_true")
    a = ap.parse_args(argv)
    for d in a.clip_dir:
        m = score(d, every=a.every, sheet=a.sheet)
        c, s, L, P, I = m["camera"], m["scale"], m["layout"]["things"], m["pose"], m["identical"]
        print(f"{m['clip']}: MATCH {I['match_score']} | cam ATE {c['ate_m']} m rot {c['rot_err_deg']} deg focal {c['focal_err_pct']}% "
              f"roll {c['roll_err_deg']} deg | scale x{s['recon_m_per_true_m']} | things {L['matched']}/{L['true_in_frame']} "
              f"(prec {L['precision']}) | people {P['people_matched']}/{P['people_true']} MPJPE {P['mpjpe_mm']} mm | "
              f"mIoU {I['miou']} explained {I['explained']} colour {I['colour_sim']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
