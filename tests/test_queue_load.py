"""Load test for the pod freeze of 2026-11-01: queue 20 big-scene App renders through a stub ComfyUI server (real
aiohttp app, ComfyUI's own POST /prompt -> on-prompt handlers -> PromptQueue and GET /queue shapes) and measure what
one GET /queue costs against GET /soundstage/queue_summary, with and without the stage-by-reference handler.

Run with -s to see the numbers:  python3 -m pytest tests/test_queue_load.py -q -s
"""
import asyncio
import copy
import json
import statistics
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import stagestore as SS  # noqa: E402
from soundstage import queuewatch as QW  # noqa: E402
from soundstage.takecheck import recipe as R  # noqa: E402

from tests.test_queue_light import app_body, big_scene  # noqa: E402

aiohttp = pytest.importorskip("aiohttp")
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

N = 20   # 1 running + 19 pending, the queue that froze the pod


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(SS, "_BASE", str(tmp_path))
    return tmp_path


class StubQueue:
    """ComfyUI's PromptQueue as far as /queue and the summary see it."""

    def __init__(self):
        self.mutex = threading.RLock()
        self.queue = []
        self.currently_running = {}

    def put(self, item):
        with self.mutex:
            self.queue.append(item)

    def start_one(self):
        with self.mutex:
            item = self.queue.pop(0)
            self.currently_running[0] = item

    def get_current_queue(self):   # ComfyUI deep-copies both lists for GET /queue
        with self.mutex:
            return [copy.deepcopy(x) for x in self.currently_running.values()], copy.deepcopy(self.queue)


def make_app(q: StubQueue, handlers):
    routes = web.RouteTableDef()
    number = [0]

    @routes.post("/prompt")
    async def post_prompt(request):          # server.py post_prompt: on-prompt handlers first, then queue
        body = await request.json()
        for h in handlers:
            body = h(body)
        pid = str(uuid.uuid4())
        extra = body.get("extra_data") or {}
        extra["client_id"] = body.get("client_id")
        number[0] += 1
        q.put((number[0], pid, body["prompt"], extra, ["9900"]))
        return web.json_response({"prompt_id": pid, "number": number[0]})

    @routes.get("/queue")
    async def get_queue(request):            # server.py get_queue: the full payload of every item
        running, pending = q.get_current_queue()
        return web.json_response({"queue_running": running, "queue_pending": pending})

    QW.register(routes, prompt_queue=q)
    app = web.Application(client_max_size=1024 ** 3)
    app.add_routes(routes)
    return app


async def _measure(client, path, runs):
    sizes, times = [], []
    for _ in range(runs):
        t0 = time.perf_counter()
        r = await client.get(path)
        body = await r.read()
        times.append((time.perf_counter() - t0) * 1000)
        assert r.status == 200
        sizes.append(len(body))
    times.sort()
    return {"bytes": sizes[-1], "median_ms": round(statistics.median(times), 2),
            "p95_ms": round(times[max(0, int(len(times) * 0.95) - 1)], 2)}


def _run(slim: bool):
    async def go():
        q = StubQueue()
        handlers = ([SS.slim_prompt] if slim else []) + [R.on_prompt]   # ComfyUI order: queuewatch registers first
        body = json.dumps(app_body(big_scene()))   # the stock UI / an old workflow: the stage inline
        async with TestClient(TestServer(make_app(q, handlers))) as c:
            t0 = time.perf_counter()
            for _ in range(N):
                r = await c.post("/prompt", data=body, headers={"Content-Type": "application/json"})
                assert r.status == 200
            queue_ms = (time.perf_counter() - t0) * 1000 / N
            q.start_one()
            full = await _measure(c, "/queue", 3)
            summary = await _measure(c, "/soundstage/queue_summary", 50)
            mine = await _measure(c, f"/soundstage/queue_summary?ids={q.queue[3][1]}", 20)
            # Ten pages polling the summary at once while one more render queues: nothing waits long.
            t0 = time.perf_counter()
            polls = [c.get("/soundstage/queue_summary") for _ in range(10)]
            rs = await asyncio.gather(c.post("/prompt", data=body, headers={"Content-Type": "application/json"}), *polls)
            burst_ms = (time.perf_counter() - t0) * 1000
            assert all(r.status == 200 for r in rs)
            j = await (await c.get("/soundstage/queue_summary")).json()
            assert j["running"] == 1 and j["pending"] == N, j
            return {"queue_ms_per_prompt": round(queue_ms, 1), "full": full, "summary": summary, "mine": mine,
                    "burst_ms": round(burst_ms, 1), "item_bytes": len(json.dumps(list(q.queue[0])))}
    return asyncio.run(go())


