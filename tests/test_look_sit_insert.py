"""Timed sits and hands-only inserts in the compiled prompts (Maya scene v2, 2026-11-09).

S4: a timed sit (sit_spans) compiled as "The woman walks away from the camera into the chair" for a woman who turns
and sits facing the lens; LTX turned her back and walked her off. S3: a hands-only insert still said "standing at the
right third, facing the camera ... dark shoes ... natural expressions" and the frame models painted legs on the table.
"""
import copy
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.look import scene as S  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402

ROOM = ("A bare rented room in late afternoon. One wooden chair, a wooden table with a phone lying on it. "
        "Maya wears a pink button-up shirt with rolled-up sleeves, blue jeans.")
CAM = {"position": [-1.9, 1.4, 0.95], "target": [-0.12, 0.98, 0.0], "focal_mm": 32}


def _scene(maya: dict, camera=CAM, frames=145, chair_deg=-90):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": "plaza", "weather": "none", "density": 0.5, "water_level": 2.5}
    s["shot"] = {"frames": frames, "fps": 24}
    s["camera"] = camera
    s.pop("camera_end", None)
    s["props"] = []
    s["actors"] = [
        {"id": "chair_main", "kind": "chair", "name": "Chair", "position": [-0.15, 0, 0], "rotation_deg": chair_deg,
         "keys": [{"frame": 0, "position": [-0.15, 0, 0]}]},
        {"id": "table_main", "kind": "table", "name": "Small table", "position": [1, 0, 0.1], "rotation_deg": 0,
         "keys": [{"frame": 0, "position": [1, 0, 0.1]}]},
        {"id": "maya", "name": "Maya", "kind": "woman", "height_m": 1.68, **maya},
    ]
    return s


WALK_IN = {"position": [-0.62, 0, 0.62], "rotation_deg": 200,
           "keys": [{"frame": 0, "position": [-0.62, 0, 0.62]}, {"frame": 22, "position": [-0.486, 0, 0]},
                    {"frame": 144, "position": [-0.486, 0, 0]}],
           "sit_spans": [{"on": "chair_main", "at": 22, "to": None}]}


def _motion(sc):
    return compile_look({"description": ROOM}, sc)["motion_prompt"]


# ---------------------------------------------------------------- bug 1: a timed sit in the motion prompt

def test_a_timed_sit_says_she_sits_down_facing_the_way_she_sits_not_the_walk():
    m = _motion(_scene(WALK_IN))
    assert "she sits down in the chair, facing the camera" in m
    assert "walks away from the camera" not in m and "into the chair" not in m
    assert "stays seated in the chair to the end of the shot" in m and "does not walk away" in m
    assert "follows behind" not in m, "no follow-the-walker camera for a sit"


def test_the_seat_facing_not_the_walk_decides_the_direction_words():
    turned = _motion(_scene(WALK_IN, chair_deg=90))   # same walk; the chair faces away from the lens
    assert "she sits down in the chair, seen from behind" in turned
    assert "facing the camera, lowering" not in turned


def test_a_timed_stand_says_she_stands_up_from_the_chair_and_where_she_walks():
    maya = {"position": [-0.486, 0, 0],
            "keys": [{"frame": 0, "position": [-0.486, 0, 0]}, {"frame": 50, "position": [-0.486, 0, 0]},
                     {"frame": 120, "position": [-1.8, 0, 0.8]}],
            "sit_spans": [{"on": "chair_main", "at": None, "to": 30}]}
    m = _motion(_scene(maya))
    assert "sits in the chair, facing the camera" in m
    assert "At 1.2 s she stands up from the chair and walks toward the camera" in m
    assert "into the chair" not in m


def test_seated_from_frame_1_is_seated_in_the_still():
    maya = {"position": [-0.486, 0, 0], "keys": [{"frame": 0, "position": [-0.486, 0, 0]}],
            "sit_spans": [{"on": "chair_main", "at": None, "to": None}]}
    sc = _scene(maya)
    e = S.frame1_facts(sc)["people"][0]
    assert e["seated"] and "sitting on a chair" in e["noun"]
    assert "standing" not in compile_look({"description": ROOM}, sc)["still_prompt"]


def test_the_shot_end_of_a_timed_sit_is_seated():
    sc = _scene(WALK_IN)
    end = S.frame_facts(sc, S.camera_at(sc, 144), 144)["people"][0]
    assert end["seated"] and "sitting on a chair" in end["noun"], "the shot's last frame reads her seated, not standing"
    assert abs(end["pos"][1] - 0.47) < 0.05, "on the seat top"


def test_a_shot_with_its_own_blocking_uses_its_own_sit_spans():
    maya = copy.deepcopy(WALK_IN)
    maya["by_shot"] = {"s2": {"keys": [{"frame": 0, "position": [-0.62, 0, 0.62]}]}}   # no sit in shot s2
    sc = _scene(maya)
    sc["active_shot"] = "s2"
    assert S.sit_spans(sc, sc["actors"][2]) == []
    sc["active_shot"] = "s1"
    assert S.sit_spans(sc, sc["actors"][2])[0]["at"] == 22


# ---------------------------------------------------------------- bug 3: a hands-only insert in the still

