"""Video → 3D street-dance fixes, review round 4 (invented data only, no GPU):

1 the echo match splits the reply into garment pieces: reworded copies of the example are still echoes
2 every person entry over the performer gets the joints' body mask (duplicate entries no longer cut the slab)
3 the block triage judges a block over the finite scan points only (her NaN pixels are not counted)
4 wardrobe: the first-listed top can be the tied one, 'tied'/'around' only count at the waist, a named bottom under
  a dress is kept in the words
Run:  python -m pytest tests/test_v2s_dancer_r4.py -q
"""
import json
import os
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


# ------------------------------------------------------------------------------------------------ 1 echo pieces
@pytest.mark.parametrize("copied", ["An orange cable-knit sweater and brown corduroy trousers",
                                    "orange cable-knit sweater; brown corduroy trousers",
                                    "orange cable knit sweater, brown corduroy trousers",
                                    "Wardrobe: an orange cable-knit sweater, brown corduroy trousers",
                                    "an orange cable-knit sweater with brown corduroy trousers",
                                    "brown corduroy trousers, an orange cable-knit sweater"])
def test_a_reworded_copy_of_the_example_is_an_echo(copied):
    assert vlm.wardrobe_of({"wardrobe": copied}) == ""
    assert vlm.parse_reply(_person(copied))["objects"][0]["wardrobe"] == ""


@pytest.mark.parametrize("real", ["white shirt and blue jeans", "shirt, jeans", "black dress",
                                  "orange cable-knit sweater, black jeans", "hoodie and jacket",
                                  "crop top, hoodie and jacket"])
def test_a_real_read_with_example_words_is_kept(real):
    assert vlm.wardrobe_of({"wardrobe": real}) == real


# ------------------------------------------------------------------------------------------------ 2 duplicate people
from soundstage.video2stage import pipeline, scanroute  # noqa: E402
from test_v2s_dancer import _dancer_depth  # noqa: E402

TAKE = {"frames": 1, "source_frames": [0], "focal_px": 500.0, "body": [[0]]}


def _entry(label, box, h=400, w=300):
    bb = [box[0] / w * 1000, box[1] / h * 1000, box[2] / w * 1000, box[3] / h * 1000]
    return {"kind": "person", "label": label, "bbox_start": bb, "bbox_end": bb}


@pytest.mark.parametrize("dup", ["same", "right_half"])
def test_every_entry_over_the_performer_keeps_the_slab_behind_her(monkeypatch, dup):
    pytest.importorskip("cv2")
    d, uv, box, hgt = _dancer_depth(70)
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    cx = (box[0] + box[2]) / 2
    # 'same': legacy_breakdown's one person per inventory frame, never merged; 'right_half': a near-duplicate box
    # ('dancer' beside 'woman dancing') that does not hold the joints' centre but lies mostly inside her joint box
    box2 = list(box) if dup == "same" else [cx + 2, box[1], box[2] + 0.05 * hgt, box[3]]
    bd = {"objects": [_entry("woman dancing", box), _entry("dancer", box2)]}
    masks = scanroute.people_masks(bd, [d], [0.0], 1.0, take=TAKE, fps=24.0)
    assert set(masks) == {"p0", "p1"}
    cut = scanroute.without_people(d, masks, 0)
    assert np.isnan(cut[195, 150])                                  # her torso is out of the scan
    assert np.isfinite(cut[300, 60]) and np.isfinite(cut[200, 250])  # the slab 0.5 m behind her stays in it


# ------------------------------------------------------------------------------------------------ 3 triage, finite only
from soundstage.video2stage import backdrop as BD  # noqa: E402
from soundstage.video2stage import scenewords  # noqa: E402
from test_v2s_dancer import LEVEL_A, LEVEL_B, LEVEL_K, POSE0, _block  # noqa: E402
from test_v2s_dancer_r3 import _stage_with_her  # noqa: E402

BESIDE = [-0.7, 0, 5.0]    # a crate beside her at her depth: about half its footprint inside her box (u 338-453)


def _stage_with_a_crate_beside_her():
    d, bd = _stage_with_her()
    d[300:410, 390:456] = 5.0      # the crate's face the scan shows, right of her box, at about her depth
    return d, bd


