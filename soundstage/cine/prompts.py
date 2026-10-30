"""Shot -> prompt compilers. Deterministic templates, never the LLM.

LTX (ltx.io 2.3 prompt guide + 2.5 camera guide, research/08 §8): one flowing present-tense
paragraph in the order shot -> scene/lighting -> blocking in frame terms -> action -> camera ->
audio; open with the shot scale; one size and one move per generation; use the documented verbs
verbatim; describe the destination frame after a move; no numeric specs.

Still (Krea 2 look frame): describes FRAME 1 ONLY. Feeding the look still the motion prompt made
Krea draw the cast twice (docs/decisions.md 2026-10-27 21:30), so the still prompt never mentions
movement or where people end up, and it states the head count.

H3 (MiniMax guide): [Shot 1] style + framing, motion = type + amplitude + speed.
"""
from __future__ import annotations

SIZE_LTX = {
    "EWS": "Extreme wide shot", "WS": "Wide shot", "FS": "Full shot",
    "COWBOY": "Medium wide cowboy shot framed from mid-thigh up", "MS": "Medium shot",
    "MCU": "Medium close-up", "CU": "Close-up", "ECU": "Extreme close-up", "INSERT": "Insert close-up",
}
SIZE_STILL = {
    "EWS": "extreme wide shot", "WS": "wide shot", "FS": "full-length shot", "COWBOY": "cowboy shot from mid-thigh up",
    "MS": "medium shot from the waist up", "MCU": "medium close-up from the chest up", "CU": "close-up of the face",
    "ECU": "extreme close-up of the eyes", "INSERT": "insert close-up",
}
SIZE_H3 = {"EWS": "an extreme wide shot", "WS": "a wide shot", "FS": "a full shot", "COWBOY": "a cowboy shot",
           "MS": "a medium shot", "MCU": "a medium close-up", "CU": "a close-up", "ECU": "an extreme close-up",
           "INSERT": "an insert close-up"}
TIGHTER = {"EWS": "a wide shot", "WS": "a full shot", "FS": "a cowboy shot", "COWBOY": "a medium shot",
           "MS": "a medium close-up", "MCU": "a close-up", "CU": "a big close-up", "ECU": "the eyes alone",
           "INSERT": "the detail alone"}
LOOSER = {"ECU": "a close-up", "CU": "a medium close-up", "MCU": "a medium shot", "MS": "a cowboy shot",
          "COWBOY": "a full shot", "FS": "a wide shot", "WS": "an extreme wide shot", "EWS": "the whole landscape",
          "INSERT": "a medium shot"}
ANGLE_WORDS = {"low": "low angle", "high": "high angle", "overhead": "overhead view", "eye": "eye level",
               "worms_eye": "extreme low angle from the ground", "dutch": "Dutch angle"}
HEIGHT_WORDS = {"ground": "from ground level", "knee": "from knee height", "hip": "from hip height",
                "seated": "from seated eye height", "chest": "from chest height", "eye": "at eye level",
                "high": "from above", "aerial": "from high in the air"}
FRAMING_WORDS = {"ots": "over-the-shoulder", "fifty_fifty": "profile two-shot", "two_shot": "two-shot",
                 "three_shot": "three-shot", "establishing": "wide establishing shot", "pov": "point-of-view shot",
                 "dirty_single": "dirty single", "group": "group shot", "master": "master shot"}
