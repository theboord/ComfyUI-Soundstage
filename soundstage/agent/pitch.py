"""Pitch Mode (Milestone 22): a director talks, the set builds itself, a sketch per beat.

The browser (web/agent/pitch.mjs) cuts the live transcript into beats (a sentence or a clause) and posts each one with
the current scene and the pitch *memory* (what has been said so far). This module:

  extract(text, memory)            -> delta: only what this beat adds (set, time, weather, a character, wardrobe,
                                      an action, a passing car, props, camera height / rig / follow / lens)
  parse_llm_delta(text)            -> the same delta from the local model's JSON (optional refinement)
  merge_delta(rules, llm)          -> rules win where both speak; the model fills what the rules missed
  merge_memory(memory, delta)      -> the pitch so far (pure; later beats override, pronouns resolve to the last person)
  beat_ops(delta, memory, scene)   -> concrete, undoable scene ops (soundstage/agent/ops.py format), so the browser
                                      applies them with the Scene agent's applyOps and undo is exact
  sketch_prompt(memory, delta)     -> the FLUX 3 Klein prompt for this beat's storyboard frame
  sketch_graph / motion_graph      -> small API graphs (Klein edit on the stage capture, a one-pass LTX draft), weights
                                      resolved from the router registry

Nothing here is destructive: every op carries its undo, and the whole pitch is one Director undo step in the App.
"""
from __future__ import annotations

import copy
import json
import math
import re

from . import catalog as C
from . import plan as P
from . import space as S
from .build import make_object

# ------------------------------------------------------------------------------------------- vocabulary

PLACE_SETS = [  # (words, set): first hit wins, so the specific places come first
    (("alley", "alleyway", "chinatown", "street", "road", "downtown", "avenue", "sidewalk", "city", "parking lot",
      "back street", "crossroads", "intersection"), "street_night"),
    (("bar", "room", "office", "kitchen", "apartment", "diner", "hallway", "corridor", "bedroom", "living room",
      "warehouse", "restaurant", "motel", "hotel", "interrogation", "precinct", "lobby", "basement", "inside"), "interior"),
    (("forest", "woods", "jungle", "trees", "clearing"), "forest"),
    (("desert", "dunes", "canyon", "mesa"), "desert"),
    (("beach", "shore", "surf", "boardwalk"), "beach"),
    (("lake", "sea", "ocean", "open water", "river"), "open_water"),
    (("stadium", "ballfield", "arena", "pitch side"), "stadium"),
    (("plaza", "square", "courtyard", "piazza", "town square"), "plaza"),
    (("studio", "green screen", "soundstage", "cyc"), "studio"),
]
TIME_WORDS = [(("midnight", "night", "nighttime", "after dark", "late at night"), "night"),
              (("dawn", "first light", "before sunrise"), "dawn"), (("sunrise", "early morning", "morning"), "golden_am"),
              (("noon", "midday", "high noon", "afternoon", "daytime", "broad daylight"), "midday"),
              (("dusk", "sunset", "golden hour", "magic hour"), "magic_hour"), (("twilight", "blue hour"), "blue_hour"),
              (("overcast", "grey day", "gray day", "cloudy"), "overcast")]
WEATHER_WORDS = [(("rain", "rainy", "raining", "downpour", "storm", "stormy", "wet", "drizzle", "pouring"), "rain"),
                 (("snow", "snowy", "snowing", "blizzard"), "snow"), (("fog", "foggy", "mist", "misty", "haze"), "fog"),
                 (("smoke", "smoky", "steam"), "smoke"), (("dust", "dusty", "sandstorm"), "dust"), (("sparks",), "sparks")]
VEHICLE_WORDS = {"car": "car", "cars": "car", "taxi": "car", "cab": "car", "sedan": "car", "headlights": "car",
                 "police car": "police_car", "cop car": "police_car", "squad car": "police_car", "cruiser": "police_car",
                 "sports car": "sports_car", "truck": "truck", "van": "truck", "motorcycle": "motorcycle", "bike": "bicycle",
                 "motorbike": "motorcycle", "bicycle": "bicycle", "hatchback": "hatchback"}
PROP_WORDS = ["dumpster", "trash can", "crate", "crates", "barrel", "barrels", "bench", "table", "chair", "lamp", "street lamp",
              "phone booth", "mailbox", "fire hydrant", "umbrella", "suitcase", "briefcase", "neon sign", "newspaper stand"]
MOTION = [  # (regex, action): the person's blocking for this beat
    (r"\b(turns? and (runs?|bolts?|flees?|sprints?)|turns? to run|takes? off running)\b", "flee"),
    (r"\b(runs?|running|sprints?|sprinting|bolts?|flees?|fleeing|races?) (away|off|back|down the|into the)\b", "flee"),
    (r"\b(runs?|running|sprints?|sprinting|charges?) (toward|towards|at) (the )?(camera|us|lens)\b", "rush"),
    (r"\b(walks?|walking|comes?|coming|strides?|striding|heads?|heading|moves?|moving|steps?|stepping|limps?|limping)"
     r" (toward|towards|to|at|up to) (the )?(camera|us|lens)\b", "approach"),
    (r"\b(approaches|approaching)\b", "approach"),
    (r"\b(walks?|walking|crosses|crossing|runs?|running) (across|past)\b", "cross"),
    (r"\b(walks?|walking|heads?|heading) (away|off|down the|into the)\b", "away"),
    # Speech-to-text splits words ("walk-stored camera" for "walks toward camera"): a walk that ends at the camera.
    (r"\b(walks?|walking|comes?|coming|heads?|heading)[\w' -]{0,14}\bcamera\b", "approach"),
    (r"\b(runs?|running|sprints?|bolts?|flees?)\b", "flee"),
    (r"\b(stops?|freezes?|stands? still|waits?|waiting|stands?|standing|lingers?)\b", "still"),
    (r"\b(turns? (around|back)|spins? around|looks? back|glances? back|looks? over (his|her|their) shoulder)\b", "turn"),
]
SWEEP_RE = r"\b(headlights?|car|taxi|cab|truck|van|police car|cruiser)\b.*\b(sweep|sweeps|sweeping|swing|swings|pass|passes|passing|race|races|roars?|drives?|speeds?) (across|by|past|through|over)\b"
CAMERA_RIGS = [(r"\bhand ?held\b|\bshaky\b|\bdocumentary style\b", "handheld"), (r"\bsteadicam\b|\bglides?\b|\bgliding\b", "steadicam"),
               (r"\bdrone\b|\baerial\b", "drone"), (r"\bdolly\b|\btracks? alongside\b|\btracking\b", "dolly"),
               (r"\btripod\b|\blocked off\b|\bstatic\b", "tripod"), (r"\bcrane\b|\bjib\b", "jib")]
