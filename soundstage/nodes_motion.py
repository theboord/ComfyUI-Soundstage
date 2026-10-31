"""⑤ Motion extras: Ripple edit and Pose follow (docs/ripple.md).

SoundstageClipLoad    a clip by file reference ("dir/x.mp4 [output]", input/output/temp) -> frames retimed to an
                      LTX rate (24 fps), trimmed to 8k+1 frames, its audio cut to match, fps, frames, info JSON.
SoundstageImageLoad   a picture by file reference (or a video's first frame) -> IMAGE.
SoundstageSheetLoad   a stage pass sprite sheet + its grid JSON -> the frame batch (the browser's pose skeletons).
SoundstageRipple      edit frame 1 of any clip, LTX Ripple carries the edit through the whole clip (keeps motion,
                      timing, camera and the clip's own audio). Expands at run time.
SoundstagePoseFollow  LTX-2.5 + union-control IC-LoRA driven by a skeleton video (the stage's clay actors as
                      OpenPose body + hands + face) or DWPose on real footage, from the shot's chosen frame.
"""
import json
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from comfy_api.latest import IO, InputImpl
from comfy_execution.graph_utils import GraphBuilder

from .footage import clip as C
from .footage import graphs as FG
from .motion import graphs as MG
from .motion import timing as T


class MotionError(ValueError):
    """User-facing: shown in the ComfyUI error dialog as is."""


def _safe_path(ref):
    """Resolve an annotated reference ("sub/x.mp4 [output]") inside input/output/temp, never outside them."""
    ref = (ref or "").strip()
    if not ref:
        raise MotionError("No file given.")
    path = os.path.realpath(folder_paths.get_annotated_filepath(ref))
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                           folder_paths.get_temp_directory())]
    if not any(path == r or path.startswith(r + os.sep) for r in roots):
        raise MotionError(f"{ref}: only files in ComfyUI's input, output or temp folders can be used.")
    if not os.path.isfile(path):
        raise MotionError(f"{ref}: file not found on the server.")
    return path


def _mtime(ref):
    try:
        return os.path.getmtime(_safe_path(ref))
    except Exception:
        return ""


def _list_files(folder):
    try:
        return folder_paths.get_filename_list(folder)
    except Exception:
        return []


def _weights(spec, what):
    w = FG.resolve(spec, _list_files)
    miss = FG.missing(w)
    if miss:
        names = ", ".join(f"{spec[r][1][0]} ({spec[r][0]})" for r in miss)
        raise MotionError(f"{what} needs these model files, not found on this server: {names}.")
    return w


# ====================================================================== loaders

class SoundstageClipLoad(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageClipLoad",
            display_name="Soundstage · Load Clip",
            category="Soundstage/Motion/advanced",
            description="Load a clip from input/, output/ or temp/ by its file reference, retimed to an LTX frame rate "
                        "and trimmed to 8k+1 frames, with its audio cut to match.",
            inputs=[
                IO.String.Input("source", default="", tooltip='File reference, e.g. "soundstage/draft_00012_.mp4 [output]".'),
                IO.Float.Input("fps", default=24.0, min=0.0, max=60.0, step=1.0,
                               tooltip="Retime to this rate (nearest frame). 0 = keep the clip's own rate."),
                IO.Int.Input("start_frame", default=0, min=0, max=1_000_000),
                IO.Int.Input("max_frames", default=161, min=0, max=10_000, tooltip="0 = to the end (at the new rate)."),
            ],
            outputs=[IO.Image.Output(display_name="images"), IO.Audio.Output(display_name="audio"),
                     IO.Float.Output(display_name="fps"), IO.Int.Output(display_name="frames"),
                     IO.String.Output(display_name="clip_json")],
        )

    @classmethod
    def execute(cls, source, fps, start_frame, max_frames) -> IO.NodeOutput:
        path = _safe_path(source)
        comp = InputImpl.VideoFromFile(path).get_components()
        src_fps = float(comp.frame_rate) or 24.0
        images = comp.images
        n = images.shape[0]
        if n == 0:
            raise MotionError(f"{source}: no video frames.")
        idx, out_fps = T.retime_indices(n, src_fps, fps, start_frame, max_frames)
        frames = images[idx].contiguous()
        start_s = start_frame / src_fps
        audio = None
        if comp.audio is not None and comp.audio.get("waveform") is not None:
            audio = C.trim_audio(comp.audio, out_fps, int(round(start_s * out_fps)), len(idx))
        info = {"source": source, "fps": out_fps, "source_fps": src_fps, "frames": len(idx), "width": int(frames.shape[2]),
                "height": int(frames.shape[1]), "has_audio": audio is not None, "seconds": round(len(idx) / out_fps, 3)}
        return IO.NodeOutput(frames, audio, out_fps, len(idx), json.dumps(info))

    @classmethod
    def fingerprint_inputs(cls, source, **kw):
        return _mtime(source)


