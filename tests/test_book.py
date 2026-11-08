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


def test_ezra_never_looks_reed_in_the_eye_is_a_performance_note_on_ezra():
    p = place1("Ezra never looks Reed in the eye")
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
    "performance": {"MARA": "Never blinks.", "EZRA": "Tired, almost relieved.", "REED": "Not here."},
    "sound": [{"hear": "Wind, then the hawk", "why": "the flats are empty"}, {"hear": "Silence on the toss", "why": "the key lands in the dirt"}],
}


def test_draft_parse_keeps_grounded_prose_and_drops_invented_names():
    out = DR.parse(json.dumps(GOOD), SCRIPT, "sc_1")
    s, g = out["sections"], out["grounding"]
    assert out["backend"] == "llm"
    assert s["core"] == "Mara takes back what was her father's."
    assert "Hank Doyle" not in s["subtext"] and s["subtext"] == "Ezra wants to be beaten."
    assert any("Hank" in d["why"] or "Doyle" in d["why"] for d in g["dropped"])
    assert set(s["performance"]) == {"MARA", "EZRA"}, "REED is not in scene 1"
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
                {"id": "b", "text": "Ezra never looks Reed in the eye", "scope": "scene", "scene_id": "sc_1", "category": "performance", "character": "EZRA"},
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
            r = await c.post("/soundstage/book/place", json={"script": SCRIPT, "notes": ["Ezra never looks Reed in the eye"]})
            assert (await r.json())["placements"][0]["scene_id"] == "sc_1"
            r = await c.post("/soundstage/book/draft", json={"script": SCRIPT, "scene_id": "sc_1", "llm_text": json.dumps(GOOD)})
            assert (await r.json())["sections"]["core"].startswith("Mara takes back")
            assert (await c.get("/soundstage/book")).status == 404
            bk = dict(_book(), script=SCRIPT)
            assert (await (await c.post("/soundstage/book/save", json={"book": bk})).json())["ok"]
            ctx = await (await c.get("/soundstage/book/context?scene=sc_2")).json()
            assert "Escape, not victory." in ctx["text"]
            n = await (await c.post("/soundstage/book/note", json={"text": "Ezra never looks Reed in the eye", "script": SCRIPT, "source": "pitch"})).json()
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
    p = PL.place(["Ezra never looks Reed in the eye"], SCRIPT, llm)["placements"][0]
    assert p["category"] == "performance" and "blocking" in p["categories"] and p["character"] == "EZRA"


def test_whole_film_wording_stays_global_whatever_the_model_says():
    llm = json.dumps({"notes": [{"i": 1, "scene": "1", "line": None, "category": "continuity", "confidence": 0.9, "why": "key"}]})
    p = PL.place(["the brass key has to be dusty in every scene"], SCRIPT, llm)["placements"][0]
    assert p["scope"] == "global" and p["scene_id"] is None


def test_spine_that_invents_a_theft_is_flagged():
    out = DR.parse_spine('{"spine":"A woman steals a car to get her father\'s key.","statement":"x"}', SCRIPT)
    assert any("steal" in f["why"] for f in out["grounding"]["flags"])


# ------------------------------------------------------------------------------------------- forget a decision everywhere

def _dec(i, ref=None):
    n = {"id": i, "text": "Weather: rain", "source": "chat", "by": "chat", "scope": "scene", "scene_id": "sc_1",
         "change": [{"tool": "weather", "args": {"kind": "rain"}}], "dv": 2}
    if ref:
        n["ref"] = ref
    return n


def _wf_with_book(notes):
    return {"nodes": [{"id": 1, "type": "SoundstageStage", "properties": {"ss_book": {"v": 1, "notes": notes}}}],
            "definitions": {"subgraphs": [{"nodes": [{"id": 2, "properties": {"ss_book": {"notes": list(notes)}}}]}]},
            "extra": {"ss_project": {"name": "Film", "id": "p_0a1b2c3d"}}}