HEIGHTS = [(r"\blow(?:[- ]angle)?\b|\bfrom below\b|\bground level\b|\bat his feet\b|\bat her feet\b|\bworm'?s?[- ]eye\b", "low"),
           (r"\bhigh[- ]angle\b|\boverhead\b|\bfrom above\b|\bbird'?s?[- ]eye\b|\btop down\b", "high"),
           (r"\beye[- ]level\b", "eye")]
LENSES = [(r"\b(extreme )?close[- ]?ups?\b|\bclose on\b|\btight on\b|\bon (his|her|their) face\b", 85),
          (r"\bmedium shot\b|\bwaist up\b", 50), (r"\bwide shot\b|\bwide angle\b|\bestablishing\b|\bwide\b", 24),
          (r"\blong lens\b|\btelephoto\b", 135)]
WARDROBE_RE = r"\b(?:in|wearing|dressed in|with) (?:a |an |the |his |her )?((?:long |dark |black |white |red |grey |gray |torn |wet |old |leather |beige |tan |blue )*(?:trench ?coat|coat|suit|hat|fedora|hoodie|dress|jacket|raincoat|uniform|cap|scarf|gloves|boots|mask|leather jacket|overcoat|tuxedo|kimono|robe|sunglasses|helmet|vest|cape))\b"
PRONOUN = {"he": "m", "him": "m", "his": "m", "she": "f", "her": "f", "hers": "f", "they": "*", "them": "*"}
FEMALE_ROLES = {r for r, k in P.ROLE_WORDS.items() if k == "woman"}

FPS = 24


def _has(t: str, w: str) -> bool:
    return re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", t) is not None


def _first(table, t, default=None):
    for words, val in table:
        if any(_has(t, w) for w in words):
            return val
    return default


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").replace("…", " ").replace("...", " ")).strip()


# ------------------------------------------------------------------------------------------- memory

def new_memory() -> dict:
    return {"beats": 0, "set": None, "place": "", "time": None, "weather": None, "cast": [], "last_who": None,
            "vehicles": [], "props": [], "camera": {"height": None, "rig": None, "follow": None, "lens": None},
            "action": None, "transcript": []}


def _norm_memory(m) -> dict:
    out = new_memory()
    if isinstance(m, dict):
        for k, v in m.items():
            if k in out:
                out[k] = copy.deepcopy(v)
        out["camera"] = {**new_memory()["camera"], **(m.get("camera") or {})}
    return out


def _cast_by_role(memory, role):
    return next((c for c in memory["cast"] if c["role"] == role), None)


def _who(memory, pron: str | None):
    """The person a pronoun means: the last one mentioned of that gender, else the last one."""
    if not memory["cast"]:
        return None
    g = PRONOUN.get(pron or "", "*")
    last = _cast_by_role(memory, memory.get("last_who")) if memory.get("last_who") else None
    if g == "*" or last is None:
        return last or memory["cast"][-1]
    want_f = g == "f"
    for c in [last, *reversed(memory["cast"])]:
        if (c["role"] in FEMALE_ROLES or c.get("kind") == "woman") == want_f:
            return c
    return last


