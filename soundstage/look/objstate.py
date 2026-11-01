"""Visible object state for the prompts (Milestone 26): what a viewer sees of each object's Parts channels.

Mirrors web/stage/objparts.mjs (stateWords / partEvents): `a["parts"] = {channel: [{"frame", "v", "i"?}]}`, numbers
ease between keys, modes hold. The still prompt says the state at frame 1 ("the police car with its headlights on,
red and blue roof lights flashing and the driver's door open"); the motion prompt also says timed changes ("At 2.0 s
the driver's door swings open."). Pure Python.
"""
from __future__ import annotations

ENUM_DEF = {"headlights": "auto", "brake": "auto", "indicator": "off", "lightbar": "off", "navlights": "off", "wipers": "off",
            "finish": "factory", "damage_side": "front", "gait": "auto", "expression": "neutral"}
CARS = {"car", "police_car", "sports_car", "hatchback"}
PEOPLE = {"man", "woman", "child"}
DOORS = {"door_fl": "the driver's door", "door_fr": "the passenger door", "door_rl": "the rear left door",
         "door_rr": "the rear right door", "hood": "the hood", "trunk": "the trunk"}
EXPR = {"smile": "smiling", "laugh": "laughing", "frown": "frowning", "angry": "angry", "sad": "sad", "surprised": "surprised",
        "afraid": "afraid", "disgust": "disgusted", "talking": "talking", "shouting": "shouting", "eyes_closed": "eyes closed"}


def channels_for(kind: str) -> list[str]:
    """The channel names an object kind has (= objparts.mjs channelsFor, without the camera / light / prop ones)."""
    if kind in CARS or kind == "truck":
        n = {"sports_car": 2, "truck": 2}.get(kind, 4)
        return (["steer", "susp_h", "susp_roll", "susp_pitch"] + ["door_fl", "door_fr", "door_rl", "door_rr"][:n]
                + ([] if kind == "truck" else ["hood"]) + ["trunk", "headlights", "brake", "indicator"]
                + (["lightbar"] if kind == "police_car" else []) + ["wipers", "tint", "finish", "dirt", "damage", "damage_side"])
    if kind == "motorcycle":
        return ["steer", "headlights", "brake", "indicator", "finish", "dirt", "damage", "damage_side"]
    if kind == "bicycle":
        return ["steer", "finish", "dirt"]
    if kind in ("boat", "jetski", "sailboat", "catamaran"):
        return ["headlights", "navlights", "finish", "dirt", "damage", "damage_side"]
    if kind == "airliner":
        return ["headlights", "navlights", "finish", "dirt"]
    if kind == "train":
        return ["headlights", "finish", "dirt"]
    if kind == "horse":
        return ["head_pitch", "head_yaw", "neck", "tail_lift", "tail_swish", "gait"]
    if kind in PEOPLE:
        return ["expression"]
    return ["finish", "glow"]


def _smooth(u: float) -> float:
    return u * u * (3 - 2 * u)


def sample(keys, frame: float):
    if not keys:
        return None
    if frame <= keys[0]["frame"] or len(keys) == 1:
        return keys[0]["v"]
    if frame >= keys[-1]["frame"]:
        return keys[-1]["v"]
    i = 0
    while keys[i + 1]["frame"] <= frame:
        i += 1
    a, b = keys[i], keys[i + 1]
    if a.get("i") == "step" or not isinstance(a["v"], (int, float)) or not isinstance(b["v"], (int, float)) \
            or isinstance(a["v"], bool):
        return a["v"]
    u = (frame - a["frame"]) / max(1e-6, b["frame"] - a["frame"])
    return a["v"] + (b["v"] - a["v"]) * (u if a.get("i") == "linear" else _smooth(u))


def value(a: dict, ch: str, frame: float):
    v = sample(((a.get("parts") or {}).get(ch)) or [], frame)
    if v is None:
        return ENUM_DEF.get(ch, 0)
    return v