def test_twenty_big_renders_queue_summary_vs_full_queue():
    before = _run(slim=False)
    after = _run(slim=True)
    print("\n20 crate-crash renders queued (stage inline from the client, as the stock UI sends it)")
    for name, m in (("no stage store", before), ("stage by reference", after)):
        print(f"  {name:>18}: GET /queue {m['full']['bytes'] / 1e6:.2f} MB, median {m['full']['median_ms']} ms | "
              f"summary {m['summary']['bytes']} B, median {m['summary']['median_ms']} ms, p95 {m['summary']['p95_ms']} ms | "
              f"one queue item {m['item_bytes'] / 1e3:.0f} KB | POST /prompt {m['queue_ms_per_prompt']} ms | "
              f"10 polls + 1 queue {m['burst_ms']} ms")
    # The bug, reproduced: tens of MB per GET /queue.
    assert before["full"]["bytes"] > 20_000_000
    # The fix: GET /queue at least 10x smaller; the summary is a few KB whatever is queued, and never a payload.
    assert after["full"]["bytes"] * 10 < before["full"]["bytes"]
    for m in (before, after):
        assert m["summary"]["bytes"] < 4096
        assert m["mine"]["bytes"] < 600
        assert m["summary"]["bytes"] * 500 < before["full"]["bytes"]
    assert after["summary"]["bytes"] == before["summary"]["bytes"] or abs(after["summary"]["bytes"] - before["summary"]["bytes"]) < 64
    # Time is load-dependent: generous bounds, the summary must stay far cheaper than one full /queue.
    assert after["summary"]["median_ms"] < 50
    assert after["summary"]["median_ms"] * 5 < before["full"]["median_ms"]


def test_one_prompt_parses_each_distinct_stage_copy_once(monkeypatch):
    """widgets_values and widgets_values_named carry the same stage text: it is parsed and hashed once per prompt."""
    body = app_body(big_scene(crates=3))
    calls = []
    real = SS.ref_value
    monkeypatch.setattr(SS, "ref_value", lambda text, base=None, data=None: calls.append(len(text)) or real(text, base, data))
    SS.slim_prompt(body)
    # Two distinct texts: the prompt input (scene + passes) and the workflow copy (scene only, written twice).
    assert len(calls) == 2, calls
    node = next(n for n in body["extra_data"]["extra_pnginfo"]["workflow"]["nodes"] if n["type"] == "SoundstageStage")
    assert node["widgets_values"][0] == node["widgets_values_named"]["stage"]
    assert SS.parse_ref(node["widgets_values"][0])


def test_the_app_queue_path_never_loads_the_stage_on_the_event_loop(monkeypatch):
    """The App sends the stage by reference (web/ui/queue.mjs stageInputsByRef) and the workflow copy inline. The two
    on-prompt handlers then hash the workflow copy once and build the recipe from the reference's facts: neither
    parses nor reads back megabytes of stage on ComfyUI's only event-loop thread."""
    scene = big_scene()
    body = app_body(scene)
    stage = body["prompt"]["9045"]["inputs"]["stage"]
    body["prompt"]["9045"]["inputs"]["stage"] = SS.ref_value(stage)        # what POST /soundstage/stage_store returned
    big_loads = []
    real_loads, real_get = json.loads, SS.get
    monkeypatch.setattr(SS.json, "loads", lambda s, *a, **k: (big_loads.append(len(s)) if len(s) > 100_000 else None)
                        or real_loads(s, *a, **k))
    monkeypatch.setattr(SS, "get", lambda *a, **k: pytest.fail("the stage was read back on the event loop"))
    t0 = time.perf_counter()
    SS.slim_prompt(body)
    R.on_prompt(body)
    dt = (time.perf_counter() - t0) * 1000
    print(f"\nApp-shaped queue of a {len(stage) / 1e6:.1f} MB stage: on-prompt handlers {dt:.1f} ms")
    assert big_loads == []
    rec = body["extra_data"]["extra_pnginfo"]["soundstage"]
    assert rec["scene_ref"] == SS.parse_ref(body["prompt"]["9045"]["inputs"]["stage"])["stage_ref"]
    assert rec["shot"] == {"id": "shot_1", "name": "Chase cam"} and "scene" not in rec
    monkeypatch.setattr(SS.json, "loads", real_loads)
    monkeypatch.setattr(SS, "get", real_get)
    # The MP4 restores the scene (not the stage wrapper) from that reference.
    back = R.from_tags({"soundstage": json.dumps(rec)})
    assert back["scene"] == scene and back["shot"]["name"] == "Chase cam"
