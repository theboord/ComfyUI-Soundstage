"""C26 router fixes (FLUX Klein and Krea 2 in the App's image-edit paths), no ComfyUI or GPU:

- the Look node's 5th output `edit_prompt` (④ Frame on Klein): an instruction, no shot-size or placement words;
- Krea 2 Whole frame / Replace / Fill through the Krea 2 Identity Edit LoRA, refusing Whole frame and Replace without it;
- every edit canvas 16-snapped (the 8 px noise band);
- Klein on a ComfyUI without ReferenceMultiLatent (the 0.38 pods): chained ReferenceLatent, and the registry gates
  FLUX 3 Klein on the "flux3" text-encoder type instead of on that node;
- FLUX.2 Klein 9B as its own frame / edit model, its LoRAs through ④ Frame's add-on stack.
Graphs are checked against tests/test_router_object_info.json (0.43 snapshot + four nodes from the 0.38 Ada pod).
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_cine_nodes  # noqa: E402,F401  (installs the comfy_api stand-in when ComfyUI is absent)
import test_router_adapters as T  # noqa: E402
from test_fill import FILL_NODES  # noqa: E402
from soundstage import nodes_look  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402
from soundstage.router import adapters as A, edit_graph as EG, lora_check as LC, registry as R  # noqa: E402
from soundstage.router.fill_graph import build_fill  # noqa: E402

OLD = set(T.OBJECT_INFO) - {"ReferenceMultiLatent"}   # a ComfyUI 0.38 as far as these graphs go


@pytest.fixture()
def info(monkeypatch):
    if not T.OBJECT_INFO:
        pytest.skip("no object_info snapshot")
    for k, v in FILL_NODES.items():
        monkeypatch.setitem(T.OBJECT_INFO, k, v)
    return T.OBJECT_INFO


def entry(mid):
    return next(m for m in T.WIRED if m["id"] == mid)


def by_type(g):
    out = {}
    for n in g.nodes.values():
        out.setdefault(n.class_type, []).append(n)
    return out


def upstream(g, link, cls):
    """Follow input links back from `link` until a node of class `cls` (breadth first), or None."""
    seen, todo = set(), [link]
    while todo:
        lk = todo.pop(0)
        if not isinstance(lk, list) or lk[0] in seen or lk[0] not in g.nodes:
            continue
        seen.add(lk[0])
        n = g.nodes[lk[0]]
        if n.class_type == cls:
            return n
        todo += [v for v in n.inputs.values() if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)]
    return None


# ---------------------------------------------------------------- 1. the Look's edit_prompt

def test_look_node_has_edit_prompt_as_its_fifth_and_last_output():
    outs = nodes_look.SoundstageLook.define_schema().outputs
    names = [getattr(o, "display_name", None) for o in outs]
    assert names == ["still_prompt", "still_negative", "motion_prompt", "look_json", "edit_prompt"]
    vals = T_values(nodes_look.SoundstageLook.execute(look="", scene_json=json.dumps(DEFAULT_SCENE)))
    assert len(vals) == 5 and vals[4] == json.loads(vals[3])["edit_prompt"]


def T_values(out):
    return getattr(out, "values", None) or getattr(out, "result", None) or out.args


def test_edit_prompt_is_an_instruction_without_shot_size_or_placement():
    r = compile_look({"film_stock": "double_x"}, DEFAULT_SCENE)
    still, edit = r["still_prompt"], r["edit_prompt"]
    # C28 (e): a photographic look's edit prompt is the measured Klein instruction, not frame_instruction(...)
    assert edit.startswith("Turn image 1, a plain 3D stage render, into a real photograph of the same shot: keep the ")
    for placed in ("wide shot", "at the left third", "in the centre", "small in frame", "seen from behind"):
        assert placed in still, placed            # the still prompt keeps them (Krea 2, Light / Strict)
        assert placed not in edit, placed
    # the look, the light and the clothes stay: only where people are and how big goes
    for kept in ("Kodak Double-X", "golden-hour sun", "35mm", "at T2", "pink button-up shirt", "Exactly two people"):
        assert kept in edit, kept


def test_a_stylised_look_keeps_the_old_frame_instruction():
    r = compile_look({"description": "a Pixar-style animated chase"}, DEFAULT_SCENE)
    edit = r["edit_prompt"]
    assert edit.startswith("Turn image 1, a grey 3D blocking render")
    assert edit == EG.frame_instruction(edit.split(" The photograph: ", 1)[1].rstrip("."))
    assert "ARRI" not in edit and "cinematic film still" in r["still_prompt"]


def test_edit_prompt_keeps_the_book_and_sfx_words():
    r = compile_look({"book": {"style": ["wet neon reflections"]}}, DEFAULT_SCENE)
    assert "wet neon reflections" in r["still_prompt"] and "wet neon reflections" in r["edit_prompt"]


# ---------------------------------------------------------------- 2. Krea 2 Identity Edit in Paint Studio

def krea_p(mode, lora=True, refs=()):
    m = entry("open.krea_2_turbo")
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=list(refs))
    p["weights"]["edit_lora"] = "Krea2/krea2_identity_edit_v1_2.safetensors" if lora else None
    return m, p


@pytest.mark.parametrize("mode", ["edit", "fill", "replace"])
def test_krea_whole_frame_replace_fill_go_through_identity_edit(info, mode):
    refs = [T.link("ref1")] if mode == "replace" else []
    m, p = krea_p(mode, refs=refs)
    g = T.FakeGraph()
    build_fill(g, m, p, {"mode": mode, "user_prompt": "brighter police lights, keep the night and rain"})
    assert T.check_graph(g) == []
    by = by_type(g)
    crop = by["SoundstageFillCrop"][0]
    lora = by["LoraLoaderModelOnly"][0]
    assert lora.inputs["lora_name"] == "Krea2/krea2_identity_edit_v1_2.safetensors" and lora.inputs["strength_model"] == 1.0
    patch, enc, ks = by["Krea2EditModelPatch"][0], by["Krea2EditGroundedEncode"][0], by["KSampler"][0]
    src = g.nodes[patch.inputs["source_image"][0]]
    assert src.class_type == "ImageScaleToTotalPixels" and src.inputs["image"] == crop.out(0)
    assert src.inputs["resolution_steps"] == 16
    assert enc.inputs["image"] == patch.inputs["source_image"]
    assert patch.inputs["fit_mode"] == "fit" and patch.inputs["ref_boost_a"] == 1.0
    assert patch.inputs["target_latent"] == ks.inputs["latent_image"]
    assert g.nodes[patch.inputs["source_latent"][0]].inputs["pixels"] == patch.inputs["source_image"]
    assert ks.inputs["model"] == patch.out(0) and ks.inputs["positive"] == enc.out(0)
    assert (ks.inputs["steps"], ks.inputs["sampler_name"], ks.inputs["scheduler"], ks.inputs["cfg"]) == (10, "euler", "simple", 1.0)
    # an instruction, not a description
    assert not enc.inputs["prompt"].startswith("brighter police lights,")
    if mode == "replace":
        assert patch.inputs["source_image_b"] == T.link("ref1") and enc.inputs["image_b"] == T.link("ref1")
        assert patch.inputs["ref_boost"] == EG.SUBJECT_BOOST
    else:
        assert "source_image_b" not in patch.inputs and patch.inputs["ref_boost"] == 1.0


@pytest.mark.parametrize("mode", ["edit", "replace"])
def test_krea_whole_frame_and_replace_refuse_without_the_lora(info, mode):
    m, p = krea_p(mode, lora=False, refs=[T.link("ref1")])
    with pytest.raises(A.RouterError) as e:
        build_fill(T.FakeGraph(), m, p, {"mode": mode})
    assert str(e.value) == EG.NO_KREA_EDIT and "Identity Edit" in str(e.value)


@pytest.mark.parametrize("mode", ["fill", "remove", "extend"])
def test_krea_without_the_lora_keeps_the_masked_repaint(info, mode):
    m, p = krea_p(mode, lora=False)
    g = T.FakeGraph()
    build_fill(g, m, p, {"mode": mode})
    by = by_type(g)
    assert "Krea2EditModelPatch" not in by and "SetLatentNoiseMask" in by and T.check_graph(g) == []


def test_krea_remove_and_extend_stay_masked_repaints_with_the_lora(info):
    for mode in ("remove", "extend"):
        m, p = krea_p(mode)
        g = T.FakeGraph()
        build_fill(g, m, p, {"mode": mode})
        assert "Krea2EditModelPatch" not in by_type(g), mode


# ---------------------------------------------------------------- 3. the 16-px snap

def test_every_scaled_canvas_is_16_snapped():
    g = T.FakeGraph()
    EG._scaled(g, T.link("img"), 1.0)
    assert [n.inputs["resolution_steps"] for n in g.nodes.values()] == [16]
    # 1312x704 at 1 MP: C26's band came from 1392x744 (744 = 46.5 x 16)
    w, h = A.snapped_canvas(1312, 704, 1.0)
    assert w % 16 == 0 and h % 16 == 0 and (w, h) == (1392, 752)
    assert EG._scaled(g, T.link("img"), None) == T.link("img")


# ---------------------------------------------------------------- 5. ReferenceLatent on a ComfyUI without ReferenceMultiLatent

KLEINS = ["open.flux3_klein", "open.flux2_klein_9b"]


@pytest.mark.parametrize("mid", KLEINS)
@pytest.mark.parametrize("i", range(3))
def test_klein_edit_chains_reference_latent_on_old_comfyui(info, mid, i):
    m = entry(mid)
    media = T.SCENARIOS["edit_image"][i]
    p = T.base_p(m, "edit_image", **media)
    p["classes"] = OLD
    p["params"]["stage_denoise"] = 0.9
    g = T.FakeGraph()
    out = A.ADAPTERS[m["adapter"]](g, m, p)
    by = by_type(g)
    assert "ReferenceMultiLatent" not in by
    n_images = 1 + len(media.get("refs") or [])
    assert len(by["ReferenceLatent"]) == 2 * n_images       # positive and negative
    ks = by["KSampler"][0]
    first = upstream(g, ks.inputs["positive"], "ReferenceLatent")
    assert first is not None
    for n in by["ImageScaleToTotalPixels"]:
        assert n.inputs["resolution_steps"] == 16
    enc = g.nodes[by["ReferenceLatent"][0].inputs["latent"][0]]
    assert enc.class_type == "VAEEncode"
    assert g.nodes[enc.inputs["pixels"][0]].inputs["image"] == T.link("img")
    assert T.check_graph(g) == [] and T.output_type(g, out["image"]) == "IMAGE"
    if media.get("control"):    # ④ Frame: the blurred start on the same 16-snapped canvas
        assert ks.inputs["denoise"] == 0.9
    else:
        assert g.nodes[ks.inputs["latent_image"][0]].class_type == "EmptyFlux2LatentImage"


def test_klein_edit_keeps_reference_multi_latent_when_comfyui_has_it(info):
    m = entry("open.flux3_klein")
    p = T.base_p(m, "edit_image", image=T.link("img"))
    p["classes"] = set(T.OBJECT_INFO)
    g = T.FakeGraph()
    A.flux3_klein(g, m, p)
    assert "ReferenceMultiLatent" in by_type(g) and "ReferenceLatent" not in by_type(g)


@pytest.mark.parametrize("mid", KLEINS)
@pytest.mark.parametrize("mode", ["fill", "remove", "replace", "extend", "edit"])
def test_klein_fill_chains_reference_latent_on_old_comfyui(info, mid, mode):
    m = entry(mid)
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=[T.link("ref1")])
    p["classes"] = OLD
    g = T.FakeGraph()
    build_fill(g, m, p, {"mode": mode})
    by = by_type(g)
    assert "ReferenceMultiLatent" not in by and T.check_graph(g) == []
    crop = by["SoundstageFillCrop"][0]
    lat = [g.nodes[n.inputs["latent"][0]] for n in by["ReferenceLatent"]]
    crop_ref = any(e.inputs["pixels"] == crop.out(0) for e in lat)
    assert crop_ref == (mode != "extend"), "the crop is image 1 except for Extend"
    assert by["CLIPLoader"][0].inputs["type"] == ("flux2" if mid == "open.flux2_klein_9b" else "flux3")


# ---------------------------------------------------------------- registry: availability and labels

POD38 = {  # the Ada pod (ComfyUI 0.38) on 2026-11-08, per /object_info/<Loader>
    "diffusion_models": ["Krea-2-Turbo.safetensors", "flux-2-klein-9b.safetensors", "flux3-image-klein-int8-convrot.safetensors"],
    "text_encoders": ["qwen3vl_4b_fp8_scaled.safetensors", "split_files/text_encoders/qwen_3_8b.safetensors"],
    "vae": ["flux2-vae.safetensors", "qwen_image_vae.safetensors"],
    "loras": ["krea2/krea2_identity_edit_v1_1.safetensors", "krea2/cn/depth-control-lora.safetensors",
              "lenovo_flux_klein9b.safetensors"],
}
CLASSES_ALL = {c for m in T.WIRED for c in m["classes"]} | {
    c for m in T.WIRED for s in m.get("optional_weights", []) for c in s.get("classes", [])}


def lister(table):
    return lambda folder: table.get(folder, [])


def test_klein_needs_the_flux3_encoder_type_not_reference_multi_latent():
    for m in (entry("open.flux3_klein"), entry("open.flux2_klein_9b")):
        assert "ReferenceMultiLatent" not in m["classes"] and "ReferenceLatent" in m["classes"]
        assert m.get("optional_classes") == ["ReferenceMultiLatent"]
    pod = (CLASSES_ALL - {"ReferenceMultiLatent", "clip_type:flux3"})       # 0.38: flux2 yes, flux3 no
    ids = [m["id"] for m in R.available_models("edit_image", pod, lister(POD38), open_only=True)]
    assert "open.flux2_klein_9b" in ids and "open.flux3_klein" not in ids
    ids = [m["id"] for m in R.available_models("edit_image", pod | {"clip_type:flux3"}, lister(POD38), open_only=True)]
    assert "open.flux3_klein" in ids, "no ReferenceMultiLatent is fine once the encoder type is there"


def test_loaded_classes_reads_clip_types_and_says_what_is_missing():
    class CLIPLoader:
        @staticmethod
        def INPUT_TYPES():
            return {"required": {"clip_name": [["a"]], "type": [["flux2", "krea2"]]}}
    got = R.loaded_classes({"CLIPLoader": CLIPLoader, "KSampler": object})
    assert got == {"CLIPLoader", "KSampler", "clip_type:flux2", "clip_type:krea2"}
    assert R.loaded_classes({"KSampler": object}) == {"KSampler"}
    msg = R.need_label("clip_type:flux3")
    assert "flux3" in msg and "0.39" in msg and R.need_label("KSampler") == "KSampler"


def test_krea_label_says_identity_edit_only_on_the_edit_stage_when_installed():
    reg = R.load_registry()
    def labels(stage, table, classes=CLASSES_ALL):
        return [lab for lab, _, m in R.stage_options(stage, classes, lister(table), open_only=True, registry=reg)
                if m and m["id"] == "open.krea_2_turbo"]
    jon = dict(POD38, loras=["Krea2/krea2_identity_edit_v1_2.safetensors"])
    assert labels("edit_image", POD38) == ["Krea 2 Turbo + Identity Edit · local [<$1M]"]
    assert labels("edit_image", jon) == ["Krea 2 Turbo + Identity Edit · local [<$1M]"], "v1_2 in Krea2/"
    assert labels("edit_image", dict(POD38, loras=[])) == ["Krea 2 Turbo · local [<$1M]"]
    assert labels("edit_image", POD38, CLASSES_ALL - {"Krea2EditGroundedEncode"}) == ["Krea 2 Turbo · local [<$1M]"]
    assert labels("generate_image", POD38) == ["Krea 2 Turbo · local [<$1M]"]
    for lab in ("Krea 2 Turbo + Identity Edit · local [<$1M]", "Krea 2 Turbo · local [<$1M]"):
        assert R.find_model(lab, reg)["id"] == "open.krea_2_turbo"
    w = R.resolve_weights(entry("open.krea_2_turbo"), lister(jon), CLASSES_ALL)
    assert w["edit_lora"] == "Krea2/krea2_identity_edit_v1_2.safetensors"


def test_flux2_klein_9b_entry_runs_on_the_pod_files_with_its_loras():
    m = entry("open.flux2_klein_9b")
    w = R.resolve_weights(m, lister(POD38), CLASSES_ALL)
    assert w == {"unet": "flux-2-klein-9b.safetensors", "text_encoder": "split_files/text_encoders/qwen_3_8b.safetensors",
                 "vae": "flux2-vae.safetensors"}
    assert R.label_for(m) == "FLUX.2 Klein 9B · local [NC]"
    assert LC.ADAPTER_FAMILY["flux2_klein"] == "klein"
    p = T.base_p(m, "edit_image", image=T.link("img"))
    p["weights"], p["loras"] = w, [{"name": "lenovo_flux_klein9b.safetensors", "strength": 0.8}]
    g = T.FakeGraph()
    A.flux3_klein(g, m, p)
    by = by_type(g)
    assert by["LoraLoaderModelOnly"][0].inputs["lora_name"] == "lenovo_flux_klein9b.safetensors"
    assert by["CLIPLoader"][0].inputs["type"] == "flux2" and by["KSampler"][0].inputs["steps"] == 4
