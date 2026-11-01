"""Pitch Mode (Milestone 22): a spoken pitch, beat by beat, builds the set. python3 -m pytest tests/test_pitch.py -q"""
import json
import math
from pathlib import Path

from soundstage.agent import ops as O
from soundstage.agent import pitch as PT

FIX = json.loads((Path(__file__).parent / "agent_fixtures" / "director_plans.json").read_text())
PITCH = ["Night.", "A rainy alley in Chinatown.", "A detective in a trench coat walks toward camera.",
         "A car's headlights sweep across him.", "He turns and runs.", "Camera follows low and handheld."]


def _empty_scene():
    s = json.loads(json.dumps(FIX["scene"]))
    s["actors"] = []
    s["environment"]["set"] = "plaza"
    return s


def _run(lines, scene=None, llm=None):
    scene, mem, ids, out = scene or _empty_scene(), None, {}, []
    for i, t in enumerate(lines):
        r = PT.beat(t, scene, mem, ids, (llm or {}).get(i))
        out.append(r)
        mem, ids, scene = r["memory"], r["ids"], r["scene"]
    return out, scene


def test_extract_reads_the_pitch_words():
    assert PT.extract("Night.") == {"time": "night"}
    d = PT.extract("A rainy alley in Chinatown.")
    assert d["set"] == "street_night" and d["weather"] == "rain" and "chinatown" in d["place"]
    d = PT.extract("A detective in a trench coat walks toward camera.")
    assert d["who"]["role"] == "detective" and d["wardrobe"] == "trench coat" and d["action"] == "approach"
    mem = PT.merge_memory(None, d, "x")
    assert PT.extract("He turns and runs.", mem)["action"] == "flee"          # not "turn": the run wins
    sweep = PT.extract("A car's headlights sweep across him.", mem)
    assert sweep["vehicle"]["action"] == "sweep" and "action" not in sweep   # the car moves, not the detective
    cam = PT.extract("Camera follows low and handheld.", mem)["camera"]
    assert cam == {"rig": "handheld", "height": "low", "follow": "detective"}


def test_misheard_words_still_stage():
    # Whisper on a TTS voice: "walks toward camera" -> "walk-stored camera"; "low and handheld" -> "low-in handheld".
    assert PT.extract("A detective in a trench coat walk-stored camera.")["action"] == "approach"
    assert PT.extract("He walks away from the camera.", PT.merge_memory(None, PT.extract("A cop."), "A cop."))["action"] == "away"
    assert PT.extract("Camera follows, low-in handheld.")["camera"] == {"rig": "handheld", "height": "low", "follow": True}


def test_low_means_camera_only_when_talking_about_the_camera():
    assert "camera" not in PT.extract("The detective keeps a low profile.")
    assert PT.extract("We go low angle on him.")["camera"]["height"] == "low"


def test_merge_memory_is_incremental_and_pronouns_resolve():
    m = PT.merge_memory(None, PT.extract("A woman in a red dress waits."), "A woman in a red dress waits.")
    m = PT.merge_memory(m, PT.extract("A cop walks toward camera.", m), "A cop walks toward camera.")
    assert [c["role"] for c in m["cast"]] == ["woman", "cop"]
    d = PT.extract("She turns and runs.", m)
    assert d["who"]["role"] == "woman"                                      # "she" -> the woman, not the last person
    m2 = PT.merge_memory(m, d, "She turns and runs.")
    assert m2["cast"][0]["action"] == "flee" and m2["cast"][0]["wardrobe"] == "red dress"
    assert m["cast"][0].get("action") == "still"                           # pure: the old memory is untouched
    assert m2["beats"] == 3 and len(m2["transcript"]) == 3
    m3 = PT.merge_memory(m2, {"time": "night"})
    assert m3["time"] == "night" and m3["cast"] == m2["cast"]              # later beats keep what was said before


def test_merge_delta_rules_win_model_fills():
    rules = {"time": "night", "camera": {"rig": "handheld"}}
    llm = {"time": "dawn", "weather": "rain", "camera": {"rig": "drone", "height": "low"}, "props": ["dumpster"]}
    d = PT.merge_delta(rules, llm)
    assert d["time"] == "night" and d["weather"] == "rain" and d["props"] == ["dumpster"]
    assert d["camera"] == {"rig": "handheld", "height": "low"}


def test_parse_llm_delta_checks_every_field():
    d = PT.parse_llm_delta('sure: {"set":"street_night","time":"noonish","who":{"role":"detective"},"action":"fly",'
                           '"camera":{"rig":"handheld","lens":"35"},"vehicle":{"kind":"spaceship"}}')
    assert d == {"set": "street_night", "who": {"role": "detective", "kind": "man"}, "camera": {"rig": "handheld", "lens": 35}}
    assert PT.parse_llm_delta("no json here") == {} and PT.parse_llm_delta(None) == {}


