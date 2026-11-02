"""Any set from a sentence (soundstage/agent/location.py): 20 varied places -> valid scenes at real size with no
overlaps; presets are starting points that a later "make it a 1950s diner at night" edits instead of replacing."""
import json
import math
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.agent import catalog as C  # noqa: E402
from soundstage.agent import core  # noqa: E402
from soundstage.agent import director as D  # noqa: E402
from soundstage.agent import location as LOC  # noqa: E402
from soundstage.agent import ops as O  # noqa: E402
from soundstage.agent import space as S  # noqa: E402
from soundstage.agent.validate import check_scene, validate_scene  # noqa: E402

# prompt -> (stage set, room [w, d] or None, a piece or library kind that must be there, or None)
PROMPTS = {
    "first date in a cramped 1950s diner at night": ("interior", None, "booth"),
    "a prisoner alone in a 6 by 4 metre prison cell": ("interior", [6, 4], "bunk bed"),
    "two commuters argue inside a city bus": ("interior", [2.5, 11], "bus seat"),
    "a knight kneels before the queen in a medieval throne room": ("interior", [14, 24], "throne"),
    "a detective alone in a 1920s speakeasy": ("interior", None, "bar counter"),
    "a nurse checks on a patient in a hospital room": ("interior", None, "hospital bed"),
    "a lawyer questions a witness in a courtroom": ("interior", None, "judge's bench"),
    "two friends talk in a 30 x 20 ft warehouse at night": ("interior", [9.14, 6.1], "crate"),
    "a scientist works in a futuristic lab": ("interior", None, "lab bench"),
    "a captain on the bridge of a starship": ("interior", None, "console"),
    "a mourner at a foggy graveyard at dusk": ("empty", None, "headstone"),
    "two hikers on a snowy mountain pass at dawn": ("desert", None, "rock"),
    "an astronaut walks across the surface of mars": ("desert", None, "rock"),
    "a farmer stands by his barn at sunset": ("empty", None, "barn"),
    "a couple at a campsite at night": ("forest", None, "tent"),
    "soldiers crouch in a muddy trench": ("empty", None, "sandbag wall"),
    "a teacher in an empty classroom": ("interior", None, "school desk"),
    "a boxer in a huge gym": ("interior", None, "boxing ring"),
    "a diver swims over a coral reef": ("underwater", None, None),
    "a woman in a tiny Victorian parlour with a 2.4 m ceiling": ("interior", None, "fireplace"),
}


@pytest.fixture(scope="module")
def built():
    return {t: core.describe(t) for t in PROMPTS}


def _names(scene):
    return {(a.get("design") or a.get("kind") or "").lower() for a in scene["actors"]}


@pytest.mark.parametrize("text", list(PROMPTS))
def test_any_set_is_valid_real_size_and_clean(built, text):
    res = built[text]
    s = res["scene"]
    want_set, want_room, must = PROMPTS[text]
    # Valid, on the floor, inside the set, no overlaps, cameras out of the walls; the validator has nothing to fix.
    assert check_scene(s) == [], check_scene(s)
    assert validate_scene(s)[1] == []
    json.dumps(s)
    env = s["environment"]
    assert env["set"] == want_set and env["set"] in C.SETS, env
    if want_room:
        assert env["room"][:2] == pytest.approx(want_room, abs=0.01)
    if env["set"] == "interior" and env.get("room"):
        w, d, h = env["room"]
        assert 1.6 <= w <= 60 and 1.6 <= d <= 80 and 2.0 <= h <= 12
        x0, x1, z0, z1 = S.set_def(C.set_key(env))["bounds"]
        assert x1 - x0 <= w and z1 - z0 <= d, "everything stands inside the room's walls"
    if must:
        assert must in _names(s), f"{must!r} missing from {sorted(_names(s))}"
    # Every piece has a real size; anything built from primitives says so in the notes.
    for a in s["actors"]:
        if a["kind"] == "custom":
            w, h, d = a["recipe"]["size_m"]
            assert 0.01 <= w <= 30 and 0.01 <= h <= 15 and 0.01 <= d <= 30, a["id"]
            assert all(p.get("color", "#").startswith("#") for p in a["recipe"]["parts"])
    if any(a.get("set_dressing") and (a.get("recipe") or {}).get("placeholder") for a in s["actors"]):
        assert any("simple shapes" in n for n in res["notes"]), res["notes"]
    # The place's colours ride on the environment for the Color pass.
    if (env.get("location") or {}).get("source") == "composed":
        assert all(re.fullmatch(r"#[0-9a-f]{6}", v) for v in env.get("look", {}).values())


