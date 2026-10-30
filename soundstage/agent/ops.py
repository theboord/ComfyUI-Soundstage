"""Chat edits: command -> symbolic ops (LLM or rules) -> concrete, undoable ops -> apply_ops().

Symbolic ops are what the LLM writes (names, not coordinates):
  {"op":"move","target":"car","near":"streetlamp"}            {"op":"move","target":"woman","dir":"left","amount":2}
  {"op":"add","what":"detective","near":"window"}              {"op":"remove","target":"horse"}
  {"op":"rotate","target":"man","face":"woman"}                {"op":"rotate","target":"car","deg":90}
  {"op":"scale","target":"tree","factor":2}                    {"op":"time","preset":"night"}
  {"op":"weather","weather":"rain"}                            {"op":"set","set":"forest"}
  {"op":"light","type":"key","on":"woman"}                     {"op":"remove_light","type":"rim"}
  {"op":"shot","setup":"ots","on":"woman","over":"man"}        {"op":"camera","move":"push_in"} / {"op":"camera","focal":85}
  {"op":"mount","target":"cowboy","on":"horse"}                {"op":"dismount","target":"cowboy"}

Concrete ops are what the stage applies. Every concrete op carries "undo": the concrete op that reverts
it, so the inverse of a list is [op["undo"] for op in reversed(ops)]:
  add_object {object, index}        <-> remove_object {id}
  update_object {id, set:{...}}     <-> update_object {id, set:{old values}}   (verb: move/rotate/scale/mount)
                                        a None value removes the field (mount_id, pose when dismounting)
  set_environment {set:{...}}       <-> set_environment {set:{old}}
  set_lighting {set:{...}, sun?}    <-> set_lighting {set:{old}, sun: old}
  add_light {light}                 <-> remove_light {id}
  add_shot {shot, index}            <-> remove_shot {id}
  update_shot {id, set:{...}}       <-> update_shot {id, set:{old}}
  set_active_shot {id}              <-> set_active_shot {id: old}
"""
from __future__ import annotations

import copy
import math
import re

from ..cine import geometry as G
from . import catalog as C
from . import cameras as CAM
from . import plan as P
from . import space as S
from .build import make_object

SYMBOLIC = {"move", "add", "remove", "rotate", "scale", "time", "weather", "set", "light", "remove_light", "shot",
            "camera", "mount", "dismount"}
SHOT_WORDS = [("ots", ["over-the-shoulder", "over the shoulder", "ots", "dirty single"]),
              ("insert", ["insert", "detail shot"]), ("pov", ["pov", "point of view", "point-of-view"]),
              ("two_shot", ["two-shot", "two shot", "2-shot", "fifty-fifty", "50/50"]),
              ("single", ["close-up", "closeup", "close up", "single", "mcu", "medium close"]),
              ("wide", ["wide shot", "wide", "establishing", "master", "long shot"])]
RELATIONS = ["closer to", "next to", "close to", "near", "beside", "by", "toward", "towards", "behind", "in front of",
             "away from", "to", "at"]


# ---- apply ------------------------------------------------------------------------------------------

def _find(items, id_):
    for i, x in enumerate(items):
        if x.get("id") == id_:
            return i, x
    return -1, None


def apply_op(s: dict, op: dict) -> None:
    """Apply one concrete op in place. Unknown ops are ignored (forward compatible)."""
    kind = op.get("op")
    actors = s.setdefault("actors", [])
    if kind == "add_object":
        obj = copy.deepcopy(op["object"])
        idx = op.get("index", len(actors))
        actors.insert(max(0, min(idx, len(actors))), obj)
    elif kind == "remove_object":
        i, _ = _find(actors, op["id"])
        if i >= 0:
            actors.pop(i)
    elif kind in ("update_object", "move_object", "rotate_object", "scale_object"):
        _, a = _find(actors, op["id"])
        if a is not None:
            for k, v in op["set"].items():  # None removes the field (so undo of a new field leaves no trace)
                if v is None:
                    a.pop(k, None)
                else:
                    a[k] = copy.deepcopy(v)
    elif kind == "set_environment":
        s["environment"] = {**s.get("environment", {}), **op["set"]}
    elif kind == "set_lighting":
        s["lighting"] = {**s.get("lighting", {}), **copy.deepcopy(op["set"])}
        if op.get("sun"):
            s["sun"] = dict(op["sun"])
        elif s["lighting"].get("mode") == "time":
            s["sun"] = C.sun_for(s["lighting"])
    elif kind == "add_light":
        L = s.setdefault("lighting", {})
        L["lights"] = [*L.get("lights", []), copy.deepcopy(op["light"])]
    elif kind == "remove_light":
        L = s.setdefault("lighting", {})
        L["lights"] = [x for x in L.get("lights", []) if x.get("id") != op["id"]]
    elif kind == "add_shot":
        shots = s.setdefault("shots", [])
        shots.insert(max(0, min(op.get("index", len(shots)), len(shots))), copy.deepcopy(op["shot"]))
    elif kind == "remove_shot":
        s["shots"] = [x for x in s.get("shots", []) if x.get("id") != op["id"]]
        if s.get("active_shot") == op["id"] and s["shots"]:
            s["active_shot"] = s["shots"][0]["id"]
    elif kind == "update_shot":
        _, sh = _find(s.get("shots", []), op["id"])
        if sh is not None:
            sh.update(copy.deepcopy(op["set"]))
    elif kind == "set_active_shot":
        if any(x.get("id") == op["id"] for x in s.get("shots", [])):
            s["active_shot"] = op["id"]
    # Keep the flat camera fields the stage's loader reads in step with the shots.
    shots = s.get("shots") or []
    if shots:
        _, act = _find(shots, s.get("active_shot"))
        act = act or shots[0]
        s["camera_keys"] = act["camera_keys"]
        s["camera"] = {k: shots[0]["camera_keys"][0][k] for k in ("position", "target", "focal_mm")}
        s["camera_end"] = {k: shots[0]["camera_keys"][-1][k] for k in ("position", "target", "focal_mm")}


