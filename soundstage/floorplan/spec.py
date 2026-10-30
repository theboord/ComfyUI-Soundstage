"""Floor-plan spec: the JSON the stage's interior builder consumes, built from a plan image or from text.

Spec (metres; plan coordinates: +x right, +z down the page; rooms are axis-aligned rectangles whose edges
are wall centre-lines, so neighbours share an edge exactly):
  {"units": "m", "ceiling_m", "wall_thickness_m",
   "rooms": [{"name", "x", "z", "w", "d"}],
   "openings": [{"type": "door|window|opening", "room", "wall": "N|S|E|W", "offset_m", "width_m",
                 "height_m", "sill_m"}],          # offset_m along the wall from its west / north end
   "fixtures": [{"kind", "room", "x", "z", "rotation_deg"}],   # x / z absolute plan metres (object centre)
   "warnings": [...], "source": "image|text"}
"""
from __future__ import annotations

import math
import re
import statistics

MIN_ROOM_M, MAX_ROOM_M = 0.7, 40.0
DEFAULT_CEILING, DEFAULT_WALL = 2.4, 0.12
LABEL_TOL = 0.12          # label vs drawing disagreement that triggers a correction
FT = 0.3048

# ---------------------------------------------------------------- dimension text


def _num(tok: str) -> float | None:
    """'5.4', '5,4', "12'6\"", '3600' (mm), '12ft' -> metres."""
    t = tok.strip().lower().replace(",", ".")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:\"|'')?)?", t)
    if m:
        return float(m.group(1)) * FT + float(m.group(2) or 0) * 0.0254
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(mm|cm|m|ft|feet|foot)?", t)
    if not m:
        return None
    v, unit = float(m.group(1)), m.group(2)
    if unit == "mm" or (unit is None and v >= 100):
        return v / 1000
    if unit == "cm":
        return v / 100
    if unit in ("ft", "feet", "foot"):
        return v * FT
    return v


_PAIR = re.compile(r"(\d+(?:[.,]\d+)?\s*(?:'\s*\d*(?:\.\d+)?\s*(?:\"|'')?|mm|cm|m|ft|feet)?)\s*(?:x|×|\*|by)\s*"
                   r"(\d+(?:[.,]\d+)?\s*(?:'\s*\d*(?:\.\d+)?\s*(?:\"|'')?|mm|cm|m|ft|feet)?)", re.I)


def parse_dims(text: str) -> tuple[float, float] | None:
    """First 'a x b' in the text, in metres. A trailing unit applies to both ('6 x 4 m', '12 x 10 ft')."""
    m = _PAIR.search(text or "")
    if not m:
        return None
    a_tok, b_tok = m.group(1), m.group(2)
    tail = (text[m.end():m.end() + 6] or "").strip().lower()
    unit = re.match(r"(mm|cm|m|ft|feet)\b", tail)
    if unit and not re.search(r"[a-z'\"]", a_tok):
        a_tok += unit.group(1)
    if unit and not re.search(r"[a-z'\"]", b_tok):
        b_tok += unit.group(1)
    a, b = _num(a_tok), _num(b_tok)
    if not a or not b:
        return None
    return a, b


