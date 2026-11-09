"""④ Frame's cast pass (soundstage/router/castpass.py, Maya scene identity test 2026-11-09): after the frame model, the
one person in frame 1 is repainted inside their own stage silhouette by FLUX.2 Klein 9B with the cast picture as
image 2. It can never add a person (nothing outside the mask changes) and it falls back to the plain frame whenever
it can't run. Graphs checked against tests/test_router_object_info.json (+ LoadImageMask from the 0.38 Ada pod)."""
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

def frame_p(mid="open.krea_2_turbo", ok=True, ids=True):
    m = entry(mid)
    p = T.base_p(m, "edit_image", image=T.link("img"), control=T.link("ctrl"), refs=[T.link("ref1"), T.link("ref2")])
    if ids and mid != "open.flux2_klein_9b":
        p["weights"].update(id_unet="flux-2-klein-9b.safetensors", id_text_encoder="qwen_3_8b.safetensors",
                            id_vae="flux2-vae.safetensors")
    elif not ids:
        p["weights"].update(id_unet=None, id_text_encoder=None, id_vae=None)
    p["classes"] = set(T.OBJECT_INFO) - {"ReferenceMultiLatent"}     # the 0.38 pods
    p["cast_pass"] = ({"ok": True, "ref": 1, "noun": "woman", "name": "Maya", "mask_file": "soundstage_cast/castmask_x.png"}
                      if ok else {"ok": False, "why": "the cast pass needs exactly one person in frame 1"})
    return m, p


@pytest.mark.parametrize("mid", ["open.krea_2_turbo", "open.flux3_klein", "open.flux2_klein_9b"])
def test_the_pass_repaints_only_the_person_with_the_cast_picture(info2, mid):
    m, p = frame_p(mid)
    g = T.FakeGraph()
    frame = T.link("img_last")
    out = CP.apply(g, m, p, frame)
    assert out != frame and T.output_type(g, out) == "IMAGE"
    by = by_type(g)
    unet = [n for n in by["UNETLoader"]]
    assert unet[0].inputs["unet_name"].startswith("flux-2-klein-9b")
    assert by["CLIPLoader"][0].inputs["type"] == "flux2"
    mask = by["LoadImageMask"][0]
    assert mask.inputs == {"image": "soundstage_cast/castmask_x.png", "channel": "red"}
    noise = by["SetLatentNoiseMask"][0]
    assert noise.inputs["mask"] == mask.out(0), "only the person's region is repainted"
    # image 1 = the painted frame, image 2 = the cast picture (ref 1: the character sheet), never the location picture
    refs = [g.nodes[n.inputs["latent"][0]] for n in by["ReferenceLatent"]]
    srcs = {tuple(g.nodes[r.inputs["pixels"][0]].inputs["image"]) for r in refs}   # VAEEncode <- the scaled picture
    assert srcs == {tuple(frame), tuple(T.link("ref2"))}
    ks = by["KSampler"][0]
    assert (ks.inputs["steps"], ks.inputs["cfg"], ks.inputs["denoise"]) == (CP.STEPS, 1.0, 1.0)
    enc = [n for n in by["CLIPTextEncode"] if "image 2" in n.inputs["text"]]
    assert enc and "Do not add anyone" in enc[0].inputs["text"]
    assert T.check_graph(g) == []


@pytest.mark.parametrize("why", ["skipped", "no_klein9b", "ref_gone"])
def test_otherwise_the_frame_is_left_as_it_was(info2, why):
    m, p = frame_p(ok=why != "skipped", ids=why != "no_klein9b")
    if why == "ref_gone":
        p["refs"] = p["refs"][:1]
    g = T.FakeGraph()
    assert CP.apply(g, m, p, T.link("img_last")) == T.link("img_last") and not g.nodes


def test_the_frame_models_carry_klein_9b_as_their_cast_pass_weights():
    for mid in ("open.krea_2_turbo", "open.flux3_klein"):
        roles = {w["role"] for w in entry(mid)["optional_weights"]}
        assert {"id_unet", "id_text_encoder", "id_vae"} <= roles, mid
    assert CP.id_weights(entry("open.flux2_klein_9b"), {"unet": "u", "text_encoder": "t", "vae": "v"}) == \
        {"unet": "u", "text_encoder": "t", "vae": "v"}
