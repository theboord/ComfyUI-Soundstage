"""Soundstage · Quality: one node that turns two App controls into the LTX-2.5 Layout-to-Render knobs.

Inputs  motion_freedom (0..1), quality (Draft | Final HQ), the clay guide video, the Look's motion prompt and the
        stage scene JSON.
Outputs the (softened) guide video, IC-LoRA guide strengths for stage 1 and 2 (always 1.0: below 1 LTX renders the
        clay itself), the two sigma schedules, the motion prompt (HQ appends subject-aware physical-motion language)
        and the IC-LoRA model strength.

At motion_freedom 0 + Draft every output is exactly today's value and the guide tensor passes through untouched,
so the App renders bit-for-bit what it rendered before. See soundstage/quality.py for the mapping.
"""
from __future__ import annotations

import json
import logging
import os

import torch
from comfy_api.latest import IO, UI

from . import ltx_settings as L
from . import quality as Q

QUALITIES = ["Draft", "Final HQ", "Final", "Hollywood"]   # appended, so saved workflows keep their values


def settings_for(quality: str, advanced: str | None) -> dict:
    return L.from_quality(quality, advanced)


def _resize(images: torch.Tensor, w: int, h: int) -> torch.Tensor:
    """[B,H,W,C] -> [B,h,w,C], bicubic on torch (the CPU lanczos resize took ~60 s for a 121-frame guide), in chunks."""
    if images.shape[1] == h and images.shape[2] == w:
        return images
    import comfy.utils
    out = []
    for i in range(0, images.shape[0], 16):
        t = images[i:i + 16].movedim(-1, 1)
        out.append(comfy.utils.common_upscale(t, w, h, "bicubic", "disabled").movedim(1, -1).clamp(0, 1))
    return torch.cat(out, 0)


