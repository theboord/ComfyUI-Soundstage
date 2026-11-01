"""The Director's `part` tool (Milestone 26): every object's Parts channels by voice or chat.

    "open the driver's door at 2 s"          -> part(target=police car, part=door_fl, value=65, at=2)
    "turn on the police lights"              -> part(part=lightbar, value=flash)
    "headlights on full beam", "hazards on", "wipers on", "make the car muddy", "crumple the front"
    "the horse throws its head up", "Mara smiles at 3 seconds", "make the lamp flicker like a candle"

The browser runs it through stage.setParts (one undo step), keyed at `at` seconds when given (the value before
holds until then). Names, ranges and modes are checked here first, like every Director call. Pure Python.
"""
from __future__ import annotations

import re

DOORS = ["door_fl", "door_fr", "door_rl", "door_rr"]
LIDS = ["hood", "trunk"]
ENUMS = {
    "headlights": ["auto", "off", "low", "high"], "brake": ["auto", "off", "on"], "indicator": ["off", "left", "right", "hazard"],
    "lightbar": ["off", "flash", "steady"], "wipers": ["off", "intermittent", "normal", "fast"], "navlights": ["off", "on", "strobe"],
    "finish": ["factory", "matte", "satin", "gloss", "metallic", "chrome"], "damage_side": ["front", "rear", "left", "right"],
    "gait": ["auto", "idle", "walk", "trot", "canter", "gallop"],
    "expression": ["neutral", "smile", "laugh", "frown", "angry", "sad", "surprised", "afraid", "disgust", "talking", "shouting", "eyes_closed"],
    "flicker": ["off", "candle", "fluorescent", "tv", "lightning", "strobe", "police", "pulse"],
}
RANGES = {"door_fl": (0, 70), "door_fr": (0, 70), "door_rl": (0, 70), "door_rr": (0, 70), "doors": (0, 70), "hood": (0, 75), "trunk": (0, 80),
          "steer": (-40, 40), "susp_h": (-0.15, 0.2), "susp_roll": (-12, 12), "susp_pitch": (-8, 8), "tint": (0, 1), "dirt": (0, 1),
          "damage": (0, 1), "head_pitch": (-40, 35), "head_yaw": (-60, 60), "neck": (-30, 30), "tail_lift": (-20, 60), "tail_swish": (0, 1),
          "intensity": (0, 12), "kelvin": (1800, 12000)}
PARTS = [*DOORS, "doors", *LIDS, *ENUMS, *[k for k in RANGES if k not in DOORS + LIDS + ["doors"]]]
VEHICLE_PARTS = set(DOORS + LIDS + ["doors", "headlights", "brake", "indicator", "lightbar", "wipers", "navlights", "steer", "susp_h",
                                    "susp_roll", "susp_pitch", "tint", "dirt", "damage", "damage_side", "finish"])
HORSE_PARTS = {"head_pitch", "head_yaw", "neck", "tail_lift", "tail_swish", "gait"}
LIGHT_PARTS = {"flicker", "intensity", "kelvin"}
PEOPLE = {"man", "woman", "child"}

TOOL = {"part": {"kind": "app", "doc": "Work a part of something on set, optionally from a time: a door / hood / trunk open or shut, "
                 "headlights, brake lights, indicators, police light bar, wipers, steering, suspension, tint, dirt, damage, paint finish; "
                 "a horse's head, tail or gait; a person's expression; a film light's flicker, intensity or colour temperature",
                 "args": {"part": ("enum", True, PARTS), "value": ("text", True, None), "target": ("name", False, None),
                          "light": ("text", False, None), "at": ("num", False, (0, 600))}}}
ALIASES = {"door": "part", "open": "part", "lights": "part", "set_part": "part", "parts": "part", "headlights": "part", "siren": "part",
           "police_lights": "part", "light_bar": "part", "lightbar": "part", "flicker": "part", "expression": "part"}

