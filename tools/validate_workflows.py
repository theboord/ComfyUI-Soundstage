#!/usr/bin/env python3
"""Check every workflow in example_workflows/ against ComfyUI node schemas, on a CPU, with no model files.

    python tools/validate_workflows.py                       # offline: no ComfyUI needed
    python tools/validate_workflows.py --url http://127.0.0.1:8188
    python tools/validate_workflows.py --url http://127.0.0.1:8188 --comfy-dir /path/to/ComfyUI --placeholders

What is checked, per node, in the main graph and inside every subgraph:
- the node type exists (a schema, a subgraph of the same file, or a frontend-only Note / Reroute);
- every link joins two nodes and slots that exist, and the output type fits the input type;
- every required socket (MODEL, IMAGE, ...) has a link, on nodes that are not muted or bypassed;
- widget values: combo values are in the option list, numbers are inside min and max;
- every model file a loader names is listed in MODELS.md, so a user can find it.

Schemas come from one of two places:
- offline (default): the pod's /object_info snapshots in tests/test_*_object_info.json (ComfyUI v0.43.0 with the
  node packs), tools/validate/extra_object_info.json for the few classes those miss, and Soundstage's own nodes read
  straight from the code (tools/validate/soundstage_schemas.py, in a separate process). Combo lists that ComfyUI
  fills from the models folders are not known offline, so model files are checked against MODELS.md instead.
- live (--url): a running ComfyUI, one class at a time via /object_info/<Class> (never the full /object_info).
  Start it with --cpu. With --comfy-dir and --placeholders, an empty file is created for every model file the
  workflows name, in the folder its loader reads, so the model combos can be checked without downloading anything
  (the same idea as freefield's tools/comfy_validate.py by neuregex, MIT; no code was copied).

Exit status 0 when every workflow passes, 1 otherwise. --json prints the full result.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = os.path.join(ROOT, "example_workflows")
SNAPSHOTS = sorted(glob.glob(os.path.join(ROOT, "tests", "test_*_object_info.json")))
EXTRA = os.path.join(ROOT, "tools", "validate", "extra_object_info.json")
SCHEMA_TOOL = os.path.join(ROOT, "tools", "validate", "soundstage_schemas.py")
MODELS_MD = os.path.join(ROOT, "MODELS.md")

FRONTEND_ONLY = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode", "Label (rgthree)"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
WILDCARD = {"*", "COMFY_MATCHTYPE_V3", ""}
SKIP_VALUES = {"COMFY_DYNAMICCOMBO_V3", "COMFY_AUTOGROW_V3"}  # dynamic widgets: values not mapped
MODEL_EXT = (".safetensors", ".sft", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx")
# Weight files a user downloads (MODELS.md lists them). Node packs fetch their own .onnx / .pt helpers.
WEIGHT_EXT = (".safetensors", ".sft", ".gguf", ".ckpt")
MEDIA_EXT = (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".mkv", ".wav", ".mp3", ".flac", ".ogg",
             ".m4a", ".glb", ".json")
SUBGRAPH_IN, SUBGRAPH_OUT = -10, -20

# Which models folder a loader reads (for --placeholders). Anything else goes to every folder in ALL_DIRS.
LOADER_DIRS = {
    "UNETLoader": ["diffusion_models"], "CLIPLoader": ["text_encoders"], "DualCLIPLoader": ["text_encoders"],
    "VAELoader": ["vae"], "LatentUpscaleModelLoader": ["latent_upscale_models"],
    "LoraLoaderModelOnly": ["loras"], "LTXICLoRALoaderModelOnly": ["loras"], "Krea2ControlLoRALoader": ["loras"],
    "CheckpointLoaderSimple": ["checkpoints"], "GemmaAPITextEncode": ["checkpoints", "diffusion_models"],
}
ALL_DIRS = ["diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "latent_upscale_models",
            "background_removal", "detection", "clip_vision", "upscale_models"]


# ---- schemas ---------------------------------------------------------------------------------------------------
def soundstage_schemas() -> tuple[dict, dict]:
    """Soundstage's own node schemas, read from the code in a separate process (it installs stand-in modules)."""
    r = subprocess.run([sys.executable, SCHEMA_TOOL], capture_output=True, text=True, cwd=ROOT, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"soundstage_schemas.py failed:\n{r.stderr[-2000:]}")
    d = json.loads(r.stdout)
    return d["object_info"], d["errors"]


def offline_schemas() -> tuple[dict, list[str]]:
    info, notes = {}, []
    for p in SNAPSHOTS:
        with open(p, encoding="utf-8") as f:
            info.update(json.load(f))
    with open(EXTRA, encoding="utf-8") as f:
        info.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
    own, errors = soundstage_schemas()
    info.update(own)
    for mod, err in errors.items():
        notes.append(f"Soundstage module {mod} did not load for the schema read: {err}")
    return info, notes


