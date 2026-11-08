"""✦ Ask's bundled brain (soundstage/assistant.py): hardware tiers, the backend decision, unload before a render, the
status route's shape and the installer's opt-outs. No Ollama, no GPU: HTTP and hardware are stubbed."""
import asyncio
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import assistant as A  # noqa: E402

READY = {"reachable": True, "has_model": True, "loaded": False}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("SOUNDSTAGE_ASSISTANT_MODEL", "SKIP_OLLAMA", "SOUNDSTAGE_OLLAMA_URL", "OLLAMA_HOST"):
        monkeypatch.delenv(k, raising=False)


@pytest.mark.parametrize("vram,ram,device,num_gpu", [
    (48, 128, "gpu", None),    # RTX 6000 Ada pod
    (24, 32, "gpu", None),     # 4090: exactly the line
    (16, 64, "cpu", 0),        # 4080 + plenty of RAM: the GPU stays for renders
    (12, 20, "cpu", 0),        # just enough RAM
    (8, 16, "none", None),     # too small: honest message, built-in 4B
    (0, 8, "none", None),      # no GPU, small laptop
])
def test_tiers_for_the_big_model(vram, ram, device, num_gpu):
    t = A.choose_tier(vram, ram, "qwen3:30b-a3b")
    assert (t["device"], t["num_gpu"]) == (device, num_gpu)
    assert t["reason"]
    if device == "none":
        assert "built-in Qwen3.5 4B" in t["reason"] and "qwen3:8b" in t["reason"]
        assert "API" not in t["reason"] and "PARTNER" not in t["reason"]


def test_smaller_pull_lowers_the_bar():
    assert A.size_class("qwen3:8b") == "small" and A.size_class("qwen3:30b-a3b") == "big"
    assert A.choose_tier(12, 16, "qwen3:8b")["device"] == "gpu"
    assert A.choose_tier(6, 12, "qwen3:8b")["device"] == "cpu"


def test_backend_is_ollama_only_when_running_with_the_model():
    hw = {"vram_gb": 48, "ram_gb": 128, "gpu": "RTX"}
    assert A.status(hw, READY)["backend"] == "ollama"
    away = A.status(hw, {"reachable": False, "has_model": False, "loaded": False})
    assert away["backend"] == "qwen" and "isn't running" in away["reason"]
    nomodel = A.status(hw, {"reachable": True, "has_model": False, "loaded": False})
    assert nomodel["backend"] == "qwen" and "ollama pull qwen3:30b-a3b" in nomodel["reason"]
    small = A.status({"vram_gb": 4, "ram_gb": 8, "gpu": ""}, READY)
    assert small["backend"] == "qwen" and small["device"] == "none"


def test_status_shape():
    st = A.status({"vram_gb": 16, "ram_gb": 64, "gpu": "RTX 4080"}, {**READY, "loaded": True})
    for k in ("backend", "model", "device", "num_gpu", "loaded", "reachable", "has_model", "reason", "url", "vram_gb", "ram_gb"):
        assert k in st, k
    assert st["device"] == "cpu" and st["loaded"] is True and st["model"] == "qwen3:30b-a3b"
    json.dumps(st)


def test_probe_uses_the_smaller_pull_when_that_is_what_is_installed(monkeypatch):
    def fake(method, path, body=None, timeout=2.0, url=None):
        return {"models": [{"name": "qwen3:8b"}]} if path == "/api/tags" else {"models": []}
    monkeypatch.setattr(A, "_http", fake)
    p = A.probe()
    assert p["model"] == "qwen3:8b" and p["has_model"]


def test_cpu_tier_and_busy_gpu_keep_layers_off_the_gpu():
    assert A.chat_options({"device": "cpu"}) == {"num_gpu": 0}
    assert A.chat_options({"device": "gpu"}) == {}
    assert A.chat_options({"device": "gpu"}, gpu_busy=True) == {"num_gpu": 0}


