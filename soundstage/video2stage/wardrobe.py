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
           (r"\bdenim\s+shorts\b", "denim shorts"), (r"\bcrop(?:ped)?\b(?=\s+(?:\w+\s+)?(?:shirt|blouse|hoodie|sweater|jacket))", "cropped"),
           # "dress shirt" / "dress pants" are a smart shirt and trousers, never a dress
           (r"\bdress[\s-]+(?=(?:shirts?|pants|trousers|slacks|shoes|socks|blouses?|coats?|jackets?)\b)", "smart ")]
# A labelled reply ("top: yellow plaid shirt; bottom: jeans"): the label is not a garment, and nothing reaches across it.
LABELS = re.compile(r"\b(?:tops?|bottoms?|upper(?:\s+body)?|lower(?:\s+body)?|outfit|wardrobe|clothing|clothes|"
                    r"footwear|shoes|accessories|legs|torso)\s*:")
SEP = "zzsep"          # a barrier word: colour / pattern words never reach back past it
# Shade words go with the colour after them ("light blue jeans" is light jeans, "dark green jacket" a dark green)
SHADES = {"light": 1, "pale": 1, "faded": 1, "pastel": 1, "washed": 1, "dark": -1, "deep": -1}
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
    t = LABELS.sub(f" {SEP} ", t)
    t = re.sub(r"[;|\n]", f" {SEP} ", t)
    for pat, rep in PHRASES:
        t = re.sub(pat, rep, t)
    return t


def said_dress(text: str) -> bool:
    """Did the model say a dress? 'dress' / 'gown' / 'sundress' as a garment, not 'dress shirt' or 'dress pants'."""
    return bool(re.search(r"\b(dress|gown|sundress)\b", _norm(text)))


def _mix(hex_: str, toward: int, k: float = 0.45) -> str:
    r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(int(round(c + (toward - c) * k)) for c in (r, g, b))


def _colour_of(before: list[str], garment: str) -> str | None:
    """The colour of a garment from the words before it (nearest first), its shade word applied first: 'light blue
    jeans' -> light jeans, 'dark green jacket' -> a darker green."""
    for j in range(len(before) - 1, -1, -1):
        prev = before[j]
        if garment == "jeans" and prev in JEANS_SHADE:
            return JEANS_SHADE[prev]
        parts = prev.split("-")
        base = parts[-1] if parts[-1] in COLORS else parts[0]
        c = COLORS.get(base)
        if not c:
            continue
        shade = next((SHADES[p] for p in parts[:-1] if p in SHADES), None) if base == parts[-1] and len(parts) > 1 \
            else None
        if shade is None and j > 0 and before[j - 1] in SHADES:
            shade = SHADES[before[j - 1]]
        if shade is None:
            return c
        if garment == "jeans" and base in ("blue", "denim", "navy"):
            return JEANS_SHADE["light" if shade > 0 else "dark"]
        return _mix(c, 255 if shade > 0 else 0)
    return None


# How far out a top is worn: a read with two tops keeps the outermost on the clay ("a white tee under a navy blazer" is
# the blazer), and the one under it is kept as `under` (a dress under a jacket also becomes the clay's skirt).
LAYER = {"tank": 0, "tshirt": 0, "shirt": 0, "dress": 0, "sweater": 1, "hoodie": 1, "uniform": 1, "jacket": 2,
         "suit": 2, "coat": 3}
# "a hoodie tied around the waist" / "jacket knotted at her hips": carried, not worn over the top. Only this phrase,
# right after that garment phrase (a multi-word one such as "flannel shirt" is one garment; before the next garment or
# barrier), marks it: "hoodie with tied drawstrings" and "jacket
# draped around her shoulders" are worn.
TIED = re.compile(r"\b(?:tied|knotted|slung)\s+(?:a?round|at|on)\s+(?:the\s+|her\s+|his\s+|their\s+)?(?:waist|hips?)\b")
# Bottom words the clay folds into another garment: the Look words keep the model's own noun
BOTTOM_NOUNS = {"leggings", "joggers", "sweatpants", "chinos", "slacks", "cargos", "cutoffs"}


