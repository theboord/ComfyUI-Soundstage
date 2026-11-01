"""HTTP routes for take checks (Milestone 16). Registered from the pack's __init__ (register()).

POST /soundstage/takecheck            {file: {filename, subfolder, type}, force?} -> the take's checks + blocking score
GET  /soundstage/takecheck/recipe     ?filename=&subfolder=&type= -> the stage + shot recipe inside the MP4
GET  /soundstage/takecheck/timing     -> measured render times per rung (from ComfyUI's history)
GET  /soundstage/takecheck/readiness  ?still=&video=&l2r=1&krea=0 -> what each App step still needs

Also installs the on-prompt handler that writes the recipe into every Soundstage render (recipe.on_prompt).
"""
from __future__ import annotations

import asyncio
import os
import shutil

from . import check as C
from . import recipe as R
from . import store

_REGISTERED = False
_SEM = None


def _resolve(file: dict | None) -> str | None:
    """A ComfyUI file ref {filename, subfolder, type} -> absolute path inside output/input/temp, or None."""
    if not isinstance(file, dict) or not file.get("filename"):
        return None
    import folder_paths
    base = {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(),
            "temp": folder_paths.get_temp_directory()}.get(file.get("type") or "output")
    if not base:
        return None
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, file.get("subfolder") or "", os.path.basename(file["filename"])))
    if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
        return None
    return path


def run(path: str, force: bool = False) -> dict:
    """The cached checks of a take, recomputed when the detectors changed or `force`; the actor half of the
    blocking score is merged in whenever the SAM pass has stored it."""
    res = None if force else store.load(path, "checks")
    if not res or res.get("version") != C.VERSION:
        res = C.check_take(path)
        store.save(path, "checks", res)
    actors = store.load(path, "actors")
    if actors is not None:
        rec = R.read(path)
        res["blocking"] = C.blocking_summary(actors, (res.get("blocking") or {}).get("camera"), (rec or {}).get("scene"))
    return res


def register(routes=None) -> bool:
    global _REGISTERED, _SEM
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes
        try:
            PromptServer.instance.add_on_prompt_handler(R.on_prompt)
        except Exception:  # noqa: BLE001 - an older ComfyUI: renders just don't carry the recipe
            pass
    _SEM = asyncio.Semaphore(2)   # two takes at a time: the checks are CPU work beside a GPU render

    @routes.post("/soundstage/takecheck")
    async def takecheck(request):
        try:
            body = await request.json()
            path = _resolve(body.get("file"))
            if not path:
                return web.json_response({"error": "no such take"}, status=404)
            async with _SEM:
                res = await asyncio.to_thread(run, path, bool(body.get("force")))
            return web.json_response(res)
        except Exception as exc:  # noqa: BLE001 - the chip shows the message
            return web.json_response({"error": str(exc)}, status=422)

    @routes.get("/soundstage/takecheck/recipe")
    async def recipe(request):
        q = request.query
        path = _resolve({"filename": q.get("filename"), "subfolder": q.get("subfolder", ""), "type": q.get("type", "output")})
        if not path:
            return web.json_response({"error": "no such file"}, status=404)
        rec = await asyncio.to_thread(R.read, path)
        if not rec:
            return web.json_response({"error": "this video carries no Soundstage recipe"}, status=404)
        return web.json_response(rec)

    @routes.get("/soundstage/takecheck/timing")
    async def timing(request):
        from server import PromptServer

        from . import timing as T
        try:
            hist = PromptServer.instance.prompt_queue.get_history(max_items=200)
        except Exception:  # noqa: BLE001
            hist = {}
        samples = await asyncio.to_thread(T.update, hist)
        return web.json_response(T.summary(samples))

    @routes.get("/soundstage/takecheck/readiness")
    async def readiness(request):
        import folder_paths
        import nodes

        from . import readiness as RD
        q = request.query
        chosen = {"still": q.get("still") or None, "video": q.get("video") or None,
                  "l2r": q.get("l2r", "1") not in ("0", "false"), "krea": q.get("krea", "0") in ("1", "true")}
        res = RD.needs(chosen, set(nodes.NODE_CLASS_MAPPINGS), folder_paths.get_filename_list, shutil.which)
        return web.json_response({"steps": res, "doc": RD.MODELS_DOC})

    _REGISTERED = True
    return True
