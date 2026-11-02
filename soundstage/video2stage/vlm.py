"""What is in the clip: the pod's vision LLM reads the first and last frames, THROUGH THE COMFYUI QUEUE.

The model names the subjects, vehicles and set pieces, gives each a box on a 0-1000 grid, and says which way
things face and whether they move. Boxes are rough; the camera tracker and the ground plane turn them into
metres. parse_reply() never trusts the model's JSON to be whole or well-typed.
"""
from __future__ import annotations

import json
import re

import numpy as np

MODELS = ["qwen3.5_4b_bf16.safetensors"]
# The inventory read: Qwen3-VL 8B first (it grounds boxes on the 0-1000 grid natively); the 4B stays the fallback.
INVENTORY_MODELS = ["qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors", "qwen3.5_4b_bf16.safetensors"]

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
             "building", "wall", "guardrail", "grass", "sidewalk", "plaza", "bench", "lamp", "table", "chair", "sofa",
             "shelf", "rug", "bin", "sign", "plant", "box", "bed", "cabinet", "desk", "hydrant", "pole", "fence"}
# The scenery the per-frame breakdown (parse_reply) has always folded into the set rather than placing as an object.
# SET_TYPES grew furniture and props for the inventory; a sofa or a box the old read lists as an object still stands.
SCENERY_TYPES = frozenset({"road", "ocean", "lake", "river", "beach", "cliff", "hill", "mountain", "shrubs", "trees",
                           "rocks", "building", "wall", "guardrail", "grass", "sidewalk", "plaza", "bench", "lamp"})
SET_SYNONYMS = {"sea": "ocean", "water": "ocean", "highway": "road", "street": "road", "freeway": "road",
                "asphalt": "road", "bushes": "shrubs", "bush": "shrubs", "shrub": "shrubs", "tree": "trees",
                "forest": "trees", "rock": "rocks", "boulders": "rocks", "mountains": "mountain",
                "hills": "hill", "cliffs": "cliff", "house": "building", "houses": "building", "buildings": "building",
                "fence": "wall", "railing": "guardrail", "barrier": "guardrail", "pavement": "sidewalk",
                "square": "plaza", "courtyard": "plaza", "lawn": "grass", "sand": "beach", "streetlight": "lamp",
                "lamppost": "lamp", "desk": "table", "counter": "table", "armchair": "chair", "stool": "chair",
                "seat": "chair", "couch": "sofa", "settee": "sofa", "bookshelf": "shelf", "bookcase": "shelf",
                "shelves": "shelf", "carpet": "rug", "mat": "rug", "trash can": "bin", "dustbin": "bin", "bins": "bin",
                "signs": "sign", "signpost": "sign", "plants": "plant", "potted plant": "plant", "crate": "box",
                "boxes": "box", "cupboard": "cabinet", "dresser": "cabinet", "fire hydrant": "hydrant",
                "sky": None, "clouds": None, "sun": None}
