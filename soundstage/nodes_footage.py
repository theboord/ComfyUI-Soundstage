"""Soundstage Footage in + Recast: video-to-video character swap.

SoundstageFootage  load a clip -> frames, fps, audio, plus per-person SAM 3.1 tracks seeded by a text
                   prompt or click points; outputs the subject's MASK batch, everyone else's, and a footage JSON.
SoundstageRecast   swap the subject for a character with the chosen engine, then composite only the
                   swapped subject back over the real plate (background and other people stay real).
                   Default engine = the open LTX-2.5 union-control + SAM3 + DWPose graph, kept
                   original audio, expanded at run time (docs/recast.md).

Helper nodes the two expand into (usable on their own too): SoundstageFootageDecode, SoundstageTrackSelect,
SoundstageRecastComposite.
"""
import json
import os

import torch

import folder_paths
import nodes
from comfy_api.latest import IO, InputImpl
from comfy_execution.graph_utils import GraphBuilder

from .footage import clip as C
from .footage import graphs as GR
from .footage import matte as M

SAM3TrackData = IO.Custom("SAM3_TRACK_DATA")


def _list_files(folder):
    try:
        return folder_paths.get_filename_list(folder)
    except Exception:
        return []


def _input_videos():
    d = folder_paths.get_input_directory()
    try:
        files = [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]
    except OSError:
        return []
    return sorted(folder_paths.filter_files_content_types(files, ["video"]))


def _sam3_ckpts():
    return [f for f in _list_files("checkpoints") if "sam3" in f.lower()] or ["sam3.1_multiplex_fp16.safetensors"]


class RecastError(ValueError):
    """User-facing: shown in the ComfyUI error dialog as is."""


# ====================================================================== Footage

class SoundstageFootageDecode(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFootageDecode",
            display_name="Soundstage · Footage Decode",
            category="Soundstage/Footage/advanced",
            description="Decode a clip to frames + audio, trimmed to an LTX-friendly length (8k+1 frames).",
            inputs=[
                IO.Combo.Input("file", options=_input_videos() or [""], upload=IO.UploadType.video),
                IO.Video.Input("video", optional=True, tooltip="Overrides the file (e.g. a Load Video or a render)."),
                IO.Int.Input("start_frame", default=0, min=0, max=1_000_000),
                IO.Int.Input("max_frames", default=97, min=0, max=10_000, tooltip="0 = to the end."),
                IO.Boolean.Input("ltx_length", default=True, tooltip="Trim to 8k+1 frames (what LTX needs)."),
            ],
            outputs=[
                IO.Image.Output(display_name="images"),
                IO.Audio.Output(display_name="audio"),
                IO.Float.Output(display_name="fps"),
                IO.Int.Output(display_name="frames"),
                IO.String.Output(display_name="footage_json"),
            ],
        )

    @classmethod
    def execute(cls, file, start_frame, max_frames, ltx_length, video=None) -> IO.NodeOutput:
        source = "connected video"
        if video is None:
            if not file:
                raise RecastError("No footage: upload a clip on Soundstage · Footage or connect a video.")
            video = InputImpl.VideoFromFile(folder_paths.get_annotated_filepath(file))
            source = file
        comp = video.get_components()
        fps = float(comp.frame_rate)
        images = comp.images
        start, count = C.trim_plan(images.shape[0], start_frame, max_frames, ltx_length)
        images = images[start:start + count].contiguous()
        audio = C.trim_audio(comp.audio, fps, start, count)
        js = C.footage_json(source, fps, start, count, images.shape[2], images.shape[1], audio is not None)
        return IO.NodeOutput(images, audio, fps, count, js)

    @classmethod
    def fingerprint_inputs(cls, file, video=None, **kw):
        if video is not None or not file:
            return ""
        try:
            return os.path.getmtime(folder_paths.get_annotated_filepath(file))
        except OSError:
            return ""