H3_MOVES = {
    "static": "The camera holds a static shot.", "dolly_in": "The camera pushes in", "dolly_out": "The camera pulls out",
    "pan_left": "The camera pans left", "pan_right": "The camera pans right", "tilt_up": "The camera tilts up",
    "tilt_down": "The camera tilts down", "truck_left": "The camera trucks left", "truck_right": "The camera trucks right",
    "track_follow": "The camera tracks", "track_lead": "The camera pulls out", "steadicam_follow": "The camera tracks",
    "arc_left": "The camera arcs", "arc_right": "The camera arcs", "crane_up": "The camera pedestals up",
    "crane_down": "The camera pedestals down", "handheld": "The camera shakes slightly", "zoom_in": "The camera zooms in",
    "snap_zoom": "The camera zooms in", "whip_pan": "The camera pans", "dolly_zoom": "The camera pushes in",
    "rack_focus": "The camera holds a static shot.",
}
DOF_WORDS = {"shallow": "shallow depth of field, background falling out of focus", "medium": "moderate depth of field",
             "deep": "deep focus, foreground and background both sharp"}


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _join(parts, sep=", "):
    return sep.join(p for p in parts if p)


def cast_desc(context: dict, cid: str) -> str:
    for c in context.get("cast", []):
        if c["id"] == cid:
            return c["description"]
    return "a figure"


def subject_phrase(shot: dict, context: dict) -> str:
    sub = shot["subject"]
    if sub in ("A", "B", "C"):
        return cast_desc(context, sub)
    if sub in ("A_hands", "B_hands"):
        return f"the hands of {cast_desc(context, sub[0])}"
    if sub == "both":
        ids = [c["id"] for c in context.get("cast", [])][:2]
        return " and ".join(cast_desc(context, i) for i in ids) or "two people"
    if sub == "all":
        return _join([c["description"] for c in context.get("cast", [])], ", ")
    if sub == "prop":
        return "the object at the centre of the scene"
    return "the location"


def definite(desc: str) -> str:
    """'a rival gunfighter' -> 'the rival gunfighter'; names and 'the ...' pass through."""
    for art in ("a ", "an "):
        if desc.startswith(art):
            return "the " + desc[len(art):]
    return desc


def detail_from_purpose(shot: dict, context: dict) -> str:
    """The descriptive half of a purpose ('insert: B's fingers flex above the holster')."""
    text = shot.get("purpose", "")
    if ":" in text:
        text = text.split(":", 1)[1]
    names = {c["id"]: c["description"] for c in context.get("cast", [])}
    for cid in ("A", "B", "C"):
        d = names.get(cid, "")
        if d:
            the = definite(d)
            text = text.replace(f"{cid}'s", f"{the}'s").replace(f" {cid} ", f" {the} ").replace(f"on {cid}", f"on {the}")
            if text.endswith(f" {cid}"):
                text = text[: -len(cid)] + the
    import re
    words = {"EWS": "extreme wide", "WS": "wide shot", "MS": "medium shot", "MCU": "medium close-up",
             "CU": "close-up", "ECU": "extreme close-up", "OTS": "over-the-shoulder", "POV": "point of view",
             "FG": "foreground", "BG": "background"}
    text = re.sub(r"\b(EWS|WS|MS|MCU|CU|ECU|OTS|POV|FG|BG)\b", lambda m: words[m.group(1)], text)
    return _neutral_pronouns(text.strip(), shot, context)


def _neutral_pronouns(text: str, shot: dict, context: dict) -> str:
    """Recipes are written about an example cast ('wide on her at the desk'); retarget them at the real one."""
    import re
    sub_id = shot["subject"][0] if shot["subject"][:1] in "ABC" else None
    desc = definite(cast_desc(context, sub_id)) if sub_id else "them"
    obj = r"(?=\s*(?:$|[,.;:)]|\s(?:at|in|on|as|while|until|and|from|with|is|to|into|across|behind)\b))"
    text = re.sub(r"\b(?:her|him)\b" + obj, desc, text)
    text = re.sub(r"\b(?:her|his)\b", "their", text)
    text = re.sub(r"\b(?:she|he)\b", desc, text)
    return text


def location_phrase(context: dict) -> str:
    loc = context.get("location", {})
    place = loc.get("place") or ("a room" if loc.get("int_ext") == "INT" else "an open landscape")
    article = "" if place.startswith(("a ", "an ", "the ")) else ("an " if place[:1] in "aeiou" else "a ")
    return _join([article + place, loc.get("time_of_day") and f"at {loc['time_of_day']}"], " ")


