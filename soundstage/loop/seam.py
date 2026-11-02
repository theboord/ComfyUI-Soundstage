"""The seam meter: how visible is the jump when a clip wraps from its last frame back to its first?

CPU only (numpy; frames come from takecheck/video.py's ffmpeg reader). Every metric is measured on every in-clip step
(frame i -> i+1) and on the wrap (last -> first). The wrap is judged against the clip's own motion, so a busy clip is
allowed a bigger step than a still one:

  pixel   mean absolute grey difference
  edges   1 - SSIM of the Sobel edge maps (structure that pops or shifts)
  motion  dense Lucas-Kanade flow: how far the picture moves in the step (% of the frame width)
  jerk    how much the flow changes from the step before to the step after (a pendulum that snaps back, a walk that
          restarts mid-stride), the thing the eye catches even when every frame matches

  ratio(metric) = wrap / median(in-clip steps);  seam = the worst of pixel, edges and jerk ratios
  Seamless      seam <= SEAMLESS (1.6x) and the wrap is inside the clip's own p95 step on every metric
  Visible seam  otherwise; also when the wrap holds still in a moving clip (a held frame reads as a hitch), or when
                a step in the last 16 frames jumps (4x the median: an end guide snapping onto its picture)

A loop render ends on (almost) its first picture. Played as is, that duplicate is a held frame, so the meter checks it
first: `dup_last` says the last frame is a copy of frame 0, and the wrap is then measured from the frame before it
(the App plays and saves the loop without it).
"""
from __future__ import annotations

import numpy as np

VERSION = 1
SEAMLESS = 1.6
WIDTH = 160            # analysis width (px)
HOLD = 0.3             # wrap motion below 0.3x the clip's median motion in a moving clip = a held frame
SNAP = 4.0              # an in-clip step 4x the median, ...
SNAP_TAIL = 16          # ... in the last 16 steps, is a snap
MOVING = 0.15          # median motion (% of width per frame) above which a clip counts as moving


# ------------------------------------------------------------------ small image maths

def _f(a) -> np.ndarray:
    a = np.asarray(a, np.float32)
    return a / 255.0 if a.max(initial=0) > 1.5 else a


def box(a: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window, edge-padded (integral image)."""
    if r <= 0:
        return a
    p = np.pad(a, r + 1, mode="edge").astype(np.float64)
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return (s / (k * k))[: a.shape[0], : a.shape[1]].astype(np.float32)


def sobel(a: np.ndarray) -> np.ndarray:
    p = np.pad(a, 1, mode="edge")
    gx = (p[1:-1, 2:] - p[1:-1, :-2]) * 2 + (p[:-2, 2:] - p[:-2, :-2]) + (p[2:, 2:] - p[2:, :-2])
    gy = (p[2:, 1:-1] - p[:-2, 1:-1]) * 2 + (p[2:, :-2] - p[:-2, :-2]) + (p[2:, 2:] - p[:-2, 2:])
    return np.sqrt(gx * gx + gy * gy) / 8.0


def ssim(a: np.ndarray, b: np.ndarray, r: int = 3) -> float:
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    ma, mb = box(a, r), box(b, r)
    va, vb = box(a * a, r) - ma * ma, box(b * b, r) - mb * mb
    cov = box(a * b, r) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(np.clip(s, -1, 1).mean())


def _down(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    a = a[:h, :w]
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def _warp(a: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Sample a at (x+u, y+v), bilinear, clamped."""
    h, w = a.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    x = np.clip(xs + u, 0, w - 1.001)
    y = np.clip(ys + v, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy) +
            a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)


