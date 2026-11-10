"""④ Frame's cast pass (soundstage/router/castpass.py, Maya scene identity test 2026-11-09): after the frame model, the
one person in frame 1 is repainted inside their own stage silhouette by FLUX 3 Klein with the cast picture as image 2
(FLUX.2 Klein 9B only where FLUX 3 Klein is not installed and 9B is). It can never add a person (nothing outside the
mask changes) and it falls back to the plain frame whenever it can't run. Graphs checked against
tests/test_router_object_info.json (+ LoadImageMask from the 0.38 Ada pod)."""
import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_router_adapters as T  # noqa: E402
from test_c26_edit_paths import by_type, entry, info  # noqa: E402,F401  (fixture)
from soundstage.router import castpass as CP  # noqa: E402

LOAD_IMAGE_MASK = {"input": {"required": {"image": [["soundstage_cast/castmask_x.png"], {"image_upload": True}],
                                          "channel": [["alpha", "red", "green", "blue"]]}},
                   "input_order": {"required": ["image", "channel"]}, "output": ["MASK"], "output_is_list": [False],
                   "output_name": ["MASK"], "name": "LoadImageMask"}
MAYA, DOOR = [0, 255, 212], [255, 0, 0]
SCENE = {"id_colors": {"maya": MAYA, "door_main": DOOR},
         "actors": [{"id": "maya", "name": "Maya", "kind": "woman", "position": [0, 0, 0]},
                    {"id": "door_main", "name": "Door", "kind": "door", "position": [2, 0, 0]}]}


def id_pass(*people):
    img = np.zeros((128, 256, 3), np.uint8)
    img[10:120, 200:240] = DOOR
    for x0, col in people:
        img[20:110, x0:x0 + 30] = col
    return img


@pytest.fixture()
def info2(info, monkeypatch):
    monkeypatch.setitem(T.OBJECT_INFO, "LoadImageMask", LOAD_IMAGE_MASK)
    return info


# ---------------------------------------------------------------- who, and which picture

def test_one_person_in_frame_1_gives_their_silhouette():
    hit = CP.one_person(id_pass((60, MAYA)), SCENE)
    assert hit is not None and hit[0]["id"] == "maya"
    assert hit[1][60:100, 70].all() and not hit[1][:, 205].any(), "the door is not the person"


def test_nobody_or_two_people_skip_the_pass():
    assert CP.one_person(id_pass(), SCENE) is None
    two = {**SCENE, "id_colors": {**SCENE["id_colors"], "jane": [255, 0, 223]},
           "actors": SCENE["actors"] + [{"id": "jane", "name": "Jane", "kind": "woman", "position": [1, 0, 0]}]}
    assert CP.one_person(id_pass((20, MAYA), (110, [255, 0, 223])), two) is None
    assert not CP.prepare(two, id_pass((20, MAYA), (110, [255, 0, 223])), ["Maya — character sheet"])["ok"]


def test_the_cast_picture_is_the_persons_character_sheet():
    labels = ["Rented room — location", "Maya — character sheet", "Pink shirt — wardrobe"]
    assert CP.pick_cast(labels, "Maya") == 1
    assert CP.pick_cast(["Jane — character sheet", "Maya — character sheet"], "Maya") == 1
    assert CP.pick_cast(["Someone — character sheet", "Room — location"], "Maya") == 0, "the only sheet"
    assert CP.pick_cast(["A — character sheet", "B — character sheet"], "Maya") is None, "unclear: skip"
    assert CP.pick_cast([""], "Maya") == 0, "one unlabelled picture on ref_1"
    assert CP.pick_cast(["Room — location"], "Maya") is None


