"""Fast CPU checks on a rendered take. Each check returns a list of issues:

    {"kind": "freeze", "start": 2.1, "end": 2.6, "label": "freeze 2.1–2.6 s", "detail": "..."}

    black      frames that are (nearly) black
    freeze     stretches where the picture stops moving; stutter = repeated frames inside motion
    jump       one frame that jumps or pops (a cut, a flash, a flicker) against its neighbours
    smear      stretches much softer than the take's own sharp frames (melting, heavy smear)
    face       a face whose look changes mid-shot (appearance drift), OpenCV only
    vehicle    a car that faces the wrong way: its lit lamps (red tail lights, white or amber headlights) show the
               other end to the camera than its keyed path says (it reads as driving backwards).
               Needs the stage scene (the keyed path and heading of every vehicle) and OpenCV.

The thresholds were set on the Soundstage takes on the pod (docs in share/Milestone16_TakeChecks/REPORT.txt) and on
synthetic clips (tests/test_takecheck.py). numpy only, except face and vehicle (cv2 when installed).
"""
from __future__ import annotations

import glob
import math
import os
import re
from functools import lru_cache
from pathlib import Path

import numpy as np

# ----------------------------------------------------------------------------------------------- helpers


def _fmt(t: float) -> str:
    return f"{t:.1f}"


def _span_label(word: str, a: float, b: float) -> str:
    return f"{word} {_fmt(a)} s" if b - a < 0.15 else f"{word} {_fmt(a)}–{_fmt(b)} s"


def runs(mask, min_len: int = 1) -> list[tuple[int, int]]:
    """[(first, last)] index runs where mask is true, at least min_len long."""
    out, start = [], None
    m = list(bool(x) for x in mask)
    for i, v in enumerate(m + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i - 1))
            start = None
    return out