def test_forget_removes_every_stored_copy(tmp_path):
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        mine = {"id": "n_mine", "text": "keep the lamp off", "source": "director"}
        ST.save({"v": 1, "notes": [_dec("n_gone"), mine, _dec("n_keep")]})
        (user / "workflows").mkdir(parents=True)
        auto = user / "projects" / "Film" / "autosave"
        auto.mkdir(parents=True)
        trash = user / "projects" / ".trash" / "Old 20261101-101010"
        (trash / "autosave").mkdir(parents=True)
        (user / "workflows" / "Film.json").write_text(json.dumps(_wf_with_book([_dec("n_gone"), mine])))
        for k in range(3):
            (auto / f"2026110{k}-120000-000.json").write_text(json.dumps({"name": "Film", "workflow": _wf_with_book([_dec("n_gone"), _dec("n_ref", ref="turn_9")])}))
        (trash / "workflow.json").write_text(json.dumps(_wf_with_book([_dec("n_gone")])))
        untouched = user / "workflows" / "Other.json"
        untouched.write_text(json.dumps(_wf_with_book([_dec("n_keep")])))
        before = untouched.stat().st_mtime_ns
        # a director's note with that id is never removed (only chat decisions)
        (user / "workflows" / "Odd.json").write_text(json.dumps({"notes": [{"id": "n_gone", "source": "director", "text": "mine"}]}))

        res = ST.forget(["n_gone", "turn_9"], [user / "workflows", user / "projects"], {"id": "p_0a1b2c3d", "name": "Film"})
        assert not res["errors"] and not res["ok"]                      # Odd.json names no project: reported, not ok
        everything = [p for p in tmp_path.rglob("*.json")]
        for p in everything:
            t = p.read_text()
            assert '"n_ref"' not in t, p                       # found by its ref
            if p.name != "Odd.json":
                assert '"n_gone"' not in t, p
        assert ST.load()["notes"] == [mine, _dec("n_keep")]
        wf = json.loads((user / "workflows" / "Film.json").read_text())
        assert wf["nodes"][0]["properties"]["ss_book"]["notes"] == [mine]
        assert wf["definitions"]["subgraphs"][0]["nodes"][0]["properties"]["ss_book"]["notes"] == [mine]
        assert wf["extra"]["ss_project"]["id"] == "p_0a1b2c3d"           # the rest of the file is left alone
        assert untouched.stat().st_mtime_ns == before                     # files that don't mention the id: not rewritten
        assert json.loads((user / "workflows" / "Odd.json").read_text())["notes"][0]["id"] == "n_gone"
        assert res["removed"] == 1 + 2 + 3 * 2 * 2 + 2                   # book, Film (2 copies), 3 autosaves x 2 x 2, trash x 2
        assert [x["path"] for x in res["skipped"]] == [str(user / "workflows" / "Odd.json")]
        assert "Odd.json" in res["error"]
        assert not list(tmp_path.rglob("*.tmp"))
        assert ST.forget([], [user]) == {"ok": True, "removed": 0, "files": [], "still_mentions": [], "skipped": [], "other_projects": [], "other_copies": [], "errors": []}
    finally:
        ST._OVERRIDE = None


