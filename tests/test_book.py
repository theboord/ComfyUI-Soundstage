"""The Director's Book (Milestone 23): the shorthand placer, the model's drafts and their grounding check, the living
memory context, the prompt words (Pitfalls said positively), the server copy and the routes, and the two hooks
(the Director's prompt context, the Look compile)."""
import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.book import context as CX  # noqa: E402
from soundstage.book import draft as DR  # noqa: E402
from soundstage.book import place as PL  # noqa: E402
from soundstage.book import prompting as PP  # noqa: E402
from soundstage.book import store as ST  # noqa: E402

SCRIPT = json.loads((ROOT / "tests" / "book_fixtures" / "dry_creek_script.json").read_text())


def place1(text, llm_text=None):
    return PL.place([text], SCRIPT, llm_text)["placements"][0]


# ------------------------------------------------------------------------------------------- the three from Mike's brief

def test_sc2_shadow_on_mara_goes_to_scene_2_lighting():
    p = place1("sc2 — keep Mara's face in shadow till she sees the badge")
    assert (p["scope"], p["scene_id"], p["category"], p["character"]) == ("scene", "sc_2", "lighting", "MARA")
    assert p["confidence"] >= 0.9 and "names scene 2" in p["why"]
    assert "badge" in p["unknown"] and "isn't in the script yet" in p["why"]


def test_chase_low_and_fast_goes_to_the_chase_scene_camera_and_sound():
    p = place1("chase: low & fast, no music till the crash")
    assert (p["scope"], p["scene_id"], p["category"]) == ("scene", "sc_2", "camera")
    assert "sound" in p["categories"]
    assert p["line"] == 1, "the police car swings out behind it: where the chase starts"
    assert "chase" in p["why"]


def test_ezra_never_looks_cole_in_the_eye_is_a_performance_note_on_ezra():
    p = place1("Ezra never looks Cole in the eye")
    assert (p["scope"], p["scene_id"], p["category"], p["character"]) == ("scene", "sc_1", "performance", "EZRA")
    assert "Ezra is only in scene 1" in p["why"] and "never on screen with" in p["why"]
    el = next(s for s in SCRIPT["scenes"] if s["id"] == "sc_1")["elements"][p["line"]]
    assert "EZRA" in el["text"].upper() or el.get("character") == "EZRA"


# ------------------------------------------------------------------------------------------- more realistic shorthand

@pytest.mark.parametrize("text,scope,scene,cat,line", [
    ("hawk cry over the key toss, let it ring", "scene", "sc_1", "sound", None),
    ("beach: warm magenta last light, sun right on the horizon", "scene", "sc_3", "lighting", None),
    ("2A radio way too loud, kill it when she kills the headlights", "scene", "sc_2A", "sound", 4),
    ("Mara barefoot = she's free now, play it light", "scene", "sc_3", "performance", 1),
    ("Ezra's hand hovers but never draws, 40 paces", "scene", "sc_1", "performance", None),
    ("Mara never smiles until the surf", "scene", "sc_3", "performance", None),
    ("no handheld anywhere", "global", None, "camera", None),
    ("the brass key has to be dusty in every scene", "global", None, "continuity", None),
    ("fix the thing later", "unsorted", None, None, None),
])
def test_shorthand_lands_where_a_director_means(text, scope, scene, cat, line):
    p = place1(text)
    assert p["scope"] == scope, p
    assert p["scene_id"] == scene, p
    if cat:
        assert p["category"] == cat, p
    if line is not None:
        assert p["line"] == line, p


def test_a_character_in_many_scenes_without_a_clue_is_a_standing_character_note():
    p = place1("Mara always keeps her chin up")
    assert p["scope"] == "character" and p["character"] == "MARA"
    assert "scenes 1, 2A, 3" in p["why"]


