"""C28: the measured cinematic first-frame words (Jon's RTX 5080 sweep through ④ Frame, outbox claude_C28.md).

The still opens with a concrete camera block (body, lens and stop, depth of field, stock, grain, halation, a slight edge
softness, light motivated by the set) instead of "cinematic film still"; a skin and fabric tail names the clothes the
people phrase already gave; the negative is the short one of variant (d); "slight vignetting" only at 12+ steps; the
Look's edit_prompt is variant (e) for FLUX Klein. The people phrase is exactly what the compiler wrote before C28.

Run:  python -m pytest tests/test_c28_camera_block.py -q
"""
import copy
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.look import compile as C  # noqa: E402
from soundstage.look import scene as S  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402
from soundstage.look.default_scene import DEFAULT_SCENE  # noqa: E402
from soundstage.look.identity import wardrobe  # noqa: E402
from soundstage.look.vocab import load_vocab  # noqa: E402


def t4_like(**kw):
    """One woman in a floor-plan room with a window and a door, at night: the shape of C28's T4 scene."""
    sc = copy.deepcopy(DEFAULT_SCENE)
    sc["actors"] = [a for a in sc["actors"] if a["kind"] == "woman"]
    sc["actors"][0]["position"] = [1.5, 0, -6]
    sc["environment"]["set"] = "empty"
    sc["props"] = []
    sc["interior"] = {"rooms": [{"name": "Room", "x": 0, "z": 0, "w": 10, "d": 30}],
                      "openings": [{"type": "window", "room": "Room", "wall": "N"},
                                   {"type": "door", "room": "Room", "wall": "S"}]}
    sc["sun"] = {"azimuth_deg": 200, "elevation_deg": -20}
    sc.update(kw)
    return sc


BLOCK_D = ("photograph shot on an ARRI Alexa 35 with a 35mm Cooke S4 prime lens at T2, shallow depth of field, focus on "
           "the subject, the back wall softly out of focus, Kodak Vision3 500T film stock, fine visible film grain, "
           "gentle halation around the bright window, slight vignetting and softness at the frame edges, motivated "
           "light: cool moonlight through the window as the key")


def test_the_camera_block_replaces_cinematic_film_still():
    still = compile_look({}, t4_like())["still_prompt"]
    assert still.startswith(BLOCK_D), still
    assert "cinematic film still" not in still
    assert "deep natural shadows" in still
    # the lens is said once, in the block: no separate "35mm lens"
    assert "35mm lens" not in still


def test_banned_words_never_appear_for_any_body_stock_or_lens():
    v = load_vocab()
    banned = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in C.BANNED_WORDS) + r")\b", re.I)
    looks = [{}] + [{"camera_body": o["id"]} for o in v["camera_bodies"]] + \
        [{"film_stock": o["id"]} for o in v["film_stocks"]] + [{"lens": o["id"]} for o in v["lenses"]]
    for look in looks:
        for sc in (t4_like(), copy.deepcopy(DEFAULT_SCENE)):
            r = compile_look(look, sc)
            for k in ("still_prompt", "edit_prompt", "still_negative"):
                assert not banned.search(r[k]), (look, k, banned.search(r[k]).group(0))


def test_the_people_phrase_is_exactly_the_compilers():
    sc = t4_like()
    still = compile_look({}, sc)["still_prompt"]
    f1 = S.frame1_facts(sc)
    by_id = {a["id"]: a for a in sc["actors"]}
    phrase = S.person_still_phrase(f1["people"], f1["camera"], lambda e: wardrobe(sc, by_id[e["id"]], {}))
    assert phrase == ("exactly one woman, full figure, small in frame, standing at the left third, mid-distance, seen "
                      "from behind, with their back to the camera, wearing a pink button-up shirt with rolled-up "
                      "sleeves, blue jeans and dark shoes, fully clothed")
    assert still.count(phrase) == 1
    assert len(re.findall(r"\bwoman\b", still)) == 1, "the block never names the person again (focus on the subject)"


def test_two_people_still_said_once_each():
    still = compile_look({}, copy.deepcopy(DEFAULT_SCENE))["still_prompt"]
    assert len(re.findall(r"\bman\b", still)) == 1 and len(re.findall(r"\bwoman\b", still)) == 1


@pytest.mark.parametrize("steps,vignette", [(None, True), (12, True), (16, True), (8, False), (6, False)])
def test_slight_vignetting_only_at_12_steps_or_more(steps, vignette):
    look = {} if steps is None else {"frame_steps": steps}
    r = compile_look(look, t4_like())
    assert ("vignetting" in r["still_prompt"]) is vignette
    assert ("vignetting" in r["edit_prompt"]) is vignette
    assert "softness at the frame edges" in r["still_prompt"]          # the edge softness stays either way


def test_skin_and_fabric_tail_names_the_clothes_already_given():
    still = compile_look({}, t4_like())["still_prompt"]
    assert still.endswith("real skin texture with pores and fine lines, visible fabric weave and creases in the shirt and jeans")
    assert "real actors, natural skin texture" in still     # the Milestone 5 words stay too
    empty = t4_like(actors=[])
    assert "fabric weave" not in compile_look({}, empty)["still_prompt"]


