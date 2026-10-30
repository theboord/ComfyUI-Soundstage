"""Floor-plan geometry shared by the builder, the validator and the edit ops.

Every object is reduced to an axis-aligned footprint on the floor (XZ), which is plenty for previz
blocking: "is it inside the set", "does it overlap something", "find the nearest free spot".
"""
from __future__ import annotations

import math

from . import catalog as C

CLEAR = 0.15  # metres of air kept between footprints


def size_of(obj: dict) -> list[float]:
    """[w, h, d] of a stage actor/object at rotation 0."""
    if obj.get("kind") == "custom":
        s = (obj.get("recipe") or {}).get("size_m") or [1, obj.get("height_m", 1), 1]
        return [float(s[0]), float(obj.get("height_m") or s[1]), float(s[2])]
    spec = C.LIBRARY.get(obj.get("kind"), C.LIBRARY["crate"])
    k = float(obj.get("height_m") or spec["height"]) / spec["height"]
    return [spec["foot"][0] * k, spec["height"] * k, spec["foot"][1] * k]


def footprint(obj: dict, position=None) -> tuple[float, float, float, float]:
    """(cx, cz, half_w, half_d) of the rotated object, axis-aligned."""
    w, _, d = size_of(obj)
    r = math.radians(float(obj.get("rotation_deg") or 0))
    c, s = abs(math.cos(r)), abs(math.sin(r))
    p = position if position is not None else obj.get("position", [0, 0, 0])
    return float(p[0]), float(p[2]), (w * c + d * s) / 2, (w * s + d * c) / 2


def overlap(a, b, clear: float = CLEAR) -> bool:
    return abs(a[0] - b[0]) < a[2] + b[2] + clear and abs(a[1] - b[1]) < a[3] + b[3] + clear


def obstacles(set_name: str) -> list[tuple]:
    return [(o[0], o[1], o[2] / 2, o[3] / 2) for o in C.SETS[set_name]["obstacles"]]


def in_bounds(fp, set_name: str, margin: float = 0.05) -> bool:
    x0, x1, z0, z1 = C.SETS[set_name]["bounds"]
    return (fp[0] - fp[2] >= x0 - margin and fp[0] + fp[2] <= x1 + margin
            and fp[1] - fp[3] >= z0 - margin and fp[1] + fp[3] <= z1 + margin)


def clamp_into(fp, set_name: str) -> tuple[float, float]:
    """Nearest centre that keeps the footprint inside the set bounds."""
    x0, x1, z0, z1 = C.SETS[set_name]["bounds"]
    hw, hd = min(fp[2], (x1 - x0) / 2), min(fp[3], (z1 - z0) / 2)
    return min(max(fp[0], x0 + hw), x1 - hw), min(max(fp[1], z0 + hd), z1 - hd)


def anchor_points(set_name: str, name: str) -> list[list[float]]:
    a = C.SETS[set_name]["anchors"].get(name)
    if a is None:
        return []
    return [a] if isinstance(a[0], (int, float)) else list(a)


def find_anchor(set_name: str, text: str):
    """Longest anchor name that appears in the text -> (name, points)."""
    t = (text or "").lower()
    for name in sorted(C.SETS[set_name]["anchors"], key=len, reverse=True):
        if name in t or name.replace(" ", "") in t.replace(" ", ""):
            return name, anchor_points(set_name, name)
    return None, []


def is_free(obj: dict, pos, set_name: str, others: list[dict], ignore_ids=()) -> bool:
    fp = footprint(obj, pos)
    if not in_bounds(fp, set_name):
        return False
    if any(overlap(fp, o, 0.05) for o in obstacles(set_name)):
        return False
    for o in others:
        if o.get("id") in ignore_ids or o.get("id") == obj.get("id"):
            continue
        if overlap(fp, footprint(o)):
            return False
    return True


