"""Soundstage model routers: one picker node per stage, every model.

Each node shows a `model` dropdown with only the models valid for its stage that can run here:
local open-weights models whose weight files are installed and, only when SOUNDSTAGE_PARTNER_MODELS=1
opts in (open weights only is the default), partner nodes that ComfyUI actually loaded (absent with
--disable-partner-nodes / --offline). Labels carry
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
from .look import frame_lock as FL
from .router.adapters import ADAPTERS, RouterError, IMAGE_SAMPLERS, IMAGE_SCHEDULERS, lora_stack
from .router import lora_check as LC
from .router import castpass as CP

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
    opts = R.stage_options(stage, R.loaded_classes(nodes.NODE_CLASS_MAPPINGS), _list_files)
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
        tooltip="Only open-weights models for this stage that can run here (partner APIs are opt-in with "
                "SOUNDSTAGE_PARTNER_MODELS=1). [API] = paid partner node (your Comfy credits), "
                "[NC] = non-commercial licence, [<$1M]/[<$5M]/[<$10M] = free below that annual revenue, "
                "[DL] = downloads weights on first run.")


def _media(io_type, name: str, tooltip: str):
    return io_type.Input(name, optional=True, lazy=True, raw_link=True, tooltip=tooltip)


def _parse_ref_files(text, limit=4):
    """'file | label' lines (label optional) -> [(file, label)], at most `limit` (more references slow the model)."""
    out = []
    for line in (text or "").splitlines():
        f, _, label = line.partition("|")
        if f.strip():
            out.append((f.strip(), label.strip()))
    return out[:limit]


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
        m, p, g = cls._prepare(model, **v)
        out = ADAPTERS[m["adapter"]](g, m, p)
        if cls.STAGE == "edit_image" and p.get("cast_pass") and "image" in out:
            out = {**out, "image": CP.apply(g, m, p, out["image"])}   # ④ Frame's cast pass (router/castpass.py)
        return out, g

    @classmethod
    def _prepare(cls, model, **v):
        """Check the chosen model can run here and build the adapters' parameter dict: (entry, p, GraphBuilder)."""
        key = model.get("model") if isinstance(model, dict) else model
        m = R.find_model(key)
        if m is None or not m.get("adapter") or cls.STAGE not in m["stages"]:
            raise RouterError(f"No runnable model selected ({key!r}). Install one for this stage or pick another.")
        if m["kind"] in R.PAID_KINDS:
            if R.open_weights_only():
                raise RouterError(f"{m['name']}: {R.PARTNER_OFF_MSG}.")
            if not (cls.hidden.auth_token_comfy_org or cls.hidden.api_key_comfy_org):
                raise RouterError(f"{m['name']} is a paid partner model: sign in to Comfy (Settings > User) "
                                  "or pick a local model.")
        loaded = R.loaded_classes(nodes.NODE_CLASS_MAPPINGS)
        missing = [R.need_label(c) for c in m["classes"] if c not in loaded]
        weights = R.resolve_weights(m, _list_files, loaded)
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
             # what this ComfyUI has: the Klein adapters chain ReferenceLatent when ReferenceMultiLatent (0.39+) is missing
             "classes": loaded,
             "steps": int(v.get("steps") or 0), "cfg": float(v.get("cfg") or 0.0),
             "sampler": v.get("sampler") if v.get("sampler") in IMAGE_SAMPLERS else "auto",
             "scheduler": v.get("scheduler") if v.get("scheduler") in IMAGE_SCHEDULERS else "auto",
             "shift": float(v.get("shift") or 0.0),
             "lora": v.get("lora") if v.get("lora") not in (None, "", "None") else None,
             "lora_strength": float(v.get("lora_strength") if v.get("lora_strength") is not None else 1.0)}
        # ④ Frame's LoRA stack (the `loras` JSON), or the older single lora / lora_strength as a one-row stack.
        p["loras"] = lora_stack(v.get("loras"), p["lora"], p["lora_strength"])
        for row in p["loras"]:
            # ④ Frame lists every LoRA (web/pipeline/pipeline.mjs stillLoraGroups): one that's gone, or made for another
            # model family, stops here with a sentence instead of a "Value not in list" or a silently ignored add-on.
            why = LC.check(row["name"], m.get("adapter"), _loras(), lambda n: folder_paths.get_full_path("loras", n))
            if why:
                raise RouterError(why)
        if cls.STAGE == "edit_image":
            if v.get("stage_denoise") is not None:
                p["params"] = {**p["params"], "stage_denoise": float(v["stage_denoise"])}
            if v.get("depth_lock") is not None:
                p["params"] = {**p["params"], "depth_lock": FL.depth_lock(v["depth_lock"])}
            refs = _parse_ref_files(v.get("ref_files"))
            first = len(p["refs"]) + (2 if p["image"] is not None else 1)   # image 1 is the clay frame being edited
            labels = [""] * len(p["refs"]) + [lab for _, lab in refs]
            p["refs"] += [g.node("LoadImage", image=f).out(0) for f, _ in refs]
            if p["refs"] and p.get("control") is not None:   # ④ Frame: the stage frame + its depth + cast pictures
                p["cast_pass"] = _cast_pass(cls.hidden, labels)
            named = [f"image {first + i} shows {label}" for i, (_, label) in enumerate(refs) if label]
            if named:
                p["prompt"] = (p["prompt"].rstrip() + " Keep each subject's appearance from its reference: "
                               + "; ".join(named) + ".").strip()
        if cls.STAGE == "generate_video":
            files = [f.strip() for f in (v.get("ref_files") or "").splitlines() if f.strip()]
            p["refs"] += [g.node("LoadImage", image=f).out(0) for f in files]
            if p["last"] is None and (v.get("last_file") or "").strip():
                p["last"] = g.node("LoadImage", image=v["last_file"].strip()).out(0)
        return m, p, g


