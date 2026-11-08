"""Video → Stage, the performer's look: what they wear (from the vision model's words), their build (from SAM 3D Body's
shape when it has one, else the person's silhouette), and an opt-in wardrobe reference picture for the Frame still.

Three rules, from the street-dance test clip (a short plaid shirt that came out as a dress):
- garments come from the model's own words only; "dress" is written only when the model said "dress" (or gown);
- a read that names no garment ("woman in yellow plaid outfit") is marked unknown, never silently turned into the
  clay's default top and jeans;
- the reference crop has its face blurred, and is made only when the user ticks it (no real person's likeness).
"""
from __future__ import annotations

import re

import numpy as np

# The clay's garments (web/stage/humans.mjs APPEARANCE_OPTIONS): top tshirt shirt sweater hoodie jacket suit coat dress
# uniform tank; bottom jeans trousers shorts skirt. Everything the model may say maps onto one of them.
TOPS = {"t-shirt": "tshirt", "tshirt": "tshirt", "tee": "tshirt", "polo": "tshirt", "jersey": "tshirt",
        "shirt": "shirt", "blouse": "shirt", "flannel": "shirt", "button-up": "shirt", "button-down": "shirt",
        "overshirt": "shirt", "croptop": "tank", "tank": "tank", "tanktop": "tank", "vest": "tank", "camisole": "tank",
        "cami": "tank", "singlet": "tank", "bralette": "tank", "halter": "tank",
        "hoodie": "hoodie", "hoody": "hoodie", "sweatshirt": "sweater", "sweater": "sweater", "jumper": "sweater",
        "cardigan": "sweater", "pullover": "sweater", "turtleneck": "sweater",
        "jacket": "jacket", "blazer": "jacket", "windbreaker": "jacket", "bomber": "jacket", "anorak": "jacket",
        "coat": "coat", "parka": "coat", "trenchcoat": "coat", "overcoat": "coat",
        "dress": "dress", "gown": "dress", "sundress": "dress", "suit": "suit", "uniform": "uniform", "top": "tshirt"}
BOTTOMS = {"jeans": "jeans", "trousers": "trousers", "pants": "trousers", "leggings": "trousers", "joggers": "trousers",
           "sweatpants": "trousers", "chinos": "trousers", "slacks": "trousers", "cargos": "trousers",
           "shorts": "shorts", "cutoffs": "shorts", "skirt": "skirt", "miniskirt": "skirt"}
PHRASES = [(r"\bcrop(?:ped)?[\s-]+tops?\b", "croptop"), (r"\btank[\s-]+tops?\b", "tanktop"), (r"\bt[\s-]shirts?\b", "t-shirt"),
           (r"\btrench[\s-]+coats?\b", "trenchcoat"), (r"\bbutton[\s-](up|down)\b", r"button-\1"),
           (r"\bdenim\s+shorts\b", "denim shorts"), (r"\bcrop(?:ped)?\b(?=\s+(?:\w+\s+)?(?:shirt|blouse|hoodie|sweater|jacket))", "cropped")]
COLORS = {"black": "#1d1d1f", "white": "#ecebe7", "cream": "#e8dfc8", "grey": "#8a8a8a", "gray": "#8a8a8a",
          "red": "#b3302b", "maroon": "#6e2230", "burgundy": "#6e2230", "blue": "#2e4f8a", "navy": "#1f2b4a",
          "teal": "#2f7a78", "green": "#3f6b3a", "olive": "#6b6b3a", "yellow": "#e3b622", "mustard": "#c99a2e",
          "orange": "#e07a24", "tiger": "#e07a24", "brown": "#6b4a32", "tan": "#b89470", "beige": "#d8c8a8",
          "pink": "#e39ab0", "purple": "#6a4a8a", "denim": "#3a4d6e", "khaki": "#a89a6a", "gold": "#c9a227",
          "silver": "#b8b8bc"}
JEANS_SHADE = {"light": "#8aa0c0", "pale": "#8aa0c0", "faded": "#8aa0c0", "light-wash": "#8aa0c0", "stonewash": "#8aa0c0",
               "dark": "#24304a", "dark-wash": "#24304a", "black": "#1d1d1f"}
PATTERNS = ("plaid", "tartan", "checked", "checkered", "gingham", "striped", "floral", "camo", "polka")
# Words that say "clothes" without saying which: a read with only these is unknown, not the default top + jeans.
VAGUE = ("outfit", "clothes", "clothing", "attire", "costume", "garments", "wear", "apparel")


def _norm(text: str) -> str:
    t = " " + str(text or "").lower() + " "
    for pat, rep in PHRASES:
        t = re.sub(pat, rep, t)
    return t


