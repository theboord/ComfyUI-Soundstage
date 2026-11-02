"""The phone bridge's lock-down (tools/vcam_bridge.py) at its edges: what tests/test_vcam_bridge.py and
tests/test_vcam_viewfinder.py do not already walk.

  * targets that look allowed but are not (encoded traversal, //host, absolute URLs, case, ";", "*", control characters);
  * methods the bridge never forwards, and allowed paths with the wrong method;
  * bodies it cannot bound (Content-Length it must not trust, Transfer-Encoding in any spelling) and bodies it can
    (a missing or short Content-Length: only the declared bytes go up, whatever is pipelined after them stays here);
  * an upstream that answers an upgrade with anything but 101 + Upgrade: websocket, answers garbage, or hangs up;
  * header injection: a bare LF / CR / NUL inside the head, a folded or space-before-colon header name. The upstream
    used here accepts a lone LF as a line end, which RFC 9112 section 2.2 allows a server to do, so a request hidden
    in one header shows up in `seen` if the bridge forwards it.

Run:  python -m pytest tests/test_vcam_bridge_lockdown.py -q
"""
import asyncio
import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("vcam_bridge_lockdown", os.path.join(ROOT, "tools", "vcam_bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

TOKEN = "T0kenT0kenT0kenT0ken"
COOKIE = f"Cookie: ss_vk={TOKEN}\r\n"
OK = [("Cookie", f"ss_vk={TOKEN}")]
WAIT = 5


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=20))


