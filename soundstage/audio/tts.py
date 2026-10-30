"""Chatterbox TTS from local weights (never downloads). Runs inside ComfyUI.

Weights: <models>/TTS/chatterbox/English/{ve.pt|ve.safetensors, t3_cfg.pt|t3_cfg.safetensors,
s3gen.safetensors|s3gen.pt, tokenizer.json, conds.pt}. Looked up next to every registered model folder
(so extra_model_paths bases count) and in $SOUNDSTAGE_CHATTERBOX_DIR.

Voices: the built-in Chatterbox voice (conds.pt), or a reference recording passed in as AUDIO. Only
use a reference of someone who agreed to it (your own voice, a consenting actor, or a voice that
was itself designed/generated). Every output keeps Resemble's Perth watermark.
"""
import importlib.util
import logging
import os
import sys
import tempfile
import threading
import types

_lock = threading.Lock()
_model = None
_model_dir = None
_builtin = None  # the built-in voice; generate(audio_prompt_path=...) overwrites model.conds


def _shim_pkg_resources():
    """perth imports pkg_resources.resource_filename, which setuptools >= 80 removed. Without it perth
    silently drops its watermarker and Chatterbox fails to build. A two-line shim keeps the watermark."""
    if "pkg_resources" in sys.modules or importlib.util.find_spec("pkg_resources") is not None:
        return
    m = types.ModuleType("pkg_resources")

    def resource_filename(package, name):
        spec = importlib.util.find_spec(package)
        return os.path.join(os.path.dirname(spec.origin), name)

    m.resource_filename = resource_filename
    sys.modules["pkg_resources"] = m


def has_package(name="chatterbox") -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def candidate_dirs():
    out = []
    env = os.environ.get("SOUNDSTAGE_CHATTERBOX_DIR")
    if env:
        out.append(env)
    try:
        import folder_paths
        roots = set()
        for kind in ("checkpoints", "diffusion_models", "vae", "text_encoders"):
            for p in folder_paths.get_folder_paths(kind):
                roots.add(os.path.dirname(os.path.normpath(p)))
        roots.add(folder_paths.models_dir)
        for r in sorted(roots):
            out.append(os.path.join(r, "TTS", "chatterbox", "English"))
            out.append(os.path.join(r, "TTS", "chatterbox"))
    except ImportError:
        pass
    return out


def _pick(d, *names):
    for n in names:
        p = os.path.join(d, n)
        if os.path.exists(p):
            return p
    return None


def find_weights():
    for d in candidate_dirs():
        if _pick(d, "t3_cfg.safetensors", "t3_cfg.pt") and _pick(d, "s3gen.safetensors", "s3gen.pt") \
                and _pick(d, "ve.safetensors", "ve.pt") and os.path.exists(os.path.join(d, "tokenizer.json")):
            return d
    return None


def _state(path):
    import torch
    if path.endswith(".safetensors"):
        from safetensors.torch import load_file
        return load_file(path)
    return torch.load(path, map_location="cpu", weights_only=False)


def load(device):
    """The Chatterbox model on `device` (cached; moved between devices as needed)."""
    global _model, _model_dir, _builtin
    d = find_weights()
    if d is None:
        raise RuntimeError("Chatterbox weights not found. Expected models/TTS/chatterbox/English with t3_cfg, "
                           "s3gen, ve, tokenizer.json (set SOUNDSTAGE_CHATTERBOX_DIR to point elsewhere).")
    with _lock:
        if _model is None or _model_dir != d:
            _shim_pkg_resources()
            from chatterbox.tts import ChatterboxTTS, Conditionals, EnTokenizer, S3Gen, T3, VoiceEncoder
            ve = VoiceEncoder()
            ve.load_state_dict(_state(_pick(d, "ve.safetensors", "ve.pt")))
            t3 = T3()
            sd = _state(_pick(d, "t3_cfg.safetensors", "t3_cfg.pt"))
            if "model" in sd:
                sd = sd["model"][0]
            t3.load_state_dict(sd)
            s3 = S3Gen()
            s3.load_state_dict(_state(_pick(d, "s3gen.safetensors", "s3gen.pt")), strict=False)
            tok = EnTokenizer(os.path.join(d, "tokenizer.json"))
            conds_path = os.path.join(d, "conds.pt")
            conds = Conditionals.load(conds_path, map_location="cpu") if os.path.exists(conds_path) else None
            for m in (ve, t3, s3):
                m.eval()
            _model = ChatterboxTTS(t3, s3, ve, tok, "cpu", conds=conds)
            _model_dir = d
            _builtin = conds
            logging.info("Soundstage: Chatterbox loaded from %s", d)
        _to(_model, device)
        return _model


def _to(m, device):
    import torch
    dev = torch.device(device)
    if str(getattr(m, "device", "")) == str(dev):
        return
    m.t3.to(dev)
    m.s3gen.to(dev)
    m.ve.to(dev)
    global _builtin
    if _builtin is not None:
        _builtin = _builtin.to(dev)
    m.conds = _builtin
    m.device = str(dev)


def offload():
    if _model is not None:
        _to(_model, "cpu")


def speak(text, device, ref_path=None, exaggeration=0.5, cfg_weight=0.5, temperature=0.8, seed=0):
    """Text -> (float32 waveform [samples], sample_rate). ref_path = a saved voice's reference WAV
    (zero-shot clone), else the built-in Chatterbox voice."""
    import torch
    m = load(device)
    m.conds = _builtin
    torch.manual_seed(int(seed) % (2 ** 63))
    kw = dict(exaggeration=float(exaggeration), cfg_weight=float(cfg_weight), temperature=float(temperature))
    try:
        if ref_path:
            wav = m.generate(text, audio_prompt_path=ref_path, **kw)
        else:
            if m.conds is None:
                raise RuntimeError("Chatterbox has no built-in voice (conds.pt missing): connect a Character Voice.")
            wav = m.generate(text, **kw)
    finally:
        m.conds = _builtin
    return wav[0].detach().float().cpu().numpy(), int(m.sr)


def convert(x, sr, device, ref_path=None):
    """Speech-to-speech (Chatterbox VC): re-voice a performance, keeping its timing. Reuses the TTS
    model's S3Gen, so no extra weights. Target = a saved voice's reference WAV, else the built-in voice."""
    import numpy as np
    import soundfile as sf
    import torch
    m = load(device)
    from chatterbox.vc import ChatterboxVC
    vc = ChatterboxVC(m.s3gen, str(m.device), ref_dict=None if ref_path else (_builtin.gen if _builtin else None))
    if not ref_path and vc.ref_dict is None:
        raise RuntimeError("Chatterbox VC needs a target voice: connect a Character Voice.")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        src = f.name
    try:
        sf.write(src, np.asarray(x, np.float32), int(sr))
        with torch.inference_mode():
            wav = vc.generate(src, target_voice_path=ref_path)
    finally:
        os.unlink(src)
    return wav[0].detach().float().cpu().numpy(), int(vc.sr)
