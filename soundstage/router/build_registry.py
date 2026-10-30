"""Build soundstage/router/registry.json and docs/router.md from the research registries.

    python -m soundstage.router.build_registry [--research ../research]

Two kinds of entries end up in registry.json:
- WIRED: hand-curated below. They carry an `adapter` (see adapters.py), the node classes they
  expand into and the weight files they need, so the router can show them when installed.
- CATALOGUE: every other model from research/10_model_registry.json and 12_layers_registry.json,
  mapped onto the Soundstage stages with `adapter: null`. They never show in a dropdown; they are
  the backlog of models to wire next and are listed in docs/router.md.
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

STAGES = {
    "generate_image": "Generate image (text / refs → still)",
    "edit_image": "Edit image (edit, keyframe from control)",
    "generate_video": "Generate video (image / control → shot)",
    "matte": "Matte (background removal / alpha)",
    "clean_plate": "Clean plate (remove subjects)",
}

LTX_LICENSE = "LTX-2.x Community License: free incl. commercial for entities <$10M annual revenue; paid above"
API_LICENSE = "Provider ToS via Comfy partner proxy (paid Comfy credits)"
H3_LICENSE = ("MiniMax H3 Community License: EXCLUDES USA, EU, UK, South Korea; <$20M revenue elsewhere; "
              "must display 'MiniMax H3' in commercial UI. US users need the commercial license Comfy resells")
CLOUD_LICENSE = "Open-weights model run on Comfy Cloud GPUs, billed per GPU-second through the partner proxy"

LTX_BASE_WEIGHTS = [
    {"role": "unet", "folder": "diffusion_models",
     "any": ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
             "ltx-2.5-22b-distilled-transformer-bf16.safetensors"]},
    {"role": "text_encoder", "folder": "text_encoders",
     "any": ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
             "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"]},
    {"role": "vae", "folder": "vae", "any": ["ltx-2.5-video-vae-bf16.safetensors"]},
]
LTX_AUDIO_VAE = {"role": "audio_vae", "folder": "vae", "any": ["ltx-2.5-audio-vae-bf16.safetensors"]}
LTX_UPSCALER = {"role": "upscaler", "folder": "latent_upscale_models",
                "any": ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"]}
LTX_CLASSES = ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "LTXVConditioning",
               "EmptyLTXVLatentVideo", "RandomNoise", "KSamplerSelect", "ManualSigmas", "CFGGuider",
               "SamplerCustomAdvanced", "VAEDecodeTiled", "CreateVideo", "ResizeImageMaskNode"]
# LTXICLoRALoaderModelOnly / LTXAddVideoICLoRAGuide ship with the ComfyUI-LTXVideo node pack, not core.
LTX_IC_CLASSES = LTX_CLASSES + ["LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide", "LTXVCropGuides",
                                "GetImageSize"]


def partner(id, name, provider, stages, adapter, classes, variant=None, params=None, notes="",
            source_ids=None, kind="partner", license=API_LICENSE):
    return {"id": id, "name": name, "provider": provider, "kind": kind, "stages": stages,
            "adapter": adapter, "variant": variant, "classes": classes, "weights": [],
            "params": params or {}, "license": license, "notes": notes,
            "source_ids": source_ids or [f"api.{c}" for c in classes]}


def local(id, name, provider, stages, adapter, classes, weights, license, params=None, notes="",
          source_ids=None, kind="local", optional_weights=None, auto_download=False, variant=None):
    return {"id": id, "name": name, "provider": provider, "kind": kind, "stages": stages,
            "adapter": adapter, "variant": variant, "classes": classes, "weights": weights,
            "optional_weights": optional_weights or [], "auto_download": auto_download,
            "params": params or {}, "license": license, "notes": notes, "source_ids": source_ids or []}


def res(options, default=None):
    return {"resolution": {"options": options, "default": default or options[0]}}


# Order matters: the first available entry of a stage is its default.
WIRED = [
    # ---------------- generate_image -------------------------------------------------------------
    local("open.krea_2_turbo", "Krea 2 Turbo", "Krea", ["generate_image", "edit_image"], "krea2",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
           "EmptyLatentImage", "KSampler", "VAEDecode", "VAEEncode"],
          [{"role": "unet", "folder": "diffusion_models",
            "any": ["Krea-2-Turbo.safetensors", "krea2_turbo_fp8_scaled.safetensors",
                    "krea2_turbo_int8_convrot.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders", "any": ["qwen3vl_4b_fp8_scaled.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["qwen_image_vae.safetensors"]}],
          "Krea 2 Community License: commercial only if company revenue <$1M; moderation required",
          params={"denoise": {"min": 0.0, "max": 1.0, "default": 0.85, "stages": ["edit_image"]}},
          optional_weights=[{"role": "depth_lora", "folder": "loras", "any": ["depth-control-lora.safetensors"],
                             "classes": ["Krea2ControlLoRALoader", "Krea2ControlImageEncode", "Krea2ControlApply"]}],
          notes="8 steps cfg 1. control_image = stage depth steers the layout (Krea2 depth-control LoRA). "
                "Edit stage = the proven Soundstage look-still: img2img from the clay frame @0.85 + depth. "
                "Depth control needs the comfyui-krea2-controlnet pack.",
          source_ids=["open.krea_2"]),
    local("open.z_image_turbo", "Z-Image Turbo", "Alibaba Tongyi-MAI", ["generate_image"], "z_image",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
           "EmptySD3LatentImage", "ModelSamplingAuraFlow", "KSampler", "VAEDecode"],
          [{"role": "unet", "folder": "diffusion_models",
            "any": ["z_image_turbo_bf16.safetensors", "z_image_turbo_int8_convrot.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders", "any": ["qwen_3_4b.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["ae.safetensors"]}],
          "Apache 2.0", notes="Fastest commercial-safe previz model. 8 steps res_multistep.",
          source_ids=["open.z_image"]),
    local("open.flux3_klein", "FLUX 3 Klein", "Black Forest Labs", ["generate_image", "edit_image"], "flux3_klein",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
           "EmptyFlux2LatentImage", "KSampler", "VAEDecode", "ReferenceMultiLatent"],
          [{"role": "unet", "folder": "diffusion_models", "any": ["flux3-image-klein-int8-convrot.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders",
            "any": ["qwen3vl_4b_int8_convrot.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["flux2-vae.safetensors"]}],
          "FLUX Kommunity License: free non-commercial; commercial use of outputs OK if you+affiliates <$5M annual revenue",
          notes="Edit = ReferenceMultiLatent (image + refs, 1 MP). Distilled template settings.",
          source_ids=["open.flux3_klein"]),
    partner("api.nano_banana_2_1", "Nano Banana 2.1", "Google", ["generate_image", "edit_image"], "nano_banana",
            ["GeminiNanoBanana2V2"], variant="Gemini Nano Banana 2.1", params=res(["1K", "2K", "4K"], "2K")),
    partner("api.nano_banana_2", "Nano Banana 2 (Gemini 3.1 Flash Image)", "Google", ["generate_image", "edit_image"],
            "nano_banana", ["GeminiNanoBanana2V2"], variant="Nano Banana 2 (Gemini 3.1 Flash Image)",
            params=res(["1K", "2K", "4K"], "2K")),
    partner("api.gpt_image_2_5", "GPT Image 2.5", "OpenAI", ["generate_image", "edit_image"], "gpt_image",
            ["OpenAIGPTImageNodeV2"], variant="gpt-image-2.5-flare",
            params={"quality": {"options": ["low", "medium", "high"], "default": "medium"}}),
    partner("api.gpt_image_2", "GPT Image 2", "OpenAI", ["generate_image", "edit_image"], "gpt_image",
            ["OpenAIGPTImageNodeV2"], variant="gpt-image-2",
            params={"quality": {"options": ["low", "medium", "high"], "default": "medium"}}),
    partner("api.flux3_image", "FLUX 3 Image", "BFL", ["generate_image", "edit_image"], "flux3_api",
            ["Flux3ImageNode"], params=res(["1K", "1.5K", "2K", "4K"], "2K")),
    partner("api.seedream_5_pro", "Seedream 5.0 Pro", "ByteDance", ["generate_image", "edit_image"], "seedream",
            ["ByteDanceSeedreamNodeV3"], variant="seedream 5.0 pro"),
    partner("api.seedream_5_flash", "Seedream 5.0 Flash", "ByteDance", ["generate_image", "edit_image"], "seedream",
            ["ByteDanceSeedreamNodeV3"], variant="seedream 5.0 flash"),
    partner("api.krea_2_medium_turbo", "Krea 2 Medium Turbo (API)", "Krea", ["generate_image"], "krea2_api",
            ["Krea2ImageNode"], variant="Krea 2 Medium Turbo"),
    partner("api.krea_2_large", "Krea 2 Large (API)", "Krea", ["generate_image"], "krea2_api",
            ["Krea2ImageNode"], variant="Krea 2 Large"),
    partner("cloud.z_image_turbo", "Z-Image Turbo (Comfy Cloud)", "Comfy Cloud", ["generate_image"], "z_image_cloud",
            ["ComfyCloudZImageTurboNode"], kind="cloud", license=CLOUD_LICENSE,
            source_ids=["cloud.ComfyCloudZImageTurboNode"]),

    # ---------------- generate_video -------------------------------------------------------------
    local("open.ltx_2_5", "LTX-2.5 22B distilled", "Lightricks", ["generate_video"], "ltx25",
          LTX_CLASSES + ["LTXVCropGuides", "LTXVImgToVideoInplace", "LTXVPreprocess", "LTXVEmptyLatentAudio",
                            "LTXVConcatAVLatent", "LTXVSeparateAVLatent", "LTXVDualCFGGuider",
                            "LTXVLatentUpsampler", "LatentUpscaleModelLoader", "LTXVAudioVAEDecode"],
          LTX_BASE_WEIGHTS + [LTX_AUDIO_VAE, LTX_UPSCALER], LTX_LICENSE,
          params={"mode": {"options": ["auto", "image/text → video", "layout → render"], "default": "auto"}},
          optional_weights=[{"role": "l2r_lora", "folder": "loras",
                             "any": ["ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"],
                             "classes": ["LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide"]}],
          notes="Core engine (LTX bonus). auto = Layout-To-Render IC-LoRA when control_video (stage clay) is "
                "connected (needs the ComfyUI-LTXVideo pack + L2R LoRA), else the official two-stage i2v/t2v "
                "template with audio. first_frame = look still.",
          source_ids=["open.ltx_2_5"]),
    local("open.minimax_h3_local", "MiniMax H3", "MiniMax", ["generate_video"], "minimax_h3_local",
          ["UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3ImageToVideo", "BasicScheduler", "BasicGuider",
           "RandomNoise", "KSamplerSelect", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "ImageFromBatch",
           "TrimAudioDuration", "CreateVideo", "LoraLoaderModelOnly"],
          [{"role": "unet", "folder": "diffusion_models",
            "any": ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_fl2va_bf16.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders",
            "any": ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "qwen3vl_32b_minimax_h3_bf16.safetensors"]},
           {"role": "vae", "folder": "vae",
            "any": ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_video_vae_int8_convrot.safetensors"]},
           {"role": "audio_vae", "folder": "vae", "any": ["minimax_h3_audio_vae_fp32.safetensors"]}],
          H3_LICENSE,
          params={"motion_ref": {"options": ["off", "clay previz as <Video 1>"], "default": "off"}},
          optional_weights=[
              {"role": "turbo_lora", "folder": "loras", "any": ["minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"]},
              {"role": "ref_unet", "folder": "diffusion_models",
               "any": ["minimax_h3_ref2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_bf16.safetensors"],
               "classes": ["MiniMaxH3ReferenceToVideo"]}],
          notes="Optional second engine (LTX-2.5 stays the default). Video + its own sound in one pass; follows "
                "the clay blocking only loosely. first / last frame (either or both) -> fl2va (8-step turbo LoRA "
                "when installed). Reference images (ref_1..3 + ref_files, up to 9 pictures with the frames) and/or "
                "motion_ref = clay previz as <Video 1> -> ref2va, 20 steps, slow. Text encoder on CPU (32B). "
                "≤362 frames, 17k+5 grid, trimmed back to the shot length.",
          source_ids=["open.minimax_h3_local"]),
    local("open.wan_animate_2", "Wan Animate 2 distilled", "Alibaba Wan-AI", ["generate_video"], "wan_animate2",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPVisionLoader", "CLIPVisionEncode", "CLIPTextEncode",
           "WanAnimate2ToVideo", "WanAnimate2Cache", "ModelSamplingSD3", "BasicScheduler", "KSamplerSelect",
           "SamplerCustom", "TrimVideoLatent", "VAEDecode", "ImageFromBatch", "ResizeImageMaskNode", "CreateVideo"],
          [{"role": "unet", "folder": "diffusion_models", "any": ["wan_animate_2_distill_int8_convrot.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders",
            "any": ["umt5_xxl_fp8_e4m3fn_scaled.safetensors", "umt5_xxl_fp16.safetensors"]},
           {"role": "clip_vision", "folder": "clip_vision", "any": ["clip_vision_h.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["Wan2_1_VAE_bf16.safetensors", "wan_2.1_vae.safetensors"]}],
          "Apache 2.0",
          notes="Motion transfer: ref_1 = character, control_video = driving pose/performance. 81-frame window.",
          source_ids=["open.wan_animate_2"]),
    partner("api.kling_4_0", "Kling 4.0", "Kling", ["generate_video"], "kling4",
            ["Kling4TextToVideoNode", "Kling4ImageToVideoNode", "Kling4ReferenceToVideoNode"],
            variant="kling-4.0", params={**res(["720p", "1080p"], "1080p"), "duration": {"min": 3, "max": 30}},
            notes="first/last frame → I2V; refs → Reference-to-Video; prompt only → T2V."),
    partner("api.veo_3_1", "Veo 3.1", "Google", ["generate_video"], "veo3",
            ["Veo3VideoGenerationNode", "Veo3FirstLastFrameNode"], variant="veo-3.1-generate",
            params={**res(["720p", "1080p", "4k"], "1080p"), "duration": {"min": 4, "max": 8}}),
    partner("api.veo_3_1_fast", "Veo 3.1 Fast", "Google", ["generate_video"], "veo3",
            ["Veo3VideoGenerationNode", "Veo3FirstLastFrameNode"], variant="veo-3.1-fast-generate",
            params={**res(["720p", "1080p", "4k"], "1080p"), "duration": {"min": 4, "max": 8}}),
    partner("api.seedance_2_5", "Seedance 2.5", "ByteDance", ["generate_video"], "seedance2",
            ["ByteDance2TextToVideoNode", "ByteDance2FirstLastFrameNode"], variant="Seedance 2.5",
            params={**res(["480p", "720p", "1080p"], "1080p"), "duration": {"min": 4, "max": 30}}),
    partner("api.seedance_2_5_draft", "Seedance 2.5 Draft", "ByteDance", ["generate_video"], "seedance2",
            ["ByteDance2TextToVideoNode", "ByteDance2FirstLastFrameNode"], variant="Seedance 2.5 Draft",
            params={**res(["480p"]), "duration": {"min": 4, "max": 30}}),
    partner("api.seedance_2_0", "Seedance 2.0", "ByteDance", ["generate_video"], "seedance2",
            ["ByteDance2TextToVideoNode", "ByteDance2FirstLastFrameNode"], variant="Seedance 2.0",
            params={**res(["480p", "720p", "1080p", "4k"], "1080p"), "duration": {"min": 4, "max": 15}}),
    partner("api.minimax_h3", "MiniMax H3", "MiniMax", ["generate_video"], "minimax_h3",
            ["MinimaxHailuo03TextToVideoNode", "MinimaxHailuo03FirstLastFrameNode"], variant="MiniMax H3",
            params={**res(["768P", "2K"]), "duration": {"min": 4, "max": 15}}),
    partner("api.minimax_h3_max", "MiniMax H3 Max", "MiniMax", ["generate_video"], "minimax_h3",
            ["MinimaxHailuo03TextToVideoNode", "MinimaxHailuo03FirstLastFrameNode"], variant="MiniMax H3 Max",
            params={**res(["480P", "768P"], "768P"), "duration": {"min": 5, "max": 15}}),
    partner("api.runway_gen4", "Runway Gen-4 Turbo", "Runway", ["generate_video"], "runway_gen4",
            ["RunwayImageToVideoNodeGen4"], params={"duration": {"options": [5, 10]}},
            notes="Needs first_frame."),
    partner("api.luma_ray_3_2", "Luma Ray 3.2", "Luma", ["generate_video"], "luma_ray32",
            ["LumaRay32TextToVideoNode", "LumaRay32ImageToVideoNode"],
            params={**res(["540p", "720p", "1080p"], "1080p")}),
    partner("api.ltx_2_5_pro", "LTX-2.5 Pro (API)", "Lightricks", ["generate_video"], "ltx25_api",
            ["LtxApi25TextToVideo", "LtxApi25ImageToVideo"], variant="LTX-2.5 (Pro)",
            params={"duration": {"options": [2, 3, 4, 5, 6, 8, 10]}}),
    partner("api.ltx_2_5_fast", "LTX-2.5 Fast (API)", "Lightricks", ["generate_video"], "ltx25_api",
            ["LtxApi25TextToVideo", "LtxApi25ImageToVideo"], variant="LTX-2.5 (Fast)",
            params={"duration": {"options": [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]}}),

    # ---------------- matte ----------------------------------------------------------------------
    local("open.sam3", "SAM 3.1 (text-prompted)", "Meta", ["matte"], "sam3",
          ["CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_Detect", "InvertMask", "JoinImageWithAlpha"],
          [{"role": "checkpoint", "folder": "checkpoints", "any": ["sam3.1_multiplex_fp16.safetensors"]}],
          "SAM License (Meta)", params={"threshold": {"min": 0.0, "max": 1.0, "default": 0.5}},
          notes="prompt = what to keep (\"person\", \"the red car\"). Hard-edged; pair with a soft matte for hair.",
          source_ids=["open.sam3"]),
    local("open.remove_background", "BiRefNet (core RemoveBackground)", "ZhengPeng7", ["matte"], "birefnet_core",
          ["LoadBackgroundRemovalModel", "RemoveBackground", "InvertMask", "JoinImageWithAlpha"],
          [{"role": "bg_model", "folder": "background_removal", "any": ["birefnet.safetensors"]}],
          "BiRefNet MIT", source_ids=["open.remove_background"]),
    local("custom.rmbg_rmbg2", "RMBG-2.0 (ComfyUI-RMBG)", "BRIA / 1038lab", ["matte"], "rmbg_pack",
          ["RMBG"], [], "CC BY-NC 4.0 (Bria) — NON-COMMERCIAL; commercial via Bria API", kind="custom_node",
          auto_download=True, variant="RMBG-2.0", source_ids=["custom.rmbg_rmbg2"]),
    local("custom.rmbg_ben2", "BEN2 (ComfyUI-RMBG)", "PramaLLC / 1038lab", ["matte"], "rmbg_pack",
          ["RMBG"], [], "MIT (BEN2 weights)", kind="custom_node", auto_download=True, variant="BEN2",
          source_ids=["custom.rmbg_ben2"]),
    local("custom.rmbg_birefnet", "BiRefNet HR matting (ComfyUI-RMBG)", "ZhengPeng7 / 1038lab", ["matte"],
          "birefnet_pack", ["BiRefNetRMBG"], [], "MIT", kind="custom_node", auto_download=True,
          variant="BiRefNet-matting",
          source_ids=["custom.rmbg_birefnet_family"]),
    local("open.ltx25_ic_alpha_gen", "LTX-2.5 Alpha-Gen (soft video matte)", "Lightricks", ["matte"], "ltx_alpha_gen",
          LTX_IC_CLASSES + ["ImageToMask", "InvertMask", "JoinImageWithAlpha"],
          LTX_BASE_WEIGHTS + [{"role": "ic_lora", "folder": "loras",
                               "any": ["ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors"]}],
          LTX_LICENSE, notes="Soft alpha for hair/smoke/glass. Picks 'the foreground' itself (no prompt). "
                             "≤121 frames, 8n+1. Single-stage distilled IC-LoRA at 544p. Needs ComfyUI-LTXVideo.",
          source_ids=["open.ltx25_ic_alpha_gen"]),
    partner("api.veed_remove_bg", "VEED Remove Video Background", "VEED", ["matte"], "veed_rmbg",
            ["VeedRemoveVideoBackgroundNode", "CreateVideo"], variant="standard",
            source_ids=["api.VeedRemoveVideoBackgroundNode"]),
    partner("api.bria_transparent_video", "Bria Transparent Video", "Bria", ["matte"], "bria_transparent",
            ["BriaTransparentVideoBackground", "CreateVideo"], source_ids=["api.BriaTransparentVideoBackground"]),

    # ---------------- clean_plate ----------------------------------------------------------------
    local("open.ltx25_ic_clean_plate", "LTX-2.5 Clean-Plate IC-LoRA", "Lightricks", ["clean_plate"], "ltx_clean_plate",
          LTX_IC_CLASSES,
          LTX_BASE_WEIGHTS + [{"role": "ic_lora", "folder": "loras",
                               "any": ["ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors"]}],
          LTX_LICENSE, notes="Removes ALL people/moving subjects (no per-object choice). prompt = the empty "
                             "scene. Fails when the subject fills most of the frame. Single-stage at 544p. "
                             "Needs ComfyUI-LTXVideo. Not yet run on the pod.",
          source_ids=["open.ltx25_ic_clean_plate"]),
    partner("api.bria_video_eraser", "Bria Video Eraser", "Bria", ["clean_plate"], "bria_video_eraser",
            ["BriaVideoEraser", "CreateVideo", "GetVideoComponents"], notes="Uses the mask input when connected.",
            source_ids=["api.BriaVideoEraser"]),
    partner("api.kling_4_0_edit", "Kling 4.0 Edit (remove by prompt)", "Kling", ["clean_plate"], "kling4_edit",
            ["Kling4EditVideoNode", "CreateVideo", "GetVideoComponents"], variant="kling-4.0",
            params=res(["720p", "1080p"], "1080p"), source_ids=["api.Kling4EditVideoNode"]),
    partner("api.runway_aleph2", "Runway Aleph 2 (remove by prompt)", "Runway", ["clean_plate"], "runway_aleph2",
            ["RunwayAleph2VideoToVideoNode", "CreateVideo", "GetVideoComponents"],
            source_ids=["api.RunwayAleph2VideoToVideoNode"]),
]

# research stage -> soundstage stage, for the catalogue
RESEARCH_STAGE_MAP = {
    "previz_image": "generate_image", "keyframe_image": "generate_image",
    "image_edit": "edit_image", "reshoot_angle": None,  # decided per entry below
    "shot_video": "generate_video", "extend_video": "generate_video", "video_swap": "generate_video",
    "layers_matte": None, "dialogue_lipsync": None, "upscale_finish": None,
}
VIDEO_STAGES = {"shot_video", "extend_video", "video_swap", "dialogue_lipsync"}
MATTE_CAPS = {"matte", "matte_video", "matte_image", "matte_video_per_frame", "soft_alpha", "alpha_out",
              "green_screen", "layers", "rgba_gen_image", "rgba_gen_video", "decompose_video"}
PLATE_CAPS = {"clean_plate", "object_removal_video", "inpaint_video", "removes_shadows_reflections"}
KIND_MAP = {"partner_node": "partner", "comfy_cloud_node": "cloud", "native_open_weights": "local",
            "custom_node": "custom_node", "python_only": "python_only", "external_api": "external_api"}


def catalogue_stages(e):
    out = set()
    for s in e.get("stages", []):
        if RESEARCH_STAGE_MAP.get(s):
            out.add(RESEARCH_STAGE_MAP[s])
        elif s == "reshoot_angle":
            out.add("generate_video" if VIDEO_STAGES & set(e["stages"]) else "edit_image")
        elif s == "layers_matte":
            caps = set(e.get("capabilities", []))
            if caps & MATTE_CAPS:
                out.add("matte")
            if caps & PLATE_CAPS:
                out.add("clean_plate")
    return sorted(out)


def clean_name(n):
    return re.sub(r"\s+—\s+local$", "", n).strip()


# Soundstage never routes to Higgsfield's own API: we are the open alternative to it (Mike, 2026-10-28).
EXCLUDED_PROVIDERS = ("higgsfield",)


def excluded(e):
    blob = " ".join(str(e.get(k, "")) for k in ("id", "provider", "node_class", "display_name")).lower()
    return any(x in blob for x in EXCLUDED_PROVIDERS)


def build(research_dir):
    wired_sources = {s for w in WIRED for s in w["source_ids"]}
    catalogue = []
    for fname in ("10_model_registry.json", "12_layers_registry.json"):
        for e in json.load(open(os.path.join(research_dir, fname))):
            if e["id"] in wired_sources or e.get("deprecated") or excluded(e):
                continue
            stages = catalogue_stages(e)
            if not stages:
                continue
            catalogue.append({
                "id": e["id"], "name": clean_name(e["display_name"]), "provider": e["provider"],
                "kind": KIND_MAP.get(e["kind"], e["kind"]), "stages": stages, "adapter": None,
                "variant": None, "classes": [e["node_class"]] if e["kind"] in ("partner_node", "comfy_cloud_node") else [],
                "weights": [], "params": {}, "license": e.get("license", ""), "notes": e.get("notes", ""),
                "source_ids": [e["id"]], "source_url": e.get("source_url", ""),
            })
    return {"version": 1, "stages": STAGES, "models": WIRED + catalogue}


def write_docs(reg, path):
    from .registry import badges_for, label_for  # local import: build runs as a module
    lines = ["# Soundstage model router",
             "",
             "One picker node per stage. Each dropdown lists only the models valid for that stage that are "
             "actually runnable on this install: partner nodes must be loaded (not `--disable-partner-nodes`), "
             "local models need their weight files. Set `SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1` to hide every paid option.",
             "",
             "Badges in the label: **API** = paid partner/cloud node (your Comfy credits), **NC** = non-commercial "
             "licence, **<$1M / <$5M / <$10M / <$20M** = free only below that annual revenue, **GEO** = territory "
             "restricted, **DL** = the node pack downloads its weights on first run.",
             "",
             "The selected model is expanded into its real backend nodes at run time (node expansion), so partner "
             "nodes keep their sign-in/credit context and local models run their official template graph.",
             "",
             "Regenerate this file and `soundstage/router/registry.json` with "
             "`python -m soundstage.router.build_registry --research ../research`.",
             ""]
    node_names = {"generate_image": "SoundstageGenerateImage", "edit_image": "SoundstageEditImage",
                  "generate_video": "SoundstageGenerateVideo", "matte": "SoundstageMatte",
                  "clean_plate": "SoundstageCleanPlate"}
    for stage, title in reg["stages"].items():
        lines += [f"## {title} — `{node_names[stage]}`", "", "| Dropdown label | Kind | Licence | Notes |",
                  "|---|---|---|---|"]
        for m in reg["models"]:
            if m["adapter"] and stage in m["stages"]:
                note = m["notes"].replace("|", "/").replace("\n", " ")
                lines.append(f"| {label_for(m)} | {m['kind']} | {m['license'][:120]} | {note} |")
        lines.append("")
    lines += ["## Catalogue — known models not wired yet", "",
              "From research/10 and research/12. These never appear in a dropdown until an adapter is written.", ""]
    for stage, title in reg["stages"].items():
        cat = [m for m in reg["models"] if not m["adapter"] and stage in m["stages"]]
        lines += [f"### {title} ({len(cat)})", ""]
        for m in cat:
            b = badges_for(m)
            lines.append(f"- {m['name']} · {m['provider']} ({m['kind']})" + (f" [{' '.join(b)}]" if b else ""))
        lines.append("")
    with open(path, "w") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--research", default=os.path.join(os.path.dirname(REPO), "research"))
    a = ap.parse_args()
    reg = build(a.research)
    with open(os.path.join(HERE, "registry.json"), "w") as f:
        json.dump(reg, f, indent=1, ensure_ascii=False)
    write_docs(reg, os.path.join(REPO, "docs", "router.md"))
    wired = sum(1 for m in reg["models"] if m["adapter"])
    print(f"registry.json: {len(reg['models'])} models ({wired} wired); docs/router.md written")


if __name__ == "__main__":
    main()
