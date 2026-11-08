"""Video → Stage, the words: what the rebuilt set says to the image and video models.

- look_hint(scene): the Look text the App pre-fills for a clip rebuilt with Video → 3D (who, what they wear, the set
  pieces by their kind words, the light the sky was measured as). scene.video2stage.look_hint.
- triage_blocks(...): the clay set blocks in front of the set scan. A block LTX sees in the depth guide with no word
  for it becomes whatever LTX likes (pillars, on the street-dance clip): each kept block gets its kind word, and a
  block the scan already shows at that place is dropped.
- from_read(read): scene words from a vision read alone (Reshoot of a stock clip has no recipe prompt to reuse).
"""
from __future__ import annotations

import math
import re

import numpy as np

from . import wardrobe as W

# Set-piece names -> the plain kind word the prompt uses. A block whose name has none of these keeps its own name.
KIND_WORDS = [(("ground", "floor", "kerb", "curb"), ""), (("tree", "trees", "forest"), "trees"), (("rock", "rocks", "boulder", "boulders"), "rocks"),
              (("shrub", "shrubs", "bush", "bushes", "hedge"), "shrubs"), (("building", "facade", "house", "block"), "a building"),
              (("wall",), "a low wall"), (("guardrail", "railing", "rail"), "a guardrail"), (("lamp", "streetlight"), "a street lamp"),
              (("bench",), "a bench"), (("table",), "a table"), (("chair",), "a chair"), (("sidewalk", "pavement"), "a sidewalk"),
              (("plaza", "square"), "a paved plaza"), (("grass", "lawn"), "grass"), (("road", "street"), "a road"),
              (("slab", "concrete"), "a concrete slab"), (("slope", "bank", "hill", "hills"), "a slope"),
              (("cliff",), "a cliff"), (("mountain", "mountains"), "mountains"), (("ocean", "sea", "lake", "river", "water"), "water"),
              (("beach", "sand"), "a beach"), (("sign",), "a sign"), (("pole",), "a pole"), (("fence",), "a fence")]
SKIP = re.compile(r"^(set scan|ground beyond|terrain|stage)\b", re.I)
LIGHT = {"overcast": "Soft overcast daylight under a grey sky", "clear": "Natural daylight under a clear blue sky",
         "warm": "Warm low sun", "dark": "Night"}


def kind_word(name: str) -> str:
    words = set(re.findall(r"[a-z]+", str(name or "").lower()))
    for keys, w in KIND_WORDS:
        if words & set(keys):
            return w
    base = re.sub(r"\s*\((left|right|off-camera)\)", "", str(name or "")).strip().lower()
    return base


def subject(actor: dict | None) -> str:
    """'a woman in a short-sleeve yellow plaid shirt and light jeans' (the model's own words when the garments are
    unknown: 'a woman in yellow plaid outfit')."""
    if not actor:
        return ""
    src = actor.get("source") or {}
    ap = actor.get("appearance") or {}
    noun = {"woman": "woman", "man": "man", "child": "child"}.get(actor.get("kind"), "person")
    wear = W.words(ap, src.get("wardrobe") or "")
    if wear:
        return f"a {noun} in {wear}"
    label = str(src.get("label") or actor.get("label") or "").strip()
    if label:
        return label if re.match(r"^(a|an|the)\b", label, re.I) else f"a {label}"
    return f"a {noun}"


def set_words(scene: dict, limit: int = 6) -> list[str]:
    """The set's kind words, nearest-first-ish (the order of the actors), without the scan pieces or the terrain."""
    out = []
    for a in scene.get("actors") or []:
        if not (a.get("set_piece") or a.get("structure") or a.get("procedural")) or a.get("scan"):
            continue
        if a.get("procedural") or "(off-camera)" in str(a.get("name") or ""):
            continue   # never in the picture
        nm = str(a.get("name") or a.get("kind") or "")
        if SKIP.match(nm) or a.get("in_view") is False:
            continue   # the scan pieces, the terrain, and blocks the triage found the camera never sees
        w = a.get("prompt_word") if a.get("prompt_word") is not None else kind_word(nm)
        if w and w not in out:
            out.append(w)
    return out[:limit]


def light_words(scene: dict) -> str:
    wx = (scene.get("video2stage") or {}).get("weather") or {}
    return LIGHT.get(wx.get("sky"), "Natural daylight")


def look_hint(scene: dict) -> str:
    actors = scene.get("actors") or []
    who = next((a for a in actors if a.get("mocap")), None) or \
        next((a for a in actors if a.get("kind") in ("man", "woman", "child")), None)
    subj = subject(who)
    pieces = set_words(scene)
    if not subj and not pieces:
        return ""
    head = (subj[0].upper() + subj[1:] + ", full body,") if subj else "The location"
    where = f" on location: {', '.join(pieces)}" if pieces else " on location"
    return f"{head}{where}. {light_words(scene)}, real photograph, shot on a cinema camera."


