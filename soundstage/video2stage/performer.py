"""Video -> Stage, the performer: SAM 3D Body captures the person in the clip (body, hands, fingers) and this puts that
take into the rebuilt set. Every frame, a ray from the tracked camera through the performer's feet lands on the
reconstructed floor: that is where they stand. Their facing comes through the same camera rotation. The stage plays
the take on a clay actor along that path (web/stage/mocap.mjs, mocap.world), so the clay overlays the source shot.
"""
from __future__ import annotations

import math

import numpy as np

from . import convert as C
from . import track as T

MOCAP_MODEL = "sam_3d_body_dinov3_bf16.safetensors"
ANKLE_M = 0.08   # the ankle joint above the sole (m)


def mocap_graph(video: str, name: str) -> dict:
    return {
        "p1": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "p2": {"class_type": "GetVideoComponents", "inputs": {"video": ["p1", 0]}},
        "p3": {"class_type": "SAM3DBody_Loader", "inputs": {"model_file": MOCAP_MODEL}},
        "p4": {"class_type": "SAM3DBody_Predict", "inputs": {"sam3d_body_model": ["p3", 0], "image": ["p2", 0],
                                                             "run_hand_refinement": True, "fov": 0.0, "batch_size": 32}},
        "p5": {"class_type": "SAM3DBody_Smooth", "inputs": {"mhr_pose_data": ["p4", 0], "strength": 0.5, "method": "gaussian",
                                                            "window": 5, "rotation_threshold_degrees": 30.0}},
        "p6": {"class_type": "SoundstageMocap", "inputs": {"mhr_pose_data": ["p5", 0], "fps": ["p2", 2], "track": 0, "name": name}},
    }


def available(names) -> bool:
    return MOCAP_MODEL in (names or [])


def pose_at(poses, times, t: float) -> np.ndarray:
    """The tracked camera (3x4 world-to-camera, cam0 space) at time t: blend of the two nearest samples."""
    if t <= times[0]:
        return np.asarray(poses[0], float)
    if t >= times[-1]:
        return np.asarray(poses[-1], float)
    j = int(np.searchsorted(times, t))
    a = (t - times[j - 1]) / max(1e-9, times[j] - times[j - 1])
    P = (1 - a) * np.asarray(poses[j - 1], float) + a * np.asarray(poses[j], float)
    U, _, Vt = np.linalg.svd(P[:, :3])            # back to a proper rotation
    P[:, :3] = U @ Vt
    return P


def _smooth(a: np.ndarray, w: int = 3) -> np.ndarray:
    out = a.copy()
    for i in range(len(a)):
        lo, hi = max(0, i - w), min(len(a), i + w + 1)
        out[i] = a[lo:hi].mean(axis=0)
    return out


