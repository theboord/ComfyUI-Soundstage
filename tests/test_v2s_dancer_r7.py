"""Video → 3D street-dance fixes, review round 7 (invented data only, no GPU):

1 a cut-short or reworded wardrobe placeholder is an echo, and never replaces a real read in merge_reads or
  enrich_breakdown
Run:  python -m pytest tests/test_v2s_dancer_r7.py -q
"""
import os
import sys

import numpy as np  # noqa: F401
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import vlm  # noqa: E402
from test_v2s_dancer_r3 import _person  # noqa: E402

FRAGMENTS = ["every garment with its colour, pattern and length e.g.", "every garment with colour, pattern and length",
             "every garment, colour, pattern, length", "people only", "<...>", "People only.",
             "<people only: every garment with its colour, pattern and length, e.g. an orange cable-knit"]


# ------------------------------------------------------------------------------------------------ 1 placeholder
@pytest.mark.parametrize("frag", FRAGMENTS)
def test_a_cut_short_or_reworded_placeholder_is_an_echo(frag):
    assert vlm.wardrobe_echo(frag)
    assert vlm.wardrobe_of({"wardrobe": frag}) == ""
    assert vlm.parse_reply(_person(frag))["objects"][0]["wardrobe"] == ""


@pytest.mark.parametrize("real", ["red hoodie, blue jeans", "patterned shirt and long jeans", "black dress",
                                  "brown corduroy trousers", "white tee with a few words printed on it, black jeans"])
def test_real_reads_are_not_placeholder_fragments(real):
    assert not vlm.wardrobe_echo(real)


def _obj(wardrobe, bbox=(430, 180, 570, 900)):
    return {"label": "woman dancing", "kind": "person", "color": "#e0b030", "bbox": list(bbox), "facing": "",
            "moving": True, "wardrobe": wardrobe}


@pytest.mark.parametrize("frag", FRAGMENTS)
def test_an_end_frame_placeholder_never_replaces_a_real_first_frame_read(frag):
    first = {"setting": "street", "time": "day", "camera": {"height_m": 1.5}, "objects": [_obj("red hoodie, blue jeans")],
             "set": []}
    last = {"objects": [_obj(frag, (440, 180, 580, 900))]}       # given raw, as a caller may (not through parse_reply)
    m = vlm.merge_reads(first, last)
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"   # 8f04bf1: the longer placeholder won
    # the other way round: a placeholder first, a real read at the end, the real read is kept
    m = vlm.merge_reads(dict(first, objects=[_obj(frag)]), {"objects": [_obj("red hoodie, blue jeans")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"


def test_a_garment_read_beats_a_longer_read_that_names_no_garment():
    first = {"setting": "", "time": "", "camera": {}, "objects": [_obj("red hoodie")], "set": []}
    m = vlm.merge_reads(first, {"objects": [_obj("a bright colourful outfit for dancing in the street")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie"
    m = vlm.merge_reads(first, {"objects": [_obj("red hoodie, blue jeans")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"   # the fuller garment read still wins


@pytest.mark.parametrize("frag", FRAGMENTS + [vlm.WARDROBE_EXAMPLE])
def test_an_inventory_placeholder_never_replaces_a_real_breakdown_read(frag):
    bd = {"setting": "street", "time": "day", "camera": {}, "set": [],
          "objects": [dict(_obj("red hoodie, blue jeans"), bbox_start=[430, 180, 570, 900])]}
    inv = {"items": [{"name": "woman", "kind": "person", "bbox": [430, 180, 570, 900], "wardrobe": frag}],
           "surfaces": []}
    assert vlm.enrich_breakdown(bd, inv)["objects"][0]["wardrobe"] == "red hoodie, blue jeans"
    inv["items"][0]["wardrobe"] = "red zip-up hoodie with white drawstrings, light blue jeans"
    assert vlm.enrich_breakdown(bd, inv)["objects"][0]["wardrobe"].startswith("red zip-up")
