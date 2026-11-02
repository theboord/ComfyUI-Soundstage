"""ASC CDL (slope / offset / power / saturation): apply, match a take to a hero take, and write the files NLEs read.

Colour space: the CDL is applied to the display-encoded image (Rec.709 / sRGB curve, 0..1), the way Resolve,
Avid and Premiere apply a CDL on a Rec.709 timeline. ASC CDL v1.2 order:

    out = clamp(in * slope + offset, 0, 1) ** power        per channel
    luma = 0.2126 R + 0.7152 G + 0.0722 B                  (Rec.709 weights, as the spec says)
    out = clamp(luma + sat * (out - luma), 0, 1)

Shot matching (`fit_cdl`) is judged in OKLab: the CDL is chosen so the take's perceptual statistics (lightness
mean / spread / percentiles, mean a and b, mean chroma) land on the hero's, with a pull toward "no grade" so a
take that already matches is left alone. Three stages: per-channel quantile fit (closed form per power), a
saturation match on mean chroma, then a bounded Nelder-Mead refinement of all ten numbers on the OKLab objective.

The text writers (`cdl_xml`, `ccc_xml`, `cube_text`) are mirrored byte for byte by web/grade/grade.mjs
(tests/test_grade.py checks the two agree).
"""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

import numpy as np

from .colour import LUMA_709, as_float_rgb, pixels, srgb_to_oklab

IDENTITY = {"slope": [1.0, 1.0, 1.0], "offset": [0.0, 0.0, 0.0], "power": [1.0, 1.0, 1.0], "sat": 1.0}
BOUNDS = {"slope": (0.25, 4.0), "offset": (-0.5, 0.5), "power": (0.25, 4.0), "sat": (0.0, 3.0)}


def _num(v, d):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return d
    return f if math.isfinite(f) else d


def normalize_cdl(c) -> dict:
    """Any CDL-ish dict -> {slope[3], offset[3], power[3], sat}, clamped to sane bounds; None/garbage -> identity."""
    c = c if isinstance(c, dict) else {}
    out = {}
    for k in ("slope", "offset", "power"):
        v = c.get(k)
        d = IDENTITY[k][0]
        if not isinstance(v, (list, tuple)):
            v = [v, v, v] if v is not None else [d, d, d]
        v = (list(v) + [d, d, d])[:3]
        lo, hi = BOUNDS[k]
        out[k] = [min(hi, max(lo, _num(x, d))) for x in v]
    lo, hi = BOUNDS["sat"]
    out["sat"] = min(hi, max(lo, _num(c.get("sat"), 1.0)))
    return out


def is_identity(c, eps=1e-6) -> bool:
    c = normalize_cdl(c)
    return all(abs(a - b) < eps for k in ("slope", "offset", "power") for a, b in zip(c[k], IDENTITY[k])) \
        and abs(c["sat"] - 1) < eps


def apply_cdl(img, cdl) -> np.ndarray:
    c = normalize_cdl(cdl)
    # [N, 3] pixel lists (what the fits pass) stay as they are; images go through as_float_rgb.
    a = np.asarray(img, dtype=np.float64) if np.ndim(img) == 2 and np.shape(img)[-1] == 3 else as_float_rgb(img)
    s, o, p = (np.array(c[k]) for k in ("slope", "offset", "power"))
    v = np.clip(a * s + o, 0.0, 1.0) ** p
    y = (v @ LUMA_709)[..., None]
    return np.clip(y + c["sat"] * (v - y), 0.0, 1.0)


# ------------------------------------------------------------------------------------------------ matching

_Q = np.linspace(0.02, 0.98, 25)
_POWERS = np.geomspace(0.4, 2.5, 61)


def _fit_channel(x, y):
    """slope, offset, power with clamp(x*s+o)^p ~ y on matched quantiles (least squares, power by grid)."""
    best = (1.0, 0.0, 1.0, float(np.mean((x - y) ** 2)) + 1e-9)
    A = np.stack([x, np.ones_like(x)], 1)
    for p in _POWERS:
        z = np.clip(y, 0, 1) ** (1 / p)
        (s, o), *_ = np.linalg.lstsq(A, z, rcond=None)
        s, o = float(np.clip(s, *BOUNDS["slope"])), float(np.clip(o, *BOUNDS["offset"]))
        err = float(np.mean((np.clip(x * s + o, 0, 1) ** p - y) ** 2)) + 0.002 * math.log(p) ** 2
        if err < best[3]:
            best = (s, o, float(p), err)
    return best[:3]


def _lab_stats(lab):
    L = lab[:, 0]
    q = np.percentile(L, [5, 50, 95])
    return np.array([L.mean(), L.std(), q[0], q[1], q[2], lab[:, 1].mean(), lab[:, 2].mean(),
                     np.hypot(lab[:, 1], lab[:, 2]).mean()])


