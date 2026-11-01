"""“$0 · about N min on your GPU”: render-time estimates from measured runs.

Every finished Soundstage render in ComfyUI's history is a measurement: the step it ran (2 frame, 3 draft,
4 final), its quality tier, the shot length, and how long execution took (execution_start to execution_success).
They are kept in user/soundstage/timings.json (so they survive restarts) and the estimate is the median seconds
per frame of the latest runs times this shot's frames. Until a rung has been measured, the defaults are the
times measured on the 48 GB card (RTX 6000 Ada) on 2026-10-31: a 121-frame draft ~95 s, a final ~6 min.

Pure Python: `harvest(history)`, `estimate(samples, rung, frames)` are tested without ComfyUI.
"""
from __future__ import annotations

import json
import os
import statistics
import threading
import time

DEFAULTS = {  # rung -> (seconds, for this many frames); "frame" is per still image
    "frame": (20.0, 1),
    "draft": (95.0, 121),
    "final": (360.0, 121),
    "final_hq": (720.0, 121),
    "layers": (60.0, 121),
}
MIN_SECONDS = {"frame": 3.0, "draft": 20.0, "final": 45.0, "final_hq": 45.0, "layers": 10.0}   # shorter = served from cache
KEEP = 40
_LOCK = threading.Lock()


def rung_of(prompt: dict) -> tuple[str | None, int | None]:
    """(rung key, shot frames) of a queued API prompt, or (None, None) for anything that is not a Soundstage render."""
    step = quality = frames = None
    for n in (prompt or {}).values():
        if not isinstance(n, dict):
            continue
        ct, inp = n.get("class_type"), n.get("inputs") or {}
        if ct == "SoundstageStep" and isinstance(inp.get("step"), (int, float)):
            step = int(inp["step"])
        elif ct == "SoundstageQuality" and isinstance(inp.get("quality"), str):
            quality = inp["quality"]
        elif ct == "SoundstageStage":
            try:
                d = json.loads(inp.get("stage") or "{}")
                frames = int(((d.get("scene") or d).get("shot") or {}).get("frames") or 0) or None
            except (ValueError, TypeError, AttributeError):
                pass
    if step is None:
        return None, frames
    key = {2: "frame", 3: "draft", 5: "layers"}.get(step)
    if step == 4:
        key = "final_hq" if (quality or "").lower() in ("final hq", "hq") else "final"
    return key, frames


def harvest(history: dict, known: set | None = None) -> list[dict]:
    """New measurements from a ComfyUI /history dict: [{id, rung, seconds, frames, t}]."""
    out = []
    known = known or set()
    for pid, item in (history or {}).items():
        if pid in known or not isinstance(item, dict):
            continue
        try:
            prompt = item["prompt"][2]
        except (KeyError, IndexError, TypeError):
            continue
        rung, frames = rung_of(prompt)
        if not rung:
            continue
        msgs = {m[0]: m[1] for m in ((item.get("status") or {}).get("messages") or []) if isinstance(m, (list, tuple)) and len(m) == 2}
        a, b = msgs.get("execution_start"), msgs.get("execution_success")
        if not a or not b:
            continue
        sec = (float(b.get("timestamp", 0)) - float(a.get("timestamp", 0))) / 1000.0
        if sec < MIN_SECONDS.get(rung, 3.0):
            continue
        out.append({"id": pid, "rung": rung, "seconds": round(sec, 1), "frames": frames or DEFAULTS[rung][1],
                    "t": round(float(b.get("timestamp", 0)) / 1000.0)})
    return out


def estimate(samples: list[dict], rung: str, frames: int | None = None, count: int = 1) -> dict:
    """{seconds, measured (how many runs it rests on), basis}. A frame estimate is per image times count."""
    base_s, base_f = DEFAULTS.get(rung, DEFAULTS["draft"])
    mine = [s for s in samples or [] if s.get("rung") == rung][-KEEP:]
    if rung == "frame":
        per = statistics.median([s["seconds"] for s in mine]) if mine else base_s
        return {"seconds": round(per * max(1, count)), "measured": len(mine), "basis": "measured" if mine else "default"}
    frames = frames or base_f
    if mine:
        per = statistics.median([s["seconds"] / max(1, s.get("frames") or base_f) for s in mine])
        return {"seconds": round(per * frames), "measured": len(mine), "basis": "measured"}
    return {"seconds": round(base_s * frames / base_f), "measured": 0, "basis": "default"}


def label(seconds: float) -> str:
    """'$0 · about 2 min on your GPU' (local models cost no credits; the time is the honest price)."""
    if seconds < 60:
        t = f"about {max(5, int(round(seconds / 5.0)) * 5)} s"
    else:
        t = f"about {max(1, int(round(seconds / 60.0)))} min"
    return f"$0 · {t} on your GPU"


# ------------------------------------------------------------------------------------------- the store

def _path(base: str | None = None) -> str:
    if base is None:
        import folder_paths
        base = folder_paths.get_user_directory()
    d = os.path.join(base, "soundstage")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "timings.json")


def load(base: str | None = None) -> list[dict]:
    try:
        with open(_path(base)) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def update(history: dict, base: str | None = None) -> list[dict]:
    """Add the history's new measurements to the store; returns all samples (the latest KEEP per rung)."""
    with _LOCK:
        samples = load(base)
        known = {s.get("id") for s in samples}
        new = harvest(history, known)
        if new:
            samples += new
            keep = []
            for r in {s["rung"] for s in samples}:
                keep += sorted([s for s in samples if s["rung"] == r], key=lambda s: s.get("t", 0))[-KEEP:]
            samples = sorted(keep, key=lambda s: s.get("t", 0))
            tmp = _path(base) + ".tmp"
            with open(tmp, "w") as f:
                json.dump(samples, f)
            os.replace(tmp, _path(base))
        return samples


def summary(samples: list[dict]) -> dict:
    """Per rung: the default and measured seconds for its default length, for the App's Run labels."""
    out = {}
    for rung, (s, f) in DEFAULTS.items():
        e = estimate(samples, rung, f)
        per_frame = e["seconds"] / max(1, f) if rung != "frame" else None
        out[rung] = {"seconds": e["seconds"], "frames": f, "per_frame": round(per_frame, 3) if per_frame else None,
                     "measured": e["measured"], "basis": e["basis"]}
    out["updated"] = int(time.time())
    return out
