"""Audio mixdown for the Cut: the whole record-time mix plus one WAV per shot, aligned to the shot's frames.

The per-shot WAV is what LTX gets as audio conditioning for that shot's final render: sample 0 is
shot frame 0, and it runs exactly shot.frames frames at 48 kHz / 24-bit stereo. A frame of the shot
is filled from the cut wherever the cut plays that moment, first where the shot itself is cut in,
then from other setups of the same scene through the shared scene clock (so an OTS that is only
cut in for two seconds still gets the scene's sound for its whole take). Frames the cut never covers
stay silent and are listed as not covered in the index.

numpy is required; decoding uses soundfile, then PyAV, then the stdlib wave module.
"""
import json
import os
import re
import wave
from urllib.parse import unquote, urlparse

import numpy as np

from .export import audible, audio_len, fps_info, layout, normalize_project, parse_view_url, safe_name, sequence_frames

SR = 48000


# ---------------------------------------------------------------- paths and decoding

def resolve_audio_path(clip, roots) -> str | None:
    """Filesystem path of an audio clip. roots: {"output": dir, "input": dir, "temp": dir}."""
    raw = clip.get("path") or clip.get("url") or ""
    view = parse_view_url(raw)
    if view:
        sub, fn, typ = view
        return os.path.join(roots.get(typ) or roots.get("output", ""), sub, fn)
    if raw.startswith("file://"):
        return unquote(urlparse(raw).path)
    if re.match(r"^[a-z][a-z0-9+.-]*:", raw, re.I):
        return None  # http(s) and friends: not fetched
    if os.path.isabs(raw):
        return raw
    return os.path.join(roots.get("output", ""), raw)


def _resample(data, sr):
    if sr == SR or len(data) == 0:
        return data
    try:
        from math import gcd

        from scipy.signal import resample_poly
        g = gcd(int(sr), SR)
        return resample_poly(data, SR // g, int(sr) // g, axis=0).astype(np.float32)
    except ImportError:
        n = int(round(len(data) * SR / sr))
        x = np.linspace(0, len(data) - 1, n)
        return np.stack([np.interp(x, np.arange(len(data)), data[:, c]) for c in range(data.shape[1])], 1).astype(np.float32)


def _stereo(data):
    if data.ndim == 1:
        data = data[:, None]
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    return np.ascontiguousarray(data[:, :2], dtype=np.float32)


def decode(path) -> np.ndarray:
    """Any audio file -> float32 [samples, 2] at 48 kHz."""
    errors = []
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return _resample(_stereo(data), sr)
    except Exception as e:  # noqa: BLE001  (fall through to the next decoder)
        errors.append(f"soundfile: {e}")
    try:
        import av
        with av.open(path) as container:
            stream = container.streams.audio[0]
            # Keep the source layout: letting the resampler upmix mono -> stereo applies a -3 dB pan law.
            ch = min(2, len(stream.layout.channels)) or 1
            resampler = av.AudioResampler(format="flt", layout="mono" if ch == 1 else "stereo", rate=SR)
            chunks = []
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1, ch))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1, ch))
        return _stereo(np.concatenate(chunks) if chunks else np.zeros((0, ch), np.float32))
    except Exception as e:  # noqa: BLE001
        errors.append(f"av: {e}")
    try:
        with wave.open(path, "rb") as w:
            ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
        if width == 3:
            b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
            ints = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
            ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
            data = ints.astype(np.float32) / 8388608.0
        else:
            dt = {1: np.uint8, 2: np.int16, 4: np.int32}[width]
            data = np.frombuffer(raw, dt).astype(np.float32)
            data = (data - 128) / 128 if width == 1 else data / float(2 ** (8 * width - 1))
        return _resample(_stereo(data.reshape(-1, ch)), sr)
    except Exception as e:  # noqa: BLE001
        errors.append(f"wave: {e}")
    raise RuntimeError("; ".join(errors))


def write_wav24(path, data) -> None:
    """float [samples, 2] -> 48 kHz 24-bit PCM WAV."""
    ints = np.round(np.clip(data, -1.0, 1.0) * 8388607.0).astype("<i4")
    raw = ints.reshape(-1).view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(raw)


# ---------------------------------------------------------------- mixing

def _f2s(frames, rate) -> int:
    return int(round(frames / rate * SR))


def clip_signal(a, data, rate) -> np.ndarray:
    """The clip's [in, out) with gain and linear fades applied."""
    n = _f2s(audio_len(a), rate)
    s0 = _f2s(a["in"], rate)
    seg = np.zeros((n, 2), np.float32)
    part = data[s0:s0 + n]
    seg[:len(part)] = part
    seg *= np.float32(10 ** (a["gain_db"] / 20))
    env = np.ones(n, np.float32)
    fi, fo = _f2s(a["fade_in"], rate), _f2s(a["fade_out"], rate)
    if fi:
        env[:fi] *= np.linspace(0, 1, fi, endpoint=False, dtype=np.float32)
    if fo:
        env[n - fo:] *= np.linspace(1, 0, fo, dtype=np.float32)
    # Volume keyframes and the auto-duck (Milestone 19): dB offsets at clip-local frames, linear in dB between keys,
    # held before the first and after the last (web/cut/fx.mjs clipGainAt).
    db = np.zeros(n, np.float64)
    pos = np.arange(n) * (rate / SR)
    for k in ("keys", "duck"):
        keys = a.get(k)
        if keys:
            db += np.interp(pos, [x[0] for x in keys], [x[1] for x in keys])
    if a.get("keys") or a.get("duck"):
        env *= (10 ** (db / 20)).astype(np.float32)
    return seg * env[:, None]


