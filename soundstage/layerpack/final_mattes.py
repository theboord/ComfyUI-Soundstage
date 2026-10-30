"""Mattes cut from the FINAL frames, not from the clay.

The stage's ID pass is the clay's silhouette: LTX moves hair, limbs, dust and edges, so a clay matte never sits
cleanly on the generated pixels. Here SAM 3.1 tracks every person/animal/vehicle kind on the stage across the
final frames, and each stage actor takes the track that overlaps its clay silhouette best (the clay says WHO,
SAM 3 says exactly WHERE). Frames where the track loses the actor fall back to the clay matte. Props without
a SAM-friendly name keep the clay matte.

Edges: ComfyUI core's Remove Background (BiRefNet) gives a soft alpha with real hair/dust edges; each actor's matte is
that soft alpha inside its (slightly grown) SAM 3 track, so SAM decides WHO and BiRefNet decides the EDGE.

`assign_tracks` and `refine` are pure torch (tested on synthetic masks); `track_final` runs SAM 3.1 inside the
executing node, i.e. in the ComfyUI queue worker.
"""
from __future__ import annotations

import torch

from .actors import fit_frames, grow_feather

PEOPLE = {"man", "woman", "child", "person", "boy", "girl"}
TRACKABLE = {"horse": "horse", "dog": "dog", "cat": "cat", "car": "car", "truck": "truck", "bicycle": "bicycle",
             "motorcycle": "motorcycle", "cow": "cow", "bird": "bird", "boat": "boat"}


def prompts_for(scene: dict) -> list[str]:
    """SAM 3 text prompts for the kinds on stage: 'person' for people, the noun for animals/vehicles."""
    out = []
    for a in scene.get("actors") or []:
        k = (a.get("kind") or "").lower()
        p = "person" if k in PEOPLE else TRACKABLE.get(k)
        if p and p not in out:
            out.append(p)
    return out


def trackable(actor: dict) -> bool:
    k = (actor.get("kind") or "").lower()
    return k in PEOPLE or k in TRACKABLE


def assign_tracks(clay: dict[str, torch.Tensor], objs: torch.Tensor, min_iou: float = 0.05) -> dict[str, tuple[int, float]]:
    """clay: {actor_id: [N,H,W] 0..1}; objs: [N,K,H,W] 0..1 SAM tracks. Greedy one-to-one by IoU over the shot."""
    if objs.shape[1] == 0 or not clay:
        return {}
    obin = objs > 0.5
    scores = []
    for aid, m in clay.items():
        mb = m > 0.5
        for k in range(objs.shape[1]):
            t = obin[:, k]
            inter = (mb & t).sum().item()
            union = (mb | t).sum().item()
            if union and inter:
                scores.append((inter / union, aid, k))
    scores.sort(reverse=True)
    taken_a, taken_k, out = set(), set(), {}
    for iou, aid, k in scores:
        if iou < min_iou or aid in taken_a or k in taken_k:
            continue
        out[aid] = (k, round(iou, 4))
        taken_a.add(aid)
        taken_k.add(k)
    return out


def refine(entries: list[dict], objs: torch.Tensor, scene: dict, grow: int = 2, feather: int = 2,
           alpha: torch.Tensor | None = None) -> list[dict]:
    """Replace each trackable actor's clay matte with its SAM 3 track (per-frame clay fallback), rebuild the
    background as everything no layer covers, and note the matte source on each entry."""
    actors = {a.get("id"): a for a in scene.get("actors") or []}
    n, h, w = entries[0]["mask"].shape if entries else (0, 0, 0)
    if objs.numel():
        objs = fit_frames(objs.flatten(0, 1), n * objs.shape[1], h, w).view(n, objs.shape[1], h, w) \
            if objs.shape[0] == n else objs
    cand = {e["id"]: e["mask"].float() for e in entries if e["kind"] != "background" and trackable(actors.get(e["id"], {}))}
    pick = assign_tracks(cand, objs) if objs.numel() else {}
    union = torch.zeros(n, h, w)
    for e in entries:
        if e["kind"] == "background":
            continue
        if e["id"] in pick:
            k, iou = pick[e["id"]]
            t = objs[:, k].float()
            lost = t.flatten(1).amax(1) < 0.5                       # frames where SAM 3 lost the actor
            mt = grow_feather(t, grow, feather)
            if alpha is not None:
                # BiRefNet's soft edge, limited to this actor's region (grown so hair/dust edges survive).
                region = grow_feather(t, max(6, grow * 3), max(4, feather * 2))
                core = 1 - torch.nn.functional.max_pool2d(1 - (t > 0.5).float()[:, None], 7, 1, 3)[:, 0]  # eroded 3 px
                mt = torch.maximum(alpha * region, core)          # solid inside the track, BiRefNet's soft edge outside
            m = torch.where(lost[:, None, None], e["mask"].float(), mt)
            e["mask"] = m.half()
            e["matte"] = f"SAM 3.1 track {k} (IoU {iou:.2f}" + (f", clay on {int(lost.sum())} frames)" if lost.any() else ")")
        elif alpha is not None:
            region = grow_feather((e["mask"].float() > 0.5).float(), 10, 6)
            others = torch.zeros(n, h, w)
            for kk, _ in pick.values():
                others = torch.maximum(others, (objs[:, kk] > 0.5).float())
            m = (alpha * region) * (1 - others)
            e["mask"] = torch.where(m.flatten(1).amax(1)[:, None, None] > 0.2, m, e["mask"].float()).half()
            e["matte"] = "BiRefNet edge in the stage silhouette"
        else:
            e["matte"] = "stage ID pass"
        union = torch.maximum(union, e["mask"].float())
    for e in entries:
        if e["kind"] == "background":
            e["mask"] = (1 - union).clamp(0, 1).half()
            e["matte"] = "inverse of all layers"
    return entries


