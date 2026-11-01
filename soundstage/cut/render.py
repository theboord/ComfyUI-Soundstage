"""Render the Cut to one finished file (Milestone 19): the picture with its transitions, fades and clip opacity, the
title cards on V2, burned-in subtitles if asked for, and the mixed sound (every audio track with its gain, fades,
volume keys and auto-duck, plus each clip's own sync sound) at a loudness target. MP4 (H.264 + AAC) or ProRes 422 HQ
(+ 24-bit PCM, .mov) at the project's size and rate, or a 9:16 social version cropped from it.

POST /soundstage/cut/render  {project, spec: {format, aspect, loudness, burn_subtitles, reframe_x, sync_audio}, name}
-> {filename, subfolder, type, seconds, frames, width, height, loudness: {...}, missing: [shot ids], ...}

The rules (where a transition sits, how much handle it uses, what a dip does) are web/cut/fx.mjs's, through the
Python twin in export.py (trans_spans). ffmpeg does the picture; numpy does the mix (mix.py), ffmpeg's two-pass
loudnorm the loudness. Text (titles, subtitles, slates for unrendered shots) is drawn with Pillow, so an ffmpeg
without drawtext still works. No ComfyUI imports in the core: tests run it on synthetic clips.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time

import numpy as np

from .export import is_overlap, key_at, layout, normalize_project, sequence_frames, total_frames, trans_spans, wrap_cue, fps_info
from .mix import SR, _f2s, decode, render_mix, resolve_audio_path, write_wav24

VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
LOUDNESS = {"social": (-14.0, -1.0), "ebu": (-23.0, -1.0), "atsc": (-24.0, -2.0)}
FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]


def _exe(name: str) -> str:
    exe = shutil.which(name)
    if not exe:
        raise RuntimeError(f"{name} not found on PATH")
    return exe


def _run(cmd, what):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{what} failed: {r.stderr.strip()[-900:]}")
    return r


def probe(path: str) -> dict:
    out = subprocess.run([_exe("ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    streams = j.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    fr = v.get("r_frame_rate") or "0/1"
    num, den = (fr.split("/") + ["1"])[:2]
    fps = float(num) / float(den) if float(den or 0) else None
    dur = float(j.get("format", {}).get("duration") or 0) or None
    return {"has_audio": any(s.get("codec_type") == "audio" for s in streams), "width": v.get("width"),
            "height": v.get("height"), "fps": fps, "duration": dur, "codec": v.get("codec_name"), "pix_fmt": v.get("pix_fmt")}


# ---------------------------------------------------------------------------------------------- text cards (Pillow)

def _font(size):
    from PIL import ImageFont
    for f in FONTS:
        if os.path.isfile(f):
            try:
                return ImageFont.truetype(f, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _text_png(path, w, h, lines, *, size, y_frac=0.5, card=False, band=False, outline=True):
    """An RGBA PNG of w x h with centred lines of text; card = opaque black behind it, band = a dark band behind it."""
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (w, h), (0, 0, 0, 255 if card else 0))
    d = ImageDraw.Draw(img)
    font = _font(size)
    boxes = [d.textbbox((0, 0), ln, font=font) for ln in lines]
    widest = max([b[2] - b[0] for b in boxes] or [0])
    if widest > w * 0.9:   # shrink to fit the frame (a 9:16 frame is narrow)
        size = max(10, int(size * w * 0.9 / widest))
        font = _font(size)
        boxes = [d.textbbox((0, 0), ln, font=font) for ln in lines]
    lh = int(size * 1.25)
    total = lh * len(lines)
    y0 = int(h * y_frac - total / 2)
    if band:
        pad = int(size * 0.5)
        d.rectangle([0, y0 - pad, w, y0 + total + pad], fill=(0, 0, 0, 150))
    for ln, b in zip(lines, boxes):
        tw = b[2] - b[0]
        x = (w - tw) // 2 - b[0]
        if outline:
            sw = max(2, size // 14)
            d.text((x, y0), ln, font=font, fill=(255, 255, 255, 255), stroke_width=sw, stroke_fill=(0, 0, 0, 230))
        else:
            d.text((x, y0), ln, font=font, fill=(255, 255, 255, 255))
        y0 += lh
    img.save(path)
    return path


def _wrap(text, width):
    words, lines, cur = str(text).split(), [], ""
    for wd in words:
        if cur and len(cur) + 1 + len(wd) > width:
            lines.append(cur)
            cur = wd
        else:
            cur = f"{cur} {wd}" if cur else wd
    return lines + ([cur] if cur else [])


# ---------------------------------------------------------------------------------------------- media

def shot_media(shot, roots):
    """(kind, path, rung) of the best render that exists on disk: final > draft > look > clay capture; imported
    footage cut as the original; else ("slate", None, "clay")."""
    src = shot.get("source")
    if src and src.get("use") == "original" and os.path.isfile(src.get("path", "")):
        return "video", src["path"], "source"
    for rung in ("final", "draft", "look", "clay"):
        raw = (shot.get("renders") or {}).get(rung)
        if not raw:
            continue
        p = resolve_audio_path({"url": raw}, roots)
        if p and os.path.isfile(p):
            return ("image" if p.lower().endswith(IMAGE_EXT) else "video"), p, rung
    if src and os.path.isfile(src.get("path", "")):
        return "video", src["path"], "source"
    return "slate", None, "clay"


def _opacity_expr(keys, pre, rate):
    """geq factor k(T) for clip opacity keys (clip-local frames; the segment starts `pre` frames before the clip)."""
    pts = [((f + pre) / rate, v) for f, v in keys]
    expr = f"{pts[-1][1]:.4f}"
    for i in range(len(pts) - 1, 0, -1):
        (t0, v0), (t1, v1) = pts[i - 1], pts[i]
        ramp = f"({v0:.4f}+({v1 - v0:.4f})*(T-{t0:.4f})/{max(1e-6, t1 - t0):.4f})"
        expr = f"if(lt(T,{t1:.4f}),{ramp},{expr})"
    return f"if(lt(T,{pts[0][0]:.4f}),{pts[0][1]:.4f},{expr})"


# ---------------------------------------------------------------------------------------------- audio

def _decode_any(path):
    """A video's sound as float [samples, 2] at 48 kHz: mix.decode (soundfile / PyAV), else through ffmpeg."""
    try:
        return decode(path)
    except Exception:  # noqa: BLE001 - no PyAV here: let ffmpeg pull the sound out
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _run([_exe("ffmpeg"), "-y", "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s16le", wav], "extract sound")
            return decode(wav)
        finally:
            os.remove(wav)


