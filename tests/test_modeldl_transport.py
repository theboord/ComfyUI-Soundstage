"""The real Transport (aiohttp client) against two local aiohttp servers on 127.0.0.1: a stand-in Hugging Face that
answers HEAD/GET on /resolve/ with a redirect, and a stand-in CDN on another port that serves the bytes with Range,
If-Range and ETag. Loopback only (stdlib + aiohttp), no network. hf_base() accepts http://127.0.0.1:<port>."""
import asyncio
import collections
import hashlib

from aiohttp import web
from aiohttp.test_utils import TestServer

from modeldl_fake import TOKEN, mini_catalog, safetensors_bytes, stub_folder_paths
from soundstage import modeldl as M

DATA = safetensors_bytes(bytes(range(256)) * 600)
PATH = "/org/r/resolve/main/vae/a.safetensors"


class Upstream:
    def __init__(self, data=DATA, version="v1"):
        self.data, self.version = data, version
        self.hf_seen, self.cdn_seen = [], []
        self.cdn_port = None

    def hf_app(self):
        async def resolve(request):
            self.hf_seen.append((request.method, dict(request.headers)))
            h = {"Location": f"http://127.0.0.1:{self.cdn_port}/blob/a",
                 "X-Linked-Etag": '"%s"' % hashlib.sha256(self.data).hexdigest(), "X-Linked-Size": str(len(self.data)),
                 "ETag": '"hf-side"'}
            return web.Response(status=302, headers=h)

        async def whoami(request):
            self.hf_seen.append((request.method, dict(request.headers)))
            ok = request.headers.get("Authorization") == f"Bearer {TOKEN}"
            return web.json_response({"name": "jane-doe"} if ok else {"error": "no"}, status=200 if ok else 401)
        app = web.Application()
        app.router.add_route("*", PATH, resolve)
        app.router.add_get("/api/whoami-v2", whoami)
        return app

    def cdn_app(self):
        async def blob(request):
            self.cdn_seen.append((request.method, dict(request.headers)))
            etag = '"%s"' % self.version
            n = len(self.data)
            base = {"ETag": etag, "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes"}
            rng = request.headers.get("Range")
            if rng and request.headers.get("If-Range") not in (None, etag):
                rng = None                                     # stale If-Range: the whole, current file
            if rng:
                start = int(rng.split("=")[1].rstrip("-"))
                if start >= n:
                    return web.Response(status=416, headers={**base, "Content-Range": f"bytes */{n}"})
                return web.Response(status=206, body=self.data[start:],
                                    headers={**base, "Content-Range": f"bytes {start}-{n - 1}/{n}"})
            return web.Response(status=200, body=self.data, headers=base)
        app = web.Application()
        app.router.add_get("/blob/a", blob)
        return app


async def _serve(up, monkeypatch, fn):
    hf, cdn = TestServer(up.hf_app(), host="127.0.0.1"), TestServer(up.cdn_app(), host="127.0.0.1")
    await hf.start_server()
    await cdn.start_server()
    up.cdn_port = cdn.port
    monkeypatch.setenv("SOUNDSTAGE_HF_ENDPOINT", f"http://127.0.0.1:{hf.port}")
    assert M.hf_base() == f"http://127.0.0.1:{hf.port}"
    tr = M.Transport()
    try:
        return await fn(tr)
    finally:
        await tr.close()
        await hf.close()
        await cdn.close()