RENDER = {"1": {"class_type": "SoundstageStep", "inputs": {"step": 3}}, "2": {"class_type": "SaveVideo", "inputs": {}}}
TEXT = {"sa1": {"class_type": "CLIPLoader"}, "sa2": {"class_type": "PrimitiveStringMultiline"},
        "sa3": {"class_type": "TextGenerate"}, "sa4": {"class_type": "PreviewAny"}}


def test_unload_before_a_render_on_the_gpu_tier(monkeypatch):
    sent = []
    monkeypatch.setattr(A, "_http", lambda m, p, body=None, timeout=2.0, url=None: sent.append((m, p, body)) or {})
    gpu = lambda: {"device": "gpu", "backend": "ollama", "model": "qwen3:30b-a3b"}  # noqa: E731
    data = {"prompt": RENDER}
    assert A.on_prompt(data, st_fn=gpu, spawn=False) is data
    assert sent == [("POST", "/api/generate", {"model": "qwen3:30b-a3b", "keep_alive": 0})]
    sent.clear()
    A.on_prompt({"prompt": TEXT}, st_fn=gpu, spawn=False)                     # the built-in Qwen's text job
    A.on_prompt({"prompt": RENDER}, st_fn=lambda: {"device": "cpu", "backend": "ollama"}, spawn=False)  # CPU tier
    A.on_prompt({"prompt": RENDER}, st_fn=lambda: {"device": "gpu", "backend": "qwen"}, spawn=False)   # no Ollama
    assert sent == []


