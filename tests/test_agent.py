"""Scene agent: 6 sample prompts -> valid, sensible scenes with coverage; 6+ chat edits -> undoable ops;
LLM-answer parsing/repair; the validator; JS/Python op parity fixture; mirrored constants."""
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
from soundstage.agent import ops as O  # noqa: E402
from soundstage.agent import plan as P  # noqa: E402
from soundstage.agent import prompts as PR  # noqa: E402
from soundstage.agent.validate import check_scene, validate_scene  # noqa: E402

PROMPTS = {
    "western": "two gunfighters face off at noon on a dusty western street",
    "office": "rainy night, detective alone in his office",
    "diner": "first date in a 50s diner",
    "tank": "underwater rescue in a tank",
    "rooftop": "chase across a rooftop at magic hour",
    "sitcom": "sitcom living room, three friends on a couch",
}
FIXTURE = ROOT / "tests" / "agent_fixtures" / "ops_parity.json"


def people(scene):
    return [a for a in scene["actors"] if a["kind"] in C.PEOPLE]


def by_name(scene, word):
    return next(a for a in scene["actors"] if word in a["name"].lower() or word in a.get("design", "") or a["kind"] == word)


@pytest.fixture(scope="module")
def built():
    return {k: core.describe(v) for k, v in PROMPTS.items()}


# ---------------------------------------------------------------------------------------------- build

@pytest.mark.parametrize("key", list(PROMPTS))
def test_build_schema_valid_and_clean(built, key):
    res = built[key]
    scene = res["scene"]
    assert check_scene(scene) == [], check_scene(scene)
    again, notes = validate_scene(scene)
    assert notes == [], f"validator still repairs a built scene: {notes}"
    for field in ("version", "shot", "camera", "camera_end", "sun", "environment", "lighting", "actors", "props",
                  "shots", "active_shot", "camera_keys"):
        assert field in scene
    assert scene["environment"]["set"] in C.SETS
    assert scene["lighting"]["preset"] in C.TIME_PRESETS and scene["lighting"]["mode"] == "time"
    assert 1 <= len(scene["shots"]) <= 4, "coverage: 1-4 camera setups"
    for sh in scene["shots"]:
        assert sh["setup"] in C.SETUPS
        for k in sh["camera_keys"]:
            assert 12 <= k["focal_mm"] <= 300
            assert math.dist(k["position"], k["target"]) > 0.3
    ids = [a["id"] for a in scene["actors"]]
    assert len(ids) == len(set(ids))
    json.dumps(scene)  # serialisable


def test_western(built):
    s = built["western"]["scene"]
    assert s["environment"]["set"] == "street_night" and s["lighting"]["preset"] == "midday"
    assert s["environment"]["weather"] == "dust"
    a, b = people(s)
    assert a["kind"] == b["kind"] == "man"
    assert abs(a["position"][0] - b["position"][0]) >= 8, "a face-off needs distance"
    # They face each other.
    assert abs(((a["rotation_deg"] - b["rotation_deg"]) % 360) - 180) < 1
    assert not any(x["kind"] == "car" for x in s["actors"]), "no parked cars on a western street"
    assert any(sh["setup"] == "wide" for sh in s["shots"])


def test_office(built):
    s = built["office"]["scene"]
    assert s["environment"] == {**s["environment"], "set": "interior", "weather": "rain"}
    assert s["lighting"]["preset"] == "night"
    assert len(people(s)) == 1 and people(s)[0]["kind"] == "man"
    desk = next(a for a in s["actors"] if a["kind"] == "table")
    det = people(s)[0]
    assert math.dist(desk["position"], det["position"]) < 1.2, "the detective is at his desk"
    types = {lt["type"] for lt in s["lighting"]["lights"]}
    assert {"practical", "key"} <= types
    key = next(lt for lt in s["lighting"]["lights"] if lt["type"] == "key")
    assert key["kelvin"] >= 6000, "night key reads as cool moonlight"
    for lt in s["lighting"]["lights"]:  # inside the room
        assert -3.8 <= lt["position"][0] <= 3.8 and lt["position"][2] <= 4.8