def _dl(tmp_path, monkeypatch, tr, size=None):
    ep = M.os.environ["SOUNDSTAGE_HF_ENDPOINT"]
    stub_folder_paths(monkeypatch, tmp_path)           # (clears the endpoint override: put it back)
    monkeypatch.setenv("SOUNDSTAGE_HF_ENDPOINT", ep)
    Usage = collections.namedtuple("Usage", "total used free")
    cat = mini_catalog([{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": size}])
    return M.Downloader(cat, transport=tr, token_fn=lambda: (TOKEN, "saved"),
                        disk_usage=lambda p: Usage(0, 0, 10 ** 15), chunk=4096)


def test_head_and_get_do_not_follow_redirects(tmp_path, monkeypatch):
    up = Upstream()

    async def go(tr):
        url = M.hf_base() + PATH
        r = await tr.open("HEAD", url, M._headers(url, TOKEN), timeout=10)
        try:
            assert r.status == 302 and r.headers["x-linked-size"] == str(len(DATA))   # lower-case keys
            assert r.headers["location"].endswith("/blob/a")
        finally:
            r.close()
        assert await M.whoami(tr, TOKEN) == "jane-doe"
        assert await M.whoami(tr, "hf_wrongTOKEN0000") is None
    stub_folder_paths(monkeypatch, tmp_path)
    asyncio.run(_serve(up, monkeypatch, go))
    assert up.hf_seen[0][1]["Authorization"] == f"Bearer {TOKEN}"
    assert up.cdn_seen == []                       # the HEAD's redirect was not followed


def test_full_download_through_the_redirect_keeps_the_token_off_the_cdn(tmp_path, monkeypatch):
    up = Upstream()
    out = {}

    async def go(tr):
        dl = _dl(tmp_path, monkeypatch, tr)
        dl.enqueue(["a"])
        await dl.idle()
        out["dl"] = dl
    asyncio.run(_serve(up, monkeypatch, go))
    dl = out["dl"]
    assert dl.done == [{"id": "a", "verified": "sha256"}], dl.failed
    assert (tmp_path / "models" / "vae" / "a.safetensors").read_bytes() == DATA
    assert all(h.get("Authorization") == f"Bearer {TOKEN}" for _m, h in up.hf_seen)
    assert up.cdn_seen and all("Authorization" not in h for _m, h in up.cdn_seen)


def test_range_resume_with_if_range_on_the_real_client(tmp_path, monkeypatch):
    up = Upstream()
    out = {}

    async def go(tr):
        dl = _dl(tmp_path, monkeypatch, tr)
        part = tmp_path / "models" / "vae" / "a.safetensors.part"
        part.write_bytes(DATA[:9000])
        M.write_meta(part, '"v1"')
        dl.enqueue(["a"])
        await dl.idle()
        out["dl"] = dl
    asyncio.run(_serve(up, monkeypatch, go))
    gets = [h for m, h in up.cdn_seen if m == "GET"]
    assert gets[0]["Range"] == "bytes=9000-" and gets[0]["If-Range"] == '"v1"'
    assert out["dl"].done == [{"id": "a", "verified": "sha256"}]
    assert (tmp_path / "models" / "vae" / "a.safetensors").read_bytes() == DATA


def test_changed_upstream_restarts_on_the_real_client(tmp_path, monkeypatch):
    # the part was started against v0; upstream is now v1 with different bytes, no sha256 in play (catalog size only)
    old = safetensors_bytes(b"OLD" * 30000)
    up = Upstream(version="v1")
    out = {}

    async def go(tr):
        dl = _dl(tmp_path, monkeypatch, tr, size=len(DATA))
        part = tmp_path / "models" / "vae" / "a.safetensors.part"
        part.write_bytes(old[:9000])
        M.write_meta(part, '"v0"')
        orig = M.linked_meta
        M.linked_meta = lambda h: (None, None)       # as if the HEAD carried no X-Linked-* headers
        try:
            dl.enqueue(["a"])
            await dl.idle()
        finally:
            M.linked_meta = orig
        out["dl"] = dl
    asyncio.run(_serve(up, monkeypatch, go))
    gets = [h for m, h in up.cdn_seen if m == "GET"]
    assert gets[0]["If-Range"] == '"v0"'
    assert out["dl"].done == [{"id": "a", "verified": "size"}], out["dl"].failed
    assert (tmp_path / "models" / "vae" / "a.safetensors").read_bytes() == DATA