def _cast_pass(hidden, labels) -> dict | None:
    """④ Frame (the frame node: stage colour pass + stage depth + cast pictures): find the queued prompt's 3D Stage,
    read frame 1's ID pass and, when exactly one person shows and one cast picture is theirs, write the grown and
    feathered person mask to input/soundstage_cast/ for the cast pass (router/castpass.py). None when it can't."""
    import json
    import os
    import numpy as np
    from PIL import Image
    from .stagestore import try_resolve
    prompt = getattr(hidden, "prompt", None) or {}
    if isinstance(prompt, str):
        try:
            prompt = json.loads(prompt)
        except ValueError:
            return None
    data = next((try_resolve((n.get("inputs") or {}).get("stage")) for n in prompt.values()
                 if isinstance(n, dict) and n.get("class_type") == "SoundstageStage"), None)
    if not isinstance(data, dict) or not isinstance(data.get("scene"), dict) or not (data.get("passes") or {}).get("id"):
        return None
    try:
        passes = data["passes"]
        img = np.asarray(Image.open(folder_paths.get_annotated_filepath(passes["id"])).convert("RGB"))
        if passes.get("grid"):
            tw, th = passes["grid"]["tile"]
            img = img[:th, :tw]
    except (OSError, KeyError, TypeError, ValueError):
        return None
    cp = CP.prepare(data["scene"], img, labels)
    if not cp.get("ok"):
        return cp
    folder = os.path.join(folder_paths.get_input_directory(), "soundstage_cast")
    os.makedirs(folder, exist_ok=True)
    name = CP.mask_name(cp["mask"])
    if not os.path.exists(os.path.join(folder, name)):
        CP.mask_image(cp["mask"]).save(os.path.join(folder, name))
    return {**{k: v for k, v in cp.items() if k != "mask"}, "mask_file": f"soundstage_cast/{name}"}


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
                        "image model: local open weights (partner APIs only with SOUNDSTAGE_PARTNER_MODELS=1).",
            inputs=[
                IO.String.Input("prompt", multiline=True, default=""),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "control_image", "Depth / stage guide control (local models that support it)."),
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
            description="Edit an image or turn the stage guide frame into the look still (with stage depth as "
                        "control), with any installed edit model.",
            inputs=[
                _media(IO.Image, "image", "Image to edit (e.g. the stage's first guide frame)."),
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
                IO.Int.Input("steps", default=0, min=0, max=100, optional=True,
                             tooltip="Sampling steps for local image models. 0 = the model's tuned default (Klein 16, Krea 8)."),
                IO.Float.Input("cfg", default=0.0, min=0.0, max=20.0, step=0.1, optional=True,
                               tooltip="Guidance (CFG). 0 = the model's default (1.0 for distilled models like Klein and Krea Turbo)."),
                IO.String.Input("ref_files", multiline=True, default="", optional=True,
                                tooltip="Character sheets / style references by file name in ComfyUI's input "
                                        "folder, one per line (added after ref_1-3). The App's Frame step fills this."),
                IO.Float.Input("stage_denoise", default=FL.DEFAULT_DENOISE, min=FL.MIN_DENOISE, max=1.0, step=0.01, optional=True,
                               advanced=True,
                               tooltip="FLUX 3 Klein with the stage depth on control_image (④ Frame): the frame starts from "
                                       "the Color pass (img2img) at this denoise, so it keeps the stage's objects, sizes "
                                       "and places. Lower = closer to the blocking. 1 = paint from noise with the pass as a "
                                       "reference only, as frames picked before Nov 1 were. The App's Follow the blocking sets it."),
                IO.Float.Input("depth_lock", default=0.0, min=0.0, max=FL.DEPTH_LOCK_MAX, step=0.05, optional=True,
                               advanced=True,
                               tooltip="④ Frame \"Lock to the stage depth\" (control_image = the stage depth pass). "
                                       "FLUX 3 Klein: Krea 2 + its depth-control LoRA repaint the frame at this denoise "
                                       "(about 0.5). Krea 2 Turbo: the frame starts from the blurred Color pass at "
                                       "stage_denoise, held to the depth (cast pictures are not used). 0 = off (frames "
                                       "picked before Nov 2)."),
                IO.Combo.Input("sampler", options=list(IMAGE_SAMPLERS), default="auto", optional=True,
                               tooltip="Sampler for local image models. auto = the model's tuned one (Klein euler / er_sde, "
                                       "Krea 2 euler_ancestral)."),
                IO.Combo.Input("scheduler", options=list(IMAGE_SCHEDULERS), default="auto", optional=True,
                               tooltip="Scheduler for local image models. auto = the model's tuned one (Klein simple, Krea 2 beta)."),
                IO.Float.Input("shift", default=0.0, min=0.0, max=12.0, step=0.05, optional=True,
                               tooltip="Sigma shift (ModelSamplingAuraFlow) for the flow-matching image models. 0 = the model's "
                                       "default, untouched. Above ~3 spends more steps on composition, below on detail."),
                IO.String.Input("loras", multiline=True, default="", optional=True,
                                tooltip="The ④ Frame LoRA stack as JSON: [{\"name\": \"file.safetensors\", \"strength\": 0.8}, …], "
                                        "applied in order on the image model. Wins over the single lora / lora_strength above."),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=HIDDEN + [IO.Hidden.prompt],   # the queued prompt: ④ Frame's cast pass reads the stage from it
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
                _media(IO.Image, "control_video", "Control frames: the stage guide pass (LTX layout→render) or a "
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