def test_diner(built):
    s = built["diner"]["scene"]
    assert s["environment"]["set"] == "interior"
    him, her = people(s)
    assert {him["kind"], her["kind"]} == {"man", "woman"}
    table = next(a for a in s["actors"] if a["kind"] == "table")
    mid = [(him["position"][i] + her["position"][i]) / 2 for i in range(3)]
    assert math.dist(mid, table["position"]) < 0.3, "the table sits between the couple"
    assert math.dist(him["position"], her["position"]) < 2.0
    assert len(s["shots"]) >= 3
    assert any(sh["setup"].startswith(("single", "ots")) for sh in s["shots"]), "coverage includes singles/OTS"


def test_tank(built):
    s = built["tank"]["scene"]
    assert s["environment"]["set"] == "water_tank" and s["environment"]["weather"] == "none"
    rescuer, victim = people(s)
    assert len(rescuer["keys"]) == 2, "the rescuer swims to the victim"
    end = rescuer["keys"][-1]["position"]
    assert math.dist(end, victim["position"]) < 1.2
    for sh in s["shots"]:
        for k in sh["camera_keys"]:
            assert abs(k["position"][0]) <= 7.6 and abs(k["position"][2]) <= 7.6, "cameras stay inside the tank"


def test_rooftop(built):
    s = built["rooftop"]["scene"]
    assert s["environment"]["set"] == "empty" and s["lighting"]["preset"] == "magic_hour"
    runner, pursuer = people(s)
    for a in (runner, pursuer):
        assert len(a["keys"]) == 2 and math.dist(a["keys"][0]["position"], a["keys"][-1]["position"]) > 6
    assert any(a.get("design") in ("water tower", "ac unit", "chimney", "parapet") for a in s["actors"])
    assert built["rooftop"]["designs"], "free-text props are handed to the object designer"


def test_sitcom(built):
    s = built["sitcom"]["scene"]
    assert s["environment"]["set"] == "interior"
    cast = people(s)
    assert len(cast) == 3 and {c["kind"] for c in cast} == {"man", "woman"}
    couch = by_name(s, "couch")
    for c in cast:
        assert c["position"][2] < couch["position"][2] < c["position"][2] + 1.2, "friends sit in front of the couch"
        assert abs(abs(c["rotation_deg"]) - 180) < 1, "they face the audience side (-Z)"
    assert {lt["type"] for lt in s["lighting"]["lights"]} == {"key", "fill", "rim"}, "sitcom = flat three-point"


def test_build_is_fast():
    import time
    t = time.time()
    for p in PROMPTS.values():
        core.describe(p)
    assert time.time() - t < 3.0, "rules + placement + advisor must be near-instant (the model is the only slow part)"


def test_empty_and_weird_prompts_still_build():
    for p in ["", "asdf qwerty", "a dog", "the void", "x" * 3000, "an army of 500 soldiers storms the beach"]:
        res = core.describe(p)
        assert check_scene(res["scene"]) == []
        assert len(people(res["scene"])) <= 4


# ---------------------------------------------------------------------------------------------- LLM plan

GOOD = ('{"set":"street_night","time":"midday","weather":"dust","genre":"western","cast":[{"name":"Cole","kind":"man"},'
        '{"name":"Hatch","kind":"man"}],"props":["horse","rifle","hat","water trough"],"blocking":"face_off","lights":[],"shots":3}')


def test_llm_plan_used_and_hand_props_dropped():
    res = core.describe(PROMPTS["western"], llm_text=GOOD)
    assert res["backend"] == "llm"
    names = [a["name"] for a in people(res["scene"])]
    assert names == ["Cole", "Hatch"]
    props = res["plan"]["props"]
    assert "rifle" not in props and "hat" not in props and "horse" in props
    assert check_scene(res["scene"]) == []


@pytest.mark.parametrize("text", [
    "```json\n" + GOOD + "\n```",
    "<think>hmm</think>" + GOOD,
    GOOD.replace('"shots":3}', '"shots":3,}'),
    GOOD[:-40],                                   # truncated mid-answer
    GOOD.replace('"street_night"', '"Main Street"').replace('"midday"', '"high noon"'),
])
def test_llm_plan_repair(text):
    res = core.describe(PROMPTS["western"], llm_text=text)
    s = res["scene"]
    assert check_scene(s) == []
    assert s["environment"]["set"] == "street_night"
    assert s["lighting"]["preset"] == "midday"


