"""Video → Stage, the set-scan path on the App route (POST /soundstage/video2stage).

The route used to build the set only from the vision model's words (convert.build_set: fixed 6 / 20 / 70 m distances).
The fused set scan (backdrop.build), the structure planes (planes.fit) and the Qwen3-VL inventory were built and tested
but never called by it. This module calls them from the route's own arrays (the legacy solve), behind the `scan`
setting: ON by default when a Qwen3-VL inventory model is installed and the set scan is wanted; the old block builder
stays the fallback (the scan path off, no model, or any failure in it).

    choose(scan_opt, backdrop, model)  -> (on, note)
    inventory_prompt(model, names)     -> (prompt, frames)   the 8B read over 6 of the depth samples
    collect_inventory(outputs, frames) -> inventory          vlm.parse_inventory + merge_inventory
    apply(scene, arrays, notes)        -> stats              planes + scan + the dressing triage, in place
"""
from __future__ import annotations

import numpy as np

from . import vlm

SCAN_MODELS = tuple(vlm.INVENTORY_MODELS[:2])   # Qwen3-VL 8B, then 4B (the old Qwen 3.5 4B can't box a whole frame)


def choose(scan_opt, backdrop: bool, model: str | None, vlm_on: bool = True) -> tuple[bool, str]:
    """The route's pick. scan_opt: the request's `scan` (None = the default). vlm_on: the user's "Name things with
    the vision model" tick (off: model is None because the user turned it off, not because none is installed)."""
    if not backdrop:
        return False, "set: the set scan is switched off; the set is built from the vision model's words (old builder)"
    if scan_opt is False:
        return False, "set: the scan path is switched off in the options; the old block builder made the set"
    if not vlm_on:
        return False, ("set: the vision model is turned off in the options, and the scan path needs its Qwen3-VL "
                       "inventory; the old block builder made the set")
    if model not in SCAN_MODELS:
        if scan_opt:
            return False, ("set: the scan path needs Qwen3-VL (8B or 4B) for its inventory and it is not installed; "
                           "the old block builder made the set")
        return False, "set: no Qwen3-VL on this server, so the set came from the old block builder (install it for the scan path)"
    return True, f"set: the set-scan path (fused scan + structure planes, inventory by {model})"


def inventory_prompt(model: str, names: list[str]) -> tuple[dict, list[int]]:
    fr = vlm.inventory_frames(len(names))
    return vlm.inventory_prompt(model, [names[i] for i in fr]), fr


def collect_inventory(outputs: dict, frames: list[int]) -> dict:
    from .queue import text_of
    reads = []
    for i, f in enumerate(frames):
        try:
            r = vlm.parse_inventory(text_of(outputs, f"r{i}"), f)
        except (ValueError, KeyError, TypeError):
            continue
        if not vlm.needs_retry(r):
            reads.append(r)
    return vlm.merge_inventory(reads)


# ---------------------------------------------------------------------------------------------- the arrays as contexts
def _box_at(o: dict, t: float):
    a, b = o.get("bbox_start"), o.get("bbox_end")
    if a and b:
        return [x + (y - x) * t for x, y in zip(a, b)]
    return a or b


def take_frame_at(take, t: float, fps: float) -> int | None:
    """The take frame nearest stage time t (s), or None when t is more than ~1.5 frames outside the take (SAM 3D Body
    tracks from when it finds the person, so the take can start after the first sample)."""
    if not take or not take.get("body"):
        return None
    n = int(take.get("frames") or len(take.get("body") or []))
    src = take.get("source_frames") or list(range(n))
    if not src:
        return None
    tt = np.asarray(src, float) / max(float(fps), 1e-6)
    k = int(np.argmin(np.abs(tt - float(t))))
    return k if abs(tt[k] - float(t)) <= 1.5 / max(float(fps), 1e-6) else None


