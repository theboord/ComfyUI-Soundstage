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
                                    "orange cable-knit sweater", "  An ORANGE cable-knit sweater ",
                                    "brown corduroy trousers", "crop top, hoodie, jacket",
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
