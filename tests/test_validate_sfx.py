"""Blocker 7 (PR #26): validate_scene (SceneEdit node, /edit, /validate) keeps SFX rigs as rigs: their kind, settings,
height above the floor (sparks on a gantry, a squib on a wall) and place, and never turns them into placeholder props."""
from soundstage.agent.validate import validate_scene


def _rig(kind, rid, pos, **sfx):
    return {"id": rid, "name": rid, "kind": "sfx_" + kind, "position": list(pos), "keys": [{"frame": 0, "position": list(pos)}],
            "rotation_deg": 0, "sfx": {"kind": kind, "armed": True, "trigger": {"type": "time", "at": 1.0}, **sfx}}


def test_rigs_survive_validate_scene():
    scene = {"actors": [{"id": "man", "kind": "man", "position": [0, 0, 0]}, {"id": "crate", "kind": "crate", "position": [0.3, 0, 0]},
                        _rig("explosion", "boom", (0.2, 0, 0.1), power=1.5),
                        _rig("sparks", "sp", (1, 2.4, 0)),
                        _rig("squib", "sq", (2, 1.2, -2), surface="wall"),
                        _rig("body_squib", "bs", (0, 0, 0), target="man", point="chest"),
                        _rig("stab", "kn", (0, 0, 0), target="man", point="belly")]}
    out, notes = validate_scene(scene)
    by = {a["id"]: a for a in out["actors"]}
    assert not [n for n in notes if "placeholder" in n], notes
    for rid, kind in [("boom", "explosion"), ("sp", "sparks"), ("sq", "squib"), ("bs", "body_squib"), ("kn", "stab")]:
        a = by[rid]
        assert a["kind"] == "sfx_" + kind, a
        assert "recipe" not in a and "design" not in a, a
        assert a["sfx"]["kind"] == kind and a["sfx"]["trigger"]["at"] == 1.0
    assert by["sp"]["keys"][0]["position"] == [1, 2.4, 0], "the sparks stay up on their gantry"
    assert by["sq"]["keys"][0]["position"] == [2, 1.2, -2], "the squib stays on the wall"
    assert by["boom"]["keys"][0]["position"] == [0.2, 0, 0.1], "a rig is not pushed aside by placement (it takes no floor space)"
    assert by["bs"]["sfx"]["target"] == "man" and by["bs"]["sfx"]["point"] == "chest"
    assert by["boom"]["sfx"]["power"] == 1.5
