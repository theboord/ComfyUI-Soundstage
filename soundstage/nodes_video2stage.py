"""Soundstage Video → Stage helper node: hand Depth Anything 3 geometry to the Video → Stage route.

SoundstageDA3Export saves a DA3_GEOMETRY batch (depth, sky, intrinsics, extrinsics) as an .npz in
output/soundstage_v2s/ and reports the path, so the route can track the camera on the CPU without
touching the GPU itself. It runs inside the ComfyUI queue like every other model job.
"""
import os

import numpy as np

import folder_paths
from comfy_api.latest import IO

OUTPUT_SUBDIR = "soundstage_v2s"
DA3Geometry = IO.Custom("DA3_GEOMETRY")


def _default_K(h: int, w: int) -> np.ndarray:
    """The K core DA3 uses for mono geometry (comfy_extras/nodes_depth_anything_3._da3_default_K)."""
    f = float(w) * 0.7
    return np.array([[f, 0, (w - 1) / 2.0], [0, f, (h - 1) / 2.0], [0, 0, 1]], np.float32)


class SoundstageDA3Export(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageDA3Export",
            display_name="Soundstage · Video → Stage: Save DA3 geometry",
            category="Soundstage",
            search_aliases=["da3 export", "depth npz", "video to stage", "camera track"],
            description="Save Depth Anything 3 geometry (per-frame depth, sky, camera intrinsics/extrinsics) as "
                        "output/soundstage_v2s/<name>.npz for the Video → Stage camera tracker.",
            is_output_node=True,
            inputs=[
                DA3Geometry.Input("da3_geometry"),
                IO.String.Input("name", default="v2s"),
            ],
            outputs=[IO.String.Output(display_name="path")],
        )

    @classmethod
    def execute(cls, da3_geometry, name="v2s") -> IO.NodeOutput:
        g = da3_geometry
        depth = g["depth"].float().cpu().numpy()  # (B, H, W)
        b, h, w = depth.shape
        out = {"depth": depth.astype(np.float32), "mode": np.array(str(g.get("mode", "mono")))}
        if "sky" in g:
            out["sky"] = g["sky"].float().cpu().numpy().astype(np.float16)
        if "confidence" in g:
            out["confidence"] = g["confidence"].float().cpu().numpy().astype(np.float16)
        if "intrinsics" in g:
            out["intrinsics"] = g["intrinsics"][0].float().cpu().numpy()
        else:
            out["intrinsics"] = np.stack([_default_K(h, w)] * b)
        if "extrinsics" in g and g.get("mode") == "multiview":
            out["extrinsics"] = g["extrinsics"][0].float().cpu().numpy()[:, :3, :4]
        folder = os.path.join(folder_paths.get_output_directory(), OUTPUT_SUBDIR)
        os.makedirs(folder, exist_ok=True)
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80] or "v2s"
        path = os.path.join(folder, f"{safe}.npz")
        np.savez_compressed(path, **out)
        return IO.NodeOutput(path, ui={"text": [path]})


NODES = [SoundstageDA3Export]
