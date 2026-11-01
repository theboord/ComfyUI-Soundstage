"""The recipe travels in the MP4.

Every Soundstage render queued from the App gets a `soundstage` metadata tag (ComfyUI's SaveVideo writes every
extra_pnginfo key into the MP4): the stage scene, the active shot, the look, the step, the seeds and the quality
knobs. Dropping that MP4 back on the stage restores the set and the shot (web/takecheck/recipe.mjs).

Takes rendered before the tag existed still carry ComfyUI's own `prompt` and `workflow` tags; `from_tags` rebuilds
the same recipe from them (the 3D Stage node's input holds the scene).

    on_prompt(body)       ComfyUI on-prompt handler: adds extra_data.extra_pnginfo.soundstage (pure, tested)
    build(prompt)         the recipe of an API prompt
    from_tags(tags)       the recipe of an MP4's format tags (the soundstage tag, else rebuilt), or None
    read(path)            from_tags(ffprobe tags)
    embed(src, recipe)    write a recipe into an existing MP4 (stream copy), for takes made outside the App
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time

TAG = "soundstage"
VERSION = 1
STEP_NAMES = {1: "stage", 2: "frame", 3: "draft", 4: "final", 5: "layers"}


def _loads(v):
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v) if isinstance(v, str) and v.strip() else None
    except (ValueError, TypeError):
        return None


def _by_class(prompt: dict, cls: str) -> list[tuple[str, dict]]:
    return [(k, n.get("inputs") or {}) for k, n in (prompt or {}).items()
            if isinstance(n, dict) and n.get("class_type") == cls]


def _literal(v):
    """A prompt input that is a value, not a link ([node_id, slot])."""
    return None if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) else v


def build(prompt: dict) -> dict | None:
    """The recipe of a queued API prompt that holds a Soundstage 3D Stage node, else None."""
    stages = _by_class(prompt, "SoundstageStage")
    if not stages:
        return None
    raw = _loads(stages[0][1].get("stage"))
    scene = (raw or {}).get("scene") if isinstance(raw, dict) and "scene" in raw else raw
    if not isinstance(scene, dict):
        return None
    shot_id = scene.get("active_shot") or scene.get("shot_id")
    shot = next((s for s in scene.get("shots") or [] if s.get("id") == shot_id), None)
    rec = {"v": VERSION, "app": "Soundstage", "made": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "scene": scene, "shot": {"id": shot_id, "name": (shot or {}).get("name")}}
    step = next((_literal(i.get("step")) for _, i in _by_class(prompt, "SoundstageStep")), None)
    if isinstance(step, (int, float)):
        rec["step"] = int(step)
        rec["rung"] = STEP_NAMES.get(int(step), str(step))
    look = next((_loads(_literal(i.get("look"))) for _, i in _by_class(prompt, "SoundstageLook")), None)
    if isinstance(look, dict):
        rec["look"] = look
    q = next((i for _, i in _by_class(prompt, "SoundstageQuality")), None)
    if q:
        rec["quality"] = {k: _literal(q.get(k)) for k in ("motion_freedom", "quality") if _literal(q.get(k)) is not None}
    seeds = {}
    for cls, key in (("SoundstageAudioDrivenShot", "video"), ("SoundstageGenerateVideo", "video_router"),
                     ("SoundstageEditImage", "still"), ("KSampler", "still_krea")):
        for _, i in _by_class(prompt, cls):
            s = _literal(i.get("seed"))
            if isinstance(s, (int, float)):
                seeds.setdefault(key, int(s))
    for _, n in (prompt or {}).items():   # the LTX sampler inside the App's subgraph (RandomNoise / SamplerCustom)
        if isinstance(n, dict) and n.get("class_type") in ("RandomNoise", "SamplerCustomAdvanced", "SamplerCustom"):
            s = _literal((n.get("inputs") or {}).get("noise_seed"))
            if isinstance(s, (int, float)):
                seeds.setdefault("ltx", int(s))
    if seeds:
        rec["seeds"] = seeds
    models = {}
    for cls, key in (("SoundstageEditImage", "still"), ("SoundstageGenerateVideo", "video")):
        for _, i in _by_class(prompt, cls):
            m = _literal(i.get("model"))
            if isinstance(m, str) and m:
                models.setdefault(key, m)
    for _, i in _by_class(prompt, "SoundstageAudioDrivenShot"):
        for k in ("quality", "width", "height"):
            v = _literal(i.get(k))
            if v is not None:
                rec.setdefault("video", {})[k] = v
    if models:
        rec["models"] = models
    return rec


def on_prompt(body: dict) -> dict:
    """ComfyUI on-prompt handler: tag Soundstage renders with their recipe (SaveVideo writes it into the MP4).
    Never raises and never touches a prompt that is not a Soundstage one."""
    try:
        prompt = body.get("prompt")
        if not isinstance(prompt, dict):
            return body
        rec = build(prompt)
        if rec is None:
            return body
        extra = body.setdefault("extra_data", {})
        pnginfo = extra.setdefault("extra_pnginfo", {})
        if isinstance(pnginfo, dict) and TAG not in pnginfo:
            pnginfo[TAG] = rec
    except Exception:  # noqa: BLE001 - a recipe must never stop a render
        pass
    return body


def from_tags(tags: dict) -> dict | None:
    """The recipe in an MP4's format tags: the soundstage tag, else rebuilt from ComfyUI's prompt tag, else the
    3D Stage widget in the workflow tag. None for a video that isn't a Soundstage take."""
    tags = tags or {}
    rec = _loads(tags.get(TAG))
    if isinstance(rec, dict) and isinstance(rec.get("scene"), dict):
        rec.setdefault("source", "soundstage tag")
        return rec
    prompt = _loads(tags.get("prompt"))
    if isinstance(prompt, dict):
        rec = build(prompt)
        if rec:
            rec["source"] = "rebuilt from the prompt tag"
            rec.pop("made", None)
            return rec
    wf = _loads(tags.get("workflow"))
    if isinstance(wf, dict):
        for n in wf.get("nodes") or []:
            if n.get("type") == "SoundstageStage":
                scene = _loads((n.get("widgets_values") or [None])[0])
                scene = scene.get("scene") if isinstance(scene, dict) and "scene" in scene else scene
                if isinstance(scene, dict) and scene.get("camera"):
                    return {"v": VERSION, "app": "Soundstage", "scene": scene, "source": "rebuilt from the workflow tag",
                            "shot": {"id": scene.get("active_shot")}}
    return None


def read(path: str) -> dict | None:
    from .video import probe
    return from_tags(probe(path).get("tags") or {})


def embed(src: str, recipe: dict, dst: str | None = None) -> str:
    """Write `recipe` as the soundstage tag of an MP4 (stream copy; other tags kept). Returns the output path."""
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("ffmpeg is not installed")
    out = dst or src
    tmp = out + ".tmp.mp4"
    cmd = [ff, "-v", "error", "-y", "-i", src, "-map", "0", "-c", "copy", "-map_metadata", "0",
           "-metadata", f"{TAG}={json.dumps(recipe, separators=(',', ':'))}", "-movflags", "use_metadata_tags+faststart", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(r.stderr.strip()[:300])
    os.replace(tmp, out)
    return out
