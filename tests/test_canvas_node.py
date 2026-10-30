"""SoundstageCanvasImage: reads the Canvas tab's PNG from input/, refuses to leave it, explains an empty path."""
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import test_cine_nodes  # noqa: E402,F401  (comfy_api stand-in when ComfyUI is absent)

_IO = sys.modules["comfy_api.latest"].IO
if not hasattr(_IO, "Image"):  # the shared stand-in predates image outputs
    _IO.Image = _IO.String


@pytest.fixture()
def canvas(tmp_path, monkeypatch):
    fp = types.ModuleType("folder_paths")
    fp.get_input_directory = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    from soundstage import nodes_canvas
    return nodes_canvas, tmp_path


def _values(out):
    return getattr(out, "values", None) or getattr(out, "result", None) or out.args


def test_schema(canvas):
    nc, _ = canvas
    s = nc.SoundstageCanvasImage.define_schema()
    assert s.node_id == "SoundstageCanvasImage" and s.category == "Soundstage"
    assert [c.__name__ for c in nc.NODES] == ["SoundstageCanvasImage"]


def test_empty_path_explains(canvas):
    nc, _ = canvas
    with pytest.raises(ValueError, match="Use as look still"):
        nc.SoundstageCanvasImage.execute(image="")


def test_path_must_stay_in_input(canvas):
    nc, _ = canvas
    with pytest.raises(ValueError, match="inside the input folder"):
        nc.resolve_input_path("../../etc/passwd")


def test_loads_rgb(canvas):
    pytest.importorskip("torch")
    from PIL import Image
    nc, tmp = canvas
    os.makedirs(tmp / "soundstage")
    Image.new("RGBA", (64, 32), (255, 0, 0, 128)).save(tmp / "soundstage" / "look.png")
    (img,) = _values(nc.SoundstageCanvasImage.execute(image="soundstage/look.png"))
    assert tuple(img.shape) == (1, 32, 64, 3)
    assert nc.SoundstageCanvasImage.fingerprint_inputs("soundstage/look.png").startswith("soundstage/look.png:")
