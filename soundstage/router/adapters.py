"""Per-model subgraph builders for the stage routers.

Each adapter takes (g, m, p): a GraphBuilder, the registry entry and the unified parameters, and
returns a dict of output links, e.g. {"image": link}, {"video": link}, {"images": link, "mask": link}.
Media in p (first, last, control, refs, image, images, mask) are raw links [node_id, slot] forwarded
from the router's own inputs, so the backend nodes pull them straight from the user's graph.

Partner adapters emit Comfy's own partner nodes (auth, upload, polling and billing stay theirs).
Local adapters rebuild the official template graphs (sources noted per adapter). Input keys and
combo values are checked against a live /object_info snapshot in tests/test_router_adapters.py.

p keys: stage, prompt, negative, sound, music, line, seed, width, height, frames, fps, first, last, control, refs (list),
image, images, mask, params (the chosen option's nested widgets), weights {role: file|None}, variant.
"""
import math


class RouterError(ValueError):
    """User-facing: shown in the ComfyUI error dialog as is."""


# ---------------------------------------------------------------- helpers

def _ratio(s):
    a, b = s.replace(":", " ").split()
    return float(a) / float(b)


def snap_aspect(width, height, options):
    """Closest 'W:H' option (log distance) to width/height; ignores 'auto'/'adaptive'/'Custom'."""
    target = math.log(width / height)
    best, err = None, 1e9
    for o in options:
        if not isinstance(o, str) or ":" not in o:
            continue
        e = abs(math.log(_ratio(o)) - target)
        if e < err:
            best, err = o, e
    return best


def snap_duration(seconds, spec):
    """Shortest allowed duration that still covers `seconds` (else the longest)."""
    if "options" in spec:
        opts = sorted(spec["options"])
        for o in opts:
            if o >= seconds - 0.01:
                return o
        return opts[-1]
    return max(spec["min"], min(spec["max"], int(math.ceil(seconds - 0.01))))


def seconds(p):
    return p["frames"] / max(p["fps"], 1e-6)


def wh(p):
    """Requested size, with a 16:9 fallback when the edit node is left at 0 x 0 (keep input size)."""
    return (p["width"] or 1920, p["height"] or 1088)


def seed31(p):
    return int(p["seed"]) % 2147483647


def ltx_frames(n):
    """LTX wants 8n+1 frames."""
    return max(9, int(round((n - 1) / 8.0)) * 8 + 1)


def snap(v, m):
    return max(m, int(round(v / m)) * m)


def need(p, key, model_name, what):
    if p.get(key) is None:
        raise RouterError(f"{model_name} needs {what}. Connect it, or pick another model.")
    return p[key]


def resize(g, link, w, h, crop="center", method="lanczos"):
    return g.node("ResizeImageMaskNode", input=link, scale_method=method,
                  **{"resize_type": "scale dimensions", "resize_type.width": int(w),
                     "resize_type.height": int(h), "resize_type.crop": crop}).out(0)


def to_video(g, images, fps):
    return g.node("CreateVideo", images=images, fps=float(fps)).out(0)


def frames_of(g, video):
    return g.node("GetVideoComponents", video=video).out(0)


def cutout(g, images, mask):
    """RGBA foreground from a subject mask (1 = keep). Core convention: alpha input is inverted."""
    inv = g.node("InvertMask", mask=mask).out(0)
    return g.node("JoinImageWithAlpha", image=images, alpha=inv).out(0)


def refs_or_first(p):
    refs = list(p.get("refs") or [])
    return refs if refs else ([p["first"]] if p.get("first") is not None else [])


# ---------------------------------------------------------------- partner: images

def nano_banana(g, m, p):
    edit = p["stage"] == "edit_image"
    images = ([p["image"]] if edit else []) + list(p.get("refs") or [])
    kw = {"prompt": p["prompt"], "seed": int(p["seed"]), "response_modalities": "IMAGE",
          "model": m["variant"], "model.resolution": p["params"].get("resolution", "2K"),
          "model.aspect_ratio": "auto" if edit else (snap_aspect(p["width"], p["height"], NB_ASPECTS) or "auto"),
          "model.thinking_level": "MINIMAL"}
    for i, link in enumerate(images[:14], 1):
        kw[f"model.images.image_{i}"] = link
    return {"image": g.node("GeminiNanoBanana2V2", **kw).out(0)}


