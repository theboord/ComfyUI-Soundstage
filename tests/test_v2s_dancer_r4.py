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
                                    "brown corduroy trousers, an orange cable-knit sweater",
                                    "crop top, hoodie and jacket"])
def test_a_reworded_copy_of_the_example_is_an_echo(copied):
    assert vlm.wardrobe_of({"wardrobe": copied}) == ""
    assert vlm.parse_reply(_person(copied))["objects"][0]["wardrobe"] == ""


@pytest.mark.parametrize("real", ["white shirt and blue jeans", "shirt, jeans", "black dress",
                                  "orange cable-knit sweater, black jeans", "hoodie and jacket"])
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
