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
