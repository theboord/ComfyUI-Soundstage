"""One image-edit builder for every App path that changes a picture: ④ Frame, Paint Studio's Whole frame, Generative
Fill / Remove / Replace / Extend, the Ripple "Edit first frame" (Paint Studio on frame 1 of a clip) and cast-picture edits.

Before this module each path wired the edit models its own way, and two of them did not edit at all
(docs/decisions.md 2026-11-08, share/QA/klein_fix):

- Krea 2 Turbo is a text-to-image model. Paint Studio ran it on a masked latent with a plain description and no
  reference, so Whole frame (a white mask at denoise 1) and therefore Ripple's "new reference" threw the picture away
  and painted a new one from the words. Now Krea 2 edits through the Krea 2 Identity Edit LoRA
  (krea2_identity_edit_v1_1, Krea2EditModelPatch + Krea2EditGroundedEncode): the source picture is the position-aligned
  "scene" reference, a cast picture the "subject". Without the LoRA a whole-frame edit is refused with a sentence.
- FLUX 3 Klein saw the clay Color pass as image 1 with a plain description of the shot. An edit model keeps image 1
  unless it is told what to change, so it kept the grey mannequins (share/OneClick/C gaze_A0). Every Klein prompt is
  now an instruction ("Turn image 1 ... into a real photograph ..."), and ④ Frame also hands Klein the stage depth
  pass as image 2, the only structure control a reference-latent edit model takes.
- Klein's references go through ReferenceLatent (in ComfyUI since FLUX.1 Kontext, the wiring of the official
  FLUX.2 Klein edit templates) instead of ReferenceMultiLatent, which only ComfyUI >= 0.39 has: on an older ComfyUI
  Klein vanished from every model list and Paint Studio fell back to Krea 2.

Structure control per path: ④ Frame has the stage, so its depth pass goes in (Klein: as a reference; Krea 2: the Krea2
depth-control LoRA). Paint Studio paths edit any picture (a frame of an imported clip has no stage): there the source
picture itself is the aligned reference that holds the layout, and the instruction says to keep it.

No ComfyUI imports: built against a GraphBuilder-like `g`, checked against an /object_info snapshot in tests.
"""
from __future__ import annotations

from .adapters import (RouterError, _loaders, _sampling, _with_lora, _with_shift, blur_start, depth_control,
                       KREA_STEPS)

KREA_EDIT_LORA = "krea2_identity_edit_v1_1.safetensors"   # registry role "edit_lora" (loras/krea2/ on the pods)
SCENE_BOOST = 1.0        # Krea2EditModelPatch ref_boost_a: the source picture (the layout). research/11_posestudio_hack.md
SUBJECT_BOOST = 4.0      # ref_boost: the cast picture (the likeness), the Pose Studio recipe's CHARACTER strength

NO_KREA_EDIT = ("Krea 2 Turbo is a text-to-image model: to change a whole picture it needs the Krea 2 Identity Edit LoRA "
                "(loras/krea2/krea2_identity_edit_v1_1.safetensors) and the comfyui-krea2edit nodes. Pick FLUX 3 Klein, "
                "or mask an area and use Generative Fill.")


# ---------------------------------------------------------------- prompts

def frame_instruction(description: str, depth: bool, n_refs: int = 0) -> str:
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
            "shape with the real object, and the flat walls and ground with real materials. No grey clay anywhere."
            + refs + (f" The photograph: {d}." if d else ""))


# ---------------------------------------------------------------- references

def _scaled(g, image, mp):
    return g.node("ImageScaleToTotalPixels", image=image, upscale_method="lanczos", megapixels=float(mp),
                  resolution_steps=1).out(0)


def klein_references(g, vae, pos, neg, images, mp):
    """Each image scaled to `mp` megapixels (aspect kept), VAE-encoded and appended to positive and negative with
    ReferenceLatent: what ReferenceMultiLatent "resize" does, on any ComfyUI. Returns (pos, neg, first scaled image)."""
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
    model, clip, vae = _loaders(g, p["weights"], "flux3")
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
    """Krea 2 Turbo as an edit model: the Identity Edit LoRA with the source as the aligned "scene" reference
    (ref_boost_a) and the first cast picture as the "subject" (ref_boost), the instruction grounded on both
    (Krea2EditGroundedEncode). depth = the Krea2 depth-control LoRA on top (④ Frame, the stage's depth pass).
    Latent as klein_edit."""
    w = p["weights"]
    if not krea_can_edit(p):
        raise RouterError(NO_KREA_EDIT)
    model, clip, vae = _loaders(g, w, "krea2")
    model = g.node("LoraLoaderModelOnly", model=model, lora_name=w["edit_lora"], strength_model=1.0).out(0)
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
    sampler, scheduler = _sampling(p, "euler_ancestral", "beta")
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=p.get("steps") or KREA_STEPS, cfg=p.get("cfg") or 1.0,
               sampler_name=sampler, scheduler=scheduler, positive=pos, negative=neg, latent_image=latent,
               denoise=float(denoise) if (start is not None or mask is not None) else 1.0).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


def frame_start(g, image):
    """④ Frame's img2img start: the Color pass blurred to its layout (look/frame_lock.py INIT_DOWN)."""
    return blur_start(g, image)
