"""Seamless loop: the LTX-2.5 graph (API prompt JSON) that starts and ends on the same picture.

No ComfyUI imports. `Prompt` is a tiny API-prompt builder with the GraphBuilder shape the other builders use
(g.node(class, **inputs).out(i)), so soundstage/footage/graphs.py helpers work on it and tests/test_loop_graphs.py
checks the result against an /object_info snapshot of the pod.

Loop = one LTX-2.5 distilled render whose first and last frames are the same picture:
  the picture (a still, or a take's frame 1: SoundstageImageLoad reads a video's first frame)
  -> LTXVImgToVideoInplace at frame 0 (exact) + LTXVAddGuide with the same picture at the last index (frame_idx -1)
  -> 8-step distilled stage 1 (~544p) -> crop guides -> [Final: x2 latent upsampler, both guides again, 3-step refine]
  -> tiled decode, the generated sound decoded too -> SaveVideo.
The last frame then lands on (almost) the first picture, so the player's wrap is the one step back to frame 0: the
App drops that duplicate last frame (soundstage/loop/fix.py) and the seam meter (seam.py) measures what's left.

Bridge = the same graph between two different pictures (the clip's last frame -> its first frame), a short render
that closes a loop that didn't land: fix.join() appends it, never a crossfade.
"""
from __future__ import annotations

from ..footage import graphs as FG

LOOP_WEIGHTS = {k: FG.LTX_WEIGHTS[k] for k in ("unet", "text_encoder", "vae", "audio_vae", "upscaler")}
QUALITY = {"Draft": {"short": 544, "two_stage": False}, "Final": {"short": 544, "two_stage": True}}
SECONDS = (2.0, 3.0, 4.0, 5.0, 6.0, 8.0)
FPS = 24.0
MAX_LONG = 1024          # stage-1 longer side (Final upsamples x2)
MIN_SIDE = 64            # EmptyLTXVLatentVideo's smallest width / height

# Our own words (docs/loop.md). Real-world cyclic motion, a locked-off camera, no cuts.
LOOP_SUFFIX = ("One continuous take on a locked-off camera that loops perfectly: every movement in the shot is cyclic "
               "and returns to exactly where it started, so the last moment flows straight back into the first. Same "
               "framing, same light and the same people from start to end; no cut, no fade, no camera move.")
DEFAULT_MOTION = ("Natural, gentle real-world motion: breathing, hair and clothes moving in a light breeze, leaves "
                  "and water moving, flickering practical lights.")
BRIDGE_SUFFIX = ("One continuous take on a locked-off camera. The shot moves smoothly and naturally from the first "
                 "picture to the second; no cut, no fade, no camera move.")
NEGATIVE = FG.LTX_NEGATIVE + ", cut, scene change, crossfade, dissolve, camera shake, zoom, morphing, frozen frame"


class Node:
    def __init__(self, nid: str):
        self.id = nid

    def out(self, i: int = 0) -> list:
        return [self.id, int(i)]


class Prompt:
    """Builds an API prompt: {"1": {"class_type", "inputs"}, ...}. node() returns a handle with .out(i)."""

    def __init__(self, prefix: str = ""):
        self.nodes: dict = {}
        self.prefix = prefix
        self.n = 0

    def node(self, class_type: str, id: str | None = None, **inputs) -> Node:
        self.n += 1
        nid = id or f"{self.prefix}{self.n}"
        self.nodes[nid] = {"class_type": class_type, "inputs": dict(inputs)}
        return Node(nid)

    def of(self, cls: str) -> list[dict]:
        return [n for n in self.nodes.values() if n["class_type"] == cls]

    def json(self) -> dict:
        return self.nodes


def ltx_frames(seconds: float, fps: float = FPS) -> int:
    """Frames for a length: 8k+1 (LTX), at least 17 (0.7 s)."""
    n = max(17, int(round(float(seconds) * float(fps))))
    return (n + 3) // 8 * 8 + 1


def render_size(width: int, height: int, short: int = 544, multiple: int = 32) -> tuple[int, int]:
    """Stage-1 size: the picture's aspect, shorter side `short`, both sides a multiple of 32, longer side <= 1024,
    neither under EmptyLTXVLatentVideo's 64 (a strip wider than 16:1 snapped its short side to 32: refused)."""
    w, h = float(max(1, width)), float(max(1, height))
    k = short / min(w, h)
    if max(w, h) * k > MAX_LONG:
        k = MAX_LONG / max(w, h)
    floor = max(MIN_SIDE, multiple)
    snap = lambda v: max(floor, int(round(v * k / multiple)) * multiple)  # noqa: E731
    return snap(w), snap(h)


def loop_prompt(text: str = "", bridge: bool = False) -> str:
    t = (text or "").strip() or ("" if bridge else DEFAULT_MOTION)
    suffix = BRIDGE_SUFFIX if bridge else LOOP_SUFFIX
    return f"{t} {suffix}".strip()


