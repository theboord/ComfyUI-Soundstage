"""HTTP routes used by the Soundstage frontend.

GET  /soundstage/object?name=grand%20piano  -> cached clay stand-in recipe, or 404
POST /soundstage/object {name, text}        -> parse + sanitise the LLM's output, cache it, return it
GET  /soundstage/object_designer            -> the system prompt and model the frontend should use
GET  /soundstage/voices                     -> the saved Character Voices [{name, character, duration_s, owner}]
"""
from aiohttp import web

from server import PromptServer

from . import object_designer as od

DESIGNER_MODEL = "qwen3.5_4b_bf16.safetensors"

routes = PromptServer.instance.routes


@web.middleware
async def _revalidate_soundstage_web(request, handler):
    # Our ES modules import each other by relative path, which no cache-busting query reaches.
    # Without a Cache-Control header browsers cache them heuristically and keep old code after
    # an update, so ask them to revalidate (a cheap 304 when nothing changed).
    response = await handler(request)
    if request.path.startswith("/extensions/ComfyUI-Soundstage/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


try:
    PromptServer.instance.app.middlewares.append(_revalidate_soundstage_web)
except (AttributeError, RuntimeError):  # app already frozen: keep default caching
    pass


@routes.get("/soundstage/object")
async def get_object(request):
    name = request.query.get("name", "").strip()
    recipe = od.load_cached(name) if name else None
    if recipe is None:
        return web.json_response({"error": "not designed yet"}, status=404)
    return web.json_response(recipe)


@routes.post("/soundstage/object")
async def post_object(request):
    body = await request.json()
    name = str(body.get("name", "")).strip()
    recipe = od.parse_recipe(body.get("text", ""), name)
    if not name or recipe is None:
        return web.json_response({"error": "The designer's answer could not be read as a 3D recipe."}, status=422)
    od.save_cached(name, recipe)
    return web.json_response(recipe)


@routes.get("/soundstage/object_designer")
async def designer_info(request):
    import folder_paths
    available = DESIGNER_MODEL in (folder_paths.get_filename_list("text_encoders") or [])
    return web.json_response({"system_prompt": od.SYSTEM_PROMPT, "model": DESIGNER_MODEL, "available": available})


@routes.get("/soundstage/source_spec")
async def source_spec(request):
    """?filename=&subfolder=&type=input|output[&original=A001_C002.R3D] -> the clip's source spec (ffprobe).
    original = the camera RAW file this proxy was made from (the exports relink to it). docs/source_fidelity.md"""
    import asyncio
    import os

    import folder_paths

    from .footage import sourcespec
    q = request.query
    name, sub = q.get("filename", ""), q.get("subfolder", "")
    base = folder_paths.get_directory_by_type(q.get("type", "input") or "input")
    if not name or base is None:
        return web.json_response({"error": "send ?filename=&subfolder=&type="}, status=400)
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, sub, name))
    if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
        return web.json_response({"error": "no such file"}, status=404)
    try:
        spec = await asyncio.to_thread(sourcespec.probe, path)
    except Exception as exc:  # noqa: BLE001 - reported to the browser
        return web.json_response({"error": str(exc)}, status=422)
    return web.json_response(sourcespec.link_original(spec, q.get("original", "")))


@routes.get("/soundstage/voices")
async def saved_voices(request):
    """The saved Character Voices (user/soundstage/voices), for the Real performance dialog's Voice choice.
    Names, characters and owners only: no paths, no audio."""
    import folder_paths

    from .audio import voices as V
    ud = folder_paths.get_user_directory()
    out = []
    for n in V.list_voices(ud):
        try:
            v = V.load_voice(ud, n)
        except (V.VoiceError, OSError, ValueError):
            continue
        out.append({"name": v["name"], "character": v.get("character") or v["name"],
                    "duration_s": v.get("duration_s"), "owner": (v.get("consent") or {}).get("owner", "")})
    return web.json_response({"voices": out})


# ✦ One-click (soundstage/oneclick/routes.py): the MCP relay; the App runs the one-clicks.
try:
    from .oneclick import routes as _oneclick_routes
    _oneclick_routes.register()
except Exception:  # noqa: BLE001 - never let one feature stop the pack loading
    import logging as _lg
    _lg.getLogger(__name__).exception("Soundstage: could not register the one-click routes")
