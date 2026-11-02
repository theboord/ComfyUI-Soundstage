"""✦ One-click: the catalog matches what the App registers, the MCP relay asks the App, the MCP tool speaks it."""
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.oneclick import catalog as C  # noqa: E402

WEB = ROOT / "web" / "oneclick"


def _node_ids():
    """The ids the JS modules really register (node imports them and lists the registry)."""
    code = ("const o = await import(process.argv[1] + '/oneclick.mjs');"
            "for (const m of ['effects','light','angle','expand']) await import(process.argv[1] + '/' + m + '.mjs');"
            "console.log(JSON.stringify(o.oneClicks().map(s => [s.id, s.group])));")
    p = subprocess.run(["node", "--input-type=module", "-e", code, WEB.as_uri()], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        pytest.skip(f"node not available: {p.stderr[:200]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_catalog_matches_the_app():
    js = _node_ids()
    assert [i for i, _ in js] and sorted(i for i, _ in js) == sorted(C.ids())
    groups = dict(js)
    for row in C.describe():
        assert groups[row["id"]] == row["group"], row


def test_catalog_covers_every_lighting_setup_and_aspect():
    ids = set(C.ids())
    setups = C.lighting_setups()
    assert len(setups) == 18
    assert {f"relight_{s['id']}" for s in setups} <= ids
    assert {"expand_2_39_1", "expand_16_9", "expand_9_16", "expand_1_85_1"} <= ids
    assert {"nightfall", "flood", "empty", "cutout", "living_photo"} <= ids
    # both kinds of new angle, so the App can say which one ran
    assert all(f"angle_{m}" in ids and f"exact_{m}" in ids for m in C.MOVES)


def test_no_competitor_text_in_our_prompts():
    # our own prompts, written for this App (docs/oneclick.md): no other app's name in the sources
    for f in WEB.glob("*.mjs"):
        assert not re.search(r"openfield|wexloops", f.read_text(encoding="utf-8"), re.I), f.name


def test_relay_asks_the_app_and_needs_confirm_gpu():
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")
    from soundstage.oneclick import routes as R

    sent = []

    async def main():
        table = web.RouteTableDef()
        state = {}

        def send(ev, data, sid=None):
            sent.append((ev, data, sid))

            async def answer():
                await asyncio.sleep(0.05)
                res = {"list": {"target": {"label": "Shot 1 · Tk 2"}, "oneclicks": [{"id": "nightfall", "group": "Effects", "label": "Nightfall", "ok": True}]},
                       "propose": {"plan": "Nightfall on Shot 1 · Tk 2: 1 job", "gpu": True, "cost": "$0 · about 1 min on your GPU"},
                       "run": {"ok": True, "label": "✦ Nightfall", "kind": "look", "file": {"filename": "x.png"}}}[data["kind"]]
                async with aiohttp.ClientSession() as s2:
                    await s2.post(state["base"] + "/soundstage/oneclick/result", json={"id": data["id"], "result": res})
            asyncio.get_running_loop().create_task(answer())

        R._REGISTERED = False
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
                async with s.get(base + "/soundstage/oneclick/catalog") as r:
                    j = await r.json()
                    assert r.status == 200 and len(j["ids"]) == len(C.ids()) and j["groups"][0] == "Effects"
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "list", "shot": 1}) as r:
                    j = await r.json()
                    assert r.status == 200 and j["oneclicks"][0]["id"] == "nightfall"
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "propose", "oneclick": "nightfall"}) as r:
                    assert (await r.json())["gpu"] is True
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "run", "oneclick": "nightfall"}) as r:
                    assert r.status == 409                 # no GPU without the user's yes
                n = len(sent)
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "run", "oneclick": "nightfall", "confirm_gpu": True, "take": 2}) as r:
                    j = await r.json()
                    assert r.status == 200 and j["ok"] and j["label"] == "✦ Nightfall"
                assert len(sent) == n + 1 and sent[-1][0] == "soundstage.oneclick" and sent[-1][1]["take"] == 2
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "run", "oneclick": "make_it_pop", "confirm_gpu": True}) as r:
                    assert r.status == 404
                async with s.post(base + "/soundstage/oneclick/ask", json={"kind": "dance"}) as r:
                    assert r.status == 400
                async with s.post(base + "/soundstage/oneclick/result", json={"id": "nobody"}) as r:
                    assert r.status == 404
        finally:
            await runner.cleanup()
            R._REGISTERED = False

    asyncio.run(main())


def test_mcp_lists_the_one_click_tool():
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "soundstage_one_click", "arguments": {"id": "nightfall"}}}]
    p = subprocess.run([sys.executable, str(ROOT / "tools" / "soundstage_mcp.py")], input="\n".join(json.dumps(m) for m in msgs),
                       capture_output=True, text=True, timeout=60, env={"SOUNDSTAGE_URL": "http://127.0.0.1:9", "PATH": "/usr/bin:/bin"})
    out = [json.loads(x) for x in p.stdout.splitlines()]
    tools = {t["name"]: t for t in out[1]["result"]["tools"]}
    assert "soundstage_one_click" in tools and "confirm_gpu" in tools["soundstage_one_click"]["inputSchema"]["properties"]
    assert out[2]["result"]["isError"] and "can't reach ComfyUI" in out[2]["result"]["content"][0]["text"]