def sync_sound(p, roots, items, rate, n_samples, spans, tail):
    """Each picture clip's own sound (a Final with audio), cut and cross-faded with the picture: a dissolve crossfades
    it, a dip / fade takes it down and up with the picture."""
    out = np.zeros((n_samples, 2), np.float32)
    used = 0
    cache = {}
    for it in items:
        if it["kind"] != "video" or not it.get("has_audio"):
            continue
        try:
            if it["path"] not in cache:
                cache[it["path"]] = _decode_any(it["path"])
            data = cache[it["path"]]
        except Exception:  # noqa: BLE001 - a clip whose sound will not decode just plays silent
            continue
        row = it["row"]
        f0 = row["in"] - it["pre"]                    # first source frame of the segment
        rec0 = row["recIn"] - it["pre"]                 # its record frame
        nf = it["frames"]
        s0, n = _f2s(f0, rate), _f2s(nf, rate)
        seg = np.zeros((n, 2), np.float32)
        part = data[s0:s0 + n]
        seg[:len(part)] = part
        # picture weight per sample, frames from the segment start
        fpos = np.arange(n) * (rate / SR)
        w = np.ones(n, np.float32)
        k = row["index"]
        into, nxt = spans[k], spans[k + 1] if k + 1 < len(spans) else None
        if into:
            if into.get("head") or not is_overlap(into["type"]):
                a0 = it["pre"] if is_overlap(into["type"]) and not into.get("head") else 0
                w *= np.clip((fpos - a0) / max(1, into["post"]), 0, 1).astype(np.float32)
            else:
                w *= np.clip(fpos / max(1, into["frames"]), 0, 1).astype(np.float32)
        if nxt and not nxt.get("head"):
            if is_overlap(nxt["type"]):
                w *= np.clip((nf - fpos) / max(1, nxt["frames"]), 0, 1).astype(np.float32)
            else:
                w *= np.clip((nf - fpos) / max(1, nxt["pre"]), 0, 1).astype(np.float32)
        if tail and k == len(spans) - 1:
            w *= np.clip((nf - fpos) / max(1, tail["pre"]), 0, 1).astype(np.float32)
        seg *= w[:, None]
        r = _f2s(rec0, rate)
        lo = max(0, -r)
        end = min(n_samples, r + n)
        if end > r + lo:
            out[r + lo:end] += seg[lo:end - r]
            used += 1
    return out, used


