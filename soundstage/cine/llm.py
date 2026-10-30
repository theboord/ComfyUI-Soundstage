"""Optional LLM composer. The rules backend is the default and the fallback for every failure.

Two ways in:
  * Ollama on the pod (HTTP, stdlib only): advise_llm(..., backend="ollama").
  * Core ComfyUI TextGenerate: build_brief() gives the system + user prompt for a
    TextGenerate node (e.g. qwen3.5_4b_bf16); its generated_text goes back into the Advisor as
    `llm_draft`, which parse_draft() repairs and validates.

Either way the LLM only chooses and orders shot templates and writes the why. Geometry, frame
counts, coverage checks and prompt wording stay deterministic (research/08 §7.2).
"""
from __future__ import annotations

import difflib
import json
import re
import urllib.error
import urllib.request

from . import schema
from .advisor import assemble, plan, realize, trim_templates
from .geometry import use_aspect

TEMPLATE_KEYS = ["purpose", "subject", "size", "framing", "angle", "horizontal", "height", "lens_mm_ff", "movement",
                 "speed", "duration_s", "lighting", "composition"]
SYNONYMS = {
    "push_in": "dolly_in", "push": "dolly_in", "dolly": "dolly_in", "pull_out": "dolly_out", "pull_back": "dolly_out",
    "pan": "pan_left", "track": "track_follow", "tracking": "track_follow", "follow": "track_follow",
    "orbit": "arc_left", "arc": "arc_left", "crane": "crane_up", "jib_up": "crane_up", "jib_down": "crane_down",
    "zoom": "zoom_in", "steadicam": "steadicam_follow", "locked": "static", "locked_off": "static", "none": "static",
    "medium": "MS", "medium_shot": "MS", "close_up": "CU", "closeup": "CU", "extreme_close_up": "ECU", "wide": "WS",
    "wide_shot": "WS", "extreme_wide": "EWS", "full": "FS", "full_shot": "FS", "medium_close_up": "MCU",
    "cowboy_shot": "COWBOY", "american": "COWBOY", "eye_level": "eye", "low_angle": "low", "high_angle": "high",
    "over_the_shoulder": "ots", "two-shot": "two_shot", "twoshot": "two_shot", "5050": "fifty_fifty",
    "three_quarter": "three_quarter_front", "side": "profile",
}
ENUMS = {"size": schema.SIZES, "framing": schema.FRAMINGS, "subject": schema.SUBJECTS, "angle": schema.ANGLES,
         "horizontal": schema.HORIZONTALS, "height": schema.HEIGHTS, "movement": schema.MOVEMENTS, "speed": schema.SPEEDS}


def _coerce(field: str, value):
    allowed = ENUMS[field]
    if value in allowed:
        return value
    key = re.sub(r"[\s\-]+", "_", str(value).strip()).lower()
    key = SYNONYMS.get(key, key)
    for a in allowed:
        if a.lower() == key.lower():
            return a
    close = difflib.get_close_matches(key, [a.lower() for a in allowed], n=1, cutoff=0.6)
    return next((a for a in allowed if a.lower() == close[0]), None) if close else None


def build_brief(p: dict, max_shots: int = 0) -> tuple[str, str]:
    """System + user prompt for an LLM composer, built from the rules plan."""
    kb = p["kb"]
    ids = [p["source"]["id"]] + [e["id"] for e in p["resolved"]["entries"].values() if e]
    ctx = []
    for eid in dict.fromkeys(ids):
        e = kb.by_id[eid]
        # compact on purpose: small local models (4B) slow down sharply with long contexts
        ctx.append({"id": e["id"], "name": e["name"], "summary": e["summary"],
                    "rules": [f"{r['then']} ({r['why']})" for r in e.get("rules", [])[:3]]})
    system = (
        "You are a feature-film director and editor planning coverage. Return ONLY a JSON object "
        '{"shots": [...], "notes": [...]} - no prose outside JSON. Each shot: purpose (what it does in THIS scene), '
        f"subject {schema.SUBJECTS}, size {schema.SIZES}, framing {schema.FRAMINGS}, angle {schema.ANGLES}, "
        f"horizontal {schema.HORIZONTALS}, height {schema.HEIGHTS}, lens_mm_ff (number), movement (exactly one of "
        f"{schema.MOVEMENTS}), speed {schema.SPEEDS}, duration_s (number), lighting, composition, "
        "why (2-3 sentences: the mechanism on the viewer, specific to this scene), kb_refs (ids from the knowledge "
        "provided). Rules: establish geography before close-ups; keep every camera on one side of the line between "
        "A and B; consecutive shots of one subject change angle 30+ degrees or size a step; one camera move per shot."
    )
    user = json.dumps({
        "scene": p["scene_text"], "beat": p["beat"], "intents": p["intents"],
        "cast": [{"id": c["id"], "description": c["description"], "posture": c["posture"]} for c in p["cast"]],
        "location": p["location"], "max_shots": max_shots or len(p["recipe"]["shots"]),
        "knowledge": ctx,
        "rules_draft": {"recipe": p["recipe"]["name"], "why": p["recipe"]["why"],
                        "shots": [{k: t[k] for k in TEMPLATE_KEYS if k in t} for t in p["recipe"]["shots"]]},
        "task": "Adapt or replace the rules draft so it serves this exact scene. Cite kb ids.",
    }, ensure_ascii=False)
    return system, user


