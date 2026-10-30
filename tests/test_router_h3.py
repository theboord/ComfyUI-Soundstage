"""MiniMax H3 as an optional local video engine: LTX-2.5 stays the default everywhere, H3 builds a valid
graph (image → video with its own sound, or with the stage clay as <Video 1>), and its frames come back
at the shot's own length and size."""
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools", "app_build"))

from soundstage.router import adapters as A  # noqa: E402
from soundstage.router import registry as R  # noqa: E402
from test_router_adapters import OBJECT_INFO, WIRED, FakeGraph, base_p, check_graph, link, output_type  # noqa: E402
from test_router_registry import ALL_CLASSES, POD_FILES, files  # noqa: E402

H3 = next(m for m in WIRED if m["id"] == "open.minimax_h3_local")
POD_H3 = {**POD_FILES,
          "diffusion_models": POD_FILES["diffusion_models"] + ["minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                                                               "minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
          "text_encoders": POD_FILES["text_encoders"] + ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
          "vae": POD_FILES["vae"] + ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
          "loras": POD_FILES["loras"] + ["MINIMAX/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"]}


def build(**kw):
    params = kw.pop("params", None)
    p = base_p(H3, "generate_video", **kw)
    if params:
        p["params"].update(params)
    g = FakeGraph()
    return g, A.minimax_h3_local(g, H3, p)


def of(g, cls):
    return [n for n in g.nodes.values() if n.class_type == cls]


# ------------------------------------------------------------------ LTX stays the default

def test_ltx_is_the_default_video_engine_even_with_h3_installed():
    got = [m["id"] for m in R.available_models("generate_video", ALL_CLASSES, files(POD_H3), open_only=False)]
    assert got[0] == "open.ltx_2_5"
    assert "open.minimax_h3_local" in got
    video = [m["id"] for m in R.load_registry()["models"] if m.get("adapter") and "generate_video" in m["stages"]]
    assert video.index("open.ltx_2_5") < video.index("open.minimax_h3_local")


def test_app_build_and_app_panel_default_to_ltx():
    import models  # tools/app_build/models.py
    assert models.VIDEO_DEFAULT.startswith("LTX-2.5")
    src = open(os.path.join(ROOT, "web", "pipeline", "pipeline.mjs")).read()
    # the first option in the Motion dropdown is the LTX Layout-to-Render path; picker switch off = LTX
    first = re.search(r'm\.engine\.append\(new Option\("([^"]+)", VIDEO_L2R\)\)', src)
    assert first and first.group(1).startswith("LTX-2.5")
    assert "MiniMax H3 (local, looser blocking, rich motion" in src


def test_h3_hidden_until_its_weights_are_installed():
    got = [m["id"] for m in R.available_models("generate_video", ALL_CLASSES, files(POD_FILES), open_only=False)]
    assert "open.minimax_h3_local" not in got


def test_h3_label_carries_licence_badges():
    assert R.label_for(H3) == "MiniMax H3 · local [<$20M GEO]"


# ------------------------------------------------------------------ graph

@pytest.mark.skipif(not OBJECT_INFO, reason="no object_info snapshot")
def test_image_to_video_graph_with_turbo_and_sound():
    g, outs = build(first=link("img"))
    assert check_graph(g) == []
    assert output_type(g, outs["video"]) == "VIDEO"
    (clip,) = of(g, "CLIPLoader")
    assert clip.inputs["device"] == "cpu" and clip.inputs["type"] == "minimax"
    (i2v,) = of(g, "MiniMaxH3ImageToVideo")
    assert i2v.inputs["width"] == 1344 and i2v.inputs["height"] == 768 and i2v.inputs["length"] == 107
    assert "first_frame" in i2v.inputs
    assert i2v.inputs["prompt"].startswith("For the target video, at 0.00 seconds")
    assert of(g, "LoraLoaderModelOnly") and of(g, "KSamplerSelect")[0].inputs["sampler_name"] == "er_sde"
    assert of(g, "BasicScheduler")[0].inputs["steps"] == 8
    assert of(g, "VAEDecodeAudio"), "H3's own audio must be decoded"
    (create,) = of(g, "CreateVideo")
    assert "audio" in create.inputs
    (trim,) = of(g, "ImageFromBatch")
    assert trim.inputs["length"] == 97  # back to the shot length
    assert abs(of(g, "TrimAudioDuration")[0].inputs["duration"] - 97 / 24) < 1e-6


@pytest.mark.skipif(not OBJECT_INFO, reason="no object_info snapshot")
def test_without_turbo_lora_uses_template_sampling():
    p_g = FakeGraph()
    p = base_p(H3, "generate_video", first=link("img"))
    p["weights"]["turbo_lora"] = None
    A.minimax_h3_local(p_g, H3, p)
    assert check_graph(p_g) == []
    assert not of(p_g, "LoraLoaderModelOnly")
    assert of(p_g, "BasicScheduler")[0].inputs["steps"] == 20


@pytest.mark.skipif(not OBJECT_INFO, reason="no object_info snapshot")
def test_clay_previz_rides_along_as_video_1():
    g, outs = build(first=link("img"), control=link("ctrl"), params={"motion_ref": A.H3_CLAY_REF})
    assert check_graph(g) == []
    (ref,) = of(g, "MiniMaxH3ReferenceToVideo")
    assert "ref_videos.ref_video_0" in ref.inputs and "ref_images.ref_image_0" in ref.inputs
    assert "<Video 1>" in ref.inputs["prompt"] and ref.inputs["prompt"].startswith("subject_definitions:")
    assert not of(g, "MiniMaxH3ImageToVideo")
    assert "ref2va" in of(g, "UNETLoader")[0].inputs["unet_name"]


def test_clay_reference_needs_the_clay():
    with pytest.raises(A.RouterError, match="control_video"):
        build(first=link("img"), params={"motion_ref": A.H3_CLAY_REF})


def test_too_long_is_a_friendly_error():
    with pytest.raises(A.RouterError, match="362"):
        build(first=link("img"), frames=400)


def test_length_grid_and_size():
    assert [A.h3_length(n) for n in (5, 22, 23, 65, 97, 124, 362)] == [5, 22, 39, 73, 107, 124, 362]
    assert A.h3_size(1920, 1088) == (1344, 768)
    w, h = A.h3_size(1088, 1920)
    assert w % 32 == 0 and h % 32 == 0 and h > w


def test_prompt_formats():
    p = base_p(H3, "generate_video", first=link("img"))
    p.update(sound="hooves on packed dirt", music="tense western strings", line="Drive.")
    text = A.h3_prompt(p, False)
    assert text.startswith("For the target video, at 0.00 seconds into the target video, <Picture 1>")
    assert "integrated_multimodal_description: [Shot 1] a woman walks to the door" in text
    assert "overall_soundscape: hooves on packed dirt" in text and "non_diegetic_music: tense western strings" in text
    assert "<d>[English] Drive.</d>" in text
    # no first frame = T2VA (no picture instruction); blank music = N/A
    t2v = A.h3_prompt(base_p(H3, "generate_video"), False)
    assert t2v.startswith("integrated_multimodal_description:") and t2v.endswith("non_diegetic_music: N/A")
    # an already structured prompt passes through untouched
    own = "subject_definitions:\n<Subject 1> ..."
    assert A.h3_prompt({**p, "prompt": own}, True) == own