# Weights on [L mean, L std, L p05, L p50, L p95, a mean, b mean, chroma mean]: the colour terms count more, a
# cast is what an audience notices at a cut.
_W = np.array([1.0, 0.7, 0.5, 0.7, 0.5, 2.0, 2.0, 1.2])


def _vec(c):
    return np.array([*c["slope"], *c["offset"], *c["power"], c["sat"]])


def _unvec(v):
    return normalize_cdl({"slope": list(v[0:3]), "offset": list(v[3:6]), "power": list(v[6:9]), "sat": v[9]})


def _nelder_mead(f, x0, step, iters=400, tol=1e-9):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + np.eye(n)[i] * step[i] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts, vals = [pts[i] for i in order], [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol:
            break
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (p - pts[0]) for p in pts[1:]]
                vals = [vals[0]] + [f(p) for p in pts[1:]]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def match_error(src_px, hero_stats, cdl) -> float:
    """Weighted OKLab statistic distance (x100) between the graded take and the hero."""
    d = (_lab_stats(srgb_to_oklab(apply_cdl(src_px, cdl))) - hero_stats) * _W
    return float(100 * np.sqrt(np.sum(d * d)))


def fit_cdl(src, hero, reg: float = 0.02) -> dict:
    """The CDL that makes `src` (a take) match `hero` (the hero take) in OKLab. Returns
    {cdl, error_before, error_after} (match_error units, x100 OKLab)."""
    sp, hp = pixels(src), pixels(hero)
    hero_stats = _lab_stats(srgb_to_oklab(hp))
    # 1. per channel, quantile to quantile
    c = {"slope": [], "offset": [], "power": [], "sat": 1.0}
    for k in range(3):
        s, o, p = _fit_channel(np.quantile(sp[:, k], _Q), np.quantile(hp[:, k], _Q))
        c["slope"].append(s)
        c["offset"].append(o)
        c["power"].append(p)
    c = normalize_cdl(c)
    # 2. saturation on mean chroma (bisection; chroma rises with sat)
    want = hero_stats[7]
    lo, hi = 0.0, 3.0
    for _ in range(24):
        mid = (lo + hi) / 2
        got = np.hypot(*srgb_to_oklab(apply_cdl(sp, {**c, "sat": mid}))[:, 1:].T).mean()
        lo, hi = (mid, hi) if got < want else (lo, mid)
    c["sat"] = (lo + hi) / 2
    # 3. refine everything on the perceptual objective, pulled toward identity
    ident = _vec(IDENTITY)

    def obj(v):
        v = np.clip(v, [BOUNDS["slope"][0]] * 3 + [BOUNDS["offset"][0]] * 3 + [BOUNDS["power"][0]] * 3 + [BOUNDS["sat"][0]],
                    [BOUNDS["slope"][1]] * 3 + [BOUNDS["offset"][1]] * 3 + [BOUNDS["power"][1]] * 3 + [BOUNDS["sat"][1]])
        return match_error(sp, hero_stats, _unvec(v)) ** 2 + reg * 100 * float(np.sum((v - ident) ** 2))

    start = min((_vec(c), ident), key=obj)
    v, _ = _nelder_mead(obj, start, [0.05] * 3 + [0.02] * 3 + [0.05] * 3 + [0.05])
    best = _unvec(v)
    before, after = match_error(sp, hero_stats, IDENTITY), match_error(sp, hero_stats, best)
    if after >= before:   # never make it worse
        best, after = normalize_cdl(IDENTITY), before
    return {"cdl": round_cdl(best), "error_before": round(before, 3), "error_after": round(after, 3)}


def round_cdl(c, nd=4) -> dict:
    c = normalize_cdl(c)
    return {k: ([round(x, nd) for x in c[k]] if k != "sat" else round(c[k], nd)) for k in ("slope", "offset", "power", "sat")}


# ------------------------------------------------------------------------------------------------ text writers
# Byte-for-byte mirrored in web/grade/grade.mjs. Numbers: fixed 6 decimals in .cube, 4 in .cdl/.ccc.

def _fixed(v, nd) -> str:
    """JavaScript's Number.prototype.toFixed: the exact binary value rounded half away from zero (Python's own
    format rounds half to even, which differs on exact ties such as 0.03125), and never "-0"."""
    s = str(Decimal(float(v)).quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP))
    return s[1:] if s.startswith("-") and not s.strip("-0.") else s


def _f4(v) -> str:
    return _fixed(v, 4)


def _f6(v) -> str:
    return _fixed(v, 6)


