"""Ask the pod's own vision LLM to read a plan image, THROUGH THE COMFYUI QUEUE (never on the GPU directly).

Graph: CLIPLoader(qwen3.5_4b) -> LoadImage -> TextGenerate(image) -> PreviewAny, posted to this server's
/prompt and collected from /history. The model reads names and dimension labels very reliably; its boxes are
on a 0-1000 grid and only roughly placed, so spec.from_pixels uses them to identify rooms, not to measure them.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid

MODELS = ["qwen3.5_4b_bf16.safetensors"]   # natively multimodal; the scene agent already uses it
SYSTEM = ("You read architectural floor plans. Reply with JSON only, no prose: "
          '{"rooms":[{"name":"room name as written","label":"the dimension text written in the room, verbatim, or empty",'
          '"bbox_px":[x0,y0,x1,y1]}]}. bbox_px is the room rectangle on a 0-1000 grid over the whole image. '
          "List every enclosed room, including halls, closets and bathrooms.")
PROMPT = "Read this floor plan. List every room with its name, its dimension label and its box."


def available_model() -> str | None:
    try:
        import folder_paths
        names = set(folder_paths.get_filename_list("text_encoders") or [])
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return None
    return next((m for m in MODELS if m in names), None)


def graph(model: str, image_name: str) -> dict:
    return {
        "fp1": {"class_type": "CLIPLoader", "inputs": {"clip_name": model, "type": "stable_diffusion", "device": "default"}},
        "fp2": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "fp3": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": SYSTEM}},
        "fp4": {"class_type": "TextGenerate", "inputs": {
            "clip": ["fp1", 0], "image": ["fp2", 0], "prompt": PROMPT, "max_length": 1500, "sampling_mode": "off",
            "thinking": False, "use_default_template": True, "system_prompt": ["fp3", 0]}},
        "fp5": {"class_type": "PreviewAny", "inputs": {"source": ["fp4", 0]}},
    }


def parse_reply(text: str) -> dict:
    t = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    t = re.sub(r"^```(?:json)?|```\s*$", "", t.strip(), flags=re.M)
    starts = sorted(i for i in (t.find("{"), t.find("[")) if i >= 0)
    if not starts:
        raise ValueError("the model did not return JSON")
    obj, err = None, None
    for i in starts:   # it sometimes opens a list it never closes; the {"rooms": …} object inside is still whole
        try:
            obj, _ = json.JSONDecoder().raw_decode(t[i:])
            break
        except ValueError as exc:
            err = exc
    if obj is None:
        raise err
    items = obj if isinstance(obj, list) else obj.get("rooms", [])   # it sometimes answers with the bare list
    if any(isinstance(x, dict) and isinstance(x.get("rooms"), list) for x in items):
        items = [r for x in items if isinstance(x, dict) for r in (x.get("rooms") or [])]   # [{"rooms": [...]}]
    rooms = [r for r in items if isinstance(r, dict) and r.get("name")]
    for r in rooms:
        # the model sometimes repeats the name inside the label ("Bath\n2.0 x 2.4")
        r["label"] = str(r.get("label") or "")
    return {"rooms": rooms}


async def read_with_vlm(base_url: str, image_name: str, model: str, timeout_s: float = 300.0) -> tuple[dict, dict]:
    """Queue the read and wait for it. Returns (parsed, timings) or raises."""
    import aiohttp

    t0 = time.perf_counter()
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{base_url}/prompt", json={"prompt": graph(model, image_name),
                                                      "client_id": f"soundstage-plan-{uuid.uuid4().hex[:8]}"}) as r:
            body = await r.json()
        pid = body.get("prompt_id")
        if not pid:
            raise RuntimeError(f"the queue refused the plan-reading job: {body.get('error') or body}")
        while True:
            await asyncio.sleep(1.0)
            async with s.get(f"{base_url}/history/{pid}") as r:
                h = await r.json()
            if pid in h:
                break
            if time.perf_counter() - t0 > timeout_s:
                raise TimeoutError(f"plan reading still queued after {timeout_s:.0f} s (job {pid} left in the queue)")
    entry = h[pid]
    status = entry.get("status", {})
    if status.get("status_str") != "success":
        msg = next((m[1].get("exception_message") for m in status.get("messages", []) if m[0] == "execution_error"), "")
        raise RuntimeError(f"plan reading failed in the queue: {msg or status.get('status_str')}")
    ts = {m[0]: m[1].get("timestamp") for m in status.get("messages", []) if isinstance(m[1], dict)}
    text = (entry.get("outputs", {}).get("fp5", {}).get("text") or [""])[0]
    timings = {"vlm_total_ms": round((time.perf_counter() - t0) * 1000)}
    if ts.get("execution_start") and ts.get("execution_success"):
        timings["vlm_exec_ms"] = ts["execution_success"] - ts["execution_start"]
        timings["queue_wait_ms"] = max(0, timings["vlm_total_ms"] - timings["vlm_exec_ms"])
    return parse_reply(text), timings
