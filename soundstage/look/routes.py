"""POST /soundstage/look/compile {look, scene} -> {still_prompt, still_negative, motion_prompt, notes, kb, ...}
POST /soundstage/look/parse   {text}        -> {look, matched}

The Look tab's live preview calls this so the preview is exactly what SoundstageLook will output.
Imported by soundstage/nodes_look.py inside ComfyUI only (needs server.PromptServer)."""
from aiohttp import web

from server import PromptServer

from .compile import compile_look

routes = PromptServer.instance.routes


@routes.post("/soundstage/look/compile")
async def post_look_compile(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "expected JSON {look, scene}"}, status=400)
    look = body.get("look") if isinstance(body, dict) else None
    scene = body.get("scene") if isinstance(body, dict) else None
    try:
        return web.json_response(compile_look(look, scene))
    except Exception as e:  # never break the panel on a half-built scene
        return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=422)


@routes.post("/soundstage/look/parse")
async def post_look_parse(request):
    """{text} -> {look, matched}: the panel's 'type a look' box ("Korean thriller, anamorphic, teal-orange")."""
    from .vocab import look_from_text
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "expected JSON {text}"}, status=400)
    look, matched = look_from_text(str((body or {}).get("text", "")))
    return web.json_response({"look": look, "matched": matched})
