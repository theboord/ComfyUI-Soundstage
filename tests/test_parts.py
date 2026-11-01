"""Milestone 26: Parts in the prompts (soundstage/look/objstate.py) and the Director's `part` tool (soundstage/agent/parts.py)."""
from soundstage.agent import director as D
from soundstage.agent import parts as PT
from soundstage.look import objstate as OS
from soundstage.look.compile import compile_look

COP = {"id": "cop", "name": "Police car", "kind": "police_car", "position": [0, 0, 0], "keys": [{"frame": 0, "position": [0, 0, 0]}],
       "rotation_deg": 0, "height_m": 1.6}


def _scene(*actors, lights=None):
    return {"actors": [dict(a) for a in actors], "shot": {"frames": 97, "fps": 24},
            "shots": [{"id": "shot_1", "name": "Master", "camera_keys": [{"frame": 0, "position": [6, 1.6, 6], "target": [0, 0.8, 0], "focal_mm": 35}]}],
            "active_shot": "shot_1", "lighting": {"lights": lights or []}, "environment": {"set": "street_night"}}


def test_state_words_match_the_browser():
    a = dict(COP, parts={"headlights": [{"frame": 0, "v": "low"}], "lightbar": [{"frame": 0, "v": "flash"}],
                         "door_fl": [{"frame": 0, "v": 0}, {"frame": 48, "v": 60}]})
    assert OS.state_words(a, 0) == ["headlights on", "red and blue roof lights flashing"]
    assert "the driver's door wide open" in OS.state_words(a, 96)
    assert OS.events(a, 96) == [{"frame": 0, "ch": "door_fl", "words": "the driver's door swings open"}]
    assert OS.state_words(dict(COP), 0) == []
    assert OS.state_words({"kind": "woman", "parts": {"expression": [{"frame": 0, "v": "smile"}]}}) == ["smiling"]
    assert OS.sample([{"frame": 0, "v": 0}, {"frame": 10, "v": 10, }], 5) == 5.0


def test_still_and_motion_prompts_say_the_visible_state_and_its_timing():
    a = dict(COP, parts={"headlights": [{"frame": 0, "v": "high"}], "door_fl": [{"frame": 0, "v": 0}, {"frame": 48, "v": 65}],
                         "lightbar": [{"frame": 0, "v": "off"}, {"frame": 24, "v": "flash", "i": "step"}]})
    sc = _scene(a)
    assert OS.still_words(sc) == "The police car has headlights on full beam."
    beats = OS.motion_beats(sc)
    assert "At 1.0 s the police car's red and blue roof lights start flashing." in beats
    out = compile_look({}, sc)
    assert "headlights on full beam" in out["still_prompt"]
    assert "At 1.0 s the police car's red and blue roof lights start flashing" in out["motion_prompt"]
    # Untouched objects add nothing.
    plain = compile_look({}, _scene(dict(COP)))
    assert "headlights" not in plain["motion_prompt"].split("Shot on")[0] or "headlights and grille" in plain["motion_prompt"]


def test_part_tool_is_typed_and_listed():
    spec = next(t for t in D.tool_specs() if t["name"] == "part")
    assert spec["kind"] == "app" and "door_fl" in spec["args"]["part"]["enum"] and "lightbar" in spec["args"]["part"]["enum"]
    assert '"part"' in D.DIRECTOR_SYSTEM or "part(" in D.DIRECTOR_SYSTEM or "part" in D.DIRECTOR_SYSTEM


def test_rules_open_the_drivers_door_at_2s_and_police_lights():
    sc = _scene(COP, {"id": "m", "name": "Mara", "kind": "woman", "position": [2, 0, 0]})
    r = D.plan("open the driver's door at 2 s", sc, {})
    assert [(c["tool"], c["args"]["part"], c["args"]["value"], c["args"]["at"], c["args"]["target_id"]) for c in r["calls"]] == \
        [("part", "door_fl", 65.0, 2.0, "cop")]
    assert "driver's door" in r["plan"][0] and "2 s" in r["plan"][0]
    r = D.plan("turn on the police lights", sc, {})
    assert [(c["args"]["part"], c["args"]["value"]) for c in r["calls"]] == [("lightbar", "flash")]
    r = D.plan("headlights on full beam, hazards on and wipers on", sc, {})
    assert {(c["args"]["part"], c["args"]["value"]) for c in r["calls"]} == {("headlights", "high"), ("indicator", "hazard"), ("wipers", "normal")}
    r = D.plan("Mara smiles at 3 seconds", sc, {})
    assert [(c["args"]["part"], c["args"]["value"], c["args"]["target_id"], c["args"]["at"]) for c in r["calls"]] == [("expression", "smile", "m", 3.0)]


def test_part_validation_defaults_and_refusals():
    import pytest
    work = D.normalize_scene(_scene({"id": "car", "name": "Red car", "kind": "car", "position": [0, 0, 0]}))
    with pytest.raises(D.Invalid, match="light bar"):
        D.validate_call({"tool": "part", "part": "lightbar", "value": "on"}, work, {})
    c = D.validate_call({"tool": "part", "part": "door_fr", "value": "open"}, work, {})
    assert (c["args"]["target_id"], c["args"]["value"]) == ("car", 65)
    with pytest.raises(D.Invalid, match="headlights setting"):
        D.validate_call({"tool": "part", "part": "headlights", "value": "purple"}, work, {})
    with pytest.raises(D.Invalid, match="no horse"):
        D.validate_call({"tool": "part", "part": "gait", "value": "trot"}, work, {})
    with pytest.raises(D.Invalid, match="no film light"):
        D.validate_call({"tool": "part", "part": "flicker", "value": "candle"}, work, {})
    lit = D.normalize_scene(_scene(lights=[{"id": "L1", "name": "Key 1", "type": "key"}, {"id": "L2", "name": "Practical 1", "type": "practical"}]))
    c = D.validate_call({"tool": "part", "part": "flicker", "value": "candle"}, lit, {})
    assert c["args"]["light_id"] == "L2", "an unnamed flicker goes on the practical"
    assert PT.normalize("tint", "70%") == (0.7, None)
    assert PT.normalize("hood", "open") == (70, None)
    assert PT.normalize("gait", "run") == ("gallop", None)
