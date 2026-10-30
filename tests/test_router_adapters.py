"""Adapters build valid backend graphs: every emitted node exists, every required input (including the
nested inputs of the chosen DynamicCombo option) is set, no unknown inputs, combo values are in their
option lists and numbers are in range. Checked against a /object_info snapshot of the pod's
ComfyUI v0.43.0 (tests/test_router_object_info.json, refresh with --refresh-snapshot, see bottom).

No ComfyUI, torch or GPU needed.
"""
import itertools
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.router import adapters as A  # noqa: E402
from soundstage.router.registry import load_registry, resolve_weights  # noqa: E402

SNAPSHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_router_object_info.json")
OBJECT_INFO = json.load(open(SNAPSHOT)) if os.path.exists(SNAPSHOT) else {}
REG = load_registry()
WIRED = [m for m in REG["models"] if m["adapter"]]


class FakeNode:
    def __init__(self, id, class_type, inputs):
        self.id, self.class_type, self.inputs = id, class_type, dict(inputs)

    def out(self, i):
        return [self.id, i]

    def set_input(self, k, v):
        self.inputs[k] = v


class FakeGraph:
    """Same surface as comfy_execution.graph_utils.GraphBuilder that the adapters use."""

    def __init__(self):
        self.nodes = {}
        self.n = 0

    def node(self, class_type, id=None, **kwargs):
        self.n += 1
        nid = id or f"x{self.n}"
        self.nodes[nid] = FakeNode(nid, class_type, kwargs)
        return self.nodes[nid]


# Raw links from the router's own inputs (upstream user nodes), with their socket types.
UPSTREAM = {"img": "IMAGE", "img_last": "IMAGE", "ctrl": "IMAGE", "ref1": "IMAGE", "ref2": "IMAGE",
            "frames": "IMAGE", "mask": "MASK"}


def link(name):
    return [f"user_{name}", 0]


def all_weights(m):
    """Pretend every required and optional weight is installed: role -> first candidate."""
    return {spec["role"]: spec["any"][0] for spec in m.get("weights", []) + m.get("optional_weights", [])}


def default_params(m, stage):
    out = {}
    for k, spec in (m.get("params") or {}).items():
        if "stages" in spec and stage not in spec["stages"]:
            continue
        if "options" in spec and k not in ("duration",):
            out[k] = spec.get("default", spec["options"][0])
        elif "default" in spec:
            out[k] = spec["default"]
    return out


def base_p(m, stage, **media):
    p = {"stage": stage, "prompt": "a woman walks to the door", "negative": "", "seed": 123456789012,
         "width": 1920, "height": 1088, "frames": 97, "fps": 24.0, "first": None, "last": None, "control": None,
         "refs": [], "image": None, "images": None, "mask": None,
         "params": default_params(m, stage), "weights": all_weights(m), "variant": m.get("variant")}
    p.update(media)
    return p


# Media combinations per stage. Adapters may refuse some (RouterError), but at least one must build.
SCENARIOS = {
    "generate_image": [{}, {"refs": [link("ref1"), link("ref2")]}, {"control": link("ctrl")}],
    "edit_image": [{"image": link("img")}, {"image": link("img"), "refs": [link("ref1")]},
                   {"image": link("img"), "control": link("ctrl")}],
    "generate_video": [{}, {"first": link("img")}, {"first": link("img"), "last": link("img_last")},
                       {"control": link("ctrl")}, {"control": link("ctrl"), "first": link("img")},
                       {"refs": [link("ref1")]}, {"control": link("ctrl"), "refs": [link("ref1")]}],
    "matte": [{"images": link("frames")}],
    "clean_plate": [{"images": link("frames")}, {"images": link("frames"), "mask": link("mask")}],
}

CASES = [(m["id"], stage, i) for m in WIRED for stage in m["stages"] for i in range(len(SCENARIOS[stage]))]


def input_specs(class_type, inputs):
    """Flatten a node's object_info inputs for the values it was given: {key: (spec, required)}.
    Expands the chosen option of each DynamicCombo into dotted keys, Autogrow into dotted names."""
    info = OBJECT_INFO[class_type]["input"]
    out = {}

    def walk(section, prefix, required):
        for name, spec in section.items():
            key = prefix + name
            typ = spec[0]
            opts = spec[1] if len(spec) > 1 else {}
            if typ == "COMFY_DYNAMICCOMBO_V3":
                out[key] = (["COMBO", {"options": [o["key"] for o in opts["options"]]}], required)
                chosen = inputs.get(key)
                for o in opts["options"]:
                    if o["key"] == chosen:
                        walk(o["inputs"].get("required", {}), key + ".", True)
                        walk(o["inputs"].get("optional", {}), key + ".", False)
            elif typ == "COMFY_AUTOGROW_V3":
                tmpl = opts["template"]
                tin = {**tmpl["input"].get("required", {}), **tmpl["input"].get("optional", {})}
                tspec = next(iter(tin.values()))
                names = tmpl.get("names") or [f"{tmpl['prefix']}{i}" for i in range(tmpl.get("max", 100))]
                for i, n in enumerate(names):
                    out[f"{key}.{n}"] = (tspec, required and i < tmpl.get("min", 0))
            else:
                out[key] = (spec, required)

    walk(info.get("required", {}), "", True)
    walk(info.get("optional", {}), "", False)
    return out


