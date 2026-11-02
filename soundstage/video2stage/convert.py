"""Tracked cameras + the model's breakdown -> a Soundstage scene (metres, Y up, rotation_deg 0 faces +Z, north = +Z).

Like Magnific's "3D Scenes from video", the clip is rebuilt as an editable layout, not a scan:
- hero subjects are library kinds at real size (a pickup is a 5 m truck, a sedan a 4.5 m car), each with a
  start mark and, if it moves, an end mark (one end-pose track per mover);
- the set is clay primitives at real dimensions: road with 3.6 m lanes and painted lines, water, cliffs,
  shrubs, mountains...;
- the source camera move is a handful of camera_keys (frame, position, target, focal_mm) you can drag in Top view.
"""
from __future__ import annotations

import math
import re

import numpy as np

from ..agent import build as B
from ..agent import catalog as C
from ..agent.validate import validate_scene
from . import track as T

FPS = 24
SENSOR_W_MM = 36.0
LANE_M = 3.6
ROAD_LEN = 320.0

# model kind -> (library kind, height_m): the library scales its footprint with the height.
SIZES = {"car": ("car", 1.45), "suv": ("car", 1.6), "pickup": ("truck", 2.0), "van": ("truck", 2.0),
         "truck": ("truck", 2.6), "bus": ("truck", 3.6), "motorcycle": ("motorcycle", 1.15),
         "bicycle": ("bicycle", 1.05), "horse": ("horse", 1.6), "dog": ("dog", 0.6), "boat": ("boat", 1.5)}
VEHICLES = {"car", "suv", "pickup", "van", "truck", "bus", "motorcycle", "bicycle"}
CAMERA_HEIGHT = {"drone": 25.0, "crane": 6.0, "vehicle": 1.4, "handheld": 1.6, "ground": 1.6}
COLOURS = {"road": "#3b3b3f", "line": "#e8e8e4", "yellow": "#d8c451", "water": "#1c6fae", "sand": "#d9c9a3",
           "cliff": "#8b7f6d", "bank": "#a08d66", "mountain": "#857456", "shrub": "#6a6942", "rock": "#8f8574",
           "grass": "#6f8f4a", "sidewalk": "#bdbab3", "plaza": "#c9c2b6", "rail": "#b8b8b4", "wall": "#a9a39a",
           "building": "#b3aca1"}


# ---------------------------------------------------------------------------------------------- cameras
def focal_mm(K: np.ndarray, width: int) -> float:
    return round(float(K[0, 0]) * SENSOR_W_MM / float(width), 1)


def camera_keys(poses, A, b, times, K, width, look_dist) -> list[dict]:
    """World-to-camera poses (cam0 space) -> stage camera keys, one per sampled frame."""
    Rw = A / np.linalg.norm(A[0])
    f = focal_mm(K, width)
    keys = []
    for i, (P, t) in enumerate(zip(poses, times)):
        pos = A @ T.camera_center(P) + b
        fwd = Rw @ T.camera_forward(P)
        fwd /= np.linalg.norm(fwd)
        d = float(look_dist[i] if hasattr(look_dist, "__len__") else look_dist)
        tgt = pos + fwd * d
        keys.append({"frame": int(round(t * FPS)), "position": [round(float(v), 3) for v in pos],
                     "target": [round(float(v), 3) for v in tgt], "focal_mm": f})
    # Two samples can round onto one frame on very short clips: keep the later one.
    out = {}
    for k in keys:
        out[k["frame"]] = k
    return [out[fr] for fr in sorted(out)]


def smooth_keys(keys: list[dict]) -> list[dict]:
    """[1 2 1]/4 on position and aim (ends kept): mono tracking jitters a few centimetres to decimetres per sample,
    which would otherwise survive as wobbly keys on a slow push-in."""
    if len(keys) < 3:
        return keys
    out = [dict(keys[0])]
    for i in range(1, len(keys) - 1):
        k = dict(keys[i])
        for f in ("position", "target"):
            k[f] = [round((keys[i - 1][f][j] + 2 * keys[i][f][j] + keys[i + 1][f][j]) / 4, 3) for j in range(3)]
        out.append(k)
    out.append(dict(keys[-1]))
    return out


def _angle(a, b) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
    return math.degrees(math.acos(min(1.0, max(-1.0, c))))


def simplify_keys(keys: list[dict], pos_tol: float | None = None, ang_tol: float = 3.0, max_keys: int = 8) -> list[dict]:
    """Fewest keys that keep the move: split where a dropped key strays more than pos_tol metres or ang_tol degrees
    from the straight interpolation between the kept ones (Ramer-Douglas-Peucker on position + aim)."""
    if len(keys) <= 2:
        return keys
    P = [np.array(k["position"], float) for k in keys]
    D = [np.array(k["target"], float) - p for k, p in zip(keys, P)]
    path = sum(float(np.linalg.norm(P[i + 1] - P[i])) for i in range(len(P) - 1))
    tol = pos_tol if pos_tol is not None else max(0.15, 0.03 * path)
    F = [k["frame"] for k in keys]

    def err(a, z, i):
        u = (F[i] - F[a]) / max(1e-6, F[z] - F[a])
        pe = float(np.linalg.norm(P[a] + (P[z] - P[a]) * u - P[i]))
        de = _angle(D[a] + (D[z] - D[a]) * u, D[i])
        return max(pe / tol, de / ang_tol)

    keep = {0, len(keys) - 1}

    def split(a, z):
        if z - a < 2:
            return
        e, i = max((err(a, z, i), i) for i in range(a + 1, z))
        if e > 1:
            keep.add(i)
            split(a, i)
            split(i, z)
    split(0, len(keys) - 1)
    idx = sorted(keep)
    while len(idx) > max_keys:   # drop the key whose removal costs least
        costs = [(err(idx[j - 1], idx[j + 1], idx[j]), j) for j in range(1, len(idx) - 1)]
        idx.pop(min(costs)[1])
    return [keys[i] for i in idx]


# ---------------------------------------------------------------------------------------------- objects
def bbox_px(bb, w, h):
    return [bb[0] / 1000 * w, bb[1] / 1000 * h, bb[2] / 1000 * w, bb[3] / 1000 * h]


def _depth_point(pose, A, b, K, uv, depth, scale):
    z = float(T.sample_depth(depth, np.array([uv], float))[0]) * scale
    if not (z > 0 and math.isfinite(z)):
        return None
    R, t = pose[:, :3], pose[:, 3]
    p_cam = T.unproject(np.array([uv], float), np.array([z]), K)[0]
    p = A @ (R.T @ (p_cam - t)) + b
    return np.array([p[0], 0.0, p[2]])


def ground_point(pose, A, b, K, uv, depth=None, scale=1.0, max_dist=400.0, check_uv=None):
    """Stage-space floor point under pixel uv seen from a tracked camera: the ray's y=0 hit, else the depth."""
    Rw = A / np.linalg.norm(A[0])
    ray_c = np.linalg.inv(K) @ np.array([uv[0], uv[1], 1.0])
    R, t = pose[:, :3], pose[:, 3]
    o = A @ T.camera_center(pose) + b
    d = Rw @ (R.T @ ray_c)
    d /= np.linalg.norm(d)
    hit = T.ray_to_ground(o, d, max_dist)
    if hit is not None and depth is not None and check_uv is not None:
        # Feet hidden behind a desk or a foreground figure: the floor ray overshoots. The depth at the body says
        # how far it really is; trust it when the two disagree by more than half.
        alt = _depth_point(pose, A, b, K, check_uv, depth, scale)
        if alt is not None:
            dh = math.hypot(hit[0] - o[0], hit[2] - o[2])
            da = math.hypot(alt[0] - o[0], alt[2] - o[2])
            if dh > 1.5 * da:
                return alt, d
    if hit is not None:
        return hit, d
    if depth is not None:
        z = float(T.sample_depth(depth, np.array([uv], float))[0]) * scale
        if z > 0 and math.isfinite(z):
            p_cam = T.unproject(np.array([uv], float), np.array([z]), K)[0]
            p = A @ (R.T @ (p_cam - t)) + b
            return np.array([p[0], 0.0, p[2]]), d
    return None, d


