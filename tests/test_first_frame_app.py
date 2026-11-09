"""The picked frame is the video's real first frame in the App's motion graph (stage 1 and stage 2), switchable.

Before: frame 1 reached LTX only as the look-reference IC guide at frame_idx -1 (9002:9042, 9034:9043), so the model
was free to change the person's face from f0, and a stage 2 without guides never saw frame 1 at all. A Maya S2 re-run
with LTXVImgToVideoInplace (strength 1) on frame 1 in both stages opened on the chosen frame and held the face longer.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import ltx_settings as L  # noqa: E402

APPS = ["Soundstage_App", "Soundstage_App_Full", "Soundstage_Car_Chase", "Soundstage_In_The_Car",
        "Soundstage_Three_In_A_Car", "Soundstage_Western"]


def _sub(wf, inner):
    return next(s for s in wf["definitions"]["subgraphs"] if any(n["id"] == inner for n in s["nodes"]))


def _check_stage(sub, src, dst, look):
    nodes = {n["id"]: n for n in sub["nodes"]}
    links = {l["id"]: l for l in sub["links"]}
    i2v = [n for n in sub["nodes"] if n["type"] == "LTXVImgToVideoInplace"]
    assert len(i2v) == 1
    n = i2v[0]
    assert n["widgets_values"] == [1, False] and n.get("mode", 0) == 0     # strength 1, on, not muted/bypassed
    by = {i["name"]: links[i["link"]] for i in n["inputs"] if i.get("link") is not None}
    assert by["latent"]["origin_id"] == src                                # on the stage's own latent
    out = links[n["outputs"][0]["links"][0]]
    assert (out["target_id"], out["target_slot"]) == (dst, 3) and nodes[dst]["inputs"][3]["link"] == out["id"]
    look_link = links[next(i["link"] for i in nodes[look]["inputs"] if i["name"] == "image")]
    assert by["image"]["origin_id"] == -10 and by["image"]["origin_slot"] == look_link["origin_slot"]   # the chosen frame
    assert sub["inputs"][by["vae"]["origin_slot"]]["name"] == "vae"
    # Link bookkeeping: every node socket points at a link that points back, every subgraph input lists its links.
    for x in sub["nodes"]:
        for slot, i in enumerate(x.get("inputs", [])):
            if i.get("link") is not None:
                assert (links[i["link"]]["target_id"], links[i["link"]]["target_slot"]) == (x["id"], slot)
    for k, i in enumerate(sub["inputs"]):
        assert sorted(i["linkIds"]) == sorted(l["id"] for l in sub["links"] if l["origin_id"] == -10 and l["origin_slot"] == k)


@pytest.mark.parametrize("name", APPS)
def test_app_workflows_condition_frame_0_on_the_chosen_frame_in_both_stages(name):
    wf = json.loads((ROOT / "example_workflows" / f"{name}.json").read_text())
    _check_stage(_sub(wf, 9042), 3059, 5012, 9042)     # stage 1: EmptyLTXVLatentVideo -> I2V -> clay guide
    _check_stage(_sub(wf, 9043), 9025, 9039, 9043)     # stage 2: latent upsampler -> I2V -> clay guide
    # The look guide stays at frame_idx -1 in both stages.
    assert _sub(wf, 9042)["nodes"][[n["id"] for n in _sub(wf, 9042)["nodes"]].index(9042)]["widgets_values"][0] == -1
    ids = [n["id"] for n in wf["nodes"]] + [n["id"] for s in wf["definitions"]["subgraphs"] for n in s["nodes"]]
    assert len(ids) == len(set(ids)) and wf["last_node_id"] >= max(ids)
    lids = [l[0] for l in wf["links"]] + [l["id"] for s in wf["definitions"]["subgraphs"] for l in s["links"]]
    assert wf["last_link_id"] >= max(lids)


def test_build_carries_the_first_frame_into_the_full_app(tmp_path):
    sys.path.insert(0, str(ROOT / "tools" / "app_build"))
    import build  # noqa: E402
    dst = tmp_path / "full.json"
    build.main(ROOT / "example_workflows" / "Soundstage_App.json", dst)
    wf = json.loads(dst.read_text())
    _check_stage(_sub(wf, 9042), 3059, 5012, 9042)
    _check_stage(_sub(wf, 9043), 9025, 9039, 9043)


def _prompt(advanced="", bypass=False):
    return {"9096": {"class_type": "SoundstageQuality", "inputs": {"quality": "Final", "advanced": advanced}},
            "9002:9083": {"class_type": "LTXVImgToVideoInplace", "inputs": {"strength": 1, "bypass": bypass}},
            "9034:9084": {"class_type": "LTXVImgToVideoInplace", "inputs": {"strength": 1, "bypass": bypass}}}


def test_first_frame_is_on_by_default_and_switchable_per_shot():
    assert L.resolve({})["first_frame"] is True
    assert L.resolve({"first_frame": False})["first_frame"] is False
    assert L.resolve({"first_frame": "off"})["first_frame"] is False
    assert L.from_quality("Draft")["first_frame"] is True
    p = L.apply_first_frame(_prompt(bypass=True))                              # an old saved graph: turned back on
    assert [p[k]["inputs"]["bypass"] for k in ("9002:9083", "9034:9084")] == [False, False]
    p = L.apply_first_frame(_prompt(json.dumps({"preset": "Final", "first_frame": False})))
    assert [p[k]["inputs"]["bypass"] for k in ("9002:9083", "9034:9084")] == [True, True]
    linked = _prompt(json.dumps({"preset": "Final", "first_frame": False}), bypass=["1", 0])
    assert L.apply_first_frame(linked)["9002:9083"]["inputs"]["bypass"] == ["1", 0]   # a linked bypass is left alone
    other = {"1": {"class_type": "LTXVImgToVideoInplace", "inputs": {"bypass": True}}}
    assert L.apply_first_frame(other)["1"]["inputs"]["bypass"] is True                # not a Soundstage prompt


def test_on_prompt_handler_switches_the_first_frame():
    from soundstage.takecheck import routes as RT
    body = {"prompt": _prompt(json.dumps({"preset": "Draft", "first_frame": False}))}
    assert RT.on_prompt_reference(body)["prompt"]["9034:9084"]["inputs"]["bypass"] is True
