"""Director's assistant (Milestone 15): the typed tool layer, validation, words -> plan (rules and model answers), the
GPU confirm gate, undoable edit ops, the HTTP routes (incl. the MCP propose/apply bridge), Whisper audio plumbing and
the MCP stdio server."""
import asyncio
import copy
import io
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.agent import director as D  # noqa: E402
from soundstage.agent import ops as O  # noqa: E402
from soundstage.agent import whisper as W  # noqa: E402

DEMO = json.loads((ROOT / "tests" / "agent_fixtures" / "director_demo.json").read_text())
CTX = {"shots": [{"id": s["id"], "name": s["name"]} for s in DEMO["shots"]],
       "scenes": [{"id": "sc_1", "number": "1", "heading": "EXT. DESERT OUTSIDE DRY CREEK - DUSK"},
                  {"id": "sc_2", "number": "2", "heading": "EXT. DRY CREEK - MAIN STREET - NIGHT"}]}


def tools(plan):
    return [c["tool"] for c in plan["calls"]]


def args(plan, tool):
    return next(c["args"] for c in plan["calls"] if c["tool"] == tool)


# ------------------------------------------------------------------------------------------- schema

def test_every_tool_is_documented_and_typed():
    specs = D.tool_specs()
    names = [t["name"] for t in specs]
    assert len(names) == len(set(names)) >= 30
    for t in specs:
        assert t["doc"] and t["kind"] in ("edit", "app")
        for a, spec in t["args"].items():
            assert spec["type"] in ("text", "name", "person", "vehicle", "seat", "place", "enum", "int", "num", "shot", "shots", "scene", "names")
            if spec["type"] == "enum":
                assert spec["enum"]
    gpu = {t["name"] for t in specs if t["gpu"]}
    assert gpu == {"frames", "render"}
    # The model's system prompt lists every tool.
    for n in names:
        assert f'"tool":"{n}"' in D.DIRECTOR_SYSTEM


def test_json_schema_round_trip():
    json.dumps(D.tool_specs())


# ------------------------------------------------------------------------------------------- validation

@pytest.mark.parametrize("raw,why", [
    ({"tool": "explode"}, "no tool"),
    ({"tool": "remove", "target": "unicorn"}, "nothing called"),
    ({"tool": "time", "preset": "teatime"}, "isn't one of"),
    ({"tool": "mount", "target": "Sports car", "on": "Police car"}, "isn't a person"),
    ({"tool": "mount", "target": "Mara", "on": "Mara"}, "can.t sit in"),
    ({"tool": "move", "target": "Mara"}, "say where"),
    ({"tool": "render", "kind": "draft", "shots": [9]}, "no shot"),
    ({"tool": "scene", "scene": 7}, "no script scene"),
    ({"tool": "lens"}, "needs 'mm'"),
    ("not a dict", "not a tool call"),
])
def test_bad_calls_are_rejected_with_a_reason(raw, why):
    with pytest.raises(D.Invalid, match=why):
        D.validate_call(raw, D.normalize_scene(DEMO), CTX)


def test_numbers_are_clamped_and_enums_normalised():
    w = D.normalize_scene(DEMO)
    assert D.validate_call({"tool": "lens", "mm": 2000}, w, CTX)["args"]["mm"] == 400
    assert D.validate_call({"tool": "lens", "mm": "35mm"}, w, CTX)["args"]["mm"] == 35
    assert D.validate_call({"tool": "stunt", "stunt": "J-turn"}, w, CTX)["args"]["stunt"] == "reverse_jturn"
    c = D.validate_call({"tool": "camera_move", "move": "dolly in"}, w, CTX)
    assert c["args"] == {"move": "push_in", "speed": "medium"}
    assert D.validate_call({"tool": "time_of_day", "preset": "sunset"}, w, CTX)["tool"] == "time"


