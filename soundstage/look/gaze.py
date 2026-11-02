"""Head and gaze blocking in words: where every person in the shot looks, beat by beat (web/stage/gaze.mjs).

The stage owns the head: actor["gaze"] = [{"frame", "target"}] keys (target "ahead", "camera", "left", "right", "up",
"down" or an actor id), or the older single look_at / look_at_frame / look_until. With no keys the head holds steady,
facing the person's travel. LTX invents head turns of its own unless the prompt says what the head does, so every
person in the shot gets one positive sentence (CFG 1: no "don't"):

  no keys, driving       "The man keeps his eyes on the road, his head steady from start to finish."
  no keys, moving        "The woman keeps her head steady, looking where she is going."
  no keys, standing      "The man holds his head still, facing the same way throughout."
  keys                   "The man keeps his head steady, facing ahead; at 2.0 s he turns his head toward the woman
                          and holds it there."

The still (frame 1) only says a look that is already on at frame 0 ("the man looking at the woman").
"""
from __future__ import annotations

from . import scene as S

DIRECTIONS = ("ahead", "camera", "left", "right", "up", "down")
START = 2     # a key at or before this frame is the opening look, not a turn


def gaze_keys(a: dict) -> list[dict]:
    """Same rules as gazeKeys() in web/stage/gaze.mjs."""
    g = a.get("gaze")
    if isinstance(g, list) and g:
        out = [{"frame": max(0, int(round(float(k["frame"])))), "target": str(k["target"])}
               for k in g if isinstance(k, dict) and k.get("target") and k.get("frame") is not None]
        return sorted(out, key=lambda k: k["frame"])
    if a.get("look_at"):
        out = [{"frame": max(0, int(a.get("look_at_frame") or 0)), "target": str(a["look_at"])}]
        if a.get("look_until") is not None:
            out.append({"frame": int(a["look_until"]), "target": "ahead"})
        return out
    return []


def _pron(a: dict) -> tuple[str, str]:
    k = (a.get("kind") or "").lower()
    if k in ("man", "boy"):
        return "he", "his"
    if k in ("woman", "girl"):
        return "she", "her"
    return "they", "their"


def _target_noun(scene: dict, target: str) -> str:
    a = next((x for x in scene.get("actors") or [] if x.get("id") == target), None)
    if a is None:
        return "the camera" if target == "camera" else "something off screen"
    return S.definite(S.classify(a)[0])


def _look(scene: dict, target: str, his: str, first: bool) -> str:
    """'looks at the woman' (first) / 'turns his head toward the woman' (a turn)."""
    if target == "ahead":
        return f"looks straight ahead" if first else f"turns {his} head back to face ahead"
    if target == "camera":
        return "looks straight into the camera" if first else "turns to look straight into the camera"
    if target in ("left", "right"):
        return f"looks off to {his} {target}" if first else f"turns {his} head to {his} {target}"
    if target in ("up", "down"):
        return f"looks {target}" if first else f"tilts {his} head to look {target}"
    who = _target_noun(scene, target)
    return f"looks at {who}" if first else f"turns {his} head toward {who}"


def _seconds(frame: int, fps: float) -> str:
    return f"{frame / fps:.1f} s"


def person_sentence(scene: dict, a: dict, noun: str, moving: bool, driving: bool, fps: float) -> str:
    he, his = _pron(a)
    keys = gaze_keys(a)
    who = S.definite(noun)
    if not keys:
        if driving:
            return f"{who} keeps {his} eyes on the road, {his} head steady from start to finish."
        if moving:
            return f"{who} keeps {his} head steady, looking where {he} {'is' if he != 'they' else 'are'} going."
        return f"{who} holds {his} head still, facing the same way throughout."
    beats = []
    first = keys[0]
    if first["frame"] <= START:
        verb = _look(scene, first["target"], his, True)
        beats.append(f"{who} {verb}" if first["target"] != "ahead" else f"{who} keeps {his} head steady, facing ahead")
        rest = keys[1:]
    else:
        beats.append(f"{who} keeps {his} head steady, facing ahead")
        rest = keys
    prev = first["target"] if first["frame"] <= START else "ahead"
    for k in rest:
        if k["target"] == prev:
            continue
        beats.append(f"at {_seconds(k['frame'], fps)} {he} {_look(scene, k['target'], his, False)}")
        prev = k["target"]
    text = "; ".join(beats)
    if len(beats) > 1:
        text += " and holds it there"
    return text + "."


def _in_shot(scene: dict) -> list[tuple[dict, str, bool, bool]]:
    """(actor, noun, moving, driving) for every person the shot shows (frame 1, or a mover who enters later)."""
    f1 = S.frame1_facts(scene)
    mf = S.motion_facts(scene)
    seen, out = set(), []
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    for e in f1["people"]:
        a = by_id.get(e["id"])
        if a is None or e["id"] in seen:
            continue
        seen.add(e["id"])
        seat = S.seat_of(scene, a) if e.get("seated") else None
        driving = bool(seat and seat[0] == "Driver")
        moving = bool(e.get("riding")) or any(m["id"] == e["id"] for m in mf["marks"]) or driving
        out.append((a, e["noun"].split(" at the wheel")[0].split(" in the ")[0] if e.get("seated") else e["noun"], moving, driving))
    for m in mf["marks"]:
        a = by_id.get(m["id"])
        if a is None or m["id"] in seen or S.classify(a)[1] != "biped":
            continue
        seen.add(m["id"])
        out.append((a, m["noun"], True, False))
    return out


def head_beats(scene: dict) -> str:
    """The motion prompt's head sentences (one per person in the shot), or "" with nobody in it."""
    fps = float((scene.get("shot") or {}).get("fps") or S.frame_range(scene)[1] or 24)
    try:
        people = _in_shot(scene)
    except Exception:  # noqa: BLE001 - a malformed scene never breaks the compile
        return ""
    out, steady = [], {}
    for a, noun, moving, driving in people:
        if gaze_keys(a) or driving:
            out.append(person_sentence(scene, a, noun, moving, driving, fps))
        else:   # people with nothing blocked share one sentence per kind of hold
            steady.setdefault(moving, []).append((a, noun))
    for moving, grp in steady.items():
        if len(grp) == 1:
            out.append(person_sentence(scene, grp[0][0], grp[0][1], moving, False, fps))
        else:
            who = S._join_and([S.definite(n) for _, n in grp])
            out.append(f"{who} keep their heads steady, looking where they are going." if moving else
                       f"{who} hold their heads still, facing the same way throughout.")
    return " ".join(s[:1].upper() + s[1:] for s in out)


def frame1_looks(scene: dict) -> list[str]:
    """Still-prompt words for the looks already on at frame 1: ['the man looking at the woman']."""
    out = []
    try:
        people = _in_shot(scene)
    except Exception:  # noqa: BLE001
        return out
    for a, noun, _, _ in people:
        keys = gaze_keys(a)
        if keys and keys[0]["frame"] <= START and keys[0]["target"] != "ahead":
            _, his = _pron(a)
            out.append(f"{S.definite(noun)} {_look(scene, keys[0]['target'], his, True).replace('looks', 'looking', 1)}")
    return out
