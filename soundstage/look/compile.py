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
from .gaze import frame1_looks, head_beats
from .identity import body_words, known_wear, motion_identity, people_identity, plain_word, still_identity, wardrobe
from .impacts import impact_beats
from .sfx import sfx_beats, sfx_still_words, without_rigs
from .objstate import motion_beats, still_words
from . import swim as SW
from .vocab import load_vocab, normalize_look, option

FRAME1_NEGATIVE = "extra people, crowd, duplicate figures, the same person twice"
# Ends every motion prompt: LTX style (present tense, stated positively), after 3D Jutsu's "strictly keep" clause.
LOCK_CLAUSE = "The layout, object placement, scale and camera motion match the reference exactly."
BRIEF_LEADS = {"world": "", "atmosphere": "the air", "surfaces": "surfaces", "furniture": "furniture", "colour": "colour",
               "light": "light", "outside": "outside the windows"}
BASE_NEGATIVE = ("motion blur trails, multiple exposures, split screen, collage, text, watermark, logo, "
                 "frame border, letterbox bars, deformed hands, extra fingers")
# A look that asks for real shutter blur (Racing cinema: the wheels, a pan's background) must not also have it in the
# negative; the ghosting the base negative guards against stays out by name.
_ASKS_BLUR = re.compile(r"motion[- ]blur", re.I)
BLUR_SAFE_NEGATIVE = BASE_NEGATIVE.replace("motion blur trails", "ghosted double images")

# Words that put a clause after frame 1 ("then they walk inside"); dropped from the still prompt.
_LATER = re.compile(r"\b(then|after(?:wards)?|until|finally|eventually|later|ends?|ending|by the end|"
                    r"walks? (?:in|into|out|away|off|toward)|enters?|exits?|arrives?|reach(?:es)?|leaves?|"
                    r"turns? (?:to|around)|begins? to|starts? to)\b", re.I)


# Words that name a cast member in a description, by kind of thing (for the sentences frame1_safe drops when that
# member is out of frame at frame 0). A negation ("no cars, no people") is kept: it is true of frame 1 too.
_PERSON_WORDS = ("man", "men", "woman", "women", "person", "child", "boy", "girl", "diver", "divers", "swimmer",
                 "swimmers", "scuba", "dancer", "dancers", "runner", "rider", "riders", "officer", "cop", "cyclist")
_VEHICLE_WORDS = ("car", "cars", "sedan", "coupe", "vehicle", "vehicles", "truck", "suv", "van", "motorcycle",
                  "motorbike", "boat", "boats", "speedboat", "jet ski", "jetski")
_NEGATED = re.compile(r"\b(no|not|without|nobody|nothing|empty)\b", re.I)


def absent_words(scene: dict, f1: dict) -> list[str]:
    """Words for the cast that is on stage but not in frame at frame 0 (it enters later, or never shows): the kind's
    own words ("police"), plus the generic ones when nothing of that sort is in frame (no person, no vehicle)."""
    lib = S.library()
    seen = {e["id"] for e in f1["people"] + f1["others"]}
    seen |= {e.get("host_id") for e in f1["people"] if e.get("host_id")}
    ride = S.ride_host(scene)
    if ride is not None:
        seen.add(ride.get("id"))                  # the camera is in or on it: vehicle_camera() words it
    cast = S.cast(scene)
    out: list[str] = []
    for c in cast:
        if c["id"] in seen or c.get("host") is not None:
            continue
        label = (lib.get(c["actor"].get("kind"), ("",))[0] or "").lower()
        out += [w for w in re.findall(r"[a-z]+", label) if w not in _VEHICLE_WORDS + _PERSON_WORDS + ("the", "a", "an")]
        rig = c["rig"]
        if rig == "biped" and not f1["people"]:
            out += list(_PERSON_WORDS)
        if rig == "vehicle" and not any(e.get("rig") == "vehicle" for e in f1["others"]):
            out += list(_VEHICLE_WORDS)
    return list(dict.fromkeys(out))


def frame1_safe(text: str, absent: list[str] | tuple = (), names: list[str] | tuple = ()) -> str:
    """Keep only the clauses of a description that can be true in the first frame. absent: words naming cast that is
    out of frame at frame 0 (absent_words); a sentence that names one is dropped whole, its spray and light with it.
    names: the cast's names ("Maya"), so a later sentence about one of them goes with the move it follows."""
    if not text:
        return ""
    if absent:
        name = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in absent) + r")\b", re.I)
        sentences = re.split(r"(?<=[.!?])\s+", text.strip())
        text = " ".join(x for x in sentences if not name.search(x) or _NEGATED.search(x))
    # Everything from the first "then" / "after" etc. onward happens later in the shot ("…, then they
    # sprint in, vault up and gallop away" drops all three actions, not just the first clause). So does everything
    # from a move to somewhere else or a change of pose ("She walks slowly to the wooden table and stops at its edge"):
    # the Maya S2 frame painted her already at the table. Past that point a sentence about a person is dropped too
    # ("She looks down at the phone" is at the table); a sentence about the place alone ("The blinds are half shut")
    # is still true at frame 1 and stays. "has just stood up" is how frame 1 begins, not a later beat.
    who = _person_ref(names)
    keep, later = [], False
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        if later:
            if not (who.search(sentence) or _LATER.search(sentence) or _moves(sentence)):
                keep += [c for c in (x.strip(" .;") for x in re.split(r",\s*|;\s*", sentence)) if c]
            continue
        for c in re.split(r"(?<=[;])\s+|,\s*|;\s*|\s+(?=(?:and\s+)?then\b)", sentence):
            c = c.strip(" .;")
            if not c:
                continue
            if _LATER.search(c) or _moves(c):
                later = True
                break
            keep.append(c)
    return ", ".join(keep)


# A move to somewhere else, or a change of pose or of what a hand holds: true only later in the shot. The subject is
# in frame 1 on its first mark (the stage says where); the destination belongs to the motion prompt.
_GO = (r"walk|stroll|run|jog|step|move|head(?:s|ed|ing)|go|goe|come|wander|hurr(?:y|ie)|rush|dash|sprint|pace|stride|march|"
       r"climb|crawl|drive|ride|swim|gallop|drift|edge|lean|turn|spin|swing|roll")
# Third-person verb forms only ("stops", not "a bus stop"; "opens", not "the door is open").
_MOVES = re.compile(
    rf"\b(?:{_GO})(?:s|es|ed|ing)?\b(?:\s+\w+ly)?\s+(?:over\s+|up\s+|back\s+|down\s+|right\s+|straight\s+)?"
    r"(?:to|toward|towards|into|onto|up to|out of|away from|away|off|inside|outside|home)\b"
    r"|\b(?:stops|stopping|halts|reaches|arrives|lands|settles|sits down|stands up|gets up|rises|kneels|lies down|"
    r"picks (?:\w+ ){0,2}up|puts (?:\w+ ){0,2}down|sets (?:\w+ ){0,2}down|takes (?:\w+ )?steps?|glances|nods|"
    r"looks (?:up|away|back|round|around|over)|"
    r"(?:eyes|gaze) (?:go|goes|move|moves|drift|drifts|flick|flicks|dart|darts|lift|lifts|drop|drops)|"
    r"folds (?:his|her|their) arms|opens|closes|grabs|lifts|throws)\b", re.I)
