"""Validate and repair a stage scene: schema and types, metres, on the floor, inside the set, no overlaps,
cameras out of the walls. Never raises on bad input; returns (scene, notes) where notes list each repair.
"""
from __future__ import annotations

import json
import math

from . import catalog as C
from . import space as S

DEFAULT_CAMERA = {"position": [-7.0, 1.7, -14.0], "target": [0, 1.3, -4.0], "focal_mm": 35}


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _vec(v, default=(0.0, 0.0, 0.0)):
    if isinstance(v, dict):
        v = [v.get("x"), v.get("y"), v.get("z")]
    if not isinstance(v, (list, tuple)):
        return list(default)
    out = [_num(x, d) for x, d in zip(list(v) + [None] * 3, default)][:3]
    return out


def _metres(p: list[float], notes: list[str], what: str, limit: float = 100) -> list[float]:
    """Centimetres slip in from LLMs ("x": 350): anything beyond 100 m on the floor is read as cm."""
    if max(abs(p[0]), abs(p[2])) > limit:
        notes.append(f"{what}: position {p} looked like centimetres; divided by 100")
        return [v / 100 for v in p]
    return p


def _cam(c, notes, what, limit: float = 100) -> dict:
    c = c if isinstance(c, dict) else {}
    pos = _metres(_vec(c.get("position"), DEFAULT_CAMERA["position"]), notes, what, limit)
    tgt = _metres(_vec(c.get("target"), DEFAULT_CAMERA["target"]), notes, what, limit)
    if math.dist(pos, tgt) < 0.05:
        tgt = [pos[0], pos[1], pos[2] + 3]
        notes.append(f"{what}: target was on the camera; looking +Z instead")
    f = _num(c.get("focal_mm"), 35)
    if not 8 <= f <= 400:
        notes.append(f"{what}: focal {f} mm clamped")
        f = min(max(f, 8), 400)
    return {"position": [round(v, 3) for v in pos], "target": [round(v, 3) for v in tgt], "focal_mm": round(f, 1)}


