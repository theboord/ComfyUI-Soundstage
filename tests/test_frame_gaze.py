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


# ---- the crate crash's ghost car: the ID pass read without inventing objects ----------------------------------------
# The stage canvas is antialiased: a 1-px seam between the yellow and green crates is a blend, and 3/4 yellow + 1/4
# green IS the sports car's ID colour. Nearest-colour labelling gave the far sports car a box over the whole crate
# pyramid, the still prompt said "close to the camera, half the frame wide" and Klein painted a ghost red car (M27,
# M28). Fixtures: frame 1 of the M27 render's own ID pass and its scene (share/GhostCar_DetailLoss).

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "framelock_fixtures")
CRASH = {"crate_6": [234, 255, 0], "crate_3": [11, 255, 0], "sports_car": [149, 255, 0]}   # the crash's real ID colours


def _crate_crash():
    import json
    from PIL import Image
    with open(os.path.join(FIX, "crate_crash_scene.json")) as f:
        d = json.load(f)
    ids = np.asarray(Image.open(os.path.join(FIX, "crate_crash_id_f1.png")).convert("RGB")).astype(np.float32) / 255
    return d["look"], d["scene"], ids


def _msaa(boxes, colors, h=100, w=200, s=4):
    """An antialiased ID pass: flat boxes drawn s x s supersampled (edges at sub-pixel places), averaged down and
    written as sRGB, the way the stage's WebGL canvas does it."""
    hi = np.zeros((h * s, w * s, 3), np.float32)
    for aid, (x0, y0, x1, y1) in boxes.items():
        hi[round(y0 * s):round(y1 * s), round(x0 * s):round(x1 * s)] = FL._srgb(np.asarray(colors[aid], np.float32) / 255)
    return hi.reshape(h, s, w, s, 3).mean((1, 3))


def test_an_antialiased_seam_never_seeds_a_third_object():
    img = _msaa({"crate_6": (40, 40, 70.75, 70), "crate_3": (70.75, 40, 100, 70), "sports_car": (170, 45, 182, 51)}, CRASH)
    seam = img[50, 70] * 255
    assert np.abs(seam - FL._srgb(np.asarray(CRASH["sports_car"], np.float32) / 255) * 255).max() < 4   # the trap is real
    m = FL.id_masks(img, CRASH)
    ys, xs = np.nonzero(m["sports_car"])
    assert xs.min() >= 169 and ys.min() >= 44                     # only the far car, nothing on the crates
    assert m["crate_6"][45:65, 70].all() or m["crate_3"][45:65, 70].all()   # the seam goes to a crate it borders
    lay = FL.frame1_layout(img, {"id_colors": CRASH, "actors": [{"id": k} for k in CRASH]})
    assert lay["sports_car"]["box"] == [0.85, 0.45, 0.91, 0.51]
    assert lay["crate_6"]["box"][2] <= 0.355 and lay["crate_3"]["box"][0] >= 0.35


def test_crate_crash_frame1_is_measured_as_staged_and_the_prompt_keeps_the_car_far():
    look, scene, ids = _crate_crash()
    lay = FL.frame1_layout(ids, scene)
    car = lay["sports_car"]["box"]
    assert car[0] > 0.8 and car[2] - car[0] < 0.08 and car[3] - car[1] < 0.1      # far down the street, by the pole
    pyramid = FL.union([lay[f"crate_{i}"]["box"] for i in range(10)])
    assert pyramid[0] > 0.3 and pyramid[2] < 0.65                                  # every crate stays in the pyramid
    assert all(lay[f"crate_{i}"]["box"][2] - lay[f"crate_{i}"]["box"][0] < 0.1 for i in range(10))
    still = compile_look(look, {**scene, "frame1_layout": lay})["still_prompt"]
    assert "a sports car on the right edge of frame, small in the distance" in still
    assert "close to the camera" not in still and "half the frame wide" not in still


def test_layout_drops_a_box_its_own_pixels_do_not_fill():
    img = _paint()
    img[0:8, 0:8] = np.asarray(COLORS["car"], np.float32) / 255          # two solid specks of one ID colour at
    img[90:98, 190:198] = np.asarray(COLORS["car"], np.float32) / 255     # opposite corners: no object a box describes
    assert "car" not in FL.frame1_layout(img, {"id_colors": COLORS, "actors": [{"id": "car"}]})


def test_check_flags_ghost_cars_on_the_crate_crash():
    look, scene, ids = _crate_crash()
    stage, names = FC.stage_silhouettes(ids, scene)
    pyramid = np.zeros(ids.shape[:2], bool)
    for k, m in FL.id_masks(ids, scene["id_colors"]).items():
        if k.startswith("crate_"):
            pyramid |= m
    assert stage["sports_car"]["kind"] == "car" and not any(k.startswith("crate_") for k in stage)
    assert not (stage.get("_set", {}).get("mask", np.zeros_like(pyramid)) & pyramid).any()   # crates excuse no car
    far = {"mask": stage["sports_car"]["mask"].copy(), "kind": "car", "score": 0.8}
    on_crates = {"mask": _box(300, 130, 560, 350, h=512, w=960), "kind": "car", "score": 0.9}   # M28: over the pyramid
    parked = {"mask": _box(470, 200, 700, 330, h=512, w=960), "kind": "car", "score": 0.9}      # M27: right foreground
    ok = FC.score(stage, [far], names)
    assert ok["verdict"] == "ok" and ok["counts"]["car"]["frame"] == ok["counts"]["car"]["stage"]
    both = FC.score(stage, [far, on_crates], names)
    assert both["verdict"] == "flag" and [e["kind"] for e in both["extra"]] == ["car"] and both["why"].startswith("an extra car")
    moved = FC.score(stage, [parked], names)                       # the far car painted big and near
    assert moved["verdict"] == "flag" and moved["actors"][0]["status"] == "off"
    assert FC.score(stage, [far, parked], names)["verdict"] == "flag"


def test_set_piece_people_animals_and_cars_still_excuse_their_own_pixels():
    scene = {"id_colors": {"hero": [255, 0, 0], "parked": [0, 0, 255], "crate": [0, 255, 0]},
             "actors": [{"id": "hero", "kind": "sports_car", "position": [0, 0, 0]},
                        {"id": "parked", "kind": "hatchback", "set_piece": True, "position": [5, 0, 5]},
                        {"id": "crate", "kind": "crate", "position": [2, 0, 2]}]}
    img = np.zeros((100, 200, 3), np.float32)
    img[40:80, 10:90] = [1, 0, 0]
    img[30:60, 120:190] = [0, 0, 1]
    img[70:95, 100:140] = [0, 1, 0]
    stage, _ = FC.stage_silhouettes(img, scene)
    assert stage["_set"]["mask"][30:60, 120:190].all() and not stage["_set"]["mask"][70:95, 100:140].any()
    hero = {"mask": stage["hero"]["mask"].copy(), "kind": "car", "score": 0.9}
    assert FC.score(stage, [hero, {"mask": _box(121, 31, 189, 59), "kind": "car", "score": 0.9}])["verdict"] == "ok"
    assert FC.score(stage, [hero, {"mask": _box(100, 66, 140, 96), "kind": "car", "score": 0.9}])["verdict"] == "flag"