def test_model_answer_is_checked_and_merged():
    notes = ["fix the thing later", "Mara never smiles until the surf", "sc2 — keep Mara's face in shadow"]
    llm = json.dumps({"notes": [
        {"i": 1, "scene": "9", "line": 2, "character": "BOB", "category": "camera", "confidence": 0.9, "why": "x"},  # no scene 9: ignored
        {"i": 2, "scene": "3", "line": 4, "character": "MARA", "category": "performance", "confidence": 0.8, "why": "she throws the key"},
        {"i": 3, "scene": "1", "line": 0, "category": "lighting", "confidence": 0.9, "why": "dusk"},                  # the note says sc2
    ]})
    out = PL.place(notes, SCRIPT, llm)
    assert out["backend"] == "llm"
    a, b, c = out["placements"]
    assert a["scope"] == "unsorted"
    assert b["scene_id"] == "sc_3" and b["line"] == 4 and b["by"] in ("llm", "rules+llm")
    assert c["scene_id"] == "sc_2" and "the model suggested scene 1" in c["why"]


def test_model_can_rescue_an_unsorted_note_and_garbage_falls_back_to_rules():
    llm = '```json\n{"notes":[{"i":1,"scene":"3","line":4,"character":"Mara","category":"performance","confidence":0.7,"why":"she throws the key away"}]}\n```'
    assert PL.place(["hold on her a beat longer"], SCRIPT)["placements"][0]["scope"] == "unsorted"
    p = PL.place(["hold on her a beat longer"], SCRIPT, llm)["placements"][0]
    assert (p["scope"], p["scene_id"], p["line"], p["character"], p["by"]) == ("scene", "sc_3", 4, "MARA", "llm")
    assert p["why"] == "she throws the key away"
    assert PL.place(["fix the thing later"], SCRIPT, "I think it goes somewhere")["backend"] == "rules (llm unreadable)"


def test_place_prompt_lists_numbered_lines_and_fits_a_small_model():
    p = PL.prompt(["a", "b"], SCRIPT)
    assert "SCENE 2A: INT. SPORTS CAR (MOVING) - CONTINUOUS" in p["prompt"]
    assert "  4. She kills the headlights" in p["prompt"]
    assert len(p["prompt"]) < 5000 and p["max_length"] <= 900


# ------------------------------------------------------------------------------------------- drafts and grounding

GOOD = {
    "synopsis": "Mara faces Ezra in the desert and takes the brass key at a gallop.",
    "times": "Dusk on the flats outside Dry Creek.",
    "imagery": "Heat shimmer, long shadows, a low orange sun.",
    "references": ["Once Upon a Time in the West - the long wait before anyone moves"],
    "core": "Mara takes back what was her father's.",
    "subtext": "Ezra wants to be beaten. Sheriff Hank Doyle watches from the ridge.",
    "pitfalls": ["avoid melodrama", "no spaghetti-western parody"],
    "lighting": "Low sun as key from behind Mara; bounce from the sand as fill.",
    "performance": {"MARA": "Never blinks.", "EZRA": "Tired, almost relieved.", "COLE": "Not here."},
    "sound": [{"hear": "Wind, then the hawk", "why": "the flats are empty"}, {"hear": "Silence on the toss", "why": "the key lands in the dirt"}],
}


def test_draft_parse_keeps_grounded_prose_and_drops_invented_names():
    out = DR.parse(json.dumps(GOOD), SCRIPT, "sc_1")
    s, g = out["sections"], out["grounding"]
    assert out["backend"] == "llm"
    assert s["core"] == "Mara takes back what was her father's."
    assert "Hank Doyle" not in s["subtext"] and s["subtext"] == "Ezra wants to be beaten."
    assert any("Hank" in d["why"] or "Doyle" in d["why"] for d in g["dropped"])
    assert set(s["performance"]) == {"MARA", "EZRA"}, "COLE is not in scene 1"
    assert s["references"][0].startswith("Once Upon a Time in the West"), "references may name films"
    assert s["constraints"] == ["restrained, understated performance", "sincere, grounded tone, played straight"]
    assert s["sound"][1]["hear"] == "Silence on the toss"
    assert g["ok"] is False


def test_draft_flags_plot_the_scene_does_not_contain():
    raw = dict(GOOD, subtext="Years ago Ezra killed her father.")
    g = DR.parse(json.dumps(raw), SCRIPT, "sc_1")["grounding"]
    assert any("killed" in f["why"] or "years ago" in f["why"].lower() for f in g["flags"])


