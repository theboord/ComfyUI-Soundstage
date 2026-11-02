"""Reshoot (soundstage/reshoot): the safe range, the new camera's geometry (the subject stays framed, +orbit moves
the camera right), the warp (identity is exact, a lens change magnifies about the centre, holes are filled from the
background), and both queued graphs are valid against the pod's /object_info.
Run:  python -m pytest tests/test_reshoot.py -q
"""
import json
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from test_loop_graphs import as_graph, _snapshot  # noqa: E402,F401
from soundstage import reshoot as R  # noqa: E402
from soundstage.reshoot import graphs as G  # noqa: E402
from soundstage.reshoot import plan as P  # noqa: E402

W = {r: names[0] for r, (f, names) in G.RESHOOT_WEIGHTS.items()}


def test_clamp_holds_the_safe_range():
    m, notes = P.clamp({"orbit_deg": 40, "dolly": -0.1, "lens": 3, "tilt_deg": "x"})
    assert m == {"orbit_deg": 15.0, "tilt_deg": 0.0, "dolly": -0.1, "lens": 1.6}
    assert len(notes) == 2 and "orbit 40" in notes[0]
    assert P.is_identity(P.clamp({})[0])
    assert not P.is_identity(P.clamp(P.PRESETS["orbit_left"])[0])


def test_describe():
    assert "orbits 10 degrees to the right" in P.describe(P.clamp({"orbit_deg": 10})[0])
    assert "dollies in 15%" in P.describe(P.clamp({"dolly": 0.15})[0])
    assert "longer lens" in P.describe(P.clamp({"lens": 1.3})[0])
    assert P.describe(P.clamp({})[0]) == "the same camera"


@pytest.mark.parametrize("move", [{"orbit_deg": 12}, {"tilt_deg": -6}, {"orbit_deg": -8, "tilt_deg": 5}])
def test_pivot_stays_centred(move):
    m = P.clamp(move)[0]
    R_, C = P.new_camera(m, 5.0)
    piv = R_.T @ (np.array([0, 0, 5.0]) - C)
    assert np.allclose(piv[:2], 0, atol=1e-9) and piv[2] == pytest.approx(5.0)


def test_orbit_right_moves_the_camera_right_and_dolly_in_moves_it_forward():
    _, C = P.new_camera(P.clamp({"orbit_deg": 10})[0], 5.0)
    assert C[0] > 0.5
    _, C = P.new_camera(P.clamp({"dolly": 0.2})[0], 5.0)
    assert C[2] == pytest.approx(1.0) and abs(C[0]) < 1e-9
    _, C = P.new_camera(P.clamp({"tilt_deg": 6})[0], 5.0)
    assert C[1] < -0.3          # OpenCV y is down: rising = negative y


def scene(h=72, w=128):
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[..., 0] = np.linspace(0, 255, w)[None, :]
    rgb[..., 1] = np.linspace(0, 255, h)[:, None]
    depth = np.full((h, w), 10.0, np.float32)          # a wall at 10 ...
    depth[24:48, 48:80] = 4.0                          # ... with a box in front of it
    rgb[24:48, 48:80] = (255, 255, 255)
    return rgb, depth, P.intrinsics(w, h)


def test_identity_warp_is_exact():
    rgb, depth, K = scene()
    c, z, hole = P.warp(rgb, depth, K, P.clamp({})[0], 4.0)
    assert not hole.any() and np.array_equal(c, rgb) and np.allclose(z, depth)


def test_longer_lens_magnifies_about_the_centre():
    rgb, depth, K = scene()
    c, _, hole = P.warp(rgb, depth, K, P.clamp({"lens": 1.5})[0], 4.0)
    assert hole.mean() < 0.01                          # supersampled: no cracks
    white = np.argwhere((c == 255).all(-1))
    h, w = depth.shape
    cy, cx = white.mean(0)
    assert abs(cx - w / 2) < 2 and abs(cy - h / 2) < 2
    assert np.ptp(white[:, 1]) > 32 * 1.4                # the box got wider


def test_orbit_reveals_background_and_fills_it_from_the_far_side():
    rgb, depth, K = scene()
    c, z, hole = P.warp(rgb, depth, K, P.clamp({"orbit_deg": 12})[0], 10.0)
    assert hole.any()
    assert np.isfinite(z).all()
    assert np.all(z[hole] > 9.0)                       # disocclusions filled with the wall, never the box


