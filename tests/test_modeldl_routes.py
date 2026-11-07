"""Model downloader routes on a real aiohttp app with a fake Hugging Face transport. The token must never leak."""
import asyncio
import json
import logging

import pytest

from modeldl_fake import TOKEN, FakeHF, stub_folder_paths
from soundstage import modeldl as M

CAT = M.load_catalog()
KLEIN = next(i for i in CAT["items"] if i["id"] == "flux2-vae")


def _files():
    return {(i["repo"], i["path"]): b"w" * 64 for i in CAT["items"]}


async def _with_client(hf, fn):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    table = web.RouteTableDef()
    M.register(table, transport=hf)
    app = web.Application()
    app.add_routes(table)
    async with TestClient(TestServer(app)) as c:
        return await fn(c)


@pytest.fixture
def env(tmp_path, monkeypatch):
    models = stub_folder_paths(monkeypatch, tmp_path)
    return tmp_path, models


@pytest.mark.parametrize("status,token,gated,want", [
    (200, True, True, "ok"), (302, True, True, "ok"), (401, False, True, "sign_in"), (401, True, False, "not_found"),
    (403, True, True, "licence"), (404, True, False, "not_found"), (500, True, False, "error"),
])
def test_classify(status, token, gated, want):
    assert M.classify(status, gated, token) == want


def test_classify_error_code_hint():
    assert M.classify(401, True, False, "GatedRepo") == "sign_in"
    assert M.classify(401, True, True, "GatedRepo") == "licence"


def test_access_route(env):
    hf = FakeHF(_files(), head_status={"Lightricks/LTX-2.5": 403, "Comfy-Org/Krea-2": 404},
                redirect_cdn=False)

    async def go(c):
        r = await c.post("/soundstage/models/access", json={"ids": ["flux2-vae", "ltx25-video-vae", "ltx25-audio-vae",
                                                                    "qwen-image-vae", "nope"]})
        j = await r.json()
        heads = [x for x in hf.calls if x[0] == "HEAD"]
        return j, heads
    j, heads = asyncio.run(_with_client(hf, go))
    assert j["results"] == {"flux2-vae": "ok", "ltx25-video-vae": "licence", "ltx25-audio-vae": "licence",
                            "qwen-image-vae": "not_found"}
    assert len(heads) == 3                    # one HEAD per repo, not per file
    assert "Accept the licence" in j["messages"]["ltx25-video-vae"]


def test_download_validation(env):
    hf = FakeHF(_files())

    async def go(c):
        r1 = await c.post("/soundstage/models/download", json={"ids": ["flux2-vae"]})
        r2 = await c.post("/soundstage/models/download", json={"ids": ["flux2-vae", "ltx25-gemma4-int8", "../x"],
                                                               "confirm": True, "accepted_licences": ["apache-2.0", "ltx2-community"]})
        j2 = await r2.json()
        await M.downloader().idle()
        return r1.status, j2
    s1, j2 = asyncio.run(_with_client(hf, go))
    assert s1 == 400
    assert j2["queued"] == ["flux2-vae"]
    assert j2["refused"] == {"ltx25-gemma4-int8": "licence_not_confirmed", "../x": "unknown"}
    # the browser never sent a URL: the fake only saw catalog-derived ones
    assert all("huggingface.co/black-forest-labs/" in u for _m, u, _h in hf.calls)


def test_status_progress_and_no_leaks(env, caplog):
    tmp_path, models = env
    hf = FakeHF(_files())
    bodies = []

    async def go(c):
        async def call(method, path, **kw):
            r = await getattr(c, method)(path, **kw)
            t = await r.text()
            bodies.append(t)
            return r.status, (json.loads(t) if t else None)
        s, bad = await call("post", "/soundstage/models/token", json={"token": "hf_wrongTOKEN00000"})
        assert s == 400 and "not accepted" in bad["error"]
        assert not M.token_path().exists()
        s, ok = await call("post", "/soundstage/models/token", json={"token": TOKEN})
        assert s == 200 and ok == {"signed_in": True, "user": "jane-doe"}
        _, st = await call("get", "/soundstage/models/status")
        await call("post", "/soundstage/models/access", json={"ids": ["flux2-vae"]})
        await call("post", "/soundstage/models/download", json={"ids": ["flux2-vae"], "confirm": True,
                                                                "accepted_licences": ["apache-2.0"]})
        await M.downloader().idle()
        _, pr = await call("get", "/soundstage/models/progress")
        _, tiers = await call("get", "/soundstage/models/tiers")
        _, rm = await call("post", "/soundstage/models/token/remove")
        await call("post", "/soundstage/models/cancel", json={"all": True})
        return st, pr, tiers, rm

    with caplog.at_level(logging.DEBUG):
        st, pr, tiers, rm = asyncio.run(_with_client(hf, go))
    assert st["signed_in"] and st["token_source"] == "saved" and st["user"] == "jane-doe"
    assert {i["id"] for i in st["items"]} == {i["id"] for i in CAT["items"]}
    assert all(i["state"] in ("installed", "partial", "missing") for i in st["items"])
    assert set(st["installed_files"]) >= {"vae", "loras"}
    assert pr["done"] == [{"id": "flux2-vae", "verified": "sha256"}] and pr["current"] is None
    assert tiers["tiers"][0]["id"] == "48gb"
    assert rm == {"signed_in": False, "token_source": None}
    for b in bodies:
        assert TOKEN not in b
        assert str(tmp_path) not in b         # no server paths
    assert TOKEN not in caplog.text
    assert (models / "vae" / "flux2-vae.safetensors").exists()