def test_names_resolve_to_ids_and_vehicle_defaults():
    w = D.normalize_scene(DEMO)
    c = D.validate_call({"tool": "mount", "target": "mara", "on": "the sports car"}, w, CTX)
    assert c["args"]["target_id"] == "getaway" and c["args"]["on_id"] == "sports_car"
    # A stunt with no car named goes to the car someone is driving.
    c = D.validate_call({"tool": "stunt", "stunt": "donut"}, w, CTX)
    assert c["args"]["target_id"] == "sports_car"
    # A rider named for a vehicle tool means the vehicle they ride.
    c = D.validate_call({"tool": "stunt", "target": "Deputy Cole", "stunt": "donut"}, w, CTX)
    assert c["args"]["target_id"] == "police_car"


def test_shot_references():
    w = D.normalize_scene(DEMO)
    assert D.resolve_shots("1-3", w, CTX) == ["crane", "tracking", "chase"]
    assert D.resolve_shots([2, "3"], w, CTX) == ["tracking", "chase"]
    assert D.resolve_shots("all", w, CTX) == ["crane", "tracking", "chase"]
    assert D.resolve_shot("crane", w, CTX) == "crane"
    assert D.resolve_shot("last", w, CTX) == "chase"
    assert D.resolve_shot("shot two", w, CTX) == "tracking"
    assert D.resolve_shot(5, w, CTX) is None
    # Strip order wins over scene order.
    ctx = {"shots": [{"id": "chase", "name": "Chase"}, {"id": "crane", "name": "Wide"}]}
    assert D.resolve_shot(1, w, ctx) == "chase"


# ------------------------------------------------------------------------------------------- words -> plan (rules)

def test_mikes_seven_commands_plan_sensibly():
    p = D.plan("Put Mara in the sports car at night, rain, camera on the hood, she's nervous", DEMO, CTX)
    assert tools(p) == ["mount", "time", "weather", "camera_on", "direct"]
    assert args(p, "time")["preset"] == "night" and args(p, "weather")["weather"] == "rain"
    assert args(p, "camera_on") == {"view": "hood", "target": "Sports car", "target_id": "sports_car"}
    assert args(p, "direct")["who_id"] == "getaway" and args(p, "direct")["note"] == "nervous"

    p = D.plan("Make shot 2 a slow push-in at 50 mm", DEMO, CTX)
    assert tools(p) == ["select_shot", "camera_move", "lens"]
    assert args(p, "select_shot")["shot"] == "tracking" and args(p, "camera_move")["speed"] == "slow" and args(p, "lens")["mm"] == 50

    p = D.plan("Drop a crate stack by the wall and have the car crash through it", DEMO, CTX)
    assert tools(p) == ["stack", "physics", "drive", "bake"]
    stack_ids = [o["object"]["id"] for o in p["calls"][0]["ops"]]
    assert args(p, "physics")["target_ids"] == stack_ids == args(p, "drive")["through_ids"]
    assert args(p, "drive")["target_id"] == "sports_car" and args(p, "physics")["mode"] == "dynamic"

    p = D.plan("Use the J-turn stunt", DEMO, CTX)
    assert tools(p) == ["stunt"] and args(p, "stunt")["stunt"] == "reverse_jturn"

    p = D.plan("Make the first frame warmer", DEMO, CTX)
    assert tools(p) == ["grade"] and args(p, "grade")["warmth"] > 0

    p = D.plan("Render a draft of shots 1 to 3", DEMO, CTX)
    assert tools(p) == ["render"] and args(p, "render") == {"kind": "draft", "shots": ["crane", "tracking", "chase"]}
    assert p["confirm"] is True and p["gpu"] == 1

    p = D.plan("Cut it together with the best takes", DEMO, CTX)
    assert tools(p) == ["cut"] and not p["confirm"]