def _merge(spans: list[tuple[int, int]], gap: int) -> list[tuple[int, int]]:
    out = []
    for a, b in sorted(spans):
        if out and a - out[-1][1] <= gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def signals(gray: np.ndarray, grid: int = 8) -> dict:
    """Per-frame signals from small grey frames [N,H,W] uint8: mean luma, 99th percentile, the mean absolute
    difference to the previous frame (diff[0] = nan), and `local`: the 90th percentile of that difference over a
    grid of blocks, so a small subject moving in a still wide shot still counts as motion."""
    g = gray.astype(np.float32) / 255.0
    n = g.shape[0]
    mean = g.reshape(n, -1).mean(1)
    p99 = np.percentile(g.reshape(n, -1), 99, axis=1) if n else np.zeros(0)
    diff = np.full(n, np.nan, dtype=np.float32)
    local = np.full(n, np.nan, dtype=np.float32)
    if n > 1:
        d = np.abs(g[1:] - g[:-1])
        diff[1:] = d.reshape(n - 1, -1).mean(1)
        H, W = d.shape[1] // grid * grid, d.shape[2] // grid * grid
        if H and W:
            blocks = d[:, :H, :W].reshape(n - 1, grid, H // grid, grid, W // grid).mean((2, 4)).reshape(n - 1, -1)
            local[1:] = np.percentile(blocks, 90, axis=1)
        else:
            local[1:] = diff[1:]
    return {"mean": mean, "p99": p99, "diff": diff, "local": local}


def stage_moving(scene: dict, n: int) -> np.ndarray | None:
    """For each of the take's n frames: does anything move on the stage there (the camera or any actor)?
    A take that holds still where the stage holds still is not frozen. None without a scene."""
    if not isinstance(scene, dict):
        return None
    try:
        from ..look import scene as S
        frames, _ = S.frame_range(scene)
        last = max(1, frames - 1)
        cams = [S.camera_at(scene, f) for f in range(frames)]
        acts = [a for a in scene.get("actors") or [] if len(a.get("keys") or []) > 1 or a.get("position_end")]
        mv = np.zeros(frames, dtype=bool)
        for f in range(1, frames):
            c0, c1 = cams[f - 1], cams[f]
            dc = max(math.dist(c0["position"], c1["position"]), math.dist(c0["target"], c1["target"]) * 0.2,
                     abs(c0["focal_mm"] - c1["focal_mm"]) * 0.01)
            if dc > 0.002:
                mv[f] = True
                continue
            for a in acts:
                if math.dist(S._pos_at(a, f - 1, last), S._pos_at(a, f, last)) > 0.003:
                    mv[f] = True
                    break
        idx = np.round(np.arange(n) * last / max(1, n - 1)).astype(int)
        return mv[np.clip(idx, 0, frames - 1)]
    except Exception:  # noqa: BLE001 - an odd scene never stops the checks
        return None


def sharpness(gray: np.ndarray) -> np.ndarray:
    """Variance of the Laplacian per frame (grey [N,H,W] uint8): high = crisp detail, low = soft/smeared."""
    g = gray.astype(np.float32) / 255.0
    lap = g[:, 1:-1, 2:] + g[:, 1:-1, :-2] + g[:, 2:, 1:-1] + g[:, :-2, 1:-1] - 4 * g[:, 1:-1, 1:-1]
    return lap.reshape(lap.shape[0], -1).var(1)


# ----------------------------------------------------------------------------------------------- black

def black(sig: dict, fps: float, mean_max: float = 0.035, p99_max: float = 0.12) -> list[dict]:
    m = (sig["mean"] < mean_max) & (sig["p99"] < p99_max)
    out = []
    for a, b in runs(m, 1):
        t0, t1 = a / fps, (b + 1) / fps
        out.append({"kind": "black", "start": round(t0, 2), "end": round(t1, 2), "frames": b - a + 1,
                    "label": _span_label("black", t0, t1)})
    return out


# ----------------------------------------------------------------------------------------------- freeze / stutter

def freeze(sig: dict, fps: float, still: float = 0.0035, min_s: float = 0.3, stage: np.ndarray | None = None) -> list[dict]:
    """A frozen stretch: nothing anywhere in the picture changes (the busiest blocks included) for at least min_s,
    while the rest of the take moves and the stage itself is moving there (a held end of a move is not a freeze).
    Stutter: frames repeated inside motion (a duplicate between two moving frames), 3+ within a second."""
    d = np.nan_to_num(sig["diff"], nan=np.inf)
    loc = np.nan_to_num(sig.get("local", sig["diff"]), nan=np.inf)
    n = len(d)
    if n < 3:
        return []
    moving = loc[np.isfinite(loc)]
    med = float(np.median(moving)) if moving.size else 0.0
    out = []
    # A take that hardly moves at all (a locked-off still life) is not "frozen": only stretches against motion.
    if med > still * 1.5:
        thr = max(still, 0.08 * med)
        frozen = loc < thr
        for a, b in runs(frozen, max(2, int(round(min_s * fps)) - 1)):
            if stage is not None and len(stage) == n and stage[a:b + 1].mean() < 0.5:
                continue                      # the stage holds still here too: a held frame, not a freeze
            # diff[i] compares frame i with i-1: the freeze starts on frame a-1 and holds to frame b.
            t0, t1 = (a - 1) / fps, (b + 1) / fps
            out.append({"kind": "freeze", "start": round(t0, 2), "end": round(t1, 2), "frames": b - a + 2,
                        "label": _span_label("freeze", t0, t1)})
    # Stutter: isolated near-duplicates (diff tiny) whose neighbours both move.
    dup = []
    for i in range(1, n - 1):
        loc = d[max(1, i - 6): i + 7]
        loc = loc[np.isfinite(loc)]
        lm = float(np.median(loc)) if loc.size else 0.0
        if lm > still * 2 and d[i] < 0.2 * lm and d[i - 1] > 0.5 * lm and d[i + 1] > 0.5 * lm:
            dup.append(i)
    if len(dup) >= 3:
        win = int(round(fps))
        spans = []
        for i in dup:
            near = [j for j in dup if abs(j - i) <= win]
            if len(near) >= 3:
                spans.append((min(near), max(near)))
        for a, b in _merge(spans, win // 2):
            t0, t1 = a / fps, (b + 1) / fps
            k = len([j for j in dup if a <= j <= b])
            out.append({"kind": "stutter", "start": round(t0, 2), "end": round(t1, 2), "frames": k,
                        "label": _span_label("stutter", t0, t1), "detail": f"{k} repeated frames"})
    return out


# ----------------------------------------------------------------------------------------------- jumps / pops

def jumps(sig: dict, fps: float, floor: float = 0.045, ratio: float = 4.0) -> list[dict]:
    """One frame that changes far more than its neighbours: a hard cut, a jump in the picture, a flash or a flicker
    of the whole frame's brightness."""
    d = np.nan_to_num(sig["diff"], nan=0.0)
    mu = sig["mean"]
    n = len(d)
    out = []
    for i in range(1, n):
        lo, hi = max(1, i - 6), min(n, i + 7)
        loc = np.concatenate([d[lo:i], d[i + 1:hi]])
        base = float(np.median(loc)) if loc.size else 0.0
        nb = max(d[i - 1] if i > 1 else 0.0, d[i + 1] if i + 1 < n else 0.0)
        jump = d[i] > max(floor, ratio * base) and d[i] > 2.0 * nb
        dmu = abs(float(mu[i] - mu[i - 1]))
        mloc = np.abs(np.diff(mu[max(0, lo - 1):hi]))
        mbase = float(np.median(mloc)) if mloc.size else 0.0
        flash = dmu > max(0.035, 6 * mbase) and not jump
        if jump or flash:
            t = i / fps
            word = "jump" if jump else "pop"
            out.append({"kind": "jump" if jump else "pop", "start": round(t, 2), "end": round(t, 2), "frame": i,
                        "label": f"{word} at {_fmt(t)} s", "detail": f"change {d[i]:.3f} vs {base:.3f} around it"})
    # A run of flagged frames is one event (a flash in and out).
    merged = []
    for e in out:
        if merged and e["frame"] - merged[-1]["frame_end"] <= 2 and e["kind"] == merged[-1]["kind"]:
            merged[-1]["frame_end"] = e["frame"]
            merged[-1]["end"] = e["end"]
            continue
        merged.append({**e, "frame_end": e["frame"]})
    for e in merged:
        e.pop("frame_end", None)
    return merged


# ----------------------------------------------------------------------------------------------- smear

def smear(sharp: np.ndarray, fps: float, rel: float = 0.38, min_s: float = 0.35) -> list[dict]:
    """Stretches far softer than the take's own crisp frames (75th percentile): melting detail, heavy smear."""
    s = np.asarray(sharp, dtype=np.float64)
    if s.size < 4:
        return []
    ref = float(np.percentile(s, 75))
    if ref <= 1e-7:
        return []
    soft = s < rel * ref
    out = []
    for a, b in runs(soft, max(2, int(round(min_s * fps)))):
        t0, t1 = a / fps, (b + 1) / fps
        worst = float(s[a:b + 1].min() / ref)
        out.append({"kind": "smear", "start": round(t0, 2), "end": round(t1, 2), "frames": b - a + 1,
                    "label": _span_label("smear", t0, t1), "detail": f"{round(100 * worst)}% of the take's sharpness"})
    return out


# ----------------------------------------------------------------------------------------------- face drift

def _cv2():
    try:
        import cv2  # noqa: F401
        return cv2
    except Exception:  # noqa: BLE001 - OpenCV is optional
        return None


def _roots() -> list[str]:
    """ComfyUI installs this process can see (this one and any extra model base paths)."""
    roots = []
    here = Path(__file__).resolve()
    for p in here.parents:
        if p.name == "custom_nodes":
            roots.append(str(p.parent))
            break
    try:
        import folder_paths
        for name in ("checkpoints", "diffusion_models"):
            for d in folder_paths.get_folder_paths(name) or []:
                r = Path(d).resolve()
                for p in r.parents:
                    if p.name == "models":
                        roots.append(str(p.parent))
                        break
    except Exception:  # noqa: BLE001 - outside ComfyUI
        pass
    env = os.environ.get("SOUNDSTAGE_YUNET")
    return list(dict.fromkeys(([env] if env else []) + roots))


@lru_cache(maxsize=1)
def yunet_path() -> str | None:
    """A YuNet face detector already on disk (models/ or a node pack's assets), or None. Never downloads."""
    env = os.environ.get("SOUNDSTAGE_YUNET")
    if env and os.path.isfile(env):
        return env
    pats = ["models/*/face_detection_yunet*.onnx", "models/face_detection_yunet*.onnx",
            "custom_nodes/*/assets/face_detection_yunet*.onnx", "custom_nodes/*/models/face_detection_yunet*.onnx",
            "custom_nodes/*/face_detection_yunet*.onnx"]
    for r in _roots():
        for p in pats:
            hits = sorted(glob.glob(os.path.join(r, p)))
            if hits:
                return hits[0]
    return None


def face_detector_name() -> str:
    cv2 = _cv2()
    if cv2 is None:
        return ""
    return "YuNet" if (yunet_path() and hasattr(cv2, "FaceDetectorYN")) else "Haar"


def _detect_faces(cv2, bgr, det):
    h, w = bgr.shape[:2]
    if det[0] == "yunet":
        d = det[1]
        d.setInputSize((w, h))
        _, faces = d.detect(bgr)
        if faces is None:
            return []
        return [(float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])) for f in faces if f[14] > 0.75]
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    found = det[1].detectMultiScale(g, scaleFactor=1.15, minNeighbors=6, minSize=(max(20, w // 40), max(20, w // 40)))
    return [(float(x), float(y), float(fw), float(fh), 0.9) for x, y, fw, fh in found]


def _iou(a, b) -> float:
    ax0, ay0, ax1, ay1 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx0, by0, bx1, by1 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0.0, min(ax1, bx1) - max(ax0, bx0)), max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    u = a[2] * a[3] + b[2] * b[3] - inter
    return inter / u if u > 0 else 0.0


def faces(rgb: np.ndarray, fps: float, every: int = 2, sim_min: float = 0.55, min_s: float = 0.3) -> tuple[list[dict], dict]:
    """Track the biggest face and compare its crop (HOG of a 64x64 equalised crop) with the face as it first
    appeared. An appearance check, not identity recognition: a sudden lasting change of the face is flagged.
    rgb: [N,H,W,3] frames sampled every `every` source frames."""
    cv2 = _cv2()
    info = {"detector": "", "faces_seen": 0}
    if cv2 is None or rgb.shape[0] < 3:
        return [], info
    if yunet_path() and hasattr(cv2, "FaceDetectorYN"):
        det = ("yunet", cv2.FaceDetectorYN.create(yunet_path(), "", (320, 320), 0.75, 0.3, 50))
        info["detector"] = "YuNet"
    else:
        det = ("haar", cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")))
        info["detector"] = "Haar"
    hog = cv2.HOGDescriptor((64, 64), (16, 16), (8, 8), (8, 8), 9)
    track, prev, last_seen = [], None, -99
    H, W = rgb.shape[1:3]
    for i in range(rgb.shape[0]):
        bgr = np.ascontiguousarray(rgb[i][..., ::-1])
        found = _detect_faces(cv2, bgr, det)
        pick = None
        if found:
            if prev is not None:
                cand = [f for f in found if _iou(f, prev) > 0.15]
                pick = max(cand, key=lambda f: f[2] * f[3]) if cand else None
            if pick is None and prev is None:
                pick = max(found, key=lambda f: f[2] * f[3])
        if pick is None or pick[2] < 24:
            track.append(None)
            if prev is not None and i - last_seen > 6:
                prev = None           # lost it for a while: pick up the biggest face again
            continue
        x, y, fw, fh = pick[:4]
        mx, my = fw * 0.1, fh * 0.1
        x0, y0 = int(max(0, x - mx)), int(max(0, y - my))
        x1, y1 = int(min(W, x + fw + mx)), int(min(H, y + fh + my))
        crop = cv2.cvtColor(np.ascontiguousarray(rgb[i, y0:y1, x0:x1]), cv2.COLOR_RGB2GRAY)
        if crop.size == 0:
            track.append(None)
            continue
        crop = cv2.equalizeHist(cv2.resize(crop, (64, 64), interpolation=cv2.INTER_AREA))
        v = hog.compute(crop).ravel().astype(np.float32)
        v /= (np.linalg.norm(v) + 1e-6)
        track.append({"i": i, "box": pick[:4], "v": v})
        prev, last_seen = pick, i
    seen = [t for t in track if t]
    info["faces_seen"] = len(seen)
    if len(seen) < 6:
        return [], info
    ref = np.mean([t["v"] for t in seen[:3]], 0)
    ref /= (np.linalg.norm(ref) + 1e-6)
    sims = np.array([float(np.dot(t["v"], ref)) if t else np.nan for t in track])
    info["similarity_min"] = round(float(np.nanmin(sims)), 3)
    info["similarity_median"] = round(float(np.nanmedian(sims)), 3)
    head = sims[: max(6, len(sims) // 4)]
    base = float(np.nanmedian(head)) if np.isfinite(head).any() else float(np.nanmedian(sims))
    low = np.nan_to_num(sims, nan=1.0) < min(sim_min, base - 0.2)
    out = []
    for a, b in runs(low, max(2, int(round(min_s * fps / every)))):
        t0, t1 = a * every / fps, (b + 1) * every / fps
        out.append({"kind": "face", "start": round(t0, 2), "end": round(t1, 2),
                    "label": f"face drift at {_fmt(t0)} s", "detail": f"face similarity {np.nanmin(sims[a:b + 1]):.2f} (start {base:.2f})"})
    return out, info


# ----------------------------------------------------------------------------------------------- vehicles

_LIB = Path(__file__).resolve().parents[2] / "web" / "stage" / "library.mjs"
VEHICLE_DIMS = {  # kind -> (length, width) in metres when the library has no length
    "car": (4.5, 1.85), "truck": (7.0, 2.5), "bicycle": (1.8, 0.6), "motorcycle": (2.1, 0.8),
}


@lru_cache(maxsize=1)
def _lib_lengths() -> dict:
    out = {}
    try:
        for m in re.finditer(r"^\s*(\w+):\s*\{[^}]*rig:\s*\"vehicle\"[^}]*\}", _LIB.read_text(), re.M):
            ln = re.search(r"length:\s*([\d.]+)", m.group(0))
            out[m.group(1)] = float(ln.group(1)) if ln else None
    except OSError:
        pass
    return out


def is_road_vehicle(kind: str) -> bool:
    k = (kind or "").lower()
    lib = _lib_lengths()
    if k in ("bicycle", "boat", "sailboat", "catamaran", "jetski"):
        return False
    return k in VEHICLE_DIMS or k in lib or k.endswith("_car") or k in ("car", "truck", "van", "bus", "taxi")


def vehicle_dims(kind: str, height: float) -> tuple[float, float, float]:
    k = (kind or "").lower()
    ln = _lib_lengths().get(k) or VEHICLE_DIMS.get(k, (4.5, 1.85))[0]
    wd = VEHICLE_DIMS.get(k, (ln, max(1.6, min(2.5, ln * 0.42))))[1]
    return float(ln), float(wd), float(height)


def lamp_blobs(rgb: np.ndarray, box: tuple[int, int, int, int]) -> list[dict]:
    """Bright, compact light sources inside box (x0,y0,x1,y1) of one RGB frame: [{area, hue, sat, val, cx, cy}].
    Lamps are emissive: far brighter than what surrounds them (a morphological top-hat on the value channel)."""
    cv2 = _cv2()
    x0, y0, x1, y1 = box
    roi = np.ascontiguousarray(rgb[y0:y1, x0:x1])
    if cv2 is None or roi.size == 0 or roi.shape[0] < 8 or roi.shape[1] < 8:
        return []
    hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)
    v = hsv[..., 2]
    k = max(9, (roi.shape[1] // 12) | 1)
    th = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    lamp = ((th > 50) & (v > 170)).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(lamp)
    hue = hsv[..., 0].astype(np.float32) * 2.0
    sat = hsv[..., 1].astype(np.float32) / 255.0
    min_area = max(6, int(roi.shape[0] * roi.shape[1] * 0.00004))
    out = []
    for j in range(1, n):
        a = int(stats[j, 4])
        if a < min_area:
            continue
        m = lab == j
        ang = np.deg2rad(hue[m])
        hh = (math.degrees(math.atan2(float(np.sin(ang).mean()), float(np.cos(ang).mean()))) + 360.0) % 360.0
        out.append({"area": a, "hue": hh, "sat": float(sat[m].mean()), "val": float(np.percentile(v[m], 90)),
                    "cx": float(cent[j][0]) + x0, "cy": float(cent[j][1]) + y0, "w": int(stats[j, 2]), "h": int(stats[j, 3])})
    out.sort(key=lambda b: -b["area"])
    return out


def lamp_class(b: dict) -> str:
    """'red' (a tail light), 'head' (a white or amber headlight) or '' (anything else: blue light bars, white
    paint catching a street light, coloured signs)."""
    h, s, v = b["hue"], b["sat"], b.get("val", 255)
    if (h >= 335 or h < 22) and s > 0.22 and v >= 238:
        return "red"                          # lit tail lights burn near white in the core; red paint does not
    if s < 0.2 and v >= 248:                 # a white headlight blows out; white paint under a lamp does not
        return "head"
    if 24 <= h <= 65 and s > 0.45 and v >= 200:
        return "head"                         # amber / warm halogen
    return ""


def lamp_pair(blobs: list[dict], box: tuple[int, int, int, int], top: int = 12) -> dict | None:
    """A car's lamps come as a pair: same class, about the same size and height, side by side, a believable
    distance apart for the car's box. The best pair (biggest, nearest the box centre), or None."""
    bx0, by0, bx1, by1 = box
    bw = max(1.0, bx1 - bx0)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    best, cand = None, [b for b in blobs[:top] if lamp_class(b)]
    for i in range(len(cand)):
        for j in range(i + 1, len(cand)):
            a, b = cand[i], cand[j]
            if lamp_class(a) != lamp_class(b):
                continue
            sep = abs(a["cx"] - b["cx"])
            if not (0.3 * bw <= sep <= 0.95 * bw):
                continue                      # head and tail lights sit at the car's outer corners
            if abs(a["cy"] - b["cy"]) > 0.35 * sep:
                continue
            if max(a["area"], b["area"]) > 2.5 * min(a["area"], b["area"]):
                continue
            if abs((a["hue"] - b["hue"] + 180) % 360 - 180) > 15 and min(a["sat"], b["sat"]) > 0.2:
                continue
            mx, my = (a["cx"] + b["cx"]) / 2, (a["cy"] + b["cy"]) / 2
            bh = max(1.0, by1 - by0)          # the box spans the lamp band (0.3–1.0 m): a roof light bar sits above it
            if not (by0 - 0.2 * bh <= my <= by1 + 0.25 * bh):
                continue
            d = math.hypot((mx - cx) / bw, (my - cy) / bw)
            if d > 0.4:
                continue                      # not on this car (the take put another car's lamps there)
            score = (a["area"] + b["area"]) * math.exp(-(d / 0.45) ** 2)
            if best is None or score > best["score"]:
                best = {"cls": lamp_class(a), "score": score, "area": a["area"] + b["area"], "sep": sep,
                        "x": mx, "y": my}
    return best


def lamp_verdict(pair: dict | None, expected: str) -> str:
    """'ok' when the lamp pair facing the camera matches the way the car drives, 'reversed' when it is the
    other end's pair, '' when it can't tell. expected: 'tail' (driving away: tail lights toward us) or 'nose'."""
    if not pair or pair["area"] < 20:
        return ""
    seen = "tail" if pair["cls"] == "red" else "nose"
    return "ok" if seen == expected else "reversed"


def _vehicle_view(G, S, a: dict, sf: int, last: int, scene: dict, W: int, H: int, stage_aspect: float) -> dict | None:
    """Where vehicle `a` sits in the take's frame at stage frame sf, and which end faces the camera:
    {box (x0,y0,x1,y1 px of its 3D volume), depth, expected ('tail'|'nose'|''), moving}, or None if off screen."""
    cam = S.camera_at(scene, sf)
    p = S._pos_at(a, sf, last)
    y0, y1 = S._pos_at(a, max(0, sf - 2), last), S._pos_at(a, min(last, sf + 2), last)
    moving = math.hypot(y1[0] - y0[0], y1[2] - y0[2]) > 0.02
    # Its nose: the way it travels, or where a stunt car's keys point it (scene._yaw_at, like the stage).
    yaw = S._yaw_at(a, sf, last)
    fwd = (math.sin(yaw), 0.0, math.cos(yaw))
    to = G.flat(G.sub(p, cam["position"]))
    if G.length(to) < 1e-3:
        return None
    al = G.dot(fwd, G.norm(to))
    _, _, hgt = S.classify(a)
    ln, wd, ht = vehicle_dims(a.get("kind"), hgt)
    c, s = math.cos(yaw), math.sin(yaw)
    pts = []
    A = W / H
    with G.use_aspect(stage_aspect):
        for dx in (-wd / 2, wd / 2):
            for dz in (-ln / 2, ln / 2):
                for dy in (0.3, 1.0):
                    w = (p[0] + dx * c + dz * s, p[1] + dy * min(1.0, ht), p[2] - dx * s + dz * c)
                    q = G.project(w, cam["position"], cam["target"], cam["focal_mm"])
                    if q:
                        pts.append(q)
    if len(pts) < 8:
        return None
    xs = [((q[0] * stage_aspect / A if A < stage_aspect else q[0]) + 1) / 2 * W for q in pts]
    ys = [(1 - (q[1] * A / stage_aspect if A > stage_aspect else q[1])) / 2 * H for q in pts]
    bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
    if bx1 < 0 or bx0 > W or by1 < 0 or by0 > H or (bx1 - bx0) < W * 0.03:
        return None
    # In profile the lamps' colour alone can't say which way it goes: no expectation then.
    expected = "" if abs(al) < 0.55 else ("tail" if al > 0 else "nose")
    return {"box": (bx0, by0, bx1, by1), "depth": G.length(to), "expected": expected, "moving": moving}


def vehicle_direction(rgb: np.ndarray, src_index: list[int], scene: dict, fps: float,
                      min_frames: int = 8) -> tuple[list[dict], list[dict]]:
    """For every road vehicle on the stage: which end should face the camera at each sampled frame (from its keyed
    path / heading and the shot camera), against the lamp pair the take actually shows there.
    Lamps inside a nearer vehicle's box belong to that vehicle and are ignored; the car the camera rides is skipped.
    rgb: sampled frames [M,H,W,3]; src_index: the take frame index of each sample. Returns (issues, per-vehicle)."""
    from ..cine import geometry as G
    from ..look import scene as S

    if _cv2() is None or rgb.shape[0] == 0:
        return [], []
    frames, _ = S.frame_range(scene)
    last = max(1, frames - 1)
    n_take = max(src_index) + 1 if src_index else 1
    H, W = rgb.shape[1:3]
    stage_aspect = G.STAGE_ASPECTS.get(str((scene.get("shot") or {}).get("aspect") or "1.85"), G.STAGE_ASPECT)
    host = S.follow_host(scene) or {}
    if host and is_road_vehicle(host.get("kind")):
        # A camera in the cabin, or one looking at / through the car it rides (an in-car single through the
        # windscreen), sees other cars only through glass (glare, reflections): no verdicts.
        try:
            c0 = (S.local_camera_path(scene) or [{}])[0]
            ln, wd, _ = vehicle_dims(host.get("kind"), 1.5)
            inside = lambda q: abs(q[0]) < wd / 2 + 0.2 and abs(q[2]) < ln / 2 + 0.2  # noqa: E731
            if inside(c0.get("position") or (99, 0, 99)) and (abs(c0["position"][2]) < ln / 2 - 0.5 or inside(c0.get("target") or (99, 0, 99))):
                return [], []
        except Exception:  # noqa: BLE001
            pass
    # The car a camera rides beside (a tracking shot) is checked like any other; one it rides on (a hood mount)
    # never projects into the frame, so it never gets a verdict.
    cars = [a for a in scene.get("actors") or [] if is_road_vehicle(a.get("kind")) and not a.get("mount_id")]
    views = {}   # (actor id, sample index) -> view
    for a in cars:
        for j, ti in enumerate(src_index):
            sf = int(round(ti * last / max(1, n_take - 1)))
            v = _vehicle_view(G, S, a, sf, last, scene, W, H, stage_aspect)
            if v:
                views[(a.get("id"), j)] = v
    issues, report = [], []
    for a in cars:
        if len(a.get("keys") or []) < 2:
            continue
        votes = []
        for j, ti in enumerate(src_index):
            v = views.get((a.get("id"), j))
            if not v or not v["moving"] or not v["expected"]:
                continue
            bx0, by0, bx1, by1 = v["box"]
            if bx1 - bx0 < 0.08 * W:
                continue                      # too small in frame to read its lamps reliably
            nearer = [o["box"] for (oid, oj), o in views.items() if oj == j and oid != a.get("id") and o["depth"] < v["depth"]]
            area = (bx1 - bx0) * (by1 - by0)
            hidden = sum(max(0.0, min(bx1, x1) - max(bx0, x0)) * max(0.0, min(by1, y1) - max(by0, y0)) for x0, y0, x1, y1 in nearer)
            if hidden > 0.3 * area:
                continue                      # mostly behind a nearer car
            mw, mh = (bx1 - bx0) * 0.25, (by1 - by0) * 0.5
            box = (int(max(0, bx0 - mw)), int(max(0, by0 - mh)), int(min(W, bx1 + mw)), int(min(H, by1 + mh * 0.3)))
            blobs = lamp_blobs(rgb[j], box)
            if nearer:
                blobs = [b for b in blobs if not any(x0 <= b["cx"] <= x1 and y0 <= b["cy"] <= y1 for x0, y0, x1, y1 in nearer)]
            pair = lamp_pair(blobs, v["box"])
            verdict = lamp_verdict(pair, v["expected"])
            votes.append({"frame": ti, "t": round(ti / fps, 2), "expected": v["expected"], "verdict": verdict,
                          "lamps": pair["cls"] if pair else ""})
        if not votes:
            continue                          # never seen end-on while moving: nothing to say about it
        conclusive = [v for v in votes if v["verdict"]]
        rev = [v for v in conclusive if v["verdict"] == "reversed"]
        rec = {"id": a.get("id"), "name": a.get("name") or a.get("kind"), "kind": a.get("kind"), "sampled": len(votes),
               "conclusive": len(conclusive), "reversed": len(rev),
               "expected": max(("tail", "nose"), key=lambda e: sum(1 for v in votes if v["expected"] == e)) if votes else "",
               # per checked frame: time, the end that should face us, the lamps seen there ("red"/"head"/"")
               "frames": [[v["t"], v["expected"], v["lamps"]] for v in votes]}
        if len(conclusive) >= min_frames and len(rev) >= 0.8 * len(conclusive):
            t0, t1 = rev[0]["t"], rev[-1]["t"]
            if rec["expected"] == "tail":
                why = "on the stage it moves away from the camera, but the take shows its headlights: it reads as driving backwards"
            else:
                why = "on the stage it comes toward the camera, but the take shows its tail lights: it reads as reversing, or driving the wrong way"
            rec["verdict"] = "reversed"
            issues.append({"kind": "vehicle", "start": t0, "end": t1, "actor": a.get("id"),
                           "label": f"{rec['name']} faces the wrong way",
                           "detail": f"{why} ({len(rev)} of {len(conclusive)} checked frames)"})
        elif len(conclusive) >= min_frames and len(rev) <= 0.2 * len(conclusive):
            rec["verdict"] = "ok"
        else:
            rec["verdict"] = "inconclusive"
        report.append(rec)
    return issues, report