def test_prepare_says_what_the_pass_needs():
    cp = CP.prepare(SCENE, id_pass((60, MAYA)), ["Room — location", "Maya — character sheet"])
    assert cp["ok"] and cp["ref"] == 1 and cp["noun"] == "woman" and cp["name"] == "Maya"
    assert cp["mask"].shape == (128, 256)
    m = np.asarray(CP.mask_image(cp["mask"]))
    assert m[60, 75] == 255 and m[60, 60 - CP.GROW] < 255 and m[60, 59] > 0, "grown and feathered"
    assert CP.mask_name(cp["mask"]) == CP.mask_name(cp["mask"].copy()), "the same mask, the same file"


def test_the_instruction_keeps_everything_but_the_face():
    t = CP.instruction("woman")
    assert t.startswith("The woman in image 1 is the woman in image 2: give her the face and hair")
    assert "Keep her pose, her clothes, the light" in t and "Do not add anyone" in t
    assert "give him" in CP.instruction("man") and "give them" in CP.instruction("person")


# ---------------------------------------------------------------- the graph

FLUX3 = {"id_unet": "flux3-image-klein-int8-convrot.safetensors", "id_text_encoder": "qwen3vl_4b_fp8_scaled.safetensors",
         "id_vae": "flux2-vae.safetensors"}
NO_FLUX3 = {k: None for k in FLUX3}
K9 = {"id9_unet": "flux-2-klein-9b.safetensors", "id9_text_encoder": "qwen_3_8b.safetensors", "id9_vae": "flux2-vae.safetensors"}
NO_K9 = {k: None for k in K9}


def frame_p(mid="open.krea_2_turbo", ok=True, ids=True, k9=False, multi=False):
    """ids: FLUX 3 Klein's id_* files resolved; k9: Klein 9B's id9_* files; multi: ComfyUI 0.39+ (ReferenceMultiLatent)."""
    m = entry(mid)
    p = T.base_p(m, "edit_image", image=T.link("img"), control=T.link("ctrl"), refs=[T.link("ref1"), T.link("ref2")])
    p["weights"].update(FLUX3 if ids else NO_FLUX3)
    p["weights"].update(K9 if k9 else NO_K9)
    p["classes"] = set(T.OBJECT_INFO) - (set() if multi else {"ReferenceMultiLatent"})   # 0.44 pods / 0.38
    p["cast_pass"] = ({"ok": True, "ref": 1, "noun": "woman", "name": "Maya", "mask_file": "soundstage_cast/castmask_x.png"}
                      if ok else {"ok": False, "why": "the cast pass needs exactly one person in frame 1"})
    return m, p


@pytest.mark.parametrize("mid", ["open.krea_2_turbo", "open.flux3_klein", "open.flux2_klein_9b"])
def test_the_pass_repaints_only_the_person_with_the_cast_picture(info2, mid):
    m, p = frame_p(mid, k9=True)     # Klein 9B installed too: FLUX 3 Klein still does the pass, on every frame model
    g = T.FakeGraph()
    frame = T.link("img_last")
    out = CP.apply(g, m, p, frame)
    assert out != frame and T.output_type(g, out) == "IMAGE"
    by = by_type(g)
    unet = [n for n in by["UNETLoader"]]
    assert unet[0].inputs["unet_name"].startswith("flux3-image-klein")
    assert by["CLIPLoader"][0].inputs["type"] == "flux3"
    assert by["CLIPLoader"][0].inputs["clip_name"].startswith("qwen3vl_4b")
    mask = by["LoadImageMask"][0]
    assert mask.inputs == {"image": "soundstage_cast/castmask_x.png", "channel": "red"}
    noise = by["SetLatentNoiseMask"][0]
    assert noise.inputs["mask"] == mask.out(0), "only the person's region is repainted"
    # image 1 = the painted frame, image 2 = the cast picture (ref 1: the character sheet), never the location picture
    refs = [g.nodes[n.inputs["latent"][0]] for n in by["ReferenceLatent"]]
    srcs = {tuple(g.nodes[r.inputs["pixels"][0]].inputs["image"]) for r in refs}   # VAEEncode <- the scaled picture
    assert srcs == {tuple(frame), tuple(T.link("ref2"))}
    ks = by["KSampler"][0]
    assert (ks.inputs["steps"], ks.inputs["cfg"], ks.inputs["denoise"]) == (16, 1.0, 1.0)
    enc = [n for n in by["CLIPTextEncode"] if "image 2" in n.inputs["text"]]
    assert enc and "Do not add anyone" in enc[0].inputs["text"]
    assert T.check_graph(g) == []


