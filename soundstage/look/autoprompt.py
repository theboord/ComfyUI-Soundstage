"""④ Frame's Auto prompt: a local vision LLM looks at frame 1 of the stage and the cast pictures, and writes the words
of the frame prompt. Mike, 2026-11-09: "Can the LLM that we have in there, Qwen, design a prompt by looking and
understanding what needs to go in it with the character you add and everything?"

What the LLM writes, and what it does not (v2, 2026-11-09). The stage's facts are not the LLM's to write: an Auto
prompt is the COMPILED prompt (compile_look with `add`, the same stage words) plus the LLM's own words on top. On the
demo chase the v1 Auto prompt (the LLM wrote the setting) lost "in a city street", the deserted street and both cars'
paint and body words, and Krea 2 painted an open lot with grass and a grey classic car. Now:
  - the place and set type, set dressing and props in frame, each person's and vehicle's description, the people and
    vehicle count, the time of day and the weather come from the stage (scene.frame1_facts, identity.py);
  - the LLM adds only light, mood, texture and photographic feel (clean_add drops a clause naming a person, a name, a
    vehicle or animal, a kind of place the stage is not, a time of day or weather it lacks, a placement, a later beat,
    or a quality tag), plus each person's looks (age, hair, build: clean_looks, no noun, so each person is named once);
  - every variant is validated (required_facts / validate): a missing stage fact is put back, a person named more often
    than in the compiled prompt fails it; a variant that still fails is left out, and none left means Compiled;
  - four variants from one call (VARIANTS: naturalistic, moody cinematic, documentary, high contrast); a variant
    whose words all fail gets built-in words for its emphasis;
  - FLUX Klein wants a short edit instruction, Krea 2 + depth the camera-block description: compile writes both forms;
  - the stage's own "empty ground in the foreground" becomes the set's ground on a street, plaza or interior (fix_ground).
The cast pass (Klein 9B repainting each silhouette with the cast picture) still carries identity on its own.

Backends (pluggable, all local, no cloud):
  ollama  an Ollama vision model (qwen3-vl, qwen2.5vl, …) where ComfyUI runs; a `{"` assistant prefill skips
          Qwen3-VL's thinking (think:false is ignored by Ollama 0.40 for it: 18 s of thinking vs 3 s);
  comfy   ComfyUI's TextGenerate with the Qwen3-VL text encoder the App already has (Krea 2 ships
          qwen3vl_4b_fp8_scaled), queued at the FRONT of the queue (realism.py's Queue);
  canned  a recorded reply (tests, SOUNDSTAGE_AUTOPROMPT_CANNED=file.json).
Anything missing, slow (TIMEOUT_S) or invalid falls back to the compiled prompt, said so in the result.

No ComfyUI imports at module level: the tests run everything but the live backends.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import time
import urllib.request

from . import scene as S

VERSION = 2   # 2: Auto is the compiled prompt plus the LLM's words, in four variants (v1 prompts are stale)
TIMEOUT_S = float(os.environ.get("SOUNDSTAGE_AUTOPROMPT_TIMEOUT") or 150)   # the whole LLM call; then compiled
# (qwen3-vl:4b on an 8-core Xeon CPU: 60-75 s with a cast picture; a GPU answers in a few seconds)
MAX_REFS = 3              # cast pictures shown to the LLM (more slow a CPU model down a lot)
IMAGE_SIDE = 768          # longest side of each image sent
TARGETS = ("edit", "still")   # edit: FLUX Klein (an edit instruction), still: Krea 2 + depth and the others

# Ollama vision models, best first (SOUNDSTAGE_AUTOPROMPT_MODEL picks one by name).
OLLAMA_MODELS = ("qwen3-vl:8b", "qwen3-vl:4b", "qwen2.5vl:7b", "qwen2.5vl:3b", "gemma3:12b", "gemma3:4b")
# ComfyUI TextGenerate vision encoders, best first (realism.py's list plus Klein's int8 one).
COMFY_MODELS = ("qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors",
                "qwen3.5_4b_bf16.safetensors")

# Quality tags never help these models and two of them were measured to hurt (compile.BANNED_WORDS); the rest is the
# same family. Matched as whole words, case-insensitive.
BANNED = ("8k", "4k", "uhd", "masterpiece", "best quality", "high quality", "highest quality", "highly detailed",
          "ultra-detailed", "ultra detailed", "hyperrealistic", "hyper-realistic", "hyper realistic",
          "trending on artstation", "award-winning", "award winning", "octane render", "unreal engine", "beautiful",
          "stunning", "breathtaking", "masterful", "perfect")
_BANNED_RE = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in BANNED) + r")\b", re.I)
# Words that place or size something in the frame: the stage owns these.
_PLACE_RE = re.compile(
    r"\b(?:left|right|centre|center|middle|foreground|background|in front of|behind|close[- ]up|wide shot|medium shot|"
    r"full[- ]figure|full body|small in frame|large in frame|fills? the frame|edge of (?:the )?frame|"
    r"in the distance|far away|nearby|next to|beside|by the|near the|at the (?:back|front)|corner)\b", re.I)
_SIDE_RE = re.compile(r"\b(left|right)\b", re.I)
_POSE_RE = {"seated": re.compile(r"\b(?:stand(?:s|ing)?|walk(?:s|ing)?|run(?:s|ning)?)\b", re.I),
            "standing": re.compile(r"\b(?:sit(?:s|ting)?|seated|lying|lies|kneel(?:s|ing)?)\b", re.I)}
_FACING_RE = {"away": re.compile(r"\b(?:facing (?:the )?(?:camera|us|viewer|lens)|looks? (?:at|into) the (?:camera|lens)|"
                                 r"toward the camera|face (?:to|toward) the camera)\b", re.I),
              "toward": re.compile(r"\b(?:from behind|back to (?:the )?(?:camera|us)|facing away|seen from the back)\b", re.I)}
# Face words for someone the stage shows from behind: Krea 2 and Klein turn a person round to show the face they are told
# about (compile.py negates "facing the camera" for the same reason).
_FACE_RE = re.compile(r"\b(?:expression|face|faced|features|eyes|smil\w*|frown\w*|gaze|lips|freckl\w*|makeup|brows?|"
                      r"cheek\w*|jaw\w*|nose)\b", re.I)
_PERSON_NOUN_RE = re.compile(
    r"\b(?:an?|one|the|two|three|exactly \w+)?\s*(?:young |old |middle-aged |elderly )?"
    r"(?:woman|women|man|men|person|people|girl|boy|child|children|lady|guy|figure|actor|actress|teenager|kid)\b", re.I)
_LATER_WORDS = re.compile(r"\b(?:then|later|after(?:wards)?|until|finally|eventually|begins? to|starts? to|will)\b", re.I)


# ------------------------------------------------------------------------------------------------ the facts

def target_for(model_key: str) -> str:
    """Which form a ④ Frame model wants: 'edit' for FLUX Klein (reads the Look's edit_prompt), 'still' otherwise."""
    return "edit" if re.search(r"\bKlein\b", str(model_key or "")) else "still"


def _where_word(sx: float) -> str:
    return "left" if sx < -0.2 else "right" if sx > 0.2 else "centre"


def _facing_kind(e: dict, cam: dict) -> str:
    """'away' / 'toward' / '' from the stage's own people phrase for this one person."""
    f = S.person_still_phrase([e], cam, lambda _e: "")
    if re.search(r"from behind|back to the camera", f):
        return "away"
    if re.search(r"facing the camera", f):
        return "toward"
    return ""


def stage_facts(look: dict | None, scene: dict | None) -> dict:
    """What the stage says frame 1 holds, in the words the LLM is told and the validator checks against."""
    from .compile import absent_words, frame1_safe
    from .identity import known_wear
    from .sfx import without_rigs
    scene = without_rigs(scene or {})
    look = look or {}
    f1 = S.frame1_facts(scene)
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    people = []
    for e in sorted(f1["people"], key=lambda e: e["sx"]):
        a = by_id.get(e["id"]) or e.get("actor") or {}
        people.append({"id": e["id"], "name": a.get("name") or "", "noun": re.sub(r"^(?:a|an) ", "", e["noun"]),
                       "where": _where_word(e["sx"]), "pose": "seated" if e.get("seated") else "standing",
                       "facing": _facing_kind(e, f1["camera"]), "wear": known_wear(a, look)})
    # only people's and animals' names ("Maya"): a prop placed as an actor is named "Door" or "Chair"
    names = [a.get("name") for a in scene.get("actors") or [] if a.get("name") and S.classify(a)[1] in ("biped", "quadruped")]
    props = [{"word": p["word"], "side": _where_word(p.get("sx", 0.0))} for p in f1["props"][:6]]
    others = [re.sub(r"^(?:a|an) ", "", e["noun"]) for e in f1["others"]]
    from .identity import still_identity
    return {
        "set": f1["location"]["set"], "identity": still_identity(scene, {e["id"] for e in f1["others"]}),
        "shot_id": scene.get("shot_id") or "",
        "size": f1["size_still"], "focal_mm": round(f1["focal_mm"]), "angle": f1["angle"],
        "place": f1["location"]["place"], "int_ext": f1["location"]["int_ext"], "weather": f1["location"]["weather"],
        "lighting": f1["lighting"], "people": people, "others": others, "props": props, "names": names,
        "notes": frame1_safe(look.get("description", ""), absent_words(scene, f1), names),
    }


def facts_sig(facts: dict, target: str) -> str:
    """The cache key's stage half: an auto prompt written for other people, another lens or another target is stale."""
    core = {k: facts.get(k) for k in ("shot_id", "size", "focal_mm", "angle", "place", "lighting", "props", "others", "notes")}
    core["people"] = [{k: p[k] for k in ("id", "where", "pose", "facing", "wear")} for p in facts.get("people") or []]
    core["target"], core["v"] = target, VERSION
    return hashlib.sha1(json.dumps(core, sort_keys=True, default=str).encode()).hexdigest()[:16]


# ------------------------------------------------------------------------------------------------ the variants

# Four emphases from ONE vision-model call (a CPU model takes a minute a call). Every variant keeps every stage fact:
# compile_still writes them, the same words as Compiled; only the words the LLM adds differ. `brief` is what the LLM is
# asked for; `words` are the built-in words when none of its own survive the checks (time-neutral; `night_words` and
# `night_label` only on a night stage).
VARIANTS = (
    {"key": "natural", "label": "Naturalistic",
     "brief": "naturalistic: true-to-life light and colour from the light sources already there, real surface textures",
     "words": "true-to-life colour, soft natural contrast, real surface textures"},
    {"key": "cinematic", "label": "Moody cinematic",
     "brief": "moody and cinematic: deeper shadows, richer contrast, atmosphere, the same light sources",
     "words": "moody cinematic atmosphere, deep shadows, rich contrast"},
    {"key": "documentary", "label": "Documentary",
     "brief": "documentary and plain: unstyled available light, honest everyday textures, no glamour",
     "words": "plain documentary realism, unstyled available light, honest everyday textures"},
    {"key": "contrast", "label": "High contrast", "night_label": "High-contrast night",
     "brief": "high contrast: hard light, deep blacks, crisp highlights and reflections",
     "words": "high contrast, hard light, deep shadows, crisp highlights",
     "night_words": "high-contrast night, deep inky blacks, hard pools of light, crisp specular highlights"},
)
VARIANT_KEYS = tuple(v["key"] for v in VARIANTS)


def variant_label(v: dict, facts: dict) -> str:
    return v.get("night_label") if v.get("night_label") and _time_class(facts.get("lighting", "")) == "night" else v["label"]


# ------------------------------------------------------------------------------------------------ the LLM's brief

SYSTEM = (
    "You help paint the first frame of a film shot. Image 1 is a plain 3D stage render of that frame: simple "
    "mannequins stand in for the actors and plain shapes for the cars, furniture and props. The stage already says "
    "the place, the camera, the framing, who and what is there, how many, their colours and clothes, where they are, "
    "the time of day and the weather. Any further images are cast pictures: what each person really looks like.\n"
    "You only ADD words about the light, the mood, the surface textures and the photographic feel, in four versions.\n"
    "Reply with JSON only:\n"
    '{"seen": "one short sentence: what image 1 shows",\n'
    ' "people": [{"id": "<the id from the list>", "looks": "at most 14 words: age, hair, build and face from that '
    'person\'s cast picture"}],\n'
    ' "variants": {"natural": {"light": "", "mood": "", "texture": ""}, "cinematic": {…}, "documentary": {…}, '
    '"contrast": {…}},\n'
    ' "changed": "one short sentence: what you left out of the director\'s notes, and why"}\n'
    'Each "light", "mood" and "texture" is at most 10 words, in that version\'s emphasis (listed below).\n'
    "Rules. Never name the place, a person, a vehicle, an animal or a prop, never say how many there are, their colour "
    "or where they are: the stage says that. Never change the time of day or the weather. Describe frame 1 only, as a "
    "still photograph: no movement, nothing that happens later. No names, no clothes in \"looks\". No positions or "
    "sizes (left, right, centre, foreground, background, close-up). "
    "No quality words such as 8k, masterpiece, best quality or highly detailed."
)


def user_prompt(facts: dict, ref_labels: list[str], target: str) -> str:
    """The stage's facts as a short list; the LLM must not contradict them."""
    lines = ["Facts from the stage (true; never contradict them):",
             f"- shot: {facts['size']}, {facts['focal_mm']}mm lens, {facts['angle']}-level camera, "
             f"{facts['place'] or 'a set'}" + (f", {facts['weather']}" if facts["weather"] else "") +
             (f", {facts['lighting']}" if facts["lighting"] else "")]
    if facts["people"]:
        lines.append(f"- people in frame 1 ({len(facts['people'])}, listed left to right):")
        for i, p in enumerate(facts["people"]):
            pic = next((f"image {j + 2}" for j, lab in enumerate(ref_labels) if lab and p["name"] and lab.lower() == p["name"].lower()), "")
            pic = pic or (f"image {i + 2}" if len(ref_labels) == len(facts["people"]) else "")
            lines.append(f"  - id {p['id']}: a {p['noun']}, {p['pose']}" + (f", wearing {p['wear']}" if p["wear"] else "") +
                         (f"; cast picture: {pic}" if pic else "; no cast picture"))
    else:
        lines.append("- nobody is in frame 1")
    if facts["others"]:
        lines.append("- also in frame: " + ", ".join(facts["others"]) + (f" ({facts['identity']})" if facts.get("identity") else ""))
    if facts["props"]:
        lines.append("- set pieces in frame: " + ", ".join(p["word"] for p in facts["props"]))
    if facts["notes"]:
        lines.append(f"- the director's notes: {facts['notes']}")
    lines.append("- the image model: " + ("an edit model that turns image 1 into a photograph" if target == "edit"
                                          else "a depth-guided image model that paints from a description"))
    night = _time_class(facts.get("lighting", "")) == "night"
    lines.append("The four versions:")
    for v in VARIANTS:
        lines.append(f"- {v['key']}: {v['brief']}" + (" (it is night: keep it night)" if night and v["key"] == "contrast" else ""))
    lines.append("Write the JSON.")
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------ parse + validate

def _flat(v) -> str:
    """A variant's words, whatever shape the LLM gave them: a string, or {light, mood, texture, …}."""
    if isinstance(v, dict):
        return ", ".join(str(v[k]).strip() for k in ("light", "mood", "texture", "composition", "words", "setting")
                         if isinstance(v.get(k), str) and v[k].strip())
    return str(v or "").strip() if isinstance(v, (str, int, float)) else ""


def parse_reply(text: str) -> dict:
    """The LLM's JSON, forgiving (video2stage.vlm's reader). Raises ValueError when there is none.
    variants: {key: words} for the keys in VARIANTS; an old one-prompt reply's "setting" is the natural one."""
    from ..video2stage.vlm import _json_obj
    obj = _json_obj(text)
    if not isinstance(obj, dict):
        raise ValueError("the model did not return a JSON object")
    people = obj.get("people") if isinstance(obj.get("people"), list) else []
    raw = obj.get("variants")
    variants: dict[str, str] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k).strip().lower()
            if key in VARIANT_KEYS and _flat(v):
                variants[key] = _flat(v)
    elif isinstance(raw, list):
        for i, v in enumerate(raw):
            key = str((v.get("key") or v.get("name") or "") if isinstance(v, dict) else "").strip().lower()
            key = key if key in VARIANT_KEYS else (VARIANT_KEYS[i] if i < len(VARIANT_KEYS) else "")
            if key and key not in variants and _flat(v):
                variants[key] = _flat(v)
    setting = str(obj.get("setting") or "").strip()
    if setting and "natural" not in variants:
        variants["natural"] = setting
    return {"seen": str(obj.get("seen") or "").strip(), "setting": setting,
            "people": [p if isinstance(p, dict) else {"looks": str(p)} for p in people],
            "variants": variants, "changed": str(obj.get("changed") or "").strip()}


