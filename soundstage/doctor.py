"""Soundstage doctor: is this ComfyUI ready for Soundstage, and if not, what exactly to do.

    python -m soundstage.doctor                                # asks the ComfyUI at 127.0.0.1:8188, else reads disk
    python -m soundstage.doctor --url http://127.0.0.1:8188
    python -m soundstage.doctor --comfy /path/to/ComfyUI       # ComfyUI not running: read its folders
    python -m soundstage.doctor --json                         # the full report as JSON
    python -m soundstage.doctor --sizes                        # also ask Hugging Face how big each missing file is

Run it from the ComfyUI-Soundstage folder. In the App: Tools ▾ › Check my setup (GET /soundstage/doctor).

It checks, in plain language:
- node packs: ComfyUI core, Soundstage itself, the required packs and the optional ones, class by class;
- model files per feature (where to get each one, its folder, its size when known), accepting another build of
  the same model the way the App does when a workflow loads (web/ui/modelmatch.mjs);
- the GPU's VRAM and which features fit it (only what was measured is claimed);
- the Python packages Soundstage imports.

Three ways to look (the report says which one it used):
- inside ComfyUI (the App's button, and --url when Soundstage is loaded there): node classes from ComfyUI's own
  class list, files from its folder_paths (extra_model_paths.yaml included), VRAM from comfy.model_management,
  Python packages from ComfyUI's own Python;
- over HTTP, when the server has no /soundstage/doctor (Soundstage did not load): one class per request via
  /object_info/<Class> (never the full /object_info, which is slow), files via /models/<folder>, VRAM via
  /system_stats. Python packages can't be seen from outside, so they are not checked;
- from disk (--comfy): models/ and custom_nodes/ folders; node classes are not known, packs are matched by folder.
This module imports nothing from ComfyUI at load time, so the CLI runs in any Python 3.10+.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MODELS_DOC = "https://github.com/theboord/ComfyUI-Soundstage/blob/main/MODELS.md"
INSTALL_DOC = "https://github.com/theboord/ComfyUI-Soundstage#install"
TESTED_COMFYUI = "0.43.0"
TESTED_VRAM_GB = 48
MIN_FILE_BYTES = 1 << 20  # a weight file under 1 MB is a failed or partial download

HF = "https://huggingface.co/"

# ---- node packs --------------------------------------------------------------------------------------------------
# folder: the custom_nodes folder names the pack is usually cloned as (for --comfy, which can't see classes).
PACKS = [
    {"id": "core", "name": "ComfyUI core nodes", "required": True, "url": "https://github.com/comfyanonymous/ComfyUI",
     "classes": ["CreateVideo", "GetVideoComponents", "ResizeImageMaskNode", "ComfySwitchNode", "StringContains",
                 "PrimitiveStringMultiline", "EmptyLTXVLatentVideo", "LTXVCropGuides", "ManualSigmas",
                 "EmptyFlux2LatentImage", "SAM3_Detect", "LoadBackgroundRemovalModel"],
     "why": "the App's graph uses these; they come with a recent ComfyUI",
     "fix": f"Update ComfyUI (git pull in the ComfyUI folder, or Manager › Update ComfyUI). Soundstage is tested on "
            f"ComfyUI v{TESTED_COMFYUI}."},
    {"id": "soundstage", "name": "Soundstage", "required": True, "url": "https://github.com/theboord/ComfyUI-Soundstage",
     "folder": ["ComfyUI-Soundstage", "comfyui-soundstage"],
     "classes": ["SoundstageStage", "SoundstageStep", "SoundstageGate", "SoundstageLook", "SoundstageGenerateVideo",
                 "SoundstageLayerPackStart"],
     "why": "its own nodes",
     "fix": "Soundstage's nodes did not load. Look for lines with 'Soundstage' in the ComfyUI console, then run "
            "pip install -r custom_nodes/ComfyUI-Soundstage/requirements.txt with ComfyUI's Python and restart."},
    {"id": "ltxvideo", "name": "ComfyUI-LTXVideo", "required": True, "url": "https://github.com/Lightricks/ComfyUI-LTXVideo",
     "folder": ["ComfyUI-LTXVideo", "comfyui-ltxvideo"],
     "classes": ["LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide", "GemmaAPITextEncode", "LTXFloatToInt"],
     "why": "Motion (drafts and finals): the Layout-to-Render IC-LoRA nodes",
     "fix": "cd ComfyUI/custom_nodes && git clone https://github.com/Lightricks/ComfyUI-LTXVideo && "
            "pip install -r ComfyUI-LTXVideo/requirements.txt, then restart ComfyUI (or Manager › Install Custom Nodes › "
            "ComfyUI-LTXVideo)."},
    {"id": "krea2cn", "name": "comfyui-krea2-controlnet", "required": True,
     "url": "https://github.com/facok/comfyui-krea2-controlnet", "folder": ["comfyui-krea2-controlnet"],
     "classes": ["Krea2ControlApply", "Krea2ControlImageEncode", "Krea2ControlLoRALoader"],
     "why": "the App workflows contain its nodes for the optional depth-locked Krea 2 frame; without it they open "
            "with red missing nodes",
     "fix": "cd ComfyUI/custom_nodes && git clone https://github.com/facok/comfyui-krea2-controlnet, then restart ComfyUI."},
    {"id": "controlnet_aux", "name": "comfyui_controlnet_aux", "required": False,
     "url": "https://github.com/Fannovel16/comfyui_controlnet_aux", "folder": ["comfyui_controlnet_aux"],
     "classes": ["DWPreprocessor", "CannyEdgePreprocessor"],
     "why": "Recast's pose control and Performance capture (DWPose)",
     "fix": "Manager › Install Custom Nodes › comfyui_controlnet_aux (or git clone "
            "https://github.com/Fannovel16/comfyui_controlnet_aux into custom_nodes and pip install its requirements)."},
    {"id": "vhs", "name": "ComfyUI-VideoHelperSuite", "required": False,
     "url": "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", "folder": ["ComfyUI-VideoHelperSuite", "comfyui-videohelpersuite"],
     "classes": ["VHS_LoadVideo", "VHS_VideoInfo"],
     "why": "only the Soundstage_Recast_LTX_UnionControl_Graph workflow",
     "fix": "Manager › Install Custom Nodes › ComfyUI-VideoHelperSuite."},
    {"id": "rmbg", "name": "ComfyUI-RMBG (GPL-3.0)", "required": False, "url": "https://github.com/1038lab/ComfyUI-RMBG",
     "folder": ["ComfyUI-RMBG", "comfyui-rmbg"], "classes": ["SAM3Segment"],
     "why": "only the Soundstage_Recast_LTX_UnionControl_Graph workflow (SAM3Segment); the Recast node itself uses "
            "core SAM 3.1",
     "fix": "Manager › Install Custom Nodes › ComfyUI-RMBG (a GPL-3.0 pack; nothing in Soundstage copies it)."},
]


# ---- features and their files --------------------------------------------------------------------------------
def _f(folder, any_, source, url=None, hf=None, size=None, note=""):
    """One needed file. any_: accepted names (first = the one to download). hf: (repo, path in repo) for --sizes."""
    return {"folder": folder, "any": list(any_), "source": source, "url": url or MODELS_DOC, "hf": hf,
            "size": size, "note": note}


LTX = "Lightricks/LTX-2.5"
KREA = "Comfy-Org/Krea-2"
FEATURES = [
    {"id": "set", "name": "Set, Look, Cut and exports", "default": True, "gpu": False, "packs": ["soundstage"],
     "files": [], "what": "the 3D stage, the Look tab, the Cut tab and the NLE exports run in the browser"},
    {"id": "frame", "name": "④ Frame: first frames, cast sheets, Paint Studio (FLUX 3 Klein)", "default": True,
     "gpu": True, "packs": ["core"], "what": "the App's default image model",
     "files": [
         _f("diffusion_models", ["flux3-image-klein-int8-convrot.safetensors"],
            "FLUX 3 Klein (int8 repackage) · Black Forest Labs", f"{HF}black-forest-labs"),
         _f("text_encoders", ["qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_int8_convrot.safetensors"],
            "Qwen3-VL 4B text encoder, shared with Krea 2 (the int8 build works too)",
            f"{HF}{KREA}/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
            hf=(KREA, "text_encoders/qwen3vl_4b_fp8_scaled.safetensors")),
         _f("vae", ["flux2-vae.safetensors"], "FLUX.2 VAE · Black Forest Labs", f"{HF}black-forest-labs"),
     ]},
    {"id": "motion", "name": "⑤ Motion: drafts and finals (LTX-2.5 Layout-to-Render)", "default": True, "gpu": True,
     "packs": ["core", "ltxvideo"], "what": "video with sound from the clay blocking",
     "too_small_gb": 16,
     "too_small_why": "a 16 GB card (RTX 5080) could not hold LTX-2.5 22B and its Gemma text encoder (about 35 GB)",
     "files": [
         _f("diffusion_models", ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
                                 "ltx-2.5-22b-distilled-transformer-bf16.safetensors"],
            "LTX-2.5 22B distilled", f"{HF}{LTX}",
            hf=(LTX, "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors")),
         _f("text_encoders", ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
                              "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"],
            "Gemma text encoder for LTX-2.5", f"{HF}{LTX}",
            hf=(LTX, "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors")),
         _f("vae", ["ltx-2.5-video-vae-bf16.safetensors"], "LTX-2.5 video VAE", f"{HF}{LTX}",
            hf=(LTX, "vae/ltx-2.5-video-vae-bf16.safetensors")),
         _f("vae", ["ltx-2.5-audio-vae-bf16.safetensors"], "LTX-2.5 audio VAE", f"{HF}{LTX}",
            hf=(LTX, "vae/ltx-2.5-audio-vae-bf16.safetensors")),
         _f("latent_upscale_models", ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"],
            "LTX-2.5 x2 latent upscaler", f"{HF}{LTX}",
            hf=(LTX, "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors")),
         _f("loras", ["ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"],
            "Layout-to-Render IC-LoRA (put it in loras/ltx2.5/)",
            f"{HF}Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render",
            hf=("Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render", "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors")),
     ]},
    {"id": "krea", "name": "Frame, optional: Krea 2 Turbo locked to the stage's depth", "default": False, "gpu": True,
     "packs": ["krea2cn"], "what": "an alternative first-frame model",
     "files": [
         _f("diffusion_models", ["Krea-2-Turbo.safetensors", "krea2_turbo_fp8_scaled.safetensors",
                                 "krea2_turbo_int8_convrot.safetensors"],
            "Krea 2 Turbo (Comfy-Org repackage)", f"{HF}{KREA}",
            hf=(KREA, "diffusion_models/krea2_turbo_fp8_scaled.safetensors")),
         _f("text_encoders", ["qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_int8_convrot.safetensors"],
            "Qwen3-VL 4B text encoder", f"{HF}{KREA}", hf=(KREA, "text_encoders/qwen3vl_4b_fp8_scaled.safetensors")),
         _f("vae", ["qwen_image_vae.safetensors"], "Qwen Image VAE", f"{HF}{KREA}",
            hf=(KREA, "vae/qwen_image_vae.safetensors")),
         _f("loras", ["depth-control-lora.safetensors"], "Krea 2 depth-control LoRA (put it in loras/krea2/cn/)",
            f"{HF}Patil/Krea-2-depth-controlnet", hf=("Patil/Krea-2-depth-controlnet", "depth-control-lora.safetensors")),
     ]},
    {"id": "layers", "name": "Layer Pack mattes from the final frames (SAM 3.1, BiRefNet)", "default": False,
     "gpu": True, "packs": ["core"], "what": "without them the Layer Pack falls back to the stage's own mattes",
     "files": [
         _f("checkpoints", ["sam3.1_multiplex_fp16.safetensors"], "SAM 3.1 (Comfy-Org repackage of facebook/sam3)",
            f"{HF}Comfy-Org"),
         _f("background_removal", ["birefnet.safetensors"], "BiRefNet (ComfyUI core Remove Background)",
            "https://github.com/ZhengPeng7/BiRefNet"),
     ]},
    {"id": "h3", "name": "Motion, optional second engine: MiniMax H3", "default": False, "gpu": True, "packs": ["core"],
     "what": "rich motion with its own sound, looser blocking (license is region-limited: see MODELS.md)",
     "files": [
         _f("diffusion_models", ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_fl2va_bf16.safetensors"],
            "MiniMax H3 fl2va", f"{HF}Comfy-Org/MiniMax-H3"),
         _f("text_encoders", ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "qwen3vl_32b_minimax_h3_bf16.safetensors"],
            "Qwen3-VL 32B text encoder for H3", f"{HF}Comfy-Org/MiniMax-H3"),
         _f("vae", ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_video_vae_int8_convrot.safetensors"],
            "H3 video VAE", f"{HF}Comfy-Org/MiniMax-H3"),
         _f("vae", ["minimax_h3_audio_vae_fp32.safetensors"], "H3 audio VAE", f"{HF}Comfy-Org/MiniMax-H3"),
     ]},
    {"id": "designer", "name": "Object designer, scene agent and Director on this machine (Qwen3.5 4B)",
     "default": False, "gpu": True, "packs": ["core"],
     "what": "without it the agent and the Director plan from their rules",
     "files": [_f("text_encoders", ["qwen3.5_4b_bf16.safetensors"], "Qwen3.5 4B (Comfy-Org)",
                  f"{HF}Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_4b_bf16.safetensors",
                  hf=("Comfy-Org/Qwen3.5", "text_encoders/qwen3.5_4b_bf16.safetensors"))]},
    {"id": "mocap", "name": "Motion capture from video (SAM 3D Body)", "default": False, "gpu": True, "packs": ["core"],
     "what": "puts a filmed performance on a clay actor",
     "files": [_f("detection", ["sam_3d_body_dinov3_bf16.safetensors"], "SAM 3D Body (Comfy-Org repackage)",
                  f"{HF}Comfy-Org/sam-3d-body")]},
    {"id": "voice", "name": "Director voice, offline (Whisper base)", "default": False, "gpu": False, "packs": [],
     "what": "without it the browser's own speech recognition still works",
     "dirs": [{"path": "whisper/whisper-base", "has": "config.json", "source": "openai/whisper-base (the whole folder)",
               "url": f"{HF}openai/whisper-base", "size": "about 290 MB"}], "files": []},
    {"id": "tts", "name": "Dialogue on this machine (Chatterbox TTS)", "default": False, "gpu": False, "packs": [],
     "what": "Character voices and spoken lines; see docs/audio.md", "deps": ["chatterbox"],
     "dirs": [{"path": "TTS/chatterbox/English", "alt": "TTS/chatterbox", "has": "tokenizer.json",
               "source": "Chatterbox English weights (ve, t3_cfg, s3gen, tokenizer.json, conds.pt)",
               "url": "https://github.com/theboord/ComfyUI-Soundstage/blob/main/docs/audio.md"}], "files": []},
    {"id": "recast", "name": "Recast and Performance capture (pose control)", "default": False, "gpu": True,
     "packs": ["controlnet_aux"], "what": "swap a person in real footage; see docs/recast.md", "files": []},
    {"id": "recast_graph", "name": "The Recast union-control graph workflow", "default": False, "gpu": True,
     "packs": ["controlnet_aux", "vhs", "rmbg", "ltxvideo"],
     "what": "example_workflows/Soundstage_Recast_LTX_UnionControl_Graph.json", "files": []},
]

# (import name, pip name, required, what for)
DEPS = [
    ("soundfile", "soundfile", True, "the audio department (WAV/FLAC)"),
    ("scipy", "scipy", True, "mocap smoothing and Video → Stage geometry"),
    ("cv2", "opencv-python-headless", True, "Video → Stage and Photo → 3D image ops"),
    ("numpy", "numpy", True, "comes with ComfyUI"),
    ("PIL", "Pillow", True, "comes with ComfyUI"),
    ("av", "av", True, "video read/write; comes with ComfyUI"),
    ("aaf2", "pyaaf2", False, "Avid AAF export from the Cut tab (EDL, XML and OTIO need nothing)"),
    ("chatterbox", "chatterbox-tts", False, "Dialogue on this machine (Chatterbox)"),
    ("transformers", "transformers", False, "the offline Director voice (Whisper); comes with ComfyUI"),
]


# ---- matching a file the way the App does (web/ui/modelmatch.mjs) --------------------------------------------------
_PREC = ["fp32", "bf16", "fp16", "fp8", "int8", "fp4", "nvfp4", "int4"]
_PACK = {"comfy", "comfyui", "convrot", "scaled", "e4m3fn", "e5m2", "e4m3", "awq", "pruned", "dynamic", "mixed",
         "quant", "quantized", "fp8e4m3fn", "fp8e5m2"}
_EXT = re.compile(r"\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$", re.I)


def family_key(name: str) -> str:
    """Two files with the same family key are builds of the same weights (precision / packaging words dropped)."""
    stem = _EXT.sub("", re.split(r"[\\/]", name)[-1]).lower()
    return "".join(t for t in re.split(r"[-_\s+]+", stem) if t and t not in _PREC and t not in _PACK)


def match_file(wanted: list[str], have: list[tuple[str, int | None]]):
    """(status, relpath, size) for the best installed file: 'ok' (a listed name, any subfolder),
    'other_build' (same family, another precision), or ('missing', None, None)."""
    by_base = {}
    for rel, size in have:
        by_base.setdefault(re.split(r"[\\/]", rel)[-1].lower(), (rel, size))
    for w in wanted:
        if w.lower() in by_base:
            return ("ok",) + by_base[w.lower()]
    fams = {family_key(w) for w in wanted if family_key(w)}
    for rel, size in sorted(have):
        if family_key(rel) in fams:
            return ("other_build", rel, size)
    return ("missing", None, None)


# ---- probes: where the facts come from -----------------------------------------------------------------------------
class InProcessProbe:
    """Inside ComfyUI's own process (the /soundstage/doctor route)."""
    mode = "inside ComfyUI"

    def __init__(self):
        import folder_paths  # noqa: F401  (fails outside ComfyUI)
        self._fp = folder_paths

    def has_class(self, name):
        import nodes
        return name in nodes.NODE_CLASS_MAPPINGS

    def list_files(self, folder):
        try:
            names = self._fp.get_filename_list(folder)
        except Exception:  # noqa: BLE001  unknown folder on this ComfyUI
            return None
        out = []
        for n in names:
            p = self._fp.get_full_path(folder, n)
            out.append((n, os.path.getsize(p) if p and os.path.isfile(p) else None))
        return out

    def model_roots(self):
        roots = {self._fp.models_dir}
        for kind in ("checkpoints", "diffusion_models", "vae", "text_encoders"):
            try:
                for p in self._fp.get_folder_paths(kind):
                    roots.add(os.path.dirname(os.path.normpath(p)))
            except Exception:  # noqa: BLE001
                pass
        return sorted(roots)

    def gpu(self):
        try:
            import comfy.model_management as mm
            dev = mm.get_torch_device()
            if getattr(dev, "type", "") == "cpu":
                return {"name": "none (ComfyUI runs on the CPU)", "vram_gb": 0.0, "source": "ComfyUI"}
            return {"name": mm.get_torch_device_name(dev), "vram_gb": round(mm.get_total_memory(dev) / 2**30, 1),
                    "source": "ComfyUI"}
        except Exception as e:  # noqa: BLE001
            return {"name": None, "vram_gb": None, "source": f"unknown ({e})"}

    def comfy_version(self):
        try:
            import comfyui_version
            return comfyui_version.__version__
        except Exception:  # noqa: BLE001
            return None

    def has_module(self, name):
        return _has_module(name)

    python = property(lambda self: sys.executable)


