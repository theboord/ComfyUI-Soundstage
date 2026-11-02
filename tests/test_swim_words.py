"""Swimmers in words (soundstage/look/swim.py): the regulator in the mouth, the kick, the bubbles, the surface strokes."""
import copy
import re

from soundstage.look import swim as SW
from soundstage.look.compile import compile_look
from soundstage.look.default_scene import DEFAULT_SCENE


def _scene(set_id, actors, frames=97):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": set_id, "weather": "none", "density": 0.5, "water_level": 1.5}
    s["shot"] = {"frames": frames, "fps": 24}
    s["actors"] = actors
    return s


def _diver(y=1.25, z1=2.4, **kw):
    return {"id": "diver", "name": "Diver", "kind": "man", "height_m": 1.8, "position": [2.2, y, 0],
            "keys": [{"frame": 0, "position": [2.2, y, 0]}, {"frame": 96, "position": [2.3, y, z1]}], **kw}


def test_a_reef_diver_has_the_regulator_in_his_mouth_in_both_prompts():
    out = compile_look({}, _scene("underwater", [_diver()]))
    still, motion, neg = out["still_prompt"], out["motion_prompt"], out["still_negative"]
    assert "regulator's mouthpiece held in his mouth" in still
    assert "hose looping over his right shoulder" in still and "fins" in still
    assert "regulator held in his mouth throughout" in motion
    assert "flutter kicks" in motion and "bubbles" in motion
    assert "regulator hanging below the chin" in neg
    sentence = SW.motion_sentence(_scene("underwater", [_diver()]))
    assert not re.search(r"\d", sentence), "LTX prompts carry no numbers"


def test_the_kick_follows_the_speed_and_the_actor():
    fast = SW.swimmers(_scene("underwater", [_diver(z1=4.8)]))[0]
    assert fast["style"] == "flutter" and fast["speed"] > 1
    assert "strong, quick" in SW.motion_sentence(_scene("underwater", [_diver(z1=4.8)]))
    assert "slow, steady" in SW.motion_sentence(_scene("underwater", [_diver(z1=1.6)]))
    assert SW.swimmers(_scene("underwater", [_diver(z1=0)]))[0]["style"] == "hover"
    assert "frog kicks" in SW.motion_sentence(_scene("underwater", [_diver(swim="frog")]))
    woman = _diver()
    woman["kind"] = "woman"
    assert "in her mouth" in SW.still_words(_scene("underwater", [woman]))


def test_a_freediver_holds_her_breath_and_a_seabed_walker_does_not_swim():
    fd = _diver(gear="freedive")
    assert "no bubbles" in SW.motion_sentence(_scene("underwater", [fd]))
    assert SW.negative_words(_scene("underwater", [fd])) == ""
    walker = _diver(y=0.3)
    assert SW.swimmers(_scene("underwater", [walker])) == []
    assert "regulator" not in compile_look({}, _scene("underwater", [walker]))["still_prompt"]


def test_surface_swimmers_in_open_water():
    s = {"id": "s", "name": "Swimmer", "kind": "woman", "position": [0, 0, 0],
         "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 96, "position": [0, 0, 4.4]}]}
    out = compile_look({}, _scene("open_water", [s]))
    assert "swims freestyle" in out["motion_prompt"] and "breathe" in out["motion_prompt"]
    assert "regulator" not in out["still_prompt"]
    slow = copy.deepcopy(s)
    slow["keys"][1]["position"] = [0, 0, 2.0]
    assert "breaststroke" in SW.motion_sentence(_scene("water_tank", [slow]))
    still = copy.deepcopy(s)
    still["keys"] = still["keys"][:1]
    assert "treads water" in SW.motion_sentence(_scene("open_water", [still]))
    assert SW.swimmers(_scene("plaza", [s])) == []
