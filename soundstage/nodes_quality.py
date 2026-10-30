"""Soundstage · Quality: one node that turns two App controls into the LTX-2.5 Layout-to-Render knobs.

Inputs  motion_freedom (0..1), quality (Draft | Final HQ), the clay guide video, the Look's motion prompt and the
        stage scene JSON.
Outputs the (softened) guide video, IC-LoRA guide strengths for stage 1 and 2 (always 1.0: below 1 LTX renders the
        clay itself), the two sigma schedules, the motion prompt (HQ appends subject-aware physical-motion language)
        and the IC-LoRA model strength.

At motion_freedom 0 + Draft every output is exactly today's value and the guide tensor passes through untouched,
so the App renders bit-for-bit what it rendered before. See soundstage/quality.py for the mapping.
"""
from __future__ import annotations

import json

import torch
from comfy_api.latest import IO

from . import quality as Q

QUALITIES = ["Draft", "Final HQ"]


def _gaussian_blur(images: torch.Tensor, radius: int) -> torch.Tensor:
    """Separable Gaussian blur on a [B, H, W, C] image batch (radius in px, sigma = radius / 2)."""
    if radius <= 0:
        return images
    sigma = max(radius / 2.0, 0.5)
    x = torch.arange(-radius, radius + 1, dtype=torch.float32, device=images.device)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    k = (k / k.sum()).to(images.dtype)
    c = images.shape[-1]
    t = images.permute(0, 3, 1, 2)  # B C H W
    t = torch.nn.functional.pad(t, (radius, radius, radius, radius), mode="replicate")
    t = torch.nn.functional.conv2d(t, k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    t = torch.nn.functional.conv2d(t, k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)
    return t.permute(0, 2, 3, 1).clamp(0, 1)


class SoundstageQuality(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageQuality",
            display_name="Soundstage · Quality (motion freedom)",
            category="Soundstage",
            description="How literally LTX follows the clay previz, and Draft vs Final HQ sampling. 0 + Draft = the "
                        "exact previous behaviour.",
            inputs=[
                IO.Float.Input("motion_freedom", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="0 = follow the blocking exactly. Higher = a looser, softer clay guide so LTX "
                                       "redraws stiff previz motion (gait, limbs, weight) while keeping composition "
                                       "and camera. 0.3-0.5 is a good range for animals and action."),
                IO.Combo.Input("quality", options=QUALITIES, default="Draft",
                               tooltip="Draft = today's 8 + 3 distilled steps. Final HQ = 18 + 12 steps on the same "
                                       "schedule plus physical-motion language for the cast in the prompt."),
                IO.Image.Input("guide", tooltip="The stage clay frames that steer LTX (IC-LoRA guide)."),
                IO.String.Input("motion_prompt", multiline=True, force_input=True),
                IO.String.Input("scene_json", multiline=True, force_input=True, optional=True),
            ],
            outputs=[
                IO.Image.Output("out_guide"),
                IO.Float.Output("guide_strength_1"),
                IO.Float.Output("guide_strength_2"),
                IO.String.Output("sigmas_1"),
                IO.String.Output("sigmas_2"),
                IO.String.Output("out_motion_prompt"),
                IO.Float.Output("lora_strength"),
            ],
        )

    @classmethod
    def execute(cls, motion_freedom, quality, guide, motion_prompt, scene_json=None) -> IO.NodeOutput:
        hq = quality == "Final HQ"
        k = Q.knobs(motion_freedom, hq)
        prompt = motion_prompt
        if hq and scene_json:
            try:
                scene = json.loads(scene_json)
                extra = Q.motion_prompt(scene.get("scene", scene) if isinstance(scene, dict) else {})
            except (json.JSONDecodeError, TypeError, AttributeError):
                extra = ""
            if extra:
                prompt = f"{motion_prompt.rstrip()} {extra}".strip()
        return IO.NodeOutput(_gaussian_blur(guide, k["guide_blur"]), k["guide_strength_1"], k["guide_strength_2"],
                             k["sigmas_1"], k["sigmas_2"], prompt, k["lora_strength"])


NODES = [SoundstageQuality]