def parse_area(text: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(m2|m²|sqm|sq\.? ?m|square met|sq\.? ?ft|sqft|square f)", text or "", re.I)
    if not m:
        return None
    v = float(m.group(1))
    return v * FT * FT if "f" in m.group(2).lower() else v


def parse_ceiling(text: str) -> float | None:
    m = re.search(r"(?:ceiling|ceilings|ceiling height)\D{0,12}(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|ft|')?)", text or "", re.I) \
        or re.search(r"(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|ft|')?)\s*(?:high )?ceilings?", text or "", re.I)
    return _num(m.group(1)) if m else None


# ---------------------------------------------------------------- room kinds -> fixtures

KINDS = [
    ("ldk", r"\bldk\b|living.?dining|open.?plan|great room"),
    ("studio", r"studio|bedsit"),
    ("living", r"living|lounge|family room|\blr\b|sitting"),
    ("kitchen", r"kitchen|kitchenette|\bk\b"),
    ("dining", r"dining|\bd\b"),
    ("bedroom", r"bed(room)?|\bbr\b|master|guest room|nursery|kids"),
    ("bath", r"bath|shower|ensuite|en-suite"),
    ("wc", r"\bwc\b|toilet|powder|lavatory|restroom"),
    ("study", r"study|office|den|library"),
    ("hall", r"hall|corridor|entry|entrance|foyer|genkan|lobby|landing"),
    ("closet", r"closet|storage|store|wic|walk.?in|pantry|utility|laundry"),
    ("balcony", r"balcony|terrace|veranda|deck|patio"),
]


def room_kind(name: str) -> str:
    n = (name or "").lower()
    for kind, pat in KINDS:
        if re.search(pat, n):
            return kind
    return "room"


# (kind, w, d, where) where = N|S|E|W wall it backs onto (or C centre), placed in room-local metres
FURNISH = {
    "ldk": [("kitchen_counter", 2.4, 0.6, "N"), ("fridge", 0.7, 0.7, "N"), ("dining_table", 1.6, 0.9, "C"),
            ("sofa", 2.0, 0.9, "S"), ("coffee_table", 1.0, 0.6, "C"), ("tv", 1.4, 0.4, "W")],
    "studio": [("kitchen_counter", 2.0, 0.6, "N"), ("bed", 1.6, 2.0, "E"), ("sofa", 1.8, 0.85, "S"),
               ("desk", 1.2, 0.6, "W")],
    "living": [("sofa", 2.0, 0.9, "S"), ("coffee_table", 1.0, 0.6, "C"), ("tv", 1.4, 0.4, "N"),
               ("armchair", 0.85, 0.85, "E"), ("rug", 2.0, 1.4, "C")],
    "kitchen": [("kitchen_counter", 2.4, 0.6, "N"), ("fridge", 0.7, 0.7, "E"), ("table", 1.2, 0.8, "C")],
    "dining": [("dining_table", 1.6, 0.9, "C"), ("houseplant", 0.5, 0.5, "E")],
    "bedroom": [("bed", 1.6, 2.0, "N"), ("wardrobe", 1.2, 0.6, "E"), ("desk", 1.0, 0.55, "W")],
    "bath": [("bath", 1.7, 0.75, "N"), ("washbasin", 0.6, 0.45, "S"), ("toilet", 0.4, 0.65, "E")],
    "wc": [("toilet", 0.4, 0.65, "N"), ("washbasin", 0.45, 0.35, "S")],
    "study": [("desk", 1.4, 0.7, "N"), ("chair", 0.5, 0.5, "C"), ("bookshelf", 1.0, 0.35, "W")],
    "hall": [("houseplant", 0.4, 0.4, "N")],
    "closet": [("wardrobe", 1.0, 0.6, "N")],
}


def furnish(room: dict, taken_walls: dict) -> list[dict]:
    """Template furniture for a room. Each piece backs onto its wall (the opposite one if a door is there),
    then slides along it to the free spot nearest the wall's centre; pieces that do not fit are dropped."""
    out, boxes = [], []
    x, z, w, d = room["x"], room["z"], room["w"], room["d"]
    pad, gap = 0.08, 0.05
    for kind, fw, fd, wall in FURNISH.get(room_kind(room["name"]), []):
        if wall in taken_walls.get(room["name"], ()):
            wall = {"N": "S", "S": "N", "E": "W", "W": "E", "C": "C"}[wall]
        rot = {"N": 0, "S": 180, "E": 270, "W": 90, "C": 0}[wall]
        ow, od = (fw, fd) if rot in (0, 180) else (fd, fw)
        if ow > w - 2 * pad or od > d - 2 * pad:
            continue
        lo_x, hi_x = x + pad + ow / 2, x + w - pad - ow / 2
        lo_z, hi_z = z + pad + od / 2, z + d - pad - od / 2
        steps = lambda lo, hi: sorted([lo + k * 0.05 for k in range(int((hi - lo) / 0.05) + 1)] or [lo],
                                      key=lambda v: abs(v - (lo + hi) / 2))
        if wall == "N":
            cands = [(cx, lo_z) for cx in steps(lo_x, hi_x)]
        elif wall == "S":
            cands = [(cx, hi_z) for cx in steps(lo_x, hi_x)]
        elif wall == "W":
            cands = [(lo_x, cz) for cz in steps(lo_z, hi_z)]
        elif wall == "E":
            cands = [(hi_x, cz) for cz in steps(lo_z, hi_z)]
        else:
            cands = [(cx, cz) for cz in steps(lo_z, hi_z)[:12] for cx in steps(lo_x, hi_x)[:12]]
        free = lambda b: kind == "rug" or all(b[2] + gap <= o[0] or o[2] + gap <= b[0] or b[3] + gap <= o[1]
                                               or o[3] + gap <= b[1] for o in boxes)
        for cx, cz in cands:
            box = (cx - ow / 2, cz - od / 2, cx + ow / 2, cz + od / 2)
            if free(box):
                if kind != "rug":
                    boxes.append(box)
                out.append({"kind": kind, "room": room["name"], "x": round(cx, 2), "z": round(cz, 2),
                            "rotation_deg": rot})
                break
    return out


# ---------------------------------------------------------------- geometry clean-up


def _cluster(values: list[float], tol: float) -> dict[float, float]:
    """Map each value to the mean of its cluster (values within tol chain together)."""
    out = {}
    vals = sorted(set(values))
    group = [vals[0]] if vals else []
    for v in vals[1:]:
        if v - group[-1] <= tol:
            group.append(v)
        else:
            m = sum(group) / len(group)
            out.update({g: m for g in group})
            group = [v]
    if group:
        m = sum(group) / len(group)
        out.update({g: m for g in group})
    return out


def snap_rooms(rooms: list[dict], wall_m: float, warnings: list[str]) -> list[dict]:
    """Move walls onto shared centre-lines, round to 5 cm, put the plan's top-left at (0, 0), clamp sizes."""
    if not rooms:
        return rooms
    tol = max(0.15, wall_m * 1.6)
    xs = _cluster([r["x"] for r in rooms] + [r["x"] + r["w"] for r in rooms], tol)
    zs = _cluster([r["z"] for r in rooms] + [r["z"] + r["d"] for r in rooms], tol)
    out = []
    for r in rooms:
        x0, x1 = xs[r["x"]], xs[r["x"] + r["w"]]
        z0, z1 = zs[r["z"]], zs[r["z"] + r["d"]]
        out.append({**r, "x": x0, "z": z0, "w": x1 - x0, "d": z1 - z0})
    ox, oz = min(r["x"] for r in out), min(r["z"] for r in out)
    for r in out:
        r["x"], r["z"] = round((r["x"] - ox) / 0.05) * 0.05, round((r["z"] - oz) / 0.05) * 0.05
        r["w"], r["d"] = round(r["w"] / 0.05) * 0.05, round(r["d"] / 0.05) * 0.05
        for k in ("w", "d"):
            if r[k] < MIN_ROOM_M or r[k] > MAX_ROOM_M:
                v = min(MAX_ROOM_M, max(MIN_ROOM_M, r[k]))
                warnings.append(f"{r['name']}: {k} {r[k]:.2f} m is not a plausible room size; clamped to {v:.2f} m")
                r[k] = v
        for k in ("x", "z", "w", "d"):
            r[k] = round(r[k], 2)
    return out


def _overlaps(a, b, eps=0.05) -> bool:
    return a["x"] + eps < b["x"] + b["w"] and b["x"] + eps < a["x"] + a["w"] and \
        a["z"] + eps < b["z"] + b["d"] and b["z"] + eps < a["z"] + a["d"]


def check_overlaps(rooms: list[dict], warnings: list[str]):
    for i, a in enumerate(rooms):
        for b in rooms[i + 1:]:
            if _overlaps(a, b):
                warnings.append(f"{a['name']} and {b['name']} overlap; check the drawing")


def wall_of(room: dict, axis: str, line_m: float, tol: float) -> str | None:
    """Which wall of the room a horizontal (axis 'h', z = line) or vertical (axis 'v', x = line) line is."""
    if axis == "h":
        if abs(line_m - room["z"]) <= tol:
            return "N"
        if abs(line_m - (room["z"] + room["d"])) <= tol:
            return "S"
    else:
        if abs(line_m - room["x"]) <= tol:
            return "W"
        if abs(line_m - (room["x"] + room["w"])) <= tol:
            return "E"
    return None


def neighbours(rooms: list[dict], room: dict, wall: str) -> list[dict]:
    out = []
    for o in rooms:
        if o is room:
            continue
        if wall in ("N", "S"):
            line = room["z"] if wall == "N" else room["z"] + room["d"]
            other = o["z"] + o["d"] if wall == "N" else o["z"]
            if abs(line - other) < 0.06 and min(room["x"] + room["w"], o["x"] + o["w"]) - max(room["x"], o["x"]) > 0.6:
                out.append(o)
        else:
            line = room["x"] if wall == "W" else room["x"] + room["w"]
            other = o["x"] + o["w"] if wall == "W" else o["x"]
            if abs(line - other) < 0.06 and min(room["z"] + room["d"], o["z"] + o["d"]) - max(room["z"], o["z"]) > 0.6:
                out.append(o)
    return out


def door(room: str, wall: str, offset: float, width: float = 0.85, kind: str = "door") -> dict:
    h = {"door": 2.0, "opening": 2.1, "window": 1.2}[kind]
    return {"type": kind, "room": room, "wall": wall, "offset_m": round(max(0.0, offset), 2),
            "width_m": round(width, 2), "height_m": h, "sill_m": 0.9 if kind == "window" else 0.0}


def wall_length(room: dict, wall: str) -> float:
    return room["w"] if wall in ("N", "S") else room["d"]


def finish(rooms, openings, warnings, source, ceiling_m=None, wall_m=DEFAULT_WALL, fixtures=None) -> dict:
    taken = {}
    for o in openings:
        if o["type"] != "window":       # furniture may sit under a window, never across a doorway
            taken.setdefault(o["room"], set()).add(o["wall"])
    if fixtures is None:
        fixtures = [f for r in rooms for f in furnish(r, taken)]
    return {"units": "m", "ceiling_m": round(ceiling_m or DEFAULT_CEILING, 2), "wall_thickness_m": round(wall_m, 3),
            "rooms": [{k: r[k] for k in ("name", "x", "z", "w", "d")} for r in rooms],
            "openings": openings, "fixtures": fixtures, "warnings": warnings, "source": source}


def unique_names(rooms: list[dict]):
    seen = {}
    for r in rooms:
        n = r["name"] or "Room"
        seen[n] = seen.get(n, 0) + 1
        if seen[n] > 1:
            r["name"] = f"{n} {seen[n]}"


# ---------------------------------------------------------------- image path


def _vlm_frames(vlm_rooms, size):
    """Qwen VLMs answer boxes on a 0-1000 grid; others in pixels. Return both readings of each box."""
    W, H = size
    out = []
    for r in vlm_rooms:
        b = r.get("bbox_px") or r.get("bbox") or []
        if len(b) != 4:
            out.append(None)
            continue
        b = [float(v) for v in b]
        out.append({"norm": [b[0] * W / 1000, b[1] * H / 1000, b[2] * W / 1000, b[3] * H / 1000], "px": b})
    return out


def _contains(box, p):
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]