def soft_alpha(images: torch.Tensor, model_name: str = "birefnet.safetensors", chunk: int = 16) -> torch.Tensor:
    """ComfyUI core Remove Background (BiRefNet) over every frame -> [N,H,W] soft alpha (1 = foreground)."""
    from comfy_extras import nodes_bg_removal as BG

    def first(res):
        return (getattr(res, "result", None) or getattr(res, "args", None) or res)[0]

    model = first(BG.LoadBackgroundRemovalModel.execute(bg_removal_name=model_name))
    outs = [first(BG.RemoveBackground.execute(bg_removal_model=model, image=images[i:i + chunk])).float().cpu()
            for i in range(0, images.shape[0], chunk)]
    a = torch.cat(outs, 0)
    if a.shape[-2:] != images.shape[1:3]:
        a = torch.nn.functional.interpolate(a[:, None], size=images.shape[1:3], mode="bilinear", align_corners=False)[:, 0]
    return a.clamp(0, 1)


def track_final(images: torch.Tensor, prompts: list[str], ckpt: str, threshold: float = 0.45, max_objects: int = 8,
                detect_interval: int = 2) -> torch.Tensor:
    """SAM 3.1 video tracks of every prompt over the final frames -> [N,K,H,W] float (K may be 0)."""
    import nodes
    from comfy_extras import nodes_sam3 as S3

    from comfy.ldm.sam3.tracker import unpack_masks

    model, clip = nodes.CheckpointLoaderSimple().load_checkpoint(ckpt)[:2]
    n, h, w = images.shape[0], images.shape[1], images.shape[2]
    found = []
    # One tracking pass per prompt: a combined "person + horse" conditioning only tracked the horses.
    for p in prompts:
        cond = nodes.CLIPTextEncode().encode(clip, p)[0]
        thr = min(float(threshold), 0.35) if p == "person" else float(threshold)   # small, backlit riders
        res = S3.SAM3_VideoTrack.execute(images=images, model=model, conditioning=cond, detection_threshold=thr,
                                         max_objects=int(max_objects), detect_interval=int(detect_interval))
        track = (getattr(res, "result", None) or getattr(res, "args", None) or res)[0]
        packed = track.get("packed_masks")
        if packed is None or packed.shape[1] == 0:
            continue
        objs = torch.stack([unpack_masks(packed[:, i]).float() for i in range(packed.shape[1])], 1)
        if objs.shape[-2:] != (h, w):
            objs = torch.nn.functional.interpolate(objs, size=(h, w), mode="bilinear", align_corners=False)
        found.append(objs.cpu())
    return torch.cat(found, 1) if found else torch.zeros(n, 0, h, w)


def conform_depth(depth: torch.Tensor, layers, eps: float = 0.02) -> torch.Tensor:
    """Re-shape the stage depth pass to the final-frame mattes.

    The stage depth is rendered from the clay, so its silhouettes are clay silhouettes. Here each actor's depth is
    painted inside its FINAL matte (soft edge, front layers last): where clay and matte overlap the clay's own depth
    detail is kept, elsewhere the actor's median clay depth fills the matte. Clay that no matte covers is replaced by
    the row's background depth (floor gradient / sky). depth: [N,H,W,C] 0..1 (near = white); layers: pack layers.
    """
    if depth.ndim == 3:
        depth = depth[..., None]
    n, h, w = depth.shape[:3]
    d = depth[..., 0].float()
    acts = sorted([l for l in layers if l.kind != "background" and l.mask is not None], key=lambda l: l.z)
    if not acts:
        return depth
    masks = [fit_frames(torch.as_tensor(l.mask).float(), n, h, w).clamp(0, 1) for l in acts]
    union = torch.stack(masks).amax(0) > 0.5
    row = d.median(dim=2, keepdim=True).values                      # first guess: actors are a minority of the row
    clay = d > row + eps                                             # the clay figures stand nearer than the ground
    bg_px = torch.where(clay | union, torch.full_like(d, float("nan")), d)
    row2 = torch.nanmedian(bg_px, dim=2, keepdim=True).values
    row = torch.where(torch.isnan(row2), row, row2)
    out = row.expand(n, h, w).clone()
    for m in masks:
        hard = m > 0.5
        near = grow_feather(hard.float(), 12, 0) > 0.5
        sel = torch.where(near & clay, d, torch.full_like(d, float("nan")))
        v = torch.nanmedian(sel.flatten(1), dim=1).values               # this actor's distance, per frame
        vmax = torch.where(near, d, torch.zeros_like(d)).flatten(1).amax(1)
        v = torch.where(torch.isnan(v), vmax, v)[:, None, None]
        body = torch.where(hard & clay, d, v.expand(n, h, w))         # keep clay detail where the shapes agree
        out = out * (1 - m) + body * m
    return out[..., None].expand(n, h, w, depth.shape[-1]).clamp(0, 1).to(depth.dtype)
