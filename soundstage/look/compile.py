"""Look JSON + stage scene JSON -> the look still prompt (frame 1 only), its negative, and the LTX motion prompt.

Precedence: the stage owns physical facts (who is where, the lens, time of day, weather, the set); the look
owns how it is photographed (camera body, glass, stock, palette, genre and cinema style, era, technique,
mood, grade). Look fragments therefore never name a time of day or the weather.

Still prompt (Krea 2 look frame): FRAME 1 ONLY. It never mentions movement or where anyone ends up, and it
states the head count; the negative always carries "extra people, crowd" (docs/decisions.md 2026-10-27 21:30).
Motion prompt (LTX-2.x): one present-tense paragraph, shot -> place/light -> blocking in frame terms ->
action -> the camera move with its destination frame -> look; documented verbs, no numeric specs.
"""
from __future__ import annotations

import re

from ..cine.kb import get_kb
from ..cine.prompts import SIZE_STILL, _cap, _join
from . import scene as S
from .colors import palette_phrase, palette_words
from .vocab import load_vocab, normalize_look, option

FRAME1_NEGATIVE = "extra people, crowd, duplicate figures, the same person twice"
# Ends every motion prompt: LTX style (present tense, stated positively), after 3D Jutsu's "strictly keep" clause.
LOCK_CLAUSE = "The layout, object placement, scale and camera motion match the reference exactly."
BRIEF_LEADS = {"world": "", "atmosphere": "the air", "surfaces": "surfaces", "furniture": "furniture", "colour": "colour",
               "light": "light", "outside": "outside the windows"}
BASE_NEGATIVE = ("motion blur trails, multiple exposures, split screen, collage, text, watermark, logo, "
                 "frame border, letterbox bars, deformed hands, extra fingers")

# Words that put a clause after frame 1 ("then they walk inside"); dropped from the still prompt.
_LATER = re.compile(r"\b(then|after(?:wards)?|until|finally|eventually|later|ends?|ending|by the end|"
                    r"walks? (?:in|into|out|away|off|toward)|enters?|exits?|arrives?|reach(?:es)?|leaves?|"
                    r"turns? (?:to|around)|begins? to|starts? to)\b", re.I)


def frame1_safe(text: str) -> str:
    """Keep only the clauses of a description that can be true in the first frame."""
    if not text:
        return ""
    # Everything from the first "then" / "after" etc. onward happens later in the shot ("…, then they
    # sprint in, vault up and gallop away" drops all three actions, not just the first clause).
    clauses = re.split(r"(?<=[.;!?])\s+|,\s*|;\s*|\s+(?=(?:and\s+)?then\b)", text.strip())
    keep = []
    for c in clauses:
        c = c.strip(" .;")
        if not c:
            continue
        if _LATER.search(c):
            break
        keep.append(c)
    return ", ".join(keep)


def _frag(field: str, look: dict, key: str) -> str:
    o = option(field, look.get(field))
    return (o or {}).get(key, "")


