"""Registry loading, availability filtering and dropdown labels.

Pure Python on purpose: the loaded-class set and the folder lister are passed in, so the tests
run without ComfyUI, torch or a GPU.
"""
import json
import os
import re

REGISTRY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.json")
OPEN_ONLY_ENV = "SOUNDSTAGE_OPEN_WEIGHTS_ONLY"
PAID_KINDS = {"partner", "cloud"}
LOCAL_KINDS = {"local", "custom_node"}
NONE_KEY = "(no model installed for this stage)"

_registry = None


def load_registry(path=None):
    global _registry
    if path:
        with open(path) as f:
            return json.load(f)
    if _registry is None:
        with open(REGISTRY_PATH) as f:
            _registry = json.load(f)
    return _registry


def open_weights_only():
    return os.environ.get(OPEN_ONLY_ENV, "0").strip().lower() in ("1", "true", "yes", "on")


def badges_for(m):
    """Short licence/cost tags shown in the dropdown label."""
    lic = (m.get("license") or "").lower()
    out = []
    cap = re.search(r"<\s*\$(\d+)\s*m", lic) or re.search(r"\$(\d+)\s*m", lic)
    if m.get("kind") in PAID_KINDS:
        out.append("API")
    elif cap:  # revenue-capped commercial use wins over a "free non-commercial" clause
        out.append(f"<${cap.group(1)}M")
    elif "non-commercial" in lic or "noncommercial" in lic or "nc 4.0" in lic or "by-nc" in lic or "research license" in lic:
        out.append("NC")
    if "exclude" in lic and m.get("kind") not in PAID_KINDS:
        out.append("GEO")
    if m.get("auto_download"):
        out.append("DL")
    return out


def label_for(m):
    where = "local" if m.get("kind") in LOCAL_KINDS else m.get("provider", "")
    b = badges_for(m)
    return f"{m['name']} · {where}" + (f" [{' '.join(b)}]" if b else "")


def resolve_weight(spec, list_files):
    """First installed file of spec['any'], matched by exact name or by basename inside a subfolder."""
    try:
        files = list_files(spec["folder"]) or []
    except Exception:
        return None
    for cand in spec["any"]:
        for f in files:
            norm = f.replace("\\", "/")
            if norm == cand or norm.endswith("/" + cand):
                return f
    return None


def resolve_weights(m, list_files, loaded_classes=None):
    """{role: filename} for required weights (None when missing) plus optional ones. An optional
    feature whose extra node classes are not loaded resolves to None too."""
    out = {}
    for spec in m.get("weights", []) + m.get("optional_weights", []):
        ok = loaded_classes is None or all(c in loaded_classes for c in spec.get("classes", []))
        out[spec["role"]] = resolve_weight(spec, list_files) if ok else None
    return out


def is_available(m, loaded_classes, list_files, open_only=False):
    if not m.get("adapter"):
        return False
    if m.get("kind") in PAID_KINDS and open_only:
        return False
    if any(c not in loaded_classes for c in m.get("classes", [])):
        return False
    return all(resolve_weight(spec, list_files) for spec in m.get("weights", []))


def available_models(stage, loaded_classes, list_files, open_only=None, registry=None):
    reg = registry or load_registry()
    if open_only is None:
        open_only = open_weights_only()
    return [m for m in reg["models"]
            if stage in m["stages"] and is_available(m, loaded_classes, list_files, open_only)]


def find_model(key, registry=None):
    """Look a dropdown value up by label (what the workflow stores) or by registry id."""
    reg = registry or load_registry()
    for m in reg["models"]:
        if m.get("adapter") and (label_for(m) == key or m["id"] == key):
            return m
    return None


def option_widgets(m, stage):
    """Nested widget specs for a model's dropdown option (the router turns them into IO inputs).
    Duration is never a widget: partner adapters derive it from the router's frames / fps."""
    out = []
    for key, spec in (m.get("params") or {}).items():
        if key == "duration" or ("stages" in spec and stage not in spec["stages"]):
            continue
        if "options" in spec:
            out.append({"kind": "combo", "id": key, "options": list(spec["options"]),
                        "default": spec.get("default", spec["options"][0])})
        elif "min" in spec and "max" in spec:
            out.append({"kind": "float", "id": key, "min": spec["min"], "max": spec["max"],
                        "default": spec.get("default", spec["min"])})
    return out


def stage_options(stage, loaded_classes, list_files, open_only=None, registry=None):
    """[(dropdown label, widget specs, entry)] for one stage; a single placeholder when nothing runs."""
    models = available_models(stage, loaded_classes, list_files, open_only, registry)
    if not models:
        return [(NONE_KEY, [], None)]
    return [(label_for(m), option_widgets(m, stage), m) for m in models]
