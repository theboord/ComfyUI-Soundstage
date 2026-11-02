"""Reshoot's two queued graphs (API prompt JSON, no ComfyUI imports; checked in tests/test_reshoot.py).

depth_prompt   the plate (the take at 24 fps, 8k+1 frames) -> Depth Anything 3 mono, every frame -> SoundstageDA3Export
               (the same model and export node Video -> Stage uses; one short GPU job, cached per take)
render_prompt  the new camera's depth video (the guide) + the depth-warped frame 1 + the take's own sound ->
               LTX-2.5 + the union-control IC-LoRA (Recast's engine, soundstage/footage/graphs.ltx_union_recast,
               used as is) -> SaveVideo
"""
from __future__ import annotations

from ..footage import graphs as FG
from ..loop.graphs import Prompt

RESHOOT_WEIGHTS = dict(FG.LTX_WEIGHTS)
DA3_RESOLUTION = 504
PROMPT = ("The same shot filmed again by a second camera: {move}. Same people doing exactly the same thing at the "
          "same moments, same place, same light, same wardrobe and the same sound. One continuous take, real camera "
          "and lens, natural motion blur.")


def depth_prompt(plate: str, model: str, name: str) -> dict:
    g = Prompt("d")
    clip = g.node("SoundstageClipLoad", source=plate, fps=0.0, start_frame=0, max_frames=0)
    m = g.node("LoadDA3Model", model_name=model, weight_dtype="default").out(0)
    geo = g.node("DA3Inference", da3_model=m, image=clip.out(0), mode="mono", resize_method="upper_bound_resize",
                 resolution=DA3_RESOLUTION).out(0)
    g.node("SoundstageDA3Export", id="npz", da3_geometry=geo, name=name)
    return g.json()


def reshoot_prompt(move_words: str, scene: str = "") -> str:
    base = PROMPT.format(move=move_words)
    return f"{scene.strip()} {base}".strip() if scene and scene.strip() else base


def render_prompt(weights: dict, *, plate: str, guide: str, first: str, width: int, height: int, prompt: str,
                  seed: int = 7, quality: str = "Draft", keep_sound: bool = True,
                  prefix: str = "soundstage_private/reshoot") -> dict:
    """plate: the take at 24 fps (its sound), guide: the new camera's depth video (same frame count), first: the
    warped frame 1 (PNG). width/height = the plate's size. Returns the API prompt (SaveVideo node id "save")."""
    g = Prompt()
    src = g.node("SoundstageClipLoad", id="plate", source=plate, fps=24.0, start_frame=0, max_frames=0)
    gd = g.node("SoundstageClipLoad", id="guide", source=guide, fps=24.0, start_frame=0, max_frames=0)
    first_img = g.node("SoundstageImageLoad", id="first", source=first).out(0)
    frames = FG.ltx_union_recast(g, weights, {
        "guide": gd.out(0), "first": first_img, "audio": src.out(1) if keep_sound else None, "fps": 24.0,
        "width": int(width), "height": int(height), "prompt": prompt, "seed": int(seed),
        "draft": quality != "Final"})
    kw = {"audio": src.out(1)} if keep_sound else {}
    video = g.node("CreateVideo", images=frames, fps=24.0, **kw).out(0)
    g.node("SaveVideo", id="save", video=video, filename_prefix=prefix, format="mp4", **{"format.codec": "h264"})
    return g.json()


def camera_lora_test_prompt(weights: dict, lora: str, *, first: str, width: int = 768, height: int = 448,
                            frames: int = 49, seed: int = 7, prefix: str = "soundstage_private/reshoot/lora_test") -> dict:
    """One load test of an LTX-2 19B camera-control LoRA on the LTX-2.5 22B transformer (PLAN.md flaw 7): a short
    image-to-video render with the LoRA at strength 1. If its keys don't match, ComfyUI logs 'lora key not loaded'
    and the render shows no camera move."""
    g = Prompt("t")
    img = FG.resize(g, g.node("SoundstageImageLoad", source=first).out(0), "scale dimensions", width=width,
                    height=height, crop="center")
    unet = g.node("UNETLoader", unet_name=weights["unet"], weight_dtype="default").out(0)
    model = g.node("LoraLoaderModelOnly", model=unet, lora_name=lora, strength_model=1.0).out(0)
    clip = g.node("CLIPLoader", clip_name=weights["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=weights["vae"]).out(0)
    audio_vae = g.node("VAELoader", vae_name=weights["audio_vae"]).out(0)
    pos = g.node("CLIPTextEncode", text="The camera dollies in slowly towards the subject. Real footage.", clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=FG.LTX_NEGATIVE, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=24.0)
    lat = g.node("EmptyLTXVLatentVideo", width=width, height=height, length=frames, batch_size=1).out(0)
    lat = g.node("LTXVImgToVideoInplace", vae=vae, image=img, latent=lat, strength=1.0, bypass=False).out(0)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=frames, frame_rate=24, batch_size=1, audio_vae=audio_vae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=lat, audio_latent=alat).out(0)
    s = FG.sampler(g, model, cond.out(0), cond.out(1), av, seed, FG.LTX_SIGMAS_STAGE1, "euler_ancestral")
    out = g.node("VAEDecodeTiled", samples=s.out(0), vae=vae, tile_size=512, overlap=64, temporal_size=128,
                 temporal_overlap=32).out(0)
    video = g.node("CreateVideo", images=out, fps=24.0).out(0)
    g.node("SaveVideo", id="save", video=video, filename_prefix=prefix, format="mp4", **{"format.codec": "h264"})
    return g.json()
