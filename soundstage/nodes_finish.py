"""Soundstage · Film Finish node (Milestone 21): the Cut render's finishing pass on any IMAGE batch (a final's frames).

Lens distortion, chromatic aberration, halation, vignette and grain (last), optional 2-frame motion blur, all stock
ffmpeg filters (soundstage/finish.py). Same size and frame count out as in.
"""
from __future__ import annotations

import numpy as np
import torch

from comfy_api.latest import IO

from .finish import PRESETS, finish_frames


class SoundstageFilmFinish(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFilmFinish",
            display_name="Soundstage · Film Finish",
            category="Soundstage/Finish",
            description="'Film' a render so it stops reading as CG: a slight barrel distortion, colour fringe toward the "
                        "edges, red halation round highlights, vignette, and grain last (a new pattern every frame). "
                        "Presets: Off · Subtle · 35mm · Anamorphic. CPU (ffmpeg), a few seconds a shot.",
            inputs=[
                IO.Image.Input("images"),
                IO.Combo.Input("preset", options=list(PRESETS), default="subtle"),
                IO.Boolean.Input("motion_blur", default=False, tooltip="Mix each frame with the next (a longer shutter) for fast action."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, advanced=True),
                IO.Int.Input("seed", default=1, min=0, max=2147483647, advanced=True, tooltip="The grain pattern's seed."),
            ],
            outputs=[IO.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, images, preset="subtle", motion_blur=False, fps=24.0, seed=1) -> IO.NodeOutput:
        if (not PRESETS.get(preset) and not motion_blur) or images.shape[0] == 0:
            return IO.NodeOutput(images)
        n, h, w = images.shape[0], images.shape[1], images.shape[2]
        arr = (images[..., :3].clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
        pad = (h % 2, w % 2)   # the filters want even sizes
        if any(pad):
            arr = np.pad(arr, ((0, 0), (0, pad[0]), (0, pad[1]), (0, 0)), mode="edge")
        out = finish_frames(arr, preset, seed=seed, motion_blur=motion_blur or None, fps=fps)[:, :h, :w]
        return IO.NodeOutput(torch.from_numpy(out.astype(np.float32) / 255.0).to(images.dtype))


NODES = [SoundstageFilmFinish]
