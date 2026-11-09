"""④ Frame paints frame 1, not the shot's later action (Maya scene test, 2026-11-09).

S2 "She walks slowly to the wooden table and stops at its edge" came out with her already at the table; S3, a close
on her hand, was compiled as "close-up of the face, head and shoulders" and painted as a wide. The still / edit prompt
now keeps only what is true at frame 1 (the stage at f0 says where and how big); the action stays in the motion prompt.
"""
import copy
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.look import scene as S  # noqa: E402
from soundstage.look.compile import compile_look, frame1_safe  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402

SET = ("A bare rented room in late afternoon: low warm sun comes through the window blinds in slatted stripes. "
       "One wooden chair, a wooden table with a phone lying on it.")
S2 = (SET + " Jane wears a pink shirt and blue jeans. Jane has just turned away from the window. She walks slowly to "
      "the wooden table and stops at its edge. She looks down at the phone lying on the table. She does not pick it up.")


def _scene(camera, keys, frames=121):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": "plaza", "weather": "none", "density": 0.5, "water_level": 2.5}
    s["shot"] = {"frames": frames, "fps": 24}
    s["camera"] = camera
    s.pop("camera_end", None)
    s["props"] = []
    s["actors"] = [{"id": "jane", "name": "Jane", "kind": "woman", "height_m": 1.68, "position": list(keys[0]["position"]),
                    "keys": keys}]
    return s


# ---------------------------------------------------------------- the description, frame 1 only

def test_a_walk_to_somewhere_and_everything_after_it_leave_the_still():
    out = frame1_safe(S2, names=["Jane"])
    assert "Jane has just turned away from the window" in out, "how frame 1 begins stays"
    for later in ("walks", "table and stops", "stops at", "looks down", "pick it up"):
        assert later not in out
    assert "bare rented room" in out and "pink shirt" in out, "the set and the clothes stay"


def test_a_sentence_about_the_place_after_the_move_stays():
    out = frame1_safe("A bare room. She walks to the door. The blinds are half shut.")
    assert out == "A bare room, The blinds are half shut"


def test_has_just_and_poses_are_frame_1():
    assert frame1_safe("Maya has just stood up from the chair. She takes two steps toward the door, stops, and folds "
                       "her arms.", names=["Maya"]) == "Maya has just stood up from the chair"
    pose = "Maya sits in the chair, leaning forward, elbows on her knees, her thumbnail at her lip"
    assert frame1_safe(pose + ". After a moment her eyes go to the door.", names=["Maya"]) == pose


def test_nouns_that_look_like_verbs_are_not_moves():
    for text in ("A man waits at a bus stop", "The door is open", "A woman in a hat, dressed head to toe in black",
                 "A police sedan drives past from left to right", "Her back to the camera"):
        assert frame1_safe(text) == text.replace(". ", ", ")


def test_end_states_and_hand_actions_are_later():
    for verb in ("She sits down on the bed", "He stands up", "She picks the phone up", "He puts the cup down",
                 "She glances at the door", "He reaches the car", "She heads into the kitchen"):
        assert frame1_safe(f"A small kitchen. {verb}.") == "A small kitchen", verb


# ---------------------------------------------------------------- compiled: still vs motion

def test_still_and_edit_prompt_say_frame_1_the_motion_prompt_keeps_the_action():
    sc = _scene({"position": [-0.6, 1.45, -0.95], "target": [0.75, 1.3, 1.5], "focal_mm": 40},
                [{"frame": 0, "position": [0.6, 0, 1.95]}, {"frame": 14, "position": [0.6, 0, 1.95]},
                 {"frame": 90, "position": [0.9, 0, 0.7]}, {"frame": 120, "position": [0.9, 0, 0.7]}])
    out = compile_look({"description": S2, "camera_body": "arri_alexa_mini_lf", "lens": "cooke_s4"}, sc)
    for key in ("still_prompt", "edit_prompt"):
        assert "walks slowly" not in out[key] and "stops at its edge" not in out[key], key
        assert "looks down at the phone" not in out[key], key
    assert "has just turned away from the window" in out["still_prompt"]
    assert "walks slowly to the wooden table" in out["motion_prompt"], "the action is for the video"


def test_a_close_on_the_hands_is_an_insert_not_a_face_close_up():
    sc = _scene({"position": [1.45, 1.0, -0.25], "target": [1.08, 0.8, 0.5], "focal_mm": 85},
                [{"frame": 0, "position": [0.9, 0, 0.7]}], frames=97)
    f1 = S.frame1_facts(sc)
    assert f1["size"] == "INSERT"
    e = f1["people"][0]
    assert e["crop"] and "out of frame above" in e["crop"]
    still = compile_look({"description": SET + " Close on Jane's right hand resting on the edge of the table."},
                         sc)["still_prompt"]
    assert "insert close-up" in still and "close-up of the face" not in still and "head and shoulders," not in still
    assert "head and shoulders out of frame above" in still or "head out of frame above" in still


def test_a_face_in_frame_keeps_its_shot_size():
    sc = _scene({"position": [0.0, 1.55, -1.2], "target": [0.0, 1.55, 0.0], "focal_mm": 50},
                [{"frame": 0, "position": [0.0, 0, 0.0]}])
    f1 = S.frame1_facts(sc)
    assert f1["size"] != "INSERT" and not f1["people"][0]["crop"]
