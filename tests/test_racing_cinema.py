"""Racing cinema (2026-11-02): the look reaches the J-turn's prompts (spray in the wet, shutter blur on the wheels,
large-format anamorphic, the grade) and never contradicts itself; Road: Wet / Dry on the stunt and the set (desert,
snow) pick the surface; the car words only reach shots with a moving car in frame (never a car-free shot, never from
inside the car or its bumper); the background only streaks when the camera really pans; the bumper and over-the-tyre
hard mounts are named, with the stunt the car does under them."""
import copy
import json
import re
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from soundstage import presets_agent as P  # noqa: E402
from soundstage.look import scene as S  # noqa: E402
from soundstage.look import stunts as ST  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed (stunt keys come from stunts.mjs)")

FORBIDDEN = re.compile(r"\b(drift\w*|cgi|video[- ]?game|vfx|computer[- ]generated)\b", re.I)
# Words an image model can't paint, game cues and showroom cues the review flagged: never in a racing prompt.
JARGON = re.compile(r"rooster|beading|show LUT|widescreen|expanded to cover|full-frame sensor|smeared car body", re.I)
CAR_WORDS = re.compile(r"\bcar\b|spray|\btyres?\b|skid marks|wheels? a", re.I)
STYLES = json.loads((ROOT / "web" / "look" / "style_presets.json").read_text(encoding="utf-8"))
RACING = next(s for s in STYLES if s["id"] == "racing_cinema")
MOUNTS = {"bumper": ([0, 0.35, 2.4], [0, 0.3, 12], 18), "front_wheel": ([1.2, 0.8, 1.3], [0.9, 0.3, -4], 14),
          "driver_pov": ([0.37, 1.2, 0.38], [0.37, 1.02, 8], 24), "dash": ([0, 1.12, 0.78], [0, 1.1, -0.3], 24)}


def _look():
    """What the Look panel's applyStyle sets: the style's vocab ids, its palette and grade."""
    return copy.deepcopy(RACING["look"])


def _jturn(surface: str | None = "wet"):
    from test_stunts import _stunt_scene
    st, _, car = _stunt_scene("reverse_jturn")
    if surface:
        car["stunt_sim"] = {"surface": surface}
    return st, car


def _ride(view: str, surface: str = "wet"):
    st, car = _jturn(surface)
    pos, tgt, mm = MOUNTS[view]
    keys = [{"frame": 0, "position": pos, "target": tgt, "focal_mm": mm}]
    st["shots"] = [{"id": "a", "name": "Mount", "setup": "single", "camera_follow": "sports_car", "camera_keys": keys}]
    st["camera_keys"] = keys
    return st


def test_style_is_mirrored_and_in_the_catalog():
    mirror = json.loads((ROOT / "soundstage" / "look" / "style_presets.json").read_text(encoding="utf-8"))
    assert mirror == STYLES
    cat = P.load_catalog()
    assert P.validate_catalog(cat) == []
    assert cat["by_id"]["racing_cinema"]["words"] == ["racing cinema"]
    for pid in ("bumper_cam", "tyre_cam", "arm_car", "long_lens_pan"):
        assert cat["by_id"][pid]["tab"] == "camera", pid
    ids = [p["id"] for p in P.presets_in_text(cat, "give the car a J-turn with a long-lens pan in the racing cinema look")]
    assert ids == ["reverse_jturn", "long_lens_pan", "racing_cinema"]


