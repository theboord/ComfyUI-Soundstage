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


# ---- ④ Frame's Auto prompt (look/autoprompt.py): a local vision LLM writes the frame prompt -------------------------

def _base_url() -> str:
    try:
        port = getattr(PromptServer.instance, "port", None) or 8188
    except Exception:  # noqa: BLE001
        port = 8188
    return f"http://127.0.0.1:{port}"


def _ref_images(ref_files: str) -> list[tuple[bytes, str]]:
    """The frame node's ref_files ('file | label' lines, input-relative) as (bytes, label); unreadable ones skipped."""
    import os
    import folder_paths
    from .autoprompt import MAX_REFS
    root = os.path.realpath(folder_paths.get_input_directory())
    out = []
    for line in str(ref_files or "").splitlines():
        f, _, label = line.partition("|")
        f = f.strip()
        if not f:
            continue
        path = os.path.realpath(os.path.join(root, f))
        if not path.startswith(root + os.sep) or not os.path.isfile(path):
            continue
        with open(path, "rb") as fh:
            out.append((fh.read(), label.strip()))
        if len(out) >= MAX_REFS:
            break
    return out


@routes.get("/soundstage/look/autoprompt/status")
async def get_autoprompt_status(request):
    import asyncio
    from .autoprompt import status
    return web.json_response(await asyncio.get_running_loop().run_in_executor(None, status, _base_url()))


@routes.post("/soundstage/look/autoprompt")
async def post_autoprompt(request):
    """{look, scene, model | target, image (data URL of frame 1), ref_files, force, steps} -> autoprompt.auto_prompt()."""
    import asyncio
    from . import autoprompt as A
    try:
        body = await request.json()
        assert isinstance(body, dict)
    except Exception:
        return web.json_response({"error": "expected JSON {look, scene, model, image, ref_files}"}, status=400)
    target = body.get("target") if body.get("target") in A.TARGETS else A.target_for(body.get("model") or "")

    def run():
        frame = A.decode_data_url(body["image"]) if body.get("image") else None
        refs = _ref_images(body.get("ref_files") or "")
        try:
            steps = int(body.get("steps") or 0) or None
        except (TypeError, ValueError):
            steps = None
        return A.auto_prompt(body.get("look") or {}, body.get("scene") or {}, target, frame, refs,
                             backend=A.pick_backend(_base_url()), force=bool(body.get("force")), steps=steps)

    try:
        return web.json_response(await asyncio.get_running_loop().run_in_executor(None, run))
    except Exception as e:  # noqa: BLE001 - never break the panel
        return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=422)