_JUST = re.compile(r"\b(?:has|have|had)\s+just\b", re.I)


def _moves(clause: str) -> bool:
    """Does this clause move someone off their first mark, or change their pose ("walks to the table", "stops",
    "stands up", "picks it up")? Not "has just stood up" (the state frame 1 starts in), not a negation."""
    if _JUST.search(clause) or _NEGATED.search(clause):
        return False
    return bool(_MOVES.search(clause))


def _person_ref(names=()) -> re.Pattern:
    words = ["she", "he", "they", "her", "him", "his", "hers", "their", "them", *_PERSON_WORDS,
             *[n for n in names if n]]
    return re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)


def _frag(field: str, look: dict, key: str) -> str:
    o = option(field, look.get(field))
    return (o or {}).get(key, "")


def look_context(scene: dict) -> dict:
    """What a car look may say about this shot, from the stage (scene.py): view "car" (a moving car in frame, the camera
    outside it or on the over-the-tyre mount) or "nocar"; the surface under the tyres ("wet", "dry", "dirt", "snow" or
    None); and how much the camera smears the background, at frame 1 (pan_still) and over the shot (pan_motion)."""
    f1 = S.frame1_facts(scene)
    frames, _ = S.frame_range(scene)
    # A camera hard-mounted on the car never pans with it: the motion prompt says it "stays locked to the car" and
    # the ride words say how the street whips round, so no "as the camera pans with the car" on top.
    rides = S.vehicle_camera(scene) is not None
    return {"view": S.look_view(scene, _in_shot_ids(scene, f1)), "surface": S.look_surface(scene),
            "pan_still": "locked" if rides else S.camera_blur(scene, 0, min(12, frames - 1)),
            "pan_motion": "locked" if rides else S.camera_blur(scene)}


def _car_layers(o: dict, ctx: dict | None) -> dict:
    """A car look's option (the motorsport subgenre) as the words this shot may carry: its head, then the surface the
    stage has, the car (wheels, body, weight), and the background blur the camera really makes. Without a moving car in
    frame (or riding inside it, on its hood or bumper) only the car-free words: grade, grain and lens do the rest."""
    ctx = ctx or {"view": "car"}
    if ctx.get("view") != "car":
        v = o.get("nocar") or {}
        return {**o, "still": v.get("still", ""), "motion": v.get("motion", ""), "neg": v.get("neg", "")}
    srf = (o.get("surface") or {}).get(ctx.get("surface") or "") or {}
    car = o.get("car") or {}
    pan_s = (o.get("pan") or {}).get(ctx.get("pan_still") or "") or {}
    pan_m = (o.get("pan") or {}).get(ctx.get("pan_motion") or "") or {}
    still = _join([o.get("still", ""), srf.get("still", ""), car.get("still", ""), pan_s.get("still", "")])
    body = "; ".join(x for x in (srf.get("motion", ""), car.get("motion", ""), pan_m.get("motion", "")) if x)
    motion = f"{o.get('motion', '')}: {body}" if body else o.get("motion", "")
    return {**o, "still": still, "motion": motion, "neg": _join([car.get("neg", ""), srf.get("neg", "")])}


def look_parts(look: dict, ctx: dict | None = None) -> dict:
    """Every chosen option, its still/motion fragment, negatives, KB refs and conflict notes.

    ctx: look_context(scene). An option with car layers (the motorsport subgenre) only says what this shot has in it:
    see _car_layers."""
    notes: list[str] = []
    chosen = {}
    for field in ("camera_body", "lens", "aperture", "film_stock", "genre", "subgenre", "movement", "era",
                  "technique", "mood", "energy"):
        o = option(field, look.get(field))
        if o and o["id"] not in ("auto", "general"):
            if isinstance(o.get("surface"), dict):
                o = _car_layers(o, ctx)
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


# ---- the camera block (C28, Jon's RTX 5080 sweep through ④ Frame, 2026-11-08: outbox claude_C28.md) ---------------
# The vague "cinematic film still" head is replaced by a concrete camera setup: the body, the lens with its focal
# length and stop, the depth of field and what is in focus, the film stock, grain, halation and a slight edge softness,
# then the light as the set motivates it. Variant (d) of the sweep: clean on both seeds on Krea 2 + depth, where the
# old head (a) was plainer and the long negative (c) painted a second woman. Words never used: beautiful, 8k,
# masterpiece, ultra-detailed (BANNED_WORDS; the tests grep every compiled prompt for them).
BANNED_WORDS = ("beautiful", "8k", "masterpiece", "ultra-detailed")
DEFAULT_BODY = "ARRI Alexa 35"
DEFAULT_GLASS = "Cooke S4 prime"
DEFAULT_STOCK = "Kodak Vision3 500T film stock"
DEFAULT_T_STOP = 2.0
# "slight vignetting" at 8 Krea steps made heavy, blotchy dark corners; at 12 steps it is clean (C28 phase D).
VIGNETTE_MIN_STEPS = 12
DEFAULT_FRAME_STEPS = 12   # ④ Frame's default for Krea 2 + depth and FLUX 3 Klein (web/pipeline/pipeline.mjs FRAME_DEFAULTS)
# The short negative of variant (d). At CFG 1 Krea 2 still reads it (mean pixel change 7.3 against none); Klein reads it
# only above CFG 1. The long negative (c) let a second woman in on one of two seeds.
C28_NEGATIVE = "CGI, 3d render, waxy airbrushed skin, oversaturated, HDR, illustration, extra people"
# Stocks / looks that are digital or grainless: no "fine visible film grain", no halation from the block.
_NO_GRAIN = {"digital_clean", "hdr", "arri_log_look", "kodak_50d", "vhs_tape"}
_NO_HALATION = {"digital_clean", "hdr", "vhs_tape"}
_GARMENTS = ("t-shirt", "shirt", "blouse", "jeans", "trousers", "pants", "shorts", "skirt", "dress", "gown",
             "coat", "jacket", "blazer", "suit", "sweater", "jumper", "hoodie", "cardigan", "vest", "uniform", "overalls",
             "jumpsuit", "robe", "wetsuit", "top", "tank top", "leggings", "scrubs", "apron")


def _a(noun: str) -> str:
    return ("an " if noun[:1].lower() in "aeiou" else "a ") + noun


def _stop_word(t: float) -> str:
    return f"T{t:g}"


