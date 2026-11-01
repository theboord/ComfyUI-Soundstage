"""Director's assistant: talk to the App ("put Mara in the sports car at night, rain, camera on the hood").

A typed tool layer over the App. The model (the local Qwen3.5 4B, an Ollama model, or the rules) answers with tool
calls; this module validates every call against TOOLS and the live scene (names must exist, numbers stay in range,
enums are enums), resolves the scene edits into the same concrete, undoable ops the Scene agent uses (ops.py), and
returns a short plan in film language. Nothing changes here: the browser shows the plan, the director presses Apply
(or says "go"), and the browser runs each call through the App's real APIs. GPU work (frames, renders) always asks
first unless the director said "go".

    plan(command, scene, ctx, llm_text=None) -> {
        "calls":   [{"tool", "args", "kind": "edit"|"app", "gpu": bool, "ops"?: [...], "plan": "I'll ..."}],
        "plan":    ["I'll ...", ...],
        "confirm": bool,             # a GPU render is in the plan and the director didn't say "go"
        "notes":   [...], "rejected": [{"call", "why"}], "backend": "llm"|"rules"|..., "summary": str}

ctx (from the browser, all optional): {"shots": [{"id", "name"}] in strip order, "active_shot", "scenes":
[{"id", "number", "heading"}], "live_scene", "renders": {shot_id: ["look", "draft", ...]}}.

Pure Python (no torch, no ComfyUI imports), like the rest of the agent.
"""
from __future__ import annotations

import copy
import json
import re

from . import catalog as C
from . import ops as O
from . import plan as P
from . import parts as PT

# ------------------------------------------------------------------------------------------- the tools

VEHICLES = {k for k, v in C.LIBRARY.items() if v.get("rig") == "vehicle"} | {"police_car", "sports_car", "bus", "boat"}
SEATABLE = VEHICLES | set(C.MOUNTS) | {"sofa", "armchair", "couch", "stool", "chair", "bench"}
STUNTS = {"reverse_jturn": "Reverse J-turn", "donut": "Donut", "handbrake_180": "Handbrake 180", "none": "No stunt"}
RIGS = ["free", "tripod", "dolly", "chapman", "slider", "jib", "steadicam", "handheld", "drone"]
CAM_VIEWS = {"hood": "windshield", "windshield": "windshield", "driver_pov": "driver_pov", "passenger": "passenger_on_driver",
             "back_seat": "back_seat", "dashboard": "dash_two_shot", "side": "side_tracking", "top": "top_down", "off": None}
MOVES = ["push_in", "pull_out", "truck_left", "truck_right", "crane_up", "crane_down", "orbit_left", "orbit_right", "static"]
REFRAMES = ["push_in", "pull_out", "higher", "lower", "wider", "tighter"]
GRADE_KEYS = ["warmth", "contrast", "saturation", "grain", "halation", "vignette"]
SETS = list(C.SETS)

# arg spec: (type, required, extra). Types: text, name (an object on set), person, vehicle, seat (something to sit in),
# place (object or set anchor), enum, int, num, shot (one shot), shots (a list or "all"), scene, names (one or more objects).
TOOLS: dict[str, dict] = {
    # scene edits, resolved here into concrete undoable ops
    "add": {"kind": "edit", "doc": "Put a prop, vehicle, animal or person on the set",
            "args": {"what": ("text", True, None), "near": ("place", False, None)}},
    "stack": {"kind": "edit", "doc": "A stack of crates (or boxes, barrels) on the floor",
              "args": {"what": ("text", False, None), "near": ("place", False, None), "count": ("int", False, (2, 12))}},
    "move": {"kind": "edit", "doc": "Move something next to a thing or place, or left/right/closer/back by metres",
             "args": {"target": ("name", True, None), "near": ("place", False, None),
                      "dir": ("enum", False, ["left", "right", "closer", "back", "centre"]), "amount": ("num", False, (0.1, 30))}},
    "remove": {"kind": "edit", "doc": "Take something off the set", "args": {"target": ("name", True, None)}},
    "turn": {"kind": "edit", "doc": "Turn something to face a thing, or by degrees",
             "args": {"target": ("name", True, None), "face": ("name", False, None), "deg": ("num", False, (-360, 360))}},
    "scale": {"kind": "edit", "doc": "Make something bigger or smaller", "args": {"target": ("name", True, None), "factor": ("num", True, (0.2, 5))}},
    "time": {"kind": "edit", "doc": "Time of day", "args": {"preset": ("enum", True, list(C.TIME_PRESETS))}},
    "weather": {"kind": "edit", "doc": "Weather and atmosphere", "args": {"weather": ("enum", True, C.WEATHER)}},
    "set": {"kind": "edit", "doc": "Change the set", "args": {"set": ("enum", True, SETS)}},
    "light": {"kind": "edit", "doc": "Add a film light, aimed at someone", "args": {"type": ("enum", True, list(C.LIGHT_TYPES)), "on": ("name", False, None)}},
    "add_shot": {"kind": "edit", "doc": "A new camera setup (coverage)",
                 "args": {"setup": ("enum", True, ["wide", "two_shot", "single", "ots", "insert", "pov"]), "on": ("name", False, None), "over": ("name", False, None)}},
    "reframe": {"kind": "edit", "doc": "Nudge the current shot's camera (closer, higher, wider...)", "args": {"move": ("enum", True, REFRAMES)}},
    # App actions, run in the browser through the App's own APIs
    "mount": {"kind": "app", "doc": "Put a person in a vehicle, on a horse or in a seat",
              "args": {"target": ("person", True, None), "on": ("seat", True, None)}},
    "dismount": {"kind": "app", "doc": "Get someone out / off", "args": {"target": ("person", True, None)}},
    "select_shot": {"kind": "app", "doc": "Work on another shot (1 = first in the strip)", "args": {"shot": ("shot", True, None)}},
    "lens": {"kind": "app", "doc": "Focal length in mm for the current shot", "args": {"mm": ("num", True, (8, 400))}},
    "camera_move": {"kind": "app", "doc": "An animated camera move over the shot",
                    "args": {"move": ("enum", True, MOVES), "speed": ("enum", False, ["slow", "medium", "fast"])}},
    "rig": {"kind": "app", "doc": "Camera support: tripod, dolly, steadicam, handheld, drone...", "args": {"type": ("enum", True, RIGS)}},
    "camera_on": {"kind": "app", "doc": "Rig the camera on a vehicle (hood mount, driver POV, back seat, side) or take it off",
                  "args": {"target": ("vehicle", False, None), "view": ("enum", False, list(CAM_VIEWS))}},
    "stunt": {"kind": "app", "doc": "A car stunt: reverse_jturn, donut, handbrake_180 (none clears it)",
              "args": {"target": ("vehicle", False, None), "stunt": ("enum", True, list(STUNTS))}},
    "drive": {"kind": "app", "doc": "Drive a vehicle straight through (or into) something",
              "args": {"target": ("vehicle", False, None), "through": ("names", True, None), "speed": ("enum", False, ["slow", "medium", "fast"])}},
    "physics": {"kind": "app", "doc": "Physics for objects: dynamic (falls, gets knocked), static, off",
                "args": {"target": ("names", True, None), "mode": ("enum", True, ["dynamic", "static", "off"])}},
    "bake": {"kind": "app", "doc": "Simulate the physics over the shot and bake it into keys", "args": {}},
    "direct": {"kind": "app", "doc": "A performance note for someone (nervous, angry, tired...)",
               "args": {"who": ("person", False, None), "note": ("text", True, None)}},
    "grade": {"kind": "app", "doc": "Colour grade for the frames: warmth, contrast, saturation, grain (-1..1 change)",
              "args": {k: ("num", False, (-1, 1)) for k in GRADE_KEYS}},
    "scene": {"kind": "app", "doc": "Go to a script scene (by number)", "args": {"scene": ("scene", True, None)}},
    "frames": {"kind": "app", "gpu": True, "doc": "Paint first frames (stills) for shots on the GPU",
               "args": {"shots": ("shots", False, None), "count": ("int", False, (1, 4))}},
    "render": {"kind": "app", "gpu": True, "doc": "Render draft or final video for shots on the GPU",
               "args": {"kind": ("enum", True, ["draft", "final"]), "shots": ("shots", False, None)}},
    "approve": {"kind": "app", "doc": "Review a shot's current take: approved, changes or rejected",
                "args": {"shot": ("shot", False, None), "status": ("enum", True, ["approved", "changes", "rejected"]), "note": ("text", False, None)}},
    "cut": {"kind": "app", "doc": "Cut the scene together with each shot's best take", "args": {}},
    "play": {"kind": "app", "doc": "Play the current shot", "args": {}},
    "undo": {"kind": "app", "doc": "Undo the last change", "args": {}},
    "build": {"kind": "app", "doc": "Build a whole new scene from a description", "args": {"text": ("text", True, None)}},
}
TOOLS.update(PT.TOOL)   # Milestone 26: doors, lamps, light bar, wipers, steering, horse head / gait, faces, light flicker
ALIASES = {"move_camera": "camera_move", "camera": "camera_move", "dolly": "camera_move", "set_lens": "lens", "focal": "lens",
           "focal_length": "lens", "time_of_day": "time", "tod": "time", "atmosphere": "weather", "location": "set",
           "shot": "select_shot", "goto_shot": "select_shot", "new_shot": "add_shot", "coverage": "add_shot",
           "rotate": "turn", "delete": "remove", "put": "add", "place": "add", "seat": "mount", "ride": "mount",
           "get_in": "mount", "get_out": "dismount", "simulate": "bake", "bake_physics": "bake", "car_stunt": "stunt",
           "crash": "drive", "drive_through": "drive", "emotion": "direct", "mood": "direct", "performance": "direct",
           "note": "direct", "colour": "grade", "color": "grade", "grade_frames": "grade", "script_scene": "scene",
           "select_scene": "scene", "paint": "frames", "paint_frames": "frames", "generate_frames": "frames",
           "render_draft": "render", "render_final": "render", "review": "approve", "assemble": "cut", "edit": "cut",
           "playback": "play", "camera_mount": "camera_on", "mount_camera": "camera_on", "nudge_camera": "reframe"}