_DOOR_WORDS = {"open": 65, "opened": 65, "wide": 70, "wide open": 70, "ajar": 12, "crack": 12, "cracked": 12, "half": 35, "close": 0,
               "closed": 0, "shut": 0, "slam": 0, "slammed": 0, "on": 65, "off": 0, "true": 65, "false": 0}
_ENUM_ALIAS = {
    "headlights": {"on": "low", "dipped": "low", "low_beam": "low", "lowbeam": "low", "high_beam": "high", "high_beams": "high", "full": "high",
                   "full_beam": "high", "brights": "high", "true": "low", "false": "off"},
    "lightbar": {"on": "flash", "flashing": "flash", "lit": "steady", "true": "flash", "false": "off", "lights_and_sirens": "flash"},
    "brake": {"true": "on", "false": "off"}, "wipers": {"on": "normal", "slow": "intermittent", "true": "normal", "false": "off"},
    "indicator": {"hazards": "hazard", "hazard_lights": "hazard", "on": "hazard", "both": "hazard"},
    "navlights": {"strobes": "strobe", "true": "on", "false": "off"},
    "gait": {"run": "gallop", "stand": "idle", "halt": "idle", "stop": "idle", "walking": "walk", "trotting": "trot", "galloping": "gallop", "cantering": "canter"},
    "expression": {"smiling": "smile", "smiles": "smile", "laughing": "laugh", "laughs": "laugh", "frowning": "frown", "frowns": "frown",
                   "scared": "afraid", "fear": "afraid", "frightened": "afraid", "shocked": "surprised", "happy": "smile", "upset": "sad",
                   "crying": "sad", "furious": "angry", "mad": "angry", "disgusted": "disgust", "talks": "talking", "speaking": "talking",
                   "yelling": "shouting", "shouts": "shouting", "screaming": "shouting", "calm": "neutral", "blank": "neutral", "closed_eyes": "eyes_closed"},
    "flicker": {"on": "candle", "flickering": "candle", "fire": "candle", "flame": "candle", "fluoro": "fluorescent", "broken": "fluorescent",
                "television": "tv", "storm": "lightning", "flash": "strobe", "cop": "police", "steady": "off", "true": "candle", "false": "off"},
    "finish": {"shiny": "gloss", "glossy": "gloss", "flat": "matte", "metal": "metallic", "mirror": "chrome"},
}
_NUM_WORDS = {"tint": {"dark": 0.9, "limo": 1.0, "black": 1.0, "light": 0.4, "clear": 0.0, "none": 0.0, "on": 0.85},
              "dirt": {"muddy": 0.85, "filthy": 0.95, "dirty": 0.7, "dusty": 0.4, "clean": 0.0, "spotless": 0.0},
              "damage": {"wrecked": 0.95, "smashed": 0.8, "crashed": 0.8, "crumpled": 0.7, "dented": 0.3, "scratched": 0.15, "fixed": 0.0, "none": 0.0},
              "steer": {"left": 28, "hard_left": 38, "right": -28, "hard_right": -38, "straight": 0},
              "head_pitch": {"up": 25, "high": 25, "down": -30, "low": -30, "level": 0},
              "head_yaw": {"left": 40, "right": -40, "ahead": 0}, "tail_swish": {"on": 0.8, "swishing": 0.8, "still": 0, "off": 0},
              "tail_lift": {"up": 40, "high": 40, "down": -15, "clamped": -15}}


def normalize(part: str, value) -> tuple:
    """(value, None) or (None, why)."""
    t = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    if part in ENUMS:
        t = _ENUM_ALIAS.get(part, {}).get(t, t)
        if part == "flicker" and t == "off":
            return "off", None
        return (t, None) if t in ENUMS[part] else (None, f"part: '{value}' isn't a {part.replace('_', ' ')} setting ({', '.join(ENUMS[part])})")
    if part in DOORS + LIDS + ["doors"]:
        w = _DOOR_WORDS.get(t.replace("_", " "), _DOOR_WORDS.get(t))
        if w is not None:
            return (70 if part in LIDS and w == 65 else w), None
    w = _NUM_WORDS.get(part, {}).get(t)
    if w is not None:
        return w, None
    m = re.search(r"-?\d+(?:\.\d+)?", t.replace("_", " "))
    if not m:
        return None, f"part: '{value}' isn't a value for the {part.replace('_', ' ')}"
    lo, hi = RANGES.get(part, (-1e9, 1e9))
    x = float(m.group())
    if part in ("tint", "dirt", "damage", "tail_swish") and x > 1:
        x /= 100.0                                               # "70%"
    return round(min(max(x, lo), hi), 3), None


