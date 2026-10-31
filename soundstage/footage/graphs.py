"""Expansion builders for Footage + Recast.

Every builder takes a GraphBuilder-like `g` (g.node(class, **inputs).out(i)) and raw links
[node_id, slot] for media, and returns links. Nothing here imports ComfyUI, so tests can check the
emitted graphs against a /object_info snapshot of the pod (tests/test_footage_object_info.json).

The LTX engine is the reference LTX-2.5 union-control swap graph
(LTX-2.5 ICLoRA union control + SAM3-gated DWPose + original-audio sampler), rebuilt node for node:
  reference video -> DWPose (body+face+hands) gated by the subject's SAM3 mask -> union-control IC-LoRA guide
  first frame (the character already standing in the shot) -> LTXVImgToVideoInplace
  original audio -> VAEEncodeAudio -> LTXVSetAudioRefTokens (frozen audio latent + audio-aware conditioning)
  8-step distilled stage 1 at ~544p -> crop guides -> x2 latent upsampler -> 3-step stage 2 -> tiled decode
plus the Stage-2 composite it never had (SoundstageRecastComposite: swapped subject over the real plate).
"""

# ------------------------------------------------------------------ weights

LTX_WEIGHTS = {
    "unet": ("diffusion_models", ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
                                  "ltx-2.5-22b-distilled-transformer-bf16.safetensors"]),
    "text_encoder": ("text_encoders", ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
                                       "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"]),
    "vae": ("vae", ["ltx-2.5-video-vae-conv-bf16.safetensors", "ltx-2.5-video-vae-bf16.safetensors"]),
    "audio_vae": ("vae", ["ltx-2.5-audio-vae-bf16.safetensors"]),
    "upscaler": ("latent_upscale_models", ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"]),
    "ic_lora": ("loras", ["ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"]),
}
KREA_WEIGHTS = {
    "unet": ("diffusion_models", ["Krea-2-Turbo.safetensors", "krea2_turbo_int8_convrot.safetensors",
                                  "krea2_turbo_fp8_scaled.safetensors"]),
    "text_encoder": ("text_encoders", ["qwen3vl_4b_fp8_scaled.safetensors"]),
    "vae": ("vae", ["qwen_image_vae.safetensors"]),
    "identity_lora": ("loras", ["krea2_identity_edit_v1_1.safetensors", "krea2_identity_edit_v1_2.safetensors"]),
}
SAM3_WEIGHTS = {"checkpoint": ("checkpoints", ["sam3.1_multiplex_fp16.safetensors", "sam3.safetensors"])}


def resolve(spec, list_files):
    """{role: filename or None}. Matches by basename so files in subfolders (ltxv/ltx2/...) are found."""
    out = {}
    for role, (folder, names) in spec.items():
        files = list_files(folder)
        hit = None
        for want in names:
            hit = next((f for f in files if f == want or f.replace("\\", "/").rsplit("/", 1)[-1] == want), None)
            if hit:
                break
        out[role] = hit
    return out


def missing(weights):
    return [r for r, f in weights.items() if not f]


# ------------------------------------------------------------------ small helpers

LTX_SIGMAS_STAGE1 = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
LTX_SIGMAS_STAGE2 = "0.85, 0.7250, 0.4219, 0.0"
LTX_NEGATIVE = ("pc game, console game, video game, cartoon, childish, ugly, blurry face, deformed hands, "
                "extra limbs, flicker")


def resize(g, link, mode, **kw):
    """ResizeImageMaskNode with its DynamicCombo flattened: resize(g, img, 'scale shorter dimension', shorter_size=544)."""
    inputs = {"input": link, "scale_method": kw.pop("scale_method", "lanczos"), "resize_type": mode}
    inputs.update({f"resize_type.{k}": v for k, v in kw.items()})
    return g.node("ResizeImageMaskNode", **inputs).out(0)


