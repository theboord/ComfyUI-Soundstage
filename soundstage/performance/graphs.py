"""Expansion builders for Performance capture and render (docs/performance.md).

No ComfyUI imports: every builder takes a GraphBuilder-like `g` (g.node(class, **inputs).out(i)) and raw links, so
tests/test_performance.py checks the emitted graphs against an /object_info snapshot of the pod.

Render = Mike's tested union-control swap graph (LTX-2.5_ICLoRA_UnionControl_SAM3_DWPose_OGaudioSampler-boord.json, rebuilt
in soundstage/footage/graphs.ltx_union_recast) driven by a captured performance instead of a plate, plus the lip-sync fix:
  actor's DWPose (body + hands + FACE) fitted onto the character's place in the shot -> union-control IC-LoRA guide
  (optional: the stage's layout pass screened faintly under the skeleton)
  the shot's frame (stage layout, camera, the character in costume) -> LTXVImgToVideoInplace
  actor's voice -> VAEEncodeAudio -> LTXVSetAudioRefTokens (raw latent) and, as the AV latent's audio half, the same
  latent with a 0.3 noise mask (frozen 0.0 = mouths flap unsynced; 0.3 measured r 0.37-0.48 mouth-vs-speech,
  reference_ltx23_lipsync_frozen_mouth) in BOTH stages
  8-step distilled stage 1 -> crop guides -> x2 latent upsampler -> 3-step stage 2 -> tiled decode
The voice on the result is the actor's own recording, untouched.
"""
from ..footage import graphs as FG

WEIGHTS = dict(FG.LTX_WEIGHTS)
AUDIO_MASK = 0.3
# Draft: stage 1 only at 544 short side. Final: 544 + x2 refine. Hollywood: 704 + x2 refine (M18's preset).
QUALITY = {"Draft": {"short": 544, "refine": False}, "Final": {"short": 544, "refine": True},
           "Hollywood": {"short": 704, "refine": True}}
LIPSYNC_HINT = "The person is talking, natural lip-sync with the dialogue, real human facial expressions."
NEGATIVE = FG.LTX_NEGATIVE + ", frozen mouth, closed mouth while talking, mannequin face, plastic skin, waxy face"


def render_size(width, height, quality="Draft"):
    """Stage-1 / guide size for the render aspect: shorter side at the quality's size, multiples of 64."""
    q = QUALITY.get(quality, QUALITY["Draft"])
    return FG.guide_size(width, height, short=q["short"])


def prompt_text(prompt, has_audio=True):
    t = (prompt or "").strip()
    if has_audio and "lip" not in t.lower():
        t = f"{t} {LIPSYNC_HINT}".strip()
    return t


def capture(g, p):
    """p: source (file ref), fps, max_frames, resolution. -> (clip node, pose node). DWPose body + hands + face on every
    frame at `resolution` (768 keeps the face landmarks on a medium shot)."""
    clip = g.node("SoundstageClipLoad", source=p["source"], fps=float(p.get("fps", 24.0)), start_frame=0,
                  max_frames=int(p.get("max_frames", 161)))
    pose = g.node("DWPreprocessor", image=clip.out(0), detect_hand="enable", detect_body="enable", detect_face="enable",
                  resolution=int(p.get("resolution", 768)), bbox_detector="yolox_l.onnx",
                  pose_estimator="dw-ll_ucoco_384_bs5.torchscript.pt", scale_stick_for_xinsr_cn="disable")
    return clip, pose


def guide(g, pose, width, height, frames, layout=None, layout_mix=0.0):
    """The IC-LoRA guide at (width, height): the fitted skeleton, with the stage's layout pass screened under it."""
    out = FG.resize(g, pose, "scale dimensions", width=int(width), height=int(height), crop="disabled")
    if layout is not None and layout_mix > 0:
        lay = FG.resize(g, layout, "scale dimensions", width=int(width), height=int(height), crop="disabled")
        lay = g.node("ImageFromBatch", image=lay, batch_index=0, length=int(frames)).out(0)
        out = g.node("ImageBlend", image1=out, image2=lay, blend_factor=float(layout_mix), blend_mode="screen").out(0)
    return out