NB_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
GPT_SIZES = ["1024x1024", "1024x1536", "1536x1024", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"]


def gpt_image(g, m, p):
    edit = p["stage"] == "edit_image"
    images = ([p["image"]] if edit else []) + list(p.get("refs") or [])
    sizes = {s: f"{s.split('x')[0]}:{s.split('x')[1]}" for s in GPT_SIZES}
    want = snap_aspect(*wh(p), list(sizes.values()))
    # largest preset of the wanted aspect that does not exceed the requested pixel count by much
    cands = sorted((s for s, r in sizes.items() if r == want), key=lambda s: int(s.split("x")[0]) * int(s.split("x")[1]))
    size = cands[0]
    for s in cands:
        if int(s.split("x")[0]) * int(s.split("x")[1]) <= wh(p)[0] * wh(p)[1] * 1.3:
            size = s
    kw = {"prompt": p["prompt"], "n": 1, "seed": seed31(p), "model": m["variant"],
          "model.size": "auto" if edit else size, "model.custom_width": 1024, "model.custom_height": 1024,
          "model.background": "auto", "model.quality": p["params"].get("quality", "medium")}
    for i, link in enumerate(images[:16], 1):
        kw[f"model.images.image_{i}"] = link
    if edit and p.get("mask") is not None:
        kw["model.mask"] = p["mask"]
    return {"image": g.node("OpenAIGPTImageNodeV2", **kw).out(0)}


FLUX3_ASPECTS = ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"]


def flux3_api(g, m, p):
    edit = p["stage"] == "edit_image"
    images = ([p["image"]] if edit else []) + list(p.get("refs") or [])
    kw = {"prompt": p["prompt"], "resolution": p["params"].get("resolution", "2K"),
          "aspect_ratio": "auto" if edit else snap_aspect(p["width"], p["height"], FLUX3_ASPECTS),
          "grounding": True, "safety_tolerance": 2, "seed": int(p["seed"]) % 4294967295}
    for i, link in enumerate(images[:10], 1):
        kw[f"images.image_{i}"] = link
    return {"image": g.node("Flux3ImageNode", **kw).out(0)}


SEEDREAM_2K = {
    "seedream 5.0 pro": ["2048x2048 (1:1)", "1728x2304 (3:4)", "2304x1728 (4:3)", "2848x1600 (16:9)",
                         "1600x2848 (9:16)", "1664x2496 (2:3)", "2496x1664 (3:2)", "3136x1344 (21:9)"],
    "seedream 5.0 flash": ["2048x2048 (1:1)", "1776x2368 (3:4)", "2368x1776 (4:3)", "2816x1584 (16:9)",
                           "1584x2816 (9:16)", "1664x2496 (2:3)", "2496x1664 (3:2)", "3136x1344 (21:9)"],
}


def seedream(g, m, p):
    edit = p["stage"] == "edit_image"
    images = ([p["image"]] if edit else []) + list(p.get("refs") or [])
    presets = SEEDREAM_2K[m["variant"]]
    want = snap_aspect(*wh(p), [s.split("(")[1].rstrip(")") for s in presets])
    preset = next(s for s in presets if s.endswith(f"({want})"))
    w, h = preset.split()[0].split("x")
    kw = {"prompt": p["prompt"], "model": m["variant"], "model.size_preset": f"(2K) {preset}",
          "model.width": int(w), "model.height": int(h), "model.seed": seed31(p), "model.watermark": False}
    if m["variant"] == "seedream 5.0 pro":
        kw["model.prompt_optimization"] = "standard"
        kw["model.thinking"] = True
    for i, link in enumerate(images[:10], 1):
        kw[f"model.images.image_{i}"] = link
    return {"image": g.node("ByteDanceSeedreamNodeV3", **kw).out(0)}


KREA_API_ASPECTS = ["1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "2:3", "9:16"]


def krea2_api(g, m, p):
    kw = {"prompt": p["prompt"], "seed": seed31(p), "model": m["variant"],
          "model.aspect_ratio": snap_aspect(p["width"], p["height"], KREA_API_ASPECTS),
          "model.resolution": "1K", "model.creativity": "medium", "model.moodboard_id": "",
          "model.moodboard_strength": 0.35}
    return {"image": g.node("Krea2ImageNode", **kw).out(0)}


def z_image_cloud(g, m, p):
    aspects = ["1:1", "3:4", "2:3", "3:2", "4:3", "16:9", "9:16", "21:9"]
    mp = max(0.1, min(16.0, round(p["width"] * p["height"] / 1e6, 2)))
    return {"image": g.node("ComfyCloudZImageTurboNode", prompt=p["prompt"], seed=int(p["seed"]),
                            aspect_ratio=snap_aspect(p["width"], p["height"], aspects), megapixels=mp).out(0)}


# ---------------------------------------------------------------- partner: video

def kling4(g, m, p):
    dur = snap_duration(seconds(p), m["params"]["duration"])
    base = {"model": m["variant"], "model.prompt": p["prompt"], "model.seed": seed31(p),
            "model.resolution": p["params"].get("resolution", "1080p"), "model.duration": dur}
    aspect = snap_aspect(p["width"], p["height"], ["16:9", "9:16", "1:1", "21:9"])
    if p.get("refs"):
        kw = dict(base, **{"model.aspect_ratio": "adaptive" if p.get("first") is not None else aspect})
        for i, link in enumerate(p["refs"][:10], 1):
            kw[f"model.reference_images.image_{i}"] = link
        for k in ("first", "last"):
            if p.get(k) is not None:
                kw[f"model.{k}_frame"] = p[k]
        return {"video": g.node("Kling4ReferenceToVideoNode", **kw).out(0)}
    if p.get("first") is not None or p.get("last") is not None:
        kw = dict(base)
        for k in ("first", "last"):
            if p.get(k) is not None:
                kw[f"model.{k}_frame"] = p[k]
        return {"video": g.node("Kling4ImageToVideoNode", **kw).out(0)}
    return {"video": g.node("Kling4TextToVideoNode", **dict(base, **{"model.aspect_ratio": aspect})).out(0)}


def veo3(g, m, p):
    dur = snap_duration(seconds(p), m["params"]["duration"])
    aspect = "9:16" if p["height"] > p["width"] else "16:9"
    common = {"prompt": p["prompt"], "negative_prompt": p.get("negative") or "", "aspect_ratio": aspect,
              "resolution": p["params"].get("resolution", "1080p"), "seed": int(p["seed"]) % 4294967295,
              "model": m["variant"], "generate_audio": True}
    if p.get("first") is not None and p.get("last") is not None:
        return {"video": g.node("Veo3FirstLastFrameNode", duration=dur, first_frame=p["first"],
                                last_frame=p["last"], **common).out(0)}
    if p.get("last") is not None:
        raise RouterError("Veo 3.1 takes a last frame only together with a first frame.")
    kw = dict(common, duration_seconds=dur, enhance_prompt=False, person_generation="ALLOW")
    if p.get("first") is not None:
        kw["image"] = p["first"]
    return {"video": g.node("Veo3VideoGenerationNode", **kw).out(0)}


SEEDANCE_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]


def seedance2(g, m, p):
    v = m["variant"]
    kw = {"model": v, "model.prompt": p["prompt"], "model.resolution": p["params"].get("resolution", "720p"),
          "model.duration": snap_duration(seconds(p), m["params"]["duration"]), "model.generate_audio": True,
          "seed": seed31(p), "watermark": False}
    if v.startswith("Seedance 2.5"):
        kw["model.output_format"] = "mp4"
    if p.get("first") is not None or p.get("last") is not None:
        if not v.startswith("Seedance 2.5"):
            kw["model.ratio"] = "adaptive"
        if p.get("first") is not None:
            kw["first_frame"] = p["first"]
        if p.get("last") is not None:
            kw["last_frame"] = p["last"]
        return {"video": g.node("ByteDance2FirstLastFrameNode", **kw).out(0)}
    kw["model.ratio"] = snap_aspect(p["width"], p["height"], SEEDANCE_RATIOS)
    return {"video": g.node("ByteDance2TextToVideoNode", **kw).out(0)}


def minimax_h3(g, m, p):
    v = m["variant"]
    kw = {"model": v, "model.prompt": p["prompt"],
          "model.resolution": p["params"].get("resolution") or m["params"]["resolution"]["default"],
          "model.duration": snap_duration(seconds(p), m["params"]["duration"]),
          "seed": int(p["seed"]) % 4294967295, "watermark": False}
    if v != "MiniMax H3":
        kw["model.prompt_expansion_mode"] = "balanced"
    if p.get("first") is not None:
        kw["first_frame"] = p["first"]
        if p.get("last") is not None:
            kw["last_frame"] = p["last"]
        return {"video": g.node("MinimaxHailuo03FirstLastFrameNode", **kw).out(0)}
    if p.get("last") is not None:
        raise RouterError("MiniMax H3 takes a last frame only together with a first frame.")
    kw["model.ratio"] = snap_aspect(p["width"], p["height"], SEEDANCE_RATIOS)
    return {"video": g.node("MinimaxHailuo03TextToVideoNode", **kw).out(0)}


RUNWAY_RATIOS = {"1280:720": "16:9", "720:1280": "9:16", "1104:832": "4:3", "832:1104": "3:4",
                 "960:960": "1:1", "1584:672": "33:14"}


def runway_gen4(g, m, p):
    first = need(p, "first", "Runway Gen-4", "a first_frame")
    want = snap_aspect(p["width"], p["height"], list(RUNWAY_RATIOS.values()))
    ratio = next(k for k, v in RUNWAY_RATIOS.items() if v == want)
    return {"video": g.node("RunwayImageToVideoNodeGen4", prompt=p["prompt"], start_frame=first,
                            duration=snap_duration(seconds(p), m["params"]["duration"]), ratio=ratio,
                            seed=int(p["seed"]) % 4294967295).out(0)}


def luma_ray32(g, m, p):
    common = {"prompt": p["prompt"], "resolution": p["params"].get("resolution", "1080p"), "loop": False,
              "seed": int(p["seed"])}
    if p.get("first") is not None or p.get("last") is not None:
        kw = dict(common)
        if p.get("first") is not None:
            kw["start_frame"] = p["first"]
        if p.get("last") is not None:
            kw["end_frame"] = p["last"]
        return {"video": g.node("LumaRay32ImageToVideoNode", **kw).out(0)}
    return {"video": g.node("LumaRay32TextToVideoNode", duration="10s" if seconds(p) > 5.05 else "5s",
                            aspect_ratio=snap_aspect(p["width"], p["height"], ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
                            **common).out(0)}


LTX_API_RES = {"LTX-2.5 (Fast)": ["1280x720", "720x1280", "1920x1080", "1080x1920", "2560x1440", "1440x2560",
                                  "3840x2160", "2160x3840"],
               "LTX-2.5 (Pro)": ["1280x720", "720x1280", "1920x1080", "1080x1920"]}


def ltx25_api(g, m, p):
    v = m["variant"]
    opts = LTX_API_RES[v]
    portrait = p["height"] > p["width"]
    cands = [r for r in opts if (int(r.split("x")[1]) > int(r.split("x")[0])) == portrait]
    resolution = min(cands, key=lambda r: abs(int(r.split("x")[0]) * int(r.split("x")[1]) - p["width"] * p["height"]))
    kw = {"prompt": p["prompt"], "seed": int(p["seed"]) % 4294967295, "model": v,
          "model.duration": str(snap_duration(seconds(p), m["params"]["duration"])),
          "model.resolution": resolution, "model.fps": "25", "model.generate_audio": True}
    if p.get("first") is not None:
        kw["image"] = p["first"]
        if p.get("last") is not None:
            kw["last_frame"] = p["last"]
        return {"video": g.node("LtxApi25ImageToVideo", **kw).out(0)}
    return {"video": g.node("LtxApi25TextToVideo", **kw).out(0)}


# ---------------------------------------------------------------- partner: matte / clean plate

def veed_rmbg(g, m, p):
    images = need(p, "images", "VEED", "images")
    n = g.node("VeedRemoveVideoBackgroundNode", **{"model": m["variant"], "model.video": to_video(g, images, p["fps"]),
                                                   "model.refine_foreground_edges": True,
                                                   "model.subject_is_person": True})
    return {"images": n.out(0), "mask": n.out(1)}


def bria_transparent(g, m, p):
    images = need(p, "images", "Bria", "images")
    n = g.node("BriaTransparentVideoBackground", video=to_video(g, images, p["fps"]), seed=seed31(p))
    return {"images": n.out(0), "mask": n.out(1)}


def bria_video_eraser(g, m, p):
    images = need(p, "images", "Bria Video Eraser", "images")
    kw = {"video": to_video(g, images, p["fps"]), "preserve_audio": False}
    if p.get("mask") is not None:
        kw["mask"] = p["mask"]
    return {"images": frames_of(g, g.node("BriaVideoEraser", **kw).out(0))}


def kling4_edit(g, m, p):
    images = need(p, "images", "Kling 4.0 Edit", "images")
    v = g.node("Kling4EditVideoNode", **{"model": m["variant"], "model.video_1": to_video(g, images, p["fps"]),
                                         "model.prompt": p["prompt"] or "Remove all people. Keep the empty set.",
                                         "model.resolution": p["params"].get("resolution", "1080p"),
                                         "model.aspect_ratio": "adaptive", "model.seed": seed31(p)}).out(0)
    return {"images": frames_of(g, v)}


def runway_aleph2(g, m, p):
    images = need(p, "images", "Runway Aleph 2", "images")
    v = g.node("RunwayAleph2VideoToVideoNode", prompt=p["prompt"] or "Remove all people. Keep the empty set.",
               video=to_video(g, images, p["fps"]), seed=int(p["seed"]) % 4294967295,
               public_figure_threshold="low").out(0)
    return {"images": frames_of(g, v)}


# ---------------------------------------------------------------- local: images

def _with_lora(g, model, p):
    """Apply the node's optional LoRA (character / product / style) to an image model."""
    if p.get("lora"):
        model = g.node("LoraLoaderModelOnly", model=model, lora_name=p["lora"],
                       strength_model=float(p.get("lora_strength", 1.0))).out(0)
    return model


def _loaders(g, w, clip_type):
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type=clip_type, device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    return unet, clip, vae


def _text(g, clip, prompt, negative=None):
    pos = g.node("CLIPTextEncode", text=prompt, clip=clip).out(0)
    neg = (g.node("CLIPTextEncode", text=negative, clip=clip).out(0) if negative
           else g.node("ConditioningZeroOut", conditioning=pos).out(0))
    return pos, neg


def krea2(g, m, p):
    """Krea 2 Turbo. Generate = template image_krea2_turbo_t2i; edit = Soundstage look-still recipe
    (img2img from the clay frame + Krea2 depth-control LoRA, docs/decisions.md 2026-10-27)."""
    w = p["weights"]
    model, clip, vae = _loaders(g, w, "krea2")
    model = _with_lora(g, model, p)
    pos, neg = _text(g, clip, p["prompt"], p.get("negative"))
    if p["stage"] == "edit_image":
        src = need(p, "image", "Krea 2 edit", "an image (e.g. the stage clay frame)")
        if p["width"] and p["height"]:
            src = resize(g, src, p["width"], p["height"])
        latent = g.node("VAEEncode", pixels=src, vae=vae).out(0)
        denoise = float(p["params"].get("denoise", 0.85))
    else:
        latent = g.node("EmptyLatentImage", width=snap(p["width"], 16), height=snap(p["height"], 16),
                        batch_size=1).out(0)
        denoise = 1.0
    if p.get("control") is not None:
        if not w.get("depth_lora"):
            raise RouterError("Krea 2 depth control needs krea2/cn/depth-control-lora.safetensors and the "
                              "comfyui-krea2-controlnet nodes. Disconnect control_image or install them.")
        model = g.node("Krea2ControlLoRALoader", model=model, lora_name=w["depth_lora"], strength=1.0).out(0)
        ctrl = g.node("Krea2ControlImageEncode", control_image=p["control"], vae=vae, latent=latent,
                      resize="match_latent_size", upscale_method="lanczos", crop="center",
                      channel_mode="grayscale", normalize="per_image_minmax", invert=False,
                      batch_mode="independent_images").out(0)
        model = g.node("Krea2ControlApply", model=model, control_latent=ctrl).out(0)
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=8, cfg=1.0, sampler_name="euler_ancestral",
               scheduler="beta", positive=pos, negative=neg, latent_image=latent, denoise=denoise).out(0)
    return {"image": g.node("VAEDecode", samples=s, vae=vae).out(0)}


def z_image(g, m, p):
    """Template image_z_image_turbo."""
    model, clip, vae = _loaders(g, p["weights"], "lumina2")
    pos, neg = _text(g, clip, p["prompt"])
    model = g.node("ModelSamplingAuraFlow", model=model, shift=3.0).out(0)
    latent = g.node("EmptySD3LatentImage", width=snap(p["width"], 16), height=snap(p["height"], 16),
                    batch_size=1).out(0)
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=8, cfg=1.0, sampler_name="res_multistep",
               scheduler="simple", positive=pos, negative=neg, latent_image=latent, denoise=1.0).out(0)
    return {"image": g.node("VAEDecode", samples=s, vae=vae).out(0)}


