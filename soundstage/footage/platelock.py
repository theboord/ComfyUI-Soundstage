"""Plate lock: put a generated result back onto the source plate so every pixel outside the edit stays the plate's.

A one-click edit (relight, weather, empty the scene, cutout) or a Recast re-renders the whole frame, and the model
drifts the colour, smears the grain and re-invents texture everywhere, even where nothing was meant to change. Plate
lock finds what the model really changed and takes only that:

  1. robust tone fit      per-frame, per-channel affine gen ~= gain * plate + bias, fitted (iteratively reweighted)
                          on the pixels that agree, so the model's global colour drift is not read as an edit;
  2. difference matte     opponent-space distance against a robust per-frame noise floor, smoothstep thresholds;
  3. hysteresis           3D (x, y, t) geodesic reconstruction: a weak change is kept only if it connects, in space or
                          in time, to a strong one, so isolated VAE shimmer dies;
  4. temporal stabilise   temporal median + zero-phase EMA, so the matte never flickers;
  5. composite + re-grain at the plate's own resolution; where the matte is 0 the plate is copied bit-for-bit, and the
                          (soft, upscaled) generated pixels get the grain the plate has and they lack;
  6. fidelity report      % of pixels bit-identical to the plate, PSNR outside the edit (locked and raw model).

Three modes:
  local  the edit is a thing in the picture (empty the scene, a recast person, flood water): tone-matched generated
         pixels inside the matte, the plate bit-for-bit outside it.
  look   the edit is the light (relight, nightfall, golden hour, rain, fog, snow): the change of light is carried onto
         the plate's own pixels as a smooth per-pixel gain (a light map), and generated pixels are taken only where
         the model changed structure beyond the light (snow on a ledge, a lit window, a puddle). Nothing is
         bit-identical in this mode by design; every pixel outside the matte is the plate's own detail, re-lit.
  alpha  the edit is a matte (cutout): RGB is the plate bit-for-bit, alpha is the model's matte, steadied in time.

Pure torch, no ComfyUI imports: CPU-testable. IMAGE = [T, H, W, C] float 0..1, MASK = [T, H, W] float 0..1.

Adapted from PlateLock (https://github.com/TusharTechs/platelock, comfyui-platelock/platelock/core.py),
MIT License, Copyright (c) 2026 PlateLock contributors (see THIRD_PARTY_NOTICES.md). Soundstage changes: the look
and alpha modes and the light map; re-grain adds only the grain the generated pixels lack (sqrt(plate^2 - gen^2));
the report also counts the edit area and reports per mode; mattes can be limited to a reach around a subject (Recast);
chunked so a full-resolution clip never needs a full-resolution float copy of the generated frames.
"""
from __future__ import annotations

import math

import torch
import torch.nn.functional as F

# Mattes below this are snapped to exactly zero, so untouched pixels stay bit-identical to the plate.
ZERO_SNAP = 1.0 / 512.0
MODES = ("local", "look", "alpha")
CHUNK = 8


# ------------------------------------------------------------------ small tensor helpers

def _nchw(img):
    return img.permute(0, 3, 1, 2)


def _nhwc(img):
    return img.permute(0, 2, 3, 1)


def _gauss_kernel(sigma, device, dtype):
    r = max(1, int(math.ceil(sigma * 3)))
    x = torch.arange(-r, r + 1, device=device, dtype=dtype)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum()


def gaussian_blur(x, sigma):
    """Separable gaussian on NCHW (reflect padded; replicate when the picture is smaller than the kernel)."""
    if sigma <= 0:
        return x
    k = _gauss_kernel(sigma, x.device, x.dtype)
    r = (k.numel() - 1) // 2
    c = x.shape[1]
    mode = "reflect" if min(x.shape[-2:]) > r else "replicate"
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode=mode), k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    return F.conv2d(F.pad(x, (0, 0, r, r), mode=mode), k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)