def joint_box(take, k, size):
    """(uv, box) of the take's 2D joints at take frame k on a `size` (w, h) grid: the joints in pixels and the box
    they span, grown for the head top, heels and clothes. (None, None) without a usable take frame."""
    from . import performer
    if k is None or not take or not take.get("focal_px") or not take.get("body"):
        return None, None
    uv = performer.sam_2d(take, k, size)
    ok = np.isfinite(uv).all(axis=1)
    if ok.sum() < 4:
        return None, None
    from . import wardrobe as W
    ends = W._with_ends(uv)
    pts = ends[np.isfinite(ends).all(axis=1)]                 # the joints and the crown, fingertips and toes
    (jx0, jy0), (jx1, jy1) = uv[ok].min(0), uv[ok].max(0)
    (ex0, ey0), (ex1, ey1) = pts.min(0), pts.max(0)
    jy1 = max(jy1, _soles_y(uv))   # her knees or ankles untracked: the box still reaches her soles
    ey1 = max(ey1, jy1)
    H = jy1 - jy0
    return uv, [min(jx0 - 0.12 * H, ex0 - 0.04 * H), min(jy0 - 0.1 * H, ey0 - 0.04 * H),
                max(jx1 + 0.12 * H, ex1 + 0.04 * H), max(jy1 + 0.05 * H, ey1 + 0.04 * H)]


def _soles_y(uv) -> float:
    """Where her soles are (pixel row) when the take misses her lower joints, from her body's proportions: below the
    tracked ankles nothing is added; with knees but no ankles the shins are about 1.1 thighs; with hips only, the legs
    are about 1.6 of the neck-to-hip trunk (shoulders for the neck). -inf when nothing tells."""
    f = lambda js: [uv[j][1] for j in js if j < len(uv) and np.all(np.isfinite(uv[j]))]   # noqa: E731
    ank, kne, hip = f((10, 13)), f((9, 12)), f((8, 11))
    top = f((1,)) or f((2, 5))
    if ank:
        return max(ank)
    if kne and hip:
        return max(kne) + 1.1 * (max(kne) - float(np.mean(hip)))
    if hip and top:
        return float(np.mean(hip)) + 1.6 * (float(np.mean(hip)) - float(np.mean(top)))
    return float("-inf")


def _over_performer(bb, jbox, w: int, h: int, share: float = 0.6) -> bool:
    """A person box (0-1000) is the performer's when it holds the joint box's centre, or when at least `share` of the
    person box lies inside the joint box: a candidate entry for her. people_masks then keeps only the best match and
    the duplicates that hold no body of their own at her depth (_another_body)."""
    x0, y0, x1, y1 = bb[0] / 1000 * w, bb[1] / 1000 * h, bb[2] / 1000 * w, bb[3] / 1000 * h
    cx, cy = (jbox[0] + jbox[2]) / 2, (jbox[1] + jbox[3]) / 2
    if x0 <= cx <= x1 and y0 <= cy <= y1:
        return True
    iw = max(0.0, min(x1, jbox[2]) - max(x0, jbox[0]))
    ih = max(0.0, min(y1, jbox[3]) - max(y0, jbox[1]))
    a = max(1e-6, (x1 - x0) * (y1 - y0))
    return iw * ih >= share * a


def _iou_px(bb, jbox, w: int, h: int) -> float:
    """Intersection over union of a person box (0-1000) and the joint box (pixels)."""
    x0, y0, x1, y1 = bb[0] / 1000 * w, bb[1] / 1000 * h, bb[2] / 1000 * w, bb[3] / 1000 * h
    iw = max(0.0, min(x1, jbox[2]) - max(x0, jbox[0]))
    ih = max(0.0, min(y1, jbox[3]) - max(y0, jbox[1]))
    u = (x1 - x0) * (y1 - y0) + (jbox[2] - jbox[0]) * (jbox[3] - jbox[1]) - iw * ih
    return iw * ih / max(u, 1e-6)


HEAD_BAND = (-0.1, 0.3)   # the rows a second person's head and shoulders fill: her crown row + these shares of her height
HEAD_ROWS = 0.12          # a head-and-shoulders piece runs at least this share of her height down the band
SHOULDER_STEP = 0.2       # ...and its shoulders stand out past its head by at least this share of the head's width
HEAD_JOIN = 0.015         # pieces this share of her height apart are one piece (her mask's margin cuts his neck)


