"""LOOK compiler's reading of the stage scene: frame-1 facts, camera-move words, actor marks, formats."""
import copy
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.look import scene as S  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402


def _scene(**over):
    s = copy.deepcopy(DEFAULT_SCENE)
    s.update(over)
    return s


def _cams(p0, t0, p1, t1, f0=35, f1=35):
    return {"camera": {"position": p0, "target": t0, "focal_mm": f0},
            "camera_end": {"position": p1, "target": t1, "focal_mm": f1}}


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_default_scene_matches_stage_mjs():
    js = subprocess.run(["node", "-e", "import('./web/stage/stage.mjs').then(m=>console.log(JSON.stringify(m.DEFAULT_SCENE)))"],
                        cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert js.returncode == 0, js.stderr
    assert json.loads(js.stdout) == json.loads(json.dumps(DEFAULT_SCENE))


def test_library_read_from_stage_files():
    lib = S.library()
    assert lib["man"][2] == "biped" and lib["dog"][2] == "quadruped" and lib["tree"][2] == "static"


def test_default_scene_frame1():
    f1 = S.frame1_facts(DEFAULT_SCENE)
    assert len(f1["people"]) == 2 and f1["size"] == "WS" and f1["angle"] == "eye"
    assert f1["location"]["place"] == "a city plaza" and f1["location"]["int_ext"] == "EXT"
    phrase = S.group_phrase(f1["people"], f1["camera"])
    assert phrase == ["a woman and a man side by side left of frame, full figures in the middle distance, "
                      "empty ground in the foreground, with their backs to the camera"]
    assert any(p["kind"] == "building" for p in f1["props"])


def test_default_scene_motion():
    mf = S.motion_facts(DEFAULT_SCENE)
    parts = dict(mf["move"]["parts"])
    assert "dolly_in" in parts and parts["truck"] == "right" and parts["pan"] == "right"
    marks = mf["marks"]
    assert len(marks) == 2 and all(m["way"] == "away from the camera" for m in marks)
    assert all(m["dest"] == "into the building through the doorway" for m in marks)
    assert mf["end"]["people"] == []        # inside the building, hidden by its walls


def test_new_keyframe_format_equals_start_end():
    """camera_keys + per-object keys (stage v2 multi-keyframes) read the same as camera/camera_end."""
    s = _scene()
    s["camera_keys"] = [{"frame": 0, **s.pop("camera")}, {"frame": 48, "position": [-5, 1.7, -8], "target": [0, 1.3, 3],
                                                           "focal_mm": 35}, {"frame": 96, **s.pop("camera_end")}]
    for a in s["actors"]:
        a["keys"] = [{"frame": 0, "position": a.pop("position")}, {"frame": 96, "position": a.pop("position_end")}]
    a, b = compile_look({"lens": "anamorphic"}, s), compile_look({"lens": "anamorphic"}, DEFAULT_SCENE)
    assert a["still_prompt"] == b["still_prompt"]
    assert "follows behind them" in a["motion_prompt"]


def test_camera_track_takes_precedence():
    s = _scene()
    s["camera_track"] = [{"frame": f, "position": [0, 1.6, -10 + 0.05 * f], "target": [0, 1.4, 0], "focal_mm": 50}
                         for f in range(97)]
    mv = S.camera_move(s)
    assert dict(mv["parts"]) == {"dolly_in": ""} and mv["start"]["focal_mm"] == 50


@pytest.mark.parametrize("cams,expect", [
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -10], [0, 1.4, 0]), []),
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -14], [0, 1.4, 0]), [("dolly_out", "")]),
    (_cams([0, 1.6, -10], [0, 1.4, 0], [-3, 1.6, -10], [-3, 1.4, 0]), [("truck", "right")]),   # -X = screen-right
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 4.0, -10], [0, 3.8, 0]), [("crane", "up")]),
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -10], [5, 1.4, 0]), [("pan", "left")]),        # +X = screen-left
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -10], [0, 4.0, 0]), [("tilt", "up")]),
    (_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -10], [0, 1.4, 0], 35, 70), [("zoom", "in")]),
    (_cams([0, 1.6, -10], [0, 1.4, 0], [-7.07, 1.6, -7.07], [0, 1.4, 0]), [("arc", "right")]),
])
def test_camera_move_words(cams, expect):
    mv = S.camera_move(_scene(**cams))
    assert mv["parts"] == expect
    assert mv["static"] == (not expect)


def test_static_camera_and_walk_toward_camera():
    s = _scene(**_cams([0, 1.6, -10], [0, 1.4, 0], [0, 1.6, -10], [0, 1.4, 0]))
    s["actors"] = [{"id": "a", "kind": "man", "position": [0, 0, 6], "position_end": [0, 0, 1], "height_m": 1.8}]
    r = compile_look({}, s)
    assert "Static frame, the camera locked off" in r["motion_prompt"]
    assert "walks toward the camera" in r["motion_prompt"]
    assert "facing the camera" in r["still_prompt"] and "exactly one person in frame" in r["still_prompt"]