def output_type(graph, value):
    nid, slot = value
    if nid.startswith("user_"):
        return UPSTREAM[nid[5:]]
    node = graph.nodes[nid]
    typ = OBJECT_INFO[node.class_type]["output"][slot]
    if typ == "COMFY_MATCHTYPE_V3":  # ResizeImageMaskNode: output type follows its `input`
        return output_type(graph, node.inputs["input"])
    return typ


def check_graph(graph):
    problems = []
    for nid, node in graph.nodes.items():
        if node.class_type not in OBJECT_INFO:
            problems.append(f"{node.class_type}: not in snapshot")
            continue
        specs = input_specs(node.class_type, node.inputs)
        for key, (spec, required) in specs.items():
            if required and key not in node.inputs:
                problems.append(f"{node.class_type}: missing required input {key}")
        for key, value in node.inputs.items():
            if key not in specs:
                problems.append(f"{node.class_type}: unknown input {key}")
                continue
            spec = specs[key][0]
            typ, opts = spec[0], (spec[1] if len(spec) > 1 else {})
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                got = output_type(graph, value)
                want = typ if isinstance(typ, str) else "COMBO"
                if want == "COMFY_MATCHTYPE_V3":
                    want = opts["template"]["allowed_types"]
                if not ({got} & set(want.split(",")) or want == "*" or got == "*"):
                    problems.append(f"{node.class_type}.{key}: link type {got} != {want}")
                continue
            choices = typ if isinstance(typ, list) else (opts.get("options") if typ == "COMBO" else None)
            if choices is not None:
                if value not in choices and not (key.endswith("_name") or key in ("ckpt_name", "model_name")):
                    problems.append(f"{node.class_type}.{key}: {value!r} not in {choices[:8]}")
            elif typ in ("INT", "FLOAT"):
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    problems.append(f"{node.class_type}.{key}: {value!r} is not a number")
                elif ("min" in opts and value < opts["min"]) or ("max" in opts and value > opts["max"]):
                    problems.append(f"{node.class_type}.{key}: {value} outside [{opts.get('min')}, {opts.get('max')}]")
            elif typ == "BOOLEAN" and not isinstance(value, bool):
                problems.append(f"{node.class_type}.{key}: {value!r} is not a bool")
            elif typ == "STRING" and not isinstance(value, str):
                problems.append(f"{node.class_type}.{key}: {value!r} is not a string")
    return problems


def run_adapter(mid, stage, i):
    m = next(x for x in WIRED if x["id"] == mid)
    g = FakeGraph()
    outs = A.ADAPTERS[m["adapter"]](g, m, base_p(m, stage, **SCENARIOS[stage][i]))
    return m, g, outs


EXPECTED_OUT = {"generate_image": {"image": "IMAGE"}, "edit_image": {"image": "IMAGE"},
                "generate_video": {"video": "VIDEO"}, "matte": {"images": "IMAGE", "mask": "MASK"},
                "clean_plate": {"images": "IMAGE"}}


@pytest.mark.skipif(not OBJECT_INFO, reason="no object_info snapshot")
@pytest.mark.parametrize("mid,stage,i", CASES)
def test_adapter_builds_valid_graph(mid, stage, i):
    try:
        m, g, outs = run_adapter(mid, stage, i)
    except A.RouterError:
        pytest.skip("adapter refuses this input combination (by design)")
    assert set(outs) == set(EXPECTED_OUT[stage])
    for k, want in EXPECTED_OUT[stage].items():
        assert output_type(g, outs[k]) == want, (k, outs[k])
    assert check_graph(g) == []
    for c in {n.class_type for n in g.nodes.values()} - {"CreateVideo", "GetVideoComponents"}:
        assert c in m["classes"] or c in {"ResizeImageMaskNode"} | set(
            itertools.chain.from_iterable(s.get("classes", []) for s in m.get("optional_weights", []))), \
            f"{m['id']} emits {c} but does not list it in classes (availability check would miss it)"


@pytest.mark.parametrize("m", WIRED, ids=lambda m: m["id"])
def test_every_wired_model_builds_for_some_input(m):
    for stage in m["stages"]:
        built = 0
        for i in range(len(SCENARIOS[stage])):
            try:
                run_adapter(m["id"], stage, i)
                built += 1
            except A.RouterError:
                pass
        assert built, f"{m['id']} refuses every input combination for {stage}"