def _stage_t_stop(scene: dict) -> float | None:
    """The shot camera's iris at frame 1 when the stage keys one (the phone viewfinder's lens keys, ③ Set's T-stop)."""
    keys = sorted((k for k in scene.get("camera_keys") or [] if isinstance(k, dict)), key=lambda k: k.get("frame", 0))
    for k in keys[:1] + [scene.get("camera") or {}]:
        try:
            t = float(k.get("t_stop") or 0)
        except (TypeError, ValueError):
            t = 0
        if 0.5 <= t <= 64:
            return t
    return None


def _look_t_stop(c: dict) -> float | None:
    """The Look tab's aperture (f2_8 -> 2.8)."""
    oid = (c.get("aperture") or {}).get("id") or ""
    m = re.fullmatch(r"f(\d+)(?:_(\d+))?", oid)
    return float(f"{m.group(1)}.{m.group(2) or 0}") if m else None


def _windows(scene: dict) -> int:
    """Windows the set has: a floor-plan room's window openings, or a set whose place names its windows."""
    n = sum(1 for o in ((scene.get("interior") or {}).get("openings") or []) if (o or {}).get("type") == "window")
    if not n and re.search(r"\bwindows?\b", S.location(scene).get("place") or ""):
        n = 1
    return n


def _light_words(l: dict) -> str:
    k = float(l.get("kelvin", 5600))
    tone = "warm" if k < 3300 else "cool blue" if k > 9000 else "cool" if k > 6000 else "neutral"
    kind = str(l.get("type", "light")).replace("_", " ")
    return f"a {'dim ' if kind == 'practical' else ''}{tone} {kind}{' lamp' if kind == 'practical' else ''}"


def motivated_light(scene: dict) -> str:
    """The light as the set motivates it: the key from the sun, the moon or the set's own lamps (through the window in
    a room that has one), the fill from what else is there, never a lamp the set does not have. '' when the stage sent
    its own lighting note (lighting_prompt): that note is said as written, elsewhere in the prompt."""
    if scene.get("lighting_prompt"):
        return ""
    sun = scene.get("sun") or {}
    lighting = scene.get("lighting") or {}
    el = float(sun.get("elevation_deg", 30))
    lights = [_light_words(l) for l in lighting.get("lights") or [] if isinstance(l, dict)]
    lights = list(dict.fromkeys(lights))
    inside = S.location(scene).get("int_ext") == "INT"
    win = _windows(scene)
    through = (" through the windows" if win > 1 else " through the window") if inside and win else ""
    if lighting.get("overcast"):
        sky, dark = "soft overcast daylight", False
    elif el < -6:
        sky, dark = "cool moonlight", True
    elif el < 0:
        sky, dark = "blue-hour skylight", True
    elif el < 6:
        sky, dark = "low magic-hour sun", False
    elif el < 20:
        sky, dark = "low golden-hour sun", False
    else:
        sky, dark = "bright sunlight", False
    if inside and not win:          # a closed room: only its own lamps light it
        key, fill = (lights[0], _join(lights[1:2]) or "soft bounce off the walls") if lights else ("soft ambient light", "")
    elif dark and lights and not through:   # a night street: the lamps are the key, the moon fills
        key, fill = lights[0], sky
    else:
        key = sky + through
        fill = lights[0] if lights else ("soft bounce off the walls" if inside else "soft skylight" if not dark else "")
    bits = [f"motivated light: {key} as the key"] + ([f"{fill} as fill"] if fill else [])
    return ", ".join(bits + ["deep natural shadows" if dark else "natural shadows"])


def _focus_target(f1: dict) -> str:
    """'the subject' when someone or something is in frame: never the noun again. The people phrase says each person
    once (C22c: a woman named twice came out as two women; C28's (b) and (c), which said "focus on the woman", painted a
    second woman on one seed of two)."""
    return "the subject" if (f1.get("people") or f1.get("others")) else ""


def camera_block(look: dict, scene: dict, parts: dict, f1: dict, steps: int | None = None, edit: bool = False) -> dict:
    """The concrete camera setup that heads a photographic still (C28 variant (d); (e) for the edit instruction).

    Derived from what the App knows: the stage's focal length and its T-stop when it keys one (else the Look tab's
    aperture, else T2), the Look tab's body, glass and stock (else Alexa 35, Cooke S4, Vision3 500T). Returns
    {"text", "said": the look fields the block already says (their own fragments are not repeated), "body_rest"}."""
    c = parts["chosen"]
    body = c.get("camera_body") or {}
    bstill = body.get("still", "")
    said, body_rest = {"aperture"}, ""
    cine = True
    if not body:
        head = f"photograph shot on {_a(DEFAULT_BODY)}"
    elif bstill.startswith("shot on "):
        name, _, body_rest = bstill[len("shot on "):].partition(", ")
        name = re.sub(r"\s*\b8K\b", "", name)          # "RED V-Raptor 8K": the resolution tag is a banned word
        head = f"photograph shot on {name if name.startswith(('a ', 'an ')) else _a(name)}"
        said.add("camera_body")
    else:   # a video camera (smartphone, VHS, CCTV): its own words lead, no film stock or film grain of ours
        name, _, body_rest = bstill.partition(", ")
        head, cine = name, False
        said.add("camera_body")
    mm = round(f1["focal_mm"])
    lens = c.get("lens")
    glass = f"{mm}mm {DEFAULT_GLASS} lens" if not lens or lens.get("id") == "cooke_s4" else f"{mm}mm lens"
    t = _stage_t_stop(scene) or _look_t_stop(c) or DEFAULT_T_STOP
    head += f" with {_a(glass)} at {_stop_word(t)}"
    target = _focus_target(f1)
    inside = f1["location"]["int_ext"] == "INT"
    if t <= 2.8:
        dof = ["shallow depth of field"]
        if target and not edit:
            dof += [f"focus on {target}", f"the {'back wall' if inside else 'background'} softly out of focus"]
    elif t <= 5.6:
        dof = ["moderate depth of field"] + ([f"focus on {target}"] if target and not edit else [])
    else:
        dof = ["deep focus, foreground and background both sharp"]
    stock = c.get("film_stock") or {}
    sid = stock.get("id", "")
    stock_words = stock.get("still", "") or (DEFAULT_STOCK if cine else "")
    if stock:
        said.add("film_stock")
    texture = []
    already = " ".join([stock_words, (lens or {}).get("still", ""), bstill]).lower()
    if cine and sid not in _NO_GRAIN and "grain" not in already:
        texture.append("fine visible film grain")
    if cine and sid not in _NO_HALATION and "halation" not in already and not parts["bw"]:
        texture.append(f"gentle halation around the bright {'window' if _windows(scene) else 'highlights'}")
    vignette = (steps or DEFAULT_FRAME_STEPS) >= VIGNETTE_MIN_STEPS
    if edit:
        edge = "slight vignetting" if vignette else ""
    else:
        edge = "slight vignetting and softness at the frame edges" if vignette else "slight softness at the frame edges"
    light = motivated_light(scene)
    text = _join([head, *dof, stock_words, *texture, edge, light])
    return {"text": text, "said": said, "body_rest": body_rest, "light": bool(light)}