def test_llm_garbage_falls_back_to_rules():
    for junk in ["I'm sorry, I can't help", "{not json", '{"set": 42, "cast": "lots"}', '{"cast":[{"kind":"dragon"}]}']:
        res = core.describe(PROMPTS["office"], llm_text=junk)
        assert check_scene(res["scene"]) == []
        assert res["scene"]["environment"]["set"] == "interior"
        assert len(people(res["scene"])) == 1


def test_interior_lamp_is_not_a_street_lamp():
    raw = '{"set":"interior","time":"night","cast":[{"name":"Detective","kind":"man"}],"props":["desk","lamp"],"blocking":"alone"}'
    s = core.describe(PROMPTS["office"], llm_text=raw)["scene"]
    assert not any(a["kind"] == "lamp" for a in s["actors"])


# ---------------------------------------------------------------------------------------------- edits

def street_scene():
    return core.describe("a woman and a man wait by a parked car on a city street at night")["scene"]


EDITS = [
    ("street", "move the car closer to the streetlamp"),
    ("office", "add a second detective by the window"),
    ("office", "make it night with rain"),
    ("diner", "give me an over-the-shoulder on the woman"),
    ("street", "turn the man to face the woman"),
    ("diner", "remove the jukebox and make it magic hour"),
    ("sitcom", "make the coffee table twice as big"),
    ("street", "move the woman 2 metres left"),
    ("office", "add a key light on the detective"),
    ("diner", "push in and use an 85mm lens"),
    ("street", "switch to the forest"),
    ("western", "add a horse next to the first gunfighter"),
    ("cowboy", "put the first cop on the police car"),
    ("cowboy", "the cowboy gets off"),
]


@pytest.fixture(scope="module")
def scenes(built):
    d = {k: v["scene"] for k, v in built.items()}
    d["street"] = street_scene()
    d["cowboy"] = core.describe(COWBOY)["scene"]
    return d


def _canon(s):
    return json.dumps(s, sort_keys=True)


@pytest.mark.parametrize("key,cmd", EDITS)
def test_edit_ops_valid_and_undoable(scenes, key, cmd):
    before = scenes[key]
    res = core.edit(before, cmd)
    assert res["ops"], f"no ops for {cmd!r}: {res['notes']}"
    for op in res["ops"]:
        assert op["op"] in {"add_object", "remove_object", "update_object", "move_object", "rotate_object", "scale_object",
                            "set_environment", "set_lighting", "add_light", "remove_light", "add_shot", "remove_shot",
                            "update_shot", "set_active_shot"}
        assert isinstance(op.get("undo"), dict)
    after = res["scene"]
    assert check_scene(after) == [], check_scene(after)
    assert _canon(O.apply_ops(after, res["inverse"])) == _canon(validate_scene(before)[0])
    assert res["summary"] != "Nothing changed."


def test_edit_move_closer_to_streetlamp(scenes):
    s = scenes["street"]
    car0 = by_name(s, "car")
    lamps = C.SETS["street_night"]["anchors"]["streetlamp"]
    d0 = min(math.dist([car0["position"][0], car0["position"][2]], p) for p in lamps)
    after = core.edit(s, "move the car closer to the streetlamp")["scene"]
    car1 = by_name(after, "car")
    d1 = min(math.dist([car1["position"][0], car1["position"][2]], p) for p in lamps)
    assert d1 < d0 and d1 < 3.5


def test_edit_second_detective_by_window(scenes):
    res = core.edit(scenes["office"], "add a second detective by the window")
    new = res["ops"][0]["object"]
    assert new["kind"] == "man" and new["name"] == "Detective 2"
    win = C.SETS["interior"]["anchors"]["window"]
    assert math.dist([new["position"][0], new["position"][2]], win) < 1.5


def test_edit_night_rain(scenes):
    after = core.edit(scenes["diner"], "make it night with rain")["scene"]
    assert after["lighting"]["preset"] == "night" and after["environment"]["weather"] == "rain"
    assert after["sun"]["elevation_deg"] < -10


