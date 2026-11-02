"""LAYOUT, step 2: every thing in the frame as a tracked mask (SAM 3.1 through the ComfyUI queue).

One queued prompt tracks each concept (the vision model's inventory names plus a fixed sweep of furniture, signs,
poles, plants, windows, doors, vehicles, animals, bags, boxes and lamps) through the trim with SAM3_VideoTrack, in
40-frame windows that overlap by 8 frames: on ComfyUI v0.43.0 one long SAM3_VideoTrack returned masks for only the
first 96 of 120 frames, while 40-frame windows return every frame. Windows are stitched by mask IoU over the overlap.

Core nodes can only hand a mask out as an image, so each window packs up to 8 objects into the bits of one 8-bit
grey PNG: ThresholdMask(0.5) -> x 2^j / 255 -> summed, with a +0.5/255 bias so SaveImage's truncation keeps the
exact integer. collect() reads the bits back, one mask per object per frame.

'person' is POSE's (people.py). Masks are de-duplicated across concepts (overlap above 0.6: the vision model's own
name wins, else the longer, larger track). What is left unexplained (not an object, a person, sky or a fitted plane)
is reported by region, named after the vision model's nearest box, so nothing visible is left out without a note.

Writes ctx['masks']['objects'] = {obj_id: {f: rle}} and ctx['seg'] = {obj_id: {concept, label, frames: {f: stats}}}.
Pixels are on the proxy grid (ctx['clip']['pw'] x ['ph']); f are stage frames.
"""
from __future__ import annotations

import math
import os
import re

import numpy as np

from . import context as X

SAM_CKPT = "sam3.1_multiplex_fp16.safetensors"
SWEEP = ["furniture", "sign", "pole", "plant", "window", "door", "vehicle", "animal", "bag", "box", "lamp"]
# Things POSE owns, and surfaces planes.py fits (SAM masks of a floor or a wall swallow everything standing on it).
NOT_THINGS = {"person", "people", "man", "woman", "child", "boy", "girl", "pedestrian", "rider", "driver", "cyclist",
              "floor", "wall", "walls", "ceiling", "ground", "road", "street", "sidewalk", "pavement", "kerb", "curb",
              "sky", "cloud", "clouds", "grass", "terrain", "asphalt", "lane", "crosswalk", "marking", "markings",
              "sun", "shadow", "light", "reflection", "horizon", "water", "ocean", "sea"}
WINDOW, OVERLAP = 40, 8
LOW = 4                 # low-res stride for dedup / coverage maps
MAX_CONCEPTS = 26
THRESH = 0.42
BIAS = 0.5 / 255.0


# ---------------------------------------------------------------------------------------------- concepts
def _noun(s: str) -> str:
    s = re.sub(r"[^a-z ]", " ", str(s or "").lower()).strip()
    return re.sub(r"\s+", " ", s)


def concepts(ctx: dict) -> list[dict]:
    """[{text, max_objects, source: 'vlm'|'sweep'}]: the inventory's kinds first (by count), then the sweep."""
    inv = ctx.get("vlm_inventory") or {}
    counts: dict = {}
    for it in inv.get("items") or []:
        k = _noun(it.get("kind") or it.get("name"))
        if not k or k in NOT_THINGS or any(w in NOT_THINGS for w in k.split()[-1:]):
            continue
        counts[k] = counts.get(k, 0) + max(1, int(it.get("count") or 1))
    out, seen = [], set()
    for k, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        if k in seen:
            continue
        seen.add(k)
        out.append({"text": k, "max_objects": int(min(16, max(4, 2 * n))), "source": "vlm"})
    for k in SWEEP:
        if k in seen:
            continue
        seen.add(k)
        out.append({"text": k, "max_objects": 16 if k in ("furniture", "vehicle", "pole", "sign", "plant") else 8,
                    "source": "sweep"})
    extra = [_noun(w) for w in str((ctx.get("opts") or {}).get("objects") or "").split(",")]
    for k in extra:   # the user's own "objects to find" go first
        if k and k not in seen:
            out.insert(0, {"text": k, "max_objects": 8, "source": "user"})
            seen.add(k)
    return out[:MAX_CONCEPTS]