def parse(text: str) -> dict:
    """'short-sleeve yellow plaid shirt, light jeans' -> {top: shirt, top_color, top_pattern: plaid, sleeves: short,
    bottom: jeans, bottom_color}. Colour / pattern words up to three before a garment belong to it. {} for no garment."""
    words = re.findall(r"[a-z]+(?:-[a-z]+)*", _norm(text))
    ap: dict = {}
    last = -1          # the previous garment: colour words never reach back past it
    vague_col = None   # "yellow plaid outfit": the colour / pattern of the whole look
    for i, w in enumerate(words):
        if w in VAGUE:
            for prev in reversed(words[max(last + 1, i - 3):i]):
                if prev.split("-")[0] in COLORS:
                    vague_col = vague_col or COLORS[prev.split("-")[0]]
                    break
            last = i
            continue
        if w in TOPS and "top" not in ap:
            slot, garment = "top", TOPS[w]
        elif w in BOTTOMS and "bottom" not in ap:
            slot, garment = "bottom", BOTTOMS[w]
        else:
            continue
        if slot == "top" and garment == "tshirt" and w == "top" and i and words[i - 1] in ("tank", "crop"):
            garment = "tank"
        ap[slot] = garment
        before = words[max(last + 1, i - 4):i]
        last = i
        for prev in reversed(before):
            if garment == "jeans" and prev in JEANS_SHADE:
                ap[f"{slot}_color"] = JEANS_SHADE[prev]
                break
            c = COLORS.get(prev.split("-")[0])
            if c:
                ap[f"{slot}_color"] = c
                break
        pat = next((p for p in PATTERNS if any(b.startswith(p) for b in before)), None) or \
            ("plaid" if w == "flannel" or "flannel" in before else None)
        if pat:
            ap[f"{slot}_pattern"] = "plaid" if pat in ("tartan", "checked", "checkered", "gingham") else pat
        if slot == "top":
            if "sleeveless" in before:
                ap["sleeves"] = "none"
            elif any(b in ("short-sleeve", "short-sleeved") for b in before) or \
                    ("short" in before and any(b.startswith("sleeve") for b in before)):
                ap["sleeves"] = "short"
            if w in ("croptop",) or "cropped" in before:
                ap["length"] = "cropped"
    if vague_col and "top" in ap and "top_color" not in ap:
        ap["top_color"] = vague_col
    if "dress" in (ap.get("top"),) and not re.search(r"\b(dress|gown|sundress)\b", str(text or "").lower()):
        ap.pop("top")   # never a dress the model did not say
    return ap


def appearance(label: str, wardrobe: str | None = None, color: str | None = None) -> dict:
    """The clay wardrobe for one person: the model's wardrobe words first, then its label. A read that names no
    garment keeps the colour it gave and is marked wardrobe: 'unknown' (the clay keeps its default shape, and the Look
    text says what the model said instead of a made-up garment)."""
    ap = parse(wardrobe or "")
    lab = parse(label or "")
    given = {slot for slot in ("top", "bottom") if slot in ap}   # the label only fills the slots the wardrobe left open
    for k, v in lab.items():
        slot = "top" if k in ("sleeves", "length") else k.split("_")[0]
        if slot not in given:
            ap.setdefault(k, v)
    if "top" not in ap and "bottom" not in ap:
        ap["wardrobe"] = "unknown"
        words = re.findall(r"[a-z]+", f"{wardrobe or ''} {label or ''}".lower())
        c = next((COLORS[w] for w in words if w in COLORS), None) or color
        if c:
            ap["top_color"] = c
        pat = next((p for p in PATTERNS if p in words), None)
        if pat:
            ap["top_pattern"] = "plaid" if pat in ("tartan", "checked", "checkered", "gingham") else pat
    elif "top_color" not in ap and "top" in ap:
        # "woman in yellow plaid outfit" + a wardrobe without colours: the outfit's colour words, then the model's hex
        words = re.findall(r"[a-z]+", f"{label or ''} {wardrobe or ''}".lower())
        named = next((COLORS[w] for i, w in enumerate(words) if w in COLORS and
                      any(x in VAGUE for x in words[i + 1:i + 4])), None)
        if named or color:
            ap["top_color"] = named or color
        if "top_pattern" not in ap:
            pat = next((p for i, p in enumerate(words) if p in PATTERNS and any(x in VAGUE for x in words[i + 1:i + 3])), None)
            if pat:
                ap["top_pattern"] = "plaid" if pat in ("tartan", "checked", "checkered", "gingham") else pat
    return ap


