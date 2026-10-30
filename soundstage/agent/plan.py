"""Scene text -> plan. The plan is the small, symbolic thing the LLM is asked for; build.py turns it into
coordinates. Small models are good at "which set, who is in it, what props" and bad at metres, so the
LLM never places anything: placement, lights and cameras are rules.

Plan format (also the LLM's output format, see prompts.BUILD_SYSTEM):
{"set": str, "time": str, "weather": str, "genre": str,
 "cast": [{"name": str, "kind": "man|woman|child|dog|horse", "role": str}],
 "props": [str],                      # library words ("car", "table") or free text ("jukebox")
 "blocking": "alone|face_off|across_table|side_by_side|group|chase|rescue|walk_and_talk",
 "lights": ["key"|"fill"|"rim"|"practical"|"spot"|"neon"],
 "shots": int}                        # 1-4 camera setups
"""
from __future__ import annotations

import json
import re

from . import catalog as C

BLOCKINGS = ["alone", "face_off", "across_table", "side_by_side", "group", "chase", "rescue", "walk_and_talk"]
KINDS = ["man", "woman", "child", "dog", "horse", "cat"]

NUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "a pair of": 2, "pair of": 2, "both": 2}
ROLE_WORDS = {  # role noun -> default kind
    "gunfighter": "man", "gunslinger": "man", "cowboy": "man", "sheriff": "man", "outlaw": "man", "bandit": "man",
    "detective": "man", "cop": "man", "officer": "man", "agent": "man", "soldier": "man", "man": "man", "guy": "man",
    "boy": "child", "girl": "child", "kid": "child", "child": "child", "woman": "woman", "lady": "woman",
    "waitress": "woman", "waiter": "man", "bartender": "man", "nurse": "woman", "doctor": "man", "mother": "woman",
    "father": "man", "friend": "man", "diver": "man", "swimmer": "woman", "runner": "man", "thief": "man",
    "killer": "man", "stranger": "man", "suspect": "man", "witness": "woman", "reporter": "woman", "boss": "man",
    "king": "man", "queen": "woman", "samurai": "man", "knight": "man", "pilot": "man", "dancer": "woman",
    "lover": "woman", "brother": "man", "sister": "woman", "roommate": "woman", "neighbor": "man", "rescuer": "man",
    "victim": "woman", "teenager": "child", "student": "woman", "teacher": "man", "dog": "dog", "horse": "horse",
    "cat": "cat", "person": "man", "people": "man", "couple": "woman", "rival": "man", "partner": "woman",
    "robot": "man", "ghost": "woman", "old man": "man", "old woman": "woman", "young man": "man",
    "young woman": "woman", "henchman": "man", "villain": "man", "hero": "man", "heroine": "woman",
}
PLURAL = {"men": "man", "women": "woman", "children": "child", "kids": "kid", "people": "person", "thieves": "thief",
          "ladies": "lady", "gunmen": "gunfighter", "policemen": "cop", "henchmen": "henchman"}
MALE = re.compile(r"\b(he|his|him|himself)\b")
FEMALE = re.compile(r"\b(she|her|hers|herself)\b")

HAND_PROPS = ["gun", "guns", "rifle", "pistol", "revolver", "shotgun", "hat", "cap", "cup", "mug", "glass", "phone",
              "book", "cigarette", "cigar", "knife", "bag", "letter", "coin", "badge", "bottle", "key", "keys", "ring",
              "watch", "sword", "flashlight", "torch", "wallet", "pen", "paper", "papers", "note", "menu", "plate",
              "fork", "spoon", "coat", "jacket", "boots", "gloves", "mask", "glasses", "sunglasses", "umbrella",
              "camera", "microphone", "remote", "popcorn", "drink", "drinks", "coffee", "milkshake", "burger", "food"]

