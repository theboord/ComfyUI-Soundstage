"""Refocus's one queued graph (API prompt JSON, no ComfyUI imports; checked in tests/test_refocus.py).

depth_prompt  the take (a clip's working plate at its own frame rate, every frame; or a still) -> Depth Anything 3 mono
              -> SoundstageDA3Export (the model and export node Video -> Stage and Reshoot use; nothing to download).
"""
from __future__ import annotations

from ..loop.graphs import Prompt

DA3_RESOLUTION = 504


def depth_prompt(source: str, model: str, name: str, *, still: bool = False, resolution: int = DA3_RESOLUTION) -> dict:
    g = Prompt("r")
    if still:
        img = g.node("SoundstageImageLoad", source=source).out(0)
    else:
        # fps 0 = the clip's own rate, every frame (the plate is already held out to 8k+1, so the loader trims nothing)
        img = g.node("SoundstageClipLoad", source=source, fps=0.0, start_frame=0, max_frames=0).out(0)
    m = g.node("LoadDA3Model", model_name=model, weight_dtype="default").out(0)
    geo = g.node("DA3Inference", da3_model=m, image=img, mode="mono", resize_method="upper_bound_resize",
                 resolution=int(resolution)).out(0)
    g.node("SoundstageDA3Export", id="npz", da3_geometry=geo, name=name)
    return g.json()