@pytest.mark.parametrize("cmd,expect", [
    ("go to scene 1", ["scene"]),
    ("approve shot 1", ["approve"]),
    ("shot 3 needs changes: too dark", ["approve"]),
    ("move the camera lower", ["reframe"]),
    ("add a dog next to the lamp", ["add"]),
    ("undo", ["undo"]),
    ("make it foggy and dawn", ["weather", "time"]),
    ("handheld", ["rig"]),
    ("do donuts with the police car", ["stunt"]),
    ("paint 3 frames for shot 2", ["frames"]),
    ("bake the physics", ["bake"]),
    ("play it", ["play"]),
    ("new scene: two cowboys face off at noon", ["build"]),
    ("crane up slowly on the crane shot", ["select_shot", "camera_move"]),
    ("Deputy Cole looks angry", ["direct"]),
])
def test_more_commands(cmd, expect):
    p = D.plan(cmd, DEMO, CTX)
    assert tools(p) == expect, (cmd, p["calls"], p["rejected"])


def test_note_and_count_parsing():
    p = D.plan("shot 3 needs changes: too dark", DEMO, CTX)
    assert args(p, "approve") == {"status": "changes", "note": "too dark", "shot": "chase"}
    assert args(D.plan("paint 3 frames for shot 2", DEMO, CTX), "frames") == {"count": 3, "shots": ["tracking"]}


def test_nonsense_gives_nothing_not_a_crash():
    p = D.plan("the mitochondria is the powerhouse of the cell", DEMO, CTX)
    assert p["calls"] == [] and p["summary"]
    assert D.plan("", DEMO, CTX)["calls"] == []
    assert D.plan("make it rain", {}, {})["calls"][0]["tool"] == "weather"   # an empty scene still plans


# ------------------------------------------------------------------------------------------- the confirm gate

@pytest.mark.parametrize("cmd,confirm", [
    ("render a draft of shot 2", True),
    ("paint frames for shot 1", True),
    ("render a draft of shot 2, go", False),
    ("go ahead and render the final of shot 1", False),
    ("go to scene 2 and render a draft", True),   # "go to" is not "go"
    ("make it rain", False),
])
def test_gpu_needs_confirmation_unless_go(cmd, confirm):
    assert D.plan(cmd, DEMO, CTX)["confirm"] is confirm


def test_typed_calls_always_confirm_gpu():
    r = D.run_calls([{"tool": "render", "kind": "final", "shots": "all"}], DEMO, CTX)
    assert r["confirm"] and r["calls"][0]["args"]["shots"] == ["crane", "tracking", "chase"]


# ------------------------------------------------------------------------------------------- model answers

def test_model_answer_is_used_when_it_covers_the_rules():
    llm = '```json\n{"calls":[{"tool":"weather","weather":"rain"},{"tool":"time","preset":"night"},{"tool":"add","what":"dog","near":"lamp"}]}\n```'
    p = D.plan("make it rain at night", DEMO, CTX, llm)
    assert p["backend"] == "llm" and tools(p) == ["weather", "time", "add"]


def test_rules_win_when_the_model_misses_something():
    p = D.plan("make it rain at night", DEMO, CTX, '{"calls":[{"tool":"weather","weather":"rain"}]}')
    assert p["backend"] == "rules" and sorted(tools(p)) == ["time", "weather"]


def test_rules_args_win_for_exact_tools():
    # The 4B model gets the shot range wrong; the rules read the numbers.
    p = D.plan("render a draft of shots 1 to 3", DEMO, CTX, '{"calls":[{"tool":"render","kind":"draft","shots":[1]}]}')
    assert args(p, "render")["shots"] == ["crane", "tracking", "chase"]


def test_unreadable_or_invalid_model_answers_fall_back():
    p = D.plan("make it rain", DEMO, CTX, "Sure! I will make it rain.")
    assert p["backend"].startswith("rules") and tools(p) == ["weather"]
    p = D.plan("make it rain", DEMO, CTX, '{"calls":[{"tool":"nuke_the_set"},{"tool":"remove","target":"unicorn"}]}')
    assert p["backend"] == "rules" and tools(p) == ["weather"]


