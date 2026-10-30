"""Pixel reading of a floor-plan image: walls, rooms and door gaps, with no model.

The VLM is good at reading names and dimension labels but its boxes are coarse (Qwen answers on a 0-1000
grid and drifts by 10-30 %). Walls are easy to measure exactly, so geometry comes from here:

1. dark pixels -> connected pieces; pieces that span a good part of the plan are walls, the rest (text,
   door swings, furniture symbols) is dropped;
2. door gaps: along each row / column, a gap between a long wall run and the next wall pixel that is shorter
   than a door is bridged, and recorded as an opening;
3. rooms: the free space left between the (bridged) walls, minus whatever touches the image border.
All coordinates returned are in ORIGINAL image pixels.
"""
from __future__ import annotations

import numpy as np
from PIL import Image
from scipy import ndimage

MAX_SIDE = 900


def load_gray(path_or_image) -> tuple[np.ndarray, float]:
    im = path_or_image if isinstance(path_or_image, Image.Image) else Image.open(path_or_image)
    im = im.convert("L")
    scale = min(1.0, MAX_SIDE / max(im.size))
    if scale < 1.0:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.BILINEAR)
    return np.asarray(im, dtype=np.uint8), scale


def _runs(line: np.ndarray):
    """(start, end) of True runs in a 1-D bool array."""
    d = np.diff(np.concatenate(([0], line.view(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def wall_mask(gray: np.ndarray) -> tuple[np.ndarray, float]:
    dark = gray < 110
    h, w = dark.shape
    lab, n = ndimage.label(dark, structure=np.ones((3, 3)))
    if n == 0:
        return dark, 0.0
    objs = ndimage.find_objects(lab)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(objs, 1):
        bh, bw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if bw >= 0.12 * w or bh >= 0.12 * h:
            keep[i] = True
    walls = keep[lab]
    # wall thickness: the typical short run across walls (rows crossing vertical walls and vice versa)
    runs = [e - s for row in walls[:: max(1, h // 120)] for s, e in _runs(row) if e - s <= 0.05 * w]
    runs += [e - s for col in walls.T[:: max(1, w // 120)] for s, e in _runs(col) if e - s <= 0.05 * h]
    thick = float(np.median(runs)) if runs else 3.0
    # thin lines that survived (a long dimension line, a hatch) are thinner than walls: open them away
    k = max(1, int(round(thick * 0.5)))
    if k >= 2:
        opened = ndimage.binary_opening(walls, structure=np.ones((k, k)))
        if opened.sum() > 0.5 * walls.sum():
            walls = opened
    return walls, thick


def bridge_gaps(walls: np.ndarray, thick: float, max_gap_frac: float = 0.3):
    """Close door / window gaps in walls. Returns (closed mask, gaps) where each gap is
    {"axis": "h"|"v", "line": centre row/col, "a": start, "b": end} in working pixels."""
    closed = walls.copy()
    h, w = walls.shape
    long_run = max(3 * thick, 10)
    gaps = []
    for axis, mat in (("h", walls), ("v", walls.T)):
        span = mat.shape[1]
        max_gap = max_gap_frac * max(h, w)
        max_gap_corner = 0.12 * max(h, w)
        hits = {}
        for r in range(mat.shape[0]):
            runs = _runs(mat[r])
            for (s0, e0), (s1, e1) in zip(runs, runs[1:]):
                g = s1 - e0
                both = e0 - s0 >= long_run and e1 - s1 >= long_run
                one = e0 - s0 >= long_run or e1 - s1 >= long_run
                # wall on both sides: a door or window mid-wall (windows can be wide). Wall on one side only: a door
                # next to a corner, which is short; longer one-sided gaps are T-junctions (a wall ending on another)
                if 2 < g <= (max_gap if both else max_gap_corner) and one:
                    hits.setdefault((e0, s1), []).append(r)
        for (a, b), rows in hits.items():
            rows = sorted(rows)
            # a real wall gap is crossed by about the wall's thickness worth of rows, all bridging the same span
            groups, cur = [], [rows[0]]
            for r in rows[1:]:
                if r - cur[-1] <= 1:
                    cur.append(r)
                else:
                    groups.append(cur)
                    cur = [r]
            groups.append(cur)
            for grp in groups:
                if len(grp) < max(2, 0.5 * thick) or len(grp) > 3 * thick + 2:
                    continue
                for r in grp:
                    if axis == "h":
                        closed[r, a:b] = True
                    else:
                        closed[a:b, r] = True
                gaps.append({"axis": axis, "line": float(np.mean(grp)), "a": int(a), "b": int(b), "span": span})
    return closed, gaps


def find_rooms(closed: np.ndarray, min_area_frac: float = 0.004):
    free = ~closed
    lab, n = ndimage.label(free)
    h, w = free.shape
    rooms = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        if sl is None:
            continue
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        if y0 == 0 or x0 == 0 or y1 == h or x1 == w:  # outside the building
            continue
        area = int((lab[sl] == i).sum())
        if area < min_area_frac * h * w:
            continue
        rooms.append({"bbox": [x0, y0, x1, y1], "area": area, "fill": area / max(1, (x1 - x0) * (y1 - y0))})
    return rooms


def read_plan_pixels(path_or_image) -> dict:
    """Rooms (inner wall faces), door/window gaps and wall thickness, in original image pixels."""
    gray, s = load_gray(path_or_image)
    walls, thick = wall_mask(gray)
    closed, gaps = bridge_gaps(walls, thick)
    rooms = find_rooms(closed)
    inv = 1.0 / s
    for r in rooms:
        r["bbox"] = [round(v * inv, 1) for v in r["bbox"]]
        r["center"] = [(r["bbox"][0] + r["bbox"][2]) / 2, (r["bbox"][1] + r["bbox"][3]) / 2]
    for g in gaps:
        for k in ("line", "a", "b"):
            g[k] = round(g[k] * inv, 1)
    h, w = gray.shape
    return {"size": [round(w * inv), round(h * inv)], "rooms": rooms, "gaps": gaps,
            "wall_px": round(thick * inv, 2)}
