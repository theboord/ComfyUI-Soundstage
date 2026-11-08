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


def people_masks(breakdown: dict, depths, times, duration: float) -> dict:
    """{person_i: {sample_i: rle}} from the read's person boxes (interpolated start -> end) and each sample's depth: the
    route has no segmentation, so the person is the box's pixels near the body's depth (wardrobe.person_mask_from_depth)."""
    from . import backdrop as BD
    from . import wardrobe as W
    out: dict = {}
    for j, o in enumerate(breakdown.get("objects") or []):
        if o.get("kind") != "person":
            continue
        per = {}
        for i, d in enumerate(depths):
            bb = _box_at(o, min(1.0, max(0.0, times[i] / max(duration, 1e-6))) if times else 0.0)
            if not bb:
                continue
            x0, y0, x1, y1 = (v / 1000 for v in bb)
            gx, gy = 0.15 * (x1 - x0), 0.05 * (y1 - y0)
            m = W.person_mask_from_depth(d, [x0 - gx, y0 - gy, x1 + gx, y1 + gy], rel=0.35)
            if m is not None and m.any():
                per[i] = BD.rle_encode(m)
        if per:
            out[f"p{j}"] = per
    return out


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
          tag: str = "scan", out: dict | None = None, use_planes: bool = True) -> dict:
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
    masks = people_masks(breakdown, depths, times, duration)
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
    depth0 = np.asarray(depths[0], np.float32) * float(scales[0]) * mpu
    h, w = depth0.shape
    tri = SW.triage_blocks(scene["actors"], poses[0], A, b, K, (w, h), depth0)
    stats.update(dropped=tri["dropped"], worded=tri["worded"])
    if tri["dropped"]:
        notes.append(f"set: dropped {len(tri['dropped'])} block(s) the scan already shows: {', '.join(tri['dropped'][:6])}")
    if tri["worded"]:
        notes.append(f"set: {len(tri['worded'])} block(s) stand in front of the scan; the Look text names each by its kind")
    return stats