def parse(text: str) -> dict:
    """'short-sleeve yellow plaid shirt, light jeans' -> {top: shirt, top_color, top_pattern: plaid, sleeves: short,
    bottom: jeans, bottom_color}. Colour / pattern words up to three before a garment belong to it. {} for no garment.
    Layers: 'light blue denim jacket over a black dress' -> top jacket (its colour), under dress, and the dress shows
    below the jacket as the clay's skirt in the dress's colour (when no bottom was named)."""
    words = re.findall(r"[a-z]+(?:-[a-z]+)*", _norm(text))
    ap: dict = {}
    tops: list[dict] = []
    last = -1          # the previous garment: colour words never reach back past it
    vague_col = None   # "yellow plaid outfit": the colour / pattern of the whole look
    for i, w in enumerate(words):
        if w == SEP:
            last = i
            continue
        if w in VAGUE:
            for prev in reversed(words[max(last + 1, i - 3):i]):
                if prev.split("-")[0] in COLORS:
                    vague_col = vague_col or COLORS[prev.split("-")[0]]
                    break
            last = i
            continue
        if w in TOPS and i + 1 < len(words) and words[i + 1] in TOPS:
            continue   # "flannel shirt", "button-down shirt": one garment phrase, its last word is the garment
        if w in TOPS:
            slot, garment = "top", TOPS[w]
        elif w in BOTTOMS and "bottom" not in ap:
            slot, garment = "bottom", BOTTOMS[w]
        else:
            continue
        if slot == "top" and garment == "tshirt" and w == "top" and i and words[i - 1] in ("tank", "crop"):
            garment = "tank"
        before = words[max(last + 1, i - 4):i]
        last = i
        g: dict = {"top" if slot == "top" else "bottom": garment}
        c = _colour_of(before, garment)
        if c:
            g[f"{slot}_color"] = c
        pat = next((p for p in PATTERNS if any(b.startswith(p) for b in before)), None) or \
            ("plaid" if w == "flannel" or "flannel" in before else None)
        if pat:
            g[f"{slot}_pattern"] = "plaid" if pat in ("tartan", "checked", "checkered", "gingham") else pat
        if slot == "bottom":
            if w in BOTTOM_NOUNS:
                g["bottom_noun"] = w
            ap.update(g)
            continue
        if "sleeveless" in before:
            g["sleeves"] = "none"
        elif any(b in ("short-sleeve", "short-sleeved") for b in before) or \
                ("short" in before and any(b.startswith("sleeve") for b in before)):
            g["sleeves"] = "short"
        if w in ("croptop",) or "cropped" in before:
            g["length"] = "cropped"
        after = []
        for x in words[i + 1:i + 8]:
            if x == SEP or x in TOPS or x in BOTTOMS:
                break
            after.append(x)
        g["tied"] = bool(TIED.search(" ".join(after)))
        tops.append(g)
    worn = [g for g in tops if not g["tied"]] or tops[:1]
    if worn:
        outer = max(worn, key=lambda g: LAYER.get(g["top"], 0))   # max keeps the first of equal layers
        ap.update({k: v for k, v in outer.items() if k != "tied"})
        inner = next((g for g in worn if g is not outer and g["top"] == "dress"), None) or \
            next((g for g in worn if g is not outer and LAYER.get(g["top"], 0) < LAYER.get(outer["top"], 0)), None)
        if inner is not None:
            ap["under"] = inner["top"]
            if inner.get("top_color"):
                ap["under_color"] = inner["top_color"]
            if inner["top"] == "dress" and "bottom" not in ap:   # the dress shows below the outer layer
                ap["bottom"] = "skirt"
                for k in ("color", "pattern"):
                    if inner.get(f"top_{k}"):
                        ap[f"bottom_{k}"] = inner[f"top_{k}"]
    if vague_col and "top" in ap and "top_color" not in ap:
        ap["top_color"] = vague_col
    if not said_dress(text):   # never a dress the model did not say
        if ap.get("top") == "dress":
            ap.pop("top")
        if ap.get("under") == "dress":
            ap.pop("under")
            ap.pop("under_color", None)
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
    if raw and not said_dress(raw) and ap.get("top") == "dress":
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
        if not g or (slot == "bottom" and ap.get("under") == "dress" and g == "skirt"):
            continue
        noun = {"tshirt": "T-shirt", "tank": "crop top" if ap.get("length") == "cropped" else "tank top"}.get(g, g)
        if slot == "bottom" and ap.get("bottom_noun"):
            noun = ap["bottom_noun"]
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
    if ap.get("under") == "dress" and ap.get("top") and ap["top"] != "dress":
        col = names.get(ap.get("under_color"))
        art = lambda p: ("an " if p[0] in "aeiou" else "a ") + p   # noqa: E731
        over = f"{art(parts[0])} over {art(((col + ' ') if col else '') + 'dress')}"
        return over + (f" and {parts[1]}" if len(parts) > 1 else "")   # a bottom named under the dress is kept
    plural = ("jeans", "trousers", "shorts", *BOTTOM_NOUNS)
    return " and ".join((("an " if p[0] in "aeiou" else "a ") + p) if not p.endswith(plural) else p for p in parts)


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


