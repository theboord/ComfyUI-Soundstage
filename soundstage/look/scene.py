"""Read a SoundstageStage scene JSON into facts the look compiler can say in words.

frame1_facts(scene)  what is on screen at frame 0: shot size, angle, lens band, who is where in frame,
                     head count, visible set pieces, place, weather, lighting.
motion_facts(scene)  the camera move from the first to the last frame (push/pull, truck, crane, pan, tilt,
                     zoom, arc, speed) and every mover's marks (walk/run, direction, destination, where
                     they are in the final frame).

Coordinates follow web/stage/stage.mjs (soundstage/cine/geometry.py): Y up, metres, +X is screen-left
when looking down +Z. Accepts the current scene (camera_keys, per-object keys, camera_track) and the
older start/end form (camera/camera_end, position/position_end).
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path

from ..cine import geometry as G
from ..cine.prompts import SIZE_LTX, SIZE_STILL
from . import stunts as ST

LIBRARY_PATH = Path(__file__).resolve().parents[2] / "web" / "stage" / "library.mjs"

# Fallback copy of web/stage/library.mjs (label, height, rig); the file itself is preferred.
_LIBRARY_FALLBACK = {
    "man": ("Man", 1.8, "biped"), "woman": ("Woman", 1.68, "biped"), "child": ("Child", 1.2, "biped"),
    "dog": ("Dog", 0.6, "quadruped"), "horse": ("Horse", 1.6, "quadruped"), "cat": ("Cat", 0.3, "quadruped"),
    "car": ("Car", 1.45, "vehicle"), "truck": ("Truck", 2.6, "vehicle"), "bicycle": ("Bicycle", 1.05, "vehicle"),
    "motorcycle": ("Motorcycle", 1.15, "vehicle"), "tree": ("Tree", 6.5, "static"), "bush": ("Bush", 1.1, "static"),
    "house": ("House", 6.0, "static"), "bench": ("Bench", 0.85, "static"), "table": ("Table", 0.75, "static"),
    "chair": ("Chair", 0.9, "static"), "lamp": ("Street lamp", 4.2, "static"), "rock": ("Rock", 0.8, "static"),
    "crate": ("Crate", 0.8, "static"), "wall": ("Wall", 2.4, "static"),
}

SET_PLACES = {
    "plaza": ("EXT", "a city plaza"), "street_night": ("EXT", "a city street"), "interior": ("INT", "an interior room"),
    "studio": ("INT", "a studio cyclorama"), "forest": ("EXT", "a forest"), "desert": ("EXT", "a desert"),
    "beach": ("EXT", "a beach by the ocean"), "water_tank": ("EXT", "a water tank"),
    "open_water": ("EXT", "open water out at sea"), "stadium": ("EXT", "a baseball stadium with a manicured ballfield and packed stands"), "empty": ("EXT", ""),
    # Milestone 11 sets (web/stage/sets)
    "underwater": ("EXT", "a coral reef deep underwater, sunlight rays slanting down through blue-green water"),
    "burning_building": ("EXT", "a night street in front of a burning brick building, flames in its windows, burning debris"),
    "airplane_cabin": ("INT", "the cabin of a passenger airliner in flight, rows of seats, overhead bins, oval windows with clouds outside"),
    "runway": ("EXT", "an airport runway"),
    "above_clouds": ("EXT", "the open sky high above a sea of white clouds"),
    "train_car": ("INT", "a passenger train carriage, seats facing across tables, big windows with countryside streaming past"),
    "train_station": ("EXT", "a railway station platform under a steel canopy beside the tracks"),
}
WEATHER_WORDS = {
    "rain": "rain falling", "snow": "snow falling", "fog": "fog and haze in the air", "smoke": "drifting smoke",
    "dust": "dust hanging in the air", "sparks": "fire sparks drifting through the air",
    "fire": "open flames burning, glowing embers and smoke rising",
}
PROP_WORDS = {"building": "a building facade", "box": "a box", "post": "a lamp post"}


@lru_cache(maxsize=1)
def library() -> dict:
    try:
        text = LIBRARY_PATH.read_text(encoding="utf-8")
        found = re.findall(r'^\s+(\w+): \{ label: "([^"]+)", height: ([\d.]+), rig: "(\w+)"', text, re.M)
        if found:
            return {k: (label, float(h), rig) for k, label, h, rig in found}
    except OSError:
        pass
    return dict(_LIBRARY_FALLBACK)


HUMANS_PATH = LIBRARY_PATH.parent / "humans.mjs"

# Fallback copies of SEATS (web/stage/library.mjs: vehicle seats, local metres, +Z forward, +X = the vehicle's left)
# and MOUNTS (web/stage/humans.mjs: where a rider sits on a horse, bike, bench...). The .mjs files are preferred.
_CAR_SEATS = (("Driver", (0.37, 0.52, 0.05)), ("Front passenger", (-0.37, 0.52, 0.05)),
              ("Rear left", (0.37, 0.52, -0.85)), ("Rear right", (-0.37, 0.52, -0.85)))
_SEATS_FALLBACK = {
    "car": _CAR_SEATS, "police_car": _CAR_SEATS, "sports_car": _CAR_SEATS, "hatchback": _CAR_SEATS,
    "truck": (("Driver", (0.5, 1.25, 2.3)), ("Passenger", (-0.5, 1.25, 2.3))),
    "boat": (("Skipper", (0.45, 0.7, 0.4)), ("Passenger", (-0.45, 0.7, 0.4)), ("Stern left", (0.5, 0.65, -1.6)),
             ("Stern right", (-0.5, 0.65, -1.6))),
    "sailboat": (("Helm", (0, 0.95, -3.2)), ("Cockpit left", (0.6, 0.9, -2.4)), ("Cockpit right", (-0.6, 0.9, -2.4)),
                 ("Foredeck", (0, 1.15, 2.4))),
    "catamaran": (("Helm", (1.6, 1.25, -3.6)), ("Trampoline left", (1.4, 1.1, 3.6)), ("Trampoline right", (-1.4, 1.1, 3.6)),
                  ("Deck", (0, 1.25, -2.0))),
    "jetski": (("Rider", (0, 0.7, -0.15)), ("Pillion", (0, 0.72, -0.75))),
}
_MOUNTS_FALLBACK = {
    "horse": ("ride", (0, 1.56, -0.05), 1.6), "bicycle": ("cycle", (0, 1.0, -0.25), None),
    "motorcycle": ("cycle", (0, 0.86, -0.15), None), "car": ("sit", (-0.38, 0.5, 0.15), None),
    "truck": ("sit", (-0.5, 1.25, 2.3), None), "chair": ("sit", (0, 0.47, 0), None), "bench": ("sit", (0, 0.47, 0.05), None),
    "table": ("sit", (0, 0.77, 0), None), "rock": ("sit", (0, 0.6, 0), None), "cube": ("sit", (0, 1.0, 0), 1.0),
}
# Riders of these sit behind glass: seen from outside they are part of the vehicle, not people standing in frame.
ENCLOSED = {"car", "police_car", "sports_car", "hatchback", "truck"}
_SEAT_WORDS = {"Driver": "at the wheel in the driver's seat", "Front passenger": "in the front passenger seat",
               "Rear left": "in the back seat behind the driver", "Rear right": "in the back seat behind the front passenger",
               "Passenger": "in the passenger seat", "Skipper": "at the helm", "Helm": "at the helm"}
_SEAT_ROLES = {"Driver": "the driver", "Front passenger": "the front passenger", "Rear left": "the back-seat passenger",
               "Rear right": "the back-seat passenger", "Passenger": "the passenger", "Skipper": "the skipper", "Helm": "the helmsman"}


def _floats(text: str) -> tuple:
    return tuple(float(x) for x in text.split(","))


@lru_cache(maxsize=1)
def seats() -> dict:
    """kind -> ((seat name, (x, y, z)), ...) from web/stage/library.mjs SEATS."""
    try:
        text = LIBRARY_PATH.read_text(encoding="utf-8")
        m = re.search(r"export const SEATS = \{\n(.*?)\n\};([^\n]*)", text, re.S)
        out = {}
        for k, block in re.findall(r"^  (\w+): \[\s*\n(.*?)\n  \],", m.group(1), re.S | re.M):
            out[k] = tuple((n, _floats(v)) for n, v in re.findall(r'name: "([^"]+)", pos: \[([^\]]+)\]', block))
        for stmt in m.group(2).split(";"):   # SEATS.police_car = SEATS.sports_car = SEATS.car
            names = re.findall(r"SEATS\.(\w+)", stmt)
            for k in names[:-1]:
                if names[-1] in out:
                    out[k] = out[names[-1]]
        if out.get("car"):
            return out
    except (OSError, AttributeError, ValueError):
        pass
    return dict(_SEATS_FALLBACK)


@lru_cache(maxsize=1)
def mounts() -> dict:
    """kind -> (pose, seat (x, y, z), refHeight or None) from web/stage/humans.mjs MOUNTS."""
    try:
        text = HUMANS_PATH.read_text(encoding="utf-8")
        block = re.search(r"export const MOUNTS = \{\n(.*?)\n\};", text, re.S).group(1)
        found = re.findall(r'^\s+(\w+): \{ pose: "(\w+)", seat: \[([^\]]+)\](?:, scaleWithHeight: true, refHeight: ([\d.]+))? \}',
                           block, re.M)
        if found:
            return {k: (pose, _floats(seat), float(ref) if ref else None) for k, pose, seat, ref in found}
    except (OSError, AttributeError, ValueError):
        pass
    return dict(_MOUNTS_FALLBACK)


def _article(noun: str) -> str:
    return ("an " if noun[:1].lower() in "aeiou" else "a ") + noun


def _v(x, n=3) -> tuple:
    try:
        return tuple(float(c) for c in list(x)[:n])
    except (TypeError, ValueError):
        return (0.0,) * n


# ---- camera ----------------------------------------------------------------------------------------


def frame_range(scene: dict) -> tuple[int, float]:
    shot = scene.get("shot") or {}
    return int(shot.get("frames") or 97), float(shot.get("fps") or 24.0)


def camera_keys(scene: dict) -> list[dict]:
    """[{frame, position, target, focal_mm}] sorted by frame."""
    frames, _ = frame_range(scene)
    keys = scene.get("camera_keys") or []
    if not keys:
        a = scene.get("camera") or {"position": [-7, 1.7, -14], "target": [0, 1.3, -4], "focal_mm": 35}
        keys = [{"frame": 0, **a}]
        b = scene.get("camera_end")
        if b and b != a:
            keys.append({"frame": frames - 1, **b})
    out = []
    for k in keys:
        out.append({"frame": int(k.get("frame", 0)), "position": _v(k.get("position")),
                    "target": _v(k.get("target")), "focal_mm": float(k.get("focal_mm") or 35)})
    return sorted(out, key=lambda k: k["frame"])


def _cam_sample(keys: list[dict], frame: int) -> dict:
    if frame <= keys[0]["frame"]:
        return dict(keys[0])
    for k0, k1 in zip(keys, keys[1:]):
        if frame <= k1["frame"]:
            u = (frame - k0["frame"]) / max(1e-6, k1["frame"] - k0["frame"])
            lerp = lambda a, b: tuple(x + (y - x) * u for x, y in zip(a, b))  # noqa: E731
            return {"frame": frame, "position": lerp(k0["position"], k1["position"]), "target": lerp(k0["target"], k1["target"]),
                    "focal_mm": k0["focal_mm"] + (k1["focal_mm"] - k0["focal_mm"]) * u}
    return dict(keys[-1])


def _world_cam(cam: dict, host: dict, frame: int, last: int) -> dict:
    tw = local_to_world(host, frame, last, camera=True)
    return {**cam, "frame": frame, "position": tw(cam["position"]), "target": tw(cam["target"])}


def camera_at_ends(scene: dict) -> tuple[dict, dict, list[dict]]:
    """First camera, last camera, and the path samples (the per-frame camera_track when present), in world space.
    A ride-along shot without a track (stage.toJSON()) has its keys in the host's own space: carried into the world."""
    track = scene.get("camera_track") or []
    if len(track) >= 2:
        path = [{"frame": int(t.get("frame", i)), "position": _v(t.get("position")), "target": _v(t.get("target")),
                 "focal_mm": float(t.get("focal_mm") or 35)} for i, t in enumerate(track)]
        return path[0], path[-1], path
    keys = camera_keys(scene)
    host = follow_host(scene)
    if host is not None:
        frames, _ = frame_range(scene)
        path = [_world_cam(_cam_sample(keys, f), host, f, frames - 1) for f in range(frames)]
        return path[0], path[-1], path
    return keys[0], keys[-1], keys