def test_forget_route(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from soundstage.book import routes as R
    ST._OVERRIDE = str(tmp_path)
    R._REGISTERED = False
    rt = web.RouteTableDef()
    R.register(rt, send=lambda ev, d: None)
    app = web.Application()
    app.add_routes(rt)
    ST.save({"v": 1, "notes": [_dec("n_a"), _dec("n_b")]})

    async def go():
        async with TestClient(TestServer(app)) as c:
            assert (await c.post("/soundstage/book/forget", json={})).status == 400
            j = await (await c.post("/soundstage/book/forget", json={"id": "n_a"})).json()
            assert not j["ok"] and j["removed"] == 1                      # no project: the open book only, and it says so
            assert "no project given" in j["error"]
            ST.save({"v": 1, "notes": [_dec("n_a"), _dec("n_b")]}, project={"id": "p_0a1b2c3d", "name": "Film"})
            j = await (await c.post("/soundstage/book/forget", json={"id": "n_a", "project": {"id": "p_0a1b2c3d", "name": "Film"}})).json()
            assert j["ok"] and j["removed"] == 1, j
            assert [n["id"] for n in ST.load()["notes"]] == ["n_b"]
    try:
        asyncio.run(go())
    finally:
        ST._OVERRIDE = None
        R._REGISTERED = False


def _wf_of(pid, name, notes):
    wf = _wf_with_book(notes)
    wf["extra"]["ss_project"] = {"name": name, **({"id": pid} if pid else {})}
    return wf


def test_forget_is_scoped_to_the_forgetting_project(tmp_path):
    """Two projects share a ref (and a Duplicate shares the note id): only the target project loses it."""
    from soundstage.project import library as L
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "projects" / "A").mkdir(parents=True)
        (user / "projects" / "A" / "project.json").write_text(json.dumps({"format": "soundstage-project", "id": "p_aaaaaaaa", "name": "A"}))
        (user / "workflows" / "A.json").write_text(json.dumps(_wf_of("p_aaaaaaaa", "A", [_dec("n_1", ref="t1")])))
        (user / "workflows" / "B.json").write_text(json.dumps(_wf_of("p_bbbbbbbb", "B", [_dec("n_9", ref="t1")])))
        L.duplicate(user, "A", "A copy")                               # same note id n_1, fresh project id
        dup = json.loads((user / "workflows" / "A copy.json").read_text())
        assert dup["extra"]["ss_project"]["id"] != "p_aaaaaaaa"
        (user / "projects" / "A" / "autosave").mkdir()
        (user / "projects" / "A" / "autosave" / "20261101-120000-000.json").write_text(
            json.dumps({"name": "A", "workflow": _wf_of(None, "A", [_dec("n_1")])}))   # pre-id autosave of A: by name
        ST.save({"v": 1, "notes": [_dec("n_9", ref="t1")]}, project={"id": "p_bbbbbbbb", "name": "B"})  # B's open book

        res = ST.forget(["t1", "n_1"], [user / "workflows", user / "projects"], {"id": "p_aaaaaaaa", "name": "A"})
        # the Duplicate still holds the same decision (note n_1): ok is False and says where; B only shares the ref
        assert not res["ok"], res
        assert res["other_copies"] == [str(user / "workflows" / "A copy.json")]
        assert "A copy.json" in res["error"] and "another project" in res["error"] and "B.json" not in res["error"]
        assert res["removed"] == 2 + 2                                 # A.json (2 copies), its autosave (2 copies)
        a = json.loads((user / "workflows" / "A.json").read_text())
        assert a["nodes"][0]["properties"]["ss_book"]["notes"] == []
        b = json.loads((user / "workflows" / "B.json").read_text())
        assert [n["id"] for n in b["nodes"][0]["properties"]["ss_book"]["notes"]] == ["n_9"], "B shares the ref: kept"
        d = json.loads((user / "workflows" / "A copy.json").read_text())
        assert [n["id"] for n in d["nodes"][0]["properties"]["ss_book"]["notes"]] == ["n_1"], "the duplicate keeps its copy"
        assert [n["id"] for n in ST.load()["notes"]] == ["n_9"], "B's server book kept"
        assert set(res["other_projects"]) == {str(user / "workflows" / "B.json"), str(user / "workflows" / "A copy.json"),
                                              str(books / "current.json")}
    finally:
        ST._OVERRIDE = None


def test_forget_reports_skipped_big_files_tmp_leftovers_and_string_mentions(tmp_path, monkeypatch):
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        P = {"id": "p_aaaaaaaa", "name": "A"}
        ST.save({"v": 1, "notes": [_dec("n_1")]}, project=P)
        (books / "current.json.tmp").write_text(json.dumps({"v": 1, "_project": P, "notes": [_dec("n_1")]}))   # a died save
        big = user / "workflows" / "Big.json"
        big.write_text(json.dumps(_wf_of("p_aaaaaaaa", "A", [_dec("n_1")])) + " " * 2048)
        wf = _wf_of("p_aaaaaaaa", "A", [_dec("n_1")])
        wf["extra"]["memo"] = "forgot n_1 earlier"                        # the id inside a string
        (user / "workflows" / "A.json").write_text(json.dumps(wf))
        monkeypatch.setattr(ST, "MAX_SCRUB_BYTES", 1500)
        res = ST.forget(["n_1"], [user / "workflows"], P)
        assert not res["ok"]
        assert '"n_1"' not in (books / "current.json.tmp").read_text(), "the .tmp leftover was cleaned too"
        assert str(books / "current.json.tmp") in res["files"]
        assert [s["path"] for s in res["skipped"]] == [str(big)] and "MB" in res["skipped"][0]["why"]
        assert res["still_mentions"] == [str(user / "workflows" / "A.json")]
        assert "Big.json" in res["error"] and "still mentions" in res["error"]
    finally:
        ST._OVERRIDE = None