def test_draft_prompt_is_grounded_in_the_scene():
    p = DR.prompt(SCRIPT, "sc_2A", {"set": "street_night", "time": "night", "shots": ["2A-A Driver, 35 mm, static"]})
    assert "Never invent" in p["system"]
    assert "MARA: Come on, old girl." in p["prompt"]
    assert "Scene before: 2 EXT. DRY CREEK - MAIN STREET - NIGHT" in p["prompt"]
    assert "Stage: set street_night, light night" in p["prompt"]


def test_unreadable_draft_is_reported_not_invented():
    out = DR.parse("Sure! Here is the page.", SCRIPT, "sc_1")
    assert out["sections"] == {} and out["backend"].startswith("rules")


def test_spine():
    out = DR.parse_spine('{"spine":"A daughter takes back her father\'s car, then lets it go.","statement":"Wide and patient. Dust and salt."}', SCRIPT)
    assert out["spine"].startswith("A daughter takes back")
    assert "Title: Last Light on Route 9" in DR.spine_prompt(SCRIPT)["prompt"]


# ------------------------------------------------------------------------------------------- prompts, context, store

def test_pitfalls_become_positive_words_for_cfg1():
    assert PP.positive_constraints(["avoid melodrama", "no shaky handheld", "keep it quiet", "no hats"]) == [
        "restrained, understated performance", "steady, locked-off camera", "keep it quiet"]
    w = PP.prompt_words({"style": ["sun-bleached, dusty"], "constraints": ["no melodrama", "steady, locked-off camera"]})
    assert w == "sun-bleached, dusty. steady, locked-off camera, restrained, understated performance."
    assert PP.prompt_words(None) == "" and PP.prompt_words({}) == ""


def test_look_compile_carries_the_book_words():
    from soundstage.look.compile import compile_look
    base = compile_look({}, None)
    withb = compile_look({"book": {"style": ["heat shimmer, low orange sun"], "constraints": ["avoid melodrama"]}}, None)
    assert "heat shimmer, low orange sun" in withb["still_prompt"] and "restrained, understated performance" in withb["motion_prompt"]
    assert "melodrama" not in withb["still_prompt"]
    assert "heat shimmer" not in base["still_prompt"]


def _book():
    return {"spine": "Take it back, then let it go.", "statement": "Patient and wide.", "rules": ["the key is always brass"],
            "scenes": {"sc_2": {"core": "Escape, not victory.", "constraints": ["steady, locked-off camera"], "imagery": "wet neon"}},
            "notes": [
                {"id": "a", "text": "chase: low & fast", "scope": "scene", "scene_id": "sc_2", "line": 1, "category": "camera"},
                {"id": "b", "text": "Ezra never looks Cole in the eye", "scope": "scene", "scene_id": "sc_1", "category": "performance", "character": "EZRA"},
                {"id": "c", "text": "Mara never smiles", "scope": "character", "character": "MARA", "category": "performance"},
                {"id": "d", "text": "no handheld anywhere", "scope": "global", "category": "camera"},
                {"id": "e", "text": "make it rain harder", "scope": "scene", "scene_id": "sc_2", "category": "lighting", "source": "chat"},
            ]}


def test_book_context_mirrors_the_browser():
    c = CX.book_context(_book(), "sc_2", SCRIPT)
    assert c["text"].splitlines()[0] == "Spine: Take it back, then let it go."
    assert "This scene's core: Escape, not victory." in c["text"]
    assert "Rule: no handheld anywhere" in c["text"] and "Rule: the key is always brass" in c["text"]
    assert "Note [camera]: chase: low & fast" in c["text"]
    assert "Mara never smiles" not in c["text"], "Mara isn't named in scene 2's pages"
    assert "Note [performance] (Mara): Mara never smiles" in CX.book_context(_book(), "sc_2A", SCRIPT)["text"]
    assert "Note [lighting]: make it rain" not in c["text"], "a chat decision shows once, as a decision"
    assert "Ezra never looks" not in c["text"]
    assert "Decided earlier: make it rain harder" in c["text"]
    assert c["prompt"] == {"style": ["wet neon"], "constraints": ["steady, locked-off camera"]}
    assert len(c["text"]) <= 900