def camera_at(scene: dict, frame: int) -> dict:
    """The world camera at any frame."""
    _, _, path = camera_at_ends(scene)
    return _cam_sample(path, frame)


def local_camera_path(scene: dict) -> list[dict] | None:
    """A ride-along shot's camera in its host's own space (from the track or the keys), or None for a world camera."""
    host = follow_host(scene)
    if host is None:
        return None
    frames, _ = frame_range(scene)
    track = scene.get("camera_track") or []
    if len(track) >= 2:
        out = []
        for i, t in enumerate(track):
            f = int(t.get("frame", i))
            inv = world_to_local(host, f, frames - 1)
            out.append({"frame": f, "position": inv(_v(t.get("position"))), "target": inv(_v(t.get("target"))),
                        "focal_mm": float(t.get("focal_mm") or 35)})
        return out
    return camera_keys(scene)


def lens_band(focal_mm: float) -> str:
    """No numbers for LTX: the lens as a word."""
    if focal_mm < 18:
        return "ultra-wide lens"
    if focal_mm < 30:
        return "wide-angle lens"
    if focal_mm < 45:
        return "wide-normal lens"
    if focal_mm < 70:
        return "normal lens"
    if focal_mm < 110:
        return "portrait telephoto lens"
    return "long telephoto lens"


def angle_of(cam: dict) -> str:
    _, pitch = G.look(cam["position"], cam["target"])
    h = cam["position"][1]
    if pitch > 60:
        return "overhead"
    if pitch > 18:
        return "high"
    if pitch < -18 or h < 0.45:
        return "worms_eye" if h < 0.45 and pitch < -10 else "low"
    if pitch < -7:
        return "low"
    return "eye"


ANGLE_STILL = {"overhead": "overhead view", "high": "high angle", "low": "low angle",
               "worms_eye": "extreme low angle from the ground", "eye": "eye level"}
ANGLE_LTX = {"overhead": "overhead", "high": "high-angle", "low": "low-angle", "worms_eye": "ground-level low-angle",
             "eye": ""}


# ---- the cast and set ------------------------------------------------------------------------------


def _keys(a: dict, last_frame: int = 96) -> list[dict]:
    keys = a.get("keys") or []
    if keys:
        return sorted(({"frame": int(k.get("frame", 0)), "position": _v(k.get("position"))} for k in keys),
                      key=lambda k: k["frame"])
    p = _v(a.get("position"))
    out = [{"frame": 0, "position": p}]
    if a.get("position_end") and _v(a["position_end"]) != p:
        out.append({"frame": max(1, last_frame), "position": _v(a["position_end"])})
    return out


def _pos_at(a: dict, frame: int, last_frame: int = 96) -> tuple:
    """Linear sample through the object's keys (the stage uses Catmull-Rom; ends are exact either way)."""
    keys = _keys(a, last_frame)
    if frame <= keys[0]["frame"]:
        return keys[0]["position"]
    for k0, k1 in zip(keys, keys[1:]):
        if frame <= k1["frame"]:
            u = (frame - k0["frame"]) / max(1e-6, k1["frame"] - k0["frame"])
            return tuple(x + (y - x) * u for x, y in zip(k0["position"], k1["position"]))
    return keys[-1]["position"]


def classify(a: dict) -> tuple[str, str, float]:
    """(noun phrase with article, rig, height). Rig: biped (a person), quadruped, vehicle, static."""
    kind = a.get("kind") or "man"
    lib = library()
    if kind == "custom":
        rig = (a.get("recipe") or {}).get("rig") or "static"
        noun = (a.get("name") or "object").strip().lower()
        return _article(noun), rig, float(a.get("height_m") or 1.0)
    label, h, rig = lib.get(kind, (kind.replace("_", " ").title(), 1.0, "static"))
    noun = label.lower()
    desc = (a.get("description") or "").strip()
    return (desc if desc else _article(noun)), rig, float(a.get("height_m") or h)


