"""Camera edit (2026-11-02): the prompts say "aerial shot", never "drone"; old scenes and looks that say drone still work.

web/stage/camrig.mjs and web/presets/engine.mjs carry the browser side (tests/js/camera_edit.test.mjs)."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from soundstage.look import scene as S
from soundstage.look.compile import compile_look
from soundstage.look.vocab import normalize_look, option
from soundstage import presets_agent as PA
from soundstage.agent import director as D
from soundstage.agent import pitch as PT

ROOT = Path(__file__).resolve().parents[1]


def _scene(rig: str | None, pos=(6.0, 1.6, -6.0), tgt=(0.0, 1.2, 0.0)) -> dict:
    keys = [{"frame": 0, "position": list(pos), "target": list(tgt), "focal_mm": 24},
            {"frame": 96, "position": [pos[0] - 2, pos[1] + 2, pos[2] - 2], "target": list(tgt), "focal_mm": 24}]
    shot = {"id": "a", "name": "A", "camera_keys": keys}
    if rig:
        shot["rig"] = {"type": rig, "amount": 1, "seed": 3}
    return {"version": 2, "shot": {"frames": 97, "fps": 24}, "camera": keys[0], "camera_keys": keys, "shots": [shot], "active_shot": "a",
            "environment": {"set": "plaza", "weather": "none"}, "actors": [{"id": "w", "kind": "woman", "position": [0, 0, 0]}]}


def test_aerial_shot_words():
    assert S.aerial_shot(_scene("aerial")) == "aerial shot"
    assert S.aerial_shot(_scene("drone")) == "aerial shot"          # an older scene's rig name
    assert S.aerial_shot(_scene("aerial_fpv")) == "aerial FPV shot"
    assert S.aerial_shot(_scene("drone_fpv")) == "aerial FPV shot"
    assert S.aerial_shot(_scene(None)) is None                      # eye-level, no aerial rig
    assert S.aerial_shot(_scene("dolly", pos=(0.0, 14.0, -0.3), tgt=(0.0, 0.0, 0.0))) == "aerial top-down shot"   # high over the set
    assert S.aerial_shot(_scene("dolly", pos=(0.0, 12.0, -14.0))) == "aerial shot"


def test_prompts_say_aerial_shot_and_never_drone():
    for rig in ("aerial", "drone"):
        out = compile_look({}, _scene(rig))
        for k in ("still_prompt", "motion_prompt"):
            text = out.get(k) or ""
            assert "aerial shot" in text.lower(), (rig, k, text[:300])
            assert "drone" not in text.lower(), (rig, k)
    plain = compile_look({}, _scene(None))
    assert "aerial" not in (plain.get("still_prompt", "") + plain.get("motion_prompt", "")).lower()


def test_old_look_with_a_drone_camera_body_reads_as_aerial():
    look, notes = normalize_look({"camera_body": "drone"})
    assert look["camera_body"] == "aerial" and not notes
    body = option("camera_body", "aerial")
    assert body["label"] == "Aerial camera" and "drone" not in (body["still"] + body["motion"]).lower()
    styles = (ROOT / "web/look/style_presets.json").read_text(encoding="utf-8")
    assert "drone" not in styles.lower()
    assert styles == (ROOT / "soundstage/look/style_presets.json").read_text(encoding="utf-8")


def test_presets_catalog_aerial_and_alias():
    cat = PA.load_catalog()
    assert PA.validate_catalog(cat) == []
    for pid in ("aerial_up", "aerial_down", "aerial_across", "aerial_orbit", "aerial_follow", "rear_bumper_cam", "side_wheel_cam",
                "roof_cam", "chase_cam"):
        assert pid in cat["by_id"], pid
    assert "drone_reveal" not in cat["by_id"]
    for p in cat["presets"]:
        if p["tab"] == "camera":
            assert "drone" not in (p["label"] + p.get("summary", "")).lower(), p["id"]
    assert PA.PRESET_ALIASES["drone_reveal"] == "aerial_up"


def test_director_rigs_and_mounts():
    assert "aerial" in D.RIGS and "aerial_fpv" in D.RIGS and "drone" not in D.RIGS
    for v in ("rear_bumper", "trunk", "roof", "side_door", "front_wheel_low", "rear_wheel_low", "tyre", "chase"):
        assert v in D.CAM_VIEWS, v
    js = (ROOT / "web/agent/director.mjs").read_text(encoding="utf-8")
    for v, mount in D.CAM_VIEWS.items():
        if mount:
            assert f"{v}: \"{mount}\"" in js, v   # the browser runs the same mount
    mounts = (ROOT / "web/stage/carmounts.mjs").read_text(encoding="utf-8") + (ROOT / "web/stage/stage.mjs").read_text(encoding="utf-8")
    for mount in filter(None, D.CAM_VIEWS.values()):
        assert f"  {mount}: {{" in mounts, mount


def test_pitch_says_aerial():
    d = PT.parse_llm_delta('{"camera":{"rig":"drone"}}')
    assert d.get("camera", {}).get("rig") == "aerial"
    src = (ROOT / "soundstage/agent/pitch.py").read_text(encoding="utf-8")
    assert '"steadicam", "aerial", "dolly"' in src and '"steadicam", "drone"' not in src   # the model is asked for aerial


def _ride(view: str | None, pos, tgt) -> dict:
    sc = _scene(None)
    car = {"id": "car", "kind": "sports_car", "position": [0, 0, -10], "keys": [{"frame": 0, "position": [0, 0, -10]}, {"frame": 96, "position": [0, 0, 20]}]}
    sc["actors"] = [car]
    keys = [{"frame": 0, "position": list(pos), "target": list(tgt), "focal_mm": 18}]
    sh = sc["shots"][0]
    sh.update({"camera_follow": "car", "camera_keys": keys})
    if view:
        sh["camera_mount"] = {"view": view, "sprung": True}
    sc["camera_keys"] = keys
    return sc


def test_outside_mounts_are_described_as_outside_not_as_a_seat():
    # The numbers are mountKey("...", sports_car) from web/stage/carmounts.mjs.
    cases = {"rear_bumper": ([0, 0.4, -2.5], [0, 0.4, -14.25], "rear bumper"),
             "trunk": ([0, 1.304, -2.025], [0, 1.035, 14.25], "trunk"),
             "roof": ([0, 1.63, -0.113], [0, 1.173, 14.25], "roof"),
             "side_door": ([1.21, 0.938, -0.113], [1.03, 0.759, 10.25], "left side door"),
             "side_rear_wheel": ([1.28, 0.3, -2.19], [0.83, 0.4, 2.25], "rear wheel"),
             "side_front_wheel": ([-1.28, 0.3, 0.59], [-0.88, 0.28, 8.25], "right flank"),
             "hood_forward": ([0, 1.077, 1.395], [0, 0.828, 12.25], "hood")}
    for view, (pos, tgt, word) in cases.items():
        v = S.vehicle_camera(_ride(view, pos, tgt))
        assert v and v["framing"] == view and v["where"] != "interior", (view, v and v["framing"])
        assert word in v["still"] and "inside" not in v["still"], (view, v["still"])
        out = compile_look({}, _ride(view, pos, tgt))
        assert word in out["still_prompt"], view
        assert "Interior" not in out["motion_prompt"][:80], (view, out["motion_prompt"][:120])
    # Without a mount (an older scene) the same rear-bumper position still reads the old way: nothing changes for it.
    assert S.vehicle_camera(_ride(None, [0, 0.4, -2.5], [0, 0.4, -14.25]))["framing"] == "back_seat_single"
    # The side mounts see the car's flank: the car look words may be used.
    assert S.look_view(_ride("side_rear_wheel", *cases["side_rear_wheel"][:2]), {"car"}) == "car"
    assert S.look_view(_ride("roof", *cases["roof"][:2]), {"car"}) == "nocar"