def person_mask_from_depth(depth: np.ndarray, box, rel: float = 0.25, front: bool = False) -> np.ndarray | None:
    """The person inside a normalised box [x0, y0, x1, y1] (0-1) of a depth map: pixels within rel of the median
    depth of the box's centre strip (the body), a stand-in for a segmentation mask on the old route. With `front`
    the body is the strip's front-most depth that holds at least FRONT_SHARE of it (a person stands in front of the
    set), so a box over the left half of her, whose centre strip is mostly the wall past her side, still finds her."""
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
    if front:
        zf = float(np.percentile(core, 100 * FRONT_SHARE))
        z = float(np.median(core[core <= zf * 1.1]))
    m = np.zeros((h, w), bool)
    m[y0:y1, x0:x1] = np.isfinite(sub) & (np.abs(sub - z) < rel * z)
    return m


FRONT_SHARE = 0.15


# The take's 2D joints (COCO-18, as SAM 3D Body's take stores them: 0 nose, 1 neck, 2-4 right arm, 5-7 left arm,
# 8-10 right leg, 11-13 left leg) as bones: the trunk and legs, then the arms.
TRUNK_BONES = ((0, 1), (1, 8), (1, 11), (2, 8), (5, 11), (8, 11), (2, 5), (8, 9), (9, 10), (11, 12), (12, 13))
ARM_BONES = ((1, 2), (2, 3), (3, 4), (1, 5), (5, 6), (6, 7))
BAND_TRUNK, BAND_ARM = 0.075, 0.045   # how far from a bone the body can reach, as a share of the person's height
CORE = 0.02                           # pixels this close to a bone are surely the body (its depth per row)


# Virtual joints past the ends COCO-18 stops at, so the band reaches the crown and the fingertips: the head top
# (the neck -> nose line carried on 0.7 of its length past the nose) and each hand (elbow -> wrist, 0.4 past the wrist).
# Each toe: the knee -> ankle line carried on 0.6 of its length past the ankle (a pointed-toe kick).
HEAD_TOP, HAND_R, HAND_L, TOE_R, TOE_L = 18, 19, 20, 21, 22
END_BONES = ((0, HEAD_TOP), (10, TOE_R), (13, TOE_L)), ((4, HAND_R), (7, HAND_L))
# Round reaches (joint, share of the height) the bones' bands miss: the shoulders and the neck (the trapezius and the
# deltoids stand off the shoulder line), the head round the nose, and each foot round its ankle (a flat foot points
# sideways, off the shin line). They widen the band only; the core (and so the per-row body depth) stays on the bones.
DISCS = ((1, 0.11), (2, 0.11), (5, 0.11), (0, 0.10), (10, 0.15), (13, 0.15))
PIECE = 0.02       # a separate piece of the depth band is the body's when the core reaches it this much (of the most)


def _with_ends(uv):
    """uv (COCO-18) plus the virtual head-top, hand and toe points (NaN where their joints are missing)."""
    out = np.full((23, 2), np.nan)
    out[:min(18, len(uv))] = uv[:18]
    for k, (a, b, f) in ((HEAD_TOP, (0, 1, 0.7)), (HAND_R, (4, 3, 0.4)), (HAND_L, (7, 6, 0.4)),
                         (TOE_R, (10, 9, 0.6)), (TOE_L, (13, 12, 0.6))):
        if np.all(np.isfinite(out[a])) and np.all(np.isfinite(out[b])):
            out[k] = out[a] + f * (out[a] - out[b])
    return out


def _bone_dist(X, Y, uv, bones):
    out = np.full(X.shape, np.inf)
    for a, b in bones:
        if a >= len(uv) or b >= len(uv) or not (np.all(np.isfinite(uv[a])) and np.all(np.isfinite(uv[b]))):
            continue
        p, q = uv[a], uv[b]
        d = q - p
        t = np.clip(((X - p[0]) * d[0] + (Y - p[1]) * d[1]) / max(float(d @ d), 1e-9), 0.0, 1.0)
        out = np.minimum(out, np.hypot(X - (p[0] + t * d[0]), Y - (p[1] + t * d[1])))
    return out


