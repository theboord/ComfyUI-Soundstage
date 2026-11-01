"""Small text helpers shared by the Director's Book modules: words, the script's vocabulary, a scene's lines.

The Script model is web/script/parse.mjs's: {title, scenes: [{id, number, heading, elements: [{type, text, character?}],
characters, breakdown, synopsis, stage_hint}], characters: [{name, scenes, lines}]}.
"""
from __future__ import annotations

import re

STOP = set("""a an the and or but nor of to in on at by for with from into onto over under till until than then so as is are
was were be been being it its this that these those he she they them his her their him our we you your i me my mine
not no never always just only very too more most less much many some any all each every one two three do does did
done have has had will would should could can may might must let lets make makes made keep keeps kept get gets got
go goes going come comes see sees seen look looks looking up down out off when while where what who whom which how why
there here also even still like feel feels thing things stuff later fix fixed maybe bit lot lots way right ok okay
something somehow sort kind""".split())

# Title words that are part of a character's cue but don't name them on their own ("DEPUTY COLE" is "Cole").
TITLES = {"deputy", "sheriff", "officer", "mr", "mrs", "ms", "dr", "doctor", "captain", "detective", "agent", "old", "young",
          "the", "uncle", "aunt", "sir", "lady", "miss", "father", "mother", "sergeant", "sgt", "lt", "lieutenant"}

WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


def stem(w: str) -> str:
    w = w.lower().replace("’", "'")
    if w.endswith("'s"):
        w = w[:-2]
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    for suf in ("ing", "ed", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            w = w[: -len(suf)]
            break
    return w


def words(text: str) -> list[str]:
    return WORD.findall(str(text or "").lower().replace("’", "'"))


def content_stems(text: str) -> list[str]:
    return [stem(w) for w in words(text) if w not in STOP and len(w) > 1]


def scene_lines(sc: dict) -> list[tuple[int, dict]]:
    """(element index, element) for the lines a note can sit on: action, dialogue, parenthetical, transition, shot."""
    return [(i, e) for i, e in enumerate(sc.get("elements") or []) if e.get("type") not in ("character", "page_break")]


def breakdown_items(sc: dict) -> list[str]:
    out = []
    for v in (sc.get("breakdown") or {}).values():
        if isinstance(v, list):
            out += [str(x.get("text") if isinstance(x, dict) else x) for x in v]
    return out


def scene_text(sc: dict) -> str:
    parts = [sc.get("heading", ""), sc.get("synopsis", ""), " ".join(e.get("text", "") for e in sc.get("elements") or []),
             " ".join(breakdown_items(sc)), " ".join((sc.get("stage_hint") or {}).get("objects") or [])]
    return " \n".join(p for p in parts if p)


def script_vocab(script: dict) -> set[str]:
    v: set[str] = set()
    for sc in (script or {}).get("scenes") or []:
        for w in words(scene_text(sc)):
            v.add(w)
            v.add(stem(w))
    for c in (script or {}).get("characters") or []:
        for w in words(c.get("name", "")):
            v.add(w)
    for w in words((script or {}).get("title", "")):
        v.add(w)
    return v


def character_names(script: dict) -> list[str]:
    names = [c.get("name") for c in (script or {}).get("characters") or [] if c.get("name")]
    for sc in (script or {}).get("scenes") or []:
        for n in sc.get("characters") or []:
            if n not in names:
                names.append(n)
    return names


def aliases(name: str) -> list[str]:
    """'DEPUTY COLE' -> ['deputy cole', 'cole']; 'EZRA HALE' -> ['ezra hale', 'ezra', 'hale']."""
    full = " ".join(words(name))
    parts = [w for w in words(name) if w not in TITLES and len(w) >= 3]
    out = [full] + [p for p in parts if p != full]
    return list(dict.fromkeys(a for a in out if a))


def scenes_of(script: dict, name: str) -> list[str]:
    """Scene ids where a character speaks, is listed, or is named in the action."""
    al = aliases(name)
    out = []
    for sc in (script or {}).get("scenes") or []:
        if name in (sc.get("characters") or []) or any(e.get("character") == name for e in sc.get("elements") or []):
            out.append(sc["id"])
            continue
        t = " ".join(words(scene_text(sc)))
        if any(re.search(rf"\b{re.escape(a)}\b", t) for a in al):
            out.append(sc["id"])
    return out


def scene_by_number(script: dict, num: str) -> dict | None:
    n = str(num or "").strip().lower().lstrip("#")
    return next((s for s in (script or {}).get("scenes") or [] if str(s.get("number", "")).lower() == n), None)


def scene_by_id(script: dict, sid: str) -> dict | None:
    return next((s for s in (script or {}).get("scenes") or [] if s.get("id") == sid), None)
