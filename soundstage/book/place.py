"""The director's shorthand -> where each note belongs in the script (Milestone 23, the Director's Book).

    place(notes, script, llm_text=None) -> [{id, text, scope, scene_id, line, character, category, categories,
                                             confidence, why, by, unknown}]

scope: "scene" (a scene, maybe a line), "character" (a standing note for one character, every scene they're in),
"global" (a rule for the whole film) or "unsorted" (the Unsorted tray). line is the element index in the scene
(web/script/parse.mjs elements), or None for the scene as a whole.

The rules read scene references ("sc2", "scene 2A"), the characters named, and the words the note shares with each
scene's text and breakdown ("chase" -> the scene whose breakdown has the car chase). The local model (prompt() and
the browser's TextGenerate run, like the Director) reads the same notes with the numbered script and may place them
better; its answer is checked (real scene, real line, real character, known category) and an explicit scene
reference or a rules placement it can't beat is kept. Without the model the rules answer alone.
"""
from __future__ import annotations

import json
import math
import re

from . import text as T

CATEGORIES = ["subtext", "lighting", "camera", "blocking", "performance", "sound", "continuity"]

# Words that say which department a note is for. They never pick the scene (a "shadow" can be in any scene).
LEX = {
    "lighting": "light lit lighting shadow shadows dark darkness silhouette silhouetted backlit backlight key fill rim glow "
                "neon practical practicals sun sunlight flare flares contrast exposure moonlight lamp lamps candle colour color "
                "warm cool magenta amber blue orange gold golden haze bright dim lantern headlight headlights face",
    "camera": "camera lens mm wide tight close closeup close-up ecu cu mcu ms ws ls low high angle overhead dutch dolly "
              "track tracking push pull crane jib drone handheld steadicam pan tilt zoom rack focus frame framing shot shots "
              "pov insert cutaway coverage master single two-shot oner fast slow speed rig tripod slider chapman whip",
    "blocking": "enter enters exit exits cross crosses stand stands sit sits walk walks move moves mark marks position "
                "distance paces apart toward towards away behind beside between blocking staging circle circles",
    "performance": "eye eyes look looks gaze stare stares blink smile smiles laugh tears voice delivery beat beats pause "
                   "pauses play plays playing emotion feel feeling nervous calm angry tender hands breath breathe whisper "
                   "flat dry wry still stillness performance acting react reacts reaction",
    "sound": "sound sounds music score song songs silence silent quiet loud sfx foley ambience ambient mix radio siren "
             "wind hum drone tone sting needle needledrop track cue cues volume hear heard audio dialogue echo",
    "subtext": "subtext really means secretly about underneath unsaid between theme guilt shame fear fears wants want "
               "need needs desire hides hiding lie lies truth knows memory grief regret",
    "continuity": "continuity prop props wardrobe costume match matches same dust dusty dirt blood wet dry costume "
                  "hair makeup scar ring watch carries carry hold holds",
}
LEX_STEMS = {cat: {T.stem(w) for w in ws.split()} for cat, ws in LEX.items()}
ALL_LEX = set().union(*LEX_STEMS.values())

# Small synonym table for scene and line matching (a note's word -> words a scene may use instead).
SYN = {
    "chase": ["pursuit", "police", "siren", "chasing", "chase"],
    "pursuit": ["chase", "police"],
    "crash": ["smash", "collide", "wreck"],
    "toss": ["tosses", "throws", "key"],
    "gunfight": ["draw", "holster"],
    "standoff": ["paces", "apart", "draw"],
    "showdown": ["paces", "apart", "draw"],
    "ocean": ["surf", "waves", "beach"], "sea": ["surf", "waves", "beach"], "shore": ["waterline", "beach"],
    "town": ["street"], "cop": ["police", "deputy"], "cops": ["police", "deputy"],
    "car": ["car", "wheel"], "drive": ["wheel", "car"], "driving": ["wheel", "car"],
    "horse": ["horses", "rider", "riders"], "horses": ["horses", "riders"], "ride": ["riders", "horses", "rode"],
}
GLOBAL_RE = re.compile(r"\b(every ?where|anywhere|throughout|always|whole (film|movie|thing)|all (scenes|of it|film)|every scene|"
                       r"the film|the movie|overall|film-?wide|across the board|no scene)\b", re.I)