def apply_ops(scene: dict, ops: list[dict]) -> dict:
    """Pure: returns a new scene with the ops applied in order."""
    s = copy.deepcopy(scene)
    for op in ops or []:
        apply_op(s, op)
    return s


def inverse(ops: list[dict]) -> list[dict]:
    return [op["undo"] for op in reversed(ops) if op.get("undo")]


# ---- lookup -----------------------------------------------------------------------------------------

def _words(t: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (t or "").lower())


def _labels(a: dict) -> set[str]:
    out = set(_words(a.get("name", ""))) | set(_words(a.get("role", ""))) | set(_words(a.get("design", "")))
    out |= set(_words((a.get("recipe") or {}).get("name", "")))
    out.add(a.get("kind", ""))
    if a.get("kind") in C.LIBRARY:
        out |= set(_words(C.LIBRARY[a["kind"]]["label"]))
    out |= {w[:-1] for w in out if w.endswith("s")}
    return {w for w in out if w and not w.isdigit()}


ORDINALS = {"first": 0, "1st": 0, "second": 1, "2nd": 1, "other": 1, "third": 2, "3rd": 2, "last": -1}


def find_object(scene: dict, text: str, exclude=()) -> dict | None:
    """The actor/object a phrase refers to: exact id, then words of name/kind/role, then synonyms."""
    if not text:
        return None
    t = str(text).lower().strip()
    actors = [a for a in scene.get("actors", []) if a.get("id") not in exclude]
    for a in actors:
        if t == a.get("id") or t == str(a.get("name", "")).lower():
            return a
    ws = [w for w in _words(t) if w not in ("the", "a", "an", "his", "her", "their", "of")]
    kind = C.resolve_kind(t)
    role_kind = next((P.ROLE_WORDS[w] for w in ws if w in P.ROLE_WORDS), None)
    scored = []
    for i, a in enumerate(actors):
        lab = _labels(a)
        sc = sum(2 for w in ws if w in lab or (w.endswith("s") and w[:-1] in lab))
        if kind and a.get("kind") == kind:
            sc += 1
        if not sc and role_kind and a.get("kind") == role_kind and role_kind in C.PEOPLE:
            sc += 0.5  # "the detective" when the actor is just called "Man"
        if sc:
            scored.append((sc, i, a))
    if not scored:
        return None
    best = max(x[0] for x in scored)
    top = [x for x in scored if x[0] == best]
    ordinal = next((ORDINALS[w] for w in ws if w in ORDINALS), None)
    if ordinal is not None and len(top) > 1:
        return top[ordinal if ordinal < len(top) else -1][2]
    return top[0][2]


def find_place(scene: dict, text: str, exclude=()) -> tuple[list[float] | None, dict | None, str]:
    """A reference point for "near X": an object, else a set anchor. Returns (point [x,z], object, label)."""
    if not text:
        return None, None, ""
    obj = find_object(scene, text, exclude)
    set_name = scene["environment"]["set"]
    name, pts = S.find_anchor(set_name, text)
    if obj is not None and not (name and len(name) > 3 and name in str(text).lower() and not
                                (_labels(obj) & set(_words(text)) - {"the"})):
        return [obj["position"][0], obj["position"][2]], obj, obj.get("name", obj["id"])
    if pts:
        return list(pts[0]), None, name
    if obj is not None:
        return [obj["position"][0], obj["position"][2]], obj, obj.get("name", obj["id"])
    return None, None, ""


def _closest(pts, x, z):
    return min(pts, key=lambda p: (p[0] - x) ** 2 + (p[1] - z) ** 2)


def _active_cam(scene: dict) -> dict:
    shots = scene.get("shots") or []
    _, sh = _find(shots, scene.get("active_shot"))
    sh = sh or (shots[0] if shots else None)
    k = sh["camera_keys"][0] if sh else (scene.get("camera") or {"position": [0, 1.7, -8], "target": [0, 1, 0]})
    return k


# ---- symbolic -> concrete ---------------------------------------------------------------------------

def _obj_patch(a: dict, fields) -> dict:
    return {f: copy.deepcopy(a.get(f)) for f in fields}


def _shift_keys(a: dict, dx: float, dz: float) -> dict:
    keys = [{"frame": k["frame"], "position": [round(k["position"][0] + dx, 3), 0.0, round(k["position"][2] + dz, 3)]}
            for k in a.get("keys") or [{"frame": 0, "position": a["position"]}]]
    return {"keys": keys, "position": list(keys[0]["position"])}