def finish(out: dict, work: dict, default_vehicle) -> str | None:
    """Tool-level checks once the args are parsed: the value, and a default target. Returns why it's invalid, or None."""
    part = out["part"]
    v, why = normalize(part, out["value"])
    if why:
        return why
    out["value"] = v
    actors = work.get("actors") or []
    if part in LIGHT_PARTS:
        lights = (work.get("lighting") or {}).get("lights") or []
        if not lights:
            return "part: there's no film light on set (add one first)"
        name = str(out.get("light") or out.get("target") or "").lower()
        hit = next((l for l in lights if name and (name in str(l.get("name", "")).lower() or name in str(l.get("type", "")))), None)
        hit = hit or next((l for l in lights if l.get("type") == "practical"), None) or lights[0]
        out["light"], out["light_id"] = hit.get("name") or hit.get("id"), hit.get("id")
        out.pop("target", None); out.pop("target_id", None)
        return None
    tgt = next((a for a in actors if a.get("id") == out.get("target_id")), None)
    if part in VEHICLE_PARTS:
        if tgt is not None and tgt.get("kind") in PEOPLE and tgt.get("mount_id"):
            tgt = next((a for a in actors if a.get("id") == tgt["mount_id"]), tgt)       # "Mara's door" = her car's
        if tgt is None or not _is_vehicle(tgt):
            tgt = default_vehicle(work)
        if tgt is None:
            return "part: there's no vehicle on set"
        if part == "lightbar" and tgt.get("kind") != "police_car":
            cop = next((a for a in actors if a.get("kind") == "police_car"), None)
            if cop is None:
                return f"part: the {tgt.get('name', 'vehicle')} has no light bar (only the police car does)"
            tgt = cop
    elif part in HORSE_PARTS:
        if tgt is None or tgt.get("kind") != "horse":
            tgt = tgt if tgt is not None and tgt.get("kind") == "horse" else next((a for a in actors if a.get("kind") == "horse"), None)
        if tgt is None:
            return "part: there's no horse on set"
    elif part == "expression":
        if tgt is None or tgt.get("kind") not in PEOPLE:
            tgt = next((a for a in actors if a.get("kind") in PEOPLE), None)
        if tgt is None:
            return "part: there's nobody on set to make that face"
    out["target"], out["target_id"] = tgt.get("name") or tgt.get("id"), tgt["id"]
    return None


def _is_vehicle(a: dict) -> bool:
    return a.get("kind") in {"car", "police_car", "sports_car", "hatchback", "truck", "bus", "motorcycle", "bicycle", "boat", "jetski",
                             "sailboat", "catamaran", "airliner", "train"}


_WORD = {"door_fl": "the driver's door", "door_fr": "the passenger door", "door_rl": "the rear left door", "door_rr": "the rear right door",
         "doors": "every door", "hood": "the hood", "trunk": "the trunk"}


