"""Which car is which, in words: the paint and livery that tell two vehicles apart, and props without lettering.

The layout guide LTX follows is grey clay, so a vehicle's colours reach the video only through frame 1 and the
prompt. In the M27 crate crash (share/GhostCar_DetailLoss) the black-and-white police car crossed the left foreground
at 3.7-4.0 s, 12-16 frames after the red sports car had left that spot, and LTX painted it red, put the police light
bar on its roof and smeared the windscreen. Neither prompt said what either car looked like: "a sports car" and
"a police car" were nouns only. Each vehicle now has its paint stated in the still and its look anchored in the
motion prompt for the whole shot.

FLUX 3 Klein reads "shipping crates" as stencilled crates and paints gibberish lettering on them (M27 frame 1:
'BOB', 'D ADRA'). Its negative prompt does nothing at CFG 1, so props that invite fake text are described as plain
and unmarked in the positive prompt instead.
"""
from __future__ import annotations

import re

from . import scene as S
from .colors import color_name, is_hex

# Stock looks of the stage's vehicle models when the scene sets no paint (web/stage/library.mjs builds them so).
LIVERY = {"police_car": "black and white with a light bar on its roof"}
# Props an image model letters by default, and the plain words that keep them blank.
PLAIN = {"crate": "plain unmarked wooden crate", "cardboard_box": "plain unmarked cardboard box",
         "box": "plain unmarked box", "barrel": "plain unmarked barrel"}


def plain_word(word: str, kind: str | None) -> str:
    """'a crate' -> 'a plain unmarked wooden crate', 'several crates' -> 'several plain unmarked wooden crates',
    'a pair of crates' -> 'a pair of plain unmarked wooden crates'. Other props pass through."""
    plain = PLAIN.get(kind or "")
    if not plain or "unmarked" in word:
        return word
    noun = S.classify({"kind": kind})[0].split(" ", 1)[-1]       # the library's noun: "crate", "cardboard box"
    pl = "es" if noun.endswith(("s", "x", "ch", "sh")) else "s"
    m = re.search(rf"\b{re.escape(noun)}({pl})?\b", word)
    if not m:
        return word
    out = word[:m.start()] + plain + (pl if m.group(1) else "") + word[m.end():]
    return re.sub(r"\ban (?=[^aeiou])", "a ", re.sub(r"\ba (?=[aeiou])", "an ", out))


def _look(a: dict) -> tuple[str, str]:
    """(paint colour, livery words) of one vehicle; either may be empty. A paint the scene sets wins over the stock
    colours of the livery, but a police car keeps its light bar."""
    col = (a.get("appearance") or {}).get("color")
    paint = color_name(col) if isinstance(col, str) and is_hex(col) else ""
    livery = LIVERY.get(a.get("kind") or "", "")
    if paint and livery:
        livery = "with a light bar on its roof" if a.get("kind") == "police_car" else ""
    return paint, livery


def vehicle_looks(scene: dict, ids: set | None = None) -> list[tuple[str, str, str]]:
    """[('the sports car', 'crimson', ''), ('the police car', '', 'black and white with a light bar on its roof')]
    for the vehicles in `ids` (every vehicle when None) whose look is known. Only when two or more vehicles share the
    shot: one car on its own has nothing to be confused with."""
    cars = [a for a in scene.get("actors") or [] if S.classify(a)[1] == "vehicle"
            and (ids is None or a.get("id") in ids)]
    if len(cars) < 2:
        return []
    out = []
    for a in cars:
        paint, livery = _look(a)
        if paint or livery:
            out.append((S.definite(S.classify(a)[0]), paint, livery))
    return out


def _words(paint: str, livery: str, verb: str) -> str:
    return " ".join(w for w in (f"{verb}{paint}" if paint else "", livery) if w)


def still_identity(scene: dict, ids: set | None = None) -> str:
    """'the sports car painted crimson; the police car black and white with a light bar on its roof'."""
    return "; ".join(f"{n} {_words(p, l, 'painted ')}" for n, p, l in vehicle_looks(scene, ids))


