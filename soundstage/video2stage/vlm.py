"""What is in the clip: the pod's vision LLM reads the first and last frames, THROUGH THE COMFYUI QUEUE.

The model names the subjects, vehicles and set pieces, gives each a box on a 0-1000 grid, and says which way
things face and whether they move. Boxes are rough; the camera tracker and the ground plane turn them into
metres. parse_reply() never trusts the model's JSON to be whole or well-typed.
"""
from __future__ import annotations

import json
import re

MODELS = ["qwen3.5_4b_bf16.safetensors"]

SYSTEM = (
    "You break one frame of a film shot down into a 3D previz layout. Reply with JSON only, no prose:\n"
    '{"setting":"a few words","time":"dawn|morning|midday|afternoon|golden hour|dusk|night|overcast",'
    '"camera":{"height_m":number,"type":"ground|handheld|vehicle|drone|crane"},'
    '"objects":[{"label":"short description","kind":"person|car|pickup|suv|van|truck|bus|motorcycle|bicycle|'
    'horse|dog|boat|other","color":"#rrggbb","bbox":[x0,y0,x1,y1],'
    '"facing":"toward camera|away from camera|left|right","moving":true}],'
    '"set":[{"type":"road|ocean|lake|river|beach|cliff|hill|mountain|shrubs|trees|rocks|building|wall|'
    'guardrail|grass|sidewalk|plaza|bench|table|chair|lamp","side":"left|right|ahead|centre|all","distance":"near|mid|far",'
    '"lanes":0,"bbox":[x0,y0,x1,y1]}]}\n'
    "bbox is on a 0-1000 grid over the whole image. List every vehicle, person and animal separately "
    "(at most 12). side is as seen from the camera. Describe people by clothing and colour only, never identity."
)
PROMPT_FIRST = "This is the FIRST frame of the shot. Break it down."
PROMPT_LAST = "This is the LAST frame of the same shot. Break it down."

KINDS = {"person", "car", "pickup", "suv", "van", "truck", "bus", "motorcycle", "bicycle", "horse", "dog", "boat", "other"}
SET_TYPES = {"road", "ocean", "lake", "river", "beach", "cliff", "hill", "mountain", "shrubs", "trees", "rocks",
             "building", "wall", "guardrail", "grass", "sidewalk", "plaza", "bench", "lamp"}
SET_SYNONYMS = {"sea": "ocean", "water": "ocean", "highway": "road", "street": "road", "freeway": "road",
                "asphalt": "road", "bushes": "shrubs", "bush": "shrubs", "shrub": "shrubs", "tree": "trees",
                "forest": "trees", "rock": "rocks", "boulders": "rocks", "mountains": "mountain",
                "hills": "hill", "cliffs": "cliff", "house": "building", "houses": "building", "buildings": "building",
                "fence": "wall", "railing": "guardrail", "barrier": "guardrail", "pavement": "sidewalk",
                "square": "plaza", "courtyard": "plaza", "lawn": "grass", "sand": "beach", "streetlight": "lamp",
                "lamppost": "lamp", "desk": "table", "counter": "table", "armchair": "chair", "stool": "chair",
                "seat": "chair", "sky": None, "clouds": None, "sun": None}
VEHICLES = {"car", "pickup", "suv", "van", "truck", "bus"}
KIND_WORDS = [("pickup", ["pickup", "pick-up", "utility vehicle", "ute"]), ("suv", ["suv", "jeep", "4x4"]),
              ("van", ["van", "minivan"]), ("bus", ["bus", "coach"]), ("truck", ["truck", "lorry", "semi", "fire engine"]),
              ("motorcycle", ["motorcycle", "motorbike", "scooter", "moped"]), ("bicycle", ["bicycle", "bike", "cyclist"]),
              ("horse", ["horse", "pony"]), ("dog", ["dog", "puppy"]), ("boat", ["boat", "ship", "yacht"]),
              ("car", ["car", "sedan", "taxi", "coupe", "hatchback", "vehicle"]),
              ("person", ["person", "man", "woman", "child", "people", "pedestrian", "driver", "rider", "runner",
                          "walker", "girl", "boy", "lady", "guy"])]


def available_model() -> str | None:
    try:
        import folder_paths
        names = set(folder_paths.get_filename_list("text_encoders") or [])
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return None
    return next((m for m in MODELS if m in names), None)