def place(take: dict, poses, times, A, b, K, size, clip_fps: float) -> dict | None:
    """Take + tracked camera -> {path: [[x, z]], yaw: [deg], start_frame} in stage space, or None when the take has no
    picture positions. size = (w, h) of the depth frames K belongs to; take["image_size"] = the source video's."""
    px = take.get("px") or []
    n = int(take.get("frames") or 0)
    if not px or len(px) != n:
        return None
    w, h = size
    img = take.get("image_size") or []
    W, H = (img[1], img[0]) if len(img) >= 2 else (w, h)   # SAM stores (H, W)
    if W < H and w > h or W > H and w < h:                # guard against an (W, H) order
        W, H = H, W
    sx, sy = w / float(W), h / float(H)
    Rw = A / np.linalg.norm(A[0])
    src = take.get("source_frames") or list(range(n))
    body = np.asarray(take["body"], float)
    feet3 = body[:, [10, 13], 1] + np.asarray(take.get("root") or np.zeros((n, 3)), float)[:, None, 1]
    ground3 = np.percentile(feet3.min(axis=1), 10)
    path, yaw, ok = [], [], []
    for k in range(n):
        t = src[k] / float(clip_fps)
        P = pose_at(poses, times, t)
        R = P[:, :3]
        ra, la = px[k][0], px[k][1]
        foot = ra if ra[1] > la[1] else la                   # the lower foot in the picture carries the weight
        uv = (foot[0] * sx, foot[1] * sy)
        hit, ray = C.ground_point(P, A, b, K, uv)
        if hit is not None:
            # The joint is the ANKLE, ~8 cm above the sole: the ray through it meets that height, not the floor (on a
            # low camera the floor hit is metres too far, which shrinks the clay in the picture).
            o = A @ T.camera_center(P) + b
            if ray[1] < -1e-6 and o[1] > ANKLE_M:
                hit = o + ray * ((ANKLE_M - o[1]) / ray[1])
        airborne = feet3[k].min() - ground3 > 0.12
        path.append(None if hit is None else [float(hit[0]), float(hit[2])])
        ok.append(hit is not None and not airborne)
        # Facing: the hips' left-to-right line in camera space (the take is y/z-flipped), turned into the stage.
        lh, rh = body[k, 11], body[k, 8]
        v_cv = np.array([lh[0] - rh[0], -(lh[1] - rh[1]), -(lh[2] - rh[2])])
        v = Rw @ (R.T @ v_cv)
        v[1] = 0
        fwd = np.cross(v, [0.0, 1.0, 0.0])
        yaw.append(math.degrees(math.atan2(fwd[0], fwd[2])) if np.linalg.norm(fwd) > 1e-6 else (yaw[-1] if yaw else 0.0))
    good = [i for i in range(n) if ok[i]]
    if not good:
        return None
    hits = []
    for k in range(n):
        hk = path[k]
        hits.append(None if hk is None else [hk[0], ANKLE_M, hk[1]])
    # Off the ground (a jump) or feet out of frame: carry the path straight between the contacts around it.
    xs = np.array([path[i] for i in good], float)
    full = np.stack([np.interp(range(n), good, xs[:, 0]), np.interp(range(n), good, xs[:, 1])], axis=1)
    full = _smooth(full, 3)
    yaw_u = np.degrees(np.unwrap(np.radians(yaw)))
    return {"path": [[round(float(x), 3), round(float(z), 3)] for x, z in full],
            "yaw": [round(float(y), 2) for y in _smooth(yaw_u[:, None], 2)[:, 0]],
            "start_frame": int(round(src[0] / float(clip_fps) * C.FPS)),
            "hits": hits, "contact": ok}


# ------------------------------------------------------------------ one lens for the solve and the performer
# SAM 3D Body fits its own focal length to the person (take["focal_px"], on the source picture) and its joints reproject
# onto them with it. The solve used Depth Anything 3's mono focal, which on the street-dance clip was 896 px against
# SAM's 1468 px at 1280 wide (25 mm vs 41 mm): the clay, placed and seen through the solved camera, came out about 2/3
# the dancer's size with its shoulders at her chest (share/QA/v2s_motion_fidelity). The fix: the shot uses ONE set of
# intrinsics (SAM's, when it captured someone) for the camera solve, the set and the performer; then the performer's
# height is fitted so its projection matches SAM's 2D joints (fit_scale).
TORSO = (1, 8, 11)   # neck, r_hip, l_hip (body_names of the take)


def source_size(take: dict, size) -> tuple[float, float]:
    """(W, H) of the picture the take was captured on, the same way round as the proxy frames (size = (w, h))."""
    w, h = size
    img = take.get("image_size") or []
    W, H = (float(img[1]), float(img[0])) if len(img) >= 2 else (float(w), float(h))   # SAM stores (H, W)
    if W < H and w > h or W > H and w < h:
        W, H = H, W
    return W, H


def sam_focal(take: dict, size) -> float | None:
    """SAM 3D Body's focal length on the proxy grid (size = (w, h)), or None."""
    f = take.get("focal_px")
    if not f or not math.isfinite(float(f)) or float(f) <= 0:
        return None
    W, _ = source_size(take, size)
    return float(f) * size[0] / W


def shared_K(K: np.ndarray, take: dict, size, lo_mm: float = 10.0, hi_mm: float = 400.0):
    """The one K for the shot: DA3's principal point with SAM 3D Body's focal (it is fitted to the person, whose
    joints are what the clay must cover). Returns (K, note); K unchanged (note None) when the take has no sane focal."""
    f = sam_focal(take, size)
    if f is None:
        return np.asarray(K, float), None
    mm = C.focal_mm(np.array([[f, 0, 0], [0, f, 0], [0, 0, 1]], float), size[0])
    if not (lo_mm <= mm <= hi_mm):
        return np.asarray(K, float), f"lens: SAM 3D Body's focal ({mm:.0f} mm) is implausible; kept Depth Anything 3's"
    K2 = np.array(K, float).copy()
    old = C.focal_mm(K2, size[0])
    K2[0, 0] = K2[1, 1] = f
    return K2, (f"lens: one focal for the camera, the set and the performer: {mm:.1f} mm from SAM 3D Body "
                f"(Depth Anything 3 guessed {old:.1f} mm)")


