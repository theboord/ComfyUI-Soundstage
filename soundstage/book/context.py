"""The Director's Book as living memory: what the Director / Pitch assistants read before every command (Milestone 23).

    book_context(book, scene_id, script=None) -> {spine, statement, scene, rules, notes, decisions, prompt, text}

Mirror of web/book/model.mjs getBookContext(): same fields, same order, so the browser's context and the server's
(MCP, the Pitch agent) say the same thing. `text` is the compact form a small model's prompt can carry (<= 900 chars).
"""
from __future__ import annotations

from . import text as T

CAT_ORDER = ["subtext", "performance", "blocking", "camera", "lighting", "sound", "continuity"]


def _short(s, n=160):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def notes_for_scene(book: dict, scene_id: str | None, script: dict | None = None) -> list[dict]:
    notes = [n for n in (book or {}).get("notes") or [] if isinstance(n, dict) and n.get("source") != "chat"]
    chars = set()
    if script and scene_id:
        sc = T.scene_by_id(script, scene_id) or {}
        chars = set(sc.get("characters") or [])
        for c in T.character_names(script):
            if scene_id in T.scenes_of(script, c):
                chars.add(c)
    out = []
    for n in notes:
        if n.get("scope") == "scene" and n.get("scene_id") == scene_id:
            out.append(n)
        elif n.get("scope") == "character" and (not script or n.get("character") in chars):
            out.append(n)
    return out


def book_context(book: dict | None, scene_id: str | None = None, script: dict | None = None) -> dict:
    book = book if isinstance(book, dict) else {}
    pages = book.get("scenes") or {}
    pg = pages.get(scene_id) or {} if scene_id else {}
    rules = [str(r) for r in book.get("rules") or [] if str(r).strip()]
    rules += [n.get("text", "") for n in book.get("notes") or [] if isinstance(n, dict) and n.get("scope") == "global"]
    notes = notes_for_scene(book, scene_id, script)
    notes = sorted(notes, key=lambda n: CAT_ORDER.index(n.get("category")) if n.get("category") in CAT_ORDER else 99)
    decisions = [n for n in book.get("notes") or [] if isinstance(n, dict) and n.get("source") == "chat"][-5:]
    scene = {k: pg.get(k) for k in ("synopsis", "times", "imagery", "core", "subtext", "lighting", "pitfalls", "constraints", "performance")
             if pg.get(k)}
    style = [s for s in [pg.get("imagery"), *(book.get("style") or [])] if s]
    constraints = list(dict.fromkeys([*(pg.get("constraints") or []), *(book.get("constraints") or [])]))
    lines = []
    if book.get("spine"):
        lines.append(f"Spine: {_short(book['spine'], 120)}")
    if book.get("statement"):
        lines.append(f"Approach: {_short(book['statement'], 120)}")
    if pg.get("core"):
        lines.append(f"This scene's core: {_short(pg['core'], 120)}")
    if pg.get("subtext"):
        lines.append(f"Subtext: {_short(pg['subtext'], 120)}")
    if pg.get("imagery"):
        lines.append(f"Imagery & tone: {_short(pg['imagery'], 100)}")
    if constraints:
        lines.append("Keep it: " + "; ".join(_short(c, 60) for c in constraints[:4]))
    for r in rules[:4]:
        lines.append(f"Rule: {_short(r, 100)}")
    for n in notes[:6]:
        who = f" ({n['character'].title()})" if n.get("character") else ""
        lines.append(f"Note [{n.get('category', 'note')}]{who}: {_short(n.get('text'), 100)}")
    for d in decisions[-2:]:
        lines.append(f"Decided earlier: {_short(d.get('text'), 90)}")
    text = "\n".join(lines)
    if len(text) > 900:
        text = text[:899].rstrip() + "…"
    return {"title": book.get("title", ""), "spine": book.get("spine", ""), "statement": book.get("statement", ""),
            "scene_id": scene_id, "scene": scene, "rules": rules, "notes": notes, "decisions": decisions,
            "prompt": {"style": style[:3], "constraints": constraints[:4]}, "text": text}
