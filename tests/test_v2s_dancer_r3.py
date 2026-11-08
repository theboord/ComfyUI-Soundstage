"""Video → 3D street-dance fixes, review round 3 (invented data only, no GPU):

1 the wardrobe echo filter is a whole-reply match: real reads that share a garment phrase with the prompt's example
  ("grey cable-knit sweater") survive; only the example itself is an echo
2 the route's people masks use the take's joints (wardrobe.body_mask): a slab 0.5 m behind her is not her
3 the block triage does not count the performer as the scan: a block where she stands is not dropped as covered
4 a layered read keeps the outer layer and the dress under it
Run:  python -m pytest tests/test_v2s_dancer_r3.py -q
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


def _person(wardrobe):
    return json.dumps({"setting": "street", "time": "day", "camera": {"height_m": 1.5, "type": "handheld"},
                       "objects": [{"label": "man walking", "kind": "person", "color": "#808080",
                                    "bbox": [430, 180, 570, 900], "wardrobe": wardrobe}], "set": []})


# ------------------------------------------------------------------------------------------------ 1 echo filter
@pytest.mark.parametrize("real", ["grey cable-knit sweater, black jeans", "navy corduroy trousers and a white tee",
                                  "a green cable-knit sweater", "black corduroy trousers",
                                  "crop top, hoodie and jacket tied at the waist, denim shorts"])
def test_real_clothing_that_shares_a_phrase_with_the_example_is_kept(real):
    assert vlm.wardrobe_of({"wardrobe": real}) == real
    o = vlm.parse_reply(_person(real))["objects"][0]
    assert o["wardrobe"] == real
    assert W.appearance(o["label"], o["wardrobe"]).get("wardrobe") != "unknown"


@pytest.mark.parametrize("copied", [vlm.WARDROBE_EXAMPLE, "Orange cable-knit sweater, brown corduroy trousers.",
                                    "<people only: every garment with its colour>"])
def test_a_true_echo_is_still_dropped(copied):
    assert vlm.wardrobe_of({"wardrobe": copied}) == ""
    assert vlm.parse_reply(_person(copied))["objects"][0]["wardrobe"] == ""


# ------------------------------------------------------------------------------------------------ 2 people masks
from soundstage.video2stage import backdrop as BD  # noqa: E402
from soundstage.video2stage import pipeline, scanroute, scenewords  # noqa: E402
from test_v2s_dancer import LEVEL_A, LEVEL_B, LEVEL_K, POSE0, _block, _dancer_depth  # noqa: E402

TAKE = {"frames": 1, "source_frames": [0], "focal_px": 500.0, "body": [[0]]}


def _dancer_read(box, h=400, w=300):
    bb = [box[0] / w * 1000, box[1] / h * 1000, box[2] / w * 1000, box[3] / h * 1000]
    return {"objects": [{"kind": "person", "label": "woman dancing", "bbox_start": bb, "bbox_end": bb}]}


def test_route_people_masks_use_the_joints_so_a_slab_behind_her_stays_in_the_scan(monkeypatch):
    pytest.importorskip("cv2")
    d, uv, box, hgt = _dancer_depth(70)
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    bd = _dancer_read(box)
    m = BD.rle_decode(scanroute.people_masks(bd, [d], [0.0], 1.0, take=TAKE, fps=24.0)["p0"][0])
    assert m[195, 150] and m[100, 150]                    # her torso and chest
    assert not m[300, 60] and not m[200, 250]             # the slab 0.5 m behind her, inside her box, is not her
    # without a take the loose stand-in stays the fallback (and still takes the slab: the known limit)
    loose = BD.rle_decode(scanroute.people_masks(bd, [d], [0.0], 1.0)["p0"][0])
    assert loose[195, 150] and loose[300, 60]
    # a take frame far from the sample's time: the fallback too
    late = dict(TAKE, source_frames=[240])
    assert BD.rle_decode(scanroute.people_masks(bd, [d], [0.0], 1.0, take=late, fps=24.0)["p0"][0])[300, 60]


# ------------------------------------------------------------------------------------------------ 3 triage vs performer
def _stage_with_her(h=480, w=640):
    d = np.full((h, w), 30.0, np.float32)            # the set: a surface 30 m ahead
    d[200:420, 250:390] = 5.0                        # the performer, 5 m ahead, in front of it
    bb = [250 / w * 1000, 200 / h * 1000, 390 / w * 1000, 420 / h * 1000]
    bd = {"objects": [{"kind": "person", "label": "woman dancing", "bbox_start": bb, "bbox_end": bb}]}
    return d, bd


def test_a_block_where_she_stands_is_not_dropped_as_covered_on_the_scan_path(monkeypatch):
    d, bd = _stage_with_her()
    # the bare triage against her depth: the crate where she stands reads as covered (the bug's mechanism)
    raw = scenewords.triage_blocks([_block("Crate", [0.0, 0, 5.0], 1.0)], POSE0, LEVEL_A, LEVEL_B, LEVEL_K,
                                   (640, 480), d)
    assert raw["dropped"] == ["Crate"]
    # the scan path: the fused scan itself is faked out (no GPU / splat here), the triage runs on the real code
    monkeypatch.setattr(BD, "ctx_from_legacy", lambda **kw: {})
    monkeypatch.setattr(BD, "build", lambda scene, ctx: {"notes": [], "actors": [{"id": "v2s_scan", "scan": True}]})
    scene = {"video2stage": {"xform": {"A": LEVEL_A.tolist(), "b": LEVEL_B.tolist()}},
             "actors": [_block("Crate", [0.0, 0, 5.0], 1.0), _block("Wall", [8.0, 0, 30.0], 4.0)]}
    notes = []
    st = scanroute.apply(scene, depths=[d], scales=[1.0], poses=[POSE0], K=LEVEL_K, files=["f0.png"], skies=None,
                         breakdown=bd, times=[0.0], duration=1.0, notes=notes, use_planes=False)
    names = [a["name"] for a in scene["actors"]]
    assert "Crate" in names and "Crate" in st["worded"], notes
    assert st["dropped"] == ["Wall"]                 # what the scan really shows behind her still goes


def test_a_block_where_she_stands_is_not_dropped_on_the_old_block_route():
    d, bd = _stage_with_her()
    scene = {"video2stage": {"xform": {"A": LEVEL_A.tolist(), "b": LEVEL_B.tolist()}},
             "actors": [_block("Crate", [0.0, 0, 5.0], 1.0)]}
    notes = []
    pipeline.finish_scene(scene, take=None, info={}, breakdown=bd, depths=[d], scales=[1.0], poses=[POSE0],
                          K=LEVEL_K, files=["f0.png"], skies=None, times=[0.0], clip={"duration": 1.0, "fps": 24.0},
                          scan_on=False, has_relief=True, wardrobe_ref=False, tag="t", sub="s", notes=notes)
    assert [a["name"] for a in scene["actors"]] == ["Crate"], notes
    assert scene["video2stage"]["set_path"]["dropped"] == [] and scene["video2stage"]["set_path"]["worded"] == ["Crate"]


# ------------------------------------------------------------------------------------------------ 4 layered wardrobe
@pytest.mark.parametrize("text", ["light blue denim jacket over a black dress", "a black dress with a denim jacket",
                                  "Top: denim jacket; black dress"])
def test_a_jacket_over_a_dress_keeps_both(text):
    ap = W.parse(text)
    assert ap["top"] == "jacket" and ap["top_color"] == W.COLORS["denim"]
    assert ap["under"] == "dress" and ap["under_color"] == W.COLORS["black"]
    assert ap["bottom"] == "skirt" and ap["bottom_color"] == W.COLORS["black"]   # the dress below the jacket
    assert W.words(ap) == "a denim jacket over a black dress"
    full = W.appearance("woman dancing", text)
    assert full["top"] == "jacket" and full["under"] == "dress" and "wardrobe" not in full


def test_layers_keep_the_outer_top_and_a_named_bottom():
    ap = W.parse("a white tee under a navy blazer, chinos")
    assert (ap["top"], ap["under"], ap["bottom"]) == ("jacket", "tshirt", "trousers")
    assert ap["top_color"] == W.COLORS["navy"] and ap["under_color"] == W.COLORS["white"]
    ap = W.parse("grey coat over a red dress and black leggings")
    assert (ap["top"], ap["under"], ap["bottom"], ap["bottom_color"]) == ("coat", "dress", "trousers", W.COLORS["black"])
    # a hoodie tied around the waist is carried, not worn over the crop top
    ap = W.parse("white crop top, grey hoodie tied around the waist, denim shorts")
    assert (ap["top"], ap["bottom"], ap.get("under")) == ("tank", "shorts", None)
    # one top: nothing changes, and a dress shirt is still never a dress
    assert "under" not in W.parse("short-sleeve yellow plaid shirt, light jeans")
    ap = W.parse("navy blazer over a white dress shirt")
    assert ap["top"] == "jacket" and ap["under"] == "shirt" and "skirt" not in json.dumps(ap)