def _iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iz = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iz
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def match_rooms(vlm_rooms: list[dict], px_rooms: list[dict], size) -> dict[int, int]:
    """vlm index -> pixel-room index. Picks the box convention (0-1000 grid or pixels) that fits best."""
    frames = _vlm_frames(vlm_rooms, size)
    best_map, best_score = {}, -1.0
    for conv in ("norm", "px"):
        pairs = []
        for vi, f in enumerate(frames):
            if not f:
                continue
            box = f[conv]
            c = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            for pi, pr in enumerate(px_rooms):
                s = _iou(box, pr["bbox"]) + (0.5 if _contains(pr["bbox"], c) else 0.0) \
                    + (0.3 if _contains(box, pr["center"]) else 0.0)
                if s > 0.15:
                    pairs.append((s, vi, pi))
        pairs.sort(reverse=True)
        used_v, used_p, m, total = set(), set(), {}, 0.0
        for s, vi, pi in pairs:
            if vi in used_v or pi in used_p:
                continue
            m[vi] = pi
            used_v.add(vi)
            used_p.add(pi)
            total += s
        if total > best_score:
            best_map, best_score = m, total
    return best_map


def _pick_orientation(label, pw, ph):
    a, b = label
    r1 = (pw / a, ph / b)
    r2 = (pw / b, ph / a)
    spread = lambda r: abs(r[0] - r[1]) / max(r)
    return ((a, b), r1) if spread(r1) <= spread(r2) else ((b, a), r2)