def screen_words(sx: float) -> str:
    if sx < -0.55:
        return "on the left edge of frame"
    if sx < -0.2:
        return "left of frame"
    if sx <= 0.2:
        return "in the centre of frame"
    if sx <= 0.55:
        return "right of frame"
    return "on the right edge of frame"


def _project_body(pos, height, cam) -> dict | None:
    """Screen x of the body centre, vertical extent, visibility and distance."""
    p, t, f = cam["position"], cam["target"], cam["focal_mm"]
    head = G.project((pos[0], pos[1] + height * 0.92, pos[2]), p, t, f)
    feet = G.project((pos[0], pos[1], pos[2]), p, t, f)
    mid = G.project((pos[0], pos[1] + height * 0.55, pos[2]), p, t, f)
    if mid is None:
        return None
    fwd, _, _ = G.basis(p, t)
    z = G.dot(G.sub(pos, p), fwd)
    in_x = -1.08 <= mid[0] <= 1.08
    top = head[1] if head else 1.5
    bottom = feet[1] if feet else -1.5
    in_y = bottom < 1.0 and top > -1.0
    return {"sx": mid[0], "top": top, "bottom": bottom, "z": z, "visible": in_x and in_y,
            "screen_h": (min(top, 1) - max(bottom, -1)) / 2}


def shot_size(z: float, height: float, focal_mm: float) -> str:
    """Shot size from how much of the subject's height the frame covers at its distance."""
    frame_h = z * G.sensor_h() / focal_mm
    r = frame_h / max(0.2, height)
    for size, limit in (("EWS", 6.0), ("WS", 2.2), ("FS", 1.12), ("COWBOY", 0.78), ("MS", 0.5), ("MCU", 0.33),
                        ("CU", 0.17)):
        if r >= limit:
            return size
    return "ECU"


def _facing_words(direction, cam, plural: bool = False, animal: bool = False, vehicle: bool = False,
                  reversing: bool = False) -> str:
    fwd, right, _ = G.basis(cam["position"], cam["target"])
    d = G.flat(direction)
    if G.length(d) < 1e-6:
        return ""
    a = G.dot(d, G.flat(fwd))
    if vehicle and reversing:
        # A stunt car backing up at speed (direction = where its nose points): the tail leads (Milestone 13).
        if a > 0.55:
            return "rear end first toward the camera, red tail lights and white reverse lights glowing, nose pointing away, reversing toward us at speed"
        if a < -0.55:
            return "front toward the camera, headlights and grille facing us, reversing away from us rear end first"
        side = "screen-right" if G.dot(d, right) > 0 else "screen-left"
        other = "screen-left" if side == "screen-right" else "screen-right"
        return f"in profile, its nose pointing {side}, reversing rear end first toward {other}"
    if vehicle:
        # A grey clay sedan reads the same nose or tail first: name the lights and the direction of travel, or the
        # video model drives it in reverse.
        if a > 0.55:
            return "seen from behind, rear bumper and red tail lights toward the camera, nose pointing away, driving forward away from us"
        if a < -0.55:
            return "front toward the camera, headlights and grille facing us, driving forward toward the camera"
        side = "screen-right" if G.dot(d, right) > 0 else "screen-left"
        return f"in profile, its nose pointing {side}, driving forward to {side}"
    if a > 0.55:
        # Animals and vehicles: say it bluntly; a clay horse from behind reads as a horse facing us otherwise.
        return ("seen from behind, facing away from the camera" + (", tails toward us" if animal else "")) if animal is not None and animal \
            else f"with their back{'s' if plural else ''} to the camera"
    if a < -0.55:
        return "facing the camera" + (", heads toward us" if animal else "")
    return "in profile, facing screen-right" if G.dot(d, right) > 0 else "in profile, facing screen-left"


def _heading(a: dict, frames: int) -> tuple:
    """Direction of travel at the start (or the static rotation)."""
    p0, p1 = _pos_at(a, 0, frames - 1), _pos_at(a, max(1, min(frames - 1, 12)), frames - 1)
    d = G.sub(p1, p0)
    if G.length((d[0], 0, d[2])) > 0.05:
        return d
    p_end = _pos_at(a, frames - 1, frames - 1)
    d = G.sub(p_end, p0)
    if G.length((d[0], 0, d[2])) > 0.05:
        return d
    r = math.radians(float(a.get("rotation_deg") or 0))
    return (math.sin(r), 0.0, math.cos(r)) if "rotation_deg" in a else (0.0, 0.0, 0.0)


def definite(noun: str) -> str:
    """'a man' -> 'the man'."""
    for art in ("a ", "an "):
        if noun.startswith(art):
            return "the " + noun[len(art):]
    return noun


_PLURALS = {"man": "men", "woman": "women", "child": "children", "person": "people"}
_COUNTS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}


def _group_nouns(nouns: list[str]) -> str:
    """'a man', 'a man' -> 'two men'; mixed groups stay a list ('a man and a woman')."""
    if len(nouns) > 1 and len(set(nouns)) == 1 and nouns[0].startswith(("a ", "an ")) and len(nouns) in _COUNTS:
        word = nouns[0].split(" ", 1)[1]
        head, _, tail = word.partition(" ")
        plural = _PLURALS.get(head, head + "s")
        # "a man riding a horse" x2 -> "two men riding horses", not "two men riding a horse"
        tail = re.sub(r"^((?:\w+ )*?(?:riding|on|sitting on|in)) an? (\w+)$", lambda m: f"{m.group(1)} {m.group(2)}s", tail)
        return f"{_COUNTS[len(nouns)]} {plural}" + (f" {tail}" if tail else "")
    return _join_and(nouns)


def _distance_words(screen_h: float, person: bool = True) -> str:
    """How big the figures read in frame. Without it, image models tend to add a foreground subject."""
    if screen_h < 0.18:
        return "small in the distance"
    if screen_h < 0.5:
        return ("full figures" if person else "seen whole") + " in the middle distance, empty ground in the foreground"
    return ""


def _join_and(items: list[str]) -> str:
    items = [i for i in items if i]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _props(scene: dict) -> list[dict]:
    """Stage props plus static library objects placed as actors."""
    out = []
    # stage._buildSet builds the scene's props (building, planters, lamp post) on the plaza set only.
    on_plaza = ((scene.get("environment") or {}).get("set") or "plaza") == "plaza"
    for p in (scene.get("props") or []) if on_plaza else []:
        kind = p.get("kind", "box")
        pid = str(p.get("id", ""))
        word = PROP_WORDS.get(kind, _article(kind))
        base = pid.split("_")[0]
        if kind == "box" and base and base not in ("box", "prop"):
            word = _article(base)
        if kind == "building" and p.get("door"):
            word = "a building facade with a doorway"
        size = _v(p.get("size") or [1, 1, 1])
        out.append({"id": pid, "kind": kind, "word": word, "position": _v(p.get("position")), "size": size,
                    "door": bool(p.get("door"))})
    for a in scene.get("actors") or []:
        noun, rig, h = classify(a)
        if rig == "static":
            out.append({"id": a.get("id"), "kind": a.get("kind"), "word": noun, "position": _pos_at(a, 0),
                        "size": (1.0, h, 1.0), "door": False})
    return out


def _visible_prop(pr: dict, cam: dict) -> dict | None:
    x, y, z = pr["position"]
    w, h, d = pr["size"]
    pts = [(x + sx * w / 2, y + sy * h, z + sz * d / 2) for sx in (-1, 1) for sy in (0, 0.5, 1) for sz in (-1, 1)]
    proj = [G.project(q, cam["position"], cam["target"], cam["focal_mm"]) for q in pts]
    proj = [q for q in proj if q]
    if not proj:
        return None
    xs, ys = [q[0] for q in proj], [q[1] for q in proj]
    if max(xs) < -1 or min(xs) > 1 or max(ys) < -1 or min(ys) > 1:
        return None
    cx = (max(min(xs), -1) + min(max(xs), 1)) / 2
    span = (min(max(xs), 1) - max(min(xs), -1)) / 2
    return {"sx": cx, "span": span}