def look_parts(look: dict) -> dict:
    """Every chosen option, its still/motion fragment, negatives, KB refs and conflict notes."""
    notes: list[str] = []
    chosen = {}
    for field in ("camera_body", "lens", "aperture", "film_stock", "genre", "subgenre", "movement", "era",
                  "technique", "mood", "energy"):
        o = option(field, look.get(field))
        if o and o["id"] not in ("auto", "general"):
            chosen[field] = o
    bw = any(o.get("bw") for o in chosen.values())
    pal = look.get("palette") or {}
    pal_opt = option("palette", pal.get("preset"))
    if pal_opt and pal_opt.get("bw"):
        bw = True
    pal_still = pal_motion = ""
    if pal.get("preset") not in (None, "", "auto"):
        if bw and not (pal_opt or {}).get("bw"):
            notes.append("a black-and-white choice overrides the colour palette")
        elif pal.get("preset") == "custom" or (pal_opt and pal.get("swatches") != pal_opt.get("swatches")):
            phrase = palette_phrase(pal.get("swatches") or [])
            name = (pal.get("name") or "").strip()
            pal_still = _join([phrase, name and f"'{name}' grade"]) if phrase else ""
            pal_motion = phrase
        elif pal_opt:
            pal_still, pal_motion = pal_opt["still"], pal_opt["motion"]
    kb_refs = []
    kb = get_kb()
    for o in chosen.values():
        if o.get("kb") and kb.get(o["kb"]):
            kb_refs.append(o["kb"])
    negs = [o["neg"] for o in chosen.values() if o.get("neg")]
    if pal_opt and pal_opt.get("neg") and pal_still:
        negs.append(pal_opt["neg"])
    if chosen.get("camera_body", {}).get("id") in ("smartphone", "dv_camcorder", "cctv") and \
            chosen.get("aperture", {}).get("dof") == "shallow":
        notes.append(f"{chosen['camera_body']['label']} rarely gives shallow focus; the aperture wins in the prompt")
        negs = [n.replace("shallow depth of field, ", "").replace("shallow depth of field", "") for n in negs]
    return {"chosen": chosen, "bw": bw, "palette_still": pal_still, "palette_motion": pal_motion,
            "kb_refs": list(dict.fromkeys(kb_refs)), "negatives": [n for n in negs if n.strip(", ")], "notes": notes}


def brief_parts(look: dict, still: bool = False) -> list[str]:
    """Restyle-brief fragments in a fixed order. For the still, each one is kept frame-1 safe."""
    brief = look.get("brief") or {}
    out = []
    for key, lead in BRIEF_LEADS.items():
        text = (brief.get(key) or "").strip().rstrip(".")
        if still:
            text = frame1_safe(text)
        if text:
            out.append(f"{lead}: {text}" if lead and not text.lower().startswith(lead.split()[0]) else text)
    return out


def _grade_words(look: dict) -> list[str]:
    spec = load_vocab()["grade"]
    out = []
    for k, v in (look.get("grade") or {}).items():
        if k not in spec or abs(v) < 0.2:
            continue
        word = spec[k]["high"] if v > 0 else spec[k]["low"]
        if word:
            out.append(("slightly " if abs(v) < 0.5 else "") + word)
    return out


def _intensity(word: str, look: dict) -> str:
    """Mood intensity 0..1: below 0.3 a faint undertone, above 0.8 played at full intensity."""
    if not word:
        return ""
    i = look.get("mood_intensity", 0.5)
    if i < 0.3:
        return f"a faint undertone of {word[2:] if word.startswith('a ') else word}"
    if i > 0.8:
        return f"{word}, played at full intensity"
    return word


def _style_head(parts: dict) -> str:
    c = parts["chosen"]
    for f in ("movement", "subgenre", "genre"):
        if f in c and c[f].get("still"):
            return c[f]["still"]
    return "cinematic film still"


def _still_count(n: int) -> str:
    return {0: "no people in frame", 1: "exactly one person in frame", 2: "exactly two people in frame",
            3: "exactly three people in frame"}.get(n, f"exactly {n} people in frame")


NUM = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}
# Image and video models like to fill a street with bystanders and parked cars the blocking never had.
NOTHING_EXTRA_NEG = "background pedestrians, bystanders, passers-by, extra people in the background, extra vehicles, additional cars"


def _vehicle_count(n: int) -> str:
    if n <= 0:
        return "no vehicles"
    return f"exactly {NUM.get(n, n)} vehicle{'s' if n > 1 else ''}, no other cars"


def _only_blocking(n_people: int, n_vehicles: int) -> str:
    """The frame holds what the stage holds, nothing more."""
    bits = []
    if n_people:
        bits.append("nobody else in the background")
    bits.append(_vehicle_count(n_vehicles) if n_vehicles else "no other vehicles")
    return ", ".join(bits)