def extract(text: str, memory: dict | None = None) -> dict:
    """What this beat says, in the pitch's own terms. Only fields it mentions are present."""
    memory = _norm_memory(memory)
    t = " " + _clean(text).lower() + " "
    d: dict = {}
    s = _first(PLACE_SETS, t)
    if s:
        d["set"] = s
        m = re.search(r"\b(?:a|an|the|in|into|at|on)\s+((?:[a-z']+ ){0,3}(?:%s)(?: (?:in|of|on|near|behind|off) (?:the )?[a-z' ]{2,24})?)" %
                      "|".join(re.escape(w) for ws, _ in PLACE_SETS for w in ws), t)
        if m:
            d["place"] = m.group(1).strip(" .,")
    tm = _first(TIME_WORDS, t)
    if tm:
        d["time"] = tm
    wx = _first(WEATHER_WORDS, t)
    if wx:
        d["weather"] = wx
    # A new character: "a detective", "an old woman", "the girl" (roles from the Scene agent's table).
    roles = sorted(P.ROLE_WORDS, key=len, reverse=True)
    new_role = None
    for r in roles:
        if P.ROLE_WORDS[r] in ("dog", "horse", "cat") and r not in t:
            continue
        if re.search(rf"\b(a|an|the|one|our|some)\s+(?:[a-z]+\s+)?{re.escape(r)}s?\b", t) and r not in ("person", "people", "friend", "partner", "couple"):
            new_role = r
            break
    if new_role:
        d["who"] = {"role": new_role, "kind": P.ROLE_WORDS[new_role], "new": _cast_by_role(memory, new_role) is None}
    else:
        pm = re.search(r"\b(he|she|they|him|her|them)\b", t)
        c = _who(memory, pm.group(1) if pm else None) if memory["cast"] else None
        if c:
            d["who"] = {"role": c["role"], "kind": c.get("kind"), "new": False}
    wm = re.search(WARDROBE_RE, t)
    if wm and d.get("who"):
        d["wardrobe"] = re.sub(r"trench ?coat", "trench coat", wm.group(1).strip())
    for word in P.EMOTIONS if hasattr(P, "EMOTIONS") else []:
        if _has(t, word):
            d["emotion"] = word
            break
    if "emotion" not in d:
        from .director import EMOTIONS
        em = next((w for w in EMOTIONS if _has(t, w)), None)
        if em:
            d["emotion"] = em
    sweep = re.search(SWEEP_RE, t)
    if sweep:
        veh = next((VEHICLE_WORDS[w] for w in sorted(VEHICLE_WORDS, key=len, reverse=True) if _has(t, w)), "car")
        d["vehicle"] = {"kind": veh, "action": "sweep", "lights": "headlight" in t}
    else:
        vm = next((w for w in sorted(VEHICLE_WORDS, key=len, reverse=True) if re.search(rf"\b(a|an|the)\s+(?:[a-z]+\s+)?{re.escape(w)}\b", t)), None)
        if vm and vm != "headlights":
            act = "arrive" if re.search(r"\b(pulls? up|arrives?|stops?|screeches? to a halt)\b", t) else "park"
            d["vehicle"] = {"kind": VEHICLE_WORDS[vm], "action": act, "lights": False}
    if d.get("who") and not sweep:
        clause = t
        # "he turns and runs" -> flee (not turn); a person verb only, not the car's.
        for rx, act in MOTION:
            if re.search(rx, clause):
                d["action"] = act
                break
    props = [p for p in PROP_WORDS if _has(t, p)]
    if props:
        d["props"] = props
    if _has(t, "neon"):
        d["neon"] = True
    cam: dict = {}
    camera_talk = re.search(r"\b(camera|we|lens|shot|frame|angle|pov)\b", t) is not None
    for rx, rig in CAMERA_RIGS:
        if re.search(rx, t) and (camera_talk or rig in ("handheld", "steadicam", "drone")):
            cam["rig"] = rig
            break
    for rx, hgt in HEIGHTS:
        if re.search(rx, t) and (camera_talk or hgt != "low" or "angle" in t):
            cam["height"] = hgt
            break
    if re.search(r"\b(camera|we) (follows?|tracks?|chases?|stays? with|goes? with|runs? with)\b|\bfollowing (him|her|them)\b|\bfollow cam\b", t):
        tgt = _who(memory, None) or ({"role": d["who"]["role"]} if d.get("who") else None)
        if d.get("who"):
            tgt = {"role": d["who"]["role"]}
        cam["follow"] = tgt["role"] if tgt else True
    mm = re.search(r"\b(\d{2,3}) ?mm\b", t)
    if mm:
        cam["lens"] = int(mm.group(1))
    else:
        for rx, lens in LENSES:
            if re.search(rx, t):
                cam["lens"] = lens
                break
    if cam:
        d["camera"] = cam
    return d


def merge_delta(rules: dict, llm: dict | None) -> dict:
    """The rules read the pitch's exact words; the model only fills fields the rules found nothing for."""
    out = copy.deepcopy(rules or {})
    for k, v in (llm or {}).items():
        if v in (None, "", [], {}):
            continue
        if k == "camera" and isinstance(v, dict):
            out["camera"] = {**{a: b for a, b in v.items() if b not in (None, "")}, **out.get("camera", {})}
        elif k == "props":
            out["props"] = list(dict.fromkeys([*out.get("props", []), *v]))[:4]
        elif k not in out:
            out[k] = copy.deepcopy(v)
    return out


def merge_memory(memory: dict | None, delta: dict, text: str = "") -> dict:
    """The pitch so far after this beat (pure)."""
    m = _norm_memory(memory)
    m["beats"] += 1
    if text:
        m["transcript"] = [*m["transcript"], _clean(text)][-40:]
    for k in ("set", "place", "time", "weather"):
        if delta.get(k):
            m[k] = delta[k]
    w = delta.get("who")
    if w:
        c = _cast_by_role(m, w["role"])
        if c is None:
            c = {"role": w["role"], "kind": w.get("kind") or P.ROLE_WORDS.get(w["role"], "man"), "wardrobe": "", "emotion": ""}
            m["cast"].append(c)
        if delta.get("wardrobe"):
            c["wardrobe"] = delta["wardrobe"]
        if delta.get("emotion"):
            c["emotion"] = delta["emotion"]
        if delta.get("action"):
            c["action"] = delta["action"]
        m["last_who"] = c["role"]
    if delta.get("action"):
        m["action"] = {"who": (w or {}).get("role"), "verb": delta["action"]}
    if delta.get("vehicle"):
        m["vehicles"] = [*m["vehicles"], delta["vehicle"]][-3:]
    if delta.get("props"):
        m["props"] = list(dict.fromkeys([*m["props"], *delta["props"]]))[-8:]
    cam = delta.get("camera") or {}
    for k, v in cam.items():
        m["camera"][k] = v
    return m


# ------------------------------------------------------------------------------------------- the model

PITCH_SYSTEM = """You help a film director pitch a scene out loud. Read ONE new sentence of the pitch (with what was said
before) and answer with ONLY a JSON object holding what this sentence adds. Keys (leave out what it doesn't say):
"set": one of %s
"place": short place description, "time": one of %s, "weather": one of %s,
"who": {"role": "detective"} (the person this sentence is about), "wardrobe": "trench coat", "emotion": "scared",
"action": one of approach|away|cross|flee|rush|still|turn (what the person does, relative to the camera),
"vehicle": {"kind": "car|police_car|truck|motorcycle", "action": "sweep|arrive|park"},
"props": ["dumpster"], "camera": {"height": "low|eye|high", "rig": "%s", "follow": "detective", "lens": 35}
Example: "A cop in a raincoat runs away from us, we follow handheld" ->
{"who":{"role":"cop"},"wardrobe":"raincoat","action":"flee","camera":{"rig":"handheld","follow":"cop"}}""" % (
    "|".join(C.SETS), "|".join(C.TIME_PRESETS), "|".join(C.WEATHER), "|".join(["handheld", "steadicam", "drone", "dolly", "tripod", "jib"]))


