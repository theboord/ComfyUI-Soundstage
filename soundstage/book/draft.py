"""The local model drafts a scene's prose pages of the Director's Book, grounded in the script (Milestone 23).

    prompt(script, scene_id, stage_facts) -> {system, prompt, max_length}
    parse(llm_text, script, scene_id)     -> {sections, grounding: {dropped, flags, ok}, backend}
    spine_prompt(script) / parse_spine(llm_text, script) -> the film's one-line spine and the director's statement

The template follows the directors' binders (share/Research_Directors_Binders/REPORT.txt): Coppola's per-scene cover
sheet (Synopsis / The Times / Imagery & Tone / The Core / Pitfalls) plus subtext, lighting, performance per character
and Hitchcock-style sound notes (what we hear, and why, silence included).

Grounding: the model may interpret (that's the director's job) but must not invent plot. Every prose sentence is
checked against the script: a sentence naming a person, place or thing in capitals the script never mentions is
dropped and reported, performance notes for characters not in the scene are dropped, and a sentence that says
something happens that the scene doesn't contain ("later", "flashback", "dies") is flagged for the director.
"""
from __future__ import annotations

import re

from . import text as T
from .prompting import positive_constraints

SYSTEM = """You are a film director's first assistant writing one scene's page of the director's book.
Write ONLY from the scene text you are given. Never invent characters, names, places, events or backstory.
Interpret like a director (what it is really about, how to play it, how to shoot and light it) but describe
only what the script contains. Short, concrete sentences. Answer with ONLY one JSON object, no markdown:
{"synopsis": "what literally happens, 1 sentence",
 "times": "time of day, place and world the scene must show, 1 sentence",
 "imagery": "imagery and tone: visual and emotional texture, 1-2 sentences",
 "references": ["a real film or painting - what to take from it", "up to 3"],
 "core": "the scene's single feeling or goal, 1 sentence",
 "subtext": "what is unsaid between the lines, 1-2 sentences",
 "pitfalls": ["what to avoid, up to 3 short items"],
 "constraints": ["the same pitfalls said positively, as prompt words, e.g. restrained, understated performance"],
 "lighting": "key and fill, motivation, colour, from the time of day, 1-2 sentences",
 "performance": {"CHARACTER NAME": "what we need from them in this scene, 1 sentence"},
 "sound": [{"hear": "what we hear", "why": "why"}]}"""

SPINE_SYSTEM = """You are a film director's first assistant. Read the screenplay summary and answer with ONLY JSON:
{"spine": "the film's spine in Kazan's sense: one line, the core action, under 14 words",
 "statement": "the director's statement: tone and visual approach for the whole film, 2 sentences"}
Use only what the screenplay contains. Never invent characters or events."""

PROSE = ("synopsis", "times", "imagery", "core", "subtext", "lighting")
LISTS = ("references", "pitfalls", "constraints")
# Words that assert plot the scene may not contain: flagged, not dropped (the director decides).
PLOT_WORDS = re.compile(r"\b(later|flashback|years ago|dies|died|killed|murder(?:ed)?|kiss(?:es)?|wedding|betray(?:s|ed)?|"
                        r"revenge|prison|daughter|son|wife|husband|brother|sister|steal(?:s|ing)?|stole|stolen|rob(?:s|bed)?)\b", re.I)
# Proper nouns that are fine in prose without being in the script (craft words, days, colours as names...).
ALLOW = {"i", "it", "the", "a", "an", "we", "she", "he", "they", "her", "his", "their", "our", "this", "that", "keep", "play",
         "let", "light", "shoot", "frame", "hold", "open", "close", "start", "end", "use", "avoid", "no", "not", "warm", "cool",
         "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "god", "american", "west", "western",
         "pacific", "kodak", "arri", "dusk", "night", "sunset", "steadicam", "technicolor", "ltx", "int", "ext", "v.o", "o.s",
         "cu", "ecu", "ws", "ms", "pov", "imax", "imax", "foley", "sfx", "vfx", "dp", "mm"}


def _scene_block(sc: dict) -> str:
    rows = [f"SCENE {sc.get('number')}: {sc.get('heading', '')}"]
    for i, e in T.scene_lines(sc):
        who = f"{e.get('character')}: " if e.get("type") in ("dialogue", "parenthetical") and e.get("character") else ""
        rows.append(f"{who}{e.get('text', '')}")
    return "\n".join(rows)


def _neighbours(script: dict, sc: dict) -> str:
    scs = script.get("scenes") or []
    i = next((k for k, s in enumerate(scs) if s.get("id") == sc.get("id")), -1)
    out = []
    if i > 0:
        p = scs[i - 1]
        out.append(f"Scene before: {p.get('number')} {p.get('heading')} - {p.get('synopsis') or p.get('outline', '')[:120]}")
    if 0 <= i < len(scs) - 1:
        n = scs[i + 1]
        out.append(f"Scene after: {n.get('number')} {n.get('heading')} - {n.get('synopsis') or n.get('outline', '')[:120]}")
    return "\n".join(out)


def stage_facts_text(f: dict | None) -> str:
    f = f or {}
    bits = []
    if f.get("set"):
        bits.append(f"set {f['set']}")
    if f.get("time"):
        bits.append(f"light {f['time']}")
    if f.get("weather") and f["weather"] != "none":
        bits.append(f"weather {f['weather']}")
    if f.get("shots"):
        bits.append("shots: " + "; ".join(str(s)[:60] for s in f["shots"][:6]))
    if f.get("look"):
        bits.append(f"look: {str(f['look'])[:120]}")
    return ("Stage: " + ", ".join(bits)) if bits else ""