def test_forget_after_rename_of_a_pre_id_project_clears_its_moved_autosaves(tmp_path):
    """A project saved before ids existed is Renamed in the library: its autosaves move to projects/<new>/ still naming
    the old project and no id. Forget from the renamed project (now with an id) must clean them, and ok is only true
    when no copy is left."""
    from soundstage.project import library as L
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "projects" / "Alpha" / "autosave").mkdir(parents=True)
        (user / "workflows" / "Alpha.json").write_text(json.dumps(_wf_of(None, "Alpha", [_dec("n_secret1")])))
        (user / "projects" / "Alpha" / "project.json").write_text(json.dumps(
            {"format": "soundstage-project", "v": 1, "name": "Alpha", "created": 1, "saved_at": 2, "saves": 1}))
        (user / "projects" / "Alpha" / "autosave" / "20261101-100000-000.json").write_text(json.dumps(
            {"format": "soundstage-project-autosave", "v": 1, "name": "Alpha", "saved_at": 3,
             "workflow": _wf_of(None, "Alpha", [_dec("n_secret1")])}))
        assert L.rename(user, "Alpha", "Beta") == "Beta"
        man = json.loads((user / "projects" / "Beta" / "project.json").read_text())
        man["id"] = "p_aaaa1111"                                      # the next Save writes the id
        (user / "projects" / "Beta" / "project.json").write_text(json.dumps(man))
        (user / "workflows" / "Beta.json").write_text(json.dumps(_wf_of("p_aaaa1111", "Beta", [])))
        res = ST.forget(["n_secret1"], [user / "workflows", user / "projects"], {"id": "p_aaaa1111", "name": "Beta"})
        left = [p for p in user.rglob("*.json") if "n_secret1" in p.read_text()]
        assert left == [], left
        assert res["ok"] and res["removed"] == 2, res                  # the autosave's two book copies
        assert res["other_projects"] == []

        # ok stays false while a copy remains: an autosave too big to read
        auto = user / "projects" / "Beta" / "autosave" / "20261102-100000-000.json"
        auto.write_text(json.dumps({"name": "Alpha", "workflow": _wf_of(None, "Alpha", [_dec("n_secret2")])}) + " " * 4096)
        old_max = ST.MAX_SCRUB_BYTES
        ST.MAX_SCRUB_BYTES = 2048
        try:
            res = ST.forget(["n_secret2"], [user / "workflows", user / "projects"], {"id": "p_aaaa1111", "name": "Beta"})
        finally:
            ST.MAX_SCRUB_BYTES = old_max
        assert "n_secret2" in auto.read_text() and not res["ok"]
    finally:
        ST._OVERRIDE = None


def test_forget_cleans_the_projects_own_workflow_when_a_two_tab_save_left_another_id_in_it(tmp_path):
    """project.json says p_11111111, workflows/A.json says p_22222222 (two tabs saved at once). Forget from
    {p_11111111, A} must clean workflows/A.json, not list it as another project's and say ok."""
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "projects" / "A").mkdir(parents=True)
        (user / "projects" / "A" / "project.json").write_text(json.dumps({"format": "soundstage-project", "id": "p_11111111", "name": "A"}))
        (user / "workflows" / "A.json").write_text(json.dumps(_wf_of("p_22222222", "A", [_dec("n_x1")])))
        res = ST.forget(["n_x1"], [user / "workflows", user / "projects"], {"id": "p_11111111", "name": "A"})
        assert "n_x1" not in (user / "workflows" / "A.json").read_text()
        assert res["ok"] and res["removed"] == 2 and res["other_projects"] == [], res
    finally:
        ST._OVERRIDE = None