def sam_points(take: dict, k: int) -> np.ndarray:
    """The take's body joints at take frame k in SAM's camera space, OpenCV axes (x right, y down, z forward), metres."""
    body = np.asarray(take["body"][k], float)
    root = np.asarray((take.get("root") or [[0.0, 0.0, 0.0]] * (k + 1))[k], float)
    P = body + root
    return np.stack([P[:, 0], -P[:, 1], -P[:, 2]], axis=1)


def project(Xc: np.ndarray, K: np.ndarray) -> np.ndarray:
    z = np.maximum(Xc[:, 2], 1e-6)
    return np.stack([K[0, 0] * Xc[:, 0] / z + K[0, 2], K[1, 1] * Xc[:, 1] / z + K[1, 2]], axis=1)


def sam_2d(take: dict, k: int, size) -> np.ndarray:
    """Where SAM 3D Body saw the joints at take frame k, on the proxy grid: its own camera, its own focal."""
    W, H = source_size(take, size)
    f = float(take["focal_px"])
    uv = project(sam_points(take, k), np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], float))
    return uv * np.array([size[0] / W, size[1] / H])


def stature(take: dict) -> float:
    """The performer's standing height (m) from the take: nose above the ankles at their most upright, plus the head
    top and heel (nose to ankle is ~0.87 of a person's height)."""
    body = np.asarray(take["body"], float)
    up = body[:, 0, 1] - body[:, [10, 13], 1].min(axis=1)
    return float(np.clip(np.percentile(up, 90) / 0.87, 0.9, 2.3))


def clay_points(take: dict, k: int, hit, pose, A, b, scale: float) -> np.ndarray | None:
    """The clay at take frame k in the stage camera's metric space: SAM's body, scaled by `scale` about its lower
    ankle, with that ankle on the stage floor point `hit` (stage metres) the placement found."""
    if hit is None:
        return None
    mpu = float(np.linalg.norm(A[0]))
    p0 = np.linalg.solve(A, np.asarray(hit, float) - b)            # stage -> cam0 (solve units)
    P = np.asarray(pose, float)
    c = (P[:, :3] @ p0 + P[:, 3]) * mpu                            # -> this frame's camera, metres
    J = sam_points(take, k)
    a = J[10] if J[10, 1] > J[13, 1] else J[13]                     # the lower ankle in the picture (y down)
    return c + scale * (J - a)


def overlay_error(take: dict, placed: dict, poses, times, A, b, K, size, clip_fps: float, scale: float = 1.0,
                  frames=None) -> dict:
    """How well the clay covers the performer through the stage camera: per contact frame, the projected torso
    (neck to mid-hip, px) of the clay and of SAM's own 2D joints, and the mean joint error over SAM's torso length."""
    src = take.get("source_frames") or list(range(int(take.get("frames") or 0)))
    tc, ts, errs = [], [], []
    ks = frames if frames is not None else [k for k, ok in enumerate(placed.get("contact") or []) if ok]
    for k in ks:
        P = pose_at(poses, times, src[k] / float(clip_fps))
        X = clay_points(take, k, placed["hits"][k], P, A, b, scale)
        if X is None or (X[:, 2] <= 0.05).any():
            continue
        uv, ref = project(X, K), sam_2d(take, k, size)
        tor = lambda q: float(np.linalg.norm(q[TORSO[0]] - (q[TORSO[1]] + q[TORSO[2]]) / 2))  # noqa: E731
        tc.append(tor(uv)); ts.append(tor(ref))
        errs.append(float(np.linalg.norm(uv - ref, axis=1).mean() / max(1e-6, ts[-1])))
    if not ts:
        return {"frames": 0}
    return {"frames": len(ts), "torso_clay_px": float(np.median(tc)), "torso_sam_px": float(np.median(ts)),
            "size_ratio": float(np.median(np.array(tc) / np.array(ts))), "err_torso": float(np.mean(errs))}