# Scene-type dressing for the rules fallback: (trigger words, props).
DRESSING = [
    (["western", "gunfighter", "gunslinger", "cowboy", "saloon", "sheriff", "outlaw"],
     ["horse", "water trough", "hitching post"]),
    (["office", "detective", "precinct", "desk"], ["desk", "chair", "filing cabinet", "coat rack"]),
    (["diner", "cafe", "café", "restaurant", "first date"], ["table", "chair", "chair", "counter", "jukebox"]),
    (["living room", "sitcom", "couch", "sofa", "apartment"], ["couch", "coffee table", "tv", "armchair"]),
    (["tank", "underwater", "rescue", "diver"], ["oxygen tank", "rock"]),
    (["rooftop", "roof"], ["parapet", "ac unit", "water tower", "chimney"]),
    (["street", "alley", "city", "town"], ["car"]),
    (["forest", "woods"], ["rock", "bush"]),
    (["beach"], ["rock"]),
    (["bar", "saloon"], ["bar", "stool", "stool"]),
]


def _has(t: str, w: str) -> bool:
    return re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t) is not None


def pick(words_table, t: str, default):
    for key, words in words_table:
        if any(_has(t, w) for w in words):
            return key
    return default


def guess_cast(text: str) -> list[dict]:
    t = text.lower()
    cast: list[dict] = []
    seen_spans: list[tuple[int, int]] = []
    roles = sorted(set(ROLE_WORDS) | set(PLURAL), key=len, reverse=True)
    num_re = "|".join(sorted((re.escape(k) for k in NUM), key=len, reverse=True))
    pat = re.compile(rf"\b(?:({num_re}|his|her|the|their)\s+)?(?:[a-z\-]+\s+)?({'|'.join(map(re.escape, roles))})s?\b")
    for m in pat.finditer(t):
        if any(m.start() < e and s < m.end() for s, e in seen_spans):
            continue
        word = m.group(2)
        role = PLURAL.get(word, word)
        if role in ("couple",):
            continue
        n = NUM.get(m.group(1) or "", 1)
        if word in PLURAL or (m.group(0).endswith("s") and not word.endswith("s") and n == 1):
            n = max(n, 2)
        seen_spans.append(m.span())
        kind = ROLE_WORDS.get(role, "man")
        for i in range(min(n, 4)):
            cast.append({"name": role.capitalize() + (f" {i + 1}" if n > 1 else ""), "kind": kind, "role": role})
    if not cast and any(_has(t, w) for w in ("first date", "date", "couple", "lovers", "romance")):
        cast = [{"name": "Him", "kind": "man", "role": "date"}, {"name": "Her", "kind": "woman", "role": "date"}]
    elif any(_has(t, w) for w in ("first date", "couple", "lovers")) and len(cast) < 2:
        cast = [{"name": "Him", "kind": "man", "role": "date"}, {"name": "Her", "kind": "woman", "role": "date"}]
    if not cast and _has(t, "rescue"):
        cast = [{"name": "Rescuer", "kind": "man", "role": "rescuer"}, {"name": "Victim", "kind": "woman", "role": "victim"}]
    if not cast and _has(t, "chase"):
        cast = [{"name": "Runner", "kind": "man", "role": "runner"}, {"name": "Pursuer", "kind": "man", "role": "pursuer"}]
    if _has(t, "rescue") and len(cast) == 1:
        cast.append({"name": "Victim", "kind": "woman", "role": "victim"})
    if _has(t, "chase") and len(cast) == 1:
        cast.append({"name": "Pursuer", "kind": "man", "role": "pursuer"})
    if not cast:
        cast = [{"name": "Lead", "kind": "man", "role": "lead"}]
    # Pronouns decide the gender of a lone, gender-neutral lead ("detective alone in her office").
    if len([c for c in cast if c["kind"] in C.PEOPLE]) == 1 and FEMALE.search(t) and not MALE.search(t):
        for c in cast:
            if c["kind"] == "man":
                c["kind"] = "woman"
    # Groups of friends read better mixed.
    if len(cast) >= 3 and len({c["role"] for c in cast}) == 1 and cast[0]["kind"] == "man" and cast[0]["role"] in (
            "friend", "person", "roommate", "student"):
        for i, c in enumerate(cast):
            c["kind"] = "woman" if i % 2 else "man"
    if any(_has(t, w) for w in ("alone", "by himself", "by herself", "solitary", "lonely")):
        cast = cast[:1]
    return cast[:4]


