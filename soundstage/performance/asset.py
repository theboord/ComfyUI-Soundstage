"""Performance assets: pure helpers (no ComfyUI, no torch) for the capture and the render.

A performance asset is one take of a real actor: their clip (picture + voice), the DWPose read of it (body 18 points,
hands 2x21, face 68 + 2 pupils) as a pose video, the face landmarks per frame, a mouth-open curve, and a consent record.
It lives in output/soundstage_private/performances/<id>/asset.json. Unit-tested in tests/test_performance.py.
"""
import datetime as _dt
import math
import re

CONSENT_TEXT = ("I am the performer in this clip, or the performer agreed that their performance (face, body and "
                "voice) may drive a character in this project.")
ASSET_VERSION = 1
# 68-point face (iBUG order, 0-based) as DWPose emits it, plus 2 pupils at 68/69.
INNER_LIP_TOP, INNER_LIP_BOTTOM = 62, 66
OUTER_LIP_TOP, OUTER_LIP_BOTTOM = 51, 57
NOSE_BRIDGE, CHIN = 27, 8
MOUTH_LEFT, MOUTH_RIGHT = 48, 54


class PerformanceError(ValueError):
    """User-facing: shown in the ComfyUI error dialog as is."""


def slug(s, n=32):
    return (re.sub(r"[^A-Za-z0-9_-]+", "_", str(s or "").strip()).strip("_")[:n]) or "take"


def check_consent(performer, consent):
    """Refuse a capture without a consent record (docs/audio.md: no cloning of a third party's likeness or voice)."""
    if not consent:
        raise PerformanceError("Tick the consent box first: " + CONSENT_TEXT)
    if not str(performer or "").strip():
        raise PerformanceError("Say who the performer is (your name, or the actor who agreed).")
    return {"performer": str(performer).strip()[:80], "statement": CONSENT_TEXT,
            "date": _dt.datetime.now().strftime("%Y-%m-%d %H:%M")}


def require_consent(asset):
    c = (asset or {}).get("consent") or {}
    if not c.get("performer") or not c.get("statement"):
        raise PerformanceError("This performance has no consent record, so it can't drive a shot. Capture it again "
                               "and tick the consent box.")
    return c


def _pts(flat):
    """Flat [x, y, c, x, y, c, ...] (OpenPose JSON) or [[x, y(, c)], ...] -> [(x, y, c)]."""
    if not flat:
        return []
    if isinstance(flat[0], (list, tuple)):
        return [(float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 1.0) for p in flat]
    return [(float(flat[i]), float(flat[i + 1]), float(flat[i + 2])) for i in range(0, len(flat) - 2, 3)]


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def mouth_open(face, min_conf=0.3):
    """Inner-lip gap over the nose-bridge-to-chin length (scale free: pixels or 0-1 coords). None if not seen."""
    p = _pts(face)
    if len(p) < 68:
        return None
    need = (INNER_LIP_TOP, INNER_LIP_BOTTOM, NOSE_BRIDGE, CHIN)
    if any(p[i][2] < min_conf for i in need):
        return None
    if any(p[i][0] < 0 or p[i][1] < 0 for i in need):
        return None
    face_h = _dist(p[NOSE_BRIDGE], p[CHIN])
    if face_h <= 1e-6:
        return None
    return round(_dist(p[INNER_LIP_TOP], p[INNER_LIP_BOTTOM]) / face_h, 4)


def person_points(person, min_conf=0.3):
    """Every confident body / face / hand point of one OpenPose person -> [(x, y)]."""
    out = []
    for key in ("pose_keypoints_2d", "face_keypoints_2d", "hand_left_keypoints_2d", "hand_right_keypoints_2d"):
        for x, y, c in _pts(person.get(key) or []):
            if c >= min_conf and (x > 0 or y > 0):
                out.append((x, y))
    return out


def box_of(points):
    if not points:
        return None
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def main_person(frame):
    """The performer in one DWPose frame: the person with the biggest box. -> (person, box) or (None, None)."""
    best, best_box, best_area = None, None, -1.0
    for person in (frame or {}).get("people") or []:
        b = box_of(person_points(person))
        if not b:
            continue
        area = (b[2] - b[0]) * (b[3] - b[1])
        if area > best_area:
            best, best_box, best_area = person, b, area
    return best, best_box