class HttpProbe:
    """A running ComfyUI from outside, one small request at a time."""
    mode = "over HTTP"

    def __init__(self, url, timeout=10.0):
        self.url, self.timeout = url.rstrip("/"), timeout
        self._folders = None
        self.asked = []

    def _get(self, path):
        self.asked.append(path)
        with urllib.request.urlopen(self.url + path, timeout=self.timeout) as r:
            return json.loads(r.read() or b"null")

    def has_class(self, name):
        try:
            d = self._get("/object_info/" + urllib.parse.quote(name, safe=""))
        except (urllib.error.URLError, ValueError, OSError):
            return None
        return isinstance(d, dict) and name in d

    def list_files(self, folder):
        try:
            if self._folders is None:
                self._folders = set(self._get("/models") or [])
            if folder not in self._folders:
                return None
            return [(n, None) for n in self._get("/models/" + urllib.parse.quote(folder, safe="")) or []]
        except (urllib.error.URLError, ValueError, OSError):
            return None

    def model_roots(self):
        return None

    def gpu(self):
        try:
            d = self._get("/system_stats")
        except (urllib.error.URLError, ValueError, OSError) as e:
            return {"name": None, "vram_gb": None, "source": f"unknown ({e})"}
        devs = d.get("devices") or []
        if not devs or devs[0].get("type") == "cpu":
            return {"name": "none (ComfyUI runs on the CPU)", "vram_gb": 0.0, "source": "/system_stats"}
        return {"name": devs[0].get("name"), "vram_gb": round((devs[0].get("vram_total") or 0) / 2**30, 1),
                "source": "/system_stats"}

    def comfy_version(self):
        try:
            return (self._get("/system_stats").get("system") or {}).get("comfyui_version")
        except (urllib.error.URLError, ValueError, OSError, AttributeError):
            return None

    def has_module(self, name):
        return None  # ComfyUI's Python can't be seen from outside

    python = None


