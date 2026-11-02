"""Seamless loop graph (soundstage/loop/graphs.py): valid against the pod's /object_info (tests/test_loop_object_info.json
plus the footage/motion snapshots), starts and ends on the same picture, and a bridge goes between two pictures.
Run:  python -m pytest tests/test_loop_graphs.py -q
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from soundstage.loop import graphs as LG  # noqa: E402

SNAPS = ["test_footage_object_info.json", "test_motion_object_info.json", "test_loop_object_info.json"]
W = {r: names[0] for r, (f, names) in LG.LOOP_WEIGHTS.items()}


@pytest.fixture(autouse=True)
def _snapshot(monkeypatch):
    merged = {}
    for s in SNAPS:
        p = os.path.join(HERE, s)
        if os.path.exists(p):
            merged.update(json.load(open(p)))
    monkeypatch.setattr(TF, "OI", merged)


def as_graph(prompt):
    g = TF.Graph()
    for nid, n in prompt.items():
        g.nodes[nid] = TF.Node(nid, n["class_type"], n["inputs"])
    return g


@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("sound", [True, False])
def test_loop_prompt_valid(quality, sound):
    p = LG.build(W, source="soundstage/look_00001_.png [output]", width=1712, height=912, seconds=4, quality=quality,
                 sound=sound, prompt="waves roll in")
    assert TF.check(as_graph(p)) == []
    assert p["save"]["class_type"] == "SaveVideo"
    assert ("audio" in p[p["save"]["inputs"]["video"][0]]["inputs"]) == sound


def test_loop_holds_the_same_picture_at_both_ends():
    p = LG.build(W, source="a.png [input]", width=1600, height=900, seconds=4)
    inplace = [n for n in p.values() if n["class_type"] == "LTXVImgToVideoInplace"]
    guides = [n for n in p.values() if n["class_type"] == "LTXVAddGuide"]
    assert len(inplace) == 1 and len(guides) == 1
    assert guides[0]["inputs"]["frame_idx"] == -1
    assert guides[0]["inputs"]["image"] == inplace[0]["inputs"]["image"]   # the same resized picture
    assert [n for n in p.values() if n["class_type"] == "SoundstageImageLoad"][0]["inputs"]["source"] == "a.png [input]"
    assert "loops perfectly" in [n for n in p.values() if n["class_type"] == "CLIPTextEncode"][0]["inputs"]["text"]


def test_final_adds_the_guides_again_at_double_size():
    p = LG.build(W, source="a.png [input]", width=1600, height=900, seconds=4, quality="Final")
    guides = [n for n in p.values() if n["class_type"] == "LTXVAddGuide"]
    crops = [n for n in p.values() if n["class_type"] == "LTXVCropGuides"]
    assert len(guides) == 2 and len(crops) == 2
    sizes = sorted(n["inputs"]["resize_type.width"] for n in p.values() if n["class_type"] == "ResizeImageMaskNode")
    assert sizes[-1] == 2 * sizes[0]


def test_bridge_goes_between_two_pictures():
    p = LG.build(W, source="last.png [input]", end_source="first.png [input]", width=992, height=544, seconds=1.0,
                 bridge=True)
    assert TF.check(as_graph(p)) == []
    loads = {n["inputs"]["source"] for n in p.values() if n["class_type"] == "SoundstageImageLoad"}
    assert loads == {"last.png [input]", "first.png [input]"}
    g = [n for n in p.values() if n["class_type"] == "LTXVAddGuide"][0]
    i = [n for n in p.values() if n["class_type"] == "LTXVImgToVideoInplace"][0]
    assert g["inputs"]["image"] != i["inputs"]["image"]
    assert "loops perfectly" not in json.dumps(p)


@pytest.mark.parametrize("secs,frames", [(4, 97), (2, 49), (0.5, 17), (1.0, 25), (5, 121), (3.7, 89)])
def test_ltx_frames(secs, frames):
    assert LG.ltx_frames(secs) == frames
    assert (frames - 1) % 8 == 0


def test_render_size_keeps_aspect():
    w, h = LG.render_size(1712, 912)
    assert h == 544 and w % 32 == 0 and abs(w / h - 1712 / 912) < 0.06
    w, h = LG.render_size(900, 1600)
    assert w == 544 and h % 32 == 0
    w, h = LG.render_size(4000, 1000)   # very wide: longer side capped
    assert w <= 1024


def test_prompt_builder_ids():
    g = LG.Prompt("x")
    a = g.node("A", v=1)
    b = g.node("B", id="save", a=a.out(0))
    assert g.json() == {"x1": {"class_type": "A", "inputs": {"v": 1}}, "save": {"class_type": "B", "inputs": {"a": ["x1", 0]}}}
    assert b.out(2) == ["save", 2]
