"""Performance: a real actor's body, face and voice drive a shot (docs/performance.md).

SoundstagePerformanceCapture  a clip of a real actor (phone, webcam, any file; with their voice) -> DWPose body + hands +
                              face on every frame -> a performance asset (pose video with the voice, overlay preview,
                              face landmarks, mouth-open curve, consent record). Expands at run time.
SoundstagePerformanceSave     the writer behind Capture: files in output/soundstage_private/performances/<id>/.
SoundstagePoseFit             move / scale a skeleton video so the actor stands where the character stands in the shot.
SoundstagePerformance         render the shot from its frame with the actor's performance: union-control IC-LoRA on the
                              fitted body + face skeleton, the actor's voice in the sampler (0.3 audio noise mask, the
                              lip-sync fix) and on the result. Expands at run time.
"""
import json
import os
import time
from fractions import Fraction

import torch
import torch.nn.functional as F

import folder_paths
from comfy_api.latest import IO, InputImpl, Types, UI
from comfy_execution.graph_utils import GraphBuilder

from .audio import clip as AC
from .motion import timing as T
from .nodes_motion import _safe_path, _mtime, _weights
from .performance import asset as A
from .performance import graphs as PG

PRIVATE = "soundstage_private/performances"
PoseKeypoint = IO.Custom("POSE_KEYPOINT")


def _folder(aid):
    path = os.path.join(folder_paths.get_output_directory(), PRIVATE, aid)
    os.makedirs(path, exist_ok=True)
    return path


def _ref(aid, name):
    return f"{PRIVATE}/{aid}/{name} [output]"


def _save_mp4(path, images, fps, audio=None, crf=12):
    comp = Types.VideoComponents(images=images, frame_rate=Fraction(round(float(fps) * 1000), 1000), audio=audio)
    InputImpl.VideoFromComponents(comp).save_to(path, format=Types.VideoContainer("mp4"), codec=Types.VideoCodec("h264"),
                                                crf=crf)


def _match(pose, h, w):
    if pose.shape[1] == h and pose.shape[2] == w:
        return pose
    return F.interpolate(pose.movedim(-1, 1), size=(h, w), mode="bilinear", align_corners=False).movedim(1, -1)


def overlay(frames, pose, dim=0.55):
    """The capture preview: the actor dimmed, the skeleton (body, hands, face) drawn over them."""
    p = _match(pose.to(frames.device, frames.dtype), frames.shape[1], frames.shape[2])
    on = (p.amax(dim=-1, keepdim=True) > 0.08).to(frames.dtype)
    return (frames * dim) * (1 - on) + p * on


