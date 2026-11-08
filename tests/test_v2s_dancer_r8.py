"""Video → 3D street-dance fixes, review round 8 (invented data only, no GPU):

1 a second body over her is a head-and-shoulders shape at her depth in her head band, not whatever misses the box
  sides: a wall from her shoulders down, a pillar beside her, railing posts and a panel rising above her head are no
  second body, so a duplicate entry for her keeps her body mask
Run:  python -m pytest tests/test_v2s_dancer_r8.py -q
"""
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import scanroute  # noqa: E402,F401
from test_v2s_dancer_r5 import _entry  # noqa: E402
from test_v2s_dancer_r6 import _cut, _her_at  # noqa: E402


# ------------------------------------------------------------------------------------------------ 1 a second body
def _surface(kind):
    """A flat surface of the set in her head band (rows 10-129 of _her_at's frame), at the slab's depth."""
    s = np.zeros((400, 400), bool)
    if kind == "wall":                    # a full-width wall from her shoulders down
        s[70:, :] = True
    elif kind == "pillar":                # a pillar beside her, inside the 40 px wider duplicate box
        s[:, 70:110] = True
    elif kind == "posts":                 # railing posts in her head band
        for c in range(60, 345, 25):
            s[60:150, c:c + 5] = True
    elif kind == "posts and rail":        # the same with a top rail across the box
        for c in range(60, 345, 25):
            s[60:150, c:c + 5] = True
        s[56:62, 55:345] = True
    elif kind == "panel":                 # a flat panel just wider than her, rising above her head
        s[:, 130:270] = True
    return s


@pytest.mark.parametrize("z, gap", [(8.0, 0.5), (4.0, 0.25)])
@pytest.mark.parametrize("kind", ["wall", "pillar", "posts", "posts and rail", "panel"])
def test_a_flat_surface_in_her_head_band_is_not_a_second_body(monkeypatch, kind, z, gap):
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(z, gap)                               # the slab from row 150 down, as before
    her = d < z * 1.05
    s = (_surface(kind) | slab) & ~her
    d[s] = z + gap
    one = _cut(monkeypatch, d, uv, [_entry("woman dancing", box)])
    dup = [box[0] - 40, box[1] - 5, box[2] + 40, box[3] + 5]
    two = _cut(monkeypatch, d, uv, [_entry("woman dancing", box), _entry("dancer", dup)])
    assert np.isnan(two[195, 200])                                   # her torso is out of the scan
    assert np.isnan(two[s]).sum() <= np.isnan(one[s]).sum()          # 26202c9 wall: 101,862 of 106,482 (one 9,586)
    assert np.isnan(two[s]).sum() <= 0.15 * s.sum()
    body = np.isnan(one) & ~s
    assert not scanroute._another_body(d, _entry("d", dup)["bbox_start"], body, 400, 400)


@pytest.mark.parametrize("kind, off", [("pillar", 45), ("pillar", 70), ("posts", 45), ("posts", 70), ("posts", -70)])
def test_a_second_dancer_by_a_surface_is_still_a_body(monkeypatch, kind, off):
    """(A pillar over his own head and shoulders joins him into one piece: the known limit, not tested here.)"""
    pytest.importorskip("cv2")
    from test_v2s_dancer import _silhouette
    d, uv, box, slab = _her_at(8.0, 0.5)
    her, _ = _silhouette(70, 400, 400)
    his = np.roll(her, off, axis=1) & ~her
    s = (_surface(kind) | slab) & ~her & ~his
    d[s] = 8.5
    d[his] = 8.0 + 0.05 * np.random.default_rng(5).random(int(his.sum()))
    cut = _cut(monkeypatch, d, uv, [_entry("woman dancing", box),
                                    _entry("man dancing", [box[0] + off, box[1], box[2] + off, box[3]])])
    assert np.isfinite(cut[his]).sum() <= 0.02 * his.sum()