def test_on_comfyui_0_39_plus_the_references_go_through_reference_multi_latent(info2):
    """The pods (0.44.2): one ReferenceMultiLatent, the frame and the cast picture each on its 16-snapped canvas
    ("keep resolution"), image 1 the very canvas the masked latent is encoded from."""
    m, p = frame_p(multi=True)
    g = T.FakeGraph()
    frame = T.link("img_last")
    out = CP.apply(g, m, p, frame)
    by = by_type(g)
    assert "ReferenceLatent" not in by and len(by["ReferenceMultiLatent"]) == 1
    rml = by["ReferenceMultiLatent"][0]
    assert rml.inputs["resolution"] == "keep resolution" and "resolution.megapixels" not in rml.inputs
    im0, im1 = rml.inputs["images.image0"], rml.inputs["images.image1"]
    assert g.nodes[im0[0]].inputs["image"] == frame and g.nodes[im1[0]].inputs["image"] == T.link("ref2")
    assert all(g.nodes[i[0]].inputs["resolution_steps"] == 16 for i in (im0, im1))
    noise = by["SetLatentNoiseMask"][0]
    enc = g.nodes[noise.inputs["samples"][0]]
    assert enc.class_type == "VAEEncode" and enc.inputs["pixels"] == im0, "the masked latent is on image 1's canvas"
    ks = by["KSampler"][0]
    assert ks.inputs["positive"] == rml.out(0) and ks.inputs["negative"] == rml.out(1)
    assert T.check_graph(g) == [] and T.output_type(g, out) == "IMAGE"


@pytest.mark.parametrize("mid", ["open.krea_2_turbo", "open.flux2_klein_9b"])
def test_klein_9b_does_the_pass_only_when_flux_3_klein_is_missing(info2, mid):
    m, p = frame_p(mid, ids=False, k9=True)
    g = T.FakeGraph()
    CP.apply(g, m, p, T.link("img_last"))
    by = by_type(g)
    assert by["UNETLoader"][0].inputs["unet_name"].startswith("flux-2-klein-9b")
    assert by["CLIPLoader"][0].inputs["type"] == "flux2"
    assert by["KSampler"][0].inputs["steps"] == 4, "4-step distilled"
    assert T.check_graph(g) == []


@pytest.mark.parametrize("why", ["skipped", "no_klein", "ref_gone"])
def test_otherwise_the_frame_is_left_as_it_was(info2, why):
    m, p = frame_p(ok=why != "skipped", ids=why != "no_klein")     # no_klein: neither FLUX 3 Klein nor Klein 9B
    if why == "ref_gone":
        p["refs"] = p["refs"][:1]
    g = T.FakeGraph()
    assert CP.apply(g, m, p, T.link("img_last")) == T.link("img_last") and not g.nodes


