"""POST /soundstage/cut/gentransition: the API prompt for one generative transition (soundstage/cut/gentransitions.py).

Body: {style, frames, fps?, quality?, seed?, prompt?, sound?,
       a: {ref, frame?}, b: {ref, frame?}}      ref: an annotated file ("sub/x.mp4 [output]"); frame: for a video
-> {prompt (API JSON, SaveVideo id "save"), frames, seconds, size, style, a, b (the picture references used)}

A video's frame is written once as a PNG under input/soundstage_private/gentrans/ (the Seamless-loop fixer's
frame_png); a still is used as it is. The App queues the prompt itself, like the loop routes.
"""
from __future__ import annotations

import os

from . import gentransitions as GT

SUB = "soundstage_private/gentrans"
VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")


def _dirs() -> dict:
    import folder_paths
    return {"input": folder_paths.get_input_directory(), "output": folder_paths.get_output_directory(),
            "temp": folder_paths.get_temp_directory()}


def _list(folder: str) -> list[str]:
    try:
        import folder_paths
        return list(folder_paths.get_filename_list(folder) or [])
    except Exception:  # noqa: BLE001
        return []


def _size(path: str) -> tuple[int, int]:
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def _frame_png(src: str, index: int, dst: str) -> str:
    from ..loop import fix as F
    return F.frame_png(src, index, dst)


def picture(side: dict, dirs: dict, frame_png=_frame_png) -> tuple[str, str]:
    """(annotated reference, absolute path) of one end's picture: a still as it is, a video's frame as a PNG."""
    from ..handoff import workflow as W
    ref = str((side or {}).get("ref") or "")
    path = W.resolve(ref, dirs)
    if not path:
        raise ValueError(f"no such picture: {ref or '(empty)'}")
    if not path.lower().endswith(VIDEO_EXT):
        return ref, path
    frame = max(0, int((side or {}).get("frame") or 0))
    out_dir = os.path.join(dirs["input"], SUB)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    dst = os.path.join(out_dir, f"{stem}_f{frame}.png")
    if not os.path.isfile(dst) or os.path.getmtime(dst) < os.path.getmtime(path):
        frame_png(path, frame, dst)
    return f"{SUB}/{os.path.basename(dst)} [input]", dst


def prepare(body: dict, dirs: dict | None = None, list_files=_list, frame_png=_frame_png, size_of=_size) -> dict:
    from ..footage import graphs as FG
    dirs = dirs or _dirs()
    style = str(body.get("style") or "")
    if style not in GT.STYLES:
        raise ValueError(f"style: one of {', '.join(GT.ORDER)}")
    frames = int(body.get("frames") or GT.STYLES[style]["frames"])
    fps = float(body.get("fps") or 24.0)
    if not 1.0 <= fps <= 120.0:
        raise ValueError("fps: 1..120")
    weights = FG.resolve(GT.WEIGHTS, list_files)
    miss = FG.missing(weights)
    if miss:
        raise RuntimeError("Generative transitions need these models: " + ", ".join(GT.WEIGHTS[r][1][0] for r in miss))
    a_ref, a_path = picture(body.get("a") or {}, dirs, frame_png)
    b_ref, b_path = picture(body.get("b") or {}, dirs, frame_png)
    w, h = size_of(a_path)
    quality = "Final" if body.get("quality") == "Final" else "Draft"
    prompt = GT.build(weights, image_a=a_ref, image_b=b_ref, width=w, height=h, frames=frames, fps=fps, style=style,
                      prompt=str(body.get("prompt") or ""), seed=int(body.get("seed") or 7), quality=quality,
                      sound=bool(body.get("sound", True)), prefix=f"{GT.PREFIX}_{style}")
    from ..loop import graphs as LG
    W2, H2 = LG.render_size(w, h, LG.QUALITY[quality]["short"])
    k = 2 if LG.QUALITY[quality]["two_stage"] else 1
    return {"prompt": prompt, "frames": frames, "seconds": round(frames / fps, 3), "size": [W2 * k, H2 * k],
            "style": style, "quality": quality, "a": a_ref, "b": b_ref}


def add_routes(routes) -> None:
    import asyncio

    from aiohttp import web

    @routes.post("/soundstage/cut/gentransition")
    async def gentransition_route(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        try:
            return web.json_response(await asyncio.to_thread(prepare, body if isinstance(body, dict) else {}))
        except Exception as exc:  # noqa: BLE001 - the panel shows the message
            msg = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else f"{type(exc).__name__}: {exc}"
            return web.json_response({"error": msg}, status=422)
