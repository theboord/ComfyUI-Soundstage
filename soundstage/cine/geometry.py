"""Lens and camera geometry in the stage's coordinate frame.

Matches web/stage/stage.mjs: Y-up, metres, actors stand on y=0, camera = {position, target,
focal_mm}, full-frame 36 mm sensor width with the vertical FOV derived from the frame aspect
(960x512 = 1.875). Looking down +Z, +X is screen-LEFT (three.js right-handed frame).
"""
from __future__ import annotations

import math

SENSOR_W_MM = 36.0
STAGE_ASPECT = 960 / 512
UP = (0.0, 1.0, 0.0)

# Delivery aspect of the shot being planned (the stage's shot.aspect). Set per advise() call with use_aspect();
# everything below reads it when no explicit aspect is passed.
_ASPECT = [STAGE_ASPECT]
STAGE_ASPECTS = {"1.85": 960 / 512, "16:9": 1024 / 576, "2.39": 1216 / 512, "9:16": 576 / 1024, "1:1": 1.0,
                 "4:3": 768 / 576, "3:4": 576 / 768}


class use_aspect:
    """`with use_aspect(stage_scene["shot"]["aspect"]):` frames every shot for that delivery size."""

    def __init__(self, aspect):
        self.value = STAGE_ASPECTS.get(aspect, aspect) if aspect else STAGE_ASPECT
        if not isinstance(self.value, (int, float)) or self.value <= 0:
            self.value = STAGE_ASPECT

    def __enter__(self):
        _ASPECT.append(float(self.value))
        return self.value

    def __exit__(self, *exc):
        _ASPECT.pop()


def current_aspect() -> float:
    return _ASPECT[-1]


SIZE_ORDER = ["EWS", "WS", "FS", "COWBOY", "MS", "MCU", "CU", "ECU", "INSERT"]

# ---- small vector helpers (tuples, no numpy) -------------------------------------------------


def add(a, b): return tuple(x + y for x, y in zip(a, b))
def sub(a, b): return tuple(x - y for x, y in zip(a, b))
def mul(a, s): return tuple(x * s for x in a)
def dot(a, b): return sum(x * y for x, y in zip(a, b))
def length(a): return math.sqrt(dot(a, a))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    n = length(a)
    return mul(a, 1.0 / n) if n > 1e-9 else (0.0, 0.0, 0.0)


def flat(a):
    """Horizontal (XZ) unit vector."""
    return norm((a[0], 0.0, a[2]))


def rot_y(v, deg):
    """Rotate around +Y (positive = counter-clockwise seen from above)."""
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return (v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c)


def r3(v):
    return [round(x, 3) for x in v]


# ---- lens math ---------------------------------------------------------------------------------


def sensor_h(aspect: float | None = None) -> float:
    return SENSOR_W_MM / (aspect or current_aspect())


def vfov_deg(focal_mm: float, aspect: float | None = None) -> float:
    return math.degrees(2 * math.atan(sensor_h(aspect) / (2 * focal_mm)))


def distance_for_height(frame_h_m: float, focal_mm: float, aspect: float | None = None) -> float:
    """Camera distance at which a region `frame_h_m` tall fills the frame height."""
    return frame_h_m * focal_mm / sensor_h(aspect)


def distance_for_width(frame_w_m: float, focal_mm: float) -> float:
    return frame_w_m * focal_mm / SENSOR_W_MM


def focal_for(frame_h_m: float, distance_m: float, aspect: float | None = None) -> float:
    return distance_m * sensor_h(aspect) / frame_h_m


# ---- framing tables ----------------------------------------------------------------------------


def frame_height(size: str, top_m: float) -> float:
    """Vertical extent of the frame for a shot size on a subject whose head top is at top_m."""
    return {
        "ECU": 0.13, "CU": 0.32, "MCU": 0.55, "MS": 0.85, "COWBOY": 0.62 * top_m + 0.12,
        "FS": top_m * 1.18, "WS": top_m * 2.4, "EWS": max(14.0, top_m * 9), "INSERT": 0.32,
    }[size]


def frame_center_y(size: str, top_m: float) -> float:
    h = frame_height(size, top_m)
    if size == "ECU":
        return top_m - 0.12                     # the eye line
    if size in ("WS", "EWS"):
        return min(top_m * 0.62, 1.6)
    return top_m + 0.07 * h - h / 2             # a little headroom above the crown


def camera_height(cls: str, eye_m: float, target_y: float, size: str, dist: float) -> float:
    base = {
        "ground": 0.25, "knee": 0.55, "hip": 0.95, "seated": 1.12, "chest": 1.3, "eye": eye_m,
        "high": max(target_y + 1.4, 2.8), "aerial": max(10.0, dist * 0.45),
    }[cls]
    if size == "EWS" and cls in ("high", "aerial"):
        base = max(base, target_y + dist * math.sin(math.radians(18 if cls == "high" else 40)))
    return base