def llm_prompt(text: str, memory: dict | None = None) -> dict:
    m = _norm_memory(memory)
    said = " ".join(m["transcript"][-6:])
    return {"system": PITCH_SYSTEM, "prompt": (f"Said so far: {said}\n" if said else "") + f"New sentence: {_clean(text)}\nJSON:",
            "max_length": 160}


def parse_llm_delta(text: str | None) -> dict:
    """The model's JSON as a delta, every field checked against the vocabularies (anything else is dropped)."""
    if not text:
        return {}
    m = re.search(r"\{.*\}", str(text), re.S)
    if not m:
        return {}
    try:
        raw = json.loads(m.group(0))
    except ValueError:
        return {}
    if not isinstance(raw, dict):
        return {}
    d: dict = {}
    if raw.get("set") in C.SETS:
        d["set"] = raw["set"]
    if isinstance(raw.get("place"), str) and raw["place"].strip():
        d["place"] = raw["place"].strip()[:60]
    if raw.get("time") in C.TIME_PRESETS:
        d["time"] = raw["time"]
    if raw.get("weather") in C.WEATHER:
        d["weather"] = raw["weather"]
    who = raw.get("who")
    role = (who.get("role") if isinstance(who, dict) else who) if who else None
    if isinstance(role, str) and role.lower().strip() in P.ROLE_WORDS:
        r = role.lower().strip()
        d["who"] = {"role": r, "kind": P.ROLE_WORDS[r]}
    for k in ("wardrobe", "emotion"):
        if isinstance(raw.get(k), str) and raw[k].strip() and d.get("who"):
            d[k] = raw[k].strip().lower()[:40]
    if raw.get("action") in ("approach", "away", "cross", "flee", "rush", "still", "turn") and d.get("who"):
        d["action"] = raw["action"]
    v = raw.get("vehicle")
    if isinstance(v, dict) and v.get("kind") in ("car", "police_car", "sports_car", "truck", "motorcycle", "bicycle", "hatchback"):
        d["vehicle"] = {"kind": v["kind"], "action": v.get("action") if v.get("action") in ("sweep", "arrive", "park") else "park",
                        "lights": bool(v.get("lights"))}
    if isinstance(raw.get("props"), list):
        ps = [str(p).lower().strip() for p in raw["props"] if isinstance(p, str) and 2 < len(p) < 30]
        if ps:
            d["props"] = ps[:3]
    cam = raw.get("camera")
    if isinstance(cam, dict):
        c = {}
        if cam.get("height") in ("low", "eye", "high"):
            c["height"] = cam["height"]
        if cam.get("rig") in ("handheld", "steadicam", "drone", "dolly", "tripod", "jib"):
            c["rig"] = cam["rig"]
        if isinstance(cam.get("follow"), str) and cam["follow"].lower() in P.ROLE_WORDS:
            c["follow"] = cam["follow"].lower()
        try:
            if cam.get("lens") and 12 <= float(cam["lens"]) <= 200:
                c["lens"] = int(float(cam["lens"]))
        except (TypeError, ValueError):
            pass
        if c:
            d["camera"] = c
    return d


# ------------------------------------------------------------------------------------------- staging

def _active(scene):
    shots = scene.get("shots") or []
    return next((s for s in shots if s.get("id") == scene.get("active_shot")), shots[0] if shots else None)


def _last(scene) -> int:
    return max(1, int((scene.get("shot") or {}).get("frames", 97)) - 1)


def _clamp_pt(set_name, x, z, margin=1.2):
    b = C.SETS.get(set_name, C.SETS["empty"])["bounds"]
    return [round(min(max(x, b[0] + margin), b[1] - margin), 2), 0.0, round(min(max(z, b[2] + margin), b[3] - margin), 2)]


def pitch_axis(scene) -> tuple[list, list, list]:
    """The camera the pitch stages against: (camera position, forward unit xz, right unit xz)."""
    sh = _active(scene)
    k = (sh or {}).get("camera_keys", [{}])[0] if sh else {}
    p = k.get("position") or [0, 1.6, 10]
    tg = k.get("target") or [0, 1.4, 0]
    dx, dz = tg[0] - p[0], tg[2] - p[2]
    n = math.hypot(dx, dz) or 1.0
    f = [dx / n, 0, dz / n]
    return list(p), f, [-f[2], 0, f[0]]


def _fresh_camera(scene, set_name):
    """A pitch establishing camera on a new set: eye height, looking down the set's long axis."""
    b = C.SETS.get(set_name, C.SETS["empty"])["bounds"]
    st = C.SETS.get(set_name, C.SETS["empty"]).get("stage", [0, 0])
    long_z = (b[3] - b[2]) >= (b[1] - b[0])
    if long_z:
        cz = min(st[1] + 10, b[3] - 1.5)
        pos, tgt = [st[0], 1.6, cz], [st[0], 1.4, cz - 12]
    else:
        cx = max(st[0] - 10, b[0] + 1.5)
        pos, tgt = [cx, 1.6, st[1]], [cx + 12, 1.4, st[1]]
    cam = {"position": pos, "target": tgt, "focal_mm": 32.0}
    cam, _ = S.clamp_camera(cam, set_name)
    return cam


def _keys_line(a, b, frames, f0=0, heading=None):
    out = [{"frame": f0, "position": a}]
    if a != b:
        out.append({"frame": frames, "position": b})
    if heading is not None:
        for k in out:
            k["heading_deg"] = heading
    return out


