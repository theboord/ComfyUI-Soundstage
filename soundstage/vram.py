"""VRAM tiers: Auto · 48 · 24 · 16 · 12 GB. One switch that makes the render graphs fit smaller cards.

Pure Python (no ComfyUI or torch imports), so tests/test_vram_tiers.py checks every rule without a GPU.

What a tier changes (the same rules for every graph: the App's own prompt on POST /prompt, through
`on_prompt`, and every expansion the router, Motion and Footage nodes build, through `apply`):
  weights        each loader that names a known model is pointed at the tier's smaller build of the same model,
                 but only when that file is installed (nothing is ever downloaded; `missing_smaller` lists what
                 would help, with the exact filename and repo)
  text encoder   CLIPLoader device "cpu" on 24 GB and below (MiniMax H3's 32B encoder already runs there)
  tiled decode   VAEDecodeTiled tiles shrink per tier (spatial and temporal)
  stage 1        `cap_settings` caps the LTX stage-1 short side (and so the x2 refine) per tier
  refine         48/24: the x2 refine as before; 16: kept, with the smaller tiled decode; 12: off (one pass)
  free           24 GB and below: the App asks ComfyUI to unload models after each finished prompt (POST /free)

Tested on hardware: only the 48 GB tier (RTX 6000 Ada). 24, 16 and 12 GB are untested estimates. The 16 GB
numbers follow Arfolomew/backlot (MIT), which renders LTX-2.5 with the w4a8 build at 1280x704 on a 16 GB
RTX 4070 Ti Super; the "unload after each job" idea follows harlixay7/Kinoloom tool/gpu_broker.py (MIT), which
evicts through ComfyUI's /free between jobs on an 8 GB card. No code was copied from either.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

TIERS = ("Auto", "48", "24", "16", "12")
ENV = "SOUNDSTAGE_VRAM_TIER"
SETTINGS_NAME = "soundstage_vram.json"

# Per tier (web/ui/vram_tiers.json, shared with the App). stage1_short: the most a stage-1 (half-size) LTX latent
# may have on its shorter side, px. one_pass_short: the single pass's shorter side when the refine is off.
# decode: VAEDecodeTiled caps. prefer: which weight builds (PREFER). flags: suggested ComfyUI launch flags.
TIERS_FILE = Path(__file__).resolve().parents[1] / "web" / "ui" / "vram_tiers.json"
_DATA = json.loads(TIERS_FILE.read_text(encoding="utf-8"))
RULES = _DATA["tiers"]
TESTED = tuple(_DATA["tested"])   # the tiers that have run on hardware

# Known builds of each model, biggest to smallest, with sizes where a source states them. Every filename here is
# one this repo, backlot or Kinoloom already loads; none is downloaded by Soundstage.
# GGUF: no .gguf build of LTX-2.5, its Gemma encoder or FLUX 3 Klein is listed. Soundstage's graphs use the core
# UNETLoader / CLIPLoader, which can't read .gguf (that needs the ComfyUI-GGUF node pack), and no GGUF filename for
# these models has been checked.
FAMILIES = {
    "ltx25_unet": {
        "folder": "diffusion_models", "label": "LTX-2.5 22B distilled (Motion, Ripple, Recast)",
        "builds": [
            {"file": "ltx-2.5-22b-distilled-transformer-bf16.safetensors", "kind": "bf16", "gb": 42.0,
             "repo": "Lightricks/LTX-2.5"},
            {"file": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "kind": "int8", "gb": 21.5,
             "repo": "Lightricks/LTX-2.5"},
            {"file": "ltx-2.5-22b-distilled-transformer-w4a8_convrot.safetensors", "kind": "w4a8", "gb": 12.5,
             "repo": "Winnougan/ltx-2.5-w4a8-convrot-int4-convrot-Winnougan-Blessing (community repack; "
                     "LTX-2 Community License)"},
        ]},
    "ltx25_te": {
        "folder": "text_encoders", "label": "Gemma 4 12B encoder for LTX-2.5",
        "builds": [
            {"file": "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", "kind": "bf16", "gb": None,
             "repo": "Lightricks/LTX-2.5"},
            {"file": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "kind": "int8", "gb": None,
             "repo": "Lightricks/LTX-2.5"},
            {"file": "gemma4-12b-with-proj-ltx-2.5-w4a8_convrot.safetensors", "kind": "w4a8", "gb": None,
             "repo": "Winnougan/ltx-2.5-w4a8-convrot-int4-convrot-Winnougan-Blessing (community repack)"},
        ]},
    "krea2_unet": {
        "folder": "diffusion_models", "label": "Krea 2 Turbo (Look still, Fill)",
        "builds": [
            {"file": "Krea-2-Turbo.safetensors", "kind": "bf16", "gb": None, "repo": "krea/Krea-2-Turbo"},
            {"file": "krea2_turbo_int8_convrot.safetensors", "kind": "int8", "gb": None, "repo": "Comfy-Org/Krea-2"},
            {"file": "krea2_turbo_fp8_scaled.safetensors", "kind": "fp8", "gb": 13.1, "repo": "Comfy-Org/Krea-2"},
        ]},
    "z_image_unet": {
        "folder": "diffusion_models", "label": "Z-Image Turbo",
        "builds": [
            {"file": "z_image_turbo_bf16.safetensors", "kind": "bf16", "gb": None, "repo": "Comfy-Org/z_image_turbo"},
            {"file": "z_image_turbo_int8_convrot.safetensors", "kind": "int8", "gb": None,
             "repo": "Comfy-Org/z_image_turbo"},
        ]},
    "qwen3vl_4b_te": {
        "folder": "text_encoders", "label": "Qwen3-VL 4B encoder (FLUX 3 Klein, Krea 2)",
        "builds": [
            {"file": "qwen3vl_4b_fp8_scaled.safetensors", "kind": "fp8", "gb": 5.2, "repo": "Comfy-Org/Krea-2"},
            {"file": "qwen3vl_4b_int8_convrot.safetensors", "kind": "int8", "gb": None, "repo": "Comfy-Org (FLUX 3 Klein)"},
        ]},
    "h3_unet": {
        "folder": "diffusion_models", "label": "MiniMax H3 fl2va",
        "builds": [
            {"file": "minimax_h3_fl2va_bf16.safetensors", "kind": "bf16", "gb": None, "repo": "Comfy-Org/MiniMax-H3"},
            {"file": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "kind": "int8", "gb": None,
             "repo": "int8 repack of MiniMaxAI/MiniMax-H3"},
        ]},
    "umt5_te": {
        "folder": "text_encoders", "label": "UMT5-XXL encoder (Wan Animate 2)",
        "builds": [
            {"file": "umt5_xxl_fp16.safetensors", "kind": "fp16", "gb": None, "repo": "Comfy-Org/Wan_2.1_ComfyUI_repackaged"},
            {"file": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "kind": "fp8", "gb": None,
             "repo": "Comfy-Org/Wan_2.1_ComfyUI_repackaged"},
        ]},
}
# Which build kinds a tier prefers, best first. "quality" keeps what the graph names (48 GB: as tested).
PREFER = {"quality": None, "int8": ["int8", "fp8"], "small": ["w4a8", "fp8", "int8"]}
SIZE = {"bf16": 3, "fp16": 3, "int8": 2, "fp8": 2, "w4a8": 1}   # a swap only ever goes to a smaller class
LOADERS = {"UNETLoader": ("unet_name", "diffusion_models"), "CLIPLoader": ("clip_name", "text_encoders")}


# ---------------------------------------------------------------- the tier

def detect(total_gb: float | None) -> str:
    """The tier for a card with total_gb of VRAM (Auto). None (no CUDA GPU seen) -> the smallest tier."""
    if total_gb is None:
        return "12"
    if total_gb >= 40:
        return "48"
    if total_gb >= 20:
        return "24"
    if total_gb >= 14:
        return "16"
    return "12"


def normalize(tier) -> str:
    t = str(tier or "Auto").strip().replace("GB", "").replace("gb", "").strip()
    return t if t in TIERS else "Auto"


def effective(tier, total_gb: float | None) -> str:
    t = normalize(tier)
    return detect(total_gb) if t == "Auto" else t


def rules(tier, total_gb: float | None = None) -> dict:
    t = effective(tier, total_gb)
    return {"tier": t, "tested": t in TESTED, **RULES[t]}


def _settings_path() -> Path:
    try:
        import folder_paths  # ComfyUI: the user directory survives updates of the node pack
        return Path(folder_paths.get_user_directory()) / SETTINGS_NAME
    except Exception:  # noqa: BLE001 - tests and the headless runner
        return Path(__file__).resolve().parents[1] / SETTINGS_NAME


def saved_tier(path: Path | None = None) -> str:
    """The App's setting: env SOUNDSTAGE_VRAM_TIER wins, then the saved file, else Auto."""
    if os.environ.get(ENV):
        return normalize(os.environ[ENV])
    try:
        return normalize(json.loads((path or _settings_path()).read_text()).get("tier"))
    except Exception:  # noqa: BLE001 - no file yet
        return "Auto"