def blur_mask(m, sigma):
    return m if sigma <= 0 else gaussian_blur(m.unsqueeze(1), sigma).squeeze(1)


def dilate(m, px):
    px = int(px)
    if px <= 0:
        return m
    return F.max_pool2d(m.unsqueeze(1), 2 * px + 1, stride=1, padding=px).squeeze(1)


def erode(m, px):
    return m if int(px) <= 0 else -dilate(-m, px)


def smoothstep(lo, hi, x):
    t = ((x - lo) / max(hi - lo, 1e-6)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def resize_frames(img, h, w, mode="bicubic"):
    """[T,H,W,C] -> [T,h,w,C], chunked. 'area' to shrink, bicubic (antialiased) otherwise."""
    if img.shape[1] == h and img.shape[2] == w:
        return img
    out = []
    for chunk in img.split(16):
        x = _nchw(chunk.float())
        if mode == "area":
            x = F.interpolate(x, size=(h, w), mode="area")
        elif mode == "bilinear":
            x = F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False)
        else:
            x = F.interpolate(x, size=(h, w), mode="bicubic", align_corners=False,
                              antialias=(h < x.shape[2] or w < x.shape[3]))
        out.append(_nhwc(x).clamp(0, 1))
    return torch.cat(out)


def resize_mask(m, h, w):
    if m.shape[1] == h and m.shape[2] == w:
        return m.float()
    out = [F.interpolate(c.float().unsqueeze(1), size=(h, w), mode="bilinear", align_corners=False).squeeze(1)
           for c in m.split(16)]
    return torch.cat(out).clamp(0, 1)


def match_length(frames, n):
    """Nearest-neighbour temporal resample of [T,...] to n frames."""
    t = frames.shape[0]
    if t == n:
        return frames
    idx = torch.linspace(0, t - 1, n, device=frames.device).round().long()
    return frames[idx]


def broadcast_mask(m, t, h, w):
    """A single-frame or per-frame mask of any size -> [t,h,w] (None passes through)."""
    if m is None:
        return None
    if m.dim() == 2:
        m = m.unsqueeze(0)
    m = resize_mask(m.float(), h, w)
    if m.shape[0] == 1:
        m = m.expand(t, h, w)
    return match_length(m, t)


def opponent(x):
    """RGB (NCHW) -> luma + two chroma differences: a cheap perceptual space."""
    r, g, b = x[:, 0:1], x[:, 1:2], x[:, 2:3]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    return torch.cat([y, b - y, r - y], dim=1)


def rgb(img):
    return img[..., :3]


# ------------------------------------------------------------------ 1. tone fit

