"""Soundstage model routers: one picker node per stage, every model.

Each node shows a `model` dropdown with only the models valid for its stage that can run here:
partner nodes that ComfyUI actually loaded (absent with --disable-partner-nodes / --offline, or when
SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1) and local models whose weight files are installed. Labels carry
short badges: [API] paid partner node, [NC] non-commercial, [<$1M] etc. revenue-capped licences.

At run time the chosen model is expanded into its real backend nodes (GraphBuilder + enable_expand),
so partner nodes keep the user's sign-in and credits, and local models run their template graph.
Media inputs are lazy raw links: the router never loads them, the expanded backend does.
"""
import time

import folder_paths
import nodes
from comfy_api.latest import IO
from comfy_execution.graph_utils import GraphBuilder

from .router import registry as R
from .router.adapters import ADAPTERS, RouterError

_TTL_S = 30
_cache: dict[str, tuple[float, list]] = {}


def _list_files(folder: str) -> list[str]:
    try:
        return folder_paths.get_filename_list(folder)
    except Exception:  # folder type not registered on this install
        return []


def _stage_options(stage: str) -> list:
    """Cached: define_schema() runs on every /object_info call and at execution."""
    hit = _cache.get(stage)
    if hit and time.time() - hit[0] < _TTL_S:
        return hit[1]
    opts = R.stage_options(stage, set(nodes.NODE_CLASS_MAPPINGS), _list_files)
    _cache[stage] = (time.time(), opts)
    return opts


def _widget(w: dict):
    if w["kind"] == "combo":
        return IO.Combo.Input(w["id"], options=w["options"], default=w["default"])
    return IO.Float.Input(w["id"], default=w["default"], min=w["min"], max=w["max"], step=0.01)


def _model_input(stage: str):
    return IO.DynamicCombo.Input(
        "model",
        options=[IO.DynamicCombo.Option(label, [_widget(w) for w in widgets])
                 for label, widgets, _ in _stage_options(stage)],
        tooltip="Only models for this stage that can run here. [API] = paid partner node (your Comfy credits), "
                "[NC] = non-commercial licence, [<$1M]/[<$5M]/[<$10M] = free below that annual revenue, "
                "[DL] = downloads weights on first run.")


def _media(io_type, name: str, tooltip: str):
    return io_type.Input(name, optional=True, lazy=True, raw_link=True, tooltip=tooltip)


def _loras():
    try:
        return list(folder_paths.get_filename_list("loras"))
    except Exception:  # noqa: BLE001 - never break the node list over a missing folder
        return []


def _common_tail():
    return [IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF, control_after_generate=True)]


HIDDEN = [IO.Hidden.unique_id, IO.Hidden.auth_token_comfy_org, IO.Hidden.api_key_comfy_org]


class _Router(IO.ComfyNode):
    STAGE = ""

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []  # media are forwarded as raw links; the expanded backend pulls them

    @classmethod
    def _expand(cls, model, **v):
        key = model.get("model") if isinstance(model, dict) else model
        m = R.find_model(key)
        if m is None or not m.get("adapter") or cls.STAGE not in m["stages"]:
            raise RouterError(f"No runnable model selected ({key!r}). Install one for this stage or pick another.")
        if m["kind"] in R.PAID_KINDS:
            if R.open_weights_only():
                raise RouterError(f"{m['name']} is a paid partner model and {R.OPEN_ONLY_ENV}=1 is set.")
            if not (cls.hidden.auth_token_comfy_org or cls.hidden.api_key_comfy_org):
                raise RouterError(f"{m['name']} is a paid partner model: sign in to Comfy (Settings > User) "
                                  "or pick a local model.")
        missing = [c for c in m["classes"] if c not in nodes.NODE_CLASS_MAPPINGS]
        weights = R.resolve_weights(m, _list_files, set(nodes.NODE_CLASS_MAPPINGS))
        missing += [s["any"][0] for s in m.get("weights", []) if not weights.get(s["role"])]
        if missing:
            raise RouterError(f"{m['name']} is missing: {', '.join(missing)}")
        params = {k: val for k, val in model.items() if k != "model"} if isinstance(model, dict) else {}
        g = GraphBuilder()
        p = {"stage": cls.STAGE, "prompt": v.get("prompt") or "", "negative": v.get("negative") or "",
             "sound": v.get("sound") or "", "music": v.get("music") or "", "line": v.get("line") or "",
             "seed": int(v.get("seed") or 0), "width": int(v.get("width") or 0), "height": int(v.get("height") or 0),
             "frames": int(v.get("frames") or 97), "fps": float(v.get("fps") or 24.0),
             "first": v.get("first_frame"), "last": v.get("last_frame"),
             "control": v.get("control_video") if cls.STAGE == "generate_video" else v.get("control_image"),
             "refs": [v[k] for k in ("ref_1", "ref_2", "ref_3") if v.get(k) is not None],
             "image": v.get("image"), "images": v.get("images"), "mask": v.get("mask"),
             "params": params, "weights": weights, "variant": m.get("variant"),
             "lora": v.get("lora") if v.get("lora") not in (None, "", "None") else None,
             "lora_strength": float(v.get("lora_strength") if v.get("lora_strength") is not None else 1.0)}
        if cls.STAGE == "edit_image":
            files = [f.strip() for f in (v.get("ref_files") or "").splitlines() if f.strip()]
            p["refs"] += [g.node("LoadImage", image=f).out(0) for f in files]
        if cls.STAGE == "generate_video":
            files = [f.strip() for f in (v.get("ref_files") or "").splitlines() if f.strip()]
            p["refs"] += [g.node("LoadImage", image=f).out(0) for f in files]
            if p["last"] is None and (v.get("last_file") or "").strip():
                p["last"] = g.node("LoadImage", image=v["last_file"].strip()).out(0)
        return ADAPTERS[m["adapter"]](g, m, p), g


