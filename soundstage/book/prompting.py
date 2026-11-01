"""The Director's Book in the generation prompts (Milestone 23).

Imagery & Tone become style words; Pitfalls become constraints. Soundstage's samplers run at CFG 1, where a negative
prompt does nothing, so a pitfall is said positively ("avoid melodrama" -> "restrained, understated performance").

    positive_constraints(["avoid melodrama", "no shaky handheld"]) -> ["restrained, understated performance", "steady, locked-off camera"]
    prompt_words({"style": [...], "constraints": [...]})          -> "Tone: ...; restrained, understated performance."
"""
from __future__ import annotations

import re

# pitfall word -> the positive phrasing (checked in order; the first hit wins)
POSITIVE = [
    (r"melodram|over-?the-?top|hysteric", "restrained, understated performance"),
    (r"overact|mugging|hamm", "still, minimal performance"),
    (r"sentimental|schmaltz|saccharine|weepy", "dry, unsentimental tone"),
    (r"clich|generic|stock", "specific, observed details"),
    (r"cheesy|campy|camp\b|parody|spoof|pastiche", "sincere, grounded tone, played straight"),
    (r"slapstick|goofy|silly|comed", "played straight, serious tone"),
    (r"shaky|handheld|wobbl|jitter", "steady, locked-off camera"),
    (r"music video|flashy|showy|gimmick", "unhurried, classical framing"),
    (r"fast cut|choppy|frantic edit", "long, patient takes"),
    (r"glossy|commercial|advert|plastic|polished", "naturalistic, lived-in textures"),
    (r"saturat|teal|orange and teal|neon overload|garish", "natural, muted colour"),
    (r"too dark|murky|muddy|crushed black", "readable exposure, detail in the shadows"),
    (r"blown|overexpos|washed out", "protected highlights, rich colour"),
    (r"flare|lens flare", "clean, crisp lens"),
    (r"gore|gory|blood", "violence kept off screen, implied"),
    (r"horror|scary|spooky", "quiet, real-world dread"),
    (r"glamou?r|beauty shot|model", "unglamorous, natural faces"),
    (r"smil|grin", "serious, unsmiling expression"),
    (r"rush|hurried|rushed", "slow, deliberate pacing"),
    (r"static|stiff|wooden", "natural, relaxed movement"),
    (r"busy|clutter|crowd", "clean, simple frame"),
    (r"slow[- ]?mo", "real-time motion"),
    (r"cgi|cg look|video ?game|cartoon", "photographic, physically real"),
]
NEG_LEAD = re.compile(r"^\s*(avoid|no|not|never|don'?t|do not|without|stay away from|steer clear of)\s+", re.I)


def positive_constraints(pitfalls) -> list[str]:
    out = []
    for p in pitfalls or []:
        t = str(p or "").strip()
        if not t:
            continue
        hit = next((pos for pat, pos in POSITIVE if re.search(pat, t, re.I)), None)
        if hit:
            out.append(hit)
        elif not NEG_LEAD.search(t) and not re.search(r"\b(no|not|never|avoid|don'?t)\b", t, re.I):
            out.append(t)     # already positive ("keep it quiet")
        # else: a negative we can't rephrase safely is left out of the prompt (it would ask for the thing)
    return list(dict.fromkeys(out))


def _clean(s: str, n: int = 14) -> str:
    s = re.sub(r"[\r\n]+", " ", str(s or "")).strip().strip(".;,")
    w = s.split()
    return " ".join(w[:n])


def prompt_words(book) -> str:
    """The book's words for the still and motion prompts (style first, then constraints). '' when there are none."""
    if not isinstance(book, dict):
        return ""
    style = [_clean(x) for x in (book.get("style") or [])[:3] if _clean(x)]
    cons = [_clean(x, 10) for x in (book.get("constraints") or [])[:4] if _clean(x, 10)]
    cons = [c for c in cons if not re.search(r"\b(no|not|never|avoid|don'?t|without)\b", c, re.I)] + \
        [c for c in positive_constraints([c for c in cons if re.search(r"\b(no|not|never|avoid|don'?t|without)\b", c, re.I)])]
    parts = []
    if style:
        parts.append("; ".join(style))
    if cons:
        parts.append(", ".join(dict.fromkeys(cons)))
    s = ". ".join(parts)
    return (s[:400].rstrip(" ,;") + ".") if s else ""
