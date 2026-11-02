"""Refocus after the render (soundstage/refocus, docs/refocus.md): the thin-lens maths against a hand-worked example,
the in-focus plane comes back bit-identical, blur grows with distance from focus and with a lower T-stop, no sharp
foreground halo in the background blur, a blurred foreground spreads over what is behind it, the pull holds, eases and
lands, the stage's 16-bit depth round-trips, DA3 depth is steadied and scaled, the marks are tracked, the DA3 graph is
valid, the whole job runs on a real MP4 (frames, fps, size, sound and recipe kept), the route answers, and the
Hero Frame Rig licence travels with the adapted code.
Run:  python -m pytest tests/test_refocus.py -q
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import types

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from test_loop_graphs import as_graph, _snapshot  # noqa: E402,F401
from soundstage import refocus as RF  # noqa: E402
from soundstage.refocus import depth as D  # noqa: E402
from soundstage.refocus import graphs as G  # noqa: E402
from soundstage.refocus import optics as O  # noqa: E402
from soundstage.refocus import plan as P  # noqa: E402

FF = shutil.which("ffmpeg") and shutil.which("ffprobe")


def _texture(h, w, seed=0, lo=0.15, hi=0.85):
    rng = np.random.default_rng(seed)
    return (lo + (hi - lo) * rng.random((h, w, 3))).astype(np.float32)


def _gray(rgb):
    return ((rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114) / 255.0).astype(np.float32)


def _hf(img):
    """High-frequency energy (mean |horizontal + vertical gradient|): sharp texture high, blurred texture low."""
    g = np.asarray(img, np.float32).mean(-1)
    return float(np.abs(np.diff(g, axis=0)).mean() + np.abs(np.diff(g, axis=1)).mean())


# ------------------------------------------------------------------------------------------------ optics

def test_coc_matches_a_hand_worked_thin_lens_example():
    # 50 mm at T2 focused at 2 m, a point at 4 m, 1920 px across a 36 mm sensor.
    # Diameter c = f^2 |z - zf| / (N z (zf - f)) = 0.0025 * 2 / (2 * 4 * 1.95) = 0.00032051 m -> radius 0.00016026 m
    # -> x 1920 / 0.036 = 8.547 px
    r = O.coc_px(np.array([1 / 4.0]), 1 / 2.0, focal_mm=50, t_stop=2, width_px=1920, sensor_mm=36)[0]
    assert r == pytest.approx(-8.547, abs=0.01)                         # farther than focus = negative
    near = O.coc_px(np.array([1 / 1.5]), 1 / 2.0, focal_mm=50, t_stop=2, width_px=1920)[0]
    assert near > 0
    # halves when the T-stop doubles; grows with the square of the focal length (same focus, same depth)
    r4 = O.coc_px(np.array([0.25]), 0.5, focal_mm=50, t_stop=4, width_px=1920)[0]
    assert r4 == pytest.approx(r / 2, rel=1e-5)
    r100 = O.coc_px(np.array([0.25]), 0.5, focal_mm=100, t_stop=2, width_px=1920)[0]
    assert abs(r100) / abs(r) == pytest.approx(4 * (1 - 0.025) / (1 - 0.05), rel=1e-4)
    # linear in diopters: twice as far from focus in 1/m, twice the blur
    r2 = O.coc_px(np.array([0.0]), 0.5, focal_mm=50, t_stop=2, width_px=1920)[0]
    assert r2 == pytest.approx(2 * r, rel=1e-5)


def test_bins_are_at_most_a_pixel_apart_up_close():
    e = O.bin_edges(60)
    steps = np.diff(e)
    assert e[0] == O.IN_FOCUS_PX and e[-1] >= 60
    assert (steps[np.array(e[:-1]) < 10] <= 1.0 + 1e-6).all() and (steps <= np.maximum(1.0, 0.1 * np.array(e[:-1])) + 1e-6).all()


def test_disc_kernel_is_unit_energy_and_round():
    img = np.zeros((101, 101, 1), np.float32)
    img[50, 50, 0] = 1.0
    out = O.disc_blur(img, 10.0)[..., 0]
    assert out.sum() == pytest.approx(1.0, abs=1e-3)
    yy, xx = np.mgrid[:101, :101]
    d = np.hypot(yy - 50, xx - 50)
    assert out[d > 11.5].max() < 1e-4                                   # nothing past the rim
    inside = out[d < 9]
    assert inside.std() / inside.mean() < 0.02                          # flat-topped disc, not a Gaussian
    # a big blur (computed at half size) keeps unit energy too
    img = np.zeros((241, 241, 1), np.float32)
    img[120, 120, 0] = 1.0
    assert O.disc_blur(img, 30.0).sum() == pytest.approx(1.0, abs=2e-3)


def test_linear_light_round_trip():
    x = np.linspace(0, 1, 256, dtype=np.float32)
    assert np.abs(O.to_srgb(O.to_linear(x)) - x).max() < 1e-5
    assert O.to_linear(np.float32(0.5)) == pytest.approx(0.2140, abs=1e-3)


def _two_planes(h=120, w=200, subject=(30, 90, 60, 140), z_bg=20.0, z_subj=2.0):
    rgb = _texture(h, w, 1)
    rgb[..., 1] = np.clip(rgb[..., 1] + 0.1, 0, 1)
    rgb[..., 0] *= 0.2                                               # background: little red
    y0, y1, x0, x1 = subject
    rgb[y0:y1, x0:x1] = _texture(y1 - y0, x1 - x0, 2) * np.array([1.0, 0.1, 0.1], np.float32) + np.array([0.1, 0, 0], np.float32)
    d = np.full((h, w), 1 / z_bg, np.float32)
    d[y0:y1, x0:x1] = 1 / z_subj
    return (np.clip(rgb, 0, 1) * 255).round().astype(np.uint8), d


def test_in_focus_plane_comes_back_bit_identical():
    rgb, d = _two_planes()
    st = {}
    out = O.render_frame(rgb, d, 1 / 2.0, focal_mm=85, t_stop=1.4, stats=st)
    assert st["r_max"] > 3                                           # the background really is blurred
    assert np.array_equal(out[30:90, 60:140], rgb[30:90, 60:140])    # every subject pixel unchanged
    assert _hf(out[:, :50]) < 0.5 * _hf(rgb[:, :50])
    # all in focus: the whole frame comes back as it was
    assert np.array_equal(O.render_frame(rgb, np.full_like(d, 0.5), 0.5, focal_mm=85, t_stop=1.4), rgb)


def test_blur_grows_with_distance_from_focus_and_with_a_lower_t_stop():
    h, w = 300, 400                     # 85 mm across 400 px: ~30 px of blur radius per diopter at T1.4
    rgb = (_texture(h, w, 3) * 255).astype(np.uint8)
    hf = {}
    for z in (2.2, 3.0, 6.0):
        for t in (1.4, 4.0):
            out = O.render_frame(rgb, np.full((h, w), 1 / z, np.float32), 1 / 2.0, focal_mm=85, t_stop=t)
            hf[z, t] = _hf(out[60:240, 60:340])
    assert hf[2.2, 1.4] > hf[3.0, 1.4] > hf[6.0, 1.4]                    # further from focus, softer
    for z in (2.2, 3.0, 6.0):
        assert hf[z, 1.4] < hf[z, 4.0]                                  # opening up, softer


def test_no_sharp_foreground_halo_in_the_background_blur():
    rgb, d = _two_planes()
    out = O.render_frame(rgb, d, 1 / 2.0, focal_mm=85, t_stop=1.4).astype(np.float32)
    naive = np.stack([O.to_srgb(O.disc_blur(O.to_linear(rgb.astype(np.float32) / 255), 8.0)[..., c]) for c in range(3)], -1) * 255
    # the background just outside the subject (within the blur's reach): no red smeared out of the sharp subject
    ring = np.zeros(d.shape, bool)
    ring[24:96, 52:148] = True
    ring[30:90, 60:140] = False
    bg_red = rgb[..., 0][d < 0.1].mean()
    assert out[..., 0][ring].mean() < bg_red + 6                         # a naive blur bleeds red here...
    assert naive[..., 0][ring].mean() > bg_red + 20                      # ...as this shows
    # and the subject's edge stays a hard edge
    assert np.array_equal(out[30:90, 60].astype(np.uint8), rgb[30:90, 60])


def test_a_blurred_foreground_spreads_over_what_is_behind_it():
    rgb, d = _two_planes()
    out = O.render_frame(rgb, d, 1 / 20.0, focal_mm=85, t_stop=1.4)      # focus on the background: the subject blurs
    # the subject's red reaches past its silhouette (near over far), and the background far from it stays sharp
    assert out[..., 0][31:89, 52:58].astype(float).mean() > rgb[..., 0][31:89, 52:58].astype(float).mean() + 15
    assert np.array_equal(out[:, :20], rgb[:, :20])


def test_highlight_lift_makes_bright_bokeh_and_leaves_focus_alone():
    h, w = 80, 80
    rgb = np.full((h, w, 3), 40, np.uint8)
    rgb[40, 40] = 255                                                   # a clipped practical in the background
    d = np.full((h, w), 1 / 30.0, np.float32)
    plain = O.render_frame(rgb, d, 1 / 2.0, focal_mm=85, t_stop=1.4, highlights=0)
    lifted = O.render_frame(rgb, d, 1 / 2.0, focal_mm=85, t_stop=1.4, highlights=3.0)
    assert lifted.astype(int).sum() > plain.astype(int).sum()
    assert np.array_equal(O.render_frame(rgb, np.full((h, w), 0.5, np.float32), 0.5, focal_mm=85, t_stop=1.4, highlights=3.0), rgb)


def test_bright_bokeh_lifts_small_clipped_lights_only_and_is_off_by_default():
    """Review 2026-11-02: the old lift raised every bright pixel (an sRGB 240 wall went to 255, white lines glowed)."""
    d_bg, focus = 1 / 30.0, 1 / 2.0                                   # 85 mm T1.4 over 240 px: ~8 px of blur behind
    kw = dict(focal_mm=85, t_stop=1.4)

    def both(rgb):
        d = np.full(rgb.shape[:2], d_bg, np.float32)
        return (O.render_frame(rgb, d, focus, highlights=0, **kw).astype(float),
                O.render_frame(rgb, d, focus, highlights=3.0, **kw).astype(float))
    # a big light-grey wall (sRGB 240) and a big clipped white window keep their exposure, lift or not
    rgb = np.full((160, 240, 3), 60, np.uint8)
    rgb[20:140, 20:110] = 240
    rgb[20:140, 130:220] = 255
    plain, lifted = both(rgb)
    for x0, x1, level in ((32, 98, 240), (142, 208, 255)):
        inner = (slice(32, 128), slice(x0, x1))
        assert abs(lifted[inner].mean() - plain[inner].mean()) <= 1.0
        assert abs(plain[inner].mean() - level) <= 1.0
    # thin white lines and white text strokes are not lights either
    rgb = np.full((160, 240, 3), 60, np.uint8)
    rgb[20:140, 30:200:16] = 255                                       # 1-px vertical lines
    rgb[60:68, 30:200] = 255                                           # a horizontal stroke
    plain, lifted = both(rgb)
    assert abs(lifted[20:140, 30:200].mean() - plain[20:140, 30:200].mean()) <= 2.0
    # a small practical does bloom into a bright disc
    rgb = np.full((80, 80, 3), 40, np.uint8)
    rgb[39:42, 39:42] = 255
    plain, lifted = both(rgb)
    assert lifted[30:50, 30:50].max() > plain[30:50, 30:50].max() + 30
    # and it is off unless asked for
    st, _ = RF.settings({})
    assert st["highlights"] is False
    assert RF.settings({"highlights": True})[0]["highlights"] is True


def test_a_focus_pull_softens_the_picture_a_little_every_frame():
    """Review 2026-11-02: layers blurred at fixed bin radii held the picture still, then jumped a whole bin (frame
    differences 0, 0, 50.8, 0, 0, 16.5, ...). Each layer is now blurred at its own mean radius."""
    h, w, n = 120, 480, 48
    rgb = (_texture(h, w, 4) * 255).astype(np.uint8)
    d = np.full((h, w), 0.1, np.float32)                               # a wall at 10 m
    curve = P.focus_curve(np.full(n, 0.1), np.full(n, 1.0), 0.1, 0.9)  # focus pulled from it to 1 m
    frames, radii = [], []
    for c in curve:
        st = {}
        frames.append(O.render_frame(rgb, d, float(c), focal_mm=50, t_stop=2.0, stats=st).astype(np.float32))
        radii.append(st["r_max"])
    diff = [float(np.abs(frames[i] - frames[i - 1]).mean()) for i in range(1, n)]
    blurred = [i for i in range(1, n) if radii[i - 1] >= O.IN_FOCUS_PX and radii[i] >= O.IN_FOCUS_PX]
    assert len(blurred) > 20
    for i in blurred:
        if radii[i] - radii[i - 1] >= 1.0 / O.STEPS:
            assert diff[i - 1] > 0, (i, radii[i - 1], radii[i])        # the blur moved: so did the picture
    for i in blurred[1:-1]:
        assert diff[i - 1] <= 2.5 * max(diff[i - 2], diff[i]) + 0.05, (i, diff[i - 2:i + 1])   # no spikes
    first = next(i for i in range(n) if radii[i] >= O.IN_FOCUS_PX)
    assert radii[first] < 1.0                                         # it leaves focus gently, not at a whole pixel


def test_no_halo_with_soft_depth_edges_from_a_low_resolution_depth_map():
    """Review 2026-11-02: depth measured small (DA3 sees 504 px) and brought up to the take's size has in-between
    distances along the silhouette; they were gathered into the background blur with the subject's colour."""
    sub = (60, 180, 100, 300)
    rgb, d = _two_planes(h=240, w=400, subject=sub)
    small = O.resize_bilinear(d, 96, 160)                              # 2.5x smaller, like 504 px under a 1280 take
    gray = _gray(rgb)
    soft = D.full_size(small, gray, native_long=160)
    y0, y1, x0, x1 = sub
    # the silhouette is hard again: no pixel in the edge's ramp keeps an in-between distance
    mid = (soft > 0.06) & (soft < 0.45)
    assert mid.mean() < 0.002, mid.mean()
    out = O.render_frame(rgb, soft, 1 / 2.0, focal_mm=85, t_stop=1.4).astype(np.float32)
    ring = np.zeros(d.shape, bool)
    ring[y0 - 8:y1 + 8, x0 - 8:x1 + 8] = True
    ring[y0 - 2:y1 + 2, x0 - 2:x1 + 2] = False
    bg_red = rgb[..., 0][d < 0.1].mean()
    assert out[..., 0][ring].mean() < bg_red + 6                       # no red glow round the sharp subject
    inner = (slice(y0 + 2, y1 - 2), slice(x0 + 2, x1 - 2))
    assert (out[inner] == rgb[inner]).all(-1).mean() > 0.995           # and the subject stays sharp to its edge