def test_store_roundtrip_and_notes(tmp_path):
    ST._OVERRIDE = str(tmp_path)
    try:
        assert ST.load() is None
        ST.save({"v": 1, "notes": []})
        n = ST.add_note({"text": "decided: 50mm on the wide", "source": "pitch"})
        assert n["id"] and ST.load()["notes"][0]["text"] == "decided: 50mm on the wide"
    finally:
        ST._OVERRIDE = None


def test_director_prompt_reads_the_book():
    from soundstage.agent import director as D
    scene = json.loads((ROOT / "tests" / "agent_fixtures" / "director_demo.json").read_text())
    p = D.prompt("push in on Mara", scene, {"book": {"text": "Spine: Take it back.\nRule: no handheld anywhere"}})
    assert "Director's book (follow it):\nSpine: Take it back." in p["prompt"]
    assert "Director's book" not in D.prompt("push in", scene, {})["prompt"]


# ------------------------------------------------------------------------------------------- routes

def test_routes(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from soundstage.book import routes as R
    ST._OVERRIDE = str(tmp_path)
    sent = []
    R._REGISTERED = False
    rt = web.RouteTableDef()
    R.register(rt, send=lambda ev, d: sent.append((ev, d)))
    app = web.Application()
    app.add_routes(rt)

    async def go():
        async with TestClient(TestServer(app)) as c:
            r = await c.post("/soundstage/book/prompt", json={"mode": "place", "script": SCRIPT, "notes": ["chase: low"]})
            assert "Director's notes:\n1. chase: low" in (await r.json())["prompt"]
            r = await c.post("/soundstage/book/prompt", json={"mode": "draft", "script": SCRIPT, "scene_id": "sc_3"})
            assert "She throws the key into the surf" in (await r.json())["prompt"]
            r = await c.post("/soundstage/book/place", json={"script": SCRIPT, "notes": ["Ezra never looks Cole in the eye"]})
            assert (await r.json())["placements"][0]["scene_id"] == "sc_1"
            r = await c.post("/soundstage/book/draft", json={"script": SCRIPT, "scene_id": "sc_1", "llm_text": json.dumps(GOOD)})
            assert (await r.json())["sections"]["core"].startswith("Mara takes back")
            assert (await c.get("/soundstage/book")).status == 404
            bk = dict(_book(), script=SCRIPT)
            assert (await (await c.post("/soundstage/book/save", json={"book": bk})).json())["ok"]
            ctx = await (await c.get("/soundstage/book/context?scene=sc_2")).json()
            assert "Escape, not victory." in ctx["text"]
            n = await (await c.post("/soundstage/book/note", json={"text": "Ezra never looks Cole in the eye", "script": SCRIPT, "source": "pitch"})).json()
            assert n["note"]["scene_id"] == "sc_1" and n["note"]["source"] == "pitch"
            assert sent and sent[-1][0] == "soundstage.book"
            assert (await c.post("/soundstage/book/note", json={})).status == 400
    try:
        asyncio.run(go())
    finally:
        ST._OVERRIDE = None
        R._REGISTERED = False


def test_the_notes_own_words_keep_their_department_over_the_model():
    llm = json.dumps({"notes": [{"i": 1, "scene": "1", "line": None, "character": "null", "category": "blocking", "confidence": 0.9, "why": "x"}]})
    p = PL.place(["Ezra never looks Cole in the eye"], SCRIPT, llm)["placements"][0]
    assert p["category"] == "performance" and "blocking" in p["categories"] and p["character"] == "EZRA"


def test_whole_film_wording_stays_global_whatever_the_model_says():
    llm = json.dumps({"notes": [{"i": 1, "scene": "1", "line": None, "category": "continuity", "confidence": 0.9, "why": "key"}]})
    p = PL.place(["the brass key has to be dusty in every scene"], SCRIPT, llm)["placements"][0]
    assert p["scope"] == "global" and p["scene_id"] is None


def test_spine_that_invents_a_theft_is_flagged():
    out = DR.parse_spine('{"spine":"A woman steals a car to get her father\'s key.","statement":"x"}', SCRIPT)
    assert any("steal" in f["why"] for f in out["grounding"]["flags"])
