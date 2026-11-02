"""Video -> Stage Cancel: the App POSTs /soundstage/video2stage/cancel. The route was missing (404), so Cancel only
stopped the browser watching while the server job and its GPU prompt kept running. Now the job stops and its own
queued prompt (and only that one) leaves the queue."""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pytest.importorskip("aiohttp")

from soundstage.video2stage import pipeline, queue as VQ, routes as VR  # noqa: E402


def test_cancel_stops_the_job_and_drops_only_its_own_prompt(monkeypatch):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    seen = {"deleted": [], "interrupted": []}

    async def go():
        fake = web.RouteTableDef()

        @fake.post("/prompt")
        async def prompt(request):
            return web.json_response({"prompt_id": "ours"})

        @fake.get("/history/{pid}")
        async def history(request):
            return web.json_response({})          # never finishes on its own

        @fake.post("/queue")
        async def q(request):
            seen["deleted"] += (await request.json()).get("delete", [])
            return web.json_response({})

        @fake.get("/soundstage/queue_summary")
        async def summary(request):
            return web.json_response({"items": [{"prompt_id": "ours", "state": "running"}]})

        @fake.post("/interrupt")
        async def interrupt(request):
            seen["interrupted"].append((await request.json()).get("prompt_id"))
            return web.json_response({})

        comfy = TestServer(web.Application())
        comfy.app.add_routes(fake)
        await comfy.start_server()
        base = str(comfy.make_url("")).rstrip("/")

        async def fake_run(_base, video, **kw):
            await VQ.run_graph(base, {"1": {}}, "depth")
            return {"never": True}

        monkeypatch.setattr(pipeline, "run", fake_run)
        routes = web.RouteTableDef()
        VR.register(routes)
        app = web.Application()
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as c:
            jid = (await (await c.post("/soundstage/video2stage", json={"video": "clip.mp4"})).json())["job"]
            await asyncio.sleep(1.3)                   # the job is waiting on its GPU prompt
            r = await c.post("/soundstage/video2stage/cancel", json={"id": jid})
            assert r.status == 200 and (await r.json())["state"] == "cancelled"
            s = await (await c.get(f"/soundstage/video2stage/job?id={jid}")).json()
            assert s["state"] == "cancelled"
            assert (await c.post("/soundstage/video2stage/cancel", json={"id": "nope"})).status == 404
        await comfy.close()

    asyncio.run(go())
    assert seen["deleted"] == ["ours"] and seen["interrupted"] == ["ours"]
