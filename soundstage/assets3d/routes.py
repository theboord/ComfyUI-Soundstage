"""HTTP routes for the photo -> 3D maker (web/assets3d/maker.mjs). The integrator calls register() once:

    from .soundstage.assets3d import routes as _assets3d_routes
    _assets3d_routes.register()

GET /soundstage/assets3d/status   -> which pipelines can run here (nodes + weights present) and their licenses
GET /soundstage/assets3d/inspect?filename=&subfolder=&type=output[&aspect=1.78]
                                  -> {format, count, bbox, [fov_deg, focal_mm, camera, to_stage]} for a GLB/PLY
"""
from __future__ import annotations

import os

_REGISTERED = False

WEIGHTS = {
    "triposplat": [("diffusion_models", "triposplat_fp16.safetensors"), ("vae", "triposplat_vae_decoder_fp16.safetensors"),
                   ("vae", "flux2-vae-triposplat.safetensors"), ("clip_vision", "dino_v3_vit_h.safetensors")],
    "da3": [("geometry_estimation", "depth_anything_3_mono_large.safetensors")],
    "birefnet": [("background_removal", "birefnet.safetensors")],
}
NODES = {
    "triposplat": ["TripoSplatPreprocessImage", "TripoSplatConditioning", "VAEDecodeTripoSplat", "SplatToFile3D", "SaveGLB"],
    "splat_to_mesh": ["SplatToMesh"],
    "da3": ["LoadDA3Model", "DA3Inference", "DA3GeometryToMesh", "SaveGLB"],
    "birefnet": ["LoadBackgroundRemovalModel", "RemoveBackground"],
    "rmbg": ["RMBG"],
}
LICENSES = {
    "triposplat": "MIT (VAST-AI-Research/TripoSplat code + weights)",
    "dino_v3": "DINOv3 License (Meta; commercial use allowed, with an acceptable-use policy and redistribution terms)",
    "flux2_vae": "Apache-2.0 (black-forest-labs FLUX.2 VAE)",
    "da3_mono_large": "Apache-2.0 (ByteDance Depth Anything 3, DA3MONO-LARGE)",
    "birefnet": "MIT (ZhengPeng7/BiRefNet)",
    "rmbg_2_0": "CC BY-NC 4.0 - NON-COMMERCIAL (briaai/RMBG-2.0); commercial use needs a BRIA licence",
}


def status() -> dict:
    import folder_paths
    import nodes as comfy_nodes

    have_node = lambda n: n in comfy_nodes.NODE_CLASS_MAPPINGS  # noqa: E731

    def have_file(folder, name):
        try:
            return name in (folder_paths.get_filename_list(folder) or [])
        except Exception:  # noqa: BLE001 - unknown folder
            return False

    def ok(key):
        return all(have_node(n) for n in NODES.get(key, [])) and all(have_file(f, n) for f, n in WEIGHTS.get(key, []))

    rmbg_dir = os.path.join(folder_paths.models_dir, "RMBG", "RMBG-2.0")
    bg = "birefnet" if ok("birefnet") else "rmbg-2.0" if have_node("RMBG") and os.path.isdir(rmbg_dir) else "none"
    return {
        "splat": ok("triposplat"),
        "mesh_object": ok("triposplat") and have_node("SplatToMesh"),
        "mesh_set": ok("da3"),
        "cutout": bg != "none",
        "background_removal": bg,
        "background_license": LICENSES["birefnet"] if bg == "birefnet" else LICENSES["rmbg_2_0"] if bg == "rmbg-2.0" else None,
        "licenses": LICENSES,
    }


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from . import inspect as INS

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.get("/soundstage/assets3d/status")
    async def get_status(request):
        try:
            return web.json_response(status())
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/soundstage/assets3d/inspect")
    async def get_inspect(request):
        import folder_paths
        q = request.query
        filename = os.path.basename(q.get("filename", ""))
        subfolder = q.get("subfolder", "")
        base = folder_paths.get_directory_by_type(q.get("type", "output"))
        if not filename or base is None:
            return web.json_response({"error": "filename and a valid type are required"}, status=400)
        base = os.path.abspath(base)
        path = os.path.abspath(os.path.join(base, subfolder, filename))
        if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
            return web.json_response({"error": "not found"}, status=404)
        if os.path.getsize(path) > 1_500_000_000:
            return web.json_response({"error": "file too large to inspect"}, status=413)
        try:
            aspect = float(q["aspect"]) if q.get("aspect") else None
        except ValueError:
            aspect = None
        with open(path, "rb") as f:
            data = f.read()
        try:
            return web.json_response(INS.inspect_bytes(data, filename, aspect))
        except Exception as e:  # noqa: BLE001 - unreadable file
            return web.json_response({"error": f"could not read {filename}: {e}"}, status=422)

    _REGISTERED = True
    return True