def _inside(pos, pr, margin=0.3) -> bool:
    x, _, z = pr["position"]
    w, _, d = pr["size"]
    return abs(pos[0] - x) <= w / 2 + margin and abs(pos[2] - z) <= d / 2 + margin


def location(scene: dict) -> dict:
    env = scene.get("environment") or {}
    set_id = env.get("set", "plaza")
    int_ext, place = SET_PLACES.get(set_id, ("EXT", set_id.replace("_", " ")))
    weather = WEATHER_WORDS.get(env.get("weather", "none"), "")
    return {"set": set_id, "int_ext": int_ext, "place": place, "weather": weather}


def lighting_words(scene: dict, cam: dict) -> str:
    """The stage's own lighting note when the widget sent one, else a port of describeLighting()."""
    if scene.get("lighting_prompt"):
        return str(scene["lighting_prompt"]).strip()
    sun = scene.get("sun") or {}
    lighting = scene.get("lighting") or {}
    el = float(sun.get("elevation_deg", 30))
    az = math.radians(float(sun.get("azimuth_deg", 180)))
    if lighting.get("overcast"):
        phase = "soft overcast daylight"
    elif el < -6:
        phase = "night, cool moonlight"
    elif el < 0:
        phase = "blue hour twilight"
    elif el < 6:
        phase = "magic hour"
    elif el < 20:
        phase = "golden hour"
    else:
        phase = "bright daylight"
    parts = [phase]
    if el > 0 and not lighting.get("overcast"):
        view = G.flat(G.sub(cam["target"], cam["position"]))
        sun_dir = (math.sin(az), 0.0, math.cos(az))
        # Screen-right of the camera (+X is screen-LEFT looking down +Z). lighting.mjs's describeLighting uses
        # (view.z, 0, -view.x), which is screen-left, so its "camera right/left" is mirrored; this is not.
        _, right, _ = G.basis(cam["position"], cam["target"])
        f, r = G.dot(sun_dir, view), G.dot(sun_dir, G.flat(right))
        where = ("behind the subjects (backlight, rim on hair and shoulders)" if f > 0.5 else
                 "behind the camera (front light)" if f < -0.5 else
                 f"from camera {'right' if r > 0 else 'left'} (side light, long shadows)")
        parts.append(f"{'low ' if el < 10 else ''}sun {round(el)}° above the horizon {where}")
    for l in lighting.get("lights") or []:
        k = float(l.get("kelvin", 5600))
        tone = "warm tungsten" if k < 3300 else "cool blue" if k > 9000 else "cool" if k > 6000 else "neutral"
        parts.append(f"{tone} {str(l.get('type', 'light')).replace('_', ' ')}")
    # A street of five lamps is one phrase, not "warm tungsten practical" five times over (as lighting.mjs).
    return ", ".join(dict.fromkeys(parts))


def _underwater(scene: dict, cam: dict) -> bool:
    env = scene.get("environment") or {}
    if env.get("set") == "underwater":   # the reef set: the surface is 10 m above the seabed (web/stage/sets/underwater.mjs)
        return cam["position"][1] < 10.0
    return env.get("set") == "water_tank" and cam["position"][1] < float(env.get("water_level", 2.5))


# ---- facts ----------------------------------------------------------------------------------------


def _by_id(scene: dict, aid) -> dict | None:
    return next((a for a in scene.get("actors") or [] if aid is not None and a.get("id") == aid), None)


def _yaw_at(a: dict, frame: int, last: int) -> float:
    """Heading (radians, forward = (sin, 0, cos)) like stage._headingAt: the way it travels, else the way it last
    travelled, else its Turn, else the way it will set off. A stunt car's nose goes where its keys put it."""
    y = ST.stunt_yaw(a, frame, last, _pos_at)
    if y is not None:
        return y

    def step(f):
        p0, p1 = _pos_at(a, max(0, f - 1), last), _pos_at(a, min(last, f + 1), last)
        dx, dz = p1[0] - p0[0], p1[2] - p0[2]
        return math.atan2(dx, dz) if math.hypot(dx, dz) > 0.004 else None
    if len(_keys(a, last)) > 1:
        for f in range(frame, -1, -1):
            y = step(f)
            if y is not None:
                return y
    if "rotation_deg" in a:
        return math.radians(float(a.get("rotation_deg") or 0))
    if len(_keys(a, last)) > 1:
        for f in range(frame, last + 1):
            y = step(f)
            if y is not None:
                return y
    return 0.0


def local_to_world(a: dict, frame: int, last: int, camera: bool = False):
    """stage._actorFrame: the object's own space (+Z forward, +X its left) -> world at `frame`. Cameras keep their
    absolute height (as the stage does); seats ride on the object's height."""
    p = _pos_at(a, frame, last)
    yaw = _yaw_at(a, frame, last)
    c, s = math.cos(yaw), math.sin(yaw)
    return lambda v: (p[0] + v[0] * c + v[2] * s, (0.0 if camera else p[1]) + v[1], p[2] - v[0] * s + v[2] * c)


def world_to_local(a: dict, frame: int, last: int):
    p = _pos_at(a, frame, last)
    yaw = _yaw_at(a, frame, last)
    c, s = math.cos(yaw), math.sin(yaw)
    return lambda v: ((v[0] - p[0]) * c - (v[2] - p[2]) * s, v[1], (v[0] - p[0]) * s + (v[2] - p[2]) * c)


def mount_host(scene: dict, a: dict) -> dict | None:
    """The horse / car / bench this actor rides or sits on (stage.mount: rider.mount_id), or None."""
    h = _by_id(scene, a.get("mount_id"))
    return h if h is not None and h is not a and not h.get("mount_id") else None


def _mounted(a: dict, frame: int) -> bool:
    """A timed mount (mount_at) walks free until then (stage.setFrame)."""
    return not (float(a.get("mount_at") or 0) > frame)


def seat_of(scene: dict, a: dict) -> tuple[str, tuple] | None:
    """(seat name, seat position in the host's own space, scaled like stage.setFrame) for a rider, else None."""
    host = mount_host(scene, a)
    if host is None:
        return None
    kind = host.get("kind", "")
    vseats = seats().get(kind)
    if vseats:
        name, sp = vseats[max(0, min(len(vseats) - 1, int(a.get("seat") or 0)))]
        ref = library().get(kind, ("", 1.0, ""))[1] or 1.0
        k = float(host.get("scale") or 1) * (float(host.get("height_m") or ref) / ref)
    else:
        pose, sp, ref = mounts().get(kind) or ("sit", (0.0, float(host.get("height_m") or 1) * 0.6, 0.0), None)
        k = float(host.get("scale") or 1) * ((float(host.get("height_m") or ref) / ref) if ref else 1.0)
        name = ""
    return name, tuple(v * k for v in sp)


def world_pos(scene: dict, a: dict, frame: int, last: int | None = None) -> tuple[tuple, dict | None]:
    """Where an actor is at `frame`: its own keys, or (once mounted) its seat on the host carried into the world.
    Returns (position, host or None). A rider's position is the seat (the pelvis), not the feet."""
    last = frame_range(scene)[0] - 1 if last is None else last
    host = mount_host(scene, a)
    if host is not None and _mounted(a, frame):
        _, sp = seat_of(scene, a)
        return local_to_world(host, frame, last)(sp), host
    return _pos_at(a, frame, last), None


def follow_host(scene: dict) -> dict | None:
    """The object the active shot's camera rides with (camera_follow: keys in its own space), or None."""
    shots = scene.get("shots") or []
    sid = scene.get("active_shot") or scene.get("shot_id")
    shot = next((s for s in shots if s.get("id") == sid), None)
    return _by_id(scene, (shot or {}).get("camera_follow"))


def ride_host(scene: dict) -> dict | None:
    """The vehicle the camera is in or on (vehicle_camera() names the placement), or None."""
    host = follow_host(scene)
    return host if host is not None and vehicle_camera(scene) else None