def render(g, w, p):
    """p: pose (IMAGE link, fitted skeleton frames), first (IMAGE link, the shot's frame), audio (AUDIO link or None),
    frames (int, 8k+1), fps, width/height (shot aspect), prompt, negative, seed, quality, audio_mask, layout (IMAGE link
    or None), layout_mix. Returns {"images", "audio"} links."""
    q = QUALITY.get(p.get("quality", "Draft"), QUALITY["Draft"])
    fps = float(p["fps"])
    n = int(p["frames"])
    gw, gh = render_size(p["width"], p["height"], p.get("quality", "Draft"))
    has_audio = p.get("audio") is not None

    base = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    lora = g.node("LTXICLoRALoaderModelOnly", model=base, lora_name=w["ic_lora"], strength_model=1.0)
    model, ldf = lora.out(0), lora.out(1)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    avae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)

    pos = g.node("CLIPTextEncode", text=prompt_text(p.get("prompt"), has_audio), clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=p.get("negative") or NEGATIVE, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=fps)
    first = FG.resize(g, p["first"], "scale longer dimension", longer_size=1536)

    gd_img = guide(g, g.node("ImageFromBatch", image=p["pose"], batch_index=0, length=n).out(0), gw, gh, n,
                   p.get("layout"), float(p.get("layout_mix") or 0.0))
    size = g.node("GetImageSize", image=gd_img)
    lat = g.node("EmptyLTXVLatentVideo", width=size.out(0), height=size.out(1), length=size.out(2), batch_size=1).out(0)
    lat = g.node("LTXVImgToVideoInplace", vae=vae, image=first, latent=lat, strength=1.0, bypass=False).out(0)
    gd = g.node("LTXAddVideoICLoRAGuide", positive=cond.out(0), negative=cond.out(1), vae=vae, latent=lat, image=gd_img,
                frame_idx=0, strength=1.0, latent_downscale_factor=ldf, crop="disabled", use_tiled_encode=False,
                tile_size=256, tile_overlap=64)

    audio_out = None
    if has_audio:
        audio_out = g.node("SoundstageAudioFit", audio=p["audio"], frames=n, fps=fps, offset_s=0.0).out(0)
        raw = g.node("VAEEncodeAudio", audio=audio_out, vae=avae).out(0)
        a_lat = g.node("SoundstageLatentNoiseMask", latent=raw, value=float(p.get("audio_mask", AUDIO_MASK))).out(0)
        ref = g.node("LTXVSetAudioRefTokens", positive=gd.out(0), negative=gd.out(1), audio_latent=raw)
        c_pos, c_neg = ref.out(0), ref.out(1)
    else:
        a_lat = g.node("LTXVEmptyLatentAudio", frames_number=size.out(2), frame_rate=g.node("LTXFloatToInt", a=fps).out(0),
                       batch_size=1, audio_vae=avae).out(0)
        c_pos, c_neg = gd.out(0), gd.out(1)
    av = g.node("LTXVConcatAVLatent", video_latent=gd.out(2), audio_latent=a_lat).out(0)
    s1 = FG.sampler(g, model, c_pos, c_neg, av, p["seed"], FG.LTX_SIGMAS_STAGE1, "euler_ancestral")
    crop = g.node("LTXVCropGuides", positive=c_pos, negative=c_neg, latent=s1.out(0))
    video_lat = crop.out(2)

    if q["refine"]:
        up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
        up = g.node("LTXVLatentUpsampler", samples=video_lat, upscale_model=up_model, vae=vae).out(0)
        up = g.node("LTXVImgToVideoInplace", vae=vae, image=first, latent=up, strength=1.0, bypass=False).out(0)
        av2 = g.node("LTXVConcatAVLatent", video_latent=up, audio_latent=a_lat if has_audio else s1.out(1)).out(0)
        s2 = FG.sampler(g, model, crop.out(0), crop.out(1), av2, p["seed"], FG.LTX_SIGMAS_STAGE2, "euler")
        video_lat = s2.out(0)

    images = g.node("VAEDecodeTiled", samples=video_lat, vae=vae, tile_size=512, overlap=64, temporal_size=128,
                    temporal_overlap=32).out(0)
    return {"images": images, "audio": audio_out}
