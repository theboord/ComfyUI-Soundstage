"""Paint Studio's backend: Generative Fill (inpaint, remove, replace with a reference, outpaint) with our own nodes.

SoundstageFill          image + mask + prompt + mode + any edit model -> picture with only the masked area replaced.
                        Expands into the three nodes below around the chosen model (soundstage/router/fill_graph.py).
SoundstageFillCrop      image, mask -> the crop the model sees (mask box + context, sized to ~1 MP, pre-filled hole
                        for Remove / Extend), its mask, the full-size repaint mask and the crop box (JSON).
SoundstageFillStitch    original, edited crop, repaint mask, box -> the original with the crop pasted back through a
                        feathered, colour-matched alpha (pixels outside it are untouched), the generated pixels as an
                        RGBA layer, and the paste alpha.
SoundstagePadForFill    image -> a bigger canvas (to an aspect, or by edges) + the mask of the new area, for Extend.
The math is numpy (soundstage/fill_math.py, unit-tested without torch); torch only converts at the edges.
"""
from __future__ import annotations

import numpy as np
from comfy_api.latest import IO

from . import fill_math as F
from .nodes_router import HIDDEN, _common_tail, _loras, _media, _model_input, _Router
from .router.fill_graph import FILL_DEFAULTS, build_fill

ASPECTS = {"16:9": 16 / 9, "2.39:1": 2.39, "1.85:1": 1.85, "9:16": 9 / 16, "4:3": 4 / 3, "1:1": 1.0}


def _np(t):
    return t.detach().cpu().float().numpy()


def _torch(a):
    import torch
    return torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32))


