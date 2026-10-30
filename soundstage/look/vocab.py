"""The LOOK vocabulary, read from web/look/vocab.mjs so the browser panel and the node never disagree.

Also: the look JSON's defaults and normaliser, and `look_from_text` ("Korean thriller, anamorphic,
teal-orange" -> a look dict) for typing a look instead of clicking it.
"""
from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path

VOCAB_PATH = Path(__file__).resolve().parents[2] / "web" / "look" / "vocab.mjs"
MARKER = "export const VOCAB ="

# look JSON field -> vocab list. Order = how the UI and the text parser walk them.
FIELDS = {
    "camera_body": "camera_bodies",
    "lens": "lenses",
    "aperture": "apertures",
    "film_stock": "film_stocks",
    "genre": "genres",
    "movement": "movements",
    "era": "eras",
    "technique": "techniques",
    "mood": "moods",
    "energy": "energies",
}

DEFAULT_LOOK = {
    "version": 1,
    "camera_body": "auto",
    "lens": "auto",
    "aperture": "auto",
    "film_stock": "auto",
    "palette": {"preset": "auto", "name": "", "swatches": []},
    "genre": "general",
    "subgenre": "",
    "movement": "auto",
    "era": "auto",
    "technique": "auto",
    "mood": "auto",
    "mood_intensity": 0.5,
    "energy": "auto",
    "grade": {"contrast": 0.0, "saturation": 0.0, "warmth": 0.0, "grain": 0.0, "halation": 0.0, "vignette": 0.0},
    "description": "",
    "negative": "",
    # Restyle brief (after 3D Jutsu's final-render brief): optional free text per aspect of the target look.
    "brief": {"world": "", "atmosphere": "", "surfaces": "", "furniture": "", "colour": "", "light": "", "outside": ""},
}

BRIEF_FIELDS = ("world", "atmosphere", "surfaces", "furniture", "colour", "light", "outside")


@lru_cache(maxsize=1)
def load_vocab() -> dict:
    text = VOCAB_PATH.read_text(encoding="utf-8")
    i = text.index(MARKER) + len(MARKER)
    vocab, _ = json.JSONDecoder().raw_decode(text[i:].lstrip())
    return vocab


def options(field: str) -> list[dict]:
    """Options of a look field ('lens', 'genre', ...). 'subgenre' = every genre's subgenres."""
    v = load_vocab()
    if field == "subgenre":
        return [s for g in v["genres"] for s in g.get("subgenres", [])]
    if field == "palette":
        return v["palettes"]
    return v[FIELDS[field]]


def option(field: str, oid: str | None) -> dict | None:
    if not oid:
        return None
    for o in options(field):
        if o["id"] == oid:
            return o
    return None


def genre_of_subgenre(sid: str) -> str | None:
    for g in load_vocab()["genres"]:
        if any(s["id"] == sid for s in g.get("subgenres", [])):
            return g["id"]
    return None


def _num(x, lo, hi, default=0.0) -> float:
    try:
        return max(lo, min(hi, float(x)))
    except (TypeError, ValueError):
        return default