def windows(n: int, size: int = WINDOW, overlap: int = OVERLAP) -> list[tuple[int, int]]:
    """[(start, length)] covering 0..n-1, consecutive windows sharing `overlap` frames."""
    if n <= size:
        return [(0, n)]
    step = size - overlap
    out, s = [], 0
    while True:
        ln = min(size, n - s)
        out.append((s, ln))
        if s + ln >= n:
            break
        s += step
    if len(out) > 1 and out[-1][1] <= overlap:   # a sliver tail: grow the window before it instead
        s0, _ = out[-2]
        out = out[:-2] + [(s0, n - s0)]
    return out


# ---------------------------------------------------------------------------------------------- graph
def _prompt_text(cons: list[dict]) -> str:
    """'sofa, chair, table, ...' for ONE multi-prompt SAM 3.1 track (commas separate prompts; none inside a name)."""
    return ", ".join(re.sub(r"[,():]", " ", c["text"]).strip() for c in cons)


def graph(ctx: dict, video: str | None = None) -> dict | None:
    """The SAM 3.1 prompt (None: nothing to track).

    Tracking: ONE SAM3_VideoTrack per 40-frame window with every concept as a multi-prompt (comma-separated; one image
    backbone pass per frame however many concepts), up to 64 objects, packed 8 per PNG.
    Naming: SAM3_Detect per concept on the inventory frames (one image each); collect() gives every track the concept
    whose detections overlap it most. ctx['seg_keys'] = {save node: ('track', window start, group) | ('det', ci, f)}."""
    clip = ctx["clip"]
    n = int(clip["frames"])
    pw, ph = int(clip["pw"]), int(clip["ph"])
    cons = ctx.get("seg_concepts") or concepts(ctx)
    ctx["seg_concepts"] = cons
    if not cons or n <= 0:
        return None
    video = video or clip.get("video") or ctx.get("video") or os.path.basename(clip["path"])
    tag = (ctx.get("env") or {}).get("tag") or ctx.get("tag") or "v2s"
    g: dict = {}
    keys: dict = {}

    def node(cls, **inputs):
        nid = f"s{len(g) + 1}"
        g[nid] = {"class_type": cls, "inputs": inputs}
        return nid

    v = node("LoadVideo", file=video)
    comp = node("GetVideoComponents", video=[v, 0])
    src = [comp, 0]
    # Stage frame f shows source frame start + source_index(f) (frames.decode_all): one slice when it is 1:1.
    fps = float(clip.get("fps") or 24.0)
    first = int(round(float(clip.get("start") or 0.0) * fps))
    n_src = int(clip.get("src_frames") or 0) if not isinstance(clip.get("src_frames"), (list, tuple)) else len(clip["src_frames"])
    if abs(fps - 24.0) > 0.01 and n_src:
        idx = [first + int(min(n_src - 1, max(0, round(f / 24.0 * fps)))) for f in range(n)]
        src = _resample(node, src, idx)
        first = 0
    img = node("ImageScale", image=src, upscale_method="area", width=pw, height=ph, crop="disabled")
    ck = node("CheckpointLoaderSimple", ckpt_name=SAM_CKPT)
    bits = [node("SolidMask", value=float(2 ** j) / 255.0, width=pw, height=ph) for j in range(8)]
    bias = node("SolidMask", value=BIAS, width=pw, height=ph)
    multi = node("CLIPTextEncode", text=_prompt_text(cons), clip=[ck, 1])
    max_obj = int(ctx.get("seg_max_objects") or 64)
    for start, ln in windows(n):
        win = node("ImageFromBatch", image=[img, 0], batch_index=first + start, length=ln)
        tr = node("SAM3_VideoTrack", images=[win, 0], model=[ck, 0], detection_threshold=THRESH,
                  max_objects=max_obj, detect_interval=1, conditioning=[multi, 0])
        for grp in range(int(math.ceil(max_obj / 8))):
            acc = None
            for j in range(8):
                k = grp * 8 + j
                if k >= max_obj:
                    break
                m = node("SAM3_TrackToMask", track_data=[tr, 0], object_indices=str(k))
                t = node("ThresholdMask", mask=[m, 0], value=0.5)
                p = node("MaskComposite", destination=[t, 0], source=[bits[j], 0], x=0, y=0, operation="multiply")
                acc = node("MaskComposite", destination=[p, 0], source=[bias, 0], x=0, y=0, operation="add") \
                    if acc is None else node("MaskComposite", destination=[acc, 0], source=[p, 0], x=0, y=0, operation="add")
            im = node("MaskToImage", mask=[acc, 0])
            sid = node("SaveImage", images=[im, 0], filename_prefix=f"soundstage/v2s_seg/{tag}_w{start:04d}_g{grp}")
            keys[sid] = ("track", start, grp)
    # Naming: each concept detected on the inventory frames.
    kf = list(ctx.get("vlm_frames") or [])
    if not kf:
        kf = sorted({int(round(i * (n - 1) / 3)) for i in range(4)})
    kf = kf[:6]
    ims = {f: node("ImageFromBatch", image=[img, 0], batch_index=first + int(f), length=1) for f in kf}
    for ci, c in enumerate(cons):
        cond = node("CLIPTextEncode", text=re.sub(r"[,():]", " ", c["text"]).strip(), clip=[ck, 1])
        for f, im in ims.items():
            det = node("SAM3_Detect", model=[ck, 0], image=[im, 0], conditioning=[cond, 0], threshold=THRESH,
                       refine_iterations=1, individual_masks=True)
            mi = node("MaskToImage", mask=[det, 0])
            sid = node("SaveImage", images=[mi, 0], filename_prefix=f"soundstage/v2s_seg/{tag}_d{ci:02d}_f{int(f):05d}")
            keys[sid] = ("det", ci, int(f))
    ctx["seg_keys"] = keys
    return g


