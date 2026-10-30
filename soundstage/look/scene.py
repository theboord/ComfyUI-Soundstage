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
    "beach": ("EXT", "a beach by the ocean"), "water_tank": ("EXT", "a water tank"), "empty": ("EXT", ""),
}
WEATHER_WORDS = {
    "rain": "rain falling", "snow": "snow falling", "fog": "fog and haze in the air", "smoke": "drifting smoke",
    "dust": "dust hanging in the air", "sparks": "fire sparks drifting through the air",
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


def camera_at_ends(scene: dict) -> tuple[dict, dict, list[dict]]:
    """First camera, last camera, and the path samples (the per-frame camera_track when present)."""
    track = scene.get("camera_track") or []
    if len(track) >= 2:
        path = [{"frame": int(t.get("frame", i)), "position": _v(t.get("position")), "target": _v(t.get("target")),
                 "focal_mm": float(t.get("focal_mm") or 35)} for i, t in enumerate(track)]
        return path[0], path[-1], path
    keys = camera_keys(scene)
    return keys[0], keys[-1], keys


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


def _facing_words(direction, cam, plural: bool = False, animal: bool = False) -> str:
    fwd, right, _ = G.basis(cam["position"], cam["target"])
    d = G.flat(direction)
    if G.length(d) < 1e-6:
        return ""
    a = G.dot(d, G.flat(fwd))
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
    for p in scene.get("props") or []:
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
    return ", ".join(parts)


def _underwater(scene: dict, cam: dict) -> bool:
    env = scene.get("environment") or {}
    return env.get("set") == "water_tank" and cam["position"][1] < float(env.get("water_level", 2.5))


# ---- facts ----------------------------------------------------------------------------------------


def cast(scene: dict) -> list[dict]:
    frames, _ = frame_range(scene)
    out = []
    for a in scene.get("actors") or []:
        noun, rig, h = classify(a)
        if rig == "static":
            continue
        out.append({"id": a.get("id"), "noun": noun, "rig": rig, "height": h, "actor": a,
                    "start": _pos_at(a, 0, frames - 1), "end": _pos_at(a, frames - 1, frames - 1),
                    "heading": _heading(a, frames)})
    return out


def frame_facts(scene: dict, cam: dict, frame: int) -> dict:
    """Who and what is on screen through `cam` at `frame`."""
    people, others = [], []
    for c in cast(scene):
        pos = _pos_at(c["actor"], frame, frame_range(scene)[0] - 1)
        pr = _project_body(pos, c["height"], cam)
        hidden = any(q["kind"] in ("building", "house") and _inside(pos, q, margin=-0.2) for q in _props(scene))
        if not pr or not pr["visible"] or hidden:
            continue
        entry = {**c, "pos": pos, **pr, "where": screen_words(pr["sx"]),
                 "size": shot_size(pr["z"], c["height"], cam["focal_mm"])}
        (people if c["rig"] == "biped" else others).append(entry)
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
            "size": nearest["size"] if nearest else "WS"}


def groups(entries: list[dict], cam: dict) -> list[dict]:
    """Cluster figures standing together: [{nouns, plural, where, far, facing}] left to right."""
    entries = sorted(entries, key=lambda e: e["sx"])
    clusters: list[list[dict]] = []
    for e in entries:
        near = 1.8 if e.get("rig") == "biped" else max(1.8, 1.4 * (e.get("height") or 1.0) + 0.8)  # horses, cars sit wider apart
        if clusters and G.length(G.sub(e["pos"], clusters[-1][-1]["pos"])) < near \
                and abs(e["sx"] - clusters[-1][-1]["sx"]) < 0.5:
            clusters[-1].append(e)
        else:
            clusters.append([e])
    out = []
    for g in clusters:
        sx = sum(e["sx"] for e in g) / len(g)
        h = min(e["screen_h"] for e in g)
        out.append({"nouns": _group_nouns([e["noun"] for e in g]), "plural": len(g) > 1, "where": screen_words(sx),
                    "far": h < 0.18, "distance": _distance_words(h, all(e.get("rig") == "biped" for e in g)),
                    "facing": _facing_words(g[0]["heading"], cam, len(g) > 1,
                                            animal=g[0].get("rig") not in (None, "biped")),
                    "moving": any(G.length(G.sub(e["end"], e["start"])) > 0.3 for e in g)})
    return out


def group_phrase(entries: list[dict], cam: dict, with_facing: bool = True) -> list[str]:
    """Still-prompt form: 'a man and a woman side by side in the centre of frame, with their backs to the camera'."""
    out = []
    for g in groups(entries, cam):
        bits = [g["nouns"] + (" side by side" if g["plural"] else "") + " " + g["where"],
                g["distance"], g["facing"] if with_facing else ""]
        out.append(", ".join(b for b in bits if b))
    return out


def blocking_sentence(entries: list[dict], cam: dict) -> str:
    """LTX form: 'A man and a woman stand side by side in the centre of frame, with their backs to the camera.'"""
    out = []
    for g in groups(entries, cam):
        verb = ("start" if g["moving"] else "stand") + " side by side" if g["plural"] else \
            ("starts" if g["moving"] else "stands")
        s = f"{g['nouns']} {verb} {g['where']}" + (", small in the distance" if g["far"] else "")
        if g["facing"]:
            s += f", {g['facing']}"
        out.append(s[:1].upper() + s[1:] + ".")
    return " ".join(out)


