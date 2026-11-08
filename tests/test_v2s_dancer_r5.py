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


# ------------------------------------------------------------------------------------------------ 2 partial her mask
from soundstage.video2stage import backdrop as BD  # noqa: E402
from test_v2s_dancer import LEVEL_A, LEVEL_B, LEVEL_K, POSE0, _block  # noqa: E402
from test_v2s_dancer_r3 import _stage_with_her  # noqa: E402


def _partial_mask(monkeypatch, d, frac):
    m = np.zeros(d.shape, bool)
    m[200:420, 250:250 + int(frac * 140)] = True      # the mask takes only part of her columns (250-390)
    monkeypatch.setattr(scanroute, "people_masks", lambda *a, **k: {"p0": {0: BD.rle_encode(m)}})


def _scene():
    return {"video2stage": {"xform": {"A": LEVEL_A.tolist(), "b": LEVEL_B.tolist()}},
            "actors": [_block("Crate", [0.0, 0, 5.0], 1.0), _block("Wall", [8.0, 0, 30.0], 4.0)]}


@pytest.mark.parametrize("frac", [0.6, 0.7])
def test_her_leftover_pixels_do_not_drop_the_crate_where_she_stands_on_the_scan_path(monkeypatch, frac):
    d, bd = _stage_with_her()
    _partial_mask(monkeypatch, d, frac)
    monkeypatch.setattr(BD, "ctx_from_legacy", lambda **kw: {})
    monkeypatch.setattr(BD, "build", lambda scene, ctx: {"notes": [], "actors": [{"id": "v2s_scan", "scan": True}]})
    notes = []
    st = scanroute.apply(_scene(), depths=[d], scales=[1.0], poses=[POSE0], K=LEVEL_K, files=["f0.png"], skies=None,
                         breakdown=bd, times=[0.0], duration=1.0, notes=notes, use_planes=False)
    assert st["worded"] == ["Crate"], notes
    assert st["dropped"] == ["Wall"]                 # what the scan really shows behind her still goes


@pytest.mark.parametrize("frac", [0.6, 0.7])
def test_her_leftover_pixels_do_not_drop_the_crate_where_she_stands_on_the_old_block_route(monkeypatch, frac):
    d, bd = _stage_with_her()
    _partial_mask(monkeypatch, d, frac)
    scene = _scene()
    notes = []
    pipeline.finish_scene(scene, take=None, info={}, breakdown=bd, depths=[d], scales=[1.0], poses=[POSE0],
                          K=LEVEL_K, files=["f0.png"], skies=None, times=[0.0], clip={"duration": 1.0, "fps": 24.0},
                          scan_on=False, has_relief=True, wardrobe_ref=False, tag="t", sub="s", notes=notes)
    sp = scene["video2stage"]["set_path"]
    assert sp["worded"] == ["Crate"] and sp["dropped"] == ["Wall"], notes