def flux3_klein(g, m, p):
    """Templates image_flux3_klein_distilled_t2i / _image_edit."""
    model, clip, vae = _loaders(g, p["weights"], "flux3")
    model = _with_lora(g, model, p)
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    images = ([need(p, "image", "FLUX 3 Klein edit", "an image")] if p["stage"] == "edit_image" else [])
    images += list(p.get("refs") or [])
    if images:
        kw = {"positive": pos, "negative": g.node("ConditioningZeroOut", conditioning=pos).out(0), "vae": vae,
              "resolution": "resize", "resolution.megapixels": round(max(0.25, p["width"] * p["height"] / 1e6), 2)
              if p["width"] and p["height"] else 1.0}
        for i, link in enumerate(images):
            kw[f"images.image{i}"] = link
        r = g.node("ReferenceMultiLatent", **kw)
        s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=16, cfg=1.0, sampler_name="euler",
                   scheduler="simple", positive=r.out(0), negative=r.out(1), latent_image=r.out(2), denoise=1.0).out(0)
    else:
        neg = g.node("CLIPTextEncode", text=p.get("negative") or "", clip=clip).out(0)
        latent = g.node("EmptyFlux2LatentImage", width=snap(p["width"], 16), height=snap(p["height"], 16),
                        batch_size=1).out(0)
        s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=15, cfg=1.0, sampler_name="er_sde",
                   scheduler="simple", positive=pos, negative=neg, latent_image=latent, denoise=1.0).out(0)
    return {"image": g.node("VAEDecode", samples=s, vae=vae).out(0)}


