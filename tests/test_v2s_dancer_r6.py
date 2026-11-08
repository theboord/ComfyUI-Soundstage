"""Video → 3D street-dance fixes, review round 6 (invented data only, no GPU):

1 a flat slab or wall within 7% of her depth is not a second body: a duplicate entry for her keeps her body mask
2 her own arms and head top leave the fused scan with her body mask
3 her region comes from the joints whenever the take tracks her (no entry, a misplaced one); without a take the
  triage's depth padding grows past a box that covers only half of her
4 the wardrobe echo is the whole example or the exact placeholder only
Run:  python -m pytest tests/test_v2s_dancer_r6.py -q
"""
import os
import re
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import vlm  # noqa: E402
from soundstage.video2stage import wardrobe as W  # noqa: E402
from test_v2s_dancer_r3 import _person  # noqa: E402

EX = vlm.WARDROBE_EXAMPLE
PLACEHOLDER = re.search(r'"wardrobe":"(<[^>]*>)', vlm.SYSTEM).group(1)


# ------------------------------------------------------------------------------------------------ 4 wardrobe echo
@pytest.mark.parametrize("real", ["white tee with a few words printed on it, black jeans", "brown corduroy trousers",
                                  "an orange cable-knit sweater", "jeans, shirt, jacket", "crop top, hoodie, jacket",
                                  "crop top, hoodie and jacket", "orange cable-knit sweater, black jeans"])
def test_real_clothing_is_never_an_echo(real):
    assert vlm.wardrobe_of({"wardrobe": real}) == real
    o = vlm.parse_reply(_person(real))["objects"][0]
    assert o["wardrobe"] == real
    assert W.appearance(o["label"], o["wardrobe"]).get("wardrobe") != "unknown"


@pytest.mark.parametrize("copied", [EX, "e.g. an orange cable-knit sweater, brown corduroy trousers", EX + " (example)",
                                    "an orange cable-knit sweater, brown corduroy pants", EX + ", white sneakers",
                                    "Brown corduroy trousers with an orange cable knit sweater.", PLACEHOLDER,
                                    PLACEHOLDER[1:-1], "every garment with its colour, pattern and length",
                                    "<people only: every garment with its colour>"])
def test_the_whole_example_or_the_placeholder_is_an_echo(copied):
    assert vlm.wardrobe_of({"wardrobe": copied}) == ""
    assert vlm.parse_reply(_person(copied))["objects"][0]["wardrobe"] == ""
    assert vlm.wardrobe_echo(copied)


# ------------------------------------------------------------------------------------------------ 1 slab, not a body
from soundstage.video2stage import pipeline, scanroute  # noqa: E402
from test_v2s_dancer import _dancer_depth, _silhouette  # noqa: E402
from test_v2s_dancer_r5 import _entry  # noqa: E402

TAKE = {"frames": 1, "source_frames": [0], "focal_px": 500.0, "body": [[0]]}


def _her_at(z, gap):
    """Her (the _silhouette shape) z metres away, a slab `gap` metres behind her from her chest down, 400 x 400."""
    d, uv, box, hgt = _dancer_depth(70, w=400)
    slab = d == 4.5
    d = d / 4.0 * z
    d[slab] = z + gap
    return d, uv, box, slab


def _cut(monkeypatch, d, uv, entries):
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    masks = scanroute.people_masks({"objects": entries}, [d], [0.0], 1.0, take=TAKE, fps=24.0)
    return scanroute.without_people(d, masks, 0)


