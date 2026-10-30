"""Audio clips for the Cut timeline. Pure numpy, no ComfyUI.

A clip JSON is one entry of the Cut project's `audio` list (soundstage/cut/export.py normalize_audio):
    {id, track, url|path, start_frame, in, out, gain_db, fade_in, fade_out, label, frames, meta}
All times are in frames at the project fps; `frames` is the source file length, `in`/`out` the used
part. `path` is relative to the ComfyUI output folder (absolute paths also work), which is what
soundstage/cut/mix.py resolves.

Tracks: DX (dialogue) = A1-A2, FX (effects) = A3-A4, MX (music) = A5-A6.
Arrays are float32 [samples, channels].
"""
import json
import math
import os
import re
import wave

import numpy as np

SR = 48000
TRACKS = {"DX1": 1, "DX2": 2, "FX1": 3, "FX2": 4, "MX1": 5, "MX2": 6}
TRACK_NAMES = {v: k for k, v in TRACKS.items()}
DEFAULT_AUDIO_TRACKS = [{"track": n, "name": name} for name, n in TRACKS.items()]
DEPARTMENT_TRACK = {"dialogue": "DX1", "sfx": "FX1", "music": "MX1"}


def track_number(track) -> int:
    """'DX1'/'FX2'/'MX1', 'A3' or 3 -> 3."""
    if isinstance(track, (int, float)):
        return max(1, int(track))
    s = str(track).strip().upper()
    if s in TRACKS:
        return TRACKS[s]
    m = re.match(r"^A?(\d+)$", s)
    if m:
        return max(1, int(m.group(1)))
    raise ValueError(f"Unknown audio track {track!r}: use DX1, DX2, FX1, FX2, MX1, MX2 or a number.")


def frames_for(seconds: float, fps: float) -> int:
    """Frames that cover `seconds` (at least 1)."""
    return max(1, int(math.ceil(float(seconds) * float(fps) - 1e-6)))


def slug(s: str, default="clip") -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", str(s or "")).strip("_")
    return s[:48] or default


def make_clip(clip_id, track, path, fps, samples, sample_rate, start_frame=0, gain_db=0.0, fade_in=0, fade_out=0,
              label="", meta=None) -> dict:
    """Cut-contract clip for a whole file placed at start_frame."""
    frames = frames_for(samples / float(sample_rate), fps)
    clip = {"id": str(clip_id), "track": track_number(track), "path": str(path).replace(os.sep, "/"),
            "start_frame": max(0, int(start_frame)), "in": 0, "out": frames,
            "gain_db": round(float(gain_db), 1), "fade_in": max(0, min(int(fade_in), frames)),
            "fade_out": 0, "label": label or os.path.splitext(os.path.basename(str(path)))[0], "frames": frames}
    clip["fade_out"] = max(0, min(int(fade_out), frames - clip["fade_in"]))
    clip["meta"] = dict(meta or {})
    clip["meta"].setdefault("duration_s", round(samples / float(sample_rate), 6))
    clip["meta"].setdefault("track_name", TRACK_NAMES.get(clip["track"], f"A{clip['track']}"))
    return clip


# ---------------------------------------------------------------- DSP