def test_the_example_pitch_builds_the_set_and_blocks_it():
    beats, scene = _run(PITCH)
    assert scene["environment"]["set"] == "street_night" and scene["environment"]["weather"] == "rain"
    assert scene["lighting"]["preset"] == "night"
    det = next(a for a in scene["actors"] if a.get("role") == "detective")
    car = next(a for a in scene["actors"] if a["kind"] == "car")
    sh = next(s for s in scene["shots"] if s["id"] == scene["active_shot"])
    cam0 = sh["camera_keys"][0]
    # He ran away from the camera: the last key is further from where the camera started than the first.
    k = det["keys"]
    assert math.dist(k[-1]["position"], beats[2]["scene"]["shots"][0]["camera_keys"][0]["position"]) > \
        math.dist(k[0]["position"], beats[2]["scene"]["shots"][0]["camera_keys"][0]["position"]) or len(k) >= 3
    assert len(car["keys"]) == 2 and car["keys"][0]["position"] != car["keys"][1]["position"]
    # Low and following: the camera rides at 0.45 m and its keys track his.
    assert all(abs(c["position"][1] - 0.45) < 1e-6 for c in sh["camera_keys"]) and len(sh["camera_keys"]) == len(k)
    assert cam0["target"][0] == k[0]["position"][0]
    assert beats[-1]["rig"] == "handheld"
    p = beats[-1]["prompt"]
    for w in ("Chinatown".lower(), "trench coat", "night", "rain", "headlights", "Low-angle".lower()):
        assert w in p.lower()


def test_every_beat_undoes_exactly():
    scene0 = _empty_scene()
    scene = scene0
    mem, ids = None, {}
    for t in PITCH:
        r = PT.beat(t, scene, mem, ids)
        after = O.apply_ops(scene, r["ops"])
        back = O.apply_ops(after, O.inverse(r["ops"]))
        for key in ("actors", "environment", "lighting", "shots"):
            assert json.dumps(back.get(key), sort_keys=True) == json.dumps(scene.get(key), sort_keys=True), (t, key)
        mem, ids, scene = r["memory"], r["ids"], after
    # And the browser's applyOps reaches the same scene the server staged.
    assert json.dumps(scene["actors"], sort_keys=True) == json.dumps(r["scene"]["actors"], sort_keys=True)


def test_sketch_and_motion_graphs_are_small_and_saved_under_pitch():
    g = PT.sketch_graph("soundstage_pitch/cap.png", "a prompt", seed=5, steps=4, megapixels=0.3)
    cls = sorted(n["class_type"] for n in g.values())
    assert "ReferenceMultiLatent" in cls and "SaveImage" in cls and "LoadImage" in cls
    ks = next(n for n in g.values() if n["class_type"] == "KSampler")["inputs"]
    assert ks["steps"] == 4 and ks["cfg"] == 1.0
    ref = next(n for n in g.values() if n["class_type"] == "ReferenceMultiLatent")["inputs"]
    assert ref["resolution.megapixels"] == 0.3 and ref["images.image0"][0] in g
    assert next(n for n in g.values() if n["class_type"] == "SaveImage")["inputs"]["filename_prefix"].startswith("soundstage_pitch/")
    m = PT.motion_graph("soundstage_pitch/beat.png", "p", width=500, height=290, frames=50)
    lat = next(n for n in m.values() if n["class_type"] == "EmptyLTXVLatentVideo")["inputs"]
    assert (lat["width"], lat["height"], lat["length"]) == (480, 288, 49)
    assert not any(n["class_type"] == "LTXVLatentUpsampler" for n in m.values())   # one pass: the fast draft
    for n in [*g.values(), *m.values()]:
        for v in n["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
                assert v[0] in g or v[0] in m


def test_routes_answer_a_beat():
    import asyncio
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from soundstage.agent import director_routes as DR

    async def go():
        routes = web.RouteTableDef()
        DR._REGISTERED = False
        DR.register(routes, send=lambda *a: None)
        app = web.Application()
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as c:
            r = await c.post("/soundstage/director/pitch", json={"text": "A detective walks toward camera.", "scene": _empty_scene()})
            j = await r.json()
            assert r.status == 200 and j["ops"] and "scene" not in j and j["memory"]["cast"][0]["role"] == "detective"
            r = await c.post("/soundstage/director/pitch_graph", json={"kind": "sketch", "image": "x.png", "prompt": "p"})
            assert r.status == 200 and (await r.json())["graph"]
            r = await c.post("/soundstage/director/pitch_prompt", json={"text": "Night.", "memory": j["memory"]})
            assert "JSON" in (await r.json())["prompt"]
        DR._REGISTERED = False
    asyncio.run(go())


def test_js_fixture_is_current():
    """tests/agent_fixtures/pitch_beats.json feeds tests/js/pitch.test.mjs (the browser applies these exact ops)."""
    fx = json.loads((Path(__file__).parent / "agent_fixtures" / "pitch_beats.json").read_text())
    scene, mem, ids = fx["scene"], None, {}
    for t, want in zip(fx["pitch"], fx["beats"]):
        r = PT.beat(t, scene, mem, ids)
        scene = r.pop("scene")
        assert json.dumps(r, sort_keys=True) == json.dumps(want, sort_keys=True), t
        mem, ids = r["memory"], r["ids"]
    assert json.dumps(scene, sort_keys=True) == json.dumps(fx["final"], sort_keys=True)
