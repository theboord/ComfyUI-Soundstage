"""tools/validate_workflows.py: every example workflow passes the offline check, and the check catches what it should.

The offline check needs no ComfyUI, torch or GPU: pod /object_info snapshots + Soundstage's own schemas read from the
code (tools/validate/soundstage_schemas.py). Run:  python -m pytest tests/test_validate_workflows.py -q
"""
import copy
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "tools", "validate"))

import validate_workflows as V  # noqa: E402
import soundstage_schemas as SS  # noqa: E402  (module import only; its fakes install on object_info())


@pytest.fixture(scope="module")
def schemas():
    info, notes = V.offline_schemas()
    return info, notes


@pytest.fixture(scope="module")
def workflows():
    return V.load_workflows()


def test_every_example_workflow_passes(schemas, workflows):
    info, notes = schemas
    assert not notes, notes  # every Soundstage node module loaded for the schema read
    documented = V.documented_models()
    bad = {name: r["problems"] for name, wf in workflows.items()
           if (r := V.check_workflow(wf, info, documented))["problems"]}
    assert not bad, json.dumps(bad, indent=1)
    assert len(workflows) >= 10


def test_soundstage_schema_read_covers_every_node_the_workflows_use(schemas, workflows):
    info, _ = schemas
    used = set().union(*(V.node_classes(w) for w in workflows.values()))
    own = {c for c in used if c.startswith("Soundstage")}
    assert own and own <= set(info), sorted(own - set(info))
    assert not [c for c in used if c not in info], sorted(c for c in used if c not in info)


def test_schema_tool_lists_the_same_modules_as_the_extension():
    src = open(os.path.join(ROOT, "soundstage", "nodes_stage.py"), encoding="utf-8").read()
    m = re.search(r"for mod in \(([^)]*)\):", src)
    listed = set(re.findall(r'"(nodes_\w+)"', m.group(1)))
    assert listed | {"nodes_stage"} == set(SS.NODE_MODULES)


def _app(workflows):
    return copy.deepcopy(workflows["Soundstage_App.json"])


def _first(wf, cls):
    for _, g, _ in V.graphs_of(wf):
        for n in g["nodes"]:
            if n["type"] == cls:
                return g, n
    raise AssertionError(cls)


def _problems(wf, info):
    return V.check_workflow(wf, info, V.documented_models())["problems"]


def test_catches_an_unknown_node_type(schemas, workflows):
    wf = _app(workflows)
    _first(wf, "SoundstageStage")[1]["type"] = "SoundstageStageOld"
    assert any("no such node type" in p for p in _problems(wf, schemas[0]))


def test_catches_a_bad_combo_value_and_a_number_out_of_range(schemas, workflows):
    wf = _app(workflows)
    _, n = _first(wf, "CreateVideo")
    n["widgets_values"][n["widgets_values"].index("sRGB")] = "no_such_sampler"
    _, s = _first(wf, "SoundstageStep")
    i = next(i for i, v in enumerate(s["widgets_values"]) if isinstance(v, int))
    s["widgets_values"][i] = 99
    ps = _problems(wf, schemas[0])
    assert any("no_such_sampler" in p for p in ps), ps
    assert any("above the maximum" in p for p in ps), ps


def test_catches_a_model_file_missing_from_models_md(schemas, workflows):
    wf = _app(workflows)
    for _, g, _ in V.graphs_of(wf):
        for n in g["nodes"]:
            if n["type"] == "VAELoader" and not any(i.get("link") for i in n.get("inputs") or []):
                n["widgets_values"][0] = "mystery-vae.safetensors"
                break
        else:
            continue
        break
    else:
        pytest.skip("no unlinked VAELoader")
    assert any("not listed in MODELS.md" in p for p in _problems(wf, schemas[0]))


def test_catches_a_wrong_link_type_and_a_dangling_link(schemas, workflows):
    wf = _app(workflows)
    g, n = _first(wf, "VAEDecodeTiled")
    lid = next(i["link"] for i in n["inputs"] if i["name"] == "vae")
    links = V._links(g)
    src = next(l for l in links if l["id"] == lid)
    # point the VAE input at a node whose output 0 is not a VAE
    info = schemas[0]
    other = next(x for x in g["nodes"] if (info.get(x["type"]) or {}).get("output", ["VAE"])[:1] == ["SAMPLER"]
                 or (info.get(x["type"]) or {}).get("output", ["VAE"])[:1] == ["IMAGE"])
    want = info[other["type"]]["output"][0]
    for raw in g["links"]:
        rid = raw["id"] if isinstance(raw, dict) else raw[0]
        if rid == src["id"]:
            if isinstance(raw, dict):
                raw["origin_id"], raw["origin_slot"] = other["id"], 0
            else:
                raw[1], raw[2] = other["id"], 0
    assert any(f"{want} into VAEDecodeTiled.vae" in p for p in _problems(wf, schemas[0]))
    wf = _app(workflows)
    wf["links"].append([999999, 424242, 0, wf["nodes"][0]["id"], 0, "IMAGE"])
    assert any("424242" in p for p in _problems(wf, schemas[0]))


def test_catches_a_required_socket_left_empty(schemas, workflows):
    wf = _app(workflows)
    _, n = _first(wf, "VAEDecodeTiled")
    for i in n["inputs"]:
        if i["name"] == "samples":
            i["link"] = None
    assert any("required input 'samples'" in p for p in _problems(wf, schemas[0]))
    n["mode"] = 4  # bypassed: ComfyUI does not validate it
    assert not any("required input 'samples'" in p for p in _problems(wf, schemas[0]))


def test_placeholders_go_to_the_loader_folder_and_never_overwrite(tmp_path, workflows):
    wf = {"x": _app(workflows)}
    keep = tmp_path / "models" / "vae" / "ltx-2.5-video-vae-bf16.safetensors"
    keep.parent.mkdir(parents=True)
    keep.write_bytes(b"real")
    made = V.make_placeholders(wf, str(tmp_path))
    assert keep.read_bytes() == b"real"
    assert made and all(os.path.getsize(tmp_path / p) == 0 for p in made)
    assert any(p.startswith(os.path.join("models", "diffusion_models")) for p in made)
    assert not any(p.startswith(os.path.join("models", "loras")) and "unet" in p for p in made)


def test_live_mode_asks_one_class_at_a_time(monkeypatch):
    asked = []

    class R:
        def __init__(self, body):
            self.body = body

        def read(self):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake(url, timeout=0):
        asked.append(url)
        cls = url.rsplit("/", 1)[1]
        return R(json.dumps({cls: {"input": {}, "output": []}} if cls != "Missing" else {}).encode())

    monkeypatch.setattr(V.urllib.request, "urlopen", fake)
    got = V.live_schemas("http://h:8188/", ["UNETLoader", "Missing"])
    assert set(got) == {"UNETLoader"}
    assert asked and all(re.search(r"/object_info/[^/]+$", u) for u in asked)