def test_model_echoing_the_scene_is_a_no_op():
    # Qwen3.5 4B, measured: "Use the J-turn stunt" -> set/time/weather the scene already has, then the stunt.
    llm = '{"calls":[{"tool":"set","set":"street_night"},{"tool":"time","preset":"magic_hour"},{"tool":"weather","weather":"none"},{"tool":"stunt","stunt":"reverse_jturn"}]}'
    p = D.plan("Use the J-turn stunt", DEMO, CTX, llm)
    assert tools(p) == ["stunt"] and any(n.startswith("already") for n in p["notes"])


def test_model_answer_shapes():
    assert D.parse_llm('{"tool":"play"}') == [{"tool": "play"}]
    assert D.parse_llm('[{"tool":"play"},{"tool":"undo"}]') == [{"tool": "play"}, {"tool": "undo"}]
    oa = '{"tool_calls":[{"function":{"name":"lens","arguments":"{\\"mm\\": 85}"}}]}'
    assert D.parse_llm(oa) == [{"tool": "lens", "mm": 85}]
    assert D.parse_llm("no json here") == []


def test_prompt_carries_the_scene_and_numbered_shots():
    p = D.prompt("make it rain", DEMO, CTX)
    assert "Mara (woman, in Sports car)" in p["prompt"] and "1=Wide crane" in p["prompt"] and "Command: make it rain" in p["prompt"]
    assert "2=EXT. DRY CREEK" in p["prompt"] and p["max_length"] == D.MAX_LENGTH


# ------------------------------------------------------------------------------------------- ops are undoable

def test_edit_ops_apply_and_invert():
    p = D.plan("Drop a crate stack by the wall, make it foggy, move the camera lower", DEMO, CTX)
    ops = [o for c in p["calls"] if c.get("ops") for o in c["ops"]]
    assert ops and all("undo" in o for o in ops)
    after = O.apply_ops(D.normalize_scene(DEMO), ops)
    assert after["environment"]["weather"] == "fog"
    crates = [a for a in after["actors"] if a["kind"] == "crate"]
    assert len(crates) == 5 and len({a["id"] for a in crates}) == 5 and len({a["stack"] for a in crates}) == 1
    assert any(a["position"][1] > 0.5 for a in crates)   # a second layer on top
    back = O.apply_ops(after, O.inverse(ops))
    base = D.normalize_scene(DEMO)
    assert [a["id"] for a in back["actors"]] == [a["id"] for a in base["actors"]]
    assert back["environment"] == base["environment"]
    assert back["shots"] == base["shots"]


def test_plans_never_mutate_the_scene():
    before = copy.deepcopy(DEMO)
    D.plan("Drop a crate stack by the wall and have the car crash through it, rain, shot 2 at 85mm", DEMO, CTX)
    assert DEMO == before


def test_select_shot_carries_into_later_edits():
    p = D.plan("on shot 3, move the camera lower", DEMO, CTX)
    assert tools(p) == ["select_shot", "reframe"]
    assert p["calls"][1]["ops"][0]["id"] == "chase"


# ------------------------------------------------------------------------------------------- routes

def _wav(seconds=1.0, rate=22050, freq=440.0):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(seconds * rate)
        frames = b"".join(int(8000 * math.sin(2 * math.pi * freq * i / rate)).to_bytes(2, "little", signed=True) * 2 for i in range(n))
        w.writeframes(frames)
    return buf.getvalue()


def test_wav_decode_and_resample():
    x, sr = W.decode_wav(_wav(0.5, 22050))
    assert sr == 22050 and abs(len(x) - 11025) <= 1 and x.max() > 0.2
    y = W.resample(x, sr, 16000)
    assert abs(len(y) - 8000) <= 1


def test_find_model_uses_env_dir(tmp_path, monkeypatch):
    d = tmp_path / "whisper" / "whisper-base"
    d.mkdir(parents=True)
    (d / "config.json").write_text("{}")
    monkeypatch.setenv("SOUNDSTAGE_WHISPER_DIR", str(tmp_path / "whisper"))
    assert W.find_model() == str(d)