def test_time_and_weather_come_from_the_words_or_the_place(built):
    assert built["first date in a cramped 1950s diner at night"]["scene"]["lighting"]["preset"] == "night"
    assert built["two hikers on a snowy mountain pass at dawn"]["scene"]["lighting"]["preset"] == "dawn"
    assert built["two hikers on a snowy mountain pass at dawn"]["scene"]["environment"]["weather"] == "snow"
    assert built["a mourner at a foggy graveyard at dusk"]["scene"]["environment"]["weather"] == "fog"
    # A diner has pendant lamps and neon; they're film lights on the stage.
    lights = built["first date in a cramped 1950s diner at night"]["scene"]["lighting"]["lights"]
    assert any(lt.get("from_location") and lt["type"] == "neon" for lt in lights)


def test_room_sizes_from_words():
    assert LOC.parse_room("a 6 by 4 metre cell")[0] == [6.0, 4.0]
    assert LOC.parse_room("a 30x20 ft warehouse")[0] == pytest.approx([9.14, 6.1], abs=0.01)
    assert LOC.parse_room("12 x 8 x 4 m")[1] == 4.0
    assert LOC.parse_room("a room with 3 m ceilings")[1] == 3.0
    big, small = LOC.compose("a huge gym"), LOC.compose("a tiny gym")
    assert big["room"][0] > LOC.compose("a gym")["room"][0] > small["room"][0]


def test_unknown_place_is_honest():
    loc = LOC.compose("a 5 by 3 m room")
    assert loc["known"] and loc["room"][:2] == [5.0, 3.0]
    assert not LOC.compose("make it bigger")["known"]
    # An outsize ask is clamped, and the notes say so.
    loc = LOC.compose("a 200 by 100 metre hall")
    assert loc["room"][0] <= 60 and any("asked for 200 x 100" in a for a in loc["approximations"])
    # An approximated vehicle interior or planet says what it really is.
    assert LOC.compose("inside a city bus")["approximations"]
    assert LOC.compose("the surface of mars")["approximations"]


def test_outside_a_place_is_an_exterior():
    s = core.describe("two cops question a cowboy on a horse outside a diner at magic hour")["scene"]
    assert s["environment"]["set"] != "interior"


# ---------------------------------------------------------------------------------------------- presets as starting points

def _preset_scene(set_name):
    """What 'Start from preset' gives you: a preset set, plus things you placed by hand."""
    mine = [
        {"id": "mara", "name": "Mara", "kind": "woman", "position": [0.4, 0, 0.6], "keys": [], "height_m": 1.68, "rotation_deg": 180},
        {"id": "my_crate", "name": "My crate", "kind": "crate", "position": [-0.6, 0, 3.0], "keys": [], "height_m": 0.8, "rotation_deg": 0},
    ]
    for a in mine:
        a["keys"] = [{"frame": 0, "position": list(a["position"])}]
    scene = {"environment": {"set": set_name, "weather": "none"}, "lighting": {"mode": "time", "preset": "midday", "hour": 12.5},
             "actors": mine, "shots": [{"id": "shot_1", "name": "Wide", "setup": "wide",
                                        "camera_keys": [{"frame": 0, "position": [0, 1.6, -6], "target": [0, 1.2, 0], "focal_mm": 35}]}],
             "active_shot": "shot_1"}
    return validate_scene(scene)[0]


@pytest.mark.parametrize("preset", ["train_car", "desert", "interior", "street_night", "underwater"])
def test_editing_a_preset_keeps_what_you_placed(preset):
    before = _preset_scene(preset)
    res = core.edit(before, "make it a 1950s diner at night")
    after = res["scene"]
    assert res["backend"] == "rules" and res["ops"]
    env = after["environment"]
    assert env["set"] == "interior" and env["room"] == [12.0, 9.0, 3.2]
    assert env["location"]["label"] == "1950s diner"
    assert after["lighting"]["preset"] == "night"
    ids = {a["id"] for a in after["actors"]}
    assert {"mara", "my_crate"} <= ids, "what you placed stays"
    assert "booth" in _names(after) and "counter" in _names(after)
    assert check_scene(after) == [], check_scene(after)
    # One undo step back to exactly the preset you started from.
    back = O.apply_ops(after, res["inverse"])
    assert back["environment"] == before["environment"]
    assert json.dumps(back["actors"], sort_keys=True) == json.dumps(before["actors"], sort_keys=True)