def riders_of(scene: dict, host_id, frame: int = 0) -> list[dict]:
    """Everyone on or in `host_id` at `frame`, seat order."""
    out = [a for a in scene.get("actors") or [] if a.get("mount_id") == host_id and a.get("kind") in ("man", "woman", "child")
           and mount_host(scene, a) is not None and _mounted(a, frame)]
    return sorted(out, key=lambda a: int(a.get("seat") or 0))


SEAT_ROWS = ("plane_seats", "train_seats")   # the cabin / carriage sets' seat rows (web/stage/sets): people sit in them


def _ride_noun(noun: str, host: dict) -> str:
    kind = host.get("kind", "")
    if kind in SEAT_ROWS:
        return f"{noun} seated by the window"
    hnoun = library().get(kind, (kind.replace("_", " "),))[0].lower()
    if kind == "horse":
        return f"{noun} on horseback"
    if kind in ("bicycle", "motorcycle", "jetski"):
        return f"{noun} riding {_article(hnoun)}"
    return f"{noun} sitting on {_article(hnoun)}" if kind in mounts() else f"{noun} on {_article(hnoun)}"


def cast(scene: dict) -> list[dict]:
    frames, _ = frame_range(scene)
    last = frames - 1
    out = []
    for a in scene.get("actors") or []:
        noun, rig, h = classify(a)
        if rig == "static":
            continue
        host = mount_host(scene, a) if rig == "biped" else None
        start, h0 = world_pos(scene, a, 0, last)
        end, _ = world_pos(scene, a, last, last)
        heading = _heading(a, frames)
        if h0 is not None:
            y = _yaw_at(h0, 0, last)
            heading = (math.sin(y), 0.0, math.cos(y))
        reversing = False
        if rig == "vehicle" and ST.is_stunt(a):    # the nose, not the travel: a stunt car may lead with its tail
            y = ST.stunt_yaw(a, 0, last, _pos_at)
            if y is not None:
                heading = (math.sin(y), 0.0, math.cos(y))
            reversing = ST.reversing_at(a, 0, last, _pos_at)
        out.append({"id": a.get("id"), "noun": noun, "rig": rig, "height": h, "actor": a, "host": host,
                    "enclosed": bool(host and host.get("kind") in ENCLOSED),
                    "start": start, "end": end, "heading": heading, "reversing": reversing})
    return out


def _occluded(e: dict, others: list[dict], cam: dict) -> bool:
    """A seated head hidden right behind a nearer seated head (the back seat behind the front passenger)."""
    for o in others:
        if o is e or o["z"] >= e["z"] - 0.3:
            continue
        hw = 0.16 * cam["focal_mm"] / max(0.2, o["z"]) / (G.SENSOR_W_MM / 2)   # half a head-and-shoulders, screen units
        if abs(o["sx"] - e["sx"]) < hw and abs(o["top"] - e["top"]) < 0.35:
            return True
    return False


def frame_facts(scene: dict, cam: dict, frame: int) -> dict:
    """Who and what is on screen through `cam` at `frame`.

    Riders count where they sit: in a car's seat (through the car's own transform), in a saddle. Seen from outside, the
    people inside a car are part of the car (their host is marked `occupied`); with the camera riding in or on that car
    they are the people in frame. A rider and their horse read as one figure ("a man on horseback")."""
    last = frame_range(scene)[0] - 1
    ride = ride_host(scene)
    people, others, occupied = [], [], set()
    for c in cast(scene):
        if ride is not None and c["id"] == ride.get("id"):
            continue                                   # the camera is in / on it: vehicle_camera() says where
        pos, host = world_pos(scene, c["actor"], frame, last)
        seated = host is not None
        if seated and c["enclosed"] and not (ride is not None and host.get("id") == ride.get("id")):
            occupied.add(host.get("id"))               # behind the glass of a car seen from outside
            continue
        s = c["height"] / 1.8
        body = 0.92 * s if seated else c["height"]       # from the seat up: the head sits ~0.85 m above the seat
        pr = _project_body(pos, body, cam)
        hidden = not seated and any(q["kind"] in ("building", "house") and _inside(pos, q, margin=-0.2) for q in _props(scene))
        if not pr or not pr["visible"] or hidden:
            continue
        noun = c["noun"]
        heading = c["heading"]
        if seated:
            y = _yaw_at(host, frame, last)
            heading = (math.sin(y), 0.0, math.cos(y))
            if ride is not None and host.get("id") == ride.get("id"):
                name, _ = seat_of(scene, c["actor"])
                noun = f"{noun} {_SEAT_WORDS.get(name, f'in the {name.lower()} seat' if name else '')}".strip()
            else:
                noun = _ride_noun(noun, host)
        size = shot_size(pr["z"], c["height"], cam["focal_mm"])
        if seated and size in ("FS", "COWBOY"):
            size = "MS"                                # sitting: the legs are out of the picture however wide the frame
        entry = {**c, "noun": noun, "heading": heading, "pos": pos, **pr, "where": screen_words(pr["sx"]),
                 "size": size, "seated": seated,
                 "riding": seated and not c["enclosed"] and host.get("kind") not in SEAT_ROWS, "host_id": host.get("id") if seated else None,
                 # Riding along: they sit still in the frame however fast the car goes.
                 "moves": not (ride is not None and seated and host.get("id") == ride.get("id"))}
        (people if c["rig"] == "biped" else others).append(entry)
    if ride is not None:
        people = [e for e in people if not (e["seated"] and _occluded(e, people, cam))]
    ridden = {e["host_id"] for e in people if e["riding"]}
    others = [e for e in others if e["id"] not in ridden]      # the horse is in the rider's phrase
    for e in others:
        e["occupied"] = e["id"] in occupied
    props: list[dict] = []
    for pr in _props(scene):
        v = _visible_prop(pr, cam)
        if not v:
            continue
        twin = next((q for q in props if q["word"] == pr["word"]), None)
        if twin:  # two planters -> "a pair of planters" once, not two near-identical phrases
            twin["count"] += 1
            twin["where"] = "framing the space"
            continue
        props.append({**pr, **v, "count": 1,
                      "where": "filling the background" if v["span"] > 0.6 else screen_words(v["sx"])})
    for q in props:
        if q["count"] > 1:
            noun = q["word"].split(" ", 1)[1]
            q["word"] = f"{'a pair of' if q['count'] == 2 else 'several'} {noun}s"
    subjects = people or others
    nearest = min(subjects, key=lambda e: e["z"]) if subjects else None
    return {"people": people, "others": others, "props": props, "nearest": nearest,
            "size": nearest["size"] if nearest else "WS",
            "occupied": any(e.get("occupied") for e in others) or bool(ride is not None and riders_of(scene, ride.get("id"), frame))}


def groups(entries: list[dict], cam: dict) -> list[dict]:
    """Cluster figures standing together: [{nouns, plural, where, far, facing}] left to right."""
    entries = sorted(entries, key=lambda e: e["sx"])
    clusters: list[list[dict]] = []
    for e in entries:
        near = 3.0 if e.get("riding") else 1.8 if e.get("rig") == "biped" else max(1.8, 1.4 * (e.get("height") or 1.0) + 0.8)  # horses, cars sit wider apart
        in_car = not e.get("moves", True)   # riding along in the car: each seat is its own phrase, never "side by side"
        if clusters and not in_car and G.length(G.sub(e["pos"], clusters[-1][-1]["pos"])) < near \
                and abs(e["sx"] - clusters[-1][-1]["sx"]) < 0.5:
            clusters[-1].append(e)
        else:
            clusters.append([e])
    out = []
    for g in clusters:
        sx = sum(e["sx"] for e in g) / len(g)
        h = min(e["screen_h"] for e in g)
        facing = _facing_words(g[0]["heading"], cam, len(g) > 1, animal=g[0].get("rig") not in (None, "biped", "vehicle"),
                               vehicle=g[0].get("rig") == "vehicle", reversing=bool(g[0].get("reversing")))
        if all(e.get("riding") for e in g) and "back" in facing and any("horseback" in e["noun"] for e in g):
            facing += ", the horse's tail toward us" if len(g) == 1 else ", the horses' tails toward us"
        out.append({"nouns": _group_nouns([e["noun"] for e in g]), "plural": len(g) > 1, "where": screen_words(sx),
                    "far": h < 0.18, "distance": _distance_words(h, all(e.get("rig") == "biped" for e in g)),
                    "facing": facing,
                    "pose": "ride" if all(e.get("riding") for e in g) else "sit" if all(e.get("seated") for e in g) else "",
                    "moving": any(e.get("moves", True) and G.length(G.sub(e["end"], e["start"])) > 0.3 for e in g)})
    return out