class _Ops:
    def __init__(self, scene):
        self.work = copy.deepcopy(scene)
        self.ops: list[dict] = []
        self.said: list[str] = []

    def emit(self, op, undo):
        from . import ops as O
        op = {**op, "undo": undo}
        O.apply_op(self.work, op)
        self.ops.append(op)

    def actor(self, aid):
        return next((a for a in self.work.get("actors", []) if a.get("id") == aid), None)

    def patch_actor(self, a, patch):
        before = {k: copy.deepcopy(a.get(k)) for k in patch}
        self.emit({"op": "move_object", "id": a["id"], "set": patch}, {"op": "move_object", "id": a["id"], "set": before})

    def patch_shot(self, sh, patch):
        before = {k: copy.deepcopy(sh.get(k)) for k in patch}
        self.emit({"op": "update_shot", "id": sh["id"], "set": patch}, {"op": "update_shot", "id": sh["id"], "set": before})


def _ensure_shot(o: _Ops):
    sh = _active(o.work)
    if sh:
        return sh
    cam = _fresh_camera(o.work, (o.work.get("environment") or {}).get("set", "empty"))
    shot = {"id": "pitch_cam", "name": "Pitch", "setup": "wide",
            "camera_keys": [{"frame": 0, **{k: cam[k] for k in ("position", "target", "focal_mm")}}]}
    o.emit({"op": "add_shot", "shot": shot}, {"op": "remove_shot", "id": "pitch_cam"})
    o.emit({"op": "set_active_shot", "id": "pitch_cam"}, {"op": "set_active_shot", "id": o.work.get("active_shot")})
    return _active(o.work)


def _actor_for(o: _Ops, memory, role):
    ids = (memory.get("ids") or {})
    aid = ids.get(role)
    return o.actor(aid) if aid else None