def guess_blocking(t: str, n_people: int) -> str:
    if n_people <= 1:
        return "alone"
    if any(_has(t, w) for w in ("chase", "chases", "pursue", "pursuit", "run", "running", "flee")):
        return "chase"
    if _has(t, "rescue") or _has(t, "rescues") or _has(t, "save"):
        return "rescue"
    if any(_has(t, w) for w in ("face off", "faces off", "standoff", "showdown", "duel", "confront", "face each other")):
        return "face_off"
    if any(_has(t, w) for w in ("couch", "sofa", "lineup", "line up")) or n_people >= 3:
        return "group"
    if any(_has(t, w) for w in ("diner", "date", "table", "booth", "dinner", "restaurant", "cafe", "café",
                                "interrogation", "across from")):
        return "across_table"
    if any(_has(t, w) for w in ("walk", "walking", "stroll")):
        return "walk_and_talk"
    return "side_by_side"


# "a cowboy on a horse", "a woman riding a bicycle", "a driver in a red car", "kid sitting on a bench"
MOUNT_RE = re.compile(r"\b([a-z]+)\s+(?:on|riding|rides|astride|atop|in|inside|driving|drives|sitting on|seated on|on top of)"
                      r"\s+(?:a |an |the |his |her |their )?([a-z]+)(?:\s+([a-z]+))?")
PASS_VERBS = r"(?:rides?|riding|walks?|walking|drives?|driving|runs?|running|gallops?|galloping|cycles?|cycling|strolls?|" \
             r"races?|racing|trots?|jogs?|wanders?|marches?|speeds?|passes|passing|crosses|crossing)"
PASS_RE = re.compile(rf"\b{PASS_VERBS}\s+(?:past|by|through|across|along)\b|\b(?:passes|passing|crosses|crossing)\b")
OUTSIDE_RE = re.compile(r"\b(?:outside|in front of|out front of|exterior of|ext\.?)\s+(?:a|an|the)\s+([a-z']+(?:\s+[a-z']+)?)")


def _singular(w: str) -> str:
    return PLURAL.get(w, w[:-1] if w.endswith("s") and w[:-1] in ROLE_WORDS else w)


def find_mounts(text: str) -> list[tuple[str, str]]:
    """[(rider word, host kind)] for riders on things the stage can seat them on."""
    out = []
    for m in MOUNT_RE.finditer(text.lower()):
        rider = _singular(m.group(1))
        host = next((C.resolve_kind(w) for w in (m.group(2), m.group(3)) if w and C.resolve_kind(w) in C.MOUNTS), None)
        if host and ROLE_WORDS.get(rider) in C.PEOPLE:
            out.append((rider, host))
    return out


def find_passers(text: str) -> set[str]:
    """Words naming who travels past/through/across: the nearest cast word before the verb (may be a mount)."""
    t = text.lower()
    out = set()
    for m in PASS_RE.finditer(t):
        before = re.findall(r"[a-z]+", re.split(r"[,.;]", t[:m.start()])[-1])
        for w in reversed(before[-8:]):
            w = _singular(w)
            if w in ROLE_WORDS:
                out.add(w)
                break
    return out