def group_phrase(entries: list[dict], cam: dict, with_facing: bool = True) -> list[str]:
    """Still-prompt form: 'a man and a woman side by side in the centre of frame, with their backs to the camera'."""
    out = []
    gs = groups(entries, cam)
    in_car = len(gs) > 1 and entries and all(not e.get("moves", True) for e in entries)
    if in_car and with_facing and len({g["facing"] for g in gs}) == 1 and gs[0]["facing"]:
        # Seat by seat, the way they all face once (a repeated "facing the camera" would be deduped off the last seat).
        both = "both" if len(gs) == 2 else f"all {_COUNTS.get(len(gs), len(gs))}"
        return [_join_and([f"{g['nouns']} {g['where']}" for g in gs]) + f", {both} {_facing_words(entries[0]['heading'], cam, True)}"]
    for g in gs:
        bits = [g["nouns"] + (" side by side" if g["plural"] else "") + " " + g["where"],
                g["distance"], g["facing"] if with_facing else ""]
        out.append(", ".join(b for b in bits if b))
    return out


def blocking_sentence(entries: list[dict], cam: dict) -> str:
    """LTX form: 'A man and a woman stand side by side in the centre of frame, with their backs to the camera.'"""
    out = []
    for g in groups(entries, cam):
        base = {"ride": "ride", "sit": "sit"}.get(g["pose"]) or ("start" if g["moving"] else "stand")
        verb = base + " side by side" if g["plural"] else (base + "s")
        s = f"{g['nouns']} {verb} {g['where']}" + (", small in the distance" if g["far"] else "")
        if g["facing"]:
            s += f", {g['facing']}"
        out.append(s[:1].upper() + s[1:] + ".")
    return " ".join(out)


def traffic_lock(scene: dict) -> dict | None:
    """Vehicles on stage and nobody on foot: say the road holds only those vehicles (video models add traffic,
    pedestrians and duplicate cars that drive through each other). Returns {"still", "motion", "negative"} or None.
    With the camera riding in one of them, that one is "the car" and the street is outside the windows."""
    lib = library()
    actors = scene.get("actors") or []
    cars = [a for a in actors if lib.get(a.get("kind"), ("", 0, ""))[2] == "vehicle"]
    if not cars:
        return None
    on_foot = [a for a in actors if a.get("kind") in ("man", "woman", "child") and not a.get("mount_id")]
    if on_foot:
        return None
    ride = ride_host(scene)
    def words(group):
        names = [lib.get(a["kind"], (a["kind"].replace("_", " "),))[0].lower() for a in group]
        count = {n: names.count(n) for n in names}
        return " and ".join(_article(n) if c == 1 else f"{c} {n}s" for n, c in count.items())
    neg = ("pedestrians, people walking in the road, people crossing the street, extra cars, duplicate cars, a second police car, "
           "cars passing through each other, merging cars")
    if ride is not None:
        rest = [a for a in cars if a is not ride]
        tail = f", the only other vehicle{'s are' if len(rest) > 1 else ' is'} {words(rest)}" if rest else ", no other cars on the road"
        # LTX drifts toward ordinary traffic as the shot goes on (a car overtaking at the frame edge), and its
        # Draft/Final sample at CFG 1, where a negative prompt does nothing. Naming what is absent ("nothing pulls
        # alongside or overtakes", "no other vehicles") primed the very cars it ruled out (Milestone 5, two seeds):
        # the motion prompt describes only what IS there, for the whole duration, early in the prompt.
        legacy = scene.get("look_start") is False   # re-rendering a frame picked before Milestone 5: its words
        whole = ("an empty road, bare curbs and empty sidewalks from the first frame to the last; only buildings, "
                 "trees and lamp posts slide past")
        if legacy:
            whole = ("the road stays empty for the whole shot, from the first frame to the last: the lanes beside and "
                     "behind the car stay clear, nothing pulls alongside or overtakes, the curbs are bare and the sidewalks empty")
        if rest:
            whole = (f"the only other vehicle{'s are' if len(rest) > 1 else ' is'} {words(rest)}; "
                     + ("apart from that the road stays empty for the whole shot, from the first frame to the last: nothing else pulls "
                        "alongside or overtakes, the curbs are bare and the sidewalks empty" if legacy else
                        "apart from that an empty road, bare curbs and empty sidewalks from the first frame to the last"))
        if (vehicle_camera(scene) or {}).get("where") == "interior":
            return {"still": f"outside the windows a deserted street with empty sidewalks{tail}",
                    "motion": f"Outside the windows {whole}.",
                    "negative": neg}
        return {"still": f"a deserted street with empty sidewalks{tail}",
                "motion": (f"On the road, {whole}." if rest else f"The car has the street to itself. {whole[0].upper() + whole[1:]}."
                           if legacy else f"The car has the street to itself: {whole}."),
                "negative": neg}
    w = words(cars)
    # Krea 2 Turbo has no negative prompt, and naming what's absent invites it: describe the empty street instead.
    return {"still": f"a deserted street with empty sidewalks, the only vehicles are {w}",
            "motion": f"The street is deserted apart from {w}, the sidewalks empty for the whole shot; each car stays whole and keeps its own lane, "
                      "and no other vehicle drives into frame, from the first frame to the last.",
            "negative": neg}


def _who(roles: list[str]) -> str:
    """['the driver', 'the back-seat passenger', 'the back-seat passenger'] -> 'the driver and two back-seat passengers'."""
    out = []
    for r in dict.fromkeys(roles):
        n = roles.count(r)
        out.append(r if n == 1 else f"{_COUNTS.get(n, n)} {r[4:]}s")
    return _join_and(out)


