"""Milestone 11 sets (web/stage/sets): the prompts read the new places, underwater reads underwater, fire reads fire."""
import copy

import pytest

from soundstage.look import scene as S
from soundstage.look.compile import compile_look
from soundstage.look.default_scene import DEFAULT_SCENE


def _scene(set_id, cam_y=1.6, weather="none"):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": set_id, "weather": weather, "density": 0.5}
    for k in s.get("camera_keys") or []:
        k["position"][1] = cam_y
    if s.get("camera"):
        s["camera"]["position"][1] = cam_y
    return s


@pytest.mark.parametrize("set_id", ["underwater", "burning_building", "airplane_cabin", "runway", "above_clouds",
                                    "train_car", "train_station"])
def test_every_new_set_has_place_words(set_id):
    ie, place = S.SET_PLACES[set_id]
    assert ie in ("INT", "EXT") and place
    out = compile_look({}, _scene(set_id))
    assert place.split(",")[0] in out["still_prompt"] or place.split(",")[0] in out["motion_prompt"]


def test_the_reef_reads_underwater_in_both_prompts():
    out = compile_look({}, _scene("underwater", cam_y=2.0))
    assert "underwater" in out["still_prompt"] and "underwater" in out["motion_prompt"]
    assert "coral reef" in out["motion_prompt"]
    assert S._underwater(_scene("underwater", cam_y=2.0), {"position": [0, 2.0, -8]})
    assert not S._underwater(_scene("underwater"), {"position": [0, 12.0, -8]})


def test_the_fire_atmospheric_reads_as_flames():
    out = compile_look({}, _scene("forest", weather="fire"))
    assert "flames" in out["motion_prompt"]


def test_no_signs_or_text_words_in_the_new_places():
    for set_id in ["underwater", "burning_building", "airplane_cabin", "runway", "above_clouds", "train_car", "train_station"]:
        place = S.SET_PLACES[set_id][1]
        for w in ("sign", "text", "number", "logo", "letter"):
            assert w not in place, (set_id, w)


def test_a_diver_off_the_seabed_swims():
    s = _scene("underwater", cam_y=1.6)
    s["actors"] = [{"id": "d", "kind": "man", "height_m": 1.8, "position": [2, 1.3, 0],
                    "keys": [{"frame": 0, "position": [2, 1.3, 0]}, {"frame": 96, "position": [2, 1.4, 4.8]}]}]
    marks = S.actor_marks(s)
    assert marks and "swims" in str(marks[0])


def test_a_passenger_in_a_seat_row_sits_by_the_window():
    s = _scene("airplane_cabin", cam_y=1.22)
    s["actors"] = [{"id": "row", "kind": "plane_seats", "height_m": 1.3, "position": [1.03, 0, -0.88], "rotation_deg": 0,
                    "keys": [{"frame": 0, "position": [1.03, 0, -0.88]}]},
                   {"id": "pax", "kind": "woman", "height_m": 1.68, "position": [1.5, 0, -0.9], "mount_id": "row", "seat": 0,
                    "keys": [{"frame": 0, "position": [1.5, 0, -0.9]}]}]
    s["camera_keys"] = [{"frame": 0, "position": [-0.2, 1.22, -0.45], "target": [1.6, 1.1, -1.02], "focal_mm": 28}]
    s["camera"] = dict(s["camera_keys"][0])
    s.pop("camera_end", None)
    out = compile_look({}, s)
    assert " rides " not in out["motion_prompt"]


def test_the_carriage_window_view_is_blurred_in_the_guide_and_the_carriage_stays_sharp():
    torch = pytest.importorskip("torch")
    from soundstage.look.look_start import blur_window_view
    H, W = 64, 96
    guide = torch.zeros(1, H, W, 3)
    guide[0, :, ::2] = 1.0                                   # hard stripes everywhere
    depth = torch.zeros(1, H, W, 3)
    depth[0, :, : W // 2] = 0.97                             # left half: inside the carriage (~2 m)
    depth[0, :, W // 2:] = 0.3                               # right half: the countryside (~28 m)
    out = blur_window_view(guide, depth, {"environment": {"set": "train_car"}})
    assert torch.equal(out[0, :, : W // 2 - 4], guide[0, :, : W // 2 - 4])
    assert out[0, :, W // 2 + 8:].std() < 0.1                # stripes gone out of the window
    same = blur_window_view(guide, depth, {"environment": {"set": "street_night"}})
    assert torch.equal(same, guide)
