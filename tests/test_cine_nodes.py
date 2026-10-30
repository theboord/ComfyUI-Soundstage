"""The V3 node classes: schemas build and execute() runs. Uses the real comfy_api when importable
(on the pod), otherwise a minimal stand-in that records schema arguments."""
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _install_stub():
    class _Rec:
        def __init__(self, *args, **kwargs):
            self.args, self.kwargs = args, kwargs
            for k, v in kwargs.items():
                setattr(self, k, v)
            if args:
                self.id = args[0]

    class _Type:
        Input = Output = _Rec

    class NodeOutput:
        def __init__(self, *values, ui=None):
            self.values, self.ui = values, ui

    io = types.SimpleNamespace(ComfyNode=object, Schema=_Rec, NodeOutput=NodeOutput,
                               String=_Type, Combo=_Type, Int=_Type, Float=_Type, Boolean=_Type)
    latest = types.ModuleType("comfy_api.latest")
    latest.IO = io
    pkg = types.ModuleType("comfy_api")
    pkg.latest = latest
    sys.modules.setdefault("comfy_api", pkg)
    sys.modules.setdefault("comfy_api.latest", latest)


try:
    import comfy_api.latest  # noqa: F401
except Exception:  # local dev box: no ComfyUI / torch
    _install_stub()

from soundstage import nodes_cine  # noqa: E402

DEFAULTS = dict(beat="", genre="auto", movement="auto", technique="auto", intent="auto", coverage="auto",
                max_shots=0, fps=24.0, preview_shot=1, backend="rules")


def _values(out):
    return getattr(out, "values", None) or getattr(out, "result", None) or out.args


def test_nodes_export_and_prefix():
    assert [c.__name__ for c in nodes_cine.NODES] == ["SoundstageAdvisor", "SoundstageAdvisorBrief",
                                                      "SoundstageShotPrompt", "SoundstageCoverageDoctor"]
    for cls in nodes_cine.NODES:
        schema = cls.define_schema()
        assert schema.node_id.startswith("Soundstage")
        assert schema.category == "Soundstage"
        ids = [getattr(x, "id", None) for x in list(schema.inputs) + list(schema.outputs)]
        assert None not in ids and len(ids) == len(set(ids)), f"{cls.__name__}: V3 needs unique input/output ids"


def test_pickers_list_kb_entries():
    labels = nodes_cine._choices("technique")
    assert labels[:2] == ["auto", "none"]
    assert any("[technique.spaghetti_standoff]" in x for x in labels)


def test_advisor_shot_prompt_and_doctor_chain():
    out = _values(nodes_cine.SoundstageAdvisor.execute(
        scene="Two gunfighters face off in a dusty street at noon.", **DEFAULTS))
    shot_list_json, summary, camera_json, ltx, still, negative, frames = out
    sl = json.loads(shot_list_json)
    assert sl["backend"] == "rules" and "WHY" in summary
    assert set(json.loads(camera_json)) == {"camera", "camera_end"}
    assert frames % 8 == 1 and ltx and still and negative

    p = _values(nodes_cine.SoundstageShotPrompt.execute(shot_list_json=shot_list_json, shot=7,
                                                        extra_detail="a silver pocket watch chain"))
    assert "pushes in" in p[0] and "pocket watch" in p[1] and p[3].startswith("[Shot 7]")

    d = _values(nodes_cine.SoundstageCoverageDoctor.execute(shot_list_json=shot_list_json))
    assert d[0].startswith("Coverage Doctor") and d[2] is True


def test_advisor_picks_by_label():
    label = next(x for x in nodes_cine._choices("movement") if "french_new_wave" in x)
    out = _values(nodes_cine.SoundstageAdvisor.execute(
        scene="A first date in a diner.", **{**DEFAULTS, "movement": label, "max_shots": 3}))
    sl = json.loads(out[0])
    assert len(sl["shots"]) == 3 and sl["picks"]["movement"] == label


def test_brief_for_textgenerate():
    system, prompt = _values(nodes_cine.SoundstageAdvisorBrief.execute(
        scene="A detective alone in a rain-soaked office at night.", beat="", genre="auto", movement="auto",
        technique="auto", intent="auto", coverage="auto", max_shots=5))
    assert "JSON" in system and json.loads(prompt)["max_shots"] == 5
