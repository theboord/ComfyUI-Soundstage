"""“Ready to run / needs X” for each App step.

The server knows which node classes loaded and which model files are on disk, so it answers per step with what the
step's chosen models need (the model router's registry: soundstage/router/registry.json) plus the fixed parts of
the App graph (the LTX-2.5 Layout-to-Render IC-LoRA, SAM 3.1 + BiRefNet for the Layer Pack, ffmpeg for the cut and
the take checks). The browser adds the graph's own loader widgets (web/ui/modelguard.mjs) and missing node types.

    needs(chosen, loaded_classes, list_files, which) -> {step: {"status": "ready"|"partial"|"needs", "needs": [...]}}

Pure: the class set, the folder lister and `which` (shutil.which) are passed in, so tests run without ComfyUI.
"""
from __future__ import annotations

from ..router import registry as REG

MODELS_DOC = "MODELS.md"

# Parts of the App graph that are not router picks: (step, what, folder, any of these files, required for the step)
FIXED = [
    ("motion", "LTX-2.5 Layout-to-Render IC-LoRA", "loras",
     ["ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"], True),
    ("deliver", "SAM 3.1 (Layer Pack mattes)", "checkpoints", ["sam3.1_multiplex_fp16.safetensors"], False),
    ("deliver", "BiRefNet (Layer Pack edges)", "background_removal", ["birefnet.safetensors"], False),
    ("frame", "Krea 2 depth-control LoRA (only for the Krea 2 + depth path)", "loras", ["depth-control-lora.safetensors"], False),
]
VIDEO_L2R = "LTX-2.5 22B distilled · local [<$10M]"   # the ⑤ Motion default (Layout-to-Render runs on its weights)
STILL_DEFAULT = "FLUX 3 Klein · local [<$5M]"
STEPS = ["script", "cast", "set", "frame", "motion", "review", "deliver"]


def _model_needs(label: str, loaded: set, list_files) -> list[dict]:
    m = REG.find_model(label) if label else None
    if m is None:
        return [{"what": f"the model “{label}”", "detail": "not in this install's model list", "required": True}] if label else []
    out = []
    for c in m.get("classes") or []:
        if c not in loaded:
            out.append({"what": f"node {c}", "detail": f"needed by {m['name']} (update ComfyUI or install its node pack)", "required": True})
    for spec in m.get("weights") or []:
        if not REG.resolve_weight(spec, list_files):
            out.append({"what": spec["any"][0], "folder": spec["folder"], "detail": f"{m['name']} · {spec['role']}", "required": True})
    return out


def _fixed(step: str, list_files) -> list[dict]:
    out = []
    for st, what, folder, files, required in FIXED:
        if st != step:
            continue
        if not REG.resolve_weight({"folder": folder, "any": files}, list_files):
            out.append({"what": files[0], "folder": folder, "detail": what, "required": required})
    return out


def needs(chosen: dict, loaded: set, list_files, which=None) -> dict:
    """Per step: status and the list of what is missing. chosen = {still, video, l2r (bool), krea (bool)}."""
    chosen = chosen or {}
    still = chosen.get("still") or STILL_DEFAULT
    video = chosen.get("video") or VIDEO_L2R
    l2r = chosen.get("l2r", True)
    res = {s: [] for s in STEPS}
    if chosen.get("krea"):
        res["frame"] += _model_needs("Krea 2 Turbo · local [<$1M]", loaded, list_files) or []
        res["frame"] += [dict(n, required=True) for n in _fixed("frame", list_files)]
    else:
        res["frame"] += _model_needs(still, loaded, list_files)
    res["cast"] = [dict(n, required=False, detail=f"reference pictures · {n.get('detail', '')}") for n in res["frame"]]
    res["motion"] += _model_needs(VIDEO_L2R if l2r else video, loaded, list_files)
    if l2r:
        res["motion"] += _fixed("motion", list_files)
    res["deliver"] += _fixed("deliver", list_files)
    if which is not None:
        if not which("ffmpeg"):
            for st in ("review", "deliver"):
                res[st].append({"what": "ffmpeg", "detail": "the take checks, the cut and the NLE exports", "required": True})
        try:
            import cv2  # noqa: F401
        except Exception:  # noqa: BLE001
            res["review"].append({"what": "opencv-python", "detail": "face and car checks on takes (the rest still runs)", "required": False})
    out = {}
    for st, items in res.items():
        # one line per file
        seen, uniq = set(), []
        for it in items:
            k = it["what"]
            if k not in seen:
                seen.add(k)
                uniq.append(it)
        status = "needs" if any(i.get("required") for i in uniq) else "partial" if uniq else "ready"
        out[st] = {"status": status, "needs": uniq}
    return out
