"""“Follows your blocking %”: how closely a take kept to the stage.

We own the ground truth the other tools have to estimate: the clay camera and every actor's mark on every frame.

  actors   each actor's stage volume projected through the shot camera (a box per frame) against where the take
           really put it: the final's SAM 3.1 track of that kind (person, horse, car...), matched to the actor
           whose stage box it overlaps best. Per-actor IoU over time; "on its mark" = IoU >= 0.3.
  camera   the move: the global motion of the final (OpenCV feature tracks, actors masked out, a RANSAC similarity
           fit between frames a few apart) against the motion the stage camera gives the static set between the
           same frames (ground and backdrop points pushed through both cameras). Per step: does the picture move
           the same way (direction of pan/tilt/track and push/pull), or hold still when the camera holds?

Score = 0.6 x actors + 0.4 x camera when both can be measured, else the one that can. When neither can (no
actor visible, no SAM pass yet, too few features) the take is INCONCLUSIVE, never a pass.

Pure numpy (+ OpenCV for the camera part); the SAM 3.1 pass runs in the SoundstageBlockingScore node.
"""
from __future__ import annotations

import math

import numpy as np

ON_MARK = 0.3             # box IoU at which an actor counts as on its mark (stage volumes are boxes, not silhouettes)
MIN_ACTOR_FRAMES = 4
MIN_CAMERA_STEPS = 5

DIMS = {  # rig/kind -> (length or depth, width) in metres, height comes from the scene
    "biped": (0.35, 0.55), "horse": (2.3, 0.65), "dog": (0.9, 0.3), "cat": (0.5, 0.2), "quadruped": (1.2, 0.45),
}


def _dims(a: dict, S) -> tuple[float, float, float, str]:
    from .detect import vehicle_dims
    _, rig, h = S.classify(a)
    k = (a.get("kind") or "").lower()
    if rig == "vehicle":
        ln, wd, ht = vehicle_dims(k, h)
        return ln, wd, ht, rig
    ln, wd = DIMS.get(k) or DIMS.get(rig) or (0.6, 0.6)
    return ln, wd, h, rig


def _to_px(q, W: int, H: int, stage_aspect: float) -> tuple[float, float]:
    """Stage-normalised screen coords -> take pixels. The take is the stage frame centre-cropped to its aspect."""
    A = W / H
    x = q[0] * stage_aspect / A if A < stage_aspect else q[0]
    y = q[1] * A / stage_aspect if A > stage_aspect else q[1]
    return (x + 1) / 2 * W, (1 - y) / 2 * H


def stage_frame(i: int, n_take: int, frames: int) -> int:
    return int(round(i * (frames - 1) / max(1, n_take - 1)))


def tracked_actors(scene: dict) -> list[dict]:
    """The actors a take's blocking is judged on: people, animals and vehicles (not set pieces or props), minus
    the car the camera rides inside (a tracking camera beside its car still sees it)."""
    from ..look import scene as S
    host = (S.follow_host(scene) or {}) if cabin_camera(scene) else {}
    out = []
    for a in scene.get("actors") or []:
        if a.get("set_piece") or (host and a.get("id") == host.get("id")):
            continue
        _, rig, _ = S.classify(a)
        mount = S.mount_host(scene, a)
        if mount is not None and S.classify(mount)[1] == "vehicle":
            continue                          # seated inside a car: the take shows the car, not the person
        if rig in ("biped", "quadruped", "vehicle"):
            out.append(a)
    return out