SCENE_REF = re.compile(r"(?<![a-z0-9])(?:sc(?:ene)?s?\.?\s*#?\s*|s(?=\d))(\d{1,3}[a-z]?)\b", re.I)
LEAD_NUM = re.compile(r"^\s*(\d{1,3}[a-z]?)(?=\s*[:\-\u2014\u2013,.)]|\s+[a-z])", re.I)


def _norm_note(n, i):
    if isinstance(n, str):
        return {"id": f"n{i + 1}", "text": n}
    return {"id": str(n.get("id") or f"n{i + 1}"), "text": str(n.get("text") or "")}


BD_CAT = {"sound": "sound", "music": "sound", "props": "continuity", "wardrobe": "continuity"}


def _bd_stems(script: dict) -> dict:
    """Breakdown item words by Book category: a hawk's cry is sound, a brass key is a prop (not a key light)."""
    out = {"sound": set(), "continuity": set()}
    for sc in (script or {}).get("scenes") or []:
        for k, cat in BD_CAT.items():
            for it in (sc.get("breakdown") or {}).get(k) or []:
                out[cat] |= set(T.content_stems(it.get("text") if isinstance(it, dict) else it))
    return out


def categories_of(text: str, script: dict | None = None) -> list[str]:
    st = T.content_stems(text) + [T.stem(w) for w in T.words(text) if w in ("low", "high", "fast", "slow", "close", "wide", "no")]
    bd = _bd_stems(script) if script else {"sound": set(), "continuity": set()}
    hits = {}
    first = {}
    for pos, s in enumerate(st):
        skip = set()
        if s in bd["sound"]:            # a hawk's cry in the breakdown's sound: sound, whatever else the word means
            hits["sound"] = hits.get("sound", 0) + 1.5
            first.setdefault("sound", pos)
            skip = set(CATEGORIES)
        elif s in bd["continuity"]:     # a prop or wardrobe item: continuity (a brass key is not a key light)
            hits["continuity"] = hits.get("continuity", 0) + 0.75
            first.setdefault("continuity", pos)
            skip = {"lighting", "continuity"}
        for cat in CATEGORIES:
            if cat not in skip and s in LEX_STEMS[cat]:
                hits[cat] = hits.get(cat, 0) + 1
                first.setdefault(cat, pos)
    return sorted(hits, key=lambda c: (-hits[c], first[c]))


def named_characters(text: str, script: dict) -> list[str]:
    t = " ".join(T.words(text))
    found = []
    for name in T.character_names(script):
        for a in T.aliases(name):
            m = re.search(rf"\b{re.escape(a)}\b", t)
            if m:
                found.append((m.start(), name))
                break
    return [n for _, n in sorted(found)]


def _expand(stems: list[str]) -> list[str]:
    out = []
    for s in stems:
        out.append(s)
        out += [T.stem(x) for x in SYN.get(s, [])]
    return out


def _scene_stems(sc: dict) -> set[str]:
    return set(T.content_stems(T.scene_text(sc)))


def _idf(script):
    scs = script.get("scenes") or []
    df = {}
    for sc in scs:
        for s in _scene_stems(sc):
            df[s] = df.get(s, 0) + 1
    n = max(1, len(scs))
    return lambda s: math.log(1 + n / df[s]) if s in df else 0.0


def _keywords(text: str, script: dict) -> list[str]:
    names = {w for n in T.character_names(script) for w in T.words(n)}
    return [s for s in T.content_stems(text) if s not in ALL_LEX and s not in names]


def unknown_terms(text: str, script: dict) -> list[str]:
    """Content words the script never uses (a 'badge' the scene doesn't have yet)."""
    vocab = T.script_vocab(script)
    names = {w for n in T.character_names(script) for w in T.words(n)}
    out = []
    for w in T.words(text):
        if w in T.STOP or len(w) < 4 or w in names or w in vocab or T.stem(w) in vocab or T.stem(w) in ALL_LEX:
            continue
        if any(T.stem(x) in vocab for x in SYN.get(T.stem(w), [])):
            continue
        out.append(w)
    return list(dict.fromkeys(out))