def motion_identity(scene: dict, ids: set | None = None) -> str:
    """'The sports car is crimson and the police car is black and white with a light bar on its roof; each car keeps
    its own paint and lights from the first frame to the last.'"""
    looks = vehicle_looks(scene, ids)
    if not looks:
        return ""
    body = S._join_and([f"{n} is {_words(p, l, '')}" for n, p, l in looks])
    return f"{body[:1].upper()}{body[1:]}; each car keeps its own paint and lights from the first frame to the last."


# ---- what each car IS: a coherent real-world body style, and a blank plate ---------------------------------------
# README media v2 QC (2026-11-02): asked for "a sports car", the J-turn final painted a generic waxy toy coupé with a
# garbled number plate. The stage's car models are specific shapes (web/stage/models/*.glb, measured and rendered):
# the words below name that body style the way a car magazine would, with no brand or model names, so the image and
# video models paint one real-looking car that also matches the clay's silhouette. Plates: Klein and LTX letter any
# plate they paint, so the plate is asked for blank (positive words: at CFG 1 the negative prompt does nothing).
BODY = {
    # sports_car.glb: long low hood, cab set back, sloping fastback roof into a short deck, wide rear haunches, 10-spoke wheels
    "sports_car": "a modern two-door fastback sports coupé with a long low hood, a short rear deck, a sloping roofline, "
                  "wide rear haunches and alloy wheels",
    # police_car.glb: the same two-door coupé proportions, black with white doors and a roof light bar
    "police_car": "a two-door pursuit-coupé patrol car with a long hood, a short rear deck and steel wheels",
    # car.glb (the library's "hatchback"): a three-box four-door sedan with a separate trunk
    "hatchback": "a mid-size four-door sedan with a separate trunk, a long hood and multi-spoke alloy wheels",
    # the procedural "car": a plain four-door sedan
    "car": "a plain mid-size four-door sedan",
}
PLATE = "a blank plain white license plate with no lettering, and no badges or logos"


def body_words(scene: dict, ids: set | None = None) -> str:
    """'The sports car is a crimson modern two-door fastback sports coupé ... ten-spoke alloy wheels, with a blank plain
    white license plate with no lettering, and no badges or logos.' for every car in `ids` (all when None)."""
    out = []
    for a in scene.get("actors") or []:
        if ids is not None and a.get("id") not in ids:
            continue
        body = BODY.get(a.get("kind") or "")
        if not body or S.classify(a)[1] != "vehicle":
            continue
        paint, _ = _look(a)
        noun = S.definite(S.classify(a)[0])
        what = f"{body[:2]}{paint} {body[2:]}" if paint and body.startswith("a ") else body
        what = re.sub(r"\ba (?=[aeiou])", "an ", what)
        out.append(f"{noun[:1].upper()}{noun[1:]} is {what}, with {PLATE}.")
    return " ".join(out)


# ---- who each person is: hat or hair, clothes, kept apart for the whole shot --------------------------------------
# README media v2 QC: in the western the man's cowboy hat became long flying hair at f40-48 while he mounted beside
# the woman (an identity blend). The motion prompt named "a man" and "a woman" and grouped them ("they"), and only the
# look's description said who wore the hat. Each person's own anchor (headwear or hair, and clothes) is now said once,
# by name, with the instruction that each keeps it from the first frame to the last.
HAIR = {"short": "short hair", "long": "long hair", "bun": "hair in a bun", "ponytail": "hair in a ponytail",
        "curly": "curly hair", "bald": "a shaved head", "cap": "a cap", "hat": "a hat"}
