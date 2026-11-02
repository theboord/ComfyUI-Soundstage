"""Motion graphics on the Cut timeline (V3 Graphics): nine templates from the commercial's motion design system
(share/Commercial/DESIGN_SYSTEM.md v1.1): title, kinetic type, lower third, callout zoom, PiP corner, dual PiP,
device frame, split and end card.

A graphic is a plain dict on project["graphics"]:
    {id, template, start_frame, frames, text, text2, text3, blue, variant, x, y, color, accent, rect,
     a: {shot_id, in, rung}, b: {shot_id, in, rung}, sfx}
x / y move the whole graphic (1080p design pixels); rect is a callout's target control [x, y, w, h, radius].

state_at(g, f) is pure: the graphic's look at local frame f (fractional for motion-blur sub-frames) as a list of
draw ops in 1920x1080 design space. web/cut/gfx.mjs is the JavaScript twin (the canvas preview); both compute the
same ops (tests/fixtures/gfx_states.json pins them). Text metrics stay out of the ops: the painter measures.
sfx_cues(g) lists the designed sound of every event (DESIGN_SYSTEM.md §13): the Cut places them on A2.

The painter (GfxPainter) draws ops with Pillow + numpy over the picture: raqm layout (GPOS kerning) where Pillow
has it, Space Grotesk (the App's own OFL face) for type, tracking by prefix advance so kerning survives.
render_graphics(...) runs it frame by frame between two ffmpeg pipes. No ComfyUI imports.
"""
from __future__ import annotations

import math
import os
import re
import subprocess

# ---------------------------------------------------------------------------------------------- tokens

W0, H0 = 1920, 1080
PAPER, PAPER2, PAPER3 = "#F0EFED", "rgba(240,239,237,0.68)", "rgba(240,239,237,0.54)"
INK, INK2, BEZEL, BLUE, BLUE_HI, ON_BLUE = "#0E0D10", "#141118", "#0B0A0D", "#28AAFF", "#78C8FF", "#0E0D10"
# Type scale (§5.3) with the Space Grotesk tracking column: Inter Tight is not vendored, Space Grotesk is.
TYPE = {
    "hero": {"size": 240, "lh": 216, "track": -0.030, "weight": 700},
    "display": {"size": 152, "lh": 144, "track": -0.025, "weight": 700},
    "title": {"size": 96, "lh": 96, "track": -0.020, "weight": 600},
    "headline": {"size": 60, "lh": 66, "track": -0.010, "weight": 600},
    "body": {"size": 36, "lh": 45, "track": 0.0, "weight": 500},
    "label": {"size": 22, "lh": 26, "track": 0.06, "weight": 600, "upper": True},
    "caption": {"size": 20, "lh": 26, "track": 0.01, "weight": 500},
}
OPTICAL_Y = 516

TEMPLATES = {
    "title": {"label": "Title", "frames": 48, "text": "Change anything.", "variant": "ink", "variants": ["ink", "over"]},
    "kinetic": {"label": "Kinetic type", "frames": 60, "text": "Recast. Rebuild. Rewrite.", "variant": "ink", "variants": ["ink", "over"]},
    "lower": {"label": "Lower third", "frames": 96, "text": "Block a scene in 3D.", "text2": "Step 3 · Set", "variant": "clean",
              "variants": ["clean", "glass"]},
    "callout": {"label": "Callout zoom", "frames": 72, "text": "Rebuild this clip as a 3D set", "variant": "zoom",
                "variants": ["zoom", "ring", "click"], "rect": [1180, 720, 420, 64, 8]},
    "pip": {"label": "PiP corner", "frames": 96, "text": "", "variant": "br", "variants": ["br", "tr", "bl"]},
    "dual": {"label": "Dual PiP", "frames": 96, "text": "Generated", "text2": "Rebuilt in 3D", "variant": "even",
             "variants": ["even", "stagger", "stack"]},
    "device": {"label": "Device frame", "frames": 96, "text": "", "variant": "monitor", "variants": ["monitor", "phone"]},
    "split": {"label": "Split", "frames": 72, "text": "Final", "text2": "Clay", "variant": "reveal", "variants": ["reveal", "hold"]},
    "endcard": {"label": "End card", "frames": 120, "text": "A film set inside ComfyUI.", "text2": "github.com/theboord/ComfyUI-Soundstage",
                "text3": "", "variant": "ink", "variants": ["ink"]},
}
RUNGS = ("auto", "clay", "look", "draft", "final", "source")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _rint(v):
    """JavaScript's Math.round (half up), so both twins agree on .5."""
    return int(math.floor(float(v) + 0.5))


def _r(v, n=3):
    """Round for the ops (both twins round the same way, so the fixtures compare exactly)."""
    x = math.floor(float(v) * 10 ** n + 0.5) / 10 ** n
    return 0.0 if x == 0 else x