ALIASES.update({k: v for k, v in PT.ALIASES.items() if k not in ALIASES})


def tool_specs() -> list[dict]:
    """TOOLS as plain JSON (for the MCP server, docs and the browser)."""
    out = []
    for name, t in TOOLS.items():
        args = {}
        for a, (typ, req, extra) in t["args"].items():
            d = {"type": typ, "required": req}
            if typ == "enum":
                d["enum"] = list(extra)
            elif extra:
                d["min"], d["max"] = extra
            args[a] = d
        out.append({"name": name, "kind": t["kind"], "gpu": bool(t.get("gpu")), "doc": t["doc"], "args": args})
    return out


# ------------------------------------------------------------------------------------------- scene helpers

def normalize_scene(scene: dict) -> dict:
    """A deep copy the ops can work on, without moving anything (unlike validate_scene)."""
    s = copy.deepcopy(scene if isinstance(scene, dict) else {})
    s.setdefault("environment", {}).setdefault("set", "plaza")
    if s["environment"].get("set") not in C.SETS:
        s["environment"]["set"] = "empty"
    s.setdefault("lighting", {}).setdefault("lights", [])
    acts = []
    for a in s.get("actors") or []:
        if not isinstance(a, dict) or not a.get("id"):
            continue
        if not isinstance(a.get("position"), list) or len(a["position"]) < 3:
            k = (a.get("keys") or [{}])[0]
            a["position"] = list(k.get("position") or [0, 0, 0])
        a.setdefault("name", a["id"])
        a.setdefault("kind", "man")
        acts.append(a)
    s["actors"] = acts
    shots = [x for x in s.get("shots") or [] if isinstance(x, dict) and x.get("id") and x.get("camera_keys")]
    if not shots and isinstance(s.get("camera"), dict):
        cam = s["camera"]
        shots = [{"id": "shot_1", "name": "Master", "setup": "master",
                  "camera_keys": [{"frame": 0, "position": cam.get("position", [0, 1.6, 8]), "target": cam.get("target", [0, 1, 0]),
                                   "focal_mm": cam.get("focal_mm", 35)}]}]
    s["shots"] = shots
    if shots and not any(x["id"] == s.get("active_shot") for x in shots):
        s["active_shot"] = shots[0]["id"]
    return s


def _people(scene):
    return [a for a in scene["actors"] if a.get("kind") in C.PEOPLE and not a.get("carry_id")]


def _vehicles(scene):
    return [a for a in scene["actors"] if a.get("kind") in VEHICLES]


def _shot_list(scene, ctx):
    shots = (ctx or {}).get("shots") or []
    ids = {s["id"] for s in scene.get("shots", [])}
    out = [s for s in shots if isinstance(s, dict) and s.get("id") in ids]
    out += [{"id": s["id"], "name": s.get("name", s["id"])} for s in scene.get("shots", []) if s["id"] not in {x["id"] for x in out}]
    return out


NUMWORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
            "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "a": 1, "an": 1, "a couple of": 2,
            "a few": 3, "some": 3, "several": 4, "a pair of": 2}