class SoundstageGenerateImage(_Router):
    STAGE = "generate_image"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageGenerateImage",
            display_name="Soundstage · Generate Image (any model)",
            category="Soundstage/Models",
            search_aliases=["text to image", "t2i", "keyframe", "previz", "model picker"],
            description="Text (plus optional references or a depth control) to a still, with any installed "
                        "image model: local open weights or partner APIs.",
            inputs=[
                IO.String.Input("prompt", multiline=True, default=""),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "control_image", "Depth/clay control (local models that support it)."),
                _media(IO.Image, "ref_1", "Reference image (style / identity) for models that take refs."),
                _media(IO.Image, "ref_2", "Reference image."),
                _media(IO.Image, "ref_3", "Reference image."),
                IO.Int.Input("width", default=1920, min=256, max=4096, step=16),
                IO.Int.Input("height", default=1088, min=256, max=4096, step=16),
                _model_input(cls.STAGE),
                *_common_tail(),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, width, height, seed, **kw) -> IO.NodeOutput:
        outs, g = cls._expand(model, prompt=prompt, width=width, height=height, seed=seed, **kw)
        return IO.NodeOutput(outs["image"], expand=g.finalize())


class SoundstageEditImage(_Router):
    STAGE = "edit_image"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageEditImage",
            display_name="Soundstage · Edit Image / Keyframe (any model)",
            category="Soundstage/Models",
            search_aliases=["image edit", "img2img", "look still", "keyframe from control", "model picker"],
            description="Edit an image or turn the stage clay frame into the look still (with stage depth as "
                        "control), with any installed edit model.",
            inputs=[
                _media(IO.Image, "image", "Image to edit (e.g. the stage's first clay frame)."),
                IO.String.Input("prompt", multiline=True, default=""),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "control_image", "Depth control (Krea 2 depth LoRA)."),
                _media(IO.Mask, "mask", "Edit mask (models that support inpainting)."),
                _media(IO.Image, "ref_1", "Reference image (character sheet, style)."),
                _media(IO.Image, "ref_2", "Reference image."),
                _media(IO.Image, "ref_3", "Reference image."),
                IO.Int.Input("width", default=0, min=0, max=4096, step=16,
                             tooltip="Output size for local models; 0 keeps the input image size."),
                IO.Int.Input("height", default=0, min=0, max=4096, step=16),
                _model_input(cls.STAGE),
                *_common_tail(),
                # Appended last so saved App workflows keep their widget order.
                IO.Combo.Input("lora", options=["None"] + _loras(), default="None", optional=True,
                               tooltip="A LoRA for the image model (FLUX 3 Klein, Krea 2): a character, a product, a "
                                       "house style. Files in models/loras."),
                IO.Float.Input("lora_strength", default=1.0, min=-2.0, max=2.0, step=0.05, optional=True),
                IO.String.Input("ref_files", multiline=True, default="", optional=True,
                                tooltip="Character sheets / style references by file name in ComfyUI's input "
                                        "folder, one per line (added after ref_1-3). The App's Frame step fills this."),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, width, height, seed, **kw) -> IO.NodeOutput:
        outs, g = cls._expand(model, prompt=prompt, width=width, height=height, seed=seed, **kw)
        return IO.NodeOutput(outs["image"], expand=g.finalize())