def test_the_frame_models_carry_flux_3_klein_then_klein_9b_as_their_cast_pass_weights():
    for mid in ("open.krea_2_turbo", "open.flux3_klein", "open.flux2_klein_9b"):
        spec = {w["role"]: w for w in entry(mid)["optional_weights"]}
        assert {"id_unet", "id_text_encoder", "id_vae", "id9_unet", "id9_text_encoder", "id9_vae"} <= set(spec), mid
        assert spec["id_unet"]["any"] == ["flux3-image-klein-int8-convrot.safetensors"]
        assert "qwen3vl_4b_fp8_scaled.safetensors" in spec["id_text_encoder"]["any"]
        assert all(spec[r]["classes"] == ["clip_type:flux3"] for r in ("id_unet", "id_text_encoder", "id_vae")), \
            "FLUX 3 Klein needs ComfyUI's flux3 text-encoder type (0.39+)"
    own = {"unet": "u", "text_encoder": "t", "vae": "v"}
    assert CP.id_weights(entry("open.flux3_klein"), {**own, **K9}) == (own, "flux3")
    assert CP.id_weights(entry("open.flux2_klein_9b"), {**own, **FLUX3})[1] == "flux3", "FLUX 3 Klein first, on 9B too"
    assert CP.id_weights(entry("open.flux2_klein_9b"), {**own, **NO_FLUX3}) == (own, "flux2")
    assert CP.id_weights(entry("open.krea_2_turbo"), {**own, **NO_FLUX3, **K9})[1] == "flux2"
    assert CP.id_weights(entry("open.krea_2_turbo"), {**own, **NO_FLUX3, **NO_K9}) is None


def test_a_comfyui_without_the_flux3_type_does_not_resolve_flux_3_klein_for_the_pass():
    from soundstage.router import registry as R
    files = {"diffusion_models": ["flux3-image-klein-int8-convrot.safetensors", "flux-2-klein-9b.safetensors"],
             "text_encoders": ["qwen3vl_4b_fp8_scaled.safetensors", "qwen_3_8b.safetensors"], "vae": ["flux2-vae.safetensors"]}
    m = entry("open.krea_2_turbo")
    old = R.resolve_weights(m, lambda folder: files.get(folder, []), {"CLIPLoader", "clip_type:flux2"})
    new = R.resolve_weights(m, lambda folder: files.get(folder, []), {"CLIPLoader", "clip_type:flux2", "clip_type:flux3"})
    assert CP.id_weights(m, old)[1] == "flux2" and CP.id_weights(m, new)[1] == "flux3"


def test_a_person_seated_on_a_chair_is_still_the_one_person():
    # Maya S4 / S5 sit on the chair (mount_id): the first version skipped every mounted person and the pass never ran
    seated = {**SCENE, "actors": [{**SCENE["actors"][0], "mount_id": "chair_main", "pose": "sit"}, SCENE["actors"][1]]}
    hit = CP.one_person(id_pass((60, MAYA)), seated)
    assert hit is not None and hit[0]["id"] == "maya"


# ---------------------------------------------------------------- no face in frame 1: no pass (Maya S3, an insert)

def _cam(position, target, focal=50.0):
    return [{"frame": 0, "position": position, "target": target, "focal_mm": focal},
            {"frame": 1, "position": position, "target": target, "focal_mm": focal}]


INSERT = {**SCENE, "camera_track": _cam([0, 0.95, 0.7], [0, 0.9, 0])}      # on the hands and hips, head far above
WIDE = {**SCENE, "camera_track": _cam([0, 1.5, 6.0], [0, 1.0, 0])}         # the whole person, head in frame


def test_an_insert_with_the_head_out_of_frame_skips_the_cast_pass():
    """S3 (hands only) ran the pass and pasted the cast picture's jeans and a boot into the silhouette."""
    assert CP.head_in_frame(INSERT, "maya") is False
    cp = CP.prepare(INSERT, id_pass((60, MAYA)), ["Maya — character sheet"])
    assert not cp["ok"] and "no face" in cp["why"] and "mask" not in cp


def test_a_person_with_the_head_in_frame_still_gets_the_pass():
    assert CP.head_in_frame(WIDE, "maya") is True
    assert CP.prepare(WIDE, id_pass((60, MAYA)), ["Maya — character sheet"])["ok"]


def test_when_the_stage_cannot_tell_the_id_pass_decides_as_before():
    assert CP.head_in_frame({**SCENE, "camera_track": "broken"}, "maya") is None
    assert CP.prepare({**SCENE, "camera_track": "broken"}, id_pass((60, MAYA)), ["Maya — character sheet"])["ok"]
    assert CP.head_in_frame(WIDE, "nobody") is None