INSERT_CAM = {"position": [1.45, 1.0, -0.25], "target": [1.08, 0.8, 0.5], "focal_mm": 85}
HANDS = {"position": [0.9, 0, 0.7], "rotation_deg": 180, "keys": [{"frame": 0, "position": [0.9, 0, 0.7]}]}


def test_a_hands_only_insert_describes_the_hands_the_surface_and_the_object():
    sc = _scene(HANDS, camera=INSERT_CAM, frames=97)
    sc["actors"].append({"id": "phone", "kind": "phone", "name": "Phone", "height_m": 0.02, "position": [0.8, 0.78, 0.2],
                         "keys": [{"frame": 0, "position": [0.8, 0.78, 0.2]}]})
    e = S.frame1_facts(sc)["people"][0]
    assert S.hands_only(e) and e["hands_surface"] == "the table"
    out = compile_look({"description": ROOM + " Close on Maya's right hand resting on the edge of the table."}, sc)
    still = out["still_prompt"]
    assert "only her hands and forearms in frame" in still and "her hands resting on the edge of the table" in still
    assert "beside a phone" in still
    for gone in ("standing", "at the right third", "facing the camera", "dark shoes", "jeans and", "natural expressions",
                 "body language", "fully clothed"):
        assert gone not in still, gone
    assert "pink button-up shirt" in still, "the sleeves still say what she wears"
    assert "legs" in out["still_negative"] and "shoes" in out["still_negative"]
    edit = out["edit_prompt"]
    assert "the woman's hands exactly" in edit and "dark shoes" not in edit and "position, size and pose" not in edit


def test_a_body_in_frame_keeps_its_place_stance_and_shoes():
    sc = _scene(HANDS, camera={"position": [0.9, 1.5, -3.2], "target": [0.9, 1.0, 0.7], "focal_mm": 32}, frames=97)
    e = S.frame1_facts(sc)["people"][0]
    assert not S.hands_only(e)
    still = compile_look({"description": ROOM}, sc)["still_prompt"]
    assert "standing" in still and "dark shoes" in still and "natural expressions" in still


# ---------------------------------------------------------------- the hands-only insert's motion prompt (GPU test, S3)

TAPS = [{"frame": f, "joints": {"r_index_1": [v, 0], "r_middle_1": [18, 0]}}
        for f, v in ((0, 14), (8, -12), (12, 14), (16, -12), (20, 14), (24, -12), (28, 14),
                     (58, -12), (62, 14), (66, -12), (70, 14), (74, -12), (78, 14), (82, 14))]


def test_a_hands_only_insert_motion_prompt_says_the_hands_the_surface_and_the_taps():
    sc = _scene({**HANDS, "pose_keys": TAPS}, camera=INSERT_CAM, frames=97)
    out = compile_look({"description": ROOM}, sc)
    m = out["motion_prompt"]
    assert "Only her hands and forearms are in frame, resting on the edge of the table" in m
    assert "Her fingers tap on the edge of the table, pause, then tap again." in m
    assert "pink button-up shirt with rolled-up sleeves shows at her wrists" in m
    for gone in ("stands", "standing", "right of frame", "facing the camera", "jeans", "dark shoes", "shoes",
                 "legs", "looks down", "fully clothed"):
        assert gone not in m, gone
    assert "no face, no body" in m
    neg = out["motion_negative"]
    for w in ("face", "head", "standing figure", "legs"):
        assert w in neg, w


def test_the_description_keeps_the_hands_and_the_room_and_loses_the_jeans_and_the_hair():
    sc = _scene(HANDS, camera=INSERT_CAM, frames=97)
    desc = ("A bare rented room in late afternoon. Maya wears a pink button-up shirt with rolled-up sleeves, blue jeans, "
            "her dark hair tied back. Close on Maya's right hand resting on the edge of the table. Her fingers tap the "
            "table edge, go still, then tap again.")
    m = compile_look({"description": desc}, sc)["motion_prompt"]
    assert "Maya wears a pink button-up shirt with rolled-up sleeves." in m
    assert "Her fingers tap the table edge, go still, then tap again." in m
    assert "jeans" not in m and "hair tied back" not in m
    assert "fingers tap on the edge" not in m, "the description already says what the fingers do"


def test_finger_bursts_count_tapping_bursts_from_the_pose_keys():
    sc = _scene({**HANDS, "pose_keys": TAPS}, camera=INSERT_CAM, frames=97)
    assert S.finger_bursts(sc, sc["actors"][2]) == 2
    one = _scene({**HANDS, "pose_keys": TAPS[:7]}, camera=INSERT_CAM, frames=97)
    assert S.finger_bursts(one, one["actors"][2]) == 1
    assert S.finger_bursts(sc, {"pose_keys": [{"frame": 0, "joints": {"spine": [18, 0, 0]}}]}) == 0
    still = _scene(HANDS, camera=INSERT_CAM, frames=97)
    m = compile_look({"description": ROOM}, still)["motion_prompt"]
    assert "fingers tap" not in m, "no finger keys, no taps"


def test_a_body_in_frame_keeps_its_motion_blocking_and_no_motion_negative():
    sc = _scene(HANDS, camera={"position": [0.9, 1.5, -3.2], "target": [0.9, 1.0, 0.7], "focal_mm": 32}, frames=97)
    out = compile_look({"description": ROOM}, sc)
    assert "stands" in out["motion_prompt"] and "dark shoes" in out["motion_prompt"]
    assert out["motion_negative"] == ""
