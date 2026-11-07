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