def from_pixels(px: dict, vlm: dict | None, text: str = "", ceiling_m: float | None = None) -> dict:
    """Combine the pixel reading with the VLM's names / labels; scale from labels (or overall text dims)."""
    warnings = []
    rooms_px = px["rooms"]
    if not rooms_px:
        raise ValueError("no closed rooms found in the image (is it a floor plan with dark walls?)")
    vlm_rooms = (vlm or {}).get("rooms") or []
    mapping = match_rooms(vlm_rooms, rooms_px, px["size"]) if vlm_rooms else {}
    by_px = {pi: vi for vi, pi in mapping.items()}
    for vi, r in enumerate(vlm_rooms):
        if vi not in mapping:
            warnings.append(f"the model read a room '{r.get('name', '?')}' that has no closed outline in the drawing; skipped")
    named = []
    for pi, pr in enumerate(rooms_px):
        vr = vlm_rooms[by_px[pi]] if pi in by_px else {}
        name = str(vr.get("name") or "").strip() or f"Room {pi + 1}"
        label_txt = str(vr.get("label") or "")
        named.append({"name": name, "label": parse_dims(label_txt), "label_txt": label_txt, "px": pr})
        if pr["fill"] < 0.8:
            warnings.append(f"{name} is not rectangular in the drawing; used its bounding box")
    unique_names(named)

    # scale: median px-per-metre over every labelled room, robust to one wrong label. Labels are read as
    # wall-centre sizes (the usual convention on plans), i.e. the inner size measured here plus one wall.
    wpx = float(px.get("wall_px") or 0.0)
    cands = []
    for n in named:
        if n["label"]:
            x0, y0, x1, y1 = n["px"]["bbox"]
            (_, ratios) = _pick_orientation(n["label"], x1 - x0 + wpx, y1 - y0 + wpx)
            cands += list(ratios)
    overall = parse_dims(text) if text else None
    if cands:
        scale = statistics.median(cands)
        how = f"scale from {len(cands) // 2} labelled room(s)"
    elif overall:
        xs = [r["bbox"][0] for r in rooms_px] + [r["bbox"][2] for r in rooms_px]
        zs = [r["bbox"][1] for r in rooms_px] + [r["bbox"][3] for r in rooms_px]
        bw, bh = max(xs) - min(xs) + 2 * wpx, max(zs) - min(zs) + 2 * wpx
        (_, ratios) = _pick_orientation(overall, bw, bh)
        scale = sum(ratios) / 2
        how = "scale from the overall dimensions in the text"
    else:
        scale = max(px["size"]) / 12.0
        how = None
        warnings.append("no dimension labels or overall size found; assumed the plan is about 12 m across. "
                        "Add room sizes or 'W x D m wall to wall' to the text for true scale")

    wall_m = max(0.08, min(0.4, wpx / scale)) if wpx else DEFAULT_WALL
    half = wall_m / 2
    rooms = []
    for n in named:
        x0, y0, x1, y1 = n["px"]["bbox"]
        w_m, d_m = (x1 - x0 + wpx) / scale, (y1 - y0 + wpx) / scale   # centre-line size
        if n["label"]:
            (lw, ld), _ = _pick_orientation(n["label"], x1 - x0 + wpx, y1 - y0 + wpx)
            bad_w, bad_d = abs(lw - w_m) / w_m > LABEL_TOL, abs(ld - d_m) / d_m > LABEL_TOL
            if bad_w or bad_d:
                warnings.append(f"{n['name']} is labelled {n['label'][0]:g}×{n['label'][1]:g} but drawn "
                                f"{w_m:.1f}×{d_m:.1f}; used {w_m:.1f}×{d_m:.1f}")
        # inner faces -> wall centre-lines
        rooms.append({"name": n["name"], "x": (x0 - wpx / 2) / scale, "z": (y0 - wpx / 2) / scale, "w": w_m, "d": d_m})
    rooms = snap_rooms(rooms, wall_m, warnings)
    check_overlaps(rooms, warnings)

    # door / window gaps from the drawing
    openings = []
    for g in px.get("gaps", []):
        line_m = g["line"] / scale
        a_m, b_m = g["a"] / scale, g["b"] / scale
        # snap_rooms shifted the plan; re-express the gap in the same frame
        x_shift = (min(r["bbox"][0] for r in rooms_px) - wpx / 2) / scale
        z_shift = (min(r["bbox"][1] for r in rooms_px) - wpx / 2) / scale
        if g["axis"] == "h":
            line, a, b = line_m - z_shift, a_m - x_shift, b_m - x_shift
        else:
            line, a, b = line_m - x_shift, a_m - z_shift, b_m - z_shift
        sides = []
        for r in rooms:
            wall = wall_of(r, g["axis"], line, tol=max(0.2, wall_m))
            if not wall:
                continue
            lo = r["x"] if wall in ("N", "S") else r["z"]
            if lo - 0.1 <= a and b <= lo + wall_length(r, wall) + 0.1:
                sides.append((r, wall, a - lo))
        width = b - a
        if not sides or width < 0.4:
            continue
        r, wall, off = min(sides, key=lambda s: s[0]["w"] * s[0]["d"])
        if len(sides) >= 2:
            kind = "door" if width <= 1.3 else "opening"
        else:
            kind = "door" if room_kind(r["name"]) == "hall" and width <= 1.3 else "window"
        openings.append(door(r["name"], wall, off, width, kind))
    if how:
        warnings.insert(0, how)
    ceil = ceiling_m or parse_ceiling(text) or DEFAULT_CEILING
    return finish(rooms, openings, warnings, "image", ceil, wall_m)


