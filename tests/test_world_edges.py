"""World collisions in the Director, the edges (tests/test_world_director.py has the main paths): the plan's words for
things that aren't people ("ram the bench", not "ram Bench"), plural groups ("the 2 benches"), and the tools' guards
(a reroute round itself, a ram with no other vehicle, keep_keyed with no on/off)."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.agent import director as D  # noqa: E402

SCENE = {"actors": [
    {"id": "pc", "name": "Police car", "kind": "police_car", "position": [0, 0, -20]},
    {"id": "rc", "name": "Red car", "kind": "sports_car", "position": [0, 0, 0]},
    {"id": "tr", "name": "Truck", "kind": "truck", "position": [9, 0, 0]},
    {"id": "b1", "name": "Bench", "kind": "bench", "position": [0, 0, 8]},
    {"id": "b2", "name": "Bench 2", "kind": "bench", "position": [1, 0, 8]},
    {"id": "mara", "name": "Mara", "kind": "woman", "position": [5, 0, 0]},
], "shots": [{"id": "s1", "name": "Shot 1"}], "active_shot": "s1"}


def plan(cmd, scene=SCENE):
    p = D.plan(cmd, scene, {})
    return [(c["tool"], c["args"]) for c in p["calls"]], p["plan"]


def test_things_are_the_thing_people_are_their_names():
    # A one-word name of a thing ("Truck", "Bench") used to read as a person's name: "I'll have the truck ram Bench".
    (t, a), = plan("the truck slams into the bench")[0]
    assert (t, a["victim_id"]) == ("ram", "b1")
    assert plan("the truck slams into the bench")[1][0].startswith("I'll have the truck ram the bench:")
    assert plan("swerve the truck around Mara")[1] == ["I'll reroute the truck round Mara"]
    assert plan("keep the truck keyed")[1] == ["I'll keep the truck on its keys through contacts"]
    assert plan("let physics take over Mara")[1] == ["I'll let the physics take over Mara at its first hit"]
    assert plan("the police car hits Mara")[1][0].startswith("I'll have the police car ram Mara:")


def test_a_group_target_is_plural_english():
    (t, a), = plan("the police car rams the red car into the benches")[0]
    assert sorted(a["into_ids"]) == ["b1", "b2"] and a["into"] == "2 benches"
    assert "into the 2 benches:" in plan("the police car rams the red car into the benches")[1][0]


def test_the_tools_guards():
    work = D.normalize_scene(SCENE)
    with pytest.raises(D.Invalid, match="round what"):
        D.validate_call({"tool": "reroute", "args": {"target": "truck", "around": "truck"}}, work, {})
    lone = D.normalize_scene({**SCENE, "actors": [a for a in SCENE["actors"] if a["id"] in ("rc", "b1")]})
    with pytest.raises(D.Invalid, match="no other vehicle"):
        D.validate_call({"tool": "ram", "args": {"victim": "red car"}}, lone, {})
    c = D.validate_call({"tool": "keep_keyed", "args": {"target": "truck"}}, work, {})
    assert (c["args"]["target_id"], c["args"]["on"]) == ("tr", "on")
    # Rules that name one thing twice plan nothing rather than a ram of a car into itself.
    assert plan("crash the truck into the truck")[0] == []
    assert plan("reroute the truck around the truck")[0] == []