def graph(model: str, first_image: str, last_image: str) -> dict:
    """Two reads (first and last frame) in one queued prompt, sharing one model load."""
    g = {
        "v1": {"class_type": "CLIPLoader", "inputs": {"clip_name": model, "type": "stable_diffusion", "device": "default"}},
        "v2": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": SYSTEM}},
    }
    for tag, img, prompt in (("a", first_image, PROMPT_FIRST), ("b", last_image, PROMPT_LAST)):
        g[f"{tag}1"] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[f"{tag}2"] = {"class_type": "TextGenerate", "inputs": {
            "clip": ["v1", 0], "image": [f"{tag}1", 0], "prompt": prompt, "max_length": 1600, "sampling_mode": "off",
            "thinking": False, "use_default_template": True, "system_prompt": ["v2", 0]}}
        g[f"{tag}3"] = {"class_type": "PreviewAny", "inputs": {"source": [f"{tag}2", 0]}}
    return g


def _json_obj(text: str):
    t = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    t = re.sub(r"^```(?:json)?|```\s*$", "", t.strip(), flags=re.M)
    starts = sorted(i for i in (t.find("{"), t.find("[")) if i >= 0)
    for i in starts:   # the outermost value first, as is, then repaired; only then an inner list
        src = t[i:]
        try:
            return json.JSONDecoder().raw_decode(src)[0]
        except ValueError:
            pass
        # The model closes a list with "}" or runs out of tokens mid-list: balance the brackets.
        for cand in (src, re.sub(r",\s*\{[^{}]*$", "", src)):   # as is, then without a half-written last item
            try:
                return json.loads(_balance(cand))
            except ValueError:
                pass
    raise ValueError("the model did not return JSON")


def _balance(s: str) -> str:
    """Insert missing closers where the model closed the wrong bracket, and close what is still open."""
    out, stack = [], []
    in_str = esc = False
    for ch in s:
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if ch not in stack:
                continue   # a stray closer
            while stack and stack[-1] != ch:
                out.append(stack.pop())
            stack.pop()
        out.append(ch)
        if not stack and ch in "}]":
            break
    tail = "".join(out).rstrip()
    if in_str:
        tail += '"'
    tail = re.sub(r",\s*$", "", tail)
    tail = re.sub(r',\s*"[^"]*"\s*:?\s*$', "", tail)   # a dangling key
    return tail + "".join(reversed(stack))


def _bbox(v):
    if isinstance(v, dict):
        v = [v.get("x0", v.get("x1")), v.get("y0", v.get("y1")), v.get("x1", v.get("x2")), v.get("y1", v.get("y2"))]
    if not isinstance(v, (list, tuple)) or len(v) < 4:
        return None
    try:
        x0, y0, x1, y1 = (float(x) for x in v[:4])
    except (TypeError, ValueError):
        return None
    if max(x0, y0, x1, y1) <= 1.0001:   # 0-1 normalised slipped in
        x0, y0, x1, y1 = x0 * 1000, y0 * 1000, x1 * 1000, y1 * 1000
    x0, x1 = sorted((min(max(x0, 0), 1000), min(max(x1, 0), 1000)))
    y0, y1 = sorted((min(max(y0, 0), 1000), min(max(y1, 0), 1000)))
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]


def resolve_kind(kind: str, label: str = "") -> str:
    k = str(kind or "").lower().strip()
    if k in KINDS and k not in ("other", "car"):
        return k
    text = f"{label} {k}".lower()
    for name, words in KIND_WORDS:
        if any(re.search(rf"\b{re.escape(w)}s?\b", text) for w in words):
            return name
    return k if k in KINDS else "other"


def _color(v):
    s = str(v or "").strip()
    return s.lower() if re.fullmatch(r"#[0-9a-fA-F]{6}", s) else None


def _facing(v) -> str:
    s = str(v or "").lower()
    if "toward" in s or "front" in s or s == "camera":
        return "toward"
    if "away" in s or "back" in s:
        return "away"
    if "left" in s:
        return "left"
    if "right" in s:
        return "right"
    return ""


def _side(v) -> str:
    s = str(v or "").lower()
    for k in ("left", "right", "ahead", "centre", "center", "all", "both", "behind"):
        if k in s:
            return {"center": "centre", "both": "all", "behind": "ahead"}.get(k, k)
    return "ahead"