def test_edit_ots_on_woman(scenes):
    s = scenes["diner"]
    res = core.edit(s, "give me an over-the-shoulder on the woman")
    after = res["scene"]
    shot = after["shots"][-1]
    assert after["active_shot"] == shot["id"] and shot["setup"].startswith("ots")
    her = by_name(after, "woman") if any(a["kind"] == "woman" for a in after["actors"]) else None
    her = next(a for a in after["actors"] if a["kind"] == "woman")
    him = next(a for a in after["actors"] if a["kind"] == "man")
    k = shot["camera_keys"][0]
    assert math.dist(k["target"][::2], her["position"][::2]) < 0.2, "aimed at the woman"
    assert math.dist(k["position"][::2], him["position"][::2]) < 1.3, "from behind the man's shoulder"
    assert math.dist(k["position"], her["position"]) > math.dist(him["position"], her["position"])


def test_edit_face(scenes):
    after = core.edit(scenes["street"], "turn the man to face the woman")["scene"]
    man = next(a for a in after["actors"] if a["kind"] == "man")
    woman = next(a for a in after["actors"] if a["kind"] == "woman")
    want = math.degrees(math.atan2(woman["position"][0] - man["position"][0], woman["position"][2] - man["position"][2]))
    assert abs(((man["rotation_deg"] - want + 180) % 360) - 180) < 1


def test_edit_llm_ops_preferred_and_repaired(scenes):
    llm = '{"ops":[{"op":"move","target":"Car","near":"streetlamp"},{"op":"weather","weather":"fog"}]}'
    res = core.edit(scenes["street"], "move the car to the lamp and fog it up", llm_text=llm)
    assert res["backend"] == "llm"
    assert [o["op"] for o in res["ops"]] == ["move_object", "set_environment"]


def test_edit_llm_unknown_names_fall_back(scenes):
    llm = '{"ops":[{"op":"move","target":"spaceship","near":"moon"}]}'
    res = core.edit(scenes["street"], "move the car closer to the streetlamp", llm_text=llm)
    assert res["backend"] == "rules" and res["ops"]


def test_edit_nonsense_is_a_noop(scenes):
    res = core.edit(scenes["office"], "what is the meaning of life")
    assert res["ops"] == [] and res["inverse"] == []


def test_scale_grows_into_free_space(scenes):
    res = core.edit(scenes["sitcom"], "make the coffee table twice as big")
    assert any(o["op"] == "scale_object" for o in res["ops"])
    assert check_scene(res["scene"]) == []


# ---------------------------------------------------------------------------------------------- validator

def test_validator_repairs_broken_scene():
    bad = {
        "environment": {"set": "interior", "weather": "hail"},
        "lighting": {"mode": "time", "hour": 40, "preset": "teatime", "lights": [{"type": "laser", "position": "x"}]},
        "actors": [
            {"id": "a", "kind": "man", "position": [350, 2, 120]},          # centimetres, floating
            {"id": "a", "kind": "woman", "position": [3.5, 0, 0]},          # duplicate id
            {"id": "c", "kind": "piano", "position": [3.5, 0, 0]},          # not in the library, overlapping
            {"id": "d", "kind": "car", "position": [50, 0, 50]},            # outside the room
            {"kind": "man", "position": [float("nan"), 0, 0], "height_m": 900},
        ],
        "shots": [{"id": "s", "camera_keys": [{"frame": 0, "position": [0, 1.7, 30], "target": [0, 1.7, 30], "focal_mm": 2}]}],
    }
    s, notes = validate_scene(bad)
    assert check_scene(s) == [], check_scene(s)
    assert notes
    assert s["environment"]["weather"] == "none" and s["lighting"]["preset"] is None
    assert s["lighting"]["lights"][0]["type"] == "key"
    assert len({a["id"] for a in s["actors"]}) == len(s["actors"])
    assert next(a for a in s["actors"] if a["id"] == "c")["kind"] == "custom"
    k = s["shots"][0]["camera_keys"][0]
    assert k["focal_mm"] >= 8 and k["position"][2] <= 4.75