def stage_boxes(scene: dict, n_take: int, W: int, H: int, frames_idx: list[int] | None = None) -> dict:
    """{actor_id: [box (x0,y0,x1,y1) px clipped to the frame, or None when off screen / behind the camera]} for the
    take frames frames_idx (default: all n_take). Each box is the actor's 3D volume through the shot camera."""
    from ..cine import geometry as G
    from ..look import scene as S
    frames, _ = S.frame_range(scene)
    last = max(1, frames - 1)
    stage_aspect = G.STAGE_ASPECTS.get(str((scene.get("shot") or {}).get("aspect") or "1.85"), G.STAGE_ASPECT)
    idx = list(range(n_take)) if frames_idx is None else list(frames_idx)
    out = {}
    for a in tracked_actors(scene):
        ln, wd, ht, rig = _dims(a, S)
        boxes = []
        for i in idx:
            sf = stage_frame(i, n_take, frames)
            cam = S.camera_at(scene, sf)
            pos, host = S.world_pos(scene, a, sf, last)
            base_y = pos[1] - (0.45 if host is not None else 0.0)     # a rider's position is the seat
            top = ht * (0.62 if host is not None else 1.0)
            yaw = S._yaw_at(host or a, sf, last) if (rig != "biped" or host is not None) else 0.0
            c, s = math.cos(yaw), math.sin(yaw)
            pts = []
            with G.use_aspect(stage_aspect):
                for dx in (-wd / 2, wd / 2):
                    for dz in (-ln / 2, ln / 2):
                        for dy in (0.0, top):
                            w = (pos[0] + dx * c + dz * s, base_y + dy, pos[2] - dx * s + dz * c)
                            q = G.project(w, cam["position"], cam["target"], cam["focal_mm"])
                            if q:
                                pts.append(_to_px(q, W, H, stage_aspect))
            if len(pts) < 8:
                boxes.append(None)
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            x0, x1, y0, y1 = max(0.0, min(xs)), min(float(W), max(xs)), max(0.0, min(ys)), min(float(H), max(ys))
            full = (max(xs) - min(xs)) * (max(ys) - min(ys))
            vis = (x1 - x0) * (y1 - y0)
            # Mostly out of frame (or a sliver at the edge): not judged on this frame.
            boxes.append((x0, y0, x1, y1) if x1 > x0 and y1 > y0 and full > 0 and vis / full >= 0.35 and vis >= 0.0004 * W * H else None)
        out[a.get("id")] = boxes
    return out


def box_iou(a, b) -> float:
    if a is None or b is None:
        return 0.0
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def mask_boxes(masks: np.ndarray, thr: float = 0.5) -> list[list]:
    """[N,K,H,W] track masks -> per object k, per frame: its bbox (x0,y0,x1,y1) or None."""
    m = np.asarray(masks) > thr
    n, k = m.shape[:2]
    out = [[None] * n for _ in range(k)]
    for j in range(k):
        for i in range(n):
            ys, xs = np.nonzero(m[i, j])
            if xs.size >= 4:
                out[j][i] = (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1))
    return out


def match_tracks(stage: dict, tracks: list[list], kinds: dict | None = None, track_kinds: list | None = None) -> dict:
    """Greedy one-to-one: each actor takes the track (of a compatible kind) with the best mean box IoU over the
    frames where its stage box is on screen. {actor_id: track index}."""
    scores = []
    for aid, sb in stage.items():
        frames = [i for i, b in enumerate(sb) if b is not None]
        if not frames:
            continue
        for k, tb in enumerate(tracks):
            if kinds and track_kinds and kinds.get(aid) and track_kinds[k] and kinds[aid] != track_kinds[k]:
                continue
            m = float(np.mean([box_iou(sb[i], tb[i] if i < len(tb) else None) for i in frames]))
            if m > 0.02:
                scores.append((m, aid, k))
    scores.sort(reverse=True)
    out, used = {}, set()
    for m, aid, k in scores:
        if aid in out or k in used:
            continue
        out[aid] = k
        used.add(k)
    return out


def actor_scores(stage: dict, tracks: list[list], names: dict | None = None, kinds: dict | None = None,
                 track_kinds: list | None = None, times: list[float] | None = None) -> list[dict]:
    """Per actor: mean box IoU and the share of on-screen frames on its mark; the frames where it drifts."""
    match = match_tracks(stage, tracks, kinds, track_kinds)
    out = []
    for aid, sb in stage.items():
        frames = [i for i, b in enumerate(sb) if b is not None]
        if len(frames) < MIN_ACTOR_FRAMES:
            continue
        tb = tracks[match[aid]] if aid in match else [None] * len(sb)
        ious = [box_iou(sb[i], tb[i] if i < len(tb) else None) for i in frames]
        on = [x >= ON_MARK for x in ious]
        drift = [frames[j] for j, ok in enumerate(on) if not ok]
        out.append({"id": aid, "name": (names or {}).get(aid, aid), "frames": len(frames), "iou": round(float(np.mean(ious)), 3),
                    "on_mark": round(float(np.mean(on)), 3), "matched": aid in match,
                    "drift_at": [round(times[i], 2) if times else i for i in drift[:12]]})
    return out


# ------------------------------------------------------------------------------------------------- camera

