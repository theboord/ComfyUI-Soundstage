"""The agent's two entry points, shared by the HTTP routes, the nodes and the tests.

describe(text, genre, llm_text) -> {"scene", "plan", "notes", "backend", "designs"}
edit(scene, command, llm_text)  -> {"ops", "inverse", "scene", "notes", "backend", "summary"}

llm_text is the raw answer of the local model to prompts.build_user()/edit_user() (the browser runs the
model through ComfyUI's queue and posts the text here). Without it, or when it is unusable, the rules
backend answers alone, so both calls always return something sensible.
"""
from __future__ import annotations

from . import catalog as C
from . import location as LOC
from . import ops as O
from . import plan as P
from .build import build_scene, pending_designs
from .validate import validate_scene


def describe(text: str, genre: str = "", llm_text: str | None = None) -> dict:
    text = (text or "").strip() or "an empty stage"
    rules = P.rules_plan(text, genre)
    notes: list[str] = []
    backend = "rules"
    plan = rules
    if llm_text and llm_text.strip():
        raw = P.extract_json(llm_text)
        plan, n = P.merge_llm_plan(rules, raw)
        notes += n
        backend = "llm" if isinstance(raw, dict) else "rules (llm unreadable)"
    # Any set from the sentence: the location composer reads the place (any place, era, size) and builds it from
    # the library and real-size primitives; the presets are only what it starts from when the words name one.
    loc = LOC.compose(f"{text} {genre}".strip())
    # A preset the words name is already the plan's set (rules + model); a composed place replaces it.
    if loc["known"] and loc["source"] == "composed":
        plan = dict(plan, set=loc["key"], location=loc)
        t = text.lower()
        if loc["time"] and not P.pick(C.TIME_WORDS, t, None):
            plan["time"] = loc["time"]
        if loc["weather"] and not P.pick(C.WEATHER_WORDS, t, None):
            plan["weather"] = loc["weather"]
    scene, n = build_scene(plan, text)
    notes += n
    out_plan = {k: v for k, v in plan.items() if k != "location"}
    out_plan["set"] = scene["environment"]["set"]
    return {"scene": scene, "plan": out_plan, "notes": notes, "backend": backend, "designs": pending_designs(scene),
            "location": (scene.get("environment") or {}).get("location")}


def _llm_sym_ops(llm_text: str) -> list[dict]:
    raw = P.extract_json(llm_text)
    if isinstance(raw, dict):
        if isinstance(raw.get("ops"), list):
            return [o for o in raw["ops"] if isinstance(o, dict)]
        if raw.get("op"):
            return [raw]
    if isinstance(raw, list):
        return [o for o in raw if isinstance(o, dict)]
    return []


def edit(scene: dict, command: str, llm_text: str | None = None) -> dict:
    scene, vnotes = validate_scene(scene)
    rules_sym = O.rules_ops(command or "", scene)
    r_ops, r_notes = O.resolve(scene, rules_sym)
    chosen = (r_ops, r_notes, rules_sym, "rules")
    if llm_text and llm_text.strip():
        l_sym = _llm_sym_ops(llm_text)
        l_ops, l_notes = O.resolve(scene, l_sym)
        # Prefer the model unless it resolved less than the rules did (unknown names, bad ops), or the rules matched
        # an unambiguous pattern the model tends to flatten (mount / dismount become plain moves).
        exact = any(o.get("op") in ("mount", "dismount", "location") for o in rules_sym) and r_ops
        if exact:
            chosen = (r_ops, r_notes, rules_sym, "rules")
        elif l_ops and (len(l_notes) <= len(r_notes) or not r_ops):
            chosen = (l_ops, l_notes, l_sym, "llm")
        elif not r_ops:
            chosen = (l_ops, l_notes + ["model answer unusable"], l_sym, "llm")
        else:
            chosen = (r_ops, r_notes + [f"model ops skipped: {'; '.join(l_notes) or 'none resolved'}"], rules_sym, "rules")
    ops, notes, sym, backend = chosen
    after = O.apply_ops(scene, ops)
    return {"ops": ops, "inverse": O.inverse(ops), "scene": after, "symbolic": sym, "notes": vnotes + notes,
            "backend": backend, "summary": O.summarize(ops, scene)}
