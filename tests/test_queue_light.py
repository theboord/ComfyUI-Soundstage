"""The pod freeze of 2026-11-01: queued prompts stay small (the stage by reference), old inline workflows still work,
and the queue summary route never returns a payload. Served by a real aiohttp app where a route is involved."""
import asyncio
import json
import random
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import stagestore as SS  # noqa: E402
from soundstage import queuewatch as QW  # noqa: E402
from soundstage.takecheck import recipe as R  # noqa: E402
from soundstage.takecheck import timing as T  # noqa: E402

PROMPT_LIMIT = 50 * 1024


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(SS, "_BASE", str(tmp_path))
    return tmp_path


def big_scene(crates=12, frames=121, seed=7):
    """A crate crash: every crate carries its fracture bake (the 1-3 MB that rode in every prompt)."""
    rnd = random.Random(seed)
    actors = [{"id": "car_1", "kind": "sports_car", "name": "Sports car", "position": [0, 0, 0],
               "keys": [{"frame": f, "position": [f * 0.2, 0, 0]} for f in range(0, frames, 4)]}]
    for i in range(crates):
        actors.append({"id": f"crate_{i}", "kind": "crate", "name": f"Crate {i + 1}", "position": [i, 0, 3],
                       "keys": [{"frame": f, "position": [i, 0, 3]} for f in range(0, frames, 8)],
                       "physics": {"bake": [[[round(rnd.uniform(-5, 5), 4) for _ in range(7)] for _ in range(24)]
                                            for _ in range(frames)]}})
    return {"version": 2, "shot": {"frames": frames, "fps": 24, "aspect": "2.39"},
            "camera": {"position": [-7, 1.7, -14], "target": [0, 1.3, -4], "focal_mm": 35},
            "actors": actors, "shots": [{"id": "shot_1", "name": "Chase cam"}], "active_shot": "shot_1",
            "shot_id": "shot_1"}


def stage_value(scene):
    passes = {"clay": "stage_clay_ab.jpg [temp]", "depth": "stage_depth_ab.png [temp]",
              "grid": {"cols": 10, "rows": 13, "frames": 121, "tile": [640, 272]}}
    return json.dumps({"scene": scene, "passes": passes})


def app_prompt(stage):
    """The App's API prompt: 90 nodes like the real one (look, quality, LTX guides, savers) around the 3D Stage."""
    p = {"9045": {"class_type": "SoundstageStage", "inputs": {"stage": stage}, "_meta": {"title": "Soundstage · 3D Stage"}},
         "9070": {"class_type": "SoundstageStep", "inputs": {"step": 4}, "_meta": {"title": "Step"}},
         "9079": {"class_type": "SoundstageLook", "inputs": {"look": json.dumps({"style": "night, rain " * 30}),
                                                             "scene_json": ["9045", 6]}, "_meta": {"title": "Look"}}}
    for i in range(87):
        p[f"9002:{5000 + i}"] = {"class_type": "LTXAddVideoICLoRAGuide",
                                 "inputs": {"positive": ["9079", 0], "negative": ["9079", 1], "vae": ["9001", 2],
                                            "latent": ["9045", 0], "image": ["9045", 1], "frame_idx": -1,
                                            "strength": 0.6, "crf": 29, "blur_radius": 0, "lora_name": "ltx-ic-lora.safetensors"},
                                 "_meta": {"title": "Add IC-LoRA guide"}}
    return p


def app_body(scene):
    stage = stage_value(scene)
    wf = json.loads((ROOT / "example_workflows" / "Soundstage_App.json").read_text())
    for n in wf["nodes"]:
        if n.get("type") == "SoundstageStage":
            n["widgets_values"][0] = json.dumps(scene)
            n["widgets_values_named"] = {"stage": json.dumps(scene)}
    return {"prompt": app_prompt(stage), "client_id": "abc", "extra_data": {"extra_pnginfo": {"workflow": wf}}}


def size(o):
    return len(json.dumps(o))


# ---- the stage store -------------------------------------------------------------------------------------------

def test_put_get_dedupes_and_validates(store):
    h = SS.put('{"a":1}')
    assert len(h) == 64 and SS.get(h) == '{"a":1}'
    assert SS.put('{"a":1}') == h and len(list((store / SS.SUBDIR).glob("*.json"))) == 1
    assert SS.get("../../etc/passwd") is None and SS.get("0" * 64) is None


def test_ref_value_is_canonical_and_small():
    text = stage_value(big_scene())
    v1, v2 = SS.ref_value(text), SS.ref_value(text)
    assert v1 == v2                                   # ComfyUI's cache keys on the input: same scene, same string
    ref = SS.parse_ref(v1)
    assert ref["bytes"] == len(text) and ref["frames"] == 121 and ref["shot_id"] == "shot_1" and len(v1) < 200