def test_stop_and_depth_of_field_come_from_the_stage_then_the_look():
    sc = t4_like()
    sc["camera"] = {**sc["camera"], "t_stop": 5.6}
    still = compile_look({"aperture": "f1_4"}, sc)["still_prompt"]
    assert "at T5.6, moderate depth of field, focus on the subject" in still   # the stage's iris wins
    assert "f/1.4" not in still                                                 # the aperture fragment is not repeated
    assert "at T1.4, shallow depth of field" in compile_look({"aperture": "f1_4"}, t4_like())["still_prompt"]
    assert "at T11, deep focus, foreground and background both sharp" in \
        compile_look({"aperture": "f11"}, t4_like())["still_prompt"]


def test_the_look_tab_body_glass_and_stock_go_into_the_block_once():
    still = compile_look({"camera_body": "red_v_raptor", "lens": "anamorphic", "film_stock": "kodak_250d"},
                         t4_like())["still_prompt"]
    assert still.startswith("photograph shot on a RED V-Raptor with a 35mm lens at T2")
    assert still.count("Kodak Vision3 250D") == 1 and "fine grain" in still and "fine visible film grain" not in still
    assert "anamorphic lens, oval bokeh" in still and "crisp high-resolution detail" in still
    # a video camera leads with its own words: no film stock or film grain of ours
    phone = compile_look({"camera_body": "smartphone"}, t4_like())["still_prompt"]
    assert phone.startswith("smartphone video frame with a 35mm Cooke S4 prime lens")
    assert "Kodak" not in phone and "film grain" not in phone


def test_light_is_motivated_by_the_set_never_an_invented_lamp():
    assert "lamp" not in C.motivated_light(t4_like())
    assert C.motivated_light(t4_like()).startswith("motivated light: cool moonlight through the window as the key")
    lamp = t4_like()
    lamp["lighting"] = {**lamp["lighting"], "lights": [{"type": "practical", "kelvin": 2800}]}
    assert C.motivated_light(lamp) == ("motivated light: cool moonlight through the window as the key, a dim warm "
                                       "practical lamp as fill, deep natural shadows")
    street = copy.deepcopy(DEFAULT_SCENE)
    street["sun"] = {"azimuth_deg": 200, "elevation_deg": -20}
    street["lighting"] = {**street["lighting"], "lights": [{"type": "street_lamp", "kelvin": 2700}]}
    assert C.motivated_light(street).startswith("motivated light: a warm street lamp as the key, cool moonlight as fill")
    noted = t4_like(lighting_prompt="one hard key from camera left")
    assert C.motivated_light(noted) == ""
    assert "one hard key from camera left" in compile_look({}, noted)["still_prompt"]


def test_negative_is_c28s_short_one_plus_this_shots_needs():
    neg = compile_look({}, t4_like())["still_negative"]
    assert C.C28_NEGATIVE.replace("extra people", "").strip(", ") in neg
    assert neg.startswith("extra people, crowd")
    for long_only in ("motion blur trails", "watermark", "plastic skin", "background pedestrians"):
        assert long_only not in neg
    hdr = compile_look({"film_stock": "hdr"}, t4_like())
    assert "HDR image" in hdr["still_prompt"] and "HDR" not in hdr["still_negative"]


def test_edit_prompt_is_variant_e():
    edit = compile_look({}, t4_like())["edit_prompt"]
    assert edit.startswith(
        "Turn image 1, a plain 3D stage render, into a real photograph of the same shot: keep the room, the camera, and "
        "the woman's position, size and pose exactly. Shot on an ARRI Alexa 35 with a 35mm Cooke S4 prime lens at T2, "
        "shallow depth of field, Kodak Vision3 500T film stock, fine visible film grain, gentle halation around the bright "
        "window, slight vignetting, motivated light: cool moonlight through the window as the key"), edit
    assert ("Exactly one woman, wearing a pink button-up shirt with rolled-up sleeves, blue jeans and dark shoes, fully "
            "clothed, real skin texture with pores, visible fabric weave and creases, real plaster walls and wooden "
            "floor, nobody else in the room.") in edit
    for placed in ("wide shot", "left third", "small in frame", "focus on"):
        assert placed not in edit
    assert "clay" not in edit.lower() and "mannequin" not in edit.lower()


def test_drawn_looks_and_legacy_frames_keep_the_old_head():
    toon = compile_look({"description": "a Pixar-style animated chase"}, copy.deepcopy(DEFAULT_SCENE))
    assert toon["still_prompt"].startswith("cinematic film still") and "ARRI" not in toon["still_prompt"]
    legacy = copy.deepcopy(DEFAULT_SCENE)
    legacy["look_start"] = False
    r = compile_look({}, legacy)
    assert r["still_prompt"].startswith("cinematic film still") and "motion blur trails" in r["still_negative"]


def test_a_genre_head_still_leads_then_the_block():
    still = compile_look({"movement": "korean_thriller"}, copy.deepcopy(DEFAULT_SCENE))["still_prompt"]
    assert still.startswith("Korean thriller film still")
    assert still.index("photograph shot on an ARRI Alexa 35") < still.index("wide shot")
    assert "cinematic film still" not in still
