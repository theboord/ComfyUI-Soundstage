"""Advisor end-to-end on three sample scenes, plus the geometry, coverage and LLM-repair paths."""
import json
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.cine import geometry  # noqa: E402
from soundstage.cine.advisor import advise, stage_cameras  # noqa: E402
from soundstage.cine.coverage import check_coverage  # noqa: E402
from soundstage.cine.kb import get_kb  # noqa: E402
from soundstage.cine.llm import advise_llm, parse_draft  # noqa: E402
from soundstage.cine.schema import SHOT_LIST_SCHEMA, validate  # noqa: E402

STANDOFF = "Two gunfighters face off in a dusty street at noon. Neither will back down."
DATE = "A first date in a diner. She is nervous; he talks too much."
DETECTIVE = "A detective alone in a rain-soaked office at night, nursing a whiskey."


@pytest.fixture(scope="module")
def standoff():
    return advise(STANDOFF)


@pytest.fixture(scope="module")
def date():
    return advise(DATE)


@pytest.fixture(scope="module")
def detective():
    return advise(DETECTIVE)


@pytest.mark.parametrize("scene", [STANDOFF, DATE, DETECTIVE])
def test_shot_list_matches_schema(scene):
    sl = advise(scene)
    assert validate(sl, SHOT_LIST_SCHEMA) == []
    json.dumps(sl)  # serialisable


def test_standoff_uses_the_spaghetti_standoff(standoff):
    assert standoff["recipe"]["from"] == "technique.spaghetti_standoff"
    sizes = [s["size"] for s in standoff["shots"]]
    assert sizes[0] == "EWS"                       # arena first
    assert "COWBOY" in sizes and "ECU" in sizes and "INSERT" in sizes
    assert sizes[-1] == "WS"                       # the draw goes back wide
    durations = [s["duration"]["seconds"] for s in standoff["shots"][2:8]]
    assert durations[-1] < durations[0]            # accelerating cut
    assert len(standoff["cast"]) == 2
    assert standoff["coverage_check"]["line_crossings"] == []


def test_date_is_a_seated_two_hander(date):
    assert len(date["cast"]) == 2
    assert date["location"]["seated"] and date["location"]["int_ext"] == "INT"
    assert date["recipe"]["from"] in ("emotion.romance", "emotion.intimacy", "coverage.table_scene", "genre.romantic_comedy")
    assert any(s["framing"] in ("fifty_fifty", "two_shot", "ots", "master") for s in date["shots"])
    assert date["coverage_check"]["verdict"] != "fail"


def test_detective_is_a_solo_isolation_scene(detective):
    assert len(detective["cast"]) == 1
    assert detective["intents"][0] == "isolation"
    assert "emotion.isolation" in {r for s in detective["shots"] for r in s["rationale"]["kb_refs"]}
    assert detective["location"]["time_of_day"] == "night"
    for s in detective["shots"]:   # an office, not a landscape: cameras stay inside a room
        assert s["camera3d"]["position"][1] <= 3.01
        assert s["camera3d"]["distance_m"] < 12


@pytest.mark.parametrize("scene", [STANDOFF, DATE, DETECTIVE])
def test_every_shot_is_complete(scene):
    sl = advise(scene)
    for s in sl["shots"]:
        assert len(s["rationale"]["why"]) > 60
        assert s["rationale"]["kb_refs"] and all(r in get_kb().by_id for r in s["rationale"]["kb_refs"])
        assert s["duration"]["frames"] % 8 == 1
        c = s["camera3d"]
        assert len(c["position"]) == 3 and len(c["target"]) == 3 and c["focal_mm"] >= 8
        assert c["end"]["focal_mm"] >= 8
        assert "still_negative" in s["prompts"]
        # the look still describes frame 1 only: no camera-move verbs
        assert not any(v in s["prompts"]["still"].lower()
                       for v in ("pushes in", "pulls back", "the camera pushes", "tracks", "pans", "as the move"))
        assert s["prompts"]["ltx"].split()[0] in ("Interior", "Exterior")


def test_camera3d_matches_the_stage_scene_shape(standoff):
    cams = stage_cameras(standoff["shots"][0])
    assert set(cams) == {"camera", "camera_end"}
    assert set(cams["camera"]) == {"position", "target", "focal_mm"}


def test_moves_produce_an_end_camera(standoff):
    push = next(s for s in standoff["shots"] if s["movement"]["id"] == "dolly_in")
    start, end = push["camera3d"]["position"], push["camera3d"]["end"]["position"]
    tgt = push["camera3d"]["target"]
    assert math.dist(end, tgt) < math.dist(start, tgt)