HEADWEAR = re.compile(r"\b(cowboy hat|stetson|hat|cap|helmet|beanie|bandana|hood|headscarf|turban|beret)\b", re.I)
_DEFAULT_HAIR = {"man": ("short", "#2b211b"), "woman": ("long", "#3a2a20"), "child": ("short", "#5a3d26")}
_PERSON_NOUN = {"man": "man", "woman": "woman", "child": "child"}
_PRON = {"man": "his", "woman": "her"}
# A wardrobe phrase ends at the next person, a verb, or a clause break.
_VERBS = (r"run|runs|running|walk|walks|walking|ride|rides|riding|gallop|gallops|swing|swings|stand|stands|standing|sit|"
          r"sits|sitting|are|is|climb|climbs|mount|mounts|race|races|drive|drives|look|looks|wait|waits|hold|holds|who|"
          r"while|as|both|all|together")


def _hair_colour(h: str) -> str:
    if not (isinstance(h, str) and is_hex(h)):
        return ""
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    mx, mn = max(r, g, b), min(r, g, b)
    light = (mx + mn) / 2
    if mx - mn < 0.06:
        return "grey" if light > 0.45 else "dark"
    if light < 0.2:
        return "dark"
    if r > g * 1.35 and r > 0.45:
        return "red"
    if light > 0.62:
        return "blond"
    return "light brown" if light > 0.42 else "brown"


def _wardrobe(description: str, noun: str) -> str:
    """The clothes the look's description gives this person: 'a man in a dark canvas jacket, jeans and a cowboy hat
    and a woman in ...' -> 'a dark canvas jacket, jeans and a cowboy hat'. '' when it names none."""
    others = "|".join(n for n in ("man", "woman", "child", "boy", "girl", "person") if n != noun)
    for m in re.finditer(rf"\b(?:a|an|the|one)\s+(?:[\w-]+\s+){{0,2}}?{noun}\s+(?:in|wearing|dressed in)\s+(.+?)"
                         rf"(?=\s+and\s+(?:a|an|the)\s+(?:[\w-]+\s+){{0,2}}?(?:{others})\b|\s+(?:{_VERBS})\b|[.;:()]|$)",
                         description or "", re.I):
        # "a woman in her thirties" is her age, not her clothes (it made "The woman wears her thirties").
        if not _AGE.match(m.group(1)):
            return m.group(1).strip(" ,")
    return ""


_AGE = re.compile(r"(?:her|his|their)\s+(?:(?:early|mid|late)[\s-]+)?(?:teens|twenties|thirties|forties|fifties|sixties|seventies|"
                  r"eighties|nineties|\d+s)\b|(?:his|her|their)\s+(?:own\s+)?(?:age|prime|youth)\b", re.I)


# ---- what each person wears (C22c, 2026-11-08) ---------------------------------------------------------------------
# No clothing reached the still prompt, so Krea 2 painted the stage's woman (a pink shirt and jeans on the stage) with a
# bare, skin-toned torso. Every person now says what they wear, and a person is never described without clothes.
# The lifelike people are Microsoft Rocketbox avatars wearing their own textures (web/stage/people/avatarcore.mjs
# ROCKETBOX; the appearance colours do not reach them): what tex/f001_body_color and tex/m002_body_color show.
AVATAR_WEAR = {"woman": "a pink button-up shirt with rolled-up sleeves, blue jeans and dark shoes",
               "man": "a white polo shirt with thin brown stripes, khaki shorts and grey sneakers"}
# The stand-in (children, or anyone without a lifelike body) wears the appearance: web/stage/humans.mjs.
DEFAULT_APPEARANCE = {
    "man": {"top": "jacket", "top_color": "#3b342f", "bottom": "jeans", "bottom_color": "#2e3b55"},
    "woman": {"top": "sweater", "top_color": "#d9cbb8", "bottom": "jeans", "bottom_color": "#3a4d6e"},
    "child": {"top": "tshirt", "top_color": "#d9534f", "bottom": "shorts", "bottom_color": "#38536b"},
}
TOP_WORDS = {"tshirt": "T-shirt", "shirt": "shirt", "sweater": "sweater", "hoodie": "hoodie", "jacket": "jacket",
             "suit": "suit", "coat": "coat", "dress": "dress", "uniform": "uniform", "tank": "tank top"}
