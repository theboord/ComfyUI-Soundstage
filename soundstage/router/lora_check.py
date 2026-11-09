"""④ Frame's "Style or character add-on": is the chosen LoRA one the frame model can use?

The App lists every LoRA in models/loras (the ones that match the frame model first, the rest under "Other LoRAs (may
not work with this model)", with a warning but no block). This is the server side, run before the frame graph is built
(nodes_router._Router._prepare): a LoRA that is gone from the folder, or whose own file says it was trained for another
model family, stops the frame with a sentence that says so, instead of a ComfyUI "Value not in list" or a frame that
quietly ignores the add-on (ComfyUI's LoRA loader skips keys it can't place and only logs "lora key not loaded").

What it can tell, from the safetensors header only (a few KB read, never the weights):
  - kohya / modelspec metadata: ss_base_model_version, modelspec.architecture, ss_sd_model_name;
  - Stable Diffusion 1.x / 2.x / SDXL key names (lora_unet_*_blocks, lora_te*_) and SDXL's second text encoder;
  - LTX video LoRAs (audio / video cross-attention keys, an "ltx" architecture).
It cannot tell a FLUX 3 Klein LoRA from a Krea 2 or FLUX 1 one by keys alone (similar transformer names), so those run,
and the App's warning is what the user sees. No metadata and no telling keys: it runs (unknown is not incompatible).
"""
from __future__ import annotations

import json
import re
import struct

# The image models ④ Frame paints with, by router adapter (soundstage/router/registry.json).
ADAPTER_FAMILY = {"flux3_klein": "klein", "flux2_klein": "klein", "krea2": "krea"}   # FLUX.2 Klein 9B: "klein" too (keys alone cannot tell 9B from FLUX 3)
FAMILY_LABEL = {"klein": "FLUX 3 Klein", "krea": "Krea 2", "sd": "Stable Diffusion 1.x/2.x", "sdxl": "SDXL",
                "ltx": "LTX video", "flux1": "FLUX.1", "wan": "Wan video", "hunyuan": "HunyuanVideo",
                "qwen": "Qwen-Image"}

_ARCH = [  # metadata text -> family (first match wins)
    (re.compile(r"klein|flux[-_ .]?[23]\b|flux[-_ .]?[23][-_ .]", re.I), "klein"),
    (re.compile(r"krea", re.I), "krea"),
    (re.compile(r"ltx", re.I), "ltx"),
    (re.compile(r"\bwan", re.I), "wan"),
    (re.compile(r"hunyuan", re.I), "hunyuan"),
    (re.compile(r"qwen", re.I), "qwen"),
    (re.compile(r"sdxl|stable-diffusion-xl|\bxl\b|pony|illustrious", re.I), "sdxl"),
    (re.compile(r"flux[-_ .]?(?:1|\.1|dev|schnell)\b|flux-1", re.I), "flux1"),
    (re.compile(r"\bsd[-_ ]?(?:1|2|v1|v2)|stable-diffusion-v1|stable-diffusion-v2|sd1\.5|sd_1|sd_2", re.I), "sd"),
]


def read_header(path: str, limit: int = 32 << 20) -> dict:
    """The JSON header of a .safetensors file ({} for anything else or a file it can't read)."""
    try:
        with open(path, "rb") as fh:
            n = struct.unpack("<Q", fh.read(8))[0]
            if n <= 0 or n > limit:
                return {}
            return json.loads(fh.read(n))
    except Exception:  # noqa: BLE001 - a header we can't read is "unknown", never an error
        return {}


def family_of(header: dict) -> str | None:
    """The model family a LoRA was trained for, from its own header, or None when it can't be told."""
    if not header:
        return None
    meta = header.get("__metadata__") or {}
    for k in ("modelspec.architecture", "ss_base_model_version", "ss_sd_model_name", "base_model"):
        v = str(meta.get(k) or "")
        if v:
            for rx, fam in _ARCH:
                if rx.search(v):
                    return fam
    keys = [k for k in header if k != "__metadata__"]
    if any(k.startswith("lora_te2_") for k in keys):
        return "sdxl"
    if any(re.match(r"lora_unet_(?:input|output|middle|down|up|mid)_block", k) for k in keys) or \
            any(k.startswith(("lora_te_", "lora_te1_")) for k in keys):
        return "sd"
    if any(re.search(r"audio_attn|audio_to_video|video_to_audio|audio_ff", k) for k in keys):
        return "ltx"
    return None


def check(name: str | None, adapter: str | None, available: list[str], full_path=None) -> str | None:
    """None when the LoRA can be used (or there is none), else the sentence to stop with. full_path(name) -> a path."""
    if not name or name == "None":
        return None
    if available and name not in available:
        return (f"The add-on LoRA {name!r} isn't in models/loras any more. Pick another under "
                "④ Frame > Style or character add-on, or None.")
    want = ADAPTER_FAMILY.get(adapter or "")
    if not want or full_path is None:
        return None
    try:
        path = full_path(name)
    except Exception:  # noqa: BLE001
        path = None
    got = family_of(read_header(path)) if path else None
    if got and got != want:
        return (f"The add-on LoRA {name!r} was made for {FAMILY_LABEL.get(got, got)}, and this frame paints with "
                f"{FAMILY_LABEL[want]}: it can't load into it. Pick one under \"Matches this model\" in ④ Frame > "
                "Style or character add-on, or None.")
    return None