# ---------------------------------------------------------------- local: LTX-2.5

LTX_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
LTX_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly"


def _ltx_core(g, w, p, negative=None):
    model = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=negative if negative is not None else (p.get("negative") or LTX_NEGATIVE),
                 clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=float(p["fps"]))
    return model, vae, cond.out(0), cond.out(1)


def _sample(g, model, pos, neg, latent, seed, sigmas, guider="CFGGuider"):
    if guider == "CFGGuider":
        gd = g.node("CFGGuider", model=model, positive=pos, negative=neg, cfg=1.0).out(0)
    else:
        gd = g.node("LTXVDualCFGGuider", model=model, positive=pos, negative=neg, video_cfg=1.0, audio_cfg=1.0).out(0)
    return g.node("SamplerCustomAdvanced", noise=g.node("RandomNoise", noise_seed=int(seed)).out(0), guider=gd,
                  sampler=g.node("KSamplerSelect", sampler_name="euler_ancestral").out(0),
                  sigmas=g.node("ManualSigmas", sigmas=sigmas).out(0), latent_image=latent).out(0)


def _ic_guide(g, pos, neg, vae, latent, image, idx, ldf, crop):
    return g.node("LTXAddVideoICLoRAGuide", positive=pos, negative=neg, vae=vae, latent=latent, image=image,
                  frame_idx=idx, strength=1.0, latent_downscale_factor=ldf, crop=crop, use_tiled_encode=False,
                  tile_size=256, tile_overlap=64)