def person_kind(label: str) -> str:
    """'man' | 'woman' | 'child' from a description, by whole words (leather, feather, weather and other are not
    'her'; a 'women's coat' on a man is still read by the subject words first)."""
    words = set(re.findall(r"[a-z]+", (label or "").lower()))
    if words & {"child", "kid", "kids", "boy", "boys", "toddler", "baby", "children"} or \
            ("girl" in words and not words & {"woman", "women", "lady"}):
        return "child"
    if words & {"woman", "women", "lady", "ladies", "female", "girl", "she", "her", "mother", "grandmother", "bride"}:
        return "woman"
    return "man"


def library_for(o: dict) -> tuple[str | None, float | None]:
    k = o["kind"]
    if k == "person":
        kind = person_kind(o["label"])
        return kind, C.LIBRARY[kind]["height"]
    if k in SIZES:
        return SIZES[k]
    return None, None


def heading(vec) -> float:
    return round(math.degrees(math.atan2(float(vec[0]), float(vec[2]))), 1)


def _footprint_depth(kind, h):
    if kind in C.LIBRARY:
        spec = C.LIBRARY[kind]
        return spec["foot"][1] * h / spec["height"], spec["foot"][0] * h / spec["height"]
    return 1.0, 1.0


def place_objects(objs, cams, A, b, K, size, frames_last, depths=None, scales=None, notes=None):
    """objs: merged model reads (bbox_start / bbox_end). cams: (pose_first, pose_last).
    Returns stage actors with start/end keys and real-size kinds."""
    w, h = size
    notes = notes if notes is not None else []
    ids: set = set()
    out = []
    for o in objs:
        kind, height = library_for(o)
        marks = []
        for which, bb in ((0, o.get("bbox_start")), (1, o.get("bbox_end"))):
            if not bb:
                marks.append(None)
                continue
            x0, y0, x1, y1 = bbox_px(bb, w, h)
            uv = ((x0 + x1) / 2, y1 - 0.02 * (y1 - y0))
            dep = None if depths is None else depths[0 if which == 0 else -1]
            sc = 1.0 if scales is None else scales[0 if which == 0 else -1]
            p, ray = ground_point(cams[which], A, b, K, uv, dep, sc, check_uv=((x0 + x1) / 2, (y0 + y1) / 2))
            if bb[3] >= 975 and bb[1] > 5 and kind in C.PEOPLE:
                # Feet out of frame: the box bottom is not the floor. Hang the head at the person's height instead.
                top, ray = ground_point(cams[which], A, b - np.array([0, height, 0]), K, ((x0 + x1) / 2, y0))
                p = None if top is None else np.array([top[0], 0.0, top[2]])
                if p is None:
                    p, ray = ground_point(cams[which], A, b, K, uv, dep, sc)
            if p is not None and kind:
                # The box's bottom edge is the near side: step half the footprint along the view ray.
                fd, fw = _footprint_depth(kind, height or 1)
                hr = np.array([ray[0], 0.0, ray[2]])
                if np.linalg.norm(hr) > 1e-6:
                    p = p + hr / np.linalg.norm(hr) * min(fd, fw) * 0.5
            marks.append(None if p is None else [round(float(p[0]), 2), 0.0, round(float(p[2]), 2)])
        start, end = marks
        if start is None and end is None:
            notes.append(f"{o['label']}: could not find it on the ground; left out")
            continue
        if start is None:
            start = end
        if not (o.get("moving") and end is not None):
            end = None
        if kind:
            a = B.make_object(kind, ids, kind=kind, label=o["label"][:40].strip().capitalize())
            a["height_m"] = round(height, 2)
        else:
            a = B.make_object(o["label"], ids, label=o["label"][:40].strip().capitalize())
        if o.get("color") and kind not in C.PEOPLE:
            a["appearance"] = {"color": o["color"]}
        a["position"] = list(start)
        a["keys"] = [{"frame": 0, "position": list(start)}]
        cam0 = A @ T.camera_center(cams[0]) + b
        if end is not None and math.dist(start, end) > 0.5:
            a["keys"].append({"frame": frames_last, "position": list(end)})
            a["rotation_deg"] = heading(np.array(end) - np.array(start))
        else:
            a["rotation_deg"] = facing_rotation(o.get("facing"), start, cam0, A, cams[0])
        a["source"] = {"label": o["label"], "bbox_start": o.get("bbox_start"), "bbox_end": o.get("bbox_end")}
        a["_bbox"] = o.get("bbox_start") or o.get("bbox_end")
        a["_boxes"] = [o.get("bbox_start"), o.get("bbox_end")]   # first and last frame: compare boxes from one frame
        out.append(a)
    return out


def facing_rotation(facing, pos, cam_pos, A, pose0) -> float:
    to_cam = np.array(cam_pos) - np.array(pos)
    if facing == "toward":
        return heading(to_cam)
    if facing == "away":
        return heading(-to_cam)
    if facing in ("left", "right"):
        Rw = A / np.linalg.norm(A[0])
        right = Rw @ (pose0[:, :3].T @ np.array([1.0, 0, 0]))   # camera-right in the stage
        return heading(-right if facing == "left" else right)
    return heading(to_cam)


def pick_hero(objs):
    """The subject the shot is about: the biggest in frame of the movers (else of everything)."""
    def area(a):
        bb = (a.get("source") or {}).get("bbox_start") or (a.get("source") or {}).get("bbox_end") or [0, 0, 0, 0]
        bb2 = (a.get("source") or {}).get("bbox_end") or bb
        return max((bb[2] - bb[0]) * (bb[3] - bb[1]), (bb2[2] - bb2[0]) * (bb2[3] - bb2[1]))
    pool = [a for a in objs if len(a["keys"]) > 1] or objs
    return max(pool, key=area) if pool else None


def mount_riders(actors: list[dict]) -> None:
    """A person whose box sits on a horse / bike / bench rides or sits on it; one inside a car's box is its driver
    (or passenger) and sits in it, so no clay figure stands beside the car. Boxes are compared within one frame: a
    driver the model only saw on the last frame is matched against the car's last-frame box."""
    hosts = [a for a in actors if a.get("kind") in C.MOUNTS and a.get("kind") not in C.PEOPLE]
    taken = set()

    def frames_of(a):
        bs = a.get("_boxes") or [a.get("_bbox"), None]
        return [(i, bb) for i, bb in enumerate(bs) if bb]

    for p in actors:
        if p.get("kind") not in C.PEOPLE or not frames_of(p):
            continue
        for hst in hosts:
            if hst["id"] in taken:
                continue
            hit = None
            for i, pb in frames_of(p):
                hb = dict(frames_of(hst)).get(i) or hst.get("_bbox")
                if not hb:
                    continue
                px = (pb[0] + pb[2]) / 2
                if not (hb[0] <= px <= hb[2]):
                    continue
                if pb[3] < hb[1] + 0.2 * (hb[3] - hb[1]) or pb[3] > hb[3] + 0.1 * (hb[3] - hb[1]):
                    continue
                hit = (pb, hb)
                break
            if not hit:
                continue
            p["mount_id"], p["pose"] = hst["id"], C.MOUNTS[hst["kind"]]
            if hst["kind"] in ("car", "truck"):
                p["occupant"] = True   # seated inside: not the clip's performer
                if hst.get("position") is not None:
                    p["position"] = list(hst["position"])
                    p["keys"] = [{"frame": 0, "position": list(hst["position"])}]
            else:
                taken.add(hst["id"])   # one rider per horse or bike; a car seats several
            break


# ---------------------------------------------------------------------------------------------- the set
def _box(pos, size, color, rot=(0, 0, 0)):
    return {"shape": "box", "pos": [round(v, 3) for v in pos], "size": [round(v, 3) for v in size],
            "rot": list(rot), "color": color}


def _custom(ids, name, parts, rot, pos, size_m):
    a = B.make_object(name, ids, kind=None, label=name)
    a.update(kind="custom", recipe={"name": name, "rig": "static", "size_m": [round(v, 2) for v in size_m],
                                    "parts": parts, "set_piece": True},
             height_m=round(max(size_m[1], 0.05), 2), rotation_deg=round(rot, 1))
    a.pop("design", None)
    p = [round(float(pos[0]), 2), 0.0, round(float(pos[2]), 2)]
    a["position"], a["keys"] = p, [{"frame": 0, "position": list(p)}]
    a["set_piece"] = True
    return a