def from_read(read: dict | None) -> str:
    """Scene words from a vision read (the 4B breakdown or the 8B inventory): who and what they wear, where, the set,
    the sky. '' when the read is empty."""
    if not read:
        return ""
    objs = read.get("objects") or [dict(it, label=it.get("name")) for it in read.get("items") or [] if it.get("bbox")]
    person = next((o for o in objs if o.get("kind") in ("person", "man", "woman", "child")), None)
    bits = []
    if person:
        from . import convert as C
        a = {"kind": C.person_kind(person.get("label") or ""), "source": {"label": person.get("label") or "",
                                                                          "wardrobe": person.get("wardrobe") or ""}}
        a["appearance"] = W.appearance(person.get("label") or "", person.get("wardrobe"), person.get("color"))
        bits.append(subject(a))
    setting = str(read.get("setting") or "").strip()
    sets = [s.get("type") for s in read.get("set") or [] if s.get("type")] + \
        [s.get("kind") for s in read.get("surfaces") or [] if s.get("kind") not in (None, "sky")]
    words = []
    for t in sets:
        w = kind_word(t)
        if w and w not in words:
            words.append(w)
    head = " ".join(b for b in bits if b)
    if setting:
        head = f"{head} in {setting}" if head else setting
    out = (head[:1].upper() + head[1:]) if head else ""
    if words:
        out = f"{out}; {', '.join(words[:6])}" if out else ", ".join(words[:6]).capitalize()
    t = str(read.get("time") or "").strip()
    if "overcast" in t or "cloud" in t:
        out += ". Overcast sky"
    return (out.strip() + ".") if out.strip() else ""


# ---------------------------------------------------------------------------------------------- blocks in front of the scan
def _project(pose, A, b, K, p_stage):
    """Stage point -> (u, v, depth along the camera z) through a legacy pose (3x4 cam-from-cam0) and the stage xform."""
    x0 = np.linalg.solve(A, np.asarray(p_stage, float) - b)
    xc = pose[:, :3] @ x0 + pose[:, 3]
    if xc[2] <= 1e-6:
        return None
    uv = K @ (xc / xc[2])
    return float(uv[0]), float(uv[1]), float(xc[2] * np.linalg.norm(A[0]))


def footprint_points(a: dict, n: int = 7) -> list[np.ndarray]:
    """Stage points over a block's whole extent (its recipe size_m turned by rotation_deg, three heights, plus each recipe
    part), so a long strip is judged by all of it, not by its centre (convert.outside_view uses the same frame)."""
    p = np.array(a.get("position") or [0, 0, 0], float)
    size = (a.get("recipe") or {}).get("size_m") or [1.0, float(a.get("height_m") or 1.0), 1.0]
    r = math.radians(float(a.get("rotation_deg") or 0))
    ax, az = np.array([math.cos(r), 0, -math.sin(r)]), np.array([math.sin(r), 0, math.cos(r)])
    hgt = min(float(size[1] or a.get("height_m") or 1.0), 6.0)
    pts = []
    for fx in np.linspace(-0.5, 0.5, n):
        for fz in np.linspace(-0.5, 0.5, 3):
            for fy in (0.1, 0.5, 0.9):
                pts.append(p + ax * fx * float(size[0]) + az * fz * float(size[2]) + np.array([0, fy * hgt, 0]))
    for part in (a.get("recipe") or {}).get("parts") or []:
        q = np.array(part.get("pos") or [0, 0, 0], float)
        pts.append(p + ax * q[0] + az * q[2] + np.array([0, q[1], 0]))
    return pts


def triage_blocks(actors: list, pose0, A, b, K, size, scan_depth_m, covered: float = 0.35, shown: float = 0.6) -> dict:
    """The clay dressing against the set scan, through the first camera, judged over each block's whole extent
    (footprint_points), not its centre. For each set piece (not the scan, not the performer):
    - no point in view -> kept, marked in_view False (it is never named: the camera never sees it);
    - in view, and at `shown` (60 %) or more of its in-view points the scan's depth is within `covered` of the block's
      -> dropped (the scan already shows it there);
    - otherwise in view in front of (or beyond) the scan -> kept, in_view True, given its kind word (prompt_word), which
      the motion prompt names with where it stands (look/compile.py set_pieces_sentence) and the Look text names.
    scan_depth_m: the scan's first-frame depth in metres on the `size` grid (None: nothing dropped).
    Returns {dropped: [names], worded: [names], off_view: [names]}; the actor list is edited in place."""
    w, h = size
    pose0 = np.asarray(pose0, float)
    res = {"dropped": [], "worded": [], "off_view": []}
    keep = []
    for a in actors:
        if not a.get("set_piece") or a.get("scan") or a.get("structure") or a.get("kind") == "glb":
            keep.append(a)
            continue
        seen = []
        for q in footprint_points(a):
            pr = _project(pose0, A, b, K, q)
            if pr is not None and 0 <= pr[0] < w and 0 <= pr[1] < h:
                seen.append(pr)
        name = a.get("name") or a.get("kind")
        if not seen:
            a["in_view"] = False
            res["off_view"].append(name)
            keep.append(a)
            continue
        hits = 0
        if scan_depth_m is not None:
            for u, v, dist in seen:
                zz = float(scan_depth_m[int(v), int(u)])
                if math.isfinite(zz) and zz > 0 and abs(zz - dist) <= covered * dist:
                    hits += 1
        if scan_depth_m is not None and hits >= shown * len(seen):
            res["dropped"].append(name)
            continue
        a["in_view"] = True
        a["prompt_word"] = kind_word(name)
        res["worded"].append(name)
        keep.append(a)
    actors[:] = keep
    return res
