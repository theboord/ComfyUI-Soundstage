"""Plan -> a complete stage scene (the format of web/stage/stage.mjs DEFAULT_SCENE plus shots[]).

Placement is rules: each blocking pattern puts the cast on marks around the set's stage point, furniture
goes where the blocking needs it (the table between the diner couple, the couch behind the friends),
everything else is dressed into free floor behind and beside the action, never in the corridor between
the master camera and the actors.
"""
from __future__ import annotations

import math
import re

from . import catalog as C
from . import cameras as CAM
from . import space as S
from .validate import validate_scene

FRAMES = 97
WALL_PROPS = ("counter", "bar", "bookshelf", "filing cabinet", "jukebox", "fireplace", "coat rack", "tv", "television")
BUILDINGS = ("diner", "building", "shop", "storefront", "gas station", "barn", "church", "motel", "saloon", "house")
FURNITURE = ("table", "desk", "couch", "sofa", "booth", "coffee table", "chair", "stool", "armchair")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:24] or "object"


def make_object(name: str, ids: set, kind: str | None = None, label: str | None = None) -> dict:
    """A stage actor entry for a library kind or a to-be-designed object (placeholder box until designed)."""
    if not kind:
        low = name.strip().lower()
        designed = any(k in low for k in C.DESIGN_SIZES if " " in k or k == low) and low not in C.SYNONYMS
        kind = None if designed and low not in C.LIBRARY else C.resolve_kind(name)
    base = slug(label or name)
    oid, n = base, 2
    while oid in ids:
        oid, n = f"{base}_{n}", n + 1
    ids.add(oid)
    if kind and kind in C.LIBRARY:
        spec = C.LIBRARY[kind]
        nice = label or (name.strip().title() if name.strip().lower() not in (kind, spec["label"].lower()) else spec["label"])
        return {"id": oid, "name": nice, "kind": kind, "position": [0, 0, 0], "keys": [], "height_m": spec["height"],
                "rotation_deg": 0}
    recipe = C.placeholder_recipe(name)
    return {"id": oid, "name": label or name.strip().title(), "kind": "custom", "recipe": recipe, "design": name.strip(),
            "position": [0, 0, 0], "keys": [], "height_m": recipe["size_m"][1], "rotation_deg": 0}


def _put(obj: dict, pos, rot=None, end=None):
    obj["position"] = [round(float(pos[0]), 2), 0.0, round(float(pos[2] if len(pos) == 3 else pos[1]), 2)]
    if rot is not None:
        obj["rotation_deg"] = round(float(rot), 1)
    obj["keys"] = [{"frame": 0, "position": list(obj["position"])}]
    if end is not None:
        e = [round(float(end[0]), 2), 0.0, round(float(end[2] if len(end) == 3 else end[1]), 2)]
        if e != obj["position"]:
            obj["keys"].append({"frame": FRAMES - 1, "position": e})
    return obj


def _span(set_name: str, want: float, axis: int = 0) -> float:
    x0, x1, z0, z1 = C.SETS[set_name]["bounds"]
    room = (x1 - x0) if axis == 0 else (z1 - z0)
    return min(want, room - 2.0)