def _garments(wear: str) -> list[str]:
    words = (wear or "").lower()
    found = []
    for g in _GARMENTS:
        if re.search(rf"\b{re.escape(g)}s?\b", words) and not any(g in f for f in found):
            found.append(g)
    return found


def top_wear(wear: str) -> str:
    """The upper garment of a wardrobe text ('a pink button-up shirt with rolled-up sleeves' from 'wearing a pink
    button-up shirt with rolled-up sleeves, blue jeans and dark shoes, fully clothed'), '' when none is named: all a
    hands-only insert shows."""
    text = re.sub(r"^wearing\s+", "", (wear or "").strip())
    text = re.sub(r",?\s*fully clothed\s*$", "", text)
    first = re.split(r",\s*|\s+and\s+", text)[0].strip()
    return first if first and first.lower() != "fully clothed" else ""


def skin_fabric_tail(scene: dict, f1: dict, look: dict, short: bool = False) -> str:
    """'real skin texture with pores and fine lines, visible fabric weave and creases in the shirt and jeans': the
    garments are the ones the people phrase already names (identity.known_wear), never new clothes."""
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    garments: list[str] = []
    for e in f1["people"]:
        wear = known_wear(by_id.get(e["id"]) or e["actor"], look)
        for g in _garments(top_wear(wear) if S.hands_only(e) else wear):   # an insert on the hands: the sleeves only
            if g not in garments:
                garments.append(g)
    if short:
        return "real skin texture with pores, visible fabric weave and creases"
    where = (" in the " + S._join_and(garments)) if garments else " in their clothes"
    return f"real skin texture with pores and fine lines, visible fabric weave and creases{where}"


def _still_count(n: int) -> str:
    return {0: "no people in frame", 1: "exactly one person in frame", 2: "exactly two people in frame",
            3: "exactly three people in frame"}.get(n, f"exactly {n} people in frame")


# People in the still: words that pull the image model toward real actors photographed on set, and away from the
# smooth mannequin it is handed (the stage's clay figures). Measured on FLUX 3 Klein, docs/decisions.md 2026-10-30.
REAL_PEOPLE = ("real actors, natural skin texture, real hair and fabric with creases, candid unposed body language, "
               "natural expressions")
# Vocabulary still fragments as they were before Milestone 5, for re-rendering a frame picked then.
LEGACY_STILL = {"kodak_200t": "Kodak Vision3 200T film stock, tungsten balance, fine grain, smooth skin"}
# An insert on the hands (every person in frame is hands only, scene.hands_only): no body language, no expressions
# (Maya S3, 2026-11-09: "candid unposed body language, natural expressions" with "standing" painted whole figures).
REAL_HANDS = "real hands, natural skin texture with knuckles, veins and fine creases, real fabric with creases"
# what the frame models painted on the Maya S3 insert: legs and shoes standing on the table
HANDS_ONLY_NEG = "legs, feet, shoes, standing figure, full body, face, person standing on the table"
# The motion prompt's negative on a hands-only insert (compile_look "motion_negative"; ⑤ Motion adds it to the video's
# negative for the queue). LTX reads a negative only above CFG 1.
HANDS_ONLY_MOTION_NEG = "face, head, standing figure, legs, feet, shoes, full body"
# Words a hands-only insert's motion prompt never carries from the description: the lower body, the stance, the face
# and hair (the Maya S3 description: "Maya wears a pink button-up shirt with rolled-up sleeves, blue jeans, her dark
# hair tied back"; the jeans and the hair are out of frame).
_NOT_HANDS = re.compile(r"\b(?:jeans|trousers|pants|shorts|skirts?|leggings|shoes?|boots?|sneakers|trainers|heels|socks|"
                        r"legs?|knees?|feet|foot|hair|ponytail|braids?|face|eyes|head|stands?|standing|sits?|sitting|"
                        r"seated|walks?|walking|facing|expressions?)\b", re.I)


def hands_only_text(text: str) -> str:
    """A description for a hands-only insert: the comma (or 'and') pieces that name what is out of frame are dropped;
    the room, the light, the shirt and the hands stay. A sentence with nothing left goes."""
    out = []
    for sentence in re.split(r"(?<=[.!?])\s+", (text or "").strip()):
        if not sentence:
            continue
        end = sentence[-1] if sentence[-1] in ".!?" else ""
        body = sentence[:-1] if end else sentence
        keep = []
        for clause in re.split(r",\s*", body):
            if not _NOT_HANDS.search(clause):
                keep.append(clause)
                continue
            parts = [x for x in re.split(r"\s+and\s+", clause) if not _NOT_HANDS.search(x)]
            if parts and len(parts) < len(re.split(r"\s+and\s+", clause)) and not re.search(r"\b(?:wears?|wearing)\b", parts[0]) \
                    and re.search(r"\b(?:wears?|wearing)\b", clause):
                parts = []   # "Maya wears jeans and a shirt": the verb went with the dropped half; leave it whole out
            if parts:
                keep.append(" and ".join(parts))
        if keep:
            t = ", ".join(keep).strip()
            out.append(t[:1].upper() + t[1:] + (end or "."))
    return " ".join(out)


def is_hands_insert(f1: dict) -> bool:
    """Every person in frame 1 is hands only (scene.hands_only): an insert on the hands."""
    return bool(f1["people"]) and all(S.hands_only(e) for e in f1["people"])


def hands_identity(scene: dict, look: dict, f1: dict) -> str:
    """The motion prompt's clothing line for a hands-only insert: only the sleeves show ("Her pink button-up shirt with
    rolled-up sleeves shows at her wrists from the first frame to the last."), never the jeans or the shoes."""
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    out = []
    for e in f1["people"]:
        top = top_wear(known_wear(by_id.get(e["id"]) or e["actor"], look))
        if not top:
            continue
        pron = {"woman": "her", "man": "his", "girl": "her", "boy": "his"}.get((e.get("actor") or {}).get("kind"), "their")
        top = re.sub(r"^(?:a|an|the)\s+", "", top)
        out.append(f"{pron.capitalize()} {top} shows at {pron} wrists from the first frame to the last.")
    return " ".join(out)


REAL_PEOPLE_NEG = "plastic skin, mannequin, doll-like faces, wax figure, CGI character, 3D render, video game character"

# A look that asks for a drawn or rendered world keeps its people stylised too.
_STYLISED = re.compile(r"\b(animat\w*|cartoon\w*|anime|manga|pixar|claymation|stop[- ]motion|cgi|3d render\w*|cel[- ]shad\w*|"  # clay-alias
                       r"illustrat\w*|painting|painted|comic\w*|video game|toon|puppet\w*|lego|low[- ]poly)\b", re.I)


