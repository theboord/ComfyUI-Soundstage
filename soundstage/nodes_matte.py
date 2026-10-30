"""Per-object mattes from the stage's ID pass.

The stage renders every object in its own flat colour (scene_json.id_colors). Because LTX
Layout-To-Render keeps the staged layout, those silhouettes line up with the final shot closely
enough to cut layers; `grow` and `feather` give the matte some slack for the generated detail
(hair, clothes) that extends past the clay mannequin.
"""
import json

import torch
import torch.nn.functional as F

from comfy_api.latest import IO


def _palette(scene: dict) -> tuple[list[str], torch.Tensor, list[str]]:
    ids = list((scene.get("id_colors") or {}).keys())
    cols = torch.tensor([scene["id_colors"][i] for i in ids], dtype=torch.float32) / 255.0 if ids else torch.zeros(0, 3)
    names = []
    for i in ids:
        a = next((x for x in scene.get("actors", []) if x.get("id") == i), {})
        names.append(a.get("name") or i)
    return ids, cols, names


def matte_from_id(id_pass: torch.Tensor, color: torch.Tensor, palette: torch.Tensor) -> torch.Tensor:
    """Nearest-colour classification (robust to antialiased edges). id_pass: NxHxWx3 → NxHxW."""
    pal = torch.cat([torch.zeros(1, 3), palette], 0)  # 0 = black background
    d = ((id_pass[..., None, :] - pal[None, None, None]) ** 2).sum(-1)  # N,H,W,K
    label = d.argmin(-1)
    target = int(((palette - color[None]) ** 2).sum(-1).argmin()) + 1
    return (label == target).float()


def grow_feather(mask: torch.Tensor, grow_px: int, feather_px: int) -> torch.Tensor:
    m = mask[:, None]
    if grow_px > 0:
        m = F.max_pool2d(m, kernel_size=2 * grow_px + 1, stride=1, padding=grow_px)
    if feather_px > 0:
        k = 2 * feather_px + 1
        m = F.avg_pool2d(F.pad(m, (feather_px,) * 4, mode="replicate"), kernel_size=k, stride=1)
    return m[:, 0].clamp(0, 1)


class SoundstageActorMatte(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageActorMatte",
            display_name="Soundstage · Actor Matte",
            category="Soundstage",
            description="Matte for one stage object (by name or index) from the stage's ID pass, sized to the "
                        "final frames. 'background' gives everything that isn't an object.",
            inputs=[
                IO.Image.Input("id_pass"),
                IO.String.Input("scene_json", force_input=True),
                IO.String.Input("object", default="1", tooltip="Object name (e.g. 'Man'), id, 1-based index, or 'background'."),
                IO.Image.Input("match_frames", optional=True, tooltip="Final frames: the matte is resized and retimed to these."),
                IO.Int.Input("grow", default=6, min=0, max=64, tooltip="Pixels to expand the clay silhouette."),
                IO.Int.Input("feather", default=4, min=0, max=64),
            ],
            outputs=[IO.Mask.Output(display_name="mask"), IO.String.Output(display_name="name")],
        )

    @classmethod
    def execute(cls, id_pass, scene_json, object="1", match_frames=None, grow=6, feather=4) -> IO.NodeOutput:
        scene = json.loads(scene_json) if scene_json else {}
        ids, pal, names = _palette(scene)
        obj = (object or "").strip()
        if obj.lower() == "background":
            if len(ids):
                fg = torch.stack([matte_from_id(id_pass, pal[i], pal) for i in range(len(ids))]).amax(0)
            else:
                fg = torch.zeros(id_pass.shape[:3])
            mask, name = 1 - fg, "background"
        else:
            if not ids:
                raise ValueError("This scene has no ID colours. Re-run the stage (rung 1) with the current Soundstage.")
            if obj.isdigit():
                idx = int(obj) - 1
            else:
                low = obj.lower()
                idx = next((i for i, (k, n) in enumerate(zip(ids, names)) if low in (k.lower(), n.lower())), -1)
            if not 0 <= idx < len(ids):
                raise ValueError(f"No stage object '{obj}'. Objects: {', '.join(names)}")
            mask, name = matte_from_id(id_pass, pal[idx], pal), names[idx]
        if match_frames is not None:
            n, h, w = match_frames.shape[0], match_frames.shape[1], match_frames.shape[2]
            mask = F.interpolate(mask[:, None], size=(h, w), mode="bilinear", align_corners=False)[:, 0]
            if mask.shape[0] != n:
                idx_t = torch.linspace(0, mask.shape[0] - 1, n).round().long()
                mask = mask[idx_t]
        if obj.lower() == "background":
            mask = 1 - grow_feather(1 - mask, grow, feather)
        else:
            mask = grow_feather(mask, grow, feather)
        return IO.NodeOutput(mask, name)


class SoundstageMatchSize(IO.ComfyNode):
    """Resize (and retime) a frame batch to match another, e.g. the stage depth pass to the final video."""

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageMatchSize",
            display_name="Soundstage · Match Size",
            category="Soundstage",
            inputs=[IO.Image.Input("images"), IO.Image.Input("reference")],
            outputs=[IO.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, images, reference) -> IO.NodeOutput:
        n, h, w = reference.shape[0], reference.shape[1], reference.shape[2]
        out = F.interpolate(images.movedim(-1, 1), size=(h, w), mode="bilinear", align_corners=False).movedim(1, -1)
        if out.shape[0] != n:
            out = out[torch.linspace(0, out.shape[0] - 1, n).round().long()]
        return IO.NodeOutput(out.clamp(0, 1))


NODES = [SoundstageActorMatte, SoundstageMatchSize]