class DiskProbe:
    """A ComfyUI folder on disk (ComfyUI not running)."""
    mode = "from disk"

    def __init__(self, comfy_dir):
        self.root = os.path.abspath(comfy_dir)
        self.models = os.path.join(self.root, "models")
        self._extra = self._extra_bases()

    def _extra_bases(self):
        """Folders named in extra_model_paths.yaml: {folder: [paths]} (needs PyYAML; skipped without it)."""
        out = {}
        p = os.path.join(self.root, "extra_model_paths.yaml")
        if not os.path.isfile(p):
            return out
        try:
            import yaml
            with open(p, encoding="utf-8") as f:
                conf = yaml.safe_load(f) or {}
        except Exception:  # noqa: BLE001
            return out
        for c in conf.values():
            if not isinstance(c, dict):
                continue
            base = os.path.expanduser(str(c.get("base_path", "")))
            for k, v in c.items():
                if k in ("base_path", "is_default"):
                    continue
                for line in str(v).splitlines():
                    if line.strip():
                        out.setdefault(k, []).append(os.path.join(base, line.strip()))
        return out

    def has_class(self, name):
        return None

    def has_pack_folder(self, names):
        cn = os.path.join(self.root, "custom_nodes")
        try:
            have = {d.lower() for d in os.listdir(cn)}
        except OSError:
            return None
        return any(n.lower() in have for n in names)

    def list_files(self, folder):
        dirs = [os.path.join(self.models, folder)] + self._extra.get(folder, [])
        if folder == "diffusion_models":
            dirs.append(os.path.join(self.models, "unet"))
        if folder == "text_encoders":
            dirs.append(os.path.join(self.models, "clip"))
        out = []
        for d in dirs:
            for dp, _, fs in os.walk(d, followlinks=True):
                for fn in fs:
                    p = os.path.join(dp, fn)
                    try:
                        out.append((os.path.relpath(p, d).replace(os.sep, "/"), os.path.getsize(p)))
                    except OSError:
                        pass
        return out

    def model_roots(self):
        roots = {self.models}
        for paths in self._extra.values():
            for p in paths:
                roots.add(os.path.dirname(os.path.normpath(p)))
        return sorted(roots)

    def gpu(self):
        return local_gpu()

    def comfy_version(self):
        p = os.path.join(self.root, "comfyui_version.py")
        try:
            m = re.search(r'__version__\s*=\s*"([^"]+)"', open(p, encoding="utf-8").read())
            return m.group(1) if m else None
        except OSError:
            return None

    def has_module(self, name):
        return _has_module(name)

    python = property(lambda self: sys.executable)