def free_spot(obj: dict, want, set_name: str, others: list[dict], ignore_ids=(), avoid=None, max_r: float = 14.0):
    """Nearest free floor position to `want` ([x, z]). Searches rings outward; `avoid(x, z)` can veto spots
    (e.g. the corridor between the camera and the action). Falls back to the clamped spot."""
    x, z = float(want[0]), float(want[1])
    fp = footprint(obj, [x, 0, z])
    cx, cz = clamp_into(fp, set_name)
    if is_free(obj, [cx, 0, cz], set_name, others, ignore_ids) and not (avoid and avoid(cx, cz)):
        return [round(cx, 2), 0.0, round(cz, 2)]
    step = 0.35
    r = step
    while r <= max_r:
        n = max(8, int(2 * math.pi * r / step))
        best = None
        for i in range(n):
            a = 2 * math.pi * i / n
            px, pz = cx + r * math.sin(a), cz + r * math.cos(a)
            if avoid and avoid(px, pz):
                continue
            if is_free(obj, [px, 0, pz], set_name, others, ignore_ids):
                d = (px - x) ** 2 + (pz - z) ** 2
                if best is None or d < best[0]:
                    best = (d, px, pz)
        if best:
            return [round(best[1], 2), 0.0, round(best[2], 2)]
        r += step
    return [round(cx, 2), 0.0, round(cz, 2)]


def heading_to(src, dst) -> float:
    """rotation_deg that turns an object at src to face dst (0 = facing +Z)."""
    return round(math.degrees(math.atan2(dst[0] - src[0], dst[2] - src[2])), 1)


# ---- camera area ------------------------------------------------------------------------------------
# Where a camera may stand: inside the room for interiors (the -Z side is open), between the
# buildings on the street, in front of the plaza building, inside the tank.
CAMERA_AREA = {
    "interior": ([-3.75, 3.75, -16, 4.75], [0.15, 3.0]),
    "water_tank": ([-7.6, 7.6, -7.6, 7.6], [0.15, 8.0]),
    "street_night": ([-6.4, 6.4, -24.5, 34], [0.1, 30]),
    "plaza": ([-30, 30, -40, 10.2], [0.1, 40]),
    "studio": ([-11, 11, -30, 9.6], [0.1, 15]),
}
DEFAULT_CAMERA_AREA = ([-45, 45, -45, 45], [0.1, 60])


def clamp_camera(cam: dict, set_name: str) -> tuple[dict, bool]:
    """Pull a camera that would sit inside a wall back toward its target; keep the framing by narrowing
    the lens by the same ratio. Returns (camera, changed)."""
    (x0, x1, z0, z1), (y0, y1) = CAMERA_AREA.get(set_name, DEFAULT_CAMERA_AREA)
    p, t = [float(v) for v in cam["position"]], [float(v) for v in cam["target"]]
    inside = lambda q: x0 <= q[0] <= x1 and z0 <= q[2] <= z1  # noqa: E731
    changed = False
    if not inside(p):
        lo, hi = 0.0, 1.0  # fraction of the way from target to position that stays inside
        if inside(t):
            for _ in range(30):
                mid = (lo + hi) / 2
                q = [t[k] + (p[k] - t[k]) * mid for k in range(3)]
                lo, hi = (mid, hi) if inside(q) else (lo, mid)
            frac = max(lo * 0.98, 0.05)
            newp = [t[k] + (p[k] - t[k]) * frac for k in range(3)]
        else:
            newp = [min(max(p[0], x0), x1), p[1], min(max(p[2], z0), z1)]
        d0 = math.dist(p, t)
        d1 = math.dist(newp, t)
        cam = dict(cam, position=[round(v, 3) for v in newp],
                   focal_mm=round(max(12.0, float(cam.get("focal_mm", 35)) * d1 / max(d0, 1e-6)), 1))
        p, changed = newp, True
    if not (y0 <= p[1] <= y1):
        cam = dict(cam, position=[round(p[0], 3), round(min(max(p[1], y0), y1), 3), round(p[2], 3)])
        changed = True
    return cam, changed
