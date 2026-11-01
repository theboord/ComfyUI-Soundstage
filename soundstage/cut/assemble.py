"""Flatten the cut into ONE video: each clip trimmed to its in/out frames, scaled to one frame size, joined in cut order
with its own sound (silence where a clip has none). A clip with no render yet becomes a titled black slate of the same
length, so the timing of the cut is always right and the gap is obvious.

POST /soundstage/cut/render_video
  {name, fps, width?, height?, clips: [{shot_id, name?, file: {filename, subfolder, type} | null, in, out}]}
-> {filename, subfolder, type, seconds, frames, missing: [shot ids], sources: {...}}

Pure ffmpeg (no ComfyUI imports in the core), so tests run it on tiny synthetic clips.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")


def _exe(name: str) -> str:
    exe = shutil.which(name)
    if not exe:
        raise RuntimeError(f"{name} not found on PATH")
    return exe


def probe(path: str) -> dict:
    """{has_audio, width, height, frames, fps} of a media file (frames/fps may be None for images)."""
    out = subprocess.run([_exe("ffprobe"), "-v", "error", "-show_streams", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    streams = json.loads(out).get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    fr = v.get("r_frame_rate") or "0/1"
    num, den = (fr.split("/") + ["1"])[:2]
    fps = float(num) / float(den) if float(den or 0) else None
    nb = v.get("nb_frames")
    return {"has_audio": any(s.get("codec_type") == "audio" for s in streams), "width": v.get("width"),
            "height": v.get("height"), "frames": int(nb) if nb and nb.isdigit() else None, "fps": fps}


def plan(clips: list[dict], fps: float) -> list[dict]:
    """Normalise cut entries: integer in < out, durations in seconds, kind video|image|slate."""
    out = []
    for c in clips:
        a = max(0, int(round(float(c.get("in", 0)))))
        b = max(a + 1, int(round(float(c.get("out", a + 1)))))
        path = c.get("path")
        kind = "slate"
        if path and os.path.isfile(path):
            kind = "image" if path.lower().endswith(IMAGE_EXT) else "video"
        out.append({**c, "in": a, "out": b, "frames": b - a, "seconds": (b - a) / fps, "kind": kind,
                    "path": path if kind != "slate" else None})
    return out


_FILTERS: dict[str, bool] = {}


def has_filter(name: str) -> bool:
    """drawtext needs an ffmpeg built with freetype; fall back to a plain black slate without it."""
    if name not in _FILTERS:
        out = subprocess.run([_exe("ffmpeg"), "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        _FILTERS[name] = re.search(rf"\s{re.escape(name)}\s", out) is not None
    return _FILTERS[name]


def _slate_text(s: str) -> str:
    # drawtext needs : \ ' % escaped; keep it short and plain.
    s = re.sub(r"[^\w .,#·()-]", "", s or "")[:60]
    return s.replace(":", r"\:").replace("%", r"\%")


def build_command(items: list[dict], out_path: str, fps: float, width: int, height: int) -> list[str]:
    """The ffmpeg command: one input per clip (black colour source for slates), concat filter, H.264 + AAC."""
    args = [_exe("ffmpeg"), "-y", "-v", "error"]
    filters, pairs = [], []
    idx = 0
    fit = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
           f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p")
    for i, it in enumerate(items):
        dur = f"{it['seconds']:.6f}"
        if it["kind"] == "video":
            args += ["-i", it["path"]]
            v_in = idx
            idx += 1
            filters.append(f"[{v_in}:v]trim=start_frame={it['in']}:end_frame={it['out']},setpts=PTS-STARTPTS,"
                           f"{fit},tpad=stop_mode=clone:stop_duration={dur},trim=duration={dur}[v{i}]")
            if it.get("has_audio"):
                filters.append(f"[{v_in}:a]atrim=start={it['in'] / fps:.6f}:end={it['out'] / fps:.6f},"
                               f"asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
                               f"apad,atrim=duration={dur}[a{i}]")
            else:
                args += ["-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo"]
                filters.append(f"[{idx}:a]anull[a{i}]")
                idx += 1
        elif it["kind"] == "image":
            args += ["-loop", "1", "-t", dur, "-i", it["path"]]
            filters.append(f"[{idx}:v]{fit},trim=duration={dur}[v{i}]")
            idx += 1
            args += ["-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{idx}:a]anull[a{i}]")
            idx += 1
        else:  # slate: black with the shot name, so a missing render is obvious but the timing holds
            args += ["-f", "lavfi", "-t", dur, "-i", f"color=c=black:s={width}x{height}:r={fps}"]
            label = _slate_text(f"{it.get('name') or it.get('shot_id') or 'shot'} · not rendered")
            draw = (f"drawtext=text='{label}':fontcolor=white@0.8:fontsize={max(14, height // 22)}:"
                    "x=(w-text_w)/2:y=(h-text_h)/2")
            filters.append(f"[{idx}:v]{draw + ',' if has_filter('drawtext') else ''}setsar=1,format=yuv420p[v{i}]")
            idx += 1
            args += ["-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{idx}:a]anull[a{i}]")
            idx += 1
        pairs.append(f"[v{i}][a{i}]")
    filters.append(f"{''.join(pairs)}concat=n={len(items)}:v=1:a=1[v][a]")
    args += ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-r", str(fps), "-movflags", "+faststart", out_path]
    return args


def assemble(clips: list[dict], out_path: str, fps: float = 24.0, width: int | None = None,
             height: int | None = None) -> dict:
    """clips: [{path|None, in, out, shot_id?, name?}] in cut order. Returns a summary."""
    if not clips:
        raise ValueError("the cut is empty")
    items = plan(clips, fps)
    for it in items:
        it["has_audio"] = False
        if it["kind"] == "video":
            info = probe(it["path"])
            it["has_audio"] = info["has_audio"]
            if width is None and info["width"]:
                width, height = info["width"], info["height"]
        elif it["kind"] == "image" and width is None:
            info = probe(it["path"])
            width, height = info["width"], info["height"]
    width, height = int(width or 1920), int(height or 1080)
    width, height = width - width % 2, height - height % 2
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    t0 = time.perf_counter()
    cmd = build_command(items, out_path, fps, width, height)
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {run.stderr.strip()[-600:]}")
    frames = sum(it["frames"] for it in items)
    return {"path": out_path, "frames": frames, "seconds": round(frames / fps, 3), "width": width, "height": height,
            "missing": [it.get("shot_id") for it in items if it["kind"] == "slate"],
            "sources": {str(it.get("shot_id")): it["kind"] for it in items},
            "encode_s": round(time.perf_counter() - t0, 2)}


# ---------------------------------------------------------------------------------------------------- route

_REGISTERED = False


def _resolve(file: dict | None) -> str | None:
    """A ComfyUI file ref {filename, subfolder, type} -> absolute path inside output/input/temp, or None."""
    if not isinstance(file, dict) or not file.get("filename"):
        return None
    import folder_paths
    base = {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(),
            "temp": folder_paths.get_temp_directory()}.get(file.get("type") or "output")
    if not base:
        return None
    path = os.path.abspath(os.path.join(base, file.get("subfolder") or "", os.path.basename(file["filename"])))
    if not path.startswith(os.path.abspath(base) + os.sep) or not os.path.isfile(path):
        return None
    return path


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    import asyncio

    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.post("/soundstage/cut/render_video")
    async def render_video(request):
        try:
            body = await request.json()
            fps = float(body.get("fps") or 24)
            clips = [{"shot_id": c.get("shot_id"), "name": c.get("name"), "in": c.get("in", 0), "out": c.get("out", 1),
                      "path": _resolve(c.get("file"))} for c in body.get("clips") or []]
            import folder_paths
            name = re.sub(r"[^\w-]+", "_", str(body.get("name") or "cut")).strip("_")[:40] or "cut"
            sub = "soundstage_cuts"
            fname = f"{name}_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
            out = os.path.join(folder_paths.get_output_directory(), sub, fname)
            res = await asyncio.to_thread(assemble, clips, out, fps, body.get("width"), body.get("height"))
            res.pop("path", None)
            return web.json_response({**res, "filename": fname, "subfolder": sub, "type": "output"})
        except Exception as exc:  # noqa: BLE001 - the panel shows the message
            return web.json_response({"error": str(exc)}, status=400)

    # Milestone 19: the full render (transitions, titles, subtitles, the mix at a loudness target, 9:16) lives next door.
    from . import render as _render
    _render.register(routes)
    _REGISTERED = True
    return True