def normalize_look(look: dict | None) -> tuple[dict, list[str]]:
    """Fill defaults, drop unknown ids (with a note), clamp numbers. Never raises on user data."""
    out = copy.deepcopy(DEFAULT_LOOK)
    notes: list[str] = []
    look = look if isinstance(look, dict) else {}
    for field in FIELDS:
        val = look.get(field)
        if val in (None, ""):
            continue
        if option(field, str(val)):
            out[field] = str(val)
        else:
            notes.append(f"unknown {field} '{val}' ignored")
    sub = look.get("subgenre") or ""
    if sub:
        parent = genre_of_subgenre(sub)
        if parent:
            out["subgenre"] = sub
            if out["genre"] in ("general", parent) or not look.get("genre"):
                out["genre"] = parent
            elif out["genre"] != parent:
                notes.append(f"subgenre '{sub}' belongs to {parent}; genre set to {parent}")
                out["genre"] = parent
        else:
            notes.append(f"unknown subgenre '{sub}' ignored")
    pal = look.get("palette")
    if isinstance(pal, str):
        pal = {"preset": pal}
    if isinstance(pal, dict):
        from .colors import is_hex
        preset = str(pal.get("preset") or "auto")
        sw = [s if s.startswith("#") else "#" + s for s in pal.get("swatches") or [] if isinstance(s, str) and is_hex(s)]
        if preset != "custom" and not option("palette", preset):
            notes.append(f"unknown palette '{preset}' ignored")
            preset = "custom" if sw else "auto"
        if preset not in ("custom", "auto") and not sw:
            sw = list(option("palette", preset)["swatches"])
        out["palette"] = {"preset": preset, "name": str(pal.get("name") or ""), "swatches": sw[:12]}
    out["mood_intensity"] = _num(look.get("mood_intensity", 0.5), 0.0, 1.0, 0.5)
    spec = load_vocab()["grade"]
    for k, v in (look.get("grade") or {}).items():
        if k in spec:
            out["grade"][k] = _num(v, spec[k]["min"], spec[k]["max"])
    brief = look.get("brief") if isinstance(look.get("brief"), dict) else {}
    out["brief"] = {k: re.sub(r"\s+", " ", str(brief.get(k) or "")).strip()[:400] for k in BRIEF_FIELDS}
    out["description"] = str(look.get("description") or "").strip()
    out["negative"] = str(look.get("negative") or "").strip()
    return out, notes


# ---- free text -> look ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    """Lower-case, hyphens to spaces; commas/semicolons survive as their own tokens (clause breaks)."""
    s = re.sub(r"([,;])", r" \1 ", s.lower().replace("-", " "))
    return re.sub(r"[^a-z0-9/&.,;]+", " ", s).strip()


@lru_cache(maxsize=1)
def _phrase_index() -> list[tuple[str, str, str]]:
    """(normalised phrase, field, option id), longest phrases first so 'vintage anamorphic' beats 'anamorphic'."""
    idx: list[tuple[str, str, str]] = []
    fields = list(FIELDS) + ["subgenre", "palette"]
    # Movement/national cinema before genre: "Korean thriller" is a cinema, not just "thriller".
    fields.sort(key=lambda f: {"movement": 0, "subgenre": 1}.get(f, 2))
    for field in fields:
        for o in options(field):
            if o["id"] in ("auto", "general"):
                continue
            # Energy labels ("Still", "Calm") are everyday words: match only their "... tempo" aliases.
            labels = [] if field == "energy" else [o["label"]]
            for phrase in [*labels, *o.get("aliases", [])]:
                p = _norm(phrase)
                if len(p) >= 2:
                    idx.append((p, field, o["id"]))
    idx.sort(key=lambda t: -len(t[0]))
    return idx


def look_from_text(text: str) -> tuple[dict, list[str]]:
    """Match vocabulary phrases in free text. Unmatched words become the scene description."""
    work = f" {_norm(text)} "
    look: dict = {}
    matched: list[str] = []
    # Longest phrase first; on equal length the one that appears earlier in the text wins.
    hits = sorted(((p, f, o) for p, f, o in _phrase_index() if f" {p} " in work),
                  key=lambda h: (-len(h[0]), work.index(f" {h[0]} ")))
    for phrase, field, oid in hits:
        key = "palette" if field == "palette" else field
        pat = f" {phrase} "
        if key in look or pat not in work:
            continue
        look[key] = {"preset": oid} if field == "palette" else oid
        matched.append(f"{phrase} -> {field}:{oid}")
        work = work.replace(pat, " | ", 1)
    rest = [re.sub(r"\s+", " ", w).strip(" .") for w in re.split(r"[|,;]", work)]
    rest = [w for w in rest if w and w not in ("and", "with", "a", "an", "the", "look", "style", "film")]
    if rest:
        look["description"] = ", ".join(rest)
    return look, matched


def parse_look_input(value: str) -> tuple[dict, list[str]]:
    """The node's `look` input: look JSON from the panel, or a typed look description."""
    value = (value or "").strip()
    if not value:
        return {}, []
    if value.startswith("{"):
        try:
            data = json.loads(value)
            if isinstance(data, dict):
                return data, []
        except json.JSONDecodeError:
            pass
    look, matched = look_from_text(value)
    return look, [f"typed look: {m}" for m in matched]