def parse_reply(text: str) -> dict:
    """Model text -> {setting, time, camera{height_m, type}, objects[], set[]}, every field typed and clamped."""
    obj = _json_obj(text)
    if isinstance(obj, list):   # it sometimes answers with the bare object list
        obj = {"objects": obj}
    if not isinstance(obj, dict):
        raise ValueError("the model did not return a JSON object")
    cam = obj.get("camera") if isinstance(obj.get("camera"), dict) else {}
    try:
        h = float(cam.get("height_m"))
        h = h if 0.2 <= h <= 500 else None
    except (TypeError, ValueError):
        h = None
    objects = []
    for o in obj.get("objects") or []:
        if not isinstance(o, dict):
            continue
        bb = _bbox(o.get("bbox") or o.get("bbox_px") or o.get("box"))
        if bb is None:
            continue
        label = str(o.get("label") or o.get("name") or o.get("kind") or "object")[:60]
        kind = resolve_kind(o.get("kind"), label)
        if kind == "other":
            st = SET_SYNONYMS.get(label.lower(), label.lower())
            if st in SET_TYPES:   # a set piece listed as an object
                continue
        mv = o.get("moving")
        objects.append({"label": label, "kind": kind, "color": _color(o.get("color")), "bbox": bb,
                        "facing": _facing(o.get("facing")),
                        "moving": mv if isinstance(mv, bool) else str(mv).lower() in ("true", "yes", "1")})
    sets = []
    for s in obj.get("set") or obj.get("set_pieces") or []:
        if isinstance(s, str):
            s = {"type": s}
        if not isinstance(s, dict):
            continue
        t = str(s.get("type") or s.get("label") or "").lower().strip()
        t = SET_SYNONYMS.get(t, t)
        if t not in SET_TYPES:
            t = next((v for k, v in SET_SYNONYMS.items() if v and k in str(s.get("type") or "").lower()), None) or \
                next((k for k in SET_TYPES if k in str(s.get("type") or "").lower()), None)
        if not t:
            continue
        try:
            lanes = int(float(s.get("lanes") or 0))
        except (TypeError, ValueError):
            lanes = 0
        dist = str(s.get("distance") or "mid").lower()
        sets.append({"type": t, "side": _side(s.get("side")), "distance": dist if dist in ("near", "mid", "far") else "mid",
                     "lanes": min(max(lanes, 0), 10), "bbox": _bbox(s.get("bbox"))})
    return {"setting": str(obj.get("setting") or "")[:120], "time": str(obj.get("time") or "").lower()[:30],
            "camera": {"height_m": h, "type": str(cam.get("type") or "").lower()[:20]},
            "objects": objects[:16], "set": sets[:20]}


def merge_reads(first: dict, last: dict | None) -> dict:
    """The first frame describes the set; objects carry {bbox_start, bbox_end} matched across the two reads."""
    last = last or {"objects": []}
    ends = list(last.get("objects") or [])
    used = set()
    out = []
    for o in first.get("objects") or []:
        best, bi = None, None
        for i, e in enumerate(ends):
            if i in used or (e["kind"] != o["kind"] and not (e["kind"] in VEHICLES and o["kind"] in VEHICLES)):
                continue   # a pickup read as a "tow truck" in the other frame is still the same vehicle
            words = set(o["label"].lower().split()) & set(e["label"].lower().split())
            col = 0.0 if not (o["color"] and e["color"]) else _col_dist(o["color"], e["color"])
            # Shared words and similar colour first; then the nearer box (things rarely swap places).
            cost = -2.0 * len(words) + col * 3 + _box_dist(o["bbox"], e["bbox"]) / 1000 + (e["kind"] != o["kind"]) * 1.5
            if best is None or cost < best:
                best, bi = cost, i
        o = dict(o, bbox_start=o["bbox"], bbox_end=None)
        if bi is not None:
            used.add(bi)
            o["bbox_end"] = ends[bi]["bbox"]
            o["moving"] = o["moving"] or ends[bi]["moving"]
            if _area(ends[bi]["bbox"]) > _area(o["bbox"]):   # seen closer at the end: trust that read of what it is
                o["kind"] = ends[bi]["kind"]
                o["color"] = o["color"] or ends[bi]["color"]
        out.append(o)
    for i, e in enumerate(ends):   # in the last frame only: entered during the shot
        if i not in used:
            out.append(dict(e, bbox_start=None, bbox_end=e["bbox"]))
    res = dict(first)
    res["objects"] = out
    if not res.get("set") and last.get("set"):
        res["set"] = last["set"]
    if not res["camera"].get("height_m") and (last.get("camera") or {}).get("height_m"):
        res["camera"] = dict(res["camera"], height_m=last["camera"]["height_m"])
    res["camera_end"] = last.get("camera") or {}
    return res


def _area(b) -> float:
    return (b[2] - b[0]) * (b[3] - b[1])


def _col_dist(a: str, b: str) -> float:
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return sum(abs(x - y) for x, y in zip(pa, pb)) / 765


def _box_dist(a, b) -> float:
    return ((a[0] + a[2] - b[0] - b[2]) ** 2 + (a[1] + a[3] - b[1] - b[3]) ** 2) ** 0.5 / 2
