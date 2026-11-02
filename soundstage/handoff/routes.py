"""HTTP routes for Track B's one-clicks (registered from soundstage/routes.py; register() is idempotent).

GET  /soundstage/handoff/workflow?ref=     -> the graph inside a take {name, kind, workflow?, prompt?, recipe?}
POST /soundstage/loop/prompt               {source, seconds?, prompt?, seed?, quality?, sound?, end_source?, bridge?}
                                           -> {prompt (API JSON, to queue), frames, size}
POST /soundstage/loop/seam                 {ref} -> the seam meter's report (CPU)
POST /soundstage/loop/fix                  {ref, how: seal|trim|bridge|join, bridge_ref?, seed?, prompt?}
                                           seal/trim/join -> {ref, before, after, summary}; bridge -> {prompt, clip_end}
GET  /soundstage/reshoot/limits            -> the safe range and the presets
POST /soundstage/reshoot                   {source, move, quality?, seed?, prompt?, keep_sound?, preview_only?} -> {job}
GET  /soundstage/reshoot/job?id=           -> {state, step, progress, result?, error?}
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid

_REGISTERED = False
JOBS: dict[str, dict] = {}
LOOP_SUB = "soundstage_private/loop"


def _dirs() -> dict:
    import folder_paths
    return {"input": folder_paths.get_input_directory(), "output": folder_paths.get_output_directory(),
            "temp": folder_paths.get_temp_directory()}


def _out_ref(path: str) -> str:
    """An absolute path in input/output/temp -> its annotated reference."""
    for kind, base in _dirs().items():
        base = os.path.realpath(base)
        p = os.path.realpath(path)
        if p.startswith(base + os.sep):
            return f"{os.path.relpath(p, base).replace(os.sep, '/')} [{kind}]"
    raise ValueError("not inside ComfyUI's folders")


def _size(path: str) -> tuple[int, int]:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        from PIL import Image
        with Image.open(path) as im:
            return im.size
    from ..takecheck import video as V
    i = V.probe(path)
    return i["width"], i["height"]


def _list(folder: str) -> list[str]:
    try:
        import folder_paths
        return list(folder_paths.get_filename_list(folder) or [])
    except Exception:  # noqa: BLE001
        return []


def loop_prompt(body: dict) -> dict:
    from ..footage import graphs as FG
    from ..loop import graphs as LG
    from . import workflow as W
    src = str(body.get("source") or "")
    path = W.resolve(src)
    if not path:
        raise ValueError("source: a still or a take in ComfyUI's input/output/temp folders")
    end = str(body.get("end_source") or "")
    if end and not W.resolve(end):
        raise ValueError("end_source: not found")
    weights = FG.resolve(LG.LOOP_WEIGHTS, _list)
    miss = FG.missing(weights)
    if miss:
        raise RuntimeError("Loop needs these models: " + ", ".join(LG.LOOP_WEIGHTS[r][1][0] for r in miss))
    w, h = _size(path)
    seconds = min(10.0, max(0.7, float(body.get("seconds") or 4.0)))
    quality = "Final" if body.get("quality") == "Final" else "Draft"
    prompt = LG.build(weights, source=src, end_source=end, width=w, height=h, seconds=seconds,
                      prompt=str(body.get("prompt") or ""), seed=int(body.get("seed") or 7), quality=quality,
                      sound=bool(body.get("sound", True)), bridge=bool(body.get("bridge")),
                      prefix=f"{LOOP_SUB}/{'bridge' if body.get('bridge') else 'loop'}")
    W2, H2 = LG.render_size(w, h, LG.QUALITY[quality]["short"])
    k = 2 if LG.QUALITY[quality]["two_stage"] else 1
    return {"prompt": prompt, "frames": LG.ltx_frames(seconds), "size": [W2 * k, H2 * k], "seconds": seconds,
            "quality": quality}


def seam(ref: str) -> dict:
    from ..loop import seam as S
    from . import workflow as W
    path = W.resolve(ref)
    if not path:
        raise ValueError("ref: no such take")
    rep = S.measure_file(path)
    rep["ref"] = ref
    return rep


def fix(body: dict) -> dict:
    from ..loop import fix as F
    from ..loop import graphs as LG
    from ..loop import seam as S
    from . import workflow as W
    ref = str(body.get("ref") or "")
    path = W.resolve(ref)
    if not path:
        raise ValueError("ref: no such take")
    how = body.get("how")
    out_dir = os.path.join(_dirs()["output"], LOOP_SUB)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    before = S.measure_file(path)
    fps = float(before.get("fps") or 24.0)
    if how == "seal":
        if not before["dup_last"]:
            return {"ref": ref, "before": before, "after": before, "summary": F.summary(before, before, "nothing to drop")}
        dst = os.path.join(out_dir, f"{stem}_sealed.mp4")
        F.trim(path, dst, 0, before["played"] - 1, fps)
        how_words = "dropped the duplicate last frame"
    elif how == "trim":
        from ..takecheck import video as V
        pair = F.best_pair(V.read_frames(path, width=256, gray=True))
        dst = os.path.join(out_dir, f"{stem}_trim{pair['start']}-{pair['end']}.mp4")
        F.trim(path, dst, pair["start"], pair["end"], fps)
        how_words = f"trimmed to frames {pair['start']}-{pair['end']} of {pair['frames']}"
    elif how == "bridge":
        in_dir = os.path.join(_dirs()["input"], LOOP_SUB)
        os.makedirs(in_dir, exist_ok=True)
        from ..takecheck import video as V
        last_i = F.clean_end(V.read_frames(path, width=256, gray=True), before["played"])
        a = F.frame_png(path, last_i, os.path.join(in_dir, f"{stem}_f{last_i}.png"))
        b = F.frame_png(path, 0, os.path.join(in_dir, f"{stem}_f0.png"))
        res = loop_prompt({"source": _out_ref(a), "end_source": _out_ref(b), "seconds": F.BRIDGE_SECONDS,
                           "prompt": body.get("prompt") or "", "seed": body.get("seed") or 11,
                           "quality": body.get("quality") or "Draft", "sound": True, "bridge": True})
        res.update(clip_end=last_i, before=before)
        return res
    elif how == "join":
        bpath = W.resolve(str(body.get("bridge_ref") or ""))
        if not bpath:
            raise ValueError("bridge_ref: render the bridge first")
        dst = os.path.join(out_dir, f"{stem}_bridged.mp4")
        F.join(path, bpath, dst, int(body.get("clip_end", before["played"] - 1)), fps)
        how_words = "added a bridge render from the last frame back to the first"
    else:
        raise ValueError("how: seal, trim, bridge or join")
    after = S.measure_file(dst)
    return {"ref": _out_ref(dst), "before": before, "after": after, "summary": F.summary(before, after, how_words)}


def _prune():
    now = time.time()
    for k in [k for k, j in JOBS.items() if now - j["t"] > 6 * 3600]:
        JOBS.pop(k, None)


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

    async def _body(request) -> dict:
        try:
            b = await request.json()
        except Exception:  # noqa: BLE001
            b = {}
        return b if isinstance(b, dict) else {}

    def _err(exc: Exception, status: int = 422):
        return web.json_response({"error": str(exc) if isinstance(exc, (ValueError, RuntimeError)) else
                                  f"{type(exc).__name__}: {exc}"}, status=status)

    @routes.get("/soundstage/handoff/workflow")
    async def take_workflow(request):
        from . import workflow as W
        path = W.resolve(request.query.get("ref", ""))
        if not path:
            return web.json_response({"error": "send ?ref=sub/name.mp4 [output] (a file in input/output/temp)"}, status=404)
        try:
            return web.json_response(await asyncio.to_thread(W.handoff, path))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @routes.post("/soundstage/loop/prompt")
    async def loop_prompt_route(request):
        try:
            return web.json_response(await asyncio.to_thread(loop_prompt, await _body(request)))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @routes.post("/soundstage/loop/seam")
    async def loop_seam_route(request):
        b = await _body(request)
        try:
            return web.json_response(await asyncio.to_thread(seam, str(b.get("ref") or "")))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @routes.post("/soundstage/loop/fix")
    async def loop_fix_route(request):
        try:
            return web.json_response(await asyncio.to_thread(fix, await _body(request)))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @routes.get("/soundstage/reshoot/limits")
    async def reshoot_limits(request):
        from ..reshoot import plan as P
        return web.json_response({"limits": P.LIMITS, "presets": P.PRESETS})

    async def _reshoot(jid, base, body):
        from .. import reshoot as R
        job = JOBS[jid]
        job["state"] = "running"

        def progress(step, frac):
            job["step"], job["progress"] = step, round(frac, 2)
        try:
            job["result"] = await R.run(base, str(body.get("source") or ""), body.get("move") or {},
                                        quality="Final" if body.get("quality") == "Final" else "Draft",
                                        seed=int(body.get("seed") or 7), prompt=str(body.get("prompt") or ""),
                                        keep_sound=bool(body.get("keep_sound", True)), progress=progress,
                                        render=not body.get("preview_only"),
                                        guide="depth" if body.get("guide") == "depth" else "edges",
                                        frame_edges=body.get("frame_edges", True) is not False)
            job["state"] = "done"
        except Exception as exc:  # noqa: BLE001 - reported to the browser
            job["state"] = "error"
            job["error"] = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else f"{type(exc).__name__}: {exc}"

    @routes.post("/soundstage/reshoot")
    async def reshoot_start(request):
        body = await _body(request)
        if not body.get("source"):
            return web.json_response({"error": "send {source: take reference, move: {orbit_deg, tilt_deg, dolly, lens}}"},
                                     status=400)
        _prune()
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"state": "queued", "step": "Queued", "progress": 0.0, "t": time.time()}
        asyncio.get_event_loop().create_task(_reshoot(jid, _base(request), body))
        return web.json_response({"job": jid})

    @routes.get("/soundstage/reshoot/job")
    async def reshoot_job(request):
        j = JOBS.get(request.query.get("id", ""))
        if not j:
            return web.json_response({"error": "no such job"}, status=404)
        return web.json_response({k: v for k, v in j.items() if k != "t"})

    _REGISTERED = True
    return True