def test_forget_is_not_ok_while_another_project_keeps_a_copy(tmp_path):
    """A Save As copy under another name and id holds the same decision note: Forget leaves it (scoped) but ok is
    False and other_copies names it; a ref shared with another project's own note is not a copy."""
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "workflows" / "A.json").write_text(json.dumps(_wf_of("p_aaaaaaaa", "A", [_dec("n_k1", ref="t7")])))
        (user / "workflows" / "Other.json").write_text(json.dumps(_wf_of("p_cccccccc", "Other", [_dec("n_k1", ref="t7")])))
        (user / "workflows" / "C.json").write_text(json.dumps(_wf_of("p_dddddddd", "C", [_dec("n_c9", ref="t7")])))
        res = ST.forget(["t7"], [user / "workflows"], {"id": "p_aaaaaaaa", "name": "A"})
        assert "n_k1" not in (user / "workflows" / "A.json").read_text()
        assert not res["ok"] and res["other_copies"] == [str(user / "workflows" / "Other.json")], res
        assert "Other.json" in res["error"] and "C.json" not in res["error"]
        assert "n_c9" in (user / "workflows" / "C.json").read_text(), "C's own decision is never touched"
        # only C shares the ref: nothing of A's decision is left anywhere, so ok
        (user / "workflows" / "Other.json").unlink()
        (user / "workflows" / "A.json").write_text(json.dumps(_wf_of("p_aaaaaaaa", "A", [_dec("n_k2", ref="t7")])))
        res = ST.forget(["t7"], [user / "workflows"], {"id": "p_aaaaaaaa", "name": "A"})
        assert res["ok"] and res["other_copies"] == [] and res["other_projects"] == [str(user / "workflows" / "C.json")], res
    finally:
        ST._OVERRIDE = None


def test_forget_everywhere_removes_another_projects_copy_by_note_id_only(tmp_path):
    """everywhere=True takes the same decision note (same note id) out of a Save As copy, but leaves another project's
    own decision that only shares the chat turn ref."""
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "workflows" / "A.json").write_text(json.dumps(_wf_of("p_aaaaaaaa", "A", [_dec("n_e1", ref="t8")])))
        (user / "workflows" / "Copy.json").write_text(json.dumps(_wf_of("p_cccccccc", "Copy", [_dec("n_e1", ref="t8")])))
        (user / "workflows" / "C.json").write_text(json.dumps(_wf_of("p_dddddddd", "C", [_dec("n_c8", ref="t8")])))
        res = ST.forget(["t8"], [user / "workflows"], {"id": "p_aaaaaaaa", "name": "A"}, everywhere=True)
        assert res["ok"] and res["other_copies"] == [], res
        assert "n_e1" not in (user / "workflows" / "A.json").read_text()
        assert "n_e1" not in (user / "workflows" / "Copy.json").read_text()
        assert "n_c8" in (user / "workflows" / "C.json").read_text()
    finally:
        ST._OVERRIDE = None


def test_forget_cleans_collected_copies_in_output_soundstage_projects(tmp_path):
    """Collect project writes the book twice into output/soundstage_projects/<P>/: script/directors_book.json and the
    collected project.json's "book" (and its "workflow"). Forget removes both; another project's collected copy of
    the same decision is reported in other_copies (ok False) until everywhere=True."""
    books, user, col = tmp_path / "books", tmp_path / "user", tmp_path / "output" / "soundstage_projects"
    ST._OVERRIDE = str(books)
    try:
        (user / "workflows").mkdir(parents=True)
        (user / "workflows" / "Film.json").write_text(json.dumps(_wf_of("p_0a1b2c3d", "Film", [_dec("n_c1", ref="t5")])))
        for folder, pid in (("Film", "p_0a1b2c3d"), ("Other", "p_99999999")):
            (col / folder / "script").mkdir(parents=True)
            book = {"v": 1, "notes": [_dec("n_c1", ref="t5"), {"id": "n_d", "text": "lamp off", "source": "director"}]}
            (col / folder / "script" / "directors_book.json").write_text(json.dumps(book))
            (col / folder / "project.json").write_text(json.dumps({"format": "soundstage-collected-project", "v": 1, "name": folder,
                                                                   "book": book, "workflow": _wf_of(pid, folder, book["notes"])}))
        roots = [user / "workflows", user / "projects", col]
        res = ST.forget(["t5"], roots, {"id": "p_0a1b2c3d", "name": "Film"})
        for p in (col / "Film" / "script" / "directors_book.json", col / "Film" / "project.json", user / "workflows" / "Film.json"):
            assert "n_c1" not in p.read_text(), p
        assert "n_d" in (col / "Film" / "script" / "directors_book.json").read_text(), "the director's own note stays"
        assert not res["skipped"], res
        assert not res["ok"] and sorted(res["other_copies"]) == sorted(
            [str(col / "Other" / "project.json"), str(col / "Other" / "script" / "directors_book.json")]), res
        res = ST.forget(["n_c1"], roots, {"id": "p_0a1b2c3d", "name": "Film"}, everywhere=True)
        assert res["ok"], res
        assert "n_c1" not in (col / "Other" / "script" / "directors_book.json").read_text()
        # a collected folder under another name whose project.json names this project is this project's
        (col / "Film 2" / "script").mkdir(parents=True)
        (col / "Film 2" / "script" / "directors_book.json").write_text(json.dumps({"v": 1, "notes": [_dec("n_c2")]}))
        (col / "Film 2" / "project.json").write_text(json.dumps({"format": "soundstage-collected-project", "name": "Film 2",
                                                                 "workflow": _wf_of("p_0a1b2c3d", "Film", [])}))
        res = ST.forget(["n_c2"], roots, {"id": "p_0a1b2c3d", "name": "Film"})
        assert res["ok"] and res["removed"] == 1, res
    finally:
        ST._OVERRIDE = None