def blocking_sentence(shot: dict, context: dict) -> str:
    parts = []
    for b in shot.get("blocking", {}).get("subjects", []):
        if not b.get("visible"):
            continue
        desc = b["description"]
        where = b["frame_position"]
        facing = b.get("facing", "")
        verb = "stands" if shot["size"] in ("WS", "FS", "COWBOY", "EWS") and shot["subject"] in ("A", "B", "C") else "is"
        parts.append(_join([f"{desc} {verb} {where}", facing], ", "))
    if not parts:
        return ""
    return _cap("; ".join(parts)) + "."


def camera_sentence(shot: dict, context: dict) -> str:
    mv, speed = shot["movement"]["id"], shot["movement"].get("speed", "regular")
    who = subject_phrase(shot, context)
    adv = {"slow": " slowly", "fast": " quickly"}.get(speed, "")
    size = shot["size"]
    dest_in = ("as the move completes, only the eyes fill the frame" if size == "ECU" else
               "as the move completes, only the detail fills the frame" if size == "INSERT" else
               f"as the move completes, {TIGHTER[size]} of {definite(who)} fills the frame")
    dest_out = f"as the move completes, {LOOSER[size]} reveals the space around {who}"
    return {
        "static": "Static frame.",
        "handheld": "Handheld movement, the frame breathing slightly as it holds on the action.",
        "dolly_in": f"The camera pushes in{adv}; {dest_in}.",
        "dolly_out": f"The camera pulls back{adv}; {dest_out}.",
        "pan_left": f"The camera pans across to the left{adv}.",
        "pan_right": f"The camera pans across to the right{adv}.",
        "tilt_up": f"The camera tilts upward{adv}.",
        "tilt_down": f"The camera tilts downward{adv}.",
        "truck_left": f"The camera tracks sideways to the left{adv}, keeping {who} in frame.",
        "truck_right": f"The camera tracks sideways to the right{adv}, keeping {who} in frame.",
        "track_follow": f"The camera follows {who} from behind{adv}.",
        "steadicam_follow": f"The camera follows {who}{adv} in one continuous shot.",
        "track_lead": f"The camera tracks backward ahead of {who}{adv}, keeping the framing.",
        "arc_left": f"The camera circles around {who}{adv}.",
        "arc_right": f"The camera circles around {who}{adv}.",
        "crane_up": f"The camera rises upward{adv} on a jib; as the move completes, the frame looks down over {who}.",
        "crane_down": f"The camera descends{adv} on a jib toward {who}.",
        "zoom_in": f"The camera slowly zooms in; {dest_in}.",
        "snap_zoom": f"A sudden snap zoom punches in on {who}.",
        "whip_pan": "A fast whip pan blurs across the scene.",
        "dolly_zoom": f"The camera pushes in while zooming out, the background stretching away behind {who}.",
        "rack_focus": "Static frame; focus racks from the foreground to the background.",
    }[mv]


def compile_ltx(shot: dict, context: dict) -> str:
    style = context.get("style", {})
    loc = context.get("location", {})
    head = _join([
        f"{'Interior' if loc.get('int_ext') == 'INT' else 'Exterior'} {SIZE_LTX[shot['size']].lower()}",
        FRAMING_WORDS.get(shot.get("framing", "")),
        ANGLE_WORDS.get(shot["angle"]["vertical"]) if shot["angle"]["vertical"] != "eye" else "",
        location_phrase(context),
    ])
    light = _join([shot.get("lighting"), _join(loc.get("weather", []))])
    action = detail_from_purpose(shot, context)
    sentences = [
        _cap(head) + ".",
        _cap(light) + "." if light else "",
        blocking_sentence(shot, context),
        _cap(action) + "." if action and shot["subject"] != "env" else "",
        camera_sentence(shot, context),
        style.get("ltx", ""),
        _cap(_join(style.get("sound", [])[:2], "; ")) + "." if style.get("sound") else "",
    ]
    return " ".join(s for s in sentences if s).replace("..", ".")