def camera_intent(text: str) -> dict:
    t = text.lower()
    height = "eye"
    if re.search(r"\b(overhead|top[- ]down|bird'?s[- ]eye|god'?s[- ]eye|aerial|drone)\b", t):
        height = "overhead"
    elif re.search(r"\b(low[- ]angle|camera low|low camera|from below|worm'?s[- ]eye|low and|shot low|ground level)\b", t):
        height = "low"
    elif re.search(r"\b(high[- ]angle|camera high|high camera|from above|looking down)\b", t):
        height = "high"
    move = "static"
    if re.search(r"\b(track|tracking|tracks|follow|following|follows|travelling|traveling|dolly along|steadicam)\b", t):
        move = "track"
    return {"height": height, "move": move}


def outside_of_room(text: str) -> str:
    """'outside a diner' -> the text with the room word removed, so the set is an exterior."""
    t = text.lower()
    m = OUTSIDE_RE.search(t)
    if m and pick([("interior", next(w for k, w in C.SET_WORDS if k == "interior"))], m.group(1), None):
        return t[:m.start()] + " outside a building " + t[m.end():]
    return t


def annotate_cast(cast: list[dict], text: str, props: list[str]) -> tuple[list[dict], list[str]]:
    """Mark riders (mount) and passers (action=pass); a mounted animal/vehicle is not a second actor or prop."""
    mounts = find_mounts(text)
    passers = find_passers(text)
    low = text.lower()
    # The model may invent mounts and movers; keep only what the text grounds (the host is named, someone passes).
    for c in cast:
        grounded = [c["mount"], *[k for k, v in C.SYNONYMS.items() if v == c["mount"]]] if c.get("mount") else []
        if c.get("mount") == "horse":
            grounded += ["rider", "riders", "riding", "rides", "horseback", "mounted", "cavalry", "saddle", "gallop", "galloping"]
        if c.get("mount") and not any(_has(low, w) for w in grounded):
            c.pop("mount")
        if c.get("action") == "pass" and passers:
            c.pop("action")  # re-decided from the text below
    used_hosts: list[str] = []
    for c in cast:
        role = (c.get("role") or c.get("name") or "").lower().split()[0] if (c.get("role") or c.get("name")) else ""
        if c["kind"] in C.PEOPLE and not c.get("mount"):
            for i, (rider, host) in enumerate(mounts):
                if rider in (role, c["name"].lower().split()[0]) or (ROLE_WORDS.get(rider) == c["kind"] and rider in text.lower()
                                                                      and role in ("lead", "")):
                    c["mount"] = host
                    mounts.pop(i)
                    break
        if c.get("mount") and c["mount"] not in C.MOUNTS:
            c["mount"] = C.resolve_kind(c["mount"]) if C.resolve_kind(c["mount"]) in C.MOUNTS else None
        if not c.get("mount"):
            c.pop("mount", None)
        if role in passers or c["name"].lower().split()[0] in passers or (c.get("mount") and c["mount"] in passers):
            c["action"] = "pass"
        if c.get("mount"):
            used_hosts.append(c["mount"])
    # The rider's mount is the host: drop that many matching animals from the cast and props.
    out = []
    for c in cast:
        if c["kind"] not in C.PEOPLE and c["kind"] in used_hosts:
            used_hosts.remove(c["kind"])
            continue
        out.append(c)
    hosts = [c["mount"] for c in out if c.get("mount")]
    keep = []
    for p in props:
        k = C.resolve_kind(p)
        if k in hosts:
            hosts.remove(k)
            continue
        keep.append(p)
    # Passing on a mount: the rider's action carries to the host (handled in build).
    return out, keep


