"""Image-edit building blocks shared by the App paths that change a picture (C25 diagnosis, C26 verification).

What is wired (2026-11-08):
- ④ Frame on FLUX Klein: the Look node's `edit_prompt` output is `frame_instruction(...)` around the look without the
  shot-size and placement words (look/compile.py compile_still(edit=True)). Klein is an edit model: with a plain
  description it kept image 1, the grey clay (Jon's machine, FLUX 3 Klein, C26 root cause A), or recomposed the shot
  (FLUX.2 Klein 9B, C25). The App points the frame node's prompt at it.
- Paint Studio on Krea 2 Turbo (fill_graph._krea2): Whole frame, Replace and Fill go through `krea_edit`, the Krea 2
  Identity Edit LoRA with the source as the aligned "scene" reference. Before, Whole frame (a white mask at denoise 1)
  was plain text-to-image and the source never reached the model (C26 root cause B); Replace dropped the cast picture.
  Without the LoRA, Whole frame and Replace refuse with NO_KREA_EDIT.
- Klein's references (adapters.klein_refs, fill_graph._klein) chain ReferenceLatent through `klein_references` when
  ComfyUI has no ReferenceMultiLatent (before 0.39: the pods), as ComfyUI's own FLUX.2 Klein edit templates do.

`klein_edit` is the one-builder version of the Klein paths; nothing calls it yet. Every canvas is 16-snapped (_scaled).

Structure control: Klein takes none. control_image never reaches its conditioning (adapters.flux3_klein); its layout
comes only from the source picture as an aligned reference plus an instruction that says to keep it. Real depth control
is Krea 2 only (the Krea2 depth-control LoRA: ④ Frame's Krea 2 + depth, and Lock to the stage depth Light / Strict).

No ComfyUI imports: built against a GraphBuilder-like `g`, checked against an /object_info snapshot in tests.
"""
from __future__ import annotations

from .adapters import (RouterError, _loaders, _sampling, _with_lora, _with_shift, blur_start, depth_control)

# registry role "edit_lora" (open.krea_2_turbo): v1_2 in loras/Krea2/ on Jon's machine, v1_1 in loras/krea2/ on the pods
KREA_EDIT_LORAS = ("krea2_identity_edit_v1_2.safetensors", "krea2_identity_edit_v1_1.safetensors")
KREA_EDIT_STEPS = 10     # the comfyui-krea2edit pack's recipe: LoRA 1.0, 10 steps, euler / simple, cfg 1 (C26 on Jon's machine)
SCENE_BOOST = 1.0        # Krea2EditModelPatch ref_boost_a: the source picture (the layout). research/11_posestudio_hack.md
SUBJECT_BOOST = 4.0      # ref_boost: the cast picture (the likeness), the Pose Studio recipe's CHARACTER strength
RES_STEP = 16            # every edit canvas is a multiple of 16: latent and decoded picture the same size, no noise band

NO_KREA_EDIT = ("Krea 2 Turbo only paints new pictures from words: to change a whole picture, or to put a cast member "
                "in, it needs the Krea 2 Identity Edit LoRA (krea2_identity_edit_v1_2 or v1_1 in models/loras) and the "
                "comfyui-krea2edit nodes. Pick FLUX 3 Klein instead, or mask an area and use Generative Fill.")


# ---------------------------------------------------------------- prompts

def frame_instruction(description: str, depth: bool = False, n_refs: int = 0) -> str:
    """④ Frame: the clay Color pass (image 1) becomes a photograph of the same shot. An edit model needs the change
    spelled out: with a description alone it keeps image 1, mannequins and all."""
    d = (description or "").strip().rstrip(".")
    refs = ""
    if n_refs:
        first = 3 if depth else 2
        refs = (f" Each person's face, hair and clothes come from their reference picture (image {first}"
                f"{f' to {first + n_refs - 1}' if n_refs > 1 else ''}).")
    return ("Turn image 1, a grey 3D blocking render of a film shot, into a real photograph of the same shot. Keep the "
            "camera, the framing and every person, vehicle and object exactly where they are in image 1, at the same "
            "size, pose and facing" + (", in the depth layout shown by the depth map in image 2" if depth else "") + ". "
            "Replace every grey mannequin with a real person in real clothes with natural skin and hair, every plain "
            "shape with the real object, and the flat walls and ground with real materials. No grey clay anywhere."   # clay-prompt: model words
            + refs + (f" The photograph: {d}." if d else ""))


# ---------------------------------------------------------------- references

def _scaled(g, image, mp):
    """`image` at about `mp` megapixels (1 MP = 1024 x 1024 px), aspect kept, both sides snapped to a multiple of 16
    (resolution_steps): with 1 a 1312x704 source came back 1392x744 with an 8 px band of noise along the bottom (C26).
    mp None = as it is (ReferenceMultiLatent's "keep resolution")."""
    if mp is None:
        return image
    return g.node("ImageScaleToTotalPixels", image=image, upscale_method="lanczos", megapixels=float(mp),
                  resolution_steps=RES_STEP).out(0)


def klein_references(g, vae, pos, neg, images, mp):
    """Each image scaled to `mp` megapixels (aspect kept, 16-snapped; None = kept as it is), VAE-encoded and appended to
    positive and negative with ReferenceLatent: what ReferenceMultiLatent does, on any ComfyUI (the pods run 0.38,
    which has no ReferenceMultiLatent). Returns (pos, neg, first scaled image)."""
    first = None
    for im in images:
        im = _scaled(g, im, mp)
        first = first if first is not None else im
        lat = g.node("VAEEncode", pixels=im, vae=vae).out(0)
        pos = g.node("ReferenceLatent", conditioning=pos, latent=lat).out(0)
        neg = g.node("ReferenceLatent", conditioning=neg, latent=lat).out(0)
    return pos, neg, first