def ltx25(g, m, p):
    mode = p["params"].get("mode", "auto")
    if mode == "auto":
        mode = "layout → render" if p.get("control") is not None else "image/text → video"
    if mode == "layout → render":
        return ltx25_l2r(g, m, p)
    return ltx25_i2v(g, m, p)


def ltx25_i2v(g, m, p):
    """Template video_ltx2_5_i2v (two-stage distilled with audio); t2v when no first_frame."""
    w = p["weights"]
    W, H = snap(p["width"], 64), snap(p["height"], 64)
    frames = ltx_frames(p["frames"])
    model, vae, pos, neg = _ltx_core(g, w, p)
    audio_vae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)
    pre = None
    if p.get("first") is not None:
        pre = g.node("LTXVPreprocess", image=resize(g, p["first"], W, H), img_compression=18).out(0)
    lat = g.node("EmptyLTXVLatentVideo", width=W // 2, height=H // 2, length=frames, batch_size=1).out(0)
    if pre is not None:
        lat = g.node("LTXVImgToVideoInplace", vae=vae, image=pre, latent=lat, strength=0.7, bypass=False).out(0)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=frames, frame_rate=int(round(p["fps"])), batch_size=1,
                  audio_vae=audio_vae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=lat, audio_latent=alat).out(0)
    s1 = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, model, pos, neg, av, p["seed"], LTX_SIGMAS, "dual"))
    up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
    up = g.node("LTXVLatentUpsampler", samples=s1.out(0), upscale_model=up_model, vae=vae).out(0)
    if pre is not None:
        up = g.node("LTXVImgToVideoInplace", vae=vae, image=pre, latent=up, strength=1.0, bypass=False).out(0)
    av2 = g.node("LTXVConcatAVLatent", video_latent=up, audio_latent=s1.out(1)).out(0)
    s2 = g.node("LTXVSeparateAVLatent",
                av_latent=_sample(g, model, pos, neg, av2, p["seed"], "0.85, 0.7250, 0.4219, 0.0", "dual"))
    images = g.node("VAEDecodeTiled", samples=s2.out(0), vae=vae, tile_size=512, overlap=64, temporal_size=64,
                    temporal_overlap=16).out(0)
    audio = g.node("LTXVAudioVAEDecode", samples=s2.out(1), audio_vae=audio_vae).out(0)
    return {"video": g.node("CreateVideo", images=images, fps=float(p["fps"]), audio=audio).out(0)}