def test_http_routes_and_mcp_bridge(monkeypatch):
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")
    from soundstage.agent import director_routes as R

    monkeypatch.setattr(W, "transcribe", lambda data, lang="en": {"text": f"make it rain ({len(data)} bytes)", "seconds": 1.0, "ms": 5, "model": "fake"})
    sent = []

    async def main():
        table = web.RouteTableDef()
        state = {}

        def send(ev, data, sid=None):
            sent.append((ev, data, sid))
            # The App answers the apply a moment later, like the browser panel does.
            async def answer():
                await asyncio.sleep(0.05)
                async with aiohttp.ClientSession() as s2:
                    await s2.post(state["base"] + "/soundstage/director/result",
                                  json={"id": data["id"], "result": {"ok": True, "said": [p for p in data.get("plan", {}).get("plan", [])]}})
            asyncio.get_running_loop().create_task(answer())

        R.STATE.update(scene=None, ctx={}, t=0, sid=None)
        R.register(table, send=send)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = state["base"] = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(base + "/soundstage/director/info") as r:
                    j = await r.json()
                    assert r.status == 200 and len(j["tools"]) >= 30 and "whisper" in j
                async with s.post(base + "/soundstage/director/prompt", json={"command": "rain", "scene": DEMO, "ctx": CTX}) as r:
                    assert "Command: rain" in (await r.json())["prompt"]
                async with s.post(base + "/soundstage/director/plan", json={"command": "Use the J-turn stunt", "scene": DEMO, "ctx": CTX}) as r:
                    j = await r.json()
                    assert r.status == 200 and j["calls"][0]["tool"] == "stunt" and "ms" in j
                async with s.post(base + "/soundstage/director/plan", json={"command": "x"}) as r:
                    assert r.status == 400
                async with s.post(base + "/soundstage/director/calls", json={"calls": [{"tool": "lens", "mm": 85}], "scene": DEMO}) as r:
                    assert (await r.json())["calls"][0]["args"]["mm"] == 85
                async with s.post(base + "/soundstage/director/transcribe", data=_wav(0.3), headers={"Content-Type": "audio/wav"}) as r:
                    j = await r.json()
                    assert r.status == 200 and j["text"].startswith("make it rain")
                async with s.post(base + "/soundstage/director/transcribe", data=b"") as r:
                    assert r.status == 400
                # MCP bridge: nothing open yet -> 409; the App reports its scene; propose is a dry run; apply asks the App.
                async with s.post(base + "/soundstage/director/propose", json={"command": "make it rain"}) as r:
                    assert r.status == 409
                async with s.get(base + "/soundstage/director/state") as r:
                    assert (await r.json())["connected"] is False
                async with s.post(base + "/soundstage/director/state", json={"scene": DEMO, "ctx": CTX, "client_id": "tab1"}) as r:
                    assert r.status == 200
                async with s.get(base + "/soundstage/director/state") as r:
                    j = await r.json()
                    assert j["connected"] and "Mara" in j["summary"]
                async with s.post(base + "/soundstage/director/propose", json={"command": "make it rain"}) as r:
                    prop = await r.json()
                    assert prop["dry_run"] and prop["plan_id"] and prop["calls"][0]["tool"] == "weather"
                assert sent == []                       # a proposal never reaches the App
                async with s.post(base + "/soundstage/director/apply", json={"plan_id": prop["plan_id"]}) as r:
                    j = await r.json()
                    assert r.status == 200 and j["ok"] and j["said"] == ["I'll bring in rain"]
                assert sent[0][0] == "soundstage.director" and sent[0][1]["kind"] == "apply" and sent[0][2] == "tab1"
                async with s.post(base + "/soundstage/director/apply", json={"plan_id": prop["plan_id"]}) as r:
                    assert r.status == 404               # a plan runs once
                # GPU plans need confirm_gpu.
                async with s.post(base + "/soundstage/director/propose", json={"calls": [{"tool": "render", "kind": "draft", "shots": [1]}]}) as r:
                    gp = await r.json()
                    assert gp["gpu"] == 1 and "confirm_gpu" in gp["next"]
                async with s.post(base + "/soundstage/director/apply", json={"plan_id": gp["plan_id"]}) as r:
                    assert r.status == 409 and len(sent) == 1
                async with s.post(base + "/soundstage/director/result", json={"id": "nobody"}) as r:
                    assert r.status == 404
        finally:
            await runner.cleanup()
            R.STATE.update(scene=None, ctx={}, t=0, sid=None)

    asyncio.run(main())