def sampler(g, model, pos, neg, latent, seed, sigmas, sampler_name):
    """the original 'Sampler' subgraphs: RandomNoise + CFGGuider(cfg 1) + ManualSigmas + SamplerCustomAdvanced."""
    s = g.node("SamplerCustomAdvanced",
               noise=g.node("RandomNoise", noise_seed=int(seed)).out(0),
               guider=g.node("CFGGuider", model=model, positive=pos, negative=neg, cfg=1.0).out(0),
               sampler=g.node("KSamplerSelect", sampler_name=sampler_name).out(0),
               sigmas=g.node("ManualSigmas", sigmas=sigmas).out(0),
               latent_image=latent).out(0)
    return g.node("LTXVSeparateAVLatent", av_latent=s)


# ------------------------------------------------------------------ footage tracking

def sam3_track(g, images, ckpt, prompt, threshold=0.5, max_objects=4, points=None, negative_points=None):
    """SAM 3.1 per-person tracks. Text-prompted (every `prompt` instance becomes a track) or seeded by
    click points on frame 0 (the clicked person becomes track 0; the text prompt still adds others)."""
    ck = g.node("CheckpointLoaderSimple", ckpt_name=ckpt)
    cond = g.node("CLIPTextEncode", text=prompt or "person", clip=ck.out(1)).out(0)
    kw = {}
    if points:
        f0 = g.node("ImageFromBatch", image=images, batch_index=0, length=1).out(0)
        det = {"model": ck.out(0), "image": f0, "threshold": float(threshold), "refine_iterations": 2,
               "individual_masks": False, "positive_coords": points}
        if negative_points:
            det["negative_coords"] = negative_points
        kw["initial_mask"] = g.node("SAM3_Detect", **det).out(0)
    track = g.node("SAM3_VideoTrack", images=images, model=ck.out(0), detection_threshold=float(threshold),
                   max_objects=int(max_objects), detect_interval=1, conditioning=cond, **kw).out(0)
    return track


def subject_silhouette(g, frames, ckpt, prompt, subject_mask, threshold=0.4, detect_interval=4):
    """The new subject's outline in the swap: SAM 3.1 tracks every person in the swap (detection every
    4th frame, ~6x faster than per-frame SAM3_Detect: 49 s vs 274 s for 97 frames at 1792x1024), then
    keeps only the ONE track that overlaps the original subject most. The engine can invent extra people
    next to the subject (seen on the test clip); a plain union of hits would paste them over the plate."""
    ck = g.node("CheckpointLoaderSimple", ckpt_name=ckpt)
    cond = g.node("CLIPTextEncode", text=prompt or "person", clip=ck.out(1)).out(0)
    track = g.node("SAM3_VideoTrack", images=frames, model=ck.out(0), detection_threshold=float(threshold),
                   max_objects=4, detect_interval=int(detect_interval), conditioning=cond).out(0)
    return g.node("SoundstageTrackSelect", track_data=track, subject=-1, match_mask=subject_mask).out(0)


# ------------------------------------------------------------------ guides

def guide_size(width, height, multiple=64, short=544):
    """Guide / stage-1 size: shorter side ~544 (the original graph), both sides a multiple of 32 x the IC-LoRA's
    latent downscale factor (union-control ref0.5 -> factor 2 -> 64). Same framing as the plate (no crop)."""
    k = short / min(width, height)
    snap = lambda v: max(multiple, int(round(v * k / multiple)) * multiple)
    return snap(width), snap(height)