def fit_pose(pose, width, height, src_box=None, dst_box=None):
    """Skeleton frames -> (width x height) frames on black. With both boxes (0-1 units of the source / target frame)
    the actor's box lands on the character's box (same height, centre x, top); otherwise the source framing is kept
    (cover-cropped to the new aspect, like the shot camera would)."""
    n, sh, sw, c = pose.shape
    W, H = int(width), int(height)
    if not (src_box and dst_box):
        k = max(W / sw, H / sh)
        nw, nh = max(1, round(sw * k)), max(1, round(sh * k))
        big = _match(pose, nh, nw)
        y0, x0 = (nh - H) // 2, (nw - W) // 2
        return big[:, y0:y0 + H, x0:x0 + W].contiguous()
    src_h = max(1e-6, src_box[3] - src_box[1]) * sh          # actor height, source px
    dst_h = max(1e-6, dst_box[3] - dst_box[1]) * H           # character height, target px
    scale_px = dst_h / src_h                                  # uniform: the actor keeps their own proportions
    nw, nh = max(1, round(sw * scale_px)), max(1, round(sh * scale_px))
    big = _match(pose, nh, nw)
    cx_src = (src_box[0] + src_box[2]) / 2 * nw     # actor centre in the scaled source, px
    top_src = src_box[1] * nh
    ox = round((dst_box[0] + dst_box[2]) / 2 * W - cx_src)
    oy = round(dst_box[1] * H - top_src)
    out = torch.zeros((n, H, W, c), dtype=pose.dtype, device=pose.device)
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(W, ox + nw), min(H, oy + nh)
    if x1 > x0 and y1 > y0:
        out[:, y0:y1, x0:x1] = big[:, y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    return out


def load_asset(ref):
    path = _safe_path(ref)
    try:
        with open(path) as f:
            asset = json.load(f)
    except (OSError, ValueError) as e:
        raise A.PerformanceError(f"{ref}: not a performance asset ({e}).")
    if asset.get("kind") != "soundstage_performance":
        raise A.PerformanceError(f"{ref}: not a performance asset.")
    return asset


# ====================================================================== capture

class SoundstagePerformanceSave(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePerformanceSave",
            display_name="Soundstage · Save Performance",
            category="Soundstage/Performance/advanced",
            description="Write a performance asset: pose video with the actor's voice, overlay preview, face landmarks, "
                        "mouth-open curve and the consent record, in output/soundstage_private/performances/<id>/.",
            inputs=[
                IO.Image.Input("frames"), IO.Image.Input("pose"), PoseKeypoint.Input("keypoints", optional=True),
                IO.Audio.Input("audio", optional=True), IO.Float.Input("fps", default=24.0, min=1.0, max=120.0),
                IO.String.Input("name", default="take"), IO.String.Input("performer", default=""),
                IO.Boolean.Input("consent", default=False), IO.String.Input("source", default=""),
                IO.String.Input("character", default="", optional=True),
            ],
            outputs=[IO.String.Output(display_name="asset_json"), IO.Image.Output(display_name="overlay")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, frames, pose, fps, name, performer, consent, source, keypoints=None, audio=None,
                character="") -> IO.NodeOutput:
        rec = A.check_consent(performer, consent)
        aid = f"{A.slug(name)}_{time.strftime('%Y%m%d_%H%M%S')}"
        folder = _folder(aid)
        n = min(int(frames.shape[0]), int(pose.shape[0]))
        frames, pose = frames[:n], pose[:n]
        pose_full = _match(pose, frames.shape[1], frames.shape[2])
        ov = overlay(frames, pose_full)
        kp = A.read_keypoints(list(keypoints or [])[:n])
        _save_mp4(os.path.join(folder, "pose.mp4"), pose_full, fps, audio, crf=10)
        _save_mp4(os.path.join(folder, "overlay.mp4"), ov, fps, audio, crf=18)
        files = {"pose": _ref(aid, "pose.mp4"), "overlay": _ref(aid, "overlay.mp4"), "keypoints": _ref(aid, "face.json")}
        if audio is not None and audio.get("waveform") is not None:
            wav = audio["waveform"][0].movedim(0, -1).float().cpu().numpy()
            AC.write_wav(os.path.join(folder, "voice.wav"), wav, int(audio["sample_rate"]))
            files["audio"] = _ref(aid, "voice.wav")
        with open(os.path.join(folder, "face.json"), "w") as f:
            json.dump(kp, f)
        asset = A.asset_record(aid=aid, name=name, consent=rec, source=source, fps=float(fps), frames=n,
                               width=int(frames.shape[2]), height=int(frames.shape[1]), has_audio="audio" in files,
                               files=files, keypoints=kp, character=character or "")
        asset["file"] = _ref(aid, "asset.json")
        with open(os.path.join(folder, "asset.json"), "w") as f:
            json.dump(asset, f, indent=1)
        text = json.dumps(asset)
        return IO.NodeOutput(text, ov, ui={"text": [text],
                                           "videos": [{"filename": "overlay.mp4", "subfolder": f"{PRIVATE}/{aid}", "type": "output"}]})


class SoundstagePerformanceCapture(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePerformanceCapture",
            display_name="Soundstage · Capture Performance (body + face + voice)",
            category="Soundstage/Performance",
            search_aliases=["performance capture", "face capture", "lip sync", "actor", "dwpose face", "mocap face"],
            description="Read a real actor's performance from a clip (phone, webcam or any file, with their voice): "
                        "DWPose body, hands and face landmarks on every frame, plus the audio. Saves a performance "
                        "asset that Soundstage · Performance renders onto a character. Needs the performer's consent.",
            inputs=[
                IO.String.Input("source", default="", tooltip='The clip, e.g. "perf_take.mp4 [input]".'),
                IO.String.Input("name", default="take"),
                IO.String.Input("performer", default="", tooltip="Who performs: you, or the actor who agreed."),
                IO.Boolean.Input("consent", default=False, tooltip=A.CONSENT_TEXT),
                IO.Int.Input("max_frames", default=241, min=9, max=481, tooltip="Longest take, in frames at 24 fps."),
                IO.Int.Input("resolution", default=768, min=256, max=2048, step=64, advanced=True,
                             tooltip="DWPose detection size; 768 keeps the face landmarks on a medium shot."),
                IO.String.Input("character", default="", optional=True),
            ],
            outputs=[IO.String.Output(display_name="asset_json"), IO.Image.Output(display_name="overlay")],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, source, name, performer, consent, max_frames, resolution=768, character="") -> IO.NodeOutput:
        A.check_consent(performer, consent)
        _safe_path(source)
        g = GraphBuilder()
        clip, pose = PG.capture(g, {"source": source, "fps": 24.0, "max_frames": int(max_frames),
                                    "resolution": int(resolution)})
        save = g.node("SoundstagePerformanceSave", frames=clip.out(0), pose=pose.out(0), keypoints=pose.out(1),
                      audio=clip.out(1), fps=clip.out(2), name=name, performer=performer, consent=bool(consent),
                      source=source, character=character or "")
        return IO.NodeOutput(save.out(0), save.out(1), expand=g.finalize())

    @classmethod
    def fingerprint_inputs(cls, source, **kw):
        return f"{_mtime(source)}:{json.dumps(kw, sort_keys=True, default=str)}"


# ====================================================================== fit + render

class SoundstagePoseFit(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePoseFit",
            display_name="Soundstage · Fit Pose to Character",
            category="Soundstage/Performance/advanced",
            description="Move and scale a skeleton video so the actor stands where the character stands in the shot "
                        "(same height, centre and top). Boxes are 0-1 frame units [x0, y0, x1, y1]; leave them empty "
                        "to keep the clip's framing.",
            inputs=[IO.Image.Input("pose"), IO.Int.Input("width", default=1280, min=64, max=8192),
                    IO.Int.Input("height", default=720, min=64, max=8192),
                    IO.String.Input("actor_box", default="", optional=True),
                    IO.String.Input("target_box", default="", optional=True)],
            outputs=[IO.Image.Output(display_name="pose")],
        )

    @classmethod
    def execute(cls, pose, width, height, actor_box="", target_box="") -> IO.NodeOutput:
        return IO.NodeOutput(fit_pose(pose, width, height, A.parse_box(actor_box), A.parse_box(target_box)))


class SoundstagePerformance(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePerformance",
            display_name="Soundstage · Performance (real actor → character)",
            category="Soundstage/Performance",
            search_aliases=["performance", "actor", "lip sync", "face", "union control", "drive character"],
            description="Render the shot from its frame with a real actor's performance: their body, hands and face "
                        "(DWPose) through the LTX union-control IC-LoRA, and their voice in the sampler with the "
                        "audio noise mask that keeps lips in sync. The result carries the actor's own voice.",
            inputs=[
                IO.String.Input("asset", default="", tooltip="The performance asset.json (Capture Performance)."),
                IO.String.Input("first_frame", default="", tooltip="The shot's frame with the character in place."),
                IO.String.Input("prompt", default="", multiline=True),
                IO.Combo.Input("quality", options=list(PG.QUALITY), default="Draft",
                               tooltip="Draft 544p one pass. Final 544p + x2 refine. Hollywood 704p + x2 refine."),
                IO.Int.Input("width", default=1280, min=64, max=4096),
                IO.Int.Input("height", default=720, min=64, max=4096),
                IO.Int.Input("seed", default=7, min=0, max=0xFFFFFFFFFFFF, control_after_generate=True),
                IO.String.Input("target_box", default="", optional=True,
                                tooltip="Where the character stands in the frame, [x0,y0,x1,y1] in 0-1. Empty: keep "
                                        "the actor's framing."),
                IO.Float.Input("audio_mask", default=PG.AUDIO_MASK, min=0.0, max=1.0, step=0.05, advanced=True,
                               tooltip="Audio latent noise mask. 0 = frozen (mouths flap unsynced); 0.2-0.5 keeps the "
                                       "audio pathway open so lips follow the voice."),
                IO.String.Input("layout", default="", optional=True, advanced=True,
                                tooltip="Optional stage pass video (clay / depth) screened faintly under the skeleton."),
                IO.Float.Input("layout_mix", default=0.0, min=0.0, max=1.0, step=0.05, optional=True, advanced=True),
                IO.Boolean.Input("keep_voice", default=True, tooltip="Put the actor's voice on the result."),
            ],
            outputs=[IO.Video.Output(display_name="video"), IO.Image.Output(display_name="frames"),
                     IO.Image.Output(display_name="guide")],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, asset, first_frame, prompt, quality, width, height, seed, keep_voice, target_box="",
                audio_mask=PG.AUDIO_MASK, layout="", layout_mix=0.0) -> IO.NodeOutput:
        if not (first_frame or "").strip():
            raise A.PerformanceError("Performance needs the shot's frame: pick or paint one in ④ Frame first.")
        a = load_asset(asset)
        A.require_consent(a)
        _safe_path(first_frame)
        w = _weights(PG.WEIGHTS, "Performance")
        frames = T.ltx_length(int(a.get("frames") or 9))
        fps = float(a.get("fps") or 24.0)
        g = GraphBuilder()
        clip = g.node("SoundstageClipLoad", source=a["files"]["pose"], fps=fps, start_frame=0, max_frames=frames)
        gw, gh = PG.render_size(width, height, quality)
        box = a.get("box")
        fit = g.node("SoundstagePoseFit", pose=clip.out(0), width=gw, height=gh,
                     actor_box=json.dumps(box) if box and A.parse_box(target_box) else "",
                     target_box=target_box if box else "").out(0)
        first = g.node("SoundstageImageLoad", source=first_frame).out(0)
        lay = None
        if (layout or "").strip() and layout_mix > 0:
            lay = g.node("SoundstageClipLoad", source=layout, fps=fps, start_frame=0, max_frames=frames).out(0)
        out = PG.render(g, w, {"pose": fit, "first": first, "audio": clip.out(1) if a.get("has_audio") else None,
                               "frames": frames, "fps": fps, "width": int(width), "height": int(height),
                               "prompt": prompt, "seed": seed, "quality": quality, "audio_mask": float(audio_mask),
                               "layout": lay, "layout_mix": float(layout_mix or 0.0)})
        kw = {"audio": out["audio"]} if keep_voice and out["audio"] is not None else {}
        video = g.node("CreateVideo", images=out["images"], fps=fps, **kw).out(0)
        return IO.NodeOutput(video, out["images"], fit, expand=g.finalize())

    @classmethod
    def fingerprint_inputs(cls, asset, first_frame, **kw):
        return f"{_mtime(asset)}:{_mtime(first_frame)}:{json.dumps(kw, sort_keys=True, default=str)}"


NODES = [SoundstagePerformanceCapture, SoundstagePerformanceSave, SoundstagePoseFit, SoundstagePerformance]
