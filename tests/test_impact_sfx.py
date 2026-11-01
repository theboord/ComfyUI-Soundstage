"""Impact sounds for A2 (Milestone 21): the synthesised library and one cue per hit.

Run:  python -m pytest tests/test_impact_sfx.py -q
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.cut import impact_sfx as I  # noqa: E402
from soundstage.cut.mix import SR  # noqa: E402


def ev(frame, impulse, a="wood", b="ground"):
    return {"frame": frame, "t": frame / 24, "impulse": impulse, "speed": impulse / 25, "a": "x", "b": "y", "mat_a": a, "mat_b": b}


def test_every_hit_starts_on_its_transient_and_materials_sound_different():
    sounds = {m: I.synth(m, 0) for m in I.MATERIALS}
    for m, x in sounds.items():
        assert x.ndim == 2 and x.shape[1] == 2 and np.max(np.abs(x)) <= 0.9
        peak = int(np.argmax(np.abs(x[:, 0])))
        assert peak < 0.03 * SR, f"{m}: the transient is {peak / SR:.3f} s in"
        assert np.abs(x[int(0.4 * SR):, 0]).max() < np.abs(x[: int(0.05 * SR), 0]).max(), f"{m} decays"
    # Metal rings longer than wood; glass is brighter than cardboard.
    tail = lambda x: np.sqrt(np.mean(x[int(0.5 * SR):int(0.9 * SR), 0] ** 2))
    assert tail(sounds["metal"]) > 3 * tail(sounds["wood"])
    def bright(x):
        X = np.abs(np.fft.rfft(x[:, 0])); f = np.fft.rfftfreq(len(x), 1 / SR)
        return (X * f).sum() / X.sum()
    assert bright(sounds["glass"]) > bright(sounds["cardboard"]) * 1.5
    assert np.array_equal(I.synth("wood", 1), I.synth("wood", 1)), "seeded"
    assert not np.array_equal(I.synth("wood", 1), I.synth("wood", 2)), "variants differ"


def test_library_is_written_once(tmp_path):
    lib = I.ensure_library(str(tmp_path))
    assert set(lib) == set(I.MATERIALS) and all(len(v) == I.VARIANTS for v in lib.values())
    p = tmp_path / I.SUB / "wood_1.wav"
    mtime = p.stat().st_mtime_ns
    I.ensure_library(str(tmp_path))
    assert p.stat().st_mtime_ns == mtime


def test_one_cue_per_hit_by_material_with_gain_by_impulse():
    cues = I.cue_list([ev(58, 370, "wood", "metal"), ev(59, 360, "wood", "metal"), ev(76, 180), ev(90, 20),
                       ev(100, 300, "metal", "concrete"), ev(110, 120, "cardboard", "ground")])
    assert [c["frame"] for c in cues] == [58, 76, 100, 110]          # 59 merged into 58; 20 N·s too soft
    assert [c["material"] for c in cues] == ["wood", "wood", "metal", "cardboard"]
    assert cues[0]["gain_db"] > cues[1]["gain_db"] > cues[3]["gain_db"]
    assert -24 <= min(c["gain_db"] for c in cues) and max(c["gain_db"] for c in cues) <= 2
    many = I.cue_list([ev(i * 6, 100 + i) for i in range(40)])
    assert len(many) == 16 and many == sorted(many, key=lambda c: c["frame"])