def _xml(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _cc(cid, cdl, desc="", ind="  "):
    c = normalize_cdl(cdl)
    i2, i3 = ind + "  ", ind + "    "
    out = [f'{ind}<ColorCorrection id="{_xml(cid)}">']
    if desc:
        out.append(f"{i2}<Description>{_xml(desc)}</Description>")
    out += [f"{i2}<SOPNode>",
            f"{i3}<Slope>{' '.join(_f4(x) for x in c['slope'])}</Slope>",
            f"{i3}<Offset>{' '.join(_f4(x) for x in c['offset'])}</Offset>",
            f"{i3}<Power>{' '.join(_f4(x) for x in c['power'])}</Power>",
            f"{i2}</SOPNode>",
            f"{i2}<SATNode>", f"{i3}<Saturation>{_f4(c['sat'])}</Saturation>", f"{i2}</SATNode>",
            f"{ind}</ColorCorrection>"]
    return out


def cdl_xml(cid, cdl, desc="") -> str:
    """One shot's .cdl (ColorDecisionList with one ColorDecision)."""
    return "\n".join(['<?xml version="1.0" encoding="UTF-8"?>',
                      '<ColorDecisionList xmlns="urn:ASC:CDL:v1.01">', "  <ColorDecision>",
                      *_cc(cid, cdl, desc, "    "), "  </ColorDecision>", "</ColorDecisionList>", ""])


def ccc_xml(items) -> str:
    """Every shot's correction in one .ccc. items = [{id, cdl, desc?}]."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">']
    for it in items:
        out += _cc(it["id"], it["cdl"], it.get("desc", ""))
    return "\n".join(out + ["</ColorCorrectionCollection>", ""])


def edl_sop(cdl) -> list:
    """The two EDL comment lines Avid and Resolve read a CDL from."""
    c = normalize_cdl(cdl)
    return [f"*ASC_SOP ({' '.join(_f4(x) for x in c['slope'])})({' '.join(_f4(x) for x in c['offset'])})"
            f"({' '.join(_f4(x) for x in c['power'])})", f"*ASC_SAT {_f4(c['sat'])}"]


def normalize_curve(curve):
    """A tone curve: 17 output values for inputs 0, 1/16 .. 1, monotone, 0..1. None/garbage -> None."""
    if not isinstance(curve, (list, tuple)) or len(curve) != 17:
        return None
    out, prev = [], 0.0
    for v in curve:
        f = min(1.0, max(0.0, _num(v, 0.0)))
        prev = max(prev, f)
        out.append(prev)
    return out


def _curve_at(curve, v):
    x = v * 16
    i = min(15, int(x))
    u = x - i
    return curve[i] + (curve[i + 1] - curve[i]) * u


def _cdl_px(c, r, g, b):
    """One pixel through the CDL with plain floats (the .cube bake; the same arithmetic as grade.mjs)."""
    s, o, p = c["slope"], c["offset"], c["power"]
    v = []
    for k, x in enumerate((r, g, b)):
        t = x * s[k] + o[k]
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        v.append(t ** p[k])
    y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
    return [min(1.0, max(0.0, y + c["sat"] * (x - y))) for x in v]


def cube_text(cdl=None, curve=None, title="Soundstage grade", size=33) -> str:
    """A 3D .cube LUT (Rec.709 in, Rec.709 out): the CDL (or a list of CDLs, applied in order), then the tone curve
    (if any) on each channel."""
    cs = [normalize_cdl(x) for x in (cdl if isinstance(cdl, (list, tuple)) else [cdl])] or [normalize_cdl(None)]
    cv = normalize_curve(curve)
    n = int(size)
    out = [f'TITLE "{str(title).replace(chr(34), "")}"',
           "# Soundstage: ASC CDL (Rec.709 display-encoded) then tone curve. Input and output Rec.709 / sRGB.",
           f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    d = n - 1
    for bi in range(n):
        for gi in range(n):
            for ri in range(n):
                px = [ri / d, gi / d, bi / d]
                for c in cs:
                    px = _cdl_px(c, *px)
                if cv:
                    px = [_curve_at(cv, x) for x in px]
                out.append(f"{_f6(px[0])} {_f6(px[1])} {_f6(px[2])}")
    return "\n".join(out) + "\n"


def parse_cube(text):
    """(size, [N^3, 3] array, R fastest) from .cube text; enough to read our own LUTs back in tests and tools."""
    size, rows = 0, []
    for line in str(text).splitlines():
        t = line.strip()
        if not t or t.startswith("#") or t.startswith("TITLE") or t.startswith("DOMAIN"):
            continue
        if t.startswith("LUT_3D_SIZE"):
            size = int(t.split()[1])
            continue
        rows.append([float(x) for x in t.split()[:3]])
    return size, np.array(rows)


def apply_cube(img, size, table):
    """Nearest-neighbour lookup through a parsed cube (for tests: checks the bake against apply_cdl)."""
    a = as_float_rgb(img)
    idx = np.clip(np.rint(a * (size - 1)).astype(int), 0, size - 1)
    flat = idx[..., 0] + idx[..., 1] * size + idx[..., 2] * size * size
    return table[flat]
