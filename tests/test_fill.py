"""Paint Studio's Generative Fill: crop / stitch math (numpy, no torch or GPU) and the crop -> model -> stitch
subgraph checked against the pod's /object_info snapshot."""
import json
import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from soundstage import fill_math as F  # noqa: E402
from soundstage.router.fill_graph import build_fill, fill_prompt  # noqa: E402
import test_router_adapters as T  # noqa: E402


def rect_mask(h, w, x0, y0, x1, y1):
    m = np.zeros((h, w), np.float32)
    m[y0:y1, x0:x1] = 1
    return m


def picture(h, w, seed=0):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.stack([xx / w, yy / h, 0.5 + 0.1 * np.sin(xx / 13)], -1)
    return np.clip(img + rng.normal(0, 0.01, img.shape), 0, 1).astype(np.float32)


# ---------------------------------------------------------------- morphology

def test_grow_and_erode_are_exact_squares():
    m = rect_mask(50, 60, 20, 20, 30, 30)
    g = F.grow(m, 5)
    assert F.mask_bbox(g) == (15, 15, 35, 35)
    assert F.mask_bbox(F.grow(g, -5)) == (20, 20, 30, 30)
    assert np.array_equal(F.grow(m, 0), m)


def test_grow_at_the_border_stays_in_bounds():
    m = rect_mask(20, 20, 0, 0, 3, 3)
    assert F.mask_bbox(F.grow(m, 4)) == (0, 0, 7, 7)


def test_blur_keeps_mean_and_softens():
    m = rect_mask(64, 64, 16, 16, 48, 48)
    b = F.blur(m, 4)
    assert b.shape == m.shape
    assert abs(b.sum() - m.sum()) / m.sum() < 0.02
    assert 0 < b[16, 32] < 1 and b[32, 32] > 0.99


# ---------------------------------------------------------------- crop geometry

def test_crop_box_contains_mask_and_context():
    x, y, w, h = F.crop_box((400, 300, 500, 360), 1920, 1080, context=0.5)
    assert x <= 400 - 50 and y <= 300 - 50 and x + w >= 550 and y + h >= 410
    assert w >= 384 and h >= 384


def test_crop_box_shifts_inside_the_image_instead_of_shrinking():
    x, y, w, h = F.crop_box((0, 0, 40, 40), 1000, 600, context=0.5, min_side=384)
    assert (x, y) == (0, 0) and w >= 384 and h >= 384
    x, y, w, h = F.crop_box((980, 580, 1000, 600), 1000, 600, context=0.5, min_side=384)
    assert x + w == 1000 and y + h == 600 and w >= 384


def test_crop_box_never_exceeds_a_small_image():
    assert F.crop_box((10, 10, 20, 20), 200, 120) == (0, 0, 200, 120)


def test_fit_size_is_about_a_megapixel_in_steps_of_16():
    tw, th = F.fit_size(600, 400, 1.0)
    assert tw % 16 == 0 and th % 16 == 0
    assert abs(tw * th - 1024 * 1024) / (1024 * 1024) < 0.05
    assert abs(tw / th - 1.5) < 0.03
    assert F.fit_size(100, 100, 1.0, max_upscale=4.0) == (400, 400)


def test_plan_crop_extend_reaches_into_the_picture():
    hole = np.zeros((540, 1290), np.float32)
    hole[:, :180] = 1
    hole[:, -180:] = 1
    plan = F.plan_crop(hole, "extend", overlap=48)
    assert plan["regen"][:, 180 + 40].min() == 1 and plan["regen"][:, 180 + 60].max() == 0
    assert plan["box"] == (0, 0, 1290, 540)


def test_plan_crop_refuses_an_empty_mask_and_bad_modes():
    with pytest.raises(ValueError, match="empty"):
        F.plan_crop(np.zeros((64, 64), np.float32))
    with pytest.raises(ValueError, match="mode"):
        F.plan_crop(rect_mask(64, 64, 1, 1, 9, 9), mode="blur")


