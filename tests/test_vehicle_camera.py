"""Ride-along cameras are described by where they sit on the vehicle, so the models don't invent the car in front."""
from soundstage.look import scene as S


def _scene(pos, target, kind="car"):
    return {"actors": [{"id": "v", "kind": kind, "keys": [{"frame": 0, "position": [0, 0, 0]}]}],
            "shots": [{"id": "s", "camera_follow": "v", "camera_keys": [{"frame": 0, "position": pos, "target": target, "focal_mm": 24}]}],
            "active_shot": "s"}


def test_driver_pov_avoids_a_car_ahead():
    v = S.vehicle_camera(_scene([0.37, 1.2, 0.38], [0.37, 1.02, 8]))
    assert "driver's seat" in v["still"] and "car directly ahead" in v["negative"]


def test_hood_cams():
    assert "looking back through the windshield" in S.vehicle_camera(_scene([0, 1.22, 2.45], [0, 1.05, 0]))["still"]
    fwd = S.vehicle_camera(_scene([0.2, 1.45, 2.2], [0, 1.0, 16], "police_car"))
    assert "hood-mounted" in fwd["still"] and fwd["negative"] == ""


def test_back_seat_and_side():
    assert "back seat" in S.vehicle_camera(_scene([0, 1.2, -1.15], [0, 1.05, 2]))["still"]
    assert "side view of the driver" in S.vehicle_camera(_scene([-0.38, 1.16, 0.42], [0.37, 1.1, -0.05]))["still"]


def test_outside_or_no_follow_is_none():
    assert S.vehicle_camera(_scene([3.2, 1.2, 0.2], [0, 1.0, 0.2])) is None        # tracking alongside
    sc = _scene([0, 1.2, 0], [0, 1, 5]); sc["shots"][0].pop("camera_follow")
    assert S.vehicle_camera(sc) is None


def test_looking_back_inside():
    assert "from the dashboard looking back" in S.vehicle_camera(_scene([0, 1.12, 0.78], [0, 1.1, -0.3]))["still"]
    assert "back seat" in S.vehicle_camera(_scene([0, 1.18, 0.15], [0, 1.0, -1.0]))["still"]