def pose_guide(g, images, subject_mask, width, height, gate_grow=12):
    """the original 'Reference Video' subgraph: shorter side 544, DWPose body+face+hands, multiplied by the
    subject's SAM3 mask so only the recast person drives the IC-LoRA, then sized to (width, height).
    the original graph snapped with 'scale to multiple', which centre-crops (DWPose returns 512-short-side
    maps), so the swap no longer lined up with the plate; an exact stretch keeps the framing and makes
    the composite's inverse exact. Returns (guide, size node: width/height/batch)."""
    small = resize(g, images, "scale shorter dimension", shorter_size=544)
    pose = g.node("DWPreprocessor", image=small, detect_hand="enable", detect_body="enable", detect_face="enable",
                  resolution=512, bbox_detector="yolox_l.onnx",
                  pose_estimator="dw-ll_ucoco_384_bs5.torchscript.pt", scale_stick_for_xinsr_cn="disable").out(0)
    if subject_mask is None:   # Pose follow on real footage: every person drives the pose
        guide = resize(g, pose, "scale dimensions", width=int(width), height=int(height), crop="disabled")
        return guide, g.node("GetImageSize", image=guide)
    gate = subject_mask
    if gate_grow:
        gate = g.node("GrowMask", mask=resize(g, gate, "match size", match=small, crop="disabled",
                                              scale_method="bilinear"),
                      expand=int(gate_grow), tapered_corners=True).out(0)
    gate_img = resize(g, g.node("MaskToImage", mask=gate).out(0), "match size", match=pose, crop="disabled",
                      scale_method="bilinear")
    gated = g.node("ImageBlend", image1=pose, image2=gate_img, blend_factor=1.0, blend_mode="multiply").out(0)
    guide = resize(g, gated, "scale dimensions", width=int(width), height=int(height), crop="disabled")
    return guide, g.node("GetImageSize", image=guide)


KREA_FRAME_PROMPT = ("Same shot, same camera, same lens, same lighting and the same background as the first "
                     "image. Replace the person {where} with the person from the second image: same pose, same "
                     "position, same size in frame, same direction. Keep everyone and everything else exactly as "
                     "it is. Photoreal, natural skin, matching light and shadows.")


def krea_first_frame(g, w, frame0, character, prompt, seed, likeness=4.0, blocking=1.0, where="in the shot"):
    """Recast frame 1 with Krea 2 Turbo + Identity Edit (Soundstage keyframe recipe, research/11):
    the plate's frame 0 is the scene reference (holds blocking), the character sheet is the subject
    reference (holds likeness). 8 steps, cfg 1, euler_ancestral / beta, ~1.2 MP."""
    src = resize(g, resize(g, frame0, "scale total pixels", megapixels=1.2), "scale to multiple", multiple=16)
    char = resize(g, character, "scale longer dimension", longer_size=1024)
    size = g.node("GetImageSize", image=src)
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    model = g.node("LoraLoaderModelOnly", model=unet, lora_name=w["identity_lora"], strength_model=1.0).out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="krea2", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    text = KREA_FRAME_PROMPT.format(where=where) + (" " + prompt.strip() if prompt and prompt.strip() else "")
    pos = g.node("Krea2EditGroundedEncode", clip=clip, prompt=text, image=src, image_b=char, grounding_px=768).out(0)
    neg = g.node("ConditioningZeroOut", conditioning=pos).out(0)
    lat = g.node("EmptySD3LatentImage", width=size.out(0), height=size.out(1), batch_size=1).out(0)
    model = g.node("Krea2EditModelPatch", model=model, source_latent=g.node("VAEEncode", pixels=src, vae=vae).out(0),
                   source_latent_b=g.node("VAEEncode", pixels=char, vae=vae).out(0), ref_boost=float(likeness),
                   ref_boost_a=float(blocking), fit_mode="fit", vae=vae, source_image=src, source_image_b=char,
                   target_latent=lat).out(0)
    s = g.node("KSampler", model=model, seed=int(seed), steps=8, cfg=1.0, sampler_name="euler_ancestral",
               scheduler="beta", positive=pos, negative=neg, latent_image=lat, denoise=1.0).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


# ------------------------------------------------------------------ engines

