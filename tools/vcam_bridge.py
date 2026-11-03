#!/usr/bin/env python3
"""Soundstage phone-viewfinder bridge: lets a phone on your Wi-Fi reach the App, safely.

The App runs on the RunPod pod and the Mac reaches it through the SSH tunnel at 127.0.0.1:8189. A phone can't open the
Mac's 127.0.0.1, and its motion sensors only work on an https page. This bridge listens on the Mac's Wi-Fi address with
https and forwards to the tunnel, with three locks so ComfyUI is never simply "open on the network":

  1. a pairing token: the QR code carries it once (?vk=...), the phone keeps it as a cookie; no token, no entry;
  2. an allow-list: only the viewfinder page, its WebSocket, its take and clip uploads and the read-only files the stage needs
     (/extensions/<pack>/..., /view). /prompt, /queue, /api/userdata, /upload... are refused (403) even with the token.
     One request per connection: only its declared body is forwarded, and the WebSocket turns into a raw pipe only
     after ComfyUI answers 101, so nothing can be pipelined behind an allowed request;
  3. it is LAN only (nothing is exposed to the internet) and runs only while this command runs (Ctrl-C stops it).

Usage (on the Mac, with the tunnel up):
    python3 tools/vcam_bridge.py                 # https on :8443, certificate made here on first run
    python3 tools/vcam_bridge.py --http          # plain http (no motion sensors on the phone: drag to aim)
    python3 tools/vcam_bridge.py --new-token     # forget every paired phone

First run makes a small local certificate authority in ~/.soundstage-vcam/ (or uses mkcert's files there, see
docs/vcam.md). Install it on the phone once from http://<mac>.local:8444/ (the bridge serves just that file there),
then trust it (iPhone: Settings > General > About > Certificate Trust Settings).

The phone-facing URL (with the token) is registered with the App (POST /soundstage/vcam/pair), so the desktop's
"Phone viewfinder" QR code points at this bridge. Python 3.9+, standard library and the `openssl` command only.
"""
import argparse
import asyncio
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request

PACK = "ComfyUI-Soundstage"
HOME = os.path.expanduser(os.environ.get("SOUNDSTAGE_VCAM_HOME", "~/.soundstage-vcam"))
COOKIE = "ss_vk"
MAX_HEAD = 32 * 1024

# (method, path regex) the phone may use. Everything else is 403.
ALLOW = [
    ("GET", re.compile(r"^/soundstage/vcam(/(viewfinder|status|pair|takes|take|device\.mjs|stabilize\.mjs))?$")),
    ("GET", re.compile(r"^/soundstage/vcam/ws$")),                     # WebSocket upgrade
    ("POST", re.compile(r"^/soundstage/vcam/(take|pose|clip)$")),           # clip: "Film a move" (needs the clip code too)
    ("GET", re.compile(r"^/extensions/" + re.escape(PACK) + r"/[A-Za-z0-9_./-]+$")),
    ("GET", re.compile(r"^/(api/)?view$")),                            # models, backdrops, mocap takes the stage loads
    ("GET", re.compile(r"^/favicon\.ico$")),
]
ALLOW_METHODS = {"GET", "HEAD", "POST"}
CTL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")          # control characters other than HTAB
TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")    # an HTTP token (method, header name)
TARGET = re.compile(r"[\x21-\x7e]+\Z")                 # a request target: visible ASCII only


# ---------------------------------------------------------------- pure helpers (unit-tested: tests/test_vcam_viewfinder.py; end to end: tests/test_vcam_bridge.py)

def parse_head(raw):
    """b"GET /x?y HTTP/1.1\\r\\nHost: a\\r\\n\\r\\n" -> (method, target, version, [(name, value)]) or None."""
    try:
        text = raw.decode("latin-1")
    except Exception:
        return None
    lines = text.split("\r\n")
    # A bare LF or CR (or any other control character) inside the head is refused: the bridge reads lines on CRLF
    # only, so a server that also accepts a lone LF (RFC 9112 lets it) would see a second request hidden in one header.
    if any(CTL.search(ln) for ln in lines):
        return None
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1.") or not TOKEN.match(parts[0]):
        return None
    headers = []
    for ln in lines[1:]:
        if not ln:
            continue
        if ":" not in ln:
            return None
        k, v = ln.split(":", 1)
        if not TOKEN.match(k):            # "Transfer-Encoding : chunked", a folded line: refused, not guessed at
            return None
        headers.append((k, v.strip()))
    return parts[0].upper(), parts[1], parts[2], headers


