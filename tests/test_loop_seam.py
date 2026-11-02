"""The seam meter (soundstage/loop/seam.py) on synthetic clips: a clip whose motion is a whole period is seamless, one
cut short has a visible seam, a duplicated last frame (how a loop render ends) is dropped, a held frame is caught.
Run:  python -m pytest tests/test_loop_seam.py -q
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from soundstage.loop import seam as S  # noqa: E402

H, W = 90, 160
YS, XS = np.mgrid[0:H, 0:W]
TEX = np.sin(XS * 0.7) * np.cos(YS * 0.5) * 0.15 + 0.5


def clip(n, period, dup=False, rgb=False):
    out = []
    for i in range(n):
        t = 2 * np.pi * i / period
        cx, cy = 80 + 30 * np.cos(t), 45 + 20 * np.sin(t)
        f = np.clip(TEX + 0.4 * np.exp(-((XS - cx) ** 2 + (YS - cy) ** 2) / 60), 0, 1)
        out.append((f * 255).astype(np.uint8))
    if dup:
        out.append(out[0].copy())
    a = np.stack(out)
    return np.repeat(a[..., None], 3, -1) if rgb else a


def test_whole_period_is_seamless():
    r = S.measure(clip(48, 48))
    assert r["verdict"] == "seamless" and r["badge"].startswith("Seamless")
    assert r["seam"] < S.SEAMLESS and not r["dup_last"]


def test_cut_short_is_a_visible_seam():
    r = S.measure(clip(48, 60))
    assert r["verdict"] == "visible" and r["seam"] > 3
    assert "pixel" in r["outside_p95"]
    assert r["badge"].startswith("Visible seam")


def test_duplicate_last_frame_is_dropped():
    r = S.measure(clip(48, 48, dup=True))
    assert r["dup_last"] and r["played"] == 48 and r["frames"] == 49
    assert r["verdict"] == "seamless"
    r2 = S.measure(clip(48, 48, dup=True), drop_duplicate=False)
    assert r2["verdict"] == "visible" and r2["held_frame"]


def test_two_held_frames_read_as_a_hitch():
    c = clip(48, 48, dup=True)
    r = S.measure(np.concatenate([c, c[-1:]]))
    assert r["verdict"] == "visible" and r["held_frame"] and "held frame" in r["badge"]


def test_rgb_and_float_input():
    assert S.measure(clip(32, 32, rgb=True))["verdict"] == "seamless"
    assert S.measure(clip(32, 32).astype(np.float32) / 255)["verdict"] == "seamless"


def test_too_short():
    with pytest.raises(ValueError):
        S.measure(clip(3, 3))


def test_flow_finds_a_shift():
    a = np.clip(TEX + 0.3 * np.exp(-((XS - 70) ** 2 + (YS - 45) ** 2) / 40), 0, 1).astype(np.float32)
    b = np.roll(a, 2, axis=1)
    u, v = S.flow(a, b)
    core = (slice(20, 70), slice(30, 130))
    assert abs(float(np.median(u[core])) - 2.0) < 0.6
    assert abs(float(np.median(v[core]))) < 0.4


def test_ssim_identity_and_box():
    a = TEX.astype(np.float32)
    assert S.ssim(a, a) == pytest.approx(1.0, abs=1e-5)
    assert np.allclose(S.box(np.ones((10, 12), np.float32), 2), 1.0)


def test_audio_wrap():
    rate = 48000
    t = np.arange(rate) / rate
    smooth = np.sin(2 * np.pi * 100 * t).astype(np.float32)     # 100 whole cycles: wraps cleanly
    r = S.audio_wrap(smooth, rate)
    assert abs(r["level_jump_db"]) < 1 and r["click"] < 2
    cut = np.concatenate([smooth[: rate // 2], 0.1 * smooth[rate // 2:]])
    assert abs(S.audio_wrap(cut, rate)["level_jump_db"]) > 15


def test_a_snap_near_the_end_is_a_seam():
    a = clip(48, 48)
    snapped = np.concatenate([a[:44], a[20:24]])
    r = S.measure(snapped)
    assert r["verdict"] == "visible" and r["snap_at"] == 44 and "jump at frame 44" in r["badge"]