def _get_json(url: str, timeout: float = 20):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def live_schemas(url: str, classes) -> dict:
    """{class: schema} for the classes this server has, one /object_info/<Class> request each."""
    out = {}
    for c in sorted(classes):
        try:
            d = _get_json(f"{url.rstrip('/')}/object_info/{urllib.parse.quote(c, safe='')}")
        except (urllib.error.URLError, ValueError):
            continue
        if isinstance(d, dict) and c in d:
            out[c] = d[c]
    return out


# ---- workflow walking ------------------------------------------------------------------------------------------
def _links(graph: dict) -> list[dict]:
    out = []
    for l in graph.get("links") or []:
        if isinstance(l, dict):
            out.append({"id": l["id"], "src": l["origin_id"], "src_slot": l["origin_slot"],
                        "dst": l["target_id"], "dst_slot": l["target_slot"], "type": l.get("type")})
        elif isinstance(l, list) and len(l) >= 6:
            out.append({"id": l[0], "src": l[1], "src_slot": l[2], "dst": l[3], "dst_slot": l[4], "type": l[5]})
    return out


def graphs_of(wf: dict):
    """(label, graph, subgraph definition or None) for the main graph and each subgraph definition."""
    yield "main", wf, None
    for sg in (wf.get("definitions") or {}).get("subgraphs") or []:
        yield f"subgraph '{sg.get('name') or sg.get('id')}'", sg, sg


def node_classes(wf: dict) -> set[str]:
    sub_ids = {sg.get("id") for sg in (wf.get("definitions") or {}).get("subgraphs") or []}
    return {n.get("type") for _, g, _ in graphs_of(wf) for n in g.get("nodes") or []
            if n.get("type") not in sub_ids and n.get("type") not in FRONTEND_ONLY}


def model_names(wf: dict) -> list[tuple[str, str]]:
    """(loader class, model file) for every model file name a widget holds."""
    out = []
    for _, g, _ in graphs_of(wf):
        for n in g.get("nodes") or []:
            vals = n.get("widgets_values")
            vals = list(vals.values()) if isinstance(vals, dict) else (vals or [])
            for v in vals:
                if isinstance(v, str) and v.lower().endswith(MODEL_EXT):
                    out.append((n.get("type"), v))
    return out


def documented_models(path: str = MODELS_MD) -> set[str]:
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return {os.path.basename(m) for m in re.findall(r"[\w.\-/]+\.(?:safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)", text)}


# ---- schema helpers --------------------------------------------------------------------------------------------
def _types(t) -> set[str]:
    if isinstance(t, list):
        return {"COMBO"}
    return {x.strip() for x in str(t).split(",")}


def _spec_inputs(schema: dict) -> list[tuple[str, list, bool]]:
    """[(name, spec, required)] in ComfyUI's order."""
    ins = schema.get("input") or {}
    order = schema.get("input_order") or {}
    out = []
    for sect, req in (("required", True), ("optional", False)):
        d = ins.get(sect) or {}
        names = order.get(sect) or list(d)
        for name in names:
            if name in d:
                spec = d[name]
                out.append((name, spec if isinstance(spec, list) else [spec, {}], req))
    return out


def _opts(spec) -> dict:
    return spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}


def _is_widget(spec) -> bool:
    t, o = spec[0], _opts(spec)
    if isinstance(t, list):
        return True
    return t in WIDGET_TYPES and not o.get("force_input") and not o.get("forceInput")


def _combo_options(spec) -> list | None:
    if isinstance(spec[0], list):
        return spec[0]
    o = _opts(spec)
    return o.get("options") if isinstance(o.get("options"), list) else None


def fits(src_type, dst_type) -> bool:
    s, d = _types(src_type), _types(dst_type)
    if s & WILDCARD or d & WILDCARD:
        return True
    if "COMBO" in d and ("COMBO" in s or "STRING" in s):
        return True
    return bool(s & d)