class SoundstageTrackSelect(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageTrackSelect",
            display_name="Soundstage · Pick Subject from SAM3 Tracks",
            category="Soundstage/Footage/advanced",
            description="Split SAM 3 tracks into the subject (to recast) and everyone else (kept real).",
            inputs=[
                SAM3TrackData.Input("track_data"),
                IO.Int.Input("subject", default=-1, min=-1, max=63,
                             tooltip="Track index to recast. -1 = the person with the most screen time/area. "
                                     "With click points the clicked person is track 0."),
                IO.String.Input("footage_json", default="", optional=True, force_input=True),
                IO.String.Input("subject_prompt", default="", optional=True, advanced=True),
                IO.String.Input("points", default="", optional=True, advanced=True),
                IO.Mask.Input("match_mask", optional=True,
                              tooltip="Pick the track that overlaps this mask most (subject = -1)."),
            ],
            outputs=[
                IO.Mask.Output(display_name="subject_mask"),
                IO.Mask.Output(display_name="others_mask"),
                IO.String.Output(display_name="footage_json"),
            ],
        )

    @classmethod
    def execute(cls, track_data, subject, footage_json="", subject_prompt="", points="",
                match_mask=None) -> IO.NodeOutput:
        packed = track_data.get("packed_masks")
        h, w = track_data["orig_size"]
        n = track_data["n_frames"]
        if packed is None:
            objs = torch.zeros(n, 0, h, w)
        else:
            from comfy.ldm.sam3.tracker import unpack_masks
            per = [unpack_masks(packed[:, i]).float() for i in range(packed.shape[1])]
            objs = torch.stack(per, 1)  # [N, K, Hm, Wm]
            if objs.shape[-2:] != (h, w):
                objs = torch.nn.functional.interpolate(objs, size=(h, w), mode="bilinear", align_corners=False)
        sub, oth, idx, stats = C.select_subject(objs.cpu(), int(subject),
                                                None if match_mask is None else match_mask.cpu())
        if idx < 0:
            raise RecastError("SAM 3 found nobody to recast. Change the subject prompt, lower the threshold, "
                              "or click on the person (points).")
        js = C.merge_json(footage_json, subject_prompt=subject_prompt or None,
                          points=json.loads(points) if points else None, subject_index=idx, tracks=stats)
        return IO.NodeOutput(sub, oth, js)