HORIZONTAL_DEG = {"front": 8, "three_quarter_front": 38, "profile": 90, "three_quarter_back": 140, "back": 172}


def place(target, direction, dist, cam_y):
    """Camera position `dist` metres from target along horizontal `direction`, at height cam_y."""
    dy = cam_y - target[1]
    horiz = math.sqrt(max(dist * dist - dy * dy, (0.35 * dist) ** 2))
    p = add(target, mul(direction, horiz))
    return (p[0], cam_y, p[2])


def look(position, target):
    """Yaw (deg, 0 = camera looking +Z, positive toward +X), pitch (deg, positive = looking down)."""
    d = sub(target, position)
    yaw = math.degrees(math.atan2(d[0], d[2]))
    pitch = math.degrees(math.atan2(-d[1], math.hypot(d[0], d[2])))
    return yaw, pitch


def basis(position, target):
    f = norm(sub(target, position))
    right = norm(cross(f, UP))
    if length(right) < 1e-6:  # looking straight down
        right = (-1.0, 0.0, 0.0)
    up = cross(right, f)
    return f, right, up


def project(point, position, target, focal_mm, aspect: float | None = None):
    """Normalised screen coords (x right, y up, both -1..1 at the frame edges) or None if behind."""
    f, right, up = basis(position, target)
    rel = sub(point, position)
    z = dot(rel, f)
    if z <= 0.05:
        return None
    half_w = SENSOR_W_MM / 2 / focal_mm
    half_h = sensor_h(aspect) / 2 / focal_mm
    return dot(rel, right) / z / half_w, dot(rel, up) / z / half_h


def side_of_line(point, a, b) -> float:
    """Signed horizontal distance of `point` from the line a->b (positive = side A cameras)."""
    axis = flat(sub(b, a))
    n = cross(UP, axis)  # for an axis along +X this is -Z, the default stage camera side
    return dot(sub(point, a), n)


def legal_frames(seconds: float, fps: float, minimum: int = 25) -> int:
    """Nearest LTX-legal frame count (8k+1) to seconds*fps, at least `minimum`."""
    k = max(round((seconds * fps - 1) / 8), (minimum - 1 + 7) // 8)
    return 8 * k + 1


# ---- moves -------------------------------------------------------------------------------------

_SPEED = {"slow": 0.6, "regular": 1.0, "fast": 1.5}


def move_end(move: str, speed: str, position, target, focal_mm: float, subject_facing=(1.0, 0.0, 0.0)):
    """End-of-shot camera for a move: returns (position, target, focal_mm)."""
    k = _SPEED.get(speed, 1.0)
    p, t, f = tuple(position), tuple(target), float(focal_mm)
    fwd, right, _ = basis(p, t)
    d = length(sub(t, p))
    left = mul(right, -1.0)
    if move == "dolly_in":
        p = add(p, mul(sub(t, p), min(0.55, 0.3 * k)))
    elif move == "dolly_out":
        p = sub(p, mul(sub(t, p), 0.4 * k))
    elif move in ("zoom_in", "snap_zoom"):
        f = f * (2.0 if move == "snap_zoom" else 1.0 + 0.5 * k)
    elif move == "dolly_zoom":
        p2 = add(p, mul(sub(t, p), 0.45))
        f = f * length(sub(t, p2)) / d
        p = p2
    elif move in ("pan_left", "pan_right", "whip_pan"):
        ang = (70 if move == "whip_pan" else 22 * k) * (1 if move != "pan_right" else -1)
        t = add(p, rot_y(sub(t, p), ang))
    elif move in ("tilt_up", "tilt_down"):
        t = add(t, (0.0, (1 if move == "tilt_up" else -1) * d * math.tan(math.radians(14 * k)), 0.0))
    elif move in ("truck_left", "truck_right"):
        off = mul(left if move == "truck_left" else right, max(1.0, 0.3 * d) * k)
        p, t = add(p, off), add(t, off)
    elif move in ("track_follow", "track_lead", "steadicam_follow"):
        off = mul(flat(subject_facing), 2.0 * k)
        p, t = add(p, off), add(t, off)
    elif move in ("arc_left", "arc_right"):
        p = add(t, rot_y(sub(p, t), (25 * k) * (-1 if move == "arc_left" else 1)))
    elif move in ("crane_up", "crane_down"):
        p = add(p, (0.0, (1.6 if move == "crane_up" else -1.2) * k, 0.0))
        if move == "crane_down":
            p = (p[0], max(0.3, p[1]), p[2])
    return p, t, f
