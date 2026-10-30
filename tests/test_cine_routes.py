"""/soundstage/advisor routes: payload shape, stage-format camera keys, errors. Served by a real aiohttp app."""
import asyncio
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.cine import routes as R  # noqa: E402
from soundstage.cine.geometry import project, use_aspect  # noqa: E402

STAGE = {
    "version": 2, "shot": {"frames": 97, "fps": 24, "aspect": "2.39"},
    "camera": {"position": [-7, 1.7, -14], "target": [0, 1.3, -4], "focal_mm": 35},
    "actors": [
        {"id": "actor_a", "name": "Man", "kind": "man", "position": [-3, 0, 2], "height_m": 1.78,
         "keys": [{"frame": 0, "position": [-3, 0, 2]}]},
        {"id": "actor_b", "name": "Woman", "kind": "woman", "position": [3, 0, 2], "height_m": 1.68},
    ],
}


def test_run_returns_stage_ready_shots():
    out = R.run({"scene": "Two gunfighters face off in a dusty street at noon.", "stage_scene": STAGE})
    assert out["recipe"]["from"] == "technique.spaghetti_standoff"
    assert out["coverage"]["verdict"] in ("pass", "warn")
    assert out["ms"] < 2000
    for s in out["shots"]:
        assert s["why"] and s["summary"] and s["kb_refs"] and s["name"] and s["setup"]
        keys = s["camera_keys"]
        assert keys[0]["frame"] == 0 and len(keys) in (1, 2)
        if len(keys) == 2:
            assert keys[1]["frame"] == 96
        for k in keys:
            assert len(k["position"]) == 3 and len(k["target"]) == 3 and k["focal_mm"] >= 8
    # cameras are placed on the stage's actors, not the default layout
    assert out["cast"][0]["position"] == [-3.0, 0.0, 2.0]


def test_frames_for_the_stage_aspect():
    """An ECU at 2.39 must still hold the eyes centred when projected at 2.39."""
    out = R.run({"scene": "Two gunfighters face off in a dusty street at noon.", "stage_scene": STAGE})
    ecu = next(s for s in out["shots"] if s["size"] == "ECU" and s["subject"] == "A")
    k = ecu["camera_keys"][0]
    with use_aspect("2.39"):
        sx, sy = project((-3, 1.67, 2), k["position"], k["target"], k["focal_mm"])
    assert abs(sx) < 0.25 and abs(sy) < 0.4


def test_vocab_lists_every_picker():
    v = R.vocab()
    assert set(v) == {"genre", "movement", "technique", "intent", "coverage"}
    assert any(o["id"] == "technique.spaghetti_standoff" for o in v["technique"])


def test_picks_by_id_and_none():
    out = R.run({"scene": "A first date in a diner.", "movement": "movement.french_new_wave", "technique": "none",
                 "max_shots": 3})
    assert len(out["shots"]) == 3
    assert out["picks"]["movement"].endswith("[movement.french_new_wave]") and out["picks"]["technique"] is None


def test_empty_scene_is_a_400():
    with pytest.raises(ValueError):
        R.run({"scene": "  "})


def test_http_routes_end_to_end():
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")

    async def main():
        table = web.RouteTableDef()
        R.register(table)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(base + "/soundstage/advisor/vocab") as r:
                    assert r.status == 200 and "technique" in await r.json()
                async with s.post(base + "/soundstage/advisor",
                                  json={"scene": "A detective alone in a rain-soaked office at night.",
                                        "stage_scene": STAGE}) as r:
                    data = await r.json()
                    assert r.status == 200 and data["shots"] and data["recipe"]["from"] == "emotion.isolation"
                async with s.post(base + "/soundstage/advisor", json={}) as r:
                    assert r.status == 400 and "scene" in (await r.json())["error"]
                async with s.post(base + "/soundstage/advisor", data=b"not json") as r:
                    assert r.status == 400
        finally:
            await runner.cleanup()

    asyncio.run(main())


def test_register_is_idempotent_for_the_server():
    R._REGISTERED = True
    try:
        assert R.register() is False
    finally:
        R._REGISTERED = False
