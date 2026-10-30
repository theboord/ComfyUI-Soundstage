"""One matte per stage actor from the stage's ID pass (pure torch, no ComfyUI imports).

Same classification as nodes_matte.SoundstageActorMatte (nearest stage ID colour, black = background,
then grow/feather and resize/retime to the final frames), but every actor is labelled in one pass,
so a scene with four actors costs one classification instead of four. Riders (actors with a
mount_id) have their own ID colour, so they come out as their own layer, separate from the horse.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F


def palette(scene: dict) -> tuple[list[str], torch.Tensor]:
    ids = list((scene.get("id_colors") or {}).keys())
    cols = torch.tensor([scene["id_colors"][i] for i in ids], dtype=torch.float32) / 255.0 if ids else torch.zeros(0, 3)
    return ids, cols


def labels(id_pass: torch.Tensor, pal: torch.Tensor, chunk: int = 8) -> torch.Tensor:
    """NxHxWx3 ID pass -> NxHxW int labels: 0 = background, k = actor k (1-based, palette order)."""
    full = torch.cat([torch.zeros(1, 3), pal.float()], 0)
    out = []
    for s in range(0, id_pass.shape[0], chunk):
        f = id_pass[s:s + chunk, ..., :3].float().cpu()
        out.append(((f[..., None, :] - full) ** 2).sum(-1).argmin(-1))
    return torch.cat(out, 0)


def grow_feather(mask: torch.Tensor, grow_px: int, feather_px: int) -> torch.Tensor:
    m = mask[:, None].float()
    if grow_px > 0:
        m = F.max_pool2d(m, kernel_size=2 * grow_px + 1, stride=1, padding=grow_px)
    if feather_px > 0:
        k = 2 * feather_px + 1
        m = F.avg_pool2d(F.pad(m, (feather_px,) * 4, mode="replicate"), kernel_size=k, stride=1)
    return m[:, 0].clamp(0, 1)


def fit_frames(mask: torch.Tensor, n: int, h: int, w: int) -> torch.Tensor:
    """Resize a NxHxW mask to h x w and retime it to n frames (nearest frame)."""
    if mask.shape[1:] != (h, w):
        mask = F.interpolate(mask[:, None].float(), size=(h, w), mode="bilinear", align_corners=False)[:, 0]
    if mask.shape[0] != n:
        mask = mask[torch.linspace(0, mask.shape[0] - 1, n).round().long()]
    return mask


def _median_depth(depth: torch.Tensor | None, sel: torch.Tensor) -> float | None:
    """Median stage depth value under a boolean NxHxW selection (stage depth: near = white)."""
    if depth is None or not bool(sel.any()):
        return None
    d = depth[..., 0] if depth.dim() == 4 else depth
    if d.shape != sel.shape:
        d = fit_frames(d.float(), sel.shape[0], sel.shape[1], sel.shape[2])
    return float(d[sel].float().median())


def actor_layers(scene: dict, id_pass: torch.Tensor, frames: torch.Tensor, depth: torch.Tensor | None = None,
                 grow: int = 6, feather: int = 4) -> list[dict]:
    """Background + one entry per stage actor that is visible somewhere in the shot.

    Returns [{name, id, z, kind, mask (n x h x w at the final size, float16), coverage, mount_id}],
    background first. z: background 0, then actors far -> near in steps of 10 (median stage depth
    under each matte, else stage order); a rider sits directly above its mount.
    """
    ids, pal = palette(scene)
    if not ids:
        raise ValueError("This scene has no ID colours. Re-run the stage (rung 1) with the current Soundstage.")
    actors = {a.get("id"): a for a in scene.get("actors", [])}
    lab = labels(id_pass, pal)
    n, h, w = frames.shape[0], frames.shape[1], frames.shape[2]

    found = []
    for k, aid in enumerate(ids):
        sel = lab == (k + 1)
        cov = float(sel.float().mean())
        if cov <= 0.0:
            continue                                   # never on screen: no layer
        a = actors.get(aid, {})
        nearness = _median_depth(depth, sel)           # stage depth: higher = nearer
        found.append({"id": aid, "name": a.get("name") or aid, "kind": "character", "mount_id": a.get("mount_id"),
                      "coverage": round(cov, 6), "order": k, "nearness": nearness, "sel": sel})

    # Far -> near, then pull each rider to just above its mount.
    found.sort(key=lambda e: (e["nearness"] if e["nearness"] is not None else 0.0, e["order"]))
    ordered = [e for e in found if not (e["mount_id"] and any(f["id"] == e["mount_id"] for f in found))]
    for e in [e for e in found if e not in ordered]:
        host = next(i for i, f in enumerate(ordered) if f["id"] == e["mount_id"])
        while host + 1 < len(ordered) and ordered[host + 1].get("mount_id") == e["mount_id"]:
            host += 1
        ordered.insert(host + 1, e)

    fg = torch.zeros_like(lab, dtype=torch.float32)
    out = []
    for rank, e in enumerate(ordered):
        m = e.pop("sel").float()
        fg = torch.maximum(fg, m)
        m = grow_feather(fit_frames(m, n, h, w), grow, feather)
        out.append({**{k: v for k, v in e.items() if k not in ("order", "nearness")}, "z": 10 * (rank + 1),
                    "mask": m.half()})
    bg = 1 - grow_feather(fit_frames(fg, n, h, w), grow, feather)
    return [{"id": "background", "name": "background", "kind": "background", "mount_id": None, "z": 0,
             "coverage": round(float((fg == 0).float().mean()), 6), "mask": bg.half()}] + out
