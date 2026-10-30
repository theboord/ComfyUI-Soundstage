"""Soundstage 3D stage node.

The stage itself lives in the browser (web/stage/stage.mjs, a three.js set with actors,
props, camera and sun). At queue time the widget renders the clay and depth passes from
the shot camera, uploads them as temp images and sends the scene JSON plus those file
references as the `stage` value. This node turns that into tensors for the rest of the graph.
"""
import json

import numpy as np
import torch
from PIL import Image, ImageOps
from typing_extensions import override

import folder_paths
from comfy_api.latest import ComfyExtension, IO

STAGE_WIDGET = "SOUNDSTAGE_STAGE"


def _load_rgb(ref: str) -> torch.Tensor:
    """Load an annotated ComfyUI file reference ('name [temp]') as a 1xHxWx3 float tensor."""
    path = folder_paths.get_annotated_filepath(ref)
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)[None]


def _load_sequence(ref: str, grid: dict | None) -> torch.Tensor:
    """Load a pass. With a grid, slice the row-major sprite sheet into an NxHxWx3 frame batch."""
    sheet = _load_rgb(ref)
    if not grid:
        return sheet
    tw, th = grid["tile"]
    cols, frames = int(grid["cols"]), int(grid["frames"])
    tiles = [sheet[0, (f // cols) * th:(f // cols + 1) * th, (f % cols) * tw:(f % cols + 1) * tw]
             for f in range(frames)]
    return torch.stack(tiles)


class SoundstageStage(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageStage",
            display_name="Soundstage · 3D Stage",
            category="Soundstage",
            search_aliases=["stage", "blocking", "previz", "3d set", "film set"],
            description="Block the shot in 3D: actors, props, camera with a real lens, and the sun. "
                        "Outputs the clay and depth passes from the shot camera plus the scene JSON.",
            inputs=[
                IO.String.Input("stage", default="", optional=True, socketless=True,
                                extra_dict={"widgetType": STAGE_WIDGET}),
            ],
            outputs=[
                IO.Image.Output(display_name="clay", tooltip="Clay render of every frame (the layout video)."),
                IO.Image.Output(display_name="depth", tooltip="Depth of every frame, near = white."),
                IO.Image.Output(display_name="first_clay", tooltip="Frame 1 clay, for the look still."),
                IO.Image.Output(display_name="first_depth", tooltip="Frame 1 depth, to steer the look still."),
                IO.Float.Output(display_name="fps"),
                IO.Int.Output(display_name="frames"),
                IO.String.Output(display_name="scene_json"),
                IO.Image.Output(display_name="id_pass", tooltip="Each object in its own flat colour (for Actor Matte)."),
                IO.Image.Output(display_name="color", tooltip="Real object colours (wardrobe, props) for every frame."),
                IO.Image.Output(display_name="first_color", tooltip="Frame 1 in colour: the best start for the look still."),
            ],
        )

    @classmethod
    def execute(cls, stage="") -> IO.NodeOutput:
        data = json.loads(stage) if isinstance(stage, str) and stage else (stage or {})
        passes = data.get("passes") or {}
        if not passes.get("clay") or not passes.get("depth"):
            raise ValueError("The 3D stage sent no render passes. Open the stage and press Run again.")
        grid = passes.get("grid")
        clay = _load_sequence(passes["clay"], grid)
        depth = _load_sequence(passes["depth"], grid)
        scene = data.get("scene", {})
        fps = float(scene.get("shot", {}).get("fps", 24))
        id_pass = _load_sequence(passes["id"], grid) if passes.get("id") else torch.zeros_like(clay)
        color = _load_sequence(passes["color"], grid) if passes.get("color") else clay
        return IO.NodeOutput(clay, depth, clay[:1], depth[:1], fps, int(clay.shape[0]), json.dumps(scene), id_pass,
                             color, color[:1])

    @classmethod
    def fingerprint_inputs(cls, stage=""):
        # Re-run whenever the scene or its captured passes change.
        return stage


class SoundstageExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        nodes = [SoundstageStage]
        # Each feature module exports NODES. Load them independently so one failing
        # module (missing optional dependency, work in progress) never hides the others.
        import importlib
        import logging
        for mod in ("nodes_ladder", "nodes_cine", "nodes_layers", "nodes_router", "nodes_matte", "nodes_look", "nodes_footage", "nodes_cut", "nodes_agent", "nodes_audio", "nodes_quality", "nodes_canvas", "nodes_video2stage", "nodes_mocap"):
            try:
                nodes.extend(importlib.import_module(f"{__package__}.{mod}").NODES)
            except ModuleNotFoundError as e:
                if e.name and e.name.endswith(mod):
                    continue  # module not written yet
                logging.exception("Soundstage: could not load %s", mod)
            except Exception:
                logging.exception("Soundstage: could not load %s", mod)
        return nodes
