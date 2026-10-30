"""LOOK tab: shared vocabulary, look normalising, typed looks, colour naming, the compiled prompts, the node."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import test_cine_nodes  # noqa: E402,F401  (installs the comfy_api stand-in when ComfyUI is absent)

from soundstage import nodes_look  # noqa: E402
from soundstage.cine.kb import get_kb  # noqa: E402
from soundstage.look import colors  # noqa: E402
from soundstage.look.compile import compile_look, frame1_safe  # noqa: E402
from soundstage.look.vocab import (FIELDS, load_vocab, look_from_text, normalize_look, option, options,  # noqa: E402
                                   parse_look_input)

KOREAN = {"movement": "korean_thriller", "lens": "anamorphic", "palette": {"preset": "teal_orange"}}


def _values(out):
    return getattr(out, "values", None) or getattr(out, "result", None) or out.args


# ---- vocabulary ------------------------------------------------------------------------------------

def test_vocab_parses_and_ids_unique():
    v = load_vocab()
    for key in list(FIELDS.values()) + ["palettes"]:
        ids = [o["id"] for o in v[key]]
        assert len(ids) == len(set(ids)), f"duplicate id in {key}"
        assert all(o["label"] and isinstance(o.get("still", ""), str) for o in v[key])
    subs = [s["id"] for s in options("subgenre")]
    assert len(subs) == len(set(subs))


def test_vocab_matches_and_exceeds_cinema_studio_4():
    """CS 4.0: 4 bodies, 5 lenses, 3 apertures, 7 genres, 6 eras, 8 emotions (research/03 §5.2)."""
    labels = lambda f: {o["label"].lower() for o in options(f)}  # noqa: E731
    bodies = labels("camera_body")
    for want in ("modern digital cinema", "35mm film (arricam / panaflex)", "super 8 / 8mm home movie", "minidv camcorder"):
        assert want in bodies
    lenses = {o["id"] for o in options("lens")}
    assert {"clean_sharp", "anamorphic", "vintage_anamorphic", "warm_vintage", "halation_vintage"} <= lenses
    assert {"f1_4", "f4", "f11"} <= {o["id"] for o in options("aperture")}
    assert {"action", "epic", "drama", "comedy", "horror", "noir"} <= {o["id"] for o in options("genre")}
    assert {"1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"} <= {o["id"] for o in options("era")}
    wheel = {o["id"] for o in options("mood") if o.get("wheel")}
    assert wheel == {"hope", "anger", "joy", "trust", "fear", "surprise", "sadness", "disgust"}
    assert len(options("camera_body")) > 4 + 1 and len(options("lens")) > 5 + 1
    assert len(options("palette")) >= 30 and all(len(p["swatches"]) == 5 for p in options("palette")[1:])


def test_every_kb_ref_exists_and_kb_techniques_are_offered():
    kb = get_kb()
    v = load_vocab()
    lists = [v[k] for k in FIELDS.values()] + [options("subgenre"), v["palettes"]]
    refs = [o["kb"] for lst in lists for o in lst if o.get("kb")]
    missing = [r for r in refs if not kb.get(r)]
    assert not missing, missing
    offered = {o.get("kb") for o in options("technique")}
    for e in kb.of_types("director_technique", "dp_technique"):
        assert e["id"] in offered, f"KB technique {e['id']} missing from the Look tab"
    for e in kb.of_types("movement", "national_cinema"):
        assert e["id"] in {o.get("kb") for o in options("movement")}


def test_look_fragments_never_set_time_or_weather():
    """The stage owns time of day and weather; look fragments that name them would fight the stage."""
    import re
    bad = re.compile(r"\b(night|noon|midday|dawn|sunrise|rain|snow|golden hour|magic hour)\b", re.I)
    for field in ("camera_body", "lens", "film_stock", "movement", "era", "technique", "subgenre"):
        for o in options(field):
            for key in ("still", "motion"):
                assert not bad.search(o.get(key, "")) or field == "subgenre" and o["id"] in (
                    "crime.detective", "scifi.cyberpunk", "romance.tragic", "noir.neo", "commercial.automotive"), \
                    f"{field}.{o['id']}.{key}: {o[key]}"


# ---- look JSON ---------------------------------------------------------------------------------------

def test_normalize_fills_defaults_and_drops_unknowns():
    look, notes = normalize_look({"lens": "nope", "subgenre": "noir.neo", "grade": {"contrast": 7, "bogus": 1},
                                  "palette": {"preset": "teal_orange"}, "mood_intensity": "x"})
    assert look["lens"] == "auto" and any("unknown lens" in n for n in notes)
    assert look["genre"] == "noir" and look["subgenre"] == "noir.neo"
    assert look["grade"]["contrast"] == 1.0 and "bogus" not in look["grade"]
    assert look["palette"]["swatches"] == option("palette", "teal_orange")["swatches"]
    assert look["mood_intensity"] == 0.5


def test_custom_palette_hex_cleaned():
    look, _ = normalize_look({"palette": {"preset": "custom", "swatches": ["#0f3d47", "e0904a", "zzz", 3]}})
    assert look["palette"]["swatches"] == ["#0f3d47", "#e0904a"]


def test_typed_look():
    look, matched = look_from_text("Korean thriller, anamorphic, teal-orange")
    assert look == {"movement": "korean_thriller", "lens": "anamorphic", "palette": {"preset": "teal_orange"}}
    assert len(matched) == 3
    look, _ = look_from_text("vintage anamorphic, 1970s, Kodak 500T, a red coat in the rain")
    assert look["lens"] == "vintage_anamorphic" and look["era"] == "1970s" and look["film_stock"] == "kodak_500t"
    assert "camera_body" not in look            # "red coat" must not pick the RED camera
    assert "red coat" in look["description"]


def test_parse_look_input_json_or_text():
    assert parse_look_input(json.dumps({"lens": "macro"}))[0] == {"lens": "macro"}
    assert parse_look_input("noir")[0]["genre"] == "noir"
    assert parse_look_input("")[0] == {}


def test_colour_names():
    assert colors.color_name("#1f6f78") == "teal"
    assert colors.color_name("#000") == "black"
    words = colors.palette_words(["#0f3d47", "#1f6f78", "#e0904a"])
    assert words[0] == "deep teal" and len(words) == 3
    assert colors.palette_phrase([]) == ""


def test_frame1_safe_drops_later_clauses():
    assert frame1_safe("a detective in a trench coat, then she walks inside") == "a detective in a trench coat"
    assert frame1_safe("Two friends on a bench. They stand and leave.") == "Two friends on a bench"
    assert frame1_safe("rain-soaked alley, neon signs") == "rain-soaked alley, neon signs"


# ---- the compile -------------------------------------------------------------------------------------

def test_korean_thriller_example():
    r = compile_look(KOREAN, None)          # None = the stage's default walk-in scene
    still, neg, motion = r["still_prompt"], r["still_negative"], r["motion_prompt"]
    assert still.startswith("Korean thriller film still")
    assert "exactly two people in frame" in still and "35mm lens" in still and "anamorphic" in still
    assert "teal and orange" in still
    for later in ("doorway ahead", "disappear", "walk", "follows", "pans"):
        assert later not in still, f"still prompt leaks motion: {later}"
    assert "extra people" in neg and "crowd" in neg
    assert motion.startswith("Exterior wide shot in a city plaza.")
    assert "away from the camera into the building through the doorway" in motion
    assert "The camera follows behind them" in motion and "panning right" in motion
    assert "as the move completes" in motion and "disappeared through the doorway" in motion
    assert "°" not in motion and "35mm" not in motion          # no numeric specs for LTX
    assert r["kb_refs"] == ["movement.korean_thriller"]


def test_black_and_white_drops_palette():
    r = compile_look({"film_stock": "double_x", "palette": {"preset": "teal_orange"}}, None)
    assert "teal" not in r["still_prompt"] and "black and white" in r["still_prompt"]
    assert "colour" in r["still_negative"]
    assert any("black-and-white" in n for n in r["notes"])


def test_custom_palette_named_in_words():
    r = compile_look({"palette": {"preset": "custom", "name": "Dreamy Teal",
                                  "swatches": ["#1f6f78", "#c9e4de", "#d6c095"]}}, None)
    assert "colour palette of teal, mint and sand" in r["still_prompt"] and "'Dreamy Teal' grade" in r["still_prompt"]
    assert "colour palette of teal, mint and sand" in r["motion_prompt"].lower()


def test_every_option_compiles():
    """Smoke: every single option of every field compiles without error and keeps the frame-1 rules."""
    for field in list(FIELDS) + ["subgenre"]:
        for o in options(field):
            r = compile_look({field: o["id"]}, None)
            assert r["still_prompt"] and r["motion_prompt"]
            assert "extra people" in r["still_negative"]
    for p in options("palette"):
        assert compile_look({"palette": {"preset": p["id"]}}, None)["still_prompt"]


def test_grade_and_mood_intensity():
    r = compile_look({"mood": "dread", "mood_intensity": 0.95, "grade": {"contrast": 0.8, "saturation": -0.3}}, None)
    assert "high contrast, crushed blacks" in r["still_prompt"]
    assert "slightly desaturated" in r["still_prompt"]
    assert "played at full intensity" in r["motion_prompt"]
    assert "faint undertone of" in compile_look({"mood": "dread", "mood_intensity": 0.1}, None)["still_prompt"]


# ---- node --------------------------------------------------------------------------------------------

def test_node_schema_and_execute():
    schema = nodes_look.SoundstageLook.define_schema()
    assert schema.node_id == "SoundstageLook" and schema.category == "Soundstage"
    ids = [getattr(x, "id", None) for x in list(schema.inputs) + list(schema.outputs)]
    assert len(ids) == len(set(ids))
    assert [c.__name__ for c in nodes_look.NODES] == ["SoundstageLook"]
    still, neg, motion, look_json = _values(nodes_look.SoundstageLook.execute(
        look="Korean thriller, anamorphic, teal-orange"))
    data = json.loads(look_json)
    assert data["look"]["movement"] == "korean_thriller" and data["still_prompt"] == still
    assert any(n.startswith("typed look") for n in data["notes"])


def test_node_accepts_raw_stage_value_and_panel_json():
    from soundstage.look.default_scene import DEFAULT_SCENE
    raw = json.dumps({"scene": DEFAULT_SCENE, "passes": {}})
    a = _values(nodes_look.SoundstageLook.execute(look=json.dumps(KOREAN), scene_json=raw))
    b = _values(nodes_look.SoundstageLook.execute(look=json.dumps(KOREAN), scene_json=json.dumps(DEFAULT_SCENE)))
    assert a[:3] == b[:3]
    c = _values(nodes_look.SoundstageLook.execute(look=json.dumps(KOREAN), scene_json="not json"))
    assert c[0] == a[0]  # falls back to the default scene


def test_frame1_safe_drops_everything_after_then():
    from soundstage.look.compile import frame1_safe
    text = ("two saddled horses stand waiting in the desert, then a man and a woman sprint in, "
            "vault up into the saddles and gallop away, kicking up dust")
    assert frame1_safe(text) == "two saddled horses stand waiting in the desert"


# ---- restyle brief + lock clause --------------------------------------------------------------------

def test_motion_always_ends_with_lock_clause():
    from soundstage.look.compile import LOCK_CLAUSE
    for look in ({}, KOREAN, {"film_stock": "double_x", "mood": "dread"}):
        r = compile_look(look, None)
        assert r["motion_prompt"].endswith(LOCK_CLAUSE)
        assert LOCK_CLAUSE not in r["still_prompt"]
    assert " not " not in f" {LOCK_CLAUSE.lower()} " and "keep" not in LOCK_CLAUSE.lower()  # stated positively, present tense


def test_brief_normalised_and_compiled():
    look, _ = normalize_look({"brief": {"world": "  a rain-soaked\nSeoul back street ", "light": "sodium lamps, then the power cuts",
                                        "bogus": "x", "outside": 7}})
    assert set(look["brief"]) == {"world", "atmosphere", "surfaces", "furniture", "colour", "light", "outside"}
    assert look["brief"]["world"] == "a rain-soaked Seoul back street" and look["brief"]["outside"] == "7"
    r = compile_look({"brief": {"world": "a rain-soaked Seoul back street", "surfaces": "wet asphalt, tiled walls",
                                "light": "sodium lamps, then the power cuts"}}, None)
    still, motion = r["still_prompt"], r["motion_prompt"]
    assert "a rain-soaked Seoul back street" in still and "surfaces: wet asphalt" in still
    assert "power cuts" not in still and "sodium lamps" in still            # frame-1 safe
    assert "power cuts" in motion and "surfaces: wet asphalt" in motion
    assert compile_look({}, None)["look"]["brief"]["world"] == ""


def test_vocab_js_default_look_has_brief():
    js = (ROOT / "web" / "look" / "look.mjs").read_text()
    for k in ("world", "atmosphere", "surfaces", "furniture", "colour", "light", "outside"):
        assert f'{k}: ""' in js