def _num(v, d=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return d
    return f if math.isfinite(f) else d


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


# ---------------------------------------------------------------------------------------------- easing (§8)

def cubic_bezier(x1, y1, x2, y2):
    def bx(s):
        return 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s

    def by(s):
        return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s

    def f(u):
        if u <= 0:
            return 0.0
        if u >= 1:
            return 1.0
        lo, hi = 0.0, 1.0
        for _ in range(60):
            m = (lo + hi) / 2
            if bx(m) < u:
                lo = m
            else:
                hi = m
        return by((lo + hi) / 2)
    return f


EASE = {
    "glide": cubic_bezier(0.20, 0.00, 0.00, 1.00),
    "swift": cubic_bezier(0.40, 0.00, 0.20, 1.00),
    "exit": cubic_bezier(0.30, 0.00, 0.80, 0.15),
    "enter": cubic_bezier(0.05, 0.70, 0.10, 1.00),
    "fade": lambda u: 0.5 - 0.5 * math.cos(math.pi * _clamp(u, 0, 1)),
    "linear": lambda u: _clamp(u, 0, 1),
}


def ao(f, a=3, m=8, s=5, A=0.04, O=0.03):
    """Anticipation and overshoot (§8.3)."""
    if f <= 0:
        return 0.0
    if f <= a:
        return -A * EASE["fade"](f / a)
    if f <= a + m:
        return -A + (1 + O + A) * EASE["glide"]((f - a) / m)
    if f <= a + m + s:
        return 1 + O - O * EASE["fade"]((f - a - m) / s)
    return 1.0


def spring(f, wn=15.23, zeta=0.75, fps=24):
    """Damped spring progress at frame f (§8.4): spring 15.23 rad/s, spring-fast 22.85 rad/s."""
    if f <= 0:
        return 0.0
    t = f / fps
    wd = wn * math.sqrt(1 - zeta * zeta)
    return 1 - math.exp(-zeta * wn * t) * (math.cos(wd * t) + (zeta * wn / wd) * math.sin(wd * t))


def spring_fast(f):
    return spring(f, 22.85)


SLAM = [1.100, 1.104, 1.111, 1.115, 1.062, 1.020, 1.001, 0.991, 0.986, 0.985, 0.986, 0.990, 0.995, 0.999, 1.000]


def slam_scale(f):
    """T2 slam scale (§10.1), interpolated between the table's frames."""
    if f <= 0:
        return SLAM[0]
    if f >= len(SLAM) - 1:
        return 1.0
    i = int(math.floor(f))
    return SLAM[i] + (SLAM[i + 1] - SLAM[i]) * (f - i)


def expo(s0, s1, p):
    return s0 * (s1 / s0) ** p


def snap8(y):
    return math.floor(y / 8) * 8


def _u(f, start, n):
    return _clamp((f - start) / n, 0.0, 1.0) if n > 0 else 1.0


# ---------------------------------------------------------------------------------------------- normalise

def _src(v, rung="auto"):
    if not isinstance(v, dict) or not v.get("shot_id"):
        return None
    return {"shot_id": str(v["shot_id"]), "in": max(0, _rint(_num(v.get("in")))),
            "rung": v.get("rung") if v.get("rung") in RUNGS else rung}


def normalize_graphics(lst) -> list:
    """The V3 graphics list, clamped (twin: web/cut/gfx.mjs normalizeGraphics)."""
    seen, out = set(), []
    for i, g in enumerate(x for x in (lst if isinstance(lst, list) else []) if isinstance(x, dict)):
        tpl = g.get("template") if g.get("template") in TEMPLATES else "title"
        d = TEMPLATES[tpl]
        gid = str(g["id"]) if g.get("id") is not None else f"g{i + 1}"
        while gid in seen:
            gid += "_"
        seen.add(gid)
        item = {"id": gid, "template": tpl, "start_frame": max(0, _rint(_num(g.get("start_frame")))),
                "frames": int(_clamp(_rint(_num(g.get("frames"), d["frames"])), 12, 2400)),
                "text": str(g["text"] if g.get("text") is not None else d.get("text", ""))[:200],
                "text2": str(g["text2"] if g.get("text2") is not None else d.get("text2", ""))[:200],
                "text3": str(g["text3"] if g.get("text3") is not None else d.get("text3", ""))[:200],
                "blue": str(g.get("blue") or "")[:60],
                "variant": g.get("variant") if g.get("variant") in d["variants"] else d["variant"],
                "x": _r(_clamp(_num(g.get("x")), -1920, 1920), 1), "y": _r(_clamp(_num(g.get("y")), -1080, 1080), 1),
                "color": g["color"].upper() if isinstance(g.get("color"), str) and _HEX.match(g["color"]) else PAPER,
                "accent": g["accent"].upper() if isinstance(g.get("accent"), str) and _HEX.match(g["accent"]) else BLUE,
                "sfx": g.get("sfx") is not False}
        if tpl == "callout":
            r = g.get("rect") if isinstance(g.get("rect"), list) else d["rect"]
            r = [_num(v) for v in (list(r) + d["rect"][len(r):])[:5]]
            w, h = _clamp(r[2], 8, 1920), _clamp(r[3], 8, 1080)
            item["rect"] = [_r(_clamp(r[0], 0, 1920 - w), 1), _r(_clamp(r[1], 0, 1080 - h), 1), _r(w, 1), _r(h, 1), _r(_clamp(r[4], 0, 200), 1)]
        a, b = _src(g.get("a"), "final" if tpl == "split" else "auto"), _src(g.get("b"), "clay" if tpl == "split" else "auto")
        if tpl == "split" and a and not b:
            b = {"shot_id": a["shot_id"], "in": a["in"], "rung": "clay"}
        if a:
            item["a"] = a
        if b:
            item["b"] = b
        out.append(item)
    return sorted(out, key=lambda x: x["start_frame"])


def graphic_at(project, f):
    """The graphics showing at record frame f, bottom to top: [(graphic, local frame)]."""
    return [(g, f - g["start_frame"]) for g in project.get("graphics") or [] if g["start_frame"] <= f < g["start_frame"] + g["frames"]]


# ---------------------------------------------------------------------------------------------- ops

def _type(tok, **kw):
    return {"op": "text", "token": tok, **kw}


def _rise(f, start, em, out_start=None):
    """T1 rise + T6 out: (dy, alpha) for a line starting at `start`, leaving at `out_start` (8 f exit)."""
    dy = 0.6 * em * (1 - EASE["glide"](_u(f, start, 14)))
    al = EASE["fade"](_u(f, start, 8))
    if out_start is not None and f >= out_start:
        u = _u(f, out_start, 8)
        dy -= 0.15 * em * EASE["exit"](u)
        al *= 1 - EASE["fade"](u)
    return dy, al


def _chip_in(f, start):
    """Chip in (§8.5): spring-fast scale .92 -> 1, fade over 6 f. (scale, alpha)"""
    if f < start:
        return 0.92, 0.0
    return 0.92 + 0.08 * spring_fast(f - start), EASE["fade"]((f - start) / 6)


def _window_in_out(f, n, start=0):
    """Window in (16 f glide: y +48 -> 0, scale .94 -> 1, fade 8 f, shadow 1 -> 2), out (last 10 f exit: y +32,
    scale .97, fade). (dy, scale, alpha, shadow)"""
    p = EASE["glide"](_u(f, start, 16))
    dy, sc, al, sh = 48 * (1 - p), 0.94 + 0.06 * p, EASE["fade"](_u(f, start, 8)), 1 + p
    if f >= n - 10:
        q = EASE["exit"](_u(f, n - 10, 10))
        dy += 32 * q
        sc *= 1 - 0.03 * q
        al *= 1 - EASE["fade"](_u(f, n - 10, 10))
    return dy, sc, al, sh


def _recede(f, n, out_len=14):
    """Recede amount 0..1 (§7.6): in with glide over 16 f, out with glide over the last out_len f."""
    k = EASE["glide"](_u(f, 0, 16))
    if f >= n - out_len:
        k *= 1 - EASE["glide"](_u(f, n - out_len, out_len))
    return k


def _win(src, x, y, w, h, r, dy=0.0, sc=1.0, al=1.0, sh=2.0, dim=1.0, still=False):
    cx, cy = x + w / 2, y + h / 2
    ww, hh = w * sc, h * sc
    return {"op": "window", "src": src, "x": _r(cx - ww / 2), "y": _r(cy - hh / 2 + dy), "w": _r(ww), "h": _r(hh), "r": _r(r * sc),
            "alpha": _r(al), "shadow": _r(sh), "dim": _r(dim), "still": still}


def state_at(g, f):
    """The ops for graphic g at local frame f (0 <= f < frames)."""
    tpl, n = g["template"], g["frames"]
    ox, oy, col, acc = g.get("x", 0), g.get("y", 0), g.get("color", PAPER), g.get("accent", BLUE)
    ops = []
    if tpl in ("title", "kinetic"):
        if g["variant"] == "over":
            k = _recede(f, n)
            ops += [{"op": "recede", "k": _r(k)}, {"op": "scrim", "kind": "full", "alpha": _r(k)}]
        else:
            ops.append({"op": "fill", "color": INK, "alpha": 1.0})
    if tpl == "title":
        lines = [ln for ln in str(g["text"]).split("\n") if ln.strip()][:2] or [" "]
        one_word = len(lines) == 1 and " " not in lines[0].strip() and len(lines[0].strip()) <= 9
        tok = "hero" if one_word else "display" if all(len(x) <= 18 for x in lines) else "title"
        t = TYPE[tok]
        for i, ln in enumerate(lines):
            y = OPTICAL_Y + (i - (len(lines) - 1) / 2) * t["lh"]
            dy, al = _rise(f, 3 * i, t["size"], n - 8)
            left = len(lines) > 1
            ops.append(_type(tok, text=ln, x=_r((96 if left else 960) + ox), y=_r(y + oy + dy), align="left" if left else "center",
                             anchor="middle", color=col, blue=g.get("blue", ""), accent=acc, alpha=_r(al),
                             clip=[_r(y + oy - t["lh"] / 2 - 0.1 * t["size"]), _r(y + oy + t["lh"] / 2 + 0.1 * t["size"])]))
    elif tpl == "kinetic":
        words = str(g["text"]).split() or [" "]
        tok = "hero" if max(len(w) for w in words) <= 9 else "display"
        em = TYPE[tok]["size"]
        for k, wd in enumerate(words):
            s0 = 12 * k                        # incoming start; sync f7 lands on the beat
            end = 12 * (k + 1) - 2 if k + 1 < len(words) else None
            if f < s0 or (end is not None and f >= end + 6):
                continue
            lf = f - s0
            if k == 0:
                sc, al, blur, dy = slam_scale(lf), EASE["fade"](lf / 3), 4 * (1 - _u(lf, 3, 4)), 0.0
            else:
                sc, al, blur = 1.0, EASE["fade"](lf / 6), 0.0
                dy = 0.4 * em * (1 - EASE["glide"](_u(lf, 0, 12)))
            if end is not None and f >= end:     # swapped out: up 0.4em on exit, fade over 6 f
                u = _u(f, end, 6)
                dy -= 0.4 * em * EASE["exit"](u)
                al *= 1 - EASE["fade"](u)
            if end is None and f >= n - 8:       # last word out (T6)
                u = _u(f, n - 8, 8)
                dy -= 0.15 * em * EASE["exit"](u)
                al *= 1 - EASE["fade"](u)
            ops.append(_type(tok, text=wd, x=_r(960 + ox), y=_r(OPTICAL_Y + oy + dy), align="center", anchor="middle", color=col,
                             blue=g.get("blue", ""), accent=acc, alpha=_r(al), scale=_r(sc), blur=_r(blur)))
    elif tpl == "lower":
        sk = EASE["fade"](_u(f, 0, 8)) * (1 - EASE["fade"](_u(f, n - 8, 8)))
        if g["variant"] == "glass":
            ops.append({"op": "plate", "x": _r(72 + ox), "y": _r(826 + oy), "w": 900, "h": 160, "r": 16, "alpha": _r(sk)})
        else:
            ops.append({"op": "scrim", "kind": "bottom", "alpha": _r(sk)})
        sc, al = _chip_in(f, 0)
        if f >= n - 8:
            al *= 1 - EASE["fade"](_u(f, n - 8, 8))
        if g.get("text2"):
            ops.append(_type("label", text=g["text2"], x=_r(96 + ox), y=_r(880 + oy), align="left", anchor="baseline", color=acc,
                             alpha=_r(al), scale=_r(sc)))
        dy, al2 = _rise(f, 3, TYPE["headline"]["size"], n - 8)
        ops.append(_type("headline", text=g["text"], x=_r(96 + ox), y=_r(952 + oy + dy), align="left", anchor="baseline", color=col,
                         blue=g.get("blue", ""), accent=acc, alpha=_r(al2), maxw=852,
                         clip=[_r(952 + oy - 66), _r(952 + oy + 24)]))
    elif tpl == "callout":
        x, y, w, h, rad = g["rect"]
        cx, cy = x + w / 2, y + h / 2
        zs = min(0.60 * 1920 / (w + 96), 0.50 * 1080 / (h + 96), 2.0)
        zoom = g["variant"] != "ring" and zs >= 1.4
        out0 = n - 14
        p = EASE["glide"](_u(f, 0, 18)) if zoom else 0.0
        if zoom and f >= out0:
            p *= 1 - EASE["glide"](_u(f, out0, 14))
        z = expo(1.0, zs, p) if zoom else 1.0
        camx = _clamp(960 + (cx - 960) * p, 960 / z, 1920 - 960 / z)
        camy = _clamp(540 + (cy - 540) * p, 540 / z, 1080 - 540 / z)
        if zoom:
            ops.append({"op": "zoom", "cx": _r(camx), "cy": _r(camy), "z": _r(z, 4)})

        def proj(px, py):
            return (px - camx) * z + 960, (py - camy) * z + 540
        X0, Y0 = proj(x, y)
        X1, Y1 = proj(x + w, y + h)
        fade_out = 1 - EASE["fade"](_u(f, out0, 6))
        ring0 = 10 if zoom else 0
        if f >= ring0:
            rs = 1.08 - 0.08 * spring(f - ring0)
            ra = EASE["fade"]((f - ring0) / 6) * fade_out
            ops.append({"op": "ring", "x": _r(X0 - 8), "y": _r(Y0 - 8), "w": _r(X1 - X0 + 16), "h": _r(Y1 - Y0 + 16),
                        "r": _r(min(rad * z + 8, (Y1 - Y0 + 16) / 2)), "scale": _r(rs), "alpha": _r(ra), "color": acc})
        chip0 = ring0 + 4
        if g.get("text") and f >= chip0:
            sc, al = _chip_in(f, chip0)
            below = (Y0 + Y1) / 2 < 540
            ops.append({"op": "chip", "text": g["text"], "cx": _r(_clamp((X0 + X1) / 2, 96, 1824)),
                        "y": _r(Y1 + 8 + 16 if below else Y0 - 8 - 16 - 40), "h": 40, "fill": "blue", "color": acc,
                        "scale": _r(sc), "alpha": _r(al * fade_out)})
        if g["variant"] == "click":
            hop0, hop1, click = 0, 14, chip0 + 8
            sx, sy = cx + 260, cy + 180
            q = EASE["glide"](_u(f, hop0, hop1 - hop0))
            px, py = sx + (cx - sx) * q, sy + (cy - sy) * q
            PX, PY = proj(px, py)
            press = 1.0
            if f >= click:
                lf = f - click
                press = 1 - 0.12 * EASE["fade"](lf / 3) if lf < 3 else 0.88 + 0.12 * spring_fast(lf - 3)
            cur = {"op": "cursor", "x": _r(PX), "y": _r(PY), "scale": _r(press * min(1.5, z)), "alpha": _r(fade_out)}
            if click <= f < click + 10:
                u = EASE["glide"]((f - click) / 10)
                cur["ripple"] = [_r(6 + 22 * u), _r(0.9 * (1 - u))]
            ops.append(cur)
    elif tpl in ("pip", "dual"):
        k = _recede(f, n, 10)
        ops.append({"op": "recede", "k": _r(k)})
        if tpl == "pip":
            px, py = {"br": (1264, 669), "tr": (1264, 96), "bl": (96, 669)}[g["variant"]]
            dy, sc, al, sh = _window_in_out(f, n)
            ops.append(_win("a", px + ox, py + oy, 560, 315, 20, dy, sc, al, sh))
            if g.get("text"):
                ops.append(_type("label", text=g["text"], x=_r(px + ox), y=_r(snap8(py - 16) + oy + dy), align="left", anchor="baseline",
                                 color=col, alpha=_r(al)))
        else:
            v = g["variant"]
            ra, rb = ((96, 300, 852, 480, 28), (972, 300, 852, 480, 28)) if v == "even" else ((96, 152, 998, 562, 28), (972, 586, 706, 398, 28))
            if v == "stack":
                rb = (972, 312, 414, 518, 16)
            da, sa, aa, ha = _window_in_out(f, n, 0)
            db, sb, ab, hb = _window_in_out(f, n, 4)
            ops.append(_win("a", ra[0] + ox, ra[1] + oy, ra[2], ra[3], ra[4], da, sa, aa, ha))
            ops.append(_win("b", rb[0] + ox, rb[1] + oy, rb[2], rb[3], rb[4], db, sb, ab, hb + (1 if v != "even" else 0) * EASE["glide"](_u(f, 4, 16)),
                            still=v == "stack"))
            if v == "even":
                for txt, r_, d_, a_ in ((g.get("text"), ra, da, aa), (g.get("text2"), rb, db, ab)):
                    if txt:
                        ops.append(_type("label", text=txt, x=_r(r_[0] + ox), y=_r(280 + oy + d_), align="left", anchor="baseline", color=col, alpha=_r(a_)))
            elif g.get("text"):
                lab_y, lab_x = (snap8(rb[1] - 16), rb[0]) if v == "stack" else (snap8(ra[1] - 16), ra[0])
                lf = 8 if v == "stack" else 0
                _, _, al_, _ = _window_in_out(f, n, lf)
                ops.append(_type("label", text=g["text"], x=_r(lab_x + ox), y=_r(lab_y + oy), align="left", anchor="baseline", color=col, alpha=_r(al_)))
    elif tpl == "device":
        ops.append({"op": "fill", "color": INK, "alpha": 1.0})
        dy, sc, al, sh = _window_in_out(f, n)
        if g["variant"] == "phone":
            outer, screen, ro, rs = (1352, 138, 384, 804), (1364, 150, 360, 780), 60, 48
        else:
            outer, screen, ro, rs = (374, 204, 1172, 672), (388, 218, 1144, 644), 28, 14
        cx, cy = outer[0] + outer[2] / 2 + ox, outer[1] + outer[3] / 2 + oy

        def tr(rx, ry, rw, rh):
            return cx + (rx + ox - cx) * sc, cy + (ry + oy - cy) * sc + dy, rw * sc, rh * sc
        bx, by, bw, bh = tr(*outer)
        ops.append({"op": "bezel", "x": _r(bx), "y": _r(by), "w": _r(bw), "h": _r(bh), "r": _r(ro * sc), "alpha": _r(al), "shadow": 3})
        sx_, sy_, sw, sh_ = tr(*screen)
        ops.append({"op": "window", "src": "a", "x": _r(sx_), "y": _r(sy_), "w": _r(sw), "h": _r(sh_), "r": _r(rs * sc), "alpha": _r(al),
                    "shadow": 0.0, "dim": 1.0, "still": False})
        if g.get("text"):
            if g["variant"] == "phone":
                dy2, al2 = _rise(f, 6, TYPE["headline"]["size"], n - 8)
                ops.append(_type("title", text=g["text"], x=_r(96 + ox), y=_r(OPTICAL_Y + oy + dy2), align="left", anchor="middle",
                                 color=col, blue=g.get("blue", ""), accent=acc, alpha=_r(al2), maxw=998))
            else:
                ops.append(_type("label", text=g["text"], x=_r(outer[0] + 14 + ox), y=_r(snap8(outer[1] - 16) + oy + dy), align="left",
                                 anchor="baseline", color=col, alpha=_r(al)))
    elif tpl == "split":
        hold = g["variant"] == "hold"
        xd = 960 * EASE["glide"](_u(f, 0, 14))
        fin0 = n - 24
        if not hold and f >= fin0:
            xd = 960 + 960 * EASE["swift"](_u(f, fin0, 24))
        ops.append({"op": "split", "x": _r(xd), "left": "a", "right": "b"})
        if g.get("text"):    # the new state's chip, top left, lands with the divider
            sc, al = _chip_in(f, 8)
            ops.append({"op": "chip", "text": g["text"], "x": 96, "y": 96, "h": 40, "fill": "glass", "color": PAPER, "scale": _r(sc), "alpha": _r(al)})
        if g.get("text2"):   # the old state's chip, top right
            sc, al = _chip_in(f, 0)
            if not hold and f >= fin0:
                al *= 1 - EASE["fade"](_u(f, fin0, 8))
            ops.append({"op": "chip", "text": g["text2"], "right": 1824, "y": 96, "h": 40, "fill": "glass", "color": PAPER, "scale": _r(sc), "alpha": _r(al)})
    elif tpl == "endcard":
        ops.append({"op": "fill", "color": INK, "alpha": 1.0})
        p = EASE["glide"](_u(f, 0, 14))
        ops.append({"op": "logo", "cx": _r(960 + ox), "y": _r(400 + oy + 12 * (1 - p)), "w": 640, "alpha": _r(EASE["fade"](_u(f, 0, 14)))})
        for txt, tok, base, start, c in ((g.get("text"), "headline", 600, 12, col), (g.get("text2"), "body", 664, 24, PAPER2),
                                         (g.get("text3"), "caption", 936, 36, PAPER3)):
            if txt:
                dy, al = _rise(f, start, TYPE[tok]["size"])
                ops.append(_type(tok, text=txt, x=_r(960 + ox), y=_r(base + oy + dy), align="center", anchor="baseline", color=c,
                                 alpha=_r(al), clip=[_r(base + oy - TYPE[tok]["lh"]), _r(base + oy + 0.35 * TYPE[tok]["size"])]))
    return ops


# ---------------------------------------------------------------------------------------------- sound (§13)

# id -> (file stem, peak dBFS in the mix). Files are peak-normalised to -1 dBFS; the clip gain sets the level.
SFX = {"SFX-01": ("tick", -28), "SFX-02": ("swap", -28), "SFX-03": ("thump", -10), "SFX-04": ("whoosh", -20),
       "SFX-05": ("whoosh_out", -24), "SFX-06": ("riser", -22), "SFX-07": ("ping", -24), "SFX-08": ("click", -26),
       "SFX-09": ("air", -22), "SFX-12": ("puff", -30), "SFX-15": ("logo_swell", -14)}


def _pan(xc):
    p = _clamp((xc - 960) / 1920, -0.5, 0.5)
    return "l" if p < -0.15 else "r" if p > 0.15 else "c"


def sfx_cues(g):
    """[{sfx, frame (local), gain_db, pan: l|c|r, variant, label}] for graphic g: one designed sound per event."""
    if not g.get("sfx", True):
        return []
    tpl, n, out = g["template"], g["frames"], []

    def cue(sid, frame, pan="c", variant="", extra_db=0.0, label=""):
        if 0 <= frame < n:
            out.append({"sfx": sid, "frame": int(frame), "gain_db": _r(SFX[sid][1] + 1 + extra_db, 1), "pan": pan, "variant": variant,
                        "label": label or sid})
    ox = g.get("x", 0)
    if tpl == "title":
        lines = [ln for ln in str(g["text"]).split("\n") if ln.strip()][:2] or [" "]
        for i in range(len(lines)):
            cue("SFX-01", 3 * i, variant=str(i % 3 + 1), label="type rise")
    elif tpl == "kinetic":
        words = str(g["text"]).split() or [" "]
        cue("SFX-03", 7, label="slam")
        for k in range(1, len(words)):
            cue("SFX-02", 12 * k - 2, label="type swap")
    elif tpl == "lower":
        if g.get("text2"):
            cue("SFX-12", 0, "l", label="eyebrow")
        cue("SFX-01", 3, "l", "2", label="line rise")
    elif tpl == "callout":
        x, y, w, h, _ = g["rect"]
        zs = min(0.60 * 1920 / (w + 96), 0.50 * 1080 / (h + 96), 2.0)
        zoom = g["variant"] != "ring" and zs >= 1.4
        pan = _pan(x + w / 2)
        if zoom:
            cue("SFX-06", 0, label="zoom in")
            cue("SFX-05", n - 14, extra_db=-6, label="zoom out")
        cue("SFX-07", 10 if zoom else 0, pan, label="focus ring")
        if g.get("text"):
            cue("SFX-12", (10 if zoom else 0) + 4, pan, label="chip")
        if g["variant"] == "click":
            cue("SFX-08", (10 if zoom else 0) + 12, pan, label="click")
    elif tpl == "pip":
        side = {"br": 1264 + 280, "tr": 1264 + 280, "bl": 96 + 280}[g["variant"]] + ox
        cue("SFX-04", 0, _pan(side), label="window in")
        cue("SFX-05", n - 10, _pan(side), label="window out")
    elif tpl == "dual":
        cue("SFX-04", 0, "l", label="window A in")
        cue("SFX-04", 4, "r", "up2", label="window B in")
        cue("SFX-05", n - 10, label="windows out")
    elif tpl == "device":
        cue("SFX-04", 0, _pan(1544 + ox) if g["variant"] == "phone" else "c", "down3", label="device in")
        cue("SFX-05", n - 10, label="device out")
    elif tpl == "split":
        cue("SFX-09", 0, "l", label="divider")
        if g["variant"] != "hold":
            cue("SFX-09", n - 24, "r", label="divider out")
    elif tpl == "endcard":
        cue("SFX-15", 0, label="sonic logo")
        if g.get("text"):
            cue("SFX-01", 12, variant="1", label="tagline")
        if g.get("text2"):
            cue("SFX-01", 24, variant="2", label="repo line")
    return out


# ---------------------------------------------------------------------------------------------- the painter

FONT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "web", "vendor", "fonts"))
LOGO = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "web", "cut", "gfx_logo.png"))