def words(ap: dict, raw: str = "") -> str:
    """The wardrobe as Look words: the model's own wardrobe text when it gave one (cleaned), else built from the
    garments ('a short-sleeve yellow plaid shirt and light jeans'); '' when unknown and nothing was said."""
    raw = " ".join(str(raw or "").split()).strip(" .,;")
    if raw and not re.search(r"\b(dress|gown|sundress)\b", raw.lower()) and ap.get("top") == "dress":
        raw = ""
    if raw:
        return raw
    if ap.get("wardrobe") == "unknown":
        return ""
    names: dict = {}
    for k, v in COLORS.items():
        names.setdefault(v, k)
    parts = []
    for slot in ("top", "bottom"):
        g = ap.get(slot)
        if not g:
            continue
        noun = {"tshirt": "T-shirt", "tank": "crop top" if ap.get("length") == "cropped" else "tank top"}.get(g, g)
        bits = []
        if slot == "top" and ap.get("sleeves") == "short":
            bits.append("short-sleeve")
        col = ap.get(f"{slot}_color")
        if g == "jeans" and col in ("#8aa0c0", "#24304a"):
            bits.append({"#8aa0c0": "light", "#24304a": "dark"}[col])
        elif col in names:
            bits.append(names[col])
        if ap.get(f"{slot}_pattern"):
            bits.append(ap[f"{slot}_pattern"])
        parts.append(" ".join(bits + [noun]))
    if not parts:
        return ""
    return " and ".join((("an " if p[0] in "aeiou" else "a ") + p) if not p.endswith(("jeans", "trousers", "shorts")) else p
                        for p in parts)


# ---------------------------------------------------------------------------------------------------------- build
# The clay's hip width (web/stage/humans.mjs buildHuman): the waist sphere 2 * waistR * 1.12, scaled 1.15 (female) /
# 1.02 (male) sideways; waistR = (0.13 female | 0.15 male) * build * height / 1.8.
def clay_hip_width(height_m: float, girth: float = 1.0, female: bool = True) -> float:
    return 2 * (0.13 if female else 0.15) * girth * height_m / 1.8 * 1.12 * (1.15 if female else 1.02)


BUILDS = {"slim": 0.9, "average": 1.0, "athletic": 1.08, "heavy": 1.28}