# ------------------------------------------------------------------------------------------------ 2 over-filtering
from soundstage.video2stage import vlm  # noqa: E402
from test_v2s_dancer_r3 import _person  # noqa: E402


@pytest.mark.parametrize("real", ["outfit: orange sweater", "orange sweater with a pattern", "outfit", "-",
                                  "brown corduroy trousers with a pattern", "orange knit sweater, just jeans"])
def test_a_real_read_of_example_words_and_one_placeholder_word_is_kept(real):
    assert not vlm.wardrobe_echo(real)                               # 0da4c57: all but the last were echoes
    assert vlm.wardrobe_of({"wardrobe": real}) == real
    assert vlm.parse_reply(_person(real))["objects"][0]["wardrobe"] == real


@pytest.mark.parametrize("frag", ["people only", "every garment, colour, pattern, length", "colour, pattern and length",
                                  "never just outfit", "<...>", "..."])
def test_placeholder_fragments_are_still_echoes(frag):
    assert vlm.wardrobe_echo(frag)


# ------------------------------------------------------------------------------------------------ 3 true echoes
EX = "orange cable-knit sweater"


@pytest.mark.parametrize("echo", ["an orange cableknit sweater, brown corduroy trousers",
                                  "orange cable-knit sweaters, brown corduroy trousers",
                                  "an orange cable-knit sweater, brown corduroy trouser",
                                  f"{EX} + brown corduroy trousers", f"{EX} / brown corduroy trousers",
                                  f"i.e. an {EX}, brown corduroy trousers", f"such as an {EX}, brown corduroy trousers",
                                  f"like an {EX}, brown corduroy trousers",
                                  f"people only: every garment with its colour, pattern and length, such as an {EX}"],
                         ids=["no hyphen", "plural", "singular trouser", "plus", "slash", "i.e.", "such as", "like",
                              "placeholder, such as"])
def test_a_reworded_example_is_an_echo(echo):
    assert vlm.wardrobe_echo(echo)
    assert vlm.wardrobe_of({"wardrobe": echo}) == ""
    assert vlm.parse_reply(_person(echo))["objects"][0]["wardrobe"] == ""


@pytest.mark.parametrize("real", ["brown corduroy trousers", "orange sweater / brown trousers",
                                  "red hoodie + blue jeans", "looks like a red hoodie, jeans",
                                  "orange cable-knit sweaters"])
def test_one_garment_of_the_example_or_a_real_list_is_still_clothing(real):
    assert not vlm.wardrobe_echo(real)


# ------------------------------------------------------------------------------------------------ 4 better_wardrobe
LEOTARD = "black leotard and fishnet tights with silver sequins"


@pytest.mark.parametrize("longer", [LEOTARD, "denim overalls over a striped tee shirt", "red jumpsuit",
                                    "navy tracksuit with white stripes", "black bodysuit"])
def test_a_shorter_parsed_read_does_not_beat_a_longer_real_read_the_parser_cannot_place(longer):
    assert vlm.better_wardrobe("jeans", longer) == longer          # 2a26229: 'jeans'
    assert vlm.better_wardrobe(longer, "jeans") == longer
    first = {"setting": "", "time": "", "camera": {}, "objects": [_obj("jeans")], "set": []}
    assert vlm.merge_reads(first, {"objects": [_obj(longer)]})["objects"][0]["wardrobe"] == longer


def test_a_garment_still_beats_a_longer_vague_read():
    assert vlm.better_wardrobe("red hoodie", "a bright colourful outfit for dancing in the street") == "red hoodie"
    assert vlm.better_wardrobe("a bright colourful costume for the show", "jeans") == "jeans"


def _obj(wardrobe, bbox=(430, 180, 570, 900)):
    return {"label": "woman dancing", "kind": "person", "color": "#e0b030", "bbox": list(bbox), "facing": "",
            "moving": True, "wardrobe": wardrobe}
