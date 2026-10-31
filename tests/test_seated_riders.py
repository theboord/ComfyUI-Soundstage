"""People in cars and on horses: the compiler counts and places them where they sit, not at their raw keys.

Scenes come from the In-the-Car and Three-in-a-Car example workflows (the stage JSON in the SoundstageStage widget).
Each in-car shot is compiled two ways: as the Look panel sends it (stage.toJSON(): ride-along camera keys in the
car's own space) and as a render sends it (a captured world-space camera_track).
"""
import copy
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from soundstage.look import scene as S
from soundstage.look.compile import compile_look

ROOT = Path(__file__).resolve().parents[1]
PEOPLE_NEG = "people, person, figure"


def _stage(name: str) -> dict:
    wf = json.loads((ROOT / "example_workflows" / f"{name}.json").read_text())
    for n in wf["nodes"]:
        if n["type"] == "SoundstageStage":
            for v in n.get("widgets_values") or []:
                if isinstance(v, str) and v.strip().startswith("{"):
                    return json.loads(v)
    raise AssertionError(f"no stage scene in {name}")


def _world_track(scene: dict) -> list[dict]:
    """What stage.cameraTrack() captures: the ride-along camera carried through the car, every frame."""
    host = S.follow_host(scene)
    last = scene["shot"]["frames"] - 1
    k = S.camera_keys(scene)[0]
    out = []
    for f in range(last + 1):
        tw = S.local_to_world(host, f, last, camera=True)
        out.append({"frame": f, "position": list(tw(k["position"])), "target": list(tw(k["target"])), "focal_mm": k["focal_mm"]})
    return out


def _shot(name: str, shot_id: str, captured: bool = False) -> dict:
    s = copy.deepcopy(_stage(name))
    shot = next(x for x in s["shots"] if x["id"] == shot_id)
    s["active_shot"] = shot_id
    s["camera_keys"] = copy.deepcopy(shot["camera_keys"])
    if captured:
        s["camera_track"] = _world_track(s)
        s["shot_id"] = shot_id
    return s


both = pytest.mark.parametrize("captured", [False, True], ids=["panel", "render"])


@both
def test_windshield_two_shot_counts_the_two_people_inside(captured):
    r = compile_look({}, _shot("Soundstage_In_The_Car", "windshield", captured))
    assert r["frame1"]["people"] == 2
    still, neg, motion = r["still_prompt"], r["still_negative"], r["motion_prompt"]
    assert "exactly two people in frame" in still and "nobody else in the car" in still
    assert "a woman in the front passenger seat left of frame and a man at the wheel in the driver's seat right of frame" in still
    assert "both facing the camera" in still
    assert PEOPLE_NEG not in neg
    assert motion.startswith("Exterior medium shot from the hood of a driving car through a city street.")
    assert "Exterior wide" not in motion and "A car drives forward" not in motion and "drives forward toward the camera" not in motion
    assert "The camera stays locked to the car as it drives" in motion
    # The car the camera sits on is not a subject "in the centre of frame, headlights facing us".
    assert "headlights and grille facing us" not in still


@both
def test_back_seat_is_an_interior_and_sees_the_front_seats_from_behind(captured):
    r = compile_look({}, _shot("Soundstage_In_The_Car", "back", captured))
    assert r["frame1"]["people"] == 2
    assert r["motion_prompt"].startswith("Interior ") and "inside a driving car" in r["motion_prompt"]
    assert "both with their backs to the camera" in r["still_prompt"]
    assert "a man at the wheel in the driver's seat left of frame" in r["still_prompt"]
    assert PEOPLE_NEG not in r["still_negative"]


@both
def test_passenger_seat_on_the_driver_and_driver_pov(captured):
    side = compile_look({}, _shot("Soundstage_In_The_Car", "passenger", captured))
    assert side["frame1"]["people"] == 1 and "exactly one person in frame" in side["still_prompt"]
    assert "a man at the wheel in the driver's seat" in side["still_prompt"]
    pov = compile_look({}, _shot("Soundstage_In_The_Car", "pov", captured))
    assert pov["frame1"]["people"] == 0
    assert PEOPLE_NEG not in pov["still_negative"]      # the driver is the camera: never "no people" in his car
    assert pov["motion_prompt"].startswith("Interior ")