def test_resolve_by_reference_and_inline():
    text = stage_value(big_scene(crates=2))
    assert SS.resolve(SS.ref_value(text)) == json.loads(text)
    assert SS.resolve(text) == json.loads(text)        # old saved workflows: inline JSON keeps working
    assert SS.resolve("") == {} and SS.resolve(json.loads(text)) == json.loads(text)
    flagged = json.dumps({**json.loads(SS.ref_value(text)), "look_start": False})
    assert SS.resolve(flagged)["look_start"] is False
    with pytest.raises(SS.StageMissing, match="press Run again"):
        SS.resolve(json.dumps({"stage_ref": "f" * 64, "bytes": 3}))


def test_the_stage_node_loads_by_reference(monkeypatch):
    """SoundstageStage.execute resolves through stagestore.resolve (no ComfyUI needed to check the call site)."""
    src = (ROOT / "soundstage" / "nodes_stage.py").read_text()
    assert "stagestore.resolve(stage)" in src and "json.loads(stage)" not in src


# ---- the queued prompt stays small --------------------------------------------------------------------------------

def test_a_big_scene_queues_under_50_kb():
    scene = big_scene()
    body = app_body(scene)
    before_prompt, before_all = size(body["prompt"]), size(body)
    assert before_prompt > 1_000_000                  # the bug: megabytes of stage per prompt
    R.on_prompt(body)                                 # the recipe tag (another full copy of the scene)
    SS.slim_prompt(body)
    after_prompt, after_all = size(body["prompt"]), size(body)
    assert after_prompt < PROMPT_LIMIT, after_prompt
    pnginfo = body["extra_data"]["extra_pnginfo"]
    assert "scene" not in pnginfo["soundstage"] and len(pnginfo["soundstage"]["scene_ref"]) == 64
    assert size(pnginfo["soundstage"]) < 4096
    assert after_all < before_all / 10
    # Every copy still reads back as the same scene.
    assert SS.resolve(body["prompt"]["9045"]["inputs"]["stage"])["scene"] == scene
    wv = next(n for n in pnginfo["workflow"]["nodes"] if n["type"] == "SoundstageStage")["widgets_values"][0]
    assert SS.resolve(wv) == scene
    named = next(n for n in pnginfo["workflow"]["nodes"] if n["type"] == "SoundstageStage")["widgets_values_named"]["stage"]
    assert named == wv
    assert R.scene_of_ref(pnginfo["soundstage"]["scene_ref"]) == scene


def test_recipe_from_a_reference_prompt_and_its_mp4_tags():
    scene = big_scene(crates=3)
    body = app_body(scene)
    SS.slim_prompt(body)                              # the App's own path: the stage arrives by reference
    R.on_prompt(body)
    rec = body["extra_data"]["extra_pnginfo"]["soundstage"]
    assert rec["scene_ref"] and "scene" not in rec and rec["shot"]["name"] == "Chase cam" and rec["rung"] == "final"
    tags = {"soundstage": json.dumps(rec), "prompt": json.dumps(body["prompt"])}
    back = R.from_tags(tags)
    assert back["scene"] == scene
    back = R.from_tags({"prompt": json.dumps(body["prompt"])})
    assert back["scene"] == scene and back["source"] == "rebuilt from the prompt tag"
    wf = body["extra_data"]["extra_pnginfo"]["workflow"]
    assert R.from_tags({"workflow": json.dumps(wf)})["scene"] == scene


def test_small_and_foreign_prompts_are_left_alone():
    small = stage_value({"version": 2, "shot": {"frames": 97}, "camera": {}, "actors": []})
    body = {"prompt": app_prompt(small)}
    SS.slim_prompt(body)
    assert body["prompt"]["9045"]["inputs"]["stage"] == small
    foreign = {"prompt": {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "x" * 100000}}}}
    SS.slim_prompt(foreign)
    assert len(foreign["prompt"]["1"]["inputs"]["text"]) == 100000
    assert SS.slim_prompt({"prompt": None}) == {"prompt": None}


def test_render_timing_reads_frames_from_the_reference():
    body = app_body(big_scene(crates=2, frames=73))
    SS.slim_prompt(body)
    assert T.rung_of(body["prompt"]) == ("final", 73)


# ---- the queue summary ---------------------------------------------------------------------------------------------

def _item(n, pid, client, prompt, extra=None):
    return (n, pid, prompt, {"client_id": client, **(extra or {})}, ["9"], {})