def true_peak_limit(x, ceiling_db):
    """Keep the true peak (4x oversampled) under ceiling_db: a look-ahead gain that never exceeds what each peak needs
    (a 2 ms sliding minimum, then a 2 ms box smoothing, which stays under it). Without scipy: one safe overall gain."""
    c = 10 ** (ceiling_db / 20)
    if not len(x):
        return x
    try:
        from scipy.ndimage import minimum_filter1d, uniform_filter1d
        from scipy.signal import resample_poly
        os4 = resample_poly(x, 4, 1, axis=0)
        peak = np.abs(os4).max(1)
        n = len(x)
        peak = np.pad(peak, (0, max(0, 4 * n - len(peak))))[:4 * n].reshape(n, 4).max(1)
        need = np.minimum(1.0, c / np.maximum(peak, 1e-9))
        if need.min() >= 1.0:
            return x
        w = max(1, int(0.002 * SR))
        g = minimum_filter1d(need, size=2 * w + 1, mode="nearest")
        g = uniform_filter1d(g, size=w, mode="nearest")
        g = np.minimum(g, minimum_filter1d(need, size=w + 1, mode="nearest"))
        return (x * g[:, None]).astype(np.float32)
    except ImportError:
        pk = float(np.max(np.abs(x)))
        return (x * np.float32(min(1.0, c / pk))) if pk > c else x


def normalize_loudness(mix, target, tp, tmp, margin=0.0):
    """The mix to `target` LUFS with one linear gain, true peak held under tp - margin by the limiter; measured with
    ffmpeg (BS.1770) and corrected once for what the limiter took. Returns (mix, stats)."""
    def lufs(x):
        f = os.path.join(tmp, "measure.wav")
        _write_float_wav(f, x)
        return measure(f)
    m0 = lufs(mix)
    if not m0 or m0["lufs"] <= -70:
        return mix, {"measured_before": m0.get("lufs") if m0 else None}
    gain = target - m0["lufs"]
    out = true_peak_limit(mix * np.float32(10 ** (gain / 20)), tp - margin)
    m1 = lufs(out)
    if m1 and abs(m1["lufs"] - target) > 0.1:   # the limiter shaved some loudness: make it up once
        gain += target - m1["lufs"]
        out = true_peak_limit(mix * np.float32(10 ** (gain / 20)), tp - margin)
    return out, {"measured_before": round(m0["lufs"], 2), "gain_db": round(gain, 2),
                 "peak_limited": bool(m0["true_peak"] + gain > tp - margin)}


def _write_float_wav(path, x):
    """32-bit float WAV (levels over 0 dBFS survive, unlike the 24-bit writer)."""
    import struct
    x = np.ascontiguousarray(x, dtype="<f4")
    data = x.tobytes()
    hdr = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 3, 2, SR, SR * 8, 8, 32)
           + b"data" + struct.pack("<I", len(data)))
    with open(path, "wb") as f:
        f.write(hdr + data)


