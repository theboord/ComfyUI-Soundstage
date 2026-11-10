"""Soundstage Canvas: the touched-up look still from the stage widget's Canvas tab.

SoundstageCanvasImage  image (input/-relative path the Canvas tab writes, e.g. "soundstage/look_still_ab12.png";
                       or a ComfyUI annotated name "look_00010.png [output]" / "x.png [temp]", which is how ⑤ Motion
                       hands the video the exact frame picked in ④ Frame) -> IMAGE (RGB). Sits behind the App's lazy "Use touched-up still" switch, so with the switch
                       off it is never run. A plain LoadImage can't do this job: it validates that its file exists
                       even when nothing downstream will ever evaluate it, so a fresh App (no canvas still yet)
                       would refuse to queue.
"""
from __future__ import annotations

import os

from comfy_api.latest import IO


_ANNOTATIONS = {"[input]": "get_input_directory", "[output]": "get_output_directory", "[temp]": "get_temp_directory"}


def resolve_input_path(rel: str) -> str:
    """input/-relative path (or "name [output]" / "name [temp]") -> absolute path inside that folder (no escaping it)."""
    import folder_paths
    rel, getter = rel.strip(), "get_input_directory"
    for tag, fn in _ANNOTATIONS.items():
        if rel.endswith(" " + tag):
            rel, getter = rel[: -len(tag) - 1].rstrip(), fn
            break
    base = os.path.realpath(getattr(folder_paths, getter)())
    path = os.path.realpath(os.path.join(base, rel.replace("\\", "/").lstrip("/")))
    if os.path.commonpath([base, path]) != base:
        raise ValueError(f"canvas still must be inside the input folder: {rel!r}")
    return path


def load_rgb(path: str):
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)[None]


class SoundstageCanvasImage(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageCanvasImage",
            display_name="Soundstage · Canvas still",
            category="Soundstage",
            search_aliases=["canvas", "touch up", "touched-up still", "paint", "inpaint result"],
            description="The look still as fixed in the stage's Canvas tab ('Use as look still' saves it to input/ "
                        "and fills this in). Feed it through a switch so the default path never needs it.",
            inputs=[
                IO.String.Input("image", default="", tooltip="input/-relative PNG written by the Canvas tab."),
            ],
            outputs=[IO.Image.Output("out_image", display_name="image")],
        )

    @classmethod
    def fingerprint_inputs(cls, image=""):
        try:
            return f"{image}:{os.path.getmtime(resolve_input_path(image))}" if image else ""
        except Exception:
            return image

    @classmethod
    def execute(cls, image="") -> IO.NodeOutput:
        if not image or not image.strip():
            raise ValueError("No canvas still yet: open the Canvas tab and press 'Use as look still' "
                             "(or turn 'Use touched-up still' off).")
        path = resolve_input_path(image.strip())
        if not os.path.isfile(path):
            raise ValueError(f"The start frame {image!r} is missing on the ComfyUI server: pick the frame again in "
                             "④ Frame (or press 'Use as look still' again in the Canvas tab).")
        return IO.NodeOutput(load_rgb(path))


NODES = [SoundstageCanvasImage]