# ---- the check -------------------------------------------------------------------------------------------------
def check_workflow(wf: dict, schemas: dict, documented: set[str] | None = None, live_combos: bool = False) -> dict:
    """{'problems': [...], 'unchecked': [...], 'nodes': n}. documented=None skips the MODELS.md check."""
    problems, unchecked, count = [], set(), 0
    sub_defs = {sg.get("id"): sg for sg in (wf.get("definitions") or {}).get("subgraphs") or []}

    for label, g, sg in graphs_of(wf):
        nodes = {n.get("id"): n for n in g.get("nodes") or []}
        count += len(nodes)

        def out_type(nid, slot):
            if nid == SUBGRAPH_IN and sg is not None:
                ins = sg.get("inputs") or []
                return ins[slot].get("type") if slot < len(ins) else None
            n = nodes.get(nid)
            if n is None:
                return None
            t = n.get("type")
            if t in schemas and t not in FRONTEND_ONLY:
                outs = schemas[t].get("output") or []
                return outs[slot] if slot < len(outs) else None
            outs = n.get("outputs") or []
            return outs[slot].get("type") if slot < len(outs) else "*"

        for l in _links(g):
            where = f"{label}, link {l['id']}"
            if l["src"] != SUBGRAPH_IN and l["src"] not in nodes:
                problems.append(f"{where}: comes from node {l['src']}, which is not in the graph")
                continue
            if l["dst"] != SUBGRAPH_OUT and l["dst"] not in nodes:
                problems.append(f"{where}: goes to node {l['dst']}, which is not in the graph")
                continue
            st = out_type(l["src"], l["src_slot"])
            if st is None:
                problems.append(f"{where}: node {l['src']} has no output slot {l['src_slot']}")
                continue
            if l["dst"] == SUBGRAPH_OUT:
                continue
            dn = nodes[l["dst"]]
            dins = dn.get("inputs") or []
            if l["dst_slot"] >= len(dins):
                problems.append(f"{where}: node {dn.get('id')} ({dn.get('type')}) has no input slot {l['dst_slot']}")
                continue
            dname = dins[l["dst_slot"]].get("name")
            schema = schemas.get(dn.get("type"))
            if schema is None:
                continue
            by_name = dict((n, s) for n, s, _ in _spec_inputs(schema))
            spec = by_name.get(dname)
            if spec is None and "." in dname:  # a DynamicCombo / Autogrow sub-input ("resize_type.multiple")
                head = by_name.get(dname.split(".")[0])
                if head is not None and str(head[0]) in SKIP_VALUES:
                    continue
            if spec is not None and l["src"] == SUBGRAPH_IN and _is_widget(spec):
                continue  # a promoted widget: the subgraph node holds a value, not a link
            if spec is None:
                if dn.get("type") in FRONTEND_ONLY:
                    continue
                problems.append(f"{where}: {dn.get('type')} (node {dn.get('id')}) has no input named '{dname}'")
            elif not fits(st, spec[0]):
                problems.append(f"{where}: {st} into {dn.get('type')}.{dname}, which takes "
                                f"{spec[0] if not isinstance(spec[0], list) else 'COMBO'}")

        for nid, n in nodes.items():
            t = n.get("type")
            if t in FRONTEND_ONLY or t in sub_defs:
                continue
            here = f"{label}, node {nid} ({t})"
            schema = schemas.get(t)
            if schema is None:
                problems.append(f"{here}: no such node type (missing node pack, or an old name)")
                continue
            if n.get("mode") in (2, 4):  # muted / bypassed: ComfyUI does not validate it
                continue
            linked = {i.get("name") for i in n.get("inputs") or [] if i.get("link") is not None}
            specs = _spec_inputs(schema)
            for name, spec, req in specs:
                if req and not _is_widget(spec) and not _opts(spec).get("socketless") \
                        and str(spec[0]) not in SKIP_VALUES and name not in linked:
                    problems.append(f"{here}: required input '{name}' ({spec[0]}) is not connected")
            if schema.get("loose") or any(not isinstance(s[0], list) and s[0] in SKIP_VALUES for _, s, _ in specs):
                unchecked.add(t)
                continue
            wv = _widget_values(n, specs, ordered=bool(schema.get("input_order")) or len(
                [1 for _, sp, _ in specs if _is_widget(sp)]) <= 1)
            if wv is None:
                unchecked.add(t)
                continue
            for name, spec, value in wv:
                if name in linked:
                    continue
                problems.extend(f"{here}: {msg}" for msg in _check_value(name, spec, value, documented, live_combos))
    return {"problems": problems, "unchecked": sorted(unchecked), "nodes": count}


def _widget_values(n: dict, specs, ordered: bool = True) -> list | None:
    vals = n.get("widgets_values")
    if isinstance(vals, dict):
        named = vals
    elif vals is None and isinstance(n.get("widgets_values_named"), dict):
        named = n["widgets_values_named"]  # the frontend loads widgets_values; the named copy is only a fallback
    else:
        named = None
    widgets = [(name, spec) for name, spec, _ in specs if _is_widget(spec)]
    # The node's own input list keeps the widgets in the order its values were saved (a snapshot's dicts may not).
    order = [i["widget"]["name"] for i in n.get("inputs") or [] if isinstance(i.get("widget"), dict)]
    nm = n.get("widgets_values_named")
    if isinstance(nm, dict) and isinstance(vals, list) and len(nm) == len(vals):
        order = list(nm)  # newer frontends save the values twice; the named copy keeps the widget order
    if order and {w for w, _ in widgets} <= set(order):
        pos = {w: k for k, w in enumerate(order)}
        widgets.sort(key=lambda w: pos[w[0]])
    elif named is None and not ordered:
        return None  # the schema has no input order (an old snapshot) and the node does not say: don't guess
    if named is not None:
        return [(name, spec, named[name]) for name, spec in widgets if name in named]
    vals = list(vals or [])
    out, i = [], 0
    for name, spec in widgets:
        if i >= len(vals):
            break
        out.append((name, spec, vals[i]))
        i += 1
        o = _opts(spec)
        if o.get("control_after_generate") or (spec[0] == "INT" and name in ("seed", "noise_seed")):
            if i < len(vals) and vals[i] in ("fixed", "increment", "decrement", "randomize"):
                i += 1
    return out


