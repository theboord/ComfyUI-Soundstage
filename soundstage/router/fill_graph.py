"""Paint Studio's Generative Fill as a router subgraph: crop -> model -> stitch.

SoundstageFill (nodes_fill.py) expands into
  SoundstageFillCrop(image, mask)  -> crop image (Extend: the empty border pre-filled), crop mask, full regen mask, box
  <model on the crop>              -> FLUX 3 Klein / Krea 2: masked-latent inpaint (VAEEncode + SetLatentNoiseMask);
                                      Klein also sees the crop (Fill / Remove / Replace) and the references as
                                      reference latents and gets an edit instruction (tested on the pod 2026-10-30:
                                      with the crop as reference Remove gives a clean plate, without it a dust cloud;
                                      for Extend the crop reference makes Klein copy the grey border, so none);
                                      any other edit model: its own router adapter on the crop (API models)
  SoundstageFillStitch             -> the picture with only the feathered mask area replaced, colour-matched
No ComfyUI imports: built against a GraphBuilder-like `g`, so tests check it against an /object_info snapshot.
"""
from .adapters import ADAPTERS, RouterError, _loaders, _text, _with_lora

FILL_DEFAULTS = {"grow": 8, "feather": 24, "context": 0.6, "megapixels": 1.0, "overlap": 48, "denoise": 1.0,
                 "color_match": True}


VERBS = ("add", "put", "place", "make", "change", "turn", "replace", "remove", "give", "insert", "paint", "swap", "move",
         "fix", "erase", "delete", "take")
KEEP = "Keep everything else exactly the same: the same light, colours, perspective, lens and film grain."


def _cap(t: str) -> str:
    return t[:1].upper() + t[1:]


def fill_prompt(mode: str, prompt: str, n_refs: int = 0, edit: bool = True) -> str:
    """What the model is told per mode. Edit models (Klein, partner APIs) see the crop and get an instruction;
    plain image models (Krea 2) and Extend (no crop reference: it would copy the empty border) get a description."""
    text = (prompt or "").strip().rstrip(".")
    starts_with_verb = text.split(" ", 1)[0].lower() in VERBS if text else False
    if mode == "extend":
        return (f"{_cap(text or 'the same place')}. One continuous photograph that carries on seamlessly past the original "
                "frame edges, with the same light, lens, colour and film grain.")
    if not edit:
        if mode == "remove":
            return (f"{text + ', ' if text and not starts_with_verb else ''}empty background: the surrounding surfaces, "
                    "textures and shadows continue seamlessly, nothing in the way. Same light, lens and film grain.")
        return f"{text or 'the scene'}, belonging naturally in the scene, same light direction, colour, perspective, lens and film grain."
    if mode == "remove":
        if starts_with_verb:
            return f"{_cap(text)}. The background continues seamlessly where it was. {KEEP}"
        return f"Remove {text or 'the person or object in the middle of the picture'}. The background continues seamlessly where it was. {KEEP}"
    if mode == "replace":
        refs = "the reference images" if n_refs > 1 else "image 2"
        return (f"Put {text or 'the subject'} from {refs} into the middle of the picture, exactly as in the reference (same face, "
                f"hair, clothes and colours), placed naturally in the scene with matching light and perspective. {KEEP}")
    if starts_with_verb:
        return f"{_cap(text)}. {KEEP}"
    return f"Add {text or 'what belongs there'} in the middle of the picture, where it fits naturally. {KEEP}"