@pytest.mark.parametrize("z, gap", [(8.0, 0.5), (4.0, 0.25)])      # the slab within 7% of her depth
@pytest.mark.parametrize("grow", [(5, 5), (40, 5)])                 # a duplicate box 5 px larger, or 40 px wider
def test_a_slab_within_7_percent_of_her_depth_is_not_a_second_body(monkeypatch, z, gap, grow):
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(z, gap)
    one = _cut(monkeypatch, d, uv, [_entry("woman dancing", box)])
    gx, gy = grow
    dup = [box[0] - gx, box[1] - gy, box[2] + gx, box[3] + gy]
    two = _cut(monkeypatch, d, uv, [_entry("woman dancing", box), _entry("dancer", dup)])
    assert np.isnan(two[195, 200])                                    # her torso is out of the scan
    assert np.isnan(two[slab]).sum() <= np.isnan(one[slab]).sum()     # the duplicate cuts no more of the slab
    assert np.isnan(two[slab]).sum() <= 0.1 * slab.sum()              # (round 5: 56,006 and 79,006 of 82,506)
    assert not scanroute._another_body(d, _entry("d", dup)["bbox_start"], np.isnan(one) & ~slab, 400, 400)


@pytest.mark.parametrize("z, gap", [(4.0, 0.5), (8.0, 0.5)])      # the slab well behind, or within 7% of her
@pytest.mark.parametrize("off", [70, -70, 45])
def test_a_second_dancer_beside_her_is_still_a_body_with_a_slab_behind_them(monkeypatch, z, gap, off):
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(z, gap)
    her, _ = _silhouette(70, 400, 400)
    his = np.roll(her, off, axis=1) & ~her
    d[his] = z + 0.05 * np.random.default_rng(5).random(int(his.sum()))   # he joins the slab when it is near her
    cut = _cut(monkeypatch, d, uv, [_entry("woman dancing", box),
                                    _entry("man dancing", [box[0] + off, box[1], box[2] + off, box[3]])])
    assert np.isfinite(cut[his]).sum() <= 0.02 * his.sum()           # he leaves the scan with her


# ------------------------------------------------------------------------------------------------ 2 her arms and head
@pytest.mark.parametrize("z, gap", [(4.0, 0.5), (6.0, 0.5)])
def test_her_arms_and_head_top_leave_the_scan_with_her_body_mask(monkeypatch, z, gap):
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(z, gap)
    her, _ = _silhouette(70, 400, 400)            # her arms hang a few pixels away from her torso
    cut = _cut(monkeypatch, d, uv, [_entry("woman dancing", box)])
    assert np.isfinite(cut[her]).sum() == 0       # round 5: 4,098 of her head and arm pixels stayed in the scan
    assert np.isnan(cut[slab]).sum() == 0         # the slab behind her stays in it
    assert np.isnan(cut[20, 180]) and np.isnan(cut[230, 150]) and np.isnan(cut[230, 250])   # crown, both hands


def test_the_build_mask_keeps_her_arms_but_not_the_hip_width():
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(4.0, 0.5)
    m = W.body_mask(d, box, uv)
    assert m[150, 150] and m[150, 250]            # both arms are in her silhouette
    g, src = W.girth_from(None, m, female=True)   # and the hip width still reads the hips alone
    g0, _ = W.girth_from(None, m & ~np.isin(np.arange(400), list(range(140, 160)) + list(range(240, 260)))[None, :])
    assert src == "the person's silhouette" and g == g0


# ------------------------------------------------------------------------------------------------ 3 her region
from soundstage.video2stage import backdrop as BD  # noqa: E402
from test_v2s_dancer import LEVEL_K, POSE0  # noqa: E402
from test_v2s_dancer_r3 import _stage_with_her  # noqa: E402
from test_v2s_dancer_r5 import _scene  # noqa: E402


def _her_joints(cx=320, top=200, bot=420):
    """COCO-18 joints (pixels) of the performer standing in _stage_with_her's rectangle (columns 250-390)."""
    hgt = bot - top
    y = lambda f: bot - 10 - f * (hgt - 25)                      # noqa: E731 - nose near the top, ankles near the soles
    uv = np.full((18, 2), np.nan)
    uv[0], uv[1] = (cx, y(1.0)), (cx, y(0.85))
    uv[2], uv[5] = (cx - 50, y(0.82)), (cx + 50, y(0.82))
    uv[3], uv[6] = (cx - 58, y(0.66)), (cx + 58, y(0.66))
    uv[4], uv[7] = (cx - 58, y(0.48)), (cx + 58, y(0.48))
    uv[8], uv[11] = (cx - 30, y(0.52)), (cx + 30, y(0.52))
    uv[9], uv[12] = (cx - 30, y(0.27)), (cx + 30, y(0.27))
    uv[10], uv[13] = (cx - 30, y(0.0)), (cx + 30, y(0.0))
    return uv


