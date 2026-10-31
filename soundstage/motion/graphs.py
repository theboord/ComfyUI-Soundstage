"""Expansion builders for ⑤ Motion's Ripple edit and Pose follow.

No ComfyUI imports: every builder takes a GraphBuilder-like `g` (g.node(class, **inputs).out(i)) and raw links,
so tests/test_motion_graphs.py checks the emitted graphs against an /object_info snapshot of the pod.

Ripple = LTX Ripple v1.1 (WepeNerd/LTX-Ripple), a "First Frame All Frames" IC-LoRA for LTX-2.5: edit frame 1 of a
clip and the edit is carried through every frame, keeping the clip's motion, timing and camera. Rebuilt node for
node from the reference workflow LTX_Ripple_FFAF_Edit_v11.json:
  source video (24 fps) + edited frame 1, both resized to the render size
  guide = [edited frame 1, source frames ...] cut to the clip length   (BatchImagesNode -> slice)
  LTX-2.5 distilled + LoraLoaderModelOnly(Ripple, 1.35) -> CFGGuider cfg 1, euler, BasicScheduler simple 25 steps
  EmptyLTXVLatentVideo -> LTXAddVideoICLoRAGuide(frame_idx 0, strength 1, downscale 1) + empty audio latent
  -> SamplerCustomAdvanced -> separate -> LTXVCropGuides -> decode
The reference workflow colour-matches the result to the source (ImageColorMatch+); that drags a relight back to the
source's light, so here it is optional and off by default (or matched to the edited frame instead).

Pose follow = the union-control IC-LoRA (pose/depth/canny, ref0.5) driven by an OpenPose-style skeleton video
(rendered from the stage's clay actors, or DWPose on real footage), starting from the shot's chosen frame. Same
graph as Recast's LTX engine (soundstage/footage/graphs.ltx_union_recast) with the guide supplied directly.
"""
from ..footage import graphs as FG

RIPPLE_WEIGHTS = {
    "unet": FG.LTX_WEIGHTS["unet"],
    "text_encoder": FG.LTX_WEIGHTS["text_encoder"],
    "vae": FG.LTX_WEIGHTS["vae"],
    "audio_vae": FG.LTX_WEIGHTS["audio_vae"],
    "ripple_lora": ("loras", ["LTX25_Ripple_v11.safetensors"]),
}
POSE_WEIGHTS = dict(FG.LTX_WEIGHTS)

RIPPLE_STRENGTH = 1.35
RIPPLE_PREFIX = ("Use the reference video for motion, timing, camera movement, composition, and unchanged scene "
                 "content, while consistently propagating the visual edit established in the first frame throughout "
                 "the video.")
RIPPLE_NEGATIVE = ("blurry, low resolution, ugly, garbled mess, compression artifacts, glitch, stop motion, still image, "
                   "pixelated, robotic voice, oversaturated")
QUALITY = {"Draft": {"short": 544, "steps": 25}, "Final": {"short": 768, "steps": 25}}
COLOR_MATCH = ("off", "edited frame", "source")
MAX_LONG = 1920


def ripple_size(width, height, quality="Draft", multiple=32):
    """Render size: the source's aspect with the shorter side at the quality's size (544 draft, 768 final), both
    sides a multiple of 32, the longer side at most 1920 (the reference workflow renders 1920x816)."""
    short = QUALITY.get(quality, QUALITY["Draft"])["short"]
    w, h = float(max(1, width)), float(max(1, height))
    k = short / min(w, h)
    if max(w, h) * k > MAX_LONG:
        k = MAX_LONG / max(w, h)
    snap = lambda v: max(multiple, int(round(v * k / multiple)) * multiple)
    return snap(w), snap(h)


def ripple_prompt(text):
    t = (text or "").strip()
    return f"{RIPPLE_PREFIX}\n\n{t}" if t else RIPPLE_PREFIX


def ripple(g, w, p):
    """p: images (source frames link), edited (edited frame-1 link), frames (int, 8k+1), fps, width/height (source
    size), prompt, seed, strength, quality, color_match. Returns the edited frames (IMAGE link) at the render size."""
    W, H = ripple_size(p["width"], p["height"], p.get("quality", "Draft"))
    F = int(p["frames"])
    fps = float(p["fps"])
    steps = int(p.get("steps") or QUALITY.get(p.get("quality", "Draft"), QUALITY["Draft"])["steps"])
    src = FG.resize(g, p["images"], "scale dimensions", width=W, height=H, crop="center")
    edited = FG.resize(g, p["edited"], "scale dimensions", width=W, height=H, crop="center")
    batch = g.node("BatchImagesNode", **{"images.image0": edited, "images.image1": src}).out(0)
    guide = g.node("ImageFromBatch", image=batch, batch_index=0, length=F).out(0)

    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    model = g.node("LoraLoaderModelOnly", model=unet, lora_name=w["ripple_lora"],
                   strength_model=float(p.get("strength", RIPPLE_STRENGTH))).out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    audio_vae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)
    pos = g.node("CLIPTextEncode", text=ripple_prompt(p.get("prompt")), clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=p.get("negative") or RIPPLE_NEGATIVE, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=fps)
    lat = g.node("EmptyLTXVLatentVideo", width=W, height=H, length=F, batch_size=1).out(0)
    gd = g.node("LTXAddVideoICLoRAGuide", positive=cond.out(0), negative=cond.out(1), vae=vae, latent=lat, image=guide,
                frame_idx=0, strength=1.0, latent_downscale_factor=1.0, crop="disabled", use_tiled_encode=False,
                tile_size=256, tile_overlap=64)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=F, frame_rate=int(round(fps)), batch_size=1,
                  audio_vae=audio_vae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=gd.out(2), audio_latent=alat).out(0)
    s = g.node("SamplerCustomAdvanced",
               noise=g.node("RandomNoise", noise_seed=int(p["seed"])).out(0),
               guider=g.node("CFGGuider", model=model, positive=gd.out(0), negative=gd.out(1), cfg=1.0).out(0),
               sampler=g.node("KSamplerSelect", sampler_name="euler").out(0),
               sigmas=g.node("BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.0).out(0),
               latent_image=av).out(0)
    sep = g.node("LTXVSeparateAVLatent", av_latent=s)
    crop = g.node("LTXVCropGuides", positive=gd.out(0), negative=gd.out(1), latent=sep.out(0))
    out = g.node("VAEDecodeTiled", samples=crop.out(2), vae=vae, tile_size=512, overlap=64, temporal_size=64,
                 temporal_overlap=16).out(0)
    cm = p.get("color_match", "off")
    if cm in ("edited frame", "source"):
        ref = edited if cm == "edited frame" else src
        out = g.node("ColorTransfer", image_target=out, image_ref=ref, method="reinhard_lab",
                     source_stats="uniform", strength=1.0).out(0)
    return out


def pose_follow(g, w, p):
    """Union-control pose follow. p: guide (skeleton frames, IMAGE link) or images (real footage -> DWPose),
    first (the shot's chosen frame), fps, width/height (render aspect), prompt, negative, seed, draft.
    Returns the frames (IMAGE link)."""
    q = dict(p)
    q.setdefault("audio", None)
    if q.get("guide") is None:
        if q.get("images") is None:
            raise ValueError("Pose follow needs a skeleton video or footage to read the pose from.")
        q["mask"] = None   # every person in the clip drives the pose
    return FG.ltx_union_recast(g, w, q)