def header(headers, name):
    name = name.lower()
    for k, v in headers:
        if k.lower() == name:
            return v
    return None


def cookie_token(headers):
    for k, v in headers:
        if k.lower() != "cookie":
            continue
        for part in v.split(";"):
            if "=" in part:
                a, b = part.strip().split("=", 1)
                if a == COOKIE:
                    return b
    return None


def allowed(method, path):
    if method == "HEAD":
        method = "GET"
    return any(m == method and rx.match(path) for m, rx in ALLOW)


def decide(method, target, headers, token):
    """What to do with a request: ("pass", None) | ("pair", clean_target) | ("deny", why) | ("forbid", why)."""
    if method not in ALLOW_METHODS:
        return "forbid", "method"
    if not TARGET.match(target):          # urlsplit drops tabs and newlines: check what is forwarded, not a cleaned copy
        return "forbid", "target"
    url = urllib.parse.urlsplit(target)
    if url.scheme or url.netloc or not url.path.startswith("/") or ".." in url.path or "\\" in url.path:
        return "forbid", "target"
    q = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
    given = dict(q).get("vk")
    if given is not None:
        if not secrets.compare_digest(given, token):
            return "deny", "bad token"
        rest = urllib.parse.urlencode([(k, v) for k, v in q if k != "vk"])
        return "pair", url.path + ("?" + rest if rest else "")
    have = cookie_token(headers)
    if have is None or not secrets.compare_digest(have, token):
        return "deny", "no token"
    if not allowed(method, url.path):
        return "forbid", url.path
    return "pass", None


def rewrite_head(method, target, version, headers):
    """The request head to forward: one request per connection (Connection: close) unless it is a WebSocket upgrade,
    and the pairing cookie stays here (ComfyUI never sees it)."""
    # Only the vcam WebSocket may keep its connection open: an "Upgrade: websocket" on any other path would leave the
    # raw pipe open, and a second request pipelined after it (POST /prompt ...) would reach ComfyUI unchecked.
    path = urllib.parse.urlsplit(target).path
    upgrade = (method == "GET" and path == "/soundstage/vcam/ws"
               and (header(headers, "upgrade") or "").lower() == "websocket")
    out = [f"{method} {target} {version}"]
    for k, v in headers:
        kl = k.lower()
        if kl in ("connection", "keep-alive", "proxy-connection", "upgrade") and not upgrade:
            continue
        if kl == "cookie":
            v = "; ".join(p.strip() for p in v.split(";") if p.strip() and not p.strip().startswith(COOKIE + "="))
            if not v:
                continue
        out.append(f"{k}: {v}")
    if not upgrade:
        out.append("Connection: close")
    return ("\r\n".join(out) + "\r\n\r\n").encode("latin-1"), upgrade


