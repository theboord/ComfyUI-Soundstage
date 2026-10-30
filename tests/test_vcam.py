"""VCam relay helpers (soundstage/vcam.py): validation and take storage. No ComfyUI needed.

Run:  python -m pytest tests/test_vcam.py -q      (stabilizer tests: node --test tests/js/)
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage import vcam  # noqa: E402


def _samples(n=10):
    return [{"t": 100 + i / 60, "position": [i * 0.01, 1.6, 0], "quaternion": [0, 0, 0, 2]} for i in range(n)]


def test_pose_payload_validates_and_normalises():
    p = vcam.pose_payload({"type": "pose", "t": 1.5, "position": [1, 2, 3], "quaternion": [0, 0, 0, 2],
                           "mode": "ar", "recording": 1, "settings": {"strength": 3, "horizonLock": 1, "bogus": 9}}, "cam")
    assert p["type"] == "pose" and p["device"] == "cam" and p["recording"] is True
    assert p["quaternion"] == [0, 0, 0, 1.0]
    assert p["settings"] == {"strength": 1.0, "horizonLock": True}
    for bad in ({"type": "pose", "t": 0, "position": [1, 2], "quaternion": [0, 0, 0, 1]},
                {"type": "pose", "t": 0, "position": [1, 2, float("nan")], "quaternion": [0, 0, 0, 1]},
                {"type": "pose", "t": 0, "position": [1, 2, 3], "quaternion": [0, 0, 0, 0]},
                {"type": "exec", "cmd": "rm"}, "nope"):
        assert vcam.pose_payload(bad, "cam") is None
    s = vcam.pose_payload({"type": "state", "event": "record"}, "cam")
    assert s["event"] == "record"


def test_take_roundtrip(tmp_path):
    take, err = vcam.build_take({"name": "Dolly In / 1", "device": "../evil", "mode": "ar",
                                 "settings": {"strength": 0.7, "scale": 4}, "samples": _samples() + [{"t": "x"}]})
    assert err is None
    assert take["samples"][0]["t"] == 0 and math.isclose(take["duration"], 9 / 60, abs_tol=1e-4)
    assert take["device"] == "evil" and len(take["samples"]) == 10
    saved = vcam.save_take(take, base=str(tmp_path))
    assert vcam.TAKE_ID.match(saved["id"]) and saved["id"].endswith("_dolly_in_1")
    again = vcam.save_take(take, base=str(tmp_path))
    assert again["id"] != saved["id"] and vcam.TAKE_ID.match(again["id"])
    loaded = vcam.load_take(saved["id"], base=str(tmp_path))
    assert loaded["samples"] == take["samples"] and loaded["settings"] == {"strength": 0.7, "scale": 4.0}
    listed = vcam.list_takes(base=str(tmp_path))
    assert {t["id"] for t in listed} == {saved["id"], again["id"]} and listed[0]["samples"] == 10
    on_disk = os.listdir(os.path.join(str(tmp_path), "soundstage", "takes"))
    assert all(f.endswith(".json") for f in on_disk)
    json.loads(open(os.path.join(str(tmp_path), "soundstage", "takes", on_disk[0])).read())


def test_take_rejects_bad_input_and_traversal(tmp_path):
    assert vcam.build_take({"samples": []})[1]
    assert vcam.build_take({"samples": [{"t": 0, "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}]})[1]
    assert vcam.build_take([1, 2])[1]
    for tid in ("../../etc/passwd", "20261027-120000_../x", "", None, "20261027-120000_ok/../../x"):
        assert vcam.load_take(tid, base=str(tmp_path)) is None
