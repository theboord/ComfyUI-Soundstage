"""Open in ComfyUI: the graph that made a take, read back out of the file (no GPU, no re-render).

ComfyUI's SaveVideo / SaveImage write the queued API prompt (`prompt`) and, when it was queued from a canvas, the UI
graph (`workflow`) into every MP4 / PNG they save. The App's own renders are queued as API prompts, so many takes
carry only `prompt`; the ComfyUI frontend opens that too (app.loadApiJson). Soundstage takes also carry the
`soundstage` recipe (takecheck/recipe.py), returned as a short summary.

    parse_ref("sub/x.mp4 [output]")   -> (folder type, subfolder, name)
    resolve(ref)                       -> an absolute path inside input/output/temp, or None
    read_tags(path)                    -> {prompt, workflow, soundstage} raw strings (MP4 via ffprobe, PNG text chunks)
    handoff(path)                      -> {name, workflow?, prompt?, recipe?, kind: "workflow"|"api"|None, nodes}
"""
from __future__ import annotations

import json
import os
import re

REF = re.compile(r"^(?P<path>.+?)(?:\s*\[(?P<type>input|output|temp)\])?$")
VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")
IMAGE_EXT = (".png", ".webp")


def parse_ref(ref: str) -> tuple[str, str, str] | None:
    m = REF.match(str(ref or "").strip())
    if not m or not m.group("path"):
        return None
    path = m.group("path").replace("\\", "/").strip("/")
    if ".." in path.split("/"):
        return None
    sub, _, name = path.rpartition("/")
    return (m.group("type") or "output"), sub, name


def resolve(ref: str, dirs: dict | None = None) -> str | None:
    """dirs: {"input": ..., "output": ..., "temp": ...} (folder_paths when None)."""
    p = parse_ref(ref)
    if not p:
        return None
    kind, sub, name = p
    if dirs is None:
        import folder_paths
        dirs = {"input": folder_paths.get_input_directory(), "output": folder_paths.get_output_directory(),
                "temp": folder_paths.get_temp_directory()}
    base = os.path.realpath(dirs.get(kind) or "")
    if not base:
        return None
    path = os.path.realpath(os.path.join(base, sub, name))
    if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
        return None
    return path


def _loads(v):
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v) if isinstance(v, str) and v.strip() else None
    except (TypeError, ValueError):
        return None


def read_tags(path: str) -> dict:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        from PIL import Image
        with Image.open(path) as im:
            info = dict(getattr(im, "text", {}) or im.info or {})
        return {k: info.get(k) for k in ("prompt", "workflow", "soundstage") if info.get(k)}
    from ..takecheck import video as V
    tags = V.probe(path).get("tags") or {}
    low = {str(k).lower(): v for k, v in tags.items()}
    return {k: low.get(k) for k in ("prompt", "workflow", "soundstage") if low.get(k)}


def is_api_prompt(p) -> bool:
    return isinstance(p, dict) and bool(p) and all(isinstance(n, dict) and "class_type" in n for n in p.values())


def is_ui_workflow(w) -> bool:
    return isinstance(w, dict) and isinstance(w.get("nodes"), list) and bool(w["nodes"])


def recipe_summary(rec) -> dict | None:
    rec = _loads(rec)
    if not isinstance(rec, dict):
        return None
    shot = rec.get("shot") if isinstance(rec.get("shot"), dict) else {}
    out = {k: rec.get(k) for k in ("rung", "step", "made", "seeds", "models", "quality") if rec.get(k) is not None}
    if shot.get("name") or shot.get("id"):
        out["shot"] = shot.get("name") or shot.get("id")
    return out


def from_tags(tags: dict, name: str = "take") -> dict:
    wf, pr = _loads(tags.get("workflow")), _loads(tags.get("prompt"))
    out = {"name": name, "kind": None, "nodes": 0}
    if is_ui_workflow(wf):
        out.update(workflow=wf, kind="workflow", nodes=len(wf["nodes"]))
    if is_api_prompt(pr):
        out["prompt"] = pr
        if out["kind"] is None:
            out.update(kind="api", nodes=len(pr))
    rec = recipe_summary(tags.get("soundstage"))
    if rec:
        out["recipe"] = rec
    if out["kind"] is None:
        out["why"] = "this file has no ComfyUI graph inside (it wasn't saved by ComfyUI, or its tags were stripped)"
    return out


def handoff(path: str) -> dict:
    name = os.path.splitext(os.path.basename(path))[0]
    return from_tags(read_tags(path), name)