def _guides(g, cond_pos, cond_neg, vae, latent, first, last, end_strength):
    """frame 0 in place (exact) + the end picture as a guide at the last index."""
    lat = g.node("LTXVImgToVideoInplace", vae=vae, image=first, latent=latent, strength=1.0, bypass=False).out(0)
    gd = g.node("LTXVAddGuide", positive=cond_pos, negative=cond_neg, vae=vae, latent=lat, image=last,
                frame_idx=-1, strength=float(end_strength))
    return gd


def loop(g, w: dict, p: dict) -> tuple[list, list]:
    """p: first (IMAGE link), last (IMAGE link, = first for a loop), width/height (render size, stage 1), frames
    (8k+1), fps, prompt, negative, seed, two_stage, end_strength. Returns (frames IMAGE link, audio AUDIO link)."""
    W, H, F, fps = int(p["width"]), int(p["height"]), int(p["frames"]), float(p.get("fps") or FPS)
    unet = g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    audio_vae = g.node("VAELoader", vae_name=w["audio_vae"]).out(0)
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=p.get("negative") or NEGATIVE, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=fps)
    first = FG.resize(g, p["first"], "scale dimensions", width=W, height=H, crop="center")
    last = first if p.get("last") is None or p.get("last") == p.get("first") else \
        FG.resize(g, p["last"], "scale dimensions", width=W, height=H, crop="center")
    end = float(p.get("end_strength", 1.0))

    lat = g.node("EmptyLTXVLatentVideo", width=W, height=H, length=F, batch_size=1).out(0)
    gd = _guides(g, cond.out(0), cond.out(1), vae, lat, first, last, end)
    n = g.node("LTXFloatToInt", a=fps).out(0)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=F, frame_rate=n, batch_size=1, audio_vae=audio_vae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=gd.out(2), audio_latent=alat).out(0)
    s1 = FG.sampler(g, unet, gd.out(0), gd.out(1), av, p["seed"], FG.LTX_SIGMAS_STAGE1, "euler_ancestral")
    crop = g.node("LTXVCropGuides", positive=gd.out(0), negative=gd.out(1), latent=s1.out(0))
    video_lat, audio_lat = crop.out(2), s1.out(1)

    if p.get("two_stage"):
        up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
        up = g.node("LTXVLatentUpsampler", samples=video_lat, upscale_model=up_model, vae=vae).out(0)
        big_first = FG.resize(g, p["first"], "scale dimensions", width=W * 2, height=H * 2, crop="center")
        big_last = big_first if last is first else \
            FG.resize(g, p["last"], "scale dimensions", width=W * 2, height=H * 2, crop="center")
        gd2 = _guides(g, crop.out(0), crop.out(1), vae, up, big_first, big_last, end)
        av2 = g.node("LTXVConcatAVLatent", video_latent=gd2.out(2), audio_latent=audio_lat).out(0)
        s2 = FG.sampler(g, unet, gd2.out(0), gd2.out(1), av2, p["seed"], FG.LTX_SIGMAS_STAGE2, "euler")
        crop2 = g.node("LTXVCropGuides", positive=gd2.out(0), negative=gd2.out(1), latent=s2.out(0))
        video_lat, audio_lat = crop2.out(2), s2.out(1)

    frames = g.node("VAEDecodeTiled", samples=video_lat, vae=vae, tile_size=512, overlap=64, temporal_size=128,
                    temporal_overlap=32).out(0)
    audio = g.node("LTXVAudioVAEDecode", samples=audio_lat, audio_vae=audio_vae).out(0)
    return frames, audio


def build(weights: dict, *, source: str, end_source: str = "", width: int, height: int, seconds: float = 4.0,
          prompt: str = "", seed: int = 7, quality: str = "Draft", sound: bool = True, end_strength: float = 1.0,
          prefix: str = "soundstage_private/loop", bridge: bool = False) -> dict:
    """The whole API prompt: SoundstageImageLoad (the picture; a video gives its frame 1) -> loop -> CreateVideo ->
    SaveVideo (node id "save"). width/height = the picture's own size (the render keeps its aspect)."""
    q = QUALITY.get(quality, QUALITY["Draft"])
    W, H = render_size(width, height, q["short"])
    g = Prompt()
    first = g.node("SoundstageImageLoad", id="src", source=source).out(0)
    last = g.node("SoundstageImageLoad", id="end", source=end_source).out(0) if end_source and end_source != source else None
    frames, audio = loop(g, weights, {"first": first, "last": last, "width": W, "height": H,
                                      "frames": ltx_frames(seconds), "fps": FPS, "seed": int(seed),
                                      "prompt": loop_prompt(prompt, bridge=bridge), "two_stage": q["two_stage"],
                                      "end_strength": end_strength})
    kw = {"audio": audio} if sound else {}
    video = g.node("CreateVideo", images=frames, fps=FPS, **kw).out(0)
    g.node("SaveVideo", id="save", video=video, filename_prefix=prefix, format="mp4", **{"format.codec": "h264"})
    return g.json()
