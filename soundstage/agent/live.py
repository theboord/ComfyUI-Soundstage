"""Run the agent against a live ComfyUI (the same tiny TextGenerate graph the browser queues).

    python -m soundstage.agent.live build "two gunfighters face off at noon on a dusty western street"
    python -m soundstage.agent.live edit scene.json "move the car closer to the streetlamp"
    python -m soundstage.agent.live warm            # load the model once

URL defaults to http://127.0.0.1:8189 (SOUNDSTAGE_COMFY_URL overrides). Standard library only.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

from . import core
from . import prompts as PR

URL = os.environ.get("SOUNDSTAGE_COMFY_URL", "http://127.0.0.1:8189")


def graph(system: str, prompt: str, max_length: int, model: str = PR.MODEL) -> dict:
    """Identical to designObject() in web/soundstage.js, so the same model cache serves both."""
    return {
        "sa1": {"class_type": "CLIPLoader", "inputs": {"clip_name": model, "type": "stable_diffusion", "device": "default"}},
        "sa2": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": system}},
        "sa3": {"class_type": "TextGenerate", "inputs": {"clip": ["sa1", 0], "prompt": prompt, "max_length": max_length,
                                                          "sampling_mode": "off", "thinking": False,
                                                          "use_default_template": True, "system_prompt": ["sa2", 0]}},
        "sa4": {"class_type": "PreviewAny", "inputs": {"source": ["sa3", 0]}},
    }


def _get(url: str, tries: int = 6):
    """GET JSON, riding out a few seconds of connection resets (the tunnel or server blinking)."""
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=30))
        except (ConnectionError, urllib.error.URLError, json.JSONDecodeError):
            if i == tries - 1:
                raise
            time.sleep(2)


def run_llm(system: str, prompt: str, max_length: int, url: str = URL, timeout: float = 600) -> tuple[str, float]:
    t0 = time.time()
    body = json.dumps({"prompt": graph(system, prompt, max_length), "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(url + "/prompt", data=body, headers={"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req, timeout=30))["prompt_id"]
    last_seen = time.time()
    while time.time() - t0 < timeout:
        h = _get(f"{url}/history/{pid}")
        if pid in h and h[pid].get("status", {}).get("completed") is not None:
            out = h[pid]["outputs"].get("sa4", {})
            text = out.get("text", [""])
            return (text[0] if isinstance(text, list) and text else str(text)), time.time() - t0
        if time.time() - last_seen > 5:
            q = _get(f"{url}/queue")
            queued = any(item[1] == pid for item in q.get("queue_running", []) + q.get("queue_pending", []))
            if not queued and pid not in _get(f"{url}/history/{pid}"):
                raise RuntimeError("the job left the queue without an answer (server restarted or job cancelled)")
            last_seen = time.time()
        time.sleep(0.2)
    raise TimeoutError(f"no answer after {timeout}s")


def live_describe(text: str, genre: str = "", url: str = URL) -> dict:
    t0 = time.time()
    llm, dt = run_llm(PR.BUILD_SYSTEM, PR.build_user(text, genre), PR.MAX_LENGTH["build"], url)
    res = core.describe(text, genre, llm)
    res["timing"] = {"llm_s": round(dt, 2), "total_s": round(time.time() - t0, 2)}
    res["llm_text"] = llm
    return res


def live_edit(scene: dict, command: str, url: str = URL) -> dict:
    t0 = time.time()
    llm, dt = run_llm(PR.EDIT_SYSTEM, PR.edit_user(command, scene), PR.MAX_LENGTH["edit"], url)
    res = core.edit(scene, command, llm)
    res["timing"] = {"llm_s": round(dt, 2), "total_s": round(time.time() - t0, 2)}
    res["llm_text"] = llm
    return res


def _main(argv):
    if not argv or argv[0] == "warm":
        print(run_llm("Answer OK.", "Say OK.", 8)[1])
        return
    if argv[0] == "build":
        r = live_describe(" ".join(argv[1:]))
        print(json.dumps({k: r[k] for k in ("timing", "backend", "plan", "notes", "designs", "llm_text")}, indent=1))
        out = os.environ.get("SOUNDSTAGE_AGENT_OUT")
        if out:
            with open(out, "w") as f:
                json.dump(r["scene"], f, indent=1)
    elif argv[0] == "edit":
        with open(argv[1]) as f:
            scene = json.load(f)
        r = live_edit(scene, " ".join(argv[2:]))
        print(json.dumps({k: r[k] for k in ("timing", "backend", "summary", "symbolic", "notes", "llm_text")}, indent=1))


if __name__ == "__main__":
    _main(sys.argv[1:])
