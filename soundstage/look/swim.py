"""Swimmers in words (web/stage/swim.mjs on the stage): the dive kit, the regulator IN the mouth, the stroke and the
exhaled bubbles, so frame 1 and the video carry what the clay shows.

The Hollywood reef take of 2026-11-01 painted the regulator hanging below the mouth and a diver gliding with hardly a
kick: neither was in the prompt. Now a diver on the reef set reads "the regulator's mouthpiece held in his mouth, its
hose looping over his right shoulder to the tank valve" in both prompts, the still's negative carries the dangling
regulator, and the motion prompt names the kick (flutter / frog / hovering), the bursts of bubbles every few seconds
and the gentle drift of straps and hose. People in a water tank or open water swim at the surface (freestyle,
breaststroke, treading water) with their stroke in words. LTX reads no numbers, so there are none.
"""
from __future__ import annotations

from . import scene as S

UNDER_STYLES = ("flutter", "frog", "stroke", "hover")
PERSON = ("man", "woman", "child")
REEF_SURFACE = 10.0          # web/stage/sets/underwater.mjs SURFACE


def _speed(a: dict, frames: int, fps: float) -> float:
    p0, p1 = S._pos_at(a, 0, frames - 1), S._pos_at(a, frames - 1, frames - 1)
    return ((p1[0] - p0[0]) ** 2 + (p1[2] - p0[2]) ** 2) ** 0.5 / max(0.1, (frames - 1) / fps)


def swimmers(scene: dict) -> list[dict]:
    """[{actor, mode ("under" | "surface"), style, gear, he, his}] for every person who swims on this shot."""
    env = scene.get("environment") or {}
    sset = env.get("set")
    frames, fps = S.frame_range(scene)
    out = []
    for a in scene.get("actors") or []:
        if a.get("kind") not in PERSON or a.get("mount_id") or a.get("swim") == "off":
            continue
        y0 = S._pos_at(a, 0, frames - 1)[1]
        y1 = S._pos_at(a, frames - 1, frames - 1)[1]
        v = _speed(a, frames, fps)
        style = a.get("swim")
        if sset == "underwater":
            if min(y0, y1) <= 0.8:
                continue                                  # on the seabed: they walk (scene.actor_marks says the same)
            h = float(a.get("height_m") or 1.8) * float(a.get("scale") or 1)
            mode = "surface" if min(y0, y1) + 0.95 * h / 1.8 >= REEF_SURFACE - 0.45 else "under"
        elif sset in ("water_tank", "open_water"):
            mode = "under" if style in UNDER_STYLES and min(y0, y1) > 0.35 else "surface"
        else:
            continue
        if mode == "under":
            style = "hover" if v < 0.12 else ("frog" if style == "frog" else "stroke" if style == "stroke" else "flutter")
        else:
            style = style if style in ("freestyle", "breaststroke") else "tread" if v < 0.12 else "breaststroke" if v < 0.75 else "freestyle"
            if v < 0.12:
                style = "tread"
        gear = a.get("gear") or ("scuba" if mode == "under" else "none")
        female = a.get("kind") == "woman" or (a.get("appearance") or {}).get("gender") == "female"
        out.append({"actor": a, "mode": mode, "style": style, "gear": gear, "he": "she" if female else "he",
                    "his": "her" if female else "his", "speed": v})
    return out


def _who(sw: list[dict], i: int) -> str:
    """The same noun the blocking sentence uses ("the man"), or "each diver" when several swim the same way."""
    one = sum(1 for x in sw if x["mode"] == sw[i]["mode"]) == 1
    if one:
        return S.definite(S.classify(sw[i]["actor"])[0])
    return "each diver" if sw[i]["mode"] == "under" else "each swimmer"


def _gear(x: dict) -> str:
    fins = "long fins" if (x["actor"].get("appearance") or {}).get("fins_color") else "long yellow fins"
    if x["gear"] == "scuba":
        return (f"a scuba tank and a black buoyancy jacket, a dive mask and {fins}, the regulator's mouthpiece held "
                f"in {x['his']} mouth with its black hose looping over {x['his']} right shoulder to the tank valve")
    if x["gear"] == "freedive":
        return f"a dive mask, a snorkel and very long freediving fins, holding {x['his']} breath"
    return ""


STROKE = {
    "flutter": "swims level and trim with slow, steady flutter kicks from the hips, legs nearly straight, the fin blades bending on every kick",
    "stroke": "glides arms outstretched ahead with slow, steady flutter kicks, the fin blades bending on every kick",
    "frog": "swims level with frog kicks: knees drawn up, fins swept out and back together, then a long coasting glide",
    "hover": "hovers motionless and level, rising and sinking a touch with each breath, fins barely sculling",
    "freestyle": ("swims freestyle along the surface, the body rolling with each stroke, arms recovering high over the "
                  "water, a steady kick churning white water, turning the head to the side to breathe"),
    "breaststroke": ("swims breaststroke at the surface: arms sweep out and in, head and shoulders lift to breathe, "
                     "the legs whip round together, then a glide"),
    "tread": "treads water upright with the head and shoulders above the surface, hands sculling and legs circling below",
}


def still_words(scene: dict, ids: set | None = None) -> str:
    """Frame 1: what each swimmer wears and how they lie in the water. ids: who is in frame at frame 0 (the reef
    shot's diver swims in later; his kit in the still painted a diver into the empty open water)."""
    sw = swimmers(scene)
    out = []
    for i, x in enumerate(sw):
        if ids is not None and x["actor"].get("id") not in ids:
            continue
        g = _gear(x)
        lie = "lying level in the water" if x["mode"] == "under" and x["style"] != "tread" else ""
        if x["mode"] == "surface" and x["style"] in ("freestyle", "breaststroke"):
            lie = "swimming face down along the surface"
        bits = [p for p in (g and f"wearing {g}", lie) if p]
        if bits:
            out.append(f"{_who(sw, i)} {', '.join(bits)}")
    return "; ".join(out)


def negative_words(scene: dict, ids: set | None = None) -> str:
    """The still's negative: the regulator out of the mouth is the classic diver failure."""
    if any(x["gear"] == "scuba" and (ids is None or x["actor"].get("id") in ids) for x in swimmers(scene)):
        return "regulator hanging below the chin, regulator out of the mouth, mouthpiece dangling, no fins, walking on the seabed"
    return ""


def motion_sentence(scene: dict) -> str:
    """The video: the stroke, the bubbles and the secondary drift."""
    sw = swimmers(scene)
    out = []
    for i, x in enumerate(sw):
        who = _who(sw, i)
        stroke = STROKE[x["style"]]
        if x["style"] in ("flutter", "stroke") and x["speed"] > 0.8:
            stroke = stroke.replace("slow, steady", "strong, quick")   # past ~0.8 m/s the kick is a sprint
        s = f"{who[0].upper()}{who[1:]} {stroke}"
        if x["gear"] == "scuba" and x["mode"] == "under":
            s += (f", the regulator held in {x['his']} mouth throughout; every few seconds {x['he']} exhales and a burst "
                  "of silver bubbles leaves the regulator and wobbles up toward the surface, growing as it rises; "
                  f"{x['his']} straps and hose drift in the gentle current")
        elif x["gear"] == "freedive":
            s += ", no bubbles: a breath-hold dive"
        out.append(s + ".")
    return " ".join(out)
