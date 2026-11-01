"""HTTP routes for the Director panel and the MCP bridge (mounted by agent.routes.register()).

Panel (the browser runs the model and the App actions):
GET  /soundstage/director/info                               -> {tools, model, available, whisper, partner}
POST /soundstage/director/prompt     {command, scene, ctx}   -> {system, prompt, max_length, model}
POST /soundstage/director/plan       {command, scene, ctx, llm_text?} -> plan (see director.plan) + ms
POST /soundstage/director/calls      {calls, scene, ctx}     -> the same for typed calls (no language step)
POST /soundstage/director/transcribe  audio/wav body          -> {text, seconds, ms, model}
                                      (header X-Soundstage-Prompt: words to expect, URL-encoded; Pitch Mode sends it)

Pitch Mode (soundstage/agent/pitch.py; the browser queues the GPU jobs itself, under its own client id):
POST /soundstage/director/pitch        {text, scene, memory, ids, llm_text?, style?} -> one beat: delta, ops, memory, prompt
POST /soundstage/director/pitch_prompt {text, memory}        -> {system, prompt, max_length, model} for the local model
POST /soundstage/director/pitch_graph  {kind: sketch|motion, image, prompt, seed, ...} -> {graph} (weights resolved here)

MCP bridge (tools/soundstage_mcp.py; propose = dry run, nothing changes until apply):
POST /soundstage/director/state      {scene, ctx}            the open App posts its scene after each change
GET  /soundstage/director/state                              -> {connected, age_s, summary, ctx}
POST /soundstage/director/propose    {command} | {calls}     -> {plan_id, plan...}       (dry run on the App's scene)
POST /soundstage/director/apply      {plan_id, confirm_gpu?} -> the App runs it and answers {ok, results, ...}
POST /soundstage/director/undo                               -> the App undoes its last Director change
POST /soundstage/director/result     {id, result}            the App's answer to an apply/undo
"""
from __future__ import annotations

import asyncio
import time
import uuid

_REGISTERED = False
STATE: dict = {"scene": None, "ctx": {}, "t": 0.0, "sid": None}
PROPOSALS: dict = {}     # plan_id -> {plan, scene_t, t}
WAITING: dict = {}       # request id -> Future
EVENT = "soundstage.director"


def _gc():
    now = time.time()
    for k in [k for k, v in PROPOSALS.items() if now - v["t"] > 3600]:
        PROPOSALS.pop(k, None)
    while len(PROPOSALS) > 64:
        PROPOSALS.pop(next(iter(PROPOSALS)))


