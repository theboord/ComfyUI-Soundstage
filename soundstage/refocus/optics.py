"""Refocus optics: a thin-lens circle of confusion and depth-layered disc bokeh in linear light (docs/refocus.md).

Adapted from Hero Frame Rig's optical renderer: ComfyUI-HeroFrameRig/hfr_core/optical.py (and the helper _fft_size from
hfr_core/__init__.py) at https://github.com/metababe-eth/hero-frame-rig commit 946d80a, MIT License,
Copyright (c) 2026 Maxwell / Hero Frame Rig contributors. The licence text is in soundstage/refocus/LICENSE.HeroFrameRig.
Only that MIT node-pack folder was used; nothing from the Apache-2.0 app code at the repo root and nothing from its
Legacy (Radiance-matched) renderer.

What we changed from the original:
  - numpy + scipy.fft instead of torch (ComfyUI's torch is not needed, and the tests run without it).
  - Depth is real inverse distance in diopters (1/m), not 0-1 over a guessed 0.5-10 m range, so the T-stop, the focal
    length and the focus distance are the real ones (as real as the depth is: see docs/refocus.md).
  - Layers are binned by circle of confusion, in steps of at most 1 px (10% above 10 px), instead of 24 fixed depth
    bins: a receding floor gets no visible blur steps. Each layer is still blurred at its own mean radius (HFR's way),
    to 1/16 px, so a plane that drifts out of focus during a pull softens a little every frame instead of holding and
    then jumping a whole bin (tests/test_refocus.py checks the frame-to-frame change during a pull).
  - Optional highlight energy (OURS, not Hero Frame Rig's, whose renderer invents no radiance; off by default): small
    clipped sources (sRGB 250-254 and up, a small share of the area around them) are lifted before the blur so an
    out-of-focus practical blooms into a bright disc, not a grey one. A white wall, white text or a bright window is not
    a small source and keeps its exposure. It is light the camera never recorded and is labelled so in the App.
  - Big blurs run at half or quarter size (the disc is still a disc, scaled), which keeps a 1080p frame to seconds on
    a CPU.
  - No spotlight, breathing or grain: the picture outside the blur is left exactly as it was.
"""
from __future__ import annotations

import math
import os
from functools import lru_cache

import numpy as np