# ------------------------------------------------------------------------------------------- MCP stdio server

def test_mcp_server_speaks_the_protocol_without_comfyui():
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "soundstage_state", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "nope"}]
    p = subprocess.run([sys.executable, str(ROOT / "tools" / "soundstage_mcp.py")], input="\n".join(json.dumps(m) for m in msgs),
                       capture_output=True, text=True, timeout=60, env={"SOUNDSTAGE_URL": "http://127.0.0.1:9", "PATH": "/usr/bin:/bin"})
    out = [json.loads(x) for x in p.stdout.splitlines()]
    assert [o["id"] for o in out] == [1, 2, 3, 4]
    assert out[0]["result"]["serverInfo"]["name"] == "soundstage"
    names = [t["name"] for t in out[1]["result"]["tools"]]
    assert {"soundstage_state", "soundstage_direct", "soundstage_apply", "soundstage_undo"} <= set(names)
    assert out[2]["result"]["isError"] and "can't reach ComfyUI" in out[2]["result"]["content"][0]["text"]
    assert out[3]["error"]["code"] == -32601


def test_mcp_typed_tool_schemas():
    sys.path.insert(0, str(ROOT / "tools"))
    import soundstage_mcp as M
    by = {t["name"]: t for t in D.tool_specs()}
    s = M._schema_for(by["render"])
    assert s["properties"]["kind"]["enum"] == ["draft", "final"] and "confirm_gpu" in s["properties"] and s["required"] == ["kind"]
    assert s["properties"]["dry_run"]["default"] is True
    assert M._schema_for(by["lens"])["properties"]["mm"]["maximum"] == 400


def test_voice_transcripts_plan_like_typing():
    # What whisper-base wrote for the `say` test clips (Milestone 15 evidence).
    p = D.plan("Make shot to a slow push in at 50 millimeters.", DEMO, CTX)
    assert tools(p) == ["select_shot", "camera_move", "lens"] and args(p, "select_shot")["shot"] == "tracking"
    p = D.plan("render a draft of shots 1-3.", DEMO, CTX)
    assert args(p, "render")["shots"] == ["crane", "tracking", "chase"]
    p = D.plan("Put Mara in the sports car at night. Rain, camera on the hood.", DEMO, CTX)
    assert tools(p) == ["mount", "time", "weather", "camera_on"]
    assert D.hear("do a jay turn") == "do a J-turn"


# ------------------------------------------------------------------------------------------- JS fixture
# tests/js/director.test.mjs runs these exact plans through the browser executors (python3 tests/test_director.py --write-fixture).
PLAN_FIXTURE = ROOT / "tests" / "agent_fixtures" / "director_plans.json"
FIXTURE_COMMANDS = [
    "Put Mara in the sports car at night, rain, camera on the hood, she's nervous",
    "Make shot 2 a slow push-in at 50 mm",
    "Drop a crate stack by the wall and have the car crash through it",
    "Use the J-turn stunt",
    "Make the first frame warmer",
    "Render a draft of shots 1 to 3",
    "Cut it together with the best takes",
    "approve shot 1",
]


def _fixture():
    return {"scene": DEMO, "ctx": CTX, "plans": {c: D.plan(c, DEMO, CTX) for c in FIXTURE_COMMANDS}}


def test_js_fixture_is_current():
    assert json.loads(PLAN_FIXTURE.read_text()) == json.loads(json.dumps(_fixture())), "run: python3 tests/test_director.py --write-fixture"


if __name__ == "__main__" and "--write-fixture" in sys.argv:
    PLAN_FIXTURE.write_text(json.dumps(_fixture(), indent=0))
    print("wrote", PLAN_FIXTURE)