def plan_words(a: dict) -> str:
    """'open the police car's driver's door at 2 s' (the Director's plan line, after "I'll ")."""
    p, v = a["part"], a["value"]
    who = (a.get("target") or a.get("light") or "").lower()
    at = f" at {float(a['at']):g} s" if a.get("at") is not None else ""
    if p in _WORD:
        verb = "open" if float(v) > 8 else "crack open" if float(v) > 1.5 else "close"
        return f"{verb} {_WORD[p]} of the {who}{at}" + (f" ({float(v):g}°)" if verb == "open" else "")
    words = {
        "headlights": {"off": "switch the {w}'s headlights off", "low": "switch the {w}'s headlights on", "high": "put the {w}'s headlights on full beam", "auto": "leave the {w}'s headlights automatic"},
        "lightbar": {"flash": "turn on the {w}'s red and blue lights", "steady": "light the {w}'s light bar", "off": "turn off the {w}'s roof lights"},
        "indicator": {"left": "put the {w}'s left indicator on", "right": "put the {w}'s right indicator on", "hazard": "put the {w}'s hazards on", "off": "turn the {w}'s indicators off"},
        "brake": {"on": "light the {w}'s brake lights", "off": "keep the {w}'s brake lights off", "auto": "let the {w}'s brake lights follow its braking"},
        "wipers": {"off": "stop the {w}'s wipers", "intermittent": "set the {w}'s wipers to intermittent", "normal": "start the {w}'s wipers", "fast": "run the {w}'s wipers fast"},
        "gait": {g: f"put the {{w}} into a {g}" for g in ("walk", "trot", "canter", "gallop")} | {"idle": "stand the {w} still", "auto": "let the {w} pick its gait"},
        "flicker": {f: "make the {w} flicker" + ("" if f == "off" else f" ({f})") for f in ENUMS["flicker"]} | {"off": "make the {w} burn steady"},
    }
    if p in words and v in words[p]:
        return words[p][v].format(w=who) + at
    if p == "expression":
        from ..look.objstate import EXPR
        return f"have {a.get('target') or who} {'relax their face' if v == 'neutral' else 'start ' + EXPR.get(v, str(v))}{at} (it goes into the prompt)"
    if p == "head_pitch":
        return f"{'raise' if float(v) > 0 else 'lower'} the {who}'s head ({float(v):+g}°){at}"
    label = {"steer": "steering", "susp_h": "ride height", "susp_roll": "body roll", "susp_pitch": "body pitch", "tint": "window tint",
             "dirt": "dirt", "damage": "damage", "finish": "paint finish", "head_pitch": "head height", "head_yaw": "head turn", "neck": "neck",
             "tail_lift": "tail", "tail_swish": "tail swish", "intensity": "intensity", "kelvin": "colour temperature"}.get(p, p.replace("_", " "))
    return f"set the {who}'s {label} to {v}{at}"


# ------------------------------------------------------------------ rules (no model): the common phrasings

_AT = re.compile(r"\b(?:at|after|from)\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b|\b(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\s+in\b")


def at_seconds(cl: str):
    m = _AT.search(cl)
    return float(m.group(1) or m.group(2)) if m else None


