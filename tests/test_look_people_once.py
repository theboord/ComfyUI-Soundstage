"""④ Frame's still prompt says each person ONCE, faces them the way the body faces at the painted frame, and always
dresses them (soundstage/look/scene.py person_still_phrase / body_yaw, look/identity.py wardrobe).

C22c GPU test, 2026-11-08 (Krea 2 + depth, 2 of 2 seeds): one woman at the right third, mid-distance, walking
screen-left from a frontal stand. The old group phrase "a woman right of frame, full figures in the middle distance,
empty ground in the foreground, in profile, facing screen-left" painted a second woman in profile, and with no
clothing in the prompt the woman came out with a bare, skin-toned torso. Invented test scenes only."""
import copy
import re

from soundstage.look import identity as I
from soundstage.look import scene as S
from soundstage.look.compile import compile_look
from soundstage.look.default_scene import DEFAULT_SCENE


def _room(actors, frames=121):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": "interior", "weather": "none"}
    s["shot"] = {"frames": frames, "fps": 24}
    s["camera"] = {"position": [0, 1.6, 9], "target": [0, 1.3, 0], "focal_mm": 35}
    s.pop("camera_end", None)
    s["props"] = []
    s["actors"] = actors
    return s


def _walker():
    """Jane Doe: stands square to the lens (Turn 0 faces +Z, the camera is at +Z), holds 12 frames, walks screen-left."""
    return {"id": "jane", "name": "Jane Doe", "kind": "woman", "height_m": 1.68, "position": [1.6, 0, 0],
            "keys": [{"frame": 0, "position": [1.6, 0, 0]}, {"frame": 12, "position": [1.6, 0, 0]},
                     {"frame": 120, "position": [-2.5, 0, 0]}]}


def test_one_person_is_said_once_with_count_size_place_and_distance():
    still = compile_look({}, _room([_walker()]))["still_prompt"]
    assert "exactly one woman, full figure, small in frame, standing at the right third, mid-distance" in still
    assert len(re.findall(r"\bwoman\b|\bwomen\b", still)) == 1, still
    for gone in ("full figures", "right of frame", "empty ground in the foreground", "side by side"):
        assert gone not in still, gone
    # C22c's F0: the description carried its own people line; the room stays, the person is still said once
    look = {"description": "a bare room at night, plain walls, a window on the back wall, one woman, full figure, "
                           "small in frame, standing at the right third, mid-distance"}
    still = compile_look(look, _room([_walker()]))["still_prompt"]
    assert "a bare room at night, plain walls, a window on the back wall" in still
    assert len(re.findall(r"\bwoman\b", still)) == 1 and still.count("full figure") == 1, still


def test_two_people_are_one_counted_statement_each_said_once():
    john = {"id": "john", "name": "John Doe", "kind": "man", "height_m": 1.8, "position": [-1.6, 0, 0]}
    still = compile_look({}, _room([_walker(), john]))["still_prompt"]
    assert "exactly two people: a man, full figure, small in frame, standing at the left third, mid-distance" in still
    assert "; a woman, full figure, small in frame, standing at the right third, mid-distance" in still
    assert len(re.findall(r"\bman\b", still)) == 1 and len(re.findall(r"\bwoman\b", still)) == 1, still
    assert "full figures" not in still and "side by side" not in still and "two men" not in still


def test_a_walker_faces_the_way_her_body_faces_at_frame_0():
    sc = _room([_walker()])
    out = compile_look({}, sc)
    assert "mid-distance, facing the camera" in out["still_prompt"]
    assert "in profile" not in out["still_prompt"] and "facing screen-left" not in out["still_prompt"]
    assert "facing the camera" not in out["still_negative"]
    # the stage turns her (540 deg/s, ahead of setting off): square to the lens at 0, in profile once she walks
    assert abs(S.body_yaw(sc["actors"][0], 0, 120)) < 1e-6
    assert abs(abs(S.body_yaw(sc["actors"][0], 60, 120)) - 3.14159 / 2) < 0.05
    mid = S.frame_facts(sc, S.camera_at(sc, 60), 60)["people"][0]
    assert S._facing_words(mid["heading"], S.camera_at(sc, 60)) == "in profile, facing screen-left"


def test_a_lifelike_person_wears_the_avatars_own_clothes():
    out = compile_look({}, _room([_walker()]))
    want = "wearing a pink button-up shirt with rolled-up sleeves, blue jeans and dark shoes, fully clothed"
    assert want in out["still_prompt"]
    assert "pink button-up shirt" in out["motion_prompt"] and "fully clothed" in out["motion_prompt"]
    # the look's description names the clothes: the director's words win
    still = compile_look({"description": "a woman in a green raincoat and black boots"}, _room([_walker()]))["still_prompt"]
    assert "wearing a green raincoat and black boots, fully clothed" in still and "pink" not in still


def test_the_stand_in_wears_its_appearance_and_nobody_is_ever_undressed():
    kid = {"id": "kid", "kind": "child", "height_m": 1.2, "position": [0, 0, 0],
           "appearance": {"top": "hoodie", "top_color": "#d9534f", "bottom": "trousers", "bottom_color": "#2e3b55"}}
    assert "wearing a coral hoodie and navy trousers, fully clothed" in compile_look({}, _room([kid]))["still_prompt"]
    # a person with no wardrobe data at all: still clothed in words
    double = {"id": "dbl", "kind": "custom", "name": "Stunt double", "recipe": {"rig": "biped"}, "height_m": 1.8,
              "position": [0, 0, 0]}
    still = compile_look({}, _room([double]))["still_prompt"]
    assert "exactly one stunt double" in still and "fully clothed" in still
    assert I.wardrobe(_room([double]), double) == "fully clothed"