@pytest.mark.skipif(not OBJECT_INFO, reason="no object_info snapshot")
@pytest.mark.parametrize("m", [m for m in WIRED if "edit_image" in m["stages"]], ids=lambda m: m["id"])
def test_edit_keeps_input_size_when_width_height_zero(m):
    g = FakeGraph()
    p = base_p(m, "edit_image", image=link("img"), width=0, height=0)
    A.ADAPTERS[m["adapter"]](g, m, p)
    assert check_graph(g) == []
    assert not any(n.class_type == "ResizeImageMaskNode" for n in g.nodes.values())


def test_ltx_auto_mode_picks_layout_to_render_when_control_connected():
    m = next(x for x in WIRED if x["id"] == "open.ltx_2_5")
    g = FakeGraph()
    A.ADAPTERS["ltx25"](g, m, base_p(m, "generate_video", control=link("ctrl"), first=link("img")))
    classes = [n.class_type for n in g.nodes.values()]
    assert "LTXICLoRALoaderModelOnly" in classes and classes.count("LTXAddVideoICLoRAGuide") == 4
    g = FakeGraph()
    A.ADAPTERS["ltx25"](g, m, base_p(m, "generate_video", first=link("img")))
    classes = [n.class_type for n in g.nodes.values()]
    assert "LTXICLoRALoaderModelOnly" not in classes and "LTXVImgToVideoInplace" in classes


def test_ltx_l2r_without_lora_is_a_friendly_error():
    m = next(x for x in WIRED if x["id"] == "open.ltx_2_5")
    p = base_p(m, "generate_video", control=link("ctrl"))
    p["weights"]["l2r_lora"] = None
    with pytest.raises(A.RouterError, match="layout-to-render"):
        A.ADAPTERS["ltx25"](FakeGraph(), m, p)


def test_media_links_are_forwarded_raw():
    m = next(x for x in WIRED if x["id"] == "api.kling_4_0")
    g = FakeGraph()
    A.ADAPTERS["kling4"](g, m, base_p(m, "generate_video", first=link("img"), last=link("img_last")))
    (node,) = [n for n in g.nodes.values() if n.class_type == "Kling4ImageToVideoNode"]
    assert node.inputs["model.first_frame"] == link("img")
    assert node.inputs["model.last_frame"] == link("img_last")
    assert node.inputs["model.duration"] == 5  # 97 frames @ 24 fps = 4.04 s -> next whole second


def test_snap_helpers():
    assert A.snap_aspect(1920, 1088, ["auto", "1:1", "16:9", "9:16"]) == "16:9"
    assert A.snap_aspect(1088, 1920, ["16:9", "9:16"]) == "9:16"
    assert A.snap_duration(4.04, {"min": 3, "max": 30}) == 5
    assert A.snap_duration(4.0, {"min": 4, "max": 8}) == 4
    assert A.snap_duration(12, {"min": 4, "max": 8}) == 8
    assert A.snap_duration(6, {"options": [5, 10]}) == 10
    assert A.snap_duration(30, {"options": [5, 10]}) == 10
    assert A.ltx_frames(97) == 97 and A.ltx_frames(100) == 97 and A.ltx_frames(120) == 121


def test_resolve_weights_finds_files_in_subfolders():
    m = next(x for x in WIRED if x["id"] == "open.ltx_2_5")
    files = {"loras": ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"]}
    w = resolve_weights(m, lambda folder: files.get(folder, []))
    assert w["l2r_lora"] == "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"
    assert w["unet"] is None


if __name__ == "__main__" and "--refresh-snapshot" in sys.argv:
    # python tests/test_router_adapters.py --refresh-snapshot [http://127.0.0.1:8189]
    import urllib.request
    base = next((a for a in sys.argv[1:] if a.startswith("http")), "http://127.0.0.1:8189")
    classes = set()
    for mid, stage, i in CASES:
        try:
            _, g, _ = run_adapter(mid, stage, i)
            classes |= {n.class_type for n in g.nodes.values()}
        except (A.RouterError, KeyError):
            pass
    for m in WIRED:
        classes |= set(m["classes"])
    snap = {}
    for c in sorted(classes):
        d = json.load(urllib.request.urlopen(f"{base}/object_info/{c}", timeout=20))
        if c in d:
            snap[c] = {"input": d[c]["input"], "output": d[c]["output"]}
        else:
            print("missing on server:", c)
    json.dump(snap, open(SNAPSHOT, "w"), indent=0, sort_keys=True)
    print(f"wrote {len(snap)} classes to {SNAPSHOT}")