def test_empty_set_and_off_screen_actor():
    s = _scene(actors=[{"id": "a", "kind": "woman", "position": [0, 0, -30], "height_m": 1.7}])  # behind the camera
    r = compile_look({}, s)
    assert "no people in frame" in r["still_prompt"]
    assert "people, person, figure" in r["still_negative"]


def test_animals_vehicles_and_static_objects():
    s = _scene(actors=[
        {"id": "d", "kind": "dog", "position": [0, 0, -6], "position_end": [0, 0, 4], "height_m": 0.6},
        {"id": "t", "kind": "tree", "position": [-4, 0, 2], "height_m": 6.5},
        {"id": "m", "kind": "man", "position": [0.8, 0, -6], "height_m": 1.8, "rotation_deg": 180},
    ])
    f1 = S.frame1_facts(s)
    assert [e["noun"] for e in f1["people"]] == ["a man"] and [e["noun"] for e in f1["others"]] == ["a dog"]
    assert any(p["word"] == "a tree" for p in S._props(s))
    r = compile_look({}, s)
    assert "exactly one person in frame" in r["still_prompt"]
    assert "a dog" in r["motion_prompt"] and "trots" in r["motion_prompt"]


def test_interior_underwater_weather_and_lighting_prompt():
    s = _scene(environment={"set": "interior", "weather": "smoke"}, lighting_prompt="warm tungsten practical, soft")
    r = compile_look({}, s)
    assert r["motion_prompt"].startswith("Interior wide shot in an interior room.")
    assert "drifting smoke" in r["still_prompt"] and "warm tungsten practical" in r["still_prompt"]
    w = _scene(environment={"set": "water_tank", "water_level": 2.5})
    assert "underwater" in compile_look({}, w)["still_prompt"]


def test_lighting_fallback_side():
    """Sun at camera screen-right: the default camera looks toward +X+Z, so its screen-right is toward -X."""
    s = _scene(sun={"azimuth_deg": 270 - 35, "elevation_deg": 40})  # roughly perpendicular to the view, toward -X
    cam = S.frame1_facts(s)["camera"]
    words = S.lighting_words(s, cam)
    assert "bright daylight" in words


def test_high_and_low_angles():
    hi = _scene(**_cams([0, 8, -8], [0, 0.5, 0], [0, 8, -8], [0, 0.5, 0]))
    lo = _scene(**_cams([0, 0.3, -4], [0, 1.8, 0], [0, 0.3, -4], [0, 1.8, 0]))
    assert S.frame1_facts(hi)["angle"] == "high" and "high angle" in compile_look({}, hi)["still_prompt"]
    assert S.frame1_facts(lo)["angle"] in ("low", "worms_eye")


def test_identical_nouns_are_counted():
    from soundstage.look.scene import _group_nouns
    assert _group_nouns(["a man", "a man"]) == "two men"
    assert _group_nouns(["a woman", "a woman", "a woman"]) == "three women"
    assert _group_nouns(["a man", "a woman"]) == "a man and a woman"


# red_car_backwards: the 10-29 chase take's look still showed the sports car's FRONT on the chase cam, and LTX moved
# that front-facing car away along the clay path (it read as reversing). Depth looks the same either way round, so the
# still and motion prompts must say which end of the car faces the camera on every Car Chase shot.
_FACING = {
    "chase": "seen from behind, rear bumper and red tail lights toward the camera",
    "tracking": "front toward the camera, headlights and grille facing us",
    "crane": "front toward the camera, headlights and grille facing us",
}


def test_car_chase_vehicle_facing():
    wf = json.loads((ROOT / "example_workflows/Soundstage_Car_Chase.json").read_text())
    st = next(json.loads(n["widgets_values"][0]) for n in wf["nodes"] if n["type"] == "SoundstageStage")
    lk = next(json.loads(n["widgets_values"][0]) for n in wf["nodes"] if n["type"] == "SoundstageLook")
    assert {s["id"] for s in st["shots"]} == set(_FACING)
    for shot in st["shots"]:
        s = copy.deepcopy(st)
        s["active_shot"] = shot["id"]
        s.update({k: v for k, v in shot.items() if k not in ("id", "name")})
        r = compile_look(lk, s)
        for which in ("still_prompt", "motion_prompt"):
            assert _FACING[shot["id"]] in r[which], (shot["id"], which)
        # the seated getaway driver is never staged as a pedestrian beside the car (take 28 grew a walking man)
        assert "a man and a sports car" not in r["motion_prompt"].lower(), shot["id"]