@both
def test_three_in_a_car_dash_and_back_seat(captured):
    dash = compile_look({}, _shot("Soundstage_Three_In_A_Car", "dash", captured))
    assert dash["frame1"]["people"] == 3 and "exactly three people in frame" in dash["still_prompt"]
    assert "the back-seat passenger in the back seat between them" in dash["still_prompt"]
    assert "all three facing the camera" in dash["still_prompt"]
    assert dash["motion_prompt"].startswith("Interior medium close-up inside a driving car")
    back = compile_look({}, _shot("Soundstage_Three_In_A_Car", "backsingle", captured))
    assert back["frame1"]["people"] == 1 and "exactly one person in frame" in back["still_prompt"]
    assert "the back-seat passenger facing the camera, the rear window behind him" in back["still_prompt"]
    ots = compile_look({}, _shot("Soundstage_Three_In_A_Car", "overshoulder", captured))
    assert ots["frame1"]["people"] == 2          # the back-seat man is beside the camera, not in front of it
    for r in (dash, back, ots):
        assert PEOPLE_NEG not in r["still_negative"] and "Exterior" not in r["motion_prompt"].split(".")[0]


def test_riders_sit_in_their_seats_in_world_space():
    s = _shot("Soundstage_Three_In_A_Car", "dash")
    car = S._by_id(s, "car")
    for rid, seat in (("driver", 0), ("front", 1), ("back", 3)):
        a = S._by_id(s, rid)
        pos, host = S.world_pos(s, a, 0)
        assert host is car
        _, local = S.seat_of(s, a)
        assert local == S.seats()["car"][seat][1]                    # height_m 1.45 = the library sedan: no scaling
        assert pos == pytest.approx((1.6 + local[0], local[1], -40 + local[2]))   # heading +Z at frame 0
        assert pos[2] != a["keys"][0]["position"][2] or local[2] == 0
    mid, _ = S.world_pos(s, S._by_id(s, "driver"), 60)
    assert mid == pytest.approx((1.6 + 0.37, 0.52, -8 + 0.05), abs=0.01)   # rides with the car (it turns a little at 60)


def test_exterior_car_keeps_its_driver_inside():
    """Seen from outside, the driver is part of the car: no head count (it summons pedestrians), but no 'no people'."""
    s = _shot("Soundstage_In_The_Car", "windshield")
    s["shots"][0].pop("camera_follow")
    s["camera_keys"] = [{"frame": 0, "position": [-6, 1.6, -30], "target": [1.6, 1, -40], "focal_mm": 35}]
    r = compile_look({}, s)
    assert r["frame1"]["people"] == 0
    assert "exactly" not in r["still_prompt"] and "no people in frame" not in r["still_prompt"]
    assert PEOPLE_NEG not in r["still_negative"]


