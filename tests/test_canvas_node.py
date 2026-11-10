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


def test_annotated_output_and_temp_names(canvas, tmp_path, monkeypatch):
    """⑤ Motion hands the video the picked ④ frame itself: "look_00010_.png [output]" / "x.png [temp]" resolve in
    those folders (walkthrough 2026-11-10), and still can't leave them."""
    nc, inp = canvas
    import sys as _s
    fp = _s.modules["folder_paths"]
    out, tmp = tmp_path / "out", tmp_path / "tmpdir"
    out.mkdir(); tmp.mkdir()
    fp.get_output_directory = lambda: str(out)
    fp.get_temp_directory = lambda: str(tmp)
    assert nc.resolve_input_path("look_00010_.png [output]") == os.path.realpath(out / "look_00010_.png")
    assert nc.resolve_input_path("sub/x.png [temp]") == os.path.realpath(tmp / "sub" / "x.png")
    assert nc.resolve_input_path("soundstage_frames/a.png [input]") == os.path.realpath(inp / "soundstage_frames" / "a.png")
    assert nc.resolve_input_path("soundstage_frames/a.png") == os.path.realpath(inp / "soundstage_frames" / "a.png")
    with pytest.raises(ValueError, match="inside the input folder"):
        nc.resolve_input_path("../../etc/passwd [output]")


def test_missing_picked_frame_says_so(canvas, tmp_path):
    nc, _ = canvas
    import sys as _s
    _s.modules["folder_paths"].get_output_directory = lambda: str(tmp_path)
    with pytest.raises(ValueError, match="pick the frame again"):
        nc.SoundstageCanvasImage.execute(image="gone_00001_.png [output]")


def test_loads_picked_output_frame(canvas, tmp_path):
    pytest.importorskip("torch")
    from PIL import Image
    nc, _ = canvas
    import sys as _s
    out = tmp_path / "o"; out.mkdir()
    _s.modules["folder_paths"].get_output_directory = lambda: str(out)
    Image.new("RGB", (48, 24), (10, 20, 30)).save(out / "look_00010_.png")
    (img,) = _values(nc.SoundstageCanvasImage.execute(image="look_00010_.png [output]"))
    assert tuple(img.shape) == (1, 24, 48, 3)