def best_line(sc: dict, text: str, chars: list[str]) -> int | None:
    lines = T.scene_lines(sc)
    if not lines:
        return None
    kw = set(_expand(T.content_stems(text))) - ALL_LEX
    best, best_i = 0.0, None
    for i, e in lines:
        st = set(T.content_stems(e.get("text", "")))
        score = float(len(kw & st))
        etext = " ".join(T.words(e.get("text", "")))
        for c in chars:
            if e.get("character") == c or any(re.search(rf"\b{re.escape(a)}\b", etext) for a in T.aliases(c)):
                score += 0.6
                break
        if score > best + 1e-9:
            best, best_i = score, i
    return best_i if best >= 0.6 else None


def _sc_label(script, sid):
    sc = T.scene_by_id(script, sid)
    return f"scene {sc.get('number')}" if sc else sid


def _nice(name: str) -> str:
    return " ".join(w.capitalize() for w in T.aliases(name)[-1:]) if T.aliases(name) else name.title()


def rules_place(note: dict, script: dict) -> dict:
    text = note["text"].strip()
    cats = categories_of(text, script) or ["performance" if named_characters(text, script) else "blocking"]
    chars = named_characters(text, script)
    out = {"id": note["id"], "text": text, "scope": "unsorted", "scene_id": None, "line": None,
           "character": chars[0] if chars else None, "category": cats[0], "categories": cats,
           "confidence": 0.0, "why": "", "by": "rules", "unknown": unknown_terms(text, script)}
    if not text:
        out["why"] = "empty note"
        return out
    scenes = script.get("scenes") or []
    # 1. An explicit scene reference wins.
    m = SCENE_REF.search(text) or LEAD_NUM.match(text)
    if m:
        sc = T.scene_by_number(script, m.group(1))
        if sc:
            out.update(scope="scene", scene_id=sc["id"], confidence=0.95, why=f"the note names scene {sc['number']}")
            out["line"] = best_line(sc, text, chars)
            return _finish(out, script)
    # 2. Characters narrow the scenes; their words pick among them.
    cand = [s["id"] for s in scenes]
    char_why = ""
    if chars:
        sets = [set(T.scenes_of(script, c)) for c in chars]
        shared = set.intersection(*sets) if sets else set()
        if shared:
            cand = [s for s in cand if s in shared]
        else:
            cand = [s for s in cand if s in sets[0]]
            if len(chars) > 1:
                char_why = f"{_nice(chars[1])} is never on screen with {_nice(chars[0])}"
    idf = _idf(script)
    kw = _expand(_keywords(text, script))
    scores = []
    for sid in cand:
        sc = T.scene_by_id(script, sid)
        st = _scene_stems(sc)
        scores.append((sum(idf(s) for s in set(kw) if s in st), sid))
    scores.sort(key=lambda x: -x[0])
    top = scores[0] if scores else (0, None)
    second = scores[1][0] if len(scores) > 1 else 0
    if top[0] > 0 and top[0] > second:
        sc = T.scene_by_id(script, top[1])
        hit = [s for s in dict.fromkeys(kw) if s in _scene_stems(sc)][:3]
        bd = set(T.content_stems(" ".join(T.breakdown_items(sc)) + " " + sc.get("heading", "")))
        strong = len(hit) >= 2 or any(x in bd for x in hit)   # two words, or one from the breakdown / heading
        conf = 0.85 if strong and top[0] >= 2 * max(second, 0.01) else 0.6
        out.update(scope="scene", scene_id=sc["id"], confidence=conf,
                   why=f"“{'”, “'.join(hit)}” is in scene {sc['number']}" + (f"; {char_why}" if char_why else ""))
        out["line"] = best_line(sc, text, chars)
        return _finish(out, script)
    if chars and len(cand) == 1:
        sc = T.scene_by_id(script, cand[0])
        why = f"{_nice(chars[0])} is only in scene {sc['number']}"
        if char_why:
            why += f" ({char_why}), so it's a standing note on {_nice(chars[0])}'s performance"
        out.update(scope="scene", scene_id=sc["id"], confidence=0.75, why=why)
        out["line"] = best_line(sc, text, chars)
        return _finish(out, script)
    if chars:
        nums = ", ".join(_sc_label(script, s).replace("scene ", "") for s in T.scenes_of(script, chars[0]))
        out.update(scope="character", confidence=0.6,
                   why=f"{_nice(chars[0])} is in scenes {nums}: filed on the character, for every scene")
        return _finish(out, script)
    if GLOBAL_RE.search(text) or re.match(r"^\s*(no|never|always|all)\b", text, re.I):
        out.update(scope="global", confidence=0.6, why="reads as a rule for the whole film")
        return _finish(out, script)
    out["why"] = "no scene, line or character in the script matches this yet"
    return out