# ------------------------------------------------------------------------- round 5: Ask's notes, legacy decisions, refs

TYPED_ASK = "remember that the diner sign flickers when Jane Doe walks in"


def _ask(i, ref=None, text=TYPED_ASK):
    n = {"id": i, "text": text, "source": "ask", "by": "ask", "scope": "scene", "scene_id": "sc_1", "why": "written by ask"}
    if ref:
        n["ref"] = ref
    return n


def test_forget_removes_asks_notes_by_ref_and_id_never_pitch_or_director(tmp_path):
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        P = {"id": "p_0a1b2c3d", "name": "Film"}
        pitch = {"id": "n_p", "text": "Pitch: open on the sign", "source": "pitch"}
        mine = {"id": "n_d", "text": "keep the lamp off", "source": "director"}
        ST.save({"v": 1, "notes": [_ask("n_a1", ref="p_0a1b2c3d:turn_5"), pitch, mine, _ask("n_a2")]}, project=P)
        auto = user / "projects" / "Film" / "autosave"
        auto.mkdir(parents=True)
        (user / "workflows").mkdir(parents=True)
        (user / "workflows" / "Film.json").write_text(json.dumps(_wf_with_book([_ask("n_a1", ref="p_0a1b2c3d:turn_5"), _ask("n_a2")])))
        (auto / "20261101-120000-000.json").write_text(json.dumps({"name": "Film", "workflow": _wf_with_book([_ask("n_a1", ref="p_0a1b2c3d:turn_5")])}))
        trash = user / "projects" / ".trash" / "Film 20261102-101010"
        trash.mkdir(parents=True)
        (trash / "workflow.json").write_text(json.dumps(_wf_with_book([_ask("n_a2")])))
        res = ST.forget(["p_0a1b2c3d:turn_5"], [user / "workflows", user / "projects"], P)       # by ref
        assert res["ok"], res
        res = ST.forget(["n_a2"], [user / "workflows", user / "projects"], P)                    # by id
        assert res["ok"], res
        for p in tmp_path.rglob("*.json"):
            assert TYPED_ASK not in p.read_text(), p                   # no copy of Ask's raw note text is left
        assert [n["id"] for n in ST.load()["notes"]] == ["n_p", "n_d"]  # Pitch's and the director's notes stay
    finally:
        ST._OVERRIDE = None


def test_clean_ref_rejects_the_text_squashed():
    t = "make it pour with rain"
    assert ST.clean_ref("p_0a1b2c3d:turn_42", t) == "p_0a1b2c3d:turn_42"
    for bad in [":makeitpourwithrain", ":makeItPourWithRain", ":pour-with-rain", "p_0a1b2c3d:pourwithrain", "make it pour", "x:y", None, 42]:
        assert ST.clean_ref(bad, t) is None, bad
    assert ST.clean_ref(":pourwithrain", "make it pour­with rain") is None     # soft hyphen inside the text