def _klein(g, m, p, crop_img, crop_mask):
    model, clip, vae = _loaders(g, p["weights"], "flux3")
    model = _with_lora(g, model, p)
    pos = g.node("CLIPTextEncode", text=p["prompt"], clip=clip).out(0)
    cfg = p.get("cfg") or 1.0
    neg = (g.node("CLIPTextEncode", text=p["negative"], clip=clip).out(0) if p.get("negative") and cfg > 1
           else g.node("ConditioningZeroOut", conditioning=pos).out(0))
    # Fill / Remove / Replace: the crop at its own size is image 1, so the edit model keeps what is around the area.
    # Extend: no crop reference (the model would copy the empty border); the masked latent carries the context.
    if p.get("fill_mode") != "extend":
        r = g.node("ReferenceMultiLatent", positive=pos, negative=neg, vae=vae, resolution="keep resolution",
                   **{"images.image0": crop_img})
        pos, neg = r.out(0), r.out(1)
    refs = list(p.get("refs") or [])
    if refs:
        kw = {f"images.image{i}": link for i, link in enumerate(refs)}
        r2 = g.node("ReferenceMultiLatent", positive=pos, negative=neg, vae=vae, resolution="resize",
                    **{"resolution.megapixels": 1.0}, **kw)
        pos, neg = r2.out(0), r2.out(1)
    latent = g.node("VAEEncode", pixels=crop_img, vae=vae).out(0)
    latent = g.node("SetLatentNoiseMask", samples=latent, mask=crop_mask).out(0)
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=p.get("steps") or 16, cfg=cfg,
               sampler_name="euler", scheduler="simple", positive=pos, negative=neg, latent_image=latent,
               denoise=float(p.get("denoise") or 1.0)).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


def _krea2(g, m, p, crop_img, crop_mask):
    model, clip, vae = _loaders(g, p["weights"], "krea2")
    model = _with_lora(g, model, p)
    pos, neg = _text(g, clip, p["prompt"], p.get("negative"))
    latent = g.node("VAEEncode", pixels=crop_img, vae=vae).out(0)
    latent = g.node("SetLatentNoiseMask", samples=latent, mask=crop_mask).out(0)
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=p.get("steps") or 8, cfg=p.get("cfg") or 1.0,
               sampler_name="euler_ancestral", scheduler="beta", positive=pos, negative=neg, latent_image=latent,
               denoise=float(p.get("denoise") or 1.0)).out(0)
    return g.node("VAEDecode", samples=s, vae=vae).out(0)


FILL_BUILDERS = {"flux3_klein": _klein, "krea2": _krea2}


def build_fill(g, m, p, settings=None):
    """Add the crop -> model -> stitch subgraph to g. p is the router's parameter dict (image and mask are links).
    Returns {"image": full picture, "layer": RGBA of only the generated pixels, "mask": paste alpha}."""
    s = {**FILL_DEFAULTS, **(settings or {})}
    mode = s.get("mode", "fill")
    if p.get("image") is None:
        raise RouterError("Generative Fill needs an image.")
    if p.get("mask") is None:
        raise RouterError("Generative Fill needs a mask: paint, select or extend the area to fill.")
    if mode == "replace" and not p.get("refs"):
        raise RouterError("Replace with reference needs a reference image (a character sheet or photo).")
    crop = g.node("SoundstageFillCrop", image=p["image"], mask=p["mask"], mode=mode, grow=int(s["grow"]),
                  context=float(s["context"]), megapixels=float(s["megapixels"]), overlap=int(s["overlap"]),
                  feather=int(s["feather"]))
    crop_img, crop_mask = crop.out(0), crop.out(1)
    q = dict(p)
    edit = m["adapter"] != "krea2"
    n_refs = len(p.get("refs") or [])
    if "user_prompt" in s:   # the router put only the reference labels in p["prompt"]
        q["prompt"] = f"{fill_prompt(mode, s['user_prompt'], n_refs, edit)} {p.get('prompt', '')}".strip()
    else:
        q["prompt"] = fill_prompt(mode, p.get("prompt", ""), n_refs, edit)
    q["denoise"] = float(s["denoise"])
    q["fill_mode"] = mode
    build = FILL_BUILDERS.get(m["adapter"])
    if build:
        edited = build(g, m, q, crop_img, crop_mask)
    else:
        # Any other edit model (partner APIs): its own adapter on the crop; the stitch keeps it inside the mask.
        q.update(image=crop_img, mask=crop_mask, width=0, height=0, stage="edit_image")
        edited = ADAPTERS[m["adapter"]](g, m, q)["image"]
    st = g.node("SoundstageFillStitch", original=p["image"], edited=edited, regen=crop.out(2), box=crop.out(3),
                feather=int(s["feather"]), color_match=bool(s["color_match"]))
    return {"image": st.out(0), "layer": st.out(1), "mask": st.out(2)}