def prompt(script: dict, scene_id: str, stage_facts: dict | None = None) -> dict:
    sc = T.scene_by_id(script, scene_id) or {}
    chars = ", ".join(sc.get("characters") or []) or "none"
    bd = ", ".join(dict.fromkeys(T.breakdown_items(sc)))
    user = "\n".join(x for x in [
        f"Film: \"{script.get('title', '')}\"",
        _neighbours(script, sc),
        _scene_block(sc),
        f"Characters in this scene: {chars}",
        bd and f"Breakdown: {bd}",
        stage_facts_text(stage_facts),
    ] if x)
    return {"system": SYSTEM, "prompt": user, "max_length": 720}


def _extract(text):
    from ..agent.plan import extract_json
    raw = extract_json(text or "")
    return raw if isinstance(raw, dict) else None


def _sentences(t: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?;])\s+", str(t or "").strip()) if s.strip()]


def _foreign_names(sentence: str, vocab: set[str]) -> list[str]:
    """Capitalised words mid-sentence (or ALL-CAPS anywhere) that the script never uses."""
    out = []
    toks = re.findall(r"[A-Za-z][A-Za-z'’\-]*", sentence)
    for k, w in enumerate(toks):
        lw = w.lower().replace("’", "'")
        base = lw[:-2] if lw.endswith("'s") else lw
        capital = w[0].isupper() and (k > 0 or (len(w) > 1 and w.isupper()))
        if not capital or base in ALLOW or base in vocab or T.stem(base) in vocab or len(base) < 3:
            continue
        out.append(w)
    return out


def _clean_prose(field: str, value, vocab, report) -> str:
    keep = []
    for s in _sentences(value if isinstance(value, str) else ""):
        bad = _foreign_names(s, vocab)
        if bad:
            report["dropped"].append({"field": field, "sentence": s, "why": f"names {', '.join(bad)}, not in the script"})
            continue
        m = PLOT_WORDS.search(s)
        if m and m.group(0).lower() not in vocab:
            report["flags"].append({"field": field, "sentence": s, "why": f"“{m.group(0)}” is not in the scene: check it's interpretation, not plot"})
        keep.append(s)
    return " ".join(keep)[:600]


def parse(llm_text: str | None, script: dict, scene_id: str) -> dict:
    sc = T.scene_by_id(script, scene_id) or {}
    report = {"dropped": [], "flags": [], "ok": True}
    raw = _extract(llm_text) if llm_text else None
    if not raw:
        return {"sections": {}, "grounding": {**report, "ok": False}, "backend": "rules (llm unreadable)" if llm_text else "rules"}
    vocab = T.script_vocab(script)
    out: dict = {}
    for f in PROSE:
        if raw.get(f):
            v = _clean_prose(f, raw[f], vocab, report)
            if v:
                out[f] = v
    for f in LISTS:
        items = raw.get(f)
        if isinstance(items, str):
            items = [items]
        if not isinstance(items, list):
            continue
        vals = []
        for it in items[:3]:
            s = str(it.get("text") if isinstance(it, dict) else it).strip()
            if not s:
                continue
            if f != "references":       # references name films and painters on purpose
                if _foreign_names(s, vocab):
                    report["dropped"].append({"field": f, "sentence": s, "why": "names something not in the script"})
                    continue
            vals.append(s[:160])
        if vals:
            out[f] = vals
    if out.get("pitfalls") and not out.get("constraints"):
        out["constraints"] = positive_constraints(out["pitfalls"])
    # Performance: only the scene's characters (matched by name or alias).
    perf = raw.get("performance") if isinstance(raw.get("performance"), dict) else {}
    names = list(sc.get("characters") or [])
    pout = {}
    for k, v in perf.items():
        who = next((n for n in names if str(k).upper() == n or str(k).lower() in T.aliases(n)), None)
        if not who:
            report["dropped"].append({"field": "performance", "sentence": f"{k}: {v}", "why": f"{k} is not in this scene"})
            continue
        t = _clean_prose("performance", v, vocab, report)
        if t:
            pout[who] = t
    if pout:
        out["performance"] = pout
    snd = raw.get("sound")
    if isinstance(snd, str):
        snd = [{"hear": snd, "why": ""}]
    if isinstance(snd, list):
        rows = []
        for it in snd[:5]:
            if isinstance(it, dict):
                hear, why = str(it.get("hear", "")).strip(), str(it.get("why", "")).strip()
            else:
                hear, why = str(it).strip(), ""
            if hear and not _foreign_names(hear, vocab):
                rows.append({"hear": hear[:160], "why": why[:160]})
        if rows:
            out["sound"] = rows
    report["ok"] = not report["dropped"]
    return {"sections": out, "grounding": report, "backend": "llm"}


def spine_prompt(script: dict) -> dict:
    rows = [f"Title: {script.get('title', '')}"]
    for sc in script.get("scenes") or []:
        rows.append(f"{sc.get('number')}. {sc.get('heading')}: {sc.get('synopsis') or sc.get('outline', '')[:160]}")
    return {"system": SPINE_SYSTEM, "prompt": "\n".join(rows), "max_length": 160}


def parse_spine(llm_text: str | None, script: dict) -> dict:
    raw = _extract(llm_text) if llm_text else None
    report = {"dropped": [], "flags": [], "ok": True}
    if not raw:
        return {"spine": "", "statement": "", "grounding": {**report, "ok": False}}
    vocab = T.script_vocab(script)
    spine = _clean_prose("spine", str(raw.get("spine", "")), vocab, report)[:140]
    statement = _clean_prose("statement", str(raw.get("statement", "")), vocab, report)
    report["ok"] = not report["dropped"]
    return {"spine": spine, "statement": statement, "grounding": report}