def ltx25_l2r(g, m, p):
    """Official LTX-2.5 ICLoRA Layout-To-Render two-stage distilled, as wired in Soundstage_Shot_v2_ladder:
    stage clay video guides every frame, the look still (first_frame) rides along at frame_idx -1."""
    w = p["weights"]
    control = need(p, "control", "LTX-2.5 Layout-to-Render", "a control_video (the stage clay pass)")
    if not w.get("l2r_lora"):
        raise RouterError("Layout-to-Render needs the ComfyUI-LTXVideo nodes and "
                          "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors in loras.")
    W, H = snap(p["width"], 64), snap(p["height"], 64)
    frames = ltx_frames(p["frames"])
    base, vae, pos, neg = _ltx_core(g, w, p)
    lora = g.node("LTXICLoRALoaderModelOnly", model=base, lora_name=w["l2r_lora"], strength_model=1.0)
    model, ldf = lora.out(0), lora.out(1)
    ctrl = resize(g, control, W // 2, H // 2)
    lat = g.node("EmptyLTXVLatentVideo", width=W // 2, height=H // 2, length=frames, batch_size=1).out(0)
    gd = _ic_guide(g, pos, neg, vae, lat, ctrl, 0, ldf, "disabled")
    if p.get("first") is not None:
        gd = _ic_guide(g, gd.out(0), gd.out(1), vae, gd.out(2), p["first"], -1, ldf, "center")
    s1 = _sample(g, model, gd.out(0), gd.out(1), gd.out(2), p["seed"], LTX_SIGMAS)
    c1 = g.node("LTXVCropGuides", positive=gd.out(0), negative=gd.out(1), latent=s1)
    up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
    up = g.node("LTXVLatentUpsampler", samples=c1.out(2), upscale_model=up_model, vae=vae).out(0)
    hd = _ic_guide(g, pos, neg, vae, up, ctrl, 0, 1.0, "disabled")
    if p.get("first") is not None:
        hd = _ic_guide(g, hd.out(0), hd.out(1), vae, hd.out(2), p["first"], -1, 1.0, "center")
    s2 = _sample(g, model, hd.out(0), hd.out(1), hd.out(2), p["seed"], "0.909375, 0.725, 0.421875, 0.0")
    c2 = g.node("LTXVCropGuides", positive=hd.out(0), negative=hd.out(1), latent=s2)
    images = g.node("VAEDecodeTiled", samples=c2.out(2), vae=vae, tile_size=512, overlap=64, temporal_size=128,
                    temporal_overlap=32).out(0)
    return {"video": g.node("CreateVideo", images=images, fps=float(p["fps"])).out(0)}


def _ltx_ic_v2v(g, p, lora_file, prompt, negative):
    """Single-stage distilled IC-LoRA video-to-video at 544p (LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled),
    video latent only. Returns frames resized back to the source size."""
    w = p["weights"]
    src = p["images"]
    small = g.node("ResizeImageMaskNode", input=src, scale_method="lanczos",
                   **{"resize_type": "scale shorter dimension", "resize_type.shorter_size": 544}).out(0)
    small = g.node("ResizeImageMaskNode", input=small, scale_method="lanczos",
                   **{"resize_type": "scale to multiple", "resize_type.multiple": 32}).out(0)
    size = g.node("GetImageSize", image=small)
    q = dict(p, prompt=prompt)
    base, vae, pos, neg = _ltx_core(g, w, q, negative=negative)
    lora = g.node("LTXICLoRALoaderModelOnly", model=base, lora_name=lora_file, strength_model=1.0)
    lat = g.node("EmptyLTXVLatentVideo", width=size.out(0), height=size.out(1), length=size.out(2), batch_size=1).out(0)
    gd = _ic_guide(g, pos, neg, vae, lat, small, 0, lora.out(1), "disabled")
    s = _sample(g, lora.out(0), gd.out(0), gd.out(1), gd.out(2), p["seed"], LTX_SIGMAS)
    c = g.node("LTXVCropGuides", positive=gd.out(0), negative=gd.out(1), latent=s)
    out = g.node("VAEDecodeTiled", samples=c.out(2), vae=vae, tile_size=512, overlap=64, temporal_size=64,
                 temporal_overlap=8).out(0)
    return g.node("ResizeImageMaskNode", input=out, scale_method="lanczos",
                  **{"resize_type": "match size", "resize_type.match": src, "resize_type.crop": "disabled"}).out(0)


def ltx_alpha_gen(g, m, p):
    need(p, "images", "LTX Alpha-Gen", "images")
    gray = _ltx_ic_v2v(g, p, p["weights"]["ic_lora"], "", "")
    mask = g.node("ImageToMask", image=gray, channel="red").out(0)
    return {"images": cutout(g, p["images"], mask), "mask": mask}


def ltx_clean_plate(g, m, p):
    need(p, "images", "LTX Clean-Plate", "images")
    prompt = p["prompt"] or "The empty set, no people, nothing moving. Static background plate."
    negative = p.get("negative") or "people, person, actor, crowd, body, face, hands"
    return {"images": _ltx_ic_v2v(g, p, p["weights"]["ic_lora"], prompt, negative)}


# ---------------------------------------------------------------- local: Wan Animate 2

WAN_NEGATIVE = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，"
                "JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，"
                "形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走")


def wan_animate2(g, m, p):
    """Template video_wan_animate2_distilled, single 81-frame-style window (no context windows)."""
    control = need(p, "control", "Wan Animate 2", "a control_video (the driving performance)")
    refs = refs_or_first(p)
    if not refs:
        raise RouterError("Wan Animate 2 needs a character image on ref_1 (or first_frame).")
    w = p["weights"]
    W, H = snap(min(p["width"], 1280), 16), snap(min(p["height"], 1280), 16)
    if W * H > 1280 * 720:  # keep the 14B in its trained range
        k = math.sqrt(1280 * 720 / (W * H))
        W, H = snap(W * k, 16), snap(H * k, 16)
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="wan", device="default").out(0)
    cv = g.node("CLIPVisionLoader", clip_name=w["clip_vision"]).out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    pose = resize(g, control, W, H, method="area")
    ref = resize(g, refs[0], W, H, method="area")
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=p.get("negative") or WAN_NEGATIVE, clip=clip).out(0)
    pos_pose = g.node("CLIPTextEncode", text="a reference video of a person moving", clip=clip).out(0)
    cvo = g.node("CLIPVisionEncode", clip_vision=cv, image=ref, crop="none").out(0)
    first_pose = g.node("ImageFromBatch", image=pose, batch_index=0, length=1).out(0)
    cvo_pose = g.node("CLIPVisionEncode", clip_vision=cv, image=first_pose, crop="none").out(0)
    wa = g.node("WanAnimate2ToVideo", positive=pos, negative=neg, vae=vae, width=W, height=H, length=int(p["frames"]),
                batch_size=1, video_frame_offset=0, pose_strength=1.0, pose_start_percent=0.0, pose_end_percent=1.0,
                reference_image_strength=1.0, reference_image=ref, pose_video=pose, clip_vision_output=cvo,
                positive_pose=pos_pose, clip_vision_output_pose=cvo_pose)
    model = g.node("WanAnimate2Cache", model=unet, device="gpu", dtype="int8").out(0)
    sampling = g.node("ModelSamplingSD3", model=model, shift=5.0).out(0)
    sigmas = g.node("BasicScheduler", model=model, scheduler="simple", steps=10, denoise=1.0).out(0)
    s = g.node("SamplerCustom", model=sampling, add_noise=True, noise_seed=int(p["seed"]), cfg=1.0,
               positive=wa.out(0), negative=wa.out(1), sampler=g.node("KSamplerSelect", sampler_name="lcm").out(0),
               sigmas=sigmas, latent_image=wa.out(2)).out(0)
    trimmed = g.node("TrimVideoLatent", samples=s, trim_amount=wa.out(3)).out(0)
    images = g.node("VAEDecode", samples=trimmed, vae=vae).out(0)
    return {"video": to_video(g, images, p["fps"])}


# ---------------------------------------------------------------- local: MiniMax H3

H3_AREA = 1344 * 768        # H3's native 16:9 size; other aspects keep about this pixel count
H3_MAX_FRAMES = 362         # ~15 s at 24 fps, the trained ceiling
H3_CLAY_REF = "clay previz as <Video 1>"


def h3_length(frames):
    """H3 frame grid: 17k + 5 (5, 22, 39, ... 362), the smallest one that covers `frames`."""
    n = max(5, int(frames))
    return n + (5 - n % 17) % 17


def h3_size(width, height):
    r = (width or 1920) / float(height or 1088)
    h = math.sqrt(H3_AREA / r)
    return snap(h * r, 32), snap(h, 32)


