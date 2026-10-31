"""⑤ Motion's Ripple edit and Pose follow expansions build valid graphs (checked against
tests/test_motion_object_info.json, an /object_info snapshot of the pod, with the footage tests' checker), mirror
the reference Ripple workflow, and the timing helpers retime clips to LTX lengths. No ComfyUI, torch or GPU needed.
Run:  python -m pytest tests/test_motion_graphs.py -q
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from soundstage import fill_math as F  # noqa: E402
from soundstage.motion import graphs as MG  # noqa: E402
from soundstage.motion import timing as T  # noqa: E402
from soundstage.router.fill_graph import fill_prompt  # noqa: E402

SNAP = os.path.join(HERE, "test_motion_object_info.json")
OI = json.load(open(SNAP)) if os.path.exists(SNAP) else {}
needs_snap = pytest.mark.skipif(not OI, reason="no object_info snapshot")
W_RIPPLE = {r: names[0] for r, (f, names) in MG.RIPPLE_WEIGHTS.items()}
W_POSE = {r: names[0] for r, (f, names) in MG.POSE_WEIGHTS.items()}


@pytest.fixture(autouse=True)
def _snapshot(monkeypatch):
    merged = dict(TF.OI)
    merged.update(json.loads(json.dumps(OI)))
    # Autogrow inputs named by prefix (BatchImagesNode: images.image0, image1, ...): spell the names out for the checker.
    for spec in merged.get("BatchImagesNode", {}).get("input", {}).get("required", {}).values():
        t = spec[1].get("template") if spec[0] == "COMFY_AUTOGROW_V3" else None
        if t and not t.get("names"):
            t["names"] = [f"{t.get('prefix', 'image')}{i}" for i in range(t.get("max", 50))]
    monkeypatch.setattr(TF, "OI", merged)


def ripple_graph(**kw):
    g = TF.Graph()
    p = {"images": TF.up("plate"), "edited": TF.up("first"), "frames": 121, "fps": 24.0, "width": 992, "height": 544,
         "prompt": "", "seed": 7, "strength": 1.35, "quality": "Draft", "color_match": "off"}
    p.update(kw)
    return g, MG.ripple(g, W_RIPPLE, p)


@needs_snap
@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("cm", ["off", "edited frame", "source"])
def test_ripple_graph_valid(quality, cm):
    g, out = ripple_graph(quality=quality, color_match=cm)
    assert TF.check(g) == []
    assert (g.of("ColorTransfer") != []) == (cm != "off")


def test_ripple_matches_reference_workflow():
    g, _ = ripple_graph(strength=1.6)
    lora = g.of("LoraLoaderModelOnly")[0].inputs
    assert lora["lora_name"] == "LTX25_Ripple_v11.safetensors" and lora["strength_model"] == 1.6
    gd = g.of("LTXAddVideoICLoRAGuide")[0].inputs
    assert (gd["frame_idx"], gd["strength"], gd["latent_downscale_factor"], gd["crop"]) == (0, 1.0, 1.0, "disabled")
    # guide = [edited frame 1, source frames...] cut to the clip length
    batch = g.of("BatchImagesNode")[0].inputs
    first, rest = g.nodes[batch["images.image0"][0]], g.nodes[batch["images.image1"][0]]
    assert first.inputs["input"] == TF.up("first") and rest.inputs["input"] == TF.up("plate")
    sl = g.nodes[gd["image"][0]].inputs
    assert (sl["batch_index"], sl["length"]) == (0, 121)
    sch = g.of("BasicScheduler")[0].inputs
    assert (sch["scheduler"], sch["steps"], sch["denoise"]) == ("simple", 25, 1.0)
    assert g.of("KSamplerSelect")[0].inputs["sampler_name"] == "euler"
    assert g.of("CFGGuider")[0].inputs["cfg"] == 1.0
    pos = [n for n in g.of("CLIPTextEncode") if n.inputs["text"].startswith("Use the reference video")]
    assert len(pos) == 1
    assert g.of("LTXVCropGuides")


def test_ripple_prompt_keeps_instruction():
    assert MG.ripple_prompt("") == MG.RIPPLE_PREFIX
    assert MG.ripple_prompt("night").endswith("\n\nnight") and MG.ripple_prompt("night").startswith(MG.RIPPLE_PREFIX)


@pytest.mark.parametrize("w,h,q,want", [(360, 480, "Draft", (544, 736)), (360, 480, "Final", (768, 1024)),
                                         (992, 544, "Draft", (992, 544)), (1920, 1088, "Final", (1344, 768)),
                                         (3840, 1080, "Final", (1920, 544))])
def test_ripple_size(w, h, q, want):
    got = MG.ripple_size(w, h, q)
    assert got == want and got[0] % 32 == 0 and got[1] % 32 == 0


@needs_snap
@pytest.mark.parametrize("draft", [True, False])
def test_pose_follow_from_skeletons(draft):
    g = TF.Graph()
    MG.pose_follow(g, W_POSE, {"guide": TF.up("plate"), "first": TF.up("first"), "fps": 24.0, "width": 1280,
                               "height": 720, "prompt": "two riders", "seed": 3, "draft": draft})
    assert TF.check(g) == []
    assert not g.of("DWPreprocessor")          # the stage's own skeletons, no pose detector
    lora = g.of("LTXICLoRALoaderModelOnly")[0].inputs
    assert "union-control" in lora["lora_name"]
    assert len(g.of("LTXVImgToVideoInplace")) == (1 if draft else 2)


@needs_snap
def test_pose_follow_from_footage_runs_dwpose_ungated():
    g = TF.Graph()
    MG.pose_follow(g, W_POSE, {"images": TF.up("plate"), "first": TF.up("first"), "fps": 24.0, "width": 720,
                               "height": 1280, "prompt": "", "seed": 3, "draft": True})
    assert TF.check(g) == []
    dw = g.of("DWPreprocessor")[0].inputs
    assert (dw["detect_body"], dw["detect_hand"], dw["detect_face"]) == ("enable", "enable", "enable")
    assert not g.of("ImageBlend")              # no subject gate: everyone in the clip drives the pose


def test_pose_follow_needs_a_pose_source():
    with pytest.raises(ValueError):
        MG.pose_follow(TF.Graph(), W_POSE, {"first": TF.up("first"), "fps": 24.0, "width": 64, "height": 64,
                                            "prompt": "", "seed": 1, "draft": True})


# ------------------------------------------------------------------ timing

def test_retime_30_to_24_ltx_length():
    idx, fps = T.retime_indices(177, 30.0, 24.0)
    assert fps == 24.0 and len(idx) == 137 and (len(idx) - 1) % 8 == 0
    assert idx[0] == 0 and idx[1] == 1 and idx[4] == 5 and idx[-1] <= 176
    assert all(b >= a for a, b in zip(idx, idx[1:]))


def test_retime_caps_and_keeps_rate():
    idx, fps = T.retime_indices(300, 24.0, 0, start_frame=10, max_frames=97)
    assert fps == 24.0 and idx[0] == 10 and len(idx) == 97 and idx == list(range(10, 107))
    assert T.ltx_length(100) == 97 and T.ltx_length(5) == 5 and T.ltx_length(9) == 9


def test_sheet_frames():
    assert T.sheet_frames('{"cols": 4, "frames": 97, "tile": [64, 36]}') == 97
    assert T.sheet_frames("") == 0 and T.sheet_frames("nope") == 0


# ------------------------------------------------------------------ Paint Studio: whole-frame edit

def test_whole_frame_edit_mode_repaints_everything():
    import numpy as np
    m = np.zeros((48, 64), np.float32)
    plan = F.plan_crop(m, "edit", grow_px=0, feather=0)
    assert plan["regen"].min() == 1.0 and plan["box"] == (0, 0, 64, 48)
    assert "edit" in F.MODES


def test_whole_frame_prompt_keeps_pose_and_framing():
    t = fill_prompt("edit", "Change the man into a teenage boy at night")
    assert t.startswith("Change the man into a teenage boy at night.")
    assert "same pose" in t and "head position" in t and "no text" in t