def real_people_wanted(look: dict) -> bool:
    text = " ".join([look.get("description") or "", *((look.get("brief") or {}).values())])
    return not _STYLISED.search(text)


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


_PEOPLE_SLOT = "\x00people\x00"
_COUNTED_PERSON = re.compile(r"^(?:a|an|one|two|three|exactly (?:one|two|three))\s+(?:woman|man|child|person|people|"
                             r"women|men|children)$", re.I)


def _drop_repeated_people(desc: str, people_words: str) -> str:
    """The description's own people line ("one woman, full figure, small in frame, standing at the right third,
    mid-distance") repeats what the people phrase now says from the stage: C22c's F0 prompt named the woman twice and
    Krea 2 painted two. Comma pieces that are a bare count + person noun, or that the people phrase says word for word,
    leave the description; everything else (the room, the light, a person's clothes) stays."""
    said = {p.strip().lower() for p in re.split(r"[,;:]", people_words)}
    parts = re.split(r"(,\s*|\.\s+|\.$)", desc or "")
    pieces, seps = parts[0::2], parts[1::2] + [""]
    out: list[list[str]] = []                      # [piece, separator after it]
    for piece, sep in zip(pieces, seps):
        bare = piece.strip()
        if bare and (bare.lower() in said or _COUNTED_PERSON.match(bare)):
            if "." in sep and out:
                out[-1][1] = sep                     # the sentence still ends where it did
            continue
        out.append([piece, sep])
    text = "".join(p + s for p, s in out).strip()
    return re.sub(r",\s*$", "", text)