def _retime(images: torch.Tensor, src_fps: float, fps: float) -> torch.Tensor:
    """Nearest-frame retime of the clay guide to the render rate, trimmed to 8k+1 frames (LTX)."""
    n = images.shape[0]
    if not fps or abs(fps - src_fps) < 1e-3 or n < 2:
        return images
    dur = (n - 1) / src_fps
    m = int(dur * fps) + 1
    m = max(9, (m - 1) // 8 * 8 + 1)
    idx = [min(n - 1, int(round(i * src_fps / fps))) for i in range(m)]
    return images[idx]


def _gaussian_blur(images: torch.Tensor, radius: int) -> torch.Tensor:
    """Separable Gaussian blur on a [B, H, W, C] image batch (radius in px, sigma = radius / 2)."""
    if radius <= 0:
        return images
    sigma = max(radius / 2.0, 0.5)
    x = torch.arange(-radius, radius + 1, dtype=torch.float32, device=images.device)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    k = (k / k.sum()).to(images.dtype)
    c = images.shape[-1]
    t = images.permute(0, 3, 1, 2)  # B C H W
    t = torch.nn.functional.pad(t, (radius, radius, radius, radius), mode="replicate")
    t = torch.nn.functional.conv2d(t, k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    t = torch.nn.functional.conv2d(t, k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)
    return t.permute(0, 2, 3, 1).clamp(0, 1)


class SoundstageQuality(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageQuality",
            display_name="Soundstage · Quality (motion freedom)",
            category="Soundstage",
            description="How literally LTX follows the clay previz, and Draft vs Final HQ sampling. 0 + Draft = the "
                        "exact previous behaviour.",
            inputs=[
                IO.Float.Input("motion_freedom", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="0 = follow the blocking exactly. Higher = a looser, softer clay guide so LTX "
                                       "redraws stiff previz motion (gait, limbs, weight) while keeping composition "
                                       "and camera. 0.3-0.5 is a good range for animals and action."),
                IO.Combo.Input("quality", options=QUALITIES, default="Final",
                               tooltip="Draft = 8 + 3 distilled steps (quick look, faces readable). Final = 12 + 6 "
                                       "(clean motion and detail, the default). Final HQ = 18 + 12 for hero shots. "
                                       "Final and Final HQ add physical-motion language for the cast."),
                IO.Image.Input("guide", tooltip="The stage clay frames that steer LTX (IC-LoRA guide)."),
                IO.String.Input("motion_prompt", multiline=True, force_input=True),
                IO.String.Input("scene_json", multiline=True, force_input=True, optional=True),
                IO.String.Input("advanced", default="", multiline=True, optional=True,
                                tooltip="Per-shot LTX settings from the App's Advanced (LTX) pop-over, as JSON "
                                        "(resolution, steps, two-stage, temporal x2, CFG, seed, decode tiles, codec…). "
                                        "Empty = the quality preset."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, force_input=True, optional=True,
                               tooltip="The shot's frame rate (the clay guide's)."),
            ],
            outputs=[
                IO.Image.Output("out_guide"),
                IO.Float.Output("guide_strength_1"),
                IO.Float.Output("guide_strength_2"),
                IO.String.Output("sigmas_1"),
                IO.String.Output("sigmas_2"),
                IO.String.Output("out_motion_prompt"),
                IO.Float.Output("lora_strength"),
                IO.String.Output("settings_json"),
                IO.Boolean.Output("two_stage"),
                IO.Boolean.Output("temporal_x2"),
                IO.Float.Output("cfg"),
                IO.Int.Output("seed"),
                IO.Float.Output("fps_out"),
                IO.Int.Output("tile_size"),
                IO.Int.Output("overlap"),
                IO.Int.Output("temporal_size"),
                IO.Int.Output("temporal_overlap"),
                IO.Float.Output("fps_final"),
            ],
        )

    @classmethod
    def execute(cls, motion_freedom, quality, guide, motion_prompt, scene_json=None, advanced="",
                fps=None) -> IO.NodeOutput:
        st = settings_for(quality, advanced)
        tier = "draft" if st["preset"] == "Draft" else "final"
        k = Q.knobs(motion_freedom, tier=tier)
        s1, s2 = L.schedules(st)
        src_fps = float(fps or 24.0)
        out_fps = float(st.get("fps") or src_fps)
        g = _retime(guide, src_fps, out_fps)
        sz = L.stage_sizes(int(g.shape[2]), int(g.shape[1]), st)
        g = _resize(_gaussian_blur(g, k["guide_blur"]), *sz["stage1"])
        lora = st["ic_lora"] if st.get("ic_lora") is not None else k["lora_strength"]
        dec = {**{"tile_size": 512, "overlap": 64, "temporal_size": 128, "temporal_overlap": 32}, **(st.get("decode") or {})}
        seed = int(st["seed"]) if st.get("seed") is not None else 42
        prompt = motion_prompt
        if tier != "draft" and scene_json:
            try:
                scene = json.loads(scene_json)
                extra = Q.motion_prompt(scene.get("scene", scene) if isinstance(scene, dict) else {})
            except (json.JSONDecodeError, TypeError, AttributeError):
                extra = ""
            if extra:
                prompt = f"{motion_prompt.rstrip()} {extra}".strip()
        st.update({"stage1": list(sz["stage1"]), "output": list(sz["output"]), "fps_render": out_fps,
                   "sigmas_1": s1, "sigmas_2": s2, "ic_lora": lora, "seed": seed})
        final_fps = out_fps * (2 if st["temporal_x2"] else 1)
        return IO.NodeOutput(g, k["guide_strength_1"], k["guide_strength_2"], s1, s2, prompt, float(lora),
                             json.dumps(st), st["two_stage"], st["temporal_x2"], st["cfg"], seed, out_fps,
                             int(dec["tile_size"]), int(dec["overlap"]), int(dec["temporal_size"]),
                             int(dec["temporal_overlap"]), final_fps)


def _encode_prores(path, images, fps, audio=None, metadata=None):
    """ProRes 422 HQ (prores_ks profile 3, 10-bit 4:2:2) in a .mov, with 24-bit PCM audio when there is sound."""
    import av
    import numpy as np
    from fractions import Fraction
    rate = Fraction(round(float(fps) * 1000), 1000)
    with av.open(path, mode="w", format="mov") as out:
        for k, v in (metadata or {}).items():
            out.metadata[k] = v if isinstance(v, str) else json.dumps(v)
        vs = out.add_stream("prores_ks", rate=rate)
        vs.width, vs.height = int(images.shape[2]), int(images.shape[1])
        vs.pix_fmt = "yuv422p10le"
        vs.options = {"profile": "3", "vendor": "apl0", "bits_per_mb": "8000"}
        astream = None
        if audio is not None and audio.get("waveform") is not None:
            sr = int(audio["sample_rate"])
            wav = audio["waveform"][0].float().cpu().numpy()
            layout = "stereo" if wav.shape[0] > 1 else "mono"
            astream = out.add_stream("pcm_s24le", rate=sr, layout=layout)
        for i in range(images.shape[0]):
            arr = (images[i].clamp(0, 1).cpu().numpy() * 65535.0 + 0.5).astype(np.uint16)
            fr = av.VideoFrame.from_ndarray(arr, format="rgb48le")
            for pkt in vs.encode(fr.reformat(format="yuv422p10le")):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        if astream is not None:
            n = int(round(images.shape[0] / float(fps) * sr))
            wav = wav[:2 if layout == "stereo" else 1, :n]
            pcm = (np.clip(wav, -1, 1) * 2147483647).astype(np.int32)
            af = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm.T.reshape(1, -1)) if layout == "stereo" else pcm[:1],
                                            format="s32", layout=layout)
            af.sample_rate = sr
            for pkt in astream.encode(af):
                out.mux(pkt)
            for pkt in astream.encode():
                out.mux(pkt)


