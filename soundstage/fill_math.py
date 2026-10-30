"""Generative Fill math for Paint Studio: crop-and-stitch inpaint / outpaint, in plain numpy.

The model only ever sees a crop around the mask (plus context), sized to what it was trained on; the result is
pasted back through a feathered alpha, colour-matched on a ring of untouched pixels, so everything outside the
blend region stays bit-identical to the original. Shapes: images H x W x C float 0..1, masks H x W float 0..1
(1 = regenerate). Boxes are (x, y, w, h) ints in image pixels. No torch here: the nodes convert at the edges.
"""
from __future__ import annotations

import json
import math

import numpy as np

MODES = ("fill", "remove", "replace", "extend")


# ---------------------------------------------------------------- morphology / blur

def _slide(a: np.ndarray, r: int, axis: int, op) -> np.ndarray:
    """Sliding max/min over a window of 2r+1 along one axis (log-doubling, edge-padded)."""
    if r <= 0:
        return a
    a = np.moveaxis(a, axis, -1)
    n = a.shape[-1]
    span_len = 2 * r + 1
    out = np.pad(a, [(0, 0)] * (a.ndim - 1) + [(r, r)], mode="edge")
    cover = 1
    while cover * 2 <= span_len:
        out = op(out[..., :-cover], out[..., cover:])
        cover *= 2
    rem = span_len - cover
    if rem > 0:
        out = op(out[..., :-rem], out[..., rem:])
    return np.moveaxis(out[..., :n], -1, axis)


def grow(mask: np.ndarray, px: int) -> np.ndarray:
    """Dilate (px > 0) or erode (px < 0) a mask by px pixels (square structuring element)."""
    px = int(px)
    if px == 0:
        return mask.astype(np.float32, copy=True)
    op = np.maximum if px > 0 else np.minimum
    r = abs(px)
    return _slide(_slide(mask.astype(np.float32), r, 0, op), r, 1, op)