def _load_image(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"):
        comp = InputImpl.VideoFromFile(path).get_components()
        return comp.images[:1].contiguous()
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)[None]


class SoundstageImageLoad(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageImageLoad",
            display_name="Soundstage · Load Picture",
            category="Soundstage/Motion/advanced",
            description="Load a picture from input/, output/ or temp/ by its file reference (a video gives its first frame).",
            inputs=[IO.String.Input("source", default="", tooltip='e.g. "soundstage_refs/frame1_edit.png [input]".')],
            outputs=[IO.Image.Output(display_name="image")],
        )

    @classmethod
    def execute(cls, source) -> IO.NodeOutput:
        return IO.NodeOutput(_load_image(_safe_path(source)))

    @classmethod
    def fingerprint_inputs(cls, source, **kw):
        return _mtime(source)


class SoundstageSheetLoad(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageSheetLoad",
            display_name="Soundstage · Load Pass Sheet",
            category="Soundstage/Motion/advanced",
            description="Slice a stage pass sprite sheet (row-major tiles) into its frames.",
            inputs=[IO.String.Input("source", default=""),
                    IO.String.Input("grid", default="", tooltip='{"cols":..,"frames":..,"tile":[w,h]}')],
            outputs=[IO.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, source, grid) -> IO.NodeOutput:
        try:
            gr = json.loads(grid) if grid else None
        except ValueError as e:
            raise MotionError(f"Bad sheet grid JSON: {e}")
        sheet = _load_image(_safe_path(source))
        return IO.NodeOutput(T.slice_sheet(sheet, gr))

    @classmethod
    def fingerprint_inputs(cls, source, **kw):
        return _mtime(source)


# ====================================================================== Ripple

class SoundstageRipple(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageRipple",
            display_name="Soundstage · Ripple Edit",
            category="Soundstage/Motion",
            search_aliases=["ripple", "first frame edit", "ffaf", "propagate edit", "video edit", "relight video"],
            description="Edit frame 1 of any clip (swap a face, change wardrobe or background, relight) and LTX Ripple "
                        "carries the edit through the whole clip, keeping its motion, timing, camera and audio.",
            inputs=[
                IO.String.Input("source", default="", tooltip='The clip: "soundstage/draft_00012_.mp4 [output]", an imported clip in input/...'),
                IO.String.Input("edited_frame", default="", tooltip="Frame 1 after your edit (Paint Studio saves it in input/soundstage_refs/)."),
                IO.String.Input("prompt", default="", multiline=True, optional=True,
                                tooltip="Optional: what changed (helps hard edits). The Ripple instruction is always added."),
                IO.Float.Input("edit_strength", default=MG.RIPPLE_STRENGTH, min=0.0, max=3.0, step=0.05,
                               tooltip="Ripple LoRA strength (1.35 recommended). Raise it if the edit doesn't carry; "
                                       "lower it if parts you didn't edit change."),
                IO.Combo.Input("quality", options=list(MG.QUALITY), default="Draft",
                               tooltip="Draft: shorter side 544 px. Final: 768 px. 25 steps either way."),
                IO.Int.Input("seed", default=7, min=0, max=0xFFFFFFFFFFFF, control_after_generate=True),
                IO.Int.Input("max_frames", default=161, min=9, max=481, tooltip="Longest clip, in frames at 24 fps."),
                IO.Combo.Input("color_match", options=list(MG.COLOR_MATCH), default="off", advanced=True,
                               tooltip="Match the result's colours to the edited frame or to the source. Off keeps a relight."),
                IO.Boolean.Input("keep_audio", default=True, tooltip="Put the clip's own audio back on the result."),
            ],
            outputs=[IO.Video.Output(display_name="video"), IO.Image.Output(display_name="frames"),
                     IO.String.Output(display_name="clip_json")],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, source, edited_frame, edit_strength, quality, seed, max_frames, keep_audio, prompt="",
                color_match="off") -> IO.NodeOutput:
        if not (source or "").strip():
            raise MotionError("Ripple needs a clip: pick a draft, a final or an imported clip.")
        if not (edited_frame or "").strip():
            raise MotionError("Ripple needs your edited frame 1: use “Edit first frame” first.")
        _safe_path(source)
        _safe_path(edited_frame)
        w = _weights(MG.RIPPLE_WEIGHTS, "Ripple")
        path = _safe_path(source)
        comp = InputImpl.VideoFromFile(path).get_components()
        n, H, W = int(comp.images.shape[0]), int(comp.images.shape[1]), int(comp.images.shape[2])
        idx, fps = T.retime_indices(n, float(comp.frame_rate) or 24.0, 24.0, 0, max_frames)
        g = GraphBuilder()
        clip = g.node("SoundstageClipLoad", source=source, fps=24.0, start_frame=0, max_frames=int(max_frames))
        edited = g.node("SoundstageImageLoad", source=edited_frame).out(0)
        frames = MG.ripple(g, w, {"images": clip.out(0), "edited": edited, "frames": len(idx), "fps": fps,
                                  "width": W, "height": H, "prompt": prompt, "seed": seed, "strength": edit_strength,
                                  "quality": quality, "color_match": color_match})
        kw = {"audio": clip.out(1)} if keep_audio else {}
        video = g.node("CreateVideo", images=frames, fps=fps, **kw).out(0)
        return IO.NodeOutput(video, frames, clip.out(4), expand=g.finalize())


# ====================================================================== Pose follow

class SoundstagePoseFollow(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePoseFollow",
            display_name="Soundstage · Pose Follow (experimental)",
            category="Soundstage/Motion",
            search_aliases=["pose", "openpose", "dwpose", "union control", "body hands face"],
            description="Animate the shot's frame with LTX-2.5 following a pose video: the stage's clay actors as "
                        "OpenPose skeletons (body + hands + face), or DWPose read from real footage. Uses the LTX "
                        "union-control IC-LoRA (made for LTX 2.3; experimental on 2.5).",
            inputs=[
                IO.String.Input("first_frame", default="", tooltip="The shot's chosen frame (file reference)."),
                IO.String.Input("pose_sheet", default="", optional=True, tooltip="Skeleton sprite sheet from the stage."),
                IO.String.Input("grid", default="", optional=True, tooltip="The sheet's grid JSON."),
                IO.String.Input("source", default="", optional=True, tooltip="Or real footage: DWPose reads the pose from it."),
                IO.String.Input("prompt", default="", multiline=True),
                IO.Float.Input("fps", default=24.0, min=1.0, max=60.0),
                IO.Int.Input("width", default=1280, min=64, max=4096),
                IO.Int.Input("height", default=720, min=64, max=4096),
                IO.Combo.Input("quality", options=["Draft", "Final"], default="Draft"),
                IO.Int.Input("seed", default=7, min=0, max=0xFFFFFFFFFFFF, control_after_generate=True),
                IO.Int.Input("max_frames", default=121, min=9, max=481),
            ],
            outputs=[IO.Video.Output(display_name="video"), IO.Image.Output(display_name="frames"),
                     IO.Image.Output(display_name="pose")],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, first_frame, prompt, fps, width, height, quality, seed, max_frames, pose_sheet="", grid="",
                source="") -> IO.NodeOutput:
        if not (first_frame or "").strip():
            raise MotionError("Pose follow needs the shot's frame: pick one in ④ Frame first.")
        if not (pose_sheet or "").strip() and not (source or "").strip():
            raise MotionError("Pose follow needs the stage's skeleton video or a clip to read the pose from.")
        w = _weights(MG.POSE_WEIGHTS, "Pose follow")
        g = GraphBuilder()
        first = g.node("SoundstageImageLoad", source=first_frame).out(0)
        p = {"first": first, "fps": float(fps), "width": int(width), "height": int(height), "prompt": prompt,
             "negative": "", "seed": seed, "draft": quality == "Draft"}
        if (pose_sheet or "").strip():
            frames = g.node("SoundstageSheetLoad", source=pose_sheet, grid=grid or "").out(0)
            n = T.sheet_frames(grid)
            if n and n > max_frames:
                frames = g.node("ImageFromBatch", image=frames, batch_index=0, length=T.ltx_length(max_frames)).out(0)
            elif n and T.ltx_length(n) != n:
                frames = g.node("ImageFromBatch", image=frames, batch_index=0, length=T.ltx_length(n)).out(0)
            p["guide"] = frames
            pose_vis = frames
        else:
            clip = g.node("SoundstageClipLoad", source=source, fps=float(fps), start_frame=0, max_frames=int(max_frames))
            p["images"] = clip.out(0)
            pose_vis = None
        out = MG.pose_follow(g, w, p)
        if pose_vis is None:
            pose_vis = out
        video = g.node("CreateVideo", images=out, fps=float(fps)).out(0)
        return IO.NodeOutput(video, out, pose_vis, expand=g.finalize())


NODES = [SoundstageClipLoad, SoundstageImageLoad, SoundstageSheetLoad, SoundstageRipple, SoundstagePoseFollow]