def test_validate_scene_accepts_stage_default_scene():
    stage = (ROOT / "web" / "stage" / "stage.mjs").read_text()
    m = re.search(r"export const DEFAULT_SCENE = (\{.*?\n\});", stage, re.S)
    js = m.group(1)
    js = re.sub(r"(\b[a-z_]+):", r'"\1":', js)
    js = re.sub(r",(\s*[}\]])", r"\1", js)
    scene = json.loads(js)
    s, notes = validate_scene(scene)
    assert s["environment"]["set"] == "plaza" and len(s["actors"]) == 2
    assert check_scene(s) == []


# ---------------------------------------------------------------------------------------------- mirrors

def test_catalog_mirrors_the_stage():
    lib = (ROOT / "web" / "stage" / "library.mjs").read_text()
    for kind, spec in C.LIBRARY.items():
        assert re.search(rf"\b{kind}: \{{ label: \"[^\"]+\", height: {spec['height']}\b", lib), kind
    env = (ROOT / "web" / "stage" / "environments.mjs").read_text()
    for name in C.SETS:
        assert re.search(rf"\b{name}: \{{ label:", env), name
    assert "const W = 8, D = 10, H = 3.2" in env and "const W = 16, D = 16, H = 4" in env
    light = (ROOT / "web" / "stage" / "lighting.mjs").read_text()
    for key in C.TIME_PRESETS:
        assert re.search(rf"\b{key}: \{{ label:", light), key
    for key, spec in C.LIGHT_TYPES.items():
        assert re.search(rf"\b{key}: \{{ label: \"[^\"]+\", kelvin: {spec['kelvin']}\b", light), key


def test_hour_for_elevation_port():
    assert C.preset_hour("midday") == 12.5
    h = C.preset_hour("magic_hour")
    assert 16 < h < 19 and abs(C.solar_position(h)[1] - 3) < 0.5


def test_prompts_are_small():
    # Qwen3.5-4B: short system prompts keep the answer fast and on-format.
    assert len(PR.BUILD_SYSTEM) < 2000 and len(PR.EDIT_SYSTEM) < 2000
    ctx = PR.edit_user("move the car", street_scene())
    assert len(ctx) < 600


# ---------------------------------------------------------------------------------------------- JS parity

def test_ops_parity_fixture_matches_python():
    """tests/agent_fixtures/ops_parity.json is also replayed by tests/js/agent.test.mjs (applyOpsToScene)."""
    cases = json.loads(FIXTURE.read_text())
    assert len(cases) >= 6
    for c in cases:
        assert _canon(O.apply_ops(c["scene"], c["ops"])) == _canon(c["expected"]), c["command"]
        assert _canon(O.apply_ops(c["expected"], c["inverse"])) == _canon(c["scene"]), c["command"]


# ---------------------------------------------------------------------------------------------- riders, passes, camera intent

COWBOY = "a cowboy on a horse rides past two cops standing by a police car outside a diner at magic hour, camera low and tracking"
# What the model really answered on the pod (2026-10-28): a separate horse in cast AND props.
COWBOY_LLM = ('{"set":"street_night","time":"magic_hour","weather":"none","genre":"western","cast":[{"name":"Cowboy","kind":"man"},'
              '{"name":"Horse","kind":"horse"},{"name":"Cop 1","kind":"man"},{"name":"Cop 2","kind":"man"}],'
              '"props":["horse","police car","diner sign"],"blocking":"group","lights":[],"shots":4}')


def _check_cowboy(res):
    s = res["scene"]
    assert check_scene(s) == [], check_scene(s)
    horses = [a for a in s["actors"] if a["kind"] == "horse"]
    assert len(horses) == 1, "one horse: the cowboy's mount, not a second one"
    horse = horses[0]
    cowboy = next(a for a in s["actors"] if "cowboy" in a["name"].lower())
    assert cowboy["mount_id"] == horse["id"] and cowboy["pose"] == "ride"
    # The horse rides past: a path that crosses the frame (screen side to side), the rider mirrors it.
    k = horse["keys"]
    assert len(k) == 2 and abs(k[0]["position"][0] - k[-1]["position"][0]) > 8
    assert [x["position"] for x in cowboy["keys"]] == [x["position"] for x in k]
    cops = [a for a in s["actors"] if a["kind"] == "man" and "cop" in a["name"].lower()]
    assert len(cops) == 2 and all(len(c["keys"]) == 1 for c in cops)
    car = next(a for a in s["actors"] if a["kind"] == "car")
    assert min(math.dist(car["position"], c["position"]) for c in cops) < 3.0, "the cops stand by the police car"
    # Camera low and tracking: the wide sits ~0.6 m up, sees everyone from a real distance, and moves with the horse.
    wide = s["shots"][0]
    assert wide["setup"] in ("wide", "master", "two_shot")
    k0, k1 = wide["camera_keys"][0], wide["camera_keys"][-1]
    assert 0.3 <= k0["position"][1] <= 0.9
    horiz = math.hypot(k0["position"][0] - k0["target"][0], k0["position"][2] - k0["target"][2])
    assert horiz > 6
    assert len(wide["camera_keys"]) == 2 and math.dist(k0["position"], k1["position"]) > 8, "the wide tracks"
    assert any(sh["camera_keys"][0]["target"][1] > 2 and len(sh["camera_keys"]) == 2 for sh in s["shots"]), \
        "a shot travels with the rider, framed up on the horse"


