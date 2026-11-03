"""Plate lock + follow-cam on synthetic plates (CPU, no ComfyUI, no models).

The plates are procedural: a textured set with sensor noise. The "model" is simulated the way a video model
misbehaves: it re-renders the whole frame at a lower resolution (soft, no grain), drifts the colour, shimmers, and
makes the edit we asked for. Plate lock must take only the edit and leave everything else bit-identical.
Run:  python -m pytest tests/test_platelock.py -q
"""
import json
import os
import sys

import pytest

torch = pytest.importorskip("torch")
F = torch.nn.functional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.footage import followcam as FC  # noqa: E402
from soundstage.footage import matte as M  # noqa: E402
from soundstage.footage import platelock as PL  # noqa: E402


def plate_clip(t=9, h=96, w=160, noise=0.02, seed=0):
    """A textured set (gradients, stripes, blocks) with per-frame sensor noise, [t,h,w,3]."""
    g = torch.Generator().manual_seed(seed)
    y = torch.linspace(0, 1, h).view(h, 1).expand(h, w)
    x = torch.linspace(0, 1, w).view(1, w).expand(h, w)
    base = torch.stack([0.25 + 0.4 * x, 0.3 + 0.3 * y, 0.35 + 0.15 * torch.sin(x * 25) * torch.cos(y * 17)], -1)
    base[(torch.arange(h) // 12 % 2 == 0)[:, None].expand(h, w) & (x > 0.7)] *= 0.6
    frames = base.expand(t, h, w, 3).clone()
    frames += torch.randn(frames.shape, generator=g) * noise
    return frames.clamp(0, 1)


def model_render(plate, scale=0.5, gain=1.06, bias=0.015):
    """What a video model gives back for an 'unchanged' area: lower res, soft, grain-free, colour drifted."""
    t, h, w, _ = plate.shape
    small = PL.resize_frames(PL._nhwc(PL.gaussian_blur(PL._nchw(plate), 1.2)), int(h * scale), int(w * scale), "area")
    return (small * gain + bias).clamp(0, 1)


def add_box(frames, y0, y1, x0, x1, color=(0.9, 0.1, 0.1)):
    f = frames.clone()
    f[:, y0:y1, x0:x1] = torch.tensor(color)
    return f


# ------------------------------------------------------------------ local mode

def test_local_lock_takes_only_the_edit_and_keeps_the_rest_bit_identical():
    plate = plate_clip(h=192, w=320)
    gen = add_box(model_render(plate), 32, 64, 40, 88)           # a red object at (64..128, 80..176) in plate px
    comp, matte, rep = PL.lock(plate, gen, "local")
    assert comp.shape == plate.shape and matte.shape == plate.shape[:3]
    outside = matte == 0
    assert torch.equal(comp[outside], plate[outside])            # bit-for-bit
    # the edit is in: the object's core is the model's red, matte ~1
    core = (slice(None), slice(74, 118), slice(90, 166))
    assert float(matte[core].min()) > 0.95
    assert float((comp[core][..., 0] - 0.9).abs().mean()) < 0.08
    # and nothing else is: the model's colour drift and softness everywhere else did not get in. The object is 10%
    # of the frame; the matte adds a ~20 px safety halo (hysteresis, grow, feather) and nothing elsewhere
    assert rep["edit_area_pct"] < 30 and rep["bit_identical_pct"] > 70
    far = (slice(None), slice(150, 192), slice(200, 320))
    assert torch.equal(comp[far], plate[far])
    assert rep["psnr_outside_db"] == "inf"
    assert rep["raw_psnr_outside_db"] < 35                       # the raw model was far from the plate there
    assert rep["mode"] == "local" and rep["frames"] == 9 and rep["resolution"] == "320x192"
    json.dumps(rep)


def test_tone_fit_recovers_the_drift_and_ignores_the_edit():
    plate = plate_clip(noise=0.0)
    gen = add_box(model_render(plate, scale=1.0, gain=1.2, bias=-0.05), 10, 70, 10, 90)  # the edit covers ~31%
    gain, bias = PL.fit_tone(plate, gen)
    assert torch.allclose(gain.mean(0), torch.tensor([1.2, 1.2, 1.2]), atol=0.08)
    assert torch.allclose(bias.mean(0), torch.tensor([-0.05, -0.05, -0.05]), atol=0.05)


def test_hysteresis_in_space_and_time():
    z = torch.zeros(5, 20, 20)
    z[2, 5:8, 5:8] = 30                                          # a strong change
    z[2, 8:12, 6] = 5                                            # a weak tail touching it (same frame)
    z[3, 5:8, 5:8] = 5                                           # weak, the next frame, same place (touches in time)
    z[1, 15:18, 15:18] = 5                                       # weak and alone: VAE shimmer
    keep = PL._hysteresis(z, lo=3.0, hi=6.0)
    assert float(keep[2, 6, 6]) == 1 and float(keep[2, 10, 6]) == 1 and float(keep[3, 6, 6]) == 1
    assert float(keep[1, 16, 16]) == 0


def test_difference_matte_ignores_soft_grainless_rerender_and_sparkle():
    plate = plate_clip()
    gen = model_render(plate, scale=1.0, gain=1.0, bias=0.0)
    g = torch.Generator().manual_seed(3)
    ys, xs = torch.randint(0, 96, (40,), generator=g), torch.randint(0, 160, (40,), generator=g)
    gen[4, ys, xs] = (gen[4, ys, xs] + 0.25).clamp(0, 1)          # one-frame, one-pixel VAE sparkles
    m = PL.difference_matte(plate, gen)["matte"]
    assert float((m > 0).float().mean()) < 0.01


def test_temporal_stabilise_fills_a_dropout_and_leaves_no_trail():
    m = torch.zeros(9, 8, 8)
    m[:, 2:6, 2:6] = 1
    m[4] = 0                                                     # one-frame dropout
    s = PL.temporal_stabilize(m)
    assert float(s[4, 3, 3]) > 0.9
    mv = torch.zeros(9, 8, 32)
    for i in range(9):
        mv[i, 2:6, i * 3:i * 3 + 4] = 1                         # a fast mover
    s = PL.temporal_stabilize(mv, window=1)
    assert float(s[8, 3, 0]) == 0.0                              # nothing left where it was 8 frames ago


def test_regrain_adds_only_the_grain_the_generated_pixels_lack():
    plate = plate_clip(noise=0.03, t=4)
    smooth = PL._nhwc(PL.gaussian_blur(PL._nchw(plate), 2.0))
    sigma = PL.regrain_sigma(plate, smooth)
    assert torch.all(sigma > 0.015)
    assert float(PL.regrain_sigma(plate, plate).max()) < 1e-6
    m = torch.ones(4, 96, 160)
    comp, _ = PL.composite(plate, smooth, m, grain=1.0)
    hp = lambda x: (PL._nchw(x) - PL.gaussian_blur(PL._nchw(x), 1.0)).abs().median()  # noqa: E731
    assert abs(float(hp(comp)) - float(hp(plate))) < 0.35 * float(hp(plate))
    comp0, _ = PL.composite(plate, smooth, m, grain=0.0)
    assert float(hp(comp0)) < 0.5 * float(hp(plate))


# ------------------------------------------------------------------ look mode

def test_look_lock_relights_the_plates_own_pixels_and_takes_only_new_structure():
    plate = plate_clip(t=5, noise=0.01, h=192, w=320)
    t, h, w, _ = plate.shape
    x = torch.linspace(0, 1, w).view(1, 1, w, 1)
    light = (0.45 + 0.9 * x) * torch.tensor([1.0, 0.9, 0.75])     # warm key from the right
    relit = model_render((plate * light).clamp(0, 1), gain=1.0, bias=0.0)
    assert float(PL.difference_matte(plate, relit, "look")["matte"].sum()) == 0   # the light alone is not an edit
    gen = add_box(relit, 8, 20, 20, 120, (0.97, 0.97, 0.97))      # snow on a ledge (top-left), in model px
    comp, matte, rep = PL.lock(plate, gen, "look")
    assert rep["mode"] == "look" and rep["edit_area_pct"] < 35
    ledge = (slice(None), slice(20, 36), slice(50, 230))
    assert float(matte[ledge].mean()) > 0.9 and float(comp[ledge].mean()) > 0.9
    # elsewhere: the plate's own detail, re-lit (not the model's soft copy)
    far = (slice(None), slice(110, 180), slice(20, 300))
    want = (plate * light).clamp(0, 1)[far]
    assert float((comp[far] - want).abs().mean()) < 0.03
    hp = lambda a: PL._nchw(a) - PL.gaussian_blur(PL._nchw(a), 1.0)  # noqa: E731
    ratio = float(hp(comp[far]).std() / hp(want).std())
    assert 0.8 < ratio < 1.25                                     # the grain and texture are the plate's
    soft = float(hp(PL.resize_frames(relit, h, w)[far]).std() / hp(want).std())
    assert soft < 0.6                                             # (the model's own copy had lost them)


def test_light_map_is_a_smooth_gain():
    plate = plate_clip(t=1, noise=0.0)
    lm = PL.light_map(plate, (plate * 0.5).clamp(0, 1))
    assert torch.allclose(lm.mean(), torch.tensor(0.5), atol=0.06)
    lm = PL.light_map(torch.zeros(1, 32, 32, 3), torch.ones(1, 32, 32, 3))
    assert float(lm.max()) <= 6.0                                 # a black plate can't be lit by a gain: clamped


# ------------------------------------------------------------------ alpha mode

def test_alpha_lock_keeps_the_picture_and_steadies_the_matte():
    plate = plate_clip(t=7)
    a = torch.zeros(7, 96, 160)
    a[:, 30:70, 50:100] = 1
    a[3] = 0                                                      # the model's matte boils for a frame
    rgba = torch.cat([model_render(plate, scale=1.0), a.unsqueeze(-1)], -1)
    comp, matte, rep = PL.lock(plate, rgba, "alpha")
    assert torch.equal(comp, plate)
    assert float(matte[3, 50, 75]) > 0.9
    assert rep["mode"] == "alpha" and rep["bit_identical_pct"] == 100.0 and 10 < rep["edit_area_pct"] < 20
    with pytest.raises(ValueError):
        PL.lock(plate, plate, "alpha")
    with pytest.raises(ValueError):
        PL.lock(plate, plate, "nope")


def test_still_size_mismatch_and_report_text():
    plate = plate_clip(t=1, h=90, w=161)
    gen = add_box(model_render(plate, scale=0.6), 10, 20, 10, 30)
    comp, matte, rep = PL.lock(plate, gen)
    assert comp.shape == plate.shape and rep["frames"] == 1
    txt = PL.format_report(rep)
    assert "bit-identical" in txt and "lossless" in txt


def test_fidelity_report_counts():
    plate = torch.zeros(1, 10, 10, 3)
    comp = plate.clone()
    comp[0, :2] = 0.5                                             # 20 pixels changed
    m = torch.zeros(1, 10, 10)
    m[0, :2] = 1
    raw = torch.full_like(plate, 0.1)
    r = PL.fidelity_report(plate, comp, m, raw=raw)
    assert r["bit_identical_pct"] == 80.0 and r["edit_area_pct"] == 20.0 and r["psnr_outside_db"] == "inf"
    assert r["raw_psnr_outside_db"] == 20.0                       # mse 0.01


# ------------------------------------------------------------------ follow-cam

def small_performer(t=13, h=120, w=200):
    m = torch.zeros(t, h, w)
    for i in range(t):
        x0 = 30 + i * 6
        m[i, 70:100, x0:x0 + 12] = 1                               # 30 px tall in a 120 px frame (25%), walking right
    return m


def test_plan_crops_follows_smoothly_at_the_plates_aspect():
    m = small_performer()
    rects, info = FC.decide(m, "auto")
    assert info["follow"] and 0.2 < info["subject_height_frac"] < 0.3
    for (x0, y0, rw, rh), b in zip(rects, FC.boxes_from_masks(m)):
        assert 0 <= x0 and 0 <= y0 and x0 + rw <= 200 and y0 + rh <= 120
        assert abs(rw / rh - 200 / 120) < 0.05
        assert x0 <= b[0] and b[2] <= x0 + rw and y0 <= b[1] and b[3] <= y0 + rh   # the performer is in frame
    xs = [r[0] for r in rects]
    assert xs == sorted(xs)                                       # pans with them, never back
    assert info["zoom_max"] <= 4.0


def test_follow_off_or_big_subject_passes_frames_through():
    imgs = plate_clip(t=13, h=120, w=200)
    big = torch.zeros(13, 120, 200)
    big[:, 10:110, 60:140] = 1
    rects, info = FC.decide(big, "auto")
    assert not info["follow"] and FC.is_identity(rects, 200, 120)
    assert FC.crop_frames(imgs, rects) is imgs
    rects, _ = FC.decide(small_performer(), "off")
    assert FC.is_identity(rects, 200, 120)
    rects, info = FC.decide(big, "on")
    assert info["follow"] or FC.is_identity(rects, 200, 120)
    with pytest.raises(ValueError):
        FC.plan_crops([None, None], 200, 120)


def test_crop_then_uncrop_round_trips_inside_the_rect():
    imgs = plate_clip(t=13, h=120, w=200, noise=0.0)
    rects, _ = FC.decide(small_performer(), "on")
    crops = FC.crop_frames(imgs, rects)
    assert crops.shape == imgs.shape
    back, box = FC.uncrop(crops, rects, imgs)
    inside = box > 0.999
    assert float((back - imgs).abs()[inside].mean()) < 0.02
    assert torch.equal(back[box == 0], imgs[box == 0])
    js = FC.dumps(rects, {"follow": True})
    assert FC.loads(js) == rects and FC.loads("") is None


def test_paste_ramp_fades_inner_edges_only():
    r = FC.paste_ramp([0, 20, 50, 40], 200, 120, edge=0.1)
    assert float(r[20, 0]) == 1.0                                 # touching the plate's left edge: no fade
    assert float(r[20, -1]) < 0.3 and float(r[0, 25]) < 0.3       # inner edges fade
    assert float(r[20, 25]) == 1.0


def test_recast_composite_pastes_the_follow_cam_swap_back_and_keeps_the_plate():
    plate = plate_clip(t=13, h=120, w=200)
    sub = small_performer()
    rects, _ = FC.decide(sub, "on")
    crop_plate, crop_sub = FC.crop_frames(plate, rects), FC.crop_masks(sub, rects)
    # the engine, in crop space: re-renders everything soft and drifted, the performer in a blue costume
    swap = model_render(crop_plate, scale=0.5, gain=1.05, bias=0.02)
    cm = PL.resize_mask(crop_sub, swap.shape[1], swap.shape[2]) > 0.5
    swap[cm] = torch.tensor([0.1, 0.2, 0.9])
    r = M.composite_ex(plate, swap, sub, grow_px=3, feather_px=3, crop_rects=rects, tone_fit=True, grain=1.0)
    comp, alpha = r["comp"], r["alpha"]
    assert comp.shape == plate.shape
    assert torch.equal(comp[alpha == 0], plate[alpha == 0])       # bit-identical everywhere the matte is 0
    core = sub > 0.5
    core = core & (PL.erode(sub, 2) > 0.5)
    assert float((comp[core] - torch.tensor([0.1, 0.2, 0.9])).abs().mean()) < 0.12
    rep = PL.fidelity_report(plate, comp, alpha, raw=r["raw"], mode="recast")
    assert rep["bit_identical_pct"] > 80 and rep["psnr_outside_db"] == "inf"
    # outside every crop rect nothing can change
    outside_crop = torch.ones_like(sub, dtype=torch.bool)
    for i, (x0, y0, rw, rh) in enumerate(rects):
        outside_crop[i, y0:y0 + rh, x0:x0 + rw] = False
    assert torch.equal(comp[outside_crop], plate[outside_crop])


def test_recast_reach_takes_a_hat_near_the_subject_but_not_an_invented_neighbour():
    plate = plate_clip(t=9, h=120, w=200, noise=0.005)
    sub = torch.zeros(9, 120, 200)
    sub[:, 50:110, 90:110] = 1
    swap = model_render(plate, scale=1.0, gain=1.0, bias=0.0)
    swap[:, 50:110, 90:110] = torch.tensor([0.2, 0.2, 0.8])
    swap[:, 38:50, 86:114] = torch.tensor([0.05, 0.05, 0.05])     # a hat: just above the SAM mask
    swap[:, 50:110, 10:30] = torch.tensor([0.9, 0.8, 0.1])        # a person the engine invented, far away
    a0 = M.composite_ex(plate, swap, sub, grow_px=2, feather_px=2)["alpha"]
    a1 = M.composite_ex(plate, swap, sub, grow_px=2, feather_px=2, reach_px=20)["alpha"]
    assert float(a0[:, 40:46, 92:108].mean()) < 0.5 < float(a1[:, 40:46, 92:108].mean())
    assert float(a1[:, 60:100, 14:26].max()) == 0.0


def test_recast_composite_is_backwards_compatible():
    plate = plate_clip(t=3, h=40, w=60)
    sub = torch.zeros(3, 40, 60)
    sub[:, 10:30, 20:40] = 1
    swap = torch.full((3, 20, 30, 3), 0.5)
    comp, layer, alpha = M.composite(plate, swap, sub, grow_px=2, feather_px=2)
    assert comp.shape == plate.shape and layer.shape[-1] == 4
    assert torch.equal(comp[alpha == 0], plate[alpha == 0])