def test_changing_the_set_again_replaces_only_the_old_dressing():
    s = core.edit(_preset_scene("desert"), "make it a 1950s diner at night")["scene"]
    res = core.edit(s, "turn it into a medieval throne room")
    after = res["scene"]
    assert after["environment"]["room"] == [14.0, 24.0, 8.0]
    assert "booth" not in _names(after) and "throne" in _names(after)
    assert {"mara", "my_crate"} <= {a["id"] for a in after["actors"]}
    assert "Took down the old set dressing" in res["summary"]
    assert check_scene(after) == []


def test_era_only_restyles_the_current_place():
    s = core.edit(_preset_scene("desert"), "make it a diner")["scene"]
    after = core.edit(s, "make it 1920s")["scene"]
    assert after["environment"]["location"]["label"] == "1920s diner"
    assert after["environment"]["look"]["wall"] == LOC._c("#3d2b22")


def test_plain_edits_are_not_set_changes():
    s = _preset_scene("desert")
    for cmd in ("make it night", "make it rain", "move Mara near the crate", "make the crate bigger", "add a horse"):
        assert not any(o["op"] == "location" for o in O.rules_ops(cmd, s)), cmd
    assert O.rules_ops("set: a 6 by 4 m prison cell", s) == [{"op": "location", "describe": "a 6 by 4 m prison cell"}]
    assert O.rules_ops("set it in a hospital room", s)[0]["op"] == "location"


def test_picking_a_preset_clears_a_composed_room():
    s = core.edit(_preset_scene("desert"), "make it a 6 by 4 metre prison cell")["scene"]
    assert s["environment"]["room"][:2] == [6.0, 4.0]
    res = core.edit(s, "switch to the forest")
    assert res["scene"]["environment"]["set"] == "forest"
    assert "room" not in res["scene"]["environment"] and "look" not in res["scene"]["environment"]


# ---------------------------------------------------------------------------------------------- the Director

def test_director_builds_any_set():
    scene = _preset_scene("train_car")
    out = D.plan("make it a 1950s diner at night", scene, {})
    assert [c["tool"] for c in out["calls"]] == ["location"], out
    assert out["calls"][0]["ops"]
    # A model that names a place as a "set" gets a location built, not a refusal.
    llm = '{"calls":[{"tool":"set","set":"1950s diner"}]}'
    out = D.plan("make it a fifties diner", scene, {}, llm_text=llm)
    assert out["calls"] and out["calls"][0]["tool"] == "location", out
    assert "location" in D.TOOLS and set(D.TOOLS["set"]["args"]["set"][2]) == set(C.SETS)


# ---------------------------------------------------------------------------------------------- mirrors

def test_room_limits_match_the_stage():
    env = (ROOT / "web" / "stage" / "environments.mjs").read_text()
    m = re.search(r"return \[c\(room\[0\], ([\d.]+), ([\d.]+)\), c\(room\[1\], ([\d.]+), ([\d.]+)\), c\(room\[2\], ([\d.]+), ([\d.]+)\)\]", env)
    assert m, "roomSize() clamp not found"
    assert [float(x) for x in m.groups()] == [v for pair in C.ROOM_LIMITS for v in pair]
    for name in re.findall(r"^  (\w+): \{ label:", env.split("export const SETS = {")[1].split("};")[0], re.M):
        assert name in C.SETS, f"{name} is a stage set the agent doesn't know"
    assert "opts.look?.[role]" in env and "env.look?.floor" in (ROOT / "web" / "stage" / "setlook.mjs").read_text()
    assert "room: env.room, look: env.look" in (ROOT / "web" / "stage" / "stage.mjs").read_text()


def test_every_location_piece_fits_its_room():
    for spec in LOC.L:
        if spec["base"] != "room":
            continue
        w, d, _ = spec["room"]
        for p in spec["pieces"]:
            pw, ph, pd = p["size"]
            assert min(pw, pd) <= max(w, d) and ph <= max(spec["room"][2], 9), (spec["key"], p["name"])


def test_rooms_stay_out_of_the_preset_list():
    LOC.compose("a 6 by 4 metre prison cell")
    assert not any("@" in k for k in C.SETS)
    assert math.isclose(S.set_def(C.room_set([6, 4, 2.6]))["bounds"][1], 2.85)