def _xform_scene(*blocks):
    return {"video2stage": {"xform": {"A": LEVEL_A.tolist(), "b": LEVEL_B.tolist()}}, "actors": list(blocks)}


def test_the_triage_judges_over_finite_points_and_keeps_a_block_with_too_few():
    d, _ = _stage_with_a_crate_beside_her()
    half = d.copy()
    half[200:420, 250:412] = np.nan                      # her pixels (and her mask's margin) are out of the scan
    tri = scenewords.triage_blocks([_block("Crate", BESIDE, 1.0)], POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), half)
    assert tri["dropped"] == ["Crate"]
    allnan = np.full_like(d, np.nan)
    tri = scenewords.triage_blocks([_block("Crate", BESIDE, 1.0)], POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), allnan)
    assert tri["dropped"] == [] and tri["worded"] == ["Crate"]


def test_a_crate_beside_her_that_the_scan_shows_is_dropped_on_the_scan_path(monkeypatch):
    d, bd = _stage_with_a_crate_beside_her()
    monkeypatch.setattr(BD, "ctx_from_legacy", lambda **kw: {})
    monkeypatch.setattr(BD, "build", lambda scene, ctx: {"notes": [], "actors": [{"id": "v2s_scan", "scan": True}]})
    scene = _xform_scene(_block("Crate", [0.0, 0, 5.0], 1.0), _block("Crate beside", BESIDE, 1.0))
    notes = []
    st = scanroute.apply(scene, depths=[d], scales=[1.0], poses=[POSE0], K=LEVEL_K, files=["f0.png"], skies=None,
                         breakdown=bd, times=[0.0], duration=1.0, notes=notes, use_planes=False)
    assert st["dropped"] == ["Crate beside"], notes      # the scan shows it: no clay block stacked on it
    assert st["worded"] == ["Crate"]                     # the crate where she stands is still kept


def test_a_crate_beside_her_that_the_scan_shows_is_dropped_on_the_old_block_route():
    d, bd = _stage_with_a_crate_beside_her()
    scene = _xform_scene(_block("Crate", [0.0, 0, 5.0], 1.0), _block("Crate beside", BESIDE, 1.0))
    notes = []
    pipeline.finish_scene(scene, take=None, info={}, breakdown=bd, depths=[d], scales=[1.0], poses=[POSE0],
                          K=LEVEL_K, files=["f0.png"], skies=None, times=[0.0], clip={"duration": 1.0, "fps": 24.0},
                          scan_on=False, has_relief=True, wardrobe_ref=False, tag="t", sub="s", notes=notes)
    sp = scene["video2stage"]["set_path"]
    assert sp["dropped"] == ["Crate beside"] and sp["worded"] == ["Crate"], notes


# ------------------------------------------------------------------------------------------------ 4 wardrobe
def test_the_first_listed_top_can_be_the_tied_one():
    ap = W.parse("hoodie tied around the waist, black dress")
    assert ap["top"] == "dress" and ap["top_color"] == W.COLORS["black"] and ap.get("under") is None
    ap = W.parse("grey hoodie tied around her waist over a white tee, jeans")
    assert (ap["top"], ap["top_color"], ap["bottom"]) == ("tshirt", W.COLORS["white"], "jeans")


def test_tied_or_around_elsewhere_is_not_a_tied_garment():
    ap = W.parse("white tee, grey hoodie with tied drawstrings")
    assert ap["top"] == "hoodie" and ap["top_color"] == W.COLORS["grey"] and ap["under"] == "tshirt"
    ap = W.parse("white tee, denim jacket draped around her shoulders")
    assert ap["top"] == "jacket" and ap["under"] == "tshirt"
    ap = W.parse("white tee, red hoodie knotted at the waist, jeans")   # still carried, not worn
    assert ap["top"] == "tshirt" and ap["top_color"] == W.COLORS["white"]


def test_the_words_keep_a_named_bottom_under_a_dress():
    ap = W.parse("black coat over a red dress with black leggings")
    assert (ap["top"], ap["under"], ap["bottom"]) == ("coat", "dress", "trousers")
    assert W.words(ap) == "a black coat over a red dress and black leggings"
    # no bottom named: the dress is the skirt and the words stay as they were
    assert W.words(W.parse("light blue denim jacket over a black dress")) == "a denim jacket over a black dress"
