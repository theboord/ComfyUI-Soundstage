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