def compile_still(look: dict, scene: dict, parts: dict, edit: bool = False,
                  steps: int | None = None) -> tuple[str, str]:
    """The frame-1 still prompt and negative. edit=True is the text for an edit model that sees the stage's Color pass
    as image 1 (FLUX Klein, the Look's `edit_prompt`): the shot-size and the who-is-where slots go, because the picture
    already says where everyone is and those words made Klein recompose the shot (share/QA/klein_fix s_nopos).
    steps: ④ Frame's step count for the frame model (None = its default, 12); "slight vignetting" needs 12 or more.

    A photographic look (real people wanted, not a frame picked before Milestone 5) opens with the camera block
    (camera_block, C28) instead of "cinematic film still"; a drawn or rendered look, and a legacy frame, keep the
    old head."""
    f1 = S.frame1_facts(scene)
    c = parts["chosen"]
    legacy = scene.get("look_start") is False
    photo = real_people_wanted(look) and not legacy
    cam = camera_block(look, scene, parts, f1, steps, edit) if photo else None
    named = any(f in c and c[f].get("still") for f in ("movement", "subgenre", "genre"))
    # a genre / movement head ("Korean thriller film still") still leads; the block replaces only the generic head
    style = (([_style_head(parts)] if named else []) + [cam["text"]]) if cam else [_style_head(parts)]
    genre_layer = "subgenre" if "subgenre" in c else "genre"   # a subgenre already says its genre
    if "movement" in c and genre_layer in c:
        style.append(c[genre_layer]["still"])
    said = cam["said"] if cam else set()
    lens_frag = c.get("lens", {}).get("still", "")
    if cam and c.get("lens", {}).get("id") == "cooke_s4":
        lens_frag = lens_frag.partition(", ")[2]          # "Cooke S4 prime" is in the block already
    body_frag = cam["body_rest"] if "camera_body" in said else c.get("camera_body", {}).get("still", "")
    # People: each one said ONCE - count, size, place, distance, the body's facing at frame 0, and clothes (C22c,
    # 2026-11-08: the old group phrase named the one woman twice, in the plural, facing the way she would walk, and
    # Krea 2 painted a second woman; no clothes were named and the woman came out bare-chested). A frame picked before
    # Milestone 5 keeps the words it was painted with, plus the clothes; so do the seats of a car the camera rides in.
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    def wear_of(e):
        w = wardrobe(scene, by_id.get(e["id"]) or e["actor"], look)
        if S.hands_only(e):   # an insert on the hands: the sleeves show, never the jeans or the shoes
            top = top_wear(w)
            return f"wearing {top}" if top else ""
        return w
    one_phrase = not legacy and S.ride_host(scene) is None
    if one_phrase:
        # kept whole through _dedupe: two people both "full figure, mid-distance" each keep their own words
        people_words = S.person_still_phrase(f1["people"], f1["camera"], wear_of)
        people = [_PEOPLE_SLOT] if people_words else []
    else:
        people = S.group_phrase(f1["people"], f1["camera"])
        dressed = [f"{S.definite(e['noun'])} {wear_of(e)}" for e in sorted(f1["people"], key=lambda e: e["sx"])]
        people += ["; ".join(dressed)] if dressed else []
    others = S.group_phrase(f1["others"], f1["camera"])   # animals/vehicles need facing too (a horse from behind is ambiguous)
    grps = S.groups(f1["others"], f1["camera"])
    away = [g for g in grps if "facing away" in (g["facing"] or "")]
    facing_neg = ", ".join(f"{g['nouns']} facing the camera, heads toward the camera" for g in away)
    # A person with their back (or three-quarter back) to the lens at frame 0: Klein turns them round otherwise.
    for g in S.groups(f1["people"], f1["camera"]):
        if (g["facing"] or "").startswith(("seen from behind", "in three-quarter view from behind")):
            facing_neg += f", {g['nouns']} facing the camera, face toward the lens"
    # Vehicles: the opposite end toward the camera, and any reversing, are the classic failure.
    for g in grps:
        fw = g["facing"] or ""
        if "tail lights toward the camera" in fw:
            facing_neg += f", {g['nouns']} facing the camera, headlights toward the camera, driving in reverse"
        elif "headlights and grille facing us" in fw:
            facing_neg += f", rear of {g['nouns']} toward the camera, tail lights toward the camera, driving in reverse"
        elif "nose pointing" in fw and "revers" not in fw:   # the J-turn's frame 1 IS reversing: never negate it
            facing_neg += f", {g['nouns']} driving backwards, reversing"
    hands = bool(f1["people"]) and all(S.hands_only(e) for e in f1["people"])
    if hands:
        facing_neg += ", " + HANDS_ONLY_NEG
    facing_neg = facing_neg.lstrip(", ")
    who = people + others
    n = len(f1["people"])
    loc = f1["location"]
    # a set whose place already says underwater (the reef) keeps its words; a camera under the tank's surface says it
    place = loc["place"] if f1["underwater"] and "underwater" in (loc["place"] or "") else "underwater" if f1["underwater"] else loc["place"]
    # crates and boxes in plain words: Klein letters "shipping crates" with gibberish stencils (look/identity.py)
    props = [f"{p['word'] if legacy else plain_word(p['word'], p.get('kind'))} {p['where']}" for p in f1["props"][:3]]
    seen = {e["id"] for e in f1["people"] + f1["others"]}   # in the shot camera's frame at frame 0, not hidden
    names = [a.get("name") for a in scene.get("actors") or [] if S.classify(a)[1] in ("biped", "quadruped")]
    desc = frame1_safe(look.get("description", ""), absent_words(scene, f1), names)
    if one_phrase and people and not edit:
        desc = _drop_repeated_people(desc, people_words)
    vcam = S.vehicle_camera(scene)
    lock = S.traffic_lock(scene, seen)
    shot = vcam["still"] if vcam else SIZE_STILL[f1["size"]] + ("" if who else " of the location")
    if edit:   # image 1 holds the framing and every mark: no shot size, no placement words; the clothes stay
        dressed = [f"{S.definite(e['noun'])} {wear_of(e)}" for e in sorted(f1["people"], key=lambda e: e["sx"])]
        shot, who = "", (["; ".join(dressed)] if dressed else [])
    # A head count only when people show: seen from outside, a car's driver is part of the car and a count of
    # zero (or one) makes Krea paint pedestrians; seen from inside, the riders ARE the people in frame.
    count = not lock or n > 0
    # A frame picked before Milestone 5 re-renders with the words it was painted with (stage sends look_start false).
    real = photo
    if vcam and vcam.get("where") in ("interior", "hood", "bumper", "wheel") and place and place != "underwater":
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
        SW.still_words(scene, seen),           # divers and swimmers: the kit, the regulator in the mouth (look/swim.py)
        # where the eyes go means nothing with every head out of frame (an insert on the hands)
        "" if f1["people"] and all(e.get("crop") for e in f1["people"]) else "; ".join(frame1_looks(scene)),
        "" if legacy else still_identity(scene, {e["id"] for e in f1["people"] + f1["others"]}),   # which car is which
        "" if legacy else body_words(scene, {e["id"] for e in f1["others"]}).rstrip("."),   # what the car is; a blank plate
        lock["still"] if lock else "",
        # The count line stays: C22c's ablation F2 (count kept, group phrase gone) painted one person on both seeds.
        _still_count(n) if count else "",
        # no face in frame (every head out of it): no expressions; only hands: no body language either
        (REAL_HANDS if hands else REAL_PEOPLE.replace(", natural expressions", "")
         if all(e.get("crop") for e in f1["people"]) else REAL_PEOPLE) if n and real else "",
        _only_blocking(n, sum(1 for e in f1["others"] if e.get("rig") == "vehicle")) if count and not lock else
        ("nobody else in the car, nobody else in the background" if count and vcam else ""),
        # The bumper and over-the-tyre mounts lead with "low camera hard-mounted": never "eye-level" after that.
        S.ANGLE_STILL[f1["angle"]] if f1["angle"] != "eye" else
        "low angle" if (vcam or {}).get("where") in ("bumper", "wheel") else "eye-level camera",
        "" if cam else f"{round(f1['focal_mm'])}mm lens",   # the block says "35mm Cooke S4 prime lens at T2"
        lens_frag,
        "" if cam else c.get("aperture", {}).get("still", ""),
        place_words,
        "; ".join(props),
        still_words(scene, {e["id"] for e in f1["people"] + f1["others"]}).rstrip("."),   # Milestone 26: lamps, doors, paint
        loc["weather"],
        f1["lighting"],
        c.get("technique", {}).get("still", ""),
        _intensity(c.get("mood", {}).get("still", ""), look) if c.get("mood") else "",
        "black and white" if parts["bw"] else parts["palette_still"],
        "" if "film_stock" in said else
        (LEGACY_STILL.get(c.get("film_stock", {}).get("id")) if legacy else None) or c.get("film_stock", {}).get("still", ""),
        body_frag,
        _join(_grade_words(look)),
        # C28: the skin and fabric tail closes the still, naming the clothes the people phrase already gave them
        skin_fabric_tail(scene, f1, look) if cam and n else "",
    ])
    # Never tell the model "no people" when the shot has people in it: riders in the car, someone walking in later.
    no_people = n == 0 and not S.people_in_shot(scene)
    count_neg = FRAME1_NEGATIVE + (", people, person, figure" if no_people else "") if n <= 3 else "extra people"
    scene_neg = [facing_neg, vcam["negative"] if vcam else "", lock["negative"] if lock else "",
                 SW.negative_words(scene, seen), *parts["negatives"], look.get("negative", "")]
    if cam:
        # C28 (d): the short negative, plus only what this shot needs (facing, the car, the empty road, the swim kit,
        # the look's own). A look that asks for HDR keeps "HDR" out of its negative.
        short = C28_NEGATIVE.replace("HDR, ", "") if re.search(r"\bHDR\b", prompt) else C28_NEGATIVE
        negative = _join([count_neg, short, *scene_neg])
    else:
        negative = _join([count_neg, BLUR_SAFE_NEGATIVE if _ASKS_BLUR.search(prompt) else BASE_NEGATIVE,
                          REAL_PEOPLE_NEG if n and real else "", facing_neg, NOTHING_EXTRA_NEG, *scene_neg[1:]])
    if edit and cam:
        return _edit_instruction(look, scene, f1, cam, prompt, people_words if one_phrase and people else "",
                                 wear_of, n, real), _dedupe(negative)
    still = _dedupe(prompt)
    if one_phrase and people:
        still = still.replace(_PEOPLE_SLOT, people_words)
    return still, _dedupe(negative)