def ltx_union_recast(g, w, p):
    """the original union-control swap. p: images, mask, first (IMAGE link, the recast frame 1), audio (or None),
    fps, width/height (plate size), prompt, negative, seed, draft. Returns swap frames (stage-2 size, ~2x the 544p guide)."""
    base = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    lora = g.node("LTXICLoRALoaderModelOnly", model=base, lora_name=w["ic_lora"], strength_model=1.0)
    model, ldf = lora.out(0), lora.out(1)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    audio_vae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)
    fps = float(p["fps"])

    # Input Parameters: local Gemma encode (the original API branch is off by default), first frame at 1536 long side
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=p.get("negative") or LTX_NEGATIVE, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=fps)
    first = resize(g, p["first"], "scale longer dimension", longer_size=1536)

    # Reference Video
    gw, gh = guide_size(p["width"], p["height"])
    if p.get("guide") is not None:   # a pose video supplied directly (Motion's Pose follow: the stage's skeletons)
        guide = resize(g, p["guide"], "scale dimensions", width=gw, height=gh, crop="disabled")
        size = g.node("GetImageSize", image=guide)
    else:
        guide, size = pose_guide(g, p["images"], p.get("mask"), gw, gh)

    # Preprocess
    lat = g.node("EmptyLTXVLatentVideo", width=size.out(0), height=size.out(1), length=size.out(2),
                 batch_size=1).out(0)
    lat = g.node("LTXVImgToVideoInplace", vae=vae, image=first, latent=lat, strength=1.0, bypass=False).out(0)
    gd = g.node("LTXAddVideoICLoRAGuide", positive=cond.out(0), negative=cond.out(1), vae=vae, latent=lat,
                image=guide, frame_idx=0, strength=1.0, latent_downscale_factor=ldf, crop="disabled",
                use_tiled_encode=False, tile_size=256, tile_overlap=64)
    if p.get("audio") is not None:
        enc = g.node("VAEEncodeAudio", audio=p["audio"], vae=audio_vae).out(0)
        ref = g.node("LTXVSetAudioRefTokens", positive=gd.out(0), negative=gd.out(1), audio_latent=enc)
        c_pos, c_neg, audio_lat = ref.out(0), ref.out(1), ref.out(2)
    else:
        n = g.node("LTXFloatToInt", a=fps).out(0)
        audio_lat = g.node("LTXVEmptyLatentAudio", frames_number=size.out(2), frame_rate=n, batch_size=1,
                           audio_vae=audio_vae).out(0)
        c_pos, c_neg = gd.out(0), gd.out(1)
    av = g.node("LTXVConcatAVLatent", video_latent=gd.out(2), audio_latent=audio_lat).out(0)

    # Sampler - Distilled (8 steps)
    s1 = sampler(g, model, c_pos, c_neg, av, p["seed"], LTX_SIGMAS_STAGE1, "euler_ancestral")
    crop = g.node("LTXVCropGuides", positive=c_pos, negative=c_neg, latent=s1.out(0))
    video_lat = crop.out(2)

    if not p.get("draft"):
        # Upscale and re-sampler (3 steps)
        up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
        up = g.node("LTXVLatentUpsampler", samples=video_lat, upscale_model=up_model, vae=vae).out(0)
        up = g.node("LTXVImgToVideoInplace", vae=vae, image=first, latent=up, strength=1.0, bypass=False).out(0)
        av2 = g.node("LTXVConcatAVLatent", video_latent=up, audio_latent=s1.out(1)).out(0)
        s2 = sampler(g, model, crop.out(0), crop.out(1), av2, p["seed"], LTX_SIGMAS_STAGE2, "euler")
        video_lat = s2.out(0)

    # Decode (the original tile settings)
    return g.node("VAEDecodeTiled", samples=video_lat, vae=vae, tile_size=512, overlap=64, temporal_size=128,
                  temporal_overlap=32).out(0)


# ------------------------------------------------------------------ Openjutsu (Comfy's H3 character swap)
#
# Comfy-Org/comfy-openjutsu (MIT app) submits workflows/swap.api.json: MiniMax H3 ref2va + the
# h3_character_swap LoRA, driven by Akatz Labs' H3CharacterSwap* nodes (akatz-labs/h3-character-swap-tool,
# worker_nodes/h3_character_swap, GPL-3.0 because it vendors GPL code; Openjutsu ships a further GPL patch).
# Soundstage does NOT vendor that pack: it only emits its node class names here, so the pack must be
# installed separately (custom_nodes) and stays under its own licence.