def test_pad_amounts_extends_without_cropping():
    l, t, r, b = F.pad_amounts(1920, 1080, 2.39)
    assert t == b == 0 and l + r == round(1080 * 2.39) - 1920 and abs(l - r) <= 1
    assert F.pad_amounts(1920, 1080, 2.39, "left") == (0, 0, round(1080 * 2.39) - 1920, 0)
    l, t, r, b = F.pad_amounts(1920, 1080, 9 / 16)
    assert l == r == 0 and t + b == round(1920 * 16 / 9) - 1080
    assert F.pad_amounts(1920, 1080, 16 / 9) == (0, 0, 0, 0)


def test_pad_image_prefills_from_the_edges():
    img = np.zeros((40, 60, 3), np.float32)
    img[..., 0] = 1.0                           # a red picture
    out, hole = F.pad_image(img, 10, 0, 20, 5)
    assert out.shape == (45, 90, 3) and hole.shape == (45, 90)
    assert hole[:, :10].min() == 1 and hole[:40, 10:70].max() == 0
    assert np.allclose(out[:40, 10:70], img)
    assert out[20, 2, 0] > 0.95 and out[20, 85, 0] > 0.95   # the new area continues the red


def test_prefill_continues_surrounding_colour():
    img = np.zeros((64, 64, 3), np.float32)
    img[:, :32] = (1, 0, 0)
    img[:, 32:] = (0, 0, 1)
    hole = rect_mask(64, 64, 24, 24, 40, 40)
    obj = img.copy()
    obj[24:40, 24:40] = (0, 1, 0)                # a green object to remove
    out = F.prefill(obj, hole)
    assert np.allclose(out[hole < 0.5], obj[hole < 0.5])
    assert out[32, 25, 0] > out[32, 25, 2] and out[32, 38, 2] > out[32, 38, 0]
    assert out[24:40, 24:40, 1].max() < 0.05     # no green left


def test_crop_inputs_prefill_only_for_extend():
    img = picture(200, 300)
    m = rect_mask(200, 300, 100, 80, 160, 120)
    for mode, changed in (("fill", False), ("replace", False), ("remove", False), ("extend", True)):
        plan = F.plan_crop(m, mode)
        crop, cm = F.crop_inputs(img, m, plan, mode)
        x, y, w, h = plan["box"]
        assert crop.shape == (h, w, 3) and cm.shape == (h, w)
        assert (not np.allclose(crop, img[y:y + h, x:x + w])) == changed, mode


# ---------------------------------------------------------------- stitch

def test_stitch_leaves_everything_outside_the_feather_untouched():
    img = picture(240, 320, 1)
    m = rect_mask(240, 320, 120, 90, 200, 150)
    plan = F.plan_crop(m, "fill", grow_px=8, feather=24)
    x, y, w, h = plan["box"]
    edited = np.full((h, w, 3), 0.9, np.float32)
    out, alpha = F.stitch(img, edited, plan["regen"], plan["box"], feather=24, match_color=False)
    untouched = alpha == 0
    assert np.array_equal(out[untouched], img[untouched])
    reach = F.grow(plan["regen"], 24) > 0
    assert not (alpha > 0)[~reach].any()                       # the seam stays within `feather` of the mask
    assert np.allclose(out[plan["regen"] > 0.5], 0.9)          # inside the mask: the edit
    ring = (alpha > 0) & (alpha < 1)
    assert ring.any()                                         # a feathered seam exists


def test_stitch_alpha_ramp_is_monotonic_outward():
    m = rect_mask(100, 200, 80, 30, 120, 70)
    a = F.blend_alpha(m, 20)
    row = a[50, 119:150]   # 119 is the last masked column
    assert row[0] == 1 and row[-1] == 0
    assert np.all(np.diff(row) <= 1e-6)


def test_stitch_hard_edge_without_feather():
    img = picture(64, 64)
    m = rect_mask(64, 64, 20, 20, 40, 40)
    out, alpha = F.stitch(img, np.zeros((64, 64, 3), np.float32), m, (0, 0, 64, 64), feather=0, match_color=False)
    assert np.array_equal(alpha, m)
    assert np.allclose(out[20:40, 20:40], 0) and np.array_equal(out[m == 0], img[m == 0])