def compile_still(look: dict, scene: dict, parts: dict) -> tuple[str, str]:
    f1 = S.frame1_facts(scene)
    c = parts["chosen"]
    style = [_style_head(parts)]
    genre_layer = "subgenre" if "subgenre" in c else "genre"   # a subgenre already says its genre
    if "movement" in c and genre_layer in c:
        style.append(c[genre_layer]["still"])
    people = S.group_phrase(f1["people"], f1["camera"])
    others = S.group_phrase(f1["others"], f1["camera"])   # animals/vehicles need facing too (a horse from behind is ambiguous)
    grps = S.groups(f1["others"], f1["camera"])
    away = [g for g in grps if "facing away" in (g["facing"] or "")]
    facing_neg = ", ".join(f"{g['nouns']} facing the camera, heads toward the camera" for g in away)
    # Vehicles: the opposite end toward the camera, and any reversing, are the classic failure.
    for g in grps:
        fw = g["facing"] or ""
        if "tail lights toward the camera" in fw:
            facing_neg += f", {g['nouns']} facing the camera, headlights toward the camera, driving in reverse"
        elif "headlights and grille facing us" in fw:
            facing_neg += f", rear of {g['nouns']} toward the camera, tail lights toward the camera, driving in reverse"
        elif "nose pointing" in fw:
            facing_neg += f", {g['nouns']} driving backwards, reversing"
    facing_neg = facing_neg.lstrip(", ")
    who = people + others
    n = len(f1["people"])
    loc = f1["location"]
    place = "underwater" if f1["underwater"] else loc["place"]
    props = [f"{p['word']} {p['where']}" for p in f1["props"][:3]]
    desc = frame1_safe(look.get("description", ""))
    vcam = S.vehicle_camera(scene)
    lock = S.traffic_lock(scene)
    shot = vcam["still"] if vcam else SIZE_STILL[f1["size"]] + ("" if who else " of the location")
    # A head count only when people show: seen from outside, a car's driver is part of the car and a count of
    # zero (or one) makes Krea paint pedestrians; seen from inside, the riders ARE the people in frame.
    count = not lock or n > 0
    if vcam and vcam.get("where") in ("interior", "hood") and place and place != "underwater":
        place_words = f"driving through {place}" if (S.camera_move(scene).get("rides") or {}).get("moving") else f"parked in {place}"
    else:
        place_words = (place and f"in {place}") if place != "underwater" else "underwater"
    prompt = _join([
        (vcam or {}).get("lead", ""),          # where the camera is goes first: depth alone reads a dashboard as a hood
        *style,
        _frag("era", look, "still"),
        desc,
        *brief_parts(look, still=True),
        shot,
        "; ".join(who),
        lock["still"] if lock else "",
        _still_count(n) if count else "",
        _only_blocking(n, sum(1 for e in f1["others"] if e.get("rig") == "vehicle")) if count and not lock else
        ("nobody else in the car, nobody else in the background" if count and vcam else ""),
        S.ANGLE_STILL[f1["angle"]] if f1["angle"] != "eye" else "eye-level camera",
        f"{round(f1['focal_mm'])}mm lens",
        c.get("lens", {}).get("still", ""),
        c.get("aperture", {}).get("still", ""),
        place_words,
        "; ".join(props),
        loc["weather"],
        f1["lighting"],
        c.get("technique", {}).get("still", ""),
        _intensity(c.get("mood", {}).get("still", ""), look) if c.get("mood") else "",
        "black and white" if parts["bw"] else parts["palette_still"],
        c.get("film_stock", {}).get("still", ""),
        c.get("camera_body", {}).get("still", ""),
        _join(_grade_words(look)),
    ])
    # Never tell the model "no people" when the shot has people in it: riders in the car, someone walking in later.
    no_people = n == 0 and not S.people_in_shot(scene)
    negative = _join([FRAME1_NEGATIVE + (", people, person, figure" if no_people else "") if n <= 3 else "extra people",
                      BASE_NEGATIVE, facing_neg, NOTHING_EXTRA_NEG, vcam["negative"] if vcam else "", lock["negative"] if lock else "",
                      *parts["negatives"], look.get("negative", "")])
    return _dedupe(prompt), _dedupe(negative)