def beat_ops(delta: dict, memory: dict, scene: dict, ids: dict | None = None) -> dict:
    """Concrete ops for one beat on the live scene. ids: role/vehicle -> actor id from earlier beats.
    -> {ops, said[], ids, rig, scene (after)}"""
    from . import ops as O
    ids = dict(ids or {})
    o = _Ops(scene)
    o.work.setdefault("actors", [])
    o.work.setdefault("environment", {"set": "empty", "weather": "none"})
    env = o.work["environment"]
    cur_set = env.get("set") or "empty"
    # Set, time, weather through the Scene agent's own resolvers (sun, practicals, actors kept inside the new set).
    sym = []
    if delta.get("set") and delta["set"] != cur_set:
        sym.append({"op": "set", "set": delta["set"]})
    if delta.get("time") and (o.work.get("lighting") or {}).get("preset") != delta["time"]:
        sym.append({"op": "time", "preset": delta["time"]})
    if delta.get("weather") and env.get("weather", "none") != delta["weather"]:
        sym.append({"op": "weather", "weather": delta["weather"]})
    if sym:
        ops, _ = O.resolve(o.work, sym)
        for op in ops:
            O.apply_op(o.work, op)
            o.ops.append(op)
        if delta.get("set") and delta["set"] != cur_set:
            o.said.append(f"Set: {C.SETS[delta['set']]['label'].lower()}" + (f" ({delta['place']})" if delta.get("place") else ""))
        if delta.get("time"):
            o.said.append(f"Time: {delta['time'].replace('_', ' ')}")
        if delta.get("weather"):
            o.said.append(f"Weather: {delta['weather']}")
    set_name = o.work["environment"].get("set") or "empty"
    sh = _ensure_shot(o)
    if delta.get("set") and delta["set"] != cur_set:
        cam = _fresh_camera(o.work, set_name)
        o.patch_shot(sh, {"camera_keys": [{"frame": 0, **cam}]})
        sh = _active(o.work)
    if delta.get("who", {}).get("new") is not False and delta.get("who") and not ids.get("_framed") and not delta.get("camera"):
        # The first person in the pitch: start from an eye-level camera looking down the set (the App's default
        # camera can be a high crane), so "toward camera" reads the way the director sees it.
        o.patch_shot(sh, {"camera_keys": [{"frame": 0, **_fresh_camera(o.work, set_name)}]})
        sh = _active(o.work)
    if delta.get("who") or (delta.get("set") and delta["set"] != cur_set):
        ids["_framed"] = True
    cpos, fwd, right = pitch_axis(o.work)
    last = _last(o.work)
    # A person.
    who = delta.get("who")
    person = None
    if who:
        aid = ids.get(who["role"])
        person = o.actor(aid) if aid else None
        if person is None:
            kind = who.get("kind") or P.ROLE_WORDS.get(who["role"], "man")
            obj = make_object(who["role"], {a["id"] for a in o.work["actors"]}, kind=kind if kind in C.LIBRARY else "man",
                              label=who["role"].capitalize())
            obj["role"] = who["role"]
            pos = _clamp_pt(set_name, cpos[0] + fwd[0] * 9, cpos[2] + fwd[2] * 9)
            obj["position"] = pos
            obj["keys"] = [{"frame": 0, "position": list(pos)}]
            obj["rotation_deg"] = S.heading_to(pos, cpos)
            o.emit({"op": "add_object", "object": obj, "index": len(o.work["actors"])}, {"op": "remove_object", "id": obj["id"]})
            person = o.actor(obj["id"])
            ids[who["role"]] = obj["id"]
            o.said.append(f"Cast: {obj['name']}")
        patch = {}
        look = " ".join(x for x in [delta.get("wardrobe") and f"in a {delta['wardrobe']}", delta.get("emotion")] if x)
        if look:
            patch["direction"] = look
            o.said.append(f"{person['name']}: {look}")
        act = delta.get("action")
        if act:
            p0 = list(person["keys"][-1]["position"] if person.get("keys") else person["position"])
            to_cam = S.heading_to(p0, cpos)
            if act in ("approach", "rush"):
                start = _clamp_pt(set_name, cpos[0] + fwd[0] * (13 if act == "approach" else 16), cpos[2] + fwd[2] * (13 if act == "approach" else 16))
                end = _clamp_pt(set_name, cpos[0] + fwd[0] * 3.2, cpos[2] + fwd[2] * 3.2)
                patch.update(position=start, keys=_keys_line(start, end, last), rotation_deg=S.heading_to(start, cpos))
            elif act in ("flee", "away"):
                dist = 4.5 * last / FPS if act == "flee" else 1.4 * last / FPS
                end = _clamp_pt(set_name, p0[0] + fwd[0] * dist, p0[2] + fwd[2] * dist)
                away = (to_cam + 180) % 360 - (360 if (to_cam + 180) % 360 > 180 else 0)
                keys = [{"frame": 0, "position": p0, "heading_deg": to_cam}, {"frame": 8, "position": p0, "heading_deg": away},
                        {"frame": last, "position": end, "heading_deg": away}]
                patch.update(position=p0, keys=keys, rotation_deg=to_cam)
            elif act == "cross":
                a = _clamp_pt(set_name, p0[0] - right[0] * 5, p0[2] - right[2] * 5)
                b = _clamp_pt(set_name, p0[0] + right[0] * 5, p0[2] + right[2] * 5)
                patch.update(position=a, keys=_keys_line(a, b, last), rotation_deg=S.heading_to(a, b))
            elif act == "turn":
                away = S.heading_to(p0, [p0[0] + fwd[0], 0, p0[2] + fwd[2]])
                patch.update(position=p0, keys=[{"frame": 0, "position": p0, "heading_deg": away},
                                                {"frame": min(last, 18), "position": p0, "heading_deg": to_cam}], rotation_deg=away)
            elif act == "still":
                patch.update(position=p0, keys=[{"frame": 0, "position": p0}], rotation_deg=to_cam)
            o.said.append({"approach": "Blocking: walks toward camera", "rush": "Blocking: runs at camera",
                           "flee": "Blocking: turns and runs", "away": "Blocking: walks away", "cross": "Blocking: crosses frame",
                           "turn": "Blocking: turns to camera", "still": "Blocking: holds"}[act])
        if patch:
            o.patch_actor(person, patch)
            person = o.actor(person["id"])
    if person is None and memory.get("last_who") and ids.get(memory["last_who"]):
        person = o.actor(ids[memory["last_who"]])
    # A vehicle: headlights sweeping across the person, or one parked / pulling up.
    v = delta.get("vehicle")
    if v:
        kind = v["kind"] if v["kind"] in C.LIBRARY else "car"
        obj = make_object(kind, {a["id"] for a in o.work["actors"]}, kind=kind)
        anchor = (person["keys"][-1]["position"] if person and person.get("keys") else
                  _clamp_pt(set_name, cpos[0] + fwd[0] * 9, cpos[2] + fwd[2] * 9))
        if v["action"] == "sweep":
            # Behind the person (from the camera), left to right across the frame, the lamps lit.
            bx, bz = anchor[0] + fwd[0] * 4, anchor[2] + fwd[2] * 4
            a = _clamp_pt(set_name, bx - right[0] * 14, bz - right[2] * 14, 1.0)
            b = _clamp_pt(set_name, bx + right[0] * 14, bz + right[2] * 14, 1.0)
            if math.dist(a, b) < 4:   # a narrow street: the car comes down it toward camera instead
                a = _clamp_pt(set_name, anchor[0] + fwd[0] * 18 + right[0] * 2, anchor[2] + fwd[2] * 18 + right[2] * 2, 1.0)
                b = _clamp_pt(set_name, anchor[0] - fwd[0] * 1 + right[0] * 2, anchor[2] - fwd[2] * 1 + right[2] * 2, 1.0)
            obj.update(position=a, keys=_keys_line(a, b, last), rotation_deg=S.heading_to(a, b))
            o.said.append("A car's headlights sweep across")
        else:
            p = _clamp_pt(set_name, anchor[0] + right[0] * 3 + fwd[0] * 2, anchor[2] + right[2] * 3 + fwd[2] * 2, 1.0)
            start = _clamp_pt(set_name, p[0] + fwd[0] * 12, p[2] + fwd[2] * 12, 1.0) if v["action"] == "arrive" else p
            obj.update(position=start, keys=_keys_line(start, p, int(last * 0.7)), rotation_deg=S.heading_to(start, cpos))
            o.said.append(f"A {obj['name'].lower()} {'pulls up' if v['action'] == 'arrive' else 'on set'}")
        o.emit({"op": "add_object", "object": obj, "index": len(o.work["actors"])}, {"op": "remove_object", "id": obj["id"]})
        ids.setdefault("vehicles", [])
        ids["vehicles"] = [*ids["vehicles"], obj["id"]][-3:]
    # Props: next to the person (or the frame centre), off their path.
    for i, pr in enumerate((delta.get("props") or [])[:3]):
        what = pr.rstrip("s") if pr.endswith("s") and pr[:-1] in C.LIBRARY else pr
        obj = make_object(what, {a["id"] for a in o.work["actors"]})
        base = person["position"] if person else _clamp_pt(set_name, cpos[0] + fwd[0] * 8, cpos[2] + fwd[2] * 8)
        side = 1 if i % 2 == 0 else -1
        want = [base[0] + right[0] * 2.4 * side + fwd[0] * (1 + i), base[2] + right[2] * 2.4 * side + fwd[2] * (1 + i)]
        q = S.free_spot(obj, want, set_name, o.work["actors"])
        obj["position"] = q
        obj["keys"] = [{"frame": 0, "position": list(q)}]
        o.emit({"op": "add_object", "object": obj, "index": len(o.work["actors"])}, {"op": "remove_object", "id": obj["id"]})
        o.said.append(f"Prop: {obj['name'].lower()}")
    # Camera: height, follow, lens (keys on the active shot); the rig runs through stage.setRig in the browser.
    cam = delta.get("camera") or {}
    mcam = {**(memory.get("camera") or {}), **cam}
    if cam or (delta.get("action") and mcam.get("follow")):
        sh = _active(o.work)
        k0 = copy.deepcopy(sh["camera_keys"][0])
        y = {"low": 0.45, "high": 4.5, "eye": 1.6}.get(mcam.get("height") or "", k0["position"][1])
        mm = float(mcam.get("lens") or k0.get("focal_mm") or 32)
        follow = mcam.get("follow")
        fid = ids.get(follow) if isinstance(follow, str) else (ids.get(memory.get("last_who")) if follow else None)
        subj = o.actor(fid) if fid else None
        keys = []
        if subj and subj.get("keys"):
            # Follow: the camera keeps its offset to the person through every key (behind, or ahead, of them).
            off = [k0["position"][0] - subj["keys"][0]["position"][0], k0["position"][2] - subj["keys"][0]["position"][2]]
            dist = math.hypot(*off) or 1.0
            want = min(dist, 3.2)
            off = [off[0] / dist * want, off[1] / dist * want]
            pts = subj["keys"]
            if len(pts) >= 2 and math.dist(pts[0]["position"], pts[-1]["position"]) > 2:
                # Moving away from the camera: trail behind them.
                mv = [pts[-1]["position"][0] - pts[0]["position"][0], pts[-1]["position"][2] - pts[0]["position"][2]]
                n = math.hypot(*mv)
                if (mv[0] * off[0] + mv[1] * off[1]) < 0:
                    off = [-mv[0] / n * want, -mv[1] / n * want]
            for k in pts:
                p = k["position"]
                keys.append({"frame": k["frame"], "position": [round(p[0] + off[0], 2), round(y, 2), round(p[2] + off[1], 2)],
                             "target": [p[0], 1.0 if mcam.get("height") == "low" else 1.3, p[2]], "focal_mm": mm})
            o.said.append(f"Camera: follows {subj['name']}" + (f", {mcam['height']}" if mcam.get("height") else ""))
        else:
            for k in sh["camera_keys"]:
                k = copy.deepcopy(k)
                k["position"][1] = round(y, 2)
                if mcam.get("height") == "low":
                    k["target"][1] = max(1.2, k["target"][1])
                k["focal_mm"] = mm
                keys.append(k)
            if cam.get("height"):
                o.said.append(f"Camera: {cam['height']} angle")
            if cam.get("lens"):
                o.said.append(f"Lens: {int(mm)} mm")
        o.patch_shot(sh, {"camera_keys": keys})
    if cam.get("rig"):
        o.said.append(f"Rig: {cam['rig']}")
    return {"ops": o.ops, "said": o.said, "ids": ids, "rig": cam.get("rig"), "scene": o.work}


