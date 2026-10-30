"""POST /soundstage/plan: floor-plan image or dimension text -> true-scale interior spec (see spec.py).

Body: {image?: <input-folder file name | data URL>, text?: str, ceiling_m?: number, vlm?: bool (default true)}
- image: walls / rooms / door gaps are measured from the pixels; room names and dimension labels come from the
  pod's vision LLM through the ComfyUI queue; labels set the scale and are cross-checked against the drawing.
- text only: rules / template layout (milliseconds, no model).
Response: the spec + {"timings": {...}, "reader": "..."}. register() is idempotent.
"""
from __future__ import annotations

import base64
import hashlib
import os
import time

from . import raster, spec, vlm

_REGISTERED = False


def _input_dir() -> str:
    import folder_paths
    return folder_paths.get_input_directory()


def save_data_url(data_url: str, folder: str) -> str:
    head, _, b64 = data_url.partition(",")
    raw = base64.b64decode(b64)
    ext = ".jpg" if "jpeg" in head or "jpg" in head else ".webp" if "webp" in head else ".png"
    name = f"ss_plan_{hashlib.sha1(raw).hexdigest()[:12]}{ext}"
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    return name


def image_path(name: str) -> str:
    import folder_paths
    path = folder_paths.get_annotated_filepath(name)
    if not path or not os.path.isfile(path):
        raise ValueError(f"image '{name}' is not in the input folder (upload it first)")
    return path


def text_spec(text: str, ceiling_m=None) -> dict:
    t0 = time.perf_counter()
    out = spec.from_text(text, ceiling_m)
    out["timings"] = {"total_ms": round((time.perf_counter() - t0) * 1000, 1)}
    out["reader"] = "rules"
    return out


async def image_spec(base_url: str, image: str, text: str = "", ceiling_m=None, use_vlm: bool = True) -> dict:
    t0 = time.perf_counter()
    name = save_data_url(image, _input_dir()) if image.startswith("data:") else image
    px = raster.read_plan_pixels(image_path(name))
    timings = {"pixels_ms": round((time.perf_counter() - t0) * 1000, 1)}
    read, notes, reader = None, [], "pixels only"
    model = vlm.available_model() if use_vlm else None
    if use_vlm and not model:
        notes.append("no local vision model (qwen3.5_4b) on this server: rooms are unnamed")
    if model:
        try:
            read, t = await vlm.read_with_vlm(base_url, name, model)
            timings.update(t)
            reader = f"pixels + {model}"
        except Exception as exc:  # noqa: BLE001 - fall back to pixels only, say why
            notes.append(f"vision model failed ({exc}); used the drawing alone")
    out = spec.from_pixels(px, read, text, ceiling_m)
    out["warnings"] = notes + out["warnings"]
    out["image"] = name
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    out["timings"] = timings
    out["reader"] = reader
    return out


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    def _base(request) -> str:
        try:
            from server import PromptServer
            port = getattr(PromptServer.instance, "port", None)
            if port:
                return f"http://127.0.0.1:{port}"
        except Exception:  # noqa: BLE001
            pass
        return f"{request.scheme}://{request.host}"

    @routes.post("/soundstage/plan")
    async def plan(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            body = {}
        image, text = str(body.get("image") or ""), str(body.get("text") or "")
        ceiling = body.get("ceiling_m")
        try:
            ceiling = float(ceiling) if ceiling not in (None, "") else None
            if image:
                out = await image_spec(_base(request), image, text, ceiling, bool(body.get("vlm", True)))
            elif text.strip():
                out = text_spec(text, ceiling)
            else:
                raise ValueError("send an image (input file name or data URL) or a text description")
            return web.json_response(out)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    if routes is not None:
        _REGISTERED = True
    return True