def test_note_route_keeps_only_an_opaque_ref(tmp_path):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from soundstage.book import routes as R
    ST._OVERRIDE = str(tmp_path)
    R._REGISTERED = False
    rt = web.RouteTableDef()
    R.register(rt, send=lambda ev, d: None)
    app = web.Application()
    app.add_routes(rt)

    async def go():
        async with TestClient(TestServer(app)) as c:
            j = await (await c.post("/soundstage/book/note", json={"text": "Sign flickers on entry", "source": "ask", "ref": "p_0a1b2c3d:t_9"})).json()
            assert j["note"]["ref"] == "p_0a1b2c3d:t_9" and j["note"]["source"] == "ask"
            j = await (await c.post("/soundstage/book/note", json={"text": "Sign flickers on entry", "source": "ask", "ref": ":signflickersonentry"})).json()
            assert "ref" not in j["note"]
    try:
        asyncio.run(go())
    finally:
        ST._OVERRIDE = None
        R._REGISTERED = False


TYPED_OLD = "could you make it pour with rain outside the diner please"


def _legacy(i, v, ref=None):
    if v == 1:
        n = {"id": i, "text": TYPED_OLD, "source": "chat", "by": "chat", "why": "decided in the Director chat (weather, lens)"}
    else:
        n = {"id": i, "text": f"Okay: {TYPED_OLD}", "source": "chat", "by": "chat", "dv": 2, "why": "decided in the Director chat (weather, lens)",
             "change": [{"tool": "weather", "args": {"weather": "pour with rain outside", "kind": "rain"}}, {"tool": "lens", "args": {"mm": 50}}]}
    if ref:
        n["ref"] = ref
    return n


def test_legacy_decisions_listed_then_migrated_in_every_server_copy(tmp_path):
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    try:
        ST.save({"v": 1, "notes": [_legacy("n_l1", 1), _dec("n_new"), {"id": "n_d", "text": TYPED_OLD, "source": "director"}]})
        auto = user / "projects" / "Film" / "autosave"
        auto.mkdir(parents=True)
        (user / "workflows").mkdir(parents=True)
        (user / "workflows" / "Film.json").write_text(json.dumps(_wf_with_book([_legacy("n_l2", 2, ref="p_0a1b2c3d:turn_3")])))
        (auto / "20261101-120000-000.json").write_text(json.dumps({"name": "Film", "workflow": _wf_with_book([_legacy("n_l2", 2, ref="p_0a1b2c3d:turn_3")])}))
        trash = user / "projects" / ".trash" / "Old 20261102-101010"
        trash.mkdir(parents=True)
        (trash / "workflow.json").write_text(json.dumps(_wf_with_book([_legacy("n_l3", 2, ref=TYPED_OLD)])))
        roots = [user / "workflows", user / "projects"]
        lst = ST.legacy_decisions(roots)
        assert lst["ok"] and lst["rewritten"] == 0
        by = {d["id"]: d for d in lst["decisions"]}
        assert set(by) == {"n_l1", "n_l2", "n_l3"}
        assert by["n_l2"]["ref"] == "p_0a1b2c3d:turn_3" and len(by["n_l2"]["files"]) == 2 and by["n_l2"]["project_id"] == "p_0a1b2c3d"
        assert TYPED_OLD in (user / "workflows" / "Film.json").read_text()      # listing changes nothing
        res = ST.legacy_decisions(roots, apply=True)
        assert res["ok"] and res["rewritten"] == 1 + 2 * 2 + 1 * 2, res     # book, Film + autosave (2 copies each), trash (2)
        for p in [books / "current.json", user / "workflows" / "Film.json", auto / "20261101-120000-000.json", trash / "workflow.json"]:
            t = p.read_text()
            assert "pour with rain" not in t.replace(f'"text": "{TYPED_OLD}", "source": "director"', ""), p
        wf = json.loads((user / "workflows" / "Film.json").read_text())
        n = wf["nodes"][0]["properties"]["ss_book"]["notes"][0]
        assert n["text"] == "Weather: rain; Lens: 50" or n["text"] == "Weather; Lens: 50", n["text"]
        assert n["change"] == [{"tool": "weather", "args": {}}, {"tool": "lens", "args": {"mm": 50}}]
        assert n["dv"] == 3 and n["migrated"] and n["ref"] == "p_0a1b2c3d:turn_3" and n["id"] == "n_l2"
        b = ST.load()["notes"]
        assert b[0]["text"] == "Weather; Lens" and b[0]["change"] == [{"tool": "weather", "args": {}}, {"tool": "lens", "args": {}}]
        assert b[2]["text"] == TYPED_OLD                                      # the director's own note is theirs
        t3 = json.loads((trash / "workflow.json").read_text())["nodes"][0]["properties"]["ss_book"]["notes"][0]
        assert "ref" not in t3                                                  # an old ref that was chat text goes
        assert ST.legacy_decisions(roots)["decisions"] == []                    # once: nothing left to migrate
        assert ST.forget(["p_0a1b2c3d:turn_3"], roots, {"id": "p_0a1b2c3d", "name": "Film"})["ok"]   # still forgettable by ref
        assert not list(tmp_path.rglob("*.tmp"))
    finally:
        ST._OVERRIDE = None


