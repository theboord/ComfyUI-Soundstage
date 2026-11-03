"""Racing cinema, the edges (after tests/test_racing_cinema.py): the browser's preset catalog and the Director's are the
same list field for field; the stage the Presets window really builds (J-turn + each racing camera preset, run in node
by web/presets/runner.mjs) compiles to the words each preset promises, with no two words that contradict each other;
the words survive other looks and stunts; the ride-along words follow the ground; no target, several cars, no driver.
JS half: tests/js/racing_cinema_edges.test.mjs."""
import copy
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from soundstage import presets_agent as P  # noqa: E402
from soundstage.look import scene as S  # noqa: E402
from soundstage.look import stunts as ST  # noqa: E402
from soundstage.look.compile import compile_look, look_context  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed (the stage and its presets run in node)")

STYLES = json.loads((ROOT / "web" / "look" / "style_presets.json").read_text(encoding="utf-8"))
RACING = next(s for s in STYLES if s["id"] == "racing_cinema")
CAMS = ["long_lens_pan", "arm_car", "tyre_cam", "bumper_cam"]
NODE_CAMS = CAMS + ["car_mount"]   # and the hood mount, for the contradiction checks
WEB = (ROOT / "web").as_uri()

# The headless stage of tests/js/racing_cinema.test.mjs: the stunt car on the set, camera A on an 85 mm from the side;
# the J-turn (Road: Wet by default), then the camera preset, exactly as the Presets window applies them.
STAGE_JS = """
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const W = %(web)s;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
globalThis.ProgressEvent ??= class ProgressEvent extends Event { constructor(t, o = {}) { super(t); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); } };
globalThis.self ??= globalThis;
const THREE = await import(W + "/vendor/three.module.min.mjs");
const { Stage, DEFAULT_SCENE } = await import(W + "/stage/stage.mjs");
const E = await import(W + "/presets/engine.mjs");
const { PresetRunner } = await import(W + "/presets/runner.mjs");
const cat = await E.loadCatalog();
const out = { catalog: cat.presets, consts: { TAB_IDS: E.TAB_IDS, CAMERA_MOVES: E.CAMERA_MOVES, TIME_KEYS: E.TIME_KEYS,
  GRADE_KEYS: E.GRADE_KEYS, RECIPE_STEPS: E.RECIPE_STEPS }, validate: E.validateCatalog(cat),
  bogus: E.validateCatalog(E.buildCatalog({ tabs: cat.tabs, presets: [{ id: "spin_cam", tab: "camera", label: "Spin", summary: "x",
    apply: { camera: { move: "barrel_roll" } } }] })), shots: {} };
for (const set of %(sets)s) for (const id of %(cams)s) {
  const st = Object.create(Stage.prototype);
  const keys = [{ frame: 0, position: [1.6, 0, -14] }];
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames: 121, fps: 24 }, environment: { set, weather: "none" },
      actors: [{ id: "car", name: "Stunt car", kind: "sports_car", height_m: 1.2, keys, position: keys[0].position, rotation_deg: 0 }],
      shots: [{ id: "a", name: "Camera A", setup: "wide", camera_keys: [{ frame: 0, position: [8, 1.2, 0], target: [1.6, 0.7, -14], focal_mm: 85 }] }],
      active_shot: "a" },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root); st._buildSet(); st.setFrame(0);
  const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
  const jt = await runner.apply("reverse_jturn");
  const r = await runner.apply(id);
  out.shots[set + "/" + id] = { ok: jt.ok && r.ok, said: r.said, scene: st.toJSON() };
}
process.stdout.write(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def stage():
    js = STAGE_JS % {"web": json.dumps(WEB), "sets": json.dumps(["plaza", "street_night"]), "cams": json.dumps(NODE_CAMS)}
    res = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, timeout=240, cwd=str(ROOT))
    assert res.returncode == 0, res.stderr[-3000:]
    return json.loads(res.stdout)


def _look():
    return copy.deepcopy(RACING["look"])


def _compiled(stage, key, look=None):
    shot = stage["shots"][key]
    assert shot["ok"], shot["said"]
    sc = copy.deepcopy(shot["scene"])
    return sc, compile_look(look or _look(), sc)


# ------------------------------------------------------------------------------------------------ the catalog


def test_the_directors_catalog_is_the_browsers_field_for_field(stage):
    js, py = stage["catalog"], P.load_catalog()["presets"]
    assert [p["id"] for p in py] == [p["id"] for p in js]
    for a, b in zip(js, py):
        for k in ("tab", "label", "group", "summary", "words"):
            assert b.get(k) == a.get(k), (a["id"], k, a.get(k), b.get(k))
        if a["tab"] == "look":   # the Director only needs the style id; the browser also carries its grade and palette
            assert b["apply"] == {"look": a["apply"]["look"]}
        else:
            assert b["apply"] == a["apply"], a["id"]
    # The rule lists both validators check against.
    for k, v in stage["consts"].items():
        assert getattr(P, k) == v, k
    assert stage["validate"] == [] and P.validate_catalog(P.load_catalog()) == []
    assert stage["bogus"] and P.validate_catalog({"tabs": P.load_catalog()["tabs"], "presets": [
        {"id": "spin_cam", "tab": "camera", "label": "Spin", "summary": "x", "apply": {"camera": {"move": "barrel_roll"}}}]}), \
        "an unknown camera move fails on both sides"
    # A hyphenated style name is matched by the same words on both sides ("Neo-Noir", "Coming-of-Age / Teen").
    cat = P.load_catalog()
    assert cat["by_id"]["neo_noir"]["words"] == ["neo noir"]
    assert [p["id"] for p in P.presets_in_text(cat, "a long-lens pan in the neo-noir look")] == ["long_lens_pan", "neo_noir"]


# ------------------------------------------------------------------------------------------------ the presets' words


@pytest.mark.parametrize("set_id", ["plaza", "street_night"])
def test_each_racing_camera_preset_says_what_it_promises(stage, set_id):
    # Long-lens pan: the lens it really ended on (the toast's mm), a long lens, the car and its spray, the pan's streaks.
    sc, r = _compiled(stage, f"{set_id}/long_lens_pan")
    mm = int(re.search(r"(\d+) mm\)", stage["shots"][f"{set_id}/long_lens_pan"]["said"]).group(1))
    assert f"{mm}mm lens" in r["still_prompt"]
    assert S.lens_band(mm) in r["motion_prompt"]
    assert sc["shots"][0]["rig"]["type"] == "tripod"
    for w in ("the wheels a motion-blurred disc", "a fine sheet of spray and mist thrown off the tyres"):
        assert w in r["still_prompt"], w
    assert "the background streaks past as the camera pans with the car" in r["motion_prompt"]
    assert re.search(r"The camera pans (left|right)", r["motion_prompt"]), "a pan, from a locked-off base"
    # Arm car: pacing on a 28 mm, the car's words, a steady camera car (not a hand-held operator).
    sc, r = _compiled(stage, f"{set_id}/arm_car")
    assert "28mm lens" in r["still_prompt"] and "wide-angle lens" in r["motion_prompt"]
    assert "the wheels a motion-blurred disc" in r["still_prompt"]
    assert re.search(r"The camera tracks sideways", r["motion_prompt"])
    assert "handheld" not in r["motion_prompt"], "an arm car pacing a J-turn swerves with it smoothly: not a hand"
    # Over the tyre: where it is, low, what the tyre throws beside the lens, the car's words (the flank is in frame).
    sc, r = _compiled(stage, f"{set_id}/tyre_cam")
    assert r["still_prompt"].startswith("low camera hard-mounted just above and outside the front wheel of a sports car")
    assert "just above the front wheel" in r["motion_prompt"]
    assert "a fine sheet of spray and mist peeling off the tyre right beside the lens" in r["motion_prompt"]
    assert "the wheels a motion-blurred disc" in r["still_prompt"] and "14mm lens" in r["still_prompt"]
    assert "Shot on an ultra-wide lens" in r["motion_prompt"]
    # Bumper cam: on the bumper, no car words (the wheels are behind the lens), no spray or smoke beside it.
    sc, r = _compiled(stage, f"{set_id}/bumper_cam")
    assert r["still_prompt"].startswith("low camera hard-mounted on the front bumper of a sports car")
    assert "18mm lens" in r["still_prompt"]
    assert "wheels a motion-blurred disc" not in r["still_prompt"] and "beside the lens" not in r["motion_prompt"]
    assert not re.search(r"spray and mist (peel|stream)|tyre smoke", S.vehicle_camera(sc)["motion"])


LENS_BANDS = ("ultra-wide lens", "wide-angle lens", "wide-normal lens", "normal lens", "portrait telephoto lens", "long telephoto lens")


@pytest.mark.parametrize("key", [f"{s}/{c}" for s in ("plaza", "street_night") for c in NODE_CAMS])
def test_the_final_prompt_never_says_two_things_that_cannot_both_be_true(stage, key):
    _, r = _compiled(stage, key)
    still, motion, neg = r["still_prompt"], r["motion_prompt"], r["still_negative"]
    assert len(re.findall(r"\b\d+mm lens\b", still)) == 1, "one focal length"
    assert len(re.findall(r"Shot on an? [a-z -]+ lens", motion)) == 1
    assert sum(motion.count(f"Shot on {S._article(b)}") for b in LENS_BANDS) == 1, "one lens band"
    assert "a ultra" not in motion, "an ultra-wide lens"
    # Locked to the car and panning with it; a static frame and a move; low and eye-level.
    if "stays locked to the" in motion or "Static frame" in motion:
        assert "pans with the car" not in motion and "horizontal streaks" not in still, key
    if still.startswith("low camera"):
        assert "eye-level" not in still, key
    if "Static frame" in motion:
        assert not re.search(r"The camera (pans|tracks|circles|rises)", motion), key
    # The road is said once, wet or dry, never both; spray in the wet, never the dry road's dense smoke.
    assert still.count("wet-down") <= 1 and motion.count("wet-down") <= 1
    assert not re.search(r"\bdry asphalt\b|heat shimmer", still + motion)
    assert not re.search(r"billowing|dense and white|white tyre smoke", motion), key
    # The look asks for shutter blur where the car words are: never in the negative too.
    if re.search(r"motion[- ]blur", still):
        assert "motion blur trails" not in neg
    # The negative never rules out what the prompt asks for.
    for frag in (f.strip() for f in neg.split(",")):
        if len(frag) > 12:
            assert frag not in still, (key, frag)
    # No fragment twice in the still.
    frags = [f.strip() for f in still.split(",") if f.strip()]
    assert len(frags) == len(set(frags)), [f for f in frags if frags.count(f) > 1]


# ------------------------------------------------------------------------------------------------ combined with others


def test_the_racing_words_survive_another_lens_film_stock_and_the_other_stunts():
    from test_stunts import _stunt_scene
    for kind in ("donut", "handbrake_180", "reverse_jturn"):
        st, _, car = _stunt_scene(kind)
        car["stunt_sim"] = {"surface": "dry"}
        look = _look()
        look.update(lens="long_tele", film_stock="kodak_500t")
        r = compile_look(look, st)
        still, motion = r["still_prompt"], r["motion_prompt"]
        # The user's picks replace the style's: one lens, one film stock.
        assert "long telephoto lens, compressed perspective" in still and "anamorphic" not in still + motion, kind
        assert "Kodak 500T" in motion and "print-emulation" not in still + motion, kind
        # The motorsport layers still reach the prompt, for the dry road.
        for w in ("modern racing film still", "the wheels a motion-blurred disc", "dry asphalt with black rubber skid marks"):
            assert w in still, (kind, w)
        assert "natural cinema-shutter motion blur smears the spinning wheels" in motion
        assert "spray" not in motion and "wet-down" not in still + motion, kind
        assert "motion blur trails" not in r["still_negative"]
    # Rain on the street: the rain the stage owns, the wet layer once, spray not smoke.
    st, _, car = _stunt_scene("reverse_jturn")
    st["environment"] = {**(st.get("environment") or {}), "weather": "rain"}
    r = compile_look(_look(), st)
    assert "rain falling" in r["still_prompt"] and r["still_prompt"].count("a fine sheet of spray and mist thrown off the tyres") == 1
    assert "wet-down" not in r["still_prompt"], "rain says the road is wet; no wet-down on top"
    assert not re.search(r"white tyre smoke|billowing", r["motion_prompt"])
    # Another genre's style (no car layers) on the same J-turn: none of the racing words leak in.
    noir = next(s for s in STYLES if s["id"] == "neo_noir")["look"]
    r = compile_look(copy.deepcopy(noir), st)
    assert not re.search(r"racing|motion-blurred disc|grime streaks", r["still_prompt"] + r["motion_prompt"])


# ------------------------------------------------------------------------------------------------ the ground and the ride


def _ride(view, surface, set_id="street_night", weather="none"):
    from test_racing_cinema import _ride as ride
    st = ride(view, surface or "wet")
    if surface is None:
        for a in st["actors"]:
            a.pop("stunt_sim", None)
    st["environment"] = {**(st.get("environment") or {}), "set": set_id, "weather": weather}
    return st


@pytest.mark.parametrize("set_id,weather,surface,throws", [
    ("desert", "none", "wet", "dust and grit"),    # Road: Wet on the desert: the desert's dust (stunt_mark says so too)
    ("beach", "none", "dry", "dust and grit"),
    ("desert", "rain", None, "dust and grit"),
    ("plaza", "snow", None, "snow and slush"),     # snow, no Road set: slush, not white tyre smoke
    ("plaza", "snow", "dry", "snow and slush"),
    ("street_night", "none", "wet", "spray and mist"),
    ("street_night", "none", "dry", "white tyre smoke"),
])
@pytest.mark.parametrize("view", ["front_wheel", "dash", "driver_pov"])
def test_what_the_tyres_throw_past_a_ride_along_lens_follows_the_ground(set_id, weather, surface, throws, view):
    st = _ride(view, surface, set_id, weather)
    v = S.vehicle_camera(st)
    assert throws in v["motion"], (view, v["motion"])
    others = {"dust and grit", "snow and slush", "spray and mist", "white tyre smoke"} - {throws}
    if throws == "snow and slush":
        others.discard("spray and mist")   # "a fine spray of snow" is not "spray and mist" but share a word
    for w in others:
        assert w not in v["motion"], (view, w)
    # The same shot's look words agree with the ride words.
    r = compile_look(_look(), st)
    if throws == "dust and grit":
        assert not re.search(r"spray and mist|white tyre smoke", r["motion_prompt"])
    if throws == "snow and slush":
        assert "white tyre smoke" not in r["motion_prompt"]


def test_ride_words_keep_their_wording_on_a_paved_road():
    st = _ride("front_wheel", "wet")
    car = next(a for a in st["actors"] if a["id"] == "sports_car")
    for ground in (None, "wet", "dry"):
        assert ST.ride_words(car, "sports car", wet=True, where="wheel", ground=ground).endswith(
            "a fine sheet of spray and mist peeling off the tyre right beside the lens.")
    assert ST.ride_words(car, "sports car", wet=True, where="hood", ground="dirt").endswith("dust and grit streaming past the hood.")
    assert "smoke" not in ST.ride_words(car, "sports car", where="bumper", ground="snow")


def test_a_hard_mount_never_pans_with_the_car(stage):
    for key in ("plaza/tyre_cam", "plaza/bumper_cam", "street_night/tyre_cam"):
        sc, r = _compiled(stage, key)
        ctx = look_context(sc)
        assert ctx["pan_still"] == ctx["pan_motion"] == "locked", key
        assert "stays locked to the sports car" in r["motion_prompt"]
        assert "pans with the car" not in r["motion_prompt"] and "pan blur" not in r["still_prompt"], key
        assert "low angle" in r["still_prompt"] and "eye-level" not in r["still_prompt"], key


def test_an_arm_car_swerving_with_the_jturn_is_steady_but_a_bob_is_still_a_hand(stage):
    sc = copy.deepcopy(stage["shots"]["plaza/arm_car"]["scene"])
    assert not S.camera_move(sc)["handheld"]
    keys = sc["shots"][0]["camera_keys"]
    # The same path with the lens bobbing up and down 6 cm key to key: an operator's steps.
    bob = [dict(k, position=[k["position"][0], k["position"][1] + (0.06 if i % 2 else -0.06), k["position"][2]]) for i, k in enumerate(keys)]
    sc["shots"][0]["camera_keys"] = bob
    sc["camera_keys"] = bob
    assert S.camera_move(sc)["handheld"]
    assert "handheld and breathing" in compile_look(_look(), sc)["motion_prompt"]


# ------------------------------------------------------------------------------------------------ edge cases


def test_a_ride_along_camera_key_without_a_target_still_compiles():
    st = _ride("front_wheel", "wet")
    st["shots"][0]["camera_keys"][0].pop("target")
    r = compile_look(_look(), st)
    assert r["still_prompt"] and r["motion_prompt"]
    assert S.vehicle_camera(st)["where"] == "wheel", "low, outside the wheel and looking back at the car's middle"
    # And a world camera without a target (the old behaviour: it looks at the stage's origin).
    from test_racing_cinema import _jturn
    st, _ = _jturn("wet")
    for k in st["shots"][0]["camera_keys"]:
        k.pop("target")
    st["camera_keys"] = st["shots"][0]["camera_keys"]
    assert compile_look(_look(), st)["still_prompt"]


def test_a_car_with_no_driver_and_a_second_car():
    from test_racing_cinema import _jturn
    st, car = _jturn("wet")
    # No driver: the tyre cam on an empty stunt car still names the mount and the spray, and never asks for empty seats.
    alone = _ride("front_wheel", "wet")
    alone["actors"] = [a for a in alone["actors"] if a.get("mount_id") != "sports_car"]
    v = S.vehicle_camera(alone)
    assert v["where"] == "wheel" and "spray and mist peeling off the tyre" in v["motion"]
    r = compile_look(_look(), alone)
    assert "the wheels a motion-blurred disc" in r["still_prompt"] and "empty seats" not in r["still_negative"]
    # A second car parked in the street: the moving stunt car still makes it a car shot; the parked car alone does not.
    two = copy.deepcopy(st)
    parked = copy.deepcopy(car)
    parked.update(id="parked", keys=[{"frame": 0, "position": [-3.0, 0, 6.0]}], position=[-3.0, 0, 6.0])
    for k in ("stunt", "stunt_sim"):
        parked.pop(k, None)
    two["actors"].append(parked)
    assert look_context(two)["view"] == "car"
    r = compile_look(_look(), two)
    assert r["still_prompt"].count("the wheels a motion-blurred disc") == 1, "the car words once, not per car"
    only_parked = copy.deepcopy(two)
    only_parked["actors"] = [a for a in only_parked["actors"] if a["id"] != "sports_car"]
    assert look_context(only_parked)["view"] == "nocar"
