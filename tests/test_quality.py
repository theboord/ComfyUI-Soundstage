"""Quality part: knob mapping (0 + Draft == today), the subject-aware motion prompt, and the App wiring."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools" / "app_build"))

from soundstage import quality as Q  # noqa: E402

APP = ROOT / "example_workflows" / "Soundstage_App.json"


def _inner(app, sub_prefix, node_id):
    s = next(x for x in app["definitions"]["subgraphs"] if x["id"].startswith(sub_prefix))
    return next(n for n in s["nodes"] if n["id"] == node_id)


def test_zero_draft_is_todays_app():
    app = json.loads(APP.read_text())
    k = Q.knobs(0.0, False)
    assert k["guide_strength_1"] == 1.0 and k["guide_strength_2"] == 1.0 and k["guide_blur"] == 0
    assert k["sigmas_1"] == _inner(app, "f9337bd7", 4984)["widgets_values"][0]
    assert k["sigmas_2"] == _inner(app, "a8746470", 9028)["widgets_values"][0]
    assert _inner(app, "d92e6f38", 5012)["widgets_values"][1] == 1      # today's stage-1 clay guide strength
    assert _inner(app, "a8746470", 9039)["widgets_values"][1] == 1      # today's stage-2 clay guide strength


def test_freedom_only_softens_never_weakens_the_guide():
    """Guide strength < 1 makes LTX render the clay itself (live horse test, 2026-10-28): it must stay 1.0."""
    prev = Q.knobs(0.0)
    for f in (0.2, 0.4, 0.7, 1.0):
        k = Q.knobs(f)
        assert k["guide_strength_1"] == 1.0 and k["guide_strength_2"] == 1.0
        assert k["guide_blur"] > prev["guide_blur"]
        prev = k
    assert Q.knobs(1.0)["guide_blur"] <= 16
    assert Q.knobs(0.0)["lora_strength"] == 1.0 and 0.6 <= Q.knobs(1.0)["lora_strength"] < Q.knobs(0.4)["lora_strength"] < 1.0


def test_hq_schedules_are_denser_versions_of_draft():
    d, h = Q.knobs(0, False), Q.knobs(0, True)
    parse = lambda s: [float(x) for x in s.split(",")]  # noqa: E731
    for a, b in (("sigmas_1", "sigmas_1"), ("sigmas_2", "sigmas_2")):
        sd, sh = parse(d[a]), parse(h[b])
        assert set(sd) <= set(sh) and len(sh) > len(sd)
        assert sh == sorted(sh, reverse=True) and sh[0] == sd[0] and sh[-1] == 0.0


def _horse_scene():
    rider = lambda i, h: {"id": i, "kind": "man", "mount_id": h, "keys": [{"frame": 0, "position": [0, 0, 0]}]}  # noqa: E731
    gallop = lambda i: {"id": i, "kind": "horse", "keys": [{"frame": 0, "position": [0, 0, -11]},  # noqa: E731
                                                          {"frame": 96, "position": [0, 0, -40]}]}
    return {"shot": {"fps": 24}, "actors": [gallop("h1"), gallop("h2"), rider("r1", "h1"), rider("r2", "h2")]}


def test_motion_prompt_is_subject_aware():
    p = Q.motion_prompt(_horse_scene())
    assert "gallop" in p and "each horse" in p
    assert "both riders ride their horses" in p
    walkers = {"shot": {"fps": 24}, "actors": [{"id": "a", "kind": "woman", "keys": [{"frame": 0, "position": [0, 0, 0]},
                                                                                      {"frame": 96, "position": [0, 0, 5]}]}]}
    w = Q.motion_prompt(walkers)
    assert "walks" in w and "horse" not in w
    still = {"shot": {"fps": 24}, "actors": [{"id": "a", "kind": "man", "keys": [{"frame": 0, "position": [0, 0, 0]}]}]}
    assert "stands naturally" in Q.motion_prompt(still) and "momentum" not in Q.motion_prompt(still)
    assert Q.motion_prompt({"actors": []}) == ""


def test_app_part_wires_every_knob():
    from graph import Graph
    import quality as part

    g = Graph.load(APP)
    part.apply(g)
    q = next(n for n in g.nodes.values() if n["type"] == "SoundstageQuality")
    outs = {o["name"]: [g.links[l][3:5] for l in (o.get("links") or [])] for o in q["outputs"]}
    assert [9002, g._slot(9002, "guide_image", "inputs")] in outs["out_guide"]
    assert [9034, g._slot(9034, "image_1", "inputs")] in outs["out_guide"]
    assert outs["guide_strength_1"] == [[9002, g._slot(9002, "guide_strength", "inputs")]]
    assert outs["sigmas_1"] == [[5516, g._slot(5516, "sigmas", "inputs")]]
    assert outs["out_motion_prompt"] == [[5014, g._slot(5014, "value_2", "inputs")]]
    assert outs["lora_strength"] == [[5004, g._slot(5004, "lora strength", "inputs")]]
    # The look still on stage 2 is untouched; the clay guide source now only feeds the Quality node.
    assert g.source_of(9034, "image") == (9057, 0)
    # Promoted inputs reach the inner nodes.
    sub = next(s for s in g.w["definitions"]["subgraphs"] if s["id"].startswith("d92e6f38"))
    inner = next(n for n in sub["nodes"] if n["id"] == 5012)
    lid = next(i["link"] for i in inner["inputs"] if i["name"] == "strength")
    assert any(l["id"] == lid and l["origin_id"] == -10 for l in sub["links"])
    keys = [k[0] for k in g.w["extra"]["linearData"]["inputs"]]
    assert f"{g.graph_id}:{q['id']}:motion_freedom" in keys and f"{g.graph_id}:{q['id']}:quality" in keys
    part.apply(g)  # idempotent
    assert sum(n["type"] == "SoundstageQuality" for n in g.nodes.values()) == 1
