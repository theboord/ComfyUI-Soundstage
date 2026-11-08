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