def _int(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    t = str(v).strip().lower()
    if re.fullmatch(r"-?\d+(\.\d+)?", t):
        return int(float(t))
    m = re.search(r"\d+", t)
    if m:
        return int(m.group())
    return NUMWORDS.get(t)


def resolve_shot(ref, scene, ctx, active=None):
    """A shot reference -> shot id: 1-based number (strip order), "this"/"current", "last", or words of its name."""
    shots = _shot_list(scene, ctx)
    if not shots:
        return None
    active = active or scene.get("active_shot")
    if ref is None or str(ref).strip().lower() in ("", "this", "current", "active", "it", "this shot", "the shot"):
        return active if any(s["id"] == active for s in shots) else shots[0]["id"]
    t = str(ref).strip().lower()
    if any(s["id"] == ref for s in shots):
        return ref
    if t in ("last", "the last", "last shot", "final shot"):
        return shots[-1]["id"]
    n = _int(re.sub(r"^(shot|setup|angle)\s*", "", t))
    if n is not None and 1 <= n <= len(shots):
        return shots[n - 1]["id"]
    if n is not None:
        return None
    ws = [w for w in re.findall(r"[a-z]+", t) if w not in ("the", "shot", "camera", "angle", "setup", "cam", "on")]
    best, score = None, 0
    for s in shots:
        name = set(re.findall(r"[a-z]+", str(s.get("name", "")).lower())) | set(re.findall(r"[a-z]+", s["id"].lower()))
        sc = sum(1 for w in ws if w in name)
        if sc > score:
            best, score = s["id"], sc
    return best


def resolve_shots(ref, scene, ctx, active=None):
    shots = _shot_list(scene, ctx)
    if ref is None or ref == "":
        one = resolve_shot(None, scene, ctx, active)
        return [one] if one else []
    if isinstance(ref, str) and ref.strip().lower() in ("all", "every", "every shot", "all shots", "each", "everything"):
        return [s["id"] for s in shots]
    if isinstance(ref, str):
        m = re.fullmatch(r"\s*(\d+)\s*(?:-|to|through|thru|–)\s*(\d+)\s*", ref)
        if m:
            ref = list(range(int(m.group(1)), int(m.group(2)) + 1))
        elif re.fullmatch(r"[\d\s,and]+", ref):
            ref = [int(x) for x in re.findall(r"\d+", ref)]
        else:
            ref = [ref]
    if not isinstance(ref, list):
        ref = [ref]
    out = []
    for r in ref:
        sid = resolve_shot(r, scene, ctx, active)
        if sid is None:
            return None
        if sid not in out:
            out.append(sid)
    return out


def resolve_scene_ref(ref, ctx):
    scenes = (ctx or {}).get("scenes") or []
    t = str(ref or "").strip().lower()
    t = re.sub(r"^(scene|sc\.?)\s*", "", t)
    for s in scenes:
        if str(s.get("number", "")).lower() == t or s.get("id") == ref:
            return s["id"]
    n = _int(t)
    if n is not None:
        for s in scenes:
            if str(s.get("number")) == str(n):
                return s["id"]
        if 1 <= n <= len(scenes):
            return scenes[n - 1]["id"]
        return None
    for s in scenes:
        if t and t in str(s.get("heading", "")).lower():
            return s["id"]
    return None


WALLISH = ["wall", "back wall", "tank wall", "storefront", "building", "cyc", "sidewalk", "fence"]


def _place_ok(scene, text):
    if text is None or str(text).strip() == "":
        return True, None
    t = re.sub(r"^(?:the|a|an)\s+", "", str(text).strip(), flags=re.I)
    pt, _, _ = O.find_place(scene, t)
    if pt is not None:
        return True, t
    if re.search(r"\bwall\b", t.lower()):
        for w in WALLISH:
            pt, _, _ = O.find_place(scene, w)
            if pt is not None:
                return True, w
    return False, t


def _group(scene, text):
    """'the crates' / 'crate stack' / 'it' (resolved earlier) -> every object it means (a stack is several)."""
    if isinstance(text, list):
        out = []
        for t in text:
            g = _group(scene, t)
            out += [a for a in g if a not in out]
        return out
    t = str(text or "").lower().strip()
    if not t:
        return []
    if t in ("__stack__", "it", "them", "the stack", "stack"):
        stacks = [x.get("stack") for x in scene["actors"] if x.get("stack")]
        if stacks:
            return [x for x in scene["actors"] if x.get("stack") == stacks[-1]]
        if t.startswith("__"):
            return []
    exact = [a for a in scene["actors"] if a["id"] == text or str(a.get("name", "")).lower() == t]
    if exact:
        a = exact[0]
        if a.get("stack"):
            return [x for x in scene["actors"] if x.get("stack") == a["stack"]]
        return [a]
    one = O.find_object(scene, t)
    if one is None:
        return []
    if one.get("stack"):
        return [x for x in scene["actors"] if x.get("stack") == one["stack"]]
    plural = re.search(r"(s|stack|pile|all|every)\b", t) is not None and one.get("kind") not in C.PEOPLE
    if plural:
        return [x for x in scene["actors"] if x.get("kind") == one.get("kind")]
    return [one]


# ------------------------------------------------------------------------------------------- validation

class Invalid(ValueError):
    pass


def _norm_call(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = raw.get("tool") or raw.get("name") or raw.get("op") or raw.get("action")
    if not name:
        return None
    name = str(name).strip().lower().replace("-", "_").replace(" ", "_")
    name = ALIASES.get(name, name)
    args = dict(raw.get("args") or raw.get("arguments") or raw.get("parameters") or {})
    for k, v in raw.items():
        if k not in ("tool", "name", "op", "action", "args", "arguments", "parameters"):
            args.setdefault(k, v)
    return {"tool": name, "args": args}


def validate_call(raw, work: dict, ctx: dict) -> dict:
    """One call -> a normalized call (names resolved to ids, numbers clamped) or Invalid with the reason."""
    c = _norm_call(raw)
    if c is None:
        raise Invalid("not a tool call")
    name = c["tool"]
    if name not in TOOLS:
        raise Invalid(f"no tool called '{name}'")
    spec = TOOLS[name]
    given = c["args"]
    # Synonym args the model likes.
    syn = {"object": "what", "thing": "what", "item": "what", "to": "near", "by": "near", "next_to": "near",
           "name": "target", "who": "who", "actor": "target", "person": "target", "vehicle": "target", "car": "target",
           "focal_mm": "mm", "focal": "mm", "value": "mm", "type": "type", "preset": "preset", "shots": "shots",
           "shot_id": "shot", "id": "target", "into": "through", "object_names": "through", "angle": "view",
           "position": "view", "emotion": "note", "mood": "note", "text": "text", "description": "text", "time": "preset",
           "kind": "kind", "status": "status", "count": "count", "number": "count", "direction": "dir", "distance": "amount",
           "degrees": "deg", "amount_deg": "deg", "size": "factor", "scale": "factor", "location": "set", "at": "near"}
    args = {}
    for k, v in given.items():
        k2 = k if k in spec["args"] else syn.get(k, k)
        if name == "render" and k == "type":
            k2 = "kind"
        if name == "direct" and k in ("target", "actor", "person", "name"):
            k2 = "who"
        if name == "light" and k == "target":
            k2 = "on"
        if name in ("frames", "render") and k == "shot":
            k2 = "shots"
        if name == "set" and k in ("name", "preset", "location"):
            k2 = "set"
        if name == "weather" and k in ("type", "preset", "kind"):
            k2 = "weather"
        if name == "camera_move" and k in ("type", "kind", "direction"):
            k2 = "move"
        if name == "reframe" and k in ("type", "kind", "direction"):
            k2 = "move"
        if name == "rig" and k in ("rig", "kind", "support"):
            k2 = "type"
        if name == "stunt" and k in ("type", "kind", "name"):
            k2 = "stunt"
        if k2 in spec["args"] and v is not None and v != "":
            args[k2] = v
    out = {}
    for a, (typ, req, extra) in spec["args"].items():
        if a not in args:
            if req:
                raise Invalid(f"{name}: needs '{a}'")
            continue
        v = args[a]
        if typ == "text":
            v = str(v).strip()[:300]
            if not v:
                raise Invalid(f"{name}: empty '{a}'")
            out[a] = v
        elif typ == "enum":
            t = str(v).strip().lower().replace("-", "_").replace(" ", "_")
            t = {"jturn": "reverse_jturn", "j_turn": "reverse_jturn", "reverse_j_turn": "reverse_jturn", "donuts": "donut",
                 "handbrake": "handbrake_180", "handbrake_turn": "handbrake_180", "pushin": "push_in", "dolly_in": "push_in",
                 "push": "push_in", "pull_back": "pull_out", "dolly_out": "pull_out", "pullout": "pull_out",
                 "magic": "magic_hour", "sunset": "magic_hour", "golden_hour": "magic_hour", "dusk": "magic_hour",
                 "noon": "midday", "day": "midday", "sunrise": "dawn", "twilight": "blue_hour", "midnight": "night",
                 "clear": "none", "no": "none", "off": "none" if name == "weather" else "off", "rainy": "rain", "foggy": "fog",
                 "snowy": "snow", "approve": "approved", "reject": "rejected", "needs_changes": "changes", "change": "changes",
                 "close_up": "single", "closeup": "single", "over_the_shoulder": "ots", "two": "two_shot", "establishing": "wide",
                 "master": "wide", "hand_held": "handheld", "crane": "jib", "street": "street_night", "city": "street_night",
                 "room": "interior", "bonnet": "hood", "hood_mount": "hood", "windscreen": "windshield", "pov": "driver_pov",
                 "dash": "dashboard", "tracking": "side", "overhead": "top", "underwater": "water_tank",
                 "boom_up": "crane_up", "boom_down": "crane_down", "track_left": "truck_left", "track_right": "truck_right",
                 "orbit": "orbit_left", "arc": "orbit_left", "locked_off": "static", "zoom_in": "tighter", "zoom_out": "wider",
                 "closer": "push_in" if name == "reframe" else "closer", "up": "higher" if name == "reframe" else "up",
                 "down": "lower" if name == "reframe" else "down"}.get(t, t)
            if t not in extra:
                raise Invalid(f"{name}: '{v}' isn't one of {', '.join(extra)}")
            out[a] = t
        elif typ in ("int", "num"):
            try:
                x = float(re.search(r"-?\d+(?:\.\d+)?", str(v)).group()) if not isinstance(v, (int, float)) else float(v)
            except (AttributeError, ValueError, TypeError):
                n = _int(v)
                if n is None:
                    raise Invalid(f"{name}: '{a}' must be a number") from None
                x = float(n)
            lo, hi = extra or (-1e9, 1e9)
            x = min(max(x, lo), hi)
            out[a] = int(round(x)) if typ == "int" else round(x, 3)
        elif typ in ("name", "person", "vehicle", "seat"):
            obj = O.find_object(work, str(v))
            if obj is None:
                raise Invalid(f"{name}: nothing called '{v}' on set")
            if typ == "person" and obj.get("kind") not in C.PEOPLE:
                ppl = [p for p in _people(work) if str(v).lower() in str(p.get("name", "")).lower()]
                if not ppl:
                    raise Invalid(f"{name}: '{v}' isn't a person")
                obj = ppl[0]
            if typ == "vehicle" and obj.get("kind") not in VEHICLES:
                host = next((x for x in work["actors"] if x["id"] == obj.get("mount_id")), None)
                if host is None or host.get("kind") not in VEHICLES:
                    raise Invalid(f"{name}: '{v}' isn't a vehicle")
                obj = host
            if typ == "seat" and obj.get("kind") not in SEATABLE:
                raise Invalid(f"{name}: can't sit in '{v}'")
            out[a] = obj["name"]
            out[a + "_id"] = obj["id"]
        elif typ == "names":
            g = _group(work, v)
            if not g:
                raise Invalid(f"{name}: nothing called '{v}' on set")
            out[a] = g[0]["name"] if len(g) == 1 else f"{len(g)} {C.LIBRARY.get(g[0]['kind'], {}).get('label', g[0]['kind']).lower()}s"
            out[a + "_ids"] = [x["id"] for x in g]
        elif typ == "place":
            ok, place = _place_ok(work, v)
            if not ok:
                raise Invalid(f"{name}: no place called '{v}'")
            out[a] = place
        elif typ == "shot":
            sid = resolve_shot(v, work, ctx)
            if sid is None:
                raise Invalid(f"{name}: no shot '{v}'")
            out[a] = sid
        elif typ == "shots":
            ids = resolve_shots(v, work, ctx)
            if not ids:
                raise Invalid(f"{name}: no shot '{v}'")
            out[a] = ids
        elif typ == "scene":
            sid = resolve_scene_ref(v, ctx)
            if sid is None:
                raise Invalid(f"{name}: no script scene '{v}'")
            out[a] = sid
    # Tool-level rules.
    if name == "move" and not (out.get("near") or out.get("dir")):
        raise Invalid("move: say where (near something, or left/right/closer/back)")
    if name == "turn" and "face" not in out and "deg" not in out:
        out["deg"] = 180
    if name == "grade" and not any(k in out for k in GRADE_KEYS):
        raise Invalid("grade: say what to change (warmer, more contrast...)")
    if name == "mount" and out.get("target_id") == out.get("on_id"):
        raise Invalid("mount: someone can't sit on themselves")
    if name in ("stunt", "drive", "camera_on") and "target_id" not in out:
        v = _default_vehicle(work)
        if v is None and not (name == "camera_on" and out.get("view") == "off"):
            raise Invalid(f"{name}: there's no vehicle on set")
        if v is not None:
            out["target"], out["target_id"] = v["name"], v["id"]
    if name == "part":
        why = PT.finish(out, work, _default_vehicle)
        if why:
            raise Invalid(why)
    if name == "camera_on":
        out.setdefault("view", "hood")
    if name == "direct" and "who_id" not in out:
        ppl = _people(work)
        if not ppl:
            raise Invalid("direct: there's nobody on set")
        out["who"], out["who_id"] = ppl[0]["name"], ppl[0]["id"]
    if name in ("frames", "render") and "shots" not in out:
        out["shots"] = resolve_shots(None, work, ctx)
    if name == "approve" and "shot" not in out:
        out["shot"] = resolve_shot(None, work, ctx)
    if name == "stack":
        out.setdefault("what", "crate")
        out.setdefault("count", 5)
    if name == "camera_move":
        out.setdefault("speed", "medium")
    t = {"tool": name, "args": out, "kind": spec["kind"], "gpu": bool(spec.get("gpu"))}
    return t


def _default_vehicle(scene):
    vs = _vehicles(scene)
    if not vs:
        return None
    driven = [v for v in vs if any(p.get("mount_id") == v["id"] for p in _people(scene))]
    return (driven or vs)[0]


# ------------------------------------------------------------------------------------------- edit resolution

def _sym(call):
    a, t = call["args"], call["tool"]
    if t == "add":
        return [{"op": "add", "what": a["what"], **({"near": a["near"]} if a.get("near") else {})}]
    if t == "move":
        return [{"op": "move", "target": a["target_id"], **({"near": a["near"]} if a.get("near") else {}),
                 **({"dir": a["dir"]} if a.get("dir") else {}), **({"amount": a["amount"]} if a.get("amount") else {})}]
    if t == "remove":
        return [{"op": "remove", "target": a["target_id"]}]
    if t == "turn":
        return [{"op": "rotate", "target": a["target_id"], **({"face": a["face_id"]} if a.get("face_id") else {"deg": a.get("deg", 180)})}]
    if t == "scale":
        return [{"op": "scale", "target": a["target_id"], "factor": a["factor"]}]
    if t == "time":
        return [{"op": "time", "preset": a["preset"]}]
    if t == "weather":
        return [{"op": "weather", "weather": a["weather"]}]
    if t == "set":
        return [{"op": "set", "set": a["set"]}]
    if t == "light":
        return [{"op": "light", "type": a["type"], **({"on": a["on_id"]} if a.get("on_id") else {})}]
    if t == "add_shot":
        return [{"op": "shot", "setup": a["setup"], **({"on": a["on_id"]} if a.get("on_id") else {}),
                 **({"over": a["over_id"]} if a.get("over_id") else {})}]
    if t == "reframe":
        return [{"op": "camera", "move": a["move"]}]
    return []


STACK_LAYOUT = [(-0.42, 0, 0), (0.42, 0, 0), (0, 0, 0.85), (0, 0.8, 0.0), (-0.85, 0, 0.85), (0.85, 0, 0.85), (-0.42, 0.8, 0.85),
                (0.42, 0.8, 0.85), (0, 1.6, 0.4), (-1.27, 0, 0), (1.27, 0, 0), (0, 0.8, 1.7)]


def _stack_ops(work, call, n_ops):
    """A tight stack: the first crate goes where 'add' puts it (free floor near the place); the rest pile round it."""
    a = call["args"]
    what = a.get("what") or "crate"
    kind = C.resolve_kind(what) or "crate"
    ops1, notes = O.resolve(work, [{"op": "add", "what": kind, **({"near": a["near"]} if a.get("near") else {})}])
    adds = [o for o in ops1 if o["op"] == "add_object"]
    if not adds:
        return [], notes
    base = adds[0]["object"]
    stack_id = f"stack_{base['id']}"
    bx, _, bz = base["position"]
    out = []
    taken = {x["id"] for x in work["actors"]}
    label = C.LIBRARY.get(kind, {}).get("label", kind.title())
    for i in range(int(a.get("count") or 5)):
        dx, dy, dz = STACK_LAYOUT[i % len(STACK_LAYOUT)]
        obj = copy.deepcopy(base)
        k = i + 1
        oid = f"{kind}_{k}"
        while oid in taken:
            k += 1
            oid = f"{kind}_{k}"
        taken.add(oid)
        pos = [round(bx + dx, 3), round(dy, 3), round(bz + dz, 3)]
        obj.update({"id": oid, "name": f"{label} {i + 1}", "position": pos, "keys": [{"frame": 0, "position": pos}],
                    "rotation_deg": (i * 7) % 15 - 7, "stack": stack_id})
        out.append({"op": "add_object", "object": obj, "index": len(work["actors"]) + i, "undo": {"op": "remove_object", "id": oid}})
    return out, notes


# ------------------------------------------------------------------------------------------- plan lines

def _lens_word(mm):
    mm = float(mm)
    if mm < 24:
        return "an ultra-wide lens: big depth, the room stretches"
    if mm < 35:
        return "a wide lens: lots of world around them"
    if mm <= 60:
        return "a normal lens, close to how the eye sees"
    if mm <= 110:
        return "a portrait lens: the background compresses and softens"
    return "a long lens: flattened, voyeuristic, very shallow focus"


MOVE_WORDS = {"push_in": "push in", "pull_out": "pull out", "truck_left": "truck left", "truck_right": "truck right",
              "crane_up": "crane up", "crane_down": "crane down", "orbit_left": "orbit left", "orbit_right": "orbit right",
              "static": "lock off (static)"}


def shot_label(sid, scene, ctx):
    shots = _shot_list(scene, ctx)
    for i, s in enumerate(shots):
        if s["id"] == sid:
            return f"shot {i + 1} ({s.get('name', sid)})"
    return sid


def plan_line(call, work, ctx):
    """'I'll ...' in plain film language."""
    a, t = call["args"], call["tool"]
    sl = lambda sid: shot_label(sid, work, ctx)  # noqa: E731
    shots = lambda ids: ", ".join(sl(s) for s in ids) if len(ids) <= 3 else f"{len(ids)} shots"  # noqa: E731
    lines = {
        "add": lambda: f"put a {a['what']} on set" + (f" by the {a['near']}" if a.get("near") else ""),
        "stack": lambda: f"stack {a['count']} {a['what']}s" + (f" by the {a['near']}" if a.get("near") else ""),
        "move": lambda: f"move {a['target']} " + (f"next to the {a['near']}" if a.get("near") else f"{a['dir']}" + (f" {a['amount']} m" if a.get("amount") else "")),
        "remove": lambda: f"strike {a['target']} from the set",
        "turn": lambda: f"turn {a['target']} " + (f"to face {a['face']}" if a.get("face") else f"{a.get('deg', 180):g}°"),
        "scale": lambda: f"make {a['target']} {'bigger' if a['factor'] > 1 else 'smaller'} (x{a['factor']:g})",
        "time": lambda: f"move the clock to {C.TIME_PRESETS[a['preset']]['label'].lower()}",
        "weather": lambda: "clear the weather" if a["weather"] == "none" else f"bring in {a['weather']}",
        "set": lambda: f"move us to the {a['set'].replace('_', ' ')} set",
        "light": lambda: f"add a {C.LIGHT_TYPES[a['type']]['label'].lower()} light" + (f" on {a['on']}" if a.get("on") else ""),
        "add_shot": lambda: f"add a {a['setup'].replace('_', ' ')} setup" + (f" on {a['on']}" if a.get("on") else ""),
        "reframe": lambda: f"nudge the camera: {a['move'].replace('_', ' ')}",
        "mount": lambda: f"put {a['target']} in the {a['on'].lower()}" if a.get("on") else "",
        "dismount": lambda: f"get {a['target']} out",
        "select_shot": lambda: f"go to {sl(a['shot'])}",
        "lens": lambda: f"put on a {a['mm']:g} mm: {_lens_word(a['mm'])}",
        "camera_move": lambda: f"make it a {a['speed']} {MOVE_WORDS[a['move']]}",
        "rig": lambda: "go handheld" if a["type"] == "handheld" else "free the camera (keys as set)" if a["type"] == "free" else f"put the camera on a {a['type']}",
        "camera_on": lambda: "take the camera off the vehicle" if a["view"] == "off" else
                             f"rig the camera on the {a['target'].lower()}: {a['view'].replace('_', ' ')} view",
        "stunt": lambda: f"give the {a['target'].lower()} the {STUNTS[a['stunt']]} stunt" if a["stunt"] != "none" else f"clear the {a['target'].lower()}'s stunt",
        "drive": lambda: f"drive the {a['target'].lower()} straight through the {a['through'].lower()}",
        "physics": lambda: f"make the {a['target'].lower()} {a['mode']}",
        "bake": lambda: "simulate the physics and bake it into the shot",
        "direct": lambda: f"note for {a['who']}: {a['note']} (it goes into the frame prompt)",
        "grade": lambda: "grade the frames " + ", ".join(
            f"{'warmer' if k == 'warmth' and v > 0 else 'cooler' if k == 'warmth' else ('more ' if v > 0 else 'less ') + k} ({v:+.2f})"
            for k, v in a.items() if k in GRADE_KEYS),
        "scene": lambda: f"go to scene {next((s.get('number') for s in (ctx or {}).get('scenes', []) if s.get('id') == a['scene']), a['scene'])}",
        "frames": lambda: f"paint {a.get('count', 2)} first-frame option{'s' if a.get('count', 2) != 1 else ''} for {shots(a['shots'])} (GPU, about 6-10 s each warm)",
        "render": lambda: f"render a {a['kind']} of {shots(a['shots'])} (GPU, {'about 2-4 min' if a['kind'] == 'draft' else 'about 4-6 min'} each)",
        "approve": lambda: f"mark {sl(a['shot'])}'s current take {a['status']}" + (f": {a['note']}" if a.get("note") else ""),
        "cut": lambda: "cut the scene together with each shot's best take",
        "play": lambda: "play the shot",
        "undo": lambda: "undo the last change",
        "build": lambda: f"build a new scene: {a['text']}",
        "part": lambda: PT.plan_words(a),
    }
    try:
        return "I'll " + lines[t]()
    except (KeyError, TypeError, ValueError):
        return f"I'll run {t}"


# ------------------------------------------------------------------------------------------- the prompt

def _tool_line(name, t):
    parts = []
    for a, (typ, req, extra) in t["args"].items():
        if typ == "enum":
            val = "|".join(f'"{x}"' for x in extra)
        elif typ in ("int", "num"):
            val = "NUMBER"
        elif typ in ("shot",):
            val = "SHOT_NUMBER"
        elif typ == "shots":
            val = '[SHOT_NUMBERS] or "all"'
        elif typ == "scene":
            val = "SCENE_NUMBER"
        elif typ == "text":
            val = "TEXT"
        else:
            val = "NAME"
        parts.append(f'"{a}":{val}' + ("" if req else "?"))
    body = ",".join([f'"tool":"{name}"'] + parts)
    return "{" + body + "}  " + t["doc"]


SYSTEM_HEAD = """You are the assistant director on a 3D film set. Turn the director's words into tool calls, in order.
Answer with ONLY {"calls":[...]}, no prose. Use names from the scene list, never coordinates. Shots are numbers (1 = first
in the strip). Leave out optional fields you don't need ("?" = optional). Renders and frames only when asked.
Tools:"""
SYSTEM_EXAMPLE = """Example
Command: put Mara in the car at night and make shot 2 a slow push-in at 50mm, she's scared
{"calls":[{"tool":"mount","target":"Mara","on":"car"},{"tool":"time","preset":"night"},{"tool":"select_shot","shot":2},{"tool":"camera_move","move":"push_in","speed":"slow"},{"tool":"lens","mm":50},{"tool":"direct","who":"Mara","note":"scared"}]}"""
DIRECTOR_SYSTEM = SYSTEM_HEAD + "\n" + "\n".join(_tool_line(n, t) for n, t in TOOLS.items()) + "\n" + SYSTEM_EXAMPLE
MAX_LENGTH = 280


def context_text(scene: dict, ctx: dict) -> str:
    env, L = scene.get("environment", {}), scene.get("lighting", {})
    lines = [f"Set: {env.get('set')}, time: {L.get('preset') or 'manual'}, weather: {env.get('weather', 'none')}"]
    items = []
    for a in scene.get("actors", [])[:20]:
        k = a.get("kind")
        what = (a.get("design") or (a.get("recipe") or {}).get("name") or "object") if k == "custom" else k.replace("_", " ")
        extra = ""
        if a.get("mount_id"):
            host = next((x for x in scene["actors"] if x["id"] == a["mount_id"]), None)
            extra = f", in {host['name']}" if host else ""
        items.append(f"{a.get('name')} ({what}{extra})")
    lines.append("On set: " + (", ".join(items) or "nothing"))
    shots = _shot_list(scene, ctx)
    if shots:
        act = scene.get("active_shot")
        lines.append("Shots: " + ", ".join(f"{i + 1}={s.get('name', s['id'])}" + ("*" if s["id"] == act else "") for i, s in enumerate(shots[:8])))
    scenes = (ctx or {}).get("scenes") or []
    if scenes:
        lines.append("Script scenes: " + ", ".join(f"{s.get('number')}={str(s.get('heading', ''))[:40]}" for s in scenes[:8]))
    # The Director's Book (Milestone 23, web/book getBookContext): the scene's intent, style and the director's rules.
    book = (ctx or {}).get("book")
    if isinstance(book, dict) and str(book.get("text") or "").strip():
        lines.append("Director's book (follow it):\n" + str(book["text"])[:900])
    return "\n".join(lines)


def prompt(command: str, scene: dict, ctx: dict | None = None) -> dict:
    s = normalize_scene(scene)
    return {"system": DIRECTOR_SYSTEM, "prompt": f"{context_text(s, ctx or {})}\nCommand: {str(command or '').strip()}",
            "max_length": MAX_LENGTH}


def parse_llm(text: str) -> list[dict]:
    t = re.sub(r"^```(?:json)?|```$", "", str(text or "").strip(), flags=re.M).strip()
    try:
        raw = json.loads(t)
    except ValueError:
        raw = P.extract_json(text or "")
    if isinstance(raw, dict):
        for k in ("calls", "tools", "tool_calls", "actions", "steps"):
            if isinstance(raw.get(k), list):
                raw = raw[k]
                break
        else:
            raw = [raw] if (raw.get("tool") or raw.get("name") or raw.get("op")) else []
    if not isinstance(raw, list):
        return []
    out = []
    for c in raw:
        if isinstance(c, dict) and isinstance(c.get("function"), dict):   # OpenAI style
            f = c["function"]
            args = f.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            c = {"tool": f.get("name"), **(args or {})}
        if isinstance(c, dict):
            out.append(c)
    return out[:16]


# ------------------------------------------------------------------------------------------- rules

EMOTIONS = ["nervous", "scared", "afraid", "terrified", "frightened", "anxious", "angry", "furious", "sad", "happy", "joyful",
            "tired", "exhausted", "calm", "confident", "determined", "desperate", "bored", "excited", "shocked", "surprised",
            "suspicious", "worried", "relieved", "panicked", "grim", "cold", "tense", "heartbroken", "defiant", "smug",
            "focused", "lost", "hopeful", "jittery", "on edge", "in a hurry", "drunk", "crying", "laughing", "smiling"]
GO_RE = re.compile(r"(?:^|[,.;!:]\s*|\b(?:and|then|so|just)\s+)go(?:\s+ahead|\s+for\s+it)?\s*(?:[,.;!]|$)|\bgo ahead\b|"
                   r"\bwithout asking\b|\bno need to (?:ask|confirm)\b|\bdon'?t ask\b", re.I)
WORDNUM = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)"


def wants_go(command: str) -> bool:
    return bool(GO_RE.search(command or ""))


def _shots_in(t: str):
    """Shot references in a clause: 'shots 1 to 3' -> '1-3', 'shot 2' -> '2', 'all shots' -> 'all', else None."""
    if re.search(r"\b(all|every|each)( the| of the)? (shots|shot|angles|setups)\b|\bwhole scene\b|\beverything\b", t):
        return "all"
    m = re.search(rf"\bshots?\s+({WORDNUM})\s*(?:-|to|through|thru|–)\s*({WORDNUM})\b", t)
    if m:
        return f"{_int(m.group(1))}-{_int(m.group(2))}"
    m = re.search(rf"\bshots?\s+({WORDNUM}(?:\s*(?:,|and|&)\s*{WORDNUM})+)\b", t)
    if m:
        return [_int(x) for x in re.findall(rf"{WORDNUM}", m.group(1))]
    m = re.search(rf"\bshot\s+({WORDNUM})\b|\b(first|second|third|fourth|fifth|last)\s+shot\b", t)
    if m:
        return "last" if m.group(2) == "last" else _int(m.group(1) or m.group(2))
    return None


def _named_shot(t, scene, ctx):
    """'the crane shot' / 'on the tracking angle' -> a shot id by its name."""
    m = re.search(r"\b(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)\s+(?:shot|angle|cam)\b", t)
    if not m:
        return None
    words = [w for w in m.group(1).split() if w not in ("the", "a", "this", "that", "next", "first", "second", "third", "last", "same")]
    if not words:
        return None
    for s in _shot_list(scene, ctx):
        name = set(re.findall(r"[a-z]+", str(s.get("name", "")).lower()))
        if all(w in name for w in words):
            return s["id"]
    return None


HEARD = [(r"\bshots? (to|too)\b", lambda m: m.group(0).split()[0] + " two"), (r"\bshot (won)\b", lambda m: "shot one"),
         (r"\b(?:j|jay)[ -]?turn\b", lambda m: "J-turn"), (r"\bpush in\b", lambda m: "push-in"),
         (r"\bmillimeters?\b|\bmillimetres?\b", lambda m: "mm"), (r"\bhood\.?\s*$", lambda m: "hood")]


def hear(command: str) -> str:
    """Tidy a voice transcript (Whisper / the browser) before the rules read it: "shot to" -> "shot two"."""
    t = str(command or "").strip()
    for pat, rep in HEARD:
        t = re.sub(pat, rep, t, flags=re.I)
    return t


def _split(command: str) -> list[str]:
    t = command.strip().rstrip(".!?")
    parts = re.split(r"\s*(?:[;,]|\.\s+|\bthen\b|(?<!\d)\s+and\s+(?!\d)(?!then))\s*", t)
    return [p.strip() for p in parts if p and p.strip()]


def rules_calls(command: str, scene: dict, ctx: dict | None = None) -> list[dict]:
    """Best-effort calls without a model. Knows the App's own verbs (stunts, renders, the cut, camera rigs, moves)
    and falls back to the Scene agent's edit rules (ops.rules_ops) for everything else."""
    ctx = ctx or {}
    work = normalize_scene(scene)
    text = hear(command)
    low = text.lower()
    calls: list[dict] = []
    m = re.match(r"^\s*(?:new scene|build (?:me )?(?:a |the )?(?:new )?scene|start over(?: with)?|set up a scene)\s*[:,-]?\s*(.+)$", low)
    if m and len(m.group(1)) > 3:
        return [{"tool": "build", "text": text[m.start(1):].strip()}]
    if re.match(r"^\s*(undo|take that back|revert that|go back one)\b", low):
        return [{"tool": "undo"}]
    last_person = None
    last_obj = None
    people = _people(work)
    for cl_raw in _split(text):
        cl = cl_raw.lower().strip()
        cl = re.sub(r"^(?:please|ok(?:ay)?|now|also|and|so|can you|could you|let'?s|i want(?: to)?|i'?d like(?: to)?)\s+", "", cl)
        here: list[tuple[int, dict]] = []
        used = False
        # Pronouns refer back.
        for p in people:
            nm = str(p.get("name", "")).lower()
            if nm and re.search(rf"\b{re.escape(nm.split()[0])}\b", cl):
                last_person = p
        # Renders, frames, the cut, approvals: whole-clause verbs.
        if re.search(r"\b(cut (?:it|them|this|the scene|everything|the shots)?\s*together|assemble|edit (?:it |them )?together|make (?:the|a) cut|rough cut|join (?:the )?(?:shots|takes|clips))\b", cl):
            calls.append({"tool": "cut"})
            continue
        grade = {}
        for pat, k, v in [(r"\bwarm(?:er)?\b", "warmth", 0.25), (r"\b(?:cool(?:er)?|cold(?:er)?|bluer)\b", "warmth", -0.25),
                          (r"\b(?:more contrast|punchier|contrasty|harder)\b", "contrast", 0.25), (r"\b(?:less contrast|flatter|softer contrast)\b", "contrast", -0.25),
                          (r"\b(?:more saturated|more colou?r|richer|saturate)\b", "saturation", 0.25), (r"\b(?:desaturated?|less colou?r|muted|washed out)\b", "saturation", -0.25),
                          (r"\b(?:grainier|more grain|grainy|film grain)\b", "grain", 0.3), (r"\b(?:less grain|cleaner)\b", "grain", -0.3),
                          (r"\bvignette\b", "vignette", 0.3), (r"\bhalation\b", "halation", 0.3)]:
            if re.search(pat, cl) and re.search(r"\b(frame|frames|look|grade|image|picture|colou?r|shot|it|everything|still)\b|^make\b|^more\b|^less\b|^a bit\b|er\b", cl) \
                    and not re.search(r"\blight\b", cl):
                if re.search(r"\b(a lot|much|way|very)\b", cl):
                    v *= 2
                if re.search(r"\b(a (?:little )?bit|slightly|a touch|touch)\b", cl):
                    v /= 2
                grade[k] = round(v, 3)
        if grade:
            calls.append({"tool": "grade", **grade})
            continue
        m = re.search(r"\b(render|make|do|run|queue|shoot)\b.*?\b(draft|final|preview)s?\b|\b(draft|final)s?\s+(?:of|for)\b", cl)
        if m:
            kind = (m.group(2) or m.group(3))
            kind = "draft" if kind in ("draft", "preview") else "final"
            sh = _shots_in(cl) or _named_shot(cl, work, ctx)
            calls.append({"tool": "render", "kind": kind, **({"shots": sh} if sh is not None else {})})
            continue
        m = re.search(r"\b(paint|generate|make|create|render|give me)\s+(?:me\s+)?(?:a\s+|the\s+|new\s+|some\s+|more\s+|(" + WORDNUM + r")\s+)?(?:new\s+)?(?:first[- ]?)?(frames?|stills?|keyframes?|variations?|options?)\b", cl)
        if m:
            sh = _shots_in(cl) or _named_shot(cl, work, ctx)
            n = _int(m.group(2)) if m.group(2) else None
            calls.append({"tool": "frames", **({"shots": sh} if sh is not None else {}), **({"count": n} if n else {})})
            continue
        m = re.search(r"\b(approve|approved|circle|print (?:it|that)|that'?s a print|reject|kill|needs? (?:some )?changes?|redo)\b", cl)
        if m and re.search(r"\b(shot|take|it|that|this)\b", cl):
            w = m.group(1)
            status = "rejected" if w in ("reject", "kill") else "changes" if ("change" in w or w == "redo") else "approved"
            sh = _shots_in(cl) or _named_shot(cl, work, ctx)
            note = re.search(r"(?:changes?|redo)\s*[:\-]\s*(.+)$", cl_raw)
            calls.append({"tool": "approve", "status": status, **({"shot": sh} if sh is not None else {}),
                          **({"note": note.group(1)} if note else {})})
            continue
        m = re.search(r"\b(?:go to|switch to|open|jump to|move to|on to|onto)?\s*\bscene\s+(\d+[a-z]?)\b", cl)
        if m:
            calls.append({"tool": "scene", "scene": m.group(1)})
            continue
        if re.search(r"\b(bake|simulate|run)\b.*\bphysics\b|^\s*simulate\b|\bbake it\b", cl):
            calls.append({"tool": "bake"})
            continue
        if re.fullmatch(r"(?:play|play it|play the shot|play it back|show me|roll it|run it|playback)(?: again)?", cl.strip()):
            calls.append({"tool": "play"})
            continue
        # Shot selection leads the clause ("make shot 2 a slow push-in").
        sh = _shots_in(cl)
        sid_named = None if sh is not None else _named_shot(cl, work, ctx)
        if sh is not None and sh != "all" and not isinstance(sh, list) and not str(sh).count("-"):
            here.append((-1, {"tool": "select_shot", "shot": sh}))
            sid = resolve_shot(sh, work, ctx)
            if sid:
                work["active_shot"] = sid
        elif sid_named:
            here.append((-1, {"tool": "select_shot", "shot": sid_named}))
            work["active_shot"] = sid_named
        # Stunts.
        m = re.search(r"\b(?:reverse\s+)?j[- ]?turn\b|\bdonuts?\b|\bdoughnuts?\b|\bhandbrake(?: turn| 180)?\b|\bbootleg(?:ger)?(?: turn)?\b|\b180 slide\b|\b(?:no|clear the|remove the) stunt\b", cl)
        if m:
            w = m.group(0)
            st = "none" if "stunt" in w and re.search(r"no|clear|remove", w) else "reverse_jturn" if "turn" in w and "j" in w else \
                "donut" if "donut" in w or "doughnut" in w else "handbrake_180"
            veh = _vehicle_in(cl, work)
            here.append((m.start(), {"tool": "stunt", "stunt": st, **({"target": veh["name"]} if veh else {})}))
            used = True
        # Camera rigged on a vehicle.
        m = re.search(r"\b(?:camera|cam)\s+(?:on|in|inside|mounted on|rigged on|on top of)\s+(?:the\s+)?(hood|bonnet|dash(?:board)?|back seat|passenger seat|windshield|windscreen|car|roof)\b|\b(hood|bonnet)\s*(?:mount|cam|camera)\b|\bdriver'?s?\s+pov\b|\b(?:tracking|side)\s+(?:mount|alongside)\b|\b(?:camera off the (?:car|vehicle))\b", cl)
        if m:
            w = m.group(0)
            view = "off" if "off the" in w else "driver_pov" if "pov" in w else "dashboard" if "dash" in w else \
                "back_seat" if "back seat" in w else "passenger" if "passenger" in w else "side" if ("tracking" in w or "side" in w) else \
                "top" if "roof" in w else "hood"
            veh = _vehicle_in(cl, work) or (next((x for x in work["actors"] if last_person and x["id"] == last_person.get("mount_id")), None))
            here.append((m.start(), {"tool": "camera_on", "view": view, **({"target": veh["name"]} if veh else {})}))
            used = True
        # Mount: put Mara in the sports car / Mara drives the car.
        m = re.search(r"\b(?:put|place|get|seat|sit|have|let)\s+(.+?)\s+(?:in|into|inside|on|onto|behind the wheel of|at the wheel of|in the driver'?s seat of)\s+(?:the\s+|a\s+|her\s+|his\s+|their\s+)?(.+)$", cl) \
            or re.search(r"\b([a-z][a-z ]*?)\s+(?:drives|is driving|rides|is riding|gets in(?:to)?|climbs in(?:to)?|sits in)\s+(?:the\s+|a\s+|her\s+|his\s+)?(.+)$", cl)
        if m and not used:
            who = O.find_object(work, m.group(1))
            host_text = re.split(r"\s+(?:at|during|with|by|while|for)\b", m.group(2))[0].strip()
            host = O.find_object(work, host_text, exclude=(who["id"],) if who else ())
            if who is not None and who.get("kind") in C.PEOPLE:
                last_person = who
                if host is not None and host.get("kind") in SEATABLE:
                    here.append((m.start(), {"tool": "mount", "target": who["name"], "on": host["name"]}))
                    used = True
                elif C.resolve_kind(host_text) in SEATABLE:
                    here.append((m.start(), {"tool": "add", "what": host_text}))
                    here.append((m.start() + 1, {"tool": "mount", "target": who["name"], "on": host_text}))
                    used = True
                rest = m.group(2)[len(host_text):]
                if used and rest:
                    cl = cl[:m.start()] + " " + rest   # "... at night" still counts below
        # Performance notes: "she's nervous", "Mara looks scared".
        emo = "|".join(re.escape(e) for e in EMOTIONS)
        m = re.search(rf"\b([a-z]+)(?:'s|’s| is| looks| seems| feels| gets| getting| acts| sounds| are| was)\s+(?:a (?:little|bit) |very |really |so |quite |more )?({emo})\b", cl) \
            or re.search(rf"\bmake\s+([a-z]+)\s+(?:look\s+|more\s+)?({emo})\b", cl)
        if m:
            w = m.group(1)
            who = last_person if w in ("she", "he", "they", "her", "him", "them") else O.find_object(work, w)
            if who is None and w in ("she", "her"):
                who = next((p for p in people if p.get("kind") == "woman"), None)
            if who is None and w in ("he", "him"):
                who = next((p for p in people if p.get("kind") == "man"), None)
            if who is not None and who.get("kind") in C.PEOPLE:
                here.append((m.start(), {"tool": "direct", "who": who["name"], "note": m.group(2)}))
                used = True
        # Stack of crates.
        m = re.search(r"\b(?:(crate|box|barrel|tyre|tire|pallet)e?s?\s+(?:stack|pile|tower|wall)|(?:stack|pile|tower|wall) of\s+(?:(" + WORDNUM + r")\s+)?(crate|box|barrel|tyre|tire|pallet)e?s?)\b", cl)
        if m:
            what = m.group(1) or m.group(3)
            near = re.search(r"\b(?:by|near|next to|against|beside|at|in front of|behind)\s+(?:the\s+)?(.+)$", cl[m.end():])
            n = _int(m.group(2)) if m.group(2) else None
            here.append((m.start(), {"tool": "stack", "what": what, **({"near": near.group(1)} if near else {}), **({"count": n} if n else {})}))
            last_obj = "__stack__"
            used = True
        # Drive / crash through.
        m = re.search(r"\b(crash(?:es)?|smash(?:es)?|plow(?:s)?|plough(?:s)?|drive(?:s)?|ram(?:s)?|burst(?:s)?|barrel(?:s)?|go(?:es)?|plunge(?:s)?)\s+(?:right\s+|straight\s+)?(?:through|into)\s+(?:the\s+)?(.+)$", cl)
        if m:
            obj = m.group(2).strip()
            obj = re.sub(r"\b(stack|pile)\b", "", obj).strip() or obj
            if obj in ("it", "them", "that", "those", "this") and last_obj:
                obj = last_obj
            veh = _vehicle_in(cl[:m.start()], work)
            crash = m.group(1)[:3] in ("cra", "sma", "plo", "ram", "bur", "bar", "plu")
            if crash:
                here.append((m.start(), {"tool": "physics", "target": obj, "mode": "dynamic"}))
            here.append((m.start() + 1, {"tool": "drive", "through": obj, **({"target": veh["name"]} if veh else {}),
                                         "speed": "fast" if crash else "medium"}))
            if crash:
                here.append((m.start() + 2, {"tool": "bake"}))
            used = True
        # Lens.
        m = re.search(r"\b(\d{2,3})\s*(?:mm|millimet(?:er|re)s?)\b", cl)
        if m:
            here.append((m.start(), {"tool": "lens", "mm": int(m.group(1))}))
            used = True
        else:
            m = re.search(r"\b(wide(?:[- ]angle)? lens|wider lens|long lens|longer lens|telephoto|normal lens|portrait lens|fisheye)\b", cl)
            if m:
                w = m.group(1)
                here.append((m.start(), {"tool": "lens", "mm": 18 if "fish" in w else 24 if "wide" in w else 50 if "normal" in w else 85 if "portrait" in w else 100}))
                used = True
        # Animated camera moves.
        m = re.search(r"\b(?:(slow|slowly|gentle|gently|creeping|quick|quickly|fast|rapid|snap)\s+)?(?:a\s+)?(?:(slow|quick|fast)\s+)?(push[- ]?in|push (?:in|forward)|dolly[- ]in|creep(?: in)?|pull[- ]?(?:out|back)|dolly[- ]out|crane[- ]up|boom[- ]up|jib[- ]up|crane[- ]down|boom[- ]down|orbit(?: left| right)?|arc(?: left| right)?|truck(?: left| right)|track(?:ing)? (?:left|right)|locked[- ]off|lock (?:it )?off|static)\b", cl)
        if m:
            sp = m.group(1) or m.group(2) or ""
            speed = "slow" if sp.startswith(("slow", "gentl", "creep")) or "creep" in m.group(3) else "fast" if sp in ("quick", "quickly", "fast", "rapid", "snap") else "medium"
            w = m.group(3).replace("-", " ")
            mv = "push_in" if ("push" in w or "dolly in" in w or "creep" in w) else "pull_out" if ("pull" in w or "dolly out" in w) else \
                "crane_up" if re.search(r"(crane|boom|jib) up", w) else "crane_down" if re.search(r"(crane|boom|jib) down", w) else \
                "orbit_right" if ("orbit right" in w or "arc right" in w) else "orbit_left" if ("orbit" in w or "arc" in w) else \
                "truck_right" if "right" in w else "truck_left" if "left" in w else "static"
            here.append((m.start(), {"tool": "camera_move", "move": mv, "speed": speed}))
            used = True
        m = re.search(r"\b(?:on\s+(?:a\s+)?|use\s+(?:a\s+)?|go\s+)(dolly|steadicam|drone|tripod|jib|crane arm|slider|chapman)\b|\b(handheld|hand-held)\b", cl)
        if m:
            here.append((m.start(), {"tool": "rig", "type": (m.group(1) or m.group(2)).replace("crane arm", "jib").replace("hand-held", "handheld")}))
            used = True
        # Parts (Milestone 26): "open the driver's door at 2 s", "turn on the police lights", "the horse throws its head up".
        part_calls = PT.rules(cl, work, last_person)
        if part_calls:
            here += [(40 + i, c) for i, c in enumerate(part_calls)]
            used = True
        # Time and weather anywhere in the clause ("at night", "rain").
        tod = P.pick(C.TIME_WORDS, cl, None)
        if tod and not re.search(r"\b(daylight|day for night|days?)\b.*\blight\b", cl):
            here.append((99, {"tool": "time", "preset": tod}))
            used = True
        if re.search(r"\b(no|stop the|clear the|without) (rain|snow|fog|weather|smoke|dust)\b|\bclear (skies|weather)\b", cl):
            here.append((99, {"tool": "weather", "weather": "none"}))
            used = True
        else:
            wx = P.pick(C.WEATHER_WORDS, cl, None)
            if wx and not (wx == "dust" and "dusty" not in cl and "dust" not in cl):
                here.append((99, {"tool": "weather", "weather": wx}))
                used = True
        if not used and not (here and here[0][1]["tool"] == "select_shot" and len(here) == 1 and re.fullmatch(r".*\bshot\s+\w+\s*", cl)):
            # The Scene agent's own rules for everything else (add, move, remove, turn, lights, coverage, reframes).
            for so in O.rules_ops(cl, work):
                c = _from_sym(so)
                if c:
                    here.append((50, c))
                    if c["tool"] == "add":
                        last_obj = c.get("what")
        here.sort(key=lambda x: x[0])
        calls += [c for _, c in here]
    return calls


def _vehicle_in(t, scene):
    for v in _vehicles(scene):
        words = set(re.findall(r"[a-z]+", str(v.get("name", "")).lower())) | {v["kind"].replace("_", " "), v["kind"].split("_")[0]}
        if any(re.search(rf"\b{re.escape(w)}\b", t) for w in words if w and w not in ("car",)):
            return v
    if re.search(r"\b(car|vehicle|truck|bike|motorcycle)\b", t):
        return _default_vehicle(scene)
    return None


def _from_sym(so: dict) -> dict | None:
    op = so.get("op")
    m = {"add": lambda: {"tool": "add", "what": so.get("what"), **({"near": so["near"]} if so.get("near") else {})},
         "move": lambda: {"tool": "move", "target": so.get("target"), **{k: so[k] for k in ("near", "dir", "amount") if so.get(k) is not None}},
         "remove": lambda: {"tool": "remove", "target": so.get("target")},
         "rotate": lambda: {"tool": "turn", "target": so.get("target"), **{k: so[k] for k in ("face", "deg") if so.get(k) is not None}},
         "scale": lambda: {"tool": "scale", "target": so.get("target"), "factor": so.get("factor")},
         "time": lambda: {"tool": "time", "preset": so.get("preset")},
         "weather": lambda: {"tool": "weather", "weather": so.get("weather")},
         "set": lambda: {"tool": "set", "set": so.get("set")},
         "light": lambda: {"tool": "light", "type": so.get("type"), **({"on": so["on"]} if so.get("on") else {})},
         "shot": lambda: {"tool": "add_shot", "setup": so.get("setup"), **{k: so[k] for k in ("on", "over") if so.get(k)}},
         "camera": lambda: ({"tool": "lens", "mm": so["focal"]} if so.get("focal") and not so.get("move") else {"tool": "reframe", "move": so.get("move")}),
         "mount": lambda: {"tool": "mount", "target": so.get("target"), "on": so.get("on")},
         "dismount": lambda: {"tool": "dismount", "target": so.get("target")}}
    f = m.get(op)
    return f() if f else None


# ------------------------------------------------------------------------------------------- plan

def _apply_calls(raw_calls, scene, ctx):
    """Validate in order against a working scene (edits applied as we go). -> (calls, rejected, notes, work)."""
    work = normalize_scene(scene)
    out, rejected, notes = [], [], []
    n_ops = 0
    for raw in raw_calls:
        try:
            c = validate_call(raw, work, ctx)
        except Invalid as e:
            rejected.append({"call": raw, "why": str(e)})
            continue
        same = {"time": lambda: (work.get("lighting") or {}).get("preset") == c["args"].get("preset"),
                "weather": lambda: (work.get("environment") or {}).get("weather", "none") == c["args"].get("weather"),
                "set": lambda: (work.get("environment") or {}).get("set") == c["args"].get("set")}.get(c["tool"])
        if same and same():
            # A small model echoes the scene list back ("set street_night" on a J-turn): a no-op never runs.
            notes.append(f"already {c['args'].get('preset') or c['args'].get('weather') or c['args'].get('set')}")
            continue
        if c["kind"] == "edit":
            if c["tool"] == "stack":
                ops, n = _stack_ops(work, c, n_ops)
            else:
                ops, n = O.resolve(work, _sym(c))
            if not ops:
                rejected.append({"call": raw, "why": "; ".join(n) or f"{c['tool']}: nothing to change"})
                continue
            notes += n
            c["ops"] = ops
            n_ops += len(ops)
            work = O.apply_ops(work, ops)
        elif c["tool"] == "select_shot":
            work["active_shot"] = c["args"]["shot"]
        elif c["tool"] == "mount":
            for a in work["actors"]:
                if a["id"] == c["args"]["target_id"]:
                    a["mount_id"] = c["args"]["on_id"]
        c["plan"] = plan_line(c, work, ctx)
        out.append(c)
    return out, rejected, notes, work


def _score(calls, rejected):
    return len(calls) - 0.5 * len(rejected)


EXACT_TOOLS = ("render", "frames", "cut", "approve", "stunt", "scene", "lens", "select_shot")


def plan(command: str, scene: dict, ctx: dict | None = None, llm_text: str | None = None) -> dict:
    ctx = ctx or {}
    command = str(command or "").strip()
    r_raw = rules_calls(command, scene, ctx)
    r_calls, r_rej, r_notes, _ = _apply_calls(r_raw, scene, ctx)
    chosen = (r_calls, r_rej, r_notes, "rules")
    if llm_text and llm_text.strip():
        l_raw = parse_llm(llm_text)
        if l_raw:
            # The rules read numbers and the App's own verbs exactly: where both name the same tool, use the rules' args.
            r_by = {}
            for c in r_raw:
                n = _norm_call(c)
                if n and n["tool"] in EXACT_TOOLS:
                    r_by.setdefault(n["tool"], c)
            l_fixed = [r_by.get((_norm_call(c) or {}).get("tool"), c) for c in l_raw]
            l_calls, l_rej, l_notes, _ = _apply_calls(l_fixed, scene, ctx)
            r_tools = sorted(c["tool"] for c in r_calls)
            l_tools = [c["tool"] for c in l_calls]
            covers = all(l_tools.count(t) >= r_tools.count(t) for t in set(r_tools))
            if l_calls and (covers or not r_calls) and _score(l_calls, l_rej) >= _score(r_calls, r_rej) - 0.01:
                chosen = (l_calls, l_rej, l_notes, "llm")
            else:
                chosen = (r_calls, r_rej, r_notes + ([f"model plan skipped ({len(l_calls)} usable, rules covered more)"] if l_calls else []), "rules")
        else:
            chosen = (r_calls, r_rej, r_notes + ["model answer unreadable"], "rules (llm unreadable)")
    calls, rejected, notes, backend = chosen
    gpu = [c for c in calls if c["gpu"]]
    confirm = bool(gpu) and not wants_go(command)
    summary = "; ".join(c["plan"][5:] if c["plan"].startswith("I'll ") else c["plan"] for c in calls) or "nothing I can do with that yet"
    return {"calls": calls, "plan": [c["plan"] for c in calls], "confirm": confirm, "gpu": len(gpu), "notes": notes,
            "rejected": rejected, "backend": backend, "summary": summary, "command": command}


def run_calls(calls: list, scene: dict, ctx: dict | None = None) -> dict:
    """Typed calls straight from a client (MCP, tests): validate and plan them without any language step."""
    ctx = ctx or {}
    out, rejected, notes, _ = _apply_calls(calls or [], scene, ctx)
    gpu = [c for c in out if c["gpu"]]
    return {"calls": out, "plan": [c["plan"] for c in out], "confirm": bool(gpu), "gpu": len(gpu), "notes": notes,
            "rejected": rejected, "backend": "typed", "summary": "; ".join(c["plan"][5:] for c in out) or "nothing to do"}