def normalise_box(box, w, h):
    """Pixel box -> 0-1 box. A box already in 0-1 (DWPose's normalised output) is returned as is."""
    if box is None:
        return None
    if max(box) <= 1.5:
        return [round(float(v), 4) for v in box]
    return [round(box[0] / w, 4), round(box[1] / h, 4), round(box[2] / w, 4), round(box[3] / h, 4)]


def read_keypoints(frames):
    """DWPose POSE_KEYPOINT list -> per-frame {mouth, box (0-1), face (68+2 points, 0-1)} and summary stats."""
    out = []
    for fr in frames or []:
        w, h = float(fr.get("canvas_width") or 1), float(fr.get("canvas_height") or 1)
        person, box = main_person(fr)
        face = _pts(person.get("face_keypoints_2d") or []) if person else []
        scale = (1.0, 1.0) if (face and max(max(p[0], p[1]) for p in face) <= 1.5) else (w, h)
        out.append({
            "mouth": mouth_open(face) if face else None,
            "box": normalise_box(box, w, h),
            "face": [[round(x / scale[0], 4), round(y / scale[1], 4), round(c, 3)] for x, y, c in face] if face else None,
        })
    seen = sum(1 for f in out if f["face"] and f["mouth"] is not None)
    return {"frames": out, "face_seen": round(seen / max(1, len(out)), 3)}


def union_box(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def fit_transform(src, dst, mode="height"):
    """The uniform scale + offset (all in 0-1 frame units) that puts the actor's box `src` on the character's box `dst`:
    same height (or width), same centre x, same top. -> (scale, dx, dy) with x' = x * scale + dx."""
    sw, sh = max(1e-6, src[2] - src[0]), max(1e-6, src[3] - src[1])
    dw, dh = max(1e-6, dst[2] - dst[0]), max(1e-6, dst[3] - dst[1])
    s = dw / sw if mode == "width" else dh / sh
    dx = (dst[0] + dst[2]) / 2 - (src[0] + src[2]) / 2 * s
    dy = dst[1] - src[1] * s
    return s, dx, dy


def parse_box(text):
    """'{"box":[x0,y0,x1,y1]}' or '[x0,y0,x1,y1]' (0-1 frame units) -> list, or None for empty / bad input."""
    import json
    if not str(text or "").strip():
        return None
    try:
        v = json.loads(text)
    except ValueError:
        return None
    if isinstance(v, dict):
        v = v.get("box")
    if isinstance(v, list) and len(v) == 4 and all(isinstance(x, (int, float)) for x in v) and v[2] > v[0] and v[3] > v[1]:
        return [float(x) for x in v]
    return None


def onsets(curve, fps, open_at=0.45, shut_at=0.25, gap_s=0.12):
    """Mouth-opening onsets (seconds), for comparing syllable timing between the actor and the result. Hysteresis on
    the curve's own range (10th-90th percentile): an onset is a rise through `open_at` of the range after the mouth
    went below `shut_at`, at least `gap_s` after the previous one."""
    vals = sorted(v for v in curve if v is not None)
    if len(vals) < 2:
        return []
    lo, hi = vals[int(0.1 * (len(vals) - 1))], vals[int(0.9 * (len(vals) - 1))]
    if hi - lo < 0.01:
        return []
    up, down = lo + open_at * (hi - lo), lo + shut_at * (hi - lo)
    out, last, armed = [], -1e9, False
    for i, v in enumerate(curve):
        if v is None:
            continue
        if v < down:
            armed = True
        elif armed and v > up and (i / fps - last) >= gap_s:
            out.append(round(i / fps, 3))
            last, armed = i / fps, False
    return out


def asset_record(*, aid, name, consent, source, fps, frames, width, height, has_audio, files, keypoints, character=""):
    kp = keypoints or {"frames": [], "face_seen": 0.0}
    mouth = [f["mouth"] for f in kp["frames"]]
    return {
        "version": ASSET_VERSION, "kind": "soundstage_performance", "id": aid, "name": name, "character": character,
        "consent": consent, "source": source, "fps": fps, "frames": frames, "width": width, "height": height,
        "seconds": round(frames / max(1e-6, fps), 3), "has_audio": bool(has_audio), "files": files,
        "face_seen": kp["face_seen"], "mouth": mouth, "onsets": onsets(mouth, fps),
        "box": union_box([f["box"] for f in kp["frames"][:12]]),
        "created": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
