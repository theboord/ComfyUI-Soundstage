"""Light queue watching and the stage store routes. register() is idempotent.

GET  /soundstage/queue_summary[?client_id=..][&ids=a,b][&limit=200]
     -> {running, pending, items: [{prompt_id, state, position, client_id, label, number}], ms}
     Counts are for the whole queue; items are filtered by client_id / ids when given. Never any prompt payload:
     this is the one way for the App, tools and agents to watch the queue (GET /queue and GET /history serialise
     every prompt in full, which froze the pod on 2026-11-01). For one finished prompt use GET /history/{prompt_id}.
POST /soundstage/stage_store   body: the stage JSON string -> {value, stage_ref, bytes}
     `value` is the canonical reference string to put in the 3D Stage node's input instead of the JSON.
GET  /soundstage/stage_store/{ref}  -> the stored stage JSON (404 when this server doesn't have it)

Also installs the on-prompt handler that turns big inline stages into references (stagestore.slim_prompt), so a
prompt from an old workflow, a script or the stock ComfyUI UI is light in the queue too.
"""
from __future__ import annotations

import time

from . import stagestore as SS

_REGISTERED = False

STEP_NAMES = {1: "Stage", 2: "Frame", 3: "Draft", 4: "Final", 5: "Layers"}


def label_of(prompt, extra) -> str:
    """A short name for a queue item without encoding its payload: "Final · Chase cam", "Frame", "SaveImage"."""
    try:
        rec = ((extra or {}).get("extra_pnginfo") or {}).get("soundstage")
        if isinstance(rec, dict) and rec.get("rung"):
            shot = (rec.get("shot") or {}).get("name") or (rec.get("shot") or {}).get("id") or ""
            return (f"{str(rec['rung']).capitalize()} · {shot}" if shot else str(rec["rung"]).capitalize())[:80]
        if isinstance(prompt, dict):
            kinds = set()
            for n in prompt.values():
                if not isinstance(n, dict):
                    continue
                ct = n.get("class_type")
                if ct == "SoundstageStep":
                    s = (n.get("inputs") or {}).get("step")
                    if isinstance(s, (int, float)):
                        return STEP_NAMES.get(int(s), f"Step {int(s)}")
                kinds.add(ct)
            if "TextGenerate" in kinds:
                return "Model call"
            for want in ("SaveVideo", "SaveGLB", "SaveImage", "SaveAudio", "PreviewAny", "PreviewImage"):
                if want in kinds:
                    return want
            return f"{len(prompt)} nodes"
    except Exception:  # noqa: BLE001 - a label never breaks the summary
        pass
    return ""


def _row(item, state: str, position: int) -> dict:
    number, pid = item[0], item[1]
    prompt = item[2] if len(item) > 2 else None
    extra = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    return {"prompt_id": pid, "state": state, "position": position, "client_id": extra.get("client_id"),
            "label": label_of(prompt, extra), "number": number}


def summarize(running, pending, client_id: str | None = None, ids=None, limit: int = 200) -> dict:
    """Pure: queue tuples (number, prompt_id, prompt, extra_data, ...) -> the summary. Pending is sorted the way the
    queue runs it (by number); position 0 is running, 1 is next."""
    pending = sorted(pending, key=lambda it: (it[0], str(it[1])))
    want = set(ids) if ids else None
    items = []
    for state, rows, start in (("running", running, 0), ("pending", pending, 1)):
        for i, it in enumerate(rows):
            if len(items) >= limit:
                break
            pid = it[1]
            if want is not None and pid not in want:
                continue
            extra = it[3] if len(it) > 3 and isinstance(it[3], dict) else {}
            if client_id and extra.get("client_id") != client_id:
                continue
            items.append(_row(it, state, 0 if state == "running" else start + i))
    return {"running": len(running), "pending": len(pending), "items": items}


def snapshot(prompt_queue):
    """(running, pending) lists from ComfyUI's PromptQueue without deep-copying any prompt."""
    vol = getattr(prompt_queue, "get_current_queue_volatile", None)
    if vol is not None:
        r, p = vol()
        return list(r), list(p)
    with prompt_queue.mutex:
        return list(prompt_queue.currently_running.values()), list(prompt_queue.queue)


def register(routes=None, prompt_queue=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    import asyncio

    from aiohttp import web

    server = None
    if routes is None:
        from server import PromptServer
        server = PromptServer.instance
        routes = server.routes
        try:
            server.add_on_prompt_handler(SS.slim_prompt)
        except Exception:  # noqa: BLE001 - an older ComfyUI: prompts stay as sent
            pass

    def _queue():
        if prompt_queue is not None:
            return prompt_queue
        from server import PromptServer
        return PromptServer.instance.prompt_queue

    @routes.get("/soundstage/queue_summary")
    async def queue_summary(request):
        t0 = time.perf_counter()
        q = request.query
        try:
            limit = max(1, min(int(q.get("limit", 200)), 2000))
        except ValueError:
            limit = 200
        ids = [x for x in (q.get("ids") or "").split(",") if x] or None
        running, pending = snapshot(_queue())
        out = summarize(running, pending, client_id=q.get("client_id") or None, ids=ids, limit=limit)
        out["ms"] = round((time.perf_counter() - t0) * 1000, 2)
        return web.json_response(out)

    @routes.post("/soundstage/stage_store")
    async def stage_store(request):
        text = await request.text()
        if not text.strip():
            return web.json_response({"error": "empty stage"}, status=400)
        try:
            value = await asyncio.to_thread(SS.ref_value, text)
        except ValueError as e:
            return web.json_response({"error": f"not a stage: {e}"}, status=400)
        ref = SS.parse_ref(value)
        return web.json_response({"value": value, "stage_ref": ref[SS.REF_KEY], "bytes": ref["bytes"]})

    @routes.get("/soundstage/stage_store/{ref}")
    async def stage_get(request):
        ref = request.match_info["ref"]
        if not SS.valid_ref(ref):
            return web.json_response({"error": "bad reference"}, status=400)
        text = await asyncio.to_thread(SS.get, ref)
        if text is None:
            return web.json_response({"error": "this server doesn't have that stage"}, status=404)
        return web.Response(text=text, content_type="application/json",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})

    if server is not None:
        _REGISTERED = True
    return True