def _has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def local_gpu():
    """VRAM of this machine's first NVIDIA GPU via nvidia-smi (no torch needed)."""
    smi = shutil.which("nvidia-smi")
    if not smi:
        return {"name": None, "vram_gb": None, "source": "no nvidia-smi on this machine"}
    try:
        r = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10)
        name, mib = r.stdout.strip().splitlines()[0].rsplit(",", 1)
        return {"name": name.strip(), "vram_gb": round(float(mib) / 1024, 1), "source": "nvidia-smi"}
    except Exception as e:  # noqa: BLE001
        return {"name": None, "vram_gb": None, "source": f"nvidia-smi failed ({e})"}


# ---- the report ---------------------------------------------------------------------------------------------------
def vram_verdict(feature, vram_gb):
    """(status, words) for one feature on a card with vram_gb (None = unknown, 0 = no GPU)."""
    if not feature.get("gpu"):
        return "fits", "no GPU needed"
    if vram_gb is None:
        return "unknown", "VRAM unknown"
    if vram_gb <= 0:
        return "no", "needs an NVIDIA GPU"
    small = feature.get("too_small_gb")
    if small and vram_gb <= small + 0.5:
        return "no", f"too small: {feature['too_small_why']}"
    if vram_gb >= TESTED_VRAM_GB - 2:
        return "fits", f"fits (tested on a {TESTED_VRAM_GB} GB card)"
    return "untested", f"untested below {TESTED_VRAM_GB} GB; may need offloading"