def resolve(scene: dict, sym_ops: list[dict]) -> tuple[list[dict], list[str]]:
    """Turn symbolic ops into concrete ops against the scene (applied as we go). Returns (ops, notes)."""
    work = copy.deepcopy(scene)
    out: list[dict] = []
    notes: list[str] = []
    set_name = lambda: work["environment"]["set"]  # noqa: E731

    def emit(op, undo):
        op = dict(op, undo=undo)
        apply_op(work, op)
        out.append(op)

    for so in sym_ops or []:
        if not isinstance(so, dict):
            continue
        kind = str(so.get("op", "")).lower()
        try:
            if kind == "move":
                a = find_object(work, so.get("target"))
                if a is None:
                    notes.append(f"move: nothing called '{so.get('target')}' on set")
                    continue
                x, z = a["position"][0], a["position"][2]
                want = None
                ref_text = so.get("near") or so.get("to") or so.get("toward")
                away = so.get("away_from")
                if ref_text or away:
                    pt, ref, label = find_place(work, ref_text or away, exclude=(a["id"],))
                    if pt is None:
                        notes.append(f"move: couldn't find '{ref_text or away}'")
                        continue
                    if not ref:
                        pts = S.anchor_points(set_name(), label)
                        pt = list(_closest(pts, x, z)) if pts else pt
                    vx, vz = x - pt[0], z - pt[1]
                    L = math.hypot(vx, vz) or 1.0
                    if away:
                        amt = float(so.get("amount") or 3.0)
                        want = (x + vx / L * amt, z + vz / L * amt)
                    else:
                        fa = S.footprint(a)
                        rr = (max(S.footprint(ref)[2:]) if ref else 0.2)
                        dist = float(so.get("distance") or (max(fa[2], fa[3]) + rr + 0.5))
                        want = (pt[0] + vx / L * dist, pt[1] + vz / L * dist)
                elif so.get("by"):
                    b = list(so["by"]) + [0, 0, 0]
                    want = (x + float(b[0]), z + float(b[2] if len(so["by"]) >= 3 else b[1]))
                else:
                    d = str(so.get("dir", "")).lower()
                    amt = float(so.get("amount") or 1.5)
                    cam = _active_cam(work)
                    f, right, _ = G.basis(tuple(cam["position"]), tuple(cam["target"]))
                    fwd = G.flat(f)
                    right = G.flat(right)
                    vec = {"left": G.mul(right, -1), "right": right, "back": fwd, "away": fwd, "further": fwd,
                           "upstage": fwd, "forward": G.mul(fwd, -1), "closer": G.mul(fwd, -1),
                           "downstage": G.mul(fwd, -1), "toward camera": G.mul(fwd, -1)}.get(d)
                    if d in ("centre", "center", "middle"):
                        sx, sz = C.SETS[set_name()]["stage"]
                        want = (sx, sz)
                    elif vec is None:
                        notes.append(f"move: no direction or place given for {a['name']}")
                        continue
                    else:
                        want = (x + vec[0] * amt, z + vec[2] * amt)
                others = [o for o in work["actors"] if o["id"] != a["id"]]
                q = S.free_spot(a, want, set_name(), others)
                patch = _shift_keys(a, q[0] - x, q[2] - z)
                emit({"op": "move_object", "id": a["id"], "set": patch},
                     {"op": "move_object", "id": a["id"], "set": _obj_patch(a, patch)})
            elif kind in ("mount", "dismount"):
                a = find_object(work, so.get("target") or so.get("rider"))
                if a is None or a.get("kind") not in C.PEOPLE:
                    notes.append(f"{kind}: no person called '{so.get('target')}'")
                    continue
                fields = ["mount_id", "pose", "keys", "position"]
                if kind == "mount":
                    h = find_object(work, so.get("on") or so.get("host"), exclude=(a["id"],))
                    if h is None or h.get("kind") not in C.MOUNTS or h.get("mount_id"):
                        notes.append(f"mount: nothing to sit on called '{so.get('on')}'")
                        continue
                    patch = {"mount_id": h["id"], "pose": C.MOUNTS[h["kind"]],
                             "keys": copy.deepcopy(h.get("keys") or [{"frame": 0, "position": h["position"]}]),
                             "position": list(h["position"])}
                    op_name = "update_object"
                else:
                    if not a.get("mount_id"):
                        notes.append(f"dismount: {a.get('name')} isn't riding anything")
                        continue
                    h = find_object(work, a["mount_id"]) or a
                    others = [o for o in work["actors"] if o["id"] not in (a["id"],)]
                    q = S.free_spot(a, [h["position"][0] + 1.2, h["position"][2]], set_name(), others)
                    patch = {"mount_id": None, "pose": None, "keys": [{"frame": 0, "position": q}], "position": q}
                    op_name = "update_object"
                emit({"op": op_name, "id": a["id"], "set": patch},
                     {"op": op_name, "id": a["id"], "set": _obj_patch(a, fields)})
            elif kind == "add":
                what = str(so.get("what") or so.get("kind") or so.get("name") or "").strip()
                if not what:
                    continue
                kd = str(so.get("kind") or "").lower()
                role = next((w for w in _words(what) if w in P.ROLE_WORDS), None)
                lib = kd if kd in C.LIBRARY else (P.ROLE_WORDS[role] if role else None)
                ids = {o["id"] for o in work["actors"]}
                existing = [o for o in work["actors"] if role and role in _labels(o)]
                label = so.get("name") or (f"{role.capitalize()} {len(existing) + 1}" if role and existing
                                           else (role.capitalize() if role else None))
                o = make_object(what if not role else role, ids, kind=lib, label=label)
                if role:
                    o["role"] = role
                pt = None
                if so.get("near"):
                    pt, ref, lbl = find_place(work, so["near"])
                if pt is None:
                    cast = CAM.people(work)
                    pt = ([sum(c["position"][0] for c in cast) / len(cast) + 1.5, sum(c["position"][2] for c in cast) / len(cast) + 1.0]
                          if cast else list(C.SETS[set_name()]["stage"]))
                cast = CAM.people(work)
                if cast and o["kind"] in C.PEOPLE:  # face the others (decided first: it changes the footprint)
                    cx = sum(c["position"][0] for c in cast) / len(cast)
                    cz = sum(c["position"][2] for c in cast) / len(cast)
                    o["rotation_deg"] = S.heading_to((pt[0], 0, pt[1]), (cx, 0, cz))
                q = S.free_spot(o, pt, set_name(), work["actors"])
                o["position"] = q
                o["keys"] = [{"frame": 0, "position": list(q)}]
                emit({"op": "add_object", "object": o, "index": len(work["actors"])},
                     {"op": "remove_object", "id": o["id"]})
            elif kind == "remove":
                a = find_object(work, so.get("target"))
                if a is None:
                    notes.append(f"remove: nothing called '{so.get('target')}' on set")
                    continue
                i, _ = _find(work["actors"], a["id"])
                emit({"op": "remove_object", "id": a["id"]}, {"op": "add_object", "object": copy.deepcopy(a), "index": i})
            elif kind == "rotate":
                a = find_object(work, so.get("target"))
                if a is None:
                    notes.append(f"rotate: nothing called '{so.get('target')}'")
                    continue
                if so.get("face"):
                    pt, _, _ = find_place(work, so["face"], exclude=(a["id"],))
                    if pt is None:
                        if str(so["face"]).lower() in ("camera", "the camera", "lens"):
                            c = _active_cam(work)["position"]
                            pt = [c[0], c[2]]
                        else:
                            notes.append(f"rotate: couldn't find '{so['face']}'")
                            continue
                    deg = S.heading_to(a["position"], (pt[0], 0, pt[1]))
                else:
                    deg = float(a.get("rotation_deg") or 0) + float(so.get("deg") or so.get("by") or 90)
                deg = round(((deg + 180) % 360) - 180, 1)
                emit({"op": "rotate_object", "id": a["id"], "set": {"rotation_deg": deg}},
                     {"op": "rotate_object", "id": a["id"], "set": _obj_patch(a, ["rotation_deg"])})
            elif kind == "scale":
                a = find_object(work, so.get("target"))
                if a is None:
                    notes.append(f"scale: nothing called '{so.get('target')}'")
                    continue
                k = min(max(float(so.get("factor") or 1.5), 0.2), 5.0)
                patch = {"height_m": round(float(a.get("height_m") or S.size_of(a)[1]) * k, 3)}
                fields = ["height_m"]
                if a.get("kind") == "custom" and a.get("recipe"):
                    r = copy.deepcopy(a["recipe"])
                    r["size_m"] = [round(v * k, 3) for v in r.get("size_m", [1, 1, 1])]
                    for p in r.get("parts", []):
                        p["pos"] = [round(v * k, 3) for v in p["pos"]]
                        p["size"] = [round(v * k, 3) for v in p["size"]]
                    patch["recipe"] = r
                    fields.append("recipe")
                emit({"op": "scale_object", "id": a["id"], "set": patch},
                     {"op": "scale_object", "id": a["id"], "set": _obj_patch(a, fields)})
                a = find_object(work, a["id"])
                others = [o for o in work["actors"] if o["id"] != a["id"]]
                if not S.is_free(a, a["position"], set_name(), others):  # grown into a neighbour: make room
                    q = S.free_spot(a, [a["position"][0], a["position"][2]], set_name(), others)
                    mp = _shift_keys(a, q[0] - a["position"][0], q[2] - a["position"][2])
                    emit({"op": "move_object", "id": a["id"], "set": mp},
                         {"op": "move_object", "id": a["id"], "set": _obj_patch(a, mp)})
            elif kind == "time":
                pre = P._norm_key(so.get("preset") or so.get("time"), C.TIME_PRESETS, None) or \
                    P.pick(C.TIME_WORDS, str(so.get("preset") or so.get("time") or "").lower(), None)
                if not pre:
                    notes.append(f"time: unknown '{so.get('preset')}'")
                    continue
                L = work.get("lighting", {})
                patch = {"mode": "time", "hour": C.preset_hour(pre, L.get("day_of_year", 300), L.get("latitude", 34.05)),
                         "preset": pre, "overcast": bool(C.TIME_PRESETS[pre].get("overcast"))}
                emit({"op": "set_lighting", "set": patch, "sun": C.sun_for({**L, **patch})},
                     {"op": "set_lighting", "set": {k: L.get(k) for k in patch}, "sun": copy.deepcopy(work.get("sun"))})
            elif kind == "weather":
                w = P._norm_key(so.get("weather"), C.WEATHER, None) or P.pick(C.WEATHER_WORDS, str(so.get("weather", "")).lower(), None)
                if str(so.get("weather", "")).lower() in ("clear", "none", "no", "dry", "off"):
                    w = "none"
                if not w:
                    notes.append(f"weather: unknown '{so.get('weather')}'")
                    continue
                patch = {"weather": w}
                if so.get("density") is not None:
                    patch["density"] = min(max(float(so["density"]), 0), 1)
                env = work["environment"]
                emit({"op": "set_environment", "set": patch},
                     {"op": "set_environment", "set": {k: env.get(k) for k in patch}})
            elif kind == "set":
                sn = P._norm_key(so.get("set"), C.SETS, None) or P.pick(C.SET_WORDS, str(so.get("set", "")).lower(), None)
                if not sn:
                    notes.append(f"set: unknown '{so.get('set')}'")
                    continue
                old = work["environment"]
                emit({"op": "set_environment", "set": {"set": sn}}, {"op": "set_environment", "set": {"set": old.get("set")}})
                # Everything must still stand inside the new set: move what no longer fits.
                placed = []
                for a in list(work["actors"]):
                    if not S.is_free(a, a["position"], sn, placed):
                        q = S.free_spot(a, [a["position"][0], a["position"][2]], sn, placed)
                        patch = _shift_keys(a, q[0] - a["position"][0], q[2] - a["position"][2])
                        emit({"op": "move_object", "id": a["id"], "set": patch},
                             {"op": "move_object", "id": a["id"], "set": _obj_patch(a, patch)})
                    placed.append(next(x for x in work["actors"] if x["id"] == a["id"]))
                for sh in work.get("shots", []):
                    keys = [dict(k, **S.clamp_camera(k, sn)[0]) for k in sh["camera_keys"]]
                    if keys != sh["camera_keys"]:
                        emit({"op": "update_shot", "id": sh["id"], "set": {"camera_keys": keys}},
                             {"op": "update_shot", "id": sh["id"], "set": {"camera_keys": copy.deepcopy(sh["camera_keys"])}})
                if sn == "plaza" and not work.get("props"):
                    notes.append("plaza building comes from the scene props; reload a plaza scene to see it")
            elif kind == "light":
                t = str(so.get("type") or "key").lower()
                t = t if t in C.LIGHT_TYPES else next((k for k in C.LIGHT_TYPES if k in t), "key")
                subj = find_object(work, so.get("on")) if so.get("on") else None
                tmp_plan = {"lights": [t], "time": (work.get("lighting") or {}).get("preset") or "midday", "set": set_name()}
                from .build import lights_for
                scn = work if subj is None else dict(work, actors=[subj] + [x for x in work["actors"] if x is not subj])
                lt = lights_for(tmp_plan, scn, _active_cam(work))[0]
                n = len([x for x in work.get("lighting", {}).get("lights", []) if x.get("type") == t]) + 1
                lt["id"] = f"light_{t}_{n}_{len(out)}"
                lt["name"] = f"{C.LIGHT_TYPES[t]['label']} {n}"
                emit({"op": "add_light", "light": lt}, {"op": "remove_light", "id": lt["id"]})
            elif kind == "remove_light":
                lights = work.get("lighting", {}).get("lights", [])
                t = str(so.get("type") or so.get("target") or "").lower()
                gone = [x for x in lights if not t or t in ("all", "lights") or x.get("type") == t or t in x.get("name", "").lower()]
                for x in gone:
                    emit({"op": "remove_light", "id": x["id"]}, {"op": "add_light", "light": copy.deepcopy(x)})
            elif kind == "shot":
                setup = str(so.get("setup") or "wide").lower().replace("-", "_").replace(" ", "_")
                setup = {"over_the_shoulder": "ots", "close_up": "single", "closeup": "single", "cu": "single",
                         "mcu": "single", "establishing": "wide", "two": "two_shot"}.get(setup, setup)
                cast = CAM.people(work)
                subj = find_object(work, so.get("on")) if so.get("on") else (cast[0] if cast else None)
                other = find_object(work, so.get("over"), exclude=(subj["id"],) if subj else ()) if so.get("over") else None
                if other is None and subj is not None:
                    rest = [c for c in cast if c["id"] != subj["id"]]
                    other = min(rest, key=lambda c: math.dist(c["position"], subj["position"])) if rest else None
                if setup in ("ots", "pov", "two_shot") and other is None:
                    notes.append(f"{setup}: needs a second person; giving a single instead")
                    setup = "single"
                letter = "a"
                if subj is not None and cast and subj["id"] != cast[0]["id"]:
                    letter = "b"
                stage_setup = {"ots": f"ots_{letter}", "single": f"single_{letter}"}.get(setup, setup)
                if stage_setup not in C.SETUPS:
                    stage_setup = "wide"
                cam = CAM.compose(setup, subj, other, work, float(so["focal"]) if so.get("focal") else None)
                label = {"ots": "Over-the-shoulder", "single": "Single"}.get(setup, C.SETUPS[stage_setup])
                name = f"{label} on {subj['name']}" if subj and setup not in ("wide", "master") else label
                sid = f"shot_{len(work.get('shots', [])) + 1}"
                while any(x["id"] == sid for x in work.get("shots", [])):
                    sid += "b"
                shot = {"id": sid, "name": name, "setup": stage_setup, "camera_keys": CAM.keys_from(cam, None, work)}
                prev = work.get("active_shot")
                emit({"op": "add_shot", "shot": shot, "index": len(work.get("shots", []))}, {"op": "remove_shot", "id": sid})
                emit({"op": "set_active_shot", "id": sid}, {"op": "set_active_shot", "id": prev})
            elif kind == "camera":
                shots = work.get("shots") or []
                _, sh = _find(shots, work.get("active_shot"))
                if sh is None:
                    notes.append("camera: no active shot")
                    continue
                mv = str(so.get("move") or "").lower().replace(" ", "_").replace("-", "_")
                keys = []
                for k in sh["camera_keys"]:
                    p, t, f = list(k["position"]), list(k["target"]), float(k["focal_mm"])
                    if mv in ("push_in", "dolly_in", "closer", "move_in"):
                        p = [p[i] + (t[i] - p[i]) * 0.3 for i in range(3)]
                    elif mv in ("pull_out", "dolly_out", "pull_back", "back_up", "further"):
                        p = [p[i] - (t[i] - p[i]) * 0.4 for i in range(3)]
                    elif mv in ("higher", "high_angle", "crane_up", "up"):
                        p[1] += 1.0
                    elif mv in ("lower", "low_angle", "crane_down", "down"):
                        p[1] = max(0.25, p[1] - 0.8)
                    elif mv in ("wider", "zoom_out"):
                        f = f / 1.5
                    elif mv in ("tighter", "zoom_in"):
                        f = f * 1.5
                    if so.get("focal"):
                        f = float(so["focal"])
                    c, _ = S.clamp_camera({"position": p, "target": t, "focal_mm": min(max(f, 8), 400)}, set_name())
                    keys.append({"frame": k["frame"], "position": G.r3(c["position"]), "target": G.r3(c["target"]),
                                 "focal_mm": round(c["focal_mm"], 1)})
                emit({"op": "update_shot", "id": sh["id"], "set": {"camera_keys": keys}},
                     {"op": "update_shot", "id": sh["id"], "set": {"camera_keys": copy.deepcopy(sh["camera_keys"])}})
            else:
                notes.append(f"unknown op '{kind}' ignored")
        except (TypeError, ValueError, KeyError, IndexError) as e:
            notes.append(f"{kind}: skipped ({e})")
    # Final guard: whatever these edits added, moved, turned or resized must end up on free floor.
    touched = []
    for op in out:
        oid = op.get("id") or (op.get("object") or {}).get("id")
        if op["op"] in ("add_object", "move_object", "rotate_object", "scale_object", "update_object") and oid not in touched:
            touched.append(oid)
    for oid in touched:
        a = next((x for x in work["actors"] if x["id"] == oid), None)
        if a is None or a.get("mount_id"):
            continue
        others = [o for o in work["actors"] if o["id"] != oid and not o.get("mount_id")]
        if not S.is_free(a, a["position"], set_name(), others):
            q = S.free_spot(a, [a["position"][0], a["position"][2]], set_name(), others)
            patch = _shift_keys(a, q[0] - a["position"][0], q[2] - a["position"][2])
            emit({"op": "move_object", "id": oid, "set": patch}, {"op": "move_object", "id": oid, "set": _obj_patch(a, patch)})
    return out, notes