def test_unload_failure_never_blocks_the_render(monkeypatch):
    def boom(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(A, "_http", boom)
    data = {"prompt": RENDER}
    assert A.on_prompt(data, st_fn=lambda: {"device": "gpu", "backend": "ollama"}, spawn=False) is data
    assert A.unload() is False


def test_keep_alive_default_and_override(monkeypatch):
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", raising=False)
    assert A.keep_alive() == "10m"
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", "30m")
    assert A.keep_alive() == "30m"
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", "600")
    assert A.keep_alive() == 600
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", "1h30m")
    assert A.keep_alive() == "1h30m"
    for bad in ("  ", "10min", "1.5", "soon"):
        monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", bad)
        assert A.keep_alive() == "10m", bad


def test_autostart_doesnt_keep_the_model_forever(monkeypatch):
    monkeypatch.delenv("OLLAMA_KEEP_ALIVE", raising=False)
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", raising=False)
    monkeypatch.delenv("SKIP_OLLAMA", raising=False)
    monkeypatch.delenv("SOUNDSTAGE_OLLAMA_AUTOSTART", raising=False)
    monkeypatch.setattr(A.shutil, "which", lambda name: "ollama")
    monkeypatch.setattr(A, "probe", lambda model=None: {"reachable": False})
    started = {}
    monkeypatch.setattr(A.subprocess, "Popen", lambda cmd, env=None, **kw: started.update(env=env))
    assert A.autostart() is True
    assert started["env"]["OLLAMA_KEEP_ALIVE"] == "10m"


def test_nothing_loads_the_model_but_a_question(monkeypatch):
    """A fake Ollama records every request: status only reads, a chat sends the idle limit, and no warm-up route exists."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", raising=False)
    monkeypatch.setattr(A, "hardware", lambda: {"vram_gb": 16.0, "ram_gb": 128.0, "gpu": "test"})
    seen = []

    async def fake(request):
        body = await request.json() if request.can_read_body else None
        seen.append((request.method, request.path, body))
        if request.path == "/api/tags":
            return web.json_response({"models": [{"name": "qwen3:30b-a3b"}]})
        if request.path == "/api/ps":
            return web.json_response({"models": []})
        return web.json_response({"message": {"content": "{}"}})

    async def go():
        ollama = web.Application()
        ollama.router.add_route("*", "/{tail:.*}", fake)
        async with TestServer(ollama) as o:
            monkeypatch.setattr(A, "ollama_url", lambda: str(o.make_url("")).rstrip("/"))
            routes = web.RouteTableDef()
            A.register(routes)
            app = web.Application()
            app.add_routes(routes)
            async with TestClient(TestServer(app)) as c:
                st = await (await c.get("/soundstage/assistant/status")).json()
                gone = (await c.post("/soundstage/assistant/warmup", json={})).status
                posts_before_chat = [s for s in seen if s[0] == "POST"]
                # A tab left open from an older version still asks to keep the model forever.
                chat = await c.post("/soundstage/assistant/chat", json={"messages": [], "keep_alive": -1})
                return st, gone, posts_before_chat, chat.status
    st, gone, posts_before_chat, chat = asyncio.run(go())
    assert st["backend"] == "ollama" and st["loaded"] is False
    assert gone in (404, 405)
    assert posts_before_chat == []
    assert chat == 200
    posts = [s for s in seen if s[0] == "POST"]
    assert [p[1] for p in posts] == ["/api/chat"]
    assert posts[0][2]["keep_alive"] == "10m"


def test_status_route(monkeypatch):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    monkeypatch.setattr(A, "hardware", lambda: {"vram_gb": 48.0, "ram_gb": 128.0, "gpu": "RTX 6000 Ada"})
    monkeypatch.setattr(A, "probe", lambda model=None: dict(READY))

    async def go():
        routes = web.RouteTableDef()
        A.register(routes)
        app = web.Application()
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as c:
            r = await c.get("/soundstage/assistant/status")
            return r.status, await r.json()
    code, j = asyncio.run(go())
    assert code == 200
    assert (j["backend"], j["device"], j["model"], j["loaded"]) == ("ollama", "gpu", "qwen3:30b-a3b", False)
    assert isinstance(j["reason"], str) and j["reason"]


def test_installer_has_the_ollama_step_and_opt_outs():
    inst = (ROOT / "tools" / "install_runpod.sh").read_text()
    start = (ROOT / "tools" / "start_ollama.sh").read_text()
    assert "SKIP_OLLAMA" in inst and "SKIP_OLLAMA" in start
    assert "SOUNDSTAGE_ASSISTANT_MODEL:-qwen3:30b-a3b" in inst
    assert re.search(r"ollama pull \"\$\{SOUNDSTAGE_ASSISTANT_MODEL", inst)
    assert "https://ollama.com/install.sh" in start
    assert "OLLAMA_KEEP_ALIVE:-10m" in start and "OLLAMA_ORIGINS" in start and "8189" in start
    assert "/workspace/ollama/models" in inst and "/workspace/ollama/models" in start


# ---------------------------------------------------------------- Ask hooks: status()['local'] and num_ctx sizing
def test_status_says_whether_the_model_server_is_on_this_machine(monkeypatch):
    hw = {"vram_gb": 16, "ram_gb": 64, "gpu": "RTX 4080"}
    for url, local in [("127.0.0.1:11434", True), ("http://localhost:11434", True), ("http://[::1]:11434", True),
                       ("0.0.0.0:11434", True), ("http://127.0.0.5:9000", True),
                       ("https://abc123-11434.proxy.example.net", False), ("http://10.0.0.7:11434", False),
                       ("http://ask-box.example.org:11434", False)]:
        monkeypatch.setenv("SOUNDSTAGE_OLLAMA_URL", url)
        st = A.status(hw, READY)
        assert st["local"] is local, (url, st["url"])
    monkeypatch.setattr(A.socket, "gethostname", lambda: "Studio-Mac.local")
    assert A.is_local_url("http://studio-mac.local:11434") is True
    assert A.is_local_url("http://studio-mac:11434") is True
    assert A.is_local_url("http://other-mac.local:11434") is False
    assert A.is_local_url("not a url") is False


def test_num_ctx_is_sized_to_the_prompt_within_bounds(monkeypatch):
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", raising=False)
    planner = [{"role": "system", "content": "x" * (3500 * 4)}, {"role": "user", "content": "add a chair"}]   # ~3,500 tokens
    o = A.chat_options({"device": "gpu"}, messages=planner)
    assert o["num_ctx"] == 8192 and o["num_ctx"] in A.CTX_SIZES, o
    assert A.chat_options({"device": "gpu"}, messages=[{"role": "user", "content": "hi"}])["num_ctx"] == 8192   # the same size as the planner
    huge = [{"role": "user", "content": "y" * 1_000_000}]
    assert A.chat_options({"device": "gpu"}, messages=huge)["num_ctx"] == 32768                                 # bounded
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", "16384")
    assert A.chat_options({"device": "gpu"}, messages=huge)["num_ctx"] == 16384
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", "100")                                                  # a bad max: still 4096
    assert A.chat_options({"device": "gpu"}, messages=huge)["num_ctx"] == 4096
    assert A.chat_options({"device": "gpu"}, messages=[{"role": "user", "content": "hi"}])["num_ctx"] == 4096   # never below Ollama's
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX")
    # the request's own num_ctx / num_predict count; the GPU decision is unchanged
    assert A.chat_options({"device": "gpu"}, messages=[], options={"num_ctx": 12000})["num_ctx"] == 16384   # snapped up, never lowered
    assert A.chat_options({"device": "gpu"}, messages=[], options={"num_predict": 7000})["num_ctx"] == 8192
    assert A.chat_options({"device": "cpu"}, messages=planner)["num_gpu"] == 0
    assert "num_ctx" not in A.chat_options({"device": "gpu"})   # no messages: as before


def test_num_ctx_counts_tools_and_images_and_never_cuts_what_the_caller_asked(monkeypatch):
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", raising=False)
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    short = [{"role": "user", "content": "add a lamp"}]
    tools = [{"type": "function", "function": {"name": f"tool_{i}", "description": "d" * 400,
              "parameters": {"type": "object", "properties": {"x": {"type": "string", "description": "e" * 200}}}}}
             for i in range(60)]   # ~60 x 700 chars = ~12,000 tokens of schemas
    assert A.chat_options({"device": "gpu"}, messages=short)["num_ctx"] == 8192
    with_tools = A.chat_options({"device": "gpu"}, messages=short, tools=tools)["num_ctx"]
    assert with_tools >= A.prompt_tokens(short, tools) + A.REPLY_TOKENS and with_tools >= 16384, with_tools
    pics = [{"role": "user", "content": "match this frame", "images": ["aGVsbG8="] * 4}]
    assert A.prompt_tokens(pics) >= 4 * A.IMAGE_TOKENS
    assert A.chat_options({"device": "gpu"}, messages=pics)["num_ctx"] >= 4 * A.IMAGE_TOKENS + A.REPLY_TOKENS
    # the caller's num_ctx: plain decimal strings and floats count, snapped UP to CTX_SIZES (never lowered), not capped at max_ctx() (only at CTX_CEILING)
    for asked, want in [("12000", 16384), (12000.0, 16384), ("9000.5", 16384), ("8192", 8192), (65536, 65536), ("65536", 65536), (70000, 131072)]:
        assert A.chat_options({"device": "gpu"}, messages=short, options={"num_ctx": asked})["num_ctx"] == want, asked
    for junk in ["lots", True, -5, 0, None, float("nan")]:
        assert A.chat_options({"device": "gpu"}, messages=short, options={"num_ctx": junk})["num_ctx"] == 8192, junk
    assert A.chat_options({"device": "gpu"}, messages=short, options={"num_predict": "7000"})["num_ctx"] == 8192
    # never below the server's own OLLAMA_CONTEXT_LENGTH (as this process sees it)
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "16384")
    assert A.chat_options({"device": "gpu"}, messages=short)["num_ctx"] == 16384
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", "8192")
    assert A.chat_options({"device": "gpu"}, messages=[{"role": "user", "content": "y" * 1_000_000}])["num_ctx"] == 16384, \
        "a max below the server's context is raised to it"


def test_local_means_a_loopback_url_and_url_kind_tells_the_cases_apart(monkeypatch):
    hw = {"vram_gb": 16, "ram_gb": 64, "gpu": "RTX 4080"}
    monkeypatch.setattr(A.socket, "gethostname", lambda: "Studio-Mac.local")
    for url, kind in [("http://127.0.0.1:11434", "loopback"), ("http://localhost:11434", "loopback"),
                      ("http://studio-mac.local:11434", "this_host"), ("http://10.0.0.7:11434", "remote")]:
        monkeypatch.setenv("SOUNDSTAGE_OLLAMA_URL", url)
        st = A.status(hw, READY)
        assert (st["url_kind"], st["local"]) == (kind, kind != "remote"), url
    # an SSH tunnel to a pod is a loopback URL: local is True, url_kind says only "loopback" (it cannot see the tunnel)
    monkeypatch.setenv("SOUNDSTAGE_OLLAMA_URL", "http://127.0.0.1:11435")
    assert A.status(hw, READY)["url_kind"] == "loopback"


def test_chat_route_sizes_num_ctx_from_the_request_messages_tools_and_options(monkeypatch):
    """The /soundstage/assistant/chat route (assistant.py register) passes the request's messages, tools and options
    to chat_options: what reaches Ollama carries the sized num_ctx and the caller's own options."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", raising=False)
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    monkeypatch.setattr(A, "hardware", lambda: {"vram_gb": 16.0, "ram_gb": 128.0, "gpu": "test"})
    A._status_cache["v"] = None
    A.forget_ctx()
    seen = []

    async def fake(request):
        body = await request.json() if request.can_read_body else None
        seen.append((request.path, body))
        if request.path == "/api/tags":
            return web.json_response({"models": [{"name": "qwen3:30b-a3b"}]})
        if request.path == "/api/ps":
            return web.json_response({"models": []})
        return web.json_response({"message": {"content": "{}"}})

    tools = [{"type": "function", "function": {"name": f"t{i}", "description": "d" * 700}} for i in range(60)]

    async def go():
        ollama = web.Application()
        ollama.router.add_route("*", "/{tail:.*}", fake)
        async with TestServer(ollama) as o:
            monkeypatch.setattr(A, "ollama_url", lambda: str(o.make_url("")).rstrip("/"))
            routes = web.RouteTableDef()
            A.register(routes)
            app = web.Application()
            app.add_routes(routes)
            async with TestClient(TestServer(app)) as c:
                msgs = [{"role": "user", "content": "add a chair"}]
                a = await c.post("/soundstage/assistant/chat", json={"messages": msgs, "tools": tools})
                b = await c.post("/soundstage/assistant/chat", json={"messages": msgs, "options": {"num_ctx": "20000", "temperature": 0.2}})
                d = await c.post("/soundstage/assistant/chat", json={"messages": msgs})
                return a.status, b.status, d.status
    assert asyncio.run(go()) == (200, 200, 200)
    chats = [b for p, b in seen if p == "/api/chat"]
    assert len(chats) == 3
    assert chats[0]["options"]["num_ctx"] >= 16384 and chats[0]["tools"] == tools, "the tool list was counted"
    assert chats[0]["options"]["num_ctx"] in A.CTX_SIZES
    assert chats[1]["options"]["num_ctx"] == 32768 and chats[1]["options"]["temperature"] == 0.2, "20000 snapped up"
    assert chats[2]["options"]["num_ctx"] == 32768, "a short chat after: the model's size is reused (no reload)"
    A._status_cache["v"] = None


def test_num_ctx_is_bounded_by_the_ceiling_whatever_the_caller_or_environment_says(monkeypatch):
    """Fix: the caller's num_ctx and OLLAMA_CONTEXT_LENGTH used to pass through unbounded (1e12, 1e308 went to Ollama
    as-is). Every value is clamped to CTX_CEILING; non-finite values and exponent strings are ignored."""
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", raising=False)
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    short = [{"role": "user", "content": "add a lamp"}]
    ctx = lambda **o: A.chat_options({"device": "gpu"}, messages=short, options=o)["num_ctx"]
    assert A.CTX_CEILING == 131072
    for huge in [1e12, 1e308, 10 ** 400, "1000000000000", "999999999999999999999999", 131073]:
        assert ctx(num_ctx=huge) == A.CTX_CEILING, huge
    for refused in ["1e3", "1e12", "inf", "-inf", "nan", float("inf"), float("-inf"), "0x2000", " ", ""]:
        assert ctx(num_ctx=refused) == 8192, refused
    assert ctx(num_ctx=131072) == 131072 and ctx(num_ctx="65536") == 65536
    assert ctx(num_predict=1e308) <= A.CTX_CEILING
    for env, want in [("1e12", 4096), ("1000000000000", A.CTX_CEILING), ("inf", 4096), ("nan", 4096), ("16384", 16384)]:   # server_ctx() itself
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", env)
        assert A.server_ctx() == want, env
        n = ctx()
        assert isinstance(n, int) and 4096 <= n <= A.CTX_CEILING, (env, n)
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "1000000000000")
    assert ctx(num_ctx=8192) == A.CTX_CEILING
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", "1e308")
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH")
    assert A.max_ctx() == 32768, "an exponent string max falls back to the default"
    monkeypatch.setenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", "99999999")
    assert A.max_ctx() == A.CTX_CEILING


