"""Run graphs through this server's own ComfyUI queue (POST /prompt, poll /history). Never touches a GPU itself."""
from __future__ import annotations

import asyncio
import time
import uuid


async def run_graph(base_url: str, graph: dict, what: str, timeout_s: float = 900.0, on_wait=None) -> tuple[dict, dict]:
    """Queue a prompt and wait for it. Returns (outputs by node id, timings) or raises with the queue's error."""
    import aiohttp

    t0 = time.perf_counter()
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{base_url}/prompt", json={"prompt": graph,
                                                      "client_id": f"soundstage-v2s-{uuid.uuid4().hex[:8]}"}) as r:
            body = await r.json()
        pid = body.get("prompt_id")
        if not pid:
            err = body.get("error") or body
            nerr = body.get("node_errors")
            raise RuntimeError(f"the queue refused the {what} job: {err}{f' {nerr}' if nerr else ''}")
        while True:
            await asyncio.sleep(1.0)
            async with s.get(f"{base_url}/history/{pid}") as r:
                h = await r.json()
            if pid in h:
                break
            if on_wait:
                on_wait(time.perf_counter() - t0)
            if time.perf_counter() - t0 > timeout_s:
                raise TimeoutError(f"{what} still queued after {timeout_s:.0f} s (job {pid} left in the queue)")
    entry = h[pid]
    status = entry.get("status", {})
    if status.get("status_str") != "success":
        msg = next((m[1].get("exception_message") for m in status.get("messages", []) if m[0] == "execution_error"), "")
        raise RuntimeError(f"{what} failed in the queue: {msg or status.get('status_str')}")
    ts = {m[0]: m[1].get("timestamp") for m in status.get("messages", []) if isinstance(m[1], dict)}
    timings = {"total_ms": round((time.perf_counter() - t0) * 1000)}
    if ts.get("execution_start") and ts.get("execution_success"):
        timings["exec_ms"] = ts["execution_success"] - ts["execution_start"]
    return entry.get("outputs", {}), timings


def text_of(outputs: dict, node: str) -> str:
    return ((outputs.get(node) or {}).get("text") or [""])[0]