# ---- rules command parser (no LLM) ---------------------------------------------------------------

def _has(t, w):
    return re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t) is not None


def _split_relation(clause: str):
    """'move the car closer to the streetlamp' -> ('the car', 'closer to', 'the streetlamp')."""
    for rel in RELATIONS:
        m = re.search(rf"\b{re.escape(rel)}\b", clause)
        if m:
            return clause[:m.start()], rel, clause[m.end():]
    return clause, "", ""


def _strip_verb(t: str, verbs) -> str:
    for v in verbs:
        t = re.sub(rf"^\s*(?:please\s+)?{v}\b", "", t)
    return t.strip()


def _num_in(t: str, default=None):
    m = re.search(r"(-?\d+(?:\.\d+)?)", t)
    if m:
        return float(m.group(1))
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "half": 0.5, "a couple": 2, "a few": 3}
    for w, v in words.items():
        if _has(t, w):
            return v
    return default


def rules_ops(command: str, scene: dict) -> list[dict]:
    """Best-effort symbolic ops from a command, without a model."""
    text = command.lower().strip().rstrip(".!")
    clauses = re.split(r"\s*(?:,|;|\bthen\b|\band also\b|\band\b(?=\s+(?:add|move|remove|make|turn|put|give|set|switch|change|rotate|delete|bring)))\s*", text)
    ops: list[dict] = []
    for cl in [c for c in clauses if c.strip()]:
        ops += _clause_ops(cl.strip(), scene)
    return ops


