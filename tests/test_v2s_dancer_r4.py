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