def test_num_ctx_is_stable_so_ollama_does_not_reload_the_model(monkeypatch):
    """Fix: the chat route sent a num_ctx sized to each prompt (4096 / 8192 / 12288 ...), and Ollama reloads the model
    whenever num_ctx changes, so mixing short chats with planner calls reloaded a big local model on every request.
    Now: a small set of fixed sizes (CTX_SIZES), the largest already sent to the model reused, never below the
    server's own OLLAMA_CONTEXT_LENGTH."""
    monkeypatch.delenv("SOUNDSTAGE_ASSISTANT_MAX_CTX", raising=False)
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    monkeypatch.setattr(A, "ollama_url", lambda: "http://127.0.0.1:11434")
    A.forget_ctx()
    short = [{"role": "user", "content": "hi"}]
    planner = [{"role": "system", "content": "x" * (3500 * 4)}, {"role": "user", "content": "add a chair"}]   # ~3,500 tokens
    mid = [{"role": "user", "content": "z" * (5000 * 4)}]                                                      # ~5,700 tokens
    big = [{"role": "user", "content": "w" * (9000 * 4)}]                                                      # ~10,300 tokens
    ctx = lambda m, model=None: A.chat_options({"device": "gpu"}, messages=m, model=model)["num_ctx"]
    # same size: consecutive short, long, short, long prompts send one value (no model given: sizes only)
    assert [ctx(m) for m in (short, planner, mid, short, planner, mid)] == [8192] * 6
    # the old per-prompt rounding gave 4096 / 8192 / 12288 for these: three reloads
    assert len({ctx(m) for m in (short, planner, mid)}) == 1
    # a bigger prompt steps up a size; for the same model, later short chats keep that size (no reload back down)
    assert [ctx(m, "qwen3:30b-a3b") for m in (short, planner, big, short, planner)] == [8192, 8192, 16384, 16384, 16384]
    # another model (or another Ollama URL) has its own size
    assert ctx(short, "llama3.2:3b") == 8192
    monkeypatch.setattr(A, "ollama_url", lambda: "http://127.0.0.1:11435")
    assert ctx(short, "qwen3:30b-a3b") == 8192
    monkeypatch.setattr(A, "ollama_url", lambda: "http://127.0.0.1:11434")
    # an unload forgets it (the model is out of memory, its next load may be smaller)
    monkeypatch.setattr(A, "_http", lambda *a, **k: {})
    assert A.unload("qwen3:30b-a3b") is True
    assert ctx(short, "qwen3:30b-a3b") == 8192
    # never below the server's own OLLAMA_CONTEXT_LENGTH, which is then the one value for every small prompt
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "12000")
    A.forget_ctx()
    assert [ctx(m, "m") for m in (short, planner, mid, short)] == [12000] * 4
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "65536")
    assert ctx(short, "m") == 65536 and ctx(big, "m") == 65536
    # every value sent is one of the sizes, the server's own context or the max (a handful of values, not one per prompt)
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH")
    A.forget_ctx()
    seen = {ctx([{"role": "user", "content": "q" * (n * 1000)}]) for n in range(1, 200, 3)}
    assert seen <= set(A.CTX_SIZES) | {A.max_ctx()}, seen
    A.forget_ctx()
