"""Phone viewfinder (Milestone 20): the relay's new message types and the LAN bridge's locks. No ComfyUI needed.

Run:  python -m pytest tests/test_vcam_viewfinder.py -q
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage import vcam  # noqa: E402

_spec = importlib.util.spec_from_file_location("vcam_bridge", os.path.join(ROOT, "tools", "vcam_bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

TOKEN = "T0kenT0kenT0kenT0ken"


def test_vf_pose_carries_the_set_space_camera_and_lens():
    p = vcam.pose_payload({"type": "vf", "frame": 12.5, "recording": True, "view": "color",
                           "cam": {"position": [1, 2, 3], "target": [0, 1, 0], "focal_mm": 50, "focus_m": 2.5, "t_stop": 2.8, "roll": 0.1}}, "vf-1")
    assert p["type"] == "vf" and p["mode"] == "viewfinder" and p["recording"] is True and p["frame"] == 12.5
    assert p["cam"] == {"position": [1.0, 2.0, 3.0], "target": [0.0, 1.0, 0.0], "focal_mm": 50.0, "focus_m": 2.5, "t_stop": 2.8, "roll": 0.1}
    # out-of-range lens values are dropped, a broken camera drops the message
    p = vcam.pose_payload({"type": "vf", "cam": {"position": [0, 0, 0], "target": [0, 0, -1], "focal_mm": 35, "t_stop": 999, "focus_m": float("nan")}}, "d")
    assert "t_stop" not in p["cam"] and "focus_m" not in p["cam"]
    for bad in ({"type": "vf"}, {"type": "vf", "cam": {"position": [0, 0], "target": [0, 0, 0], "focal_mm": 35}},
                {"type": "vf", "cam": {"position": [0, 0, 0], "target": [0, 0, 0], "focal_mm": 2}}):
        assert vcam.pose_payload(bad, "d") is None


def test_vfstate_data_is_small_and_flat():
    p = vcam.pose_payload({"type": "vfstate", "event": "keep" * 20, "data": {"id": "20261031-120000_take_1", "bad key!": 1,
                                                                            "n": float("inf"), "deep": {"a": {"b": 1}}, "s": "x" * 500}}, "d")
    assert p["event"] == ("keep" * 20)[:24]
    assert p["data"] == {"id": "20261031-120000_take_1", "badkey": 1, "deep": {}, "s": "x" * 200}


def test_takes_keep_lens_channels_and_viewfinder_settings():
    s = vcam.clean_sample({"t": 1, "position": [0, 1, 2], "quaternion": [0, 0, 0, 1], "focal_mm": 50, "focus_m": 3.25, "t_stop": 4, "evil": 1})
    assert s == {"t": 1.0, "position": [0.0, 1.0, 2.0], "quaternion": [0.0, 0.0, 0.0, 1.0], "focal_mm": 50.0, "focus_m": 3.25, "t_stop": 4.0}
    st = vcam.clean_settings({"space": "set", "startFrame": 0, "fps": 24, "lastFrame": 96, "stabilize": 1, "horizonLock": 0, "space2": "x"})
    assert st == {"startFrame": 0.0, "lastFrame": 96.0, "fps": 24.0, "stabilize": True, "horizonLock": False, "space": "set"}
    assert "space" not in vcam.clean_settings({"space": "../etc"})
    take, err = vcam.build_take({"mode": "viewfinder", "settings": st, "samples": [
        {"t": 5 + i / 60, "position": [0, 1.6, -i * 0.01], "quaternion": [0, 0, 0, 1], "focus_m": 2, "t_stop": 2.8} for i in range(10)]})
    assert err is None and take["mode"] == "viewfinder" and take["samples"][0]["t"] == 0 and take["samples"][3]["focus_m"] == 2


def test_pairing_url_registration():
    vcam._pair.clear()
    assert vcam.pair_info() == {}
    assert vcam.set_pair("https://mac.local:8443/soundstage/vcam/viewfinder?vk=abc", now=1000)
    assert vcam.pair_info(now=1010)["url"].startswith("https://mac.local")
    assert vcam.pair_info(now=1000 + vcam.PAIR_TTL + 1) == {}, "a bridge that stopped re-registering expires"
    for bad in ("javascript:alert(1)", "https://x\"onload=1", "ftp://x", "", None, 5, "https://" + "a" * 500):
        assert not vcam.set_pair(bad)


def test_sync_is_cleaned():
    s = vcam.clean_sync({"frame": 12, "playing": True, "view": "clay", "take": {"id": "x", "status": "applied", "keys": 9}, "f": float("nan")})
    assert s == {"frame": 12, "playing": True, "view": "clay", "take": {"id": "x", "status": "applied", "keys": 9}}


# ---------------------------------------------------------------- the LAN bridge

def H(**kw):
    return [(k.replace("_", "-"), v) for k, v in kw.items()]


def test_bridge_pairs_once_then_needs_the_cookie():
    assert bridge.decide("GET", f"/soundstage/vcam/viewfinder?vk={TOKEN}", [], TOKEN) == ("pair", "/soundstage/vcam/viewfinder")
    assert bridge.decide("GET", f"/soundstage/vcam/viewfinder?a=1&vk={TOKEN}", [], TOKEN) == ("pair", "/soundstage/vcam/viewfinder?a=1")
    assert bridge.decide("GET", "/soundstage/vcam/viewfinder?vk=wrong", [], TOKEN)[0] == "deny"
    assert bridge.decide("GET", "/soundstage/vcam/viewfinder", [], TOKEN)[0] == "deny"
    assert bridge.decide("GET", "/soundstage/vcam/viewfinder", H(Cookie="ss_vk=nope"), TOKEN)[0] == "deny"
    assert bridge.decide("GET", "/soundstage/vcam/viewfinder", H(Cookie=f"a=1; ss_vk={TOKEN}"), TOKEN) == ("pass", None)


def test_bridge_allow_list_blocks_the_rest_of_comfyui_even_with_the_token():
    ok = H(Cookie=f"ss_vk={TOKEN}")
    for m, path in [("GET", "/soundstage/vcam/ws"), ("POST", "/soundstage/vcam/take"), ("GET", "/extensions/ComfyUI-Soundstage/stage/stage.mjs"),
                    ("GET", "/view?filename=a.glb&type=input"), ("GET", "/api/view?filename=a"), ("HEAD", "/soundstage/vcam/viewfinder"),
                    ("GET", "/soundstage/vcam/take?id=x")]:
        assert bridge.decide(m, path, ok, TOKEN) == ("pass", None), path
    for m, path in [("POST", "/prompt"), ("POST", "/api/prompt"), ("GET", "/queue"), ("POST", "/queue"), ("GET", "/api/userdata/workflows"),
                    ("POST", "/upload/image"), ("POST", "/soundstage/vcam/scene"), ("POST", "/soundstage/vcam/pair"), ("GET", "/"),
                    ("GET", "/extensions/OtherPack/x.js"), ("GET", "/extensions/ComfyUI-Soundstage/../../x"), ("DELETE", "/soundstage/vcam/take"),
                    ("GET", "http://evil/soundstage/vcam"), ("POST", "/soundstage/agent/apply"), ("GET", "/system_stats")]:
        assert bridge.decide(m, path, ok, TOKEN)[0] == "forbid", path


def test_bridge_rewrites_one_request_per_connection_and_keeps_the_cookie_to_itself():
    out, up = bridge.rewrite_head("GET", "/view?x", "HTTP/1.1", H(Host="mac.local:8443", Connection="keep-alive", Cookie=f"ss_vk={TOKEN}; other=1"))
    text = out.decode()
    assert not up and "Connection: close" in text and "keep-alive" not in text and TOKEN not in text and "other=1" in text
    assert text.endswith("\r\n\r\n") and "Host: mac.local:8443" in text, "Host passes through (ComfyUI's origin check)"
    out, up = bridge.rewrite_head("GET", "/soundstage/vcam/ws", "HTTP/1.1", H(Host="h", Connection="Upgrade", Upgrade="websocket", Cookie=f"ss_vk={TOKEN}"))
    assert up and "Connection: Upgrade" in out.decode() and "Cookie" not in out.decode()


def test_bridge_parses_heads_strictly():
    assert bridge.parse_head(b"GET /a HTTP/1.1\r\nHost: x\r\nCookie: a=b") == ("GET", "/a", "HTTP/1.1", [("Host", "x"), ("Cookie", "a=b")])
    assert bridge.parse_head(b"GET /a\r\n") is None
    assert bridge.parse_head(b"GET /a HTTP/2\r\n") is None
    assert bridge.parse_head(b"GET /a HTTP/1.1\r\nno-colon") is None
    assert bridge.cookie_token(H(Cookie="x=1; ss_vk=abc ; y=2")) == "abc"
