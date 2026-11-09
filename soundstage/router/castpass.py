"""④ Frame's cast pass: after the frame model paints frame 1, the one person in it gets the cast picture's face and hair
through a masked identity pass on FLUX.2 Klein 9B (image 1 = the painted frame, image 2 = the cast picture, the noise
mask = that person's region from the stage's ID pass of frame 1, grown and feathered).

Why this and not the other ways (Maya scene, 2026-11-09, idfix comparison sheets; S2, S4, S5 and the pull-back close-up):
- Krea 2's two-reference identity edit (the frame or the stage colour pass as "scene", the cast picture as "subject")
  put the cast picture in as a SECOND woman on medium and close shots (S2: two women; the frame-as-scene version three
  on the pull-back), or lost the framing (pull-back: silhouette match 0.22).
- Krea 2 with the cast picture as its only reference + the stage depth kept one woman but did not hold the framing on
  the pull-back close-up (it painted a medium shot; match 0.45), and left a ghost of a second figure on S2.
- FLUX.2 Klein 9B with the stage colour pass as image 1 and the cast as image 2 kept one woman with a good likeness
  but recomposed the wide-angle close-up (match 0.29): Klein takes no depth.
- The masked pass changes only the person's pixels: the framing, the room and the light stay the frame model's, and it
  can never add a person (nothing outside the mask is repainted). Match 0.91-0.94 on S2 and S4. What it cannot do is
  remove an extra person the frame model already painted: that one is the frame check's (it flags it and re-rolls).

Pure Python + numpy: nodes_router calls prepare() with the queued prompt (to find the stage) and apply() on the
expanded graph; tests run without ComfyUI.
"""
from __future__ import annotations

import hashlib
import re

import numpy as np

CAST_LABEL = "character sheet"   # web/cast/shotcast.mjs KIND_LABEL.character: "Maya — character sheet"
GROW = 24                        # px the person's silhouette is grown by (hair, loose clothes, a pose a little off)
FEATHER = 10                     # px of soft edge
STEPS = 4                        # FLUX.2 Klein 9B is 4-step distilled
MIN_AREA = 0.002                 # a person smaller than this share of frame 1 is too small for a likeness


def instruction(noun: str = "person") -> str:
    """The edit instruction: 'the woman in image 1 is the woman in image 2', keep everything else."""
    n = re.sub(r"^(?:a|an|the|one)\s+", "", (noun or "person").strip()) or "person"
    obj, pos = {"woman": ("her", "her"), "girl": ("her", "her"), "man": ("him", "his"), "boy": ("him", "his")}.get(n, ("them", "their"))
    return (f"The {n} in image 1 is the {n} in image 2: give {obj} the face and hair of the {n} in image 2. Keep {pos} "
            f"pose, {pos} clothes, the light and everything else exactly as in image 1. Do not add anyone.")


def _people(scene: dict) -> list[dict]:
    from ..look import scene as S
    return [a for a in scene.get("actors") or [] if S.classify(a)[1] == "biped"]   # seated on a chair or not


def one_person(id_rgb: np.ndarray, scene: dict) -> tuple[dict, np.ndarray] | None:
    """(actor, HxW bool mask) when exactly one person shows in frame 1's ID pass, else None (nobody, a crowd, a
    two-shot: one cast picture holds one identity, and which face goes where is not ours to guess)."""
    from ..look import frame_lock as FLK
    masks = FLK.id_masks(id_rgb, scene.get("id_colors") or {})
    area = float(id_rgb.shape[0] * id_rgb.shape[1])
    shown = [(a, masks[a["id"]]) for a in _people(scene) if a.get("id") in masks and masks[a["id"]].sum() / area >= MIN_AREA]
    return shown[0] if len(shown) == 1 else None


def pick_cast(labels: list[str], name: str) -> int | None:
    """Which reference is this person's cast picture: the character sheet labelled with their name, else the only
    character sheet, else the only reference when none is labelled (a picture on ref_1). None when it is unclear."""
    sheets = [i for i, lab in enumerate(labels) if CAST_LABEL in (lab or "").lower()]
    key = re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
    if key:
        mine = [i for i in sheets if re.sub(r"[^a-z0-9]+", " ", labels[i].lower().split("—")[0]).strip() == key]
        if len(mine) == 1:
            return mine[0]
    if len(sheets) == 1:
        return sheets[0]
    if len(labels) == 1 and not (labels[0] or "").strip():
        return 0
    return None


def mask_image(mask: np.ndarray, grow: int = GROW, feather: int = FEATHER):
    """The noise mask as a greyscale PIL image (white = repaint): grown, then feathered."""
    from PIL import Image, ImageFilter
    m = Image.fromarray(mask.astype(np.uint8) * 255)
    k = 2 * (grow // 2) + 1         # twice: grown by `grow` px in all (the idfix test masks)
    for _ in range(2):
        m = m.filter(ImageFilter.MaxFilter(k))
    return m.filter(ImageFilter.GaussianBlur(feather))


def mask_name(mask: np.ndarray) -> str:
    return "castmask_" + hashlib.sha1(np.packbits(mask).tobytes() + str(mask.shape).encode()).hexdigest()[:16] + ".png"


def prepare(scene: dict, id_rgb: np.ndarray, labels: list[str]) -> dict:
    """What the pass needs, or why it is skipped: {"ok": True, "mask": HxW bool, "ref": index, "noun": "woman",
    "name": "Maya"} or {"ok": False, "why": ...}."""
    hit = one_person(id_rgb, scene)
    if hit is None:
        return {"ok": False, "why": "the cast pass needs exactly one person in frame 1"}
    actor, mask = hit
    ref = pick_cast(labels, actor.get("name") or "")
    if ref is None:
        return {"ok": False, "why": f"no single cast picture for {actor.get('name') or 'the person'}"}
    noun = (actor.get("kind") or "person").lower()
    noun = noun if noun in ("woman", "man", "girl", "boy", "child") else "person"
    return {"ok": True, "mask": mask, "ref": ref, "noun": noun, "name": actor.get("name") or ""}


def id_weights(m: dict, w: dict) -> dict | None:
    """FLUX.2 Klein 9B's three files: the model's own when it IS Klein 9B, else the entry's optional id_* roles."""
    if m.get("adapter") == "flux2_klein":
        return {"unet": w.get("unet"), "text_encoder": w.get("text_encoder"), "vae": w.get("vae")}
    ws = {"unet": w.get("id_unet"), "text_encoder": w.get("id_text_encoder"), "vae": w.get("id_vae")}
    return ws if all(ws.values()) else None


def apply(g, m: dict, p: dict, image):
    """The pass on the expanded graph, after the frame model's `image`; `image` unchanged when it does not apply
    (no cast picture, not one person, Klein 9B not installed): the plain frame, as before."""
    cp = p.get("cast_pass") or {}
    ws = id_weights(m, p.get("weights") or {})
    refs = p.get("refs") or []
    if not cp.get("ok") or ws is None or cp["ref"] >= len(refs):
        return image
    from .edit_graph import klein_edit
    mask = g.node("LoadImageMask", image=cp["mask_file"], channel="red").out(0)
    q = {"weights": ws, "clip_type": "flux2", "seed": p["seed"], "steps": STEPS, "cfg": 1.0, "classes": p.get("classes")}
    return klein_edit(g, q, source=image, prompt=instruction(cp["noun"]), refs=[refs[cp["ref"]]], mask=mask)