def test_depth_image_near_is_white():
    d = np.array([[1.0, 10.0]])
    g = P.depth_image(d, 1.0, 10.0)
    assert g[0, 0] == 255 and g[0, 1] == 0


def test_plate_frames_and_size():
    assert R.plate_frames(97, 24) == 97
    assert R.plate_frames(300, 30) == 161
    assert (R.plate_frames(100, 30) - 1) % 8 == 0
    assert R.plate_size(1984, 1088) == (1312, 720)
    assert R.plate_size(960, 544) == (960, 544)


def test_warp_clip_shapes():
    rgb, depth, K = scene()
    out = R.warp_clip(np.stack([rgb] * 3), np.stack([depth] * 3), K, P.clamp({"orbit_deg": 8})[0])
    assert out["guide"].shape == (3, 72, 128) and out["guide"].dtype == np.uint8
    assert out["first"].shape == (72, 128, 3) and 0 < out["holes"] < 0.3
    small = R.warp_clip(np.stack([rgb] * 2), np.stack([depth] * 2), K, P.clamp({"orbit_deg": 8})[0], guide_short=36)
    assert small["guide"].shape == (2, 36, 64) and small["first"].shape == (72, 128, 3)   # frame 1 stays full size
    assert abs(small["holes"] - out["holes"]) < 0.05


def test_fill_background_is_linear_and_complete():
    import time
    rgb = np.zeros((400, 700, 3), np.uint8)
    z = np.full((400, 700), 5.0)
    z[:, :250] = np.inf                                # a wide frame-edge reveal
    z[100:110, 400:600] = np.inf                       # a thin crack
    t = time.time()
    c, zz = P.fill_background(rgb, z)
    assert np.isfinite(zz).all() and time.time() - t < 3


def test_depth_prompt_valid():
    p = G.depth_prompt("soundstage_private/reshoot/x_plate.mp4 [input]", "depth_anything_3_mono_large.safetensors", "rs_x")
    assert TF.check(as_graph(p)) == []
    assert p["npz"]["class_type"] == "SoundstageDA3Export"


@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("sound", [True, False])
def test_render_prompt_valid(quality, sound):
    p = G.render_prompt(W, plate="p.mp4 [input]", guide="g.mp4 [input]", first="f.png [input]", width=1312,
                        height=720, prompt=G.reshoot_prompt("the camera orbits 10 degrees to the right"),
                        quality=quality, keep_sound=sound)
    assert TF.check(as_graph(p)) == []
    assert any(n["class_type"] == "LTXICLoRALoaderModelOnly" for n in p.values())
    assert any(n["class_type"] == "LTXVSetAudioRefTokens" for n in p.values()) == sound
    assert any(n["class_type"] == "LTXVLatentUpsampler" for n in p.values()) == (quality == "Final")


def test_camera_lora_test_prompt_valid():
    p = G.camera_lora_test_prompt(W, "ltx-2-19b-lora-camera-control-dolly-in.safetensors", first="f.png [input]")
    assert TF.check(as_graph(p)) == []


def test_recipe_prompt_reads_the_longest_positive(monkeypatch):
    from soundstage.takecheck import video as V
    pr = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "A rider gallops across the desert at dusk."}},
          "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, pc game"}}}
    monkeypatch.setattr(V, "probe", lambda p: {"tags": {"prompt": json.dumps(pr)}})
    assert R.recipe_prompt("x.mp4") == "A rider gallops across the desert at dusk."


def test_auto_frame_pushes_edge_reveals_out():
    h = np.zeros((72, 128), bool)
    h[:, :10] = True                                   # an orbit's strip at the left edge
    z = P.auto_frame([h, h])
    assert 1.15 < z < 1.2                              # 2 x 10 px of 128 cropped, centred
    assert P.auto_frame([np.zeros((72, 128), bool)]) == 1.0
    h2 = np.zeros((72, 128), bool); h2[:, :60] = True
    assert P.auto_frame([h2]) == 1.25                  # never more than the cap


def test_edge_image_keeps_outlines():
    rgb, depth, K = scene()
    e = P.edge_image(rgb)
    assert e.dtype == np.uint8 and e.shape == depth.shape
    assert e[24:48, 46:50].max() == 255 and e[60:70, 5:40].max() == 0   # the box outline, not the smooth wall