def _resample(node, src, stage_to_src):
    """Stage frame -> source frame list as a batch (ImageFromBatch per run of consecutive source frames)."""
    runs = []
    for s in stage_to_src:
        if runs and s == runs[-1][0] + runs[-1][1]:
            runs[-1][1] += 1
        elif runs and s == runs[-1][0] + runs[-1][1] - 1:   # a repeated frame (slow source)
            runs.append([s, 1])
        else:
            runs.append([s, 1])
    out = None
    for s, ln in runs:
        b = node("ImageFromBatch", image=src, batch_index=int(s), length=int(ln))
        out = b if out is None else node("ImageBatch", image1=[out, 0], image2=[b, 0])
    return [out, 0]


# ---------------------------------------------------------------------------------------------- collect
def _read_gray(entry: dict, out_dir: str) -> np.ndarray | None:
    import cv2
    p = os.path.join(out_dir, entry.get("subfolder") or "", entry["filename"])
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    if im is None:
        return None
    return im if im.ndim == 2 else im[..., 0]


def _output_dir(ctx: dict | None = None) -> str:
    od = ((ctx or {}).get("env") or {}).get("output_dir")
    if od:
        return od
    import folder_paths
    return folder_paths.get_output_directory()


def _stats(m: np.ndarray) -> dict | None:
    ys, xs = np.nonzero(m)
    if len(xs) < 6:
        return None
    h, w = m.shape
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    return {"area": int(len(xs)), "bbox": [x0, y0, x1, y1], "c": [float(xs.mean()), float(ys.mean())],
            "edge": bool(x0 <= 1 or y0 <= 1 or x1 >= w - 2 or y1 >= h - 2), "bottom": float(np.percentile(ys, 97))}