def test_cowboy_rules_path():
    res = core.describe(COWBOY)
    assert res["scene"]["environment"]["set"] == "plaza", "outside a diner = an exterior"
    _check_cowboy(res)


def test_cowboy_llm_path():
    res = core.describe(COWBOY, llm_text=COWBOY_LLM)
    assert res["backend"] == "llm" and res["scene"]["environment"]["set"] == "street_night"
    _check_cowboy(res)


def test_llm_rides_field():
    raw = ('{"set":"desert","time":"midday","cast":[{"name":"Rider","kind":"man","rides":"horse","passes":true}],'
           '"props":["rock"],"blocking":"alone"}')
    s = core.describe("a lone rider crosses the desert", llm_text=raw)["scene"]
    rider = next(a for a in s["actors"] if a["kind"] == "man")
    horse = next(a for a in s["actors"] if a["kind"] == "horse")
    assert rider["mount_id"] == horse["id"] and len(horse["keys"]) == 2


@pytest.mark.parametrize("key", list(PROMPTS))
def test_wides_are_not_top_down(built, key):
    """Wides frame every person from a horizontal distance at eye height; nothing looks down steeper than 30-38°."""
    s = built[key]["scene"]
    cast = people(s)
    for sh in s["shots"]:
        k = sh["camera_keys"][0]
        horiz = math.hypot(k["position"][0] - k["target"][0], k["position"][2] - k["target"][2])
        pitch = math.degrees(math.atan2(k["position"][1] - k["target"][1], max(horiz, 1e-6)))
        assert pitch <= 38.5, f"{sh['name']} looks down {pitch:.0f}°"
        if sh["setup"] in ("wide", "master") and key != "rooftop":
            assert 1.2 <= k["position"][1] <= 1.8, f"{sh['name']} at {k['position'][1]} m"
            from soundstage.cine import geometry as G
            for a in cast:
                xy = G.project((a["position"][0], 1.0, a["position"][2]), tuple(k["position"]), tuple(k["target"]),
                               k["focal_mm"])
                assert xy is not None and abs(xy[0]) <= 1.0, f"{a['name']} out of the wide in {key}"


def test_camera_intent_words():
    assert P.camera_intent("camera low and tracking") == {"height": "low", "move": "track"}
    assert P.camera_intent("high angle on the crowd")["height"] == "high"
    assert P.camera_intent("bird's eye view of the square")["height"] == "overhead"
    s = core.describe("two friends talk on a bench in a park, high angle")["scene"]
    assert s["shots"][0]["camera_keys"][0]["position"][1] > 3


def test_mount_and_dismount_edits():
    s = core.describe("a man and a horse in the desert at noon")["scene"]
    res = core.edit(s, "put the man on the horse")
    man = next(a for a in res["scene"]["actors"] if a["kind"] == "man")
    horse = next(a for a in res["scene"]["actors"] if a["kind"] == "horse")
    assert man["mount_id"] == horse["id"] and man["pose"] == "ride"
    assert check_scene(res["scene"]) == []
    back = O.apply_ops(res["scene"], res["inverse"])
    assert "mount_id" not in next(a for a in back["actors"] if a["kind"] == "man"), "undo leaves no mount_id: null"
    res2 = core.edit(res["scene"], "the man gets off")
    man2 = next(a for a in res2["scene"]["actors"] if a["kind"] == "man")
    assert "mount_id" not in man2 and "pose" not in man2
    assert check_scene(res2["scene"]) == []
    llm = '{"ops":[{"op":"mount","target":"Man","on":"Horse"}]}'
    assert core.edit(s, "saddle up", llm_text=llm)["ops"][0]["set"]["pose"] == "ride"