def block_cast(plan: dict, ids: set, notes: list[str]) -> tuple[list[dict], list[dict]]:
    """Cast on their marks. Returns (cast objects, furniture objects placed with them)."""
    set_name = plan["set"]
    sx, sz = C.SETS[set_name]["stage"]
    people, animals, passers = [], [], []
    for c in plan["cast"]:
        o = make_object(c["kind"], ids, kind=c["kind"], label=c.get("name") or c["kind"].title())
        o["role"] = c.get("role", "")
        if c.get("mount") in C.MOUNTS and c["kind"] in C.PEOPLE:
            o["_mount"] = c["mount"]
        if c.get("action") == "pass":
            passers.append(o)
        else:
            (people if c["kind"] in C.PEOPLE else animals).append(o)
    props = [p for p in plan["props"]]
    furn: list[dict] = []

    def take(*names):
        for nm in names:
            for p in props:
                if p == nm or p.endswith(" " + nm) or C.resolve_kind(p) == C.resolve_kind(nm) == "table" and nm in ("table", "desk"):
                    props.remove(p)
                    return p
        return None

    b = plan["blocking"]
    n = len(people)
    if b == "alone" and people:
        a = people[0]
        desk = take("desk", "table")
        if desk:
            d = make_object(desk, ids)
            _put(d, (sx, 0, sz), 0)
            _put(a, (sx, 0, sz + 0.85), 180)
            furn.append(d)
            ch = take("chair")
            if ch:
                furn.append(_put(make_object(ch, ids), (sx, 0, sz + 1.45), 180))
        else:
            _put(a, (sx, 0, sz), 180)
    elif b == "face_off" and n >= 2:
        d = _span(set_name, 12.0) / 2
        _put(people[0], (sx - d, 0, sz), 90)
        _put(people[1], (sx + d, 0, sz), -90)
    elif b == "across_table" and n >= 2:
        t = take("table", "booth", "desk")
        if t:
            tb = make_object(t, ids)
            _put(tb, (sx, 0, sz), 90)  # long side along Z, so the two sit across its width
            furn.append(tb)
        _put(people[0], (sx - 0.75, 0, sz), 90)
        _put(people[1], (sx + 0.75, 0, sz), -90)
        for side in (-1, 1):
            ch = take("chair", "stool")
            if ch:
                furn.append(_put(make_object(ch, ids), (sx + side * 1.35, 0, sz), 90 * side * -1))
    elif b == "chase" and n >= 2:
        x0, x1, _, _ = C.SETS[set_name]["bounds"]
        run = min(14.0, (x1 - x0) - 3)
        _put(people[0], (sx - run / 2 + 3.5, 0, sz), 90, end=(sx + run / 2, 0, sz + 0.6))
        _put(people[1], (sx - run / 2, 0, sz), 90, end=(sx + run / 2 - 3.5, 0, sz + 0.6))
    elif b == "rescue" and n >= 2:
        _put(people[1], (sx + 1.4, 0, sz), -90)
        _put(people[0], (sx - 4.0, 0, sz - 1.0), 90, end=(sx + 0.65, 0, sz))
    elif b == "walk_and_talk" and n >= 2:
        z0 = min(sz + 6, C.SETS[set_name]["bounds"][3] - 1)
        for i, a in enumerate(people[:2]):
            x = sx + (i - 0.5) * 0.9
            _put(a, (x, 0, z0), 180, end=(x, 0, sz - 1.5))
    elif b == "side_by_side" and n >= 2:
        for i, a in enumerate(people[:2]):
            _put(a, (sx + (i - 0.5) * 1.0, 0, sz), 180)
    if b == "group" or (n >= 3 and b in ("across_table", "face_off", "side_by_side")):
        couch = take("couch", "sofa", "bench")
        row = people if b == "group" else people[2:]
        if couch and b == "group":
            co = make_object(couch, ids)
            _put(co, (sx, 0, sz + 1.6), 180)
            furn.append(co)
            gap = 0.75
            for i, a in enumerate(people):
                _put(a, (sx + (i - (n - 1) / 2) * gap, 0, sz + 0.8), 180)
            ct = take("coffee table", "table")
            if ct:
                furn.append(_put(make_object(ct, ids), (sx, 0, sz - 0.1), 0))
            row = []
        k = len(row)
        for i, a in enumerate(row):
            ang = math.radians(-60 + 120 * (i + 0.5) / max(k, 1))
            p = (sx + 1.6 * math.sin(ang), 0, sz + 1.6 * math.cos(ang))
            _put(a, p, S.heading_to(p, (sx, 0, sz)))
    for a in people:
        if not a["keys"]:  # anyone the pattern did not place
            _put(a, (sx, 0, sz), 180)
    # Animals stay near the first person.
    for i, a in enumerate(animals):
        ref = people[0]["position"] if people else [sx, 0, sz]
        _put(a, (ref[0] + 1.6 + i * 1.5, 0, ref[2] + 1.2), 180 if a["kind"] != "horse" else 90)
    # Whoever passes by crosses the frame upstage of the others, screen-left (+X) to screen-right (-X).
    x0, x1, z0, z1 = C.SETS[set_name]["bounds"]
    if people:
        gx = sum(a["position"][0] for a in people) / len(people)
        gz = sum(a["position"][2] for a in people) / len(people)
    else:
        gx, gz = sx, sz - 3.5
    for i, a in enumerate(passers):
        reach = min(9.0, (x1 - x0) / 2 - 1.4)
        z = max(gz - 3.0 - i * 2.0, z0 + 2.0)  # downstage: they ride past between the camera and the others
        start, end = (min(gx + reach, x1 - 1.4), 0, z), (max(gx - reach, x0 + 1.4), 0, z)
        _put(a, start, -90, end=end)
    # Riders sit on their mount (stage.mount: rider.mount_id + rider.pose); the host carries the marks.
    hosts = []
    for a in people + passers:
        kind = a.pop("_mount", None)
        if not kind:
            continue
        h = make_object(kind, ids, kind=kind)
        h["keys"] = [dict(k, position=list(k["position"])) for k in a["keys"]]
        h["position"] = list(a["position"])
        h["rotation_deg"] = a.get("rotation_deg", 0)
        a["mount_id"] = h["id"]
        a["pose"] = C.MOUNTS[kind]
        hosts.append(h)
    plan["props"] = props
    return people + passers + hosts + animals, furn