BOTTOM_WORDS = {"jeans": "jeans", "trousers": "trousers", "shorts": "shorts", "skirt": "skirt"}
CLOTHED = "fully clothed"
SWIM_WEAR = "wearing a dark full-length wetsuit"


def avatar_kind(a: dict) -> str | None:
    """avatarcore.avatarSpecFor: the Rocketbox body a person shows as ('woman' / 'man'), or None (the stand-in)."""
    kind = a.get("kind")
    if kind == "woman" or (kind == "man" and (a.get("appearance") or {}).get("gender") == "female"):
        return "woman"
    return "man" if kind == "man" else None


def _colour(h) -> str:
    return color_name(h) if isinstance(h, str) and is_hex(h) else ""


def appearance_wear(a: dict) -> str:
    """'a coral T-shirt and steel blue shorts' from the person's appearance (kind defaults filling gaps), '' if none."""
    ap = {**DEFAULT_APPEARANCE.get(a.get("kind") or "", {}), **{k: v for k, v in (a.get("appearance") or {}).items() if v}}
    top, bottom = TOP_WORDS.get(ap.get("top") or ""), BOTTOM_WORDS.get(ap.get("bottom") or "")
    if not top and not bottom:
        return ""
    parts = []
    if top:
        parts.append(" ".join(w for w in (_colour(ap.get("top_color")), top) if w))
    if bottom and ap.get("top") != "dress":
        parts.append(" ".join(w for w in (_colour(ap.get("bottom_color")), bottom) if w))
    text = _join_and_plain(parts)
    return re.sub(r"\ba (?=[aeiou])", "an ", "a " + text) if top else text


def _join_and_plain(items: list[str]) -> str:
    return " and ".join(i for i in items if i)


def wardrobe(scene: dict, a: dict, look: dict | None = None) -> str:
    """What this person wears, always with clothes: the look's description first (the director's words), else the
    lifelike avatar's own clothes, else the stand-in's appearance; 'fully clothed' closes it, and stands alone when
    nothing is known. A swimmer wears a wetsuit (look/swim.py names any dive kit). '' only for a non-person."""
    from . import swim as SW
    if S.classify(a)[1] != "biped":
        return ""
    if any(x["actor"] is a for x in SW.swimmers(scene)):
        return SWIM_WEAR
    kind = a.get("kind") or ""
    base = _PERSON_NOUN.get(kind, kind.replace("_", " "))
    own = (a.get("description") or "").strip()
    if own and (_wardrobe(own, base) or re.search(r"\b(wearing|dressed in|in an? [\w-]+ (?:shirt|dress|coat|"
                                                    r"jacket|suit|top|sweater|uniform))", own, re.I)):
        return CLOTHED                                       # the person's own noun already says what they wear
    wear = known_wear(a, look)
    return f"wearing {wear}, {CLOTHED}" if wear else CLOTHED


def known_wear(a: dict, look: dict | None = None) -> str:
    """The clothes text alone ('a pink button-up shirt ..., blue jeans and dark shoes'), '' when unknown."""
    kind = a.get("kind") or ""
    wear = _wardrobe((look or {}).get("description") or "", _PERSON_NOUN.get(kind, kind.replace("_", " ")))
    if not wear:
        ak = avatar_kind(a)
        wear = AVATAR_WEAR[ak] if ak else appearance_wear(a)
    return wear


