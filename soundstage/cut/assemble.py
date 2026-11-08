"""Flatten the cut into ONE video: each clip trimmed to its in/out frames, scaled to one frame size, joined in cut order
with its own sound (silence where a clip has none). A clip with no render yet becomes a titled black slate of the same
length, so the timing of the cut is always right and the gap is obvious.

POST /soundstage/cut/render_video
  {name, fps, width?, height?, clips: [{shot_id, name?, file: {filename, subfolder, type} | null, in, out}
                                      | {gap: true, frames}]}
-> {filename, subfolder, type, seconds, frames, gaps, missing: [shot ids], sources: {...}}

A gap (a true gap in the cut, {kind: "gap"} on the App side, web/onevideo.mjs) is black picture + silence of exactly its
length. Timing is frame-accurate at the cut's rate: 23.976 / 29.97 / 59.94 are the NTSC rationals 24000/1001 etc., and
each segment's audio is cut to a whole number of 48 kHz samples from its record start, so sound after a gap stays in
sync (timeline()).

Pure ffmpeg (no ComfyUI imports in the core), so tests run it on tiny synthetic clips.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from fractions import Fraction

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


AUDIO_RATE = 48000
_NTSC = (24, 30, 48, 60, 120)
MAX_FPS = 1000

# Hard caps, so a malformed cut can't ask ffmpeg for hours of black and silence (a gap like {in: 0, out: 1e12} would
# never finish and would fill the output disk). MAX_GAP_SECONDS mirrors web/onevideo.mjs, which refuses first.
MAX_GAP_SECONDS = 600            # one gap: 10 minutes
MAX_OUTPUT_SECONDS = 4 * 3600    # the whole joined video: 4 hours
# ffmpeg gets a timeout too: a fixed floor plus a multiple of the output's length, never more than the ceiling.
TIMEOUT_FLOOR_S = 300
TIMEOUT_PER_OUTPUT_S = 8
TIMEOUT_CEILING_S = 6 * 3600


def _bad_fps(fps) -> ValueError:
    return ValueError(f"the cut's frame rate ({str(fps)[:20]}) isn't a usable rate: it must be a positive number of "
                      "frames per second, like 24, 23.976 or 30000/1001")


def rational_fps(fps) -> Fraction:
    """The cut's frame rate as an exact fraction: 23.976 -> 24000/1001, 29.97 -> 30000/1001, 24 -> 24. None -> 24.
    Anything else that isn't a positive, finite rate up to MAX_FPS (0, -24, '24/0', 'abc', nan, True) is a ValueError
    in plain words, never a ZeroDivisionError or an ffmpeg failure."""
    if fps is None:
        return Fraction(24)
    if isinstance(fps, bool):
        raise _bad_fps(fps)
    if isinstance(fps, Fraction):
        rate = fps
    elif isinstance(fps, str) and "/" in fps:
        a, _, b = fps.partition("/")
        try:
            num, den = int(a), int(b)
        except ValueError:
            raise _bad_fps(fps) from None
        if den <= 0 or num <= 0:
            raise _bad_fps(fps)
        rate = Fraction(num, den)
    else:
        try:
            f = float(fps)
        except (TypeError, ValueError):
            raise _bad_fps(fps) from None
        if not (f > 0) or f == float("inf"):
            raise _bad_fps(fps)
        rate = None
        for n in _NTSC:
            if abs(f - n * 1000 / 1001) < 0.006:
                rate = Fraction(n * 1000, 1001)
                break
        if rate is None:
            rate = Fraction(f).limit_denominator(1001)
    if rate <= 0 or rate > MAX_FPS:
        raise _bad_fps(fps)
    return rate


def max_gap_frames(rate: Fraction) -> int:
    """The longest gap in frames at this rate (floor of MAX_GAP_SECONDS x rate); web/onevideo.mjs maxGapFrames."""
    return int(MAX_GAP_SECONDS * rate)


def _whole(v, what: str) -> int:
    """A frame number from the request, as an int; a ValueError in plain words for null / text / nan / inf."""
    if v is None or isinstance(v, bool):
        raise ValueError(f"{what} has no length")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} has a length that isn't a number") from None
    if f != f or f in (float("inf"), float("-inf")):
        raise ValueError(f"{what} has a length that isn't a number")
    return int(round(f))


def ffmpeg_timeout(seconds: float) -> float:
    return float(min(TIMEOUT_CEILING_S, TIMEOUT_FLOOR_S + TIMEOUT_PER_OUTPUT_S * max(0.0, seconds)))


def rate_str(rate: Fraction) -> str:
    return str(rate.numerator) if rate.denominator == 1 else f"{rate.numerator}/{rate.denominator}"


def timeline(items: list[dict], fps) -> list[dict]:
    """Record position of every segment: start/end frame, and start/end audio sample at 48 kHz, each rounded from the
    exact record time (so samples never drift, whatever the rate). Total frames = sum of clip and gap frames."""
    rate = rational_fps(fps)
    out, f = [], 0
    for it in items:
        a, b = f, f + int(it["frames"])
        sa, sb = round(Fraction(a) * AUDIO_RATE / rate), round(Fraction(b) * AUDIO_RATE / rate)
        out.append({"start_frame": a, "end_frame": b, "start_sample": sa, "end_sample": sb, "samples": sb - sa,
                    "start_s": float(Fraction(a) / rate)})
        f = b
    return out


def plan(clips: list[dict], fps) -> list[dict]:
    """Normalise cut entries: integer in < out, durations in seconds, kind video|image|slate|gap.

    A gap's length is `frames`, else out - in when both are given; a gap with neither, a null / negative / non-number
    length, or one longer than MAX_GAP_SECONDS is a ValueError (refused, never dropped); a zero-length gap is no gap.
    The whole cut longer than MAX_OUTPUT_SECONDS is refused too."""
    rate = rational_fps(fps)
    cap = max_gap_frames(rate)
    out = []
    for i, c in enumerate(clips):
        if c.get("gap"):
            what = f"gap {i + 1} in the cut"
            if "frames" in c:
                n = _whole(c.get("frames"), what)
            elif c.get("in") is not None and c.get("out") is not None:
                n = _whole(c.get("out"), what) - _whole(c.get("in"), what)
            else:
                raise ValueError(f"{what} has no length")
            if n < 0:
                raise ValueError(f"{what} has a negative length ({n} frames)")
            if n > cap:
                raise ValueError(f"{what} is longer than {MAX_GAP_SECONDS // 60} minutes ({n} frames); "
                                 "one-video export can't include it")
            if n == 0:
                continue   # a zero-length gap is no gap
            out.append({**c, "in": 0, "out": n, "frames": n, "seconds": float(n / rate), "kind": "gap", "path": None})
            continue
        what = f"clip {i + 1} ({c.get('name') or c.get('shot_id') or 'shot'})"
        a = max(0, _whole(c.get("in", 0), what))
        b = max(a + 1, _whole(c.get("out", a + 1), what))
        path = c.get("path")
        kind = "slate"
        if path and os.path.isfile(path):
            kind = "image" if path.lower().endswith(IMAGE_EXT) else "video"
        out.append({**c, "in": a, "out": b, "frames": b - a, "seconds": float((b - a) / rate), "kind": kind,
                    "path": path if kind != "slate" else None})
        if b - a > MAX_OUTPUT_SECONDS * rate:
            raise ValueError(f"{what} is longer than {MAX_OUTPUT_SECONDS // 3600} hours; one-video export can't include it")
    total = sum(it["frames"] for it in out)
    if total > MAX_OUTPUT_SECONDS * rate:
        raise ValueError(f"the joined cut would run {float(total / rate) / 3600:.1f} hours, longer than the "
                         f"{MAX_OUTPUT_SECONDS // 3600}-hour limit for one video")
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


def build_command(items: list[dict], out_path: str, fps, width: int, height: int) -> list[str]:
    """The ffmpeg command: one input per clip (black colour source for slates and gaps), concat filter, H.264 + AAC."""
    rate = rational_fps(fps)
    fps = rate_str(rate)
    args = [_exe("ffmpeg"), "-y", "-v", "error"]
    filters, pairs = [], []
    idx = 0
    tl = timeline(items, rate)
    fit = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
           f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p")
    for i, it in enumerate(items):
        dur = f"{it['seconds']:.6f}"
        pad = f"{it['seconds'] + 1:.6f}"   # sources run a little long; trim / atrim cut them to exact frames / samples
        if it["kind"] == "gap":   # black picture + silence of exactly the gap's length
            args += ["-f", "lavfi", "-t", pad, "-i", f"color=c=black:s={width}x{height}:r={fps}"]
            filters.append(f"[{idx}:v]trim=end_frame={it['frames']},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v{i}]")
            idx += 1
            args += ["-f", "lavfi", "-t", pad, "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
            filters.append(f"[{idx}:a]atrim=end_sample={tl[i]['samples']},asetpts=PTS-STARTPTS[a{i}]")
            idx += 1
            pairs.append(f"[v{i}][a{i}]")
            continue
        if it["kind"] == "video":
            args += ["-i", it["path"]]
            v_in = idx
            idx += 1
            filters.append(f"[{v_in}:v]trim=start_frame={it['in']}:end_frame={it['out']},setpts=PTS-STARTPTS,"
                           f"{fit},tpad=stop_mode=clone:stop_duration={dur},trim=end_frame={it['frames']}[v{i}]")
            if it.get("has_audio"):
                # whole samples from the segment's record start (timeline()), so sound after a gap stays in sync
                filters.append(f"[{v_in}:a]atrim=start={float(it['in'] / rate):.6f}:end={float(it['out'] / rate):.6f},"
                               f"asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
                               f"apad,atrim=end_sample={tl[i]['samples']}[a{i}]")
            else:
                args += ["-f", "lavfi", "-t", pad, "-i", "anullsrc=r=48000:cl=stereo"]
                filters.append(f"[{idx}:a]atrim=end_sample={tl[i]['samples']},asetpts=PTS-STARTPTS[a{i}]")
                idx += 1
        elif it["kind"] == "image":
            args += ["-loop", "1", "-t", pad, "-i", it["path"]]
            filters.append(f"[{idx}:v]{fit},trim=end_frame={it['frames']},setpts=PTS-STARTPTS[v{i}]")
            idx += 1
            args += ["-f", "lavfi", "-t", pad, "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{idx}:a]atrim=end_sample={tl[i]['samples']},asetpts=PTS-STARTPTS[a{i}]")
            idx += 1
        else:  # slate: black with the shot name, so a missing render is obvious but the timing holds
            args += ["-f", "lavfi", "-t", pad, "-i", f"color=c=black:s={width}x{height}:r={fps}"]
            label = _slate_text(f"{it.get('name') or it.get('shot_id') or 'shot'} · not rendered")
            draw = (f"drawtext=text='{label}':fontcolor=white@0.8:fontsize={max(14, height // 22)}:"
                    "x=(w-text_w)/2:y=(h-text_h)/2")
            filters.append(f"[{idx}:v]{draw + ',' if has_filter('drawtext') else ''}trim=end_frame={it['frames']},setpts=PTS-STARTPTS,"
                           f"setsar=1,format=yuv420p[v{i}]")
            idx += 1
            args += ["-f", "lavfi", "-t", pad, "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{idx}:a]atrim=end_sample={tl[i]['samples']},asetpts=PTS-STARTPTS[a{i}]")
            idx += 1
        pairs.append(f"[v{i}][a{i}]")
    filters.append(f"{''.join(pairs)}concat=n={len(items)}:v=1:a=1[v][a]")
    args += ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-r", str(fps), "-movflags", "+faststart", out_path]
    return args


def assemble(clips: list[dict], out_path: str, fps=24.0, width: int | None = None,
             height: int | None = None, timeout: float | None = None) -> dict:
    """clips: [{path|None, in, out, shot_id?, name?}] in cut order. Returns a summary."""
    if not clips:
        raise ValueError("the cut is empty")
    rate = rational_fps(fps)
    items = plan(clips, rate)
    if not any(it["kind"] != "gap" for it in items):
        raise ValueError("the cut has no clips, only gaps")
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
    cmd = build_command(items, out_path, rate, width, height)
    frames = sum(it["frames"] for it in items)
    limit = ffmpeg_timeout(float(frames / rate)) if timeout is None else float(timeout)
    try:
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=limit)
    except subprocess.TimeoutExpired:
        # subprocess.run has already killed ffmpeg; don't leave a half-written file behind
        _remove(out_path)
        raise RuntimeError(f"ffmpeg took longer than {limit:.0f} s joining the cut and was stopped; nothing was saved") from None
    if run.returncode != 0:
        _remove(out_path)
        raise RuntimeError(f"ffmpeg failed: {run.stderr.strip()[-600:]}")
    return {"path": out_path, "frames": frames, "seconds": round(float(frames / rate), 3), "width": width, "height": height,
            "gaps": sum(1 for it in items if it["kind"] == "gap"),
            "missing": [it.get("shot_id") for it in items if it["kind"] == "slate"],
            "sources": {str(it.get("shot_id")): it["kind"] for it in items if it["kind"] != "gap"},
            "encode_s": round(time.perf_counter() - t0, 2)}


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


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
            fps = rational_fps(body.get("fps"))   # None -> 24; 0 / negative / x/0 -> a plain-words 400
            clips = [{"gap": True, **{k: c[k] for k in ("frames", "in", "out") if k in c}} if c.get("gap") else
                     {"shot_id": c.get("shot_id"), "name": c.get("name"), "in": c.get("in", 0), "out": c.get("out", 1),
                      "path": _resolve(c.get("file"))} for c in body.get("clips") or [] if isinstance(c, dict)]
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