def dress(plan: dict, placed: list[dict], ids: set, master_cam: dict | None) -> list[dict]:
    """Place the remaining props in free floor around the action, out of the master camera's sight line."""
    set_name = plan["set"]
    sx, sz = C.SETS[set_name]["stage"]
    cast = [a for a in placed if a["kind"] in C.PEOPLE and len(a.get("keys") or []) <= 1 and not a.get("mount_id")]
    cast = cast or [a for a in placed if a["kind"] in C.PEOPLE]
    cx = sum(a["position"][0] for a in cast) / len(cast) if cast else sx
    cz = sum(a["position"][2] for a in cast) / len(cast) if cast else sz
    cam = master_cam["position"] if master_cam else [cx, 1.7, cz - 8]

    paths = [a["keys"] for a in placed if len(a.get("keys") or []) > 1 and not a.get("mount_id")]

    def on_path(x, z):
        for keys in paths:
            for k0, k1 in zip(keys, keys[1:]):
                ax, az = k0["position"][0], k0["position"][2]
                bx, bz = k1["position"][0], k1["position"][2]
                L2 = (bx - ax) ** 2 + (bz - az) ** 2 or 1e-9
                u = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2))
                if math.hypot(x - (ax + u * (bx - ax)), z - (az + u * (bz - az))) < 2.2:
                    return True
        return False

    def corridor(x, z):
        if on_path(x, z):
            return True
        # Inside the triangle-ish wedge from the camera to the cast (plus a margin)?
        vx, vz = cx - cam[0], cz - cam[2]
        L = math.hypot(vx, vz) or 1.0
        u = ((x - cam[0]) * vx + (z - cam[2]) * vz) / (L * L)
        if u < 0 or u > 1.05:
            return False
        px, pz = cam[0] + u * vx, cam[2] + u * vz
        return math.hypot(x - px, z - pz) < 1.0 + 2.2 * u

    out = []
    x0, x1, z0, z1 = C.SETS[set_name]["bounds"]
    for i, name in enumerate(plan["props"]):
        if set_name in ("street_night", "plaza") and any(w in name.lower() for w in BUILDINGS):
            continue  # these sets already have their buildings
        o = make_object(name, ids)
        lname = name.lower()
        w = S.size_of(o)
        by = re.search(rf"\b(?:by|next to|beside|near|leaning on|against|around)\s+(?:a|an|the|their|his|her)\s+(?:[a-z]+\s+)?{re.escape(lname.split()[-1])}\b",
                       plan.get("text", "").lower()) if plan.get("text") else None
        if by and cast:
            # "two cops standing by a police car": right behind the group, side-on to the camera.
            rot = 90 if o["kind"] in ("car", "truck", "motorcycle", "bicycle", "bench", "wall") else 0
            o["rotation_deg"] = rot
            want = (cx, cz + 0.55 + S.footprint(o)[3])
        elif set_name == "street_night" and o["kind"] in ("car", "truck", "motorcycle", "bicycle"):
            side = -1 if i % 2 else 1
            want, rot = (side * (5.3 - w[0] / 2), cz + 4 + 3 * i), 0
        elif o["kind"] == "horse":
            want, rot = (cx + 3.0, cz + 2.5), 90
        elif C.SETS[set_name]["interior"] and any(k in lname for k in WALL_PROPS):
            # Back wall first, then the side walls.
            spots = [((-2.2 + 2.2 * (i % 3)), z1 - w[2] / 2, 180), (x1 - w[2] / 2, cz + 1.5, -90), (x0 + w[2] / 2, cz + 1.5, 90)]
            sxx, szz, rot = spots[i % 3]
            if rot != 180:
                o["rotation_deg"] = rot
            want = (sxx, szz)
        elif any(k in lname for k in ("lamp", "desk lamp")) and "street" not in lname and o["kind"] == "custom":
            near = next((p for p in placed if p.get("kind") in ("table",) or "desk" in p.get("name", "").lower()), None)
            want = (near["position"][0] + 0.45, near["position"][2] - 0.1) if near else (cx + 1.2, cz + 1.0)
            rot = 0
        elif any(k in lname for k in ("parapet", "ledge")):
            want, rot = (cx, min(z1 - 0.3, cz + 6)), 0
        else:
            ring = [(0, 3.2), (35, 3.6), (-35, 3.6), (70, 4.2), (-70, 4.2), (20, 6.0), (-20, 6.0), (100, 5.0), (-100, 5.0)]
            ang, r = ring[i % len(ring)]
            r *= 1.0 + max(w[0], w[2]) / 6
            want = (cx + r * math.sin(math.radians(ang)), cz + r * math.cos(math.radians(ang)))
            rot = S.heading_to((want[0], 0, want[1]), (cx, 0, cz)) if o["kind"] in ("chair", "bench", "custom") else 0
        if rot:
            o["rotation_deg"] = round(rot, 1)
        pos = S.free_spot(o, want, set_name, placed + out, avoid=corridor)
        if not S.is_free(o, pos, set_name, placed + out):
            continue  # nowhere it fits (a 12 m diner on the street set): leave it out rather than overlap
        _put(o, pos)
        out.append(o)
    return out