def queue_state(pending=19):
    big = app_body(big_scene())
    running = [_item(1, "run-1", "app", big["prompt"], {"extra_pnginfo": {"soundstage": {"rung": "final", "shot": {"name": "Chase cam"}}}})]
    pend = [_item(10 + i, f"p-{i}", "app" if i % 2 else "qa", big["prompt"]) for i in range(pending)]
    return running, pend


def test_summarize_counts_ids_and_labels_without_payloads():
    running, pending = queue_state()
    s = QW.summarize(running, pending)
    assert s["running"] == 1 and s["pending"] == 19 and len(s["items"]) == 20
    assert s["items"][0] == {"prompt_id": "run-1", "state": "running", "position": 0, "client_id": "app",
                             "label": "Final · Chase cam", "number": 1}
    assert s["items"][1]["position"] == 1 and s["items"][1]["label"] == "Final"
    assert size(s) < 4000
    mine = QW.summarize(running, pending, ids=["p-3"])
    assert [i["prompt_id"] for i in mine["items"]] == ["p-3"] and mine["items"][0]["position"] == 4 and mine["pending"] == 19
    qa = QW.summarize(running, pending, client_id="qa")
    assert {i["client_id"] for i in qa["items"]} == {"qa"}
    assert len(QW.summarize(running, pending, limit=3)["items"]) == 3


def test_labels():
    assert QW.label_of({"1": {"class_type": "TextGenerate", "inputs": {}}}, {}) == "Model call"
    assert QW.label_of({"1": {"class_type": "SaveGLB", "inputs": {}}}, {}) == "SaveGLB"
    assert QW.label_of({"1": {"class_type": "SoundstageStep", "inputs": {"step": 2}}}, {}) == "Frame"
    assert QW.label_of(None, None) == ""


class _Queue:
    def __init__(self, running, pending):
        self.r, self.p = running, pending

    def get_current_queue_volatile(self):
        return list(self.r), list(self.p)


def _serve(handler):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    async def go():
        routes = web.RouteTableDef()
        running, pending = queue_state()
        QW.register(routes, prompt_queue=_Queue(running, pending))
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as c:
            return await handler(c, running, pending)
    return asyncio.run(go())


def test_queue_summary_route_is_small_and_fast():
    async def h(c, running, pending):
        full = len(json.dumps({"queue_running": running, "queue_pending": pending}))
        t0 = time.perf_counter()
        r = await c.get("/soundstage/queue_summary")
        dt = time.perf_counter() - t0
        body = await r.read()
        j = json.loads(body)
        assert r.status == 200 and j["running"] == 1 and j["pending"] == 19
        assert len(body) < 4000 and full > 20_000_000      # what GET /queue would have encoded (20 big prompts)
        assert dt < 0.5
        r = await c.get("/soundstage/queue_summary?ids=p-1,p-2&client_id=app")
        j = await r.json()
        assert [i["prompt_id"] for i in j["items"]] == ["p-1"]
    _serve(h)


def test_stage_store_routes():
    async def h(c, *_):
        text = stage_value(big_scene(crates=2))
        r = await c.post("/soundstage/stage_store", data=text)
        j = await r.json()
        assert r.status == 200 and SS.parse_ref(j["value"])["stage_ref"] == j["stage_ref"] and j["bytes"] == len(text)
        r = await c.get(f"/soundstage/stage_store/{j['stage_ref']}")
        assert r.status == 200 and await r.text() == text
        assert (await c.get("/soundstage/stage_store/" + "0" * 64)).status == 404
        assert (await c.get("/soundstage/stage_store/nothex")).status == 400
        assert (await c.post("/soundstage/stage_store", data="not json")).status == 400
        assert (await c.post("/soundstage/stage_store", data="")).status == 400
    _serve(h)


# ---- nobody polls the full queue or history --------------------------------------------------------------------------

def test_no_code_fetches_the_full_queue_or_history():
    """GET /queue and GET /history (no id) encode every prompt in full: the App, the tools and the QA drivers use
    /soundstage/queue_summary and /history/{prompt_id}. POST /queue {delete} (cancel) is fine."""
    import re
    bad = []
    pat = re.compile(r"""(fetchApi\(|fetch\(|json\(api,\s*|_get\(|\.get\()\s*[`'"f]*[^`'"]*?/(queue|history)[`'"?]""")
    for d in ("web", "tools", "soundstage"):
        for f in (ROOT / d).rglob("*"):
            if f.suffix not in (".js", ".mjs", ".py") or "vendor" in f.parts or f.name == "api.js":
                continue
            for i, line in enumerate(f.read_text(errors="ignore").splitlines(), 1):
                if pat.search(line) and "method: \"POST\"" not in line and "queue_summary" not in line:
                    bad.append(f"{f.relative_to(ROOT)}:{i}: {line.strip()[:120]}")
    assert not bad, "\n".join(bad)