def test_snap_edges_leaves_a_receding_floor_and_a_middle_surface_alone():
    h, w = 120, 200
    floor = np.repeat(np.linspace(1 / 1.5, 1 / 6.0, h, dtype=np.float32)[:, None], w, 1)   # smooth: 1.5 m to 6 m
    assert np.allclose(D.snap_edges(floor, 10), floor)
    # three surfaces within one window: the middle one keeps its own distance
    d = np.full((h, w), 0.1, np.float32)
    d[:, 80:120] = 0.5
    d[:, 120:] = 1.0
    soft = D.full_size(O.resize_bilinear(d, 48, 80), np.zeros((h, w), np.float32), native_long=80)
    assert np.allclose(soft[:, 92:108], 0.5, atol=0.02)
    assert np.allclose(soft[:, :70], 0.1, atol=0.01) and np.allclose(soft[:, 130:], 1.0, atol=0.01)


def test_a_portrait_take_has_the_sensor_across_its_width():
    """Review 2026-11-02: the stage puts the 36 mm sensor across the frame's width (web/stage/stage.mjs SENSOR_W_MM);
    a 9:16 take was given its long edge, 16/9 too much blur."""
    for (h, w) in ((90, 160), (284, 160)):
        d = np.full((h, w), 1 / 10.0, np.float32)
        st = {}
        O.render_frame((_texture(h, w, 6) * 255).astype(np.uint8), d, 1 / 2.0, focal_mm=50, t_stop=1.4, stats=st)
        want = abs(float(O.coc_px(np.array([0.1]), 0.5, focal_mm=50, t_stop=1.4, width_px=160)[0])) - O.TOLERANCE_PX
        assert st["r_max"] == pytest.approx(want, abs=0.02), (h, w)


