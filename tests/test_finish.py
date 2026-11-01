"""Film Finish (Milestone 21): stock-ffmpeg lens, fringe, halation, vignette, grain.

Run:  python -m pytest tests/test_finish.py -q
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage import finish as F  # noqa: E402


def _clip(n=6, h=96, w=160):
    """A flat grey clip with a white box (a highlight) and a sharp vertical edge."""
    x = np.full((n, h, w, 3), 110, np.uint8)
    x[:, 30:60, 60:100] = 250
    x[:, :, :20] = 30
    return x


@pytest.mark.parametrize("preset", ["subtle", "35mm", "anamorphic"])
def test_size_and_frame_count_are_kept_and_the_picture_changes(preset):
    src = _clip()
    out = F.finish_frames(src, preset, seed=3)
    assert out.shape == src.shape and out.dtype == np.uint8
    assert np.abs(out.astype(int) - src.astype(int)).mean() > 1.0


def test_grain_is_different_every_frame_and_seeded():
    src = _clip()
    a = F.finish_frames(src, "35mm", seed=3).astype(int)
    # Same input every frame: only the grain differs frame to frame.
    assert np.abs(a[1] - a[2]).mean() > 0.5
    flat = a[:, 70:90, 30:55].reshape(len(a), -1)
    assert flat.std(axis=1).min() > 1.0, "grain variance > 0"
    assert np.array_equal(a, F.finish_frames(src, "35mm", seed=3).astype(int))


def test_vignette_darkens_the_corners_and_halation_glows_red_round_the_highlight():
    src = np.full((4, 96, 160, 3), 120, np.uint8)
    out = F.finish_frames(src, "35mm", seed=1).astype(float)
    assert out[:, 2:8, 26:34].mean() < out[:, 44:52, 76:84].mean() - 6
    hl = _clip(4)
    o = F.finish_frames(hl, "35mm", seed=1).astype(float)
    ring = o[:, 62:68, 70:90]        # just below the white box, on the grey
    base = F.finish_frames(np.where(hl == 250, 110, hl).astype(np.uint8), "35mm", seed=1).astype(float)[:, 62:68, 70:90]
    assert ring[..., 0].mean() > base[..., 0].mean() + 2, "red halation"
    assert (ring[..., 0] - base[..., 0]).mean() > (ring[..., 2] - base[..., 2]).mean()


def test_off_is_a_no_op_and_motion_blur_mixes_frames():
    src = _clip()
    assert F.finish_frames(src, "off") is src
    assert F.finish_graph("[a]", "[b]", "off", 160, 96) == ["[a]null[b]"]
    moving = np.zeros((4, 64, 64, 3), np.uint8)
    for i in range(4):
        moving[i, :, i * 12:i * 12 + 8] = 255
    out = F.finish_frames(moving, "subtle", motion_blur=True)
    assert out.shape == moving.shape
    assert out[2, 32, 12:20].mean() > 40, "the previous frame's bar shows through"


def test_the_cut_render_applies_the_finish_under_the_titles():
    from soundstage.cut import render as R
    g = ";".join(F.finish_graph("[base]", "[fin]", "35mm", 1920, 1080, 5))
    for f in ("lenscorrection", "lutrgb", "gblur", "blend=all_mode=screen", "vignette", "noise=", "all_seed=5"):
        assert f in g
    assert R.FINISH is F.PRESETS