# ------------------------------------------------------------------------------------------- the sketch

TIME_PHRASE = {"night": "at night", "dawn": "at dawn, cold first light", "golden_am": "early morning, low warm sun",
               "midday": "midday, hard sun", "overcast": "overcast soft daylight", "magic_hour": "at sunset, golden light",
               "blue_hour": "at blue hour after sunset"}
WEATHER_PHRASE = {"rain": "pouring rain, wet reflective ground", "snow": "falling snow", "fog": "thick fog", "smoke": "drifting smoke",
                  "dust": "blowing dust", "sparks": "flying sparks"}
ACTION_PHRASE = {"approach": "walks toward the camera", "rush": "runs straight at the camera", "flee": "turns and runs away",
                 "away": "walks away from the camera", "cross": "crosses the frame", "turn": "turns back to look",
                 "still": "stands still"}
HEIGHT_PHRASE = {"low": "low-angle camera near the ground", "high": "high-angle camera looking down", "eye": "eye-level camera"}


def sketch_prompt(memory: dict, delta: dict | None = None, text: str = "", style: str = "") -> str:
    m = _norm_memory(memory)
    place = m["place"] or (C.SETS.get(m["set"] or "", {}).get("label", "").lower() if m["set"] else "")
    bits = []
    where = " ".join(x for x in [place, TIME_PHRASE.get(m["time"] or "", "")] if x)
    if where:
        bits.append(where[:1].upper() + where[1:])
    if m["weather"] and m["weather"] != "none":
        bits.append(WEATHER_PHRASE.get(m["weather"], m["weather"]))
    for c in m["cast"]:
        desc = f"a {c['role']}" + (f" in a {c['wardrobe']}" if c.get("wardrobe") else "") + (f", {c['emotion']}" if c.get("emotion") else "")
        act = ACTION_PHRASE.get(c.get("action") or "", "")
        bits.append(f"{desc} {act}".strip())
    for v in m["vehicles"][-1:]:
        bits.append("a car's headlights sweep across the scene" if v.get("action") == "sweep" else f"a {v['kind'].replace('_', ' ')}")
    if m["props"]:
        bits.append(", ".join(m["props"][-3:]))
    cam = m["camera"]
    shot = ", ".join(x for x in [HEIGHT_PHRASE.get(cam.get("height") or "", ""), cam.get("rig") and f"{cam['rig']} camera",
                                 cam.get("follow") and "following the action", cam.get("lens") and f"{cam['lens']}mm lens"] if x)
    if shot:
        bits.append(shot)
    said = _clean(text)
    head = "Turn this grey 3D previs frame into a cinematic film still, a storyboard frame of the pitch: "
    tail = (" Keep the camera angle, framing and where every person, car and object stands exactly as in the picture. "
            "Photographic, moody film lighting, no text, no logos.")
    body = ". ".join(b[:1].upper() + b[1:] for b in bits if b) or said
    if said and not delta and said.lower() not in body.lower():
        body += f". {said}"
    return head + body + "." + (f" Style: {style.strip()}." if style and style.strip() else "") + tail


