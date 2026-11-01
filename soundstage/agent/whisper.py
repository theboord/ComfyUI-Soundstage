"""Offline speech-to-text for the Director panel: Whisper (open weights, MIT) on the ComfyUI machine.

The browser records a push-to-talk clip, encodes it as 16-bit WAV and posts it to /soundstage/director/transcribe.
This loads whisper-base once (transformers; on the GPU when there is one, about 300 MB, falling back to the CPU if
VRAM is short under a render) and returns the text. No download: the model must already be in models/whisper/whisper-base (see MODELS.md, Optional).

    find_model() -> path or None
    decode_wav(bytes) -> (float32 mono samples, sample rate)
    transcribe(wav_bytes, language="en") -> {"text", "seconds", "ms", "model"}
"""
from __future__ import annotations

import io
import os
import threading
import time

MODEL_NAMES = ("whisper-base", "whisper-small", "whisper-tiny", "whisper-base.en", "whisper-tiny.en")
_LOCK = threading.Lock()
_CACHE: dict = {}


def _roots() -> list[str]:
    roots = []
    try:
        import folder_paths
        roots.append(os.path.join(folder_paths.models_dir, "whisper"))
        for kind in ("whisper", "text_encoders", "checkpoints", "audio_encoders"):
            try:
                for p in folder_paths.get_folder_paths(kind):
                    roots.append(p if kind == "whisper" else os.path.join(os.path.dirname(os.path.normpath(p)), "whisper"))
            except Exception:  # noqa: BLE001 - kind not registered
                pass
    except Exception:  # noqa: BLE001 - outside ComfyUI
        pass
    env = os.environ.get("SOUNDSTAGE_WHISPER_DIR")
    if env:
        roots.insert(0, env)
    seen, out = set(), []
    for r in roots:
        r = os.path.normpath(r)
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def find_model() -> str | None:
    for root in _roots():
        if os.path.isfile(os.path.join(root, "config.json")) and "whisper" in os.path.basename(root):
            return root
        for name in MODEL_NAMES:
            p = os.path.join(root, name)
            if os.path.isfile(os.path.join(p, "config.json")):
                return p
    return None


def decode_wav(data: bytes):
    """WAV (or anything soundfile reads) -> (float32 mono numpy array, rate)."""
    import numpy as np
    try:
        import soundfile as sf
        x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        x = x.mean(axis=1)
    except Exception:  # noqa: BLE001 - fall back to the standard library for plain PCM WAV
        import wave
        with wave.open(io.BytesIO(data)) as w:
            sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(n)
        if sw != 2:
            raise ValueError("send 16-bit PCM WAV") from None
        x = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
        if ch > 1:
            x = x.reshape(-1, ch).mean(axis=1)
    return np.ascontiguousarray(x, dtype="float32"), int(sr)


def resample(x, sr: int, to: int = 16000):
    import numpy as np
    if sr == to or len(x) == 0:
        return x
    n = int(round(len(x) * to / sr))
    t = np.linspace(0, len(x) - 1, n)
    return np.interp(t, np.arange(len(x)), x).astype("float32")


def _load(path: str, device: str):
    key = (path, device)
    if key not in _CACHE:
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        proc = WhisperProcessor.from_pretrained(path)
        model = WhisperForConditionalGeneration.from_pretrained(path).to(device).eval()
        _CACHE.clear()
        _CACHE[key] = (proc, model)
    return _CACHE[key]


def transcribe(data: bytes, language: str | None = "en", device: str | None = None) -> dict:
    t0 = time.time()
    path = find_model()
    if not path:
        raise FileNotFoundError("Whisper isn't installed: put whisper-base in models/whisper/ (see MODELS.md)")
    x, sr = decode_wav(data)
    x = resample(x, sr, 16000)
    secs = len(x) / 16000.0
    if secs < 0.2:
        return {"text": "", "seconds": round(secs, 2), "ms": round((time.time() - t0) * 1000), "model": os.path.basename(path)}
    x = x[: 16000 * 30]   # one Whisper window: push-to-talk commands are short
    import torch
    want = device or os.environ.get("SOUNDSTAGE_WHISPER_DEVICE", "auto")
    devices = (["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]) if want == "auto" else [want]
    kw = {"max_new_tokens": 120}
    if language:
        kw.update(language=language, task="transcribe")
    err = None
    with _LOCK:
        for dev in devices:
            try:
                proc, model = _load(path, dev)
                feats = proc(x, sampling_rate=16000, return_tensors="pt").input_features.to(dev)
                with torch.no_grad():
                    ids = model.generate(feats, **kw)
                text = proc.batch_decode(ids, skip_special_tokens=True)[0].strip()
                return {"text": text, "seconds": round(secs, 2), "ms": round((time.time() - t0) * 1000),
                        "model": os.path.basename(path), "device": dev}
            except RuntimeError as e:   # out of GPU memory under a render: the CPU still answers
                err = e
                _CACHE.clear()
    raise err