def _threads() -> int:
    """CPU threads for the FFTs: half the machine (the pod is shared with ComfyUI and other people's jobs), or the
    SOUNDSTAGE_REFOCUS_THREADS environment variable."""
    try:
        v = int(os.environ.get("SOUNDSTAGE_REFOCUS_THREADS") or 0)
    except ValueError:
        v = 0
    return max(1, v or (os.cpu_count() or 2) // 2)


THREADS = _threads()
try:   # scipy.fft is multi-threaded; numpy.fft is the fallback
    from scipy import fft as _fft
    _KW = {"workers": THREADS}
except Exception:  # noqa: BLE001
    _fft = np.fft
    _KW = {}

IN_FOCUS_PX = 0.5          # a radius under this is sharp at the delivery size (it is pasted back untouched)
TOLERANCE_PX = 0.5         # subtracted from every radius: sub-pixel defocus reads as sharp, the step stays continuous
MAX_RADIUS = 0.05          # the largest blur radius, as a share of the long edge (cost and sanity cap)
CLIP_KNEE = (0.955, 0.991)      # linear max channel where a source counts as clipped: sRGB 250 -> 254
SMALL_SOURCE = (0.03, 0.1)      # clipped share of the area around it: under the first a source is small (a practical,
                                # lifted in full), over the second it is a surface (a wall, text, a window: not lifted)
LINE_ANISO = (2.0, 4.0)         # clipped share down vs across through it: over this it is a line, a stroke or an edge
STEPS = 16                      # blur radii are kept to 1/16 px (the cached disc spectra)


# ------------------------------------------------------------------------------------------------ colour

def to_linear(srgb: np.ndarray) -> np.ndarray:
    """sRGB 0-1 -> linear light (the exact piecewise curve)."""
    x = np.asarray(srgb, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def to_srgb(lin: np.ndarray) -> np.ndarray:
    """Linear light -> sRGB 0-1, clipped (8-bit delivery cannot hold more than white)."""
    x = np.clip(np.asarray(lin, np.float32), 0, None)
    return np.clip(np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055), 0, 1).astype(np.float32)


# ------------------------------------------------------------------------------------------------ the lens

def coc_px(diopters, focus_d: float, *, focal_mm: float, t_stop: float, width_px: int, sensor_mm: float = 36.0):
    """Signed thin-lens blur RADIUS in pixels (+ nearer than focus, - farther).

    c/2 = f^2 * (1/z - 1/z_f) / (2 N (1 - f/z_f)), times width_px / sensor width. Depth and focus are inverse distance
    (diopters = 1/m), where blur is linear. N is the T-stop used as the f-number (a cine lens's T-stop is its f-number
    plus its transmission loss, under 1/3 stop: depth of field follows the f-number, so it reads a touch deep).
    """
    f = float(focal_mm) / 1000.0
    n = max(0.5, float(t_stop))
    fd = min(float(focus_d), 0.9 / f)             # focus is always beyond the focal length
    k = f * f / (2.0 * n * (1.0 - f * fd)) * (float(width_px) / (float(sensor_mm) / 1000.0))
    return (np.asarray(diopters, np.float32) - np.float32(fd)) * np.float32(k)


def effective_radius(signed: np.ndarray, long_edge: int) -> np.ndarray:
    """|radius| less the sharpness tolerance, capped (the tolerance keeps the in/out-of-focus step continuous)."""
    return np.clip(np.abs(signed) - TOLERANCE_PX, 0, MAX_RADIUS * long_edge).astype(np.float32)


def bin_edges(r_max: float) -> list[float]:
    """Layer boundaries in blur radius: 1 px apart up to 10 px, then 10% apart (no visible steps on a receding floor)."""
    e, out = IN_FOCUS_PX, [IN_FOCUS_PX]
    while e < r_max:
        e += max(1.0, 0.1 * e)
        out.append(e)
    return out


# ------------------------------------------------------------------------------------------------ the disc

def _fft_size(value: int) -> int:
    """Next size whose only prime factors are 2, 3, 5 (fast FFT). From hfr_core/__init__.py (MIT)."""
    while True:
        test = value
        for prime in (2, 3, 5):
            while test % prime == 0:
                test //= prime
        if test == 1:
            return value
        value += 1


@lru_cache(maxsize=96)
def _disc_spectrum(h: int, w: int, radius_steps: int):
    """The FFT of a unit-energy disc with an antialiased rim (coverage clamp(r + 0.5 - d, 0, 1)), for an h x w image.
    radius_steps is the radius in 1/STEPS px (the rim's coverage is continuous in r: 0.5 px is a single pixel)."""
    radius = radius_steps / float(STEPS)
    pad = math.ceil(radius + 1)
    shape = (_fft_size(h + 2 * pad), _fft_size(w + 2 * pad))
    v = np.arange(-pad, pad + 1, dtype=np.float32)
    yy, xx = np.meshgrid(v, v, indexing="ij")
    disc = np.clip(radius + 0.5 - np.sqrt(xx * xx + yy * yy), 0, 1).astype(np.float32)
    disc /= disc.sum()
    kernel = np.zeros(shape, np.float32)
    kernel[: len(v), : len(v)] = disc
    kernel = np.roll(kernel, (-pad, -pad), (0, 1))
    return _fft.rfft2(kernel, **_KW).astype(np.complex64), shape, pad


def _down(img: np.ndarray, k: int) -> np.ndarray:
    """Box-average by k (edges padded by repeat)."""
    h, w = img.shape[:2]
    h2, w2 = -(-h // k) * k, -(-w // k) * k
    if (h2, w2) != (h, w):
        img = np.pad(img, ((0, h2 - h), (0, w2 - w), (0, 0)), mode="edge")
    return img.reshape(h2 // k, k, w2 // k, k, -1).mean((1, 3), dtype=np.float32)


def resize_bilinear(img: np.ndarray, h: int, w: int) -> np.ndarray:
    """Bilinear resize (pixel centres, like align_corners=False) of [H,W] or [H,W,C] float."""
    a = np.asarray(img, np.float32)
    h0, w0 = a.shape[:2]
    if (h0, w0) == (h, w):
        return a
    ys = np.clip((np.arange(h, dtype=np.float32) + 0.5) * h0 / h - 0.5, 0, h0 - 1)
    xs = np.clip((np.arange(w, dtype=np.float32) + 0.5) * w0 / w - 0.5, 0, w0 - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, h0 - 1), np.minimum(x0 + 1, w0 - 1)
    fy, fx = (ys - y0), (xs - x0)
    if a.ndim == 3:
        fy, fx = fy[:, None, None], fx[None, :, None]
    else:
        fy, fx = fy[:, None], fx[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def scale_for(radius: float) -> int:
    """Big blurs are computed smaller (the disc keeps at least ~8 px of radius there)."""
    return 4 if radius >= 40 else 2 if radius >= 16 else 1


def disc_blur(img: np.ndarray, radius: float) -> np.ndarray:
    """[H,W,C] float32 through a circular, unit-energy lens PSF with an antialiased rim (reflect-padded edges)."""
    if radius < IN_FOCUS_PX:
        return img
    h, w = img.shape[:2]
    k = scale_for(radius)
    src = _down(img, k) if k > 1 else img
    hs, ws = src.shape[:2]
    r = min(float(radius) / k, min(hs, ws) / 3)
    spec, shape, pad = _disc_spectrum(hs, ws, max(STEPS // 2, round(r * STEPS)))
    padded = np.pad(src, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    f = _fft.rfft2(padded, s=shape, axes=(0, 1), **_KW)
    out = _fft.irfft2(f * spec[:, :, None], s=shape, axes=(0, 1), **_KW)[pad:pad + hs, pad:pad + ws]
    out = np.clip(out, 0, None).astype(np.float32)
    return resize_bilinear(out, hs * k, ws * k)[:h, :w] if k > 1 else out   # exact k: no shrink, energy kept


def blur_layer(rgb: np.ndarray, mask: np.ndarray, radius: float):
    """A premultiplied layer (colour x mask, mask) blurred, computed only over the mask's bounding box plus the blur's
    reach. Returns (slice, [h,w,4] blurred layer) or None for an empty mask. Outside the box the layer is zero, so
    reflect padding at an inner box edge mirrors zeros, and at the frame edge it mirrors the picture, as before."""
    rows, cols = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
    if not len(rows):
        return None
    h, w = mask.shape
    m = int(math.ceil(radius)) + 2 * scale_for(radius) + 3
    y0, y1 = max(0, rows[0] - m), min(h, rows[-1] + 1 + m)
    x0, x1 = max(0, cols[0] - m), min(w, cols[-1] + 1 + m)
    sl = (slice(y0, y1), slice(x0, x1))
    mf = mask[sl].astype(np.float32)[..., None]
    return sl, disc_blur(np.concatenate((rgb[sl] * mf, mf), -1), radius)


# ------------------------------------------------------------------------------------------------ a frame

def box_mean(a: np.ndarray, r: int, rx: int | None = None) -> np.ndarray:
    """Mean of [H,W] over a (2r+1) x (2rx+1) window (rx defaults to r; at the edges the window shrinks), via summed
    areas."""
    h, w = a.shape
    rx = r if rx is None else rx
    c = np.zeros((h + 1, w + 1), np.float64)
    c[1:, 1:] = np.cumsum(np.cumsum(a, 0), 1)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - rx, 0, w)
    x1 = np.clip(np.arange(w) + rx + 1, 0, w)
    s = c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]
    return (s / ((y1 - y0)[:, None] * (x1 - x0)[None, :])).astype(np.float32)


def _smooth01(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def highlight_lift(lin: np.ndarray, amount: float, reach: int = 8) -> np.ndarray:
    """Lift SMALL CLIPPED sources (x(1 + amount)) so a defocused practical blooms bright. Invented energy: 8-bit SDR
    stopped recording at white, so a practical blurred as it is blooms into a grey disc. Only pixels at the clip
    (CLIP_KNEE, on the brightest channel, so a coloured bulb counts) that are a small share of the (2*reach+1)^2 area
    around them (SMALL_SOURCE) and about as tall as wide (not a line or a stroke: LINE_ANISO, from the clipped share of
    a strip down and a strip across) are lifted. A white wall, a bright window, white text, a thin white line or an
    sRGB 240 surface keep their exposure. Not from Hero Frame Rig (its renderer invents no radiance)."""
    if amount <= 0:
        return lin
    lo, hi = CLIP_KNEE
    clip = _smooth01((lin.max(-1) - lo) / (hi - lo)).astype(np.float32)
    if not clip.any():
        return lin
    a, b = SMALL_SOURCE
    r = int(max(1, reach))
    small = 1.0 - _smooth01((box_mean(clip, r) - a) / (b - a))
    a, b = LINE_ANISO
    down, across = box_mean(clip, r, 0), box_mean(clip, 0, r)          # a line (or its end) fills one far more
    aniso = np.maximum(down, across) / (np.minimum(down, across) + 1.0 / (2 * r + 1))
    small *= 1.0 - _smooth01((aniso - a) / (b - a))
    return (lin * (1 + float(amount) * clip * small)[..., None]).astype(np.float32)


def render_frame(rgb: np.ndarray, diopters: np.ndarray, focus_d: float, *, focal_mm: float, t_stop: float,
                 sensor_mm: float = 36.0, highlights: float = 0.0, stats: dict | None = None) -> np.ndarray:
    """One frame refocused. rgb: [H,W,3] uint8 or float 0-1 (sRGB); diopters: [H,W] inverse distance (0 = infinity).
    Returns the same type as rgb. Pixels whose blur is under half a pixel come back exactly as they were.

    Layers composite far to near (HFR's scheme): a 'behind' plate gathers only pixels farther than focus (so a sharp
    subject never smears into the background blur), every out-of-focus layer is blurred with its own colour and
    coverage, in-focus pixels are pasted back hard, and a blurred foreground spreads over what is behind it.
    """
    u8 = rgb.dtype == np.uint8
    src = rgb.astype(np.float32) / 255.0 if u8 else np.asarray(rgb, np.float32)
    h, w = src.shape[:2]
    if diopters.shape != (h, w):
        raise ValueError(f"depth is {diopters.shape}, picture is {(h, w)}")
    long_edge = max(h, w)
    # the sensor's width is across the frame's WIDTH (the stage's convention, web/stage/stage.mjs SENSOR_W_MM: a 9:16
    # take is a 36 mm wide sensor across its short side); only the cost cap is on the long edge
    signed = coc_px(diopters, focus_d, focal_mm=focal_mm, t_stop=t_stop, width_px=w, sensor_mm=sensor_mm)
    r = effective_radius(signed, long_edge)
    r_max = float(r.max()) if r.size else 0.0
    if stats is not None:
        stats.update(r_max=round(r_max, 2), layers=0)
    if r_max < IN_FOCUS_PX:
        return rgb.copy()
    lin = to_linear(src)
    lit = highlight_lift(lin, highlights, reach=int(min(64, max(8, 2 * r_max))))   # the disc's diameter
    near = signed > 0
    # the plate under everything: a gather of only what is behind the focus plane, normalised by its coverage
    far = np.clip((-signed - TOLERANCE_PX - IN_FOCUS_PX) / 1.5, 0, 1).astype(np.float32)
    packed = disc_blur(np.concatenate((lit * far[..., None], far[..., None]), -1), r_max + 2)
    behind = packed[..., :3] / np.maximum(packed[..., 3:4], 1e-6)
    fallback = disc_blur(lit, r_max)
    support = np.clip(packed[..., 3:4] / 0.15, 0, 1)        # a tiny far highlight is not a whole hidden wall
    support = support * support * (3 - 2 * support)
    base = fallback + (behind - fallback) * support
    # layers by blur radius: far side from the farthest in, then in focus, then near side. Each layer is blurred at the
    # mean radius of its own pixels (to 1/16 px), not at its bin's centre: as focus moves, a plane's blur follows it
    # smoothly instead of holding and jumping a whole bin, and a plane just leaving focus starts at ~0.5 px (a single
    # pixel), not at the first bin's 1 px
    edges = np.asarray(bin_edges(r_max), np.float32)
    idx = np.searchsorted(edges, r, side="right") - 1     # -1 = in focus
    order = [("far", i) for i in range(len(edges) - 1, -1, -1)] + [("focus", -1)] + [("near", i) for i in range(len(edges))]
    layers = 0
    for side, i in order:
        if side == "focus":
            m = idx < 0
            if m.any():
                base[m] = lin[m]
            continue
        m = (idx == i) & (near if side == "near" else ~near)
        if not m.any():
            continue
        radius = max(IN_FOCUS_PX, float(r[m].mean(dtype=np.float64)))
        sl, layer = blur_layer(lit, m, radius)
        a = np.clip(layer[..., 3:4], 0, 1)
        base[sl] = base[sl] * (1 - a) + layer[..., :3]
        layers += 1
    if stats is not None:
        stats["layers"] = layers
    out = to_srgb(base)
    # exactness where nothing blurred over the sharp picture (float round trip would move a few values by 1/255)
    keep = (idx < 0) & (base == lin).all(-1)
    if u8:
        res = np.round(out * 255).astype(np.uint8)
        res[keep] = rgb[keep]
        return res
    out[keep] = src[keep]
    return out