def rules_plan(text: str, genre: str = "") -> dict:
    t = f"{outside_of_room(text)} {genre}".lower()
    set_ = pick(C.SET_WORDS, t, "plaza" if not any(_has(t, w) for w in ("inside", "room")) else "interior")
    time = pick(C.TIME_WORDS, t, "night" if set_ == "street_night" and not any(_has(t, w) for w in (
        "western", "noon", "day")) else "midday")
    weather = pick(C.WEATHER_WORDS, t, "none")
    if set_ == "water_tank":
        weather = "none"
    cast = guess_cast(text)
    people = [c for c in cast if c["kind"] in C.PEOPLE]
    cast, _ = annotate_cast(cast, text, [])
    staying = [c for c in people if c.get("action") != "pass"]
    blocking = guess_blocking(re.sub(PASS_VERBS, " ", t) if len(staying) < len(people) else t, len(staying) or len(people))
    props: list[str] = []
    western = any(_has(t, w) for w in DRESSING[0][0])
    for words, items in DRESSING:
        if western and "street" in words:
            continue  # a western main street, not a city street with parked cars
        if any(_has(t, w) for w in words):
            props += [p for p in items if p not in props or p in ("chair", "stool")]
            if len(props) >= 5:
                break
    if blocking == "across_table" and "table" not in props:
        props = ["table", "chair", "chair"] + props
    if blocking == "group" and set_ == "interior" and not any(p in props for p in ("couch", "sofa", "table")):
        props = ["couch"] + props
    for adj, word in re.findall(r"\b(?:(police|squad|patrol|sports|getaway|old|vintage|red|black|white|blue|parked|pickup|delivery|garbage) )?"
                                r"(car|truck|horse|motorcycle|bicycle|bench|lamp|tree|dog)\b", t):
        name = f"{adj} {word}" if adj and adj != "parked" else word
        if name not in props and word not in props and not any(c["kind"] == word for c in cast):
            props.append(name)
    lights = []
    if time in ("night", "blue_hour") or set_ in ("interior", "studio"):
        lights = ["key", "rim"] if set_ not in ("interior",) else ["practical", "key"]
    if any(_has(t, w) for w in ("sitcom", "multi-cam", "multicam", "bright", "comedy")):
        lights = ["key", "fill", "rim"]
    if any(_has(t, w) for w in ("neon", "club", "cyberpunk")):
        lights.append("neon")
    cast, props = annotate_cast(cast, text, props)
    return {"set": set_, "time": time, "weather": weather, "genre": genre or "", "cast": cast, "props": props[:6],
            "blocking": blocking, "lights": lights[:4], "shots": 4 if len(people) >= 2 else 3,
            "camera": camera_intent(text), "text": text}


# ---- LLM plan --------------------------------------------------------------------------------------

