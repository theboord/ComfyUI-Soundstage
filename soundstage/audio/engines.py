"""Engines per audio department, like the model router's stage-aware picker.

Open weights come first and are the default; partner nodes carry [API] and use the user's Comfy
credits. An engine is listed only when it can run here: its node classes are loaded, its weight files
are installed (folder_paths) and, for in-process engines, its Python package imports.
Open weights only by default (same switch as the router): [API] engines are hidden unless
SOUNDSTAGE_PARTNER_MODELS=1 (or the legacy SOUNDSTAGE_OPEN_WEIGHTS_ONLY=0) is set.

Pure Python: the node module passes in the loaded class names and a file lister.
"""
import os

OPEN_ONLY_ENV = "SOUNDSTAGE_OPEN_WEIGHTS_ONLY"
PARTNER_ENV = "SOUNDSTAGE_PARTNER_MODELS"
PARTNER_OFF_MSG = ("partner API models are off in this open-weights build; set SOUNDSTAGE_PARTNER_MODELS=1 "
                   "(and restart ComfyUI) to use them, or pick an open-weights engine")

LTX_WEIGHTS = [
    {"role": "unet", "folder": "diffusion_models",
     "any": ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
             "ltx-2.5-22b-distilled-transformer-bf16.safetensors"]},
    {"role": "text_encoder", "folder": "text_encoders",
     "any": ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
             "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"]},
    {"role": "vae", "folder": "vae", "any": ["ltx-2.5-video-vae-bf16.safetensors"]},
    {"role": "audio_vae", "folder": "vae", "any": ["ltx-2.5-audio-vae-bf16.safetensors"]},
    {"role": "upscaler", "folder": "latent_upscale_models",
     "any": ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"]},
    {"role": "l2r_lora", "folder": "loras", "optional": True,
     "any": ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
             "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"]},
]
LTX_LICENCE = "LTX-2.x Community License: free incl. commercial below $10M annual revenue"
LTX_CORE = ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "LTXVConditioning", "RandomNoise",
            "KSamplerSelect", "ManualSigmas", "CFGGuider", "SamplerCustomAdvanced", "LTXVEmptyLatentAudio",
            "LTXVConcatAVLatent", "LTXVSeparateAVLatent", "LTXVAudioVAEDecode"]

ELEVEN_VOICES = ["Roger (male, american)", "Sarah (female, american)", "Laura (female, american)", "Charlie (male, australian)", "George (male, british)", "Callum (male, american)", "River (neutral, american)", "Harry (male, american)", "Liam (male, american)", "Alice (female, british)", "Matilda (female, american)", "Will (male, american)", "Jessica (female, american)", "Eric (male, american)", "Bella (female, american)", "Chris (male, american)", "Brian (male, american)", "Daniel (male, british)", "Lily (female, british)", "Adam (male, american)", "Bill (male, american)"]

# kind: "local" (expanded open-weights graph), "inproc" (runs inside our node), "api" (partner node).
# Mike, 2026-10-28: local = Chatterbox + LTX-2.5 audio; partner = ElevenLabs via Comfy's partner nodes (Comfy credits).
EL_TTS_MODELS = ["eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_multilingual_v2"]
EL_STS_MODELS = ["eleven_multilingual_sts_v2", "eleven_english_sts_v2"]
_EL_VOICE = {"id": "preset_voice", "kind": "combo", "options": ELEVEN_VOICES, "default": "River (neutral, american)",
             "tooltip": "Used when no Character Voice is connected (a connected voice is cloned instead)."}
_CHATTERBOX = {"package": "chatterbox", "kind": "inproc",
               "licence": "MIT (Resemble AI); output carries the Perth watermark"}