def save_tier(tier, path: Path | None = None) -> str:
    t = normalize(tier)
    p = path or _settings_path()
    p.write_text(json.dumps({"tier": t}))
    return t


def gpu_total_gb() -> float | None:
    """Total VRAM of the first CUDA device, or None (no torch / no CUDA)."""
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        return round(torch.cuda.get_device_properties(0).total_memory / 1024 ** 3, 1)
    except Exception:  # noqa: BLE001
        return None


def current(total_gb: float | None = None) -> dict:
    """The rules in force on this server right now."""
    return rules(saved_tier(), total_gb if total_gb is not None else gpu_total_gb())


# ---------------------------------------------------------------- weights

def family_of(filename: str):
    base = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    for key, fam in FAMILIES.items():
        for b in fam["builds"]:
            if b["file"] == base:
                return key, b
    return None, None


def _installed(name: str, files) -> str | None:
    for f in files or []:
        norm = f.replace("\\", "/")
        if norm == name or norm.endswith("/" + name):
            return f
    return None


def pick(filename: str, prefer: str, files) -> str:
    """The tier's build of the model `filename` names, if one is installed (files = that folder's list);
    otherwise `filename` unchanged. A bigger build is never swapped in."""
    order = PREFER.get(prefer)
    key, cur = family_of(filename)
    if not order or key is None:
        return filename
    cands = [b for b in FAMILIES[key]["builds"] if b["kind"] in order and SIZE[b["kind"]] < SIZE[cur["kind"]]]
    for b in sorted(cands, key=lambda b: order.index(b["kind"])):
        hit = _installed(b["file"], files)
        if hit:
            return hit
    return filename