def road_recipe(lanes: int, two_way: bool, length: float = ROAD_LEN) -> tuple[list[dict], float]:
    """Asphalt + painted lines along local +Z, 3.6 m lanes. Returns (parts, width)."""
    lanes = max(1, lanes)
    w = lanes * LANE_M
    parts = [_box([0, 0.02, 0], [w + 1.0, 0.04, length], COLOURS["road"])]
    edge = w / 2 - 0.1
    for s in (-1, 1):
        parts.append(_box([s * edge, 0.045, 0], [0.15, 0.01, length], COLOURS["line"]))
    if two_way and lanes >= 2:
        for s in (-1, 1):
            parts.append(_box([s * 0.12, 0.045, 0], [0.1, 0.01, length], COLOURS["yellow"]))
    dash, gap = 3.0, 9.0
    n = int(length // (dash + gap))
    for i in range(1, lanes):
        x = -w / 2 + i * LANE_M
        if two_way and abs(x) < 0.01:
            continue
        for j in range(n):   # dashed lane lines read as speed in previz
            z = -length / 2 + (j + 0.5) * (dash + gap)
            parts.append(_box([x, 0.045, z], [0.12, 0.01, dash], COLOURS["line"]))
    return parts, w


def road_axis(vehicles, motions, f0) -> np.ndarray:
    """Which way the road runs (unit XZ vector, pointing away from the camera): a line through the traffic when it
    is spread out along the road, else the longest mover's travel, else the camera's view."""
    pts = np.array([[a["position"][0], a["position"][2]] for a in vehicles], float)
    u = None
    if len(pts) >= 3:
        c = pts - pts.mean(0)
        _, sv, vt = np.linalg.svd(c, full_matrices=False)
        if sv[0] > 3 * max(sv[1], 1e-6) and np.ptp(c @ vt[0]) > 25:
            u = np.array([vt[0][0], 0.0, vt[0][1]])
    if u is None and motions:
        ref = motions[int(np.argmax([np.linalg.norm(m) for m in motions]))]
        if np.linalg.norm(ref) > 2:
            u = np.array([ref[0], 0.0, ref[2]])
    if u is None:
        u = np.array(f0, float)
    u = u / np.linalg.norm(u)
    return -u if u @ f0 < 0 else u


def _side_vec(side, left):
    return {"left": left, "right": -left}.get(side)


def build_set(breakdown, movers, cam_path, notes, seed: int = 7):
    """Primitive set dressing from the model's set list. Returns actors."""
    rng = np.random.default_rng(seed)
    ids: set = set()
    out = []
    sets = list(breakdown.get("set") or [])
    types = [s["type"] for s in sets]
    cam0 = np.array(cam_path[0]["position"], float)
    tgt0 = np.array(cam_path[0]["target"], float)
    f0 = tgt0 - cam0
    f0 = np.array([f0[0], 0.0, f0[2]])
    f0 = f0 / (np.linalg.norm(f0) or 1)
    mid = np.mean([k["position"] for k in cam_path], 0)

    # The reference line: the road (along the traffic), else the camera's view.
    vehicles = [a for a in movers if a.get("_vehicle")]
    motions = [np.array(a["keys"][-1]["position"]) - np.array(a["keys"][0]["position"]) for a in vehicles if len(a["keys"]) > 1]
    u = road_axis(vehicles, motions, f0)
    left = np.array([u[2], 0.0, -u[0]])
    rot = heading(u)
    if vehicles:   # parked / unread traffic faces along the road, the way the model said it faces
        for a in vehicles:
            if len(a["keys"]) > 1:
                continue
            fwd = np.array([math.sin(math.radians(a["rotation_deg"])), 0, math.cos(math.radians(a["rotation_deg"]))])
            a["rotation_deg"] = heading(u if fwd @ u >= 0 else -u)
    road = next((s for s in sets if s["type"] == "road"), None)
    half = 0.0
    origin = np.array([mid[0], 0.0, mid[2]])
    if road or vehicles:
        lanes = (road or {}).get("lanes") or 0
        two_way = bool(motions) and any(m @ u < -0.5 * np.linalg.norm(m) for m in motions)
        if not lanes:
            lanes = 4 if two_way else 2
            notes.append(f"road: lane count not read; assumed {lanes} lanes")
        lat = [float((np.array(a["position"]) - origin) @ left) for a in vehicles]
        if lat:
            c = float(np.median(lat))
            # Snap the road so the traffic sits in lane centres.
            w = lanes * LANE_M
            offs = [(-w / 2 + (i + 0.5) * LANE_M) for i in range(lanes)]
            shift = min(offs, key=lambda o: abs(c - o))
            origin = origin + left * (c - shift)
        else:
            # No traffic: centre the road under the camera's line of sight a few metres out.
            origin = cam0 * np.array([1, 0, 1]) + f0 * 10.0
        along = float((mid - origin) @ u)
        origin = origin + u * along
        parts, w = road_recipe(lanes, two_way or (lanes >= 2 and not motions))
        out.append(_custom(ids, "Road", parts, rot, origin, [w + 1, 0.05, ROAD_LEN]))
        half = w / 2 + 0.5
        notes.append(f"road: {lanes} lanes x {LANE_M} m ({'two-way' if two_way else 'one-way'}), {w:.1f} m wide")
    if road or vehicles or any(t in types for t in ("ocean", "mountain", "hill", "cliff", "beach")):
        # The stage floor is 80 m square; outdoor clips run further, so lay terrain under everything.
        out.append(_custom(ids, "Terrain", [_box([0, -0.03, 0], [800, 0.02, 800], COLOURS["bank"])], 0,
                           [mid[0], 0, mid[2]], [800, 0.05, 800]))
    water_side = next((s["side"] for s in sets if s["type"] in ("ocean", "lake", "river")), None)

    dist = {"near": 6.0, "mid": 20.0, "far": 70.0}
    seen = set()
    for s in sets:
        t, side = s["type"], s["side"]
        if t == "road" or (t, side) in seen or (t == "plaza" and any(x[0] == "plaza" for x in seen)):
            continue
        seen.add((t, side))
        sv = _side_vec(side, left)
        base = dist.get(s["distance"], 20.0)
        both = side == "all" and t in ("ocean", "shrubs", "rocks", "mountain", "hill", "guardrail", "grass",
                                       "sidewalk", "cliff", "beach")
        sides = [sv] if sv is not None else ([left, -left] if both else [None])
        for v in sides:
            name_side = "" if v is None else (" (left)" if v @ left > 0 else " (right)")
            if v is None:   # ahead: along the view, past the action
                p0 = origin + f0 * (base + 30.0)
                lat_dir = left
            else:
                p0 = origin + v * (half + base)
                lat_dir = v
            if t in ("ocean", "lake", "river"):
                depth = 400.0 if t == "ocean" else 120.0 if t == "lake" else 40.0
                c = (origin + lat_dir * (half + base + depth / 2)) if v is not None else origin + f0 * (base + 30 + depth / 2)
                parts = [_box([0, 0.015, 0], [ROAD_LEN * 1.6, 0.03, depth], COLOURS["water"])]   # the stage floor is opaque: water sits on it
                out.append(_custom(ids, t.capitalize() + name_side, parts, rot if v is not None else heading(left),
                                   c, [ROAD_LEN * 1.6, 0.4, depth]))
            elif t == "beach":
                c = origin + (lat_dir * (half + base + 7) if v is not None else f0 * (base + 20))
                out.append(_custom(ids, "Beach" + name_side, [_box([0, -0.4, 0], [ROAD_LEN, 0.8, 14], COLOURS["sand"])],
                                   rot, c, [ROAD_LEN, 0.8, 14]))
            elif t == "cliff":
                drop = water_side is not None and (v is None or _side_vec(water_side, left) is not None
                                                   and (_side_vec(water_side, left) @ v) > 0)
                cw = 12.0
                c = origin + (v * (half + 1 + cw / 2) if v is not None else f0 * (base + 30))
                if drop:   # the road sits on a sea cliff; the floor is opaque, so the cliff is its rocky edge
                    parts = [_box([0, 0.6, 0], [ROAD_LEN, 1.2, cw], COLOURS["cliff"])]
                    size = [ROAD_LEN, 1.2, cw]
                else:      # a bank / cut rising beside the road
                    hgt = 8.0 if s["distance"] != "far" else 20.0
                    parts = [_box([0, hgt / 2, 0], [ROAD_LEN, hgt, cw], COLOURS["bank"])]
                    size = [ROAD_LEN, hgt, cw]
                out.append(_custom(ids, ("Sea cliff" if drop else "Roadside bank") + name_side, parts, rot, c, size))
            elif t in ("mountain", "hill"):
                big = t == "mountain"
                far = {"near": 70.0, "mid": 130.0, "far": 220.0}[s["distance"]]
                parts = []
                for i in range(4 if big else 3):
                    along_ = (i - 1.5) * (90 if big else 50) + rng.uniform(-15, 15)
                    r = rng.uniform(40, 65) if big else rng.uniform(20, 35)
                    hh = rng.uniform(30, 55) if big else rng.uniform(10, 22)
                    parts.append({"shape": "cone", "pos": [round(along_, 1), round(hh / 2, 1), round(rng.uniform(-20, 20), 1)],
                                  "size": [round(2 * r, 1), round(hh, 1), round(1.6 * r, 1)], "rot": [0, 0, 0],
                                  "color": COLOURS["mountain"]})
                c = origin + (lat_dir * (half + far) if v is not None else f0 * far)
                out.append(_custom(ids, ("Mountains" if big else "Hills") + name_side, parts,
                                   rot if v is not None else heading(left), c, [360, 60, 140]))
            elif t in ("shrubs", "rocks"):
                parts = []
                for i in range(12 if t == "shrubs" else 6):
                    sz = rng.uniform(1.3, 2.2) if t == "shrubs" else rng.uniform(1.5, 4.0)
                    parts.append({"shape": "sphere", "pos": [round(rng.uniform(-60, 60), 1), round(sz * 0.25, 2),
                                                             round(rng.uniform(-4, 4), 1)],
                                  "size": [round(sz, 2), round(sz * 0.65, 2), round(sz * 0.9, 2)], "rot": [0, 0, 0],
                                  "color": COLOURS["shrub" if t == "shrubs" else "rock"]})
                c = origin + (lat_dir * (half + max(base, 8.0)) if v is not None else f0 * (base + 25))
                out.append(_custom(ids, t.capitalize() + name_side, parts, rot if v is not None else heading(left),
                                   c, [120, 2.2, 9]))
            elif t == "wall" and v is None:
                along = [float((np.array(a["position"]) - cam0) @ f0) for a in movers] or [base]
                c = cam0 * np.array([1, 0, 1]) + f0 * (max(along) + 2.5)
                out.append(_custom(ids, "Back wall", [_box([0, 1.75, 0], [16.0, 3.5, 0.3], COLOURS["wall"])],
                                   heading(f0), c, [16.0, 3.5, 0.3]))
            elif t == "building" and v is None:
                # A facade behind the action, facing the camera.
                along = [float((np.array(a["position"]) - cam0) @ f0) for a in movers] or [base + 20]
                c = cam0 * np.array([1, 0, 1]) + f0 * (max(along) + 6.0)
                out.append(_custom(ids, "Building facade", [_box([0, 4.5, 0], [30.0, 9.0, 1.0], COLOURS["building"])],
                                   heading(f0), c, [30.0, 9.0, 1.0]))
            elif t == "building" and road is not None and v is not None:
                # A street: a row of city blocks on the kerb line, facing the road (two houses read as a suburb).
                rr = np.random.default_rng(seed + len(out))
                widths = rr.uniform(12.0, 20.0, 6)
                heights = rr.uniform(10.0, 26.0, 6)
                tones = ["#8e8378", "#7b7067", "#9a8f83", "#6f6a66", "#a39686", "#857a70"]
                total, x, parts = float(widths.sum()), 0.0, []
                for i, (wd, ht) in enumerate(zip(widths, heights)):
                    x0 = -total / 2 + x
                    parts.append(_box([round(x0 + wd / 2, 2), round(ht / 2, 2), 0], [round(wd - 0.4, 2), round(ht, 2), 12.0], tones[i]))
                    x += wd
                c = origin + v * (half + 3.0 + 6.0)   # pavement, then the block's own depth
                out.append(_custom(ids, "City block" + name_side, parts, heading(-v), c,
                                   [total, float(heights.max()), 12.0]))
            elif t == "trees" or t in ("building", "bench", "lamp", "table", "chair"):
                kind = {"trees": "tree", "building": "house", "bench": "bench", "lamp": "lamp", "table": "table",
                        "chair": "chair"}[t]
                n = {"tree": 5, "house": 2}.get(kind, 1)
                for i in range(n):
                    a = B.make_object(kind, ids, kind=kind)
                    p = p0 + u * ((i - (n - 1) / 2) * (14 if kind == "house" else 9)) + lat_dir * rng.uniform(0, 4)
                    a["position"] = [round(float(p[0]), 2), 0.0, round(float(p[2]), 2)]
                    a["keys"] = [{"frame": 0, "position": list(a["position"])}]
                    a["rotation_deg"] = heading(-lat_dir) if kind != "lamp" else rot
                    a["set_piece"] = True
                    a["_set_bbox"] = s.get("bbox")
                    out.append(a)
            elif t in ("guardrail", "wall"):
                hgt, th = (0.75, 0.15) if t == "guardrail" else (1.8, 0.3)
                c = origin + (v * (half + 0.6) if v is not None else f0 * (base + 20))
                out.append(_custom(ids, t.capitalize() + name_side,
                                   [_box([0, hgt / 2, 0], [th, hgt, ROAD_LEN], COLOURS["rail" if t == "guardrail" else "wall"])],
                                   rot if v is not None else heading(left) + 90, c, [th, hgt, ROAD_LEN]))
            elif t in ("grass", "sidewalk", "plaza"):
                wid = {"grass": 30.0, "sidewalk": 3.0, "plaza": 60.0}[t]
                if t == "plaza":
                    c = np.array([mid[0], 0, mid[2]]) + f0 * 8
                    size = [60.0, 0.03, 60.0]
                else:
                    c = origin + (v * (half + wid / 2) if v is not None else f0 * (base + 20))
                    size = [wid, 0.03 if t == "grass" else 0.15, ROAD_LEN]
                out.append(_custom(ids, t.capitalize() + name_side, [_box([0, size[1] / 2, 0], size, COLOURS[t])],
                                   rot, c, size))
    return out


def place_set_bboxes(actors, pose0, A, b, K, size, depth0=None, scale0=1.0):
    """Set pieces the model boxed (benches, lamps, buildings, trees): put the first one where the box says."""
    w, h = size
    done = set()
    for a in actors:
        bb = a.pop("_set_bbox", None)
        if not bb or a["kind"] in done:
            continue
        x0, y0, x1, y1 = bbox_px(bb, w, h)
        p, _ = ground_point(pose0, A, b, K, ((x0 + x1) / 2, y1 - 0.02 * (y1 - y0)), depth0, scale0, max_dist=150,
                            check_uv=((x0 + x1) / 2, (y0 + y1) / 2))
        if p is not None:
            a["position"] = [round(float(p[0]), 2), 0.0, round(float(p[2]), 2)]
            a["keys"] = [{"frame": 0, "position": list(a["position"])}]
            a["_bbox"] = bb
            done.add(a["kind"])


# ---------------------------------------------------------------------------------------------- scale
def metres_per_unit(breakdown, ground, depth0, K, size, notes) -> float:
    """Mono depth has no units. Anchor it on the camera height the model guessed and on people's height."""
    cam = breakdown.get("camera") or {}
    guess = cam.get("height_m") or CAMERA_HEIGHT.get(cam.get("type") or "", None)
    if guess is None and ground is not None:
        guess = 1.6
        notes.append("scale: camera height not read; assumed 1.6 m")
    cands = []
    if ground is not None and guess:
        cands.append(("camera height", guess / ground[1]))
    # People: 1.7 m tall at the depth of their feet.
    w, h = size
    ppl = []
    for o in breakdown.get("objects") or []:
        if o["kind"] != "person" or not o.get("bbox_start"):
            continue
        x0, y0, x1, y1 = bbox_px(o["bbox_start"], w, h)
        if y1 - y0 < 0.08 * h or y1 > 0.995 * h:   # tiny or cut off at the bottom
            continue
        z = float(np.median(T.sample_depth(depth0, np.array([[(x0 + x1) / 2, y0 + f * (y1 - y0)] for f in (0.5, 0.7, 0.9)]))))
        if z > 0 and math.isfinite(z):
            units = (y1 - y0) / K[1, 1] * z
            ppl.append(1.7 / units)
    if ppl:
        cands.append(("people", float(np.median(ppl))))
    if not cands:
        med = float(np.median(depth0[np.isfinite(depth0) & (depth0 > 0)])) if np.isfinite(depth0).any() else 1.0
        notes.append("scale: no ground plane or people to measure; assumed the middle of the frame is 10 m away")
        return 10.0 / max(med, 1e-6)
    # A floor + the camera height is steadier than people (mono depth is soft on a figure's outline); people
    # measure the shot when there is no floor to stand the camera on, or when the "floor" is plainly something
    # else (a desk top just under the lens puts everyone 60 m away: the two scales then disagree wildly).
    pick = cands[0]
    if len(cands) == 2 and not (0.4 <= cands[0][1] / cands[1][1] <= 2.5):
        pick = cands[1]
        notes.append("scale: the floor fit disagrees with people's height; measured the shot by the people")
    notes.append(f"scale from {pick[0]}" + (f" (camera ~{guess:g} m up)" if guess else ""))
    return float(pick[1])


# ---------------------------------------------------------------------------------------------- scene
def time_preset(text: str) -> str:
    t = (text or "").lower()
    if "afternoon" in t:
        return "midday"
    for key, words in C.TIME_WORDS:
        if any(w in t for w in words):
            return key
    return "midday"


def assemble(ctx: dict | None = None, **legacy) -> dict:
    """The single entry point. assemble(ctx): the LAYOUT rebuild from the agreed context (see assemble_ctx).
    assemble(poses=..., scales=..., ...): the legacy keyword form (kept for the tests and the old route)."""
    if ctx is not None:
        return assemble_ctx(ctx)
    return assemble_legacy(**legacy)


def assemble_legacy(*, poses, scales, times, K, size, depths, ground, breakdown, clip, reference, notes, backdrop=None,
                    skies=None, repin: bool = True) -> dict:
    """Everything -> a validated stage scene (see docs/video2stage.md)."""
    w, h = size
    mpu = metres_per_unit(breakdown, ground, depths[0], K, size, notes)
    if ground is not None and any(n.startswith("scale: the floor fit disagrees") for n in notes):
        cam = breakdown.get("camera") or {}
        guess = cam.get("height_m") or CAMERA_HEIGHT.get(cam.get("type") or "", 1.6)
        ground = (ground[0], guess / mpu) + tuple(ground[2:])   # keep its tilt, take the camera height as read
        repin = False
    A, b0 = T.world_frame(ground, mpu, default_height_units=(1.6 / mpu))
    corrections = None
    if repin and ground is not None and len(poses) > 2:
        heights = T.ground_heights(depths, skies, K, scales, poses, A)
        if sum(x is not None for x in heights) >= len(heights) // 2:
            poses, corrections = T.repin_heights(poses, heights, A, b0)
            if max(abs(c - 1) for c in corrections) > 0.1:
                notes.append(f"camera: depth-scale drift corrected from each frame's own floor "
                             f"(x{min(corrections):.2f}-x{max(corrections):.2f})")
    frames = max(9, min(1000, int(round(clip["duration"] * FPS)) + 1))
    last = frames - 1
    times = [min(t, last / FPS) for t in times]
    # Where each camera looks: the middle of its frame's depth (clamped to something you can aim at).
    look = []
    for d, s in zip(depths, scales):
        c = d[int(h * 0.35):int(h * 0.65), int(w * 0.35):int(w * 0.65)]
        c = c[np.isfinite(c) & (c > 0)]
        look.append(float(np.clip(np.median(c) * s * mpu if len(c) else 10.0, 2.0, 80.0)))
    look = [float(np.median(look))] * len(look)   # one aim distance: keys interpolate cleanly and drag predictably
    raw_keys = smooth_keys(camera_keys(poses, A, b0, times, K, w, look))
    # Recentre: the action (or the camera's first look point) at the origin.
    objs = place_objects(breakdown.get("objects") or [], (poses[0], poses[-1]), A, b0, K, size, last,
                         depths=(depths[0], depths[-1]), scales=(scales[0], scales[-1]), notes=notes)
    hero = pick_hero(objs)
    if hero is not None:   # aim every key at the hero's distance: the target lands on the subject, not the far wall
        c0 = np.array(raw_keys[0]["position"])
        dist = max(1.5, math.hypot(hero["position"][0] - c0[0], hero["position"][2] - c0[2]))
        for k in raw_keys:
            p, t = np.array(k["position"]), np.array(k["target"])
            f = (t - p) / (np.linalg.norm(t - p) or 1)
            k["target"] = [round(float(v), 3) for v in p + f * dist]
    if hero is not None:
        cx, cz = hero["position"][0], hero["position"][2]
    else:
        cx, cz = raw_keys[0]["target"][0], raw_keys[0]["target"][2]
    shift = np.array([-cx, 0.0, -cz])
    b = b0 + shift

    def mv(p):
        return [round(p[0] + shift[0], 3), p[1], round(p[2] + shift[2], 3)]
    for k in raw_keys:
        k["position"], k["target"] = mv(k["position"]), mv(k["target"])
    for a in objs:
        a["position"] = mv(a["position"])
        for k in a["keys"]:
            k["position"] = mv(k["position"])
        a["_vehicle"] = a["kind"] in ("car", "truck", "motorcycle", "bicycle")
    keys = simplify_keys(raw_keys)
    dressing = build_set(breakdown, objs, keys, notes)
    place_set_bboxes(dressing, poses[0], A, b, K, size, depths[0], scales[0])
    actors = objs + dressing
    mount_riders(actors)
    for a in actors:
        for k in ("_vehicle", "_bbox", "_boxes", "_set_bbox"):
            a.pop(k, None)

    preset = time_preset(breakdown.get("time", ""))
    lighting = B.lighting_for({"time": preset})
    scene = {"version": 2, "shot": {"frames": frames, "fps": FPS},
             "environment": {"set": "empty", "weather": "none", "density": 0.5, "water_level": 2.5},
             "lighting": lighting, "sun": C.sun_for(lighting), "actors": actors, "props": [],
             "shots": [{"id": "shot_1", "name": "Source camera", "setup": "master", "camera_keys": keys}],
             "active_shot": "shot_1"}
    scene, vnotes = validate_scene(scene, place=False)
    notes += vnotes
    scene["shot"]["aspect"] = aspect_key(w / h)   # validate_scene keeps frames/fps only
    scene["reference"] = reference
    scene["video2stage"] = {"metres_per_unit": round(mpu, 5), "ground": None if ground is None else
                            {"normal": [round(float(v), 4) for v in ground[0]], "height_units": round(float(ground[1]), 4)},
                            "camera_keys_raw": raw_keys, "drift_correction": corrections, "setting": breakdown.get("setting", ""),
                            "camera_type": (breakdown.get("camera") or {}).get("type", ""),
                            # cam0 -> stage (after recentring): the performer is placed through the same transform
                            "xform": {"A": np.round(A, 6).tolist(), "b": np.round(b, 5).tolist()}}
    if backdrop:
        scene["actors"].append(backdrop_actor(backdrop, A, b))
    return scene


ASPECTS = {"1.85": 1.85, "16:9": 16 / 9, "2.39": 2.39, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "3:4": 0.75}


def aspect_key(ratio: float) -> str:
    """The stage frame (web/stage/stage.mjs ASPECTS) nearest the clip's."""
    return min(ASPECTS, key=lambda k: abs(math.log(ASPECTS[k] / ratio)))


def backdrop_actor(glb: dict, A, b) -> dict:
    """The DA3 mesh of the first frame as a set (kind glb), placed by the same cam0 -> stage transform.
    The mesh is in glTF axes (flip y, z of OpenCV) and DA3 depth units."""
    s = float(np.linalg.norm(A[0]))
    Rw = A / s
    q = _quat(Rw)
    return {"id": "v2s_backdrop", "name": "Source frame (DA3 depth)", "kind": "glb", "format": "glb", "url": glb["url"],
            "position": [0, 0, 0], "keys": [{"frame": 0, "position": [0, 0, 0]}], "height_m": 1.7, "rotation_deg": 0,
            "set_xform": {"flip_xyz": [1, -1, -1], "scale": round(s, 6), "offset": [round(float(v), 4) for v in b],
                          "quat": [round(float(v), 6) for v in q]}}


def _quat(R) -> list[float]:
    """Rotation matrix -> [x, y, z, w] (three.js Quaternion order)."""
    m = np.asarray(R, float)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w, x, y, z = (m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w, x, y, z = (m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w, x, y, z = (m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s
    return [x, y, z, w]



# ============================================================================================== LAYOUT (ctx)
# The measured inventory -> stage actors. Library kinds when the measured box fits the library item within ±25 %
# per dimension (vehicles and animals always: a car is a car); otherwise a clay recipe AT the measured size and colour.
LIBRARY_KIND = {"car": "car", "sedan": "car", "taxi": "car", "coupe": "car", "suv": "car", "hatchback": "hatchback",
                "sports car": "sports_car", "police car": "police_car", "pickup": "truck", "van": "truck",
                "truck": "truck", "lorry": "truck", "bus": "truck", "bicycle": "bicycle", "bike": "bicycle",
                "motorcycle": "motorcycle", "scooter": "motorcycle", "horse": "horse", "dog": "dog", "cat": "cat",
                "tree": "tree", "bush": "bush", "shrub": "bush", "hedge": "bush", "bench": "bench", "table": "table",
                "dining table": "table", "chair": "chair", "dining chair": "chair", "street light": "lamp",
                "streetlight": "lamp", "lamp post": "lamp", "lamppost": "lamp", "rock": "rock", "boulder": "rock",
                "crate": "crate"}
ALWAYS_LIBRARY = {"car", "hatchback", "sports_car", "police_car", "truck", "bicycle", "motorcycle", "horse", "dog", "cat"}
# Canonical class words the bench / outliner read (recipe.name): never the raw 'custom'.
CLASS_WORD = {"couch": "sofa", "settee": "sofa", "armchair": "chair", "stool": "chair", "bookshelf": "shelf",
              "bookcase": "shelf", "shelves": "shelf", "carpet": "rug", "mat": "rug", "floor lamp": "lamp",
              "table lamp": "lamp", "coffee table": "table", "side table": "table", "desk": "table",
              "potted plant": "plant", "houseplant": "plant", "flower pot": "plant", "trash can": "bin",
              "dustbin": "bin", "garbage can": "bin", "fire hydrant": "hydrant", "stop sign": "sign",
              "street sign": "sign", "painting": "picture", "poster": "picture", "frame": "picture",
              "cardboard box": "box", "crate": "box", "street light": "light", "streetlight": "light",
              "lamp post": "light", "pole": "pole"}
COLOUR_WORDS = [("red", 0), ("orange", 30), ("yellow", 55), ("green", 120), ("teal", 170), ("blue", 220),
                ("purple", 275), ("pink", 330), ("red", 360)]


def colour_word(hexs: str | None) -> str:
    if not hexs:
        return ""
    r, g, b = (int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5))
    mx, mn = max(r, g, b), min(r, g, b)
    light = (mx + mn) / 2
    sat = 0 if mx == mn else (mx - mn) / (1 - abs(2 * light - 1) + 1e-9)
    if sat < 0.18 or mx - mn < 0.08:
        return "black" if light < 0.18 else "dark grey" if light < 0.38 else "grey" if light < 0.7 else "white"
    if mx == r:
        hue = (60 * ((g - b) / (mx - mn)) + 360) % 360
    elif mx == g:
        hue = 60 * ((b - r) / (mx - mn)) + 120
    else:
        hue = 60 * ((r - g) / (mx - mn)) + 240
    name = min(COLOUR_WORDS, key=lambda c: abs(c[1] - hue))[0]
    if name in ("orange", "red") and light < 0.35 and sat < 0.6:
        name = "brown"
    return ("dark " if light < 0.25 and name != "brown" else "") + name


def class_word(kind: str) -> str:
    k = (kind or "").lower().strip()
    if k in CLASS_WORD:
        return CLASS_WORD[k]
    last = k.split(" ")[-1] if k else "object"
    return CLASS_WORD.get(last, last)


def nice_name(rec: dict) -> str:
    """'Grey fabric sofa', 'Dark sedan', 'Potted plant': the vision model's name, else colour + kind. Never 'custom'."""
    n = (rec.get("name") or "").strip()
    if n and n.lower() not in ("custom", "object", "da3", "thing"):
        return n[:40][0].upper() + n[:40][1:]
    w = colour_word(rec.get("colour"))
    k = rec.get("kind") or "object"
    return (f"{w} {k}" if w else k).strip().capitalize()


def _part(shape, pos, size, color, rot=(0, 0, 0)):
    return {"shape": shape, "pos": [round(float(v), 3) for v in pos], "size": [round(max(float(v), 0.003), 3) for v in size],
            "rot": list(rot), "color": color}


def _shade(hexs: str | None, k: float) -> str | None:
    if not hexs:
        return None
    r, g, b = (int(hexs[i:i + 2], 16) for i in (1, 3, 5))
    return "#" + "".join(f"{int(max(0, min(255, round(v * k)))):02x}" for v in (r, g, b))


def recipe_for(kind: str, dims, colour: str | None) -> list[dict]:
    """Clay parts (metres, origin on the floor at the centre, +Z front) at EXACTLY the measured size."""
    w, h, d = (float(v) for v in dims)
    c = colour or "#9a948a"
    k = class_word(kind)
    if k == "sofa":
        seat_h = min(0.48, 0.55 * h)
        return [_part("box", [0, seat_h / 2, 0.08 * d], [w, seat_h, 0.84 * d], c),
                _part("box", [0, h / 2, -0.42 * d], [w, h, 0.16 * d], c),
                _part("box", [-w / 2 + 0.06 * w, 0.62 * h / 2, 0], [0.12 * w, 0.62 * h, d], c),
                _part("box", [w / 2 - 0.06 * w, 0.62 * h / 2, 0], [0.12 * w, 0.62 * h, d], c)]
    if k == "chair":
        seat = min(0.47, 0.55 * h)
        legs = [_part("box", [sx * (w / 2 - 0.03), seat / 2, sz * (d / 2 - 0.03)], [0.04, seat, 0.04], c)
                for sx in (-1, 1) for sz in (-1, 1)]
        return [_part("box", [0, seat, 0], [w, 0.05, d], c), _part("box", [0, (seat + h) / 2, -d / 2 + 0.03],
                                                                     [w, h - seat, 0.05], c)] + legs
    if k == "table" or k == "desk":
        legs = [_part("box", [sx * (w / 2 - 0.05), (h - 0.04) / 2, sz * (d / 2 - 0.05)], [0.05, h - 0.04, 0.05], c)
                for sx in (-1, 1) for sz in (-1, 1)]
        return [_part("box", [0, h - 0.02, 0], [w, 0.04, d], c)] + legs
    if k == "shelf" or k == "cabinet":
        return [_part("box", [0, h / 2, 0], [w, h, d], c)] + \
               [_part("box", [0, h * (i + 1) / 5, 0.01], [w * 0.94, 0.02, d * 0.96], _shade(c, 0.85)) for i in range(4)]
    if k == "rug":
        return [_part("box", [0, max(h, 0.01) / 2, 0], [w, max(h, 0.01), d], c)]
    if k == "plant":
        pot = min(0.35 * h, 0.4)
        return [_part("cylinder", [0, pot / 2, 0], [0.6 * w, pot, 0.6 * d], "#8a6a52"),
                _part("sphere", [0, pot + (h - pot) / 2, 0], [w, h - pot, d], c)]
    if k == "lamp" or k == "light":
        shade = min(0.3, 0.2 * h)
        return [_part("cylinder", [0, 0.015, 0], [0.6 * w, 0.03, 0.6 * d], "#2f2f2f"),
                _part("cylinder", [0, (h - shade) / 2, 0], [0.03, h - shade, 0.03], "#2f2f2f"),
                _part("cylinder", [0, h - shade / 2, 0], [w, shade, d], c)]
    if k == "pole" or k == "sign":
        if k == "sign":
            plate = min(0.8, 0.35 * h)
            return [_part("cylinder", [0, (h - plate) / 2, 0], [0.07, h - plate, 0.07], "#8c8c8c"),
                    _part("box", [0, h - plate / 2, 0.04], [w, plate, max(0.02, min(d, 0.05))], c)]
        return [_part("cylinder", [0, h / 2, 0], [max(0.08, min(w, 0.3)), h, max(0.08, min(d, 0.3))], c)]
    if k in ("bin", "hydrant", "bollard", "vase", "barrel"):
        return [_part("cylinder", [0, h / 2, 0], [w, h, d], c)]
    if k == "tree":
        trunk = 0.4 * h
        return [_part("cylinder", [0, trunk / 2, 0], [0.12 * w, trunk, 0.12 * d], "#6b5440"),
                _part("sphere", [0, trunk + (h - trunk) / 2, 0], [w, h - trunk, d], c)]
    return [_part("box", [0, h / 2, 0], [w, h, d], c)]


def _library_fit(lib: str, dims) -> tuple[bool, float]:
    """Does the library item, scaled by height, match the measured box within ±25 % per dimension?"""
    spec = C.LIBRARY[lib]
    s = float(dims[1]) / spec["height"]
    fw, fd = spec["foot"][0] * s, spec["foot"][1] * s
    w, d = float(dims[0]), float(dims[2])
    ok = all(0.75 <= a / max(b, 1e-6) <= 1.25 for a, b in ((fw, w), (fd, d)))
    # A car's footprint might come back with width and length swapped.
    ok2 = all(0.75 <= a / max(b, 1e-6) <= 1.25 for a, b in ((fw, d), (fd, w)))
    return ok or ok2, s


def object_actor(rec: dict, s: float, ids: set) -> tuple[dict, str]:
    """One measured thing (solve units, x s -> metres) -> (stage actor, matched: 'library' | 'box')."""
    dims = [float(v) * s for v in rec["dims"]]
    c = [float(v) * s for v in rec["centre"]]
    kind = rec.get("kind") or "object"
    name = nice_name(rec)
    lib = LIBRARY_KIND.get(kind) or LIBRARY_KIND.get(kind.split(" ")[-1])
    if lib == "lamp" and dims[1] < 2.5:   # a floor lamp is not a street lamp
        lib = None
    if lib == "table" and dims[1] < 0.6:  # a coffee table: its own proportions
        lib = None
    matched = "box"
    if lib and lib in C.LIBRARY:
        fit, _ = _library_fit(lib, dims)
        if fit or lib in ALWAYS_LIBRARY:
            spec = C.LIBRARY[lib]
            h = dims[1]
            if lib in ALWAYS_LIBRARY:   # a class prior is steadier than mono depth on a vehicle's outline
                h = min(max(h, 0.75 * spec["height"]), 1.25 * spec["height"])
            a = B.make_object(lib, ids, kind=lib, label=name)
            a["height_m"] = round(h, 3)
            matched = "library"
    if matched == "box":
        word = class_word(kind)
        a = B.make_object(name, ids, kind=None, label=name)
        a.update(kind="custom", recipe={"name": word, "rig": "static", "size_m": [round(v, 3) for v in dims],
                                        "parts": recipe_for(kind, dims, rec.get("colour")), "set_piece": True,
                                        "measured": True},
                 height_m=round(max(dims[1], 0.01), 3))
        a.pop("design", None)
        a["set_piece"] = True
    if rec.get("colour"):
        a["appearance"] = {"color": rec["colour"]}
    y = 0.0 if rec.get("grounded", True) else round(c[1] - dims[1] / 2, 3)
    a["position"] = [round(c[0], 3), y, round(c[2], 3)]
    a["keys"] = [{"frame": 0, "position": list(a["position"])}]
    a["rotation_deg"] = round(float(rec.get("yaw_deg") or 0.0), 1)
    a["name"] = name
    a["source"] = {"mask_ref": rec["id"], "dims_m": [round(v, 3) for v in dims], "matched": matched,
                   "label": rec.get("name") or kind}
    return a, matched


def plane_actor(pl: dict, ids: set) -> dict:
    size = [float(v) for v in pl["size"]]
    word = {"ground": "ground", "road": "road", "floor": "floor", "water": "ocean"}.get(pl["kind"], pl["kind"])
    col = pl.get("colour") or COLOURS.get(pl["kind"], "#a9a39a")
    c = pl["centre"]
    a = B.make_object(pl["name"], ids, kind=None, label=pl["name"])
    a.update(kind="custom", recipe={"name": word, "rig": "static", "size_m": [round(v, 3) for v in size],
                                    "parts": [_part("box", [0, size[1] / 2, 0], size, col)], "set_piece": True,
                                    "measured": True},
             height_m=round(max(size[1], 0.01), 3), rotation_deg=round(float(pl.get("yaw_deg") or 0.0), 1))
    a.pop("design", None)
    y0 = float(c[1]) - size[1] / 2
    a["position"] = [round(float(c[0]), 3), round(y0, 3), round(float(c[2]), 3)]
    a["keys"] = [{"frame": 0, "position": list(a["position"])}]
    a["set_piece"] = True
    a["structure"] = pl["kind"]
    return a


def dedupe_names(actors: list[dict]) -> None:
    """'Tree 1' .. 'Tree 5', 'Dark sedan 1 / 2': every actor's name is unique and readable."""
    groups: dict = {}
    for a in actors:
        groups.setdefault(a.get("name") or a.get("id"), []).append(a)
    for name, grp in groups.items():
        if len(grp) > 1:
            for i, a in enumerate(grp, 1):
                a["name"] = f"{name} {i}"


def _project_inside(ctx: dict, pts: np.ndarray, frames: list[int], max_dist: float) -> bool:
    from . import context as X
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    for f in frames:
        uv, z = X.world_to_pixel(ctx, f, pts)
        ok = (z > 0.1) & (z < max_dist) & (uv[:, 0] >= 0) & (uv[:, 0] < pw) & (uv[:, 1] >= 0) & (uv[:, 1] < ph)
        if ok.any():
            return True
    return False


def outside_view(ctx: dict, actor: dict, s_world: float = 1.0, max_dist: float = 90.0) -> bool:
    """True when no part of the actor is inside the solved camera's frame at any (6th) frame closer than max_dist m:
    procedural dressing may only fill what the camera never sees."""
    p = np.array(actor["position"], float)
    size = (actor.get("recipe") or {}).get("size_m") or [1, actor.get("height_m") or 1, 1]
    a = math.radians(actor.get("rotation_deg") or 0)
    ax = np.array([math.cos(a), 0, -math.sin(a)])
    az = np.array([math.sin(a), 0, math.cos(a)])
    pts = []
    for fx in np.linspace(-0.5, 0.5, 5):
        for fz in np.linspace(-0.5, 0.5, 5):
            for fy in (0.0, 0.5, 1.0):
                pts.append(p + ax * fx * size[0] + az * fz * size[2] + np.array([0, fy * size[1], 0]))
    for part in (actor.get("recipe") or {}).get("parts") or []:
        q = np.array(part["pos"], float)
        pts.append(p + ax * q[0] + az * q[2] + np.array([0, q[1], 0]))
    frames = list(range(0, int(ctx["clip"]["frames"]), 6)) or [0]
    return not _project_inside(ctx, np.array(pts) / s_world, frames, max_dist)


def camera_keys_from_ctx(ctx: dict, mpu: float) -> list[dict]:
    """SOLVE's keys when it wrote them (ctx['camera_keys'], stage metres); else one key per 4 frames from the poses."""
    keys = ctx.get("camera_keys")
    if keys:
        return [dict(k) for k in keys]
    from . import context as X
    out = []
    n = int(ctx["clip"]["frames"])
    pw = ctx["clip"]["pw"]
    for f in sorted(set(list(range(0, n, 4)) + [n - 1])):
        P = X.pose_at(ctx, f)
        pos = P[:3, 3]
        fwd = P[:3, :3] @ np.array([0, 0, 1.0])
        K = X.K_at(ctx, f)
        out.append({"frame": int(f), "position": [round(float(v), 3) for v in pos],
                    "target": [round(float(v), 3) for v in pos + fwd * 5.0],
                    "focal_mm": round(float(K[0, 0]) * SENSOR_W_MM / pw, 2)})
    return out


def missing_from_inventory(ctx: dict) -> list[str]:
    """Names the vision model saw that no track explains (by box overlap on the frame it read)."""
    inv = ctx.get("vlm_inventory") or {}
    seg = ctx.get("seg") or {}
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    out = []
    for it in inv.get("items") or []:
        if not it.get("bbox") or it.get("kind") in ("person", "man", "woman", "child", "people"):
            continue
        b = [it["bbox"][0] / 1000 * pw, it["bbox"][1] / 1000 * ph, it["bbox"][2] / 1000 * pw, it["bbox"][3] / 1000 * ph]
        f = int(it.get("frame") or 0)
        hit = False
        for o in seg.values():
            st = o["frames"].get(f)
            if st is None:
                continue
            bx = st["bbox"]
            ix = max(0, min(b[2], bx[2]) - max(b[0], bx[0]))
            iy = max(0, min(b[3], bx[3]) - max(b[1], bx[1]))
            if ix * iy > 0.3 * max(1.0, (b[2] - b[0]) * (b[3] - b[1])):
                hit = True
                break
        if not hit:
            out.append(it.get("name") or it.get("kind"))
    seen, uniq = set(), []
    for n in out:
        if n and n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


def assemble_ctx(ctx: dict) -> dict:
    """The LAYOUT rebuild: SOLVE's camera keys, mpu and frames as given; every measured thing, structure plane and
    mover; procedural dressing only outside the solved view. People and the backdrop are added by the pipeline
    (people.attach, backdrop.build), never here. Returns a validated scene with scene.video2stage.inventory."""
    from . import context as X
    from . import movers as MV
    from . import planes as PL
    from . import segment as SG
    from . import vlm as V
    mpu = ctx.get("mpu")
    if not mpu:
        X.note(ctx, "scale: no metric anchor was agreed; the set is in the solve's own units (about metres)", "warn")
        mpu = 1.0
    lay = ctx.get("layout") or {}
    s = 1.0 if lay.get("units") == "metres" else float(mpu)
    clip = ctx["clip"]
    frames = max(9, int(clip["frames"]))
    last = frames - 1
    notes: list = []
    ids: set = set()
    actors: list = []
    inventory: list = []
    keys = camera_keys_from_ctx(ctx, mpu)
    # ---- structure
    st = PL.fit(ctx, notes)
    interior = st["interior"] or bool((ctx.get("vlm_inventory") or {}).get("interior") and st["sky_share"] < 0.01)
    surf_kinds = {sf["kind"] for sf in (ctx.get("vlm_inventory") or {}).get("surfaces") or []}
    for pl in st["planes"]:
        if pl["kind"] in ("ground",) and surf_kinds & {"water", "ocean", "sea", "lake"} and not surf_kinds & {"road", "street"}:
            pl["kind"], pl["name"] = "water", "Water"
        a = plane_actor(pl, ids)
        actors.append(a)
        inventory.append({"id": a["id"], "name": a["name"], "kind": pl["kind"], "dims_m": [round(v, 2) for v in pl["size"]],
                          "colour": pl.get("colour"), "material": "", "matched": "box", "moving": False,
                          "seen_frames": None, "notes": [], "structure": True})
    # ---- things
    objs = lay.get("objects") or {}
    movers = ctx.get("movers") or set()
    from . import measure as ME
    for oid, rec in sorted(objs.items(), key=lambda kv: -float(np.prod(kv[1]["dims"]))):
        ME.sanity(rec, s)
        a, matched = object_actor(rec, s, ids)
        onotes = list(rec.get("notes") or [])
        if oid in movers or rec.get("moving"):
            pth = None
            try:
                pth = MV.path(ctx, oid, rec, s, rec["kind"])
            except Exception as exc:  # noqa: BLE001
                onotes.append(f"path could not be keyed ({exc}); left at its first mark")
            if pth and pth["keys"]:
                a["keys"] = pth["keys"]
                a["position"] = list(pth["keys"][0]["position"])
                a["rotation_deg"] = round(float(pth["keys"][0].get("heading_deg") or a["rotation_deg"]), 1)
                if pth["entered"] or pth["left"]:
                    onotes.append(f"in frame {pth['frames'][0]}-{pth['frames'][-1]}; parked off-frame outside that")
                a["source"]["path_coverage"] = round(pth["coverage"], 3)
        actors.append(a)
        inventory.append({"id": a["id"], "name": a["name"], "kind": rec["kind"], "dims_m": a["source"]["dims_m"],
                          "colour": rec.get("colour"), "material": rec.get("material") or "", "matched": matched,
                          "moving": bool(len(a["keys"]) > 1), "seen_frames": rec.get("seen_frames"), "notes": onotes,
                          "source": a["source"]})
    # ---- what nobody explained
    try:
        SG.unexplained(ctx, lambda f, shape: PL.coverage(ctx, st["planes"], f, shape))
    except Exception as exc:  # noqa: BLE001
        notes.append(f"layout: unexplained-pixel map failed ({exc})")
    miss = missing_from_inventory(ctx)
    if miss:
        X.note(ctx, "layout: seen by the vision model but not tracked: " + ", ".join(miss[:12]) +
               (" ..." if len(miss) > 12 else ""), "warn")
    # ---- dressing only where the camera never looks (outdoors)
    if not interior:
        inv = ctx.get("vlm_inventory") or {}
        bd = V.legacy_breakdown(inv)
        cam_path = [{"position": k["position"], "target": k["target"]} for k in keys] or \
            [{"position": [0, 1.6, 0], "target": [0, 1.6, 5]}]
        veh = [dict(a, _vehicle=True) for a in actors if a.get("kind") in ("car", "truck", "motorcycle", "bicycle")]
        try:
            fill = build_set(bd, veh, cam_path, notes)
        except Exception as exc:  # noqa: BLE001
            fill, _ = [], notes.append(f"dressing: {exc}")
        kept = 0
        for a in fill:
            nm = (a.get("name") or "").lower()
            if nm.startswith("terrain"):   # the ground beyond the measured plate, under everything
                a["name"] = "Ground beyond the plate"
                actors.append(a)
                continue
            if nm.startswith("road") and any(p["kind"] in ("road", "ground") for p in st["planes"]):
                continue
            if outside_view(ctx, a, s_world=1.0):
                a["name"] = (a.get("name") or "Dressing") + " (off-camera)"
                a["procedural"] = True
                actors.append(a)
                kept += 1
        if kept:
            notes.append(f"dressing: {kept} procedural piece(s), all outside the solved view")
    for a in actors:
        for k in ("_vehicle", "_bbox", "_boxes", "_set_bbox"):
            a.pop(k, None)
    dedupe_names(actors)
    nm = {a["id"]: a["name"] for a in actors}
    for it in inventory:
        it["name"] = nm.get(it["id"], it["name"])
    inv = ctx.get("vlm_inventory") or {}
    preset = time_preset(inv.get("time", ""))
    lighting = B.lighting_for({"time": preset})
    scene = {"version": 2, "shot": {"frames": frames, "fps": FPS},
             "environment": {"set": "empty", "weather": "none", "density": 0.5, "water_level": 2.5},
             "lighting": lighting, "sun": C.sun_for(lighting), "actors": actors, "props": [],
             "shots": [{"id": "shot_1", "name": "Source camera", "setup": "master", "camera_keys": keys}],
             "active_shot": "shot_1"}
    scene, vnotes = validate_scene(scene, place=False)
    notes += vnotes
    w, h = clip.get("w") or clip["pw"], clip.get("h") or clip["ph"]
    key = aspect_key(w / h)
    scene["shot"]["aspect"] = key
    crop = 1 - min(ASPECTS[key], w / h) / max(ASPECTS[key], w / h)
    if crop > 0.005:
        notes.append(f"frame: the stage's nearest frame is {key}; {100 * crop:.1f} % of the plate is cropped")
    if ctx.get("reference"):
        scene["reference"] = ctx["reference"]
    if interior:
        scene["environment"]["sky"] = "none"
        scene["environment"]["interior"] = True
    for t in notes:
        X.note(ctx, t, "info")
    un = ctx.get("unexplained") or {}
    scene["video2stage"] = {
        "metres_per_unit": round(float(mpu), 6), "setting": inv.get("setting", ""), "interior": bool(interior),
        "inventory": inventory, "structure": [{k: p[k] for k in ("kind", "name", "centre", "size", "yaw_deg", "colour")}
                                              for p in st["planes"]],
        "unexplained_share": round(float(un.get("share", 0.0)), 4),
        "missing": miss, "camera_type": (inv.get("camera") or {}).get("type", "")}
    ctx["inventory"] = inventory
    return scene