# ---------------------------------------------------------------- text path

ROOM_WORDS = r"(studio|bedsit|ldk|living(?: room)?|lounge|kitchen(?:ette)?|dining(?: room)?|bed(?:room)?s?|master(?: bedroom)?|" \
             r"bath(?:room)?s?|en-?suite|shower(?: room)?|wc|toilet|powder room|study|office|den|hall(?:way)?|corridor|" \
             r"entry|entrance|foyer|genkan|closet|storage|utility|laundry|pantry|balcony|terrace)"
DEFAULT_SIZE = {"bath": (2.0, 1.8), "wc": (1.0, 1.6), "hall": (1.6, 2.0), "closet": (1.2, 1.4),
                "kitchen": (2.6, 3.0), "dining": (3.2, 3.0), "study": (2.8, 2.8), "bedroom": (3.2, 3.4),
                "balcony": (3.0, 1.5)}
SERVICE = ("bath", "wc", "hall", "closet", "kitchen", "dining", "study")


def parse_text_rooms(text: str) -> tuple[list[dict], tuple[float, float] | None, list[str]]:
    """Rooms named in prose (with sizes where given) + overall footprint."""
    t = text or ""
    tl = t.lower()
    notes = []
    rooms = []
    footprint = None
    m = re.search(r"(\d+(?:[.,]\d+)?\s*(?:m|ft|')?\s*(?:x|×|by)\s*\d+(?:[.,]\d+)?\s*(?:m|ft|')?)\s*(?:wall[- ]to[- ]wall|overall|"
                  r"footprint|total|outside|external|in total)", tl)
    if m:
        footprint = parse_dims(m.group(1))
    # Japanese nLDK / nK / nDK and English "2 bed 1 bath"
    jm = re.search(r"\b(\d)\s*(s?ldk|dk|k)\b", tl)
    n_bed = None
    if jm:
        n_bed = int(jm.group(1))
        rooms.append({"name": {"ldk": "LDK", "sldk": "LDK", "dk": "DK", "k": "Kitchen"}[jm.group(2)], "dims": None})
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
    for em in re.finditer(r"(?<![\d.,])\b(\d|one|two|three|four|five)\s*-?\s*(?:bed(?:room)?s?|br)\b", tl):
        if re.search(r"(x|×|by)\s*$", tl[max(0, em.start() - 4):em.start()]):
            continue  # "3 x 3.5 bedroom" is a size, not a count
        if n_bed is None:
            n_bed = words.get(em.group(1)) or int(em.group(1))
        break
    # explicit rooms with optional dims: "bathroom 2x2", "kitchenette", "bedroom 3.5 x 3 m", "a 3 x 3.5 bedroom"
    for rm in re.finditer(r"(?:(" + _PAIR.pattern + r")\s*(?:m|ft)?\s+)?" + ROOM_WORDS +
                          r"\s*(?:of|:|is|at)?\s*(" + _PAIR.pattern + r"(?:\s*(?:m|ft))?)?", tl):
        word = rm.group(4)
        size_txt = rm.group(5) or rm.group(1)
        dims = parse_dims(size_txt) if size_txt else None
        start = rm.start()
        if re.match(r"(\d|one|two|three|four|five)\s*-?\s*$", tl[max(0, start - 6):start]) and \
                room_kind(word) == "bedroom" and not dims:
            continue  # "2 bedrooms" / "one-bed" handled as a count
        name = word.title() if word not in ("ldk", "wc") else word.upper()
        if name == "Studio" and footprint is None and dims:
            footprint = dims
            dims = None
        if word in ("kitchenette",):
            notes.append("kitchenette placed as a counter in the main room")
            continue
        if room_kind(word) == "bedroom" and n_bed and not dims:
            continue
        rooms.append({"name": name, "dims": dims})
    if n_bed:
        named_beds = [r for r in rooms if room_kind(r["name"]) == "bedroom"]
        for i in range(len(named_beds), n_bed):
            rooms.append({"name": f"Bedroom {i + 1}" if n_bed > 1 else "Bedroom", "dims": None})
        if jm and not any(room_kind(r["name"]) == "bath" for r in rooms):
            rooms += [{"name": "Bath", "dims": None}, {"name": "WC", "dims": None}, {"name": "Entry", "dims": None}]
    # dedupe by name
    seen, out = set(), []
    for r in rooms:
        key = r["name"].lower()
        if key in seen and not r["dims"]:
            continue
        seen.add(key)
        out.append(r)
    if footprint is None:
        first = parse_dims(t)
        if first and not any(r["dims"] == first for r in out):
            footprint = first
    return out, footprint, notes