def _edit_instruction(look: dict, scene: dict, f1: dict, cam: dict, prompt: str, people_words: str, wear_of,
                      n: int, real: bool) -> str:
    """④ Frame on FLUX Klein (the Look's `edit_prompt`): C28 variant (e), the only Klein text that came close to a
    photograph (and, with "Lock to the stage depth: Light", gave one on both seeds). An instruction to turn image 1
    into a photograph of the same shot, keeping the place, the camera and every mark; then the camera block without
    the focus target; then who is there and what they wear (no positions: image 1 has them); the skin, fabric and
    material words; and the rest of the look. `prompt` is compile_still's edit=True slot list, joined: its look words
    (genre, era, description, palette, grade …) follow, minus what the block already said."""
    inside = f1["location"]["int_ext"] == "INT"
    place = "room" if inside else "location"
    others = f1["others"]
    if n == 1 and not others and S.hands_only(f1["people"][0]):   # an insert on the hands: there is no body to keep
        marks = f"{S.definite(re.sub(r' (?:sitting on|on|riding) an? [\w ]+$', '', f1['people'][0]['noun']))}'s hands"
    elif n == 1 and not others:
        marks = f"{S.definite(f1['people'][0]['noun'])}'s position, size and pose"
    elif n or others:
        marks = "every person's and object's position, size and pose"
    else:
        marks = "every object's position and size"
    head = (f"Turn image 1, a plain 3D stage render, into a real photograph of the same shot: keep the {place}, the "
            f"camera, and {marks} exactly.")
    block = _cap(cam["text"].replace("photograph shot on", "Shot on", 1)) + "."
    dressed = [f"{S.definite(e['noun'])} {wear_of(e)}".strip() for e in sorted(f1["people"], key=lambda e: e["sx"])]
    if n == 1 and S.hands_only(f1["people"][0]):
        who = _join([f"Only the hands of one {re.sub(r'^(?:a|an|the) ', '', f1['people'][0]['noun'])}", wear_of(f1["people"][0])])
    elif n == 1:
        who = f"Exactly one {re.sub(r'^(?:a|an|the) ', '', f1['people'][0]['noun'])}, {wear_of(f1['people'][0])}"
    elif n:
        who = f"Exactly {NUM.get(n, n)} people: " + "; ".join(dressed)
    else:
        who = ""
    floorplan = bool((scene.get("interior") or {}).get("rooms"))
    material = "real plaster walls and wooden floor" if floorplan else "real materials on every surface"
    tail = _join([who, skin_fabric_tail(scene, f1, look, short=True) if n and real else "", material,
                  (f"nobody else in the {'room' if inside else 'frame'}" if n else "")])
    # The rest of the look: compile_still's edit slots minus the block (first) and what the instruction now says.
    rest = prompt.replace(_PEOPLE_SLOT, "")
    if rest.startswith(cam["text"]):
        rest = rest[len(cam["text"]):]
    drop = {x.strip().lower() for x in (people_words, *dressed, _still_count(n)) if x}
    drop |= {p.strip().lower() for p in (REAL_PEOPLE + ", " + skin_fabric_tail(scene, f1, look)).split(",")}
    if cam["light"]:
        drop |= {p.strip().lower() for p in (f1["lighting"] or "").split(",")}
    keep = [p for p in _dedupe(rest).split(", ") if p and p.strip().lower() not in drop
            and not p.lower().startswith(("nobody else", "no other vehicles", "eye-level camera", "in ", "exactly "))]
    worn = "; ".join(dressed)   # the clothes are in `who` already
    keep = [p for p in keep if p not in worn]
    look_s = _cap(_join(keep)) + "." if keep else ""
    return " ".join(x for x in (head, block, _cap(tail) + "." if tail else "", look_s) if x)


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
        elif end["people"] or end.get("others"):
            # People first; with nobody in frame, the car (or horse) the shot ends on: a stunt car still in shot at
            # the end must not read as "the empty set" (LTX then drives it out of frame).
            ends = end["people"] or end["others"]
            who = S._join_and([the(e["noun"]) for e in ends])
            sx = sum(e["sx"] for e in ends) / len(ends)
            dest = f"as the move completes, {who} {'are' if len(ends) > 1 else 'is'} {S.screen_words(sx)} in {S._article(size_end)}"
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
    out = []
    for m in marks:
        if m.get("sit_text"):   # a timed sit / stand (scene._sit_mark): its own sentences, never grouped
            again = bool(introduced) and {m["id"]} == introduced
            out.append(_cap(f"{S.definite(m['noun']) if again else m['noun']} {m['sit_text']}"))
            continue
        groups.setdefault((m["verb"], m["way"], m["dest"]), []).append(m)
    for (verb, way, dest), ms in groups.items():
        again = bool(introduced) and {m["id"] for m in ms} == introduced
        who = ("they" if len(ms) > 1 else S.definite(ms[0]["noun"])) if again else S._group_nouns([m["noun"] for m in ms])
        if len(ms) > 1 and ms[0].get("verb_pl"):
            verb = ms[0]["verb_pl"]
        elif len(ms) > 1:
            verb = {"walks": "walk", "walks briskly": "walk briskly", "runs": "run", "drives": "drive", "drives forward": "drive forward", "rolls forward": "roll forward",
                    "rolls": "roll", "trots": "trot"}.get(verb, verb)
            verb += " together" if verb.startswith("walk") else ""
        out.append(_cap(_join([f"{who} {verb} {way}".strip(), dest], " ")) + ".")
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


def _frame_holds(scene: dict, f1: dict, lock: dict | None, rides: dict) -> str:
    """The closing 'nothing else' sentence. Riding along in a car it names what the frame holds, positively: at CFG 1
    LTX reads "no other vehicles" as vehicles (Milestone 5)."""
    host = S.ride_host(scene)
    if lock and host is not None and scene.get("look_start") is not False:
        noun = rides.get("noun") or "car"
        n = len(S.riders_of(scene, host.get("id"), 0))
        inside = {0: "", 1: " and the person inside it"}.get(n, f" and the {NUM.get(n, n)} people inside it")
        others = [a for a in scene.get("actors") or [] if a is not host and S.classify(a)[1] == "vehicle"]
        more = f", the {_join([S.classify(a)[0].split(' ', 1)[-1] for a in others], ' and the ')}" if others else ""
        return f"The frame holds only the {noun}{inside}{more}, start to end."
    if lock:
        return "Nobody and nothing else enters the frame at any point, not even at its edges near the end: no bystanders, no other vehicles."
    return "Nobody and nothing else enters the frame: no bystanders, no extra cars."


def _in_shot_ids(scene: dict, f1: dict) -> set:
    """Everyone in frame at the start, plus every rider and mover that enters later (the western's riders run in)."""
    ids = {e["id"] for e in f1["people"] + f1["others"]}
    ids |= {m["id"] for m in S.actor_marks(scene)}
    return ids