def _extract_json(text: str):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start < 0:
        raise ValueError("no JSON in the LLM reply")
    obj, _ = json.JSONDecoder().raw_decode(text[start:])
    return obj


def parse_draft(text: str, kb_ids: set[str]) -> tuple[list[dict], list[str], list[list[str]], list[str]]:
    """LLM JSON -> (templates, whys, kb_refs per shot, notes). Raises ValueError if nothing usable."""
    obj = _extract_json(text)
    shots = obj.get("shots", obj) if isinstance(obj, dict) else obj
    if not isinstance(shots, list):
        raise ValueError("LLM reply has no shot list")
    templates, whys, refs, notes = [], [], [], []
    for i, s in enumerate(shots):
        if not isinstance(s, dict):
            continue
        t = {"purpose": str(s.get("purpose", f"shot {i + 1}"))[:300]}
        for field in ENUMS:
            if field in s:
                v = _coerce(field, s[field])
                if v is None:
                    notes.append(f"shot {i + 1}: dropped unknown {field} '{s[field]}'")
                else:
                    t[field] = v
        if "size" not in t:
            notes.append(f"shot {i + 1}: no usable size, skipped")
            continue
        t.setdefault("subject", "A")
        for num, lo, hi in (("lens_mm_ff", 12, 400), ("duration_s", 0.5, 30)):
            try:
                t[num] = min(hi, max(lo, float(s[num])))
            except (KeyError, TypeError, ValueError):
                pass
        for k in ("lighting", "composition"):
            if isinstance(s.get(k), str):
                t[k] = s[k][:200]
        errs = schema.validate(t, {"$ref": "#/$defs/shot_template", **{"$defs": schema.KB_ENTRY_SCHEMA["$defs"]}})
        if errs:
            notes.append(f"shot {i + 1}: {errs[0]}")
            continue
        templates.append(t)
        whys.append(str(s.get("why", ""))[:900] if len(str(s.get("why", ""))) >= 20 else "")
        refs.append([r for r in s.get("kb_refs", []) if r in kb_ids])
    if not templates:
        raise ValueError("LLM reply had no valid shots: " + "; ".join(notes[:3]))
    return templates, whys, refs, notes + [str(n) for n in obj.get("notes", [])][:5] if isinstance(obj, dict) else notes


def ollama_generate(system: str, prompt: str, model: str, url: str = "http://127.0.0.1:11434",
                    timeout: float = 90.0) -> str:
    if model.lower().startswith("qwen3"):
        prompt += " /no_think"   # Qwen3's soft switch; some Ollama builds ignore "think": false
    body = json.dumps({"model": model, "system": system, "prompt": prompt, "format": "json", "stream": False,
                       "think": False, "options": {"temperature": 0.4, "num_ctx": 8192, "num_predict": 2500}}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())["response"]


def advise_llm(scene_text: str, beat: str = "", picks: dict | None = None, characters: str = "", max_shots: int = 0,
               fps: float = 24.0, stage_scene: dict | None = None, backend: str = "ollama", llm_draft: str = "",
               model: str = "qwen3:4b", url: str = "http://127.0.0.1:11434", timeout: float = 90.0,
               kb=None) -> dict:
    """LLM-composed shot list; falls back to the rules recipe on any failure and says why in notes."""
    p = plan(scene_text, beat, picks, characters, stage_scene, kb)
    notes = []
    try:
        if backend == "llm_draft":
            text = llm_draft
        else:
            system, user = build_brief(p, max_shots)
            text = ollama_generate(system, user, model, url, timeout)
        templates, whys, refs, parse_notes = parse_draft(text, set(p["kb"].by_id))
        if max_shots:
            templates, whys, refs = templates[:max_shots], whys[:max_shots], refs[:max_shots]
        with use_aspect(((stage_scene or {}).get("shot") or {}).get("aspect")):
            shots = realize(p, templates, fps, whys=whys)
        for s, r in zip(shots, refs):
            s["rationale"]["kb_refs"] = list(dict.fromkeys(r + s["rationale"]["kb_refs"]))
        notes = [f"Composed by {backend}{' (' + model + ')' if backend == 'ollama' else ''}; geometry, frames and "
                 f"prompts recomputed by rules."] + parse_notes
        used = backend
    except (ValueError, KeyError, TypeError, OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        templates = trim_templates(p["recipe"]["shots"], max_shots)
        with use_aspect(((stage_scene or {}).get("shot") or {}).get("aspect")):
            shots = realize(p, templates, fps)
        notes = [f"LLM path failed ({type(exc).__name__}: {str(exc)[:160]}); used the rules recipe instead."]
        used = "rules"
    notes.append(f"Recipe context: '{p['recipe']['name']}' from {p['source']['id']}.")
    return assemble(p, shots, used, notes)
