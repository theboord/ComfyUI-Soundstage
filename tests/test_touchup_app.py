"""tools/app_build/touchup.py adds the Canvas-tab touch-up between the look still and motion, default off."""
import importlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "app_build"))

from graph import Graph  # noqa: E402

BASE = os.path.join(ROOT, "example_workflows", "Soundstage_App.json")


def build(parts):
    g = Graph.load(BASE)
    for p in parts:
        importlib.import_module(p).apply(g)
    return g


def node(g, title):
    return next(n for n in g.nodes.values() if n.get("title") == title)


def check(parts, expected_src):
    before = build([p for p in parts if p != "touchup"])
    old = before.consumers(*expected_src)
    g = build(parts)
    sw = node(g, "Use touched-up still")
    still = node(g, "Touch-up · canvas still")
    assert sw["type"] == "ComfySwitchNode" and sw["widgets_values"] == [False]
    assert g.source_of(sw["id"], "on_false") == expected_src
    assert g.source_of(sw["id"], "on_true") == (still["id"], 0)
    assert still["type"] == "SoundstageCanvasImage" and still["widgets_values"] == [""]
    assert not any(n["type"] == "VNCCS_UniCanvas" for n in g.nodes.values())
    # every former consumer of the still (gate 9061 -> Rung 2 preview, L2R 9002, stage-2 9034, ...) reads the switch
    assert old and all(g.source_of(d, s) == (sw["id"], 0) for d, s in old)
    assert g.consumers(*expected_src) == [(sw["id"], 0)]
    readers = {d for d, _ in g.consumers(sw["id"], 0)}
    assert {9061, 9002} <= readers  # Gate rung 2 (-> "Rung 2 · Look still") and the L2R look_still
    keys = [k[0] for k in g.w["extra"]["linearData"]["inputs"]]
    assert f"{g.graph_id}:{sw['id']}:switch" in keys
    assert not any(k.endswith((":unicanvas_ui", ":unicanvas_state")) for k in keys)  # no canvas widget in the App panel
    return g


def test_touchup_alone_chains_after_the_base_still_picker():
    # Soundstage_App.json carries the still-model picker itself (9082: Krea 2 9057 off, FLUX 3 Klein 9081 on).
    check(["touchup"], (9082, 0))


def test_touchup_chains_after_the_model_picker():
    g = build(["models"])
    picker = next(n["id"] for n in g.nodes.values() if (n.get("title") or "").startswith("Still model · use picker"))
    g = check(["models", "touchup"], (picker, 0))
    # the still-model picker still sees the raw Krea still on its off branch
    assert g.source_of(picker, "on_false") == (9057, 0)


def test_idempotent_and_full_build_order():
    g = build(["models", "touchup", "touchup", "audio", "outputs"])
    assert sum(n.get("title") == "Use touched-up still" for n in g.nodes.values()) == 1
    sys.path.insert(0, os.path.join(ROOT, "tools", "app_build"))
    parts = importlib.import_module("build").PARTS
    assert parts.index("models") < parts.index("touchup") < parts.index("audio")