def _box(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r <= 0:
        return a
    a = np.moveaxis(a, axis, -1)
    n = a.shape[-1]
    p = np.pad(a, [(0, 0)] * (a.ndim - 1) + [(r + 1, r)], mode="edge")
    c = np.cumsum(p, axis=-1, dtype=np.float64)
    k = 2 * r + 1
    out = (c[..., k:] - c[..., :-k]) / k
    return np.moveaxis(out[..., :n].astype(np.float32), -1, axis)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian-like blur (three box passes) over the first two axes; works on masks and images."""
    if sigma <= 0.3:
        return a.astype(np.float32, copy=True)
    r = max(1, int(round((math.sqrt(4 * sigma * sigma + 1) - 1) / 2)))
    out = a.astype(np.float32)
    for _ in range(3):
        out = _box(_box(out, r, 0), r, 1)
    return out


# ---------------------------------------------------------------- boxes and sizes

def mask_bbox(mask: np.ndarray, thresh: float = 0.02):
    """(x0, y0, x1, y1) of mask > thresh, exclusive end, or None when empty."""
    on = mask > thresh
    rows, cols = np.flatnonzero(on.any(1)), np.flatnonzero(on.any(0))
    if not rows.size:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def crop_box(bbox, width: int, height: int, context: float = 0.6, min_side: int = 384, pad_min: int = 48):
    """The region the model sees: the mask's box grown by `context` x its longer side (at least pad_min px a side),
    at least min_side square-ish, shifted (never shrunk) to stay inside the image. Returns (x, y, w, h)."""
    x0, y0, x1, y1 = bbox
    pad = max(float(pad_min), float(context) * max(x1 - x0, y1 - y0))
    cx0, cy0, cx1, cy1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad

    def widen(a0, a1, want, limit):
        if a1 - a0 < want:
            c = (a0 + a1) / 2
            a0, a1 = c - want / 2, c + want / 2
        if a1 - a0 >= limit:
            return 0.0, float(limit)
        if a0 < 0:
            a0, a1 = 0.0, a1 - a0
        if a1 > limit:
            a0, a1 = a0 - (a1 - limit), float(limit)
        return a0, a1

    cx0, cx1 = widen(cx0, cx1, min(min_side, width), width)
    cy0, cy1 = widen(cy0, cy1, min(min_side, height), height)
    x, y = int(math.floor(cx0)), int(math.floor(cy0))
    w, h = int(math.ceil(cx1)) - x, int(math.ceil(cy1)) - y
    return x, y, min(w, width - x), min(h, height - y)


def fit_size(w: int, h: int, megapixels: float = 1.0, multiple: int = 16, max_upscale: float = 4.0):
    """Model resolution for a w x h crop: about `megapixels` (1.0 = 1024 x 1024), same aspect, multiple of 16."""
    scale = math.sqrt(megapixels * 1024 * 1024 / max(1, w * h))
    scale = min(scale, max_upscale)
    tw = max(multiple, int(round(w * scale / multiple)) * multiple)
    th = max(multiple, int(round(h * scale / multiple)) * multiple)
    return tw, th


def pad_amounts(width: int, height: int, aspect: float, anchor: str = "center"):
    """Padding (left, top, right, bottom) that extends a picture to `aspect` (w/h) without cropping. Anchor 'left' keeps the picture on the left (new area on the right) etc."""
    if aspect <= 0 or abs(width / height - aspect) < 1e-3:
        return 0, 0, 0, 0
    if aspect > width / height:
        extra = int(round(height * aspect)) - width
        left = 0 if anchor == "left" else extra if anchor == "right" else extra // 2
        return left, 0, extra - left, 0
    extra = int(round(width / aspect)) - height
    top = 0 if anchor == "top" else extra if anchor == "bottom" else extra // 2
    return 0, top, 0, extra - top


def pad_image(img: np.ndarray, left: int, top: int, right: int, bottom: int):
    """Grow the canvas by the given pads: (image with the new area pre-filled from the edges, mask 1 = new area)."""
    h, w = img.shape[:2]
    out = np.zeros((h + top + bottom, w + left + right, img.shape[2]), np.float32)
    out[top:top + h, left:left + w] = img
    hole = np.ones(out.shape[:2], np.float32)
    hole[top:top + h, left:left + w] = 0
    return prefill(out, hole), hole


# ---------------------------------------------------------------- hole pre-fill

def prefill(img: np.ndarray, hole: np.ndarray) -> np.ndarray:
    """Fill the hole (mask >= 0.5) with a smooth continuation of the colours around it (push-pull pyramid).
    Gives the model a neutral start for Remove / Extend instead of the object or black."""
    valid = (hole < 0.5).astype(np.float32)
    if valid.min() >= 1:
        return img.astype(np.float32, copy=True)
    if valid.max() <= 0:
        return np.full_like(img, 0.5, dtype=np.float32)
    c = img.shape[2]
    levels = []
    col, wt = img.astype(np.float32) * valid[..., None], valid
    while min(wt.shape) > 1:
        levels.append((col, wt))
        h, w = wt.shape
        ph, pw = h % 2, w % 2
        ci = np.pad(col, ((0, ph), (0, pw), (0, 0)), mode="edge")
        cw = np.pad(wt, ((0, ph), (0, pw)), mode="edge")
        h2, w2 = cw.shape[0] // 2, cw.shape[1] // 2
        ci = ci.reshape(h2, 2, w2, 2, c).sum((1, 3))
        cw = cw.reshape(h2, 2, w2, 2).sum((1, 3))
        mean = ci / np.maximum(cw, 1e-6)[..., None]
        wt = np.minimum(cw, 1.0)
        col = mean * wt[..., None]
    top_col, top_w = col, wt
    flat = top_col.reshape(-1, c).sum(0) / max(float(top_w.sum()), 1e-6)
    cur = np.where(top_w[..., None] > 0, top_col / np.maximum(top_w, 1e-6)[..., None], flat)
    for li, lw in reversed(levels):
        h, w = lw.shape
        up = np.repeat(np.repeat(cur, 2, 0), 2, 1)[:h, :w]
        up = blur(up, 1.0)
        fine = li / np.maximum(lw, 1e-6)[..., None]
        cur = fine * lw[..., None] + up * (1 - lw[..., None])
    out = img.astype(np.float32, copy=True)
    sel = hole >= 0.5
    out[sel] = cur[sel]
    return out


# ---------------------------------------------------------------- crop / stitch

def regen_mask(mask: np.ndarray, mode: str, grow_px: int = 8, overlap: int = 48) -> np.ndarray:
    """What the model may repaint. Extend: the new area plus `overlap` px into the picture, so the seam is
    generated, not glued. Remove: the object grown a little more (halos and shadows go too)."""
    m = (mask > 0.02).astype(np.float32) * np.clip(mask, 0, 1)
    m = np.maximum(m, (mask > 0.5).astype(np.float32))
    if mode == "extend":
        return np.clip(grow(m, max(grow_px, overlap)), 0, 1)
    if mode == "remove":
        return np.clip(grow(m, grow_px + 8), 0, 1)
    return np.clip(grow(m, grow_px), 0, 1)


def plan_crop(mask: np.ndarray, mode: str = "fill", grow_px: int = 8, context: float = 0.6, overlap: int = 48,
              feather: int = 24, megapixels: float = 1.0):
    """Everything about a fill that is pure geometry: {'regen': mask, 'box': (x,y,w,h), 'size': (tw,th)}."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, not {mode!r}")
    h, w = mask.shape
    regen = regen_mask(mask, mode, grow_px, overlap)
    bb = mask_bbox(regen)
    if bb is None:
        raise ValueError("The mask is empty: paint, select or extend the area to fill first.")
    # The crop must hold the whole feathered seam plus a ring for colour matching.
    pad_min = max(48, int(feather) + 24)
    box = crop_box(bb, w, h, context=context, pad_min=pad_min)
    return {"regen": regen, "box": box, "size": fit_size(box[2], box[3], megapixels)}