ENGINES = {
    "dialogue": [
        {"key": "chatterbox", "label": "Chatterbox · local [open · MIT]", **_CHATTERBOX,
         "params": [{"id": "exaggeration", "kind": "float", "default": 0.5, "min": 0.25, "max": 2.0,
                     "tooltip": "Emotion / intensity. 0.5 neutral, 0.7+ dramatic."},
                    {"id": "cfg_weight", "kind": "float", "default": 0.5, "min": 0.0, "max": 1.0,
                     "tooltip": "Pace and adherence. Lower (~0.3) = slower, more deliberate delivery."},
                    {"id": "temperature", "kind": "float", "default": 0.8, "min": 0.05, "max": 2.0,
                     "tooltip": "Variation between takes."}]},
        {"key": "elevenlabs_tts", "label": "ElevenLabs TTS · partner [API]", "kind": "api",
         "classes": ["ElevenLabsVoiceSelector", "ElevenLabsTextToSpeech", "ElevenLabsInstantVoiceClone"],
         "licence": "ElevenLabs terms, billed to the signed-in Comfy account",
         "params": [{"id": "model", "kind": "combo", "options": EL_TTS_MODELS, "default": "eleven_v4"},
                    _EL_VOICE,
                    {"id": "stability", "kind": "float", "default": 0.5, "min": 0.0, "max": 1.0,
                     "tooltip": "Lower = more emotional range, higher = steadier."},
                    {"id": "speed", "kind": "float", "default": 1.0, "min": 0.7, "max": 1.2,
                     "tooltip": "Pace (eleven_v3 / multilingual_v2 only)."},
                    {"id": "language", "kind": "string", "default": "", "tooltip": "ISO 639-1, empty = auto."}]},
    ],
    "voice_change": [
        {"key": "chatterbox_vc", "label": "Chatterbox VC · local [open · MIT]", **_CHATTERBOX, "params": []},
        {"key": "elevenlabs_sts", "label": "ElevenLabs Speech-to-Speech · partner [API]", "kind": "api",
         "classes": ["ElevenLabsVoiceSelector", "ElevenLabsSpeechToSpeech", "ElevenLabsInstantVoiceClone"],
         "licence": "ElevenLabs terms, billed to the signed-in Comfy account",
         "params": [{"id": "model", "kind": "combo", "options": EL_STS_MODELS, "default": "eleven_multilingual_sts_v2"},
                    _EL_VOICE,
                    {"id": "stability", "kind": "float", "default": 0.5, "min": 0.0, "max": 1.0},
                    {"id": "similarity", "kind": "float", "default": 0.75, "min": 0.0, "max": 1.0},
                    {"id": "remove_noise", "kind": "bool", "default": False}]},
    ],
    "sfx": [
        {"key": "ltx_t2a", "label": "LTX-2.5 audio · local [open · <$10M]", "kind": "local",
         "classes": LTX_CORE + ["LTXVAudioOnlyModel", "LTXVAudioOnlyEmptyVideoLatent"],
         "weights": LTX_WEIGHTS[:4], "licence": LTX_LICENCE, "params": []},
        {"key": "elevenlabs_sfx", "label": "ElevenLabs SFX · partner [API]", "kind": "api",
         "classes": ["ElevenLabsTextToSoundEffects"], "licence": "ElevenLabs terms, billed to the signed-in Comfy account",
         "params": [{"id": "prompt_influence", "kind": "float", "default": 0.3, "min": 0.0, "max": 1.0}]},
    ],
    "music": [
        {"key": "ltx_t2a", "label": "LTX-2.5 audio · local [open · <$10M]", "kind": "local",
         "classes": LTX_CORE + ["LTXVAudioOnlyModel", "LTXVAudioOnlyEmptyVideoLatent"],
         "weights": LTX_WEIGHTS[:4], "licence": LTX_LICENCE, "params": []},
    ],
}


def open_weights_only() -> bool:
    if os.environ.get(PARTNER_ENV, "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    return os.environ.get(OPEN_ONLY_ENV, "").strip().lower() not in ("0", "false", "no", "off")


def resolve_weights(engine, list_files) -> dict:
    """role -> installed file (or None). list_files(folder) -> filenames."""
    out = {}
    for spec in engine.get("weights", []):
        files = set(list_files(spec["folder"]) or [])
        out[spec["role"]] = next((f for f in spec["any"] if f in files), None)
        if out[spec["role"]] is None:  # same file in another subfolder
            names = {os.path.basename(f): f for f in files}
            out[spec["role"]] = next((names[os.path.basename(f)] for f in spec["any"]
                                      if os.path.basename(f) in names), None)
    return out


def missing(engine, loaded_classes, list_files, has_package=None) -> list:
    miss = [c for c in engine.get("classes", []) if c not in loaded_classes]
    w = resolve_weights(engine, list_files)
    miss += [s["any"][0] for s in engine.get("weights", []) if not s.get("optional") and not w.get(s["role"])]
    if engine.get("package") and has_package is not None and not has_package(engine["package"]):
        miss.append(f"python package {engine['package']}")
    return miss


def available(department, loaded_classes, list_files, has_package=None, open_only=None) -> list:
    """Engines of a department that can run here, open weights first. Never empty: if nothing is
    installed the first engine is still listed so the node loads and says what is missing."""
    open_only = open_weights_only() if open_only is None else open_only
    out = []
    for e in ENGINES[department]:
        if e["kind"] == "api" and open_only:
            continue
        if not missing(e, loaded_classes, list_files, has_package):
            out.append(e)
    return out or [ENGINES[department][0]]


def find(department, label_or_key):
    for e in ENGINES[department]:
        if label_or_key in (e["label"], e["key"]):
            return e
    return None