class SoundstageSaveVideo(IO.ComfyNode):
    """Save a final with the App's per-shot codec settings: H.264 at a chosen CRF (high bitrate by default), or a
    ProRes 422 HQ master (.mov, for the NLE) plus an H.264 preview the App plays."""

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageSaveVideo",
            display_name="Soundstage · Save Final",
            category="Soundstage",
            search_aliases=["save video", "prores", "master", "crf"],
            description="Save a video as H.264 (CRF from the settings; lower = better) or as a ProRes 422 HQ master "
                        "with an H.264 preview. Takes the Quality node's settings_json.",
            inputs=[
                IO.Video.Input("video"),
                IO.String.Input("filename_prefix", default="soundstage/final"),
                IO.String.Input("settings_json", default="", force_input=True, optional=True),
            ],
            hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[IO.Video.Output("video")],
        )

    @classmethod
    def execute(cls, video, filename_prefix, settings_json="") -> IO.NodeOutput:
        import folder_paths
        from comfy_api.latest import Types
        try:
            st = json.loads(settings_json) if settings_json else {}
        except ValueError:
            st = {}
        codec = st.get("codec") if st.get("codec") in L.CODECS else "h264"
        crf = int(min(51, max(0, int(st.get("crf", 14)))))
        w, h = video.get_dimensions()
        folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), w, h)
        meta = {}
        if cls.hidden.extra_pnginfo is not None:
            meta.update(cls.hidden.extra_pnginfo)
        if cls.hidden.prompt is not None:
            meta["prompt"] = cls.hidden.prompt
        file = f"{name}_{counter:05}_.mp4"
        video.save_to(os.path.join(folder, file), format=Types.VideoContainer("mp4"), codec=Types.VideoCodec("h264"),
                      metadata=meta or None, crf=crf)
        ui = UI.PreviewVideo([UI.SavedResult(file, subfolder, IO.FolderType.output)])
        if codec == "prores_hq":
            master = f"{name}_{counter:05}_.mov"
            try:
                comp = video.get_components()
                _encode_prores(os.path.join(folder, master), comp.images, float(comp.frame_rate), comp.audio, meta)
                ui = {**ui.as_dict(), "master": [{"filename": master, "subfolder": subfolder, "type": "output"}]}
            except Exception as e:  # the H.264 is saved; say why the master is missing
                logging.exception("Soundstage: ProRes master failed: %s", e)
        return IO.NodeOutput(video, ui=ui)


class SoundstageLTXLoRA(IO.ComfyNode):
    """An optional extra LoRA on the LTX model, set per shot from the App's Advanced (LTX) pop-over."""

    @classmethod
    def define_schema(cls) -> IO.Schema:
        import folder_paths
        try:
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        return IO.Schema(
            node_id="SoundstageLTXLoRA",
            display_name="Soundstage · Extra LTX LoRA",
            category="Soundstage",
            description="Apply one extra LoRA (style, character, detail) on the LTX model. The settings_json from the "
                        "Quality node wins when it names one; None = the model passes through.",
            inputs=[
                IO.Model.Input("model"),
                IO.Combo.Input("lora_name", options=["None", *names], default="None"),
                IO.Float.Input("strength", default=0.8, min=-4.0, max=4.0, step=0.05),
                IO.String.Input("settings_json", default="", force_input=True, optional=True),
            ],
            outputs=[IO.Model.Output("model")],
        )

    @classmethod
    def execute(cls, model, lora_name="None", strength=0.8, settings_json="") -> IO.NodeOutput:
        try:
            extra = (json.loads(settings_json) if settings_json else {}).get("extra_lora") or {}
        except ValueError:
            extra = {}
        name = extra.get("name") or lora_name
        strength = float(extra.get("strength", strength))
        if not name or name == "None" or strength == 0:
            return IO.NodeOutput(model)
        import comfy.sd
        import comfy.utils
        import folder_paths
        path = folder_paths.get_full_path("loras", name)
        if not path:
            raise ValueError(f"Extra LoRA not found on this server: {name}")
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        m, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
        return IO.NodeOutput(m)


NODES = [SoundstageQuality, SoundstageSaveVideo, SoundstageLTXLoRA]
