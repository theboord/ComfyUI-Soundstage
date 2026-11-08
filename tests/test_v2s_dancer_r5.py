"""Video → 3D street-dance fixes, review round 5 (invented data only, no GPU):

1 only the entry that best matches her joints gets her body mask: a second dancer beside her, whose box covers her
  joints' centre, keeps the loose mask minus her body, so his pixels leave the scan
2 the block triage does not count her leftover unmasked pixels (an incomplete performer mask) as scan coverage
3 wardrobe: a tie phrase applies to the whole multi-word garment phrase it follows
Run:  python -m pytest tests/test_v2s_dancer_r5.py -q
"""
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import pipeline, scanroute  # noqa: E402
from soundstage.video2stage import wardrobe as W  # noqa: E402
from test_v2s_dancer import _dancer_depth, _silhouette  # noqa: E402

TAKE = {"frames": 1, "source_frames": [0], "focal_px": 500.0, "body": [[0]]}


def _entry(label, box, h=400, w=400):
    bb = [box[0] / w * 1000, box[1] / h * 1000, box[2] / w * 1000, box[3] / h * 1000]
    return {"kind": "person", "label": label, "bbox_start": bb, "bbox_end": bb}


# ------------------------------------------------------------------------------------------------ 1 second dancer
@pytest.mark.parametrize("off", [45, 70, -45])
@pytest.mark.parametrize("his_first", [False, True])
def test_a_second_dancer_beside_her_does_not_get_her_body_mask(monkeypatch, off, his_first):
    pytest.importorskip("cv2")
    d, uv, box, hgt = _dancer_depth(70, w=400)
    her, _ = _silhouette(70, 400, 400)
    his = np.roll(her, off, axis=1) & ~her          # a second dancer at her depth, his box over her joints' centre
    d[his] = 4.0 + 0.05 * np.random.default_rng(5).random(int(his.sum()))
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    es = [_entry("woman dancing", box), _entry("man dancing", [box[0] + off, box[1], box[2] + off, box[3]])]
    masks = scanroute.people_masks({"objects": es[::-1] if his_first else es}, [d], [0.0], 1.0, take=TAKE, fps=24.0)
    cut = scanroute.without_people(d, masks, 0)
    assert np.isnan(cut[195, 200])                                   # her torso is out of the scan
    assert np.isfinite(cut[his]).sum() <= 0.02 * his.sum()           # and so is he