def validate_scene(scene, place: bool = True) -> tuple[dict, list[str]]:
    """place=False keeps measured layouts as they are (Video → Stage): no bounds/overlap repair, no camera clamp."""
    notes: list[str] = []
    if isinstance(scene, str):
        try:
            scene = json.loads(scene)
        except json.JSONDecodeError:
            scene = {}
    s = json.loads(json.dumps(scene if isinstance(scene, dict) else {}))
    s["version"] = 2
    shot = s.get("shot") if isinstance(s.get("shot"), dict) else {}
    frames = int(_num(shot.get("frames"), 97)) or 97
    s["shot"] = {"frames": max(9, min(frames, 1000)), "fps": _num(shot.get("fps"), 24) or 24}
    last = s["shot"]["frames"] - 1

    env = s.get("environment") if isinstance(s.get("environment"), dict) else {}
    set_name = env.get("set") if env.get("set") in C.SETS else None
    if set_name is None:
        notes.append(f"unknown set {env.get('set')!r}; using empty") if env.get("set") else None
        set_name = "empty" if env.get("set") else "plaza"
    weather = env.get("weather") if env.get("weather") in C.WEATHER else "none"
    s["environment"] = {"set": set_name, "weather": weather, "density": min(max(_num(env.get("density"), 0.5), 0), 1),
                        "water_level": min(max(_num(env.get("water_level"), 2.5), 0.3), 3.8)}

    L = s.get("lighting") if isinstance(s.get("lighting"), dict) else {}
    lighting = {"mode": L.get("mode") if L.get("mode") in ("time", "manual") else "manual",
                "hour": min(max(_num(L.get("hour"), 12.5), 0), 24), "day_of_year": _num(L.get("day_of_year"), 300),
                "latitude": _num(L.get("latitude"), 34.05), "north_deg": _num(L.get("north_deg"), 0),
                "overcast": bool(L.get("overcast")), "preset": L.get("preset") if L.get("preset") in C.TIME_PRESETS else None,
                "lights": []}
    seen_l = set()
    for i, lt in enumerate(L.get("lights") or []):
        if not isinstance(lt, dict):
            continue
        t = lt.get("type") if lt.get("type") in C.LIGHT_TYPES else "key"
        spec = C.LIGHT_TYPES[t]
        lid = str(lt.get("id") or f"light_{i + 1}")
        while lid in seen_l:
            lid += "_b"
        seen_l.add(lid)
        lighting["lights"].append({
            "id": lid, "type": t, "name": str(lt.get("name") or spec["label"]),
            "position": _vec(lt.get("position"), (0, spec["height"], -2)), "target": _vec(lt.get("target"), (0, 1.2, 0)),
            "kelvin": min(max(_num(lt.get("kelvin"), spec["kelvin"]), 1000), 40000),
            "intensity": min(max(_num(lt.get("intensity"), spec["intensity"]), 0), 50),
            "softness": min(max(_num(lt.get("softness"), spec["softness"]), 0), 1),
            "angle": min(max(_num(lt.get("angle"), spec["angle"]), 1), 180)})
    s["lighting"] = lighting
    if lighting["mode"] == "time":
        s["sun"] = C.sun_for(lighting)
    else:
        sun = s.get("sun") if isinstance(s.get("sun"), dict) else {}
        s["sun"] = {"azimuth_deg": _num(sun.get("azimuth_deg"), 235), "elevation_deg": _num(sun.get("elevation_deg"), 18)}

    # ---- actors / objects
    actors, ids = [], set()
    for i, a in enumerate(s.get("actors") or []):
        if not isinstance(a, dict):
            continue
        kind = a.get("kind")
        if kind != "custom" and kind not in C.LIBRARY:
            k2 = C.resolve_kind(str(kind or a.get("name") or ""))
            if k2:
                kind = k2
            else:
                name = str(kind or a.get("name") or "object")
                notes.append(f"'{name}' is not in the library; drawn as a placeholder to design")
                a["recipe"], a["design"], kind = C.placeholder_recipe(name), name, "custom"
        if kind == "custom" and not isinstance(a.get("recipe"), dict):
            a["recipe"] = C.placeholder_recipe(str(a.get("name") or "object"))
            a.setdefault("design", str(a.get("name") or "object"))
        aid = str(a.get("id") or f"{kind}_{i + 1}")
        while aid in ids:
            aid += "_b"
        ids.add(aid)
        default_h = C.LIBRARY[kind]["height"] if kind in C.LIBRARY else (a["recipe"].get("size_m") or [1, 1, 1])[1]
        h = _num(a.get("height_m"), default_h)
        if not 0.05 <= h <= (30 if place else 500):
            notes.append(f"{aid}: height {h} m out of range; reset to {default_h}")
            h = default_h
        out = {**a, "id": aid, "name": str(a.get("name") or (C.LIBRARY[kind]["label"] if kind in C.LIBRARY else aid)),
               "kind": kind, "height_m": round(h, 3), "rotation_deg": round(((_num(a.get("rotation_deg")) + 180) % 360) - 180, 1)}
        keys = a.get("keys") if isinstance(a.get("keys"), list) and a.get("keys") else None
        if keys is None:
            keys = [{"frame": 0, "position": a.get("position")}]
            if a.get("position_end") is not None:
                keys.append({"frame": last, "position": a.get("position_end")})
        clean = {}
        for k in keys:
            if not isinstance(k, dict):
                continue
            f = int(min(max(_num(k.get("frame")), 0), last))
            p = _metres(_vec(k.get("position")), notes, aid, 100 if place else 1e5)
            if abs(p[1]) > 1e-6:
                p[1] = 0.0  # the stage stands everything on the floor
            clean[f] = p
        if not clean:
            clean[0] = _metres(_vec(a.get("position")), notes, aid, 100 if place else 1e5)
            clean[0][1] = 0.0
        out["keys"] = [{"frame": f, "position": [round(v, 3) for v in clean[f]]} for f in sorted(clean)]
        out["position"] = list(out["keys"][0]["position"])
        out.pop("position_end", None)
        actors.append(out)

    # Riders (stage.mount): the host must exist; the rider rides along and takes no floor space of its own.
    by_id = {a["id"]: a for a in actors}
    for a in actors:
        h = by_id.get(a.get("mount_id"))
        if a.get("mount_id") is None:
            a.pop("mount_id", None)
            if a.get("pose") is None:
                a.pop("pose", None)
            continue
        if h is None or h is a or h.get("mount_id"):
            notes.append(f"{a['id']}: mount '{a.get('mount_id')}' is missing; standing instead")
            a.pop("mount_id", None)
            a.pop("pose", None)
            continue
        a["pose"] = a.get("pose") or C.MOUNTS.get(h["kind"], "sit")
    riders = {a["id"] for a in actors if a.get("mount_id")}

    # Inside the set and not overlapping: people keep their marks first, then movers, then dressing.
    order = sorted(range(len(actors)), key=lambda i: (actors[i]["kind"] not in C.PEOPLE, len(actors[i]["keys"]) == 1, i))
    placed: list[dict] = []
    for i in order if place else []:
        a = actors[i]
        if a["id"] in riders:
            continue
        for k in a["keys"][1:]:
            fp = S.footprint(a, k["position"])
            if not S.in_bounds(fp, set_name):
                cx, cz = S.clamp_into(fp, set_name)
                notes.append(f"{a['id']}: frame {k['frame']} mark moved inside the set")
                k["position"] = [round(cx, 3), 0.0, round(cz, 3)]
        p = a["position"]
        if not S.is_free(a, p, set_name, placed):
            q = S.free_spot(a, [p[0], p[2]], set_name, placed)
            if math.dist(q, p) > 0.01:
                notes.append(f"{a['id']}: moved {math.dist(q, p):.2f} m to a free spot inside the set")
                a["keys"][0]["position"] = q
                a["position"] = list(q)
        placed.append(a)
    for a in actors:  # the rider's own marks mirror the host's (the stage ignores them while mounted)
        if a["id"] in riders:
            h = by_id[a["mount_id"]]
            a["keys"] = [{"frame": k["frame"], "position": list(k["position"])} for k in h["keys"]]
            a["position"] = list(h["position"])
    s["actors"] = actors

    if not isinstance(s.get("props"), list):
        s["props"] = []
    if set_name == "plaza" and not s["props"]:
        s["props"] = [dict(p) for p in C.PLAZA_PROPS]

    # ---- shots / cameras
    shots, sids = [], set()
    raw_shots = s.get("shots") if isinstance(s.get("shots"), list) else []
    if not raw_shots:
        keys = s.get("camera_keys") or [{"frame": 0, **(s.get("camera") or DEFAULT_CAMERA)}]
        raw_shots = [{"id": "shot_1", "name": "Master", "setup": "master", "camera_keys": keys}]
    for i, sh in enumerate(raw_shots):
        if not isinstance(sh, dict):
            continue
        sid = str(sh.get("id") or f"shot_{i + 1}")
        while sid in sids:
            sid += "_b"
        sids.add(sid)
        ck = {}
        for k in sh.get("camera_keys") or [{"frame": 0, **DEFAULT_CAMERA}]:
            if not isinstance(k, dict):
                continue
            c = _cam(k, notes, sid, 100 if place else 1e5)
            c2, changed = S.clamp_camera(c, set_name) if place else (c, False)
            if changed:
                notes.append(f"{sid}: camera moved out of the set walls")
            ck[int(min(max(_num(k.get("frame")), 0), last))] = c2
        if not ck:
            ck[0] = dict(DEFAULT_CAMERA)
        setup = sh.get("setup") if sh.get("setup") in C.SETUPS else "master"
        shots.append({**sh, "id": sid, "name": str(sh.get("name") or C.SETUPS[setup]), "setup": setup,
                      "camera_keys": [{"frame": f, **ck[f]} for f in sorted(ck)]})
    s["shots"] = shots
    if s.get("active_shot") not in sids:
        s["active_shot"] = shots[0]["id"]
    active = next(x for x in shots if x["id"] == s["active_shot"])
    s["camera_keys"] = active["camera_keys"]
    first = shots[0]["camera_keys"]
    s["camera"] = {k: first[0][k] for k in ("position", "target", "focal_mm")}
    s["camera_end"] = {k: first[-1][k] for k in ("position", "target", "focal_mm")}
    return s, notes


def check_scene(scene: dict) -> list[str]:
    """Problems that remain (used by tests): empty list = valid, on the floor, inside, no overlaps."""
    errs = []
    set_name = scene["environment"]["set"]
    placed = []
    ids = {a["id"] for a in scene["actors"]}
    for a in scene["actors"]:
        if a["kind"] != "custom" and a["kind"] not in C.LIBRARY:
            errs.append(f"{a['id']}: bad kind")
        if a.get("mount_id"):
            if a["mount_id"] not in ids:
                errs.append(f"{a['id']}: mounted on a missing object")
            continue
        for k in a["keys"]:
            if k["position"][1] != 0:
                errs.append(f"{a['id']}: off the floor")
            if not S.in_bounds(S.footprint(a, k["position"]), set_name, margin=0.06):
                errs.append(f"{a['id']}: outside the set at frame {k['frame']}")
        if not S.is_free(a, a["position"], set_name, placed):
            errs.append(f"{a['id']}: overlaps another object or the set")
        placed.append(a)
    for sh in scene["shots"]:
        for k in sh["camera_keys"]:
            if S.clamp_camera(k, set_name)[1]:
                errs.append(f"{sh['id']}: camera inside a wall")
    return errs