class SoundstageFootage(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFootage",
            display_name="Soundstage · Footage",
            category="Soundstage/Footage",
            search_aliases=["load footage", "video in", "plate", "track person", "sam3 track", "recast source"],
            description="Bring real footage onto the stage: frames, fps and original audio, plus SAM 3.1 tracks "
                        "of every person. Pick who to recast with a text prompt or by clicking them on frame 1.",
            inputs=[
                IO.Combo.Input("file", options=_input_videos() or [""], upload=IO.UploadType.video),
                IO.Video.Input("video", optional=True, lazy=True, raw_link=True,
                               tooltip="Optional: use a connected video instead of the file."),
                IO.Int.Input("start_frame", default=0, min=0, max=1_000_000),
                IO.Int.Input("max_frames", default=97, min=0, max=10_000,
                             tooltip="Frames to use (97 = 4 s at 24 fps). Trimmed to 8k+1 for LTX."),
                IO.String.Input("subject_prompt", default="person",
                                tooltip="What to track (SAM 3 text prompt): 'person', 'woman in yellow coat'..."),
                IO.String.Input("points", default="", optional=True,
                                tooltip='Click points on frame 1, pixel coords: [{"x":640,"y":360}]. The clicked '
                                        "person becomes the subject."),
                IO.String.Input("negative_points", default="", optional=True, advanced=True),
                IO.Int.Input("subject", default=-1, min=-1, max=63,
                             tooltip="Which track to recast. -1 = auto (clicked person, else the most on-screen)."),
                IO.Int.Input("max_people", default=4, min=1, max=16, advanced=True),
                IO.Float.Input("threshold", default=0.5, min=0.05, max=0.95, step=0.01, advanced=True),
                IO.Combo.Input("sam3_model", options=_sam3_ckpts(), advanced=True),
            ],
            outputs=[
                IO.Image.Output(display_name="images"),
                IO.Mask.Output(display_name="subject_mask", tooltip="The person to recast, every frame."),
                IO.Mask.Output(display_name="others_mask", tooltip="Everyone else (kept real in the composite)."),
                IO.Audio.Output(display_name="audio"),
                IO.Float.Output(display_name="fps"),
                IO.Int.Output(display_name="frames"),
                IO.String.Output(display_name="footage_json"),
            ],
            enable_expand=True,
        )

    @classmethod
    def check_lazy_status(cls, **kw):
        return []  # the video link is forwarded into the expansion

    @classmethod
    def execute(cls, file, start_frame, max_frames, subject_prompt, subject, max_people, threshold, sam3_model,
                points="", negative_points="", video=None) -> IO.NodeOutput:
        pts = C.parse_points(points)
        neg = C.parse_points(negative_points)
        g = GraphBuilder()
        dec_in = {"file": file, "start_frame": start_frame, "max_frames": max_frames, "ltx_length": True}
        if video is not None:
            dec_in["video"] = video
        dec = g.node("SoundstageFootageDecode", **dec_in)
        track = GR.sam3_track(g, dec.out(0), sam3_model, subject_prompt, threshold, max_people, pts, neg)
        sel = g.node("SoundstageTrackSelect", track_data=track, subject=0 if (pts and subject < 0) else subject,
                     footage_json=dec.out(4), subject_prompt=subject_prompt, points=pts or "")
        return IO.NodeOutput(dec.out(0), sel.out(0), sel.out(1), dec.out(1), dec.out(2), dec.out(3), sel.out(2),
                             expand=g.finalize())


# ====================================================================== Composite

class SoundstageRecastComposite(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageRecastComposite",
            display_name="Soundstage · Recast Composite",
            category="Soundstage/Footage/advanced",
            search_aliases=["stage 2 composite", "comp swap over plate", "matte composite"],
            description="Put only the swapped subject back over the original plate: union of the old and new "
                        "silhouettes, dilated, steadied over time, feathered, other people cut back out, edge "
                        "colour matched. Output is at the plate's size and length.",
            inputs=[
                IO.Image.Input("plate", tooltip="Original footage frames."),
                IO.Image.Input("swap", tooltip="Engine output (any size; resized to the plate)."),
                IO.Mask.Input("subject_mask", tooltip="Subject in the original plate (SAM 3)."),
                IO.Mask.Input("swap_subject_mask", optional=True,
                              tooltip="Subject found in the swap (its new outline). Optional."),
                IO.Mask.Input("others_mask", optional=True, tooltip="Other people: always kept from the plate."),
                IO.Int.Input("grow", default=12, min=0, max=256, tooltip="Dilate the matte (px at plate size)."),
                IO.Int.Input("feather", default=10, min=0, max=256, tooltip="Soft edge width (px)."),
                IO.Int.Input("temporal", default=1, min=0, max=8,
                             tooltip="Average the matte over ±N frames to stop edge boil."),
                IO.Boolean.Input("match_color", default=False,
                                 tooltip="Nudge the swap's colour toward the plate around the matte edge "
                                         "(±5%). Off by default: when the engine drifts the background the "
                                         "ring is not a fair sample."),
                IO.Combo.Input("framing", options=["stretch", "cover"], default="stretch",
                               tooltip="stretch: the swap shows the whole plate. cover: the swap is a centred "
                                       "crop of the plate (graphs that snap with ResizeImageMask 'scale to "
                                       "multiple', e.g. the original union-control graph)."),
            ],
            outputs=[
                IO.Image.Output(display_name="composite"),
                IO.Image.Output(display_name="layer", tooltip="Swapped subject RGBA (for the Layer Pack)."),
                IO.Mask.Output(display_name="layer_mask"),
            ],
        )

    @classmethod
    def execute(cls, plate, swap, subject_mask, grow, feather, temporal, match_color, framing="stretch",
                swap_subject_mask=None, others_mask=None) -> IO.NodeOutput:
        comp, layer, alpha = M.composite(plate, swap, subject_mask, swap_subject_mask, others_mask, grow, feather,
                                         temporal, match_color, framing)
        return IO.NodeOutput(comp, layer, alpha)