def test_stitch_checks_the_crop_size():
    img = picture(64, 64)
    with pytest.raises(ValueError, match="box"):
        F.stitch(img, np.zeros((10, 10, 3), np.float32), rect_mask(64, 64, 1, 1, 9, 9), (0, 0, 64, 64))


def test_color_match_removes_a_global_shift():
    orig = picture(120, 160, 2)
    m = rect_mask(120, 160, 60, 40, 100, 80)
    plan = F.plan_crop(m, "fill", feather=16)
    x, y, w, h = plan["box"]
    shifted = np.clip(orig[y:y + h, x:x + w] * 0.8 + 0.1, 0, 1)    # a VAE-like colour drift
    out, alpha = F.stitch(orig, shifted, plan["regen"], plan["box"], feather=16, match_color=True)
    inside = plan["regen"] > 0.5
    err_matched = np.abs(out[inside] - orig[inside]).mean()
    out2, _ = F.stitch(orig, shifted, plan["regen"], plan["box"], feather=16, match_color=False)
    err_raw = np.abs(out2[inside] - orig[inside]).mean()
    assert err_matched < err_raw * 0.35


def test_box_json_round_trip():
    s = F.box_json((3, 4, 50, 60), (512, 608))
    assert F.parse_box(s) == (3, 4, 50, 60) and json.loads(s)["tw"] == 512


# ---------------------------------------------------------------- the subgraph

FILL_NODES = {
    "SoundstageFillCrop": {"input": {"required": {
        "image": ["IMAGE"], "mask": ["MASK"], "mode": [list(F.MODES)], "grow": ["INT", {"min": 0, "max": 256}],
        "context": ["FLOAT", {"min": 0.0, "max": 4.0}], "megapixels": ["FLOAT", {"min": 0.25, "max": 4.0}],
        "overlap": ["INT", {"min": 0, "max": 256}], "feather": ["INT", {"min": 0, "max": 256}]}},
        "output": ["IMAGE", "MASK", "MASK", "STRING"]},
    "SoundstageFillStitch": {"input": {"required": {
        "original": ["IMAGE"], "edited": ["IMAGE"], "regen": ["MASK"], "box": ["STRING", {}],
        "feather": ["INT", {"min": 0, "max": 256}], "color_match": ["BOOLEAN", {}]}},
        "output": ["IMAGE", "IMAGE", "MASK"]},
}


@pytest.fixture()
def info(monkeypatch):
    if not T.OBJECT_INFO:
        pytest.skip("no object_info snapshot")
    for k, v in FILL_NODES.items():
        monkeypatch.setitem(T.OBJECT_INFO, k, v)
    return T.OBJECT_INFO


EDIT_MODELS = [m for m in T.WIRED if "edit_image" in m["stages"]]


@pytest.mark.parametrize("mid", [m["id"] for m in EDIT_MODELS])
@pytest.mark.parametrize("mode", ["fill", "remove", "extend", "replace"])
def test_fill_graph_is_valid_for_every_edit_model(info, mid, mode):
    m = next(x for x in EDIT_MODELS if x["id"] == mid)
    g = T.FakeGraph()
    refs = [T.link("ref1")] if mode == "replace" else []
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=refs)
    try:
        outs = build_fill(g, m, p, {"mode": mode})
    except T.A.RouterError as e:   # some partner adapters refuse a combination; never a crash
        pytest.skip(str(e))
    assert T.check_graph(g) == []
    assert T.output_type(g, outs["image"]) == "IMAGE" and T.output_type(g, outs["mask"]) == "MASK"
    types = [n.class_type for n in g.nodes.values()]
    assert types.count("SoundstageFillCrop") == 1 and types.count("SoundstageFillStitch") == 1