class _G:
    """Just enough of ComfyUI's GraphBuilder for the router adapters' style: node(...).out(i) -> [id, i]."""
    def __init__(self, prefix="pt"):
        self.nodes: dict = {}
        self.prefix = prefix

    def node(self, cls, **inputs):
        nid = f"{self.prefix}{len(self.nodes) + 1}"
        self.nodes[nid] = {"class_type": cls, "inputs": inputs}
        g = self

        class N:
            id = nid

            def out(self, i):
                return [nid, i]
        return N()


def _weights(model_id, list_files):
    from ..router import registry as R
    m = R.find_model(model_id)
    if not m:
        return None
    w = R.resolve_weights(m, list_files)
    need = [s["role"] for s in m.get("weights", [])]
    missing = [r for r in need if not w.get(r)]
    return None if missing else w


def sketch_graph(image: str, prompt: str, seed: int = 0, steps: int = 4, megapixels: float = 0.3, weights: dict | None = None,
                 prefix: str = "soundstage_pitch/beat") -> dict:
    """FLUX 3 Klein edit of the stage capture (input/ `image`), few steps, small: the storyboard frame."""
    w = weights or {"unet": "flux3-image-klein-int8-convrot.safetensors", "text_encoder": "qwen3vl_4b_fp8_scaled.safetensors",
                    "vae": "flux2-vae.safetensors"}
    g = _G("pt")
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="flux3", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    img = g.node("LoadImage", image=image).out(0)
    pos = g.node("CLIPTextEncode", text=prompt, clip=clip).out(0)
    neg = g.node("ConditioningZeroOut", conditioning=pos).out(0)
    r = g.node("ReferenceMultiLatent", positive=pos, negative=neg, vae=vae, resolution="resize",
               **{"resolution.megapixels": round(max(0.1, float(megapixels)), 2), "images.image0": img})
    s = g.node("KSampler", model=unet, seed=int(seed) % (2 ** 31), steps=int(max(1, min(16, steps))), cfg=1.0,
               sampler_name="euler", scheduler="simple", positive=r.out(0), negative=r.out(1), latent_image=r.out(2),
               denoise=1.0).out(0)
    dec = g.node("VAEDecode", samples=s, vae=vae).out(0)
    g.node("SaveImage", images=dec, filename_prefix=prefix)
    return g.nodes


LTX_FAST_SIGMAS = "1.0, 0.99375, 0.9875, 0.909375, 0.725, 0.421875, 0.0"


def motion_graph(image: str, prompt: str, seed: int = 0, width: int = 512, height: int = 288, frames: int = 49, fps: int = 24,
                 weights: dict | None = None, prefix: str = "soundstage_pitch/motion") -> dict:
    """A very fast, low-grade LTX-2.5 draft of a beat: one pass (no upscale, no audio), 6 sigmas, from the sketch."""
    w = weights or {"unet": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
                    "text_encoder": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
                    "vae": "ltx-2.5-video-vae-bf16.safetensors"}
    W, H = max(64, int(width) // 32 * 32), max(64, int(height) // 32 * 32)
    n = max(9, (int(frames) - 1) // 8 * 8 + 1)
    g = _G("pm")
    model = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    pos = g.node("CLIPTextEncode", text=prompt, clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text="pc game, console game, video game, cartoon, childish, ugly", clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=float(fps))
    img = g.node("LoadImage", image=image).out(0)
    img = g.node("ImageScale", image=img, upscale_method="lanczos", width=W, height=H, crop="center").out(0)
    pre = g.node("LTXVPreprocess", image=img, img_compression=18).out(0)
    lat = g.node("EmptyLTXVLatentVideo", width=W, height=H, length=n, batch_size=1).out(0)
    lat = g.node("LTXVImgToVideoInplace", vae=vae, image=pre, latent=lat, strength=1.0, bypass=False).out(0)
    gd = g.node("CFGGuider", model=model, positive=cond.out(0), negative=cond.out(1), cfg=1.0).out(0)
    s = g.node("SamplerCustomAdvanced", noise=g.node("RandomNoise", noise_seed=int(seed) % (2 ** 31)).out(0), guider=gd,
               sampler=g.node("KSamplerSelect", sampler_name="euler_ancestral").out(0),
               sigmas=g.node("ManualSigmas", sigmas=LTX_FAST_SIGMAS).out(0), latent_image=lat).out(0)
    dec = g.node("VAEDecodeTiled", samples=s, vae=vae, tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16).out(0)
    vid = g.node("CreateVideo", images=dec, fps=float(fps)).out(0)
    g.node("SaveVideo", video=vid, filename_prefix=prefix, format="mp4", codec="h264")
    return g.nodes


def motion_prompt(memory: dict, text: str = "", style: str = "") -> str:
    p = sketch_prompt(memory, None, text, style)
    p = p.replace("Turn this grey 3D previs frame into a cinematic film still, a storyboard frame of the pitch: ", "")
    p = p.replace(" Keep the camera angle, framing and where every person, car and object stands exactly as in the picture.", "")
    return "A cinematic shot. " + p


# ------------------------------------------------------------------------------------------- one beat

def beat(text: str, scene: dict, memory: dict | None = None, ids: dict | None = None, llm_text: str | None = None,
         style: str = "") -> dict:
    """Everything the browser needs for one beat."""
    memory = _norm_memory(memory)
    rules = extract(text, memory)
    llm = parse_llm_delta(llm_text) if llm_text else {}
    delta = merge_delta(rules, llm)
    mem = merge_memory(memory, delta, text)
    staged = beat_ops(delta, {**mem, "ids": ids or {}}, scene, ids)
    caption = "; ".join(staged["said"]) or "(nothing new to stage)"
    return {"delta": delta, "rules": rules, "llm": llm, "memory": mem, "ops": staged["ops"], "said": staged["said"],
            "ids": staged["ids"], "rig": staged["rig"], "caption": caption, "changed": bool(staged["ops"] or staged["rig"]),
            "prompt": sketch_prompt(mem, delta, text, style), "motion_prompt": motion_prompt(mem, text, style),
            "scene": staged["scene"]}