def test_jturn_wet_says_spray_not_smoke_and_never_contradicts_itself():
    st, _ = _jturn("wet")
    r = compile_look(_look(), st)
    still, neg, motion = r["still_prompt"], r["still_negative"], r["motion_prompt"]
    assert still.startswith("modern racing film still, a fine sheet of spray and mist thrown off the tyres")
    for w in ("the wheels a motion-blurred disc", "the car body sharp", "spray-flecked, grimy bodywork", "large-format anamorphic",
              "oval bokeh", "fine film grain"):
        assert w in still, w
    # The wet road is said once (the stage's Road: Wet), not twice.
    assert still.count("wet-down") == 1 and motion.count("wet-down") == 1
    for w in ("a fine sheet of spray and mist, with a thin wisp of steam at the contact patch, peels off all four tyres",
              "motion blur smears the spinning wheels", "rolls onto its outside tyres", "wet-down asphalt road"):
        assert w in motion, w
    # Wet: spray and mist, a thin wisp of steam; the dense white smoke is the dry road's.
    for w in ("billowing", "dense and white", "wall of white smoke", "white tyre smoke"):
        assert w not in motion, w
    assert motion.index("races backwards toward the camera") < motion.index("slides around 180 degrees") < motion.index("drives forward, nose first")
    for text in (still, motion):
        assert not re.search(r"\bdry (road|asphalt)\b|heat shimmer|badges (stay )?(crisp|sharp)", text), text
        assert not FORBIDDEN.search(text), FORBIDDEN.search(text).group(0)
        assert not JARGON.search(text), JARGON.search(text).group(0)
    assert "motion blur trails" not in neg, "the look asks for shutter blur; the negative must not fight it"
    assert "ghosted double image of the car" in neg and "smeared car body" not in neg
    assert "driving backwards, reversing" not in neg, "frame 1 of a J-turn IS reversing"
    assert "°" not in motion and "180-degree" not in motion, "no numeric specs for LTX"


def test_road_dry_keeps_the_dense_smoke_and_says_dry_asphalt():
    st, _ = _jturn("dry")
    r = compile_look(_look(), st)
    still, motion = r["still_prompt"], r["motion_prompt"]
    assert still.startswith("modern racing film still, dry asphalt") and "heat shimmer" in still and "heat shimmer" in motion
    assert "wet-down" not in still and "wet-down" not in motion and "spray" not in motion
    assert "thick, billowing clouds of white tyre smoke" in motion and "wall of white smoke" in motion
    assert "dry dusty road" not in r["still_negative"]


def test_a_shot_with_no_car_gets_no_car_words():
    """DEFAULT_SCENE (two people walking in the plaza, no vehicle) with Racing Cinema: grade, grain and lens only."""
    r = compile_look(_look(), copy.deepcopy(DEFAULT_SCENE))
    for text in (r["still_prompt"], r["motion_prompt"]):
        assert not CAR_WORDS.search(text), CAR_WORDS.search(text).group(0)
        assert re.search(r"racing[- ]film", text, re.I) and not JARGON.search(text)
    assert "fine film grain" in r["still_prompt"] and "oval bokeh" in r["still_prompt"]
    assert "ghosted double image of the car" not in r["still_negative"]
    # A parked car in frame is not a racing car either: no spinning wheels, no spray.
    st, car = _jturn("wet")
    for k in car["keys"]:
        k["position"] = car["keys"][0]["position"]
        k.pop("heading_deg", None)
        k.pop("fx", None)
    car.pop("stunt", None)
    car.pop("stunt_sim", None)
    assert S.look_view(st, {"sports_car", "getaway"}) == "nocar"


@pytest.mark.parametrize("view", ["bumper", "driver_pov", "dash"])
def test_riding_inside_or_on_the_bumper_gets_no_car_words(view):
    st = _ride(view)
    r = compile_look(_look(), st)
    head = r["still_prompt"].split("modern racing film still", 1)[1][:80]
    assert head.startswith(", grounded and unglamorous"), head
    assert "wheels a motion-blurred disc" not in r["still_prompt"] and "fine sheet of spray" not in r["still_prompt"]
    assert "beside the lens" not in r["motion_prompt"], "the tyres are not beside an interior or bumper lens"
    if view == "bumper":
        assert not re.search(r"spray and mist|tyre smoke", S.vehicle_camera(st)["motion"]), "the tyres are behind a bumper lens"
        assert "asphalt" not in S.vehicle_camera(st)["still"]
    else:
        assert "spray and mist streaking past the windows" in S.vehicle_camera(st)["motion"]


