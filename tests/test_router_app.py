"""tools/app_build/models.py wires the model pickers into the App without changing the default path."""
import importlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "app_build"))

from graph import Graph  # noqa: E402

BASE = os.path.join(ROOT, "example_workflows", "Soundstage_App.json")


def built():
    g = Graph.load(BASE)
    importlib.import_module("models").apply(g)
    return g


def by_title(g, prefix):
    return next(n["id"] for n in g.nodes.values() if (n.get("title") or "").startswith(prefix))


def test_default_path_goes_through_switches_set_off():
    base, g = Graph.load(BASE), built()
    sw_still, sw_video = by_title(g, "Still model · use picker"), by_title(g, "Video model · use picker")
    assert g.nodes[sw_still]["widgets_values"] == [False] and g.nodes[sw_video]["widgets_values"] == [False]
    assert g.source_of(sw_still, "on_false") == (9057, 0)
    assert g.source_of(sw_video, "on_false") == (5518, 0)
    # every old consumer of the look still / final video now reads the switch instead
    for dst, slot in base.consumers(9057, 0):
        assert g.source_of(dst, slot) == (sw_still, 0)
    for dst, slot in base.consumers(5518, 0):
        assert g.source_of(dst, slot) == (sw_video, 0)
    assert g.consumers(9057, 0) == [(sw_still, 0)] and g.consumers(5518, 0) == [(sw_video, 0)]


def test_router_inputs():
    g = built()
    still, video = by_title(g, "Still model (any)"), by_title(g, "Video model (any)")
    assert g.source_of(still, "image") == (9045, 9) and g.source_of(still, "control_image") == (9045, 3)
    assert g.source_of(still, "prompt") == (9079, 0) and g.source_of(still, "negative") == (9079, 1)
    assert g.source_of(video, "prompt") == (9079, 2) and g.source_of(video, "control_video") == (9045, 0)
    assert g.source_of(video, "first_frame") == (by_title(g, "Still model · use picker"), 0)
    assert g.source_of(video, "frames") == (9045, 5) and g.source_of(video, "fps") == (9045, 4)
    for nid in (still, video):  # random seeds would invalidate the ladder's cached rungs every queue
        assert "fixed" in g.nodes[nid]["widgets_values"]


def test_app_panel_exposes_toggles_and_models():
    g = built()
    keys = [k[0].split(":", 1)[1] for k in g.w["extra"]["linearData"]["inputs"]]
    for prefix, widget in (("Still model · use picker", "switch"), ("Still model (any)", "model"),
                           ("Video model · use picker", "switch"), ("Video model (any)", "model")):
        assert f"{by_title(g, prefix)}:{widget}" in keys