def rules(cl: str, work: dict, last_person=None) -> list[dict]:
    """Part calls in one clause (lower case), or []."""
    out: list[dict] = []
    at = at_seconds(cl)
    t = re.sub(r"\b(?:at|after|from)\s+\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\b", " ", cl)
    tgt = _target_words(t, work)

    def add(part, value, **kw):
        c = {"tool": "part", "part": part, "value": value, **({"target": tgt} if tgt and "target" not in kw and part not in LIGHT_PARTS else {}), **kw}
        if at is not None:
            c["at"] = at
        out.append(c)

    # Doors, hood, trunk.
    m = re.search(r"\b(open|opens|opening|close|closes|shut|shuts|slam|slams|crack|cracks|swing open|swings open|pop|pops)\b(?:\s+\w+){0,4}?\s+"
                  r"(?:the\s+|his\s+|her\s+|its\s+|their\s+)?(?:(driver'?s?|passenger'?s?|rear left|rear right|back left|back right|front left|front right|"
                  r"left rear|right rear|left|right|all(?: the)?|every|all four|both)\s+)?(doors?|hood|bonnet|trunk|boot|hatch(?:back)?|tailgate|lid)\b", t)
    if m:
        verb, which, what = m.group(1), (m.group(2) or "").replace("'", "").replace(" the", ""), m.group(3)
        value = 0 if verb.startswith(("close", "shut", "slam")) else 12 if verb.startswith("crack") else 65
        if what in ("hood", "bonnet"):
            add("hood", 70 if value == 65 else value)
        elif what in ("trunk", "boot", "hatch", "hatchback", "tailgate", "lid"):
            add("trunk", 75 if value == 65 else value)
        elif what == "doors" or which in ("all", "every", "all four", "both"):
            add("doors", value)
        else:
            d = {"driver": "door_fl", "drivers": "door_fl", "front left": "door_fl", "left": "door_fl", "passenger": "door_fr", "passengers": "door_fr",
                 "front right": "door_fr", "right": "door_fr", "rear left": "door_rl", "back left": "door_rl", "left rear": "door_rl",
                 "rear right": "door_rr", "back right": "door_rr", "right rear": "door_rr"}.get(which, "door_fl")
            add(d, value)
    # Lights. on/off for the light bar, headlights, brake lights, hazards, wipers.
    onoff = "off" if re.search(r"\b(off|kill|cut|douse|stop|no)\b", t) else "on"
    if re.search(r"\b(police lights|cop lights|light ?bar|lights and sirens?|sirens?|flashers|the blues|blues and twos|cherr(?:y|ies)|red and blue)\b", t):
        add("lightbar", "off" if onoff == "off" else "flash")
    elif re.search(r"\b(full beams?|high beams?|brights)\b", t):
        add("headlights", "off" if onoff == "off" else "high")
    elif re.search(r"\b(head ?lights?|headlamps?|dipped beams?)\b", t):
        add("headlights", "off" if onoff == "off" else "low")
    if re.search(r"\b(hazards?|hazard lights|four[- ]ways)\b", t):
        add("indicator", "off" if onoff == "off" else "hazard")
    else:
        m2 = re.search(r"\b(?:indicates?|signals?)\s+(left|right)\b|\b(left|right)\s+(?:indicator|turn signal|blinker)\b", t)
        if m2:
            add("indicator", m2.group(1) or m2.group(2))
        elif re.search(r"\b(indicators?|turn signals?|blinkers?)\b", t) and onoff == "off":
            add("indicator", "off")
    if re.search(r"\bbrake ?lights?\b", t):
        add("brake", "off" if onoff == "off" else "on")
    if re.search(r"\bwipers?\b", t):
        add("wipers", "off" if onoff == "off" else "fast" if re.search(r"\b(fast|full)\b", t) else "intermittent" if "intermittent" in t else "normal")
    if re.search(r"\btinted\b|\btint (?:the )?windows\b|\blimo tint\b", t):
        add("tint", 0.9)
    m3 = re.search(r"\b(muddy|filthy|dirty|dusty|clean)\b", t)
    if m3 and re.search(r"\b(car|truck|van|vehicle|bike|motorcycle|boat|cruiser|it)\b", t):
        add("dirt", m3.group(1))
    m4 = re.search(r"\b(smash|smashed|crumple|crumpled|dent|dented|wreck|wrecked|crash damage|damage)\b(?:\s+\w+){0,3}?\s+(?:the\s+)?(front|nose|rear|back|left|right|side)?", t)
    if m4 and not re.search(r"\b(crate|box|boxes|crates)\b", t):
        side = {"nose": "front", "back": "rear", "side": "left"}.get(m4.group(2) or "front", m4.group(2) or "front")
        add("damage", 0.75 if m4.group(1).startswith(("smash", "crumple", "wreck", "crash")) else 0.3)
        add("damage_side", side)
    m5 = re.search(r"\b(?:turn|steer|crank)s?\s+(?:the\s+)?(?:front\s+)?wheels?\s+(?:hard\s+)?(left|right|straight)\b", t)
    if m5:
        add("steer", ("hard_" if "hard" in t else "") + m5.group(1) if m5.group(1) != "straight" else "straight")
    # Horses.
    horse = any(a.get("kind") == "horse" for a in work.get("actors") or [])
    if horse and re.search(r"\bhorse|\bmare|\bstallion|\bpony|\bits head|\bits tail\b", t):
        if re.search(r"\b(lifts|raises|throws up|throws|tosses|lift|raise)\b.*\bhead\b", t):
            add("head_pitch", 28)
        elif re.search(r"\b(lowers|drops|lower|drop|grazes|graze)\b.*\bhead\b|\bhead down\b|\bgrazes?\b", t):
            add("head_pitch", -32)
        if re.search(r"\b(turns|turn)\b.*\bhead\b.*\b(left|right)\b", t):
            add("head_yaw", re.search(r"\b(left|right)\b", t).group(1))
        if re.search(r"\bswish(?:es|ing)?\b.*\btail\b|\btail\s+swish", t):
            add("tail_swish", 0.8)
        g = re.search(r"\b(walks?|trots?|canters?|gallops?|halts?|stands still|breaks into a (walk|trot|canter|gallop))\b", t)
        if g:
            w = g.group(2) or g.group(1)
            add("gait", {"walks": "walk", "trots": "trot", "canters": "canter", "gallops": "gallop", "halts": "idle", "halt": "idle", "stands still": "idle"}.get(w, w))
    # Faces.
    # Only face verbs: "looks angry" / "nervous" stay performance notes (the direct tool).
    m6 = re.search(r"\b(smiles?|smiling|laughs?|laughing|frowns?|frowning|scowls?|cries|crying|closes (?:his|her|their) eyes)\b", t)
    if m6:
        w = m6.group(1)
        e = ("smile" if w.startswith("smil") else "laugh" if w.startswith("laugh") else "frown" if w.startswith(("frown", "scowl")) else
             "sad" if w.startswith(("cr", "gets upset")) or "sad" in w else "afraid" if re.search(r"scared|afraid", w) else
             "surprised" if re.search(r"surprised|shocked", w) else "disgust" if "disgust" in w else "angry" if "angry" in w else
             "shouting" if w.startswith(("shout", "yell", "scream")) else "eyes_closed" if "eyes" in w else "neutral")
        who = tgt if tgt and _person_named(tgt, work) else (last_person or {}).get("name")
        add("expression", e, **({"target": who} if who else {}))
    # Film lights.
    m7 = re.search(r"\b(flicker(?:s|ing)?|strobe|pulse|pulsing)\b", t)
    if m7 and re.search(r"\b(light|lamp|practical|key|fill|rim|bulb|neon|sconce|candle|tv|fluorescent)\b", t):
        kind = "fluorescent" if re.search(r"fluoro|fluorescent|tube|broken|failing", t) else "tv" if re.search(r"\btv\b|television", t) else \
            "lightning" if "lightning" in t else "police" if re.search(r"police|red and blue", t) else "strobe" if "strobe" in t else \
            "pulse" if "puls" in t else "off" if re.search(r"\b(stop|no longer|steady)\b", t) else "candle"
        lw = re.search(r"\b(practical|key|fill|rim|spot|neon)\b", t)
        add("flicker", kind, **({"light": lw.group(1)} if lw else {}))
    return out


def _person_named(name, work):
    return any(str(a.get("name", "")).lower() == str(name).lower() and a.get("kind") in PEOPLE for a in work.get("actors") or [])


def _target_words(t: str, work: dict):
    """The object a clause names (its name, or its kind's words), else None."""
    best = None
    for a in work.get("actors") or []:
        nm = str(a.get("name", "")).lower()
        kind = str(a.get("kind", "")).replace("_", " ")
        words = {nm, kind} | ({"cop car", "cruiser", "police"} if a.get("kind") == "police_car" else set()) | \
                ({"horse"} if a.get("kind") == "horse" else set())
        first = nm.split()[0] if nm.split() else ""
        if first and len(first) > 2 and first not in ("the", "car", "man", "woman") and re.search(rf"\b{re.escape(first)}\b", t):
            words.add(first)
        for w in words:
            if w and re.search(rf"\b{re.escape(w)}\b", t) and (best is None or len(w) > best[0]):
                best = (len(w), a.get("name") or a.get("id"))
    return best[1] if best else None