def _back_points(cam: dict, W: int, H: int, stage_aspect: float, far: float = 30.0, grid: int = 9) -> list[tuple]:
    """Static world points the camera sees: a screen grid cast onto the ground (y = 0), or onto a backdrop `far`
    metres away above the horizon."""
    from ..cine import geometry as G
    f, right, up = G.basis(cam["position"], cam["target"])
    with G.use_aspect(stage_aspect):
        half_w = G.SENSOR_W_MM / 2 / cam["focal_mm"]
        half_h = G.sensor_h(stage_aspect) / 2 / cam["focal_mm"]
    pts = []
    for gy in np.linspace(-0.9, 0.9, grid):
        for gx in np.linspace(-0.9, 0.9, grid):
            d = G.norm(G.add(f, G.add(G.mul(right, gx * half_w), G.mul(up, gy * half_h))))
            p = cam["position"]
            if d[1] < -1e-3:
                t = -p[1] / d[1]
                if 0.5 < t < 200:
                    pts.append(G.add(p, G.mul(d, t)))
                    continue
            pts.append(G.add(p, G.mul(d, far)))
    return pts


def _sim(src: np.ndarray, dst: np.ndarray) -> np.ndarray | None:
    """Least-squares similarity dst ~ s R src + t -> (tx, ty, log s, rot) in units of the frame width."""
    if len(src) < 4:
        return None
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    den = (a ** 2).sum()
    if den < 1e-9:
        return None
    p = (a[:, 0] * b[:, 0] + a[:, 1] * b[:, 1]).sum() / den
    q = (a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum() / den
    sc = math.hypot(p, q)
    t = md - ms
    return np.array([t[0], t[1], math.log(max(1e-6, sc)), math.atan2(q, p)])


def expected_motion(scene: dict, n_take: int, pairs: list[tuple[int, int]], W: int, H: int) -> list[np.ndarray | None]:
    """The similarity the stage camera gives the static set between take frames a and b (frame-width units)."""
    from ..cine import geometry as G
    from ..look import scene as S
    frames, _ = S.frame_range(scene)
    stage_aspect = G.STAGE_ASPECTS.get(str((scene.get("shot") or {}).get("aspect") or "1.85"), G.STAGE_ASPECT)
    out = []
    for a, b in pairs:
        ca, cb = S.camera_at(scene, stage_frame(a, n_take, frames)), S.camera_at(scene, stage_frame(b, n_take, frames))
        src, dst = [], []
        with G.use_aspect(stage_aspect):
            for w in _back_points(ca, W, H, stage_aspect):
                qa = G.project(w, ca["position"], ca["target"], ca["focal_mm"])
                qb = G.project(w, cb["position"], cb["target"], cb["focal_mm"])
                if qa and qb and abs(qa[0]) < 1.2 and abs(qb[0]) < 1.2 and abs(qa[1]) < 1.2 and abs(qb[1]) < 1.2:
                    src.append(_to_px(qa, W, H, stage_aspect))
                    dst.append(_to_px(qb, W, H, stage_aspect))
        m = _sim(np.array(src) / W, np.array(dst) / W) if len(src) >= 6 else None
        out.append(m)
    return out


def measured_motion(gray: np.ndarray, pairs: list[tuple[int, int]], masks: list[list] | None = None) -> list[np.ndarray | None]:
    """The take's own global motion between frames a and b: feature tracks (actors masked out), RANSAC similarity."""
    import cv2
    H, W = gray.shape[1:3]
    out = []
    for j, (a, b) in enumerate(pairs):
        m = np.full((H, W), 255, np.uint8)
        for box in (masks[j] if masks else []) or []:
            if box is None:
                continue
            x0, y0, x1, y1 = box
            dx, dy = (x1 - x0) * 0.1, (y1 - y0) * 0.1
            m[int(max(0, y0 - dy)):int(min(H, y1 + dy)), int(max(0, x0 - dx)):int(min(W, x1 + dx))] = 0
        p0 = cv2.goodFeaturesToTrack(gray[a], maxCorners=400, qualityLevel=0.01, minDistance=7, mask=m)
        if p0 is None or len(p0) < 20:
            out.append(None)
            continue
        p1, st, _ = cv2.calcOpticalFlowPyrLK(gray[a], gray[b], p0, None, winSize=(21, 21), maxLevel=3)
        ok = st.ravel() == 1
        if ok.sum() < 20:
            out.append(None)
            continue
        src, dst = p0[ok].reshape(-1, 2), p1[ok].reshape(-1, 2)
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0)
        if M is None or inl is None or inl.sum() < 15:
            out.append(None)
            continue
        sc = math.hypot(M[0, 0], M[1, 0])
        # The fitted translation is about the image origin; express it about the centre like _sim does.
        c = np.array([W / 2, H / 2])
        tc = M[:, :2] @ c + M[:, 2] - c
        out.append(np.array([tc[0] / W, tc[1] / W, math.log(max(1e-6, sc)), math.atan2(M[1, 0], M[0, 0])]))
    return out