def _dedupe(text: str) -> str:
    seen, out = set(), []
    for p in (x.strip() for x in text.split(",")):
        k = p.lower()
        if p and k not in seen:
            seen.add(k)
            out.append(p)
    return ", ".join(out)


# ---- motion ---------------------------------------------------------------------------------------

_MOVE_VERBS = {
    ("dolly_in", ""): "pushes forward", ("dolly_out", ""): "pulls back",
    ("truck", "left"): "tracks sideways to the left", ("truck", "right"): "tracks sideways to the right",
    ("crane", "up"): "rises upward", ("crane", "down"): "descends",
    ("pan", "left"): "pans left", ("pan", "right"): "pans right",
    ("tilt", "up"): "tilts upward", ("tilt", "down"): "tilts downward",
    ("zoom", "in"): "slowly zooms in", ("zoom", "out"): "zooms out",
    ("arc", "left"): "circles around to the left", ("arc", "right"): "circles around to the right",
}


_MOVE_GERUNDS = {
    ("truck", "left"): "drifting left", ("truck", "right"): "drifting right", ("crane", "up"): "rising",
    ("crane", "down"): "descending", ("pan", "left"): "panning left", ("pan", "right"): "panning right",
    ("tilt", "up"): "tilting up", ("tilt", "down"): "tilting down", ("zoom", "in"): "zooming in",
    ("zoom", "out"): "zooming out", ("arc", "left"): "arcing left", ("arc", "right"): "arcing right",
}


def _camera_sentence(mf: dict, f1: dict, look: dict) -> str:
    mv = mf["move"]
    end = mf["end"]
    rides = mv.get("rides")
    if rides and mv["static"]:
        if rides["inside"]:
            return f"The camera stays locked to the {rides['noun']}" + (" as it drives; only the world outside moves." if rides["moving"] else ".")
        return f"The camera travels with the {rides['noun']}, keeping pace with it." if rides["moving"] else "Static frame, the camera locked off."
    if mv["static"]:
        s = "Static frame, the camera locked off."
    else:
        follow = any(m["way"] == "away from the camera" for m in mf["marks"]) and \
            any(p[0] == "dolly_in" for p in mv["parts"])
        lead = any(m["way"] == "toward the camera" for m in mf["marks"]) and \
            any(p[0] == "dolly_out" for p in mv["parts"])
        if follow or lead:
            rest = [_MOVE_GERUNDS[p] for p in mv["parts"] if p in _MOVE_GERUNDS and p[0] not in ("dolly_in", "dolly_out")]
            s = ("The camera follows behind them" if follow else "The camera tracks backward ahead of them") + \
                (f" {mv['speed']}" if mv["speed"] else "") + (", " + S._join_and(rest) if rest else "")
        else:
            verbs = [_MOVE_VERBS[p] for p in mv["parts"] if p in _MOVE_VERBS]
            s = "The camera " + S._join_and(verbs) + (f" {mv['speed']}" if mv["speed"] and len(verbs) == 1 else "")
        if mv["handheld"]:
            s += ", handheld and breathing"
        movers_end = [m for m in mf["marks"] if m["inside_at_end"] and not any(e["id"] == m["id"] for e in end["people"])]
        size_end = S.SIZE_STILL[end["size"]] if end["nearest"] else "the location"
        the = S.definite
        door = next((p for p in end["props"] if p["kind"] == "building"), None)
        if movers_end and not end["people"]:
            who = S._join_and([the(m["noun"]) for m in movers_end])
            where = f" {door['where']}" if door and door["where"] != "filling the background" else " ahead"
            dest = f"as the move completes, {who} {'have' if len(movers_end) > 1 else 'has'} disappeared through the doorway{where}"
        elif end["people"]:
            who = S._join_and([the(e["noun"]) for e in end["people"]])
            sx = sum(e["sx"] for e in end["people"]) / len(end["people"])
            dest = f"as the move completes, {who} {'are' if len(end['people']) > 1 else 'is'} {S.screen_words(sx)} in {S._article(size_end)}"
        else:
            dest = "as the move completes, the frame settles on the empty set"
        s += f"; {dest}."
    return s.replace("  ", " ")


