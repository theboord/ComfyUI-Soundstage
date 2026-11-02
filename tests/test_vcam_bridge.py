"""The LAN phone bridge (tools/vcam_bridge.py) end to end: a real bridge in front of a small fake ComfyUI.

The fake upstream is deliberately permissive: it keeps every connection alive, ignores "Connection: close" and answers
every request it can parse, pipelined or not, and records each one. So whatever the bridge lets through shows up in
`upstream.seen`, whatever ComfyUI itself would have done with it. The last two tests run the same checks against a real
aiohttp server (what ComfyUI runs on), when aiohttp is installed.

Run:  python -m pytest tests/test_vcam_bridge.py -q
"""
import asyncio
import base64
import hashlib
import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("vcam_bridge_e2e", os.path.join(ROOT, "tools", "vcam_bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

TOKEN = "T0kenT0kenT0kenT0ken"
COOKIE = f"Cookie: ss_vk={TOKEN}\r\n"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WAIT = 5


class FakeComfy:
    """Keep-alive HTTP/1.1 server: 101 + raw echo for a proper /soundstage/vcam/ws handshake, 400 (connection kept
    open) for a broken one, 200 for everything else. Records (method, path) of every request it parses."""

    def __init__(self):
        self.seen = []
        self.raw = b""
        self.server = None
        self.port = None

    async def start(self):
        self.server = await asyncio.start_server(self._conn, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def close(self):
        self.server.close()

    async def _conn(self, r, w):
        try:
            while True:
                try:
                    head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), timeout=0.5)
                except Exception:
                    break
                self.raw += head
                lines = head.decode("latin-1").split("\r\n")
                method, path = lines[0].split(" ")[:2]
                hdrs = {ln.split(":", 1)[0].strip().lower(): ln.split(":", 1)[1].strip() for ln in lines[1:] if ":" in ln}
                self.seen.append((method, path))
                n = int(hdrs.get("content-length", "0") or 0)
                if n:
                    self.raw += await r.readexactly(n)
                if path == "/soundstage/vcam/ws" and hdrs.get("upgrade", "").lower() == "websocket":
                    key = hdrs.get("sec-websocket-key")
                    if key:
                        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
                        w.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                 f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
                        await w.drain()
                        while True:                      # "WebSocket": echo raw bytes back
                            data = await r.read(65536)
                            if not data:
                                return
                            w.write(b"echo:" + data)
                            await w.drain()
                    body = b"bad handshake"
                    w.write(b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
                else:
                    body = f"ok {path}".encode()
                    w.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
                await w.drain()
        finally:
            w.close()


async def start_bridge(port):
    logs = []
    cfg = {"token": TOKEN, "target_host": "127.0.0.1", "target_port": port, "tls": False, "ca": None, "log": logs.append}
    srv = await asyncio.start_server(lambda r, w: bridge.handle(r, w, cfg), "127.0.0.1", 0)
    return srv, srv.sockets[0].getsockname()[1], logs


async def send_all(port, data, eof=True):
    """Send `data` in one write (as a pipelining client would), optionally half-close, read until the bridge closes."""
    r, w = await asyncio.open_connection("127.0.0.1", port)
    w.write(data)
    await w.drain()
    if eof:
        w.write_eof()
    out = b""
    try:
        while True:
            chunk = await asyncio.wait_for(r.read(65536), timeout=WAIT)
            if not chunk:
                break
            out += chunk
    finally:
        w.close()
    return out


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=20))


WS_GET = ("GET /soundstage/vcam/ws HTTP/1.1\r\nHost: mac.local:8443\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
          "Sec-WebSocket-Version: 13\r\n")


def test_a_valid_websocket_upgrade_still_works_end_to_end():
    async def go():
        up = await FakeComfy().start()
        srv, port, _ = await start_bridge(up.port)
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write((WS_GET + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" + COOKIE + "\r\n").encode())
        await w.drain()
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), timeout=WAIT)
        assert head.startswith(b"HTTP/1.1 101 "), head
        assert b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" in head, "the upstream's accept key reaches the phone untouched"
        for msg in (b"frame-1", b"frame-2"):
            w.write(msg)
            await w.drain()
            got = await asyncio.wait_for(r.readexactly(len(b"echo:") + len(msg)), timeout=WAIT)
            assert got == b"echo:" + msg
        w.close()
        srv.close()
        await asyncio.sleep(0.05)
        await up.close()
        assert up.seen == [("GET", "/soundstage/vcam/ws")]
        assert TOKEN.encode() not in up.raw, "the pairing cookie never reaches ComfyUI"
    run(go())


@pytest.mark.parametrize("smuggled", [
    "GET /system_stats HTTP/1.1\r\nHost: x\r\n\r\n",
    "POST /prompt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
])
def test_b_broken_handshake_then_pipelined_request_never_reaches_upstream(smuggled):
    """No Sec-WebSocket-Key: ComfyUI answers 400 and keeps the connection open. The old bridge had already switched to a
    raw pipe, so the request pipelined behind the handshake reached ComfyUI past the allow-list."""
    async def go():
        up = await FakeComfy().start()
        srv, port, logs = await start_bridge(up.port)
        out = await send_all(port, (WS_GET + COOKIE + "\r\n" + smuggled).encode())
        await asyncio.sleep(0.3)
        srv.close()
        await up.close()
        assert up.seen == [("GET", "/soundstage/vcam/ws")], up.seen
        assert out.startswith(b"HTTP/1.1 400 "), out
        assert out.count(b"HTTP/1.1 ") == 1, "exactly one response, then the bridge closes"
        assert b"bad handshake" in out
    run(go())