def _pack_status(pack, probe):
    if isinstance(probe, DiskProbe):
        if pack["id"] == "core":  # classes can't be seen on disk: judge by the version
            v = _version_tuple(probe.comfy_version())
            if v is None:
                return {"status": "unknown", "missing": []}
            return {"status": "ok" if v >= _version_tuple(TESTED_COMFYUI) else "partial", "missing": [],
                    "note": f"ComfyUI {probe.comfy_version()}"}
        found = probe.has_pack_folder(pack.get("folder") or [])
        return {"status": "unknown" if found is None else ("ok" if found else "missing"), "missing": [],
                "note": "folder in custom_nodes" if found else ""}
    res = {c: probe.has_class(c) for c in pack["classes"]}
    if any(v is None for v in res.values()):
        return {"status": "unknown", "missing": [c for c, v in res.items() if v is None]}
    missing = [c for c, v in res.items() if not v]
    status = "ok" if not missing else ("missing" if len(missing) == len(res) else "partial")
    return {"status": status, "missing": missing}


def _version_tuple(v):
    m = re.match(r"(\d+)\.(\d+)\.(\d+)", str(v or ""))
    return tuple(int(x) for x in m.groups()) if m else None


def _file_status(spec, probe, cache):
    if spec["folder"] not in cache:
        cache[spec["folder"]] = probe.list_files(spec["folder"])
    have = cache[spec["folder"]]
    out = {"folder": spec["folder"], "want": spec["any"][0], "accepts": spec["any"], "source": spec["source"],
           "url": spec["url"], "size": spec.get("size"), "hf": spec.get("hf")}
    if have is None:
        return {**out, "status": "unknown", "found": None, "bytes": None}
    status, rel, size = match_file(spec["any"], have)
    if status != "missing" and size is not None and size < MIN_FILE_BYTES and _EXT.search(rel or ""):
        status = "incomplete"
    return {**out, "status": status, "found": rel, "bytes": size}