def mask_hip_ratio(mask: np.ndarray) -> float | None:
    """Hip width / standing height of a person's silhouette: the run through the body's centre at the hip rows
    (53 % of the height up from the soles), median over a 6 %-tall band so a hand at the hip doesn't widen it."""
    m = np.asarray(mask) > 0
    rows = np.flatnonzero(m.any(1))
    if len(rows) < 20:
        return None
    top, bot = int(rows[0]), int(rows[-1])
    hgt = bot - top + 1
    cols = np.flatnonzero(m.any(0))
    cx = int(round(np.median(np.nonzero(m[top + hgt // 4: bot - hgt // 4])[1]))) if cols.size else 0
    widths = []
    for r in range(int(bot - 0.56 * hgt), int(bot - 0.50 * hgt) + 1):
        line = m[r]
        if not line[min(max(cx, 0), len(line) - 1)]:
            continue
        lo = hi = cx
        while lo > 0 and line[lo - 1]:
            lo -= 1
        while hi < len(line) - 1 and line[hi + 1]:
            hi += 1
        widths.append(hi - lo + 1)
    if not widths:
        return None
    return float(np.median(widths)) / hgt


def girth_from(take: dict | None = None, mask: np.ndarray | None = None, female: bool = True):
    """(girth scale for the clay, source) : SAM 3D Body's own shape when the take carries one (unverified on the GPU:
    the node may not return it), else the silhouette's hip width over its height; (None, '') without either."""
    shp = (take or {}).get("body_shape") or (take or {}).get("shape") or {}
    if isinstance(shp, dict):
        if shp.get("girth"):
            return float(np.clip(float(shp["girth"]), 0.75, 1.5)), "SAM 3D Body shape"
        if shp.get("hip_width_m") and shp.get("height_m"):
            g = float(shp["hip_width_m"]) / clay_hip_width(float(shp["height_m"]), 1.0, female)
            return float(np.clip(g, 0.75, 1.5)), "SAM 3D Body shape"
    if mask is not None:
        r = mask_hip_ratio(mask)
        if r:
            g = r / (clay_hip_width(1.0, 1.0, female) / 1.0)
            return float(np.clip(g, 0.75, 1.5)), "the person's silhouette"
    return None, ""


def nearest_build(girth: float) -> str:
    return min(BUILDS, key=lambda k: abs(BUILDS[k] - girth))


def person_mask_from_depth(depth: np.ndarray, box, rel: float = 0.25) -> np.ndarray | None:
    """The person inside a normalised box [x0, y0, x1, y1] (0-1) of a depth map: pixels within rel of the median
    depth of the box's centre strip (the body), a stand-in for a segmentation mask on the old route."""
    d = np.asarray(depth, np.float32)
    h, w = d.shape
    x0, y0, x1, y1 = (int(round(v * s)) for v, s in zip(box, (w, h, w, h)))
    x0, x1 = max(0, x0), min(w, x1)
    y0, y1 = max(0, y0), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 8:
        return None
    sub = d[y0:y1, x0:x1]
    cx0, cx1 = (x1 - x0) * 2 // 5, max((x1 - x0) * 3 // 5, (x1 - x0) * 2 // 5 + 1)
    core = sub[: (y1 - y0) * 3 // 4, cx0:cx1]
    core = core[np.isfinite(core) & (core > 0)]
    if not core.size:
        return None
    z = float(np.median(core))
    m = np.zeros((h, w), bool)
    m[y0:y1, x0:x1] = np.isfinite(sub) & (np.abs(sub - z) < rel * z)
    return m


# ---------------------------------------------------------------------------------------------------------- reference
def blur_face(img: np.ndarray, face_box) -> np.ndarray:
    """A heavy box blur (pixelate + blur) over face_box [x0, y0, x1, y1] in pixels, grown 25 %: no likeness survives."""
    out = np.array(img, copy=True)
    h, w = out.shape[:2]
    x0, y0, x1, y1 = face_box
    gx, gy = 0.25 * (x1 - x0), 0.25 * (y1 - y0)
    x0, y0 = int(max(0, x0 - gx)), int(max(0, y0 - gy))
    x1, y1 = int(min(w, x1 + gx)), int(min(h, y1 + gy))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return out
    patch = out[y0:y1, x0:x1].astype(np.float32)
    cell = max(2, min(x1 - x0, y1 - y0) // 4)
    ph, pw = patch.shape[:2]
    gh, gw = -(-ph // cell), -(-pw // cell)
    padded = np.pad(patch, ((0, gh * cell - ph), (0, gw * cell - pw)) + ((0, 0),) * (patch.ndim - 2), mode="edge")
    small = padded.reshape(gh, cell, gw, cell, *patch.shape[2:]).mean(axis=(1, 3))   # each cell's mean colour
    big = np.repeat(np.repeat(small, cell, 0), cell, 1)[:ph, :pw]
    k = max(1, cell // 2)
    pad = np.pad(big, ((k, k), (k, k), (0, 0)) if big.ndim == 3 else ((k, k), (k, k)), mode="edge")
    acc = np.zeros_like(big)
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            acc += pad[k + dy: k + dy + big.shape[0], k + dx: k + dx + big.shape[1]]
    out[y0:y1, x0:x1] = (acc / (2 * k + 1) ** 2).astype(out.dtype)
    return out


def face_box_from_joints(uv: np.ndarray, body_box) -> list[float]:
    """The head from the take's 2D joints (0 nose, 1 neck; 14-17 eyes / ears when present), else the top 18 % of the
    person box. uv in pixels; body_box [x0, y0, x1, y1] in pixels."""
    x0, y0, x1, y1 = body_box
    uv = np.asarray(uv, float) if uv is not None else np.zeros((0, 2))
    head = [i for i in (0, 14, 15, 16, 17) if i < len(uv) and np.all(np.isfinite(uv[i]))]
    if head and len(uv) > 1 and np.all(np.isfinite(uv[1])):
        P = uv[head]
        neck = uv[1]
        r = max(float(np.linalg.norm(uv[0] - neck)) * 1.1, 0.06 * (y1 - y0))
        cx, cy = float(P[:, 0].mean()), float(P[:, 1].mean())
        return [cx - r, cy - 1.3 * r, cx + r, cy + 0.9 * r]
    hh = 0.18 * (y1 - y0)
    cx = (x0 + x1) / 2
    return [cx - 0.55 * hh, y0, cx + 0.55 * hh, y0 + hh]


def reference_crop(img: np.ndarray, body_box, face_box=None, pad: float = 0.08) -> np.ndarray:
    """The person cut out of a source frame (box grown by pad) with the face blurred: a wardrobe reference for the
    Frame still (build, garments, hem length) that carries no likeness."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = body_box
    face = face_box if face_box is not None else face_box_from_joints(None, body_box)
    blurred = blur_face(img, face)
    dx, dy = pad * (x1 - x0), pad * (y1 - y0)
    X0, Y0 = int(max(0, x0 - dx)), int(max(0, y0 - dy))
    X1, Y1 = int(min(w, x1 + dx)), int(min(h, y1 + dy))
    return blurred[Y0:Y1, X0:X1].copy()


CONSENT = ("Sends a crop of the person from the clip, with the face blurred, to the Frame still so it copies their build "
           "and clothes. Only for footage you have the right to use; the face is never sent.")
