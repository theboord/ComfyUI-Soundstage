"""Movie car stunts in the prompts (Milestone 13): the still and motion prompts narrate reverse -> spin -> forward from
the same heading keys the stage plays, in the positive prompt, and never with words that pull toward a game render."""
import copy
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.look import scene as S  # noqa: E402
from soundstage.look import stunts as ST  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed (stunt keys come from stunts.mjs)")

FORBIDDEN = re.compile(r"\b(drift\w*|cgi|video[- ]?game|vfx|computer[- ]generated)\b", re.I)


def _keys(kind: str, start=(1.6, 0, -14), dir_deg=0, last=120) -> list[dict]:
    js = subprocess.run(["node", "-e", f"import('./web/stage/stunts.mjs').then(m=>console.log(JSON.stringify(m.stuntKeys("
                         f"{json.dumps(kind)},{{start:{json.dumps(list(start))},dirDeg:{dir_deg},last:{last}}}))))"],
                        cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert js.returncode == 0, js.stderr
    return json.loads(js.stdout)


def _chase():
    wf = json.loads((ROOT / "example_workflows/Soundstage_Car_Chase.json").read_text())
    st = next(json.loads(n["widgets_values"][0]) for n in wf["nodes"] if n["type"] == "SoundstageStage")
    lk = next(json.loads(n["widgets_values"][0]) for n in wf["nodes"] if n["type"] == "SoundstageLook")
    return st, lk


def _stunt_scene(kind: str):
    """Car Chase street, the sports car (driver inside) alone, camera A: 85 mm tripod pan from the sidewalk."""
    st, lk = _chase()
    st = copy.deepcopy(st)
    st["actors"] = [a for a in st["actors"] if a["id"] in ("sports_car", "getaway")]
    car = next(a for a in st["actors"] if a["id"] == "sports_car")
    car["keys"] = _keys(kind)
    car["stunt"] = kind
    car["position"] = car["keys"][0]["position"]
    next(a for a in st["actors"] if a["id"] == "getaway")["keys"] = [{"frame": 0, "position": car["position"]}]
    cam = [{"frame": 0, "position": [5.0, 1.2, 40], "target": [1.55, 0.9, -14], "focal_mm": 85},
           {"frame": 48, "position": [5.0, 1.2, 40], "target": [0.7, 0.9, 5.6], "focal_mm": 85},
           {"frame": 120, "position": [5.0, 1.2, 40], "target": [0.1, 0.9, 27], "focal_mm": 85}]
    st["shots"] = [{"id": "a", "name": "Stunt A", "setup": "wide", "rig": {"type": "tripod", "amount": 1}, "camera_keys": cam}]
    st["active_shot"] = "a"
    st["camera_keys"] = cam
    st["camera"] = cam[0]
    lk = dict(lk, description="A stunt driver's car on a city street at night")
    return st, lk, car


def test_stunt_yaw_follows_the_heading_keys_and_reverse_drive():
    car = {"keys": [{"frame": 0, "position": [0, 0, 0], "heading_deg": 180}, {"frame": 10, "position": [0, 0, 5], "heading_deg": 90},
                    {"frame": 20, "position": [0, 0, 10], "heading_deg": 0}]}
    assert ST.is_stunt(car)
    assert round(math_deg(S._yaw_at(car, 0, 20))) == 180
    assert round(math_deg(S._yaw_at(car, 5, 20))) == 135
    assert round(math_deg(S._yaw_at(car, 20, 20))) == 0
    assert ST.reversing_at(car, 0, 20, S._pos_at)
    rev = {"drive": "reverse", "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 20, "position": [0, 0, 10]}]}
    assert abs(abs(math_deg(S._yaw_at(rev, 10, 20))) - 180) < 1e-6
    plain = {"keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 20, "position": [0, 0, 10]}]}
    assert not ST.is_stunt(plain) and abs(S._yaw_at(plain, 10, 20)) < 1e-9
    assert ST.unwrap_deg(350, 10) == 370 and ST.unwrap_deg(10, 350) == -10


def math_deg(r):
    import math
    return math.degrees(r)


def test_reverse_jturn_beats_in_order():
    _, _, car = _stunt_scene("reverse_jturn")
    beats = [b["beat"] for b in ST.beats(car, 121, 24, S._pos_at)]
    assert beats == ["reverse", "spin", "forward"], beats
    spin = next(b for b in ST.beats(car, 121, 24, S._pos_at) if b["beat"] == "spin")
    assert 140 < spin["turn_deg"] < 200


def test_reverse_jturn_prompts_narrate_reverse_spin_forward():
    st, lk, _ = _stunt_scene("reverse_jturn")
    r = compile_look(lk, st)
    still, motion = r["still_prompt"], r["motion_prompt"]
    # The still: tail toward the long lens, reversing (the clay alone reads either way round).
    assert "rear end first toward the camera" in still and "reverse lights" in still
    assert "driving forward" not in still
    # The motion prompt, in order: backwards, the 180, then nose first.
    i = motion.index("races backwards toward the camera, rear end first")
    j = motion.index("slides around 180 degrees")
    k = motion.index("drives forward, nose first")
    assert i < j < k
    assert "tyre smoke" in motion and "rolling onto its outside tyres" in motion
    for text in (still, motion, r.get("negative_prompt") or "", r.get("motion_negative") or ""):
        assert not FORBIDDEN.search(text), FORBIDDEN.search(text).group(0)


def test_donut_and_handbrake_words():
    st, lk, _ = _stunt_scene("donut")
    m = compile_look(lk, st)["motion_prompt"]
    assert "on the spot" in m and "rear tyres" in m
    st, lk, car = _stunt_scene("handbrake_180")
    assert [b["beat"] for b in ST.beats(car, 121, 24, S._pos_at)][:2] == ["forward", "spin"]
    m = compile_look(lk, st)["motion_prompt"]
    assert "yanks the handbrake" in m and "slides round 180 degrees" in m
    assert not FORBIDDEN.search(m)


def test_ordinary_cars_unchanged():
    st, lk = _chase()
    for a in st["actors"]:
        assert not ST.is_stunt(a)
    r = compile_look(lk, st)
    assert "races backwards" not in r["motion_prompt"] and "reverse lights" not in r["still_prompt"]


def test_camera_car_pacing_the_stunt_reads_steady_and_ends_on_the_car():
    """Camera B: a bumper camera on a camera car in the next lane, keyed every 6 frames on the stunt car's path. Its
    braking and launching bunch the keys along the line: that is not handheld shake. With no people in frame, the
    move ends on the car, not on "the empty set" (which reads as the car leaving)."""
    st, lk, car = _stunt_scene("reverse_jturn")
    st["actors"] = [a for a in st["actors"] if a["id"] == "sports_car"]
    ks = sorted(car["keys"], key=lambda k: k["frame"])
    cam = [{"frame": k["frame"], "position": [-2.5, 0.5, k["position"][2] + 5], "target": [k["position"][0], 0.7, k["position"][2]],
            "focal_mm": 26} for k in ks]
    st["shots"][0].update(rig={"type": "free", "amount": 1}, camera_keys=cam)
    st["camera_keys"], st["camera"] = cam, cam[0]
    m = compile_look(lk, st)["motion_prompt"]
    cam_sentence = m[m.index("The camera"):].split(".")[0]
    assert "handheld" not in cam_sentence, cam_sentence
    assert "the empty set" not in m and "the sports car is" in cam_sentence, cam_sentence
    assert m.count("warm tungsten practical") <= 1, "the street's lamps are one phrase"
    # A real handheld wobble (sideways) still reads as handheld.
    shaky = [dict(c, position=[c["position"][0] + (0.08 if i % 2 else -0.08), c["position"][1], c["position"][2]]) for i, c in enumerate(cam)]
    st["shots"][0]["camera_keys"] = shaky
    st["camera_keys"], st["camera"] = shaky, shaky[0]
    assert "handheld" in compile_look(lk, st)["motion_prompt"]
