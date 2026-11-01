"""Timed material beats from the baked hits (Milestone 21).

Run:  python -m pytest tests/test_look_impacts.py -q
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.look import impacts as I  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402


def _scene(events, material=None, shake=None, overcrank=None):
    sc = copy.deepcopy(DEFAULT_SCENE)
    sc["environment"] = {"set": "street_night", "weather": "none"}
    sc["actors"] = [
        {"id": "car", "name": "Sports car", "kind": "sports_car", "position": [0, 0, -10], "keys": [{"frame": 0, "position": [0, 0, -10]}]},
        *[{"id": f"c{i}", "name": f"Crate {i}", "kind": "crate", "position": [i, 0, 0], "keys": [{"frame": 0, "position": [i, 0, 0]}],
           "physics": {"mode": "dynamic", "baked": True, **({"material": material} if material else {})}} for i in range(3)],
    ]
    sc["physics"] = {"events": events, **({"overcrank": overcrank} if overcrank else {})}
    if shake:
        sc["shots"] = [{"id": "s1", "name": "Wide", "camera_keys": sc.get("camera_keys") or [], "impact_shake": shake}]
        sc["active_shot"] = "s1"
    return sc


def ev(t, a, b, impulse, mat_a="wood", mat_b="metal"):
    return {"frame": round(t * 24), "t": t, "pos": [0, 0.4, 0], "normal": [0, 1, 0], "impulse": impulse, "speed": impulse / 25,
            "a": a, "b": b, "mat_a": mat_a, "mat_b": mat_b}


CRASH = [ev(1.2, "c0", "car", 360), ev(1.25, "c1", "car", 340), ev(1.9, "c1", "__ground", 170, "wood", "ground")]


def test_a_crash_gets_a_timed_material_beat_in_the_motion_prompt():
    text = compile_look(None, _scene(CRASH))["motion_prompt"]
    assert "At 1.2 s the sports car slams into the wooden crates" in text
    assert "splinter" in text and "dust" in text
    assert "At 1.9 s" in text and "onto the asphalt" in text
    assert "Heavy, weighty impacts" in text
    assert "Slow motion" not in text


def test_cardboard_crumples_and_the_material_words_stay_positive():
    text = I.impact_beats(_scene(CRASH, material="cardboard"))
    assert "cardboard boxes" in text and "crumple" in text and "seams split" in text
    neg = compile_look(None, _scene(CRASH, material="cardboard"))["still_negative"]
    assert "crumple" not in neg and "cardboard" not in neg


def test_no_events_means_the_prompt_is_unchanged():
    base = compile_look(None, _scene([]))["motion_prompt"]
    sc = _scene([])
    del sc["physics"]
    assert compile_look(None, sc)["motion_prompt"] == base
    assert "At " not in base.split("Static")[0] or "impacts" not in base
    assert "weighty impacts" not in base


def test_small_hits_make_no_beat_and_beats_are_capped_and_in_time_order():
    assert I.impact_beats(_scene([ev(1.0, "c0", "__ground", 30, "wood", "ground")])) == ""
    many = [ev(0.5 + i * 0.6, f"c{i % 3}", "__ground", 200 + i, "wood", "ground") for i in range(8)]
    text = I.impact_beats(_scene(many))
    assert text.count("At ") == I.MAX_BEATS
    times = [float(x.split(" s")[0]) for x in text.split("At ")[1:]]
    assert times == sorted(times)


def test_shake_and_overcrank_add_their_words():
    text = I.impact_beats(_scene(CRASH, shake="heavy", overcrank=2))
    assert "the camera jolts" in text
    assert "Slow motion" in text and "high-speed camera" in text
    assert "jolts" not in I.impact_beats(_scene(CRASH, shake="off"))