def fit_scale(take: dict, placed: dict, poses, times, A, b, K, size, clip_fps: float) -> float:
    """The clay's scale that makes its projected torso match SAM's (the floor solve's distance and SAM's metric
    distance disagree when the set's scale is off): 1 / the median size ratio, kept within 0.5-2."""
    e = overlay_error(take, placed, poses, times, A, b, K, size, clip_fps, 1.0)
    if not e.get("frames"):
        return 1.0
    return float(np.clip(1.0 / max(1e-6, e["size_ratio"]), 0.5, 2.0))


COLORS = {"black": "#1d1d1f", "white": "#ecebe7", "grey": "#8a8a8a", "gray": "#8a8a8a", "red": "#b3302b", "blue": "#2e4f8a",
          "navy": "#1f2b4a", "green": "#3f6b3a", "olive": "#6b6b3a", "yellow": "#e3b622", "orange": "#e07a24", "tiger": "#e07a24",
          "brown": "#6b4a32", "tan": "#b89470", "beige": "#d8c8a8", "pink": "#e39ab0", "purple": "#6a4a8a", "denim": "#3a4d6e",
          "khaki": "#a89a6a", "gold": "#c9a227", "silver": "#b8b8bc", "plaid": None, "striped": None}
TOPS = {"t-shirt": "tshirt", "tshirt": "tshirt", "tee": "tshirt", "shirt": "shirt", "blouse": "shirt", "jacket": "jacket",
        "hoodie": "hoodie", "sweater": "sweater", "jumper": "sweater", "coat": "coat", "dress": "dress", "tank": "tank",
        "suit": "suit", "uniform": "uniform", "vest": "tank", "top": "tshirt"}
BOTTOMS = {"jeans": "jeans", "trousers": "trousers", "pants": "trousers", "leggings": "trousers", "shorts": "shorts",
           "skirt": "skirt", "joggers": "trousers", "sweatpants": "trousers"}


def appearance_from_label(label: str, color: str | None = None) -> tuple[str, dict]:
    """'person in yellow plaid shirt and tiger-striped leggings' -> (kind, clay wardrobe). Words before a garment colour it."""
    import re
    words = re.findall(r"[a-z]+(?:-[a-z]+)?", (label or "").lower())
    kind = C.person_kind(label or "")
    if kind == "man" and any(w in words for w in ("dress", "skirt", "leggings", "blouse", "she", "her")):
        kind = "woman"
    ap: dict = {}
    for i, w in enumerate(words):
        garment, slot = (TOPS.get(w), "top") if w in TOPS else ((BOTTOMS.get(w), "bottom") if w in BOTTOMS else (None, None))
        if not garment or slot in ap:
            continue
        ap[slot] = garment
        for prev in reversed(words[max(0, i - 3):i]):
            c = COLORS.get(prev.split("-")[0])
            if c:
                ap[f"{slot}_color"] = c
                break
    if "top" in ap and "top_color" not in ap and color:
        ap["top_color"] = color
    return kind, ap


def attach(scene: dict, take_file: str, take: dict, placed: dict, name: str = "Performer") -> str:
    """Give the clip's person (the VLM's nearest person, else a new one) the take, standing on its path."""
    people = [a for a in scene["actors"] if a.get("kind") in ("man", "woman", "child") and not a.get("mount_id")]
    x0, z0 = placed["path"][0]
    if people:
        a = min(people, key=lambda p: math.hypot(p["position"][0] - x0, p["position"][2] - z0))
    else:
        a = {"id": "performer", "name": name, "kind": "man", "height_m": 1.75, "appearance": {}}
        scene["actors"].append(a)
    a["position"] = [x0, 0.0, z0]
    a["keys"] = [{"frame": 0, "position": [x0, 0.0, z0]}]
    a["rotation_deg"] = placed["yaw"][0]
    label = (a.get("source") or {}).get("label") or a.get("label") or a.get("name") or ""
    a["name"] = short_name(label) or name   # "Person in yellow plaid shirt and tiger-s" (cut at 40) reads badly
    if label:
        kind, ap = appearance_from_label(label, (a.get("appearance") or {}).get("color") or a.get("color"))
        a["kind"] = kind
        a["appearance"] = {**(a.get("appearance") or {}), **ap}
    a["mocap"] = {"file": take_file, "name": take_file.rsplit("/", 1)[-1].split("_2")[0], "start": placed["start_frame"],
                  "travel": True, "speed": 1, "loop": False, "world": {"path": placed["path"], "yaw": placed["yaw"]}}
    return a["id"]