def _dir_status(spec, probe):
    roots = probe.model_roots()
    out = {"folder": spec["path"], "want": spec["path"].split("/")[-1], "source": spec["source"], "url": spec["url"],
           "size": spec.get("size"), "hf": None, "accepts": [spec["path"]], "is_dir": True}
    if roots is None:
        return {**out, "status": "unknown", "found": None, "bytes": None}
    for r in roots:
        for rel in (spec["path"], spec.get("alt")):
            if rel and os.path.isfile(os.path.join(r, *rel.split("/"), spec["has"])):
                return {**out, "status": "ok", "found": os.path.join(r, *rel.split("/")), "bytes": None}
    return {**out, "status": "missing", "found": None, "bytes": None}


def build_report(probe, sizes=False) -> dict:
    gpu = probe.gpu()
    packs = []
    for p in PACKS:
        st = _pack_status(p, probe)
        packs.append({k: p[k] for k in ("id", "name", "required", "url", "why", "fix")} | st)
    pack_by = {p["id"]: p for p in packs}

    deps = []
    for mod, pip, req, why in DEPS:
        ok = probe.has_module(mod)
        deps.append({"module": mod, "pip": pip, "required": req, "why": why,
                     "status": "unknown" if ok is None else ("ok" if ok else "missing")})
    dep_by = {d["module"]: d for d in deps}

    cache, features = {}, []
    for f in FEATURES:
        files = [_file_status(s, probe, cache) for s in f.get("files", [])]
        files += [_dir_status(s, probe) for s in f.get("dirs", [])]
        need_packs = [pack_by[p] for p in f.get("packs", [])]
        need_deps = [dep_by[d] for d in f.get("deps", [])]
        states = [x["status"] for x in files] + [p["status"] for p in need_packs] + [d["status"] for d in need_deps]
        if any(s in ("missing", "incomplete", "partial") for s in states):
            status = "not ready"
        elif any(s == "unknown" for s in states):
            status = "unknown"
        else:
            status = "ready"
        fit, fit_words = vram_verdict(f, gpu.get("vram_gb"))
        features.append({"id": f["id"], "name": f["name"], "default": f["default"], "what": f["what"],
                         "status": status, "files": files, "packs": [p["id"] for p in need_packs],
                         "vram": fit, "vram_words": fit_words})

    if sizes:
        add_hf_sizes(features)

    report = {"when": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "mode": probe.mode,
              "python": probe.python, "comfyui_version": probe.comfy_version(), "tested_comfyui": TESTED_COMFYUI,
              "gpu": gpu, "packs": packs, "features": features, "deps": deps,
              "models_doc": MODELS_DOC, "install_doc": INSTALL_DOC}
    report["steps"] = next_steps(report)
    report["ok"] = not any(s["required"] for s in report["steps"])
    return report