def test_framing_math_matches_lens():
    # a 0.30 m close-up on a 35mm full-frame lens at the stage aspect sits ~0.55 m away
    d = geometry.distance_for_height(0.30, 35)
    assert abs(d - 0.30 * 35 / 19.2) < 1e-9
    assert abs(geometry.vfov_deg(50) - 2 * math.degrees(math.atan(19.2 / 100))) < 1e-9
    assert [geometry.legal_frames(s, 24) for s in (1, 4, 6)] == [25, 97, 145]


def test_ecu_actually_frames_the_eyes(standoff):
    ecu = next(s for s in standoff["shots"] if s["size"] == "ECU")
    a = standoff["cast"][0] if ecu["subject"] == "A" else standoff["cast"][1]
    c = ecu["camera3d"]
    eye = (a["position"][0], 1.69, a["position"][2])
    sx, sy = geometry.project(eye, c["position"], c["target"], c["focal_mm"])
    assert abs(sx) < 0.2 and abs(sy) < 0.3


def test_stage_scene_positions_are_used():
    scene = {"actors": [{"id": "actor_a", "position": [-3, 0, 2], "height_m": 1.8},
                        {"id": "actor_b", "position": [3, 0, 2], "height_m": 1.7}]}
    sl = advise(STANDOFF, stage_scene=scene)
    assert sl["cast"][0]["position"] == [-3.0, 0.0, 2.0]
    assert validate(sl, SHOT_LIST_SCHEMA) == []


def test_explicit_picks_win_and_blend():
    sl = advise(DATE, picks={"movement": "movement.french_new_wave", "technique": "none"})
    assert sl["picks"]["movement"].endswith("[movement.french_new_wave]")
    lo, hi = get_kb().by_id["movement.french_new_wave"]["signature"]["lens_mm_ff"]
    for s in sl["shots"]:
        if s["size"] not in ("EWS", "INSERT") and s["framing"] != "ots":
            assert lo <= s["lens"]["focal_mm_ff"] <= hi


def test_max_shots_keeps_first_and_last(standoff):
    sl = advise(STANDOFF, max_shots=4)
    assert len(sl["shots"]) == 4
    assert sl["shots"][0]["size"] == "EWS" and sl["shots"][-1]["purpose"] == standoff["shots"][-1]["purpose"]


def test_advisor_is_deterministic():
    assert json.dumps(advise(STANDOFF)) == json.dumps(advise(STANDOFF))


# ---- Coverage Doctor ---------------------------------------------------------------------------


def _mirror_z(p):
    return [p[0], p[1], -p[2]]


def test_doctor_flags_a_line_jump(standoff):
    sl = json.loads(json.dumps(standoff))
    bad = sl["shots"][3]            # B's cowboy single, moved to the far side of the line
    bad["camera3d"]["position"] = _mirror_z(bad["camera3d"]["position"])
    bad["camera3d"]["target"] = _mirror_z(bad["camera3d"]["target"])
    bad["camera3d"]["end"]["position"] = _mirror_z(bad["camera3d"]["end"]["position"])
    result = check_coverage(sl)
    assert result["verdict"] == "fail"
    assert any("Shot 4" in w for w in result["line_crossings"])


def test_doctor_flags_a_thirty_degree_jump(standoff):
    sl = json.loads(json.dumps(standoff))
    dup = json.loads(json.dumps(sl["shots"][2]))
    dup["shot_id"] = "3b"
    dup["camera3d"]["position"][0] += 0.1
    sl["shots"].insert(3, dup)
    assert check_coverage(sl)["thirty_degree_warnings"]


def test_doctor_flags_closeup_before_geography(standoff):
    sl = json.loads(json.dumps(standoff))
    sl["shots"] = [s for s in sl["shots"] if s["size"] not in ("EWS", "WS")]
    assert check_coverage(sl)["geography"]


def test_doctor_flags_bad_frame_counts(standoff):
    sl = json.loads(json.dumps(standoff))
    sl["shots"][0]["duration"]["frames"] = 100
    assert any("8k+1" in w for w in check_coverage(sl)["ltx"])


# ---- LLM paths (no network) --------------------------------------------------------------------


