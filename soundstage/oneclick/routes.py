"""MCP relay for ✦ One-click (tools/soundstage_mcp.py soundstage_one_click). The open App runs every one-click itself,
in view, so the result lands as a take on the shot like a click would:

GET  /soundstage/oneclick/catalog                       -> {ids: [{id, group}]} (no App needed)
POST /soundstage/oneclick/ask {kind: list|propose|run, oneclick?, shot?, take?, opts?, confirm_gpu?}
                                                        -> the App's answer (run needs confirm_gpu for a GPU one-click)
POST /soundstage/oneclick/result {id, result}           the App's answer to an ask
"""
from __future__ import annotations

import asyncio
import math
import uuid

_REGISTERED = False
WAITING: dict = {}
EVENT = "soundstage.oneclick"
TIMEOUT = {"list": 30.0, "propose": 30.0, "run": 2400.0}


def register(routes=None, send=None) -> bool:
    """Mount on ComfyUI's PromptServer (or a RouteTableDef + a fake send(event, data, sid) for tests)."""
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from . import catalog as C

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    def _server_send(ev, data, sid=None):
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(ev, data, sid)
        except Exception:  # noqa: BLE001 - outside ComfyUI nobody listens
            pass
    send = send or _server_send

    def _app_sid():
        try:
            from ..agent.director_routes import STATE
            return STATE.get("sid")
        except Exception:  # noqa: BLE001
            return None

    @routes.get("/soundstage/oneclick/catalog")
    async def catalog(request):
        return web.json_response({"ids": C.describe(), "groups": list(C.GROUPS)})

    async def _body(request):
        """The JSON object sent ({} when there is no JSON body), or None for JSON that isn't an object (a list or a
        string answered 500)."""
        try:
            b = await request.json()
        except Exception:  # noqa: BLE001
            return {}
        return b if isinstance(b, dict) else None

    def _timeout(value, kind) -> float:
        try:
            t = float(value) if value not in (None, "") else TIMEOUT[kind]
        except (TypeError, ValueError):
            t = TIMEOUT[kind]
        return t if math.isfinite(t) and t > 0 else TIMEOUT[kind]

    @routes.post("/soundstage/oneclick/ask")
    async def ask(request):
        b = await _body(request)
        if b is None:
            return web.json_response({"error": "send a JSON object: {kind, oneclick?, shot?, take?, opts?}"}, status=400)
        kind = str(b.get("kind") or "list")
        if kind not in TIMEOUT:
            return web.json_response({"error": "kind must be list, propose or run"}, status=400)
        oc = str(b.get("oneclick") or "")
        if kind != "list" and oc not in C.ids() and not b.get("any_id"):
            return web.json_response({"error": f"unknown one-click {oc!r}: list them first"}, status=404)
        if kind == "run" and not b.get("confirm_gpu"):
            return web.json_response({"error": "a one-click renders on the GPU: ask the user, then run with confirm_gpu=true"}, status=409)
        rid = uuid.uuid4().hex[:12]
        fut = asyncio.get_running_loop().create_future()
        WAITING[rid] = fut
        try:
            send(EVENT, {"id": rid, "kind": kind, "oneclick": oc, "shot": b.get("shot"), "take": b.get("take"),
                         "opts": b.get("opts") if isinstance(b.get("opts"), dict) else {}}, _app_sid())
            res = await asyncio.wait_for(fut, _timeout(b.get("timeout"), kind))
        except asyncio.TimeoutError:
            return web.json_response({"error": "the App didn't answer (is the Soundstage App open in a browser?)"}, status=504)
        finally:
            WAITING.pop(rid, None)
        return web.json_response(res if isinstance(res, dict) else {"result": res})

    @routes.post("/soundstage/oneclick/result")
    async def result(request):
        b = await _body(request) or {}
        fut = WAITING.get(str(b.get("id", "")))
        if fut and not fut.done():
            fut.set_result(b.get("result") if isinstance(b.get("result"), dict) else {"result": b.get("result")})
            return web.json_response({"ok": True})
        return web.json_response({"ok": False, "error": "nobody is waiting for that id"}, status=404)

    _REGISTERED = True
    return True