def short_name(label: str, limit: int = 24) -> str:
    """A person's name for the timeline and outliner: the vision model's label when it is short, else "Performer"."""
    label = " ".join(str(label or "").split())
    if not label or len(label) > limit:
        return "Performer"
    return label[:1].upper() + label[1:]


def cutout(take: dict, mpu: float, pad: float = 0.18) -> dict | None:
    """The performer's box in the first frame (normalised image coords) and how far away they stand (depth units),
    so the stage can cut their frozen relief out of the first-frame set mesh (the clay actor replaces it)."""
    f = take.get("focal_px")
    img = take.get("image_size") or []
    if not f or len(img) < 2 or not take.get("body"):
        return None
    W, H = float(max(img)), float(min(img))
    body = np.asarray(take["body"][0], float)
    root = np.asarray((take.get("root") or [[0, 0, 0]])[0], float)
    pts = body + root
    pts = np.concatenate([pts, np.asarray(take["hands"][0], float) + root]) if take.get("hands") else pts
    z = -pts[:, 2]                                         # the take is y/z-flipped: camera depth = -z
    if (z <= 0.1).any():
        return None
    # Which way round is the frame? Try both and keep the one that lands inside the picture.
    best = None
    for w, h in ((W, H), (H, W)):
        u = f * pts[:, 0] / z + w / 2
        v = -f * pts[:, 1] / z + h / 2
        box = [u.min() / w, v.min() / h, u.max() / w, v.max() / h]
        inside = sum(0 <= c <= 1 for c in box)
        if best is None or inside > best[0]:
            best = (inside, box)
    x0, y0, x1, y1 = best[1]
    dx, dy = (x1 - x0) * pad, (y1 - y0) * pad * 0.5
    box = [max(0.0, x0 - dx), max(0.0, y0 - dy), min(1.0, x1 + dx), min(1.0, y1 + dy)]
    return {"box": [round(v, 4) for v in box], "max_depth": round(float((np.median(z) + 0.8) / mpu), 4),
            "min_depth": round(float(max(0.05, np.median(z) - 1.2) / mpu), 4)}


def camera_drifted(scene: dict, breakdown: dict, max_rise: float = 0.8, max_travel: float = 2.5) -> bool:
    """A handheld / locked-off camera (by the vision model's read) whose solved track climbs or travels more than a
    person could carry it: mono depth mistook the subject's motion for the camera's."""
    keys = (scene.get("shots") or [{}])[0].get("camera_keys") or []
    if len(keys) < 2:
        return False
    kinds = " ".join(((breakdown.get(k) or {}).get("type") or "") for k in ("camera", "camera_end")).lower()
    if any(w in kinds for w in ("drone", "crane", "aerial", "jib", "helicopter")):
        return False   # these really climb and travel
    if any(w in kinds for w in ("dolly", "tracking", "car", "vehicle", "steadicam", "gimbal")):
        max_travel = 8.0   # a moving camera may travel, but it does not climb metres
    ys = [k["position"][1] for k in keys]
    p0 = keys[0]["position"]
    travel = max(math.hypot(k["position"][0] - p0[0], k["position"][2] - p0[2]) for k in keys)
    return max(ys) - min(ys) > max_rise or travel > max_travel


def drop_background_people(scene: dict, keep_id: str, min_height: float = 0.2) -> int:
    """Other people the vision model saw who are tiny in frame (far background walkers): mono depth puts them metres
    too close, so leave them out once the performer is captured. Returns how many were dropped."""
    out, n = [], 0
    for a in scene["actors"]:
        bb = (a.get("source") or {}).get("bbox_start")
        if a.get("id") != keep_id and a.get("kind") in ("man", "woman", "child") and bb and (bb[3] - bb[1]) / 1000 < min_height:
            n += 1
            continue
        out.append(a)
    scene["actors"] = out
    return n