class LenientComfy:
    """A keep-alive HTTP/1.1 server that ends a line on LF (a CR before it is optional, as RFC 9112 lets a server
    choose), ignores Connection: close, honours Content-Length and answers 200 to every request it can parse.
    `seen` lists (method, path) of each one; `raw` is every byte it was sent."""

    def __init__(self, ws_answer=None, plain_answer=None):
        self.seen, self.raw = [], b""
        self.ws_answer = ws_answer          # bytes to answer a WebSocket handshake with (then keep reading), or None
        self.plain_answer = plain_answer    # bytes for every other request, or None for a 200 "ok <path>"

    async def start(self):
        self.server = await asyncio.start_server(self._conn, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def close(self):
        self.server.close()

    async def _conn(self, r, w):
        buf = b""
        try:
            while True:
                while b"\n\n" not in buf.replace(b"\r\n", b"\n"):
                    try:
                        chunk = await asyncio.wait_for(r.read(65536), timeout=0.5)
                    except Exception:
                        return
                    if not chunk:
                        return
                    self.raw += chunk
                    buf += chunk
                # find the end of the head in the original bytes: the first LF [CR] LF
                i, end = 0, None
                while i < len(buf):
                    j = buf.find(b"\n", i)
                    if j < 0:
                        break
                    k = j + 1
                    if buf[k:k + 1] == b"\r":
                        k += 1
                    if buf[k:k + 1] == b"\n":
                        end = k + 1
                        break
                    i = j + 1
                if end is None:
                    return
                head, buf = buf[:end], buf[end:]
                lines = [ln.rstrip(b"\r").decode("latin-1") for ln in head.split(b"\n")]
                while lines and not lines[0]:
                    lines.pop(0)
                if not lines or len(lines[0].split(" ")) < 3:
                    continue
                method, path = lines[0].split(" ")[:2]
                hdrs = {ln.split(":", 1)[0].strip().lower(): ln.split(":", 1)[1].strip() for ln in lines[1:] if ":" in ln}
                self.seen.append((method, path))
                n = int(hdrs.get("content-length", "0") or 0) if hdrs.get("content-length", "0").isdigit() else 0
                while len(buf) < n:
                    try:
                        chunk = await asyncio.wait_for(r.read(65536), timeout=0.5)
                    except Exception:
                        return
                    if not chunk:
                        return
                    self.raw += chunk
                    buf += chunk
                buf = buf[n:]
                if hdrs.get("upgrade", "").lower() == "websocket" and self.ws_answer is not None:
                    w.write(self.ws_answer)
                    await w.drain()
                    if not self.ws_answer:
                        return                       # hang up without a word
                    continue
                body = f"ok {path}".encode()
                w.write(self.plain_answer if self.plain_answer is not None else
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
                await w.drain()
        finally:
            w.close()


async def start_bridge(port):
    logs = []
    cfg = {"token": TOKEN, "target_host": "127.0.0.1", "target_port": port, "tls": False, "ca": None, "log": logs.append}
    srv = await asyncio.start_server(lambda r, w: bridge.handle(r, w, cfg), "127.0.0.1", 0)
    return srv, srv.sockets[0].getsockname()[1], logs


async def send_all(port, data, eof=True, then=b""):
    r, w = await asyncio.open_connection("127.0.0.1", port)
    w.write(data)
    await w.drain()
    if then:
        await asyncio.sleep(0.2)
        try:
            w.write(then)
            await w.drain()
        except Exception:
            pass
    if eof:
        try:
            w.write_eof()
        except Exception:
            pass
    out = b""
    try:
        while True:
            chunk = await asyncio.wait_for(r.read(65536), timeout=WAIT)
            if not chunk:
                break
            out += chunk
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        w.close()
    return out


async def through(req, upstream=None, **kw):
    """Send `req` to a bridge in front of `upstream` (a LenientComfy); return (phone's bytes, upstream, logs)."""
    up = await (upstream or LenientComfy()).start()
    srv, port, logs = await start_bridge(up.port)
    out = await send_all(port, req if isinstance(req, bytes) else req.encode("latin-1"), **kw)
    await asyncio.sleep(0.3)
    srv.close()
    await up.close()
    return out, up, logs


# ---------------------------------------------------------------- targets

@pytest.mark.parametrize("target", [
    "/extensions/ComfyUI-Soundstage/%2e%2e/%2e%2e/prompt",           # encoded ".."
    "/extensions/ComfyUI-Soundstage/..%2f..%2fprompt",
    "/extensions/ComfyUI-Soundstage/%2E%2E%5Cprompt",
    "/extensions/ComfyUI-Soundstage/a/../../../user/default.json",
    "/extensions/ComfyUI-Soundstage/a\\..\\x",
    "/soundstage/vcam/%2e%2e/%2e%2e/prompt",
    "//evil.example/soundstage/vcam/viewfinder",                     # network-path reference
    "http://127.0.0.1:8189/soundstage/vcam/viewfinder",               # absolute form
    "HTTP://127.0.0.1:8189/prompt",
    "/SOUNDSTAGE/vcam/viewfinder", "/Soundstage/Vcam/ws", "/VIEW",   # case tricks: ComfyUI's routes are case-sensitive, so is the list
    "/soundstage/vcam/ws/", "/soundstage/vcam/take/", "/soundstage/vcam/", "/favicon.ico/x",
    "/soundstage/vcam/ws;x", "/view;/prompt", "/soundstage/vcam%2Fws",
    "/soundstage/vcam/ws%00", "/soundstage/vcamx", "/soundstage/vcam/viewfinder.html",
    "/prompt?next=/soundstage/vcam/viewfinder", "/queue#/soundstage/vcam", "/api/prompt?x=/view",
    "*", "soundstage/vcam/viewfinder", "", "/extensions/ComfyUI-Soundstage",
    "/extensions/ComfyUI-Soundstagex/a.js", "/extensions/comfyui-soundstage/a.js", "/extensions/ComfyUI-Soundstage/a%20b.js",
    "/soundstage/vcam/view\tfinder", "/soundstage/vcam/ws\n", "/view\r", "/soundstage/vcam/viewfinder\x00",   # urlsplit strips \t \n \r
    "/soundstage/vcam/viewfinder\xe9",
])
def test_targets_outside_the_allow_list_are_forbidden_even_with_the_token(target):
    for m in ("GET", "POST", "HEAD"):
        assert bridge.decide(m, target, OK, TOKEN)[0] == "forbid", (m, target)


def test_a_control_character_in_the_target_is_checked_as_sent_not_as_urlsplit_cleans_it():
    """urlsplit("/soundstage/vcam/view\\tfinder").path is "/soundstage/vcam/viewfinder": the old check passed it and then
    forwarded the raw target with the tab in it."""
    for t in ("/soundstage/vcam/view\tfinder", "/view\n", "/soundstage/vcam/w\rs"):
        assert bridge.decide("GET", t, OK, TOKEN) == ("forbid", "target"), repr(t)


def test_the_query_string_never_widens_the_path():
    for t in ("/view?filename=../../user/default/comfy.settings.json", "/soundstage/vcam/viewfinder?/prompt", "/view?%2e%2e"):
        assert bridge.decide("GET", t, OK, TOKEN) == ("pass", None), t   # ComfyUI's /view checks its own filename
    assert bridge.decide("POST", "/soundstage/vcam/take?x=/prompt", OK, TOKEN) == ("pass", None)
    assert bridge.decide("POST", "/prompt?x=/soundstage/vcam/take", OK, TOKEN)[0] == "forbid"


def test_pairing_redirects_stay_on_the_bridge():
    for t, loc in ((f"/soundstage/vcam/viewfinder?vk={TOKEN}", "/soundstage/vcam/viewfinder"),
                   (f"/soundstage/vcam/viewfinder?vk={TOKEN}&next=//evil.example", "/soundstage/vcam/viewfinder?next=%2F%2Fevil.example")):
        assert bridge.decide("GET", t, [], TOKEN) == ("pair", loc)
    for t in (f"//evil.example/?vk={TOKEN}", f"https://evil.example/?vk={TOKEN}", f"/\t/evil.example/?vk={TOKEN}",
              f"/\\evil.example/?vk={TOKEN}"):
        assert bridge.decide("GET", t, [], TOKEN)[0] == "forbid", repr(t)


def test_a_token_in_the_query_is_never_forwarded_even_on_a_forbidden_path():
    async def go():
        out, up, _ = await through(f"POST /prompt?vk={TOKEN} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{{}}")
        assert out.startswith(b"HTTP/1.1 302 ") and up.seen == [] and up.raw == b""
    run(go())


# ---------------------------------------------------------------- methods

@pytest.mark.parametrize("method", ["PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "PROPFIND", "PRI", "get2"])
def test_methods_other_than_get_head_post_never_reach_comfyui(method):
    async def go():
        out, up, _ = await through(f"{method} /soundstage/vcam/take HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n{COOKIE}\r\n{{}}")
        assert out.startswith(b"HTTP/1.1 403 "), out
        assert up.seen == []
    run(go())


@pytest.mark.parametrize("method, path", [
    ("POST", "/soundstage/vcam/ws"), ("POST", "/view"), ("POST", "/extensions/ComfyUI-Soundstage/a.js"),
    ("POST", "/soundstage/vcam/viewfinder"), ("HEAD", "/soundstage/vcam/pose"), ("GET", "/soundstage/vcam/clip"),
    ("get", "/soundstage/vcam/pose"),
])
def test_allowed_paths_with_the_wrong_method_are_forbidden(method, path):
    assert bridge.decide(method.upper(), path, OK, TOKEN)[0] == "forbid"


def test_a_lower_case_method_is_forwarded_as_the_method_that_was_checked():
    async def go():
        out, up, _ = await through(f"get /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\n{COOKIE}\r\n")
        assert out.startswith(b"HTTP/1.1 200 ") and up.seen == [("GET", "/soundstage/vcam/status")]
    run(go())


def test_a_method_that_is_not_an_http_token_is_a_bad_request():
    for raw in (b"G(ET /view HTTP/1.1\r\nHost: x", b"GE\tT /view HTTP/1.1\r\nHost: x", b" GET /view HTTP/1.1\r\nHost: x"):
        assert bridge.parse_head(raw) is None, raw


# ---------------------------------------------------------------- bodies

POST_TAKE = "POST /soundstage/vcam/take HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
SMUGGLE = "POST /prompt HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}"


@pytest.mark.parametrize("cl", [
    "1234567890123",          # 13 digits: more than the bridge will count
    "99999999999999999999",
    "-1", "+2", "0x2", "2.0", "2 2", "2,2", "1e3", " ", "",
    "\xb2",                   # "²": str.isdigit() said yes and int() raised, so the handler crashed without an answer
    "\xb9\xb2",
])
def test_a_content_length_the_bridge_cannot_trust_is_a_400_and_nothing_goes_up(cl):
    async def go():
        out, up, _ = await through(POST_TAKE + f"Content-Length: {cl}\r\n" + COOKIE + "\r\n{}" + SMUGGLE)
        assert out.startswith(b"HTTP/1.1 400 "), out
        assert up.seen == []
    run(go())


def test_body_length_is_ascii_digits_only():
    assert bridge.body_length([("Content-Length", "\xb2")], False) == (None, "content-length")
    assert bridge.body_length([("Content-Length", "000012")], False) == (12, None)
    assert bridge.body_length([("Content-Length", "999999999999")], False) == (999999999999, None)
    assert bridge.body_length([("Content-Length", "5"), ("content-length", "5")], False) == (5, None)
    assert bridge.body_length([("Content-Length", "0")], True) == (0, None)


@pytest.mark.parametrize("te", ["chunked", "Chunked", "identity", "gzip, chunked", "chunked, identity", "", "x"])
def test_any_transfer_encoding_is_refused(te):
    async def go():
        out, up, _ = await through(POST_TAKE + f"Transfer-Encoding: {te}\r\nContent-Length: 2\r\n" + COOKIE + "\r\n{}" + SMUGGLE)
        assert out.startswith(b"HTTP/1.1 411 "), out
        assert up.seen == []
    run(go())


@pytest.mark.parametrize("hdr", ["Transfer-Encoding : chunked", "Transfer-Encoding\t: chunked", " Transfer-Encoding: chunked",
                                 "\tTransfer-Encoding: chunked", "Content-Length : 2"])
def test_header_names_with_whitespace_or_folding_are_a_bad_request(hdr):
    """A front end that strips the space and a back end that does not disagree about the body: refuse instead."""
    async def go():
        out, up, _ = await through(POST_TAKE + "X-A: 1\r\n" + hdr + "\r\nContent-Length: 2\r\n" + COOKIE + "\r\n{}" + SMUGGLE)
        assert out.startswith(b"HTTP/1.1 400 "), out
        assert up.seen == []
    run(go())


def test_no_content_length_forwards_no_body_and_nothing_pipelined_behind_it():
    async def go():
        out, up, _ = await through(POST_TAKE + COOKIE + "\r\n" + SMUGGLE)
        assert up.seen == [("POST", "/soundstage/vcam/take")], up.seen
        assert b"/prompt" not in up.raw
        assert out.startswith(b"HTTP/1.1 200 ")
    run(go())


def test_a_short_content_length_forwards_only_that_many_bytes():
    async def go():
        body = '{"take": 1, "x": "POST /prompt HTTP/1.1"}'
        out, up, _ = await through(POST_TAKE + "Content-Length: 11\r\n" + COOKIE + "\r\n" + body + SMUGGLE)
        assert up.seen == [("POST", "/soundstage/vcam/take")], up.seen
        assert up.raw.endswith(b'{"take": 1,'), up.raw[-40:]
    run(go())


def test_bytes_sent_after_the_body_in_a_later_write_stay_here_too():
    async def go():
        out, up, _ = await through(POST_TAKE + "Content-Length: 2\r\n" + COOKIE + "\r\n{}", then=SMUGGLE.encode())
        assert up.seen == [("POST", "/soundstage/vcam/take")], up.seen
        assert b"/prompt" not in up.raw
    run(go())


def test_a_get_with_a_body_forwards_exactly_the_body_and_no_more():
    async def go():
        out, up, _ = await through("GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n" + COOKIE + "\r\nabc" + SMUGGLE)
        assert up.seen == [("GET", "/soundstage/vcam/status")] and up.raw.endswith(b"abc")
    run(go())


def test_the_phone_hanging_up_mid_body_ends_the_request_upstream():
    async def go():
        out, up, _ = await through(POST_TAKE + "Content-Length: 100\r\n" + COOKIE + "\r\n{\"partial")
        assert up.seen == [("POST", "/soundstage/vcam/take")]
        assert b"/prompt" not in up.raw
    run(go())


def test_a_head_over_the_limit_is_431():
    async def go():
        out, up, _ = await through("GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\nX-Pad: " + "a" * (40 * 1024) + "\r\n" + COOKIE + "\r\n")
        assert out.startswith(b"HTTP/1.1 431 ") and up.seen == []
    run(go())


# ---------------------------------------------------------------- the WebSocket handshake against odd upstreams

WS = ("GET /soundstage/vcam/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" + COOKIE + "\r\n")


@pytest.mark.parametrize("answer, status", [
    (b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nhi", b"200"),
    (b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", b"403"),
    (b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n", b"502"),
    (b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n", b"502"),
    (b"HTTP/1.0 101 Switching Protocols\r\nUpgrade: websocket\r\nX: 1\r\n\r\n", b"101"),     # HTTP/1.0 is still HTTP/1.
    (b"HTTP/1.1 1o1 Switching\r\nUpgrade: websocket\r\n\r\n", b"502"),
    (b"HTTP/1.1 \xb9\xb2\xb3 x\r\nUpgrade: websocket\r\n\r\n", b"502"),
    (b"SSH-2.0-OpenSSH\r\n\r\n", b"502"),
    (b"HTTP/1.1 400 Bad Request\r\nContent-Length: 99999999\r\n\r\nshort", b"400"),
])
def test_only_a_101_websocket_answer_opens_the_pipe(answer, status):
    """Whatever ComfyUI answers, the phone's frames sent after the handshake reach it only behind a real 101."""
    async def go():
        out, up, logs = await through(WS + "POST /prompt HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}", upstream=LenientComfy(ws_answer=answer))
        assert out.startswith(b"HTTP/1.1 " + status) or (status == b"101" and out.startswith(b"HTTP/1.0 101")), out
        if status != b"101":
            assert out.count(b"HTTP/1.") == 1, "one response, then the bridge closes"
            assert up.seen == [("GET", "/soundstage/vcam/ws")], up.seen
            assert b"/prompt" not in up.raw
    run(go())


def test_an_upstream_that_hangs_up_on_the_handshake_is_a_502():
    async def go():
        out, up, _ = await through(WS, upstream=LenientComfy(ws_answer=b""))
        assert out.startswith(b"HTTP/1.1 502 "), out
    run(go())


def test_an_upstream_that_hangs_up_mid_response_ends_the_phones_connection():
    async def go():
        out, up, _ = await through(f"GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\n{COOKIE}\r\n",
                                   upstream=LenientComfy(plain_answer=b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"), eof=False)
        assert out == b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"
    run(go())


def test_an_upstream_that_is_not_there_is_a_502():
    async def go():
        s = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
        port = s.sockets[0].getsockname()[1]
        s.close()
        await s.wait_closed()
        srv, bport, _ = await start_bridge(port)
        out = await send_all(bport, f"GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\n{COOKIE}\r\n".encode())
        srv.close()
        assert out.startswith(b"HTTP/1.1 502 ")
    run(go())


def test_a_body_on_the_upgrade_is_refused():
    async def go():
        out, up, _ = await through(WS.replace("\r\n\r\n", "\r\nContent-Length: 2\r\n\r\n") + "{}")
        assert out.startswith(b"HTTP/1.1 400 ") and up.seen == []
    run(go())


# ---------------------------------------------------------------- header injection

@pytest.mark.parametrize("head", [
    # a lone LF ends a line for a lenient server: the second request hides inside one header's value
    "GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\nX-A: a\n\nPOST /prompt HTTP/1.1\nHost: x\nContent-Length: 2\n\n{}\r\n" + COOKIE + "\r\n",
    "GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\n" + COOKIE + "X-A: a\nContent-Length: 50\r\n\r\n",
    "GET /soundstage/vcam/status HTTP/1.1\nPOST /prompt HTTP/1.1\r\nHost: x\r\n" + COOKIE + "\r\n",
    "GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\rX-B: 1\r\n" + COOKIE + "\r\n",
    "GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\x00y\r\n" + COOKIE + "\r\n",
    "GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\x7f\r\n" + COOKIE + "\r\n",
    "GET /view?x=\n\nPOST HTTP/1.1\r\nHost: x\r\n" + COOKIE + "\r\n",
])
def test_control_characters_in_the_head_are_a_bad_request(head):
    async def go():
        out, up, _ = await through(head)
        assert out.startswith(b"HTTP/1.1 400 "), out
        assert up.seen == [], up.seen
    run(go())


def test_a_tab_inside_a_header_value_is_still_fine():
    assert bridge.parse_head(b"GET /a HTTP/1.1\r\nUser-Agent: a\tb\r\nCookie: x=1") == ("GET", "/a", "HTTP/1.1", [("User-Agent", "a\tb"), ("Cookie", "x=1")])


def test_the_pairing_cookie_never_goes_up_in_any_cookie_header():
    async def go():
        req = (f"GET /soundstage/vcam/status HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\nCookie: ss_vk={TOKEN}; b=2\r\n"
               f"cookie: ss_vk={TOKEN}\r\n\r\n")
        out, up, _ = await through(req)
        assert up.seen == [("GET", "/soundstage/vcam/status")]
        assert TOKEN.encode() not in up.raw and b"a=1" in up.raw and b"b=2" in up.raw
    run(go())


def test_host_and_origin_go_up_as_the_phone_sent_them():
    """The bridge has no Host / Origin check of its own: ComfyUI's origin check compares the two, so neither may be
    rewritten (docs/vcam.md). They pass through byte for byte; the token and the allow-list are the bridge's locks."""
    async def go():
        req = (f"POST /soundstage/vcam/take HTTP/1.1\r\nHost: mac.local:8443\r\nOrigin: https://mac.local:8443\r\n"
               f"Content-Length: 2\r\n{COOKIE}\r\n{{}}")
        out, up, _ = await through(req)
        assert b"\r\nHost: mac.local:8443\r\n" in up.raw and b"\r\nOrigin: https://mac.local:8443\r\n" in up.raw
    run(go())