def _head_and_shoulders(piece, Hb: int, hers=None) -> bool:
    """True when a piece of the head band (a bool mask, the band's rows inside the person box) is shaped like a
    person's head and shoulders, not like a set piece's outline: tall enough (HEAD_ROWS of her height Hb); its top
    rows (the head) have real edges on both sides, neither one the box's (or frame's) side, which only cuts a wall or
    a roof; and the shoulders stand out past the head on BOTH sides, a side counting when its edge in the lower rows
    stands out past the head's by SHOULDER_STEP of the head's width (at least 3 px) without being the box's side
    (a wall running on to the box edge is no shoulder), or when that edge runs along her own body mask `hers` (her
    body hides his shoulder there). One widening edge is not enough: a roofline rising to one side, a wall taller on
    one side, a sign stepping out from a post all widen on one side only. Without `hers` no side counts as hidden."""
    rows = np.flatnonzero(piece.any(1))
    if rows.size < max(3, HEAD_ROWS * Hb):
        return False
    sub = piece[rows]
    W_ = sub.shape[1]
    left = np.argmax(sub, axis=1)
    right = W_ - 1 - np.argmax(sub[:, ::-1], axis=1)
    n = rows.size
    k = max(3, n // 4)                                       # the top quarter: the head
    lo = max(k, int(0.4 * n))                                # below 40% of the piece: the shoulders
    if (left[:k] <= 0).any() or (right[:k] >= W_ - 1).any():   # the box or frame side cuts it: a wall, a roof
        return False
    tl, tr = float(np.median(left[:k])), float(np.median(right[:k]))
    head = tr - tl + 1
    ll, lr = float(np.percentile(left[lo:], 20)), float(np.percentile(right[lo:], 80))
    need = max(3.0, SHOULDER_STEP * head)
    out_l = tl - ll >= need and ll > 0
    out_r = lr - tr >= need and lr < W_ - 1

    def hidden(edge, step):
        if hers is None:
            return False
        hb = np.asarray(hers, bool)[rows[lo:]]
        hit = 0
        for i, e in enumerate(edge[lo:]):
            a, b = (max(0, e - 3), e) if step < 0 else (e + 1, min(W_, e + 4))
            hit += bool(hb[i, a:b].any())
        return hit >= 0.5 * max(1, n - lo)

    return bool((out_l and (out_r or hidden(right, 1))) or (out_r and (out_l or hidden(left, -1))))


def _another_body(d, bb, body, w: int, h: int, rel: float = 0.07, share: float = 0.15) -> bool:
    """True when a person box (0-1000) over the performer holds, outside her body mask, a person of its own at her
    depth. It is judged on a person's shape, from her own body mask (her joints' silhouette): someone at her depth is
    about her size in the picture and stands on the same floor, so his head and shoulders fill the rows of hers (her
    crown row + HEAD_BAND of her height). Inside the box, in those rows only, the pixels within rel of her median depth
    and outside her body are cut into connected pieces (pieces under HEAD_JOIN of her height apart joined, so her grown mask
    does not part his head from his shoulders); only a piece shaped like a head and shoulders
    (_head_and_shoulders: inside the box, shoulders standing out past the head on both sides, or on one side with
    her body along the other) is his, and it is a second body when those pieces
    hold at least `share` of her own pixels in those rows. Everything else at her depth there is a surface, whether
    or not it touches the box's sides: a wall or slab from her shoulders down, a pillar beside her, railing posts, a
    panel rising above her head, a ledge or bench, the ground at her feet, a box that reaches both frame edges, so a
    duplicate entry for her keeps her body mask. Known limits: a second person much shorter than her, crouching or
    lying down, or standing well behind or in front of her, reads as no second body (the entry gets her body mask and
    his pixels stay in the scan); so does one whose shoulders she hides on both sides, or whose head-band piece is
    joined to a wall or slab within rel of her depth, or whose shoulders reach the box's side; a set piece at her
    depth inside the box, clear of its sides, that widens on both sides below a narrower top (a T-shaped sign on a
    post), or widens on one side while her body runs along its other side, reads as a second body."""
    rows = np.flatnonzero(body.any(1))
    if not rows.size:
        return False
    zb = float(np.median(d[body]))
    top, Hb = int(rows[0]), int(rows[-1] - rows[0] + 1)
    x0, x1 = max(0, int(bb[0] / 1000 * w)), min(w, int(np.ceil(bb[2] / 1000 * w)))
    y0, y1 = max(0, int(bb[1] / 1000 * h)), min(h, int(np.ceil(bb[3] / 1000 * h)))
    r0, r1 = max(y0, top + int(HEAD_BAND[0] * Hb)), min(y1, top + int(np.ceil(HEAD_BAND[1] * Hb)))
    if x1 <= x0 or r1 <= r0:
        return False
    sub = d[r0:r1, x0:x1]
    hers = body[r0:r1, x0:x1]
    need = share * max(1, int(body[r0:r1].sum()))
    near = ~hers & np.isfinite(sub) & (np.abs(sub - zb) < rel * zb)
    if int(near.sum()) < need:
        return False
    try:
        import cv2
        k = max(3, int(round(HEAD_JOIN * Hb)) | 1)   # her grown mask can part his head from his shoulders
        joined = cv2.dilate(near.astype(np.uint8), np.ones((k, k), np.uint8))
        n, lab = cv2.connectedComponents(joined, connectivity=4)
        lab = np.where(near, lab, 0)
    except ImportError:   # without OpenCV every near pixel is one piece
        n, lab = 2, near.astype(np.int32)
    sizes = np.bincount(lab[near], minlength=n)
    his = 0
    for c in np.flatnonzero(sizes):
        if c and _head_and_shoulders(lab == c, Hb, hers):
            his += int(sizes[c])
    return his >= need


TAKE_KEY = "take"   # people_masks / people_boxes: the performer from the take's joints when no person entry is over her


def people_masks(breakdown: dict, depths, times, duration: float, take=None, fps: float = 24.0) -> dict:
    """{person_i: {sample_i: rle}} from the read's person boxes (interpolated start -> end) and each sample's depth.
    The performer (every person box that holds the take's joints' centre at that sample, or lies mostly inside her
    joint box: legacy_breakdown lists her once per inventory frame, and a read can give 'woman dancing' plus
    'dancer'): wardrobe.body_mask, banded by the joints and the body's own depth per row, so a slab half a metre
    behind her is not her and stays in the scan.
    Only the entry that best matches her joint box (largest overlap with it) is surely her; another entry over her is
    a duplicate of her only when its box, outside her body mask, holds no body of its own at her depth
    (_another_body): a second dancer beside her, whose box covers her joints' centre, keeps the loose mask minus her
    body mask, so his own pixels leave the scan too.
    While the take tracks her and no entry is over her (the read has no person entry, or its box is misplaced), her
    body mask still comes from the joints, under its own key (TAKE_KEY).
    Everyone else, and the performer outside the take: the loose box-and-depth stand-in
    (wardrobe.person_mask_from_depth, rel 0.35)."""
    from . import backdrop as BD
    from . import wardrobe as W
    people = [(j, o) for j, o in enumerate(breakdown.get("objects") or []) if o.get("kind") == "person"]
    out: dict = {}
    for i, d in enumerate(depths):
        d = np.asarray(d, np.float32)
        h, w = d.shape
        t = float(times[i]) if times else 0.0
        boxes = {j: _box_at(o, min(1.0, max(0.0, t / max(duration, 1e-6))) if times else 0.0) for j, o in people}
        uv, jbox = joint_box(take, take_frame_at(take, t, fps), (w, h)) if take and times else (None, None)
        perf: set = set()
        over: list = []
        if jbox is not None:   # the take's person: the best match, plus any duplicate entry for her
            over = [j for j, bb in boxes.items() if bb and _over_performer(bb, jbox, w, h)]
            if over:
                best = max(over, key=lambda j: _iou_px(boxes[j], jbox, w, h))
                perf = {best}
        body = W.body_mask(d, jbox, uv) if jbox is not None else None
        if body is not None and body.any():
            perf |= {j for j in over if j not in perf and not _another_body(d, boxes[j], body, w, h)}
            if not over:   # the take tracks her but no entry is over her (none, or a misplaced box): her own key
                out.setdefault(TAKE_KEY, {})[i] = BD.rle_encode(body)
        for j, bb in boxes.items():
            if not bb:
                continue
            m = body if j in perf else None
            if m is None or not m.any():
                x0, y0, x1, y1 = (v / 1000 for v in bb)
                gx, gy = 0.15 * (x1 - x0), 0.05 * (y1 - y0)
                m = W.person_mask_from_depth(d, [x0 - gx, y0 - gy, x1 + gx, y1 + gy], rel=0.35, front=True)
                if m is not None and body is not None and j in over:
                    m = m & ~body   # a second person over her: his pixels, not hers
            if m is not None and m.any():
                out.setdefault(f"p{j}", {})[i] = BD.rle_encode(m)
    return out


def people_boxes(breakdown: dict, size, times, duration: float, take=None, fps: float = 24.0, i: int = 0,
                 hers: set | None = None) -> dict:
    """{person_i: [x0, y0, x1, y1]} in pixels of a `size` (w, h) grid at sample i: each person box (interpolated
    start -> end) grown by the loose mask's margin, and for the performer while the take tracks her also her joint
    box; with no entry over her, her joint box alone (TAKE_KEY). The keys match people_masks. without_people uses them
    so pixels a mask missed still count as the person. `hers`, when given, is filled with the performer's keys (the
    entries over her joints, or TAKE_KEY): without_people lets only those, or a person-shaped mask, open its box."""
    w, h = size
    t = float(times[i]) if times else 0.0
    people = [(j, o) for j, o in enumerate((breakdown or {}).get("objects") or []) if o.get("kind") == "person"]
    boxes = {j: _box_at(o, min(1.0, max(0.0, t / max(duration, 1e-6))) if times else 0.0) for j, o in people}
    uv, jbox = joint_box(take, take_frame_at(take, t, fps), (w, h)) if take and times else (None, None)
    out = {}
    found = False
    for j, bb in boxes.items():
        if not bb:
            continue
        x0, y0, x1, y1 = bb[0] / 1000 * w, bb[1] / 1000 * h, bb[2] / 1000 * w, bb[3] / 1000 * h
        gx, gy = 0.15 * (x1 - x0), 0.05 * (y1 - y0)
        r = [x0 - gx, y0 - gy, x1 + gx, y1 + gy]
        if jbox is not None and _over_performer(bb, jbox, w, h):
            r = [min(r[0], jbox[0]), min(r[1], jbox[1]), max(r[2], jbox[2]), max(r[3], jbox[3])]
            found = True
            if hers is not None:
                hers.add(f"p{j}")
        out[f"p{j}"] = r
    if jbox is not None and not found:   # no entry over her: her joint box, under people_masks' own key for her
        out[TAKE_KEY] = list(jbox)
        if hers is not None:
            hers.add(TAKE_KEY)
    return out


OPEN_FILL = 0.85   # a mask filling more of its box than this is no person's shape (a wall, the background): no padding
# A side is cut when the person crosses it and carries on past it (cut, below) along: on the left or right side, at
# least OPEN_SIDE of the mask's own height (the box holds only her left or right half) or at most LIMB of it (an arm
# spread past the box); on the top or bottom side, at least TORSO of the mask's own width (a box over her top half or
# third: her waist runs out of it, however wide her spread arms make her) or at most LIMB of it (a raised arm). A
# crossing in between, on the left or right, is a thing at her depth beside her (a crate she stands against): no cut.
OPEN_SIDE, LIMB, TORSO = 0.8, 0.15, 0.25
OPEN_WIDEN = 0.5   # an open side's padding also reaches this much of the box past its two neighbouring sides


def _person_shaped(m, x0, y0, x1, y1) -> bool:
    """A mask a person's: it leaves part of its box free (OPEN_FILL), so it is not a wall or a background the loose
    box-and-depth stand-in took whole."""
    sub = m[y0:y1, x0:x1]
    return bool(sub.size) and float(sub.mean()) <= OPEN_FILL


def _open_box(m, r, w: int, h: int, src=None, zm: float | None = None, hers: bool = False, rel: float = 0.1):
    """The padding region of a person box r (pixels) for mask m: the box, opened to the frame edge past each side the
    person is cut by (the box covers only part of her: the top third, the left half), and widened there by OPEN_WIDEN
    of the box on the two neighbouring sides, clipped to the frame. A side is cut when the mask runs into it and the
    person carries on past it (the pixel just outside within rel of her depth `zm` in `src`; without `src`, the mask
    at the side is the evidence) along a share of her own span there (OPEN_SIDE, LIMB, TORSO): an arm spread at
    shoulder level, the legs below a box over her top half. Only her (`hers`: the performer's entry or her joints' key while the take tracks her) or
    a person-shaped mask (_person_shaped) opens anything: a bystander's loose mask that took the wall he leans on, or
    a hallucinated box over the background, fills its box and stays as it is. A box that holds the person touches her
    only at a hand, a foot or the head, with the set past it, so it stays as it is too."""
    x0, y0 = max(0, int(np.floor(r[0]))), max(0, int(np.floor(r[1])))
    x1, y1 = min(w, int(np.ceil(r[2]))), min(h, int(np.ceil(r[3])))
    if x1 <= x0 or y1 <= y0:
        return x0, y0, x1, y1
    sub = m[y0:y1, x0:x1]
    if not sub.any() or not (hers or _person_shaped(m, x0, y0, x1, y1)):
        return x0, y0, x1, y1
    bw, bh = x1 - x0, y1 - y0
    kx, ky = max(2, bw // 50), max(2, bh // 50)               # "at the side": within 2% of the box (rounding)

    rows, cols = np.flatnonzero(sub.any(1)), np.flatnonzero(sub.any(0))
    span_r, span_c = rows[-1] - rows[0] + 1, cols[-1] - cols[0] + 1

    def cut(at_side, outside, span, wide):
        if outside is None:
            return False
        if src is None or zm is None:
            on = at_side
        else:
            z = np.asarray(outside, np.float32)
            on = at_side & np.isfinite(z) & (np.abs(z - zm) < rel * zm)
        n = int(on.sum())
        if n < 2:
            return False
        return n >= wide * span or n <= LIMB * span

    S = None if src is None else np.asarray(src, np.float32)
    out = lambda sl: None if S is None else S[sl]               # noqa: E731
    g = [False] * 4
    g[0] = x0 > 0 and cut(sub[:, :kx].any(1), out(np.s_[y0:y1, x0 - 1]) if S is not None else sub[:, 0], span_r,
                          OPEN_SIDE)
    g[2] = x1 < w and cut(sub[:, -kx:].any(1), out(np.s_[y0:y1, x1]) if S is not None else sub[:, -1], span_r,
                          OPEN_SIDE)
    g[1] = y0 > 0 and cut(sub[:ky].any(0), out(np.s_[y0 - 1, x0:x1]) if S is not None else sub[0], span_c, TORSO)
    g[3] = y1 < h and cut(sub[-ky:].any(0), out(np.s_[y1, x0:x1]) if S is not None else sub[-1], span_c, TORSO)
    ox0, oy0, ox1, oy1 = x0, y0, x1, y1
    if g[0] or g[2]:   # open left / right: to the frame edge there, and a little taller
        ox0, ox1 = (0 if g[0] else x0), (w if g[2] else x1)
        oy0, oy1 = y0 - int(OPEN_WIDEN * bh), y1 + int(OPEN_WIDEN * bh)
    if g[1] or g[3]:   # open up / down: to the frame edge there, and a little wider
        oy0 = 0 if g[1] else min(oy0, y0)
        oy1 = h if g[3] else max(oy1, y1)
        ox0, ox1 = min(ox0, x0 - int(OPEN_WIDEN * bw)), max(ox1, x1 + int(OPEN_WIDEN * bw))
    return max(0, ox0), max(0, oy0), min(w, ox1), min(h, oy1)


def _reach(cand, seed):
    """The pixels of `cand` 4-connected to `seed` (the person's mask and her padding inside her box). Without OpenCV
    or SciPy: `cand` within the seed's own bounding rows and columns."""
    try:
        import cv2
        n, lab = cv2.connectedComponents(cand.astype(np.uint8), connectivity=4)
    except ImportError:
        try:
            from scipy import ndimage
            lab, n = ndimage.label(cand)
            n += 1
        except ImportError:
            rows, cols = np.flatnonzero(seed.any(1)), np.flatnonzero(seed.any(0))
            out = np.zeros_like(cand)
            if rows.size:
                out[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1] = cand[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
            return out
    keep = np.zeros(n, bool)
    keep[np.unique(lab[seed & cand])] = True
    keep[0] = False
    return keep[lab]


def without_people(depth, masks: dict | None, i: int = 0, boxes: dict | None = None, rel: float = 0.1,
                   hers=None) -> np.ndarray:
    """A copy of sample i's depth with every person's pixels (people_masks) set to NaN: the block triage then judges a
    block against the set behind her, not against the performer standing in front of it (a block where she stands
    would otherwise read as 'the scan already shows it' and be dropped).
    With `boxes` (people_boxes) a mask that missed part of the person is padded: inside that person's box, every pixel
    within `rel` of the median depth under the mask goes too, so her leftover unmasked pixels at her own depth are
    not read as the scan showing a block where she stands. Known limit: a set piece within `rel` of her depth inside
    her box is not seen by the triage either (the block there is kept and worded, not dropped).
    A box that cuts the person (_open_box: the top third of her, the left half, an arm spread past it) is no limit to
    the padding: past each cut side it reaches to the frame edge, but only over pixels at her depth connected to her
    (_reach), so the set beyond her stays. `hers` (people_boxes' keys for the performer while the take tracks her) may
    always open; any other key only when its mask is person-shaped, so a bystander's loose mask that took the wall
    he leans on (or a box over the background) pads only its own box. Known limit: ground at her depth that the
    loose mask took along the box's bottom side opens it too, and the padding then takes that ground strip below her
    box (a block on it within `rel` of her depth is kept and worded, not dropped)."""
    from . import backdrop as BD
    src = np.asarray(depth, np.float32)
    d = np.array(src, copy=True)
    h, w = d.shape
    hers = set(hers or ())
    for key, per in (masks or {}).items():
        m = BD.rle_decode(per.get(i), d.shape) if isinstance(per, dict) and i in per else None
        if m is None or m.shape != d.shape:
            continue
        d[m] = np.nan
        r = (boxes or {}).get(key)
        z = src[m]
        z = z[np.isfinite(z) & (z > 0)]
        if r is None or not z.size:
            continue
        zm = float(np.median(z))
        bx0, by0 = max(0, int(np.floor(r[0]))), max(0, int(np.floor(r[1])))
        bx1, by1 = min(w, int(np.ceil(r[2]))), min(h, int(np.ceil(r[3])))
        if bx1 <= bx0 or by1 <= by0:
            continue
        at = np.isfinite(src) & (np.abs(src - zm) < rel * zm)
        inbox = np.zeros_like(at)
        inbox[by0:by1, bx0:bx1] = True
        pad = at & inbox
        x0, y0, x1, y1 = _open_box(m, r, w, h, src=src, zm=zm, hers=key in hers, rel=rel)
        if (x0, y0, x1, y1) != (bx0, by0, bx1, by1):
            region = np.zeros_like(at)
            region[y0:y1, x0:x1] = True
            pad |= _reach(at & region, (m | pad) & region)
        d[pad] = np.nan
    return d


def planes_ctx(*, depths, scales, poses, K, A, b, files, skies, masks) -> dict:
    """The legacy solve in the context's stage-world convention (metres, Y up): world-from-camera 4x4 per sample and
    metric depth, so planes.fit can run on it."""
    mpu = float(np.linalg.norm(A[0]))
    Rw = A / mpu
    h, w = np.asarray(depths[0]).shape
    ctx = {"clip": {"pw": w, "ph": h}, "depth": {}, "sky": {}, "K": {}, "poses": {}, "all_frames": list(files),
           "masks": {"people": masks or {}, "objects": {}}, "samples": list(range(len(depths)))}
    for i, d in enumerate(depths):
        P = np.asarray(poses[i], float)
        R, t = P[:, :3], P[:, 3]
        W4 = np.eye(4)
        W4[:3, :3] = Rw @ R.T
        W4[:3, 3] = b - A @ (R.T @ t)
        ctx["poses"][i] = W4
        ctx["depth"][i] = np.asarray(d, np.float32) * float(scales[i]) * mpu
        ctx["K"][i] = np.asarray(K, float)
        if skies is not None:
            ctx["sky"][i] = np.asarray(skies[i], np.float32)
    return ctx


FLAT_DRESSING = ("plaza", "sidewalk", "grass", "road")


def apply(scene: dict, *, depths, scales, poses, K, files, skies, breakdown, times, duration, notes: list,
          tag: str = "scan", out: dict | None = None, use_planes: bool = True, take=None, fps: float = 24.0) -> dict:
    """The scan path on a built scene (convert.assemble_legacy's output), in place:
    1. structure planes (planes.fit) as set pieces; the old flat dressing they replace goes;
    2. the fused set scan (backdrop.build) replaces the frame-0 relief;
    3. the dressing in front of the scan gets its kind word, the dressing the scan already shows goes
       (scenewords.triage_blocks).
    Returns stats {planes, dropped, worded, scan}."""
    from . import backdrop as BD
    from . import convert as CV
    from . import planes as PL
    from . import scenewords as SW
    xf = scene["video2stage"]["xform"]
    A, b = np.asarray(xf["A"], float), np.asarray(xf["b"], float)
    stats: dict = {"planes": 0, "dropped": [], "worded": [], "scan": False}
    masks = people_masks(breakdown, depths, times, duration, take=take, fps=fps)
    if use_planes:
        try:
            pctx = planes_ctx(depths=depths, scales=scales, poses=poses, K=K, A=A, b=b, files=files, skies=skies,
                              masks=masks)
            st = PL.fit(pctx, notes)
            ids = {a.get("id") for a in scene["actors"]}
            kinds = set()
            for pl in st["planes"]:
                a = CV.plane_actor(pl, ids)
                a["structure"] = True
                scene["actors"].append(a)
                kinds.add(pl["kind"])
            stats["planes"] = len(st["planes"])
            if kinds & {"ground", "road", "floor", "sidewalk"}:
                before = len(scene["actors"])
                scene["actors"] = [a for a in scene["actors"] if a.get("structure") or not a.get("set_piece") or
                                   not str(a.get("name") or "").lower().startswith(FLAT_DRESSING)]
                if before != len(scene["actors"]):
                    notes.append(f"set: {before - len(scene['actors'])} flat dressing piece(s) replaced by the measured ground")
        except Exception as exc:  # noqa: BLE001 - the scan and the blocks still stand
            notes.append(f"set: structure planes failed ({exc}); kept the old dressing")
    try:
        bctx = BD.ctx_from_legacy(depths=[np.asarray(d, np.float32) * float(s) for d, s in zip(depths, scales)],
                                  poses_cw=poses, K=K, sample_frames=list(range(len(depths))), frame_files=list(files),
                                  skies=skies, frame_w=np.asarray(depths[0]).shape[1], tag=tag, out=out,
                                  masks={"people": masks})
        res = BD.build(scene, bctx)
        notes += res["notes"]
        stats["scan"] = bool(res["actors"])
    except Exception as exc:  # noqa: BLE001
        notes.append(f"set: the set scan failed ({exc}); kept the frame-0 relief")
    mpu = float(np.linalg.norm(A[0]))
    h, w = np.asarray(depths[0]).shape
    hers: set = set()
    boxes0 = people_boxes(breakdown, (w, h), times, duration, take=take, fps=fps, hers=hers)
    depth0 = without_people(np.asarray(depths[0], np.float32) * float(scales[0]) * mpu, masks, 0, boxes=boxes0,
                            hers=hers)
    tri = SW.triage_blocks(scene["actors"], poses[0], A, b, K, (w, h), depth0)
    stats.update(dropped=tri["dropped"], worded=tri["worded"])
    if tri["dropped"]:
        notes.append(f"set: dropped {len(tri['dropped'])} block(s) the scan already shows: {', '.join(tri['dropped'][:6])}")
    if tri["worded"]:
        notes.append(f"set: {len(tri['worded'])} block(s) stand in front of the scan; the Look text names each by its kind")
    return stats
