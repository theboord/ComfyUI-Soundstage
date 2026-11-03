"""Practical-effects beats in the LTX prompt (soundstage/look/sfx.py): each fired cue is named at its time with what
it does on screen; rigs are never described as props; gore stays at film level; scenes without rigs are unchanged."""
import copy

from soundstage.look import sfx as SFX
from soundstage.look.compile import compile_look
from soundstage.look.default_scene import DEFAULT_SCENE


def rig(kind, rid, pos=(0, 0, 0), **sfx):
    return {"id": rid, "name": kind, "kind": f"sfx_{kind}", "position": list(pos), "keys": [{"frame": 0, "position": list(pos)}],
            "physics": {"mode": "off"}, "sfx": sfx}


def actor(aid, kind, pos):
    return {"id": aid, "name": aid, "kind": kind, "position": list(pos), "keys": [{"frame": 0, "position": list(pos)}]}


def scene(actors, fires, **rec):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["actors"] = actors
    s["physics"] = {"sfx": {"fires": fires, "burning": rec.get("burning", {}), "affected": rec.get("affected", []),
                            "scorch": [], "wounds": rec.get("wounds", [])}}
    return s


def test_explosion_beat_names_the_fireball_and_what_it_threw():
    s = scene([actor("car", "sports_car", (-2.4, 0, 0)), actor("crate", "crate", (2.2, 0, 0)), actor("man", "man", (0, 0, 4)),
               rig("explosion", "boom", power=2.2)],
              [{"id": "boom", "kind": "explosion", "frame": 36, "t": 1.5, "by": "time"}],
              affected=[{"id": "car", "by": "boom", "how": "flips"}, {"id": "crate", "by": "boom", "how": "thrown"},
                        {"id": "man", "by": "boom", "how": "knocked down"}])
    b = SFX.sfx_beats(s)
    assert b.startswith("At 1.5 s a huge fireball erupts")
    assert "lands on its roof" in b and "is thrown through the air" in b and "knocked off his feet" in b
    assert "column of thick black smoke" in b and "orange flash" in b
    m = compile_look({}, s)["motion_prompt"]
    assert "At 1.5 s a huge fireball erupts" in m
    # The rig is crew equipment, not a thing in the shot.
    assert "SFX" not in m and "sfx_" not in m and "mortar" not in m.lower()


def test_squibs_group_and_the_body_squib_reaction_follows_the_hit_and_the_stain_stays():
    s = scene([actor("man", "man", (0, 0, 0))] + [rig("squib", f"s{i}", (2 - i, 0, 1), surface="ground") for i in range(3)]
              + [rig("body_squib", "b", (0, 1.3, 0), target="man", point="chest", power=1)],
              [{"id": f"s{i}", "kind": "squib", "frame": 24 + 3 * i, "t": round((24 + 3 * i) / 24, 3), "by": "time"} for i in range(3)]
              + [{"id": "b", "kind": "body_squib", "frame": 36, "t": 1.5, "by": "chain:s2"}],
              wounds=[{"rig": "b", "target": "man", "point": "chest", "kind": "squib"}])
    b = SFX.sfx_beats(s)
    assert "From 1.0 s three bullet hits stitch across the ground, kicking up spurts of dirt." in b
    assert "At 1.5 s a squib bursts on the man's chest with a puff of torn shirt fabric and a spray of stage blood; he jolts back, clutches his chest and falls backwards to the ground." in b
    assert "stage-blood stain spreads across the man's shirt at the chest and stays for the rest of the shot" in b
    # Film level: stage blood and a squib, no gore words.
    for w in ("gore", "guts", "entrails", "gaping", "dismember", "decapitat", "brain"):
        assert w not in b.lower()


def test_reactions_by_hit_location():
    who = {"kind": "woman"}
    assert SFX._reaction("arm_l", 1, None, who) == "she flinches, grabbing her left arm"
    assert SFX._reaction("leg_r", 1, None, who) == "her right thigh buckles and she drops to one knee"
    assert SFX._reaction("chest", 0.5, None, who).endswith("and staggers")
    assert SFX._reaction("back", 1, None, who) == "she is thrown forward, arching and falls face down"


def test_stab_gag_and_other_cues():
    s = scene([actor("man", "man", (0, 0, 0))] + [rig("stab", "k", target="man", point="belly"), rig("smoke_bomb", "sm", (3, 0, 0), color="red"),
              rig("breakaway_glass", "g", (0, 0, 2)), rig("sparks", "sp", (0, 3, 0)), rig("fire", "f", (5, 0, 0)), rig("flare", "fl", (1, 0, 1))],
              [{"id": "f", "kind": "fire", "frame": 0, "t": 0, "by": "time"}, {"id": "fl", "kind": "flare", "frame": 6, "t": 0.25, "by": "time"},
               {"id": "sp", "kind": "sparks", "frame": 12, "t": 0.5, "by": "time"}, {"id": "k", "kind": "stab", "frame": 24, "t": 1, "by": "manual"},
               {"id": "g", "kind": "breakaway_glass", "frame": 30, "t": 1.25, "by": "contact"}, {"id": "sm", "kind": "smoke_bomb", "frame": 48, "t": 2, "by": "time"}])
    b = SFX.sfx_beats(s)
    assert b.index("From the start orange flames") < b.index("road flare") < b.index("shower of bright orange sparks") < b.index("stunt knife") < b.index("pane of glass shatters")
    assert "a retractable stunt knife strikes the man's stomach: a slash opens across his shirt with a thin line of stage blood; he doubles over" in b
    assert "At 2.0 s a smoke canister pours out a thick plume of red smoke" in b
    assert SFX.sfx_still_words(s) == "Orange flames burning with dark smoke rising."
    assert "Orange flames burning with dark smoke rising." in compile_look({}, s)["still_prompt"]


def test_burning_props_and_no_rigs_unchanged():
    s = scene([actor("c1", "crate", (0.6, 0, 0)), actor("c2", "crate", (1.3, 0, 0)), rig("fire", "f")],
              [{"id": "f", "kind": "fire", "frame": 12, "t": 0.5, "by": "time"}], burning={"c1": {"frame": 26, "by": "f"}, "c2": {"frame": 52, "by": "c1"}})
    b = SFX.sfx_beats(s)
    assert "At 1.1 s two " in b and "s one after another catch fire and burn with tall orange flames and black smoke." in b, b
    plain = copy.deepcopy(DEFAULT_SCENE)
    assert SFX.sfx_beats(plain) == "" and SFX.without_rigs(plain) is plain
    assert compile_look({}, plain) == compile_look({}, copy.deepcopy(DEFAULT_SCENE))
    # A disarmed / reset rig (no fires) adds nothing, and is still not described as a prop.
    s2 = scene([actor("man", "man", (0, 0, 0)), rig("explosion", "boom")], [])
    assert SFX.sfx_beats(s2) == ""
    s3 = scene([actor("man", "man", (0, 0, 0))], [])
    del s3["physics"]["sfx"]
    assert compile_look({}, s2)["motion_prompt"] == compile_look({}, s3)["motion_prompt"]