def _clause_ops(cl: str, scene: dict) -> list[dict]:
    ops = []
    m = re.match(r"^(?:dismount|unmount)\s+(.+)$", cl) or re.match(r"^(?:have|let|make)?\s*(.+?)\s+(?:gets? off|dismounts?|climbs? off|stands? up)\b", cl)
    if m and find_object(scene, m.group(1)):
        return [{"op": "dismount", "target": m.group(1).strip()}]
    m = re.match(r"^(?:put|sit|seat|place|have|get|let|mount)\s+(.+?)\s+(?:on|onto|in|into|astride|on top of|ride|riding)\s+(.+)$", cl) \
        or re.match(r"^(.+?)\s+(?:rides|mounts|gets on|climbs on|sits on|sits in|gets in)\s+(.+)$", cl)
    if m:
        rider, host = find_object(scene, m.group(1)), find_object(scene, m.group(2))
        if rider is not None and host is not None and rider is not host and rider.get("kind") in C.PEOPLE \
                and host.get("kind") in C.MOUNTS:
            return [{"op": "mount", "target": m.group(1).strip(), "on": m.group(2).strip()}]
    shot_kind = P.pick(SHOT_WORDS, cl, None)
    is_light = re.search(r"\b(key|fill|rim|back|practical|spot|neon)\s*light|\blight\b", cl) is not None
    if re.match(r"^(remove|delete|get rid of|lose|take out|kill)\b", cl):
        tgt = _strip_verb(cl, ["remove", "delete", "get rid of", "lose", "take out", "kill"])
        if is_light or "light" in tgt:
            m = re.search(r"(key|fill|rim|practical|spot|neon)", tgt)
            return [{"op": "remove_light", "type": m.group(1) if m else "all"}]
        return [{"op": "remove", "target": tgt}]
    if shot_kind and re.search(r"\b(give|add|get|make|want|need|cover|shot|set ?up|show)\b|^(an?|the)\b", cl) \
            and not re.match(r"^(move|put|bring)\b", cl):
        m_on = re.search(r"\b(?:on|of|at)\s+(?:the\s+)?([a-z][a-z0-9 ]*?)(?=\s+(?:over|from|with|using)\b|$)", cl)
        m_over = re.search(r"\bover\s+(?:the\s+)?([a-z][a-z0-9 ]*?)(?:'s)?\s+shoulder", cl) or \
            re.search(r"\bfrom\s+(?:behind\s+)?(?:the\s+)?([a-z][a-z0-9 ]*?)$", cl)
        op = {"op": "shot", "setup": shot_kind}
        if m_on and m_on.group(1) not in ("shoulder",):
            op["on"] = m_on.group(1).strip()
        if m_over:
            op["over"] = m_over.group(1).strip()
        f = re.search(r"(\d{2,3})\s*mm", cl)
        if f:
            op["focal"] = float(f.group(1))
        return [op]
    if is_light and re.search(r"\b(add|give|put|set|light|use)\b", cl):
        m = re.search(r"(key|fill|rim|back|practical|spot|neon)", cl)
        t = {"back": "rim"}.get(m.group(1), m.group(1)) if m else "key"
        m_on = re.search(r"\bon\s+(?:the\s+)?([a-z][a-z0-9 ]*)$", cl)
        return [{"op": "light", "type": t, **({"on": m_on.group(1)} if m_on else {})}]
    cam_moves = [("push_in", ["push in", "dolly in", "move in", "get closer", "tighter on"]),
                 ("pull_out", ["pull out", "pull back", "dolly out", "back up", "widen out"]),
                 ("higher", ["higher", "high angle", "crane up", "from above"]),
                 ("lower", ["lower", "low angle", "crane down", "from below"]),
                 ("tighter", ["zoom in", "tighter"]), ("wider", ["zoom out", "wider"])]
    lens = re.search(r"(\d{2,3})\s*mm", cl)
    if (re.search(r"\b(camera|lens|shot|angle|frame)\b", cl) or lens or P.pick(cam_moves, cl, None) in ("push_in", "pull_out")) \
            and not re.match(r"^(move|put|bring)\s+the\s+(?!camera)", cl):
        mv = P.pick(cam_moves, cl, None)
        if mv or lens:
            return [{"op": "camera", **({"move": mv} if mv else {}), **({"focal": float(lens.group(1))} if lens else {})}]
    tm = P.pick(C.TIME_WORDS, cl, None)
    wx = P.pick(C.WEATHER_WORDS, cl, None)
    if re.search(r"\b(stop|no more|no)\s+(the\s+)?(rain|snow|fog|smoke|dust)|\bclear (skies|weather)\b", cl):
        ops.append({"op": "weather", "weather": "none"})
        wx = None
    if tm and (re.match(r"^(make|set|change|switch|turn)\b", cl) or re.search(r"\b(it'?s|time|at)\b", cl) or not
               re.match(r"^(add|move|put)\b", cl)):
        ops.append({"op": "time", "preset": tm})
    if wx and not re.match(r"^(add|move|put)\b", cl):
        ops.append({"op": "weather", "weather": wx})
    if ops:
        return ops
    set_hit = P.pick(C.SET_WORDS, cl, None)
    if set_hit and re.search(r"\b(switch|change|go|move the (scene|set|action)|take (us|it)|relocate|set it|make it|set the scene)\b", cl):
        return [{"op": "set", "set": set_hit}]
    if re.match(r"^(turn|rotate|spin|face|have)\b", cl):
        m = re.search(r"\b(?:to\s+)?face\s+(?:the\s+)?([a-z][a-z0-9 ]*)$", cl)
        tgt = re.sub(r"\b(to\s+)?face\b.*$", "", _strip_verb(cl, ["turn", "rotate", "spin", "have", "face"])).strip()
        tgt = re.sub(r"\b(around|by|\d+\s*(degrees|deg|°)?|left|right)\b", "", tgt).strip()
        if m:
            return [{"op": "rotate", "target": tgt or m.group(1), "face": m.group(1)}]
        deg = _num_in(cl, 180 if "around" in cl else 90)
        if _has(cl, "right"):
            deg = -abs(deg)
        return [{"op": "rotate", "target": tgt, "deg": deg}]
    if re.search(r"\b(bigger|larger|smaller|scale|taller|shorter|twice|double|half)\b", cl):
        tgt = re.sub(r"\b(make|scale|the|bigger|larger|smaller|taller|shorter|twice|double|half|as big|as|size|times|x|by|\d+(\.\d+)?)\b", " ", cl)
        f = 2.0 if re.search(r"\b(twice|double)\b", cl) else 0.5 if _has(cl, "half") else _num_in(cl, None)
        if f is None:
            f = 1.5 if re.search(r"\b(bigger|larger|taller)\b", cl) else 0.67
        return [{"op": "scale", "target": " ".join(tgt.split()), "factor": f}]
    if re.match(r"^(add|put|place|bring in|we need|i want|give me|insert|drop|spawn|there should be)\b", cl):
        body = _strip_verb(cl, ["add", "put", "place", "bring in", "we need", "i want", "give me", "insert", "drop",
                                "spawn", "there should be"])
        what, rel, ref = _split_relation(body)
        what = re.sub(r"^(an?|the|some|another|one more|a second|second|a third|third)\s+", "", what.strip())
        op = {"op": "add", "what": what.strip()}
        if ref.strip():
            op["near"] = ref.strip()
        return [op] if op["what"] else []
    if re.match(r"^(move|bring|push|pull|put|slide|shift|walk|drive|park|place|reposition)\b", cl):
        body = _strip_verb(cl, ["move", "bring", "push", "pull", "put", "slide", "shift", "walk", "drive", "park",
                                "place", "reposition"])
        what, rel, ref = _split_relation(body)
        d = None
        for word in ("left", "right", "back", "forward", "closer", "further", "upstage", "downstage", "centre",
                     "center", "middle"):
            if _has(what, word) or (not rel and _has(body, word)):
                d = word
                what = re.sub(rf"\b{word}\b", "", what)
        what = re.sub(r"\b(\d+(\.\d+)?|metres?|meters?|m|a bit|a little|slightly|further|to the|over)\b", " ", what)
        op = {"op": "move", "target": " ".join(what.split())}
        if rel == "away from":
            op["away_from"] = ref.strip()
        elif rel and ref.strip() and not re.match(r"^\s*the (left|right)\b", ref):
            op["near"] = ref.strip()
        elif rel == "to" and re.match(r"^\s*the (left|right)\b", ref):
            d = re.match(r"^\s*the (left|right)\b", ref).group(1)
        if d and "near" not in op:
            op["dir"] = d
        amt = _num_in(cl, None)
        if amt:
            op["amount"] = amt
        return [op]
    return []