def _read(*boxes, h=480, w=640):
    return {"objects": [{"kind": "person", "label": "woman dancing",
                         "bbox_start": [b[0] / w * 1000, b[1] / h * 1000, b[2] / w * 1000, b[3] / h * 1000],
                         "bbox_end": [b[0] / w * 1000, b[1] / h * 1000, b[2] / w * 1000, b[3] / h * 1000]}
                        for b in boxes]}


def _scan_path(monkeypatch, d, bd, take):
    monkeypatch.setattr(BD, "ctx_from_legacy", lambda **kw: {})
    monkeypatch.setattr(BD, "build", lambda scene, ctx: {"notes": [], "actors": [{"id": "v2s_scan", "scan": True}]})
    notes = []
    st = scanroute.apply(_scene(), depths=[d], scales=[1.0], poses=[POSE0], K=LEVEL_K, files=["f0.png"], skies=None,
                         breakdown=bd, times=[0.0], duration=1.0, notes=notes, use_planes=False, take=take, fps=24.0)
    return st, notes


@pytest.mark.parametrize("boxes", [(), ([0, 0, 100, 100],), ([500, 40, 620, 300],)],
                         ids=["no person entry", "box in the corner", "box beside her"])
def test_the_take_alone_gives_her_region_and_keeps_the_crate_where_she_stands(monkeypatch, boxes):
    pytest.importorskip("cv2")
    d, _ = _stage_with_her()
    uv = _her_joints()
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    bd = _read(*boxes)
    st, notes = _scan_path(monkeypatch, d, bd, TAKE)
    assert st["worded"] == ["Crate"], notes
    assert st["dropped"] == ["Wall"]                                    # what the scan shows behind her still goes
    masks = scanroute.people_masks(bd, [d], [0.0], 1.0, take=TAKE, fps=24.0)
    assert BD.rle_decode(masks[scanroute.TAKE_KEY][0], d.shape)[300, 320]   # her joints' mask, under her own key


@pytest.mark.parametrize("half", [[250, 200, 390, 310], [250, 200, 320, 420]], ids=["top half", "left half"])
def test_without_a_take_a_box_over_half_of_her_keeps_the_crate_where_she_stands(monkeypatch, half):
    d, _ = _stage_with_her()
    st, notes = _scan_path(monkeypatch, d, _read(half), None)
    assert st["worded"] == ["Crate"], notes
    assert st["dropped"] == ["Wall"]
    scene = _scene()
    notes = []
    pipeline.finish_scene(scene, take=None, info={}, breakdown=_read(half), depths=[d], scales=[1.0], poses=[POSE0],
                          K=LEVEL_K, files=["f0.png"], skies=None, times=[0.0], clip={"duration": 1.0, "fps": 24.0},
                          scan_on=False, has_relief=True, wardrobe_ref=False, tag="t", sub="s", notes=notes)
    sp = scene["video2stage"]["set_path"]
    assert sp["worded"] == ["Crate"] and sp["dropped"] == ["Wall"], notes


def test_a_box_that_holds_her_does_not_open_the_padding():
    d, _ = _stage_with_her()
    m = np.zeros(d.shape, bool)
    m[200:420, 250:390] = True
    assert scanroute._open_box(m, [229, 189, 411, 431], 640, 480) == (229, 189, 411, 431)
    # the top half: open down to the frame edge, and half a box wider (round 7: one box size was not enough)
    assert scanroute._open_box(m, [229, 194, 411, 310], 640, 480) == (138, 194, 502, 480)