# ---------------------------------------------------------------- round 6, fix 3: the everywhere retry after a first pass
TYPED_P5 = "please make the rain much heavier outside the diner window"


def _typed_dec(i, ref):
    n = _dec(i, ref=ref)
    n["text"] = TYPED_P5                    # a pre-v3 decision that still holds the typed sentence
    return n


def test_forget_everywhere_retry_after_a_first_pass_removes_the_duplicates_copy(tmp_path):
    """Forget by ref in Film: ok False, other_copies names Film 3.json (a Duplicate, fresh id). The everywhere retry the
    error asks for, with the same ref, must remove Film 3's copy: never ok True with removed 0 while the sentence stays."""
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    ref = "p_0a1b2c3d:turn_9"
    try:
        (user / "workflows").mkdir(parents=True)
        film, film3 = user / "workflows" / "Film.json", user / "workflows" / "Film 3.json"
        film.write_text(json.dumps(_wf_of("p_0a1b2c3d", "Film", [_typed_dec("n_d1", ref)])))
        film3.write_text(json.dumps(_wf_of("p_99999999", "Film 3", [_typed_dec("n_d1", ref)])))
        proj = {"id": "p_0a1b2c3d", "name": "Film"}
        first = ST.forget([ref], [user / "workflows"], proj)
        assert not first["ok"] and first["other_copies"] == [str(film3)], first
        assert first["decision_ids"] == ["n_d1"]
        assert TYPED_P5 not in film.read_text()
        # a second plain pass: this project's copy is gone, the duplicate is still found through the ref's project id
        again = ST.forget([ref], [user / "workflows"], proj)
        assert not again["ok"] and again["other_copies"] == [str(film3)], again
        retry = ST.forget([ref], [user / "workflows"], proj, everywhere=True)
        assert TYPED_P5 not in film3.read_text(), retry
        assert retry["ok"] and retry["removed"] >= 1 and retry["other_copies"] == [], retry
    finally:
        ST._OVERRIDE = None


def test_forget_unprefixed_ref_only_in_another_project_is_never_ok_with_nothing_removed(tmp_path):
    """A ref with no project id (saved before the project had one) is not matched by ref in another project's files
    (it may be an unrelated decision). With this project's copy already gone, the retry removes nothing and must say
    ok False and name the note ids; forgetting those ids with everywhere removes the copy."""
    books, user = tmp_path / "books", tmp_path / "user"
    ST._OVERRIDE = str(books)
    ref = ":turn_9"
    try:
        (user / "workflows").mkdir(parents=True)
        film, film3 = user / "workflows" / "Film.json", user / "workflows" / "Film 3.json"
        film.write_text(json.dumps(_wf_of("p_0a1b2c3d", "Film", [_typed_dec("n_d2", ref)])))
        film3.write_text(json.dumps(_wf_of("p_99999999", "Film 3", [_typed_dec("n_d2", ref)])))
        proj = {"id": "p_0a1b2c3d", "name": "Film"}
        first = ST.forget([ref], [user / "workflows"], proj)
        assert not first["ok"] and first["other_copies"] == [str(film3)] and first["decision_ids"] == ["n_d2"], first
        retry = ST.forget([ref], [user / "workflows"], proj, everywhere=True)
        assert not retry["ok"] and retry["removed"] == 0, retry
        assert retry["ref_elsewhere"] == [str(film3)] and retry["ref_elsewhere_ids"] == ["n_d2"], retry
        assert "Film 3.json" in retry["error"]
        assert TYPED_P5 in film3.read_text()
        done = ST.forget([ref, *first["decision_ids"]], [user / "workflows"], proj, everywhere=True)
        assert done["ok"] and done["removed"] >= 1, done
        assert TYPED_P5 not in film3.read_text()
    finally:
        ST._OVERRIDE = None