def summarize(ops: list[dict], scene_before: dict) -> str:
    """One readable line per op for the chat box."""
    names = {a["id"]: a.get("name", a["id"]) for a in scene_before.get("actors", [])}
    lines = []
    for op in ops:
        k = op["op"]
        if k == "add_object":
            p = op["object"]["position"]
            lines.append(f"Added {op['object']['name']} at ({p[0]:.1f}, {p[2]:.1f})")
            names[op["object"]["id"]] = op["object"]["name"]
        elif k == "remove_object":
            lines.append(f"Removed {names.get(op['id'], op['id'])}")
        elif k == "move_object":
            p = op["set"]["position"]
            lines.append(f"Moved {names.get(op['id'], op['id'])} to ({p[0]:.1f}, {p[2]:.1f})")
        elif k == "rotate_object":
            lines.append(f"Turned {names.get(op['id'], op['id'])} to {op['set']['rotation_deg']:.0f}°")
        elif k == "update_object" and "mount_id" in op["set"]:
            h = op["set"]["mount_id"]
            lines.append(f"{names.get(op['id'], op['id'])} " + (f"is on the {names.get(h, h)}" if h else "got off"))
        elif k == "update_object" and "recipe" in op["set"]:
            lines.append(f"Designed {names.get(op['id'], op['id'])}")
        elif k == "scale_object":
            lines.append(f"Resized {names.get(op['id'], op['id'])} to {op['set']['height_m']:.2f} m tall")
        elif k == "set_lighting" and op["set"].get("preset"):
            lines.append(f"Time of day: {C.TIME_PRESETS[op['set']['preset']]['label']}")
        elif k == "set_environment":
            lines.append("Set: " + ", ".join(f"{a}={b}" for a, b in op["set"].items()))
        elif k == "add_light":
            lines.append(f"Added {op['light']['name']}")
        elif k == "remove_light":
            lines.append("Removed a light")
        elif k == "add_shot":
            c = op["shot"]["camera_keys"][0]
            lines.append(f"New camera: {op['shot']['name']} ({c['focal_mm']:.0f} mm)")
        elif k == "update_shot":
            c = op["set"]["camera_keys"][0]
            lines.append(f"Camera adjusted ({c['focal_mm']:.0f} mm)")
    return "; ".join(lines) if lines else "Nothing changed."