def _check_value(name, spec, value, documented, live_combos) -> list[str]:
    t, o = spec[0], _opts(spec)
    if isinstance(value, str) and value.lower().endswith(WEIGHT_EXT):
        opts = _combo_options(spec)
        if live_combos and opts is not None:
            return [] if value in opts else [f"'{name}' = {value}: no such file on the server"]
        if documented is not None and os.path.basename(value) not in documented:
            return [f"'{name}' = {value}: this model file is not listed in MODELS.md"]
        return []
    if t == "COMBO" or isinstance(t, list):
        opts = _combo_options(spec)
        if not opts or value is None or (isinstance(value, str) and value.lower().endswith(MEDIA_EXT + MODEL_EXT)):
            return []  # model lists and input files differ per install
        return [] if value in opts else [f"'{name}' = {value!r} is not one of {opts[:8]}"]
    if t in ("INT", "FLOAT") and isinstance(value, (int, float)) and not isinstance(value, bool):
        lo, hi = o.get("min"), o.get("max")
        if lo is not None and value < lo:
            return [f"'{name}' = {value} is below the minimum {lo}"]
        if hi is not None and value > hi:
            return [f"'{name}' = {value} is above the maximum {hi}"]
    return []


# ---- placeholders ----------------------------------------------------------------------------------------------
def make_placeholders(workflows: dict, comfy_dir: str) -> list[str]:
    """Create an empty file for every model file the workflows name, in its loader's folder. Never overwrites."""
    made = []
    for wf in workflows.values():
        for cls, name in model_names(wf):
            for d in LOADER_DIRS.get(cls, ALL_DIRS):
                p = os.path.join(comfy_dir, "models", d, *name.replace("\\", "/").split("/"))
                if not os.path.exists(p):
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    open(p, "wb").close()
                    made.append(os.path.relpath(p, comfy_dir))
    return made


def load_workflows(paths=None) -> dict:
    paths = paths or sorted(glob.glob(os.path.join(WORKFLOWS, "*.json")))
    out = {}
    for p in paths:
        with open(p, encoding="utf-8") as f:
            out[os.path.basename(p)] = json.load(f)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("workflows", nargs="*", help="workflow files (default: example_workflows/*.json)")
    ap.add_argument("--url", help="a running ComfyUI (start it with --cpu); schemas are read one class at a time")
    ap.add_argument("--comfy-dir", help="that ComfyUI's folder, for --placeholders")
    ap.add_argument("--placeholders", action="store_true", help="create empty model files the workflows name")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    workflows = load_workflows(a.workflows or None)
    documented = documented_models()
    notes = []
    if a.url:
        if a.placeholders:
            if not a.comfy_dir:
                ap.error("--placeholders needs --comfy-dir")
            made = make_placeholders(workflows, a.comfy_dir)
            notes.append(f"created {len(made)} empty model files under {a.comfy_dir}/models")
        classes = set().union(*(node_classes(w) for w in workflows.values()))
        schemas = live_schemas(a.url, classes)
        notes.append(f"read {len(schemas)} of {len(classes)} node schemas from {a.url} (one class per request)")
    else:
        schemas, n2 = offline_schemas()
        notes += n2
        notes.append(f"offline: {len(schemas)} schemas (pod snapshots, extra_object_info.json, Soundstage's own nodes)")

    results = {name: check_workflow(wf, schemas, documented, live_combos=bool(a.url and a.placeholders))
               for name, wf in workflows.items()}
    ok = all(not r["problems"] for r in results.values())
    if a.json:
        print(json.dumps({"ok": ok, "notes": notes, "results": results}, indent=1))
    else:
        for n in notes:
            print(f"· {n}")
        for name, r in results.items():
            mark = "✓" if not r["problems"] else "✗"
            extra = f"; values not checked on {', '.join(r['unchecked'])}" if r["unchecked"] else ""
            print(f"{mark} {name}: {r['nodes']} nodes, {len(r['problems'])} problems{extra}")
            for p in r["problems"]:
                print(f"    {p}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