def _marks_sentence(mf: dict, introduced: set | None = None) -> str:
    """introduced = ids of the figures the blocking sentence just named (then they become 'they')."""
    marks = mf["marks"]
    if not marks:
        return ""
    # Group movers that share verb, direction and destination ("a man and a woman walk ... together").
    groups: dict[tuple, list[dict]] = {}
    for m in marks:
        groups.setdefault((m["verb"], m["way"], m["dest"]), []).append(m)
    out = []
    for (verb, way, dest), ms in groups.items():
        again = bool(introduced) and {m["id"] for m in ms} == introduced
        who = ("they" if len(ms) > 1 else S.definite(ms[0]["noun"])) if again else S._group_nouns([m["noun"] for m in ms])
        if len(ms) > 1 and ms[0].get("verb_pl"):
            verb = ms[0]["verb_pl"]
        elif len(ms) > 1:
            verb = {"walks": "walk", "walks briskly": "walk briskly", "runs": "run", "drives": "drive", "drives forward": "drive forward", "rolls forward": "roll forward",
                    "rolls": "roll", "trots": "trot"}.get(verb, verb)
            verb += " together" if verb.startswith("walk") else ""
        out.append(_cap(_join([f"{who} {verb} {way}", dest], " ")) + ".")
    return " ".join(out)


def _no_numbers(text: str) -> str:
    """LTX prompts carry no numeric specs: '18° above the horizon' -> 'low', '3200K' -> ''."""
    def sun(m):
        return "low sun" if int(m.group(1)) < 25 else "high sun"
    text = re.sub(r"(?:low )?sun (\d+)° above the horizon", sun, text)
    text = re.sub(r"\b\d{3,5}K\s*", "", text)
    return re.sub(r"\s+,", ",", text).strip()


def _sound(parts: dict, loc: dict) -> str:
    """Ambience from the chosen cinema's KB signature, minus anything that contradicts the stage weather."""
    kb = get_kb()
    for ref in parts["kb_refs"]:
        e = kb.get(ref)
        sounds = (e or {}).get("signature", {}).get("sound") or []
        keep = [re.sub(r"\s+against .*$", "", s) for s in sounds
                if (loc["weather"] or not re.search(r"rain|storm|thunder|wind", s, re.I))
                and not re.search(r"voice|dialogue|narrat|speech|line", s, re.I)]
        if keep:
            return _cap(_join(keep[:2], "; ")) + "."
    return ""