# ====================================================================== Recast

ENGINE_LTX = "LTX-2.5 union control (open)"
ENGINE_WAN = "Wan 2.2 Animate 2 (open)"
ENGINE_OJ_API = "Openjutsu · MiniMax H3 API (partner)"
ENGINE_OJ_LOCAL = "Openjutsu · local H3 (license: not for US use)"
ENGINES = [ENGINE_LTX, ENGINE_WAN, ENGINE_OJ_API, ENGINE_OJ_LOCAL]


def _engine_input():
    opts = [
        IO.DynamicCombo.Option(ENGINE_LTX, [
            IO.Combo.Input("quality", options=["final (2x upscale)", "draft (544p, 1 stage)"],
                           default="final (2x upscale)"),
            IO.Float.Input("likeness", default=4.0, min=0.0, max=10.0, step=0.05,
                           tooltip="Frame-1 recast (Krea 2 Identity Edit): how hard to hold the character."),
            IO.Float.Input("hold_blocking", default=1.0, min=0.0, max=4.0, step=0.05,
                           tooltip="Frame-1 recast: how hard to hold the plate's pose and framing."),
        ]),
        IO.DynamicCombo.Option(ENGINE_WAN, []),
        IO.DynamicCombo.Option(ENGINE_OJ_API, [
            IO.Combo.Input("model", options=["MiniMax H3", "MiniMax H3 Max"], default="MiniMax H3"),
            IO.Combo.Input("resolution", options=["768P", "2K", "480P"], default="768P",
                           tooltip="H3: 768P or 2K. H3 Max: 480P or 768P."),
            IO.Boolean.Input("send_first_frame", default=True,
                             tooltip="Also send the recast frame 1 (Krea 2 edit) as Image 2, like Openjutsu's anchor."),
        ]),
        IO.DynamicCombo.Option(ENGINE_OJ_LOCAL, [
            IO.Boolean.Input("use_anchor", default=True,
                             tooltip="Use the recast frame 1 as Openjutsu's anchor image."),
        ]),
    ]
    from .router import registry as R
    if R.open_weights_only():  # open weights only by default; SOUNDSTAGE_PARTNER_MODELS=1 lists the API engine
        opts = [o for o in opts if o.key != ENGINE_OJ_API]
    return IO.DynamicCombo.Input(
        "engine", options=opts,
        tooltip="LTX-2.5 union control: open weights, local, keeps the original audio (default). "
                "Wan 2.2 Animate 2: open weights (Apache-2.0), needs its weights installed. "
                "Openjutsu · MiniMax H3 API: Comfy's Openjutsu model (H3 reference-to-video) hosted by MiniMax "
                "through the Comfy partner node; paid (Comfy credits), covered by MiniMax's API terms; listed only "
                "with SOUNDSTAGE_PARTNER_MODELS=1. "
                "Openjutsu · local H3: Comfy's Openjutsu workflow on local H3 weights + the GPL h3_character_swap "
                "node pack. The H3 Community License excludes the USA, EU, UK and South Korea, so it only runs "
                f"when {GR.H3_LICENSE_ENV}=1 says you are licensed (outside those territories, or a MiniMax/Comfy "
                "commercial licence).")


def _media(io_type, name, tooltip, optional=False):
    return io_type.Input(name, optional=optional, lazy=True, raw_link=True, tooltip=tooltip)