def response(status, reason, body=b"", headers=()):
    head = [f"HTTP/1.1 {status} {reason}", f"Content-Length: {len(body)}", "Connection: close", "Cache-Control: no-store"]
    head += [f"{k}: {v}" for k, v in headers]
    return ("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body


DENY_PAGE = b"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Soundstage</title>
<body style="font:16px -apple-system,sans-serif;background:#111;color:#eee;padding:24px">
<h2>Scan the QR code again</h2><p>Open <b>Phone viewfinder</b> in the Soundstage App on the computer and scan its QR code
with this phone. (This link needs the pairing code the QR carries.)</p></body>"""


# ---------------------------------------------------------------- certificates

def lan_names():
    host = None
    try:
        host = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception:
        pass
    host = ((host or socket.gethostname().split(".")[0]) + ".local").lower()
    ip = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))     # no packet is sent: this only picks the Wi-Fi interface's address
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return host, ip


def ensure_cert(host, ip):
    """(certfile, keyfile, ca_file_or_None). mkcert files for the host win; else a local CA made with openssl."""
    os.makedirs(HOME, exist_ok=True)
    os.chmod(HOME, 0o700)
    mk_cert, mk_key = os.path.join(HOME, f"{host}.pem"), os.path.join(HOME, f"{host}-key.pem")
    if os.path.isfile(mk_cert) and os.path.isfile(mk_key):
        return mk_cert, mk_key, None
    ca, ca_key = os.path.join(HOME, "soundstage-vcam-ca.pem"), os.path.join(HOME, "soundstage-vcam-ca.key")
    cert, key = os.path.join(HOME, "bridge.pem"), os.path.join(HOME, "bridge.key")
    run = lambda *a: subprocess.run(["openssl", *a], check=True, capture_output=True)  # noqa: E731
    if not (os.path.isfile(ca) and os.path.isfile(ca_key)):
        cnf = os.path.join(HOME, "ca.cnf")
        with open(cnf, "w") as f:
            f.write("[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Soundstage VCam local CA\nO=Soundstage\n"
                    "[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n")
        run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca_key, "-out", ca, "-days", "3650", "-sha256", "-config", cnf)
        os.chmod(ca_key, 0o600)
    names = os.path.join(HOME, "names.txt")
    want = f"{host}|{ip}"
    have = open(names).read() if os.path.isfile(names) else ""
    if not (os.path.isfile(cert) and os.path.isfile(key)) or have != want:
        san = f"DNS:{host},DNS:localhost,IP:127.0.0.1" + (f",IP:{ip}" if ip else "")
        cnf = os.path.join(HOME, "leaf.cnf")
        with open(cnf, "w") as f:
            f.write(f"[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN={host}\n[v3]\nbasicConstraints=CA:FALSE\n"
                    f"keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName={san}\n")
        csr = os.path.join(HOME, "bridge.csr")
        run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-config", cnf)
        # 397 days: the longest a phone accepts for a server certificate
        run("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial", "-out", cert, "-days", "397", "-sha256",
            "-extfile", cnf, "-extensions", "v3")
        os.chmod(key, 0o600)
        with open(names, "w") as f:
            f.write(want)
    return cert, key, ca


def load_token(new=False):
    path = os.path.join(HOME, "token")
    os.makedirs(HOME, exist_ok=True)
    if not new and os.path.isfile(path):
        t = open(path).read().strip()
        if len(t) >= 16:
            return t
    t = secrets.token_urlsafe(18)
    with open(path, "w") as f:
        f.write(t)
    os.chmod(path, 0o600)
    return t


# ---------------------------------------------------------------- the proxy

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer, cfg):
    peer = writer.get_extra_info("peername")
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
    except Exception:
        writer.close()
        return
    if len(raw) > MAX_HEAD:
        writer.write(response(431, "Request Header Fields Too Large"))
        writer.close()
        return
    head = parse_head(raw[:-4])
    if not head:
        writer.write(response(400, "Bad Request"))
        writer.close()
        return
    method, target, version, headers = head
    verdict, info = decide(method, target, headers, cfg["token"])
    log = cfg["log"]
    if verdict == "pair":
        log(f"{peer[0]} paired")
        flags = "; Secure" if cfg["tls"] else ""
        writer.write(response(302, "Found", b"", [("Location", info),
                                                  ("Set-Cookie", f"{COOKIE}={cfg['token']}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000{flags}")]))
        await writer.drain()
        writer.close()
        return
    if verdict != "pass":
        log(f"{peer[0]} {method} {target.split('?')[0]} -> {verdict} ({info})")
        if verdict == "deny":
            writer.write(response(401, "Unauthorized", DENY_PAGE, [("Content-Type", "text/html; charset=utf-8")]))
        else:
            writer.write(response(403, "Forbidden", b"not available from the phone bridge\n", [("Content-Type", "text/plain")]))
        await writer.drain()
        writer.close()
        return
    out, upgrade = rewrite_head(method, target, version, headers)
    length, why = body_length(headers, upgrade)
    if length is None:
        log(f"{peer[0]} {method} {target.split('?')[0]} -> refused ({why})")
        status, reason = (411, "Length Required") if why == "chunked" else (400, "Bad Request")
        writer.write(response(status, reason, f"{why}\n".encode(), [("Content-Type", "text/plain")]))
        await writer.drain()
        writer.close()
        return
    try:
        up_r, up_w = await asyncio.open_connection(cfg["target_host"], cfg["target_port"])
    except Exception:
        writer.write(response(502, "Bad Gateway", b"The App is not reachable: is the SSH tunnel up?\n", [("Content-Type", "text/plain")]))
        writer.close()
        return
    try:
        up_w.write(out)
        await up_w.drain()
        if upgrade:
            await relay_upgrade(reader, writer, up_r, up_w, log, peer)
        else:
            # One request, then its response. Only the declared body goes up: anything the phone sends after it (a
            # pipelined second request) stays here, so the allow-list above is the only way in.
            await asyncio.gather(copy_exactly(reader, up_w, length), pipe(up_r, writer))
    except Exception:
        pass
    finally:
        for w in (up_w, writer):
            try:
                w.close()
            except Exception:
                pass


def body_length(headers, upgrade):
    """(bytes of request body to forward, None) or (None, why). The bridge forwards exactly this many bytes and no more,
    so it never has to understand a second request on the same connection. Chunked bodies are refused (the phone pages
    always send a Content-Length); a WebSocket handshake carries no body."""
    if header(headers, "transfer-encoding") is not None:
        return None, "chunked"
    lengths = {v.strip() for k, v in headers if k.lower() == "content-length"}
    if not lengths:
        return 0, None
    if len(lengths) != 1:
        return None, "content-length"
    v = lengths.pop()
    if not re.fullmatch(r"[0-9]{1,12}", v):     # str.isdigit() also says yes to "²", which int() then refuses
        return None, "content-length"
    if upgrade and int(v):
        return None, "body on upgrade"
    return int(v), None


async def copy_exactly(reader, writer, n):
    """Copy exactly n bytes from reader to writer and leave whatever follows unread."""
    while n > 0:
        data = await reader.read(min(n, 65536))
        if not data:                      # the phone hung up mid-body: let ComfyUI see the end too
            writer.close()
            break
        n -= len(data)
        writer.write(data)
        await writer.drain()


def upgrade_accepted(raw):
    """Is the response head `raw` (without the final blank line) a 101 Switching Protocols with Upgrade: websocket?"""
    head = parse_response_head(raw)
    return bool(head) and head[0] == 101 and (header(head[2], "upgrade") or "").lower() == "websocket"


def parse_response_head(raw):
    """b"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket" -> (101, "Switching Protocols", [(name, value)]) or None."""
    try:
        lines = raw.decode("latin-1").split("\r\n")
    except Exception:
        return None
    parts = lines[0].split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/1.") or not re.fullmatch(r"[0-9]{3}", parts[1]):
        return None
    hdrs = []
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            hdrs.append((k.strip(), v.strip()))
    return int(parts[1]), (parts[2] if len(parts) > 2 else ""), hdrs


async def relay_upgrade(reader, writer, up_r, up_w, log, peer):
    """The vcam WebSocket. Raw two-way piping starts only after ComfyUI answers 101 Switching Protocols with
    Upgrade: websocket. Any other answer (a broken handshake gets a 400 on a connection ComfyUI keeps open) is relayed
    as one response and both sides are closed, so nothing the phone sent after the handshake reaches ComfyUI."""
    try:
        raw = await asyncio.wait_for(up_r.readuntil(b"\r\n\r\n"), timeout=15)
    except Exception:
        writer.write(response(502, "Bad Gateway", b"no answer to the WebSocket handshake\n", [("Content-Type", "text/plain")]))
        await writer.drain()
        return
    if len(raw) <= MAX_HEAD and upgrade_accepted(raw[:-4]):
        writer.write(raw)
        await writer.drain()
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))
        return
    head = parse_response_head(raw[:-4]) if len(raw) <= MAX_HEAD else None
    status, reason, hdrs = head if head and head[0] != 101 else (502, "Bad Gateway", [])
    body = b""
    n = header(hdrs, "content-length")
    if n and n.isdigit():
        try:
            body = await asyncio.wait_for(up_r.readexactly(min(int(n), 65536)), timeout=5)
        except Exception:
            body = b""
    log(f"{peer[0]} WebSocket handshake not accepted upstream ({status}): one response, connection closed")
    ctype = header(hdrs, "content-type")
    writer.write(response(status, reason or "Error", body, [("Content-Type", ctype)] if ctype else ()))
    await writer.drain()


async def serve_ca(reader, writer, cfg):
    """Plain-http helper on --ca-port: only the CA certificate and a page that links it (both harmless to share)."""
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        head = parse_head(raw[:-4])
        path = urllib.parse.urlsplit(head[1]).path if head else "/"
        if path == "/soundstage-vcam-ca.pem" and cfg["ca"]:
            body = open(cfg["ca"], "rb").read()
            writer.write(response(200, "OK", body, [("Content-Type", "application/x-x509-ca-cert"),
                                                    ("Content-Disposition", "attachment; filename=soundstage-vcam-ca.pem")]))
        else:
            link = (f'<p><a href="/soundstage-vcam-ca.pem" style="color:#f2ff59;font-size:20px">Install the Soundstage certificate</a></p>'
                    f'<p>iPhone: tap it, allow the profile download, then Settings &gt; General &gt; VPN &amp; Device Management to install it, '
                    f'and Settings &gt; General &gt; About &gt; Certificate Trust Settings to turn it on. Android: Settings &gt; Security &gt; '
                    f'Install a certificate &gt; CA certificate.</p>') if cfg["ca"] else "<p>This bridge uses mkcert's certificate (see docs/vcam.md).</p>"
            body = (f'<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Soundstage certificate</title>'
                    f'<body style="font:16px -apple-system,sans-serif;background:#111;color:#eee;padding:24px"><h2>Soundstage viewfinder</h2>{link}'
                    f'<p>Then scan the QR code on the computer again.</p></body>').encode()
            writer.write(response(200, "OK", body, [("Content-Type", "text/html; charset=utf-8")]))
        await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


def register(cfg):
    """Tell the App where phones can reach it (the desktop's QR shows this). Repeats so a restarted App still knows."""
    body = json.dumps({"url": cfg["pair_url"]}).encode()
    req = urllib.request.Request(f"http://{cfg['target_host']}:{cfg['target_port']}/soundstage/vcam/pair", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


async def keep_registered(cfg):
    ok_before = None
    while True:
        ok = await asyncio.get_running_loop().run_in_executor(None, register, cfg)
        if ok != ok_before:
            cfg["log"]("registered with the App: the desktop QR points here" if ok else "the App is not answering on the tunnel yet (retrying)")
            ok_before = ok
        await asyncio.sleep(30)


async def main_async(a):
    host, ip = lan_names()
    if a.host:
        host = a.host
    token = load_token(a.new_token)
    th, tp = a.target.rsplit(":", 1)
    cfg = {"token": token, "target_host": th, "target_port": int(tp), "tls": not a.http, "ca": None,
           "log": lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)}
    ctx = None
    if not a.http:
        cert, key, ca = ensure_cert(host, ip)
        cfg["ca"] = ca
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(cert, key)
    scheme = "http" if a.http else "https"
    cfg["pair_url"] = f"{scheme}://{host}:{a.port}/soundstage/vcam/viewfinder?vk={token}"
    srv = await asyncio.start_server(lambda r, w: handle(r, w, cfg), a.bind, a.port, ssl=ctx)
    servers = [srv]
    if not a.http and a.ca_port:
        servers.append(await asyncio.start_server(lambda r, w: serve_ca(r, w, cfg), a.bind, a.ca_port))
    print("\nSoundstage phone viewfinder bridge")
    print(f"  forwarding  {scheme}://{host}:{a.port}  ->  http://{a.target}  (only the viewfinder's paths)")
    if ip:
        print(f"  also        {scheme}://{ip}:{a.port}")
    print(f"  phone URL   {cfg['pair_url']}")
    if cfg["ca"]:
        print(f"  first time on a phone: open http://{host}:{a.ca_port}/ and install + trust the certificate")
    print("  Open 'Phone viewfinder' in the App and scan the QR code. Ctrl-C stops the bridge.\n", flush=True)
    if not a.no_register:
        asyncio.create_task(keep_registered(cfg))
    await asyncio.gather(*(s.serve_forever() for s in servers))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--target", default="127.0.0.1:8189", help="the App (the SSH tunnel), default 127.0.0.1:8189")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--ca-port", type=int, default=8444, help="plain-http page with the certificate to install (0 = off)")
    p.add_argument("--bind", default="0.0.0.0", help="address to listen on (default: every interface of this Mac, LAN only)")
    p.add_argument("--host", default=None, help="the name phones use (default: <LocalHostName>.local)")
    p.add_argument("--http", action="store_true", help="plain http: no certificate, but no motion sensors on the phone")
    p.add_argument("--new-token", action="store_true", help="make a new pairing code (every paired phone must scan again)")
    p.add_argument("--no-register", action="store_true", help="don't tell the App about this bridge (its QR keeps its own address)")
    a = p.parse_args(argv)
    try:
        asyncio.run(main_async(a))
    except KeyboardInterrupt:
        print("bridge stopped")
    except subprocess.CalledProcessError as e:
        sys.exit(f"openssl failed: {e.stderr.decode(errors='replace')[:400]}")


if __name__ == "__main__":
    main()
