"""SoundstagePlateLock, SoundstageFollowCrop and SoundstageRecastComposite: schemas build and execute() runs on
synthetic plates. Uses the real comfy_api when importable (on the pod), otherwise the shared stand-in."""
import json
import sys
import types
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import test_cine_nodes  # noqa: E402,F401  (comfy_api stand-in when ComfyUI is absent)

_IO = sys.modules["comfy_api.latest"].IO
for _name in ("Image", "Mask", "Video", "Audio", "DynamicCombo"):
    if not hasattr(_IO, _name):
        setattr(_IO, _name, _IO.String)
if not hasattr(_IO, "Custom"):
    _IO.Custom = lambda name: _IO.String
if not hasattr(_IO, "Hidden"):
    _IO.Hidden = types.SimpleNamespace(unique_id="unique_id", auth_token_comfy_org="a", api_key_comfy_org="k")
_latest = sys.modules["comfy_api.latest"]
if not hasattr(_latest, "InputImpl"):
    _latest.InputImpl = types.SimpleNamespace()
for _mod, _attrs in (("folder_paths", {"get_filename_list": lambda f: [], "get_input_directory": lambda: "/tmp"}),
                     ("nodes", {"NODE_CLASS_MAPPINGS": {}}),
                     ("comfy_execution", {}), ("comfy_execution.graph_utils", {"GraphBuilder": object})):
    if _mod not in sys.modules:
        m = types.ModuleType(_mod)
        for k, v in _attrs.items():
            setattr(m, k, v)
        sys.modules[_mod] = m

from soundstage import nodes_footage as NF  # noqa: E402
from tests.test_platelock import add_box, model_render, plate_clip, small_performer  # noqa: E402


def _vals(o):
    return getattr(o, "values", None) or getattr(o, "result", None) or o.args


def test_node_list_and_schemas():
    names = [n.__name__ for n in NF.NODES]
    assert "SoundstagePlateLock" in names and "SoundstageFollowCrop" in names
    for cls in (NF.SoundstagePlateLock, NF.SoundstageFollowCrop, NF.SoundstageRecastComposite):
        cls.define_schema()


def test_plate_lock_node_returns_composite_matte_and_report():
    plate = plate_clip(t=3, h=192, w=320)
    gen = add_box(model_render(plate), 32, 64, 40, 88)
    out = NF.SoundstagePlateLock.execute(plate, gen, "local", 0.5, 1.0, 4, 4.0)
    comp, matte, js = _vals(out)
    rep = json.loads(js)
    assert comp.shape == plate.shape and matte.shape == plate.shape[:3]
    assert rep["psnr_outside_db"] == "inf" and rep["bit_identical_pct"] > 70
    assert out.ui["text"][1] == js and "bit-identical" in out.ui["text"][0]


def test_follow_crop_and_recast_composite_nodes_round_trip():
    plate = plate_clip(t=13, h=120, w=200)
    sub = small_performer()
    imgs, csub, coth, crop_json = _vals(NF.SoundstageFollowCrop.execute(plate, sub, "auto", 0.4, 1.45, 12, 4.0))
    info = json.loads(crop_json)
    assert info["follow"] and len(info["rects"]) == 13 and imgs.shape == plate.shape
    assert float(coth.sum()) == 0 and float(csub.sum()) > float(sub.sum())    # the performer is bigger in the crop
    swap = imgs.clone()
    swap[csub > 0.5] = torch.tensor([0.1, 0.2, 0.9])
    comp, layer, alpha, js = _vals(NF.SoundstageRecastComposite.execute(
        plate, swap, sub, 3, 3, 1, False, "stretch", crop_json=crop_json, tone_fit=True, reach=8, regrain=1.0))
    assert torch.equal(comp[alpha == 0], plate[alpha == 0])
    rep = json.loads(js)
    assert rep["mode"] == "recast" and rep["psnr_outside_db"] == "inf"
    # big subject, auto: frames pass through untouched
    big = torch.zeros(13, 120, 200)
    big[:, 10:110, 60:140] = 1
    imgs2, *_rest, cj = _vals(NF.SoundstageFollowCrop.execute(plate, big, "auto", 0.4, 1.45, 12, 4.0))
    assert imgs2 is plate and not json.loads(cj)["follow"]