def vehicle_camera(scene: dict) -> dict | None:
    """Where a ride-along camera sits on its vehicle, in words for the image and video models.

    A shot with camera_follow keeps its camera keys in the vehicle's own frame (x = the vehicle's left, +z forward).
    Without this the models only see "a man drives a blue sedan" and paint that sedan in front of a POV camera.
    Returns {"still", "motion", "negative"} or None when the camera isn't in or on a vehicle.
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
    looks_back = tz < pz - 0.5
    looks_sideways = abs(tx - px) > abs(tz - pz)
    if pz > 1.6 and looks_back:
        return {"still": f"shot from the hood of the {noun}, looking back through the windshield at the people inside",
                "motion": f"The camera is mounted on the hood of the {noun}, looking back through the windshield at the people inside as it drives.",
                "negative": ""}
    if pz > 1.6 and not looks_back:
        return {"still": f"low hood-mounted camera on the front of the {noun}, looking down the road ahead",
                "motion": f"The camera is mounted on the hood of the {noun}, racing down the road ahead.",
                "negative": ""}
    if looks_back and pz > 0.45 and not looks_sideways:
        return {"lead": f"interior of a {noun}, camera on the dashboard looking back at the front seats, the driver and the front passenger facing the camera, their faces toward the lens",
                "still": f"inside the {noun}, from the dashboard looking back at the driver and the front passenger side by side, the rear window and street behind them",
                "motion": f"The camera sits on the dashboard of the {noun}, looking back at the two front seats as the street slides past the rear window.",
                "negative": "exterior view of the car, camera outside the car, empty seats, people seen from behind, backs of heads, rear view, the road ahead through the windshield"}
    if looks_back and not looks_sideways:
        return {"lead": f"interior of a {noun}, looking back from between the front seats at the back seat, the back-seat passenger facing the camera, the rear window behind him",
                "still": f"inside the {noun}, looking back between the front seats at the back seat and the person sitting there",
                "motion": f"The camera is between the front seats of the {noun}, looking back at the back seat.",
                "negative": "exterior view of the car, camera outside the car, people seen from behind, backs of heads, the road ahead through the windshield"}
    if pz < -0.5 and not looks_back:
        return {"lead": f"interior of a {noun}, from the back seat",
                "still": f"from the back seat of the {noun}, looking forward between the two front seats at the road ahead",
                "motion": f"The camera rides in the back seat of the {noun}, looking forward between the front seats at the road ahead.",
                "negative": ""}
    if looks_sideways:
        side = "driver" if tx > px else "passenger"
        return {"lead": f"interior of a {noun}, shot from inside the cabin" + (" from the passenger seat: the driver in profile at the wheel, the side window behind him" if side == "driver" else ""),
                "still": f"from inside the {noun}, in the {'passenger' if side == 'driver' else 'driver'} seat, a close side view of the {side} at the wheel"
                         if side == "driver" else f"from inside the {noun}, a close side view of the passenger",
                "motion": f"The camera rides inside the {noun}, looking across the cabin at the {side}; the street slides past the windows.",
                "negative": "exterior view of the car, camera outside the car, the car door seen from outside"}
    if not looks_back:
        return {"lead": f"interior of a {noun}, first-person view from the driver's seat: steering wheel and dashboard in the foreground, the road ahead through the windshield",
                "still": f"first-person view from the driver's seat of the {noun}, looking out through the windshield at the road ahead, the dashboard and hood in the lower frame",
                "motion": f"First-person view from the driver's seat of the {noun}: the road ahead rushes toward the camera through the windshield.",
                "negative": f"a car directly ahead, another {noun} in front of the camera, the {noun} seen from outside, exterior shot, the hood seen from the front"}
    return None


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
        jitter = [G.length(G.sub(G.mul(G.add(path[i - 1]["position"], path[i + 1]["position"]), 0.5),
                                 path[i]["position"])) for i in range(1, len(path) - 1)]
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
    return {"parts": parts, "seconds": seconds, "travel_m": travel, "speed": _speed_word(travel, seconds),
            "handheld": shake > 0.012, "static": not parts, "start": c0, "end": c1, "keys": len(camera_keys(scene))}


def actor_marks(scene: dict) -> list[dict]:
    """Each mover's walk: verb, direction in the opening frame's terms, destination."""
    frames, fps = frame_range(scene)
    seconds = frames / fps
    cam0, cam1, _ = camera_at_ends(scene)
    fwd, right, _ = G.basis(cam0["position"], cam0["target"])
    props = _props(scene)
    out = []
    for c in cast(scene):
        d = G.sub(c["end"], c["start"])
        dist = G.length((d[0], 0.0, d[2]))
        if dist < 0.3:
            continue
        v = dist / max(0.1, seconds)
        if c["rig"] == "vehicle":
            verb = "drives" if v > 2 else "rolls"
        elif c["rig"] == "quadruped":
            verb = "trots" if v < 3 else "runs"
        else:
            verb = "walks" if v < 2.6 else "walks briskly" if v < 5.5 else "runs"
        a, r = G.dot(G.flat(d), G.flat(fwd)), G.dot(G.flat(d), G.flat(right))
        if a > 0.6:
            way = "away from the camera"
        elif a < -0.6:
            way = "toward the camera"
        else:
            way = f"across frame toward screen-{'right' if r > 0 else 'left'}"
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
        out.append({**c, "verb": verb, "way": way, "dest": dest, "inside_at_end": inside,
                    "end_visible": bool(endp and endp["visible"]) and not inside,
                    "end_where": screen_words(endp["sx"]) if endp else "", "sx0": startp["sx"] if startp else 0.0})
    return sorted(out, key=lambda m: m["sx0"])


def motion_facts(scene: dict) -> dict:
    cam0, cam1, _ = camera_at_ends(scene)
    frames, fps = frame_range(scene)
    end = frame_facts(scene, cam1, frames - 1)
    return {"move": camera_move(scene), "marks": actor_marks(scene), "end": end, "frames": frames, "fps": fps,
            "end_size": end["size"]}
