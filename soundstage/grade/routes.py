"""Grade routes (registered by the pack's __init__ like the other feature routes; CPU only, no models).

POST /soundstage/grade/stats       {frames: [Frame]}                  -> {stats: {id: Stats}}
POST /soundstage/grade/match       {hero: Frame, takes: [Frame]}      -> {hero: id, grades: {id: {cdl, error_before,
                                                                          error_after, stats, graded}}, hero_stats}
POST /soundstage/grade/steal       {image | url | path}               -> steal_look(): look_patch, stock, cdl, curve...
POST /soundstage/grade/continuity  {shots: [{id, name, scene, stats}]} -> {flags}

Frame = {id, image?: data: URL, url?: a ComfyUI /view URL, path?: a file inside output/input/temp, at?: 0..1 where
in a video to read (default the middle), cdl?: a CDL to grade it with before its stats}. Videos are read with
ffmpeg (one frame), images with Pillow.
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import subprocess

import numpy as np

from . import cdl as CDL
from .colour import downscale, frame_stats
from .continuity import check_cut
from .steal import steal_look

_REGISTERED = False
_VIDEO = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".gif")


def _roots():
    try:
        import folder_paths
        return {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(),
                "temp": folder_paths.get_temp_directory()}
    except Exception:  # noqa: BLE001 - outside ComfyUI (tests): no file access
        return {}


def _safe_path(sub, name, typ="output"):
    base = _roots().get(typ or "output")
    if not base or not name:
        return None
    base = os.path.abspath(base)
    p = os.path.abspath(os.path.join(base, sub or "", os.path.basename(name)))
    return p if os.path.commonpath([base, p]) == base and os.path.isfile(p) else None


def _resolve(fr: dict):
    from ..cut.export import parse_view_url
    if fr.get("url"):
        v = parse_view_url(fr["url"])
        if v:
            return _safe_path(v[0], v[1], v[2])
    if fr.get("path"):
        p = str(fr["path"])
        for typ in ("output", "input", "temp"):
            hit = _safe_path(os.path.dirname(p), os.path.basename(p), typ)
            if hit:
                return hit
    return None


def _video_frame(path, at=0.5):
    from ..takecheck.video import probe
    info = probe(path)
    t = max(0.0, float(info.get("duration") or 0) * min(1.0, max(0.0, float(at))))
    w = min(640, info["width"] or 640) // 2 * 2
    h = max(2, int(round((info["height"] or 360) * w / max(1, info["width"] or 640) / 2)) * 2)
    out = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-vf",
                          f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=60)
    if out.returncode != 0 or len(out.stdout) < w * h * 3:
        raise RuntimeError(f"could not read a frame of {os.path.basename(path)}")
    return np.frombuffer(out.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)


def load_frame(fr: dict) -> np.ndarray:
    """A Frame -> float RGB [H, W, 3] (long side <= 512)."""
    from PIL import Image
    img = fr.get("image")
    if isinstance(img, str) and img.startswith("data:"):
        raw = base64.b64decode(img.split(",", 1)[1])
        return downscale(np.asarray(Image.open(io.BytesIO(raw)).convert("RGB")), 512)
    path = _resolve(fr)
    if not path:
        raise ValueError(f"frame {fr.get('id', '')!s}: no image, or the file is not in ComfyUI's output/input/temp")
    if path.lower().endswith(_VIDEO):
        return downscale(_video_frame(path, fr.get("at", 0.5)), 512)
    with Image.open(path) as im:
        return downscale(np.asarray(im.convert("RGB")), 512)


def _stats_of(fr):
    img = load_frame(fr)
    st = frame_stats(img)
    if fr.get("cdl") and not CDL.is_identity(fr["cdl"]):
        st = {**st, "graded": frame_stats(CDL.apply_cdl(img, fr["cdl"]))}
    return st


def stats(body):
    out, errors = {}, {}
    for i, fr in enumerate((body or {}).get("frames") or []):
        fid = str(fr.get("id", i))
        try:
            out[fid] = _stats_of(fr)
        except Exception as e:  # noqa: BLE001 - one bad frame never fails the rest
            errors[fid] = str(e)
    return {"stats": out, "errors": errors}


def match(body):
    hero = (body or {}).get("hero") or {}
    himg = load_frame(hero)
    hid = str(hero.get("id", "hero"))
    grades, errors = {}, {}
    for i, fr in enumerate((body or {}).get("takes") or []):
        fid = str(fr.get("id", i))
        if fid == hid:
            continue
        try:
            img = load_frame(fr)
            r = CDL.fit_cdl(img, himg)
            grades[fid] = {**r, "stats": frame_stats(img), "graded": frame_stats(CDL.apply_cdl(img, r["cdl"]))}
        except Exception as e:  # noqa: BLE001
            errors[fid] = str(e)
    return {"hero": hid, "hero_stats": frame_stats(himg), "grades": grades, "errors": errors}


def _stock_labels():
    try:
        from ..look.vocab import options
        return {o["id"]: o["label"] for o in options("film_stock")}
    except Exception:  # noqa: BLE001
        return {}


def steal(body):
    return steal_look(load_frame(body or {}), _stock_labels())


def continuity(body):
    return {"flags": check_cut((body or {}).get("shots") or [])}


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web
    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    def handler(fn):
        async def h(request):
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001
                return web.json_response({"error": "expected JSON"}, status=400)
            try:
                return web.json_response(await asyncio.to_thread(fn, body))
            except Exception as e:  # noqa: BLE001 - a bad frame is the user's problem to see, not a 500
                return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=422)
        return h

    for name, fn in (("stats", stats), ("match", match), ("steal", steal), ("continuity", continuity)):
        routes.post(f"/soundstage/grade/{name}")(handler(fn))
    _REGISTERED = True
    return True
