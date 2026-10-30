"""HTTP routes for the Scene agent. The integrator calls register() once (it is idempotent):

    from .soundstage.agent import routes as _agent_routes
    _agent_routes.register()

GET  /soundstage/agent/info                      -> {model, available, max_length}
POST /soundstage/agent/prompt   {mode, text|command, genre?, scene?} -> {system, prompt, max_length, model}
POST /soundstage/agent/build    {text, genre?, llm_text?}            -> {scene, plan, notes, backend, designs, ms}
POST /soundstage/agent/edit     {scene, command, llm_text?}          -> {ops, inverse, scene, summary, notes, backend, ms}
POST /soundstage/agent/validate {scene}                              -> {scene, notes}
"""
from __future__ import annotations

import time

_REGISTERED = False


def register(routes=None) -> bool:
    """Mount the routes on ComfyUI's PromptServer (or on an aiohttp RouteTableDef passed in, for tests)."""
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from . import core
    from . import prompts as PR
    from .validate import validate_scene

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    def _available() -> bool:
        try:
            import folder_paths
            return PR.MODEL in (folder_paths.get_filename_list("text_encoders") or [])
        except Exception:  # noqa: BLE001 - outside ComfyUI
            return False

    async def _body(request) -> dict:
        try:
            b = await request.json()
            return b if isinstance(b, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    @routes.get("/soundstage/agent/info")
    async def info(request):
        return web.json_response({"model": PR.MODEL, "available": _available(), "max_length": PR.MAX_LENGTH})

    @routes.post("/soundstage/agent/prompt")
    async def prompt(request):
        b = await _body(request)
        if b.get("mode") == "edit":
            sys_p, user = PR.EDIT_SYSTEM, PR.edit_user(str(b.get("command", "")), validate_scene(b.get("scene") or {})[0])
        else:
            sys_p, user = PR.BUILD_SYSTEM, PR.build_user(str(b.get("text", "")), str(b.get("genre", "")))
        mode = "edit" if b.get("mode") == "edit" else "build"
        return web.json_response({"system": sys_p, "prompt": user, "max_length": PR.MAX_LENGTH[mode], "model": PR.MODEL})

    @routes.post("/soundstage/agent/build")
    async def build(request):
        b = await _body(request)
        t0 = time.time()
        res = core.describe(str(b.get("text", "")), str(b.get("genre", "")), b.get("llm_text"))
        res["ms"] = round((time.time() - t0) * 1000)
        return web.json_response(res)

    @routes.post("/soundstage/agent/edit")
    async def edit(request):
        b = await _body(request)
        if not isinstance(b.get("scene"), dict):
            return web.json_response({"error": "edit needs the current scene"}, status=400)
        t0 = time.time()
        res = core.edit(b["scene"], str(b.get("command", "")), b.get("llm_text"))
        res["ms"] = round((time.time() - t0) * 1000)
        return web.json_response(res)

    @routes.post("/soundstage/agent/validate")
    async def validate(request):
        b = await _body(request)
        scene, notes = validate_scene(b.get("scene") or {})
        return web.json_response({"scene": scene, "notes": notes})

    _REGISTERED = True
    return True
