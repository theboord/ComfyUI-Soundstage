"""④ Frame's Auto prompt: a local vision LLM looks at frame 1 of the stage and the cast pictures, and writes the words
of the frame prompt. Mike, 2026-11-09: "Can the LLM that we have in there, Qwen, design a prompt by looking and
understanding what needs to go in it with the character you add and everything?"

What the LLM writes, and what it does not. The measured rules (C22c, C26, C28, C31) stay in code, because a 4B
vision model does not keep them reliably:
  - FLUX Klein wants a short edit instruction ("Turn image 1 … into a real photograph of the same shot: keep …"),
    Krea 2 + depth the camera-block description: the FORM is assembled here, per target model;
  - each person is named once (a woman named twice came out as two women): the head count and the one people phrase
    come from the stage, the LLM only adds what each person looks like, with no noun;
  - placement and size words can override the reference: they come from the stage (Krea) or from image 1 (Klein),
    never from the LLM, and an LLM clause that places someone, or a prop on the wrong side, is dropped;
  - no quality tags (8k, masterpiece …), no names (the image model does not know them), nothing after frame 1.
The LLM writes: `setting` (the place in frame 1 as a real set: surfaces, materials, the props it can see, the light),
`people[].looks` (age, hair, build from the cast picture) and two notes for the user, `seen` and `changed`.
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

VERSION = 1
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
    return {
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


# ------------------------------------------------------------------------------------------------ the LLM's brief

SYSTEM = (
    "You help paint the first frame of a film shot. Image 1 is a plain 3D stage render of that frame: simple "
    "mannequins stand in for the actors and plain shapes for the furniture; the camera, the framing and where everyone "
    "stands are already right. Any further images are cast pictures: what each person really looks like.\n"
    "Reply with JSON only:\n"
    '{"seen": "one short sentence: what image 1 shows",\n'
    ' "setting": "one sentence, at most 30 words: the place in this frame as a real film set: walls, floor, the '
    'furniture and props you can see in image 1 with their real materials and colours, and the light",\n'
    ' "people": [{"id": "<the id from the list>", "looks": "at most 14 words: age, hair, build and face from that '
    'person\'s cast picture"}],\n'
    ' "changed": "one short sentence: what you left out of the director\'s notes, and why"}\n'
    "Rules. Describe frame 1 only, as a still photograph: no movement, nothing that happens later. People appear only "
    "in \"people\", once each, never in \"setting\". No names, no clothes in \"looks\" (the stage sets the clothes). "
    "No positions or sizes (left, right, centre, foreground, background, close-up): the stage sets them. "
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
        lines.append("- also in frame: " + ", ".join(facts["others"]))
    if facts["props"]:
        lines.append("- set pieces in frame: " + ", ".join(p["word"] for p in facts["props"]))
    if facts["notes"]:
        lines.append(f"- the director's notes: {facts['notes']}")
    lines.append("- the image model: " + ("an edit model that turns image 1 into a photograph" if target == "edit"
                                          else "a depth-guided image model that paints from a description"))
    lines.append("Write the JSON.")
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------ parse + validate

def parse_reply(text: str) -> dict:
    """The LLM's JSON, forgiving (video2stage.vlm's reader). Raises ValueError when there is none."""
    from ..video2stage.vlm import _json_obj
    obj = _json_obj(text)
    if not isinstance(obj, dict):
        raise ValueError("the model did not return a JSON object")
    people = obj.get("people") if isinstance(obj.get("people"), list) else []
    return {"seen": str(obj.get("seen") or "").strip(), "setting": str(obj.get("setting") or "").strip(),
            "people": [p if isinstance(p, dict) else {"looks": str(p)} for p in people],
            "changed": str(obj.get("changed") or "").strip()}


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


def clean_setting(text: str, facts: dict) -> tuple[str, list[str]]:
    """The LLM's setting sentence, frame-1 true: clauses naming a person, a name, a later beat, a quality tag, or a
    prop on the wrong side go; a placement word on its own stays only when it agrees with the stage. Returns
    (text, notes on what went)."""
    from .compile import frame1_safe
    notes: list[str] = []
    names = [n for n in facts.get("names") or [] if n]
    name_re = re.compile(r"\b(?:" + "|".join(re.escape(n) for n in names) + r")\b", re.I) if names else None
    keep = []
    for c in _clauses(frame1_safe(text, (), names) if text else ""):
        if _PERSON_NOUN_RE.search(c) or re.search(r"\b(?:she|he|her|his|they|their|them)\b", c, re.I) or \
                (name_re and name_re.search(c)):
            notes.append(f"dropped “{c}” (people are said once, from the stage)")
            continue
        if _LATER_WORDS.search(c):
            notes.append(f"dropped “{c}” (after frame 1)")
            continue
        side = _SIDE_RE.search(c)
        if side:
            prop = next((p for p in facts.get("props") or []
                         if re.search(r"\b" + re.escape(re.sub(r"^(?:a|an) ", "", p["word"])) + r"s?\b", c, re.I)), None)
            if not prop or prop["side"] != side.group(1).lower():
                notes.append(f"dropped “{c}” (a placement the stage does not have)")
                continue
        keep.append(c)
    out = ", ".join(keep)
    for w in banned_in(out):
        notes.append(f"removed “{w}” (a quality tag)")
    out = re.sub(r"\s{2,}", " ", _BANNED_RE.sub("", out)).strip(" ,")
    out = re.sub(r",\s*,", ",", out)
    return _limit_words(out, 40), notes


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


# ------------------------------------------------------------------------------------------------ assemble

def _sep(words: str) -> str:
    """'the man in his forties' / 'the man wearing …' read on; 'the man, forties, short grey hair' needs the comma."""
    return " " if re.match(r"(?:in|with|wearing|aged)\b", words or "") else ", "


def assemble(look_in: dict | None, scene: dict | None, llm: dict, target: str, steps: int | None = None) -> dict:
    """The frame prompt in the target model's form, built from the stage's structure and the LLM's words.
    Returns {"prompt", "notes": [...], "used": {"setting", "looks": {id: text}}}."""
    from ..cine.prompts import SIZE_STILL, _cap, _join
    from .compile import (NUM, REAL_PEOPLE, _only_blocking, _still_count, camera_block, look_context, look_parts,
                          real_people_wanted, skin_fabric_tail)
    from .identity import wardrobe
    from .sfx import without_rigs
    from .vocab import normalize_look
    look, _ = normalize_look({k: v for k, v in (look_in or {}).items() if k != "frame_prompts"})
    scene = without_rigs(scene or {})
    facts = stage_facts(look, scene)
    parts = look_parts(look, look_context(scene))
    f1 = S.frame1_facts(scene)
    photo = real_people_wanted(look) and scene.get("look_start") is not False
    edit = target == "edit"
    cam = camera_block(look, scene, parts, f1, steps, edit) if photo else None
    names = facts["names"]
    notes: list[str] = []
    setting, n1 = clean_setting(llm.get("setting", ""), facts)
    notes += n1
    by_pid = {str(p.get("id") or ""): p for p in llm.get("people") or [] if isinstance(p, dict)}
    looks: dict[str, str] = {}
    unmatched = [p for p in llm.get("people") or [] if isinstance(p, dict) and str(p.get("id") or "") not in
                 {q["id"] for q in facts["people"]}]
    for i, p in enumerate(facts["people"]):
        raw = by_pid.get(p["id"]) or (unmatched[i] if i < len(unmatched) else None)
        t, n2 = clean_looks((raw or {}).get("looks", ""), p, names)
        notes += n2
        if t:
            looks[p["id"]] = t
    by_id = {a.get("id"): a for a in scene.get("actors") or []}

    def wear_of(e):
        w = wardrobe(scene, by_id.get(e["id"]) or e["actor"], look)
        return _join([looks.get(e["id"], ""), w])

    n = len(f1["people"])
    inside = f1["location"]["int_ext"] == "INT"
    palette = "black and white" if parts["bw"] else parts["palette_still"]
    if edit:
        others = f1["others"]
        if n == 1 and not others:
            marks = f"{S.definite(f1['people'][0]['noun'])}'s position, size and pose"
        elif n or others:
            marks = "every person's and object's position, size and pose"
        else:
            marks = "every object's position and size"
        place = "room" if inside else "location"
        head = (f"Turn image 1, a plain 3D stage render, into a real photograph of the same shot: keep the {place}, "
                f"the camera, and {marks} exactly.")
        block = (_cap(cam["text"].replace("photograph shot on", "Shot on", 1)) + ".") if cam else ""
        if n == 1:
            who = f"Exactly one {re.sub(r'^(?:a|an|the) ', '', f1['people'][0]['noun'])}, {wear_of(f1['people'][0])}"
        elif n:
            who = f"Exactly {NUM.get(n, n)} people: " + "; ".join(
                f"{S.definite(e['noun'])}{_sep(wear_of(e))}{wear_of(e)}" for e in sorted(f1["people"], key=lambda e: e["sx"]))
        else:
            who = ""
        tail = _join([who, skin_fabric_tail(scene, f1, look, short=True) if n and photo else "",
                      "real materials on every surface", f"nobody else in the {'room' if inside else 'frame'}" if n else ""])
        if not photo:   # a drawn or rendered look: the generic instruction, then the words
            from ..router.edit_graph import frame_instruction
            prompt = frame_instruction(_join([setting, who, palette]))
        else:
            prompt = " ".join(x for x in (head, block, _cap(setting) + "." if setting else "", _cap(tail) + ".",
                                          _cap(palette) + "." if palette else "") if x)
    else:
        people = S.person_still_phrase(f1["people"], f1["camera"], wear_of) if n else ""
        props = "; ".join(f"{p['word']} {p['where']}" for p in f1["props"][:3])
        prompt = _join([
            cam["text"] if cam else "film still",
            setting,
            SIZE_STILL[f1["size"]] + ("" if n or f1["others"] else " of the location"),
            people,
            S.group_phrase(f1["others"], f1["camera"]) and "; ".join(S.group_phrase(f1["others"], f1["camera"])),
            _still_count(n),
            REAL_PEOPLE if n and photo else "",
            _only_blocking(n, sum(1 for e in f1["others"] if e.get("rig") == "vehicle")),
            "" if cam else f"{round(f1['focal_mm'])}mm lens",
            props,
            f1["lighting"],
            palette,
            skin_fabric_tail(scene, f1, look) if cam and n else "",
        ])
    for w in banned_in(prompt):   # the look's own words never carry one (compile's test), but say so if they do
        notes.append(f"removed “{w}” (a quality tag)")
    prompt = re.sub(r"\s{2,}", " ", _BANNED_RE.sub("", prompt)).replace(" ,", ",")
    return {"prompt": prompt, "notes": notes, "used": {"setting": setting, "looks": looks}}


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
                "options": {"temperature": 0, "num_predict": 400, "num_ctx": 8192},
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
                 "max_length": 500, "sampling_mode": "off", "thinking": False, "use_default_template": True,
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
    """Write the frame prompt for one shot. Never raises: a missing, slow or invalid LLM gives the compiled prompt.
    Returns {source: auto|compiled, prompt, compiled, seen, changed, notes, problems, backend, model, sig, cached, ms}."""
    t0 = time.time()
    target = target if target in TARGETS else "still"
    look = look or {}
    scene = scene or {}
    facts = stage_facts(look, scene)
    sig = facts_sig(facts, target)
    compiled = compiled_prompt(look, scene, target)
    base = {"source": "compiled", "prompt": compiled, "compiled": compiled, "seen": "", "changed": "", "notes": [],
            "problems": [], "backend": getattr(backend, "name", "none"), "model": getattr(backend, "model", ""),
            "sig": sig, "target": target, "cached": False}

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
        reply = backend.generate(SYSTEM, prompt, images, timeout)
        llm = parse_reply(reply)
    except Exception as e:  # noqa: BLE001 - slow, missing or broken: the compiled prompt
        return done({**base, "notes": [f"The vision model gave no usable answer ({type(e).__name__}: {str(e)[:120]}): "
                                       "the compiled prompt is used."]})
    out = assemble(look, scene, llm, target, steps)
    problems = check_prompt(out["prompt"], facts)
    if not out["used"]["setting"] and not out["used"]["looks"]:
        problems.append("the vision model's words did not survive the checks")
    if problems:
        return done({**base, "seen": llm["seen"], "changed": llm["changed"], "problems": problems, "llm": llm,
                     "notes": out["notes"] + ["The written prompt failed the checks: the compiled prompt is used."]})
    res = {**base, "source": "auto", "prompt": out["prompt"], "llm": llm, "seen": _limit_words(llm["seen"], 30),
           "changed": _limit_words(llm["changed"], 30), "notes": out["notes"], "used": out["used"]}
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