def fit_tone(plate_small, gen, iters=4, temporal=5, weight=None):
    """Robust per-frame, per-channel affine gen ~= gain * plate + bias. Returns (gain [T,3], bias [T,3]).

    Fitted on a heavily blurred 1/8 copy (VAE detail loss and sensor noise don't read as contrast), iteratively
    reweighted so pixels the edit changed don't bias it, reduced-major-axis (noise doesn't pull the gain to 0),
    smoothed over time (no flicker). weight [T,h,w] (optional) limits the fit to where the plate should show
    (Recast: everything but the subject).
    """
    p = gaussian_blur(_nchw(plate_small), 3.0)
    g = gaussian_blur(_nchw(gen), 3.0)
    hs, ws = max(8, p.shape[2] // 8), max(8, p.shape[3] // 8)
    p = F.interpolate(p, size=(hs, ws), mode="area").flatten(2)  # [T,3,N]
    g = F.interpolate(g, size=(hs, ws), mode="area").flatten(2)
    w0 = torch.ones_like(p[:, :1])
    if weight is not None:
        w0 = F.interpolate(weight.float().unsqueeze(1), size=(hs, ws), mode="area").flatten(2).clamp(0, 1) + 1e-4
    gain = torch.ones(p.shape[0], 3, 1, device=p.device, dtype=p.dtype)
    bias = torch.zeros_like(gain)
    for _ in range(iters):
        resid = (g - (gain * p + bias)).abs().mean(dim=1, keepdim=True)
        scale = resid.median(dim=2, keepdim=True).values * 2.5 + 1e-3
        wgt = torch.exp(-((resid / scale) ** 2)) * w0
        sw = wgt.sum(2, keepdim=True) + 1e-6
        mp = (wgt * p).sum(2, keepdim=True) / sw
        mg = (wgt * g).sum(2, keepdim=True) / sw
        cov = (wgt * (p - mp) * (g - mg)).sum(2, keepdim=True)
        var_p = (wgt * (p - mp) ** 2).sum(2, keepdim=True) + 1e-6
        var_g = (wgt * (g - mg) ** 2).sum(2, keepdim=True) + 1e-6
        gain = (torch.where(cov < 0, -1.0, 1.0) * torch.sqrt(var_g / var_p)).clamp(0.6, 1.6)
        bias = mg - gain * mp
    gain, bias = gain.squeeze(-1), bias.squeeze(-1)
    if temporal > 1 and gain.shape[0] > 2:
        k = min(temporal, gain.shape[0]) | 1
        pad = k // 2

        def sm(x):
            x = F.pad(x.t().unsqueeze(0), (pad, pad), mode="replicate")
            return F.avg_pool1d(x, k, stride=1).squeeze(0).t()

        gain, bias = sm(gain), sm(bias)
    return gain, bias


def apply_inverse_tone(gen, gain, bias):
    """Generated frames back into the plate's colour."""
    return ((gen - bias.view(-1, 1, 1, 3)) / gain.view(-1, 1, 1, 3)).clamp(0, 1)


# ------------------------------------------------------------------ 1b. light map (look mode)

def light_map(plate_small, gen, sigma_frac=1 / 24, lo=0.02, hi=6.0):
    """Smooth per-pixel, per-channel gain gen/plate [T,h,w,3]: the change of light, without the detail.

    Both are blurred to about 1/24 of the frame height first, so the map carries where the light falls and its
    colour, never texture or edges. Dividing by a near-black plate is clamped (lo..hi): a light that switches on
    in a black area can't be carried by a gain, and the difference matte takes the model's pixels there instead.
    """
    sigma = max(1.0, plate_small.shape[1] * sigma_frac)
    eps = 0.02
    p = gaussian_blur(_nchw(plate_small), sigma) + eps
    g = gaussian_blur(_nchw(gen), sigma) + eps
    return _nhwc((g / p).clamp(lo, hi))


# ------------------------------------------------------------------ 2+3. difference matte with 3D hysteresis

def _hysteresis(z, lo, hi, iters=24):
    """Keep weak responses (z > lo) only where they connect in x, y or t to a strong one (z > hi)."""
    strong = (z > hi).float()[None, None]
    weak = (z > lo).float()[None, None]
    r = strong
    for _ in range(iters):
        nr = F.max_pool3d(r, 3, stride=1, padding=1) * weak
        if torch.equal(nr, r):
            break
        r = nr
    return r[0, 0]


def difference_matte(plate, gen, mode="local", sensitivity=0.5, chroma_weight=2.0, detail_sigma=1.5,
                     hysteresis=True, region_hint=None, protect=None, tone_weight=None):
    """What did the model really change? Works at the generated frames' size.

    Returns dict: matte [T,h,w], gen_matched [T,h,w,3] (generated, back in the plate's colour: tone fit in local
    mode, unchanged in look mode), light [T,h,w,3] or None (look mode), z [T,h,w] (change score).
    """
    gen = rgb(gen).float()
    t, h, w, _ = gen.shape
    plate = match_length(rgb(plate).float(), t)
    plate_small = resize_frames(plate, h, w, mode="area")

    light = None
    if mode == "look":
        light = light_map(plate_small, gen)
        ref = (plate_small * light).clamp(0, 1)    # the plate, re-lit: what the model "should" show with no new things
        gen_m = gen
    else:
        gain, bias = fit_tone(plate_small, gen, weight=tone_weight)
        gen_m = apply_inverse_tone(gen, gain, bias)
        ref = plate_small

    dists = []
    for ps, gs in zip(ref.split(16), gen_m.split(16)):
        a = opponent(gaussian_blur(_nchw(ps), detail_sigma))
        b = opponent(gaussian_blur(_nchw(gs), detail_sigma))
        d = (a - b) ** 2
        dists.append(torch.sqrt(d[:, 0] + chroma_weight * (d[:, 1] + d[:, 2]) + 1e-8))
    d = torch.cat(dists)

    # robust per-frame noise floor from the quietest half of the frame: valid even when the edit is big
    flat = d.flatten(1)
    flat = flat[:, :: max(1, flat.shape[1] // 65536)].float()
    q = torch.quantile(flat, torch.tensor([0.25, 0.5], device=d.device), dim=1)
    floor = q[1].view(-1, 1, 1)
    spread = ((q[1] - q[0]).view(-1, 1, 1) * 2.0).clamp_min(4e-3)
    z = (d - floor) / spread

    s = float(min(max(sensitivity, 0.0), 1.0))
    lo = 9.0 - 6.5 * s     # weak threshold: 9 (strict) .. 2.5 (loose)
    hi = lo * 2.0
    matte = smoothstep(lo, hi, z)
    if hysteresis:
        matte = matte * dilate(_hysteresis(z, lo, hi), 2)
    if region_hint is not None:
        hint = broadcast_mask(region_hint, t, h, w)
        matte = matte * blur_mask(dilate(hint, max(2, h // 40)), max(1.0, h / 100))
    if protect is not None:
        matte = matte * (1 - broadcast_mask(protect, t, h, w))
    return {"matte": matte.clamp(0, 1), "gen_matched": gen_m, "light": light, "z": z.clamp_min(0)}


# ------------------------------------------------------------------ 4. temporal stabilise + refine

def temporal_stabilize(m, window=5, ema=0.6):
    """Temporal median, then a zero-phase EMA: max(raw, min(forward, backward)).

    min(fwd, bwd) keeps only what both directions agree on, so a fast element leaves no trail; max with the raw
    matte means nothing real is lost, while one-frame dropouts are filled.
    """
    t = m.shape[0]
    if t < 3:
        return m
    k = max(1, min(window, t) | 1)
    if k > 1:
        pad = k // 2
        x = torch.cat([m[:1].expand(pad, -1, -1), m, m[-1:].expand(pad, -1, -1)])
        m = x.unfold(0, k, 1).median(dim=-1).values
    if 0 < ema < 1:
        fwd = m.clone()
        for i in range(1, t):
            fwd[i] = ema * fwd[i - 1] + (1 - ema) * m[i]
        bwd = m.clone()
        for i in range(t - 2, -1, -1):
            bwd[i] = ema * bwd[i + 1] + (1 - ema) * m[i]
        m = torch.maximum(torch.minimum(fwd, bwd), m)
    return m.clamp(0, 1)


def refine_matte(m, open_px=1, close_px=3, grow_px=4, feather_px=4.0):
    if open_px > 0:
        m = dilate(erode(m, open_px), open_px)
    if close_px > 0:
        m = erode(dilate(m, close_px), close_px)
    if grow_px > 0:
        m = dilate(m, grow_px)
    if feather_px > 0:
        # the soft edge stays within feather_px of the grown matte: a gaussian's tail would otherwise reach (just
        # above the zero snap) far into the plate and cost bit-identical pixels for nothing visible
        reach = dilate((m > 0).float(), int(math.ceil(feather_px)))
        m = blur_mask(m, feather_px / 2.0) * reach
    return m.clamp(0, 1)


# ------------------------------------------------------------------ 5. composite + re-grain

def estimate_grain(frames, sample=8):
    """Per-channel noise sigma [3] (robust MAD of a high-pass), on up to `sample` frames."""
    f = rgb(frames)[:: max(1, frames.shape[0] // sample)].float()
    x = _nchw(f)
    hp = x - gaussian_blur(x, 1.0)
    flat = hp.permute(1, 0, 2, 3).flatten(1)
    flat = flat[:, :: max(1, flat.shape[1] // 200000)]
    return (flat.abs().median(dim=1).values * 1.4826).clamp(0, 0.1)


def regrain_sigma(plate, gen_full_sample):
    """The grain the generated pixels lack: sqrt(max(0, plate^2 - gen^2)) per channel."""
    sp = estimate_grain(plate)
    sg = estimate_grain(gen_full_sample)
    return torch.sqrt((sp ** 2 - sg ** 2).clamp_min(0))


def composite(plate, gen, matte, mode="local", light=None, grain=1.0, seed=0):
    """Generated pixels onto the full-resolution plate through the matte. Returns (comp [T,H,W,3], matte [T,H,W]).

    local: plate outside (bit-for-bit), gen inside.  look: plate x light map outside, gen inside.
    alpha: comp is the plate (bit-for-bit); the matte is the alpha.
    gen and light are at any size and length; they are resized per chunk.
    """
    plate = rgb(plate)
    t, h, w, _ = plate.shape
    gen = match_length(rgb(gen), t)
    matte = match_length(matte, t)
    if light is not None:
        light = match_length(light, t)
    sigma = None
    if grain > 0 and mode != "alpha":
        mid = gen[:: max(1, t // 4)][:4]
        sigma = regrain_sigma(plate, resize_frames(mid, h, w)) * float(grain)
        if float(sigma.max()) <= 1e-5:
            sigma = None
    rng = torch.Generator(device="cpu").manual_seed(int(seed))

    comps, mattes = [], []
    for i in range(0, t, CHUNK):
        p = plate[i:i + CHUNK]
        m = resize_mask(matte[i:i + CHUNK], h, w)
        m = torch.where(m < ZERO_SNAP, torch.zeros_like(m), m)
        mattes.append(m)
        if mode == "alpha":
            comps.append(p)
            continue
        g = resize_frames(gen[i:i + CHUNK], h, w)
        if sigma is not None:
            noise = torch.randn(g.shape, generator=rng).to(g.device, g.dtype)
            g = (g + noise * sigma.view(1, 1, 1, 3).to(g)).clamp(0, 1)
        base = p
        if mode == "look" and light is not None:
            lm = light[i:i + CHUNK].float()
            if lm.shape[1:3] != (h, w):   # a gain, not a picture: resize it unclamped (resize_frames clamps to 0..1)
                lm = _nhwc(F.interpolate(_nchw(lm), size=(h, w), mode="bilinear", align_corners=False))
            base = (p * lm.to(p)).clamp(0, 1)
        m3 = m.unsqueeze(-1)
        c = base * (1 - m3) + g.to(p) * m3
        if mode == "local":
            c = torch.where(m3 == 0, p, c)   # exact outside the matte, no float round-off
        comps.append(c)
    return torch.cat(comps), torch.cat(mattes)


# ------------------------------------------------------------------ 6. fidelity report

def _psnr(sse, n):
    if n <= 0:
        return None
    mse = sse / n
    return float("inf") if mse <= 1e-12 else 10 * math.log10(1.0 / mse)


def fidelity_report(plate, comp, matte, raw=None, mode="local"):
    """How much of the source plate survived. All at the plate's size and length.

    bit_identical_pct   pixels (RGB) exactly equal to the plate, over the whole frame
    edit_area_pct       pixels the matte touches at all (> 0)
    psnr_outside_db     comp vs plate where the matte is 0 (inf = lossless)
    raw_psnr_outside_db the model's own output vs plate there (what plate lock saved you from), if raw is given
    """
    plate = rgb(plate)
    t, h, w, _ = plate.shape
    comp = match_length(rgb(comp), t)
    matte = match_length(matte, t)
    if raw is not None:
        raw = match_length(rgb(raw), t)
    same = out_n = touched = 0.0
    sse = raw_sse = 0.0
    for i in range(0, t, CHUNK):
        p = plate[i:i + CHUNK].float()
        c = comp[i:i + CHUNK].float()
        m = resize_mask(matte[i:i + CHUNK], h, w)
        outside = (m == 0).float().unsqueeze(-1)
        same += float((comp[i:i + CHUNK] == plate[i:i + CHUNK]).all(dim=-1).float().sum())
        touched += float((m > 0).float().sum())
        out_n += float(outside.sum()) * 3
        sse += float((((c - p) ** 2) * outside).sum())
        if raw is not None:
            g = resize_frames(raw[i:i + CHUNK], h, w)
            raw_sse += float((((g.float() - p) ** 2) * outside).sum())
    total = float(t * h * w)

    def num(x):
        return None if x is None else ("inf" if x == float("inf") else round(x, 2))

    return {
        "kind": "soundstage.fidelity", "version": 1, "mode": mode,
        "frames": t, "resolution": f"{w}x{h}",
        "bit_identical_pct": round(100.0 * same / total, 2),
        "edit_area_pct": round(100.0 * touched / total, 2),
        "psnr_outside_db": num(_psnr(sse, out_n)),
        "raw_psnr_outside_db": num(_psnr(raw_sse, out_n)) if raw is not None else None,
    }


def format_report(r):
    def db(v):
        return "lossless" if v == "inf" else ("n/a" if v is None else f"{v:.1f} dB")
    lines = [f"Fidelity ({r['mode']}) · {r['frames']} frame(s) @ {r['resolution']}",
             f"  bit-identical to the plate: {r['bit_identical_pct']:.2f}% of pixels",
             f"  edit area (matte > 0):      {r['edit_area_pct']:.2f}%",
             f"  outside the edit:           {db(r['psnr_outside_db'])} PSNR"]
    if r.get("raw_psnr_outside_db") is not None:
        lines.append(f"  raw model there:            {db(r['raw_psnr_outside_db'])} PSNR")
    return "\n".join(lines)


# ------------------------------------------------------------------ the whole pass

def lock(plate, generated, mode="local", sensitivity=0.5, grain=1.0, seed=0, alpha=None, region_hint=None,
         protect=None, window=5, smoothing=0.6, grow_px=4, feather_px=4.0):
    """Plate-lock one result. Returns (comp [T,H,W,3], matte [T,H,W], report dict).

    alpha mode needs `alpha` (the model's matte, [T,h,w], 1 = subject) or an RGBA `generated`.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    plate = rgb(plate).float()
    t, H, W, _ = plate.shape
    if mode == "alpha":
        if alpha is None:
            if generated.shape[-1] < 4:
                raise ValueError("alpha mode needs a matte (or an RGBA result)")
            alpha = generated[..., 3]
        a = match_length(alpha.float() if alpha.dim() == 3 else alpha.float()[None], t)
        a = temporal_stabilize(a, window, smoothing) if t >= 3 else a
        comp, m = composite(plate, plate, a, mode="alpha")
        return comp, m, fidelity_report(plate, comp, torch.zeros_like(m), mode="alpha") | {
            "edit_area_pct": round(100.0 * float((m > 0).float().mean()), 2)}
    dm = difference_matte(plate, generated, mode, sensitivity, region_hint=region_hint, protect=protect)
    m = dm["matte"]
    if m.shape[0] >= 3:
        m = temporal_stabilize(m, window, smoothing)
    m = refine_matte(m, grow_px=grow_px, feather_px=feather_px)
    comp, mfull = composite(plate, dm["gen_matched"], m, mode=mode, light=dm["light"], grain=grain, seed=seed)
    return comp, mfull, fidelity_report(plate, comp, mfull, raw=generated, mode=mode)
