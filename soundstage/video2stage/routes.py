"""HTTP routes for Video → Stage. register() is idempotent.

POST /soundstage/video2stage          {video: <input-folder file>, samples?: 8-24, vlm?: bool, backdrop?: bool,
                                       original?: camera RAW name the video is a proxy of}
                                      -> {job}
GET  /soundstage/video2stage/job?id=  -> {state: queued|running|done|error|cancelled, step, progress, result?, error?}
POST /soundstage/video2stage/cancel   {id} -> {state}: stops the rebuild and takes its own queued GPU prompt off
                                      the queue (the App's Cancel button)
POST /soundstage/video2stage/regenerate {video, seed?, lock?: {camera, performer, set}, samples?, vlm?, backdrop?,
                                      original?} -> {job}: ↻ Regenerate. The same rebuild with a new seed; the locked parts
                                      (and the depth, which has no seed) come from the last run's record (stages.py)
POST /soundstage/video2stage/fix_object {video, actor: {...}, mode: fix|add, sample?, point?: {x, y} (0-1), seed?}
                                      -> {job}: re-analyse ONE object (SAM 3.1 over the source frames) and rebuild it
                                      alone (fixobject.py). Its result is {actor, frames, notes}
Every job reports prompt_id / prompt_what: the GPU prompt it is waiting on, for the Activity bar.
"""
from __future__ import annotations

import asyncio
import time
import uuid

_REGISTERED = False
JOBS: dict[str, dict] = {}
TASKS: dict[str, "asyncio.Task"] = {}


def _prune():
    now = time.time()
    for k in [k for k, j in JOBS.items() if now - j["t"] > 3600]:
        JOBS.pop(k, None)
        TASKS.pop(k, None)


def regen_kwargs(body: dict) -> dict:
    """↻ Regenerate's body -> pipeline.run keywords: a new seed (never 0, the first build's) and the stages to reuse."""
    from . import stages
    seed = int(body.get("seed") or 0) or (int(time.time() * 1000) % 2_000_000_000) or 1
    lock = {k: bool((body.get("lock") or {}).get(k)) for k in ("camera", "performer", "set")}
    reuse = {"depth"} | {stages.LOCKS[k] for k, on in lock.items() if on}
    return {"seed": seed, "reuse": reuse, "lock_flags": lock, "tag": str(body.get("tag") or "") or None}


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from . import pipeline

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

    async def _work(jid, base, body, kind="rebuild"):
        job = JOBS[jid]
        job["state"] = "running"
        job["kind"] = kind
        from . import queue as Q
        Q.JOB.set(job)

        def progress(step, frac):
            job["step"], job["progress"] = step, round(frac, 2)
        try:
            if kind == "fix":
                from . import fixobject
                job["result"] = await fixobject.run(base, body, progress=progress)
            else:
                kw = regen_kwargs(body) if kind == "regenerate" else {}
                lock = kw.pop("lock_flags", None)
                job["result"] = await pipeline.run(
                    base, str(body.get("video") or ""), samples=min(max(int(body.get("samples") or 16), 8), 24),
                    use_vlm=bool(body.get("vlm", True)), backdrop=bool(body.get("backdrop", True)), progress=progress,
                    original=str(body.get("original") or ""), **kw)
                if lock is not None:
                    job["result"]["lock"] = lock
            job["state"] = "done"
        except asyncio.CancelledError:
            job["state"], job["step"] = "cancelled", "Cancelled"
        except Exception as exc:  # noqa: BLE001 - reported to the browser
            job["state"], job["error"] = "error", f"{type(exc).__name__}: {exc}" if not isinstance(exc, ValueError) else str(exc)

    @routes.post("/soundstage/video2stage")
    async def start(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict) or not body.get("video"):
            return web.json_response({"error": "send {video: <file in the input folder>}"}, status=400)
        _prune()
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"state": "queued", "step": "Queued", "progress": 0.0, "t": time.time()}
        TASKS[jid] = asyncio.get_event_loop().create_task(_work(jid, _base(request), body))
        return web.json_response({"job": jid})

    def _start(request, body, kind):
        _prune()
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"state": "queued", "step": "Queued", "progress": 0.0, "t": time.time(), "kind": kind}
        TASKS[jid] = asyncio.get_event_loop().create_task(_work(jid, _base(request), body, kind))
        return web.json_response({"job": jid})

    async def _body(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        return body if isinstance(body, dict) else {}

    @routes.post("/soundstage/video2stage/regenerate")
    async def regenerate(request):
        body = await _body(request)
        if not body.get("video"):
            return web.json_response({"error": "send {video, seed?, lock?: {camera, performer, set}}"}, status=400)
        return _start(request, body, "regenerate")

    @routes.post("/soundstage/video2stage/fix_object")
    async def fix_object(request):
        body = await _body(request)
        from . import fixobject
        err = fixobject.check_body(body)
        if err:
            return web.json_response({"error": err}, status=400)
        return _start(request, body, "fix")

    @routes.post("/soundstage/video2stage/cancel")
    async def cancel(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        jid = str((body or {}).get("id") or "") if isinstance(body, dict) else ""
        j = JOBS.get(jid)
        if not j:
            return web.json_response({"error": "no such job"}, status=404)
        t = TASKS.get(jid)
        if j["state"] in ("queued", "running") and t is not None and not t.done():
            t.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(t), 10)   # let it drop its own prompt from the queue
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            j["state"], j["step"] = "cancelled", "Cancelled"
        return web.json_response({"state": j["state"]})

    @routes.get("/soundstage/video2stage/job")
    async def status(request):
        j = JOBS.get(request.query.get("id", ""))
        if not j:
            return web.json_response({"error": "no such job"}, status=404)
        return web.json_response({k: v for k, v in j.items() if k != "t"})

    _REGISTERED = True
    return True
