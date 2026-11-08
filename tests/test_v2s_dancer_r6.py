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
