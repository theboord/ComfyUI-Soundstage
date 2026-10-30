"""Prompt hygiene for generated sound. Pure Python.

Two field rules from real jobs:
- Words that name an animal or a voice summon one, even as a metaphor ("the engine barks",
  "the motor coughs" gave a real dog). Swap them for mechanical words and say what must not be there.
- One sound event per generation. "Stalls, then cranks, then stalls" collapses into one event;
  generate the pieces and place them on the timeline.
"""
import re

# word -> safer wording. The left side matches whole words, case-insensitive, with simple inflections.
LEAK_WORDS = {
    "bark": "sharp snap", "barks": "snaps", "barking": "snapping",
    "cough": "sputter", "coughs": "sputters", "coughing": "sputtering",
    "growl": "low rumble", "growls": "rumbles", "growling": "rumbling",
    "howl": "high whine", "howls": "whines", "howling": "whining",
    "purr": "smooth idle", "purrs": "idles smoothly", "purring": "idling smoothly",
    "roar": "loud rumble", "roars": "rumbles loudly", "roaring": "rumbling loudly",
    "scream": "high screech", "screams": "screeches", "screaming": "screeching",
    "squeal": "high squeak", "squeals": "squeaks", "squealing": "squeaking",
    "snarl": "harsh rasp", "snarls": "rasps", "hiss": "air hiss",
    "moan": "low groan of metal", "moans": "groans", "sigh": "soft exhale of air", "sighs": "exhales",
    "whimper": "faint whine", "chirp": "short high tick", "chirps": "ticks",
    "breath": "air rush", "breathing": "air rushing",
}
ANIMAL_OR_VOICE = {"dog", "dogs", "cat", "cats", "bird", "birds", "voice", "voices", "talking", "speech",
                   "people", "person", "man", "woman", "crowd", "singing", "laugh", "laughter"}
SFX_GUARD = "No animals, no voices, no music."
SEQUENCE_WORDS = re.compile(r"\b(then|after that|followed by|and then|before|while|again)\b", re.I)


def _sub_word(text, word, repl):
    def keep_case(m):
        s = m.group(0)
        return repl[:1].upper() + repl[1:] if s[:1].isupper() else repl
    return re.sub(rf"\b{re.escape(word)}\b", keep_case, text, flags=re.I)


def sfx_prompt(text, guard=True, allow=()):
    """(cleaned prompt, warnings). allow: words the user really wants (e.g. a scene with a real dog)."""
    allow = {a.lower() for a in allow}
    out, warnings = (text or "").strip(), []
    for word, repl in LEAK_WORDS.items():
        if word in allow:
            continue
        if re.search(rf"\b{re.escape(word)}\b", out, re.I):
            out = _sub_word(out, word, repl)
            warnings.append(f"'{word}' can summon an animal or a voice; changed to '{repl}'.")
    named = sorted({w for w in re.findall(r"[a-z]+", out.lower()) if w in ANIMAL_OR_VOICE} - allow)
    if named:
        warnings.append("The prompt names " + ", ".join(named) + ": the generator will add them. Remove "
                        "them, or list them in allow_words if you want them.")
    if SEQUENCE_WORDS.search(out) or out.count(",") >= 3:
        warnings.append("This reads like several sound events. Generate one event per clip and place the "
                        "clips on the FX tracks; multi-beat prompts collapse into one sound.")
    if guard and SFX_GUARD.lower() not in out.lower() and not named:
        out = f"{out.rstrip('.')}. {SFX_GUARD}"
    return out, warnings


def music_brief(genre="", mood="", tempo_bpm=0, length_s=0.0, instruments="", notes="", vocals=False):
    """A one-paragraph cue brief that text-to-music models follow."""
    parts = []
    head = " ".join(p for p in (mood.strip(), genre.strip()) if p) or "cinematic"
    parts.append(f"{head} film score cue")
    if instruments.strip():
        parts.append(f"featuring {instruments.strip()}")
    if tempo_bpm:
        parts.append(f"{int(tempo_bpm)} BPM")
    if length_s:
        parts.append(f"about {round(float(length_s))} seconds long, with a clear start and a clean ending")
    text = ", ".join(parts) + "."
    if not vocals:
        text += " Instrumental only, no vocals, no singing."
    if notes.strip():
        text += " " + notes.strip().rstrip(".") + "."
    return text


def dialogue_text(text):
    """Strip stage directions in (parentheses) and collapse whitespace. Keeps [laugh]-style tags."""
    t = re.sub(r"\([^)]*\)", " ", text or "")
    return re.sub(r"\s+", " ", t).strip()


def words(text):
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def word_error_rate(ref, hyp):
    """Levenshtein over words / len(ref). 0 = perfect."""
    r, h = words(ref), words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(h, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
            prev, d[j] = d[j], cur
    return round(d[len(h)] / len(r), 3)
