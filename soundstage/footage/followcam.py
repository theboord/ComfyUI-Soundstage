"""Follow-cam crop + paste-back for Recast: small performers get the model's full resolution.

A video model re-renders the whole frame at its own resolution (LTX stage 1 at ~544 px tall). A performer 150 px tall
in a 1080p plate becomes ~75 px of latent: the face and hands come back mush. So, for a small performer, Recast
renders a virtual camera that follows them: a smooth per-frame crop around the subject, at the plate's aspect,
scaled up to the plate's size. The engine swaps the character in that crop; the result is scaled back down into the
crop's rect on the untouched full-resolution plate, inside the subject matte, with a soft ramp at crop edges that
are not plate edges.

Pure torch + numpy, no ComfyUI imports. IMAGE = [N, H, W, C] float 0..1, MASK = [N, H, W] float 0..1.

plan_crops() and the edge ramp in paste_ramp() are adapted from Body Double's bodydouble/media.py (plan_crops,
composite) by lucataco, https://github.com/lucataco/open-source-higgsfield, Apache License 2.0, Copyright 2026
lucataco; see THIRD_PARTY_NOTICES.md and NOTICE. Changes (Soundstage, 2026-11-02): ported from PIL to torch tensors;
the crop keeps the plate's aspect and is scaled to the plate's size, so the Recast engines need no new sizes; a
zoom cap (max_zoom) so a tiny or distant subject is not blown up past what the plate can resolve; an `auto` rule
(follow only when the subject is small); rects are integer pixel boxes; paste-back builds a full-frame canvas and a
crop-box alpha instead of pasting into a PIL image.
"""
from __future__ import annotations

import json

import numpy as np
import torch
import torch.nn.functional as F

MODES = ("auto", "on", "off")


def _smooth(values, radius):
    """Centred moving average that holds the ends."""
    v = np.asarray(values, dtype=np.float64)
    if radius <= 0 or len(v) < 2:
        return v
    padded = np.concatenate([np.full(radius, v[0]), v, np.full(radius, v[-1])])
    return np.convolve(padded, np.ones(2 * radius + 1) / (2 * radius + 1), mode="valid")