def visible_count(shot: dict) -> int:
    return sum(1 for b in shot.get("blocking", {}).get("subjects", []) if b.get("visible"))


def _layout_free(text: str) -> str:
    """Drop composition notes that name screen sides: the measured blocking already says where people are."""
    import re
    return "" if re.search(r"\b(left|right|third|edge)\b", text) else text


def compile_still(shot: dict, context: dict) -> tuple[str, str]:
    """Frame-1-only look-still prompt and its negative."""
    style = context.get("style", {})
    loc = context.get("location", {})
    lens = shot["lens"]
    who = subject_phrase(shot, context)
    placed = []
    for b in shot.get("blocking", {}).get("subjects", []):
        if b.get("visible"):
            placed.append(_join([f"{b['description']} {b['frame_position']}", b.get("facing", "")], " "))
    n = visible_count(shot)
    count = {0: "no people in frame", 1: "exactly one person in frame",
             2: "exactly two people in frame", 3: "exactly three people in frame"}.get(n, f"{n} people in frame")
    framing = FRAMING_WORDS.get(shot.get("framing", ""), "")
    prompt = _join([
        style.get("still", "cinematic film still"),
        _join([SIZE_STILL[shot["size"]], framing and f"({framing})", "of", who if shot["subject"] != "env" else "the location"], " "),
        _join(placed, "; "),
        count if shot["subject"] not in ("A_hands", "B_hands", "prop") else "",
        ANGLE_WORDS.get(shot["angle"]["vertical"], ""),
        HEIGHT_WORDS.get(shot["angle"]["height"], "") if shot["angle"]["height"] != "eye" else "",
        f"{round(lens['focal_mm_ff'])}mm lens",
        "anamorphic" if lens.get("look") == "anamorphic" else "",
        DOF_WORDS.get(lens.get("dof", "medium"), ""),
        location_phrase(context),
        _join(loc.get("weather", [])),
        shot.get("lighting", ""),
        _layout_free(shot.get("composition", "")),
        context.get("aspect_ratio", "") and f"{context['aspect_ratio']} frame",
    ])
    negative = _join([
        "extra people, duplicate figures, the same person twice, crowd" if n <= 3 else "",
        "motion blur trails, multiple exposures, split screen, collage, text, watermark, logo, frame border",
        "deformed hands, extra fingers",
    ])
    return prompt, negative


def compile_h3(shot: dict, context: dict, index: int = 1, start_s: float = 0.0) -> str:
    style = context.get("style", {})
    mv = shot["movement"]
    move = H3_MOVES[mv["id"]]
    if not move.endswith("."):
        amp = "small" if mv.get("speed") == "slow" else "large" if mv.get("speed") == "fast" else ""
        move += _join([amp and f" with {amp} amplitude", {"slow": " at slow speed", "fast": " at fast speed"}.get(mv.get("speed"), "")], "") + "."
    body = f"{SIZE_H3[shot['size']]} frames {subject_phrase(shot, context)} in {location_phrase(context)}"
    if shot.get("lighting"):
        body += f", {shot['lighting']}"
    if index == 1:
        return f"[Shot 1] {_join([style.get('h3', 'Live-action, cinematic'), body])}. {move}"
    mm, ss = divmod(start_s, 60)
    body = body.replace(" frames ", " framing ", 1)
    return f"[Shot {index}] At {int(mm):02d}:{ss:06.3f}, the camera cuts to {body}. {move}"


def compile_shot(shot: dict, context: dict, index: int = 1, start_s: float = 0.0) -> dict:
    still, negative = compile_still(shot, context)
    return {"ltx": compile_ltx(shot, context), "still": still, "still_negative": negative,
            "h3": compile_h3(shot, context, index, start_s)}