def test_validator_drops_dangling_mount():
    s, notes = validate_scene({"environment": {"set": "desert"}, "actors": [
        {"id": "r", "kind": "man", "position": [0, 0, 0], "mount_id": "ghost", "pose": "ride"}]})
    assert "mount_id" not in s["actors"][0] and notes


# ---------------------------------------------------------------------------------------------- live-run regressions (2026-10-28)

def test_llm_cannot_make_bystanders_pass_or_invent_mounts():
    raw = ('{"set":"street_night","time":"magic_hour","cast":[{"name":"Cowboy","kind":"man","rides":"horse","passes":true},'
           '{"name":"Cop1","kind":"man","passes":true},{"name":"Cop2","kind":"man","passes":true}],"props":["police car"],'
           '"blocking":"chase","shots":4}')
    s = core.describe(COWBOY, llm_text=raw)["scene"]
    cops = [a for a in s["actors"] if a["name"].lower().startswith("cop")]
    assert cops and all(len(c["keys"]) == 1 for c in cops), "only the one the text says rides past moves"
    raw2 = ('{"set":"empty","time":"magic_hour","cast":[{"name":"Runner","kind":"man","rides":"motorcycle"},'
            '{"name":"Pursuer","kind":"man","rides":"motorcycle"}],"props":["chimney"],"blocking":"chase","shots":3}')
    s2 = core.describe("chase across a rooftop at magic hour", llm_text=raw2)["scene"]
    assert not any(a.get("mount_id") for a in s2["actors"]) and not any(a["kind"] == "motorcycle" for a in s2["actors"])


def test_llm_shot_count_has_a_floor():
    raw = ('{"set":"interior","time":"night","weather":"rain","cast":[{"name":"Detective","kind":"man"}],'
           '"props":["desk"],"blocking":"alone","shots":1}')
    assert len(core.describe(PROMPTS["office"], llm_text=raw)["scene"]["shots"]) >= 2
    raw2 = GOOD.replace('"shots":3', '"shots":1')
    assert len(core.describe(PROMPTS["western"], llm_text=raw2)["scene"]["shots"]) >= 3


def test_mount_command_beats_a_flattened_model_move():
    s = core.describe(COWBOY)["scene"]
    llm = '{"ops":[{"op":"move","target":"Cop 1","near":"police car"}]}'
    res = core.edit(s, "put the first cop on the police car", llm_text=llm)
    assert res["backend"] == "rules" and res["ops"][0]["set"].get("mount_id")


def test_edits_never_leave_overlaps():
    s = core.describe(PROMPTS["western"])["scene"]
    g2 = next(a for a in s["actors"] if a["name"] == "Gunfighter 2")
    # A model op that would park the horse on top of a gunfighter, then turn it.
    llm = ('{"ops":[{"op":"move","target":"horse","near":"Gunfighter 2","distance":0.2},'
           '{"op":"rotate","target":"horse","deg":90}]}')
    res = core.edit(s, "move the horse next to the gunfighter and turn it", llm_text=llm)
    assert check_scene(res["scene"]) == []
    assert O.apply_ops(res["scene"], res["inverse"]) == validate_scene(s)[0]
    assert g2


if __name__ == "__main__" and "--write-fixture" in sys.argv:
    out = []
    base = {k: core.describe(v)["scene"] for k, v in PROMPTS.items()}
    base["street"] = street_scene()
    base["cowboy"] = core.describe(COWBOY)["scene"]
    for key, cmd in EDITS[:8] + EDITS[-2:]:
        r = core.edit(base[key], cmd)
        out.append({"command": cmd, "scene": validate_scene(base[key])[0], "ops": r["ops"], "inverse": r["inverse"],
                    "expected": r["scene"]})
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.write_text(json.dumps(out))
    print(f"wrote {FIXTURE} ({len(out)} cases)")