def next_steps(report) -> list[dict]:
    """What to do, most important first: [{'required': bool, 'text': str, 'url': str}]."""
    steps = []
    for p in report["packs"]:
        if p["status"] in ("missing", "partial"):
            what = f"Install {p['name']}" if p["status"] == "missing" else f"Update {p['name']}"
            miss = f" (missing: {', '.join(p['missing'])})" if p["missing"] else ""
            steps.append({"required": p["required"], "text": f"{what}{miss} ({p['why']}). {p['fix']}",
                          "url": p["url"]})
    for d in report["deps"]:
        if d["status"] == "missing":
            steps.append({"required": d["required"],
                          "text": f"pip install {d['pip']} (with ComfyUI's Python): {d['why']}.", "url": ""})
    seen = set()
    for f in report["features"]:
        for x in f["files"]:
            key = (x["folder"], frozenset(x["accepts"]))
            if x["status"] not in ("missing", "incomplete") or key in seen:
                continue
            seen.add(key)
            size = f", {x['size']}" if x.get("size") else ""
            if x.get("is_dir"):
                text = f"Put {x['source']} in models/{x['folder']}/{size.replace(', ', ' (') + ')' if size else ''} for {f['name']}."
            else:
                verb = "Download again (the file is incomplete)" if x["status"] == "incomplete" else "Download"
                text = f"{verb} {x['want']} into models/{x['folder']}/ ({x['source']}{size}) for {f['name']}."
            steps.append({"required": f["default"], "text": text, "url": x["url"]})
    v = report["gpu"].get("vram_gb")
    if v is not None and v <= 0:
        steps.append({"required": False, "text": "No NVIDIA GPU: the stage, Look, Cut and exports work; Frame and "
                      "Motion need a GPU (48 GB recommended).", "url": INSTALL_DOC})
    steps.sort(key=lambda s: not s["required"])
    return steps


def add_hf_sizes(features, timeout=10.0):
    """Ask Hugging Face for the size of each missing file that has a known repo path (HEAD on the resolve URL)."""
    for f in features:
        for x in f["files"]:
            if x.get("size") or not x.get("hf") or x["status"] == "ok":
                continue
            repo, path = x["hf"]
            req = urllib.request.Request(f"{HF}{repo}/resolve/main/{path}", method="HEAD")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    n = r.headers.get("x-linked-size") or r.headers.get("content-length")
            except urllib.error.HTTPError as e:
                n = e.headers.get("x-linked-size") if e.headers else None
                if not n:
                    x["size"] = "gated: accept the license on Hugging Face" if e.code in (401, 403) else None
                    continue
            except (urllib.error.URLError, OSError):
                continue
            if n:
                x["size"] = human_bytes(int(n))


def human_bytes(n):
    for unit, k in (("GB", 2**30), ("MB", 2**20), ("KB", 2**10)):
        if n >= k:
            return f"{n / k:.1f} {unit}"
    return f"{n} bytes"


MARK = {"ok": "✓", "ready": "✓", "fits": "✓", "missing": "✗", "not ready": "✗", "incomplete": "✗", "partial": "✗",
        "no": "✗", "other_build": "✓", "unknown": "?", "untested": "~"}


