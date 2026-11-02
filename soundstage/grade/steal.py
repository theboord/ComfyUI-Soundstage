"""Steal the look: read a reference frame's grade (tone curve, cast, saturation, palette, grain) and turn it into a
Soundstage Look: the nearest film-stock preset, the Look tab's grade sliders, a custom palette, plus a CDL and a
tone curve that the NLE package bakes into a 33^3 .cube.

How the grade is separated from the picture: the frame is "neutralised" (grey-world cast removed on its
mid-tones, lightness redistributed to an even spread, chroma brought to an ordinary level), then
`fit_cdl` finds the CDL that takes the neutral version back to the reference in OKLab, and a 17-knot tone curve
takes the rest of the way (quantile to quantile on lightness, blended halfway to the identity so it never posterises).
Apply CDL then curve to ordinary Rec.709 footage and it takes on the reference's grade.

Film-stock profiles below are written for this project by eye from each stock's published character (the same
words the Look vocabulary uses): rough numbers, not measured characteristic curves. They only pick the nearest
preset; the CDL and curve carry the actual grade.
"""
from __future__ import annotations

import numpy as np

from .cdl import apply_cdl, fit_cdl, normalize_curve
from .colour import LUMA_709, downscale, frame_stats, linear_to_srgb, pixels, srgb_to_linear, srgb_to_oklab, to_hex

# id: (contrast, saturation, warmth_ev, tint_ev, black (display luma Y' at the 5th percentile), grain 0..1, black-and-white)
STOCK_PROFILES = {
    "kodak_500t": (0.10, 0.00, 0.10, 0.00, 0.14, 0.35, False),
    "kodak_250d": (0.05, 0.05, 0.15, 0.00, 0.12, 0.20, False),
    "kodak_50d": (0.15, 0.25, 0.10, 0.00, 0.10, 0.05, False),
    "kodak_200t": (0.05, 0.00, -0.05, 0.00, 0.12, 0.20, False),
    "fuji_eterna_500": (-0.35, -0.35, -0.15, 0.12, 0.20, 0.30, False),
    "ektachrome": (0.50, 0.55, -0.05, 0.00, 0.06, 0.15, False),
    "kodachrome": (0.35, 0.50, 0.35, -0.03, 0.08, 0.15, False),
    "cinestill_800t": (0.15, 0.15, -0.35, 0.00, 0.12, 0.45, False),
    "technicolor_ib": (0.45, 0.80, 0.15, 0.00, 0.05, 0.10, False),
    "eastmancolor_faded": (-0.40, -0.40, 0.20, -0.20, 0.28, 0.35, False),
    "bleach_bypass": (0.70, -0.65, 0.00, 0.00, 0.05, 0.30, False),
    "cross_processed": (0.55, 0.45, 0.10, 0.30, 0.10, 0.25, False),
    "push_2": (0.60, 0.10, 0.00, 0.00, 0.10, 0.80, False),
    "double_x": (0.30, -1.00, 0.00, 0.00, 0.08, 0.50, True),
    "tri_x": (0.60, -1.00, 0.00, 0.00, 0.05, 0.65, True),
    "ilford_hp5": (0.00, -1.00, 0.00, 0.00, 0.15, 0.45, True),
    "aerochrome": (0.40, 0.90, 0.20, -0.45, 0.08, 0.30, False),
    "digital_clean": (0.00, 0.00, 0.00, 0.00, 0.10, 0.00, False),
    "arri_log_look": (-0.15, -0.05, 0.05, 0.00, 0.14, 0.02, False),
    "hdr": (0.20, 0.20, 0.00, 0.00, 0.04, 0.00, False),
    "vhs_tape": (-0.20, -0.10, 0.00, 0.05, 0.22, 0.70, False),
}
_WEIGHTS = np.array([1.0, 1.0, 1.2, 1.2, 4.0, 0.8])
NEUTRAL_IQR = 0.28        # OKLab L inter-quartile range of an ordinary, ungraded Rec.709 frame
NEUTRAL_CHROMA = 0.06     # its mean OKLab chroma