def banned_in(text: str) -> list[str]:
    return sorted({m.group(0).lower() for m in _BANNED_RE.finditer(text or "")})


def _clauses(text: str) -> list[str]:
    return [c.strip(" .;") for c in re.split(r"[.;]\s+|,\s*|\s+(?:and|while|with)\s+(?=\w+ing\b)", text or "") if c.strip(" .;")]


def _limit_words(text: str, n: int) -> str:
    words = text.split()
    if len(words) <= n:
        return text
    cut = " ".join(words[:n])
    i = max(cut.rfind(","), cut.rfind(";"))
    return (cut[:i] if i > len(cut) // 2 else cut).rstrip(" ,;")


# What the LLM may not add: things the stage owns. Vehicles and animals (the stage counts and paints them: the chase
# shot's Auto said "a grey classic car" and Krea painted one), a kind of place the stage is not (an open lot with grass
# on a city street), a time of day or weather the stage does not have.
_VEHICLE_RE = re.compile(
    r"\b(?:cars?|vehicles?|trucks?|vans?|bus(?:es)?|sedans?|coup[eé]s?|suvs?|jeeps?|taxis?|cabs?|motorbikes?|motorcycles?|"
    r"bikes?|bicycles?|cruisers?|boats?|ships?|planes?|aircraft|helicopters?|trains?|horses?|dogs?|cats?|animals?)\b", re.I)
_PLACE_NOUN_RE = re.compile(
    r"\b(?:parking lot|open lot|empty lot|vacant lot|field|meadow|grass|grassy|lawn|park|beach|sand|sandy|desert|dunes?|"
    r"forest|woods|jungle|room|kitchen|bedroom|living room|office|warehouse|garage|studio|cabin|ocean|sea|lake|river|"
    r"mountains?|hills?|countryside|farm|barn|runway|airport|station|platform|stadium|highway|alley|street|road|avenue|"
    r"boulevard|plaza|square|courtyard|yard|backyard|dirt|gravel|reef|underwater)\b", re.I)
# kinds of place that go together: a street is also a road; a desert is sand and dunes
_PLACE_GROUPS = ({"street", "road", "avenue", "boulevard"}, {"plaza", "square", "courtyard"},
                 {"desert", "sand", "sandy", "dune", "dunes", "dirt", "gravel"}, {"beach", "sand", "sandy", "ocean", "sea"},
                 {"forest", "woods", "dirt"}, {"runway", "airport"}, {"station", "platform"},
                 {"stadium", "field", "grass", "grassy", "lawn", "ballfield"}, {"reef", "underwater", "ocean", "sea"},
                 {"lake", "river"})
_INTERIOR_WORDS = {"room", "kitchen", "bedroom", "living room", "office", "studio"}
_DAY_RE = re.compile(r"\b(?:daylight|daytime|sunlight|sunlit|sunny|sunshine|midday|noon|morning|afternoon|blue sky|"
                     r"bright sun|harsh sun|sun-drenched)\b", re.I)
_NIGHT_RE = re.compile(r"\b(?:night|nighttime|night-time|moonlight|moonlit|starlight|starry|after dark|midnight)\b", re.I)
_GOLDEN_RE = re.compile(r"\b(?:golden hour|sunset|sunrise|dusk|dawn|magic hour|twilight|blue hour)\b", re.I)
_NOON_RE = re.compile(r"\b(?:midday|noon|overhead sun)\b", re.I)
# weather words, by the stage word that allows them
_WEATHER = {"rain": r"rain|raining|rainy|drizzle|downpour|storm|stormy|rain-slicked", "wet": r"wet|puddles?|rain-slicked",
            "fog": r"fog|foggy|mist|misty|haze|hazy", "smoke": r"smoke|smoky", "dust": r"dust|dusty",
            "snow": r"snow|snowy|snowing", "overcast": r"overcast|cloudy"}
_WEATHER_RE = {k: re.compile(r"\b(?:" + v + r")\b", re.I) for k, v in _WEATHER.items()}


def _time_class(lighting: str) -> str:
    """'night' / 'twilight' / 'golden' / 'day' from the stage's lighting words, '' when they do not say."""
    t = (lighting or "").lower()
    if "night" in t or "moonlight" in t:
        return "night"
    if "twilight" in t or "blue hour" in t:
        return "twilight"
    if "magic hour" in t or "golden hour" in t or "low sun" in t:
        return "golden"
    if "daylight" in t or re.search(r"\bsun\b", t):
        return "day"
    return ""


def _place_ok(noun: str, facts: dict) -> bool:
    place = (facts.get("place") or "").lower()
    if not place:
        return True                              # an empty set: no place to contradict
    noun = noun.lower()
    words = set(re.findall(r"[a-z]+", place))
    if noun in words or noun in place:
        return True
    if facts.get("int_ext") == "INT" and noun in _INTERIOR_WORDS and "interior" in words:
        return True
    return any(noun in g and g & words for g in _PLACE_GROUPS)


def _time_bad(clause: str, cls: str) -> str:
    if cls == "night":
        m = _DAY_RE.search(clause) or _GOLDEN_RE.search(clause)
    elif cls == "twilight":
        m = _DAY_RE.search(clause)
    elif cls == "golden":
        m = _NIGHT_RE.search(clause) or _NOON_RE.search(clause)
    elif cls == "day":
        m = _NIGHT_RE.search(clause) or _GOLDEN_RE.search(clause)
    else:
        m = None
    return m.group(0) if m else ""


def _weather_bad(clause: str, facts: dict) -> str:
    have = f"{facts.get('weather') or ''} {facts.get('lighting') or ''}".lower()
    for k, rx in _WEATHER_RE.items():
        m = rx.search(clause)
        if not m:
            continue
        ok = k in have or (k == "wet" and "rain" in have) or (k == "fog" and "haze" in have)
        if not ok:
            return m.group(0)
    return ""


def clean_add(text: str, facts: dict) -> tuple[str, list[str]]:
    """The words the LLM adds to the stage's (light, mood, texture), frame-1 true and stage true. A clause goes when it
    names a person, a name, a vehicle or an animal, a kind of place the stage is not, a time of day or weather the stage
    does not have, a later beat, or a placement ("empty ground in the foreground"); a left / right word stays only
    for a prop the stage puts on that side. Quality tags go. Returns (text, notes on what went)."""
    from .compile import frame1_safe
    notes: list[str] = []
    names = [n for n in facts.get("names") or [] if n]
    name_re = re.compile(r"\b(?:" + "|".join(re.escape(n) for n in names) + r")\b", re.I) if names else None
    cls = _time_class(facts.get("lighting", ""))
    keep = []
    for c in _clauses(frame1_safe(text, (), names) if text else ""):
        if _PERSON_NOUN_RE.search(c) or re.search(r"\b(?:she|he|her|his|they|their|them)\b", c, re.I) or \
                (name_re and name_re.search(c)):
            notes.append(f"dropped “{c}” (people are said once, from the stage)")
            continue
        if _VEHICLE_RE.search(c):
            notes.append(f"dropped “{c}” (vehicles and animals come from the stage)")
            continue
        if _LATER_WORDS.search(c):
            notes.append(f"dropped “{c}” (after frame 1)")
            continue
        bare = re.sub(r"\bdepth of field\b", "", c, flags=re.I)
        noun = next((m.group(0) for m in _PLACE_NOUN_RE.finditer(bare) if not _place_ok(m.group(0), facts)), "")
        if noun:
            notes.append(f"dropped “{c}” (“{noun}”: the stage is {facts.get('place') or 'another place'})")
            continue
        t = _time_bad(c, cls)
        if t:
            notes.append(f"dropped “{c}” (“{t}”: the stage's time of day is {facts.get('lighting', '').split(',')[0]})")
            continue
        w = _weather_bad(c, facts)
        if w:
            notes.append(f"dropped “{c}” (“{w}”: the stage has no such weather)")
            continue
        placed = {m.group(0).lower() for m in _PLACE_RE.finditer(c)}
        if placed:
            prop = next((p for p in facts.get("props") or []
                         if re.search(r"\b" + re.escape(re.sub(r"^(?:a|an) ", "", p["word"])) + r"s?\b", c, re.I)), None)
            if not (placed <= {"left", "right"} and prop and prop["side"] in placed and len(placed) == 1):
                notes.append(f"dropped “{c}” (a placement the stage does not have)")
                continue
        keep.append(c)
    out = ", ".join(dict.fromkeys(keep))
    for w in banned_in(out):
        notes.append(f"removed “{w}” (a quality tag)")
    out = re.sub(r"\s{2,}", " ", _BANNED_RE.sub("", out)).strip(" ,")
    out = re.sub(r",\s*,", ",", out)
    return _limit_words(out, 36), notes


clean_setting = clean_add   # the one-prompt name (v1)


def clean_looks(text: str, person: dict, names: list[str]) -> tuple[str, list[str]]:
    """One person's looks: no noun (the people phrase already says 'a woman'), no name, no clothes, no place, no pose
    or facing that contradicts the stage, no quality tag."""
    notes: list[str] = []
    t = str(text or "")
    for n in names:
        if n:
            t = re.sub(r"\b" + re.escape(n) + r"(?:'s)?\b", "", t, flags=re.I)
    keep = []
    for c in _clauses(t):
        if _PLACE_RE.search(c):
            notes.append(f"dropped “{c}” (placement comes from the stage)")
            continue
        if re.search(r"\b(?:wear(?:s|ing)?|dressed|shirt|jeans|trousers|pants|dress|jacket|coat|skirt|shoes|hoodie|"
                     r"sweater|t-shirt|blouse|suit)\b", c, re.I):
            continue   # clothes come from the stage, silently
        if person.get("facing") == "away" and _FACE_RE.search(c):
            notes.append(f"dropped “{c}” (the stage has them with their back to the camera: a face word turns them round)")
            continue
        pose_bad = _POSE_RE.get(person.get("pose", ""))
        face_bad = _FACING_RE.get(person.get("facing", ""))
        if (pose_bad and pose_bad.search(c)) or (face_bad and face_bad.search(c)):
            notes.append(f"dropped “{c}” (the stage has them {person.get('pose')}"
                         f"{', facing ' + person['facing'] if person.get('facing') else ''})")
            continue
        keep.append(c)
    out = ", ".join(keep)
    # a leading noun phrase ("a woman in her thirties") would name the person a second time
    out = re.sub(r"^(?:an?|one|the)\s+(?:young |old |middle-aged |elderly )?(?:woman|man|person|girl|boy|lady|guy|child)\b"
                 r"(?:\s+(?:who is|aged))?[\s,]*", "", out, flags=re.I)
    if _PERSON_NOUN_RE.search(out):
        notes.append("dropped a second noun for the person")
        out = _PERSON_NOUN_RE.sub("", out)
    for w in banned_in(out):
        notes.append(f"removed “{w}” (a quality tag)")
    out = re.sub(r"\s{2,}", " ", _BANNED_RE.sub("", out)).strip(" ,")
    return _limit_words(out, 16), notes


def check_prompt(text: str, facts: dict) -> list[str]:
    """Problems in a whole frame prompt (the assembled Auto one, or a Manual one typed by the user: shown, never
    changed): quality tags, a name, more people named than the stage has, a side word for a person the stage puts
    elsewhere."""
    out = []
    for w in banned_in(text):
        out.append(f"“{w}” is a quality tag: it does not help this model")
    for n in facts.get("names") or []:
        if n and re.search(r"\b" + re.escape(n) + r"\b", text or ""):
            out.append(f"“{n}” is a name: the image model does not know it (the cast picture carries who it is)")
    n = len(facts.get("people") or [])
    count = re.findall(r"\bexactly (one|two|three|four|five|six|\d+) (?:people|person|persons|woman|man|women|men|"
                       r"child|children|girl|boy)", text or "", re.I)
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
    for c in count:
        k = words.get(c.lower(), int(c) if c.isdigit() else 0)
        if k != n:
            out.append(f"says {c} {'person' if k == 1 else 'people'}; the stage has {n} in frame 1")
    return out


# ------------------------------------------------------------------------------------------------ the stage's facts, kept

# The stage's own "empty ground in the foreground" (scene._distance_words) on a set whose foreground is not open
# ground: Krea 2 painted an open lot with grass for the chase on the city street. Auto says the set's own ground.
GROUND_WORDS = {"street_night": "the empty road in the foreground", "burning_building": "the empty road in the foreground",
                "plaza": "empty paving in the foreground", "runway": "empty runway tarmac in the foreground",
                "train_station": "the empty platform in the foreground"}
_EMPTY_GROUND = "empty ground in the foreground"


def fix_ground(prompt: str, facts: dict) -> str:
    if _EMPTY_GROUND not in (prompt or ""):
        return prompt
    words = GROUND_WORDS.get(facts.get("set") or "") or ("open floor in the foreground" if facts.get("int_ext") == "INT" else "")
    return prompt.replace(_EMPTY_GROUND, words) if words else prompt


def _pieces(text: str) -> list[str]:
    """Comma / semicolon / sentence pieces, the grain compile's _dedupe keeps or drops."""
    return [p.strip(" .") for p in re.split(r"[,;]\s*|\.\s+", text or "") if p.strip(" .")]


_PERSON_WORDS = ("woman", "man", "child", "girl", "boy", "person")


def required_facts(look: dict, scene: dict, compiled: str) -> list[str]:
    """The stage's facts an Auto prompt must keep, as the pieces the compiled prompt says them in: the place and set
    type, the street's own words, which car is which and what each car is, each person (noun and clothes), the head
    count, the weather and the time of day. Only pieces the compiled prompt really carries (an edit prompt has no
    "in a city street": image 1 holds the place); plus, on a street with its traffic lock, how many vehicles."""
    from .compile import NUM, _still_count
    from .identity import body_words, still_identity, wardrobe
    f1 = S.frame1_facts(scene)
    ids = {e["id"] for e in f1["people"] + f1["others"]}
    loc = f1["location"]
    lock = S.traffic_lock(scene, ids)
    by_id = {a.get("id"): a for a in scene.get("actors") or []}
    cands = [f"in {loc['place']}" if loc["place"] else "", loc["place"], loc["weather"],
             (f1["lighting"] or "").split(",")[0], lock["still"] if lock else "",
             still_identity(scene, ids), body_words(scene, {e["id"] for e in f1["others"]}), _still_count(len(f1["people"]))]
    for e in f1["people"]:
        cands.append(wardrobe(scene, by_id.get(e["id"]) or e["actor"], look))
    low = fix_ground(compiled, {"set": loc["set"], "int_ext": loc["int_ext"]}).lower()
    out: list[str] = []
    for c in cands:
        for p in ([c] if c and c.lower() in low else []) + _pieces(c):
            if p and p.lower() in low and p not in out:
                out.append(p)
    nv = sum(1 for e in f1["others"] if e.get("rig") == "vehicle")
    if lock and nv:
        out.append(f"{NUM.get(nv, nv)} vehicle{'s' if nv > 1 else ''} in frame")
    return out


def _person_counts(text: str) -> dict:
    t = (text or "").lower()
    return {w: len(re.findall(r"\b" + w + r"\b", t)) for w in _PERSON_WORDS}


def validate(prompt: str, compiled: str, required: list[str]) -> tuple[list[str], list[str]]:
    """(missing stage facts, other problems): every required piece is in the Auto prompt, and no person is named more
    often than the compiled prompt names them (a woman named twice came out as two women)."""
    low = (prompt or "").lower()
    missing = [r for r in required if r.lower() not in low]
    a, c = _person_counts(prompt), _person_counts(compiled)
    extra = [f"names “{w}” {a[w]} times; the stage {c[w]}" for w in _PERSON_WORDS if a[w] > c[w]]
    return missing, extra


def reinsert(prompt: str, missing: list[str], target: str) -> str:
    """Put missing stage facts back: at the end of the description, or as a sentence of the edit instruction."""
    if not missing:
        return prompt
    if target == "edit":
        tail = "; ".join(missing)
        return f"{prompt.rstrip(' .')}. {tail[:1].upper()}{tail[1:]}."
    return f"{prompt.rstrip(' ,.')}, {', '.join(missing)}"


# ------------------------------------------------------------------------------------------------ assemble

def without_names(text: str, names: list[str]) -> tuple[str, list[str]]:
    """The description without the comma pieces that name someone ("Sam and Maya wait by the building"): the image
    model does not know a name, the stage says who is where, the cast picture who it is. Returns (text, pieces gone)."""
    rx = re.compile(r"\b(?:" + "|".join(re.escape(n) for n in names if n) + r")\b", re.I) if any(names) else None
    if not rx or not text:
        return text or "", []
    out, gone = [], []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        end = sentence[-1] if sentence and sentence[-1] in ".!?" else ""
        body = sentence[:-1] if end else sentence
        keep = []
        for piece in re.split(r",\s*", body):
            (gone if rx.search(piece) else keep).append(piece.strip())
        if keep:
            t = ", ".join(k for k in keep if k)
            out.append(t[:1].upper() + t[1:] + (end or "."))
    return " ".join(out), [g for g in gone if g]


_PERSON_REF_RE = re.compile(
    r"\b(?:she|he|her|hers|him|his|they|them|their|woman|women|man|men|person|people|girl|boy|child|children|lady|"
    r"guy|actor|actress|figure)\b", re.I)
_CLOTHES_ONLY_RE = re.compile(
    r"^(?:(?:a|an|the|her|his|their|blue|black|white|grey|gray|dark|light|pink|red|green|brown|navy|beige|khaki|faded|"
    r"worn|rolled-up|button-up|long|short|sleeves?|with|and|of|in)\s+)*(?:jeans|trousers|pants|shorts|skirt|dress|"
    r"shirt|t-shirt|blouse|jacket|coat|hoodie|sweater|shoes|sneakers|boots|suit)(?:\s+\w+){0,3}$", re.I)


def without_people(text: str) -> tuple[str, list[str]]:
    """Auto's description without the comma pieces about a person ("A woman in her thirties, stands by the window",
    "her back half to us", "she barely moves") or only their clothes ("Blue jeans"): the stage's people phrase says
    each person ONCE, with place, facing and clothes, and the vision model adds their looks. Measured on the Maya S1
    stage: without_names alone left "A woman in her thirties, stands by the window" beside "exactly one woman …
    standing in the centre": the woman named twice (C22c painted two) and placed where the stage does not have her.
    Returns (text, pieces gone)."""
    if not text:
        return text or "", []
    out, gone = [], []
    for sentence in re.split(r"(?<=[.!?:])\s+", text.strip()):
        end = sentence[-1] if sentence and sentence[-1] in ".!?:" else ""
        body = sentence[:-1] if end else sentence
        keep = []
        for piece in re.split(r",\s*", body):
            p = piece.strip()
            (gone if p and (_PERSON_REF_RE.search(p) or _CLOTHES_ONLY_RE.match(p)) else keep).append(p)
        if [k for k in keep if k]:
            t = ", ".join(k for k in keep if k)
            out.append(t[:1].upper() + t[1:] + ("." if end in ("", ":") else end))
    return " ".join(out), [g for g in gone if g]


def assemble(look_in: dict | None, scene: dict | None, llm: dict, target: str, steps: int | None = None,
             words: str | None = None) -> dict:
    """The frame prompt in the target model's form: the compiled prompt's own stage words (compile_look with `add`),
    plus the LLM's cleaned words (`words`, else the reply's natural variant / setting) and each person's looks.
    Returns {"prompt", "notes": [...], "used": {"setting", "looks": {id: text}}}."""
    from .compile import compile_look
    from .sfx import without_rigs
    look = {k: v for k, v in (look_in or {}).items() if k != "frame_prompts"}
    if steps and not look.get("frame_steps"):
        look["frame_steps"] = steps
    scene = without_rigs(scene or {})
    facts = stage_facts(look, scene)
    names = facts["names"]
    notes: list[str] = []
    if look.get("description") and names:
        look["description"], gone = without_names(look["description"], names)
        notes += [f"dropped “{c}” from the description (a name: the image model does not know it)" for c in gone]
    if look.get("description") and facts["people"]:
        look["description"], gone = without_people(look["description"])
        notes += [f"dropped “{c}” from the description (each person is said once, from the stage)" for c in gone]
    raw = words if words is not None else ((llm.get("variants") or {}).get("natural") or llm.get("setting", ""))
    added, n1 = clean_add(raw, facts)
    notes += n1
    by_pid = {str(p.get("id") or ""): p for p in llm.get("people") or [] if isinstance(p, dict)}
    looks: dict[str, str] = {}
    unmatched = [p for p in llm.get("people") or [] if isinstance(p, dict) and str(p.get("id") or "") not in
                 {q["id"] for q in facts["people"]}]
    for i, p in enumerate(facts["people"]):
        raw_p = by_pid.get(p["id"]) or (unmatched[i] if i < len(unmatched) else None)
        t, n2 = clean_looks((raw_p or {}).get("looks", ""), p, names)
        notes += n2
        if t:
            looks[p["id"]] = t
    r = compile_look(look, scene, add={"looks": looks, "words": added})
    prompt = fix_ground(r["edit_prompt"] if target == "edit" else r["still_prompt"], facts)
    for w in banned_in(prompt):   # the look's own words never carry one (compile's test), but say so if they do
        notes.append(f"removed “{w}” (a quality tag)")
    prompt = re.sub(r"\s{2,}", " ", _BANNED_RE.sub("", prompt)).replace(" ,", ",")
    return {"prompt": prompt, "notes": notes, "used": {"setting": added, "looks": looks}}


def build_variants(look: dict, scene: dict, llm: dict, target: str, compiled: str, steps: int | None = None) -> dict:
    """Every variant's prompt, each checked against the stage: {"variants": [...], "dropped": [notes], "llm_words": bool}.
    A variant whose LLM words all fail the checks gets the built-in words for its emphasis; one that still misses a
    stage fact after putting it back is left out."""
    facts = stage_facts(look, scene)
    required = required_facts(look, scene, compiled)
    night = _time_class(facts.get("lighting", "")) == "night"
    out, dropped, llm_words, seen = [], [], False, set()
    for v in VARIANTS:
        raw = (llm.get("variants") or {}).get(v["key"], "")
        a = assemble(look, scene, llm, target, steps, words=raw)
        builtin = not a["used"]["setting"]
        notes = list(a["notes"])
        if builtin:
            if raw:
                notes.append("none of the vision model's words survived the checks: the built-in words for this emphasis")
            a = assemble(look, scene, llm, target, steps, words=(v.get("night_words") if night else None) or v["words"])
        else:
            llm_words = True
        prompt = a["prompt"]
        missing, extra = validate(prompt, compiled, required)
        if missing:
            notes.append("put back what the stage says: " + "; ".join(f"“{m}”" for m in missing))
            prompt = reinsert(prompt, missing, target)
            missing, extra = validate(prompt, compiled, required)
        problems = missing and [f"misses “{m}”" for m in missing] or []
        problems += extra + check_prompt(prompt, facts)
        if problems:
            dropped.append(f"{v['label']}: " + "; ".join(problems))
            continue
        if prompt in seen:
            dropped.append(f"{v['label']}: the same words as another variant")
            continue
        seen.add(prompt)
        out.append({"key": v["key"], "label": variant_label(v, facts), "prompt": prompt, "words": a["used"]["setting"],
                    "builtin": builtin, "notes": notes, "looks": a["used"]["looks"]})
    return {"variants": out, "dropped": dropped, "llm_words": llm_words or any(v["looks"] for v in out),
            "required": required}


# ------------------------------------------------------------------------------------------------ images

def _jpeg(img, side: int = IMAGE_SIDE) -> bytes:
    from PIL import Image
    im = img if isinstance(img, Image.Image) else Image.open(io.BytesIO(img))
    im = im.convert("RGB")
    im.thumbnail((side, side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def decode_data_url(s: str) -> bytes:
    s = str(s or "")
    if s.startswith("data:"):
        s = s.split(",", 1)[1]
    return base64.b64decode(s)


def composite(frame: bytes, refs: list[bytes]) -> bytes:
    """One picture for a backend that takes one image (ComfyUI's TextGenerate): the frame on the left, the cast
    pictures stacked on the right at the frame's height."""
    from PIL import Image
    fr = Image.open(io.BytesIO(_jpeg(frame)))
    if not refs:
        return _jpeg(fr)
    h = fr.height
    cells = [Image.open(io.BytesIO(_jpeg(r, h))) for r in refs[:MAX_REFS]]
    ch = h // len(cells)
    cells = [c.resize((max(1, int(c.width * ch / c.height)), ch)) for c in cells]
    w = fr.width + max(c.width for c in cells) + 8
    out = Image.new("RGB", (w, h), (24, 24, 24))
    out.paste(fr, (0, 0))
    y = 0
    for c in cells:
        out.paste(c, (fr.width + 8, y))
        y += ch
    return _jpeg(out, max(w, h))


# ------------------------------------------------------------------------------------------------ backends

class Backend:
    name = "none"
    model = ""
    temperature = 0.0     # ↻ Rewrite asks for another set of words (Ollama samples; the others answer the same)

    def available(self) -> bool:  # pragma: no cover - interface
        return False

    def generate(self, system: str, prompt: str, images: list[bytes], timeout: float) -> str:  # pragma: no cover
        raise NotImplementedError


class CannedBackend(Backend):
    """A recorded reply: a JSON file {"reply": "..."} or {"replies": {"<shot_id>": "..."}} or a plain dict."""
    name = "canned"

    def __init__(self, reply: str | dict | None = None, path: str | None = None):
        self.model = "canned"
        self.reply, self.path, self.calls = reply, path, []

    def available(self) -> bool:
        return self.reply is not None or bool(self.path and os.path.exists(self.path))

    def generate(self, system, prompt, images, timeout):
        self.calls.append({"system": system, "prompt": prompt, "images": len(images)})
        r = self.reply
        if r is None and self.path:
            with open(self.path, encoding="utf-8") as f:
                r = json.load(f)
        if isinstance(r, dict) and "replies" in r:
            sid = re.search(r"shot_id=(\S+)", prompt)
            r = r["replies"].get(sid.group(1) if sid else "", next(iter(r["replies"].values()), ""))
        if isinstance(r, dict):
            r = r.get("reply", json.dumps(r))
        return str(r)


class OllamaBackend(Backend):
    name = "ollama"

    def __init__(self, url: str | None = None, model: str | None = None):
        from ..assistant import ollama_url
        self.url = (url or ollama_url()).rstrip("/")
        self.want = model or os.environ.get("SOUNDSTAGE_AUTOPROMPT_MODEL") or ""
        self.model = ""

    def _get(self, path: str, data: dict | None = None, timeout: float = 3.0):
        req = urllib.request.Request(self.url + path, json.dumps(data).encode() if data is not None else None,
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def available(self) -> bool:
        try:
            tags = self._get("/api/tags").get("models") or []
        except Exception:  # noqa: BLE001 - Ollama not running
            return False
        have = [m.get("name") or m.get("model") for m in tags]
        vision = [m for m in have if any(m == w or m.startswith(w) for w in OLLAMA_MODELS)]
        if self.want:
            vision = [m for m in have if m == self.want or m.split(":")[0] == self.want]
        for m in sorted(vision, key=lambda m: next((i for i, w in enumerate(OLLAMA_MODELS) if m.startswith(w)), 99)):
            self.model = m
            return True
        return False

    def generate(self, system, prompt, images, timeout):
        body = {"model": self.model, "stream": False, "think": False, "keep_alive": "5m",
                "options": {"temperature": self.temperature, "num_predict": 800, "num_ctx": 8192,
                            **({"seed": int(time.time()) % 100000} if self.temperature else {})},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": prompt,
                              "images": [base64.b64encode(_jpeg(i)).decode() for i in images]},
                             # the prefill: Qwen3-VL answers at once instead of thinking first
                             {"role": "assistant", "content": '{"'}]}
        r = self._get("/api/chat", body, timeout=timeout)
        content = ((r.get("message") or {}).get("content") or "")
        return content if content.lstrip().startswith("{") else '{"' + content


class ComfyBackend(Backend):
    """TextGenerate with a Qwen3-VL text encoder, through this server's own queue (at the front of it)."""
    name = "comfy"

    def __init__(self, base_url: str, model: str | None = None):
        from ..takecheck.realism import Queue
        self.q = Queue(base_url, timeout_s=TIMEOUT_S)
        self.want = model
        self.model = ""

    def available(self) -> bool:
        try:
            have = self.q.text_encoders()
        except Exception:  # noqa: BLE001
            return False
        pick = self.want if self.want in have else next((m for m in COMFY_MODELS if m in have), None)
        self.model = pick or ""
        return bool(pick)

    def generate(self, system, prompt, images, timeout):
        self.q.timeout_s = timeout
        img = composite(images[0], images[1:]) if images else None
        g = {"m": {"class_type": "CLIPLoader", "inputs": {"clip_name": self.model, "type": "stable_diffusion",
                                                          "device": "default"}},
             "s": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": system}},
             "t": {"class_type": "TextGenerate", "inputs": {
                 "clip": ["m", 0], "prompt": prompt + ("\nThe picture: image 1 on the left; the cast pictures stacked "
                                                       "on the right, top to bottom (images 2, 3 …)." if len(images) > 1 else ""),
                 "max_length": 900, "sampling_mode": "off", "thinking": False, "use_default_template": True,
                 "system_prompt": ["s", 0]}},
             "p": {"class_type": "PreviewAny", "inputs": {"source": ["t", 0]}}}
        if img is not None:
            name = self.q.upload(f"autoprompt_{hashlib.sha1(img).hexdigest()[:12]}.jpg", img)
            g["l"] = {"class_type": "LoadImage", "inputs": {"image": name}}
            g["t"]["inputs"]["image"] = ["l", 0]
        return self._run_front(g, "p")

    def _run_front(self, g: dict, out: str) -> str:
        """realism.Queue.run, but at the front of the pending queue: a frame prompt should not wait behind renders."""
        import uuid
        body = json.dumps({"prompt": g, "front": True, "client_id": f"soundstage-autoprompt-{uuid.uuid4().hex[:8]}"}).encode()
        pid = self.q._req("/prompt", body, {"Content-Type": "application/json"}).get("prompt_id")
        if not pid:
            raise RuntimeError("the queue refused the auto-prompt job")
        t0 = time.time()
        while True:
            time.sleep(1.0)
            h = self.q._req(f"/history/{pid}")
            if pid in h:
                break
            if time.time() - t0 > self.q.timeout_s:
                raise TimeoutError(f"the auto prompt waited {self.q.timeout_s:.0f} s for the GPU (job {pid} left queued)")
        st = h[pid].get("status", {})
        if st.get("status_str") != "success":
            raise RuntimeError(f"the auto-prompt job failed: {st.get('status_str')}")
        return (h[pid].get("outputs", {}).get(out, {}).get("text") or [""])[0]


def pick_backend(base_url: str | None = None) -> Backend | None:
    """The first available local backend: a canned reply (tests), an Ollama vision model, ComfyUI's Qwen3-VL.
    SOUNDSTAGE_AUTOPROMPT_BACKEND=ollama|comfy|off pins one."""
    pin = (os.environ.get("SOUNDSTAGE_AUTOPROMPT_BACKEND") or "").lower()
    canned = os.environ.get("SOUNDSTAGE_AUTOPROMPT_CANNED")
    if pin == "off":
        return None
    if canned:
        return CannedBackend(path=canned)
    cands: list[Backend] = []
    if pin in ("", "ollama"):
        cands.append(OllamaBackend())
    if pin in ("", "comfy") and base_url:
        cands.append(ComfyBackend(base_url))
    return next((b for b in cands if b.available()), None)


# ------------------------------------------------------------------------------------------------ the whole run

_CACHE: dict[str, dict] = {}
_CACHE_MAX = 256


def cache_key(sig: str, images: list[bytes], backend: Backend | None) -> str:
    h = hashlib.sha1(sig.encode())
    for i in images:
        h.update(hashlib.sha1(i).digest())
    h.update(f"{getattr(backend, 'name', '')}:{getattr(backend, 'model', '')}".encode())
    return h.hexdigest()[:20]


def compiled_prompt(look_in: dict | None, scene: dict | None, target: str) -> str:
    from .compile import compile_look
    look = {k: v for k, v in (look_in or {}).items() if k != "frame_prompts"}
    r = compile_look(look, scene)
    return r["edit_prompt"] if target == "edit" else r["still_prompt"]


def auto_prompt(look: dict | None, scene: dict | None, target: str, frame: bytes | None, refs: list[tuple[bytes, str]] = (),
                backend: Backend | None = None, force: bool = False, steps: int | None = None,
                timeout: float = TIMEOUT_S) -> dict:
    """Write the frame prompt for one shot, in up to four variants (VARIANTS) from one vision-model call. Never raises:
    a missing, slow or invalid LLM gives the compiled prompt. Every variant is the compiled prompt's stage words plus
    the LLM's own (checked: required_facts / validate); `prompt` is the first variant's.
    Returns {source: auto|compiled, prompt, variant, variants: [{key, label, prompt, words, builtin, notes}], compiled,
    seen, changed, notes, problems, backend, model, sig, cached, ms}."""
    t0 = time.time()
    target = target if target in TARGETS else "still"
    look = {k: v for k, v in (look or {}).items() if k != "frame_prompts"}
    scene = scene or {}
    facts = stage_facts(look, scene)
    sig = facts_sig(facts, target)
    compiled = compiled_prompt(look, scene, target)
    base = {"source": "compiled", "prompt": compiled, "compiled": compiled, "seen": "", "changed": "", "notes": [],
            "problems": [], "backend": getattr(backend, "name", "none"), "model": getattr(backend, "model", ""),
            "sig": sig, "target": target, "cached": False, "variant": "", "variants": []}

    def done(r):
        r["ms"] = int((time.time() - t0) * 1000)
        return r

    if backend is None:
        return done({**base, "notes": ["No local vision model: the compiled prompt is used."]})
    refs = [(b, lab) for b, lab in refs][:MAX_REFS]
    images = ([frame] if frame else []) + [b for b, _ in refs]
    key = cache_key(sig, images, backend)
    if not force and key in _CACHE:
        return done({**_CACHE[key], "cached": True})
    if not frame:
        return done({**base, "notes": ["No stage frame was sent: the compiled prompt is used."]})
    prompt = user_prompt(facts, [lab for _, lab in refs], target) + f"\n(shot_id={facts['shot_id']})"
    try:
        backend.temperature = 0.7 if force else 0.0
        reply = backend.generate(SYSTEM, prompt, images, timeout)
        llm = parse_reply(reply)
    except Exception as e:  # noqa: BLE001 - slow, missing or broken: the compiled prompt
        return done({**base, "notes": [f"The vision model gave no usable answer ({type(e).__name__}: {str(e)[:120]}): "
                                       "the compiled prompt is used."]})
    built = build_variants(look, scene, llm, target, compiled, steps)
    vs = built["variants"]
    problems = list(built["dropped"]) if not vs else []
    if vs and not built["llm_words"]:
        problems.append("the vision model's words did not survive the checks")
    if problems or not vs:
        return done({**base, "seen": llm["seen"], "changed": llm["changed"], "problems": problems or ["no variant passed the checks"],
                     "llm": llm, "notes": ["The written prompt failed the checks: the compiled prompt is used."]})
    first = vs[0]
    res = {**base, "source": "auto", "prompt": first["prompt"], "variant": first["key"], "variants": vs, "llm": llm,
           "seen": _limit_words(llm["seen"], 30), "changed": _limit_words(llm["changed"], 30),
           "notes": first["notes"] + built["dropped"], "used": {"setting": first["words"], "looks": first["looks"]}}
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = res
    return done(res)


_STATUS: dict = {"t": 0.0, "v": None}


def status(base_url: str | None = None, max_age: float = 30.0) -> dict:
    """Is Auto possible here? Cached for max_age seconds (④ Frame asks each time it opens)."""
    if _STATUS["v"] is not None and time.time() - _STATUS["t"] < max_age:
        return _STATUS["v"]
    _STATUS["v"], _STATUS["t"] = _status(base_url), time.time()
    return _STATUS["v"]


def _status(base_url: str | None) -> dict:
    b = pick_backend(base_url)
    if b is None:
        return {"available": False, "backend": "none", "model": "",
                "reason": "No local vision model: install one in Ollama (qwen3-vl:4b) or put Qwen3-VL "
                          "(qwen3vl_4b_fp8_scaled.safetensors, Krea 2's text encoder) in models/text_encoders."}
    return {"available": True, "backend": b.name, "model": b.model, "reason": ""}


def apply_override(result: dict, look_in: dict | None, scene: dict | None) -> dict:
    """compile_look's last step: a shot's frame prompt from ④ Frame (the Look JSON's `frame_prompts`, by shot id)
    replaces the compiled still or edit prompt. Manual text is used as typed. An Auto text whose stage signature no
    longer matches (someone moved, a person was added) is stale: the compiled prompt stays, with a note."""
    fp = (look_in or {}).get("frame_prompts") if isinstance(look_in, dict) else None
    sid = (scene or {}).get("shot_id") if isinstance(scene, dict) else None
    entry = fp.get(sid) if isinstance(fp, dict) and sid else None
    if not isinstance(entry, dict):
        return result
    text = str(entry.get("text") or "").strip()
    source = entry.get("source")
    target = entry.get("target") if entry.get("target") in TARGETS else None
    if source not in ("auto", "manual") or not text or not target:
        return result
    out = "edit_prompt" if target == "edit" else "still_prompt"
    if source == "auto":
        clean = {k: v for k, v in (scene or {}).items() if k != "frame1_layout"}
        sig = facts_sig(stage_facts(result.get("look") or {}, clean), target)
        if entry.get("sig") and entry["sig"] != sig:
            result["notes"] = list(result.get("notes") or []) + [
                "④ Frame's Auto prompt was written for an earlier stage: the compiled prompt is used. Rewrite it."]
            result["frame_prompt"] = {"source": "compiled", "stale": True, "target": target}
            return result
    result["frame_prompt"] = {"source": source, "target": target, "compiled": result[out]}
    result[out] = text
    return result