def vehicle_camera(scene: dict) -> dict | None:
    """Where a ride-along camera sits on its vehicle, in words for the image and video models.

    A shot with camera_follow keeps its camera keys in the vehicle's own frame (x = the vehicle's left, +z forward).
    Without this the models only see "a man drives a blue sedan" and paint that sedan in front of a POV camera.
    The words name who actually sits where (the riders' seats), so an empty passenger seat is never "the passenger".
    Returns {"framing", "where", "lead", "still", "motion", "negative"} or None when the camera isn't in or on a vehicle.
    """
    shots = scene.get("shots") or []
    sid = scene.get("active_shot") or scene.get("shot_id")
    shot = next((s for s in shots if s.get("id") == sid), None)
    host_id = (shot or {}).get("camera_follow")
    if not host_id:
        return None
    host = next((a for a in scene.get("actors") or [] if a.get("id") == host_id), None)
    kind = (host or {}).get("kind", "")
    lib = library()
    if not host or lib.get(kind, ("", 0, ""))[2] != "vehicle":
        return None
    keys = shot.get("camera_keys") or []
    if not keys:
        return None
    k0 = keys[0]
    (px, py, pz), (tx, ty, tz) = k0["position"], k0["target"]
    noun = lib.get(kind, (kind.replace("_", " "),))[0].lower()
    if abs(px) > 1.4 or pz > 3.2 or pz < -3.0 or py > 2.6:
        return None                                              # tracking alongside / overhead: an outside shot
    frames, _ = frame_range(scene)
    moving = G.length(G.sub(_pos_at(host, frames - 1, frames - 1), _pos_at(host, 0, frames - 1))) > 0.3
    seat_names = {}
    for a in riders_of(scene, host_id, 0):
        name, _ = seat_of(scene, a)
        seat_names.setdefault(_SEAT_ROLES.get(name, f"the {name.lower()} rider" if name else "the passenger"), []).append(a)
    roles = [r for r, lst in seat_names.items() for _ in lst]
    front = [r for r in roles if r in ("the driver", "the front passenger", "the passenger")]
    back = [r for r in roles if r == "the back-seat passenger"]
    def pron(group):
        return "them" if len(group) != 1 else "her" if group[0].get("kind") == "woman" else "him"
    back_actors = seat_names.get("the back-seat passenger", [])
    who_all, who_front, who_back = _who(roles), _who(front), _who(back)
    empty_front = len(front) < 2 and kind in ("car", "police_car", "sports_car", "hatchback", "truck")
    looks_back = tz < pz - 0.5
    looks_sideways = abs(tx - px) > abs(tz - pz)
    street = " as the street slides past" if moving else ""
    if pz > 1.6 and looks_back:
        inside = f"{who_all} seated inside behind the glass, facing the camera" if roles else "the empty seats inside"
        return {"framing": "windshield", "where": "hood",
                "lead": f"close shot through the windshield of a {noun}, {inside}",
                "still": f"shot from the hood of the {noun}, looking back through the windshield at {who_all or 'the empty cabin'}",
                "motion": f"The camera is mounted on the hood of the {noun}, looking back through the windshield at {who_all or 'the empty cabin'} inside{street}.",
                "negative": "the car seen from a distance, exterior wide shot of the whole car, camera inside the car, people standing outside the car, "
                            "people on the hood" + ("" if empty_front else ", empty seats")}
    if pz > 1.6 and not looks_back:
        return {"framing": "hood_forward", "where": "hood", "lead": "",
                "still": f"low hood-mounted camera on the front of the {noun}, looking down the road ahead",
                "motion": f"The camera is mounted on the hood of the {noun}, racing down the road ahead.",
                "negative": ""}
    if looks_back and pz > 0.45 and not looks_sideways:
        faces = f"{who_front} facing the camera, {'their faces' if len(front) > 1 else ('her face' if them == 'her' else 'his face')} toward the lens" if front else "the empty front seats"
        extra = f", {who_back} in the back seat between them" if back else ""
        return {"framing": "dash_two_shot", "where": "interior",
                "lead": f"interior of a {noun}, camera on the dashboard looking back at the front seats, {faces}{extra}",
                "still": f"inside the {noun}, from the dashboard looking back at {who_front or 'the front seats'}" + (" side by side" if len(front) > 1 else "")
                         + ", the rear window and street behind them",
                "motion": f"The camera sits on the dashboard of the {noun}, looking back at {who_front or 'the two front seats'}{' as the street slides past the rear window' if moving else ''}.",
                "negative": "exterior view of the car, camera outside the car, people seen from behind, backs of heads, rear view, the road ahead through the windshield"
                            + ("" if empty_front else ", empty seats")}
    if looks_back and not looks_sideways:
        sat = f"{who_back} facing the camera, the rear window behind {pron(back_actors)}" if back else "the empty back seat"
        return {"framing": "back_seat_single", "where": "interior",
                "lead": f"interior of a {noun}, looking back from between the front seats at the back seat, {sat}",
                "still": f"inside the {noun}, looking back between the front seats at the back seat and {who_back or 'nobody'} sitting there"
                         if back else f"inside the {noun}, looking back between the front seats at the empty back seat",
                "motion": f"The camera is between the front seats of the {noun}, looking back at {who_back or 'the back seat'}.",
                "negative": "exterior view of the car, camera outside the car, people seen from behind, backs of heads, the road ahead through the windshield"}
    if pz < -0.5 and not looks_back:
        past = f", {who_front} seen from behind in the front seats" if front else ""
        return {"framing": "back_seat", "where": "interior",
                "lead": f"interior of a {noun}, from the back seat{past}",
                "still": f"from the back seat of the {noun}, looking forward between the two front seats at the road ahead" + (f", the backs of the heads of {who_front}" if front else ""),
                "motion": f"The camera rides in the back seat of the {noun}, looking forward between the front seats{' past ' + who_front if front else ''} at the road ahead.",
                "negative": "exterior view of the car, camera outside the car, faces toward the camera, people facing the camera"}
    if looks_sideways:
        side = "driver" if tx > px else "passenger"
        return {"framing": "side", "where": "interior",
                "lead": f"interior of a {noun}, shot from inside the cabin" + (" from the passenger seat: the driver in profile at the wheel, the side window behind him" if side == "driver" else ""),
                "still": f"from inside the {noun}, in the {'passenger' if side == 'driver' else 'driver'} seat, a close side view of the {side} at the wheel"
                         if side == "driver" else f"from inside the {noun}, a close side view of the passenger",
                "motion": f"The camera rides inside the {noun}, looking across the cabin at the {side}; the street slides past the windows.",
                "negative": "exterior view of the car, camera outside the car, the car door seen from outside"}
    if not looks_back:
        return {"framing": "driver_pov", "where": "interior",
                "lead": f"interior of a {noun}, first-person view from the driver's seat: steering wheel and dashboard in the foreground, the road ahead through the windshield",
                "still": f"first-person view from the driver's seat of the {noun}, looking out through the windshield at the road ahead, the dashboard and hood in the lower frame",
                "motion": f"First-person view from the driver's seat of the {noun}: the road ahead rushes toward the camera through the windshield.",
                "negative": f"a car directly ahead, another {noun} in front of the camera, the {noun} seen from outside, exterior shot, the hood seen from the front"}
    return None


def people_in_shot(scene: dict, step: int = 6) -> bool:
    """Anyone in the shot at any frame: walking into frame later, riding in the car the camera rides, sitting in a car
    that is in frame. The still's negative must not say "people" then."""
    frames, _ = frame_range(scene)
    if ride_host(scene) is not None and riders_of(scene, ride_host(scene).get("id"), 0):
        return True
    for f in list(range(0, frames, step)) + [frames - 1]:
        ff = frame_facts(scene, camera_at(scene, f), f)
        if ff["people"] or ff["occupied"]:
            return True
    return False


def frame1_facts(scene: dict) -> dict:
    cam0, _, _ = camera_at_ends(scene)
    ff = frame_facts(scene, cam0, 0)
    loc = location(scene)
    return {**ff, "camera": cam0, "angle": angle_of(cam0), "height_m": cam0["position"][1],
            "focal_mm": cam0["focal_mm"], "lens_band": lens_band(cam0["focal_mm"]), "location": loc,
            "lighting": lighting_words(scene, cam0), "underwater": _underwater(scene, cam0),
            "size_still": SIZE_STILL[ff["size"]], "size_ltx": SIZE_LTX[ff["size"]]}


def _speed_word(dist: float, seconds: float) -> str:
    v = dist / max(0.1, seconds)
    return "slowly" if v < 0.25 else "" if v < 1.2 else "steadily" if v < 2.5 else "quickly"