OPENJUTSU_WEIGHTS = {
    "unet": ("diffusion_models", ["minimax_h3_ref2va_pruned_int8_convrot.safetensors"]),
    "text_encoder": ("text_encoders", ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]),
    "video_vae": ("vae", ["minimax_h3_video_vae_fp16.safetensors"]),
    "audio_vae": ("vae", ["minimax_h3_audio_vae_fp32.safetensors"]),
    "swap_lora": ("loras", ["h3_character_swap_v1.5.safetensors"]),
    "turbo_lora": ("loras", ["minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"]),
    "sam3": ("checkpoints", ["sam3.1_multiplex_fp16.safetensors"]),
}
OPENJUTSU_CLASSES = [
    "H3CharacterSwapPrepareVideo", "H3CharacterSwapSelectSubject", "H3CharacterSwapRecoverMasks",
    "H3CharacterSwapExpandMask", "H3CharacterSwapModels", "H3CharacterSwapSettings", "H3CharacterSwapShot",
    "H3CharacterSwapWindowPlan", "H3CharacterSwapController", "H3CharacterSwapAssemble",
    "MiniMaxH3SigmaShift", "ModelAttentionBackend", "SelectCLIPDevice", "SAM3_Detect", "SAM3_VideoTrack",
    "SAM3_TrackToMask",
]
OPENJUTSU_PROMPT = ("Replace the selected person with the reference character. Preserve source performance, "
                    "scene and audio timing.")
H3_LICENSE_ENV = "SOUNDSTAGE_H3_LICENSED"


