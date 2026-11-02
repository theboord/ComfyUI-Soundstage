"""④ Frame follows the stage exactly (soundstage/look/frame_lock.py, takecheck/framecheck.py, the Klein adapter) and
head / gaze blocking in words (soundstage/look/gaze.py, the Director and Pitch tools)."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.look import frame_lock as FL  # noqa: E402
from soundstage.look import gaze as GZ  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.takecheck import framecheck as FC  # noqa: E402

# ---- the ID pass in words -----------------------------------------------------------------------------------------

COLORS = {"car": [255, 0, 0], "driver": [0, 255, 0], "cop": [0, 0, 255], "tiny": [255, 255, 0], "rider": [255, 0, 255]}


def _paint(h=100, w=200, boxes=None, srgb=False):
    img = np.zeros((h, w, 3), np.float32)
    for aid, (x0, y0, x1, y1) in (boxes or {}).items():
        c = np.asarray(COLORS[aid], np.float32) / 255
        img[y0:y1, x0:x1] = FL._srgb(c) if srgb else c
    return img


def test_id_masks_read_both_encodings_and_ignore_black():
    for srgb in (False, True):
        m = FL.id_masks(_paint(boxes={"car": (10, 10, 50, 40)}, srgb=srgb), COLORS)
        assert set(m) == {"car"} and int(m["car"].sum()) == 40 * 30


def test_layout_merges_a_seated_driver_into_the_car_and_skips_specks():
    scene = {"id_colors": COLORS, "actors": [{"id": "car"}, {"id": "driver", "mount_id": "car"}, {"id": "tiny"},
                                             {"id": "rider", "mount_id": "car", "mount_at": 40}]}
    img = _paint(boxes={"car": (20, 40, 140, 90), "driver": (60, 30, 80, 45), "tiny": (190, 0, 191, 1),
                        "rider": (150, 10, 160, 30)})
    lay = FL.frame1_layout(img, scene)
    assert lay["car"]["box"] == [0.1, 0.3, 0.7, 0.9]          # the driver's head pokes above the roof: in the car's box
    assert "tiny" not in lay
    assert lay["rider"]["box"][0] == 0.75                      # a timed mount is still on foot at frame 1
    assert lay["car"]["box"][2] < 0.75


def test_layout_words():
    assert FL.frac_words(0.58) == "two thirds of the" and FL.frac_words(0.12) == "a tenth of the"
    assert FL.where_words([0.14, 0.3, 0.72, 0.84]) == "in the centre of frame"
    assert FL.where_words([0.66, 0.35, 0.79, 0.51]) == "in the right third of frame"
    assert FL.size_words([0.14, 0.3, 0.72, 0.84], tall=False).startswith("close to the camera, two thirds of the frame wide")
    assert FL.size_words([0.66, 0.35, 0.79, 0.51], tall=False).startswith("small in the distance")
    man = FL.size_words([0.53, 0.27, 0.73, 1.0], tall=True)
    assert "close to the camera" in man and "cut off by the bottom of frame" in man
    assert FL.stage_denoise(None) == 1.0 and FL.stage_denoise(0.1) == FL.MIN_DENOISE and FL.stage_denoise("0.75") == 0.75


def _chase_scene(layout=None, look_start=True):
    scene = {
        "environment": {"set": "street_night"}, "shot": {"frames": 49, "fps": 24},
        "camera": {"position": [0, 1.4, -6], "target": [0, 0.8, 0], "focal_mm": 30},
        "actors": [{"id": "car", "kind": "sports_car", "position": [0, 0, 0], "rotation_deg": 180, "height_m": 1.3},
                   {"id": "cop", "kind": "police_car", "position": [4, 0, 25], "rotation_deg": 180, "height_m": 1.5}],
    }
    if layout:
        scene["frame1_layout"] = layout
    if not look_start:
        scene["look_start"] = False
    return scene


def test_still_prompt_states_the_measured_layout():
    lay = {"car": {"box": [0.14, 0.3, 0.72, 0.84]}, "cop": {"box": [0.66, 0.35, 0.79, 0.51]}}
    before = compile_look({}, _chase_scene())["still_prompt"]
    after = compile_look({}, _chase_scene(lay))["still_prompt"]
    assert "close to the camera, two thirds of the frame wide" in after
    assert "small in the distance, a tenth of the frame wide" in after
    assert "close to the camera" not in before
    # a frame picked before the lock (look_start false) compiles exactly as it did
    assert compile_look({}, _chase_scene(lay, look_start=False))["still_prompt"] == \
        compile_look({}, _chase_scene(None, look_start=False))["still_prompt"]


# ---- the Klein adapter --------------------------------------------------------------------------------------------

def _klein(params, control=True):
    from soundstage.router import adapters as A
    from tests.test_router_adapters import FakeGraph, base_p, link, WIRED
    m = next(x for x in WIRED if x["id"] == "open.flux3_klein")
    p = base_p(m, "edit_image", image=link("img"), **({"control": link("ctrl")} if control else {}))
    p["params"] = {**p["params"], **params}
    g = FakeGraph()
    A.ADAPTERS["flux3_klein"](g, m, p)
    ks = next(n for n in g.nodes.values() if n.class_type == "KSampler")
    return g, ks


def test_klein_frame_starts_from_the_color_pass_at_stage_denoise():
    g, ks = _klein({"stage_denoise": 0.9})
    enc = [n for n in g.nodes.values() if n.class_type == "VAEEncode"]
    assert len(enc) == 1 and ks.inputs["denoise"] == 0.9 and ks.inputs["latent_image"] == enc[0].out(0)
    scales = [n.inputs["scale_by"] for n in g.nodes.values() if n.class_type == "ImageScaleBy"]
    assert scales == [1 / FL.INIT_DOWN, 8, FL.INIT_DOWN / 8]                  # the start is the layout only, not the clay
    # 1.0 (frames picked before) and Klein edits without the stage depth (Paint Studio, refs) stay as they were
    for params, ctrl in (({"stage_denoise": 1.0}, True), ({}, True), ({"stage_denoise": 0.75}, False)):
        g, ks = _klein(params, ctrl)
        assert ks.inputs["denoise"] == 1.0 and not any(n.class_type == "VAEEncode" for n in g.nodes.values())


# ---- the first-frame check ----------------------------------------------------------------------------------------

def _box(x0, y0, x1, y1, h=100, w=200):
    m = np.zeros((h, w), bool)
    m[y0:y1, x0:x1] = True
    return m


STAGE = {"car": {"mask": _box(20, 30, 140, 90), "kind": "car"}, "cop": {"mask": _box(150, 35, 175, 50), "kind": "car"},
         "man": {"mask": _box(180, 20, 190, 60), "kind": "person"}}


def test_check_ok_when_every_silhouette_matches():
    dets = [{"mask": _box(22, 32, 140, 88), "kind": "car", "score": 0.9}, {"mask": _box(150, 35, 176, 51), "kind": "car", "score": 0.8},
            {"mask": _box(180, 21, 190, 60), "kind": "person", "score": 0.7},
            {"mask": _box(60, 35, 75, 50), "kind": "person", "score": 0.8}]       # the driver behind the windscreen
    r = FC.score(STAGE, dets, {"car": "Sports car"})
    assert r["verdict"] == "ok" and r["extra"] == [] and r["score"] > 0.85
    assert r["counts"]["car"] == {"stage": 2, "frame": 2}
    assert FC.badge(r)["tone"] == "good"


def test_check_flags_a_ghost_car_and_a_missing_actor():
    dets = [{"mask": _box(22, 32, 140, 88), "kind": "car", "score": 0.9}, {"mask": _box(150, 35, 176, 51), "kind": "car", "score": 0.8},
            {"mask": _box(0, 10, 25, 30), "kind": "car", "score": 0.7}]            # a second red car behind the hero
    r = FC.score(STAGE, dets, {"car": "Sports car", "man": "Man"})
    assert r["verdict"] == "flag"
    assert [e["kind"] for e in r["extra"]] == ["car"] and r["missing"] == ["man"]
    assert r["why"].startswith("an extra car") and "Man missing" in r["why"]
    assert r["counts"]["car"] == {"stage": 2, "frame": 3}
    assert FC.badge(r) == {"text": "⚠ an extra car", "tone": "bad", "title": r["why"]}


def test_check_off_mark_loose_and_low_confidence():
    small = [{"mask": _box(100, 60, 130, 80), "kind": "car", "score": 0.9}]       # the hero car small and far
    r = FC.score({"car": STAGE["car"]}, small)
    assert r["verdict"] == "flag" and r["actors"][0]["status"] == "off"
    loose = [{"mask": _box(20, 30, 70, 90), "kind": "car", "score": 0.9}]
    assert FC.score({"car": STAGE["car"]}, loose)["verdict"] == "loose"
    faint = [{"mask": _box(22, 32, 140, 88), "kind": "car", "score": 0.9}, {"mask": _box(0, 0, 18, 20), "kind": "car", "score": 0.3}]
    assert FC.score({"car": STAGE["car"]}, faint)["verdict"] == "ok"
    on_prop = {**{"car": STAGE["car"]}, "_set": {"mask": _box(150, 0, 200, 100), "kind": "_set"}}
    parked = [{"mask": _box(22, 32, 140, 88), "kind": "car", "score": 0.9}, {"mask": _box(160, 40, 190, 60), "kind": "car", "score": 0.9}]
    assert FC.score(on_prop, parked)["verdict"] == "ok"                       # a staged set-piece car is not a ghost


# ---- gaze in words ------------------------------------------------------------------------------------------------

def _two_people(gaze_ben=None, ellie_walks=True):
    ben = {"id": "ben", "name": "Ben", "kind": "man", "position": [0.6, 0, 3], "rotation_deg": 180, "height_m": 1.8}
    if gaze_ben is not None:
        ben["gaze"] = gaze_ben
    ellie = {"id": "ellie", "name": "Ellie", "kind": "woman", "position": [-0.5, 0, 12], "rotation_deg": 180, "height_m": 1.65}
    if ellie_walks:
        ellie["keys"] = [{"frame": 0, "position": [-0.5, 0, 12]}, {"frame": 96, "position": [-0.5, 0, 5]}]
        ellie["position_end"] = [-0.5, 0, 5]
    return {"environment": {"set": "street_night"}, "shot": {"frames": 97, "fps": 24},
            "camera": {"position": [0, 1.6, 0], "target": [0, 1.4, 10], "focal_mm": 35}, "actors": [ben, ellie]}


def test_gaze_keys_legacy_and_sorted():
    assert GZ.gaze_keys({"gaze": [{"frame": 48, "target": "ellie"}, {"frame": 0, "target": "camera"}]})[0]["target"] == "camera"
    assert GZ.gaze_keys({"look_at": "b", "look_at_frame": 5, "look_until": 30}) == [{"frame": 5, "target": "b"}, {"frame": 30, "target": "ahead"}]
    assert GZ.gaze_keys({}) == []


def test_motion_prompt_says_every_head_beat_in_positive_words():
    m = compile_look({}, _two_people([{"frame": 48, "target": "ellie"}]))["motion_prompt"]
    assert "The man keeps his head steady, facing ahead; at 2.0 s he turns his head toward the woman and holds it there." in m
    assert "The woman keeps her head steady, looking where she is going." in m
    assert "don't" not in m.lower() and "no head" not in m.lower()
    steady = compile_look({}, _two_people())["motion_prompt"]
    assert "holds his head still, facing the same way throughout" in steady


def test_frame1_look_reaches_the_still():
    s = compile_look({}, _two_people([{"frame": 0, "target": "camera"}]))["still_prompt"]
    assert "the man looking straight into the camera" in s


def test_driver_keeps_eyes_on_the_road():
    assert GZ.person_sentence({}, {"kind": "woman"}, "a woman", True, True, 24) == \
        "the woman keeps her eyes on the road, her head steady from start to finish."
    keys = {"kind": "man", "gaze": [{"frame": 0, "target": "left"}, {"frame": 36, "target": "ahead"}]}
    assert GZ.person_sentence({}, keys, "a man", False, False, 24) == \
        "the man looks off to his left; at 1.5 s he turns his head back to face ahead and holds it there."


# ---- the Director and Pitch set gaze ------------------------------------------------------------------------------

DIRECTOR_SCENE = {"actors": [{"id": "ben", "name": "Ben", "kind": "man", "position": [0, 0, 0]},
                             {"id": "ellie", "name": "Ellie", "kind": "woman", "position": [2, 0, 2]}],
                  "shots": [{"id": "s1", "camera_keys": [{"frame": 0, "position": [0, 1.6, -5], "target": [0, 1, 0], "focal_mm": 35}]}],
                  "active_shot": "s1"}


@pytest.mark.parametrize("cmd,at,time", [("Ben looks at Ellie at 2 s", "ellie", 2.0), ("she turns her head toward the camera", "camera", None),
                                         ("Ben keeps his eyes on the road", "ahead", None), ("Ben looks left after 1.5 seconds", "left", 1.5)])
def test_director_gaze_tool(cmd, at, time):
    from soundstage.agent import director as D
    calls = D.plan(cmd, DIRECTOR_SCENE, {})["calls"]
    assert [c["tool"] for c in calls] == ["gaze"]
    a = calls[0]["args"]
    assert a["at_id"] == at and a.get("time") == time


def test_director_note_is_not_a_look():
    from soundstage.agent import director as D
    assert [c["tool"] for c in D.plan("Ellie looks scared", DIRECTOR_SCENE, {})["calls"]] == ["direct"]
    with pytest.raises(D.Invalid):
        D.validate_call({"tool": "gaze", "who": "Ben", "at": "Ben"}, D.normalize_scene(DIRECTOR_SCENE), {})


def test_pitch_hears_a_look_and_keys_it():
    from soundstage.agent import pitch as PT
    assert PT.extract("She looks at the camera at 2 seconds.") == {"gaze": {"at": "camera", "time": 2.0}}
    assert PT.extract("He keeps his eyes on the road.") == {"gaze": {"at": "ahead"}}      # not a road set
    mem = PT.new_memory()
    out = PT.beat("A detective stands in a rainy alley.", {"actors": [], "environment": {"set": "empty"}}, mem)
    scene, mem, ids = out["scene"], out["memory"], out["ids"]
    out = PT.beat("He looks into the camera at 1.5 seconds.", scene, mem, ids)
    det = next(a for a in out["scene"]["actors"] if a["id"] == ids["detective"])
    assert det["gaze"] == [{"frame": 36, "target": "camera"}]


def test_check_moved_actor_is_off_its_mark_not_missing_plus_extra():
    moved = [{"mask": _box(0, 20, 12, 60), "kind": "person", "score": 0.8}]     # the man, stood somewhere else
    r = FC.score({"man": STAGE["man"]}, moved, {"man": "Man"})
    assert r["verdict"] == "flag" and r["extra"] == [] and r["actors"][0]["status"] == "off"
    assert r["why"] == "Man off its mark" and r["counts"]["person"] == {"stage": 1, "frame": 1}