def lights_for(plan: dict, scene: dict, master_cam: dict) -> list[dict]:
    """Film lights from the plan, placed like stage.addLight() does (relative to the master camera)."""
    cast = CAM.people(scene)
    subj = cast[0] if cast else None
    sp = subj["position"] if subj else [master_cam["target"][0], 0, master_cam["target"][2]]
    sh = float(subj.get("height_m", 1.75)) * 0.75 if subj else 1.3
    subj_pt = [round(sp[0], 2), round(sh, 2), round(sp[2], 2)]
    cam = master_cam["position"]
    vx, vz = subj_pt[0] - cam[0], subj_pt[2] - cam[2]
    L = math.hypot(vx, vz) or 1
    vx, vz = vx / L, vz / L
    rx, rz = vz, -vx
    offs = {"key": (-2.4, -2.4), "fill": (2.6, -2.0), "rim": (1.2, 3.0), "practical": (-1.5, 0.8), "spot": (0, -1.0),
            "neon": (2.0, 1.5)}
    lights = []
    night = plan["time"] in ("night", "blue_hour")
    for i, t in enumerate(plan.get("lights", [])):
        spec = C.LIGHT_TYPES[t]
        a, b = offs[t]
        pos = [round(subj_pt[0] + rx * a + vx * b, 2), spec["height"], round(subj_pt[2] + rz * a + vz * b, 2)]
        kelvin = spec["kelvin"]
        if t == "key" and night:
            kelvin = 6500  # moonlight through the window / streetlight
            win = S.anchor_points(plan["set"], "window")
            if win:
                pos = [win[0][0], 2.0, win[0][1] - 0.3]
        if t == "practical":
            # The lamp on the desk/table nearest the subject (props stand on the floor, so the lamp is a light).
            desk = next((a for a in scene["actors"] if a.get("kind") == "table" or "desk" in a.get("name", "").lower()), None)
            if desk:
                pos = [round(desk["position"][0] + 0.45, 2), 1.05, round(desk["position"][2] - 0.1, 2)]
        if scene["environment"]["set"] in S.CAMERA_AREA:
            (x0, x1, z0, z1), (y0, y1) = S.CAMERA_AREA[scene["environment"]["set"]]
            pos = [min(max(pos[0], x0 + 0.1), x1 - 0.1), min(pos[1], y1 - 0.1), min(max(pos[2], z0), z1 - 0.1)]
        lights.append({"id": f"light_{t}_{i + 1}", "type": t, "name": f"{spec['label']} {i + 1}", "position": pos,
                       "target": subj_pt, "kelvin": kelvin, "intensity": spec["intensity"], "softness": spec["softness"],
                       "angle": spec["angle"]})
    return lights