def _riders(mount_at=None):
    rider = {"id": "r", "kind": "man", "keys": [{"frame": 0, "position": [0, 0, -40]}], "mount_id": "h", "pose": "ride"}
    if mount_at:
        rider.update(keys=[{"frame": 0, "position": [-2, 0, 2]}, {"frame": 20, "position": [-0.6, 0, 0]}], mount_at=mount_at)
    return {"shot": {"frames": 97, "fps": 24}, "environment": {"set": "desert"},
            "actors": [rider, {"id": "h", "kind": "horse", "height_m": 1.6, "rotation_deg": 180,
                               "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 96, "position": [0, 0, -40]}]}],
            "camera_keys": [{"frame": 0, "position": [0, 1.6, 9], "target": [0, 1.4, 0], "focal_mm": 35}]}


def test_a_mounted_rider_is_one_figure_on_horseback():
    r = compile_look({}, _riders())
    assert r["frame1"]["people"] == 1
    assert "a man on horseback in the centre of frame" in r["still_prompt"] and "exactly one person in frame" in r["still_prompt"]
    assert "a horse " not in r["still_prompt"]                     # the horse is in the rider's phrase, not a second subject
    assert "A man on horseback rides in the centre of frame" in r["motion_prompt"]
    assert "gallops away from the camera" in r["motion_prompt"] and "A horse" not in r["motion_prompt"]
    pos, _ = S.world_pos(_riders(), _riders()["actors"][0], 0)
    assert pos == pytest.approx((0, 1.56, 0.05))                   # MOUNTS.horse seat, the horse facing -Z


def test_timed_mount_walks_then_rides():
    sc = _riders(mount_at=24)
    assert S.world_pos(sc, sc["actors"][0], 10)[1] is None          # still on foot
    assert S.world_pos(sc, sc["actors"][0], 30)[1] is not None
    r = compile_look({}, sc)
    assert "walks to the horse, swings up into the saddle and gallops away from the camera" in r["motion_prompt"]
    assert PEOPLE_NEG not in r["still_negative"]


def test_western_riders_walk_in_and_mount_up():
    s = _stage("Soundstage_Western")
    s["active_shot"] = "shot_1"
    s["camera_keys"] = next(x for x in s["shots"] if x["id"] == "shot_1")["camera_keys"]
    r = compile_look({}, s)
    assert "walk to their horses, swing up into the saddles and gallop away from the camera" in r["motion_prompt"]
    assert "A horse and a horse" not in r["motion_prompt"]
    assert "the man on horseback and the woman on horseback" in r["motion_prompt"]
    assert PEOPLE_NEG not in r["still_negative"]                    # nobody in frame 1, but they walk into the shot


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_seats_and_mounts_match_the_stage_files():
    js = subprocess.run(["node", "-e", "Promise.all([import('./web/stage/library.mjs'), import('./web/stage/humans.mjs')]).then(([l, h]) =>"
                         " console.log(JSON.stringify({seats: l.SEATS, mounts: h.MOUNTS})))"],
                        cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert js.returncode == 0, js.stderr
    d = json.loads(js.stdout)
    assert {k: [(q["name"], tuple(q["pos"])) for q in v] for k, v in d["seats"].items()} == \
        {k: [(n, tuple(p)) for n, p in v] for k, v in S.seats().items()}
    assert {k: (v["pose"], tuple(v["seat"]), v.get("refHeight")) for k, v in d["mounts"].items()} == S.mounts()


def test_heading_follows_the_drive():
    car = {"id": "c", "kind": "car", "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 48, "position": [10, 0, 0]}]}
    assert S._yaw_at(car, 0, 96) == pytest.approx(math.pi / 2)
    assert S._yaw_at(car, 90, 96) == pytest.approx(math.pi / 2)    # parked at the end: keeps the way it came


def test_props_only_on_the_plaza_set():
    """The stage builds scene.props (the walk-in building, planters) on the plaza only: a desert prompt never gets them."""
    s = _stage("Soundstage_Western")
    s["active_shot"] = "shot_mvtzikwz"
    s["camera_keys"] = next(x for x in s["shots"] if x["id"] == "shot_mvtzikwz")["camera_keys"]
    assert s["environment"]["set"] == "desert" and s["props"]
    assert not S._props(s) and "building" not in compile_look({}, s)["still_prompt"]
    s["environment"]["set"] = "plaza"
    assert any(p["kind"] == "building" for p in S._props(s))


def test_a_car_keeping_pace_behind_a_ride_along_camera_has_no_move():
    s = _shot("Soundstage_In_The_Car", "windshield")
    s["actors"].append({"id": "cop", "kind": "police_car", "keys": [{"frame": 0, "position": [-1.8, 0, -54]},
                                                                    {"frame": 60, "position": [-1.8, 0, -20]},
                                                                    {"frame": 120, "position": [-2.2, 0, 16]}]})
    r = compile_look({}, s)
    assert "police car drives" not in r["motion_prompt"] and "the only other vehicle is a police car" in r["motion_prompt"]