H3_MAX_PICTURES = 9


def _h3_sound(p):
    sound = (p.get("sound") or "").strip() or "Natural diegetic sound of the action and the place, in sync with the picture."
    music = (p.get("music") or "").strip() or "N/A"
    return sound, music


def _h3_action(p):
    text = (p["prompt"] or "").strip()
    line = (p.get("line") or "").strip()
    if line:
        text += f" (S1) speaks in a natural voice, lips in sync: <d>[English] {line}</d>"
    return text


def _structured(text):
    return text.startswith(("For the target video", "How the reference pictures")) \
        or "integrated_multimodal_description:" in text or "subject_definitions:" in text


def h3_prompt(p, clay_ref=False):
    """Wrap the shot prompt in H3's structured form, picked from the media: I2VA (first frame), FL2VA (first +
    last), L2VA (last only), T2VA (none), or full-reference when there are reference images or the clay rides
    along as <Video 1>. An already structured prompt passes through untouched."""
    if _structured((p["prompt"] or "").strip()):
        return p["prompt"].strip()
    text, (sound, music) = _h3_action(p), _h3_sound(p)
    first, last, refs = p.get("first") is not None, p.get("last") is not None, list(p.get("refs") or [])
    dur = f"{seconds(p):.2f}"
    if refs or clay_ref:
        return _h3_reference_prompt(text, sound, music, first, last, len(refs), clay_ref, dur)
    if first and last:
        head = ("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the "
                f"0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the {dur}-second mark "
                "of the target video.\n\n")
    elif first:
        head = ("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully "
                "referenced.\n\n")
    elif last:
        head = ("How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with "
                f"the {dur}-second mark of the target video.\n\n")
    else:
        head = ""
    return (f"{head}integrated_multimodal_description: [Shot 1] {text}\n\n"
            f"overall_soundscape: {sound}\n\nnon_diegetic_music: {music}")


def _h3_reference_prompt(text, sound, music, first, last, n_refs, clay_ref, dur):
    pic, subj = 0, 0
    defs, keep, tasks, anchors = [], [], ["reference generation"], []
    if first or last:
        tasks.insert(0, "keyframe completion")
    world = None
    if first:
        pic += 1
        subj += 1
        world = f"<Picture {pic}>"
        defs.append(f"<Subject {subj}> is the world of <Picture {pic}>: its characters, wardrobe, props, set, "
                    "lighting and colour grade.")
        keep.append(f"<Subject {subj}>: partially_preserved")
        anchors.append(f"The shot opens exactly on <Picture {pic}> at 0.00 seconds.")
    if last:
        pic += 1
        world = world or f"<Picture {pic}>"
        anchors.append(f"It ends exactly on <Picture {pic}> at {dur} seconds.")
    for _ in range(n_refs):
        pic += 1
        subj += 1
        defs.append(f"<Subject {subj}> is the character, prop or element shown in <Picture {pic}>; its look, "
                    "shape and colours are kept exactly as they are. Only that subject comes from the picture, not "
                    "its background, framing or lighting.")
        keep.append(f"<Subject {subj}>: attribute_transfer")
    if clay_ref:
        subj += 1
        defs.append(f"<Subject {subj}> is the blocking in <Video 1>, an untextured grey clay previz: where each figure "
                    "stands and moves, the timing of every move and the camera's framing and motion. Only positions, "
                    "paths, timing and camera come from it; its grey clay surfaces, flat lighting and simple shapes "
                    "never appear.")
        keep.append(f"<Subject {subj}>: attribute_transfer")
    look = f"in the look of {world}" if world else "in a cinematic live-action look"
    summary = (f"[{' + '.join(tasks)}] A live-action shot {look}" +
               (", staged and framed as the clay blocking of <Video 1>" if clay_ref else "") +
               (", featuring the referenced subjects" if n_refs else "") + ".")
    body = " ".join([*anchors, text])
    return ("subject_definitions:\n" + "\n".join(defs) + "\n\n"
            f"summary:\n{summary}\n\n"
            "retention_analysis:\n" + "\n".join(keep) + "\n\n"
            f"detailed_description:\nCinematic live-action, {look[3:] if world else 'cinematic live-action look'}. "
            f"[Shot 1] {body}\n\n"
            f"overall_soundscape:\n{sound}\n\nnon_diegetic_music:\n{music}")