def test_llm_draft_is_repaired_and_recomputed():
    draft = """```json
    {"shots": [
      {"purpose": "the whole office, one lamp on", "subject": "env", "size": "extreme wide", "framing": "establishing",
       "angle": "high angle", "height": "high", "lens_mm_ff": 21, "movement": "locked off", "duration_s": 5,
       "why": "Starting tiny in a dark room tells the audience the detective has nobody left.", "kb_refs": ["emotion.isolation", "bogus.id"]},
      {"purpose": "slow push on the detective's face", "subject": "A", "size": "close-up", "angle": "eye level",
       "lens_mm_ff": 85, "movement": "push in", "speed": "slow", "duration_s": 6, "why": "The push lands the thought."},
      {"purpose": "nonsense", "size": "gigantic"}
    ]}
    ```"""
    templates, whys, refs, notes = parse_draft(draft, set(get_kb().by_id))
    assert [t["size"] for t in templates] == ["EWS", "CU"]
    assert templates[0]["movement"] == "static" and templates[1]["movement"] == "dolly_in"
    assert refs[0] == ["emotion.isolation"]
    sl = advise_llm(DETECTIVE, backend="llm_draft", llm_draft=draft)
    assert sl["backend"] == "llm_draft"
    assert validate(sl, SHOT_LIST_SCHEMA) == []
    assert sl["shots"][0]["rationale"]["why"].startswith("Starting tiny")


def test_llm_failure_falls_back_to_rules():
    sl = advise_llm(STANDOFF, backend="ollama", url="http://127.0.0.1:9", timeout=1.0)
    assert sl["backend"] == "rules"
    assert "failed" in sl["notes"][0]
    assert sl["recipe"]["from"] == "technique.spaghetti_standoff"


def test_garbage_draft_falls_back_to_rules():
    sl = advise_llm(DATE, backend="llm_draft", llm_draft="I think you should shoot it nicely.")
    assert sl["backend"] == "rules" and validate(sl, SHOT_LIST_SCHEMA) == []


def test_three_way_standoff_keeps_its_geometry():
    sl = advise("Three gunmen in a mexican standoff in a cemetery.")
    assert len(sl["cast"]) == 3
    assert sl["recipe"]["from"] == "technique.three_way_standoff"
    assert sl["coverage_check"]["line_crossings"] == [] and sl["coverage_check"]["verdict"] != "fail"
    assert validate(sl, SHOT_LIST_SCHEMA) == []


# ---- action vs comedy recipe matching (regression: a horse getaway once got the pratfall recipe) --------

HORSES = ("A man and a woman sprint to two horses, vault into the saddles and gallop away across the desert "
          "at magic hour. Action.")
ACTION = [
    HORSES,
    "Two thieves flee the bank and sprint down an alley as police give chase.",
    "A rider gallops across the plains at sunset, chased by bandits.",
    "Action: the getaway driver races through the city at night with the cops on his tail.",
    "A woman escapes the burning warehouse and runs for the car.",
    "Two soldiers run across the battlefield under fire to reach the helicopter.",
]
COMEDY = [
    ("Sitcom: two roommates argue on the couch until a neighbor bursts through the front door.", None),
    ("A waiter carries a tray of drinks across a party and slips in front of his date. Slapstick.", None),
    ("A deadpan comedy scene: two estranged siblings sit on a bench and discuss something absurd.", None),
]


def _is_comic(entry_id):
    e = get_kb().by_id[entry_id]
    return e["intent_tags"][0] == "comedy" or entry_id in ("technique.planimetric_deadpan",)


def test_horse_getaway_gets_mount_up_coverage():
    sl = advise(HORSES)
    assert sl["recipe"]["from"] == "coverage.chase_escape" and sl["recipe"]["name"] == "Mount up and ride off"
    assert "energy" in sl["intents"]
    sizes = [s["size"] for s in sl["shots"]]
    assert sizes[0] == "EWS" and sizes[-1] == "EWS" and "INSERT" in sizes
    assert any(s["movement"]["id"].startswith("truck") for s in sl["shots"])
    # both riders travel one way: every visible side-on rider faces the same screen direction
    facings = {b["facing"] for s in sl["shots"] for b in s["blocking"]["subjects"]
               if b["visible"] and b["facing"].startswith("facing screen")}
    assert len(facings) == 1
    # the gallop-away wide watches them go
    assert all(b["facing"] != "facing the camera" for b in sl["shots"][-1]["blocking"]["subjects"] if b["visible"])
    assert sl["coverage_check"]["line_crossings"] == []


@pytest.mark.parametrize("scene", ACTION)
def test_action_prompts_never_get_comedy(scene):
    sl = advise(scene)
    assert not _is_comic(sl["recipe"]["from"]), (scene, sl["recipe"])
    assert "energy" in sl["intents"] or "chaos" in sl["intents"]
    assert validate(sl, SHOT_LIST_SCHEMA) == []


@pytest.mark.parametrize("scene,_", COMEDY)
def test_comedy_prompts_still_get_comedy(scene, _):
    sl = advise(scene)
    assert _is_comic(sl["recipe"]["from"]), (scene, sl["recipe"])


def test_comedy_never_wins_on_shared_words_alone():
    sl = advise("A man and a woman stand in a field.")
    assert not _is_comic(sl["recipe"]["from"])