def _low(m: np.ndarray) -> np.ndarray:
    return m[LOW // 2::LOW, LOW // 2::LOW]


def collect(ctx: dict, outputs: dict, out_dir: str | None = None, reader=None) -> dict:
    """Read the packed mask PNGs back into ctx['masks']['objects'] and ctx['seg'], name each track from the
    per-concept detections (else the inventory's boxes). Returns ctx['seg']."""
    out_dir = out_dir or _output_dir(ctx)
    reader = reader or (lambda e: _read_gray(e, out_dir))
    keys = ctx.get("seg_keys") or {}
    cons = ctx.get("seg_concepts") or []
    n = int(ctx["clip"]["frames"])
    per_win: dict = {}
    dets: dict = {}   # f -> [(ci, mask)]
    for nid, key in keys.items():
        ims = sorted((outputs.get(nid) or {}).get("images") or [], key=lambda e: e["filename"])
        if key[0] == "det":
            _, ci, f = key
            for e in ims:
                im = reader(e)
                if im is not None and (im > 127).sum() >= 6:
                    dets.setdefault(f, []).append((ci, im > 127))
            continue
        _, start, grp = key
        for i, e in enumerate(ims):
            f = start + i
            if f >= n:
                break
            im = reader(e)
            if im is None:
                continue
            v = im.astype(np.uint8)
            if not v.any():
                continue
            for j in range(8):
                m = (v >> j) & 1
                if m.any():
                    per_win.setdefault(start, {}).setdefault(grp * 8 + j, {})[f] = m.astype(bool)
    seg: dict = {}
    masks = ctx.setdefault("masks", {}).setdefault("objects", {})
    for gid, track in _stitch(per_win).items():
        fr, rle, low = {}, {}, {}
        for f, m in sorted(track.items()):
            st = _stats(m)
            if st is None:
                continue
            fr[f] = st
            rle[f] = X.rle_encode(m)
            low[f] = _low(m)
        if len(fr) < 2 and not (len(fr) == 1 and n <= 2):
            continue
        concept, votes = name_track(track, dets, cons)
        oid = f"{_slug(concept)}_{gid}"
        while oid in seg:
            oid += "_b"
        seg[oid] = {"id": oid, "concept": concept, "source": cons[votes]["source"] if isinstance(votes, int) and votes < len(cons) else "sweep",
                    "frames": fr, "_low": low}
        masks[oid] = rle
    dedupe(seg, masks)
    label_from_vlm(seg, ctx.get("vlm_inventory") or {}, ctx["clip"])
    ctx["seg"] = seg
    X.note(ctx, f"layout: {len(seg)} things tracked by SAM 3.1 ({len(cons)} concepts in one multi-prompt track)")
    return seg


def name_track(track: dict, dets: dict, cons: list) -> tuple[str, int | None]:
    """The concept whose detections overlap this track most (IoU > 0.4 on the detection frames). ('object', None)
    when nothing does (label_from_vlm may still name it)."""
    score: dict = {}
    for f, lst in dets.items():
        m = track.get(f)
        if m is None:
            continue
        for ci, d in lst:
            if d.shape != m.shape:
                import cv2
                d = cv2.resize(d.astype(np.uint8), (m.shape[1], m.shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)
            inter = np.logical_and(m, d).sum()
            uni = np.logical_or(m, d).sum()
            iou = inter / uni if uni else 0.0
            if iou > 0.4:
                # A specific word beats a sweep word at equal overlap.
                w = iou + (0.1 if ci < len(cons) and cons[ci].get("source") != "sweep" else 0.0)
                score[ci] = score.get(ci, 0.0) + w
    if not score:
        return "object", None
    ci = max(score, key=score.get)
    return (cons[ci]["text"] if ci < len(cons) else "object"), ci


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "object"


def _iou_frames(a: dict, b: dict) -> float:
    fs = sorted(set(a) & set(b))
    if not fs:
        return 0.0
    vals = []
    for f in fs:
        inter = np.logical_and(a[f], b[f]).sum()
        uni = np.logical_or(a[f], b[f]).sum()
        vals.append(inter / uni if uni else 0.0)
    return float(np.mean(vals))


def _stitch(per_win: dict) -> dict:
    """{window start: {k: {f: mask}}} -> {global id: {f: mask}}: each window's tracks joined to the previous window's
    by mean IoU over the shared frames (greedy, > 0.3), else new ids."""
    out: dict = {}
    prev: dict = {}   # local k of previous window -> global id
    nxt = 0
    prev_tracks: dict = {}
    for start in sorted(per_win):
        cur = per_win[start]
        pairs = []
        for k, tr in cur.items():
            for pk, ptr in prev_tracks.items():
                s = _iou_frames(tr, ptr)
                if s > 0.3:
                    pairs.append((s, k, pk))
        pairs.sort(reverse=True)
        used_k, used_p, mapping = set(), set(), {}
        for s, k, pk in pairs:
            if k in used_k or pk in used_p:
                continue
            used_k.add(k)
            used_p.add(pk)
            mapping[k] = prev[pk]
        for k in sorted(cur):
            if k not in mapping:
                mapping[k] = nxt
                nxt += 1
            gid = mapping[k]
            dst = out.setdefault(gid, {})
            for f, m in cur[k].items():
                dst[f] = m if f not in dst else (dst[f] | m)
        prev, prev_tracks = mapping, cur
    return out


def _overlap(a: dict, b: dict) -> float:
    """Mean of |A∩B| / min(|A|, |B|) over the low-res frames both appear in (0 when they never share a frame)."""
    fs = sorted(set(a["_low"]) & set(b["_low"]))
    if not fs:
        return 0.0
    vals = []
    for f in fs:
        ma, mb = a["_low"][f], b["_low"][f]
        sa, sb = ma.sum(), mb.sum()
        if not sa or not sb:
            continue
        vals.append(np.logical_and(ma, mb).sum() / min(sa, sb))
    return float(np.mean(vals)) if vals else 0.0


def _strength(o: dict) -> tuple:
    rank = {"user": 3, "vlm": 2, "sweep": 1}.get(o.get("source"), 0)
    areas = [s["area"] for s in o["frames"].values()]
    return (rank, len(o["frames"]), float(np.median(areas)) if areas else 0.0)


GENERIC = {"furniture", "vehicle", "animal", "plant", "object", "thing", "box", "sign", "pole"}


def dedupe(seg: dict, masks: dict | None = None, thresh: float = 0.6) -> list[str]:
    """Drop the weaker of two tracks that overlap above `thresh` (a sofa found as 'sofa' and as 'furniture').
    A generic sweep word never beats a specific name. Returns the dropped ids."""
    ids = sorted(seg, key=lambda i: _strength(seg[i]), reverse=True)
    keep: list = []
    dropped = []
    for i in ids:
        o = seg[i]
        dup = None
        for k in keep:
            # A part inside a bigger thing (a book on a shelf, a wheel of a car) is kept: only near-equal sizes merge.
            ov = _overlap(o, seg[k])
            if ov <= thresh:
                continue
            ra = np.median([s["area"] for s in o["frames"].values()]) / max(1.0, np.median([s["area"] for s in seg[k]["frames"].values()]))
            if 0.4 <= ra <= 2.5:
                dup = k
                break
        if dup is None:
            keep.append(i)
            continue
        k = dup
        if seg[k]["concept"] in GENERIC and o["concept"] not in GENERIC:   # a specific name beats 'furniture'
            seg[k]["concept"] = o["concept"]
            seg[k]["source"] = o["source"]
        seg[k].setdefault("aka", []).append(o["concept"])
        dropped.append(i)
    for i in dropped:
        seg.pop(i, None)
        if masks is not None:
            masks.pop(i, None)
    return dropped


def label_from_vlm(seg: dict, inv: dict, clip: dict) -> None:
    """Give each track the inventory item whose box (on the frame the model read) overlaps it best: its name,
    colour, material and moving flag. A generic concept ('furniture') takes the item's kind."""
    items = [it for it in inv.get("items") or [] if it.get("bbox") and it.get("frame") is not None]
    pw, ph = clip["pw"], clip["ph"]
    for o in seg.values():
        best, bs = None, 0.0
        for it in items:
            st = o["frames"].get(int(it["frame"]))
            if st is None:
                continue
            b = [it["bbox"][0] / 1000 * pw, it["bbox"][1] / 1000 * ph, it["bbox"][2] / 1000 * pw, it["bbox"][3] / 1000 * ph]
            s = _box_iou(st["bbox"], b)
            k = _noun(it.get("kind"))
            if k and (k == o["concept"] or k in o.get("aka", [])):
                s += 0.15
            if s > bs:
                best, bs = it, s
        if best is not None and bs > 0.3:
            o["item"] = {k: best.get(k) for k in ("name", "kind", "material", "color", "moving")}
            if o["concept"] in GENERIC and _noun(best.get("kind")) and _noun(best.get("kind")) not in NOT_THINGS:
                o["concept"] = _noun(best.get("kind"))


def _box_iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / ua) if ua > 0 else 0.0


# ---------------------------------------------------------------------------------------------- unexplained
def coverage(ctx: dict, f: int, extra=None) -> np.ndarray:
    """Low-res bool map of frame f explained by an object, a person, the sky or `extra` (fitted planes)."""
    pw, ph = ctx["clip"]["pw"], ctx["clip"]["ph"]
    cov = np.zeros((len(range(LOW // 2, ph, LOW)), len(range(LOW // 2, pw, LOW))), bool)
    for o in (ctx.get("seg") or {}).values():
        m = o.get("_low", {}).get(f)
        if m is not None:
            cov |= m[:cov.shape[0], :cov.shape[1]]
    ppl = X.mask_at(ctx, f, groups=("people",))
    if ppl is not None:
        cov |= _low(ppl)[:cov.shape[0], :cov.shape[1]]
    sky = (ctx.get("sky") or {}).get(f)
    if sky is not None:
        cov |= _resize_low(sky > 0.5, cov.shape)
    if callable(extra):
        extra = extra(f, cov.shape)
    if extra is not None:
        cov |= _resize_low(extra, cov.shape)
    return cov


def _resize_low(m: np.ndarray, shape) -> np.ndarray:
    import cv2
    return cv2.resize(m.astype(np.uint8), (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)


def unexplained(ctx: dict, plane_cover=None, min_share: float = 0.005) -> dict:
    """{share: mean unexplained share over the samples, regions: [{share, bbox, near}]} and a note per region."""
    import cv2
    samples = ctx.get("samples") or sorted((ctx.get("depth") or {}).keys()) or [0]
    shares, regions = [], []
    inv = ctx.get("vlm_inventory") or {}
    for f in samples:
        cov = coverage(ctx, f, plane_cover.get(f) if isinstance(plane_cover, dict) else plane_cover)
        un = ~cov
        shares.append(float(un.mean()))
        n, lab, st, _ = cv2.connectedComponentsWithStats(un.astype(np.uint8), connectivity=8)
        for i in range(1, n):
            share = st[i, cv2.CC_STAT_AREA] / un.size
            if share < min_share:
                continue
            x, y, w, h = st[i, :4]
            regions.append({"f": int(f), "share": float(share),
                            "bbox": [int(x * LOW), int(y * LOW), int((x + w) * LOW), int((y + h) * LOW)]})
    # One note per place (regions on several samples merge by box overlap).
    merged: list = []
    for r in sorted(regions, key=lambda r: -r["share"]):
        if any(_box_iou(r["bbox"], m["bbox"]) > 0.3 for m in merged):
            continue
        merged.append(r)
    for r in merged[:8]:
        r["near"] = _near_name(r["bbox"], inv, ctx["clip"])
        X.note(ctx, f"layout: unidentified {r['near']}, {100 * r['share']:.1f} % of frame {r['f']} "
                    "(not rebuilt; add it by name under Advanced > objects to find)", "warn")
    out = {"share": float(np.mean(shares)) if shares else 0.0, "per_frame": shares, "regions": merged}
    ctx["unexplained"] = out
    return out


def _near_name(bbox, inv: dict, clip: dict) -> str:
    pw, ph = clip["pw"], clip["ph"]
    best, bs = None, 0.0
    for it in inv.get("items") or []:
        b = it.get("bbox")
        if not b:
            continue
        bb = [b[0] / 1000 * pw, b[1] / 1000 * ph, b[2] / 1000 * pw, b[3] / 1000 * ph]
        s = _box_iou(bbox, bb)
        if s > bs:
            best, bs = it, s
    if best is not None and bs > 0.2:
        return f"object at the {best.get('name') or best.get('kind')}"
    cx = (bbox[0] + bbox[2]) / 2 / pw
    cy = (bbox[1] + bbox[3]) / 2 / ph
    hz = "left" if cx < 0.33 else "right" if cx > 0.67 else "centre"
    vt = "top" if cy < 0.33 else "bottom" if cy > 0.67 else "middle"
    return f"region at the {vt} {hz} of the frame"