@pytest.mark.parametrize("view,where,word", [("bumper", "bumper", "front bumper"), ("front_wheel", "wheel", "front wheel")])
def test_hard_mounts_on_the_jturn(view, where, word):
    st = _ride(view)
    v = S.vehicle_camera(st)
    assert v["where"] == where and word in v["still"]
    assert "slides round 180 degrees" in v["motion"] and "the street whips round the frame" in v["motion"]
    r = compile_look(_look(), st)
    assert word in r["motion_prompt"] and "road vibration" in r["motion_prompt"]
    assert not FORBIDDEN.search(r["still_prompt"] + r["motion_prompt"])
    if where == "wheel":   # the tyre and the flank are in frame: the car words, and the spray beside the lens
        assert "just above and outside the front wheel" in v["still"]
        assert "spray and mist peeling off the tyre right beside the lens" in v["motion"]
        assert "the wheels a motion-blurred disc" in r["still_prompt"]


def test_ride_words_by_placement_and_road():
    st, _ = _jturn("wet")
    car = next(a for a in st["actors"] if a["id"] == "sports_car")
    assert "beside the lens" in ST.ride_words(car, "sports car", wet=True, where="wheel")
    assert "past the windows" in ST.ride_words(car, "sports car", wet=True, where="interior")
    assert "past the hood" in ST.ride_words(car, "sports car", wet=True, where="hood", framing="windshield")
    assert not re.search(r"spray|smoke", ST.ride_words(car, "sports car", wet=True, where="bumper"))
    dry = {**car, "stunt_sim": {"surface": "dry"}}
    assert "white tyre smoke billowing past the windows" in ST.ride_words(dry, "sports car", wet=False, where="interior")


def test_desert_and_snow_never_say_asphalt():
    st, _ = _jturn("wet")
    desert = copy.deepcopy(st)
    desert["environment"] = {**(desert.get("environment") or {}), "set": "desert", "weather": "none"}
    assert S.look_surface(desert) == "dirt" and S.location(desert)["weather"] == ""
    r = compile_look(_look(), desert)
    bad = re.compile(r"asphalt|tarmac|wet-down|spray and mist")
    for text in (r["still_prompt"], r["motion_prompt"]):
        assert not bad.search(text), bad.search(text).group(0)
        assert "dust and grit" in text
    snow = copy.deepcopy(st)
    snow["environment"] = {**(snow.get("environment") or {}), "weather": "snow"}
    for a in snow["actors"]:
        a.pop("stunt_sim", None)
    assert S.look_surface(snow) == "snow"
    r = compile_look(_look(), snow)
    for text in (r["still_prompt"], r["motion_prompt"]):
        assert not re.search(r"wet-down|dry asphalt|heat shimmer|white tyre smoke", text)
        assert "snow and slush" in text


def test_background_streaks_only_when_the_camera_pans():
    st, car = _jturn("wet")
    # The fixture's 85 mm pan from 54 m away: no speed lines on frame 1.
    assert S.camera_blur(st, 0, 12) in ("locked", "slow")
    r = compile_look(_look(), st)
    assert "horizontal streaks" not in r["still_prompt"]
    # A 135 mm panning with the car from 12 m off its path: the background streaks.
    frames, _ = S.frame_range(st)
    last = frames - 1
    zs = [S._pos_at(car, f, last)[2] for f in range(0, frames, 6)]
    base = [12.0, 1.2, (min(zs) + max(zs)) / 2]
    keys = []
    for f in list(range(0, last, 6)) + [last]:
        p = S._pos_at(car, f, last)
        keys.append({"frame": f, "position": base, "target": [p[0], 0.6, p[2]], "focal_mm": 135})
    st["shots"][0]["camera_keys"] = keys
    st["camera_keys"] = keys
    assert S.camera_blur(st) == "fast"
    r = compile_look(_look(), st)
    assert "the background streaks past as the camera pans with the car" in r["motion_prompt"]


def test_road_wet_alone_says_the_road_is_wet():
    """The stunt's Road: Wet used to drive only the clay spray; now the prompts say it too, with no rain."""
    st, _ = _jturn("wet")
    assert S.road_surface(st) == "wet"
    assert S.location(st)["weather"] == S.WET_ROAD_WORDS
    r = compile_look({"film_stock": "kodak_500t"}, st)
    assert "wet-down asphalt road" in r["still_prompt"] and "spray and mist" in r["motion_prompt"]
    assert not re.search(r"\brain\b", r["still_prompt"] + r["motion_prompt"])
    st2, _ = _jturn(None)
    assert S.road_surface(st2) is None and S.location(st2)["weather"] == ""