def body_mask(depth: np.ndarray, box_px, uv=None, rel: float = 0.07) -> np.ndarray | None:
    """The person's silhouette for the build, tighter than person_mask_from_depth: inside the box (pixels), within a
    band around the take's own 2D joints (uv, pixels of this depth map) when it has them, and within rel of the BODY's
    depth on that row (not the box's median), then only the connected pieces the body's core reaches (the torso, and an
    arm or hand a gap away from it). The band reaches the crown, the fingertips and the toes (virtual points past the
    nose, the wrists and the ankles), and is wider round the shoulders, neck, head and feet (DISCS). A concrete slab or a
    slope half a metre behind the hips is no longer counted as hip. Known limit: a background within ~rel of the body
    (a wall she leans on) and inside the band still joins."""
    d = np.asarray(depth, np.float32)
    h, w = d.shape
    x0, y0, x1, y1 = box_px
    x0, x1 = max(0, int(np.floor(x0))), min(w, int(np.ceil(x1)))
    y0, y1 = max(0, int(np.floor(y0))), min(h, int(np.ceil(y1)))
    if x1 - x0 < 4 or y1 - y0 < 8:
        return None
    sub = d[y0:y1, x0:x1]
    ok = np.isfinite(sub) & (sub > 0)
    Y, X = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    uv = None if uv is None else np.asarray(uv, float)
    hips = uv is not None and any(i < len(uv) and np.all(np.isfinite(uv[i])) for i in (8, 11))
    if hips and np.isfinite(uv).all(axis=1).sum() >= 6:
        okj = np.isfinite(uv[:18]).all(axis=1)
        span = float(np.ptp(uv[:18][okj, 1])) if okj.sum() >= 2 else 0.0
        H = 1.15 * span if span > 0 else float(y1 - y0)   # her height as the joints give it (the old joint box)
        ends = _with_ends(uv)
        dt, da = _bone_dist(X, Y, ends, TRUNK_BONES + END_BONES[0][:1]), _bone_dist(X, Y, ends, ARM_BONES + END_BONES[1])
        dtoe = _bone_dist(X, Y, ends, END_BONES[0][1:])   # band only: a toe line off a flat foot lies on the ground
        band = (dt < BAND_TRUNK * H) | (da < BAND_ARM * H)
        extra = dtoe < BAND_TRUNK * H
        for j, r in DISCS:
            if j < len(uv) and np.all(np.isfinite(uv[j])):
                extra |= np.hypot(X - uv[j][0], Y - uv[j][1]) < r * H
        ank = [uv[j][1] for j in (10, 13) if j < len(uv) and np.all(np.isfinite(uv[j]))]
        if ank:   # below her soles (the lower ankle + 0.05 of her height) only the tight tolerance: the floor is there
            below = Y > max(ank) + 0.05 * H / 1.15
            extra |= band & below
            band &= ~below
        extra &= ~band          # the toe lines' and the discs' own reach: half the depth tolerance (tight)
        core = (dt < CORE * H) | (da < 0.6 * CORE * H)
    else:
        band = np.ones_like(ok)
        core = np.zeros_like(ok)
        extra = np.zeros_like(ok)
        bw = x1 - x0
        core[: (y1 - y0) * 3 // 4, bw * 2 // 5: max(bw * 3 // 5, bw * 2 // 5 + 1)] = True
    core &= ok
    if not core.any():
        return None
    # the body's depth on each row: the median of its core pixels there, filled from the nearest row that has some.
    # Core pixels far off the whole body's depth (a bone end past the crown or a toe tip runs onto the background)
    # are not the body and do not set a row's depth.
    zall = float(np.median(sub[core]))
    near = core & (np.abs(sub - zall) < 0.25 * zall)
    core = near if near.any() else core
    # On a row the core shares with what is behind her (an ankle's core over the slab below the foot) the body is the
    # front-most core there: only the core pixels within rel of the row's nearest tenth count. A row whose body depth
    # still lies more than 1.5 rel behind the whole body's has no body of its own and takes its neighbour's.
    zr = np.full(sub.shape[0], np.nan)
    for r in np.flatnonzero(core.any(1)):
        zc = sub[r][core[r]]
        zf = float(np.percentile(zc, 10))
        z = float(np.median(zc[zc <= zf * (1 + rel)]))
        if z <= zall * (1 + 1.5 * rel):
            zr[r] = z
    have = np.flatnonzero(np.isfinite(zr))
    if not have.size:
        return None
    zr = zr[have[np.abs(np.arange(len(zr))[:, None] - have[None]).argmin(1)]]
    dz = np.abs(sub - zr[:, None])
    m = ok & ((band & (dz < rel * zr[:, None])) | (extra & (dz < 0.5 * rel * zr[:, None])))
    try:
        import cv2
        n, lab = cv2.connectedComponents(m.astype(np.uint8), connectivity=4)
        if n > 2:   # every piece the body's core reaches (an arm a gap from the torso is its own piece)
            hits = np.bincount(lab[m & core], minlength=n)
            hits[0] = 0
            keep = hits >= max(1, PIECE * int(hits.max()))
            keep[0] = False
            m = keep[lab]
    except ImportError:   # without OpenCV the band and the depth test alone decide
        pass
    out = np.zeros((h, w), bool)
    out[y0:y1, x0:x1] = m
    return out


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
