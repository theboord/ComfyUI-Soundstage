"""Real people in the look still, not plastic CG (Milestone 5).

Two levers, measured on FLUX 3 Klein with the riders and windshield shots (docs/decisions.md 2026-10-30):
the still prompt asks for real actors, and frame 1 reaches the image model with the clay heads softened
(upscaled when faces are small).

Run:  python -m pytest tests/test_look_realism.py -q
"""
import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.look import compile as C  # noqa: E402
from soundstage.look import look_start as LS  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402
from soundstage.look.vocab import load_vocab  # noqa: E402


# ---- prompt -----------------------------------------------------------------------------------------

def test_people_in_frame_get_real_actor_wording():
    out = compile_look({}, copy.deepcopy(DEFAULT_SCENE))
    assert out["frame1"]["people"] > 0
    assert "real actors, natural skin texture" in out["still_prompt"]
    assert "candid unposed body language" in out["still_prompt"]
    neg = out["still_negative"]
    assert "plastic skin" in neg and "mannequin" in neg and "doll-like faces" in neg
    # The head count still comes first and the realism words never mention more people.
    p = out["still_prompt"]
    assert p.index("people in frame") < p.index("real actors")


def test_no_people_no_actor_wording():
    scene = copy.deepcopy(DEFAULT_SCENE)
    scene["actors"] = []
    out = compile_look({}, scene)
    assert "real actors" not in out["still_prompt"]
    assert "plastic skin" not in out["still_negative"]


@pytest.mark.parametrize("desc", ["a Pixar-style animated chase", "claymation western", "anime duel at dawn",
                                  "low-poly video game look"])
def test_a_stylised_look_keeps_its_people_stylised(desc):
    out = compile_look({"description": desc}, copy.deepcopy(DEFAULT_SCENE))
    assert "real actors" not in out["still_prompt"]
    assert "3D render" not in out["still_negative"]


def test_brief_can_ask_for_a_stylised_world_too():
    assert not C.real_people_wanted({"brief": {"world": "a painted storybook town"}})
    assert C.real_people_wanted({"description": "gritty 16mm documentary, handheld"})


def test_still_prompt_never_asks_for_cg_skin():
    vocab = load_vocab()
    for items in vocab.values():
        if not isinstance(items, list):
            continue
        for o in items:
            still = (o.get("still") or "") if isinstance(o, dict) else ""
            assert "smooth skin" not in still, o.get("id")
            assert "plastic" not in still, o.get("id")


def test_motion_prompt_is_unchanged_by_the_realism_words():
    out = compile_look({}, copy.deepcopy(DEFAULT_SCENE))
    assert "real actors" not in out["motion_prompt"]


# ---- head detection (pure) --------------------------------------------------------------------------

# Row widths (pixels, top down) of real stage silhouettes at 960 x 512, from the riders and windshield shots.
RIDER_MAN = [11, 15, 19, 22, 24, 26, 26, 26, 27, 27, 27, 27, 27, 27, 27, 26, 26, 26, 26, 25, 25, 24, 23, 22, 21, 20,
             18, 17, 15, 11, 11, 11, 11, 11, 11, 20, 36, 44, 53, 54, 55, 56, 56, 56, 57]
RIDER_WOMAN = [5, 10, 15, 18, 20, 21, 23, 24, 25, 25, 26, 27, 28, 28, 28, 28, 28, 28, 28, 29, 29, 29, 28, 28, 28, 27,
               27, 27, 27, 28, 29, 29, 29, 29, 27, 27, 31, 40, 41, 42, 42, 43, 43, 43, 44]
# Hair down to the shoulders: no neck in the outline, the shoulders widen it over a few rows.
CAR_PASSENGER = [5, 14, 23, 26, 29, 35, 41, 44, 47, 49, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64, 65, 66, 66, 67,
                 68, 68, 68, 68, 69, 70, 70, 70, 70, 70, 71, 71, 71, 72, 73, 73, 73, 73, 73, 73, 73, 74, 74, 74, 74,
                 74, 74, 74, 74, 75, 75, 75, 75, 75, 75, 76, 76, 77, 77, 78, 78, 78, 78, 78, 78, 78, 78, 78, 77,
                 77, 77, 77, 77, 77, 77, 77, 77, 77, 77, 78, 78, 78, 78, 78, 97, 118, 127, 130, 132, 134]
# Short hair and a neck: the outline narrows to the neck, then the shoulders come in wide.
CAR_DRIVER = ([4, 19, 31, 36, 43, 51, 56, 58, 63, 66] + [70] * 50 + [60, 50, 40, 31, 31, 31, 31, 31, 31, 27, 15]
              + [55, 83, 89, 85, 82, 104, 112])


@pytest.mark.parametrize("rows,lo,hi", [(RIDER_MAN, 34, 37), (RIDER_WOMAN, 35, 39), (CAR_PASSENGER, 88, 92),
                                        (CAR_DRIVER, 70, 73)])
def test_shoulder_row_ends_the_head_at_the_shoulders(rows, lo, hi):
    assert lo <= LS._shoulder_row(rows) <= hi


def test_shoulder_row_ignores_the_crown_widening():
    # The crown widens fast (5 -> 23 px in three rows): that is still the head, not the shoulders.
    assert LS._shoulder_row(CAR_PASSENGER) > 20
    assert LS._shoulder_row(RIDER_WOMAN) > 20


def test_upscale_only_when_faces_are_small():
    assert LS.upscale_factor([]) == 1.0
    assert LS.upscale_factor([101, 97]) == 1.0                 # windshield close shot: keep its framing
    assert LS.upscale_factor([36, 36]) == LS.MAX_UPSCALE       # riders wide shot: 960x512 -> 1680x896
    assert 1.0 < LS.upscale_factor([48]) < LS.MAX_UPSCALE
    # An occluded head (cut short by a horse's neck) never asks for more than the largest head needs.
    assert LS.upscale_factor([12, 80]) == 1.0