def minimax_h3_local(g, m, p):
    """MiniMax H3 local, after Comfy's video_minimax_h3_i2v / _r2v templates. Video and audio come out of one pass.
    - first / last frame (either or both): the fl2va model, MiniMaxH3ImageToVideo; the 8-step fl2v turbo LoRA when
      installed.
    - reference images (refs, up to 9 pictures in all) and/or motion_ref on (stage clay as <Video 1>): the ref2va
      model, MiniMaxH3ReferenceToVideo, with the first / last frames as the leading pictures."""
    w = p["weights"]
    if p["frames"] > H3_MAX_FRAMES:
        raise RouterError(f"MiniMax H3 renders at most {H3_MAX_FRAMES} frames (~15 s); this shot has "
                          f"{p['frames']}. Shorten it or use LTX-2.5.")
    clay_ref = p["params"].get("motion_ref") == H3_CLAY_REF
    refs = list(p.get("refs") or [])
    W, H = h3_size(p["width"], p["height"])
    length = h3_length(p["frames"])
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="minimax", device="cpu").out(0)  # 32B: keep off the GPU
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    audio_vae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)
    prompt = h3_prompt(p, clay_ref)
    if refs or clay_ref:
        pictures = [x for x in (p.get("first"), p.get("last")) if x is not None] + refs
        if len(pictures) > H3_MAX_PICTURES:
            raise RouterError(f"MiniMax H3 takes at most {H3_MAX_PICTURES} pictures (first + last frame + references); "
                              f"this shot has {len(pictures)}.")
        if not w.get("ref_unet"):
            raise RouterError("MiniMax H3 references need minimax_h3_ref2va_pruned_int8_convrot.safetensors "
                              "in diffusion_models.")
        model = g.node("UNETLoader", unet_name=w["ref_unet"], weight_dtype="default").out(0)
        kw = {"clip": clip, "prompt": prompt, "width": W, "height": H, "length": length, "ref_image_size": "match",
              "vae": vae, "audio_vae": audio_vae}
        for i, pic in enumerate(pictures):
            # first / last are frames of this shot: match its size; references keep their own framing
            kw[f"ref_images.ref_image_{i}"] = resize(g, pic, W, H) if i < len(pictures) - len(refs) else pic
        if clay_ref:
            control = need(p, "control", "MiniMax H3 with the clay reference", "a control_video (the stage clay pass)")
            if seconds(p) < 2.0:
                raise RouterError("MiniMax H3 takes a reference video of 2 s or more; this shot is shorter. "
                                  "Turn the clay reference off.")
            kw["ref_videos.ref_video_0"] = resize(g, control, W, H)
        cond = g.node("MiniMaxH3ReferenceToVideo", **kw)
        sampler, scheduler, steps = "res_multistep", "simple", 20
    else:
        model = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
        kw = {"clip": clip, "vae": vae, "prompt": prompt, "width": W, "height": H, "length": length}
        if p.get("first") is not None:
            kw["first_frame"] = resize(g, p["first"], W, H)
        if p.get("last") is not None:
            kw["last_frame"] = resize(g, p["last"], W, H)
        cond = g.node("MiniMaxH3ImageToVideo", **kw)
        if w.get("turbo_lora"):
            model = g.node("LoraLoaderModelOnly", model=model, lora_name=w["turbo_lora"], strength_model=1.0).out(0)
            sampler, scheduler, steps = "er_sde", "beta", 8
        else:
            sampler, scheduler, steps = "res_multistep", "simple", 20
    sigmas = g.node("BasicScheduler", model=model, scheduler=scheduler, steps=steps, denoise=1.0).out(0)
    guider = g.node("BasicGuider", model=model, conditioning=cond.out(0)).out(0)
    lat = g.node("SamplerCustomAdvanced", noise=g.node("RandomNoise", noise_seed=int(p["seed"])).out(0),
                 guider=guider, sampler=g.node("KSamplerSelect", sampler_name=sampler).out(0), sigmas=sigmas,
                 latent_image=cond.out(1)).out(0)
    images = g.node("VAEDecode", samples=lat, vae=vae).out(0)
    audio = g.node("VAEDecodeAudio", samples=lat, vae=audio_vae).out(0)
    # Back to the shot's own length and size, so the Cut, Ladder and Layer pack see what LTX would give them.
    images = g.node("ImageFromBatch", image=images, batch_index=0, length=int(p["frames"])).out(0)
    images = resize(g, images, p["width"] or W, p["height"] or H)
    audio = g.node("TrimAudioDuration", audio=audio, start_index=0.0, duration=float(seconds(p))).out(0)
    return {"video": g.node("CreateVideo", images=images, fps=float(p["fps"]), audio=audio).out(0)}

# ---------------------------------------------------------------- local: mattes

def sam3(g, m, p):
    """Templates utility_image_segment_sam3 / utility_video_segment_sam3 (per-frame detect)."""
    images = need(p, "images", "SAM 3", "images")
    ck = g.node("CheckpointLoaderSimple", ckpt_name=p["weights"]["checkpoint"])
    cond = g.node("CLIPTextEncode", text=p["prompt"] or "person", clip=ck.out(1)).out(0)
    mask = g.node("SAM3_Detect", model=ck.out(0), image=images, conditioning=cond,
                  threshold=float(p["params"].get("threshold", 0.5)), refine_iterations=2,
                  individual_masks=False).out(0)
    return {"images": cutout(g, images, mask), "mask": mask}


def birefnet_core(g, m, p):
    images = need(p, "images", "BiRefNet", "images")
    bg = g.node("LoadBackgroundRemovalModel", bg_removal_name=p["weights"]["bg_model"]).out(0)
    mask = g.node("RemoveBackground", bg_removal_model=bg, image=images).out(0)
    return {"images": cutout(g, images, mask), "mask": mask}


def rmbg_pack(g, m, p):
    images = need(p, "images", m["name"], "images")
    n = g.node("RMBG", image=images, model=m["variant"], sensitivity=1.0, process_res=1024, mask_blur=0,
               mask_offset=0, invert_output=False, refine_foreground=False, background="Alpha",
               background_color="#222222")
    return {"images": n.out(0), "mask": n.out(1)}


def birefnet_pack(g, m, p):
    images = need(p, "images", m["name"], "images")
    n = g.node("BiRefNetRMBG", image=images, model=m["variant"], sensitivity=1.0, mask_blur=0, mask_offset=0,
               invert_output=False, refine_foreground=False, background="Alpha", background_color="#222222")
    return {"images": n.out(0), "mask": n.out(1)}


ADAPTERS = {
    # images
    "krea2": krea2, "z_image": z_image, "flux3_klein": flux3_klein, "nano_banana": nano_banana,
    "gpt_image": gpt_image, "flux3_api": flux3_api, "seedream": seedream, "krea2_api": krea2_api,
    "z_image_cloud": z_image_cloud,
    # video
    "ltx25": ltx25, "wan_animate2": wan_animate2, "kling4": kling4, "veo3": veo3, "seedance2": seedance2,
    "minimax_h3": minimax_h3, "minimax_h3_local": minimax_h3_local, "runway_gen4": runway_gen4, "luma_ray32": luma_ray32, "ltx25_api": ltx25_api,
    # matte
    "sam3": sam3, "birefnet_core": birefnet_core, "rmbg_pack": rmbg_pack, "birefnet_pack": birefnet_pack,
    "ltx_alpha_gen": ltx_alpha_gen, "veed_rmbg": veed_rmbg, "bria_transparent": bria_transparent,
    # clean plate
    "ltx_clean_plate": ltx_clean_plate, "bria_video_eraser": bria_video_eraser, "kling4_edit": kling4_edit,
    "runway_aleph2": runway_aleph2,
}