class SoundstageGenerateVideo(_Router):
    STAGE = "generate_video"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageGenerateVideo",
            display_name="Soundstage · Generate Shot (any model)",
            category="Soundstage/Models",
            search_aliases=["video", "i2v", "t2v", "layout to render", "ltx", "kling", "veo", "model picker"],
            description="Image / stage control to a video shot with any installed video model. Default LTX-2.5: "
                        "with control_video connected it renders the stage layout (Layout-To-Render IC-LoRA).",
            inputs=[
                IO.String.Input("prompt", multiline=True, default=""),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "first_frame", "Start frame / look still."),
                _media(IO.Image, "last_frame", "End frame (models with first+last frame)."),
                _media(IO.Image, "control_video", "Control frames: stage clay pass (LTX layout→render) or a "
                                                  "driving performance (Wan Animate)."),
                _media(IO.Image, "ref_1", "Reference image (character / element)."),
                _media(IO.Image, "ref_2", "Reference image."),
                _media(IO.Image, "ref_3", "Reference image."),
                IO.Int.Input("width", default=1920, min=256, max=4096, step=32),
                IO.Int.Input("height", default=1088, min=256, max=4096, step=32),
                IO.Int.Input("frames", default=97, min=9, max=1000,
                             tooltip="Shot length in frames. Partner models get the nearest duration they allow."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=60.0, step=0.001),
                _model_input(cls.STAGE),
                *_common_tail(),
                # Added last so saved workflows keep their widget order.
                IO.String.Input("sound", multiline=True, default="", optional=True, advanced=True,
                                tooltip="What the shot sounds like, for models that make their own audio in the same "
                                        "pass (MiniMax H3). Blank = the natural sound of the action."),
                IO.String.Input("music", default="", optional=True, advanced=True,
                                tooltip="Score mood for models that make their own audio. Blank = no music."),
                IO.String.Input("line", default="", optional=True, advanced=True,
                                tooltip="A spoken line for models that make their own audio. Blank = no dialogue."),
                IO.String.Input("last_file", default="", optional=True, advanced=True,
                                tooltip="End frame by file name (as LoadImage takes it, e.g. 'soundstage/x.png [output]'). "
                                        "Used when last_frame is not connected. The App fills this from the shot."),
                IO.String.Input("ref_files", multiline=True, default="", optional=True, advanced=True,
                                tooltip="Extra reference images by file name, one per line (character or prop sheets). "
                                        "Added after ref_1..ref_3 for models that take references."),
            ],
            outputs=[IO.Video.Output(display_name="video"), IO.Image.Output(display_name="frames")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, width, height, frames, fps, seed, **kw) -> IO.NodeOutput:
        outs, g = cls._expand(model, prompt=prompt, width=width, height=height, frames=frames, fps=fps,
                              seed=seed, **kw)
        frames_out = g.node("GetVideoComponents", video=outs["video"]).out(0)
        return IO.NodeOutput(outs["video"], frames_out, expand=g.finalize())


class SoundstageMatte(_Router):
    STAGE = "matte"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageMatte",
            display_name="Soundstage · Matte (any model)",
            category="Soundstage/Models",
            search_aliases=["matte", "alpha", "remove background", "rotoscope", "sam3", "birefnet"],
            description="Pull a matte from frames with any installed matting model. Outputs the RGBA foreground "
                        "and the subject mask (white = subject).",
            inputs=[
                _media(IO.Image, "images", "Frames (or a single image) to matte."),
                IO.String.Input("prompt", default="person",
                                tooltip="What to keep, for text-prompted models (SAM 3). Others ignore it."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=60.0, step=0.001,
                               tooltip="Frame rate sent to video APIs."),
                _model_input(cls.STAGE),
                *_common_tail(),
            ],
            outputs=[IO.Image.Output(display_name="foreground"), IO.Mask.Output(display_name="mask")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, fps, seed, **kw) -> IO.NodeOutput:
        outs, g = cls._expand(model, prompt=prompt, fps=fps, seed=seed, **kw)
        return IO.NodeOutput(outs["images"], outs["mask"], expand=g.finalize())


class SoundstageCleanPlate(_Router):
    STAGE = "clean_plate"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageCleanPlate",
            display_name="Soundstage · Clean Plate (any model)",
            category="Soundstage/Models",
            search_aliases=["clean plate", "remove people", "object removal", "erase", "inpaint video"],
            description="Remove the actors / moving subjects from frames with any installed clean-plate model.",
            inputs=[
                _media(IO.Image, "images", "Frames to clean."),
                _media(IO.Mask, "mask", "What to remove (models that take a mask; others remove all people)."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the empty set (LTX) or what to remove (Kling / Runway)."),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                IO.Float.Input("fps", default=24.0, min=1.0, max=60.0, step=0.001),
                _model_input(cls.STAGE),
                *_common_tail(),
            ],
            outputs=[IO.Image.Output(display_name="plate")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, fps, seed, **kw) -> IO.NodeOutput:
        outs, g = cls._expand(model, prompt=prompt, fps=fps, seed=seed, **kw)
        return IO.NodeOutput(outs["images"], expand=g.finalize())


NODES = [SoundstageGenerateImage, SoundstageEditImage, SoundstageGenerateVideo, SoundstageMatte, SoundstageCleanPlate]