def render_mix(project, roots, cache=None):
    """(mix float32 [samples, 2] over the whole sequence from record frame 0, problems list)."""
    p = normalize_project(project)
    fi = fps_info(p["fps"])
    rate = fi["num"] / fi["den"]
    mix = np.zeros((_f2s(sequence_frames(p), rate), 2), np.float32)
    cache = {} if cache is None else cache
    problems = []
    for a in p["audio"]:
        if a["out"] is None or not audible(p, a["track"]):
            continue
        path = resolve_audio_path(a, roots)
        try:
            if not path:
                raise RuntimeError("not a local file")
            if path not in cache:
                cache[path] = decode(path)
            sig = clip_signal(a, cache[path], rate)
        except Exception as e:  # noqa: BLE001  (a bad clip must not sink the export)
            problems.append({"audio_id": a["id"], "label": a["label"], "source": a["path"] or a["url"], "error": str(e)})
            continue
        s = _f2s(a["start_frame"], rate)
        end = min(len(mix), s + len(sig))
        mix[s:end] += sig[:end - s]
    return mix, problems


def shot_segments(project, shot):
    """[(shot_f0, shot_f1, rec_f0, source)] filling the shot's frames from the cut ("own" first, then "scene")."""
    p = normalize_project(project)
    covered = np.zeros(shot["frames"], bool)
    segs = []
    rows = layout(p)
    own = [r for r in rows if r["shot"]["id"] == shot["id"]]
    scene = [r for r in rows if r["shot"]["id"] != shot["id"] and shot["scene_name"]
             and r["shot"]["scene_name"] == shot["scene_name"]]
    for kind, group in (("own", own), ("scene", scene)):
        for r in group:
            delta = r["shot"]["scene_offset"] - shot["scene_offset"]  # event shot frame f == this shot frame f + delta
            lo, hi = max(0, r["in"] + delta), min(shot["frames"], r["out"] + delta)
            f = lo
            while f < hi:
                if covered[f]:
                    f += 1
                    continue
                g = f
                while g < hi and not covered[g]:
                    g += 1
                covered[f:g] = True
                segs.append((f, g, r["recIn"] + (f - delta - r["in"]), kind))
                f = g
    return sorted(segs)


def write_mixdown(project, folder, roots) -> dict:
    """Write <folder>/audio/<cut>_mix.wav, <shot_id>_mix.wav per shot, and index.json. Returns the index."""
    p = normalize_project(project)
    fi = fps_info(p["fps"])
    rate = fi["num"] / fi["den"]
    audio_dir = os.path.join(folder, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    for old in os.listdir(audio_dir):  # a re-export replaces the previous mixes
        if old.endswith("_mix.wav") or old == "index.json":
            os.remove(os.path.join(audio_dir, old))
    index = {"version": 1, "cut": p["name"], "fps": p["fps"], "sample_rate": SR, "bit_depth": 24, "channels": 2,
             "has_audio": any(a["out"] is not None for a in p["audio"]), "cut_mix": None, "shots": [], "problems": []}
    if not index["has_audio"]:
        _write_index(audio_dir, index)
        return index
    mix, problems = render_mix(p, roots)
    index["problems"] = problems
    cut_file = f"{safe_name(p['name'])}_mix.wav"
    write_wav24(os.path.join(audio_dir, cut_file), mix)
    index["cut_mix"] = {"file": f"audio/{cut_file}", "path": os.path.join(audio_dir, cut_file),
                        "frames": sequence_frames(p), "samples": len(mix), "peak_dbfs": _peak(mix)}
    for shot in p["shots"]:
        n = _f2s(shot["frames"], rate)
        out = np.zeros((n, 2), np.float32)
        segs = shot_segments(p, shot)
        for f0, f1, rec0, _ in segs:
            a, b = _f2s(f0, rate), _f2s(f1, rate)
            r = _f2s(rec0, rate)
            part = mix[r:r + (b - a)]
            out[a:a + len(part)] = part
        fname = f"{safe_name(shot['id'])}_mix.wav"
        write_wav24(os.path.join(audio_dir, fname), out)
        index["shots"].append({
            "shot_id": shot["id"], "name": shot["name"], "file": f"audio/{fname}", "path": os.path.join(audio_dir, fname),
            "frames": shot["frames"], "samples": n, "duration_s": round(n / SR, 6),
            "covered": [[f0, f1, kind] for f0, f1, _, kind in segs],
            "silent": not np.any(out), "peak_dbfs": _peak(out),
        })
    _write_index(audio_dir, index)
    return index


def _peak(x):
    m = float(np.max(np.abs(x))) if len(x) else 0.0
    return round(20 * np.log10(m), 2) if m > 0 else None


def _write_index(audio_dir, index):
    with open(os.path.join(audio_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