def as_2d(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x[:, None] if x.ndim == 1 else x


def to_channels(x, channels=2) -> np.ndarray:
    x = as_2d(x)
    if x.shape[1] == channels:
        return np.ascontiguousarray(x)
    if channels == 1:
        return x.mean(axis=1, keepdims=True)
    if x.shape[1] == 1:
        return np.repeat(x, channels, axis=1)
    return np.ascontiguousarray(x[:, :channels])


def resample(x, sr_in, sr_out=SR) -> np.ndarray:
    x = as_2d(x)
    if int(sr_in) == int(sr_out) or len(x) == 0:
        return x
    try:
        from scipy.signal import resample_poly
        g = math.gcd(int(sr_in), int(sr_out))
        return resample_poly(x, int(sr_out) // g, int(sr_in) // g, axis=0).astype(np.float32)
    except ImportError:
        n = int(round(len(x) * sr_out / sr_in))
        t = np.linspace(0, len(x) - 1, n)
        return np.stack([np.interp(t, np.arange(len(x)), x[:, c]) for c in range(x.shape[1])], 1).astype(np.float32)


def peak_dbfs(x):
    m = float(np.max(np.abs(x))) if np.size(x) else 0.0
    return round(20 * math.log10(m), 2) if m > 0 else None


def rms_dbfs(x):
    x = as_2d(x)
    r = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    return round(20 * math.log10(r), 2) if r > 0 else None


def normalize_peak(x, target_db=-3.0) -> np.ndarray:
    m = float(np.max(np.abs(x))) if np.size(x) else 0.0
    if m <= 1e-9:
        return as_2d(x)
    return (as_2d(x) * np.float32(10 ** (target_db / 20) / m)).astype(np.float32)


def _envelope_db(x, sr, win_s=0.01):
    mono = np.abs(as_2d(x)).max(axis=1)
    hop = max(1, int(sr * win_s))
    n = len(mono) // hop
    if n == 0:
        return np.zeros(0, np.float32), hop
    frames = mono[:n * hop].reshape(n, hop).max(axis=1)
    return 20 * np.log10(np.maximum(frames, 1e-9)), hop


def trim_silence(x, sr, threshold_db=-45.0, keep_s=0.15) -> np.ndarray:
    """Cut dead lead/tail below threshold_db, keeping keep_s of natural pause on each side.
    (LTX lip sync: trimmed clean audio beats padding with room tone.)"""
    x = as_2d(x)
    env, hop = _envelope_db(x, sr)
    loud = np.nonzero(env > threshold_db)[0]
    if len(loud) == 0:
        return x
    keep = int(keep_s * sr)
    a = max(0, loud[0] * hop - keep)
    b = min(len(x), (loud[-1] + 1) * hop + keep)
    return x[a:b]


def apply_fades(x, sr, fade_in_s=0.0, fade_out_s=0.0) -> np.ndarray:
    x = as_2d(x).copy()
    n = len(x)
    fi, fo = min(n, int(fade_in_s * sr)), min(n, int(fade_out_s * sr))
    if fi:
        x[:fi] *= np.linspace(0, 1, fi, endpoint=False, dtype=np.float32)[:, None]
    if fo:
        x[n - fo:] *= np.linspace(1, 0, fo, dtype=np.float32)[:, None]
    return x


def fit_length(x, samples) -> np.ndarray:
    """Trim or zero-pad to exactly `samples`."""
    x = as_2d(x)
    if len(x) >= samples:
        return x[:samples]
    return np.concatenate([x, np.zeros((samples - len(x), x.shape[1]), np.float32)])


def fit_to_frames(x, sr, frames, fps, offset_s=0.0) -> np.ndarray:
    """The shot's soundtrack: sample 0 = frame 0 (+offset_s), exactly frames/fps seconds long."""
    x = as_2d(x)
    s = int(round(offset_s * sr))
    if s > 0:
        x = x[s:]
    elif s < 0:
        x = np.concatenate([np.zeros((-s, x.shape[1]), np.float32), x])
    return fit_length(x, int(round(frames / float(fps) * sr)))


def onsets(x, sr, threshold_db=12.0, min_gap_s=0.12, floor_db=-50.0) -> list:
    """Times (s) where the level jumps by threshold_db over the recent minimum: footsteps, door hits,
    syllable starts. Simple and robust enough for counting events and checking sync."""
    env, hop = _envelope_db(x, sr)
    if len(env) == 0:
        return []
    out, last = [], -1e9
    look = max(1, int(0.05 * sr / hop))
    for i in range(1, len(env)):
        base = env[max(0, i - look):i].min()
        t = i * hop / sr
        if env[i] > floor_db and env[i] - base >= threshold_db and t - last >= min_gap_s:
            out.append(round(t, 3))
            last = t
    return out


def place(dst, src, sr, start_s, gain_db=0.0) -> np.ndarray:
    """Mix src into dst at start_s (in place, clipped to dst)."""
    s = int(round(start_s * sr))
    if s >= len(dst):
        return dst
    part = as_2d(src)[: len(dst) - s] * np.float32(10 ** (gain_db / 20))
    dst[s:s + len(part)] += to_channels(part, dst.shape[1])
    return dst


# ---------------------------------------------------------------- files

def write_wav(path, x, sr=SR, bits=24):
    """PCM WAV (24-bit default, what Avid wants). soundfile if present, else stdlib wave."""
    x = np.clip(as_2d(x), -1.0, 1.0)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        import soundfile as sf
        sf.write(path, x, int(sr), subtype="PCM_24" if bits == 24 else "PCM_16")
        return path
    except ImportError:
        pass
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1])
        w.setframerate(int(sr))
        if bits == 24:
            w.setsampwidth(3)
            v = (x * 8388607.0).astype(np.int32).reshape(-1)
            b = np.stack([(v & 0xFF), (v >> 8) & 0xFF, (v >> 16) & 0xFF], 1).astype(np.uint8)
            w.writeframes(b.tobytes())
        else:
            w.setsampwidth(2)
            w.writeframes((x * 32767.0).astype("<i2").tobytes())
    return path