VEHICLES = {"car", "pickup", "suv", "van", "truck", "bus"}
KIND_WORDS = [("pickup", ["pickup", "pick-up", "utility vehicle", "ute"]), ("suv", ["suv", "jeep", "4x4"]),
              ("van", ["van", "minivan"]), ("bus", ["bus", "coach"]), ("truck", ["truck", "lorry", "semi", "fire engine"]),
              ("motorcycle", ["motorcycle", "motorbike", "scooter", "moped"]), ("bicycle", ["bicycle", "bike", "cyclist"]),
              ("horse", ["horse", "pony"]), ("dog", ["dog", "puppy"]),
              ("boat", ["boat", "ship", "yacht", "dinghy", "kayak", "canoe", "speedboat", "sailboat", "ferry"]),
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
            if st in SCENERY_TYPES:   # a set piece listed as an object
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


# ============================================================================================== the inventory (LAYOUT)
INVENTORY_SYSTEM = (
    "You are a set dresser listing everything in one film frame so the set can be rebuilt in 3D. Group identical "
    "things by kind. Include furniture, props, vehicles, people, animals, plants, trees, signs, poles, street lights, "
    "lamps, bins, boxes, bags, pictures, rugs, windows, doors, and small things cut off at the frame edge. Also list "
    "the surfaces (floor, walls, ceiling, road, sidewalk, kerb, building fronts, grass, ground, water, sky).\n"
    "Reply with JSON only, in this shape:\n"
    '{"setting":"<where, 3-8 words>","interior":<true|false>,"time":"<day|night|dusk|dawn|overcast>",'
    '"camera":{"height_m":<metres>,"type":"<ground|handheld|vehicle|drone|crane>"},'
    '"things":[{"kind":"<one noun>","count":<n>,"name":"<colour + material + noun>","material":"<fabric|wood|metal|'
    'glass|plastic|stone|paper|leaf|paint|concrete|rubber|other>","color":"#rrggbb","moving":<true|false>,'
    '"boxes":[[x0,y0,x1,y1]]}],'
    '"surfaces":[{"kind":"<floor|wall|ceiling|road|sidewalk|kerb|building|grass|ground|water|sky>",'
    '"material":"<...>","color":"#rrggbb"}]}\n'
    "Every <...> is a placeholder: write what YOU see, never the placeholder. boxes are [x0,y0,x1,y1] on a 0-1000 "
    "grid over the whole image, one box per object, at most 10 boxes per kind. kind is one plain English noun. "
    "Describe people by clothing only, never identity.")
INVENTORY_PROMPT = "Inventory this frame."
INVENTORY_FRAMES = 6
# Echoes of the instructions (the model copying the schema instead of answering): such a value is rejected.
ECHOES = ("a few words", "short description", "one noun", "placeholder", "colour + material", "color + material",
          "3-8 words", "2-4 word", "what you see", "<", ">")
SURFACES = {"floor", "wall", "walls", "ceiling", "road", "street", "sidewalk", "pavement", "kerb", "curb", "building",
            "buildings", "facade", "grass", "lawn", "ground", "terrain", "water", "sea", "ocean", "lake", "river", "sky",
            "dirt", "sand", "beach", "asphalt", "plaza", "crosswalk", "mountain", "mountains", "hill", "hills"}


def inventory_model() -> str | None:
    try:
        import folder_paths
        names = set(folder_paths.get_filename_list("text_encoders") or [])
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return None
    return next((m for m in INVENTORY_MODELS if m in names), None)


def inventory_frames(n_frames: int, k: int = INVENTORY_FRAMES) -> list[int]:
    """k stage frames spread over the trim (first and last included)."""
    if n_frames <= 1:
        return [0]
    k = max(1, min(k, n_frames))
    return sorted({int(round(i * (n_frames - 1) / max(1, k - 1))) for i in range(k)})


def inventory_prompt(model: str, images: list[str], max_length: int = 1400) -> dict:
    """One TextGenerate per frame in ONE queued prompt (one model load). Outputs: node 'r<i>' per frame."""
    g = {"v1": {"class_type": "CLIPLoader", "inputs": {"clip_name": model, "type": "stable_diffusion",
                                                       "device": "default"}},
         "v2": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": INVENTORY_SYSTEM}}}
    for i, img in enumerate(images):
        g[f"l{i}"] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[f"t{i}"] = {"class_type": "TextGenerate", "inputs": {
            "clip": ["v1", 0], "image": [f"l{i}", 0], "prompt": INVENTORY_PROMPT, "max_length": int(max_length),
            "sampling_mode": "off", "thinking": False, "use_default_template": True, "system_prompt": ["v2", 0]}}
        g[f"r{i}"] = {"class_type": "PreviewAny", "inputs": {"source": [f"t{i}", 0]}}
    return g


def _echo(v) -> bool:
    s = str(v or "").strip().lower()
    return bool(s) and any(e in s for e in ECHOES)


def _clean(v, n: int = 60) -> str:
    s = str(v or "").strip()
    return "" if _echo(s) else s[:n]


def _words(s) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", str(s or "").lower())).strip()


def _kind_noun(kind: str, name: str = "") -> str:
    k = _words(kind) or (_words(name).split(" ") or [""])[-1]
    k = SET_SYNONYMS.get(k, k) or k
    if k.endswith("s") and not k.endswith(("ss", "us")) and k[:-1] in SET_TYPES | KINDS | SURFACES:
        k = k[:-1]
    return k


def parse_inventory(text: str, frame: int = 0) -> dict:
    """One frame's read -> {setting, interior, time, camera, items: [{name, kind, material, color, moving, bbox, frame}],
    surfaces: [...], echoes: n}. Repeated boxes (a greedy decode looping) and off-grid boxes are dropped; a value that
    copies the instructions is blanked and counted in `echoes`."""
    obj = _json_obj(text)
    if isinstance(obj, list):
        obj = {"things": obj}
    if not isinstance(obj, dict):
        raise ValueError("the model did not return a JSON object")
    echoes = 0
    cam = obj.get("camera") if isinstance(obj.get("camera"), dict) else {}
    try:
        h = float(cam.get("height_m"))
        h = h if 0.2 <= h <= 500 else None
    except (TypeError, ValueError):
        h = None
    items, surfaces = [], []
    things = obj.get("things") or obj.get("items") or obj.get("objects") or []
    for t in things if isinstance(things, list) else []:
        if not isinstance(t, dict):
            continue
        kind = _kind_noun(t.get("kind"), t.get("name") or t.get("label"))
        if not kind or _echo(kind):
            echoes += 1
            continue
        name = _clean(t.get("name") or t.get("label"))
        if not name and (t.get("name") or t.get("label")):
            echoes += 1
        if kind in SURFACES:
            surfaces.append({"kind": kind, "material": _clean(t.get("material"), 20), "color": _color(t.get("color"))})
            continue
        mv = t.get("moving")
        base = {"name": name or kind, "kind": kind, "material": _clean(t.get("material"), 20).lower(),
                "color": _color(t.get("color")), "moving": mv if isinstance(mv, bool) else str(mv).lower() in ("true", "yes", "1"),
                "frame": int(frame)}
        boxes = t.get("boxes") or ([t.get("bbox")] if t.get("bbox") else [])
        kept = []
        for bx in boxes if isinstance(boxes, list) else []:
            if isinstance(bx, (list, tuple)) and len(bx) >= 4 and all(isinstance(x, (int, float)) for x in bx[:4]):
                if min(bx[:4]) < -5 or max(bx[:4]) > 1005:   # off the grid: a decoding loop
                    continue
            bb = _bbox(bx)
            if bb is None or any(_iou(bb, k) > 0.85 for k in kept):
                continue
            kept.append(bb)
            if len(kept) >= 12:
                break
        try:
            count = int(float(t.get("count") or len(kept) or 1))
        except (TypeError, ValueError):
            count = len(kept) or 1
        count = max(1, min(count, 40))
        if kept:
            for bb in kept:
                items.append(dict(base, bbox=bb, count=1))
            if count > len(kept):   # more than it boxed: the rest are known by count only
                items.append(dict(base, bbox=None, count=count - len(kept)))
        else:
            items.append(dict(base, bbox=None, count=count))
    for sfc in obj.get("surfaces") or []:
        if isinstance(sfc, str):
            sfc = {"kind": sfc}
        if not isinstance(sfc, dict):
            continue
        k = _kind_noun(sfc.get("kind"))
        if k and not _echo(k):
            surfaces.append({"kind": k, "material": _clean(sfc.get("material"), 20), "color": _color(sfc.get("color"))})
    setting = _clean(obj.get("setting"), 120)
    if obj.get("setting") and not setting:
        echoes += 1
    interior = obj.get("interior")
    interior = interior if isinstance(interior, bool) else (str(interior).lower() in ("true", "yes") if interior is not None else None)
    return {"setting": setting, "interior": interior, "time": _clean(obj.get("time"), 30).lower(),
            "camera": {"height_m": h, "type": _clean(cam.get("type"), 20).lower()},
            "items": items, "surfaces": surfaces, "echoes": echoes, "frame": int(frame)}


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = _area(a) + _area(b) - inter
    return inter / u if u > 0 else 0.0


def needs_retry(read: dict | None) -> bool:
    """Unusable (no JSON) or mostly an echo of the schema: worth one retry."""
    if read is None:
        return True
    return read["echoes"] > 0 and read["echoes"] >= max(1, len(read["items"]))


def merge_inventory(reads: list[dict]) -> dict:
    """Several frames' reads -> one inventory: every item of every frame (with its frame, for naming the masks),
    per-kind counts (the largest count any one frame saw), majority setting / interior / time, the median camera
    height (ONE reconciled value)."""
    reads = [r for r in reads if r]
    if not reads:
        return {"setting": "", "interior": None, "time": "", "camera": {}, "items": [], "surfaces": [], "kinds": {}}
    kinds: dict = {}
    for r in reads:
        per: dict = {}
        for it in r["items"]:
            per[it["kind"]] = per.get(it["kind"], 0) + it.get("count", 1)
        for k, n in per.items():
            kinds[k] = max(kinds.get(k, 0), n)
    def vote(vals):
        vals = [v for v in vals if v not in (None, "")]
        return max(set(vals), key=vals.count) if vals else None
    hs = [r["camera"]["height_m"] for r in reads if r["camera"].get("height_m")]
    surf: dict = {}
    for r in reads:
        for sf in r["surfaces"]:
            surf.setdefault(sf["kind"], sf)
    return {"setting": next((r["setting"] for r in reads if r["setting"]), ""),
            "interior": vote([r["interior"] for r in reads]), "time": vote([r["time"] for r in reads]) or "",
            "camera": {"height_m": float(np.median(hs)) if hs else None,
                       "type": vote([r["camera"].get("type") for r in reads]) or ""},
            "items": [it for r in reads for it in r["items"]], "surfaces": list(surf.values()), "kinds": kinds,
            "frames": [r["frame"] for r in reads]}


def legacy_breakdown(inv: dict) -> dict:
    """The inventory as the old {setting, time, camera, objects, set} breakdown (build_set, metres_per_unit)."""
    sets = []
    for sf in inv.get("surfaces") or []:
        t = SET_SYNONYMS.get(sf["kind"], sf["kind"])
        if t in SET_TYPES and t not in ("wall", "building"):
            sets.append({"type": t, "side": "all" if t in ("ocean", "mountain", "hill", "grass") else "ahead",
                         "distance": "far" if t in ("mountain", "hill", "ocean") else "mid", "lanes": 0, "bbox": None})
    objs = []
    for it in inv.get("items") or []:
        if it.get("bbox") is None:
            continue
        objs.append({"label": it["name"], "kind": resolve_kind(it["kind"], it["name"]), "color": it.get("color"),
                     "bbox": it["bbox"], "facing": "", "moving": bool(it.get("moving")),
                     "bbox_start": it["bbox"], "bbox_end": None})
    return {"setting": inv.get("setting", ""), "time": inv.get("time", ""), "camera": inv.get("camera") or {},
            "objects": objs, "set": sets}


# ---------------------------------------------------------------------------------------------- pipeline hooks (ctx)
def _input_name(path: str, ctx: dict) -> str:
    import os
    root = (ctx.get("env") or {}).get("input_dir")
    if not root:
        try:
            import folder_paths
            root = folder_paths.get_input_directory()
        except Exception:  # noqa: BLE001
            root = None
    if root:
        rel = os.path.relpath(path, root)
        if not rel.startswith(".."):
            return rel.replace(os.sep, "/")
    return path


def inventory_graph(ctx: dict, frames: list[int] | None = None) -> dict | None:
    """The LAYOUT inventory prompt for the pipeline's module chain (None: no vision model / turned off)."""
    from . import context as X
    if (ctx.get("opts") or {}).get("vlm") is False:
        return None
    model = ctx.get("vlm_model") or inventory_model()
    if not model:
        X.note(ctx, "layout: no local vision model (Qwen3-VL 8B / 4B): things are named by SAM's sweep words only", "warn")
        return None
    ctx["vlm_model"] = model
    if model != INVENTORY_MODELS[0]:
        X.note(ctx, f"layout: inventory read with the fallback {model} (Qwen3-VL 8B is not on this server)")
    all_f = ctx.get("all_frames") or []
    if not all_f:
        return None
    fr = frames if frames is not None else inventory_frames(len(all_f))
    ctx["vlm_frames"] = list(fr)
    return inventory_prompt(model, [_input_name(all_f[f], ctx) for f in fr])


def inventory_collect(ctx: dict, outputs: dict) -> list[int]:
    """Each frame's read -> ctx['vlm_inventory'] (and the legacy ctx['breakdown'] for the scale's camera read).
    Returns the frames whose read was unusable or an echo of the schema (worth one retry: layout.run_gpu does it)."""
    from . import context as X
    from .queue import text_of
    fr = ctx.get("vlm_frames") or []
    by_frame = {r["frame"]: r for r in ctx.get("vlm_reads") or [] if r}
    retry = []
    for i, f in enumerate(fr):
        try:
            r = parse_inventory(text_of(outputs, f"r{i}"), f)
        except ValueError:
            r = None
        if needs_retry(r):
            retry.append(f)
            if r is not None and f not in by_frame:
                by_frame[f] = r
            continue
        by_frame[f] = r
    ctx["vlm_reads"] = [by_frame[f] for f in sorted(by_frame)]
    inv = merge_inventory(ctx["vlm_reads"])
    ctx["vlm_inventory"] = inv
    ctx["breakdown"] = legacy_breakdown(inv)
    if retry:
        X.note(ctx, f"layout: the vision model's read of frame(s) {', '.join(map(str, retry))} was unusable", "info")
    n_items = sum(it.get("count", 1) for it in inv["items"])
    X.note(ctx, f"layout: the vision model listed {n_items} things in {len(inv['kinds'])} kinds over "
                f"{len(ctx['vlm_reads'])} frames ({ctx.get('vlm_model')})")
    return retry