def flow(a: np.ndarray, b: np.ndarray, levels: int = 3, r: int = 4, iters: int = 2) -> tuple[np.ndarray, np.ndarray]:
    """Dense pyramidal Lucas-Kanade flow a -> b (u, v in px at a's size). Textureless pixels get 0."""
    pa, pb = [a], [b]
    for _ in range(levels - 1):
        if min(pa[-1].shape) < 24:
            break
        pa.append(_down(pa[-1]))
        pb.append(_down(pb[-1]))
    u = np.zeros_like(pa[-1])
    v = np.zeros_like(pa[-1])
    for lv in range(len(pa) - 1, -1, -1):
        A, B = pa[lv], pb[lv]
        if u.shape != A.shape:
            u = 2 * np.kron(u, np.ones((2, 2), np.float32))[: A.shape[0], : A.shape[1]]
            v = 2 * np.kron(v, np.ones((2, 2), np.float32))[: A.shape[0], : A.shape[1]]
            u = np.pad(u, ((0, A.shape[0] - u.shape[0]), (0, A.shape[1] - u.shape[1])), mode="edge")
            v = np.pad(v, ((0, A.shape[0] - v.shape[0]), (0, A.shape[1] - v.shape[1])), mode="edge")
        p = np.pad(A, 1, mode="edge")
        ix = (p[1:-1, 2:] - p[1:-1, :-2]) * 0.5
        iy = (p[2:, 1:-1] - p[:-2, 1:-1]) * 0.5
        sxx, syy, sxy = box(ix * ix, r), box(iy * iy, r), box(ix * iy, r)
        det = sxx * syy - sxy * sxy
        tr = sxx + syy
        lam = 0.5 * (tr - np.sqrt(np.maximum(tr * tr - 4 * det, 0)))
        ok = lam > 1e-5
        for _ in range(iters):
            it = _warp(B, u, v) - A
            sxt, syt = box(ix * it, r), box(iy * it, r)
            with np.errstate(divide="ignore", invalid="ignore"):
                du = np.where(ok, (-syy * sxt + sxy * syt) / det, 0)
                dv = np.where(ok, (sxy * sxt - sxx * syt) / det, 0)
            u = np.clip(u + np.nan_to_num(du), -40, 40)
            v = np.clip(v + np.nan_to_num(dv), -40, 40)
    return u.astype(np.float32), v.astype(np.float32)


# ------------------------------------------------------------------ the meter

def step(a: np.ndarray, b: np.ndarray, with_flow: bool = True) -> dict:
    """The metrics of one step a -> b (grey float frames)."""
    out = {"pixel": float(np.abs(a - b).mean()), "edges": float(1.0 - ssim(sobel(a), sobel(b)))}
    if with_flow:
        u, v = flow(a, b)
        out["motion"] = float(np.median(np.hypot(u, v)) * 100.0 / a.shape[1])
        out["_flow"] = (u, v)
    return out


def _jerk(f1, f2) -> float:
    """How much the flow field changes between two consecutive steps (% of width)."""
    (u1, v1), (u2, v2) = f1, f2
    return float(np.median(np.hypot(u2 - u1, v2 - v1)) * 100.0 / u1.shape[1])


