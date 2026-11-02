"""Soundstage's own node schemas in /object_info form, without ComfyUI, torch or a GPU.

    python tools/validate/soundstage_schemas.py > soundstage_object_info.json

Imports every Soundstage node module with small stand-ins for ComfyUI's modules (comfy_api, folder_paths, nodes,
server, comfy, comfy_execution) and for torch, then calls each node's define_schema() and writes what ComfyUI's
/object_info would say about its inputs and outputs. Only the schema is read; no node runs.

The stand-ins are deliberately loose (any attribute exists, any call works), so this is for checking workflows
(tools/validate_workflows.py), not for running anything. Run it in its own process: it fills sys.modules with
fakes. Combo lists that ComfyUI fills from the models folders come out empty here; the validator skips those.
"""
from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NODE_MODULES = ("nodes_stage", "nodes_ladder", "nodes_cine", "nodes_layers", "nodes_router", "nodes_matte",
                "nodes_look", "nodes_footage", "nodes_cut", "nodes_agent", "nodes_audio", "nodes_quality",
                "nodes_canvas", "nodes_fill", "nodes_video2stage", "nodes_mocap", "nodes_motion", "nodes_takecheck",
                "nodes_finish", "nodes_performance")
# Must match SoundstageExtension.get_node_list (soundstage/nodes_stage.py); tests/test_validate_workflows.py checks.

FAKE_ROOTS = ("torch", "torchaudio", "torchvision", "comfy", "comfy_api", "comfy_execution", "comfy_extras",
              "folder_paths", "nodes", "server", "node_helpers", "latent_preview", "comfy_api_nodes", "app",
              "safetensors", "transformers", "einops", "kornia")