def boxes_from_masks(masks, thresh=0.5):
    """Per-frame (x0, y0, x1, y1) of the mask, or None where it is empty."""
    out = []
    for m in masks:
        ys, xs = torch.nonzero(m > thresh, as_tuple=True)
        out.append(None if ys.numel() == 0 else (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    return out


def subject_height_frac(masks):
    """Median subject box height over the plate height (0 if never seen)."""
    hs = [b[3] - b[1] for b in boxes_from_masks(masks) if b is not None]
    return float(np.median(hs)) / masks.shape[1] if hs else 0.0


def plan_crops(boxes, src_w, src_h, aspect=None, margin=1.45, radius=12, max_zoom=4.0):
    """One crop rect per frame [x0, y0, w, h] (integer px), aspect = w/h (default: the plate's), following the
    subject smoothly. Frames where the track lost them hold the nearest tracked box."""
    aspect = aspect or src_w / src_h
    idx = [i for i, b in enumerate(boxes) if b is not None]
    if not idx:
        raise ValueError("the performer was never tracked")
    b = np.array([boxes[min(idx, key=lambda k: abs(k - i))] for i in range(len(boxes))], dtype=np.float64)
    cx, cy = (b[:, 0] + b[:, 2]) / 2, (b[:, 1] + b[:, 3]) / 2
    need_h = np.maximum((b[:, 3] - b[:, 1]) * margin, (b[:, 2] - b[:, 0]) * margin / aspect)
    max_h = min(src_h, src_w / aspect)
    need_h = np.clip(need_h, max_h / max(1.0, max_zoom), max_h)
    # smooth zoom, but never much tighter than the local need, so limbs aren't cut when the performer opens up
    h = np.maximum(_smooth(need_h, radius), _smooth(need_h, 2))
    cx, cy = _smooth(cx, radius), _smooth(cy, radius)
    rects = []
    for x, y, hh in zip(cx, cy, h):
        hh = min(hh, max_h)
        ww = hh * aspect
        rw, rh = max(2, min(src_w, int(round(ww)))), max(2, min(src_h, int(round(hh))))
        x0 = int(round(min(max(x - rw / 2, 0), src_w - rw)))
        y0 = int(round(min(max(y - rh / 2, 0), src_h - rh)))
        rects.append([x0, y0, rw, rh])
    return rects


def full_rects(n, w, h):
    return [[0, 0, int(w), int(h)] for _ in range(n)]


def is_identity(rects, w, h):
    return all(list(r) == [0, 0, int(w), int(h)] for r in rects)


def decide(masks, mode="auto", below=0.4, margin=1.45, radius=12, max_zoom=4.0):
    """(rects, info) for a [N,H,W] subject mask. off, or auto with a big subject, gives full-frame rects."""
    n, h, w = masks.shape
    frac = subject_height_frac(masks)
    follow = mode == "on" or (mode == "auto" and 0 < frac < below)
    info = {"mode": mode, "subject_height_frac": round(frac, 4), "follow": False}
    if not follow or frac == 0:
        return full_rects(n, w, h), info
    rects = plan_crops(boxes_from_masks(masks), w, h, margin=margin, radius=radius, max_zoom=max_zoom)
    if is_identity(rects, w, h):
        return rects, info
    zoom = [h / r[3] for r in rects]
    info.update(follow=True, zoom_min=round(min(zoom), 3), zoom_max=round(max(zoom), 3))
    return rects, info


def _resize(x, h, w, mode):
    """x NCHW -> (h, w)."""
    if x.shape[-2:] == (h, w):
        return x
    if mode == "bicubic":
        return F.interpolate(x, size=(h, w), mode="bicubic", align_corners=False,
                             antialias=(h < x.shape[2] or w < x.shape[3])).clamp(0, 1)
    return F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False).clamp(0, 1)


def crop_frames(images, rects, mode="bicubic"):
    """[N,H,W,C] -> each frame's rect scaled to the full H x W. Identity rects return the frames untouched."""
    n, h, w = images.shape[:3]
    if is_identity(rects, w, h):
        return images
    out = torch.empty_like(images)
    for i, (x0, y0, rw, rh) in enumerate(rects[:n]):
        c = images[i:i + 1, y0:y0 + rh, x0:x0 + rw].movedim(-1, 1)
        out[i] = _resize(c.float(), h, w, mode).movedim(1, -1)[0].to(images.dtype)
    return out


def crop_masks(masks, rects):
    if masks is None:
        return None
    return crop_frames(masks.unsqueeze(-1), rects, mode="bilinear")[..., 0]


def paste_ramp(rect, w, h, edge=0.02):
    """[rh, rw] alpha ramp that fades the crop out over `edge` of its size, except along plate borders
    (a crop touching the frame edge has nothing to blend into there)."""
    x, y, rw, rh = rect
    e = max(1, int(min(rw, rh) * edge))
    ax = torch.minimum(torch.arange(rw) + 1, torch.arange(rw).flip(0) + 1).clamp(max=e).float() / e
    ay = torch.minimum(torch.arange(rh) + 1, torch.arange(rh).flip(0) + 1).clamp(max=e).float() / e
    if x <= 0:
        ax[:e] = 1.0
    if y <= 0:
        ay[:e] = 1.0
    if x + rw >= w:
        ax[-e:] = 1.0
    if y + rh >= h:
        ay[-e:] = 1.0
    return ay[:, None] * ax[None, :]


def uncrop(crop, rects, plate, edge=0.02):
    """Crop-space frames [N,H,W,C] (each = its rect scaled to H x W) back to plate space.

    Returns (canvas [N,H,W,C]: the plate with each rect replaced by its crop scaled down, box [N,H,W]: the ramped
    rect where the canvas holds crop pixels, 0 elsewhere). Identity rects: (crop, ones)."""
    n, h, w = plate.shape[:3]
    if is_identity(rects, w, h):
        return crop, torch.ones(n, h, w, device=plate.device)
    canvas = plate[..., :crop.shape[-1]].clone() if plate.shape[-1] >= crop.shape[-1] else \
        torch.zeros(n, h, w, crop.shape[-1], device=plate.device, dtype=crop.dtype)
    box = torch.zeros(n, h, w, device=plate.device)
    for i, r in enumerate(rects[:n]):
        x0, y0, rw, rh = r
        c = _resize(crop[i:i + 1].movedim(-1, 1).float(), rh, rw, "bicubic").movedim(1, -1)[0]
        canvas[i, y0:y0 + rh, x0:x0 + rw] = c.to(canvas.dtype)
        box[i, y0:y0 + rh, x0:x0 + rw] = paste_ramp(r, w, h, edge).to(box.device)
    return canvas, box


def uncrop_mask(mask, rects, h, w):
    """A crop-space mask [N,H,W] back to plate space (0 outside each rect)."""
    if mask is None:
        return None
    n = mask.shape[0]
    if is_identity(rects, w, h):
        return mask
    out = torch.zeros(n, h, w, device=mask.device)
    for i, (x0, y0, rw, rh) in enumerate(rects[:n]):
        out[i, y0:y0 + rh, x0:x0 + rw] = _resize(mask[i:i + 1, None].float(), rh, rw, "bilinear")[0, 0]
    return out


def dumps(rects, info=None):
    return json.dumps({"kind": "soundstage.followcam", "version": 1, "rects": [list(map(int, r)) for r in rects],
                       **(info or {})})


def loads(text):
    """crop_json -> rects (None for '' or no rects)."""
    if not text:
        return None
    d = json.loads(text) if isinstance(text, str) else text
    r = d.get("rects") if isinstance(d, dict) else d
    return [list(map(int, x)) for x in r] if r else None