class SoundstageRecast(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageRecast",
            display_name="Soundstage · Recast (character swap)",
            category="Soundstage/Footage",
            search_aliases=["character swap", "recast", "replace actor", "video to video", "v2v", "openjutsu",
                            "minimax h3", "wan animate", "ltx union control"],
            description="Swap the tracked person in real footage for a new character, then composite only them "
                        "back over the plate. Everyone and everything else stays real; the original audio is kept.",
            inputs=[
                _media(IO.Image, "images", "Footage frames (Soundstage · Footage images)."),
                _media(IO.Mask, "subject_mask", "Who to recast (Footage subject_mask)."),
                IO.String.Input("footage_json", force_input=True, tooltip="Footage footage_json (fps, length, audio)."),
                _media(IO.Mask, "others_mask", "Other people, kept real (Footage others_mask).", optional=True),
                _media(IO.Audio, "audio", "Original audio (Footage audio).", optional=True),
                _media(IO.Image, "character", "Character reference: a photo or sheet of who they become.",
                       optional=True),
                _media(IO.Image, "first_frame", "Optional: frame 1 already recast (skips the Krea frame-1 edit).",
                       optional=True),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the new character and the action."),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _engine_input(),
                IO.Int.Input("grow", default=12, min=0, max=256, advanced=True),
                IO.Int.Input("feather", default=10, min=0, max=256, advanced=True),
                IO.Boolean.Input("new_silhouette", default=True, advanced=True,
                                 tooltip="Also track the new character's outline in the swap (bigger costume, "
                                         "hair) so nothing of the old actor peeks out. One extra SAM 3 pass."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF, control_after_generate=True),
            ],
            outputs=[
                IO.Video.Output(display_name="composite", tooltip="Final shot: recast subject over the real plate, "
                                                                  "original audio."),
                IO.Image.Output(display_name="composite_frames"),
                IO.Video.Output(display_name="swap", tooltip="Raw engine output (whole frame regenerated)."),
                IO.Image.Output(display_name="layer", tooltip="Swapped subject RGBA at plate size (Layer Pack)."),
                IO.Mask.Output(display_name="layer_mask"),
                IO.Image.Output(display_name="plate", tooltip="The original frames, untouched."),
            ],
            hidden=[IO.Hidden.unique_id, IO.Hidden.auth_token_comfy_org, IO.Hidden.api_key_comfy_org],
            enable_expand=True,
        )

    @classmethod
    def check_lazy_status(cls, **kw):
        return []

    @classmethod
    def execute(cls, footage_json, prompt, engine, grow, feather, new_silhouette, seed, images=None,
                subject_mask=None, others_mask=None, audio=None, character=None, first_frame=None,
                negative="") -> IO.NodeOutput:
        if images is None or subject_mask is None:
            raise RecastError("Recast needs footage images and a subject_mask (connect Soundstage · Footage).")
        info = json.loads(footage_json or "{}")
        fps = float(info.get("fps") or 24.0)
        key = engine.get("engine") if isinstance(engine, dict) else engine
        params = {k: v for k, v in engine.items() if k != "engine"} if isinstance(engine, dict) else {}
        audio = audio if info.get("has_audio") else None
        sam = GR.resolve(GR.SAM3_WEIGHTS, _list_files)["checkpoint"]
        g = GraphBuilder()
        p = {"images": images, "mask": subject_mask, "audio": audio, "fps": fps, "prompt": prompt or "",
             "negative": negative or "", "seed": int(seed), "frames": int(info.get("frames") or 97),
             "width": int(info.get("width") or 1280), "height": int(info.get("height") or 720),
             "subject_prompt": info.get("subject_prompt") or "person"}

        framing = "stretch"
        if key == ENGINE_LTX:
            swap = cls._ltx(g, p, params, character, first_frame)
        elif key == ENGINE_WAN:
            swap = cls._wan(g, p, character, first_frame)
        elif key == ENGINE_OJ_API:
            swap = cls._openjutsu_api(g, p, params, character, first_frame)
        elif key == ENGINE_OJ_LOCAL:
            swap = cls._openjutsu_local(g, p, params, character, first_frame)
            framing = "cover"  # H3CharacterSwapPrepareVideo scales to cover and centre-crops (never stretches)
        else:
            raise RecastError(f"Unknown engine {key!r}.")

        # generic prompt: the swap shows the NEW character, so the plate's subject prompt would miss it
        new_sil = GR.subject_silhouette(g, swap, sam, "person", subject_mask) \
            if (new_silhouette and sam) else None
        comp_in = {"plate": images, "swap": swap, "subject_mask": subject_mask, "grow": grow, "feather": feather,
                   "temporal": 1, "match_color": False, "framing": framing}
        if new_sil is not None:
            comp_in["swap_subject_mask"] = new_sil
        if others_mask is not None:
            comp_in["others_mask"] = others_mask
        comp = g.node("SoundstageRecastComposite", **comp_in)
        vid_kw = {"audio": audio} if audio is not None else {}
        comp_video = g.node("CreateVideo", images=comp.out(0), fps=fps, **vid_kw).out(0)
        swap_video = g.node("CreateVideo", images=swap, fps=fps, **vid_kw).out(0)
        return IO.NodeOutput(comp_video, comp.out(0), swap_video, comp.out(1), comp.out(2), images,
                             expand=g.finalize())

    # ---------------------------------------------------------------- engines

    @staticmethod
    def _first_frame(g, p, params, character, first_frame):
        if first_frame is not None:
            return first_frame
        if character is None:
            raise RecastError("Recast needs a character reference (or a recast first_frame).")
        kw = GR.resolve(GR.KREA_WEIGHTS, _list_files)
        miss = GR.missing(kw)
        if miss or "Krea2EditModelPatch" not in nodes.NODE_CLASS_MAPPINGS:
            raise RecastError("The frame-1 recast needs Krea 2 Turbo + krea2_identity_edit LoRA and the "
                              f"comfyui-krea2edit nodes (missing: {', '.join(miss) or 'comfyui-krea2edit'}). "
                              "Or connect a first_frame you made elsewhere.")
        frame0 = g.node("ImageFromBatch", image=p["images"], batch_index=0, length=1).out(0)
        return GR.krea_first_frame(g, kw, frame0, character, p["prompt"], p["seed"],
                                   float(params.get("likeness", 4.0)), float(params.get("hold_blocking", 1.0)))

    @classmethod
    def _ltx(cls, g, p, params, character, first_frame):
        w = GR.resolve(GR.LTX_WEIGHTS, _list_files)
        need = ["LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide", "LTXVSetAudioRefTokens", "DWPreprocessor"]
        miss = GR.missing(w) + [c for c in need if c not in nodes.NODE_CLASS_MAPPINGS]
        if miss:
            raise RecastError("LTX-2.5 union-control recast is missing: " + ", ".join(miss) +
                              " (needs ComfyUI-LTXVideo, comfyui_controlnet_aux and the LTX-2.5 weights).")
        first = cls._first_frame(g, p, params, character, first_frame)
        q = dict(p, first=first, draft=str(params.get("quality", "")).startswith("draft"))
        return GR.ltx_union_recast(g, w, q)

    @classmethod
    def _wan(cls, g, p, character, first_frame):
        from .router import registry as R
        from .router.adapters import ADAPTERS, RouterError
        m = R.find_model("open.wan_animate_2")
        weights = R.resolve_weights(m, _list_files, set(nodes.NODE_CLASS_MAPPINGS))
        miss = [s["any"][0] for s in m.get("weights", []) if not weights.get(s["role"])]
        miss += [c for c in m["classes"] + ["DWPreprocessor"] if c not in nodes.NODE_CLASS_MAPPINGS]
        if miss:
            raise RecastError("Wan 2.2 Animate 2 is not installed here (missing: " + ", ".join(miss) + ").")
        ref = character if character is not None else first_frame
        if ref is None:
            raise RecastError("Wan 2.2 Animate 2 needs a character reference.")
        # Wan's pose video is the same subject-gated DWPose guide (latent downscale factor 1 = plain 32 snap)
        guide, _ = GR.pose_guide(g, p["images"], p["mask"], *GR.guide_size(p["width"], p["height"], 32, 720))
        q = {"stage": "generate_video", "prompt": p["prompt"], "negative": p["negative"], "seed": p["seed"],
             "width": p["width"], "height": p["height"], "frames": p["frames"], "fps": p["fps"],
             "control": guide, "refs": [ref], "first": None, "params": {}, "weights": weights, "variant": None}
        try:
            video = ADAPTERS["wan_animate2"](g, m, q)["video"]
        except RouterError as e:
            raise RecastError(str(e))
        return g.node("GetVideoComponents", video=video).out(0)

    @classmethod
    def _openjutsu_api(cls, g, p, params, character, first_frame):
        from .router import registry as R
        if R.open_weights_only():
            raise RecastError(f"Openjutsu · MiniMax H3 API: {R.PARTNER_OFF_MSG}.")
        if "MinimaxHailuo03ReferenceNode" not in nodes.NODE_CLASS_MAPPINGS:
            raise RecastError("The MiniMax H3 partner node is not available here (offline or partner nodes off).")
        if not (cls.hidden.auth_token_comfy_org or cls.hidden.api_key_comfy_org):
            raise RecastError("Openjutsu · MiniMax H3 API is a paid partner model: sign in to Comfy "
                              "(Settings > User) or pick an open engine.")
        if character is None:
            raise RecastError("Openjutsu needs a character reference image.")
        model = params.get("model", "MiniMax H3")
        res = params.get("resolution", "768P")
        allowed = {"MiniMax H3": ["768P", "2K"], "MiniMax H3 Max": ["480P", "768P"]}[model]
        if res not in allowed:
            res = "768P"
        first = None
        if params.get("send_first_frame", True):
            first = cls._first_frame(g, p, {}, character, first_frame)
        video = GR.h3_api_reference(g, dict(p, character=character, first=first), res, model)
        return g.node("GetVideoComponents", video=video).out(0)

    @classmethod
    def _openjutsu_local(cls, g, p, params, character, first_frame):
        if os.environ.get(GR.H3_LICENSE_ENV) != "1":
            raise RecastError(
                "Openjutsu · local H3 runs MiniMax H3's open weights, whose Community License (§I.5, §V.4) "
                "excludes the USA, EU, UK and South Korea, outputs included. Set "
                f"{GR.H3_LICENSE_ENV}=1 only if you are licensed (outside those territories under $20M revenue, "
                "or with a MiniMax / Comfy commercial licence). Otherwise use an open engine (or Openjutsu · MiniMax H3 API with SOUNDSTAGE_PARTNER_MODELS=1).")
        w = GR.resolve(GR.OPENJUTSU_WEIGHTS, _list_files)
        miss = GR.missing(w) + [c for c in GR.OPENJUTSU_CLASSES if c not in nodes.NODE_CLASS_MAPPINGS]
        if miss:
            raise RecastError("Openjutsu (local) is missing: " + ", ".join(miss) + ". It needs Akatz Labs' "
                              "h3_character_swap node pack (GPL-3.0, github.com/akatz-labs/h3-character-swap-tool, "
                              "as patched by Comfy-Org/comfy-openjutsu build/) and the files in Openjutsu's "
                              "build/model-files.md.")
        if character is None:
            raise RecastError("Openjutsu needs a character reference image.")
        use_anchor = bool(params.get("use_anchor", True))
        first = cls._first_frame(g, p, {}, character, first_frame) if use_anchor else character
        frames, _audio = GR.openjutsu_local(g, w, dict(p, character=character, first=first, use_anchor=use_anchor))
        return frames


NODES = [SoundstageFootage, SoundstageRecast, SoundstageFootageDecode, SoundstageTrackSelect,
         SoundstageRecastComposite]