def compile_motion(look: dict, scene: dict, parts: dict) -> str:
    f1 = S.frame1_facts(scene)
    mf = S.motion_facts(scene)
    c = parts["chosen"]
    loc = f1["location"]
    vcam = S.vehicle_camera(scene)
    rides = mf["move"].get("rides") or {}
    if vcam:   # in or on a car: the shot is the car's interior (or its windshield), whatever the set outside is
        going = "driving" if rides.get("moving") else "parked"
        through = loc["place"] and (f" through {loc['place']}" if rides.get("moving") else f" in {loc['place']}")
        where = {"interior": f"Interior {f1['size_ltx'].lower()} inside a {going} {rides.get('noun', 'car')}{through}",
                 "hood": f"Exterior {f1['size_ltx'].lower()} from the hood of a {going} {rides.get('noun', 'car')}{through}"}
        head = where.get(vcam.get("where"), where["interior"])
    else:
        head = _join([
            _join([f"{'Interior' if loc['int_ext'] == 'INT' else 'Exterior'} {f1['size_ltx'].lower()}",
                   S.ANGLE_LTX[f1["angle"]] and f"from a {S.ANGLE_LTX[f1['angle']]} angle"], " "),
            ("underwater" if f1["underwater"] else loc["place"] and f"in {loc['place']}"),
        ], " ")
    light = _join([_no_numbers(f1["lighting"]), loc["weather"]])
    blocking_s = S.blocking_sentence(f1["people"] + f1["others"], f1["camera"])
    props = [p for p in f1["props"] if p["kind"] == "building"]
    set_s = _cap(f"{props[0]['word']} {'fills the background' if props[0]['where'] == 'filling the background' else 'stands ' + props[0]['where']}") + "." if props else ""
    desc = (look.get("description") or "").strip().rstrip(".")
    lens_s = _join([f"a {f1['lens_band']}", c.get("lens", {}).get("motion", ""),
                    c.get("aperture", {}).get("motion", "")])
    look_s = _join([
        c.get("camera_body", {}).get("motion", ""),
        c.get("film_stock", {}).get("motion", ""),
        "black and white" if parts["bw"] else parts["palette_motion"],
        _join(_grade_words(look)),
    ])
    style_s = _join([c[k]["motion"] for k in ("movement", "subgenre" if "subgenre" in c else "genre") if k in c])
    era_s = _frag("era", look, "motion")
    tech_s = c.get("technique", {}).get("motion", "")
    mood_s = _intensity(c.get("mood", {}).get("motion", ""), look) if c.get("mood") else ""
    lock = S.traffic_lock(scene)
    sentences = [
        _cap(head) + ".",
        lock["motion"] if lock else "",          # early: the empty road is the instruction LTX forgets late in a shot
        vcam["motion"] if vcam else "",
        _cap(light) + "." if light else "",
        blocking_s,
        set_s,
        _cap(desc) + "." if desc else "",
        _cap("; ".join(brief_parts(look))) + "." if brief_parts(look) else "",
        _marks_sentence(mf, {e["id"] for e in f1["people"] + f1["others"]}
                        if len(S.groups(f1["people"] + f1["others"], f1["camera"])) == 1 else None),
        _camera_sentence(mf, f1, look),
        f"Shot on {lens_s}." if lens_s else "",
        _cap(_join([look_s, era_s and f"with {era_s}"])) + "." if (look_s or era_s) else "",
        _cap(style_s) + "." if style_s else "",
        _cap(tech_s) + "." if tech_s else "",
        _cap(mood_s) + "." if mood_s else "",
        c.get("energy", {}).get("motion", ""),
        _sound(parts, loc),
        ("Nobody and nothing else enters the frame at any point, not even at its edges near the end: no bystanders, no other vehicles."
         if lock else "Nobody and nothing else enters the frame: no bystanders, no extra cars.") if (f1["people"] or f1["others"]) else "",
        LOCK_CLAUSE,
    ]
    text = " ".join(s for s in sentences if s and s != ".")
    return re.sub(r"\s+", " ", text.replace("..", ".")).strip()


def _kb_card(ref: str) -> dict:
    """Name + first sentence of a KB entry, for the panel's 'why this look' line."""
    e = get_kb().get(ref) or {}
    summary = e.get("summary", "")
    first = re.split(r"(?<=\.)\s", summary, maxsplit=1)[0] if summary else ""
    return {"id": ref, "name": e.get("name", ref), "summary": first}


def compile_look(look_in: dict | None, scene: dict | None) -> dict:
    """The whole compile: normalised look + the three prompts + notes and KB refs."""
    look, notes = normalize_look(look_in)
    scene = scene if isinstance(scene, dict) and scene else dict(DEFAULT_SCENE)
    parts = look_parts(look)
    still, negative = compile_still(look, scene, parts)
    motion = compile_motion(look, scene, parts)
    f1 = S.frame1_facts(scene)
    return {
        "look": look,
        "still_prompt": still,
        "still_negative": negative,
        "motion_prompt": motion,
        "kb_refs": parts["kb_refs"],
        "kb": [_kb_card(r) for r in parts["kb_refs"]],
        "notes": notes + parts["notes"],
        "frame1": {"people": len(f1["people"]), "size": f1["size"], "angle": f1["angle"],
                   "focal_mm": f1["focal_mm"]},
        "palette_words": palette_words((look.get("palette") or {}).get("swatches") or []),
    }


from .default_scene import DEFAULT_SCENE  # noqa: E402  (after the functions: the module is data only)