def register(routes=None, send=None) -> bool:
    """Mount on ComfyUI's PromptServer (or on a RouteTableDef + a fake send(event, data, sid) for tests)."""
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from . import director as D
    from . import prompts as PR
    from . import whisper as W

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

    def _available() -> bool:
        try:
            import folder_paths
            return PR.MODEL in (folder_paths.get_filename_list("text_encoders") or [])
        except Exception:  # noqa: BLE001
            return False

    def _partner() -> bool:
        try:
            from ..router.registry import open_weights_only
            return not open_weights_only()
        except Exception:  # noqa: BLE001
            return False

    async def _body(request) -> dict:
        try:
            b = await request.json()
            return b if isinstance(b, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    @routes.get("/soundstage/director/info")
    async def info(request):
        wp = W.find_model()
        return web.json_response({"tools": D.tool_specs(), "model": PR.MODEL, "available": _available(),
                                  "max_length": D.MAX_LENGTH, "whisper": {"available": bool(wp), "model": wp and wp.rsplit("/", 1)[-1]},
                                  "partner": _partner()})

    @routes.post("/soundstage/director/prompt")
    async def prompt(request):
        b = await _body(request)
        p = D.prompt(str(b.get("command", "")), b.get("scene") or {}, b.get("ctx") or {})
        p["model"] = PR.MODEL
        return web.json_response(p)

    @routes.post("/soundstage/director/plan")
    async def plan(request):
        b = await _body(request)
        if not isinstance(b.get("scene"), dict):
            return web.json_response({"error": "plan needs the current scene"}, status=400)
        t0 = time.time()
        res = D.plan(str(b.get("command", "")), b["scene"], b.get("ctx") or {}, b.get("llm_text"))
        res["ms"] = round((time.time() - t0) * 1000)
        return web.json_response(res)

    @routes.post("/soundstage/director/calls")
    async def calls(request):
        b = await _body(request)
        if not isinstance(b.get("scene"), dict) or not isinstance(b.get("calls"), list):
            return web.json_response({"error": "calls needs {calls: [...], scene}"}, status=400)
        return web.json_response(D.run_calls(b["calls"], b["scene"], b.get("ctx") or {}))

    @routes.post("/soundstage/director/transcribe")
    async def transcribe(request):
        data = await request.read()
        if not data or len(data) < 44:
            return web.json_response({"error": "send the recording as an audio/wav body"}, status=400)
        if len(data) > 12 * 1024 * 1024:
            return web.json_response({"error": "recording too long (push-to-talk clips are a few seconds)"}, status=413)
        lang = request.query.get("lang", "en") or None
        from urllib.parse import unquote
        hint = unquote(request.headers.get("X-Soundstage-Prompt") or "")[:400] or None
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, (lambda: W.transcribe(data, lang, prompt=hint)) if hint else (lambda: W.transcribe(data, lang)))
        except FileNotFoundError as e:
            return web.json_response({"error": str(e)}, status=404)
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": f"transcription failed: {e}"}, status=500)
        return web.json_response(res)

    # ---------------------------------------------------------------- Pitch Mode
    from . import pitch as PT

    @routes.post("/soundstage/director/pitch")
    async def pitch_beat(request):
        b = await _body(request)
        if not isinstance(b.get("scene"), dict):
            return web.json_response({"error": "pitch needs the current scene"}, status=400)
        t0 = time.time()
        res = PT.beat(str(b.get("text", "")), b["scene"], b.get("memory"), b.get("ids"), b.get("llm_text"), str(b.get("style") or ""))
        res.pop("scene", None)
        res["ms"] = round((time.time() - t0) * 1000)
        return web.json_response(res)

    @routes.post("/soundstage/director/pitch_prompt")
    async def pitch_prompt(request):
        b = await _body(request)
        p = PT.llm_prompt(str(b.get("text", "")), b.get("memory"))
        p["model"] = PR.MODEL
        return web.json_response(p)

    @routes.post("/soundstage/director/pitch_graph")
    async def pitch_graph(request):
        b = await _body(request)
        image = str(b.get("image") or "")
        if not image:
            return web.json_response({"error": "pitch_graph needs the uploaded image name"}, status=400)
        try:
            import folder_paths
            lf = folder_paths.get_filename_list
        except Exception:  # noqa: BLE001 - outside ComfyUI: the default file names
            lf = None
        kind = b.get("kind", "sketch")
        mid = "open.ltx_2_5" if kind == "motion" else "open.flux3_klein"
        w = PT._weights(mid, lf) if lf else None
        if lf and w is None:
            return web.json_response({"error": f"{'LTX-2.5' if kind == 'motion' else 'FLUX 3 Klein'} isn't installed on this ComfyUI"}, status=404)
        seed = int(b.get("seed") or 0)
        if kind == "motion":
            g = PT.motion_graph(image, str(b.get("prompt") or ""), seed, int(b.get("width") or 512), int(b.get("height") or 288),
                                int(b.get("frames") or 49), int(b.get("fps") or 24), w)
        else:
            g = PT.sketch_graph(image, str(b.get("prompt") or ""), seed, int(b.get("steps") or 4), float(b.get("megapixels") or 0.3), w)
        return web.json_response({"graph": g, "model": mid})

    # ---------------------------------------------------------------- MCP bridge
    @routes.post("/soundstage/director/state")
    async def state_in(request):
        b = await _body(request)
        if isinstance(b.get("scene"), dict):
            STATE.update(scene=b["scene"], ctx=b.get("ctx") or {}, t=time.time(), sid=b.get("client_id") or None)
        return web.json_response({"ok": True})

    @routes.get("/soundstage/director/state")
    async def state_out(request):
        sc = STATE["scene"]
        if sc is None:
            return web.json_response({"connected": False, "hint": "Open the Soundstage App in a browser (it reports its scene here)."})
        s = D.normalize_scene(sc)
        out = {"connected": True, "age_s": round(time.time() - STATE["t"], 1), "summary": D.context_text(s, STATE["ctx"]),
               "ctx": STATE["ctx"]}
        if request.query.get("full"):
            out["scene"] = sc
        return web.json_response(out)

    @routes.post("/soundstage/director/propose")
    async def propose(request):
        b = await _body(request)
        if STATE["scene"] is None:
            return web.json_response({"error": "No Soundstage App is open: open it in a browser first."}, status=409)
        if isinstance(b.get("calls"), list):
            res = D.run_calls(b["calls"], STATE["scene"], STATE["ctx"])
        else:
            res = D.plan(str(b.get("command", "")), STATE["scene"], STATE["ctx"], b.get("llm_text"))
        _gc()
        pid = uuid.uuid4().hex[:10]
        PROPOSALS[pid] = {"plan": res, "t": time.time(), "scene_t": STATE["t"]}
        res = {**res, "plan_id": pid, "dry_run": True,
               "next": "Nothing has changed yet. Call apply with this plan_id to run it" + (" (it renders on the GPU: pass confirm_gpu=true)" if res.get("gpu") else "") + "."}
        return web.json_response(res)

    async def _ask_app(kind: str, payload: dict, timeout: float):
        rid = uuid.uuid4().hex[:12]
        fut = asyncio.get_running_loop().create_future()
        WAITING[rid] = fut
        try:
            # Only the App that last reported its scene runs it (two open tabs must not both apply).
            send(EVENT, {"id": rid, "kind": kind, **payload}, STATE.get("sid"))
            return await asyncio.wait_for(fut, timeout)
        finally:
            WAITING.pop(rid, None)

    @routes.post("/soundstage/director/apply")
    async def apply(request):
        b = await _body(request)
        prop = PROPOSALS.get(str(b.get("plan_id", "")))
        if not prop:
            return web.json_response({"error": "unknown or expired plan_id: propose again"}, status=404)
        plan = prop["plan"]
        if plan.get("gpu") and not b.get("confirm_gpu"):
            return web.json_response({"error": "this plan renders on the GPU: ask the user, then apply with confirm_gpu=true",
                                      "plan": plan["plan"]}, status=409)
        try:
            res = await _ask_app("apply", {"plan": plan, "confirm_gpu": bool(b.get("confirm_gpu")), "source": "mcp"},
                                 float(b.get("timeout", 120)))
        except asyncio.TimeoutError:
            return web.json_response({"error": "the App didn't answer (is it open, with the Director panel loaded?)"}, status=504)
        PROPOSALS.pop(str(b.get("plan_id")), None)
        return web.json_response(res if isinstance(res, dict) else {"ok": True, "result": res})

    @routes.post("/soundstage/director/undo")
    async def undo(request):
        try:
            res = await _ask_app("undo", {"source": "mcp"}, 30)
        except asyncio.TimeoutError:
            return web.json_response({"error": "the App didn't answer"}, status=504)
        return web.json_response(res if isinstance(res, dict) else {"ok": True})

    @routes.post("/soundstage/director/result")
    async def result(request):
        b = await _body(request)
        fut = WAITING.get(str(b.get("id", "")))
        if fut and not fut.done():
            fut.set_result(b.get("result") if isinstance(b.get("result"), dict) else {"ok": True, "result": b.get("result")})
            return web.json_response({"ok": True})
        return web.json_response({"ok": False, "error": "nobody is waiting for that id"}, status=404)

    _REGISTERED = True
    return True