def read_wav(path):
    """(float32 [samples, ch], sr). soundfile if present, else stdlib wave (PCM 16/24/32)."""
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return data, int(sr)
    except ImportError:
        pass
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = np.frombuffer(w.readframes(n), np.uint8)
    if sw == 2:
        v = raw.view("<i2").astype(np.float32) / 32768.0
    elif sw == 3:
        b = raw.reshape(-1, 3).astype(np.int32)
        v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16))
        v = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32) / 8388608.0
    elif sw == 4:
        v = raw.view("<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported WAV sample width {sw}")
    return v.reshape(-1, ch), int(sr)


def finish(x, sr, out_dir, rel_dir, *, clip_id, track, fps, label="", start_frame=0, gain_db=0.0, fade_in=0,
           fade_out=0, trim=False, normalize_db=None, max_seconds=None, meta=None, out_sr=SR):
    """Clean a generated clip and write it as a 48 kHz / 24-bit WAV. Returns (audio float32, clip JSON).

    out_dir is the ComfyUI output folder, rel_dir the subfolder the clip goes in (kept in clip.path)."""
    x = to_channels(resample(x, sr, out_sr), 2)
    if trim:
        x = trim_silence(x, out_sr)
    if max_seconds:
        x = x[: int(round(max_seconds * out_sr))]
    if normalize_db is not None:
        x = normalize_peak(x, normalize_db)
    if len(x) == 0:
        raise ValueError(f"Soundstage audio: {label or clip_id} came back empty.")
    name = f"{slug(clip_id)}.wav"
    rel = os.path.join(rel_dir, name)
    write_wav(os.path.join(out_dir, rel), x, out_sr)
    m = dict(meta or {})
    m.update({"peak_dbfs": peak_dbfs(x), "rms_dbfs": rms_dbfs(x), "sample_rate": out_sr})
    clip = make_clip(clip_id, track, rel, fps, len(x), out_sr, start_frame=start_frame, gain_db=gain_db,
                     fade_in=fade_in, fade_out=fade_out, label=label, meta=m)
    return x, clip


def unique_id(prefix, existing_dir) -> str:
    """prefix_001, _002 ... not already present as a WAV in existing_dir."""
    base = slug(prefix)
    i = 1
    while os.path.exists(os.path.join(existing_dir, f"{base}_{i:03d}.wav")):
        i += 1
    return f"{base}_{i:03d}"


def dumps(clip) -> str:
    return json.dumps(clip, ensure_ascii=False)


def mix_clips(clips, out_dir, frames, fps, limit_db=-1.0):
    """Mix Cut clips (dicts) into one stereo shot track: each at start_frame with gain and fades, sample 0 =
    frame 0, exactly frames / fps long, peak-limited to limit_db. Relative paths resolve under out_dir."""
    fps = float(fps)
    mix = np.zeros((int(round(frames / fps * SR)), 2), np.float32)
    for c in clips:
        p = c["path"] if os.path.isabs(c["path"]) else os.path.join(out_dir, c["path"])
        x, sr = read_wav(p)
        x = to_channels(resample(x, sr, SR), 2)
        n = int(round((c["out"] - c["in"]) / fps * SR))
        seg = fit_length(x[int(round(c["in"] / fps * SR)):], n)
        seg = apply_fades(seg, SR, c.get("fade_in", 0) / fps, c.get("fade_out", 0) / fps)
        place(mix, seg, SR, c["start_frame"] / fps, c.get("gain_db", 0.0))
    lim = 10 ** (limit_db / 20)
    pk = float(np.max(np.abs(mix))) if mix.size else 0.0
    if pk > lim:
        mix *= np.float32(lim / pk)
    return mix