def _start_latent(g, vae, canvas, *, start=None, mask=None, empty="EmptyFlux2LatentImage"):
    """The latent the sampler starts from, on the reference canvas: masked (inpaint), img2img (start), or empty."""
    if mask is not None:
        lat = g.node("VAEEncode", pixels=canvas, vae=vae).out(0)
        return g.node("SetLatentNoiseMask", samples=lat, mask=mask).out(0)
    if start is not None:
        return g.node("VAEEncode", pixels=start, vae=vae).out(0)
    size = g.node("GetImageSize", image=canvas)
    return g.node(empty, width=size.out(0), height=size.out(1), batch_size=1).out(0)


# ---------------------------------------------------------------- builders

def klein_edit(g, p, *, source, prompt, refs=(), depth=None, start=None, mask=None, denoise=1.0, mp=1.0,
               source_ref=True):
    """FLUX 3 Klein edit. References: the source (image 1, unless source_ref=False as for Extend), the depth pass
    (image 2, ④ Frame), then the cast pictures. Latent: masked source (mask), `start` resized to the source canvas
    (img2img at `denoise`), else empty on the source canvas."""
    model, clip, vae = _loaders(g, p["weights"], p.get("clip_type") or "flux3")
    model = _with_shift(g, _with_lora(g, model, p), p)
    cfg = p.get("cfg") or 1.0
    pos = g.node("CLIPTextEncode", text=prompt, clip=clip).out(0)
    # A negative prompt only does anything with CFG above 1 (Klein is distilled for CFG 1).
    neg = (g.node("CLIPTextEncode", text=p["negative"], clip=clip).out(0) if p.get("negative") and cfg > 1
           else g.node("ConditioningZeroOut", conditioning=pos).out(0))
    images = ([source] if source_ref else []) + ([depth] if depth is not None else []) + list(refs)
    pos, neg, _ = klein_references(g, vae, pos, neg, images, mp)
    canvas = _scaled(g, source, mp)
    if start is not None:
        start = _scaled(g, start, mp)
    latent = _start_latent(g, vae, canvas, start=start, mask=mask)
    sampler, scheduler = _sampling(p, "euler", "simple")
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=p.get("steps") or 16, cfg=cfg, sampler_name=sampler,
               scheduler=scheduler, positive=pos, negative=neg, latent_image=latent,
               denoise=float(denoise) if (start is not None or mask is not None) else 1.0).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


def krea_can_edit(p) -> bool:
    return bool((p.get("weights") or {}).get("edit_lora"))


def krea_edit(g, p, *, source, prompt, refs=(), depth=None, start=None, mask=None, denoise=1.0, mp=1.0):
    """Krea 2 Turbo as an edit model, the comfyui-krea2edit pack's recipe: the Identity Edit LoRA at 1.0; the source
    (scaled to `mp`, 16-snapped) as source_image / source_latent, fit, ref_boost_a 1 (the aligned "scene" reference)
    and target_latent = the KSampler's latent; the first cast picture as the "subject" (source_image_b, ref_boost
    SUBJECT_BOOST, else 1); the instruction grounded on the source (and subject) with Krea2EditGroundedEncode;
    10 steps euler / simple, cfg 1. depth = the Krea2 depth-control LoRA on top (not used by any path yet: on ④ Frame
    identity edit + depth broke the depth hold, share/OneClick/C). Latent as klein_edit (masked / img2img / empty)."""
    w = p["weights"]
    if not krea_can_edit(p):
        raise RouterError(NO_KREA_EDIT)
    model, clip, vae = _loaders(g, w, "krea2")
    model = g.node("LoraLoaderModelOnly", model=model, lora_name=w["edit_lora"], strength_model=1.0).out(0)   # 1.0: the pack
    model = _with_lora(g, model, p)
    canvas = _scaled(g, source, mp)
    if start is not None:
        start = _scaled(g, start, mp)
    latent = _start_latent(g, vae, canvas, start=start, mask=mask, empty="EmptyLatentImage")
    subject = list(refs)[:1]
    patch = {"model": model, "source_latent": g.node("VAEEncode", pixels=canvas, vae=vae).out(0), "vae": vae,
             "source_image": canvas, "fit_mode": "fit", "ref_boost_a": SCENE_BOOST, "target_latent": latent,
             "ref_boost": SUBJECT_BOOST if subject else SCENE_BOOST}
    enc = {"clip": clip, "prompt": prompt, "image": canvas}
    if subject:
        patch["source_image_b"] = subject[0]
        enc["image_b"] = subject[0]
    model = g.node("Krea2EditModelPatch", **patch).out(0)
    if depth is not None:
        if not w.get("depth_lora"):
            raise RouterError("Krea 2 depth control needs krea2/cn/depth-control-lora.safetensors and the "
                              "comfyui-krea2-controlnet nodes.")
        model = depth_control(g, model, vae, depth, latent, w["depth_lora"])
    pos = g.node("Krea2EditGroundedEncode", **enc).out(0)
    neg = g.node("ConditioningZeroOut", conditioning=pos).out(0)
    sampler, scheduler = _sampling(p, "euler", "simple")
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=p.get("steps") or KREA_EDIT_STEPS, cfg=p.get("cfg") or 1.0,
               sampler_name=sampler, scheduler=scheduler, positive=pos, negative=neg, latent_image=latent,
               denoise=float(denoise) if (start is not None or mask is not None) else 1.0).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


def frame_start(g, image):
    """④ Frame's img2img start: the Color pass blurred to its layout (look/frame_lock.py INIT_DOWN)."""
    return blur_start(g, image)