def from_text(text: str, ceiling_m: float | None = None) -> dict:
    """Template layout: service rooms stacked down the west wall, bedrooms down the east wall, the main room
    (LDK / living / studio) takes the middle. Sizes given in the text are kept where they fit."""
    warnings = []
    rooms_req, footprint, notes = parse_text_rooms(text)
    warnings += notes
    main_req = next((r for r in rooms_req if room_kind(r["name"]) in ("ldk", "studio", "living")), None)
    if main_req is None:
        main_req = {"name": "Studio" if "studio" in (text or "").lower() else "Living", "dims": None}
        if not any(room_kind(r["name"]) in ("bedroom",) for r in rooms_req) and not rooms_req:
            warnings.append("no rooms named in the text; built a single open room")
    beds = [r for r in rooms_req if room_kind(r["name"]) == "bedroom"]
    service = [r for r in rooms_req if r is not main_req and room_kind(r["name"]) in SERVICE + ("room",)]
    def depth_in(dims, col_w):
        """The side of a room that runs down its column (the other side is the column width)."""
        return dims[1] if abs(dims[0] - col_w) <= abs(dims[1] - col_w) else dims[0]

    def col_width(items, fallback):
        ws = [min(r["dims"]) if r["dims"] else (DEFAULT_SIZE.get(room_kind(r["name"]), (fallback, 0))[0])
              for r in items]
        return max(ws) if ws else 0.0

    svc_default = lambda r: DEFAULT_SIZE.get(room_kind(r["name"]), (2.0, 2.0))  # noqa: E731
    built, main_d = footprint is None and not parse_area(text), None
    if built:
        # No overall size: build the footprint around the rooms, so every stated size is kept (guessing a
        # footprint from total area squeezed a "living room 5x4" into a 2.4 x 6.9 m strip).
        west_w = col_width(service, 2.0) if service else 0.0
        east_w = col_width(beds, 3.2) if beds else 0.0
        need = max(sum(depth_in(r["dims"] or svc_default(r), west_w) for r in service),
                   sum(depth_in(r["dims"] or DEFAULT_SIZE["bedroom"], east_w) for r in beds), 0.0)
        if main_req.get("dims"):
            a, b = sorted(main_req["dims"])
            # long side down the plan when the sides are deep; take the turn that leaves no slack, or enough for an entry
            opts = [(a, b), (b, a)] if need > a + 1e-6 else [(b, a), (a, b)]
            fits = lambda d: max(need, d) - d < 1e-6 or max(need, d) - d >= 0.9  # noqa: E731
            main_w, main_d = next((o for o in opts if fits(o[1])), opts[0])
        else:
            main_d = max(need, 4.0)
            main_w = min(7.0, max(3.6, round(22 / main_d / 0.1) * 0.1))
        footprint = (west_w + main_w + east_w, max(need, main_d))
        warnings.append(f"no overall size in the text; built {footprint[0]:.1f}×{footprint[1]:.1f} m around the rooms")
    if footprint is None:
        area = sum((r["dims"][0] * r["dims"][1]) if r["dims"] else 9 for r in rooms_req if r is not main_req)
        area += (main_req["dims"][0] * main_req["dims"][1]) if main_req.get("dims") else 22
        area = parse_area(text) or area * 1.08
        W = round(math.sqrt(area * 1.3) / 0.1) * 0.1
        footprint = (W, round(area / W / 0.1) * 0.1)
        warnings.append(f"no overall size in the text; assumed {footprint[0]:.1f}×{footprint[1]:.1f} m")
    W, D = footprint
    if W < D and beds and not built:
        W, D = D, W  # lay long side east-west so three columns fit
    rooms, openings = [], []

    def stack(items, x, col_w, default_kind_size):
        """Stack rooms N->S in a column; fill / squeeze to the footprint depth."""
        sizes = []
        for r in items:
            # the column width is fixed; keep the given depth (the dimension that isn't the width)
            sizes.append(depth_in(r["dims"] or default_kind_size(r), col_w))
        total = sum(sizes)
        if total > D + 1e-6:
            k = D / total
            warnings.append(f"rooms on one side need {total:.1f} m but the footprint is {D:.1f} m deep; scaled them to fit")
            sizes = [s * k for s in sizes]
        placed, z = [], 0.0
        for r, dd in zip(items, sizes):
            placed.append({"name": r["name"], "x": x, "z": z, "w": col_w, "d": dd})
            z += dd
        if D - z > 0.6 and placed and room_kind(placed[-1]["name"]) not in ("hall", "bedroom"):
            placed.append({"name": "Hall", "x": x, "z": z, "w": col_w, "d": D - z})
        elif D - z >= 0.9 and placed and items[-1]["dims"]:   # a bedroom with a stated size keeps it
            placed.append({"name": "Closet" if D - z < 2.2 else "Hall", "x": x, "z": z, "w": col_w, "d": D - z})
        elif placed:
            placed[-1]["d"] += D - z
        return placed

    if not built:
        west_w = min(col_width(service, 2.0), W * 0.4) if service else 0.0
        east_w = min(col_width(beds, 3.2), W * 0.45) if beds else 0.0
    if main_req.get("dims") and not beds and not service:
        W, D = main_req["dims"]
    main_w = W - west_w - east_w
    if main_w < 2.4:
        warnings.append(f"the main room is only {main_w:.1f} m wide; widened the footprint")
        W += 2.4 - main_w
        main_w = 2.4
    service.sort(key=lambda r: room_kind(r["name"]) == "hall")   # the hall goes last and absorbs the slack
    west = stack(service, 0.0, west_w, svc_default) if service else []
    east = stack(beds, west_w + main_w, east_w,
                 lambda r: (east_w, D / len(beds)) if not any(b["dims"] for b in beds) else DEFAULT_SIZE["bedroom"]) \
        if beds else []
    main = {"name": main_req["name"], "x": west_w, "z": 0.0, "w": main_w, "d": D}
    entry = []
    if built and main_d is not None and D - main_d >= 0.9:
        main["d"] = main_d                                  # keep the stated size; the slack is an entry hall
        entry = [{"name": "Entry", "x": west_w, "z": main_d, "w": main_w, "d": D - main_d}]
    elif built and main_req.get("dims") and D - main_d > 0.05:
        warnings.append(f"{main_req['name']} is {D - main_d:.1f} m deeper than asked so the rooms beside it fit")
    rooms = west + [main] + entry + east
    unique_names(rooms)
    for r in rooms:
        for k in ("x", "z", "w", "d"):
            r[k] = round(r[k] / 0.05) * 0.05
    rooms = snap_rooms(rooms, DEFAULT_WALL, warnings)
    main = next(r for r in rooms if r["name"] == main_req["name"])
    # doors from every side room into the main room (or into the hall when the main room isn't adjacent)
    for r in rooms:
        if r is main:
            continue
        wall = "S" if abs(r["x"] - main["x"]) < 0.01 else "E" if r["x"] < main["x"] else "W"
        if wall == "S":                                     # the entry under the main room opens north into it
            wall = "N"
        if neighbours(rooms, r, wall):
            openings.append(door(r["name"], wall, min(0.3, wall_length(r, wall) - 0.9), 0.8))
    # entrance: west wall of the hall/entry if there is one, else the main room's south wall
    hall = next((r for r in rooms if room_kind(r["name"]) == "hall"), None)
    if hall:
        openings.append(door(hall["name"], "W" if hall["x"] == 0 else "S", 0.3, 0.9))
    else:
        openings.append(door(main["name"], "S", 0.4, 0.9))
    # windows on exterior walls of the main room and bedrooms
    for r in [main] + [b for b in rooms if room_kind(b["name"]) == "bedroom"]:
        for wall in ("S", "E") if r is not main else ("S", "N"):
            if neighbours(rooms, r, wall):
                continue
            L = wall_length(r, wall)
            if L >= 2.0 and not (r is main and wall == "S" and not hall):
                ww = min(1.8, L - 0.8)
                openings.append(door(r["name"], wall, (L - ww) / 2, ww, "window"))
    ceil = ceiling_m or parse_ceiling(text) or DEFAULT_CEILING
    return finish(rooms, openings, warnings, "text", ceil)
