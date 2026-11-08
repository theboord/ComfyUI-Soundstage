"""✦ Ask's brain: Ollama + Qwen3-30B-A3B on this machine, placed by hardware so renders keep the GPU.

  tier     when                                  where the model runs
  gpu      GPU with >= 24 GB VRAM                on the GPU (unloaded before each render, reloaded on the next Ask)
  cpu      otherwise, >= 20 GB system RAM         CPU / RAM (Ollama num_gpu=0): the GPU stays free for renders
  none     under ~20 GB RAM                       not run: says so honestly and uses the built-in Qwen3.5 4B

Smaller pull (SOUNDSTAGE_ASSISTANT_MODEL=qwen3:8b) needs ~8 GB VRAM for the GPU tier and ~8 GB RAM for the CPU tier.

GET  /soundstage/assistant/status  -> {backend, model, device, num_gpu, loaded, reachable, has_model, reason, ...}
POST /soundstage/assistant/chat    body: an Ollama /api/chat body; forwarded to Ollama with the tier's options (the
     browser can't reach 127.0.0.1:11434 on a pod, the ComfyUI server can)
POST /soundstage/assistant/unload  free the GPU now (keep_alive: 0)

Nothing loads the model until someone asks a question, and Ollama lets it go after SOUNDSTAGE_ASSISTANT_KEEP_ALIVE idle
(default 10m), so opening the App costs no memory. An on-prompt handler unloads the model from VRAM before any render
is queued (gpu tier only). On ComfyUI start, an
installed but stopped Ollama is started (tools/start_ollama.sh does the same from a shell; SKIP_OLLAMA=1 opts out).
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request

log = logging.getLogger("soundstage.assistant")

DEFAULT_MODEL = "qwen3:30b-a3b"
FALLBACKS = ("qwen3:8b",)
DEFAULT_KEEP_ALIVE = "10m"   # how long an idle model stays in memory after an answer
# (min VRAM GB for the gpu tier, min RAM GB for the cpu tier) by model size
NEEDS = {"big": (24.0, 20.0), "small": (8.0, 8.0)}
# Text-only model jobs (the built-in Qwen through TextGenerate): no reason to free the GPU for these.
TEXT_ONLY = {"TextGenerate", "PreviewAny", "CLIPLoader", "PrimitiveStringMultiline", "PrimitiveString"}

_REGISTERED = False
_status_cache: dict = {"t": 0.0, "v": None}


def model_name() -> str:
    return (os.environ.get("SOUNDSTAGE_ASSISTANT_MODEL") or DEFAULT_MODEL).strip()


def ollama_url() -> str:
    host = os.environ.get("SOUNDSTAGE_OLLAMA_URL") or os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434"
    if not host.startswith("http"):
        host = "http://" + host
    return host.rstrip("/").replace("://0.0.0.0", "://127.0.0.1")


def size_class(model: str) -> str:
    """'big' for the 30B-class models (~19 GB at Q4), 'small' for 8B and under."""
    m = model.lower()
    for tag in ("0.6b", "1.7b", "1b", "3b", "4b", "7b", "8b"):
        if f":{tag}" in m or f"-{tag}" in m:
            return "small"
    return "big"


# ------------------------------------------------------------------------------------------------ hardware

def _ram_gb() -> float:
    try:
        import psutil  # ComfyUI ships it
        return psutil.virtual_memory().total / 1024 ** 3
    except Exception:  # noqa: BLE001
        pass
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 1024 ** 2
    except OSError:
        pass
    try:
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3).stdout
        return int(out.strip()) / 1024 ** 3
    except Exception:  # noqa: BLE001
        return 0.0


def _vram_gb() -> tuple[float, str]:
    """(largest GPU's VRAM in GB, its name). Apple silicon: ~2/3 of unified memory is what Metal will give a model."""
    try:
        import torch
        if torch.cuda.is_available():
            best = max(range(torch.cuda.device_count()), key=lambda i: torch.cuda.get_device_properties(i).total_memory)
            p = torch.cuda.get_device_properties(best)
            return p.total_memory / 1024 ** 3, p.name
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return _ram_gb() * 2 / 3, "Apple GPU (unified memory)"
    except Exception:  # noqa: BLE001 - no torch (tests, tools)
        pass
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,name", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5).stdout
            rows = [r.split(",", 1) for r in out.strip().splitlines() if r.strip()]
            if rows:
                mb, name = max(rows, key=lambda r: float(r[0]))
                return float(mb) / 1024, name.strip()
        except Exception:  # noqa: BLE001
            pass
    return 0.0, ""


def hardware() -> dict:
    vram, name = _vram_gb()
    return {"vram_gb": round(vram, 1), "ram_gb": round(_ram_gb(), 1), "gpu": name}


def choose_tier(vram_gb: float, ram_gb: float, model: str | None = None) -> dict:
    """Pure: where the assistant model runs on this hardware -> {device, num_gpu, reason}."""
    model = model or model_name()
    min_vram, min_ram = NEEDS[size_class(model)]
    if vram_gb >= min_vram:
        return {"device": "gpu", "num_gpu": None,
                "reason": f"{vram_gb:.0f} GB VRAM: {model} runs on the GPU and steps aside for every render"}
    if ram_gb >= min_ram:
        return {"device": "cpu", "num_gpu": 0,
                "reason": f"{vram_gb:.0f} GB VRAM (under {min_vram:.0f}): {model} runs on the CPU in {ram_gb:.0f} GB RAM "
                          "so the GPU stays free for renders (slower answers)"}
    return {"device": "none", "num_gpu": None,
            "reason": f"only {ram_gb:.0f} GB RAM ({model} needs ~{min_ram:.0f} GB, or {min_vram:.0f} GB VRAM): ✦ Ask uses "
                      "the built-in Qwen3.5 4B instead (slower, less capable). A smaller pull may fit: "
                      "SOUNDSTAGE_ASSISTANT_MODEL=qwen3:8b"}


# ------------------------------------------------------------------------------------------------ Ollama

def _http(method: str, path: str, body=None, timeout: float = 2.0, url: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request((url or ollama_url()) + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - our own localhost Ollama
        return json.loads(r.read() or b"{}")


def _same(a: str, b: str) -> bool:
    norm = lambda s: s[:-7] if s.endswith(":latest") else s  # noqa: E731
    return norm(a) == norm(b)


def probe(model: str | None = None) -> dict:
    """{reachable, has_model, loaded, on_gpu} from Ollama's /api/tags and /api/ps."""
    model = model or model_name()
    out = {"reachable": False, "has_model": False, "loaded": False}
    try:
        tags = _http("GET", "/api/tags")
    except Exception:  # noqa: BLE001 - not running
        return out
    out["reachable"] = True
    names = [m.get("name", "") for m in tags.get("models", [])]
    if not os.environ.get("SOUNDSTAGE_ASSISTANT_MODEL") and not any(_same(n, model) for n in names):
        # Installed with SOUNDSTAGE_ASSISTANT_MODEL=qwen3:8b but ComfyUI started without it: use the smaller pull.
        model = next((f for f in FALLBACKS if any(_same(n, f) for n in names)), model)
    out["model"] = model
    out["has_model"] = any(_same(n, model) for n in names)
    try:
        ps = _http("GET", "/api/ps")
        out["loaded"] = any(_same(m.get("name", ""), model) for m in ps.get("models", []))
    except Exception:  # noqa: BLE001
        pass
    return out


def status(hw: dict | None = None, probed: dict | None = None, model: str | None = None) -> dict:
    """The whole decision: which backend ✦ Ask uses (ollama, else the built-in qwen) and why. Pure when hw and probed
    are given."""
    model = model or model_name()
    hw = hw if hw is not None else hardware()
    probed = probed if probed is not None else probe(model)
    model = probed.get("model") or model
    tier = choose_tier(hw.get("vram_gb", 0), hw.get("ram_gb", 0), model)
    out = {"model": model, "url": ollama_url(), **hw, **probed, **tier,
           "skipped": os.environ.get("SKIP_OLLAMA", "0") == "1"}
    out["local"] = is_local_url(out["url"])   # the Ask model server is on this machine (loopback / own name)
    if tier["device"] == "none":
        out["backend"] = "qwen"
    elif not probed.get("reachable"):
        out["backend"], out["reason"] = "qwen", f"Ollama isn't running at {out['url']} (install: tools/start_ollama.sh); using the built-in Qwen3.5 4B"
    elif not probed.get("has_model"):
        out["backend"], out["reason"] = "qwen", f"Ollama has no {model} yet (ollama pull {model}); using the built-in Qwen3.5 4B"
    else:
        out["backend"] = "ollama"
    return out


def cached_status(max_age: float = 20.0) -> dict:
    now = time.monotonic()
    if _status_cache["v"] is None or now - _status_cache["t"] > max_age:
        _status_cache["v"], _status_cache["t"] = status(), now
    return _status_cache["v"]


OLLAMA_DEFAULT_CTX = 4096   # Ollama's own default context: never asked below it
CTX_STEP = 4096             # num_ctx is rounded up to a multiple of this (8192 for a ~3,500-token planner prompt)
CHARS_PER_TOKEN = 3.5       # a deliberately low estimate (English runs ~4), so the prompt is never under-counted
REPLY_TOKENS = 2048         # room kept for the answer when the request sets no num_predict


def max_ctx() -> int:
    """The largest num_ctx ✦ Ask asks for (SOUNDSTAGE_ASSISTANT_MAX_CTX, default 32768; never below 4096)."""
    try:
        v = int(os.environ.get("SOUNDSTAGE_ASSISTANT_MAX_CTX", "32768"))
    except ValueError:
        v = 32768
    return max(OLLAMA_DEFAULT_CTX, v)


def prompt_tokens(messages) -> int:
    """Rough token count of a chat request's messages (content + tool calls), from its length in characters."""
    n = 0
    for m in messages or []:
        if isinstance(m, dict):
            c = m.get("content")
            n += len(c if isinstance(c, str) else json.dumps(c or "")) + 8   # + the role / turn markers
            if m.get("tool_calls"):
                n += len(json.dumps(m["tool_calls"]))
        else:
            n += len(str(m))
    return int(n / CHARS_PER_TOKEN) + 1


def num_ctx_for(messages, reply: int | None = None, asked: int | None = None) -> int:
    """num_ctx sized to the prompt: prompt + reply room, rounded up to 4096s, at least Ollama's 4096 (and at least
    what the request asked), at most max_ctx(). A prompt bigger than max_ctx() is still capped (Ollama then drops
    the oldest part)."""
    need = prompt_tokens(messages) + (reply if isinstance(reply, int) and reply > 0 else REPLY_TOKENS)
    if isinstance(asked, int) and asked > 0:
        need = max(need, asked)
    need = -(-need // CTX_STEP) * CTX_STEP
    return max(OLLAMA_DEFAULT_CTX, min(max_ctx(), need))


def chat_options(st: dict, gpu_busy: bool = False, messages=None, options: dict | None = None) -> dict:
    """Ollama options for this tier: CPU tier (or a GPU tier while a render runs) keeps every layer off the GPU.
    With the request's messages, num_ctx is sized to them (num_ctx_for); options = the request's own options
    (its num_predict and num_ctx are honoured, within the bound)."""
    opts = {}
    if st.get("device") == "cpu" or (st.get("device") == "gpu" and gpu_busy):
        opts["num_gpu"] = 0
    if messages is not None:
        o = options or {}
        opts["num_ctx"] = num_ctx_for(messages, reply=o.get("num_predict"), asked=o.get("num_ctx"))
    return opts


def is_local_url(url: str | None = None) -> bool:
    """True when the Ask model server is on this machine: a loopback address (127.x, ::1, localhost, 0.0.0.0, which
    ollama_url() maps to 127.0.0.1) or this machine's own host name. False for any other host (a remote URL, a pod).
    No DNS lookup: a name is compared, never resolved."""
    from urllib.parse import urlsplit
    try:
        host = (urlsplit(url or ollama_url()).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    if not host:
        return False
    if host in ("localhost", "0.0.0.0", "::1", "::") or host.endswith(".localhost") or re.fullmatch(r"127(\.\d{1,3}){3}", host):
        return True
    try:
        me = socket.gethostname().lower().rstrip(".")
    except OSError:
        return False
    return bool(me) and host in (me, me.split(".")[0], me.split(".")[0] + ".local")


def keep_alive():
    """How long Ollama keeps the model after an answer: a duration ("10m") or a number of seconds, as Ollama takes it."""
    v = os.environ.get("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE", "").strip()
    if not v:
        return DEFAULT_KEEP_ALIVE
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?(\d+(\.\d+)?(ms|s|m|h))+", v):
        return v
    log.warning("SOUNDSTAGE_ASSISTANT_KEEP_ALIVE=%r isn't a duration like 10m or a number of seconds; using %s", v, DEFAULT_KEEP_ALIVE)
    return DEFAULT_KEEP_ALIVE


def unload(model: str | None = None, timeout: float = 3.0) -> bool:
    """Free the model's VRAM now (Ollama: a request with keep_alive 0). Ollama reloads it on the next Ask turn."""
    try:
        _http("POST", "/api/generate", {"model": model or model_name(), "keep_alive": 0}, timeout=timeout)
        return True
    except Exception:  # noqa: BLE001 - Ollama away: nothing to free
        return False


def is_render(prompt) -> bool:
    """Does this ComfyUI prompt use the GPU for more than a text-model call?"""
    if not isinstance(prompt, dict):
        return False
    kinds = {n.get("class_type") for n in prompt.values() if isinstance(n, dict)}
    return bool(kinds - TEXT_ONLY)


def on_prompt(json_data, st_fn=cached_status, unload_fn=unload, spawn=True):
    """ComfyUI on-prompt handler: before a render is queued, free the assistant's VRAM (gpu tier only)."""
    try:
        prompt = (json_data or {}).get("prompt")
        if is_render(prompt):
            st = st_fn()
            if st.get("device") == "gpu" and st.get("backend") == "ollama":
                if spawn:
                    threading.Thread(target=unload_fn, args=(st.get("model"),), daemon=True).start()
                else:
                    unload_fn(st.get("model"))
    except Exception:  # noqa: BLE001 - never block a render
        log.debug("assistant unload skipped", exc_info=True)
    return json_data


def autostart() -> bool:
    """Start an installed Ollama that isn't running (the App's origins allowed, an idle model let go)."""
    if os.environ.get("SKIP_OLLAMA", "0") == "1" or os.environ.get("SOUNDSTAGE_OLLAMA_AUTOSTART", "1") == "0":
        return False
    exe = shutil.which("ollama")
    if not exe or probe()["reachable"]:
        return False
    env = dict(os.environ)
    env.setdefault("OLLAMA_KEEP_ALIVE", str(keep_alive()))
    env.setdefault("OLLAMA_ORIGINS", "http://127.0.0.1:*,http://localhost:*,https://*.proxy.runpod.net")
    if "OLLAMA_MODELS" not in env and os.path.isdir("/workspace/ollama/models"):
        env["OLLAMA_MODELS"] = "/workspace/ollama/models"
    try:
        subprocess.Popen([exe, "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        log.info("Soundstage: started Ollama for ✦ Ask (%s)", model_name())
        return True
    except OSError:
        return False


# ------------------------------------------------------------------------------------------------ routes

def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    import asyncio

    from aiohttp import ClientSession, ClientTimeout, web

    server = None
    if routes is None:
        from server import PromptServer
        server = PromptServer.instance
        routes = server.routes
        try:
            server.add_on_prompt_handler(on_prompt)
        except Exception:  # noqa: BLE001 - older ComfyUI
            pass
        threading.Thread(target=autostart, daemon=True).start()

    def _gpu_busy() -> bool:
        try:
            from server import PromptServer
            running, _ = PromptServer.instance.prompt_queue.get_current_queue_volatile()
            return any(is_render(it[2]) for it in running if len(it) > 2)
        except Exception:  # noqa: BLE001
            return False

    @routes.get("/soundstage/assistant/status")
    async def assistant_status(request):
        st = await asyncio.to_thread(status)
        _status_cache["v"], _status_cache["t"] = st, time.monotonic()
        return web.json_response(st)

    async def _forward(path, body, timeout):
        async with ClientSession(timeout=ClientTimeout(total=timeout)) as s:
            async with s.post(ollama_url() + path, json=body) as r:
                return r.status, await r.json(content_type=None)

    @routes.post("/soundstage/assistant/chat")
    async def assistant_chat(request):
        body = await request.json()
        st = await asyncio.to_thread(cached_status)
        body["model"] = body.get("model") or st["model"]
        body["stream"] = False
        asked = body.get("options") if isinstance(body.get("options"), dict) else {}
        body["options"] = {**asked, **chat_options(st, await asyncio.to_thread(_gpu_busy),
                                                   messages=body.get("messages") or [], options=asked)}
        body["keep_alive"] = keep_alive()   # the server decides: a tab left open from an older version can't pin the model
        try:
            code, j = await _forward("/api/chat", body, 300)
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": f"Ollama: {e}"}, status=502)
        return web.json_response(j, status=code)

    @routes.post("/soundstage/assistant/unload")
    async def assistant_unload(request):
        return web.json_response({"ok": await asyncio.to_thread(unload)})

    if server is not None:
        _REGISTERED = True
    return True