def test_klein_fill_inpaints_a_masked_latent_with_the_crop_and_refs(info):
    m = next(x for x in T.WIRED if x["adapter"] == "flux3_klein")
    g = T.FakeGraph()
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=[T.link("ref1"), T.link("ref2")])
    p["seed"] = 77
    build_fill(g, m, p, {"mode": "replace", "denoise": 0.9})
    by = {}
    for n in g.nodes.values():
        by.setdefault(n.class_type, []).append(n)
    crop = by["SoundstageFillCrop"][0]
    noise = by["SetLatentNoiseMask"][0]
    assert noise.inputs["mask"] == crop.out(1)
    enc = g.nodes[noise.inputs["samples"][0]]
    assert enc.class_type == "VAEEncode" and enc.inputs["pixels"] == crop.out(0)
    rml = by["ReferenceMultiLatent"]
    assert rml[0].inputs["images.image0"] == crop.out(0) and rml[0].inputs["resolution"] == "keep resolution"
    assert rml[1].inputs["images.image0"] == T.link("ref1") and rml[1].inputs["images.image1"] == T.link("ref2")
    ks = by["KSampler"][0]
    assert ks.inputs["latent_image"] == noise.out(0) and ks.inputs["positive"] == rml[1].out(0)
    assert ks.inputs["seed"] == 77 and ks.inputs["denoise"] == 0.9 and ks.inputs["steps"] == 16
    st = by["SoundstageFillStitch"][0]
    assert st.inputs["original"] == T.link("img") and st.inputs["regen"] == crop.out(2) and st.inputs["box"] == crop.out(3)


def test_fill_graph_needs_a_mask_and_replace_needs_a_reference(info):
    m = next(x for x in T.WIRED if x["adapter"] == "flux3_klein")
    with pytest.raises(T.A.RouterError, match="mask"):
        build_fill(T.FakeGraph(), m, T.base_p(m, "edit_image", image=T.link("img")), {"mode": "fill"})
    with pytest.raises(T.A.RouterError, match="reference"):
        build_fill(T.FakeGraph(), m, T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask")),
                   {"mode": "replace"})


def test_fill_prompts_per_mode():
    assert fill_prompt("fill", "a brass floor lamp").startswith("Add a brass floor lamp in the middle of the picture")
    assert fill_prompt("fill", "make his shirt red").startswith("Make his shirt red. Keep everything else")
    assert fill_prompt("remove", "").startswith("Remove the person or object in the middle of the picture.")
    assert fill_prompt("remove", "the cowboy").startswith("Remove the cowboy.")
    assert fill_prompt("remove", "erase the sign").startswith("Erase the sign.")
    ext = fill_prompt("extend", "desert road")
    assert ext.startswith("Desert road.") and "past the original frame edges" in ext and "Keep" not in ext
    assert "the reference images" in fill_prompt("replace", "the sheriff", 2) and "image 2" in fill_prompt("replace", "", 1)
    plain = fill_prompt("remove", "", edit=False)        # Krea 2 is not an edit model: a description
    assert plain.startswith("empty background") and "Remove" not in plain


def test_klein_extend_has_no_crop_reference_but_keeps_refs(info):
    m = next(x for x in T.WIRED if x["adapter"] == "flux3_klein")
    g = T.FakeGraph()
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=[T.link("ref1")])
    build_fill(g, m, p, {"mode": "extend", "user_prompt": "desert street"})
    rml = [n for n in g.nodes.values() if n.class_type == "ReferenceMultiLatent"]
    assert len(rml) == 1 and rml[0].inputs["images.image0"] == T.link("ref1")
    enc = next(n.inputs["text"] for n in g.nodes.values() if n.class_type == "CLIPTextEncode")
    assert enc.startswith("Desert street.")


def test_router_reference_labels_follow_the_instruction(info):
    m = next(x for x in T.WIRED if x["adapter"] == "flux3_klein")
    g = T.FakeGraph()
    p = T.base_p(m, "edit_image", image=T.link("img"), mask=T.link("mask"), refs=[T.link("ref1")])
    p["prompt"] = "Keep each subject's appearance from its reference: image 2 shows Sheriff."
    build_fill(g, m, p, {"mode": "replace", "user_prompt": "the sheriff"})
    text = next(n.inputs["text"] for n in g.nodes.values() if n.class_type == "CLIPTextEncode")
    assert text.startswith("Put the sheriff from image 2") and text.endswith("image 2 shows Sheriff.")