def format_text(r) -> str:
    L = []
    gpu = r["gpu"]
    vram = gpu.get("vram_gb")
    L.append("Soundstage doctor")
    L.append(f"  Looked {r['mode']} · ComfyUI {r['comfyui_version'] or 'version unknown'} "
             f"(tested on {r['tested_comfyui']}) · GPU: {gpu.get('name') or 'unknown'}"
             + (f", {vram} GB" if vram else "") + f" ({gpu.get('source')})")
    L.append("")
    req = [s for s in r["steps"] if s["required"]]
    opt = [s for s in r["steps"] if not s["required"]]
    if not req:
        L.append("Ready: the required node packs, Python packages and the default models (Frame and Motion) are here.")
    else:
        L.append(f"Not ready yet. Do these {len(req)} thing{'s' if len(req) != 1 else ''}, then restart ComfyUI and check again:")
        for i, s in enumerate(req, 1):
            L.append(f"  {i}. {s['text']}" + (f"\n     {s['url']}" if s["url"] else ""))
    L.append("")
    L.append("What works on this setup:")
    for f in r["features"]:
        tag = "" if f["default"] else " (optional)"
        L.append(f"  {MARK.get(f['status'], '?')} {f['name']}{tag}: {f['status']} · {f['vram_words']}")
        for x in f["files"]:
            if x["status"] == "ok":
                continue
            if x["status"] == "other_build":
                L.append(f"      using {x['found']} (another build of {x['want']}; fine)")
            elif x["status"] == "unknown":
                L.append(f"      ? {x['want']}: could not see models/{x['folder']}/")
            else:
                why = " (incomplete download)" if x["status"] == "incomplete" else ""
                name = x["source"] if x.get("is_dir") else x["want"]
                L.append(f"      ✗ {name}{why} → models/{x['folder']}/" + (f" · {x['size']}" if x.get("size") else ""))
    L.append("")
    L.append("Node packs:")
    for p in r["packs"]:
        tag = "required" if p["required"] else "optional"
        extra = f" (missing {', '.join(p['missing'])})" if p["status"] in ("partial",) else ""
        L.append(f"  {MARK.get(p['status'], '?')} {p['name']} [{tag}]: {p['status']}{extra}")
    L.append("")
    if any(d["status"] == "unknown" for d in r["deps"]):
        L.append("Python packages: not checked (ComfyUI's Python can't be seen from outside; the App's "
                 "Tools › Check my setup checks them).")
    else:
        L.append(f"Python packages ({r['python']}):")
        if r["mode"] == "from disk":
            L.append("  (checked in the Python running this command: run it with the Python that starts ComfyUI)")
        for d in r["deps"]:
            tag = "" if d["required"] else " (optional)"
            L.append(f"  {MARK.get(d['status'], '?')} {d['pip']}{tag}: {d['status']} · {d['why']}")
    if opt:
        L.append("")
        L.append("Optional extras you could add:")
        for s in opt:
            L.append(f"  - {s['text']}")
    L.append("")
    L.append(f"Where to get every model, with licenses: {r['models_doc']}")
    L.append("Model sizes: run with --sizes to ask Hugging Face (only where the exact file path is known).")
    return "\n".join(L)


# ---- CLI ------------------------------------------------------------------------------------------------------------
def _fetch_server_report(url, timeout=60.0):
    """The full report from inside a running ComfyUI (/soundstage/doctor), or None when Soundstage isn't loaded."""
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/soundstage/doctor", timeout=timeout) as r:
            d = json.loads(r.read())
            return d if isinstance(d, dict) and "features" in d else None
    except (urllib.error.URLError, ValueError, OSError):
        return None


def _reachable(url, timeout=3.0):
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/system_stats", timeout=timeout):
            return True
    except (urllib.error.URLError, ValueError, OSError):
        return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m soundstage.doctor",
                                 description="Check a ComfyUI install for Soundstage: node packs, models, VRAM, "
                                             "Python packages. Exit status 0 when the required parts are there.")
    ap.add_argument("--url", help="a running ComfyUI (default: http://127.0.0.1:8188 when it answers)")
    ap.add_argument("--comfy", help="a ComfyUI folder to read when ComfyUI is not running "
                                    "(default: the folder this pack sits in, custom_nodes/..)")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    ap.add_argument("--sizes", action="store_true", help="ask Hugging Face for each missing file's size")
    a = ap.parse_args(argv)

    report = None
    url = a.url or ("http://127.0.0.1:8188" if not a.comfy else None)
    if url and (a.url or _reachable(url)):
        report = _fetch_server_report(url)
        if report is None:
            if a.url and not _reachable(url):  # nothing answered: every check would be "unknown", not "ready"
                print(f"No ComfyUI answered at {url}. Start it, check the address, or pass --comfy /path/to/ComfyUI.",
                      file=sys.stderr)
                return 2
            report = build_report(HttpProbe(url), sizes=a.sizes)
        elif a.sizes:
            add_hf_sizes(report["features"])
            report["steps"] = next_steps(report)
    if report is None:
        # soundstage/doctor.py -> ComfyUI-Soundstage -> custom_nodes -> the ComfyUI folder
        comfy = a.comfy or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *[os.pardir] * 3))
        if not os.path.isdir(os.path.join(comfy, "models")):
            print(f"No ComfyUI answered at {url} and {comfy} has no models/ folder. "
                  "Start ComfyUI, or pass --url or --comfy /path/to/ComfyUI.", file=sys.stderr)
            return 2
        report = build_report(DiskProbe(comfy), sizes=a.sizes)
    print(json.dumps(report, indent=1, default=str) if a.json else format_text(report))
    return 0 if report["ok"] else 1


# ---- the App's button ----------------------------------------------------------------------------------------------
def register():
    """GET /soundstage/doctor: the report from inside ComfyUI (Tools ▾ › Check my setup)."""
    import asyncio

    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/soundstage/doctor")
    async def doctor(request):
        loop = asyncio.get_running_loop()
        rep = await loop.run_in_executor(None, lambda: build_report(InProcessProbe()))
        rep["text"] = format_text(rep)  # the dialog's Copy report
        return web.json_response(rep)


if __name__ == "__main__":
    sys.exit(main())