def _resize(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """H x W (x C) float array -> h x w, bicubic with antialias (bilinear for masks)."""
    import torch
    import torch.nn.functional as tf
    if a.shape[0] == h and a.shape[1] == w:
        return a
    t = _torch(a)
    t = t[None, None] if t.ndim == 2 else t.permute(2, 0, 1)[None]
    mode = "bilinear" if a.ndim == 2 else "bicubic"
    with torch.no_grad():
        r = tf.interpolate(t, size=(int(h), int(w)), mode=mode, align_corners=False, antialias=True)
    r = r[0, 0] if a.ndim == 2 else r[0].permute(1, 2, 0)
    return np.clip(r.numpy(), 0, 1)


def _first_mask(mask, h, w):
    m = _np(mask)
    m = m[0] if m.ndim == 3 else m
    return _resize(m, w, h) if m.shape != (h, w) else m


class SoundstageFillCrop(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFillCrop",
            display_name="Soundstage · Fill crop",
            category="Soundstage/Paint",
            search_aliases=["inpaint crop", "crop and stitch", "outpaint crop"],
            description="The part of the picture a fill model sees: the mask's box plus context, sized to about "
                        "`megapixels`. Extend pre-fills the empty border with the surrounding colours.",
            inputs=[
                IO.Image.Input("image"),
                IO.Mask.Input("mask", tooltip="White = repaint. For Extend: the new, empty area."),
                IO.Combo.Input("mode", options=list(F.MODES), default="fill"),
                IO.Int.Input("grow", default=FILL_DEFAULTS["grow"], min=0, max=256,
                             tooltip="Grow the mask by this many px before repainting."),
                IO.Float.Input("context", default=FILL_DEFAULTS["context"], min=0.0, max=4.0, step=0.05,
                               tooltip="Context around the mask, as a fraction of its longer side."),
                IO.Float.Input("megapixels", default=FILL_DEFAULTS["megapixels"], min=0.25, max=4.0, step=0.05,
                               tooltip="Model resolution of the crop (1.0 = about 1024 x 1024)."),
                IO.Int.Input("overlap", default=FILL_DEFAULTS["overlap"], min=0, max=256,
                             tooltip="Extend: how far into the existing picture the seam is regenerated."),
                IO.Int.Input("feather", default=FILL_DEFAULTS["feather"], min=0, max=256,
                             tooltip="Seam softness used by the stitch (the crop keeps room for it)."),
            ],
            outputs=[IO.Image.Output("crop_image", display_name="crop"), IO.Mask.Output("crop_mask", display_name="crop mask"),
                     IO.Mask.Output("regen", display_name="repaint mask"), IO.String.Output("box", display_name="box")],
        )

    @classmethod
    def execute(cls, image, mask, mode="fill", grow=8, context=0.6, megapixels=1.0, overlap=48, feather=24):
        img = _np(image)[0][..., :3]
        h, w = img.shape[:2]
        m = _first_mask(mask, h, w)
        plan = F.plan_crop(m, mode, grow, context, overlap, feather, megapixels)
        crop, cm = F.crop_inputs(img, m, plan, mode)
        tw, th = plan["size"]
        crop, cm = _resize(crop, tw, th), _resize(cm, tw, th)
        return IO.NodeOutput(_torch(crop)[None], _torch(cm)[None], _torch(plan["regen"])[None],
                             F.box_json(plan["box"], plan["size"]))


class SoundstageFillStitch(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFillStitch",
            display_name="Soundstage · Fill stitch",
            category="Soundstage/Paint",
            search_aliases=["inpaint stitch", "paste back", "crop and stitch"],
            description="Paste an edited crop back into the original through a feathered, colour-matched mask. "
                        "Everything outside the feathered mask stays exactly as it was.",
            inputs=[
                IO.Image.Input("original"),
                IO.Image.Input("edited", tooltip="The model's result for the crop (any size; a batch = variations)."),
                IO.Mask.Input("regen", tooltip="Full-size repaint mask from Fill crop."),
                IO.String.Input("box", default="", tooltip="Crop box JSON from Fill crop."),
                IO.Int.Input("feather", default=FILL_DEFAULTS["feather"], min=0, max=256),
                IO.Boolean.Input("color_match", default=True,
                                 tooltip="Match the crop's colour and contrast to the untouched pixels around the mask."),
            ],
            outputs=[IO.Image.Output("image", display_name="image"),
                     IO.Image.Output("layer", display_name="layer (RGBA)"),
                     IO.Mask.Output("alpha", display_name="alpha")],
        )

    @classmethod
    def execute(cls, original, edited, regen, box, feather=24, color_match=True):
        orig = _np(original)[0][..., :3]
        h, w = orig.shape[:2]
        rg = _first_mask(regen, h, w)
        bx = F.parse_box(box)
        imgs, layers, alphas = [], [], []
        for e in _np(edited):
            e = _resize(e[..., :3], bx[2], bx[3])
            out, alpha = F.stitch(orig, e, rg, bx, feather, color_match)
            imgs.append(out)
            layers.append(np.concatenate([out, alpha[..., None]], -1))
            alphas.append(alpha)
        return IO.NodeOutput(_torch(np.stack(imgs)), _torch(np.stack(layers)), _torch(np.stack(alphas)))


class SoundstagePadForFill(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePadForFill",
            display_name="Soundstage · Extend canvas",
            category="Soundstage/Paint",
            search_aliases=["outpaint", "pad image", "extend canvas", "expand canvas"],
            description="Make the canvas bigger, to an aspect ratio or by edges, for Generative Fill's Extend mode. "
                        "Outputs the picture (new area pre-filled from its edges) and the mask of the new area.",
            inputs=[
                IO.Image.Input("image"),
                IO.Combo.Input("aspect", options=["custom"] + list(ASPECTS), default="2.39:1",
                               tooltip="Extend to this aspect (never crops). custom = use the edge amounts."),
                IO.Combo.Input("anchor", options=["center", "left", "right", "top", "bottom"], default="center",
                               tooltip="Where the original picture stays."),
                IO.Int.Input("left", default=0, min=0, max=4096),
                IO.Int.Input("top", default=0, min=0, max=4096),
                IO.Int.Input("right", default=0, min=0, max=4096),
                IO.Int.Input("bottom", default=0, min=0, max=4096),
            ],
            outputs=[IO.Image.Output("image", display_name="image"), IO.Mask.Output("mask", display_name="new area")],
        )

    @classmethod
    def execute(cls, image, aspect="2.39:1", anchor="center", left=0, top=0, right=0, bottom=0):
        img = _np(image)[0][..., :3]
        h, w = img.shape[:2]
        pads = F.pad_amounts(w, h, ASPECTS[aspect], anchor) if aspect in ASPECTS else (left, top, right, bottom)
        out, hole = F.pad_image(img, *pads)
        return IO.NodeOutput(_torch(out)[None], _torch(hole)[None])


class SoundstageFill(_Router):
    STAGE = "edit_image"

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFill",
            display_name="Soundstage · Generative Fill (any edit model)",
            category="Soundstage/Paint",
            search_aliases=["generative fill", "inpaint", "outpaint", "remove object", "extend", "paint studio"],
            description="Photoshop-style Generative Fill: repaint only the masked area of a picture (Fill, Remove, "
                        "Replace with a reference, Extend the canvas). Crops around the mask, runs the edit model "
                        "on the crop (FLUX 3 Klein by default) and stitches it back with a feathered, colour-matched "
                        "seam; nothing outside the mask changes.",
            inputs=[
                _media(IO.Image, "image", "The picture to edit."),
                _media(IO.Mask, "mask", "White = the area to repaint (Extend: the new, empty area)."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to put there (Fill), what the area shows (Remove: optional), who "
                                        "(Replace) or what lies beyond the frame (Extend)."),
                IO.Combo.Input("mode", options=list(F.MODES), default="fill"),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "ref_1", "Reference image (character sheet, product, style)."),
                _media(IO.Image, "ref_2", "Reference image."),
                _media(IO.Image, "ref_3", "Reference image."),
                _model_input(cls.STAGE),
                *_common_tail(),
                IO.Combo.Input("lora", options=["None"] + _loras(), default="None", optional=True),
                IO.Float.Input("lora_strength", default=1.0, min=-2.0, max=2.0, step=0.05, optional=True),
                IO.Int.Input("steps", default=0, min=0, max=100, optional=True, tooltip="0 = the model's default."),
                IO.Float.Input("cfg", default=0.0, min=0.0, max=20.0, step=0.1, optional=True,
                               tooltip="0 = the model's default (1.0 for Klein / Krea Turbo)."),
                IO.String.Input("ref_files", multiline=True, default="", optional=True,
                                tooltip="References by file name in the input folder, 'file | label' per line."),
                IO.Int.Input("grow", default=FILL_DEFAULTS["grow"], min=0, max=256, optional=True),
                IO.Int.Input("feather", default=FILL_DEFAULTS["feather"], min=0, max=256, optional=True),
                IO.Float.Input("context", default=FILL_DEFAULTS["context"], min=0.0, max=4.0, step=0.05, optional=True),
                IO.Float.Input("megapixels", default=FILL_DEFAULTS["megapixels"], min=0.25, max=4.0, step=0.05,
                               optional=True),
                IO.Int.Input("overlap", default=FILL_DEFAULTS["overlap"], min=0, max=256, optional=True),
                IO.Float.Input("denoise", default=FILL_DEFAULTS["denoise"], min=0.05, max=1.0, step=0.01, optional=True),
                IO.Boolean.Input("color_match", default=True, optional=True),
            ],
            outputs=[IO.Image.Output("image", display_name="image"),
                     IO.Image.Output("layer", display_name="layer (RGBA)"),
                     IO.Mask.Output("alpha", display_name="alpha")],
            hidden=HIDDEN,
            enable_expand=True,
        )

    @classmethod
    def execute(cls, prompt, model, seed, mode="fill", **kw) -> IO.NodeOutput:
        settings = {k: kw.pop(k) for k in list(FILL_DEFAULTS) if kw.get(k) is not None}
        settings.update(mode=mode, user_prompt=prompt or "")
        # The router adds only the reference labels ("image 2 shows …") here; build_fill writes the instruction.
        m, p, g = cls._prepare(model, prompt="", seed=seed, **kw)
        outs = build_fill(g, m, p, settings)
        return IO.NodeOutput(outs["image"], outs["layer"], outs["mask"], expand=g.finalize())


NODES = [SoundstageFill, SoundstageFillCrop, SoundstageFillStitch, SoundstagePadForFill]