def _clip(v, lo=-1.0, hi=1.0) -> float:
    return float(min(hi, max(lo, v)))


def grain_estimate(img) -> float:
    """0..1: the high-pass noise on the flattest quarter of the frame (luma, 3x3 box residual)."""
    a = downscale(img, 512)
    y = a @ LUMA_709
    if min(y.shape) < 8:
        return 0.0
    pad = np.pad(y, 1, mode="edge")
    blur = sum(pad[i:i + y.shape[0], j:j + y.shape[1]] for i in range(3) for j in range(3)) / 9.0
    res = y - blur
    b = 8
    h, w = (y.shape[0] // b) * b, (y.shape[1] // b) * b
    blocks_y = blur[:h, :w].reshape(h // b, b, w // b, b)
    blocks_r = res[:h, :w].reshape(h // b, b, w // b, b)
    flat = blocks_y.std(axis=(1, 3))        # how much real detail each block has
    noise = blocks_r.std(axis=(1, 3))
    keep = flat <= np.quantile(flat, 0.25)
    sigma = float(np.median(noise[keep])) if keep.any() else 0.0
    return _clip((sigma - 0.003) / 0.03, 0.0, 1.0)


def vignette_estimate(img) -> float:
    a = downscale(img, 128) @ LUMA_709
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot((yy - h / 2) / (h / 2), (xx - w / 2) / (w / 2))
    centre, corner = a[r < 0.5].mean(), a[r > 1.1].mean() if (r > 1.1).any() else a.mean()
    return _clip((centre - corner) / max(centre, 1e-3) / 0.6, 0.0, 1.0)


def palette(img, k: int = 5) -> list:
    """k swatches (hex, darkest first): k-means in OKLab, centroids reported as their members' mean colour."""
    p = pixels(img, 4000)
    lab = srgb_to_oklab(p)
    order = np.argsort(lab[:, 0])
    cent = lab[order[np.linspace(0, len(p) - 1, k + 2).astype(int)[1:-1]]].copy()
    lab_w = lab * np.array([1.0, 2.0, 2.0])     # hue counts more than lightness for a palette
    for _ in range(15):
        d = ((lab_w[:, None, :] - (cent * np.array([1.0, 2.0, 2.0]))[None]) ** 2).sum(-1)
        lbl = d.argmin(1)
        for j in range(k):
            if (lbl == j).any():
                cent[j] = lab[lbl == j].mean(0)
    sw = []
    for j in np.argsort(cent[:, 0]):
        m = lbl == j
        if m.any():
            sw.append(to_hex(linear_to_srgb(srgb_to_linear(p[m]).mean(0))))
    return sw


def features(img, stats=None) -> dict:
    s = stats or frame_stats(img)
    bw = s["chroma_mean"] < 0.012
    return {
        "contrast": _clip((s["L_p75"] - s["L_p25"]) / NEUTRAL_IQR - 1.0),
        "saturation": -1.0 if bw else _clip(np.log2(max(s["chroma_mean"], 1e-4) / NEUTRAL_CHROMA)),
        "warmth_ev": 0.0 if bw else float(s["warmth_ev"]),
        "tint_ev": 0.0 if bw else float(s["tint_ev"]),
        "black": float(np.percentile(pixels(img) @ LUMA_709, 5)),   # display luma (Y') at the 5th percentile
        "grain": grain_estimate(img),
        "bw": bool(bw),
    }


def nearest_stocks(f: dict, n: int = 3) -> list:
    v = np.array([f["contrast"], f["saturation"], f["warmth_ev"], f["tint_ev"], f["black"], f["grain"]])
    out = []
    for sid, prof in STOCK_PROFILES.items():
        d = (v - np.array(prof[:6])) * _WEIGHTS
        dist = float(np.sqrt(np.sum(d * d))) + (3.0 if prof[6] != f["bw"] else 0.0)
        out.append({"id": sid, "distance": round(dist, 3)})
    return sorted(out, key=lambda x: x["distance"])[:n]


def neutralise(img) -> np.ndarray:
    """The reference with its grade taken out (see the module note). Same size, display-encoded."""
    a = downscale(img, 256)
    lin = srgb_to_linear(a)
    flat = lin.reshape(-1, 3)
    lab = srgb_to_oklab(a.reshape(-1, 3))
    L = lab[:, 0]
    lo, hi = np.percentile(L, [10, 90])
    m = (L >= lo) & (L <= hi)
    if m.sum() < 16:
        m = np.ones(len(L), bool)
    means = flat[m].mean(0) + 1e-6
    lin = lin * (means.mean() / means)                       # grey world on the neutrals
    disp = linear_to_srgb(lin)
    y = disp @ LUMA_709
    rank = np.argsort(np.argsort(y.ravel())).reshape(y.shape) / max(1, y.size - 1)
    y_n = 0.04 + 0.90 * rank                                  # an even spread of tone
    disp = np.clip(disp * (y_n / np.maximum(y, 1e-4))[..., None], 0, 1)
    ch = np.hypot(*srgb_to_oklab(disp.reshape(-1, 3))[:, 1:].T).mean()
    if ch > 1e-4:
        yy = (disp @ LUMA_709)[..., None]
        disp = np.clip(yy + (disp - yy) * min(3.0, NEUTRAL_CHROMA / ch), 0, 1)
    return disp


def tone_curve(src, ref, blend: float = 0.5) -> list:
    """17 knots (inputs 0, 1/16 .. 1): src luma quantiles -> ref luma quantiles, monotone, blended toward identity."""
    ys = np.sort(pixels(src) @ LUMA_709)
    yr = np.sort(pixels(ref) @ LUMA_709)
    knots = np.linspace(0, 1, 17)
    qs = np.searchsorted(ys, knots) / max(1, len(ys))          # where each input level sits in the source
    out = np.quantile(yr, np.clip(qs, 0, 1))
    curve = (1 - blend) * knots + blend * out
    curve[0] = (1 - blend) * 0 + blend * yr[int(0.005 * len(yr))]
    curve[-1] = (1 - blend) * 1 + blend * yr[int(0.995 * (len(yr) - 1))]
    return normalize_curve([round(float(x), 6) for x in np.maximum.accumulate(curve)])


def steal_look(img, stock_labels: dict | None = None) -> dict:
    """Everything the Look tab applies from one reference frame."""
    stats = frame_stats(img)
    f = features(img, stats)
    near = nearest_stocks(f)
    neutral = neutralise(img)
    fit = fit_cdl(neutral, downscale(img, 256))
    curve = tone_curve(apply_cdl(neutral, fit["cdl"]), downscale(img, 256))
    sw = [] if f["bw"] else palette(img)
    stock = near[0]["id"]
    labels = stock_labels or {}
    grade = {"contrast": round(f["contrast"], 2), "saturation": round(f["saturation"], 2),
             "warmth": round(_clip(f["warmth_ev"] / 0.8), 2), "grain": round(f["grain"], 2), "halation": 0.0,
             "vignette": round(vignette_estimate(img), 2)}
    name = f"Stolen: {labels.get(stock, stock)}"
    patch = {"film_stock": stock, "grade": grade,
             "colour": {"cdl": fit["cdl"], "curve": curve, "stock": stock, "source": "steal"}}
    if sw:
        patch["palette"] = {"preset": "custom", "name": name, "swatches": sw}
    notes = []
    if f["bw"]:
        notes.append("black-and-white reference: palette dropped, nearest B&W stock picked")
    return {"look_patch": patch, "stock": {"id": stock, "label": labels.get(stock, stock), "distance": near[0]["distance"]},
            "alternatives": [{**x, "label": labels.get(x["id"], x["id"])} for x in near[1:]],
            "features": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in f.items()},
            "cdl": fit["cdl"], "curve": curve, "palette": sw, "stats": stats, "notes": notes}