def test_b_handshake_without_eof_is_closed_by_the_bridge():
    """The phone never half-closes: the bridge itself must end the connection after the refused handshake."""
    async def go():
        up = await FakeComfy().start()
        srv, port, _ = await start_bridge(up.port)
        out = await send_all(port, (WS_GET + COOKIE + "\r\n" + "GET /queue HTTP/1.1\r\nHost: x\r\n\r\n").encode(), eof=False)
        srv.close()
        await up.close()
        assert out.startswith(b"HTTP/1.1 400 ") and up.seen == [("GET", "/soundstage/vcam/ws")]
    run(go())


@pytest.mark.parametrize("req", [
    "GET /system_stats HTTP/1.1\r\nHost: x\r\n" + COOKIE + "\r\n",
    "POST /prompt HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n" + COOKIE + "\r\n{}",
    "GET /queue HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\n" + COOKIE + "\r\n",
    "GET /api/userdata/workflows HTTP/1.1\r\nHost: x\r\n" + COOKIE + "\r\n",
    "GET /soundstage/vcam/viewfinder HTTP/1.1\r\nHost: x\r\n\r\n",       # allowed path, but no pairing cookie
])
def test_c_non_allow_listed_or_unpaired_requests_are_refused(req):
    async def go():
        up = await FakeComfy().start()
        srv, port, _ = await start_bridge(up.port)
        out = await send_all(port, req.encode())
        await asyncio.sleep(0.1)
        srv.close()
        await up.close()
        assert out.startswith((b"HTTP/1.1 403 ", b"HTTP/1.1 401 ")), out
        assert up.seen == []
    run(go())


def test_d_only_the_declared_body_goes_up_with_an_allowed_request():
    """A plain allowed request: the bridge forwards its Content-Length body and nothing after it, so a second request
    pipelined behind the take upload never reaches ComfyUI (even one that would ignore Connection: close)."""
    async def go():
        up = await FakeComfy().start()
        srv, port, _ = await start_bridge(up.port)
        out = await send_all(port, ("POST /soundstage/vcam/take HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                                    "Content-Length: 11\r\n" + COOKIE + "\r\n{\"take\": 1}"
                                    "POST /prompt HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}").encode())
        srv.close()
        await up.close()
        assert up.seen == [("POST", "/soundstage/vcam/take")], up.seen
        assert up.raw.endswith(b"{\"take\": 1}") and b"Connection: close" in up.raw
        assert out.startswith(b"HTTP/1.1 200 ") and out.endswith(b"ok /soundstage/vcam/take")
    run(go())


@pytest.mark.parametrize("extra, status", [
    ("Transfer-Encoding: chunked\r\n", b"411"),
    ("Content-Length: 2\r\nContent-Length: 3\r\n", b"400"),
    ("Content-Length: -1\r\n", b"400"),
])
def test_d_bodies_the_bridge_cannot_bound_are_refused(extra, status):
    async def go():
        up = await FakeComfy().start()
        srv, port, _ = await start_bridge(up.port)
        out = await send_all(port, ("POST /soundstage/vcam/take HTTP/1.1\r\nHost: x\r\n" + extra + COOKIE + "\r\n"
                                    "2\r\n{}\r\n0\r\n\r\n").encode())
        srv.close()
        await up.close()
        assert out.startswith(b"HTTP/1.1 " + status), out
        assert up.seen == []
    run(go())


def test_upgrade_accepted_reads_the_status_line_and_upgrade_header():
    assert bridge.upgrade_accepted(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: Upgrade")
    assert not bridge.upgrade_accepted(b"HTTP/1.1 400 Bad Request\r\nUpgrade: websocket")
    assert not bridge.upgrade_accepted(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c")
    assert not bridge.upgrade_accepted(b"HTTP/1.1 101 Switching Protocols")
    assert not bridge.upgrade_accepted(b"HTTP/1.1 1010 x\r\nUpgrade: websocket")
    assert not bridge.upgrade_accepted(b"garbage")


# ---------------------------------------------------------------- the same against aiohttp (what ComfyUI runs on)

async def _aiohttp_upstream(seen):
    web = pytest.importorskip("aiohttp.web")

    async def h(req):
        seen.append((req.method, req.path))
        if req.path == "/soundstage/vcam/ws":
            ws = web.WebSocketResponse()
            await ws.prepare(req)
            async for msg in ws:
                await ws.send_str("echo:" + msg.data)
            return ws
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", h)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


def test_aiohttp_websocket_through_the_bridge():
    aiohttp = pytest.importorskip("aiohttp")

    async def go():
        seen = []
        runner, up_port = await _aiohttp_upstream(seen)
        srv, port, _ = await start_bridge(up_port)
        async with aiohttp.ClientSession(cookies={"ss_vk": TOKEN}) as s:
            async with s.ws_connect(f"http://127.0.0.1:{port}/soundstage/vcam/ws") as ws:
                await ws.send_str("hi")
                msg = await asyncio.wait_for(ws.receive(), timeout=WAIT)
                assert msg.data == "echo:hi"
        srv.close()
        await runner.cleanup()
        assert seen == [("GET", "/soundstage/vcam/ws")]
    run(go())


def test_aiohttp_broken_handshake_does_not_smuggle_a_request():
    pytest.importorskip("aiohttp")

    async def go():
        seen = []
        runner, up_port = await _aiohttp_upstream(seen)
        srv, port, _ = await start_bridge(up_port)
        out = await send_all(port, (WS_GET + COOKIE + "\r\n" + "GET /system_stats HTTP/1.1\r\nHost: x\r\n\r\n").encode())
        await asyncio.sleep(0.3)
        srv.close()
        await runner.cleanup()
        assert seen == [("GET", "/soundstage/vcam/ws")], seen
        assert out.startswith(b"HTTP/1.1 400 ")
    run(go())