def _finish(out, script):
    if out.get("unknown") and out["scope"] in ("scene", "character"):
        u = out["unknown"][:2]
        out["why"] += f" (“{'”, “'.join(u)}” isn't in the script yet)"
    return out


# --------------------------------------------------------------------------------------------- the model

SYSTEM = """You file a film director's shorthand notes into their screenplay. For each note decide which scene it belongs to, the
line number inside that scene (or null for the whole scene), the character it is about (or null), and its category.
Categories: subtext, lighting, camera, blocking, performance, sound, continuity.
Use only scenes, lines and characters that are listed. If a note is a rule for the whole film, scene "all".
If a note fits nowhere, scene null. Never invent scenes or characters.
Answer with ONLY JSON: {"notes":[{"i":1,"scene":"2","line":3,"character":"MARA","category":"lighting","confidence":0.8,"why":"under 12 words"}]}"""


def script_listing(script: dict, max_chars: int = 3500) -> str:
    rows = []
    for sc in script.get("scenes") or []:
        rows.append(f"SCENE {sc.get('number')}: {sc.get('heading', '')}  (characters: {', '.join(sc.get('characters') or []) or 'none'})")
        bd = ", ".join(dict.fromkeys(T.breakdown_items(sc)))
        if bd:
            rows.append(f"  breakdown: {bd[:200]}")
        for i, e in T.scene_lines(sc):
            who = f"{e.get('character')}: " if e.get("type") in ("dialogue", "parenthetical") and e.get("character") else ""
            rows.append(f"  {i}. {who}{str(e.get('text', ''))[:110]}")
    s = "\n".join(rows)
    return s[:max_chars]


def prompt(notes: list, script: dict) -> dict:
    ns = [_norm_note(n, i) for i, n in enumerate(notes or [])]
    lines = "\n".join(f"{i + 1}. {n['text']}" for i, n in enumerate(ns))
    user = f"Screenplay \"{script.get('title', '')}\":\n{script_listing(script)}\n\nDirector's notes:\n{lines}"
    return {"system": SYSTEM, "prompt": user, "max_length": min(900, 90 + 70 * len(ns))}


def _extract(text: str):
    from ..agent.plan import extract_json
    raw = extract_json(text or "")
    if isinstance(raw, dict) and isinstance(raw.get("notes"), list):
        return raw["notes"]
    if isinstance(raw, list):
        return raw
    try:
        j = json.loads(re.sub(r"```(?:json)?|```", "", text or "").strip())
        return j if isinstance(j, list) else (j.get("notes") if isinstance(j, dict) else None)
    except Exception:  # noqa: BLE001
        return None