def person_anchors(scene: dict, look: dict | None, ids: set | None = None) -> list[dict]:
    """[{id, noun, kind, wear, headwear, hair}] for the people in `ids` (all when None) whose kind is a person."""
    from . import swim as SW
    desc = (look or {}).get("description") or ""
    swim_ids = {x["actor"].get("id") for x in SW.swimmers(scene)}
    out = []
    for a in scene.get("actors") or []:
        if ids is not None and a.get("id") not in ids:
            continue
        noun, rig, _ = S.classify(a)
        kind = a.get("kind") or ""
        if rig != "biped":
            continue
        base = _PERSON_NOUN.get(kind, kind.replace("_", " "))
        ap = a.get("appearance") or {}
        style, col = _DEFAULT_HAIR.get(kind, ("short", "#3a2a20"))
        style, col = ap.get("hair") or style, ap.get("hair_color") or col
        wear = _wardrobe(desc, base) or (SWIM_WEAR.replace("wearing ", "") if a.get("id") in swim_ids
                                         else known_wear(a))   # the description's, else what the body wears (C22c)
        hw = HEADWEAR.search(wear)
        headwear = hw.group(1).lower() if hw else ({"cap": "a cap", "hat": "a hat"}.get(style, "") and style)
        hair = "" if style in ("cap", "hat") else _with_colour(HAIR.get(style, ""), _hair_colour(col))
        if style in ("cap", "hat"):   # the hair under it is the kind's default
            hair = HAIR[_DEFAULT_HAIR.get(kind, ("short", ""))[0]]
        out.append({"id": a.get("id"), "noun": S.definite(noun), "kind": kind, "wear": wear, "headwear": headwear,
                    "hair": hair, "rider": S.mount_host(scene, a) is not None})
    return out


def people_identity(scene: dict, look: dict | None, ids: set | None = None) -> str:
    """'The man wears a dark canvas jacket, jeans and a cowboy hat, his short dark hair under the hat; the woman
    wears a white shirt and jeans, bareheaded, her long brown hair loose. Each rider keeps their own hat, hair and
    clothes from the first frame to the last, and the two never swap or blend.' Only with two or more people: one
    person on their own has nobody to blend with, but still says what they wear (C22c: never undressed)."""
    ps = person_anchors(scene, look, ids)
    if len(ps) == 1:
        p = ps[0]
        what = f"wears {p['wear']}, {CLOTHED}," if p["wear"] else f"is {CLOTHED}"
        return f"{p['noun'][:1].upper()}{p['noun'][1:]} {what} from the first frame to the last."
    if len(ps) < 2:
        return ""
    parts = []
    hats = any(p["headwear"] for p in ps)
    for p in ps:
        pron = _PRON.get(p["kind"], "their")
        bits = [f"wears {p['wear']}" if p["wear"] else ""]
        if p["headwear"]:
            if p["headwear"] not in (p["wear"] or "").lower():
                hw = _article_hw(p["headwear"])
                bits = [f"{bits[0]}, with {hw}" if bits[0] else f"wears {hw}"]
            if p["hair"]:
                bits.append(f"{pron} {p['hair']} under the {p['headwear'].split()[-1]}")
        else:
            down = " down {0} back".format(pron) if "long" in p["hair"] else ""
            bits.append(("bareheaded, " if hats else "") + (f"{pron} {p['hair']}{down}" if p["hair"] else ""))
        text = ", ".join(b.strip(", ") for b in bits if b.strip(", "))
        if text.startswith("bareheaded"):
            text = "is " + text
        elif text.startswith(pron + " "):
            text = "has " + text[len(pron) + 1:]
        if text:
            parts.append(f"{p['noun']} {text}")
    if not parts:
        return ""
    who = "rider" if all(p["rider"] for p in ps) else "person"
    keep = "hat, hair and clothes" if hats else "hair and clothes"
    n = {2: "two", 3: "three"}.get(len(ps), "")
    body = "; ".join(parts)
    return (f"{body[:1].upper()}{body[1:]}. Each {who} keeps their own {keep} from the first frame to the last, "
            f"and the {n + ' ' if n else ''}{who}s never swap or blend into one another.")


def _article_hw(w: str) -> str:
    return w if re.match(r"(a|an|the)\s", w) else ("an " if w[:1] in "aeiou" else "a ") + w


def _with_colour(hair: str, colour: str) -> str:
    """'short hair' + 'dark' -> 'short dark hair'; 'hair in a bun' + 'brown' -> 'brown hair in a bun'."""
    if not colour or not hair or hair.startswith("a "):
        return hair
    if hair.endswith(" hair"):
        return f"{hair[:-5]} {colour} hair"
    return f"{colour} {hair}"
