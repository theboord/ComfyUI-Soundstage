"""Named character voices, saved per user: <ComfyUI user dir>/soundstage/voices/<name>.json + <name>.wav.

A voice is a short reference recording (3-15 s, trimmed, 48 kHz / 24-bit) plus who it belongs to and the
consent record. Chatterbox uses the recording zero-shot (TTS and voice change); ElevenLabs makes an
Instant Voice Clone from it inside the user's own Comfy partner account.

Consent rule: only your own voice or one you have the rights to (a consenting actor, a voice you were
licensed, a designed/synthetic voice). Saving needs consent=True and an owner; loading refuses a file
without a consent record. Never ship or demo a clone of a real third party.
Pure Python + numpy; the node module passes in the user directory.
"""
import datetime
import json
import os
import re

from . import clip as C

CONSENT_TEXT = ("I confirm this is my own voice, or I have the speaker's permission / the rights to use it "
                "for this project. No clones of real third parties without their consent.")
MIN_S, MAX_S = 3.0, 15.0


class VoiceError(ValueError):
    """User-facing."""


def voice_dir(user_dir):
    d = os.path.join(user_dir, "soundstage", "voices")
    os.makedirs(d, exist_ok=True)
    return d


def safe_name(name):
    n = re.sub(r"[^A-Za-z0-9 _-]+", "", str(name or "")).strip().replace(" ", "_")
    if not n:
        raise VoiceError("Give the voice a name (letters, numbers, spaces, - and _).")
    return n[:48]


def list_voices(user_dir):
    d = voice_dir(user_dir)
    return sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))


def save_voice(user_dir, name, x, sr, *, consent, owner, character="", notes="", source="reference recording",
               settings=None):
    """Trim + normalise the reference, write <name>.wav/.json. Returns the voice dict."""
    if not consent:
        raise VoiceError("Voice not saved: tick the consent box. " + CONSENT_TEXT)
    if not str(owner or "").strip():
        raise VoiceError("Voice not saved: say whose voice this is (voice_owner), e.g. 'me' or the actor's name "
                         "with their permission.")
    n = safe_name(name)
    y = C.to_channels(C.resample(x, sr, C.SR), 1)
    y = C.trim_silence(y, C.SR)
    dur = len(y) / C.SR
    if dur < MIN_S:
        raise VoiceError(f"The reference is {dur:.1f} s of speech; give at least {MIN_S:.0f} s (5-10 s is best).")
    y = C.normalize_peak(y[: int(MAX_S * C.SR)], -3.0)
    d = voice_dir(user_dir)
    C.write_wav(os.path.join(d, n + ".wav"), y, C.SR)
    v = {"version": 1, "name": n, "character": character or n, "reference": n + ".wav",
         "duration_s": round(min(dur, MAX_S), 3), "source": source, "notes": notes,
         "consent": {"confirmed": True, "owner": str(owner).strip(), "statement": CONSENT_TEXT,
                     "date": datetime.datetime.now().isoformat(timespec="seconds")},
         "settings": dict(settings or {})}
    with open(os.path.join(d, n + ".json"), "w", encoding="utf-8") as f:
        json.dump(v, f, indent=1, ensure_ascii=False)
    v["path"] = os.path.join(d, v["reference"])
    return v


def resolve_name(user_dir, name):
    """The saved voice a name means: the exact file, else case-insensitively, else the voice saved for that character
    ("Ezra Hale" -> EZRA_HALE), else the one voice whose name or character starts with that first name
    ("Ezra" / "EZRA" -> EZRA_HALE). An ambiguous first name resolves to nothing. -> the saved name, or None."""
    n = safe_name(name)
    have = list_voices(user_dir)
    if n in have:
        return n
    up = n.upper()
    for h in have:
        if h.upper() == up:
            return h
    d = voice_dir(user_dir)

    def character(h):
        try:
            with open(os.path.join(d, h + ".json"), encoding="utf-8") as f:
                return safe_name(json.load(f).get("character") or h).upper()
        except (OSError, ValueError, VoiceError):
            return h.upper()
    chars = {h: character(h) for h in have}
    for h, c in chars.items():
        if c == up:
            return h
    # First-name fallback, for a one-word cue only ("EZRA" finds EZRA_HALE): a full name that matched no voice or
    # character above never borrows someone else's ("Ezra Reed" must not find EZRA_HALE).
    if "_" in up:
        return None
    first = up
    hits = [h for h in have if any(x == first or x.startswith(first + "_") for x in (h.upper(), chars[h]))]
    return hits[0] if len(hits) == 1 else None


def load_voice(user_dir, name):
    n = resolve_name(user_dir, name) or safe_name(name)
    d = voice_dir(user_dir)
    p = os.path.join(d, n + ".json")
    if not os.path.exists(p):
        have = ", ".join(list_voices(user_dir)) or "none yet"
        raise VoiceError(f"No saved voice '{n}'. Saved voices: {have}.")
    v = json.load(open(p, encoding="utf-8"))
    if not (v.get("consent") or {}).get("confirmed"):
        raise VoiceError(f"Voice '{n}' has no consent record; re-create it with the consent box ticked.")
    v["path"] = os.path.join(d, v["reference"])
    if not os.path.exists(v["path"]):
        raise VoiceError(f"Voice '{n}': reference file {v['reference']} is missing.")
    return v


def public(v):
    """What goes into clip meta (no absolute paths)."""
    return {"name": v["name"], "character": v.get("character"), "owner": (v.get("consent") or {}).get("owner"),
            "consent_date": (v.get("consent") or {}).get("date")}