def camera_move(scene: dict) -> dict:
    """Decompose first->last camera into the documented LTX verbs."""
    c0, c1, path = camera_at_ends(scene)
    local = local_camera_path(scene)
    host = follow_host(scene)
    if local:   # riding with a car / horse: the move is the one relative to it, not the car's own drive
        c0, c1, path = local[0], local[-1], local
    frames, fps = frame_range(scene)
    seconds = frames / fps
    p0, p1 = c0["position"], c1["position"]
    fwd, right, _ = G.basis(p0, c0["target"])
    disp = G.sub(p1, p0)
    along = G.dot(disp, G.flat(fwd))
    lateral = G.dot(disp, G.flat(right))
    vertical = disp[1]
    yaw0, pitch0 = G.look(p0, c0["target"])
    yaw1, pitch1 = G.look(p1, c1["target"])
    dyaw = (yaw1 - yaw0 + 180) % 360 - 180   # + = toward +X = screen-left = pan left
    dpitch = pitch1 - pitch0                 # + = looking further down = tilt down
    zoom = c1["focal_mm"] / max(1e-6, c0["focal_mm"])
    # Arc: the camera swings around a fixed target at roughly constant distance.
    t0, t1 = c0["target"], c1["target"]
    r0, r1 = G.length(G.sub(p0, t0)), G.length(G.sub(p1, t1))
    ang0 = math.degrees(math.atan2(p0[0] - t0[0], p0[2] - t0[2]))
    ang1 = math.degrees(math.atan2(p1[0] - t1[0], p1[2] - t1[2]))
    darc = (ang1 - ang0 + 180) % 360 - 180
    travel = sum(G.length(G.sub(b["position"], a["position"])) for a, b in zip(path, path[1:])) or G.length(disp)
    shake = 0.0
    if len(path) > 8:  # handheld: the path wobbles around its own smooth line
        # Only the wobble across the path counts: a camera car braking and speeding up with a stunt car bunches its
        # samples along the line (a large second difference) without any shake.
        def _wobble(a, b, c):
            d = G.sub(G.mul(G.add(a, c), 0.5), b)
            t = G.sub(c, a)
            n = G.length(t)
            if n < 1e-6:
                return G.length(d)
            u = G.mul(t, 1.0 / n)
            return G.length(G.sub(d, G.mul(u, G.dot(d, u))))
        jitter = [_wobble(path[i - 1]["position"], path[i]["position"], path[i + 1]["position"]) for i in range(1, len(path) - 1)]
        shake = sum(jitter) / len(jitter)
    parts = []
    tgt_moved = G.length(G.sub(t1, t0))
    if abs(darc) > 15 and abs(r1 - r0) < 0.35 * max(r0, 0.1) and tgt_moved < 0.5:
        parts.append(("arc", "left" if darc < 0 else "right"))
    else:
        if along > 0.4 and along >= abs(lateral) * 0.6:
            parts.append(("dolly_in", ""))
        elif along < -0.4 and -along >= abs(lateral) * 0.6:
            parts.append(("dolly_out", ""))
        if abs(lateral) > 0.6:
            parts.append(("truck", "right" if lateral > 0 else "left"))
        if abs(vertical) > 0.4:
            parts.append(("crane", "up" if vertical > 0 else "down"))
        if abs(dyaw) > 6:
            parts.append(("pan", "left" if dyaw > 0 else "right"))
        if abs(dpitch) > 5:
            parts.append(("tilt", "down" if dpitch > 0 else "up"))
    if zoom > 1.15:
        parts.append(("zoom", "in"))
    elif zoom < 0.87:
        parts.append(("zoom", "out"))
    rides = None
    if host is not None:
        kind = host.get("kind", "")
        rides = {"noun": library().get(kind, (kind.replace("_", " "),))[0].lower(), "inside": ride_host(scene) is not None,
                 "moving": G.length(G.sub(_pos_at(host, frames - 1, frames - 1), _pos_at(host, 0, frames - 1))) > 0.3}
    return {"parts": parts, "seconds": seconds, "travel_m": travel, "speed": _speed_word(travel, seconds),
            "handheld": shake > 0.012, "static": not parts, "start": c0, "end": c1, "keys": len(camera_keys(scene)),
            "rides": rides}


def actor_marks(scene: dict) -> list[dict]:
    """Each mover's walk: verb, direction in the opening frame's terms, destination."""
    frames, fps = frame_range(scene)
    seconds = frames / fps
    cam0, cam1, _ = camera_at_ends(scene)
    fwd, right, _ = G.basis(cam0["position"], cam0["target"])
    props = _props(scene)
    ride = ride_host(scene)
    follow = follow_host(scene)
    everyone = cast(scene)
    # Who carries a rider (the rider's mark says it: "a man on horseback gallops"), and who rides along with the camera.
    ridden = {c["host"].get("id") for c in everyone if c["host"] is not None and not c["enclosed"]}
    out = []
    for c in everyone:
        host = c["host"]
        if ride is not None and (c["id"] == ride.get("id") or (host is not None and host.get("id") == ride.get("id"))):
            continue                       # fixed in the frame: the camera rides with them
        if c["enclosed"] or c["id"] in ridden:
            continue                       # inside a car (the car's mark) / under a rider (the rider's mark)
        start = c["start"]
        timed = host is not None and float(c["actor"].get("mount_at") or 0) > 0
        if timed:   # on foot, then up into the saddle: the way they go is the mount's way after that
            start, _ = world_pos(scene, c["actor"], int(c["actor"]["mount_at"]), frames - 1)
        d = G.sub(c["end"], start)
        if follow is not None:   # riding along: what moves is what moves relative to the car the camera is on
            rel = G.sub(d, G.sub(_pos_at(follow, frames - 1, frames - 1), _pos_at(follow, 0, frames - 1)))
            if G.length((rel[0], 0.0, rel[2])) < 0.3:
                continue          # keeps pace with us (the chase car behind): no move to describe
        dist = G.length((d[0], 0.0, d[2]))
        if dist < 0.3:
            continue
        v = dist / max(0.1, seconds - (float(c["actor"].get("mount_at") or 0) / fps if timed else 0))
        verb_pl = ""
        if host is not None:
            hk = host.get("kind", "")
            if hk == "horse":
                verb, verb_pl = ("rides", "ride") if v < 2.2 else ("canters", "canter") if v < 4.5 else ("gallops", "gallop")
            elif hk in ("bicycle", "motorcycle"):
                verb, verb_pl = ("cycles", "cycle") if hk == "bicycle" else ("rides", "ride")
            else:
                verb, verb_pl = "rides", "ride"
            if timed:
                hn = library().get(hk, (hk.replace("_", " "),))[0].lower()
                saddle = "the saddle" if hk == "horse" else "the seat"
                verb = f"walks to the {hn}, swings up into {saddle} and {verb}"
                verb_pl = f"walk to their {hn}s, swing up into {saddle}s and {verb_pl}"
        elif c["rig"] == "vehicle":
            verb = "drives forward" if v > 2 else "rolls forward"   # "forward": a clay car reads either way round
        elif c["rig"] == "quadruped":
            verb = "trots" if v < 3 else "runs"
        elif (scene.get("environment") or {}).get("set") == "underwater" and min(c["start"][1], c["end"][1]) > 0.8:
            verb = "swims" if v < 1.6 else "swims fast"   # off the seabed on the reef set: the stage swims them
        else:
            verb = "walks" if v < 2.6 else "walks briskly" if v < 5.5 else "runs"
        a, r = G.dot(G.flat(d), G.flat(fwd)), G.dot(G.flat(d), G.flat(right))
        if a > 0.6:
            way = "away from the camera"
        elif a < -0.6:
            way = "toward the camera"
        else:
            way = f"across frame toward screen-{'right' if r > 0 else 'left'}"
        if c["rig"] == "vehicle" and host is None:
            # A movie stunt (Milestone 13): beat by beat, which end leads (reverse, the spin, then nose first).
            loc = location(scene)
            stunt = ST.stunt_mark(c["actor"], frames, fps, _pos_at, fwd, right, spray=bool(re.search(r"rain|wet|storm", loc["weather"] or "")))
            if stunt:
                verb, way = stunt
        dest = ""
        for pr in props:
            if _inside(c["end"], pr):
                dest = ("into the building through the doorway" if pr["kind"] == "building" and pr["door"]
                        else f"into {pr['word'].replace('a ', 'the ', 1)}")
                break
        if not dest:
            near = sorted(props, key=lambda pr: G.length(G.sub(pr["position"], c["end"])))
            if near and G.length(G.sub(near[0]["position"], c["end"])) < 2.5:
                dest = "toward " + near[0]["word"].replace("a ", "the ", 1).replace("an ", "the ", 1)
        startp = _project_body(c["start"], c["height"], cam0)
        endp = _project_body(c["end"], c["height"], cam1)
        inside = bool(dest.startswith("into"))
        noun = _ride_noun(c["noun"], host) if host is not None and not timed else c["noun"]
        out.append({**c, "noun": noun, "verb": verb, "verb_pl": verb_pl, "way": way, "dest": dest, "inside_at_end": inside,
                    "end_visible": bool(endp and endp["visible"]) and not inside,
                    "end_where": screen_words(endp["sx"]) if endp else "", "sx0": startp["sx"] if startp else 0.0})
    return sorted(out, key=lambda m: m["sx0"])


def motion_facts(scene: dict) -> dict:
    cam0, cam1, _ = camera_at_ends(scene)
    frames, fps = frame_range(scene)
    end = frame_facts(scene, cam1, frames - 1)
    return {"move": camera_move(scene), "marks": actor_marks(scene), "end": end, "frames": frames, "fps": fps,
            "end_size": end["size"]}
