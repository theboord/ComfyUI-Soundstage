"""Video → 3D street-dance fixes, review round 9 (invented data only, no GPU):

1 a set piece in her head band whose top is not flat (a roofline rising to one side, a wall taller on one side, a
  sign stepping out from a post) is no second body: one widening edge is not a head and shoulders, so a duplicate
  entry for her cuts exactly what one entry cuts
4 the wardrobe echo probes run through the public read path (wardrobe_of / parse_reply), and two more rewordings
Run:  python -m pytest tests/test_v2s_dancer_r9.py -q
"""
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import scanroute  # noqa: E402
from test_v2s_dancer_r5 import _entry  # noqa: E402
from test_v2s_dancer_r6 import _cut, _her_at  # noqa: E402


# ------------------------------------------------------------------------------------------------ 1 a sloped set piece
def _piece(kind):
    """A set piece reaching her head band (rows 0-128 of _her_at's 400 x 400 frame; she spans columns ~143-257)."""
    s = np.zeros((400, 400), bool)
    r, c = np.mgrid[0:400, 0:400]
    if kind == "roof rising right":       # a roofline, row 110 at the left edge up to row 0 at the right
        s = r >= 110 - 110 * c / 399
    elif kind == "roof rising left":
        s = r >= 110 * c / 399
    elif kind == "wall taller left":      # a wall stepping down past her shoulder, or at her centre line
        s = (r >= 20) & (c < 280) | (r >= 80) & (c >= 280)
    elif kind == "wall taller right":
        s = (r >= 80) & (c < 120) | (r >= 20) & (c >= 120)
    elif kind == "wall stepped at her centre":
        s = (r >= 20) & (c < 200) | (r >= 80) & (c >= 200)
    elif kind == "sign right":            # a post right of her, a sign stepping out from it to the right
        s[0:, 278:292] = True
        s[50:100, 278:345] = True
    elif kind == "sign left":
        s[0:, 108:122] = True
        s[50:100, 55:122] = True
    return s


KINDS = ["roof rising right", "roof rising left", "wall taller left", "wall taller right", "wall stepped at her centre",
         "sign right", "sign left"]
GROW = {"5 px larger": (5, 5, 5, 5), "40 px wider": (40, 5, 40, 5), "60 px taller": (5, 60, 5, 5)}


@pytest.mark.parametrize("z, gap", [(8.0, 0.5), (4.0, 0.25)])      # the piece within 7% of her depth
@pytest.mark.parametrize("grow", list(GROW))
@pytest.mark.parametrize("kind", KINDS)
def test_a_set_piece_with_a_sloped_or_stepped_top_is_not_a_second_body(monkeypatch, kind, grow, z, gap):
    pytest.importorskip("cv2")
    d, uv, box, slab = _her_at(z, gap)
    her = d < z * 1.05
    d[~her] = 40.0 / 4.0 * z                                          # no round-6 slab: only the piece behind her
    s = _piece(kind) & ~her
    d[s] = z + gap
    one = _cut(monkeypatch, d, uv, [_entry("woman dancing", box)])
    gl, gt, gr, gb = GROW[grow]
    dup = [box[0] - gl, box[1] - gt, box[2] + gr, box[3] + gb]
    two = _cut(monkeypatch, d, uv, [_entry("woman dancing", box), _entry("dancer", dup)])
    assert np.isnan(two[195, 200])                                    # her torso is out of the scan
    assert int(np.isnan(two[s]).sum()) == int(np.isnan(one[s]).sum())   # a5a7a37 roof: 75,981+ of 115,971 cut
    body = np.isnan(one) & ~s
    assert not scanroute._another_body(d, _entry("d", dup)["bbox_start"], body, 400, 400)


@pytest.mark.parametrize("off", [45, 70, -45, -70])
def test_a_second_dancer_by_a_sloped_roof_is_still_a_body(monkeypatch, off):
    """The guard: a real second person at her depth, with a roofline well behind them, still leaves the scan."""
    pytest.importorskip("cv2")
    from test_v2s_dancer import _silhouette
    d, uv, box, slab = _her_at(8.0, 0.5)
    her, _ = _silhouette(70, 400, 400)
    his = np.roll(her, off, axis=1) & ~her
    d[~her] = 80.0
    d[_piece("roof rising right") & ~her & ~his] = 12.0
    d[his] = 8.0 + 0.05 * np.random.default_rng(5).random(int(his.sum()))
    cut = _cut(monkeypatch, d, uv, [_entry("woman dancing", box),
                                    _entry("man dancing", [box[0] + off, box[1], box[2] + off, box[3]])])
    assert np.isfinite(cut[his]).sum() <= 0.02 * his.sum()
