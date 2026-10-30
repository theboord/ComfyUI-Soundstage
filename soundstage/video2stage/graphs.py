"""The Depth Anything 3 graph Video → Stage queues (core DA3 nodes + SoundstageDA3Export)."""
from __future__ import annotations

# Multi-view (camera poses + intrinsics straight from the model) needs a Small/Base checkpoint; the
# Mono/Metric ones only give depth, and the route then tracks the camera itself.
MULTIVIEW_HINTS = ("small", "base")
PREFERRED = ["depth_anything_3_base.safetensors", "depth_anything_3_small.safetensors",
             "depth_anything_3_mono_large.safetensors", "depth_anything_3_metric_large.safetensors"]


def pick_model(names: list[str]) -> tuple[str | None, bool]:
    """(checkpoint, multiview?) from the geometry_estimation folder listing."""
    da3 = [n for n in names if "depth_anything_3" in n.lower() or "da3" in n.lower()]
    for p in PREFERRED:
        if p in da3:
            return p, any(h in p for h in MULTIVIEW_HINTS)
    for n in da3:
        if any(h in n.lower() for h in MULTIVIEW_HINTS):
            return n, True
    return (da3[0], False) if da3 else (None, False)


def da3_graph(model: str, images: list[str], name: str, multiview: bool, resolution: int = 504,
              backdrop_prefix: str | None = None) -> dict:
    """LoadImage x N -> batch -> DA3Inference -> SoundstageDA3Export (+ frame-0 mesh -> SaveGLB)."""
    g: dict = {}
    prev = None
    for i, img in enumerate(images):
        g[f"i{i}"] = {"class_type": "LoadImage", "inputs": {"image": img}}
        if prev is None:
            prev = [f"i{i}", 0]
        else:
            g[f"b{i}"] = {"class_type": "ImageBatch", "inputs": {"image1": prev, "image2": [f"i{i}", 0]}}
            prev = [f"b{i}", 0]
    g["d1"] = {"class_type": "LoadDA3Model", "inputs": {"model_name": model, "weight_dtype": "default"}}
    inf = {"da3_model": ["d1", 0], "image": prev, "resolution": resolution, "resize_method": "upper_bound_resize"}
    if multiview:
        inf.update({"mode": "multiview", "mode.ref_view_strategy": "first", "mode.pose_method": "cam_dec"})
    else:
        inf["mode"] = "mono"
    g["d2"] = {"class_type": "DA3Inference", "inputs": inf}
    g["x1"] = {"class_type": "SoundstageDA3Export", "inputs": {"da3_geometry": ["d2", 0], "name": name}}
    if backdrop_prefix:
        g["m1"] = {"class_type": "DA3GeometryToMesh", "inputs": {"da3_geometry": ["d2", 0], "batch_index": 0,
                   "decimation": 2, "discontinuity_threshold": 0.04, "confidence_threshold": 0.1,
                   "use_sky_mask": True, "texture": True}}
        g["m2"] = {"class_type": "SaveGLB", "inputs": {"mesh": ["m1", 0], "filename_prefix": backdrop_prefix}}
    return g


def saved_glb(outputs: dict, node: str = "m2") -> dict | None:
    """The SaveGLB result {filename, subfolder, type} (core puts it under '3d' or 'meshes' depending on version)."""
    o = outputs.get(node) or {}
    for key in ("3d", "meshes", "glb", "files", "result"):
        v = o.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("filename"):
            return v[0]
    for v in o.values():
        if isinstance(v, list) and v and isinstance(v[0], dict) and str(v[0].get("filename", "")).endswith(".glb"):
            return v[0]
    return None