def crop_inputs(img: np.ndarray, mask: np.ndarray, plan: dict, mode: str):
    """(crop image for the model at native box size, crop regen mask). Extend pre-fills the empty border (the model
    repaints the masked area from noise anyway; this keeps partner models and denoise < 1 sane). Remove keeps the
    real pixels: the edit model needs to see what it is removing."""
    x, y, w, h = plan["box"]
    crop = img[y:y + h, x:x + w].astype(np.float32, copy=True)
    regen = plan["regen"][y:y + h, x:x + w].copy()
    if mode == "extend":
        crop = prefill(crop, (mask[y:y + h, x:x + w] > 0.5).astype(np.float32))
    return crop, regen


def blend_alpha(regen: np.ndarray, feather: int) -> np.ndarray:
    """Paste alpha: 1 inside the regen mask, a soft ramp `feather` px outward, exactly 0 beyond it."""
    m = np.clip(regen, 0, 1).astype(np.float32)
    f = int(feather)
    if f <= 0:
        return (m > 0.5).astype(np.float32)
    soft = blur(grow(m, max(1, f // 2)), max(0.5, f / 4.0))
    soft = np.clip((soft - 0.06) / 0.94, 0, 1)
    a = np.maximum(m, soft)
    a[grow(m, f) <= 0.0] = 0.0
    return a


def color_match(edited: np.ndarray, original: np.ndarray, ring: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Match edited's per-channel mean / contrast to original on `ring` (pixels both should share)."""
    if ring.sum() < 64:
        return edited
    e, o = edited[ring], original[ring]
    me, mo = e.mean(0), o.mean(0)
    se, so = e.std(0) + 1e-4, o.std(0) + 1e-4
    k = np.clip(so / se, 0.75, 1.33)
    out = (edited - me) * k + mo
    out = edited + (out - edited) * float(strength)
    return np.clip(out, 0, 1).astype(np.float32)


def stitch(original: np.ndarray, edited: np.ndarray, regen: np.ndarray, box, feather: int = 24,
           match_color: bool = True):
    """Paste `edited` (already at box size) into `original` through the feathered regen mask.
    Returns (result, alpha). Pixels where alpha is 0, and everything outside the box, are untouched."""
    x, y, w, h = box
    if edited.shape[:2] != (h, w):
        raise ValueError(f"edited crop is {edited.shape[1]}x{edited.shape[0]}, box is {w}x{h}")
    # Everything is computed inside the box: the crop keeps room for the seam (plan_crop's pad_min).
    rg = np.clip(regen[y:y + h, x:x + w], 0, 1).astype(np.float32)
    a = blend_alpha(rg, feather)
    alpha = np.zeros(regen.shape, np.float32)
    alpha[y:y + h, x:x + w] = a
    o = original[y:y + h, x:x + w]
    e = edited[..., :o.shape[2]].astype(np.float32)
    if match_color:
        ring = (grow(rg, int(feather) + 24) > 0.5) & (a <= 0)
        e = color_match(e, o, ring)
    out = original.astype(np.float32, copy=True)
    out[y:y + h, x:x + w] = o * (1 - a[..., None]) + e * a[..., None]
    return out, alpha


def box_json(box, size=None) -> str:
    d = {"x": int(box[0]), "y": int(box[1]), "w": int(box[2]), "h": int(box[3])}
    if size:
        d["tw"], d["th"] = int(size[0]), int(size[1])
    return json.dumps(d)


def parse_box(text: str):
    d = json.loads(text)
    return int(d["x"]), int(d["y"]), int(d["w"]), int(d["h"])
