"""Compare a Soundstage silhouette with a DCC render of the same frame (Milestone 12 round-trip check).

  python3 tools/interop/compare_frames.py <soundstage_mask.png> <dcc_render.png> [overlay_out.png]

The Soundstage mask is white geometry on black (rendered through the shot camera); the DCC render is an RGBA frame
with a transparent background (Blender: Film > Transparent). Prints IoU, the fraction of pixels that disagree, the
centroid offset in pixels and the mean distance between the two outlines; writes an overlay (green = both,
red = Soundstage only, blue = DCC only).
"""
import json
import sys

import numpy as np
from PIL import Image


def masks(ss_path, dcc_path):
    a = np.asarray(Image.open(ss_path).convert("L"), dtype=np.float32) > 127
    im = Image.open(dcc_path)
    if im.size != (a.shape[1], a.shape[0]):
        im = im.resize((a.shape[1], a.shape[0]), Image.NEAREST)
    arr = np.asarray(im.convert("RGBA"), dtype=np.float32)
    b = arr[..., 3] > 127
    return a, b


def edges(m):
    e = np.zeros_like(m)
    e[1:-1, 1:-1] = m[1:-1, 1:-1] & ~(m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:])
    return e


def chamfer(a_edges, b_edges):
    """Mean distance (px) from each edge pixel of a to the nearest edge pixel of b (brute force on a coarse sample)."""
    pa = np.argwhere(a_edges)
    pb = np.argwhere(b_edges)
    if not len(pa) or not len(pb):
        return float("nan")
    if len(pa) > 4000:
        pa = pa[np.linspace(0, len(pa) - 1, 4000).astype(int)]
    d = []
    for i in range(0, len(pa), 256):
        chunk = pa[i:i + 256][:, None, :] - pb[None, :, :]
        d.append(np.sqrt((chunk ** 2).sum(-1)).min(1))
    return float(np.concatenate(d).mean())


def compare(ss_path, dcc_path, overlay=None):
    a, b = masks(ss_path, dcc_path)
    inter, union = (a & b).sum(), (a | b).sum()
    ca = np.argwhere(a).mean(0) if a.any() else np.zeros(2)
    cb = np.argwhere(b).mean(0) if b.any() else np.zeros(2)
    ea, eb = edges(a), edges(b)
    out = {
        "iou": round(float(inter / union) if union else 1.0, 4),
        "pixels_disagree": round(float((a ^ b).mean()), 5),
        "centroid_offset_px": round(float(np.linalg.norm(ca - cb)), 3),
        "outline_distance_px": round((chamfer(ea, eb) + chamfer(eb, ea)) / 2, 3),
        "coverage": [round(float(a.mean()), 4), round(float(b.mean()), 4)],
        "size": [int(a.shape[1]), int(a.shape[0])],
    }
    if overlay:
        img = np.zeros(a.shape + (3,), dtype=np.uint8)
        img[a & b] = (60, 200, 90)
        img[a & ~b] = (230, 60, 60)
        img[~a & b] = (70, 120, 255)
        Image.fromarray(img).save(overlay)
    return out


if __name__ == "__main__":
    print(json.dumps(compare(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)))