def missing_smaller(tier, list_files, total_gb: float | None = None) -> list[dict]:
    """For each model family with any build installed: the tier's preferred build when it is not installed.
    [{family, file, folder, repo, gb}] - to show, never to download."""
    r = rules(tier, total_gb)
    order = PREFER.get(r["prefer"])
    if not order:
        return []
    out = []
    for key, fam in FAMILIES.items():
        try:
            files = list_files(fam["folder"]) or []
        except Exception:  # noqa: BLE001
            files = []
        have = [b for b in fam["builds"] if _installed(b["file"], files)]
        if not have:
            continue
        best = min(fam["builds"], key=lambda b: order.index(b["kind"]) if b["kind"] in order else 99)
        if not any(SIZE[b["kind"]] <= SIZE[best["kind"]] for b in have):
            out.append({"family": fam["label"], "file": best["file"], "folder": fam["folder"],
                        "repo": best["repo"], "gb": best["gb"]})
    return out


# ---------------------------------------------------------------- graphs

def _is_link(v) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[1], int)


def apply(prompt: dict, r: dict, list_files=None) -> list[str]:
    """Rewrite an API-format graph ({id: {"class_type", "inputs"}}) in place for the tier rules `r`.
    Linked inputs are left alone. Returns what was changed, in words."""
    changed = []
    if not isinstance(prompt, dict) or not r or r.get("tier") == "48":
        return changed
    cache = {}

    def files(folder):
        if list_files is None:
            return []
        if folder not in cache:
            try:
                cache[folder] = list_files(folder) or []
            except Exception:  # noqa: BLE001
                cache[folder] = []
        return cache[folder]

    for nid, n in prompt.items():
        if not isinstance(n, dict):
            continue
        ct, inp = n.get("class_type"), n.get("inputs")
        if not isinstance(inp, dict):
            continue
        if ct in LOADERS:
            key, folder = LOADERS[ct]
            name = inp.get(key)
            if isinstance(name, str):
                new = pick(name, r["prefer"], files(folder))
                if new != name:
                    inp[key] = new
                    changed.append(f"{nid}: {name} -> {new}")
        if ct == "CLIPLoader" and r["te_device"] == "cpu" and not _is_link(inp.get("device")):
            if inp.get("device") != "cpu":
                inp["device"] = "cpu"
                changed.append(f"{nid}: text encoder on the CPU")
        if ct == "VAEDecodeTiled" and r.get("decode"):
            for k, cap in r["decode"].items():
                v = inp.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v > cap:
                    inp[k] = cap
                    changed.append(f"{nid}: {k} {v} -> {cap}")
            # temporal_overlap must stay below temporal_size; overlap below tile_size
            for a, b in (("temporal_overlap", "temporal_size"), ("overlap", "tile_size")):
                if isinstance(inp.get(a), int) and isinstance(inp.get(b), int) and inp[a] >= inp[b]:
                    inp[a] = max(4 if a == "temporal_overlap" else 0, inp[b] // 4)
    return changed


def cap_settings(s: dict, r: dict) -> dict:
    """LTX settings (ltx_settings.resolve) capped for the tier: the stage-1 short side, the refine, the decode.
    Adds "vram_note" when anything was lowered. Returns a new dict."""
    out = dict(s)
    if not r or r.get("tier") == "48":
        return out
    notes = []
    res = int(out.get("resolution", 1088))
    if r["refine"] == "off" and out.get("two_stage", True):
        out["two_stage"] = False
        one = r.get("one_pass_short") or 512
        if res > one:
            out["resolution"] = one
        notes.append(f"x2 refine off on {r['tier']} GB: one pass at {min(res, one)}p")
    elif out.get("two_stage", True) and r.get("stage1_short") and res > 2 * r["stage1_short"]:
        out["resolution"] = 2 * r["stage1_short"]
        notes.append(f"{res}p capped to {out['resolution']}p on {r['tier']} GB")
    elif not out.get("two_stage", True) and r.get("stage1_short"):
        one = r.get("one_pass_short") or 2 * r["stage1_short"]
        if res > one:
            out["resolution"] = one
            notes.append(f"one pass {res}p capped to {one}p on {r['tier']} GB")
    if r.get("decode"):
        dec = {**{"tile_size": 512, "overlap": 64, "temporal_size": 128, "temporal_overlap": 32}, **(out.get("decode") or {})}
        out["decode"] = {k: min(v, r["decode"].get(k, v)) for k, v in dec.items()}
        if out["decode"]["temporal_overlap"] >= out["decode"]["temporal_size"]:
            out["decode"]["temporal_overlap"] = max(4, out["decode"]["temporal_size"] // 4)
    if r["refine"] == "tiled" and out.get("preset") == "Hollywood":
        notes.append("Hollywood's refine runs with small decode tiles")
    if notes:
        out["vram_note"] = "; ".join(notes) + " (VRAM tier, untested on this card size)."
    out["vram_tier"] = r["tier"]
    return out


def cap_short(width: int, height: int, short_max: int | None, multiple: int = 32) -> tuple[int, int]:
    """Scale (width, height) down so the shorter side is at most short_max, keeping the aspect, multiples kept."""
    if not short_max or min(width, height) <= short_max:
        return int(width), int(height)
    k = short_max / float(min(width, height))
    snap = lambda v: max(multiple, int(v * k) // multiple * multiple)  # noqa: E731
    return snap(width), snap(height)


def one_pass_cap(r: dict | None) -> int | None:
    """The shorter-side cap for a single-pass LTX render (Ripple, union-control Recast) on this tier."""
    if not r or r.get("tier") == "48":
        return None
    return r.get("one_pass_short") or (2 * r["stage1_short"] if r.get("stage1_short") else None)


def video_size(width: int, height: int, r: dict | None, multiple: int = 64) -> tuple[int, int]:
    """The router's two-stage LTX output size for the tier: stage 1 (half) at most stage1_short; one pass at
    one_pass_short when the refine is off."""
    if not r or r.get("tier") == "48":
        return int(width), int(height)
    if r["refine"] == "off":
        return cap_short(width, height, r.get("one_pass_short") or 512, multiple)
    return cap_short(width, height, 2 * r["stage1_short"] if r.get("stage1_short") else None, multiple)


# ---------------------------------------------------------------- setup check

FEATURES = [
    # (feature, what it loads, {tier: verdict}); verdict: tested | should fit | offload | no
    ("③ Set, Look tab, ⑥ Edit (Cut) and exports", "runs in the browser, no GPU model",
     {"48": "tested", "24": "should fit", "16": "should fit", "12": "should fit"}),
    ("④ Frame: FLUX 3 Klein (int8) + Qwen3-VL 4B", "image model, encoder on the CPU below 48 GB",
     {"48": "tested", "24": "should fit", "16": "should fit", "12": "offload"}),
    ("Look still: Krea 2 Turbo", "fp8 build (13.1 GB) preferred below 48 GB",
     {"48": "tested", "24": "should fit", "16": "offload", "12": "offload"}),
    ("⑤ Motion: LTX-2.5 Draft / Final", "22B video model: int8 21.5 GB, w4a8 12.5 GB",
     {"48": "tested", "24": "offload", "16": "should fit", "12": "offload"}),
    ("⑤ Motion: Hollywood", "1408p on 48 GB; capped per tier",
     {"48": "tested", "24": "offload", "16": "should fit", "12": "offload"}),
    ("Ripple, Pose follow, Recast (LTX)", "the same 22B LTX-2.5 model",
     {"48": "tested", "24": "offload", "16": "should fit", "12": "offload"}),
    ("MiniMax H3 (second video engine)", "needs about 48 GB; low-VRAM H3 needs GGUF nodes Soundstage does not wire",
     {"48": "tested", "24": "no", "16": "no", "12": "no"}),
    ("Layers: SAM 3.1 + BiRefNet mattes", "about 2 GB",
     {"48": "tested", "24": "should fit", "16": "should fit", "12": "should fit"}),
    ("Director / Scene agent: Qwen3.5 4B (optional)", "about 8 GB bf16; rules-only without it",
     {"48": "tested", "24": "should fit", "16": "should fit", "12": "offload"}),
]
VERDICT_WORDS = {"tested": "fits (tested)", "should fit": "should fit (untested)",
                 "offload": "runs with partial offload to system RAM: slow (untested)",
                 "no": "does not fit"}


def report(tier, total_gb: float | None, list_files=None, gpu_name: str | None = None) -> dict:
    """The setup check: what this GPU is, which tier is in force, and which features fit."""
    r = rules(tier, total_gb)
    t = r["tier"]
    rows = []
    for name, what, v in FEATURES:
        verdict = v[t]
        if t == "16" and name.startswith(("⑤", "Ripple")) and list_files is not None:
            if not _installed(FAMILIES["ltx25_unet"]["builds"][2]["file"], _safe(list_files, "diffusion_models")):
                verdict = "offload"
                what += " (the w4a8 build is not installed: the int8 one is offloaded)"
        rows.append({"feature": name, "loads": what, "verdict": verdict, "words": VERDICT_WORDS[verdict]})
    out = {"setting": saved_tier() if tier is None else normalize(tier), "tier": t, "tested": r["tested"],
           "gpu": {"name": gpu_name, "total_gb": total_gb}, "note": r["note"], "features": rows,
           "launch_flags": r["flags"], "free_between": r["free_between"],
           "missing_smaller": missing_smaller(t, list_files, total_gb) if list_files is not None else []}
    if total_gb is not None and total_gb < 11:
        out["warning"] = (f"{total_gb:g} GB is below the smallest tier (12 GB). Motion will offload most of LTX-2.5 to "
                          "system RAM and may not finish.")
    elif total_gb is not None and int(t) > total_gb + 2:
        out["warning"] = (f"The {t} GB tier is set but this GPU has {total_gb:g} GB: renders may run out of memory. "
                          "Pick Auto or a smaller tier.")
    elif total_gb is None:
        out["warning"] = "No CUDA GPU was found: Auto falls back to the 12 GB rules. The browser steps still work."
    return out


def _safe(list_files, folder):
    try:
        return list_files(folder) or []
    except Exception:  # noqa: BLE001
        return []


# ---------------------------------------------------------------- ComfyUI hooks

def on_prompt(body: dict) -> dict:
    """On-prompt: the tier's rules on every submitted graph (the App, Ripple, one-click, scripts). Never raises."""
    try:
        r = current()
        if r["tier"] != "48" and isinstance(body.get("prompt"), dict):
            apply(body["prompt"], r, _comfy_list_files)
    except Exception:  # noqa: BLE001 - a tier must never stop a render
        pass
    return body


def finalize(g) -> dict:
    """g.finalize() with the tier's rules applied: for expansions built at run time (router, Motion, Footage)."""
    graph = g.finalize()
    try:
        apply(graph, current(), _comfy_list_files)
    except Exception:  # noqa: BLE001
        pass
    return graph


def _comfy_list_files(folder: str):
    try:
        import folder_paths
        return folder_paths.get_filename_list(folder)
    except Exception:  # noqa: BLE001
        return []


_REGISTERED = False


def register(routes=None) -> bool:
    """GET /soundstage/vram -> the setup check; POST /soundstage/vram {"tier": "16"} -> saves the App's setting."""
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web
    if routes is None:
        _REGISTERED = True
        from server import PromptServer
        routes = PromptServer.instance.routes
        try:
            PromptServer.instance.add_on_prompt_handler(on_prompt)
        except Exception:  # noqa: BLE001 - an older ComfyUI: graphs render as built
            pass

    def _gpu_name():
        try:
            import torch
            return torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
        except Exception:  # noqa: BLE001
            return None

    @routes.get("/soundstage/vram")
    async def _get(request):
        tier = request.query.get("tier") or saved_tier()
        return web.json_response(report(tier, gpu_total_gb(), _comfy_list_files, _gpu_name()))

    @routes.post("/soundstage/vram")
    async def _post(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if os.environ.get(ENV):
            return web.json_response({"error": f"{ENV} is set on the server; it wins over the App setting."},
                                     status=409)
        t = save_tier(body.get("tier"))
        return web.json_response(report(t, gpu_total_gb(), _comfy_list_files, _gpu_name()))

    return True