def _rgba(c, alpha=1.0):
    if isinstance(c, str) and c.startswith("rgba"):
        r, g, b, a = [float(v) for v in c[5:-1].split(",")]
        return int(r), int(g), int(b), int(round(255 * a * alpha))
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), int(round(255 * alpha))


class GfxPainter:
    """Draws ops over a picture with Pillow. W x H output; design space is 1920 x 1080 scaled by W / 1920 (a 9:16
    frame gets the 16:9 layout fitted to its width, centred)."""

    def __init__(self, W, H):
        from PIL import ImageFont
        self.W, self.H = W, H
        self.s = W / W0
        self.oy = (H - H0 * self.s) / 2
        self._fonts = {}
        self._masks = {}
        self._shadows = {}
        self.raqm = False
        try:
            from PIL import features
            self.raqm = bool(features.check("raqm"))
        except Exception:  # noqa: BLE001
            pass
        self._layout = ImageFont.Layout.RAQM if self.raqm else ImageFont.Layout.BASIC
        self._logo = None

    # --- helpers
    def X(self, v):
        return v * self.s

    def Y(self, v):
        return v * self.s + self.oy

    def font(self, weight, size):
        from PIL import ImageFont
        key = (weight, round(size * 4) / 4)
        if key not in self._fonts:
            w = {500: 500, 600: 600, 700: 700}.get(weight, 500)
            path = os.path.join(FONT_DIR, f"space-grotesk-{w}.woff2")
            self._fonts[key] = ImageFont.truetype(path, max(4.0, key[1]), layout_engine=self._layout)
        return self._fonts[key]

    def _rr_mask(self, w, h, r, ss=2):
        """An antialiased rounded-rect L mask of w x h px (drawn at ss x, then reduced)."""
        from PIL import Image, ImageDraw
        w, h = max(1, int(round(w))), max(1, int(round(h)))
        key = (w, h, int(round(r)))
        m = self._masks.get(key)
        if m is None:
            big = Image.new("L", (w * ss, h * ss), 0)
            ImageDraw.Draw(big).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius=max(0, r * ss), fill=255)
            m = big.resize((w, h), Image.LANCZOS)
            if len(self._masks) > 256:
                self._masks.clear()
            self._masks[key] = m
        return m

    @staticmethod
    def _paste(dst, layer, x, y):
        """alpha_composite an RGBA layer at (x, y), clipped to dst (negative offsets allowed)."""
        x, y = int(round(x)), int(round(y))
        lw, lh = layer.size
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(dst.size[0], x + lw), min(dst.size[1], y + lh)
        if x1 <= x0 or y1 <= y0:
            return
        part = layer.crop((x0 - x, y0 - y, x1 - x, y1 - y))
        dst.alpha_composite(part, (x0, y0))

    def _shadow(self, dst, x, y, w, h, r, tier, alpha):
        """Shadow tiers 1..3 (§7.3) as blurred rounded rects, computed at quarter size."""
        from PIL import Image, ImageFilter
        if tier <= 0 or alpha <= 0:
            return
        layers = {1: [(1, 2, .30), (4, 12, .24)], 2: [(2, 4, .28), (12, 28, .32), (32, 72, .36)],
                  3: [(4, 8, .30), (24, 48, .36), (60, 120, .45)]}
        lo, hi = int(math.floor(tier)), int(math.ceil(tier))
        mixes = [(lo, 1.0)] if lo == hi else [(lo, hi - tier), (hi, tier - lo)]
        q = 4
        key = ("shadow", int(round(w)), int(round(h)), int(round(r)), round(tier, 2), round(alpha, 2))
        hit = self._shadows.get(key)
        if hit is not None:
            for lay, ox, oy in hit:
                self._paste(dst, lay, x + ox, y + oy)
            return
        made = []
        for t, wt in mixes:
            if t <= 0 or wt <= 0:
                continue
            for dy, blur, a in layers[t]:
                dy_s, b_s = dy * self.s, blur * self.s
                pad = int(b_s * 1.5) + 2
                ww, hh = int((w + 2 * pad) / q) + 1, int((h + 2 * pad) / q) + 1
                m = Image.new("L", (ww, hh), 0)
                inner = self._rr_mask(max(1, w / q), max(1, h / q), r / q)
                m.paste(inner, (int(pad / q), int(pad / q)))
                if b_s / q > 0.3:
                    m = m.filter(ImageFilter.GaussianBlur(b_s / q / 2))
                m = m.resize((ww * q, hh * q), Image.BILINEAR)
                amt = a * wt * alpha
                m = m.point(lambda v, amt=amt: int(v * amt))
                lay = Image.new("RGBA", m.size, (0, 0, 0, 0))
                lay.putalpha(m)
                made.append((lay, -pad, -pad + dy_s))
                self._paste(dst, lay, x - pad, y - pad + dy_s)
        if len(self._shadows) > 64:
            self._shadows.clear()
        self._shadows[key] = made

    def _text_layer(self, op):
        """An RGBA layer with op's text and the (x, y) of its top left in output px."""
        from PIL import Image, ImageDraw, ImageFilter
        t = TYPE[op["token"]]
        text = op["text"].upper() if t.get("upper") else op["text"]
        sc = op.get("scale", 1.0)
        size = t["size"] * self.s * sc
        font = self.font(t["weight"], size)
        track = t["track"] * size
        n = len(text)
        adv = [font.getlength(text[:i]) + i * track for i in range(n + 1)]
        width = adv[-1] - (track if n else 0)
        maxw = op.get("maxw")
        if maxw and width > maxw * self.s and n:    # never wider than its columns: shrink to fit
            k = maxw * self.s / width
            size *= k
            font = self.font(t["weight"], size)
            track = t["track"] * size
            adv = [font.getlength(text[:i]) + i * track for i in range(n + 1)]
            width = adv[-1] - track
        asc, desc = font.getmetrics()
        cap = -font.getbbox("H", anchor="ls")[1]
        pad = int(size * 0.3) + 4 + int(op.get("blur", 0) * self.s * 3)
        lw, lh = int(width + 2 * pad) + 1, int(asc + desc + 2 * pad) + 1
        layer = Image.new("RGBA", (lw, lh), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        base = pad + asc
        blue = (op.get("blue") or "").strip()
        bi = text.find(blue.upper() if t.get("upper") else blue) if blue else -1
        c0, c1 = _rgba(op.get("color", PAPER)), _rgba(op.get("accent", BLUE))
        if not self.raqm or abs(track) < 1e-6 and bi < 0:
            # one pass keeps contextual alternates; tracking 0 needs no per-glyph placement
            if abs(track) < 1e-6 and bi < 0:
                d.text((pad, base), text, font=font, fill=c0, anchor="ls")
            else:
                for i, ch in enumerate(text):
                    d.text((pad + adv[i], base), ch, font=font, fill=c1 if 0 <= bi <= i < bi + len(blue) else c0, anchor="ls")
        else:
            for i, ch in enumerate(text):
                d.text((pad + adv[i], base), ch, font=font, fill=c1 if 0 <= bi <= i < bi + len(blue) else c0, anchor="ls")
        if op.get("blur", 0) > 0.05:
            layer = layer.filter(ImageFilter.GaussianBlur(op["blur"] * self.s))
        al = op.get("alpha", 1.0)
        if al < 0.999:
            a = layer.getchannel("A").point(lambda v, al=al: int(v * al))
            layer.putalpha(a)
        # anchor: the x is the left edge or the centre (centred type with negative tracking shifts by half of it)
        X = self.X(op["x"])
        x0 = X - pad if op.get("align") == "left" else X - width / 2 - pad
        Y = self.Y(op["y"])
        y0 = (Y - base) if op.get("anchor") == "baseline" else (Y + cap / 2 - base)
        return layer, x0, y0

    def logo(self):
        from PIL import Image
        if self._logo is None:
            self._logo = Image.open(LOGO).convert("RGBA") if os.path.isfile(LOGO) else None
        return self._logo

    # --- the frame
    def compose(self, pic, ops, sources):
        """pic: PIL RGB (W x H, the V1 picture under the graphic); sources: {"a": PIL RGB, "b": PIL RGB} at W x H.
        Returns PIL RGB."""
        from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
        W, H = self.W, self.H
        img = pic.convert("RGB")
        for op in ops:
            if op["op"] == "zoom":
                z, cx, cy = op["z"], self.X(op["cx"]), self.Y(op["cy"])
                hw, hh = W / 2 / z, H / 2 / z
                img = img.resize((W, H), Image.LANCZOS, box=(cx - hw, cy - hh, cx + hw, cy + hh))
            elif op["op"] == "recede" and op["k"] > 0.001:
                k = op["k"]
                s = 1 + 0.03 * k
                hw, hh = W / 2 / s, H / 2 / s
                # scale +3 % and an 8 px blur (at quarter size: the plate behind a window is soft anyway)
                small = img.resize((W // 4, H // 4), Image.BILINEAR, box=(W / 2 - hw, H / 2 - hh, W / 2 + hw, H / 2 + hh))
                img = small.filter(ImageFilter.GaussianBlur(8 * k * self.s / 2 / 4)).resize((W, H), Image.BICUBIC)
                img = ImageEnhance.Brightness(img).enhance(1 - 0.28 * k)
            elif op["op"] == "split":
                a, b = sources.get(op["left"]), sources.get(op["right"])
                xd = int(round(self.X(op["x"])))
                base = (b or img).copy()
                if a is not None and xd > 0:
                    base.paste(a.crop((0, 0, xd, H)), (0, 0))
                img = base
        out = img.convert("RGBA")
        for op in ops:
            kind = op["op"]
            if kind == "fill" and op["alpha"] > 0:
                out.alpha_composite(Image.new("RGBA", (W, H), _rgba(op["color"], op["alpha"])))
            elif kind == "scrim" and op["alpha"] > 0.001:
                if op["kind"] == "full":
                    out.alpha_composite(Image.new("RGBA", (W, H), _rgba(INK, 0.55 * op["alpha"])))
                else:
                    out.alpha_composite(self._bottom_scrim(op["alpha"]))
            elif kind == "split":
                xd = self.X(op["x"])
                if 0 < xd < W:
                    d = ImageDraw.Draw(out, "RGBA")
                    d.rectangle([xd - 2 * self.s, self.oy, xd - self.s, self.oy + H0 * self.s], fill=(0, 0, 0, 102))
                    d.rectangle([xd + self.s, self.oy, xd + 2 * self.s, self.oy + H0 * self.s], fill=(0, 0, 0, 102))
                    d.rectangle([xd - self.s, self.oy, xd + self.s, self.oy + H0 * self.s], fill=_rgba(PAPER, 0.8))
            elif kind in ("window", "bezel", "plate") and op["alpha"] > 0.002:
                x, y, w, h, r = self.X(op["x"]), self.Y(op["y"]), op["w"] * self.s, op["h"] * self.s, op["r"] * self.s
                if w < 2 or h < 2:
                    continue
                self._shadow(out, x, y, w, h, r, op.get("shadow", 0), op["alpha"] * (0.6 if kind == "plate" else 1))
                mask = self._rr_mask(w, h, r)
                if kind == "window":
                    src = sources.get(op["src"])
                    content = self._cover(src, mask.size) if src is not None else Image.new("RGB", mask.size, (20, 17, 24))
                    if op.get("dim", 1) < 0.999:
                        content = ImageEnhance.Brightness(content).enhance(op["dim"])
                    lay = content.convert("RGBA")
                    ImageDraw.Draw(lay, "RGBA").rounded_rectangle([0, 0, lay.size[0] - 1, lay.size[1] - 1], radius=r, outline=(255, 255, 255, 36), width=1)
                elif kind == "bezel":
                    lay = Image.new("RGBA", mask.size, _rgba(BEZEL))
                    ImageDraw.Draw(lay, "RGBA").rounded_rectangle([0, 0, lay.size[0] - 1, lay.size[1] - 1], radius=r, outline=(255, 255, 255, 26), width=1)
                else:   # glass plate
                    crop = out.crop((int(x), int(y), int(x) + mask.size[0], int(y) + mask.size[1])).convert("RGB")
                    crop = ImageEnhance.Color(crop.filter(ImageFilter.GaussianBlur(12 * self.s))).enhance(1.4)
                    lay = Image.alpha_composite(crop.convert("RGBA"), Image.new("RGBA", mask.size, _rgba("rgba(20,17,24,0.56)")))
                    ImageDraw.Draw(lay, "RGBA").rounded_rectangle([0, 0, lay.size[0] - 1, lay.size[1] - 1], radius=r, outline=(255, 255, 255, 36), width=1)
                a = mask if op["alpha"] >= 0.999 else mask.point(lambda v, al=op["alpha"]: int(v * al))
                lay.putalpha(a)
                self._paste(out, lay, x, y)
            elif kind == "ring" and op["alpha"] > 0.002:
                s = op["scale"]
                cx, cy = self.X(op["x"] + op["w"] / 2), self.Y(op["y"] + op["h"] / 2)
                w, h, r = op["w"] * self.s * s, op["h"] * self.s * s, op["r"] * self.s * s
                ss = 2
                pad = int(10 * self.s) + 2
                lay = Image.new("RGBA", (int((w + 2 * pad) * ss), int((h + 2 * pad) * ss)), (0, 0, 0, 0))
                d = ImageDraw.Draw(lay, "RGBA")
                rgb = _rgba(op.get("color", BLUE))[:3]
                d.rounded_rectangle([(pad - 8 * self.s) * ss, (pad - 8 * self.s) * ss, (pad + w + 8 * self.s) * ss, (pad + h + 8 * self.s) * ss],
                                    radius=(r + 8 * self.s) * ss, outline=rgb + (46,), width=int(round(8 * self.s * ss)))
                d.rounded_rectangle([pad * ss, pad * ss, (pad + w) * ss, (pad + h) * ss], radius=r * ss, outline=rgb + (255,),
                                    width=max(1, int(round(3 * self.s * ss))))
                lay = lay.resize((int(lay.size[0] / ss), int(lay.size[1] / ss)), Image.LANCZOS)
                lay.putalpha(lay.getchannel("A").point(lambda v, al=op["alpha"]: int(v * al)))
                self._paste(out, lay, cx - w / 2 - pad, cy - h / 2 - pad)
            elif kind == "chip" and op["alpha"] > 0.002:
                self._chip(out, op)
            elif kind == "text" and op["alpha"] > 0.002:
                layer, x0, y0 = self._text_layer(op)
                if op.get("clip"):
                    c0, c1 = self.Y(op["clip"][0]) - y0, self.Y(op["clip"][1]) - y0
                    m = Image.new("L", layer.size, 0)
                    ImageDraw.Draw(m).rectangle([0, max(0, c0), layer.size[0], min(layer.size[1], c1)], fill=255)
                    from PIL import ImageChops
                    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), m))
                self._paste(out, layer, x0, y0)
            elif kind == "logo" and op["alpha"] > 0.002:
                lg = self.logo()
                if lg is not None:
                    w = op["w"] * self.s
                    h = w * lg.size[1] / lg.size[0]
                    lay = lg.resize((max(1, int(round(w))), max(1, int(round(h)))), Image.LANCZOS)
                    if op["alpha"] < 0.999:
                        lay.putalpha(lay.getchannel("A").point(lambda v, al=op["alpha"]: int(v * al)))
                    self._paste(out, lay, self.X(op["cx"]) - w / 2, self.Y(op["y"]))
            elif kind == "cursor" and op["alpha"] > 0.002:
                self._cursor(out, op)
        return out.convert("RGB")

    @staticmethod
    def _cover(src, size):
        from PIL import Image
        w, h = size
        sw, sh = src.size
        k = max(w / sw, h / sh)
        cw, ch = w / k, h / k
        cw, ch = min(cw, sw), min(ch, sh)
        return src.resize((w, h), Image.BICUBIC, box=(max(0.0, (sw - cw) / 2), max(0.0, (sh - ch) / 2), min(sw, (sw + cw) / 2), min(sh, (sh + ch) / 2)),
                          reducing_gap=2.0)

    def _bottom_scrim(self, alpha):
        from PIL import Image
        import numpy as np
        key = ("scrim", round(alpha, 3))
        if key in self._masks:
            return self._masks[key]
        H, W = self.H, self.W
        t = 1 - (np.arange(H, dtype=np.float32) - self.oy) / (H0 * self.s)   # 0 at the bottom of the design frame
        a = np.interp(t, [0, 0.18, 0.42, 1.0], [0.72, 0.48, 0.0, 0.0]) * alpha
        a = np.where(np.arange(H) > self.oy + H0 * self.s, 0, a)
        rgba = np.zeros((H, W, 4), np.uint8)
        rgba[..., 0], rgba[..., 1], rgba[..., 2] = 14, 13, 16
        rgba[..., 3] = (a[:, None] * 255).astype(np.uint8)
        im = Image.fromarray(rgba, "RGBA")
        self._masks[key] = im
        return im

    def _chip(self, out, op):
        from PIL import Image, ImageDraw
        t = TYPE["label"]
        size = t["size"] * self.s
        font = self.font(t["weight"], size)
        text = op["text"].upper()
        track = t["track"] * size
        width = font.getlength(text) + track * max(0, len(text) - 1)
        h = op["h"] * self.s
        w = width + 32 * self.s
        sc = op.get("scale", 1.0)
        if "cx" in op:
            x = self.X(op["cx"]) - w / 2
        elif "right" in op:
            x = self.X(op["right"]) - w
        else:
            x = self.X(op["x"])
        x = _clamp(x, self.X(96), max(self.X(96), self.X(1824) - w))
        y = self.Y(op["y"])
        lay = Image.new("RGBA", (int(w) + 2, int(h) + 2), (0, 0, 0, 0))
        if op.get("fill") == "blue":
            fill = Image.new("RGBA", lay.size, _rgba(op.get("color", BLUE)))
            tc = _rgba(ON_BLUE)
        else:
            crop = out.crop((int(x), int(y), int(x) + lay.size[0], int(y) + lay.size[1])).convert("RGB")
            from PIL import ImageFilter
            fill = Image.alpha_composite(crop.filter(ImageFilter.GaussianBlur(12 * self.s)).convert("RGBA"),
                                         Image.new("RGBA", lay.size, _rgba("rgba(20,17,24,0.56)")))
            tc = _rgba(op.get("color", PAPER))
        mask = self._rr_mask(lay.size[0], lay.size[1], h / 2)
        fill.putalpha(mask)
        lay.alpha_composite(fill)
        d = ImageDraw.Draw(lay, "RGBA")
        if op.get("fill") != "blue":
            d.rounded_rectangle([0, 0, lay.size[0] - 1, lay.size[1] - 1], radius=h / 2, outline=(255, 255, 255, 36), width=1)
        xx = 16 * self.s
        for i, ch in enumerate(text):
            d.text((xx + font.getlength(text[:i]) + i * track, h / 2 + 1), ch, font=font, fill=tc, anchor="lm")
        if sc != 1.0:
            lay = lay.resize((max(1, int(lay.size[0] * sc)), max(1, int(lay.size[1] * sc))), Image.LANCZOS)
        if op["alpha"] < 0.999:
            lay.putalpha(lay.getchannel("A").point(lambda v, al=op["alpha"]: int(v * al)))
        self._paste(out, lay, x + w / 2 - lay.size[0] / 2, y + h / 2 - lay.size[1] / 2)

    def _cursor(self, out, op):
        from PIL import Image, ImageDraw
        s = self.s * op.get("scale", 1.0)
        ss = 3
        pts = [(0, 0), (0, 22), (5.6, 16.8), (9.2, 25.4), (12.6, 24), (9, 15.6), (16, 15.6)]
        x, y = self.X(op["x"]), self.Y(op["y"])
        if op.get("ripple"):
            r, a = op["ripple"]
            r *= self.s
            lay = Image.new("RGBA", (int(4 * r + 8) * ss, int(4 * r + 8) * ss), (0, 0, 0, 0))
            c = lay.size[0] / 2
            ImageDraw.Draw(lay).ellipse([c - r * ss, c - r * ss, c + r * ss, c + r * ss], outline=_rgba(BLUE_HI, a), width=int(2 * self.s * ss))
            lay = lay.resize((lay.size[0] // ss, lay.size[1] // ss), Image.LANCZOS)
            self._paste(out, lay, x - lay.size[0] / 2, y - lay.size[1] / 2)
        pad = 4
        lay = Image.new("RGBA", (int((18 + 2 * pad) * s * ss) + 1, int((28 + 2 * pad) * s * ss) + 1), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        poly = [((px + pad) * s * ss, (py + pad) * s * ss) for px, py in pts]
        sh = [(px + 1.5 * s * ss, py + 3 * s * ss) for px, py in poly]
        d.polygon(sh, fill=(0, 0, 0, 70))
        d.polygon(poly, fill=_rgba(PAPER), outline=_rgba(INK), width=max(1, int(1.5 * s * ss)))
        lay = lay.resize((max(1, lay.size[0] // ss), max(1, lay.size[1] // ss)), Image.LANCZOS)
        if op["alpha"] < 0.999:
            lay.putalpha(lay.getchannel("A").point(lambda v, al=op["alpha"]: int(v * al)))
        self._paste(out, lay, x - pad * s, y - pad * s)


# ---------------------------------------------------------------------------------------------- motion blur

def _travel(a, b):
    """The largest on-screen move between two op lists, in 1080p px (a scale change counts at the element's edge).
    inf when the ops differ in kind (something appears or goes)."""
    if len(a) != len(b) or any(p["op"] != q["op"] for p, q in zip(a, b)):
        return math.inf
    d = 0.0
    for p, q in zip(a, b):
        for k in ("x", "y", "cx", "cy"):
            if k in p and k in q:
                d = max(d, abs(p[k] - q[k]))
        for k in ("w", "h"):
            if k in p and k in q:
                d = max(d, abs(p[k] - q[k]) / 2)
        if "scale" in p and "scale" in q:
            d = max(d, abs(p["scale"] - q["scale"]) * 400)      # a slam on a ~800 px word: its edge
        if "z" in p and "z" in q:
            d = max(d, abs(q["z"] / p["z"] - 1) * 960)          # a zoom: the frame edge
    return d


def frame_ops(g, f, motion_blur=True):
    """[(weight, ops)] for local frame f. Where something moves more than 4 px (or scales over 2 %) in the frame,
    it is averaged over a 180-degree shutter (§8.6): 4 sub-frames at t + {0, 1/8, 2/8, 3/8}, more for fast moves so
    no sub-frame step exceeds about 3 px (a split's divider sweeping 80 px a frame gets 14, not 4 ghost lines)."""
    ops = state_at(g, f)
    if not motion_blur:
        return [(1.0, ops)]
    d = _travel(ops, state_at(g, f + 1))
    if d <= 4:
        return [(1.0, ops)]
    n = 4 if not math.isfinite(d) else int(_clamp(math.ceil(d / 2 / 3), 4, 16))
    return [(1.0 / n, state_at(g, f + k / (2 * n))) for k in range(n)]


# ---------------------------------------------------------------------------------------------- the render pass

class _Reader:
    """Raw RGB frames of a source (video or still) cover-fit to W x H, from a start frame, one per call."""

    def __init__(self, ffmpeg, path, kind, start, rate, W, H, frames):
        self.W, self.H, self.kind, self.proc, self.img, self.last = W, H, kind, None, None, None
        from PIL import Image
        if kind == "image":
            im = Image.open(path).convert("RGB")
            self.img = GfxPainter._cover(im, (W, H))
        elif kind == "video":
            fit = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"
            vf = (f"trim=start={start / rate:.6f},setpts=PTS-STARTPTS,fps={rate:.6f},{fit},"
                  f"tpad=stop_mode=clone:stop_duration={frames / rate + 1:.3f},format=rgb24")
            self.proc = subprocess.Popen([ffmpeg, "-v", "error", "-i", path, "-vf", vf, "-frames:v", str(frames + 2), "-f", "rawvideo", "-"],
                                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def next(self):
        from PIL import Image
        if self.img is not None:
            return self.img
        if self.proc is not None:
            buf = self.proc.stdout.read(self.W * self.H * 3)
            if len(buf) == self.W * self.H * 3:
                self.last = Image.frombytes("RGB", (self.W, self.H), buf)
        return self.last

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdout.close()
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass


def _slate(W, H, name):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new("RGB", (W, H), (33, 25, 39))
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype(os.path.join(FONT_DIR, "space-grotesk-500.woff2"), max(12, H // 18))
    except OSError:
        f = ImageFont.load_default()
    d.text((W / 2, H / 2), f"{name} · not rendered", font=f, fill=(150, 150, 160), anchor="mm")
    return im


def render_graphics(ffmpeg, base_path, graphics, out_path, W, H, rate, frames, media_for, motion_blur=True):
    """Composite every graphic over base_path (the cut's picture) into out_path (FFV1, lossless).
    media_for(src_dict) -> (kind, path, label). Returns {"frames", "graphics", "raqm", "subframes"}."""
    if not graphics:
        raise ValueError("no graphics")
    painter = GfxPainter(W, H)
    dec = subprocess.Popen([ffmpeg, "-v", "error", "-i", base_path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", f"{rate:.6f}",
                            "-i", "-", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "yuv444p", out_path],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    from PIL import Image
    import numpy as np
    readers: dict = {}
    subframes = 0
    n_bytes = W * H * 3
    try:
        for f in range(frames):
            buf = dec.stdout.read(n_bytes)
            if len(buf) < n_bytes:
                buf = bytes(n_bytes) if not f else last
            last = buf
            active = [g for g in graphics if g["start_frame"] <= f < g["start_frame"] + g["frames"]]
            if not active:
                enc.stdin.write(buf)
                continue
            pic = Image.frombytes("RGB", (W, H), buf)
            for g in active:
                lf = f - g["start_frame"]
                srcs = {}
                for key in ("a", "b"):
                    s = g.get(key)
                    if not s:
                        continue
                    rk = (g["id"], key)
                    if rk not in readers:
                        kind, path, label = media_for(s)
                        still = key == "b" and g["template"] == "dual" and g["variant"] == "stack"   # a still card
                        if kind == "slate":
                            readers[rk] = _Static(_slate(W, H, label))
                        else:
                            rd = _Reader(ffmpeg, path, kind, s["in"], rate, W, H, 1 if still else g["frames"] + 2)
                            if still:
                                img = rd.next()
                                rd.close()
                                rd = _Static(img if img is not None else _slate(W, H, label))
                            readers[rk] = rd
                    srcs[key] = readers[rk].next()
                passes = frame_ops(g, lf, motion_blur)
                if len(passes) == 1:
                    pic = painter.compose(pic, passes[0][1], srcs)
                else:
                    subframes += len(passes)
                    acc = None
                    for wt, ops in passes:
                        a = np.asarray(painter.compose(pic, ops, srcs), dtype=np.float32) * wt
                        acc = a if acc is None else acc + a
                    pic = Image.fromarray(np.clip(acc + 0.5, 0, 255).astype(np.uint8), "RGB")
            enc.stdin.write(pic.tobytes())
        enc.stdin.close()
        err = enc.stderr.read().decode(errors="replace")
        if enc.wait() != 0:
            raise RuntimeError(f"graphics encode failed: {err[-600:]}")
    finally:
        for r in readers.values():
            r.close()
        try:
            dec.stdout.close()
            dec.kill()
            dec.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass
    return {"frames": frames, "graphics": len(graphics), "raqm": painter.raqm, "subframes": subframes}


class _Static:
    def __init__(self, img):
        self.img = self.last = img

    def next(self):
        return self.img

    def close(self):
        pass
