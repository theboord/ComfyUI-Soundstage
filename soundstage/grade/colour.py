"""Colour maths for the grade pipeline: sRGB / Rec.709 transfer, OKLab (the perceptual space every match and
continuity check is judged in) and the per-frame statistics a grade is matched on.

Pure numpy, CPU only. Images are float arrays [H, W, 3] in 0..1, display-encoded (sRGB / Rec.709 with the sRGB
curve, what every Soundstage render and every web image is). Nothing here needs ComfyUI.

Stops: `exposure_ev` is log2 of the frame's mean linear luminance over 18 % grey; `warmth_ev` is log2(R / B) and
`tint_ev` is log2(G / sqrt(R * B)), both of the mean *linear* light of the frame's mid-tones (the 10th to 90th
percentile of lightness: not the clipped sky, not the crushed doorway). A grey-world measure: a shot full of red
brick reads warmer than one of blue sky with the same light, so compare shots of one scene, as the Coach does. A difference of 0.4 in
`warmth_ev` between two shots is what the Coach calls "0.4 stops warmer".
"""
from __future__ import annotations

import numpy as np

LUMA_709 = np.array([0.2126, 0.7152, 0.0722])

# Linear sRGB (Rec.709 primaries, D65) -> LMS -> OKLab (Björn Ottosson, 2020; public-domain matrices).
_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]])


def srgb_to_linear(v):
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def linear_to_oklab(rgb):
    lms = np.cbrt(np.asarray(rgb, dtype=np.float64) @ _M1.T)
    return lms @ _M2.T


def srgb_to_oklab(rgb):
    return linear_to_oklab(srgb_to_linear(rgb))


def as_float_rgb(img) -> np.ndarray:
    """uint8 / uint16 / float, [H,W], [H,W,3] or [H,W,4] -> float64 [H,W,3] in 0..1."""
    a = np.asarray(img)
    if a.dtype == np.uint8:
        a = a.astype(np.float64) / 255.0
    elif a.dtype == np.uint16:
        a = a.astype(np.float64) / 65535.0
    else:
        a = a.astype(np.float64)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    if a.ndim != 3 or a.shape[2] < 3:
        raise ValueError(f"expected an RGB image, got shape {a.shape}")
    return np.clip(a[..., :3], 0.0, 1.0)


def downscale(img, long_side: int = 256) -> np.ndarray:
    """Box-filter downscale so the long side is at most `long_side` (integer factor; enough for statistics)."""
    a = as_float_rgb(img)
    f = int(np.ceil(max(a.shape[:2]) / float(long_side)))
    if f <= 1:
        return a
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    return a[:h, :w].reshape(h // f, f, w // f, f, 3).mean(axis=(1, 3))


def pixels(img, n: int = 6000) -> np.ndarray:
    """A deterministic, evenly spaced sample of up to `n` pixels as [N, 3] (statistics and fits run on this)."""
    p = downscale(img).reshape(-1, 3)
    if len(p) <= n:
        return p
    return p[np.linspace(0, len(p) - 1, n).astype(int)]


def _neutral_mask(lab, L):
    """The mid-tones a cast is read from: L inside the 10..90th percentile (no clipped highlights, no crushed
    blacks). Chosen by lightness only, so a cast (which barely moves lightness) reads off the same pixels in both
    shots; picking the 'least colourful' pixels instead would pick different pixels once the cast is on."""
    lo, hi = np.percentile(L, [10, 90])
    m = (L >= lo) & (L <= hi)
    return m if m.sum() >= 16 else np.ones(len(L), bool)


def frame_stats(img) -> dict:
    """The numbers a grade is matched on and continuity is judged by (all plain floats, JSON-ready)."""
    p = pixels(img)
    lin = srgb_to_linear(p)
    lab = linear_to_oklab(lin)
    L = lab[:, 0]
    c = np.hypot(lab[:, 1], lab[:, 2])
    y = lin @ LUMA_709
    m = _neutral_mask(lab, L)
    r, g, b = (max(float(lin[m, k].mean()), 1e-5) for k in range(3))
    q = np.percentile(L, [5, 25, 50, 75, 95])
    return {
        "L_mean": float(L.mean()), "L_std": float(L.std()),
        "L_p05": float(q[0]), "L_p25": float(q[1]), "L_p50": float(q[2]), "L_p75": float(q[3]), "L_p95": float(q[4]),
        "a_mean": float(lab[:, 1].mean()), "b_mean": float(lab[:, 2].mean()),
        "chroma_mean": float(c.mean()),
        "exposure_ev": float(np.log2(max(float(y.mean()), 1e-5) / 0.18)),
        "warmth_ev": float(np.log2(r / b)),
        "tint_ev": float(np.log2(g / np.sqrt(r * b))),
    }


def stats_delta_e(a: dict, b: dict) -> float:
    """OKLab distance of two frames' mean colour, x100 (about 1 = just noticeable, as for CIEDE2000)."""
    return float(100 * np.sqrt((a["L_mean"] - b["L_mean"]) ** 2 + (a["a_mean"] - b["a_mean"]) ** 2
                               + (a["b_mean"] - b["b_mean"]) ** 2))


def to_hex(rgb) -> str:
    r, g, b = (int(round(float(np.clip(v, 0, 1)) * 255)) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"
