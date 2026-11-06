"""Shipped workflows must not store CreateVideo's optional defaults.

UI workflows store widget values by position, so a stored default lands in the wrong widget as soon as ComfyUI inserts
a new optional input ahead of it (0.44.0 added chroma_subsampling before codec, and the stored "none" failed validation).
A value left out keeps the widget's own default on any ComfyUI, so only what differs from the default is stored.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Position 0 is fps (always stored). These follow it in widgets_values, in the order the workflows were saved.
OPTIONAL_DEFAULTS = ("auto", "sRGB", "none")


def _create_videos():
    for path in sorted((ROOT / "example_workflows").glob("*.json")):
        wf = json.loads(path.read_text(encoding="utf-8"))
        graphs = [wf, *wf.get("definitions", {}).get("subgraphs", [])]
        for graph in graphs:
            for node in graph.get("nodes", []):
                if node.get("type") == "CreateVideo":
                    yield path.name, node["id"], node.get("widgets_values")


def test_the_check_sees_the_shipped_create_video_nodes():
    assert len({name for name, _, _ in _create_videos()}) == 8


def test_no_shipped_create_video_stores_a_trailing_default():
    for name, node_id, values in _create_videos():
        assert isinstance(values, list) and values, (name, node_id)
        assert isinstance(values[0], (int, float)), (name, node_id, values)   # fps
        optional = values[1:]
        assert len(optional) <= len(OPTIONAL_DEFAULTS), (name, node_id, values)
        if optional:
            assert optional[-1] != OPTIONAL_DEFAULTS[len(optional) - 1], (name, node_id, values)
        assert "none" not in optional, (name, node_id, values)


def test_the_builder_does_not_write_the_defaults_back():
    source = (ROOT / "tools" / "app_build" / "audio.py").read_text(encoding="utf-8")
    assert '"sRGB", "none"' not in source