def extract_json(text: str):
    """First JSON object in model output, forgiving common small-model slips. None if unusable."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("{")
    if start < 0:
        return None
    depth, end = 0, -1
    in_str = esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            esc = (ch == "\\") and not esc
            if ch == '"' and not esc:
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    chunk = text[start:end + 1] if end > 0 else text[start:] + "}" * max(depth, 0)
    for attempt in (chunk, re.sub(r",\s*([}\]])", r"\1", chunk), re.sub(r",\s*([}\]])", r"\1", chunk).replace("'", '"')):
        try:
            return json.loads(attempt)
        except json.JSONDecodeError:
            continue
    # Truncated inside a list: close what is open.
    fixed = re.sub(r",\s*$", "", chunk.rstrip("}"))
    for tail in ("]}", "}]}", "\"}]}", "\"]}"):
        try:
            return json.loads(fixed + tail)
        except json.JSONDecodeError:
            continue
    return None


def _norm_key(v, table, default):
    v = str(v or "").strip().lower().replace(" ", "_").replace("-", "_")
    if v in table:
        return v
    return default


def merge_llm_plan(rules: dict, raw) -> tuple[dict, list[str]]:
    """Overlay what the LLM said on the rules plan, keeping only valid values. Returns (plan, notes)."""
    notes: list[str] = []
    if not isinstance(raw, dict):
        return rules, ["LLM answer unreadable; rules plan used."]
    out = json.loads(json.dumps(rules))
    s = _norm_key(raw.get("set"), C.SETS, None)
    if s:
        out["set"] = s
    elif raw.get("set"):
        notes.append(f"unknown set '{raw.get('set')}', kept {rules['set']}")
    tm = _norm_key(raw.get("time"), C.TIME_PRESETS, None)
    if not tm and raw.get("time"):
        tm = pick(C.TIME_WORDS, str(raw.get("time")).lower(), None)
    if tm:
        out["time"] = tm
    w = _norm_key(raw.get("weather"), C.WEATHER, None)
    if w:
        out["weather"] = w
    if isinstance(raw.get("genre"), str):
        out["genre"] = raw["genre"][:40]
    cast = []
    for c in raw.get("cast") if isinstance(raw.get("cast"), list) else []:
        if isinstance(c, str):
            c = {"name": c}
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or c.get("role") or "").strip()[:40]
        kind = str(c.get("kind") or "").lower()
        if kind not in KINDS:
            kind = C.resolve_kind(kind) or C.resolve_kind(name) or ROLE_WORDS.get(name.lower(), "man")
            if kind not in KINDS:
                kind = "man"
        entry = {"name": name or kind.capitalize(), "kind": kind, "role": str(c.get("role") or name).lower()[:40]}
        host = c.get("mount") or c.get("rides")
        if isinstance(host, str) and C.resolve_kind(host) in C.MOUNTS and kind in C.PEOPLE:
            entry["mount"] = C.resolve_kind(host)
        if c.get("passes") is True or str(c.get("action", "")).lower() in ("pass", "passes", "cross", "crosses",
                                                                             "rides past", "walks past"):
            entry["action"] = "pass"
        cast.append(entry)
    if cast:
        out["cast"] = cast[:4]
    props = []
    for p in raw.get("props") if isinstance(raw.get("props"), list) else []:
        name = p.get("name") if isinstance(p, dict) else p
        if isinstance(name, str) and name.strip() and len(props) < 8:
            props.append(name.strip().lower()[:40])
    # Floor-standing dressing only: drop people and hand props (the stage stands everything on the floor),
    # then top up from the rules dressing so the set never looks bare.
    props = [p for p in props if C.resolve_kind(p) not in C.PEOPLE and not any(_has(p, w) for w in HAND_PROPS)]
    if out["set"] in ("interior", "studio"):
        props = ["floor lamp" if p in ("lamp", "lamps") else p for p in props]
    if props:
        for extra in rules["props"]:
            if len(props) >= 5:
                break
            if extra not in props and not (extra in ("chair", "stool") and extra in props):
                props.append(extra)
        out["props"] = props[:6]
    text = rules.get("text", "")
    out["cast"], out["props"] = annotate_cast(out["cast"], text, out["props"])
    b = _norm_key(raw.get("blocking"), BLOCKINGS, None)
    people = [c for c in out["cast"] if c["kind"] in C.PEOPLE and c.get("action") != "pass"]
    if b in ("chase", "walk_and_talk", "rescue") and b != rules["blocking"] and \
            guess_blocking(re.sub(PASS_VERBS, " ", text.lower()), max(2, len(people))) != b:
        b = None  # a moving pattern the text doesn't support (the model said "chase" for a ride-past)
    if b:
        out["blocking"] = b
    if len(people) <= 1:
        out["blocking"] = "alone"
    elif out["blocking"] == "alone":
        out["blocking"] = guess_blocking("", len(people))
    lights = [lt for lt in (raw.get("lights") if isinstance(raw.get("lights"), list) else []) if isinstance(lt, str) and lt.lower() in C.LIGHT_TYPES]
    if lights or raw.get("lights") == []:
        out["lights"] = [lt.lower() for lt in lights][:4]
    try:
        # Coverage floor: the model often asks for 1-2 setups; a scene with people needs a wide plus angles.
        n_people = len([c for c in out["cast"] if c["kind"] in C.PEOPLE])
        out["shots"] = max(3 if n_people >= 2 else 2, min(4, int(raw.get("shots", out["shots"]))))
    except (TypeError, ValueError):
        pass
    return out, notes