# ---- the start image (torch) ------------------------------------------------------------------------

def _scene():
    return {"actors": [{"id": "man", "kind": "man"}, {"id": "horse", "kind": "horse"}, {"id": "box", "kind": "crate"}],
            "id_colors": {"man": [255, 0, 0], "horse": [0, 74, 255], "box": [149, 255, 0]}}


def _passes(head_h=40, H=256, W=480):
    """A figure: round head of height head_h on a wide body, a horse block and a box. The ID colours are written
    sRGB-encoded, as the stage's PNG holds them."""
    torch = pytest.importorskip("torch")
    idp = torch.zeros(1, H, W, 3)
    col = torch.zeros(1, H, W, 3)
    col[..., :] = torch.linspace(0, 1, W)[None, None, :, None]   # a gradient so blurring changes pixels
    top, cx, r = 30, 120, head_h // 2
    ys, xs = torch.meshgrid(torch.arange(H), torch.arange(W), indexing="ij")
    head = ((ys - (top + r)) ** 2 + ((xs - cx) * 1.2) ** 2) <= r * r
    body = (ys >= top + head_h) & (ys < top + head_h + 4 * head_h) & ((xs - cx).abs() <= int(head_h * 1.2))
    man = head | body
    red = torch.tensor([1.0, 0, 0])
    blue = LS._srgb(torch.tensor([0, 74 / 255, 1.0]))
    idp[0][man] = red
    idp[0, 200:250, 300:460] = blue
    col[0][head] = torch.tensor([0.8, 0.6, 0.5])
    col[0, top + r, cx] = torch.tensor([0.0, 0.0, 0.0])            # a 'clay eye' the softening must wash out
    return col, idp, head, body


def test_people_masks_find_the_person_not_the_horse():
    col, idp, head, body = _passes()
    masks = LS.person_masks(idp[0], _scene())
    assert list(masks) == ["man"]
    assert int(masks["man"].sum()) == int((head | body).sum())


def test_heads_are_softened_and_the_rest_is_untouched():
    torch = pytest.importorskip("torch")
    col, idp, head, body = _passes(head_h=80)
    out, info = LS.look_start(col, idp, _scene())
    assert info["softened"] and info["people"] == 1 and info["scale"] == 1.0
    assert out.shape == col.shape
    # The clay eye is gone ...
    assert float(out[0, 30 + 40, 120].sum()) > 0.3
    # ... the body below the shoulders and the horse are pixel for pixel the same.
    lower = torch.zeros_like(head)
    lower[30 + 80 + 20:] = True
    assert torch.equal(out[0][lower], col[0][lower])
    assert torch.equal(out[0, 200:250, 300:460], col[0, 200:250, 300:460])


def test_small_faces_upscale_frame_one():
    col, idp, _, _ = _passes(head_h=24)
    out, info = LS.look_start(col, idp, _scene())
    assert info["scale"] > 1.5
    assert out.shape[1] % 16 == 0 and out.shape[2] % 16 == 0
    assert abs(out.shape[2] / out.shape[1] - col.shape[2] / col.shape[1]) < 0.02   # same aspect


def test_no_people_or_no_id_pass_is_a_no_op():
    torch = pytest.importorskip("torch")
    col, idp, _, _ = _passes()
    scene = _scene()
    scene["actors"] = [a for a in scene["actors"] if a["id"] != "man"]
    out, info = LS.look_start(col, idp, scene)
    assert torch.equal(out, col) and info["people"] == 0
    out, info = LS.look_start(col, None, _scene())
    assert torch.equal(out, col)
    out, info = LS.look_start(col, idp, {"actors": []})
    assert torch.equal(out, col)


# ---- the layout guide in ride-along car shots (torch) -----------------------------------------------

def _ride_scene():
    return {"actors": [{"id": "car", "kind": "car", "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 96, "position": [0, 0, 40]}]},
                       {"id": "driver", "kind": "man", "mount_id": "car", "seat": 0}],
            "id_colors": {"car": [255, 0, 0], "driver": [0, 74, 255]}}


def test_quiet_background_only_for_ride_along_car_shots(monkeypatch):
    torch = pytest.importorskip("torch")
    clay = torch.rand(3, 64, 96, 3)
    idp = torch.zeros(3, 64, 96, 3)
    idp[:, 20:50, 30:70] = torch.tensor([1.0, 0, 0])            # the car (and anyone in it) stays sharp
    monkeypatch.setattr(LS, "quiet_background_wanted", lambda scene: True)
    out = LS.quiet_background(clay, idp, _ride_scene())
    assert out.shape == clay.shape
    assert torch.allclose(out[:, 26:44, 36:64], clay[:, 26:44, 36:64], atol=1e-5)   # inside the actor, past the feather
    assert float((out[:, :8, :8] - clay[:, :8, :8]).abs().mean()) > 0.05   # the static set is blurred
    assert float(out[:, :8, :8].std()) < float(clay[:, :8, :8].std())
    monkeypatch.setattr(LS, "quiet_background_wanted", lambda scene: False)
    assert torch.equal(LS.quiet_background(clay, idp, _ride_scene()), clay)
    assert torch.equal(LS.quiet_background(clay, None, _ride_scene()), clay)


def test_quiet_background_wanted_reads_the_scene():
    assert not LS.quiet_background_wanted({"actors": [{"id": "a", "kind": "man"}]})
    assert not LS.quiet_background_wanted({})