def openjutsu_local(g, w, p):
    """Openjutsu's swap.api.json, node for node (pinned upstream 0670e4f + Openjutsu's changes), fed from
    Soundstage: the plate (+ original audio) as the source video, the character as the reference, our
    recast frame 1 as the anchor, the Footage subject prompt for SAM. Returns (frames, audio) links; frames
    are H3CharacterSwapPrepareVideo's 24 fps cover-crop of the plate (composite with framing='cover')."""
    seconds = p["frames"] / max(p["fps"], 1e-6)
    src_kw = {"audio": p["audio"]} if p.get("audio") is not None else {}
    video = g.node("CreateVideo", images=p["images"], fps=float(p["fps"]), **src_kw).out(0)
    prep = g.node("H3CharacterSwapPrepareVideo", video=video, resolution="768", duration_seconds=float(seconds))
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    m = g.node("MiniMaxH3SigmaShift", model=unet, shift_video=12, shift_audio=3).out(0)
    m = g.node("ModelAttentionBackend", model=m, attention="comfy kitchen attention").out(0)
    m = g.node("LoraLoaderModelOnly", model=m, lora_name=w["turbo_lora"], strength_model=1.0).out(0)
    m = g.node("LoraLoaderModelOnly", model=m, lora_name=w["swap_lora"], strength_model=1.0).out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="minimax", device="default").out(0)
    # Openjutsu pins "gpu:0"; single-GPU ComfyUI only offers default/cpu, and default is the GPU there
    clip = g.node("SelectCLIPDevice", clip=clip, device="default").out(0)
    models = g.node("H3CharacterSwapModels", model=m, clip=clip,
                    video_vae=g.node("VAELoader", vae_name=w["video_vae"]).out(0),
                    audio_vae=g.node("VAELoader", vae_name=w["audio_vae"]).out(0)).out(0)
    # Openjutsu's person mask chain (SAM 3.1 on the prepared frames), prompted with our subject description
    ck = g.node("CheckpointLoaderSimple", ckpt_name=w["sam3"])
    cond = g.node("CLIPTextEncode", text=p.get("subject_prompt") or "person", clip=ck.out(1)).out(0)
    f0 = g.node("ImageFromBatch", image=prep.out(0), batch_index=0, length=1).out(0)
    det = g.node("SAM3_Detect", model=ck.out(0), image=f0, conditioning=cond, threshold=0.35, refine_iterations=2,
                 individual_masks=True).out(0)
    sel = g.node("H3CharacterSwapSelectSubject", masks=det, selection="largest", index=0)
    tr = g.node("SAM3_VideoTrack", images=prep.out(0), model=ck.out(0), initial_mask=sel.out(0), conditioning=cond,
                detection_threshold=0.5, max_objects=1, detect_interval=1).out(0)
    masks = g.node("SAM3_TrackToMask", track_data=tr, object_indices="").out(0)
    rec = g.node("H3CharacterSwapRecoverMasks", masks=masks, images=prep.out(0), model=ck.out(0), conditioning=cond,
                 selection=sel.out(1), source_frames=prep.out(5), recover_empty_frames=True).out(0)
    body = g.node("H3CharacterSwapExpandMask", masks=rec, images=prep.out(0), source_frames=prep.out(5),
                  expansion_px=64).out(0)
    anchor = g.node("ImageScale", image=p["first"], upscale_method="lanczos", width=prep.out(2), height=prep.out(3),
                    crop="center").out(0)
    settings = g.node("H3CharacterSwapSettings", prompt=p.get("prompt") or OPENJUTSU_PROMPT, seed=int(p["seed"]),
                      audio_guide=True, steps=8, cfg=1.0, sampler_name="er_sde", scheduler="normal",
                      activation_memory_gib=17).out(0)
    shot = g.node("H3CharacterSwapShot", source_video=video, source=prep.out(0), source_audio=prep.out(1),
                  source_frames=prep.out(5), fps=prep.out(6), reference=p["character"], anchor=anchor,
                  body_mask=body, use_anchor=bool(p.get("use_anchor", True)), use_mask=True,
                  shot_id="soundstage-recast").out(0)
    plan = g.node("H3CharacterSwapWindowPlan", shot=shot, settings=settings, window_frames="124",
                  history_frames="18").out(0)
    ctl = g.node("H3CharacterSwapController", models=models, shot=shot, plan=plan)
    asm = g.node("H3CharacterSwapAssemble", state=ctl.out(0), shot=ctl.out(1), filename_prefix="soundstage-recast")
    return asm.out(0), asm.out(1)


H3_API_PROMPT = ("Video 1 is the source shot. Replace {who} in Video 1 with the person shown in Image 1: same "
                 "performance, timing, path and gestures, same camera, framing, lighting, background and other "
                 "people as Video 1. Image 2 is the first frame with the new character already in place. "
                 "Keep the original sound. {extra}")


def h3_api_reference(g, p, resolution="768P", variant="MiniMax H3"):
    """Openjutsu's model (MiniMax H3 reference-to-video), hosted by MiniMax through Comfy's partner node:
    Video 1 = the plate with its audio, Image 1 = character, Image 2 = recast frame 1. Paid (Comfy credits);
    licensed under MiniMax's API terms, not the H3 weights' Community License. Returns a VIDEO link."""
    seconds = p["frames"] / max(p["fps"], 1e-6)
    src_kw = {"audio": p["audio"]} if p.get("audio") is not None else {}
    video = g.node("CreateVideo", images=p["images"], fps=float(p["fps"]), **src_kw).out(0)
    prompt = H3_API_PROMPT.format(who=p.get("subject_prompt") or "the main person", extra=p.get("prompt") or "")
    kw = {"model": variant, "model.prompt": prompt.strip(), "model.resolution": resolution,
          "model.ratio": "adaptive", "model.duration": int(max(4, min(15, round(seconds)))),
          "model.reference_images.image_1": p["character"], "model.reference_videos.video_1": video,
          "seed": int(p["seed"]) % 2147483647, "watermark": False}
    if p.get("first") is not None:
        kw["model.reference_images.image_2"] = p["first"]
    return g.node("MinimaxHailuo03ReferenceNode", **kw).out(0)