def step_agrees(e: np.ndarray, m: np.ndarray, t_thr: float = 0.01, s_thr: float = 0.02) -> bool | None:
    """One step of the move. Components the stage camera clearly has must show in the take the same way: pan/tilt/
    track (the picture's translation, by direction) and push/pull (its scale, by sign). A camera that holds expects a
    picture that holds. Sizes are not compared: near ground and far backdrop move by different amounts."""
    et, mt = np.asarray(e[:2]), np.asarray(m[:2])
    en, mn = float(np.linalg.norm(et)), float(np.linalg.norm(mt))
    checks = []
    if en >= t_thr:
        checks.append(mn >= t_thr * 0.25 and float(np.dot(et, mt)) / (en * mn + 1e-12) > 0.5)
    if abs(e[2]) >= s_thr:
        checks.append(np.sign(m[2]) == np.sign(e[2]) and abs(m[2]) >= s_thr * 0.2)
    if not checks:
        return mn < t_thr * 1.5 and abs(m[2]) < s_thr * 1.5      # the camera holds: so must the picture
    return all(checks)


def camera_agreement(exp: list, meas: list) -> dict:
    """{agree: share of steps that move the way the stage camera does, steps, conclusive}."""
    rows = [step_agrees(e, m) for e, m in zip(exp, meas) if e is not None and m is not None]
    rows = [r for r in rows if r is not None]
    n = len(rows)
    return {"agree": round(float(sum(rows)) / n, 3) if n else None, "steps": n, "conclusive": n >= MIN_CAMERA_STEPS}


def cabin_camera(scene: dict) -> bool:
    """The camera rides inside a car (or looks through the one it rides): its interior moves with the camera, so
    the picture's global motion says nothing about the move."""
    from ..look import scene as S
    from .detect import is_road_vehicle, vehicle_dims
    host = S.follow_host(scene) or {}
    if not host or not is_road_vehicle(host.get("kind")):
        return False
    try:
        c0 = (S.local_camera_path(scene) or [{}])[0]
        ln, wd, _ = vehicle_dims(host.get("kind"), 1.5)
        inside = lambda q: abs(q[0]) < wd / 2 + 0.2 and abs(q[2]) < ln / 2 + 0.2  # noqa: E731
        return inside(c0.get("position") or (99, 0, 99)) and (abs(c0["position"][2]) < ln / 2 - 0.5 or inside(c0.get("target") or (99, 0, 99)))
    except Exception:  # noqa: BLE001
        return False


def combine(actors: list[dict] | None, camera: dict | None) -> dict:
    """One score per take. INCONCLUSIVE (score None) when nothing could be measured; never shown as a pass."""
    act = None
    if actors:
        w = sum(a["frames"] for a in actors)
        act = sum(a["on_mark"] * a["frames"] for a in actors) / w if w else None
    cam = camera.get("agree") if camera and camera.get("conclusive") else None
    if act is not None and cam is not None:
        score, basis = 0.6 * act + 0.4 * cam, "actors and camera"
    elif act is not None:
        score, basis = act, "actors only (camera move not measurable)"
    elif cam is not None:
        score, basis = cam, "camera only (no actor measured yet)"
    else:
        return {"score": None, "verdict": "inconclusive", "basis": "nothing measurable"}
    verdict = "follows" if score >= 0.75 else "drifts" if score >= 0.5 else "ignores"
    return {"score": round(score, 3), "verdict": verdict, "basis": basis,
            "actors_score": round(act, 3) if act is not None else None, "camera_score": round(cam, 3) if cam is not None else None}


def camera_part(gray: np.ndarray, scene: dict, fps: float, step: int = 4, actor_boxes: list | None = None) -> dict:
    """CPU only: the camera-move agreement of a take (grey frames [N,H,W] uint8) against its stage scene.
    actor_boxes: per pair, the boxes to mask out (the final's own actor tracks when the SAM pass ran); default the
    stage boxes."""
    n, H, W = gray.shape
    if cabin_camera(scene):
        return {"agree": None, "steps": 0, "conclusive": False, "why": "the camera rides inside a car"}
    pairs = [(a, a + step) for a in range(0, n - step, step)]
    if actor_boxes is None:
        sb = stage_boxes(scene, n, W, H, frames_idx=[p[0] for p in pairs])
        masks = [[sb[aid][j] for aid in sb] for j in range(len(pairs))]
    else:
        masks = actor_boxes
    exp = expected_motion(scene, n, pairs, W, H)
    meas = measured_motion(gray, pairs, masks)
    res = camera_agreement(exp, meas)
    res["pairs"] = len(pairs)
    return res
