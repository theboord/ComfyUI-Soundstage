"""World collisions in the Director (web/stage/world.mjs runs the physics; this is the words side): "the police car rams
the red car into the boxes" plans a ram, the consequence check and its one-click fixes (crash them / reroute) are
commands the rules understand, and loose props still get the old drive-through."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.agent import director as D  # noqa: E402

SCENE = {"actors": [
    {"id": "pc", "name": "Police car", "kind": "police_car", "position": [0, 0, -20]},
    {"id": "rc", "name": "Red car", "kind": "sports_car", "position": [0, 0, 0]},
    {"id": "b1", "name": "Box", "kind": "crate", "position": [0, 0, 8]},
    {"id": "b2", "name": "Box 2", "kind": "crate", "position": [1, 0, 8]},
    {"id": "mara", "name": "Mara", "kind": "woman", "position": [5, 0, 0]},
    {"id": "l1", "name": "Street lamp", "kind": "lamp", "position": [5, 0, 5]},
], "shots": [{"id": "s1", "name": "Shot 1"}], "active_shot": "s1"}


def calls(cmd):
    p = D.plan(cmd, SCENE, {})
    return [(c["tool"], c["args"]) for c in p["calls"]], p


def test_ram_into_the_boxes_is_one_ram_call_with_the_target():
    cs, p = calls("the police car rams the red car into the boxes")
    assert [t for t, _ in cs] == ["ram"]
    a = cs[0][1]
    assert (a["target_id"], a["victim_id"], sorted(a["into_ids"])) == ("pc", "rc", ["b1", "b2"])
    assert "momentum" in p["plan"][0] and p["plan"][0].startswith("I'll have the police car ram the red car into the")


def test_the_check_fixes_are_commands_the_rules_run():
    # world.mjs consequences() writes these as the one-click fixes.
    (t1, a1), = calls("crash the police car into the red car")[0]
    assert t1 == "ram" and (a1["target_id"], a1["victim_id"]) == ("pc", "rc")
    (t2, a2), = calls("reroute the police car around the red car")[0]
    assert t2 == "reroute" and (a2["target_id"], a2["around_id"]) == ("pc", "rc")
    (t3, a3), = calls("crash the police car into Mara")[0]
    assert t3 == "ram" and a3["victim_id"] == "mara"


def test_people_lamps_check_and_keep_keyed():
    assert calls("the red car hits Mara")[0][0][0] == "ram"
    assert calls("the police car crashes into the street lamp")[0][0][1]["victim_id"] == "l1"
    assert calls("check for collisions")[0] == [("check", {})]
    assert calls("does anything pass through anything?")[0][0][0] == "check"
    assert calls("keep the police car keyed")[0] == [("keep_keyed", {"target": "Police car", "target_id": "pc", "on": "on"})]
    assert calls("let physics take over the red car")[0][0][1]["on"] == "off"


def test_loose_props_keep_the_drive_through():
    cs, _ = calls("the police car crashes through the boxes")
    assert [t for t, _ in cs] == ["physics", "drive", "bake"]


def test_ram_tool_validation():
    work = D.normalize_scene(SCENE)
    c = D.validate_call({"tool": "ram", "args": {"victim": "red car"}}, work, {})
    assert c["args"]["target_id"] == "pc", "the other vehicle rams by default"
    try:
        D.validate_call({"tool": "ram", "args": {"target": "red car", "victim": "red car"}}, work, {})
        raise AssertionError("a car ramming itself must be rejected")
    except D.Invalid as e:
        assert "itself" in str(e)
    names = {t["name"] for t in D.tool_specs()}
    assert {"ram", "check", "reroute", "keep_keyed"} <= names