def prepare(frames) -> list[np.ndarray]:
    """[N,H,W] or [N,H,W,3] uint8/float -> grey float frames about WIDTH px wide."""
    arr = np.asarray(frames)
    if arr.ndim == 4:
        arr = arr[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    arr = _f(arr)
    k = max(1, int(round(arr.shape[2] / WIDTH)))
    if k > 1:
        h, w = arr.shape[1] // k * k, arr.shape[2] // k * k
        arr = arr[:, :h, :w].reshape(arr.shape[0], h // k, k, w // k, k).mean((2, 4))
    return [a.astype(np.float32) for a in arr]


def is_duplicate(a: np.ndarray, b: np.ndarray, median_pixel: float) -> bool:
    """b is a copy of a (the loop's last frame landing on its first picture)."""
    d = float(np.abs(a - b).mean())
    return d < max(0.0005, 0.35 * median_pixel)


def measure(frames, *, drop_duplicate: bool = True) -> dict:
    """Score the wrap of a clip. frames: [N,H,W(,3)]. Returns the report the App badges (see the module doc)."""
    fr = prepare(frames)
    n = len(fr)
    if n < 4:
        raise ValueError("a loop needs at least 4 frames")
    steps = [step(fr[i], fr[i + 1]) for i in range(n - 1)]
    med_pix = float(np.median([s["pixel"] for s in steps]))
    end = n - 1
    dup = bool(drop_duplicate and is_duplicate(fr[0], fr[-1], med_pix))
    if dup:
        end = n - 2
        steps = steps[:-1]
    wrap = step(fr[end], fr[0])
    # jerk: flow change across each pair of consecutive steps, and across the wrap (step into it, step out of it)
    jerks = [_jerk(steps[i]["_flow"], steps[i + 1]["_flow"]) for i in range(len(steps) - 1)]
    wrap_jerk = 0.5 * (_jerk(steps[-1]["_flow"], wrap["_flow"]) + _jerk(wrap["_flow"], steps[0]["_flow"]))
    report = {"version": VERSION, "frames": n, "played": end + 1, "dup_last": dup, "metrics": {}}
    worst, outside = 0.0, []
    for k, w_val, series in (("pixel", wrap["pixel"], [s["pixel"] for s in steps]),
                             ("edges", wrap["edges"], [s["edges"] for s in steps]),
                             ("motion", wrap["motion"], [s["motion"] for s in steps]),
                             ("jerk", wrap_jerk, jerks or [0.0])):
        med = float(np.median(series))
        p95 = float(np.percentile(series, 95))
        floor = {"pixel": 0.002, "edges": 0.002, "motion": 0.02, "jerk": 0.02}[k]
        ratio = w_val / max(med, floor)
        report["metrics"][k] = {"wrap": round(w_val, 5), "median": round(med, 5), "p95": round(p95, 5),
                                "ratio": round(ratio, 2)}
        if k != "motion":
            worst = max(worst, ratio)
            if w_val > max(p95 * 1.1, floor * 2):
                outside.append(k)
    med_motion = report["metrics"]["motion"]["median"]
    med_pix = report["metrics"]["pixel"]["median"]
    held = (med_motion > MOVING and wrap["motion"] < HOLD * med_motion) or \
        (med_pix > 0.0015 and wrap["pixel"] < HOLD * med_pix)
    report["seam"] = round(worst, 2)
    report["held_frame"] = bool(held)
    report["outside_p95"] = outside
    # A jump inside the clip near its end (an end guide snapping the last latent block onto the picture) is a seam too.
    pix = [st["pixel"] for st in steps]
    snaps = [i for i in range(max(0, len(pix) - SNAP_TAIL), len(pix)) if pix[i] > SNAP * max(med_pix, 0.0015)]
    report["snap_at"] = snaps[-1] + 1 if snaps else None
    seamless = worst <= SEAMLESS and not outside and not held and not snaps
    report["verdict"] = "seamless" if seamless else "visible"
    report["badge"] = badge(report)
    return report


def badge(r: dict) -> str:
    if r.get("verdict") == "seamless":
        return f"Seamless · {r['seam']:.1f}x"
    if r.get("held_frame"):
        why = "held frame at the wrap"
    elif r.get("snap_at") is not None:
        why = f"jump at frame {r['snap_at']}"
    else:
        why = ", ".join(r.get("outside_p95") or []) or "jump"
    return f"Visible seam · {r['seam']:.1f}x ({why})"


def audio_wrap(samples: np.ndarray, rate: int, ms: float = 20.0) -> dict:
    """The sound at the wrap: the level of the last vs the first `ms` (dB) and the sample jump (a click)."""
    a = np.asarray(samples, np.float32)
    if a.ndim > 1:
        a = a.mean(axis=0 if a.shape[0] <= 8 else 1)
    k = max(1, int(rate * ms / 1000.0))
    if a.size < 2 * k:
        return {"level_jump_db": 0.0, "click": 0.0}
    rms = lambda x: float(np.sqrt(np.mean(x * x)) + 1e-6)  # noqa: E731
    jump = 20 * np.log10(rms(a[:k]) / rms(a[-k:]))
    typical = float(np.median(np.abs(np.diff(a)))) + 1e-6
    return {"level_jump_db": round(float(jump), 1), "click": round(float(abs(a[0] - a[-1]) / typical), 1)}


def measure_file(path: str, width: int = 256) -> dict:
    """measure() on an MP4 (ffmpeg grey frames)."""
    from ..takecheck import video as V
    info = V.probe(path)
    rep = measure(V.read_frames(path, width=width, gray=True, info=info))
    rep["fps"] = info["fps"]
    return rep