def set_pieces_sentence(f1: dict, limit: int = 5) -> str:
    """The Video -> 3D set blocks in frame, each by its kind word and where it stands ("Rocks stand on the left edge of
    frame and a box in the centre of frame."). LTX sees each clay block in the depth guide; without a word for it, it
    paints whatever it likes there (pillars, on the street-dance clip)."""
    items = [q for q in f1.get("props") or [] if q.get("set_word")][:limit]
    if not items:
        return ""
    bits = [f"{q['word']} {q['where']}" for q in items]
    return _cap("In the set: " + S._join_and(bits)) + "."


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
                 "hood": f"Exterior {f1['size_ltx'].lower()} from the hood of a {going} {rides.get('noun', 'car')}{through}",
                 "bumper": f"Exterior {f1['size_ltx'].lower()} from the front bumper of a {going} {rides.get('noun', 'car')}{through}",
                 "wheel": f"Exterior {f1['size_ltx'].lower()} from just above the front wheel of a {going} {rides.get('noun', 'car')}{through}"}
        head = where.get(vcam.get("where"), where["interior"])
    else:
        head = _join([
            _join([f"{'Interior' if loc['int_ext'] == 'INT' else 'Exterior'} {f1['size_ltx'].lower()}",
                   S.ANGLE_LTX[f1["angle"]] and f"from a {S.ANGLE_LTX[f1['angle']]} angle"], " "),
            ("underwater" if f1["underwater"] and "underwater" not in (loc["place"] or "") else loc["place"] and f"in {loc['place']}"),
        ], " ")
    light = _join([_no_numbers(f1["lighting"]), loc["weather"]])
    # An insert on the hands (the still's hands_only): the hands, the surface and what the fingers do, no stance,
    # facing, place in frame, legs, shoes or face (Maya S3, 2026-11-09)
    hands = is_hands_insert(f1)
    hands_ids = {e["id"] for e in f1["people"]} if hands else set()
    if hands:   # the rim the backlight puts on hair and shoulders is out of frame: say where it lands
        light = light.replace("rim on hair and shoulders", "rim on the hands and sleeves")
        blocking_s = " ".join(x for x in [" ".join(S.hands_motion_sentence(e, scene) for e in f1["people"]),
                                          S.blocking_sentence(f1["others"], f1["camera"])] if x)
        mf = {**mf, "marks": [m for m in mf["marks"] if m["id"] not in hands_ids]}
    else:
        blocking_s = S.blocking_sentence(f1["people"] + f1["others"], f1["camera"])
    props = [p for p in f1["props"] if p["kind"] == "building"]
    set_s = _cap(f"{props[0]['word']} {'fills the background' if props[0]['where'] == 'filling the background' else 'stands ' + props[0]['where']}") + "." if props else ""
    desc = (look.get("description") or "").strip().rstrip(".")
    if hands:
        desc = hands_only_text(desc).rstrip(".")
        if re.search(r"\bfingers?\b|\btap", desc, re.I):   # the description says what the fingers do: once is enough
            blocking_s = re.sub(r" \w+ fingers tap[^.]*\.", "", blocking_s)
    lens_s = _join([S._article(f1['lens_band']), c.get("lens", {}).get("motion", ""),
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
        set_pieces_sentence(f1),
        _cap(desc) + "." if desc else "",
        _cap("; ".join(brief_parts(look))) + "." if brief_parts(look) else "",
        _marks_sentence(mf, {e["id"] for e in f1["people"] + f1["others"]}
                        if len(S.groups(f1["people"] + f1["others"], f1["camera"])) == 1 else None),
        SW.motion_sentence(scene),               # the stroke, the exhaled bubbles, the drift (look/swim.py)
        # each vehicle's paint and livery for the whole shot: the clay guide carries none (look/identity.py)
        "" if scene.get("look_start") is False else motion_identity(scene, {e["id"] for e in f1["people"] + f1["others"]}),
        # what each car is (a real body style, a blank plate) and who each person is (hat or hair): look/identity.py
        "" if scene.get("look_start") is False else body_words(scene, _in_shot_ids(scene, f1)),
        "" if scene.get("look_start") is False else (hands_identity(scene, look, f1) if hands
                                                     else people_identity(scene, look, _in_shot_ids(scene, f1))),
        "" if hands else head_beats(scene),      # head and gaze blocking: every person's head, beat by beat (no head in an insert)
        _camera_sentence(mf, f1, look),
        impact_beats(scene),                     # Milestone 21: timed material beats off the baked hits
        sfx_beats(scene),                        # practical effects: the fireball, squibs, stage blood (look/sfx.py)
        still_words(scene, {e["id"] for e in f1["people"] + f1["others"]}),   # Milestone 26: what each object's parts show
        motion_beats(scene, {e["id"] for e in f1["people"] + f1["others"]}),  # and when they change ("At 2.0 s the door opens")
        f"Shot on {lens_s}." if lens_s else "",
        _cap(_join([look_s, era_s and f"with {era_s}"])) + "." if (look_s or era_s) else "",
        _cap(style_s) + "." if style_s else "",
        _cap(tech_s) + "." if tech_s else "",
        _cap(mood_s) + "." if mood_s else "",
        c.get("energy", {}).get("motion", ""),
        _sound(parts, loc),
        ("Only the hands and what they touch are in frame, start to end; no face, no body, nobody else." if hands
         else _frame_holds(scene, f1, lock, rides) if (f1["people"] or f1["others"]) else ""),
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
    scene = without_rigs(scene)   # SFX rigs are crew equipment, never things in the shot (their effects get beats)
    parts = look_parts(look, look_context(scene))
    # ④ Frame's step count for the frame model, when the App sends it (the Look JSON's frame_steps): the vignetting rule
    try:
        steps = int((look_in or {}).get("frame_steps") or 0) if isinstance(look_in, dict) else 0
    except (TypeError, ValueError):
        steps = 0
    still, negative = compile_still(look, scene, parts, steps=steps or None)
    edit_still, _ = compile_still(look, scene, parts, edit=True, steps=steps or None)
    sw = sfx_still_words(scene)
    if sw:
        still = f"{still.rstrip(' .')}. {sw}"
        edit_still = f"{edit_still.rstrip(' .')}. {sw}"
    motion = compile_motion(look, scene, parts)
    # The Director's Book (Milestone 23): Imagery & Tone as style words, Pitfalls said positively (CFG 1: no negatives).
    from ..book.prompting import prompt_words
    bw = prompt_words((look_in or {}).get("book") if isinstance(look_in, dict) else None)
    if bw:
        still, motion = f"{still.rstrip(' .')}. {bw}", f"{motion.rstrip(' .')}. {bw}"
        edit_still = f"{edit_still.rstrip(' .')}. {bw}"
    # ④ Frame on FLUX Klein: an instruction to turn the clay (image 1) into a photograph of the same shot, then the
    # look without placement words (soundstage/router/edit_graph.py; local import: the router imports look.frame_lock).
    # A photographic look's edit_still is already that instruction (C28 variant (e), _edit_instruction).
    from ..router.edit_graph import frame_instruction
    edit_prompt = edit_still if edit_still.startswith("Turn image 1") else frame_instruction(edit_still)
    f1 = S.frame1_facts(scene)
    result = {
        "look": look,
        "still_prompt": still,
        "still_negative": negative,
        "motion_prompt": motion,
        # ⑤ Motion adds it to the video's negative for the queue (LTX reads a negative only above CFG 1)
        "motion_negative": HANDS_ONLY_MOTION_NEG if is_hands_insert(f1) else "",
        "edit_prompt": edit_prompt,
        "kb_refs": parts["kb_refs"],
        "kb": [_kb_card(r) for r in parts["kb_refs"]],
        "notes": notes + parts["notes"],
        "frame1": {"people": len(f1["people"]), "size": f1["size"], "angle": f1["angle"],
                   "focal_mm": f1["focal_mm"]},
        "palette_words": palette_words((look.get("palette") or {}).get("swatches") or []),
    }
    # ④ Frame's prompt source (Auto / Manual) for this shot replaces the compiled frame prompt (look/autoprompt.py)
    from .autoprompt import apply_override
    return apply_override(result, look_in, scene)


from .default_scene import DEFAULT_SCENE  # noqa: E402  (after the functions: the module is data only)