def state_words(a: dict, frame: float = 0) -> list[str]:
    """['headlights on', "the driver's door open"] for an object at a frame (nothing for an untouched object)."""
    kind = a.get("kind") or ""
    has = set(channels_for(kind))
    v = lambda ch: value(a, ch, frame)  # noqa: E731
    out: list[str] = []
    if not a.get("parts"):
        return out
    if "headlights" in has:
        h = v("headlights")
        out += {"low": ["headlights on"], "high": ["headlights on full beam"], "off": ["headlights off"]}.get(h, [])
    if "lightbar" in has:
        out += {"flash": ["red and blue roof lights flashing"], "steady": ["roof light bar lit"]}.get(v("lightbar"), [])
    if "indicator" in has:
        i = v("indicator")
        if i == "hazard":
            out.append("hazard lights blinking")
        elif i in ("left", "right"):
            out.append(f"{i} turn signal blinking")
    if "brake" in has and v("brake") == "on":
        out.append("brake lights glowing red")
    if "navlights" in has and v("navlights") != "off":
        out.append("navigation lights and white strobes flashing" if v("navlights") == "strobe" else "red and green navigation lights on")
    for ch, w in DOORS.items():
        if ch not in has:
            continue
        d = float(v(ch) or 0)
        if d > 45:
            out.append(f"{w} wide open")
        elif d > 8:
            out.append(f"{w} open")
        elif d > 1.5:
            out.append(f"{w} ajar")
    if "wipers" in has and v("wipers") != "off":
        out.append("windscreen wipers sweeping")
    if "tint" in has and float(v("tint") or 0) > 0.6:
        out.append("dark tinted windows")
    if "finish" in has and v("finish") not in (None, "factory"):
        out.append(f"{ {'matte': 'matte', 'satin': 'satin', 'gloss': 'glossy', 'metallic': 'metallic', 'chrome': 'mirror-chrome'}.get(v('finish'), v('finish'))} paint")
    if "dirt" in has:
        d = float(v("dirt") or 0)
        if d > 0.6:
            out.append("caked in mud and road dirt")
        elif d > 0.25:
            out.append("dusty, road-dirty paint")
    if "damage" in has and float(v("damage") or 0) > 0.08:
        side = {"front": "front end", "rear": "rear end", "left": "left side", "right": "right side"}.get(v("damage_side"), "front end")
        out.append(f"{'a badly crumpled' if float(v('damage')) > 0.5 else 'a dented'} {side}")
    if "steer" in has and (a.get("parts") or {}).get("steer"):
        s = float(v("steer") or 0)
        if abs(s) > 12:
            out.append(f"front wheels turned hard {'left' if s > 0 else 'right'}")
    if kind == "horse":
        hp, hy = float(v("head_pitch") or 0), float(v("head_yaw") or 0)
        if hp > 15:
            out.append("head held high")
        elif hp < -20:
            out.append("head low")
        if abs(hy) > 20:
            out.append(f"head turned to its {'left' if hy > 0 else 'right'}")
        if float(v("tail_lift") or 0) > 25:
            out.append("tail carried high")
        if float(v("tail_swish") or 0) > 0.3:
            out.append("tail swishing")
        g = v("gait")
        if g and g != "auto":
            out.append({"idle": "standing", "walk": "at a walk", "trot": "trotting", "canter": "cantering", "gallop": "galloping"}.get(g, g))
    if kind in PEOPLE:
        e = v("expression")
        if e and e != "neutral":
            out.append(EXPR.get(e, e))
    return out


def events(a: dict, last: int) -> list[dict]:
    """Timed changes: [{"frame", "words"}] ("the driver's door swings open")."""
    kind = a.get("kind") or ""
    out = []
    for ch in channels_for(kind):
        keys = ((a.get("parts") or {}).get(ch)) or []
        for i in range(1, len(keys)):
            pa, pb = keys[i - 1], keys[i]
            x, y = pa["v"], pb["v"]
            num = isinstance(y, (int, float)) and not isinstance(y, bool)
            f = pb["frame"] if pa.get("i") == "step" or not num else pa["frame"]
            if x == y or f > last:
                continue
            w = None
            if ch in DOORS and num:
                w = f"{DOORS[ch]} swings open" if y > x + 5 else f"{DOORS[ch]} closes" if x > y + 5 else None
            elif ch == "headlights":
                w = "the headlights switch off" if y == "off" else "the headlights snap on" if x in ("off", "auto") else \
                    "the headlights flick to full beam" if y == "high" else None
            elif ch == "lightbar":
                w = "the roof lights go dark" if y == "off" else "the red and blue roof lights start flashing"
            elif ch == "indicator":
                w = "the turn signal stops" if y == "off" else "the hazard lights start blinking" if y == "hazard" else f"the {y} turn signal starts blinking"
            elif ch == "brake":
                w = "the brake lights flare red" if y == "on" else None
            elif ch == "wipers":
                w = "the wipers stop" if y == "off" else "the wipers start sweeping"
            elif ch == "damage" and num:
                w = "the body crumples" if y > x + 0.1 else None
            elif ch == "expression":
                w = "the face relaxes" if y == "neutral" else f"starts {EXPR.get(y, y)}"
            elif ch == "gait":
                w = None if y == "auto" else f"breaks into a {'halt' if y == 'idle' else y}"
            elif ch == "head_pitch" and num:
                w = "throws its head up" if y > x + 15 else "drops its head" if x > y + 15 else None
            if w:
                out.append({"frame": f, "ch": ch, "words": w})
    return sorted(out, key=lambda e: e["frame"])


def _noun(a: dict) -> str:
    return str(a.get("name") or a.get("kind", "object").replace("_", " ")).strip().lower()


def still_words(scene: dict, ids: set | None = None) -> str:
    """'The police car has its headlights on and the driver's door open.' for objects in frame (ids) at frame 0."""
    out = []
    for a in scene.get("actors") or []:
        if ids is not None and a.get("id") not in ids:
            continue
        w = state_words(a, 0)
        if not w:
            continue
        noun = _noun(a)
        if a.get("kind") in PEOPLE:
            out.append(f"{noun[:1].upper()}{noun[1:]} is {', '.join(w)}.")
        else:
            body = ", ".join(w[:-1]) + (" and " if len(w) > 1 else "") + w[-1]
            out.append(f"The {noun} has {body}." if not noun.startswith("the ") else f"{noun[:1].upper()}{noun[1:]} has {body}.")
    return " ".join(out)


def motion_beats(scene: dict, ids: set | None = None) -> str:
    """'At 2.0 s the police car's driver's door swings open.' (timed changes inside the shot)."""
    fps = float((scene.get("shot") or {}).get("fps") or 24)
    last = int((scene.get("shot") or {}).get("frames") or 97) - 1
    beats = []
    for a in scene.get("actors") or []:
        if ids is not None and a.get("id") not in ids:
            continue
        for e in events(a, last):
            if e["frame"] <= 0:
                continue
            who = _noun(a)
            words = e["words"]
            if words.startswith("the "):
                words = f"the {who}'s {words[4:]}"
            else:
                words = f"the {who} {words}"
            words = words.replace("driver's door", "driver door")
            beats.append((e["frame"], f"At {e['frame'] / fps:.1f} s {words}."))
    return " ".join(b for _, b in sorted(beats))
