"""Recast Stage-2 composite + footage helpers (pure torch, no ComfyUI).

Run:  cd tests && python -m pytest test_footage_matte.py -q
"""
import json
import os
import sys

import pytest

torch = pytest.importorskip("torch")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.footage import clip as C  # noqa: E402
from soundstage.footage import matte as M  # noqa: E402

N, H, W = 5, 64, 96


def _box(n, h, w, x0, y0, x1, y1):
    m = torch.zeros(n, h, w)
    m[:, y0:y1, x0:x1] = 1
    return m


def _scene():
    plate = torch.full((N, H, W, 3), 0.2)
    plate[..., 2] = 0.6                                  # blue-ish plate
    swap = torch.full((N, H // 2, W // 2, 3), 0.9)        # engine output at half size, bright
    subject = _box(N, H, W, 30, 10, 50, 60)
    others = _box(N, H, W, 70, 20, 85, 60)
    return plate, swap, subject, others


def test_background_and_others_stay_plate():
    plate, swap, subject, others = _scene()
    comp, layer, alpha = M.composite(plate, swap, subject, others=others, grow_px=4, feather_px=4, temporal=0,
                                     match_color=False)
    assert comp.shape == plate.shape and layer.shape == (N, H, W, 4) and alpha.shape == (N, H, W)
    far = alpha == 0
    assert far.any()
    assert torch.allclose(comp[far], plate[far])          # untouched background is bit-exact plate
    assert torch.allclose(comp[others > 0.5], plate[others > 0.5], atol=1e-6)  # other person kept real
    assert torch.allclose(comp[subject > 0.5], torch.full_like(comp[subject > 0.5], 0.9))  # subject swapped
    assert torch.equal(layer[..., 3], alpha)


def test_new_silhouette_extends_matte_only_near_subject():
    plate, swap, subject, _ = _scene()
    bigger = _box(N, H // 2, W // 2, 13, 3, 27, 31)       # swap silhouette (half res), wider than the old one
    stranger = _box(N, H // 2, W // 2, 0, 0, 3, 3)          # someone far away in the swap
    a_old = M.build_matte(subject, H, W, N, grow_px=0, feather_px=0, temporal=0)
    a_new = M.build_matte(subject, H, W, N, swap_subject=torch.maximum(bigger, stranger), grow_px=0, feather_px=0,
                          temporal=0)
    assert a_new.sum() > a_old.sum()
    assert a_new[:, :4, :4].sum() == 0                     # far-away detection ignored


def test_frame_count_and_size_are_fitted_to_plate():
    plate, swap, subject, _ = _scene()
    short_swap = swap[:3]
    comp, layer, alpha = M.composite(plate, short_swap, subject[:4], grow_px=2, feather_px=2)
    assert comp.shape[0] == N and alpha.shape == (N, H, W)


def test_cover_framing_places_swap_in_centre_crop():
    plate, _, subject, _ = _scene()                       # plate 96x64 (1.5)
    swap = torch.full((N, 32, 32, 3), 0.9)                # square swap = centre crop of the plate
    wide = _box(N, H, W, 0, 10, W, 60)                     # subject spans the whole width
    comp, layer, alpha = M.composite(plate, swap, wide, grow_px=0, feather_px=0, temporal=0, framing="cover")
    assert alpha[:, :, :10].sum() == 0 and alpha[:, :, -10:].sum() == 0   # outside the 64px box: plate
    assert torch.allclose(comp[:, 20, 48], torch.full((N, 3), 0.9))
    canvas, box = M.place_cover(swap, H, W)
    assert box.sum() == 64 * 64 and canvas.shape == (N, H, W, 3)


def test_dilate_blur_temporal():
    m = _box(3, 32, 32, 10, 10, 12, 12)
    assert M.dilate(m, 3).sum() > m.sum()
    assert M.dilate(M.dilate(m, 3), -3).sum() == m.sum()
    b = M.blur(m, 4)
    assert 0 < b.max() < 1 and b.min() >= 0
    flick = torch.zeros(5, 4, 4)
    flick[2] = 1
    s = M.temporal_smooth(flick, 1)
    assert torch.isclose(s[1, 0, 0], torch.tensor(1 / 3)) and torch.isclose(s[2, 0, 0], torch.tensor(1 / 3))


def test_color_match_moves_toward_plate():
    plate, swap, subject, _ = _scene()
    sw = M.resize_images(swap, H, W)
    fixed = M.color_match(sw, plate, subject, 6)
    assert (fixed - plate).abs().mean() < (sw - plate).abs().mean()


# ---------------------------------------------------------------- clip helpers

def test_ltx_length_and_trim_plan():
    assert [C.ltx_length(n) for n in (9, 10, 97, 100, 121, 5)] == [9, 9, 97, 97, 121, 5]
    assert C.trim_plan(300, 10, 97, True) == (10, 97)
    assert C.trim_plan(50, 0, 0, True) == (0, 49)
    assert C.trim_plan(50, 0, 0, False) == (0, 50)
    assert C.trim_plan(20, 500, 97, True) == (19, 1)


def test_trim_audio_matches_picture():
    sr = 48000
    audio = {"waveform": torch.arange(sr * 4, dtype=torch.float32).view(1, 1, -1), "sample_rate": sr}
    a = C.trim_audio(audio, 24.0, 24, 48)                 # 1 s in, 2 s long
    assert a["waveform"].shape[-1] == 2 * sr and a["waveform"][0, 0, 0] == sr
    pad = C.trim_audio(audio, 24.0, 72, 48)                # runs past the end -> padded with silence
    assert pad["waveform"].shape[-1] == 2 * sr and pad["waveform"][0, 0, -1] == 0
    assert C.trim_audio(None, 24.0, 0, 9) is None


def test_parse_points():
    assert C.parse_points("") is None
    assert json.loads(C.parse_points('[{"x": 10.4, "y": 20}]')) == [{"x": 10, "y": 20}]
    assert json.loads(C.parse_points("[[1, 2], [3, 4]]")) == [{"x": 1, "y": 2}, {"x": 3, "y": 4}]


def test_select_subject_largest_and_index():
    objs = torch.zeros(4, 3, 8, 8)
    objs[:, 0, :2, :2] = 1          # small
    objs[:, 1, :, :5] = 1           # largest
    objs[2:, 2, 6:, 6:] = 1         # appears late
    sub, oth, idx, stats = C.select_subject(objs, -1)
    assert idx == 1 and torch.equal(sub, objs[:, 1])
    assert torch.equal(oth, torch.maximum(objs[:, 0], objs[:, 2]))
    assert stats[2]["first_frame"] == 2 and stats[2]["frames_visible"] == 2
    _, _, idx0, _ = C.select_subject(objs, 0)
    assert idx0 == 0
    _, _, none, _ = C.select_subject(torch.zeros(4, 0, 8, 8), -1)
    assert none == -1


def test_select_subject_by_overlap_ignores_invented_neighbour():
    objs = torch.zeros(4, 2, 8, 8)
    objs[:, 0, :, 5:] = 1           # bigger invented person on the right
    objs[:, 1, 2:6, 1:3] = 1        # the recast character, where the old subject was
    old = torch.zeros(4, 16, 16)
    old[:, 4:12, 2:6] = 1           # original subject (different resolution)
    sub, oth, idx, _ = C.select_subject(objs, -1, match=old)
    assert idx == 1 and torch.equal(sub, objs[:, 1])


def test_footage_json_roundtrip():
    js = C.footage_json("clip.mp4", 24.0, 0, 97, 1280, 704, True)
    d = json.loads(C.merge_json(js, subject_index=1, tracks=[{"index": 1}]))
    assert d["frames"] == 97 and d["seconds"] == pytest.approx(4.0417, abs=1e-3) and d["subject_index"] == 1