# ---- a value that is anything ------------------------------------------------------------------------------
class _AnyMeta(type):
    def __getattr__(cls, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _any_class(name)

    def __getitem__(cls, item):
        return cls

    def __or__(cls, other):
        return cls

    __ror__ = __or__

    def __iter__(cls):
        return iter(())


class _Any(metaclass=_AnyMeta):
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _any_class(name)()

    def __call__(self, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]  # used as a decorator: keep the function
        return _Any()

    def __iter__(self):
        return iter(())

    def __getitem__(self, k):
        return _Any()

    def __len__(self):
        return 0

    def __bool__(self):
        return False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __float__(self):
        return 0.0

    def __int__(self):
        return 0

    def __index__(self):
        return 0

    def __str__(self):
        return ""

    def __fspath__(self):
        return os.devnull

    def __add__(self, o):
        return _Any()

    __radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __truediv__ = __rtruediv__ = __add__
    __or__ = __ror__ = __and__ = __neg__ = __add__


def _any_class(name):
    return _AnyMeta(str(name), (_Any,), {})


class _AnyModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _any_class(name)


# ---- comfy_api.latest IO: records the schema -----------------------------------------------------------------
V3_TYPES = {"String": "STRING", "Int": "INT", "Float": "FLOAT", "Boolean": "BOOLEAN", "Combo": "COMBO",
            "Image": "IMAGE", "Mask": "MASK", "Audio": "AUDIO", "Video": "VIDEO", "Model": "MODEL",
            "Latent": "LATENT", "Clip": "CLIP", "Vae": "VAE", "Conditioning": "CONDITIONING", "Sigmas": "SIGMAS",
            "Noise": "NOISE", "Guider": "GUIDER", "Sampler": "SAMPLER", "AnyType": "*",
            "DynamicCombo": "COMFY_DYNAMICCOMBO_V3", "MatchType": "COMFY_MATCHTYPE_V3",
            "Autogrow": "COMFY_AUTOGROW_V3", "MultiCombo": "COMBO", "Webcam": "WEBCAM",
            "UpscaleModel": "UPSCALE_MODEL", "ClipVision": "CLIP_VISION", "ClipVisionOutput": "CLIP_VISION_OUTPUT",
            "ControlNet": "CONTROL_NET", "Load3D": "LOAD3D", "Voxel": "VOXEL", "Mesh": "MESH"}
WIDGET_OPTS = ("default", "min", "max", "step", "multiline", "options", "control_after_generate", "tooltip",
               "display_mode", "round", "placeholder", "socketless", "force_input", "image_upload")


class _In:
    def __init__(self, io_type, id, *a, **k):
        self.io_type, self.id, self.kw = io_type, id, k
        if io_type == "COMBO" and a and "options" not in k:
            self.kw["options"] = a[0]

    def spec(self):
        opts = {}
        for key in WIDGET_OPTS:
            if key in self.kw and self.kw[key] is not None:
                v = self.kw[key]
                if key == "options":
                    v = [getattr(o, "value", o) for o in (v if isinstance(v, (list, tuple)) else [])]
                    if self.io_type == "COMFY_DYNAMICCOMBO_V3":
                        v = [{"key": o.key, "inputs": _inputs_dict(o.inputs)} for o in self.kw[key]]
                elif key == "control_after_generate":
                    v = bool(v)
                elif not isinstance(v, (str, int, float, bool, list)):
                    continue
                opts[key] = v
        return [self.io_type, opts]


class _Out:
    def __init__(self, io_type, id=None, *a, **k):
        self.io_type, self.id = io_type, id
        self.name = k.get("display_name") or id or io_type


def _type_ns(name, io_type):
    def inp(id, *a, **k):
        return _In(io_type, id, *a, **k)

    def out(id=None, *a, **k):
        return _Out(io_type, id, *a, **k)

    ns = types.SimpleNamespace(Input=inp, Output=out, io_type=io_type)
    if name == "DynamicCombo":
        ns.Option = lambda key, inputs=(), **k: types.SimpleNamespace(key=key, inputs=list(inputs))
    if name == "MatchType":
        ns.Template = lambda *a, **k: _Any()
    return ns


def _custom(io_type):
    return _type_ns(io_type, str(io_type))


def _inputs_dict(inputs):
    req, opt = {}, {}
    for i in inputs or ():
        if not isinstance(i, _In):
            continue
        (opt if i.kw.get("optional") else req)[i.id] = i.spec()
    return {"required": req, "optional": opt}


class _Schema:
    def __init__(self, node_id, inputs=(), outputs=(), hidden=(), is_output_node=False, category="", **k):
        self.node_id, self.inputs, self.outputs = node_id, list(inputs or ()), list(outputs or ())
        self.is_output_node, self.category = is_output_node, category


class _IOMeta(type):
    def __getattr__(cls, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if name in V3_TYPES:
            return _type_ns(name, V3_TYPES[name])
        return _any_class(name)


class IO(metaclass=_IOMeta):
    Schema = _Schema
    Custom = staticmethod(_custom)

    class ComfyNode:
        pass

    class NodeOutput(_Any):
        pass


class ComfyExtension:
    pass


def _install_fakes():
    real_torch = False
    try:
        importlib.import_module("torch")
        real_torch = os.environ.get("SOUNDSTAGE_SCHEMA_REAL_TORCH") == "1"
    except Exception:
        pass

    class Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
        def find_spec(self, fullname, path, target=None):
            root = fullname.split(".")[0]
            if root in FAKE_ROOTS and not (real_torch and root == "torch"):
                return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
            return None

        def create_module(self, spec):
            m = _AnyModule(spec.name)
            m.__path__ = []
            return m

        def exec_module(self, module):
            if module.__name__ == "comfy_api.latest":
                module.IO, module.ComfyExtension = IO, ComfyExtension
            if module.__name__ == "nodes":
                module.NODE_CLASS_MAPPINGS = {}
            if module.__name__ == "folder_paths":
                module.models_dir = os.devnull
                module.get_filename_list = lambda *a, **k: []
                module.get_folder_paths = lambda *a, **k: []
                module.get_output_directory = module.get_input_directory = module.get_temp_directory = \
                    lambda *a, **k: os.devnull
                module.folder_names_and_paths = {}

    for k in [m for m in sys.modules if m.split(".")[0] in FAKE_ROOTS]:
        del sys.modules[k]
    sys.meta_path.insert(0, Finder())


def object_info(modules=NODE_MODULES) -> tuple[dict, dict]:
    """({class: /object_info entry}, {module: error}) for every Soundstage node that imports under the fakes."""
    _install_fakes()
    sys.path.insert(0, ROOT)
    out, errors = {}, {}
    for mod in modules:
        try:
            m = importlib.import_module(f"soundstage.{mod}")
        except Exception as e:  # noqa: BLE001  report, keep going
            errors[mod] = f"{type(e).__name__}: {e}"
            continue
        classes = list(getattr(m, "NODES", None) or [])
        if mod == "nodes_stage":
            classes = [getattr(m, "SoundstageStage")]
        for cls in classes:
            try:
                s = cls.define_schema()
            except Exception as e:  # noqa: BLE001
                errors[f"{mod}.{getattr(cls, '__name__', cls)}"] = f"{type(e).__name__}: {e}"
                continue
            ins = _inputs_dict(s.inputs)
            out[s.node_id] = {
                "input": ins,
                "input_order": {k: list(v) for k, v in ins.items()},
                "output": [o.io_type for o in s.outputs],
                "output_name": [o.name for o in s.outputs],
                "output_node": bool(s.is_output_node),
                "category": s.category,
                "python_module": f"custom_nodes.ComfyUI-Soundstage (soundstage.{mod})",
            }
    return out, errors


if __name__ == "__main__":
    info, errs = object_info()
    json.dump({"object_info": info, "errors": errs}, sys.stdout, indent=1, sort_keys=True)