def _merge(r: dict, m: dict, script: dict) -> dict:
    out = dict(r)
    names = T.character_names(script)
    scene_raw = m.get("scene")
    sc = None
    if isinstance(scene_raw, (int, float)) or (isinstance(scene_raw, str) and scene_raw.strip()):
        s = str(scene_raw).strip()
        s = re.sub(r"^(sc(?:ene)?\.?\s*)", "", s, flags=re.I)
        if s.lower() in ("all", "global", "film", "every"):
            sc = "global"
        else:
            sc = T.scene_by_number(script, s) or T.scene_by_id(script, s)
    cat = str(m.get("category") or "").lower().strip()
    char = m.get("character")
    char = next((n for n in names if isinstance(char, str) and (char.upper() == n or char.lower() in T.aliases(n))), None)
    try:
        conf = max(0.0, min(1.0, float(m.get("confidence", 0.6))))
    except (TypeError, ValueError):
        conf = 0.6
    why = str(m.get("why") or "").strip()[:140]
    explicit = r["confidence"] >= 0.95
    if r["scope"] == "global" and GLOBAL_RE.search(r["text"]):
        # "in every scene", "anywhere": the note says it's for the whole film, whatever scene the model liked.
        if cat in CATEGORIES and cat not in out["categories"]:
            out["categories"] = out["categories"] + [cat]
        out["by"] = "rules+llm" if sc == "global" else "rules"
        return out
    model_scene = sc["id"] if isinstance(sc, dict) else sc
    if explicit or (r["scope"] == "scene" and r["confidence"] >= 0.75 and model_scene not in (None, r["scene_id"])):
        # Keep the rules' scene: the note named it, or the script's words pin it down. The model may still pick the line.
        if isinstance(sc, dict) and sc["id"] == r["scene_id"]:
            out["line"] = _valid_line(sc, m.get("line"), r["line"])
        if cat in CATEGORIES and cat not in out["categories"][:1]:
            out["categories"] = list(dict.fromkeys([out["category"], cat] + out["categories"]))
        out["by"] = "rules+llm" if model_scene == r["scene_id"] else "rules"
        if model_scene not in (None, r["scene_id"]):
            out["why"] += f"; the model suggested {_sc_label(script, model_scene) if model_scene != 'global' else 'the whole film'}"
        return out
    if isinstance(sc, dict):
        out.update(scope="scene", scene_id=sc["id"], line=_valid_line(sc, m.get("line"), r["line"] if r["scene_id"] == sc["id"] else None),
                   confidence=round(min(0.9, conf if r["scene_id"] != sc["id"] else max(conf, r["confidence"])), 2),
                   by="llm" if r["scene_id"] != sc["id"] else "rules+llm")
    elif sc == "global" and r["scope"] in ("unsorted", "global"):
        out.update(scope="global", scene_id=None, line=None, confidence=round(min(0.85, conf), 2), by="llm")
    elif sc is None and r["scope"] == "unsorted":
        out["by"] = "rules+llm"
    else:
        return out
    if char and out["scope"] != "global":
        out["character"] = char
    if cat in CATEGORIES:
        if categories_of(r["text"], script):
            # The note's own words name a department (look, eye -> performance): that stays first, the model's is added.
            out["categories"] = list(dict.fromkeys(r["categories"] + [cat]))
        else:
            out["category"] = cat
            out["categories"] = list(dict.fromkeys([cat] + r["categories"]))
    if why and out["by"] == "llm":
        out["why"] = why
    return out


def _valid_line(sc, line, fallback):
    try:
        li = int(line)
    except (TypeError, ValueError):
        return fallback
    ok = {i for i, _ in T.scene_lines(sc)}
    return li if li in ok else fallback


def place(notes: list, script: dict, llm_text: str | None = None) -> dict:
    script = script or {}
    ns = [_norm_note(n, i) for i, n in enumerate(notes or [])]
    rules = [rules_place(n, script) for n in ns]
    backend = "rules"
    out = rules
    if llm_text and str(llm_text).strip():
        raw = _extract(llm_text)
        if isinstance(raw, list) and raw:
            by_i = {}
            for k, m in enumerate(raw):
                if isinstance(m, dict):
                    try:
                        by_i[int(m.get("i", k + 1)) - 1] = m
                    except (TypeError, ValueError):
                        by_i[k] = m
            out = [_merge(r, by_i[i], script) if i in by_i else r for i, r in enumerate(rules)]
            backend = "llm"
        else:
            backend = "rules (llm unreadable)"
    return {"placements": out, "backend": backend}