def lighting_for(plan: dict) -> dict:
    L = {"mode": "time", "hour": C.preset_hour(plan["time"]), "day_of_year": 300, "latitude": 34.05, "north_deg": 0,
         "overcast": bool(C.TIME_PRESETS[plan["time"]].get("overcast")), "preset": plan["time"], "lights": []}
    return L


def build_scene(plan: dict, text: str = "") -> tuple[dict, list[str]]:
    """Plan -> (scene, notes). Always returns a scene the stage can load."""
    notes: list[str] = []
    plan = dict(plan, props=list(plan.get("props", [])))
    ids: set = set()
    cast, furn = block_cast(plan, ids, notes)
    set_name = plan["set"]
    env = {"set": set_name, "weather": plan.get("weather", "none"),
           "density": 0.6 if plan.get("weather") in ("rain", "snow") else 0.5, "water_level": 2.5}
    lighting = lighting_for(plan)
    scene = {"version": 2, "shot": {"frames": FRAMES, "fps": 24}, "environment": env, "lighting": lighting,
             "sun": C.sun_for(lighting), "actors": cast + furn,
             "props": [dict(p) for p in C.PLAZA_PROPS] if set_name == "plaza" else []}
    # Repair the cast/furniture first (overlaps, bounds) so the advisor frames the final marks.
    scene, vnotes = validate_scene(scene)
    notes += [n for n in vnotes if not n.startswith("shot_1:")]  # the placeholder camera; coverage replaces it
    shots, cnotes = CAM.coverage(scene, text or plan.get("genre", ""), plan.get("shots", 3), plan.get("camera"))
    notes += cnotes
    master = {k: shots[0]["camera_keys"][0][k] for k in ("position", "target", "focal_mm")}
    scene["actors"] += dress(plan, scene["actors"], ids, master)
    scene["lighting"]["lights"] = lights_for(plan, scene, master)
    scene["shots"] = shots
    scene["active_shot"] = shots[0]["id"]
    scene["camera_keys"] = shots[0]["camera_keys"]
    scene["camera"] = dict(master)
    last = shots[0]["camera_keys"][-1]
    scene["camera_end"] = {k: last[k] for k in ("position", "target", "focal_mm")}
    scene["agent"] = {"prompt": text, "plan": {k: v for k, v in plan.items() if k not in ("props", "text")}}
    scene, vnotes = validate_scene(scene)
    notes += vnotes
    return scene, notes


def pending_designs(scene: dict) -> list[dict]:
    """Objects still drawn as placeholder boxes: the client asks the object designer for each."""
    return [{"id": a["id"], "name": a["design"]} for a in scene.get("actors", [])
            if a.get("kind") == "custom" and a.get("design") and (a.get("recipe") or {}).get("placeholder")]