def measure(path):
    """{lufs, true_peak, lra} of a file's sound (ffmpeg loudnorm's measurement), or {} without sound."""
    try:
        r = _run([_exe("ffmpeg"), "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "loudnorm=print_format=json",
                  "-f", "null", "-"], "measure")
        m = json.loads(r.stderr[r.stderr.rindex("{"):r.stderr.rindex("}") + 1])
        return {"lufs": float(m["input_i"]), "true_peak": float(m["input_tp"]), "lra": float(m["input_lra"])}
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------------------------------------- the render

def render_cut(project, roots, out_path, spec=None) -> dict:
    """Render the whole cut. roots: {"output": dir, "input": dir, "temp": dir} for /view URLs and relative paths."""
    spec = dict(spec or {})
    p = normalize_project(project)
    rows = layout(p)
    if not rows:
        raise ValueError("the cut is empty")
    fi = fps_info(p["fps"])
    rate = fi["num"] / fi["den"]
    fps_s = f"{fi['num']}/{fi['den']}"
    W, H = int(p["width"]) // 2 * 2, int(p["height"]) // 2 * 2
    social = spec.get("aspect") == "9:16"
    OW, OH = (1080, 1920) if social else (W, H)
    prores = spec.get("format") == "prores"
    spans, tail = trans_spans(p)
    t0 = time.perf_counter()
    tmp = tempfile.mkdtemp(prefix="ss_render_")
    try:
        # ---- picture segments: each clip with the handles its dissolves use
        items = []
        for k, row in enumerate(rows):
            into, nxt = spans[k], spans[k + 1] if k + 1 < len(spans) else None
            pre = into["pre"] if into and is_overlap(into["type"]) and not into.get("head") else 0
            post = nxt["post"] if nxt and is_overlap(nxt["type"]) else 0
            kind, path, rung = shot_media(row["shot"], roots)
            it = {"row": row, "kind": kind, "path": path, "rung": rung, "pre": pre, "post": post, "frames": row["len"] + pre + post}
            if kind == "video":
                info = probe(path)
                it["has_audio"] = info["has_audio"]
                it["src_fps"] = info["fps"] or rate
            if kind == "slate":
                it["path"] = _text_png(os.path.join(tmp, f"slate_{k}.png"), W, H,
                                       [row["shot"]["name"], "not rendered yet"], size=max(18, H // 18), card=True, outline=False)
                it["kind"] = "image"
                it["slate"] = True
            items.append(it)

        args = [_exe("ffmpeg"), "-y", "-v", "error"]
        filters = []
        fit = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
               f"setsar=1,fps={fps_s},format=yuv420p")
        idx = 0
        for i, it in enumerate(items):
            dur = it["frames"] / rate
            row = it["row"]
            if it["kind"] == "video":
                args += ["-i", it["path"]]
                a, b = row["in"] - it["pre"], row["out"] + it["post"]
                # Trim in seconds of the source (its own rate), then conform; tpad holds the last frame if the render
                # is shorter than the shot says.
                sf = it.get("src_fps") or rate
                chain = (f"[{idx}:v]trim=start={a / rate:.6f}:end={b / rate:.6f},setpts=PTS-STARTPTS,{fit},"
                         f"tpad=stop_mode=clone:stop_duration={dur:.6f},trim=end_frame={it['frames']}")
                del sf
            else:
                args += ["-loop", "1", "-framerate", fps_s, "-t", f"{dur + 0.1:.6f}", "-i", it["path"]]
                chain = f"[{idx}:v]{fit},trim=end_frame={it['frames']}"
            idx += 1
            k = row["index"]
            into, nxt = spans[k], spans[k + 1] if k + 1 < len(spans) else None
            fades = []
            col = lambda sp: "white" if sp["type"] == "dip_white" else "black"  # noqa: E731
            if into and (into.get("head") or not is_overlap(into["type"])) and into["post"]:
                fades.append(f"fade=t=in:st=0:d={into['post'] / rate:.6f}:color={col(into)}")
            if nxt and not is_overlap(nxt["type"]) and nxt["pre"]:
                fades.append(f"fade=t=out:st={(it['frames'] - nxt['pre']) / rate:.6f}:d={nxt['pre'] / rate:.6f}:color={col(nxt)}")
            if tail and k == len(rows) - 1:
                fades.append(f"fade=t=out:st={(it['frames'] - tail['pre']) / rate:.6f}:d={tail['pre'] / rate:.6f}:color={col(tail)}")
            op = row["event"].get("opacity")
            if op:
                e = _opacity_expr(op, it["pre"], rate)
                fades.append(f"geq=lum='lum(X,Y)*({e})':cb='128+(cb(X,Y)-128)*({e})':cr='128+(cr(X,Y)-128)*({e})'")
            filters.append(chain + "".join("," + f for f in fades) + f",settb=AVTB,setpts=N/({fps_s})/TB[s{i}]")

        # ---- join: xfade over dissolves / wipes, concat elsewhere
        cur, length = "[s0]", items[0]["frames"]
        for i in range(1, len(items)):
            sp = spans[i]
            if sp and is_overlap(sp["type"]):
                off = (length - sp["frames"]) / rate
                tr = "wipeleft" if sp["type"] == "wipe" else "fade"
                filters.append(f"{cur}[s{i}]xfade=transition={tr}:duration={sp['frames'] / rate:.6f}:offset={off:.6f}[j{i}]")
                length += items[i]["frames"] - sp["frames"]
            else:
                filters.append(f"{cur}[s{i}]concat=n=2:v=1:a=0[j{i}]")
                length += items[i]["frames"]
            cur = f"[j{i}]"
        pic = total_frames(p)
        seq = sequence_frames(p)
        tail_pad = (seq - pic) / rate
        last = f"{cur}trim=end_frame={pic},setpts=PTS-STARTPTS"
        if tail_pad > 0:   # the sound runs past the picture: black to the end
            last += f",tpad=stop_mode=add:stop_duration={tail_pad:.6f}:color=black"
        if social:
            cw = int(round(H * 9 / 16)) // 2 * 2
            x = int(round((W - cw) / 2 * (1 + float(spec.get("reframe_x") or 0))))
            x = max(0, min(W - cw, x))
            last += f",crop={cw}:{H}:{x}:0,scale={OW}:{OH}:flags=lanczos,setsar=1"
        filters.append(last + "[base]")
        cur = "[base]"

        # ---- titles (V2) and burned-in subtitles: Pillow PNGs overlaid in time
        overlays = []
        for n, t in enumerate(p.get("titles") or []):
            style = t["style"]
            size = (OH // 9 if social else OH // 11) if style != "lower" else (OH // 26 if social else OH // 16)
            png = _text_png(os.path.join(tmp, f"title_{n}.png"), OW, OH, _wrap(t["text"], 16 if social else 28), size=size,
                            y_frac={"card": 0.5, "center": 0.5, "lower": 0.8 if social else 0.82}[style],
                            card=style == "card", band=style == "lower")
            overlays.append((png, t["start_frame"], t["frames"], t["fade_in"], t["fade_out"]))
        if spec.get("burn_subtitles"):
            for n, c in enumerate(p.get("subtitles") or []):
                size = OH // 24 if social else OH // 20
                lines = wrap_cue(c["text"]) if not social else _wrap(c["text"], 24)
                png = _text_png(os.path.join(tmp, f"sub_{n}.png"), OW, OH, lines, size=size, y_frac=0.72 if social else 0.86)
                overlays.append((png, c["start_frame"], c["end_frame"] - c["start_frame"], 0, 0))
        for n, (png, s, nf, fin, fout) in enumerate(overlays):
            args += ["-loop", "1", "-framerate", fps_s, "-t", f"{nf / rate + 0.05:.6f}", "-i", png]
            fx = [f"[{idx}:v]format=rgba,trim=end_frame={nf}"]
            if fin:
                fx.append(f"fade=t=in:st=0:d={fin / rate:.6f}:alpha=1")
            if fout:
                fx.append(f"fade=t=out:st={(nf - fout) / rate:.6f}:d={fout / rate:.6f}:alpha=1")
            fx.append(f"setpts=PTS-STARTPTS+{s / rate:.6f}/TB[o{n}]")
            filters.append(",".join(fx))
            filters.append(f"{cur}[o{n}]overlay=0:0:eof_action=pass:enable='between(t,{s / rate:.6f},{(s + nf) / rate - 1e-4:.6f})'[ov{n}]")
            cur = f"[ov{n}]"
            idx += 1
        filters.append(f"{cur}format={'yuv422p10le' if prores else 'yuv420p'}[vout]")

        # ---- sound: the tracks (gain, fades, keys, duck) + the clips' own sync sound, then loudness
        n_samples = _f2s(seq, rate)
        mix, problems = render_mix(p, roots)
        mix = np.pad(mix, ((0, max(0, n_samples - len(mix))), (0, 0)))[:n_samples]
        sync_used = 0
        if spec.get("sync_audio", True):
            snd, sync_used = sync_sound(p, roots, items, rate, n_samples, spans, tail)
            mix = mix + snd
        lstats = {"target": None}
        if spec.get("loudness") in LOUDNESS and np.any(mix):
            target, tp = LOUDNESS[spec["loudness"]]
            # AAC overshoots the true peak a little; PCM (ProRes) does not.
            mix, st = normalize_loudness(mix, target, tp, tmp, margin=0.0 if prores else 0.7)
            lstats = {"target": target, "true_peak_ceiling": tp, **st}
        else:
            pk = float(np.max(np.abs(mix))) if len(mix) else 0.0
            if pk > 0.98:   # no target: just keep it out of clipping
                mix = mix * np.float32(0.98 / pk)
        wav = os.path.join(tmp, "mix.wav")
        write_wav24(wav, mix)
        args += ["-i", wav]
        a_in = idx
        args += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-map", f"{a_in}:a"]
        if prores:
            args += ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-c:a", "pcm_s24le"]
        else:
            args += ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k",
                     "-movflags", "+faststart"]
        args += ["-r", fps_s, "-t", f"{seq / rate:.6f}", out_path]
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        _run(args, "ffmpeg render")
        info = probe(out_path)
        lstats.update(measure(out_path))
        return {"path": out_path, "frames": seq, "seconds": round(seq / rate, 3), "width": info["width"], "height": info["height"],
                "codec": info["codec"], "format": "prores" if prores else "mp4", "aspect": "9:16" if social else "source",
                "loudness": lstats, "missing": [it["row"]["shot"]["id"] for it in items if it.get("slate")],
                "sources": {it["row"]["shot"]["id"]: it["rung"] for it in items}, "sync_clips": sync_used,
                "transitions": [{"edit": k, **{x: sp[x] for x in ("type", "frames", "pre", "post", "limited")}} for k, sp in enumerate(spans) if sp]
                + ([{"edit": "tail", **{x: tail[x] for x in ("type", "frames", "pre", "post", "limited")}}] if tail else []),
                "problems": problems, "encode_s": round(time.perf_counter() - t0, 2)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------------------------- route

_REGISTERED = False


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    import asyncio

    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.post("/soundstage/cut/render")
    async def render_route(request):
        try:
            body = await request.json()
            import folder_paths
            roots = {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(),
                     "temp": folder_paths.get_temp_directory()}
            spec = body.get("spec") or {}
            name = re.sub(r"[^\w-]+", "_", str(body.get("name") or (body.get("project") or {}).get("name") or "cut")).strip("_")[:40] or "cut"
            sub = "soundstage_cuts"
            ext = ".mov" if spec.get("format") == "prores" else ".mp4"
            tag = "_9x16" if spec.get("aspect") == "9:16" else ""
            fname = f"{name}{tag}_{time.strftime('%Y%m%d_%H%M%S')}{ext}"
            out = os.path.join(folder_paths.get_output_directory(), sub, fname)
            res = await asyncio.to_thread(render_cut, body.get("project") or {}, roots, out, spec)
            res.pop("path", None)
            return web.json_response({**res, "filename": fname, "subfolder": sub, "type": "output"})
        except Exception as exc:  # noqa: BLE001 - the panel shows the message
            return web.json_response({"error": str(exc)}, status=400)

    _REGISTERED = True
    return True
