"""④ Frame's still prompt holds only what the shot camera sees at frame 0 (soundstage/look/compile.py compile_still,
scene.py traffic_lock and _facing_words, swim.py). The 2026-11-02 commercial renders: the car-pass still named the
police car that only enters at 1.7 s, the reef still gave an off-frame diver's kit, and a dancer turned three-quarter
read "facing the camera". Things that enter later stay in the motion prompt."""
import copy
import re

from soundstage.look import scene as S
from soundstage.look import swim as SW
from soundstage.look.compile import absent_words, compile_look, frame1_safe
from soundstage.look.default_scene import DEFAULT_SCENE

CAR_DESC = ("A city street at night in rain. A police sedan with its light bar flashing drives past from left to "
            "right, tyres throwing spray. The sidewalks are empty.")


def _scene(actors, camera, set_id="street_night", frames=121):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["environment"] = {"set": set_id, "weather": "none", "density": 0.5, "water_level": 1.5}
    s["shot"] = {"frames": frames, "fps": 24}
    s["camera"] = camera
    s.pop("camera_end", None)
    s["props"] = []
    s["actors"] = actors
    return s


def _car_pass():
    """The commercial's car pass: locked off on the sidewalk, the police car far up-street (out of frame) at frame 0."""
    car = {"id": "police_car", "name": "Police car", "kind": "police_car", "height_m": 1.6, "position": [2.2, 0, -16.8],
           "keys": [{"frame": 0, "position": [2.2, 0, -16.8]}, {"frame": 120, "position": [2.2, 0, 18.2]}]}
    cop = {"id": "cop", "name": "Officer", "kind": "man", "height_m": 1.8, "mount_id": "police_car", "seat": 0,
           "pose": "sit", "position": [2.2, 0, -16.8], "keys": [{"frame": 0, "position": [2.2, 0, -16.8]}]}
    return _scene([cop, car], {"position": [-5.2, 1.4, 6], "target": [6, 1.1, 0], "focal_mm": 35})


def test_a_car_off_screen_at_frame_0_is_out_of_the_still_and_in_the_motion():
    scene = _car_pass()
    f1 = S.frame1_facts(scene)
    assert not f1["others"] and not f1["people"], "the car is up the street, outside the frustum at frame 0"
    out = compile_look({"description": CAR_DESC}, scene)
    still, motion = out["still_prompt"].lower(), out["motion_prompt"].lower()
    assert "police" not in still and "sedan" not in still and "only vehicles" not in still
    assert "spray" not in still, "the description's sentence about the car goes whole"
    assert "rain" in still and "sidewalks are empty" in still, "the rest of the description stays"
    assert "empty road" in still
    assert "police car" in motion and "police sedan" in motion, "it still drives through in the video"


def test_a_car_in_frame_at_frame_0_is_still_named():
    scene = _car_pass()
    for a in scene["actors"]:
        a["keys"][0]["position"] = [2.2, 0, 2.0]
        a["position"] = [2.2, 0, 2.0]
    still = compile_look({"description": CAR_DESC}, scene)["still_prompt"]
    assert "the only vehicles are a police car" in still and "police sedan" in still


def test_frame1_safe_keeps_negations_of_absent_cast():
    text = "Open water. No people, no fish. A scuba diver swims across."
    assert frame1_safe(text, ["diver", "scuba"]) == "Open water, No people, no fish"
    assert frame1_safe(text) == "Open water, No people, no fish, A scuba diver swims across"


def test_a_diver_below_frame_at_frame_0_loses_his_kit_in_the_still_only():
    diver = {"id": "diver", "name": "Diver", "kind": "man", "height_m": 1.8, "swim": "flutter", "gear": "scuba",
             "position": [-0.5, 3.2, 5.0], "keys": [{"frame": 0, "position": [-0.5, 3.2, 5.0]},
                                                    {"frame": 120, "position": [3.5, 2.6, 6.0]}]}
    scene = _scene([diver], {"position": [-4, 9.0, -2], "target": [0, 10.0, 6], "focal_mm": 24}, set_id="underwater")
    assert "diver" in absent_words(scene, S.frame1_facts(scene))
    out = compile_look({}, scene)
    assert "regulator" not in out["still_prompt"] and "fins" not in out["still_prompt"]
    assert "regulator hanging" not in out["still_negative"]
    assert "regulator held in his mouth" in out["motion_prompt"]
    assert "regulator" in SW.still_words(scene), "without ids it still words every swimmer"


def _one(rotation_deg, mocap=None):
    """One woman at the origin, the camera 4 m down -Z looking at her (+Z). rotation 0 = facing +Z = away from us."""
    w = {"id": "w", "name": "Dancer", "kind": "woman", "height_m": 1.68, "position": [0, 0, 0], "rotation_deg": rotation_deg,
         "keys": [{"frame": 0, "position": [0, 0, 0]}]}
    if mocap:
        w["mocap"] = mocap
    return _scene([w], {"position": [0, 1.5, -4], "target": [0, 1.1, 0], "focal_mm": 35}, set_id="plaza")


def test_back_to_camera_reads_seen_from_behind():
    out = compile_look({}, _one(0))
    assert "seen from behind, with their back to the camera" in out["still_prompt"]
    assert "facing the camera" not in out["still_prompt"]
    assert "facing the camera, face toward the lens" in out["still_negative"]
    assert "seen from behind" in out["motion_prompt"]


def test_profile_and_three_quarter_and_front():
    assert "in profile, facing screen-" in compile_look({}, _one(90))["still_prompt"]
    assert "in profile, facing screen-" in compile_look({}, _one(-90))["still_prompt"]
    p_left, p_right = compile_look({}, _one(90))["still_prompt"], compile_look({}, _one(-90))["still_prompt"]
    assert ("screen-left" in p_left) != ("screen-left" in p_right), "the two profiles face opposite ways"
    assert "in three-quarter view, turned toward the camera" in compile_look({}, _one(130))["still_prompt"]
    assert "in three-quarter view from behind" in compile_look({}, _one(60))["still_prompt"]
    assert "a woman in the centre of frame, facing the camera" in compile_look({}, _one(180))["still_prompt"]


def test_a_mocap_clay_faces_the_way_its_world_track_turns_it_at_frame_0():
    # Video -> Stage: the clay is posed from mocap.world.yaw (web/stage/mocap.mjs place()), not rotation_deg.
    take = {"file": "x.json", "start": 0, "travel": True, "world": {"path": [[0, 0]] * 3, "yaw": [0.0, 10.0, 20.0]}}
    assert "seen from behind" in compile_look({}, _one(180, take))["still_prompt"]
    take["world"]["yaw"] = [90.0, 80.0, 70.0]
    assert "in profile" in compile_look({}, _one(180, take))["still_prompt"]


def test_a_man_behind_a_building_at_frame_0_is_not_in_the_still():
    man = {"id": "m", "name": "Man", "kind": "man", "height_m": 1.8, "position": [0, 0, 12],
           "keys": [{"frame": 0, "position": [0, 0, 12]}, {"frame": 120, "position": [8, 0, 12]}]}
    scene = _scene([man], {"position": [0, 1.6, -4], "target": [0, 1.4, 6], "focal_mm": 35}, set_id="plaza")
    assert S.frame1_facts(scene)["people"], "in the frustum with nothing in the way"
    scene["props"] = [{"id": "building", "kind": "building", "position": [0, 0, 6], "size": [12, 8, 4]}]
    assert not S.frame1_facts(scene)["people"], "the building hides him"
    assert not re.search(r"\ba man\b", compile_look({}, scene)["still_prompt"])