# ------------------------------------------------------------------------------------------------ the pull

def test_focus_pull_holds_eases_and_lands():
    n = 49
    c = P.focus_curve(0.5, 0.1, 0.25, 0.75)                             # scalar marks
    assert len(c) == 1
    c = P.focus_curve(np.full(n, 0.5), np.full(n, 0.1), 0.25, 0.75)
    t = np.linspace(0, 1, n)
    assert np.allclose(c[t <= 0.25], 0.5) and np.allclose(c[t >= 0.75], 0.1)
    assert (np.diff(c) <= 1e-12).all()                                  # monotonic, no overshoot
    mid = c[np.argmin(np.abs(t - 0.5))]
    assert mid == pytest.approx(0.3, abs=1e-6)                          # halfway in diopters at the middle
    # a moving mark is followed while it holds
    da = np.linspace(0.5, 0.6, n)
    c2 = P.focus_curve(da, np.full(n, 0.1), 0.5, 1.0)
    assert np.allclose(c2[: n // 2], da[: n // 2])


def test_window_and_points_are_made_safe():
    assert P.window(0.8, 0.3)[:2] == pytest.approx((0.8, 0.85))
    assert P.window("x", None)[:2] == (0.25, 0.75)
    assert P.parse_point("0.3,0.7") == (0.3, 0.7)
    assert P.parse_point([2, -1]) == (1.0, 0.0)
    assert P.parse_point({"x": 0.1, "y": 0.2}) == (0.1, 0.2)
    assert P.parse_point("nonsense", None) is None
    st, _ = RF.settings({"a": "0.2,0.4", "b": [0.8, 0.6], "t_stop": 99, "highlights": "false", "depth": "evil"})
    assert st["t_stop"] == 32.0 and st["highlights"] is False and st["depth"] == "auto" and st["pull"]
    st, _ = RF.settings({"focal_mm": "junk", "subject_m": 0})
    assert st["focal_mm"] is None and st["subject_m"] is None and not st["pull"]       # nonsense = auto, never 0 m


def test_smooth_series_drops_a_slipped_frame():
    v = np.full(30, 0.5)
    v[12] = 0.05                                                        # the mark slipped onto the background once
    s = P.smooth_series(v)
    assert np.abs(s - 0.5).max() < 1e-9


def test_track_point_follows_a_moving_patch():
    pytest.importorskip("cv2")
    n, h, w = 12, 120, 160
    rng = np.random.default_rng(4)
    bg = (rng.random((h, w)) * 60).astype(np.uint8)
    patch = (rng.random((24, 24)) * 255).astype(np.uint8)
    grays = []
    for i in range(n):
        g = bg.copy()
        x = 30 + 6 * i
        g[50:74, x:x + 24] = patch
        grays.append(g)
    pts = P.track_point(grays, (30 + 12) / (w - 1), 62 / (h - 1), 0)
    xs = pts[:, 0] * (w - 1)
    assert abs(xs[-1] - (30 + 6 * (n - 1) + 12)) < 2.0
    back = P.track_point(grays, (30 + 6 * (n - 1) + 12) / (w - 1), 62 / (h - 1), n - 1)
    assert abs(back[0, 0] * (w - 1) - 42) < 2.0


def test_sharpness_flags_a_soft_spot():
    rng = np.random.default_rng(5)
    g = (rng.random((100, 100)) * 255).astype(np.float32)
    g[:, 50:] = g[:, 50:].mean()                                        # right half: no detail at all
    assert P.sharpness(g, 0.25, 0.5) > 0.6 and P.sharpness(g, 0.8, 0.5) < 0.35


# ------------------------------------------------------------------------------------------------ depth

def test_stage_sheet_round_trips_16_bit_inverse_depth():
    frames, tw, th, cols = 5, 16, 9, 3
    z = np.linspace(0.3, 80, frames * th * tw).reshape(frames, th, tw)
    dio = (1 / z).astype(np.float32)
    dio[0, 0, 0] = 0.0                                                  # sky / infinity is black
    sheet = np.zeros((2 * th, cols * tw, 3), np.uint8)
    for i in range(frames):
        sheet[(i // cols) * th:(i // cols + 1) * th, (i % cols) * tw:(i % cols + 1) * tw] = D.encode16(dio[i])
    back = D.decode_sheet(sheet, cols=cols, frames=frames, tile=(tw, th))
    assert np.abs(back - dio).max() <= D.DMAX / 65535 / 2 + 1e-6        # one 16-bit step
    assert back[0, 0, 0] == 0.0
    # at 2 m, the step is ~0.6 mm: fine enough for a face at T1.4
    assert 1 / 0.5 - 1 / (0.5 + D.DMAX / 65535) < 0.001


def test_center_crop_time_map_and_fit():
    a = np.arange(2 * 4 * 8, dtype=np.float32).reshape(2, 4, 8)
    assert D.center_crop(a, 1.0).shape == (2, 4, 4) and D.center_crop(a, 4.0).shape == (2, 2, 8)
    assert list(D.time_map(5, 30.0, 4, 24.0)) == [0, 1, 2, 2, 3]
    assert list(D.time_map(4, 24.0, 2, 24.0)) == [0, 1, 1, 1]
    assert D.fit_frames(a, 6, 3).shape == (2, 3, 6)
    assert D.working_size(1920, 1080) == (1024, 576) and D.working_size(640, 360) == (640, 360)


def test_da3_depth_is_steadied_scaled_and_sky_is_infinity():
    n, h, w = 9, 20, 30
    base = np.where(np.arange(w)[None, :] < 15, 2.0, 8.0) * np.ones((h, 1))
    jitter = np.array([1, 1.3, 0.8, 1.2, 0.9, 1.25, 0.85, 1.1, 1.0])
    raw = np.stack([base * j for j in jitter]).astype(np.float32)
    sky = np.zeros_like(raw)
    sky[:, :3] = 1.0
    inv = D.da3_inverse(raw, sky)
    assert (inv[:, :3] == 0).all()
    med = np.array([np.median(inv[i][3:]) for i in range(n)])
    assert med.std() / med.mean() < 0.2 * (1 / jitter).std() / (1 / jitter).mean() + 0.05   # the pumping is gone
    dio, s = D.anchor(inv, 0.2, 0.5, 2.0)
    assert 1 / P.patch_level(dio[0], int(0.2 * (w - 1)), 10) == pytest.approx(2.0, rel=1e-3)
    # the far half keeps its ratio: 4x the distance
    assert np.median(dio[0][:, 20:]) == pytest.approx(np.median(dio[0][3:, 3:12]) / 4, rel=0.05)


def test_upsampled_depth_keeps_its_edge_where_the_depth_put_it_and_hard():
    h, w = 64, 64
    gray = np.zeros((h, w), np.float32)
    gray[:, 33:] = 1.0                                                  # the picture's edge is at x = 33
    small = np.zeros((16, 16), np.float32)
    small[:, 8:] = 1.0                                                  # coarse depth edge at x = 32
    up = D.full_size(small, gray)
    assert up.shape == (h, w)
    assert up[:, :28].max() < 0.25 and up[:, 38:].min() > 0.75
    assert set(np.unique(up)) <= {0.0, 1.0}                              # no in-between distances on the step
    assert np.array_equal(D.full_size(small, size=(h, w)), up)


# ------------------------------------------------------------------------------------------------ the graph

def test_depth_prompt_valid():
    p = G.depth_prompt("soundstage_private/refocus/x_plate.mp4 [input]", "depth_anything_3_mono_large.safetensors", "rf_x")
    assert TF.check(as_graph(p)) == []
    load = next(n for n in p.values() if n["class_type"] == "SoundstageClipLoad")["inputs"]
    assert load["fps"] == 0.0 and load["max_frames"] == 0                               # every frame, own rate
    assert p["npz"]["class_type"] == "SoundstageDA3Export" and p["npz"]["inputs"]["name"] == "rf_x"
    s = G.depth_prompt("soundstage/look_00001_.png [output]", "depth_anything_3_mono_large.safetensors", "rf_y", still=True)
    assert TF.check(as_graph(s)) == []
    assert any(n["class_type"] == "SoundstageImageLoad" for n in s.values())


# ------------------------------------------------------------------------------------------------ the job, end to end

def _fake_folders(monkeypatch, tmp_path, models=("depth_anything_3_mono_large.safetensors",)):
    dirs = {k: tmp_path / k for k in ("input", "output", "temp")}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    fp = types.ModuleType("folder_paths")
    fp.get_input_directory = lambda: str(dirs["input"])
    fp.get_output_directory = lambda: str(dirs["output"])
    fp.get_temp_directory = lambda: str(dirs["temp"])

    def annotated(ref):
        name, kind = ref, "input"
        if ref.endswith("]") and " [" in ref:
            name, kind = ref[:-1].rsplit(" [", 1)
        return str(dirs[kind] / name)
    fp.get_annotated_filepath = annotated
    fp.get_filename_list = lambda folder: list(models) if folder == "geometry_estimation" else []
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    return dirs


def _make_clip(path, w=320, h=180, n=25, fps=24, audio=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
    cmd += ["-frames:v", str(n), "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p"]
    cmd += (["-c:a", "aac", "-shortest"] if audio else []) + [path]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    return path


def _fake_da3(monkeypatch, calls):
    from soundstage.video2stage import queue as Q

    async def run_graph(base, graph, what, timeout_s=0, on_wait=None):
        calls.append(graph)
        import folder_paths
        name = graph["npz"]["inputs"]["name"]
        load = next(n for n in graph.values() if n["class_type"] in ("SoundstageClipLoad", "SoundstageImageLoad"))
        src = folder_paths.get_annotated_filepath(load["inputs"]["source"])
        from soundstage.takecheck import video as V
        info = V.probe(src)
        n, h, w = max(1, info["frames"]), info["height"], info["width"]            # the plate: 8k+1, held
        depth = np.where(np.arange(w)[None, None, :] < w // 2, 1.0, 5.0) * np.ones((n, h, 1))   # relative: left near
        out = os.path.join(folder_paths.get_output_directory(), "soundstage_v2s", f"{name}.npz")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        np.savez_compressed(out, depth=depth.astype(np.float32), sky=np.zeros_like(depth, np.float16))
        return {"npz": {"text": [out]}}, {"total_ms": 5}
    monkeypatch.setattr(Q, "run_graph", run_graph)


@pytest.mark.skipif(not FF, reason="needs ffmpeg")
def test_run_refocuses_a_clip_and_keeps_its_frames_sound_and_recipe(monkeypatch, tmp_path):
    from soundstage.takecheck import recipe as RC
    from soundstage.takecheck import video as V
    dirs = _fake_folders(monkeypatch, tmp_path)
    src = _make_clip(str(dirs["output"] / "soundstage" / "draft_00001_.mp4"))
    RC.embed(src, {"v": 1, "app": "Soundstage", "scene": {"camera": {}, "active_shot": "s1"}, "shot": {"id": "s1"}})
    calls, steps = [], []
    _fake_da3(monkeypatch, calls)
    body = {"a": [0.25, 0.5], "b": [0.75, 0.5], "t_stop": 1.4, "focal_mm": 85, "subject_m": 2.0, "start": 0.2, "land": 0.8}
    res = asyncio.run(RF.run("http://x", "soundstage/draft_00001_.mp4 [output]", body, progress=lambda s, f: steps.append(s)))
    assert len(calls) == 1 and res["depth"] == "da3" and res["kind"] == "clip"
    out = os.path.join(dirs["output"], res["file"]["subfolder"], res["file"]["filename"])
    assert res["file"]["type"] == "output" and res["file"]["subfolder"] == "soundstage_private/refocus"
    a, b = V.probe(src), V.probe(out)
    assert (b["width"], b["height"]) == (a["width"], a["height"]) and b["frames"] == a["frames"] == 25
    assert b["fps"] == pytest.approx(a["fps"])
    assert RF.has_audio(out)
    rec = RC.read(out)
    assert rec["shot"] == {"id": "s1"} and rec["refocus"]["t_stop"] == 1.4 and rec["refocus"]["depth"] == "da3"
    fm = rec["refocus"]["focus_m"]
    assert fm[0] == pytest.approx(2.0, rel=0.05) and fm[-1] == pytest.approx(10.0, rel=0.1)   # A at 2 m, B 5x farther
    assert any(s.startswith("Refocusing frame") for s in steps)
    # frame 1 is focused on the left (near) half: the right half is the one that went soft
    f_in = V.read_frames(src, width=320, gray=False)[0].astype(np.float32)
    f_out = V.read_frames(out, width=320, gray=False)[0].astype(np.float32)
    far, near = _hf(f_out[:, 180:]) / _hf(f_in[:, 180:]), _hf(f_out[:, :140]) / _hf(f_in[:, :140])
    assert far < 0.8 and near > 0.9, (far, near)        # testsrc2 is mostly flat colour: the far half still loses >20%
    # a second run is free: the depth is cached
    asyncio.run(RF.run("http://x", "soundstage/draft_00001_.mp4 [output]", dict(body, t_stop=4)))
    assert len(calls) == 1


@pytest.mark.skipif(not FF, reason="needs ffmpeg")
def test_run_uses_the_stage_depth_without_a_gpu(monkeypatch, tmp_path):
    from PIL import Image
    dirs = _fake_folders(monkeypatch, tmp_path, models=())
    _make_clip(str(dirs["output"] / "soundstage" / "draft_00002_.mp4"), n=17, audio=False)
    frames, tw, th, cols = 17, 160, 90, 5
    tile = np.where(np.arange(tw)[None, :] < tw // 2, 1 / 2.0, 1 / 12.0) * np.ones((th, 1))
    sheet = np.zeros((4 * th, cols * tw, 3), np.uint8)
    for i in range(frames):
        sheet[(i // cols) * th:(i // cols + 1) * th, (i % cols) * tw:(i % cols + 1) * tw] = D.encode16(tile)
    sub = dirs["input"] / "soundstage_private" / "refocus"
    sub.mkdir(parents=True)
    Image.fromarray(sheet).save(sub / "rf_s1.png")
    calls = []
    _fake_da3(monkeypatch, calls)
    stage = {"sheet": "soundstage_private/refocus/rf_s1.png [input]", "cols": cols, "frames": frames, "tile": [tw, th],
             "fps": 24, "focal_mm": [50.0] * frames}
    res = asyncio.run(RF.run("http://x", "soundstage/draft_00002_.mp4 [output]",
                             {"a": "0.2,0.5", "b": "0.8,0.5", "t_stop": 2, "stage": stage}))
    assert not calls and res["depth"] == "stage"
    assert res["focus"]["focal_mm"] == 50.0 and res["focus"]["lens_from"] == "shot"
    assert res["focus"]["focus_m"][0] == pytest.approx(2.0, rel=0.02) and res["focus"]["focus_m"][-1] == pytest.approx(12.0, rel=0.05)
    assert not RF.has_audio(os.path.join(dirs["output"], "soundstage_private", "refocus", res["file"]["filename"]))
    # asking for stage depth without a stage pass, or DA3 where there is none, says so
    with pytest.raises(ValueError, match="stage"):
        asyncio.run(RF.run("http://x", "soundstage/draft_00002_.mp4 [output]", {"depth": "stage"}))
    with pytest.raises(RuntimeError, match="Depth Anything 3 is not on this server"):
        asyncio.run(RF.run("http://x", "soundstage/draft_00002_.mp4 [output]", {"depth": "da3"}))


@pytest.mark.skipif(not FF, reason="needs ffmpeg")
def test_run_refocuses_a_still_and_refuses_files_outside_comfyui(monkeypatch, tmp_path):
    from PIL import Image
    dirs = _fake_folders(monkeypatch, tmp_path)
    (dirs["output"] / "soundstage").mkdir()
    Image.fromarray((_texture(90, 160, 7) * 255).astype(np.uint8)).save(dirs["output"] / "soundstage" / "look_00001_.png")
    calls = []
    _fake_da3(monkeypatch, calls)
    res = asyncio.run(RF.run("http://x", "soundstage/look_00001_.png [output]", {"a": [0.2, 0.5], "t_stop": 1.4, "focal_mm": 85}))
    assert res["kind"] == "still" and res["file"]["filename"].endswith(".png")
    assert any(n["class_type"] == "SoundstageImageLoad" for n in calls[0].values())
    assert any("guessed 2.5 m" in n for n in res["notes"])           # no distance given: said so
    outside = tmp_path / "elsewhere.mp4"
    outside.write_bytes(b"x")
    with pytest.raises(ValueError, match="not a file in ComfyUI"):
        asyncio.run(RF.run("http://x", "../elsewhere.mp4 [output]", {}))


def test_route_starts_a_job_and_reports_it(monkeypatch):
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")
    from soundstage.handoff import routes as HR
    seen = {}

    async def fake_run(base, source, body, progress=None, list_files=None):
        seen.update(source=source, body=body)
        progress("Refocusing frame 3 of 9", 0.5)
        await asyncio.sleep(0.05)
        return {"file": {"filename": "x_rf_1.mp4", "subfolder": "soundstage_private/refocus", "type": "output"}, "kind": "clip"}
    monkeypatch.setattr(RF, "run", fake_run)

    async def main():
        table = web.RouteTableDef()
        HR._REGISTERED = False
        HR.register(table)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(base + "/soundstage/refocus", json={}) as r:
                    assert r.status == 400
                async with s.post(base + "/soundstage/refocus", json={"source": "soundstage/a.mp4 [output]", "a": [0.1, 0.2], "t_stop": 2}) as r:
                    job = (await r.json())["job"]
                for _ in range(50):
                    async with s.get(base + f"/soundstage/refocus/job?id={job}") as r:
                        j = await r.json()
                    if j["state"] == "done":
                        break
                    await asyncio.sleep(0.02)
                assert j["state"] == "done" and j["result"]["file"]["filename"] == "x_rf_1.mp4" and "t" not in j
                async with s.get(base + "/soundstage/refocus/job?id=nope") as r:
                    assert r.status == 404
        finally:
            await runner.cleanup()
            HR._REGISTERED = False
    asyncio.run(main())
    assert seen["source"] == "soundstage/a.mp4 [output]" and seen["body"]["t_stop"] == 2


@pytest.mark.skipif(not FF, reason="needs ffmpeg")
def test_the_shots_lens_is_used_without_a_depth_sheet_and_the_cpu_work_runs_off_the_event_loop(monkeypatch, tmp_path):
    """Review 2026-11-02: with DA3 and a distance given the App takes no stage pass, so the shot's lens was lost
    (35 mm); and DA3's post-processing (seconds on a long take) ran on ComfyUI's event loop."""
    from PIL import Image
    dirs = _fake_folders(monkeypatch, tmp_path)
    (dirs["output"] / "soundstage").mkdir()
    Image.fromarray((_texture(90, 160, 7) * 255).astype(np.uint8)).save(dirs["output"] / "soundstage" / "look_00002_.png")
    calls, threaded = [], []
    _fake_da3(monkeypatch, calls)
    real = asyncio.to_thread

    async def to_thread(fn, *a, **k):
        threaded.append(getattr(fn, "__name__", str(fn)))
        return await real(fn, *a, **k)
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    res = asyncio.run(RF.run("http://x", "soundstage/look_00002_.png [output]",
                             {"a": [0.2, 0.5], "t_stop": 2, "subject_m": 2, "depth": "da3", "lens": {"focal_mm": [85.0], "fps": 24}}))
    assert res["focus"]["focal_mm"] == 85.0 and res["focus"]["lens_from"] == "shot"
    assert not any("35 mm assumed" in n for n in res["notes"])
    assert "da3_depth" in threaded and "render_still" in threaded


def test_route_runs_one_refocus_at_a_time(monkeypatch):
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")
    from soundstage.handoff import routes as HR
    live, peak = [0], [0]

    async def fake_run(base, source, body, progress=None, list_files=None):
        live[0] += 1
        peak[0] = max(peak[0], live[0])
        await asyncio.sleep(0.15)
        live[0] -= 1
        return {"file": {"filename": f"{source}.mp4"}, "kind": "clip"}
    monkeypatch.setattr(RF, "run", fake_run)
    monkeypatch.setattr(HR, "_REFOCUS_LOCK", None)

    async def main():
        table = web.RouteTableDef()
        HR._REGISTERED = False
        HR.register(table)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with aiohttp.ClientSession() as s:
                jobs = []
                for src in ("a", "b"):
                    async with s.post(base + "/soundstage/refocus", json={"source": src}) as r:
                        jobs.append((await r.json())["job"])
                await asyncio.sleep(0.05)
                async with s.get(base + f"/soundstage/refocus/job?id={jobs[1]}") as r:
                    waiting = await r.json()
                assert waiting["state"] == "queued" and "Waiting" in waiting["step"]
                for _ in range(100):
                    states = []
                    for j in jobs:
                        async with s.get(base + f"/soundstage/refocus/job?id={j}") as r:
                            states.append((await r.json())["state"])
                    if states == ["done", "done"]:
                        break
                    await asyncio.sleep(0.03)
                assert states == ["done", "done"]
        finally:
            await runner.cleanup()
            HR._REGISTERED = False
    asyncio.run(main())
    assert peak[0] == 1


# ------------------------------------------------------------------------------------------------ licence

def test_hero_frame_rig_licence_travels_with_the_adapted_code():
    lic = open(os.path.join(ROOT, "soundstage", "refocus", "LICENSE.HeroFrameRig"), encoding="utf-8").read()
    assert lic.startswith("MIT License") and "Copyright (c) 2026 Maxwell / Hero Frame Rig contributors" in lic
    assert "THE SOFTWARE IS PROVIDED \"AS IS\"" in lic
    notices = open(os.path.join(ROOT, "THIRD_PARTY_NOTICES.md"), encoding="utf-8").read()
    assert "hero-frame-rig" in notices and "946d80a" in notices and "soundstage/refocus/LICENSE.HeroFrameRig" in notices
    for f in ("optics.py", "plan.py", "depth.py"):
        src = open(os.path.join(ROOT, "soundstage", "refocus", f), encoding="utf-8").read()
        assert "MIT" in src and ("Hero Frame Rig" in src or "HFR" in src), f
    # nothing from the Apache-2.0 app code or the Radiance-matched Legacy renderer
    allsrc = "".join(open(os.path.join(ROOT, "soundstage", "refocus", f), encoding="utf-8").read()
                     for f in os.listdir(os.path.join(ROOT, "soundstage", "refocus")) if f.endswith(".py"))
    for name in ("_render_legacy", "legacy_sigma", "round_lens", "rack_focus", "metric_scale", "z_near_for"):
        assert name not in allsrc, name


def test_catalog_lists_refocus_under_camera():
    from soundstage.oneclick import catalog as C
    assert "refocus" in C.ids()
    assert {"id": "refocus", "group": "Camera"} in C.describe()
