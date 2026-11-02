"""Watercraft in the prompts: water, not a street; paddlers paddle; eyes on the water ahead (soundstage/look/boats.py)."""
from soundstage.look import boats as BT
from soundstage.look import scene as S
from soundstage.look.objstate import channels_for


def _scene(kind="speedboat", set_id="lake"):
    return {"environment": {"set": set_id, "sea_state": "calm_lake"}, "shot": {"frames": 121, "fps": 24},
            "actors": [{"id": "b", "kind": kind, "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 120, "position": [0, 0, 40]}]},
                       {"id": "p", "kind": "man", "mount_id": "b", "seat": 0, "keys": [{"frame": 0, "position": [0, 0, 0]}]}]}


def test_boats_get_the_water_not_a_deserted_street():
    lock = S.traffic_lock(_scene())
    assert "street" not in lock["still"] and "boats on the water" in lock["still"]
    assert "calm lake" in lock["still"] and "wake" in lock["motion"]


def test_verbs_and_riders():
    assert "plane" in BT.boat_verb("speedboat", 12) and "bow" in BT.boat_verb("speedboat", 5)
    assert "paddl" in BT.boat_verb("canoe", 1.5) and "oars" in BT.boat_verb("rowboat", 1)
    assert BT.ride_noun("a man", "canoe", "canoe") == "a man paddling a canoe"
    assert BT.ride_noun("a man", "speedboat", "speedboat", 0) == "a man at the wheel of a speedboat"
    assert "sailing" in BT.ride_noun("a woman", "dinghy", "sailing dinghy")


def test_sets_and_parts():
    assert "lake" in S.SET_PLACES["lake"][1] and "rapids" in S.SET_PLACES["river_rapids"][1]
    assert "motor_trim" in channels_for("speedboat") and "sheet" in channels_for("yacht") and "effort" in channels_for("canoe")
    assert S.seats()["canoe"][0][0] == "Bow paddler" and len(S.seats()["raft"]) == 6
