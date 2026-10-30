"""Registry filtering and dropdown option building, with the loaded-class set and the model folders
mocked (no ComfyUI / GPU)."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.router import registry as R  # noqa: E402
from soundstage.router.adapters import ADAPTERS  # noqa: E402

REG = R.load_registry()
WIRED = [m for m in REG["models"] if m["adapter"]]
ALL_CLASSES = {c for m in WIRED for c in m["classes"]} | {
    c for m in WIRED for s in m.get("optional_weights", []) for c in s.get("classes", [])}

# What the pod (RTX 6000 Ada, ComfyUI 0.43 at :8189) had on 2026-10-27, per folder_paths.
POD_FILES = {
    "diffusion_models": ["Krea-2-Turbo.safetensors", "flux3-image-klein-int8-convrot.safetensors",
                         "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
                         "z_image_turbo_bf16.safetensors", "wan2.2_animate_14B_bf16.safetensors"],
    "text_encoders": ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "qwen3vl_4b_fp8_scaled.safetensors",
                      "qwen_3_4b.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    "vae": ["ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors", "qwen_image_vae.safetensors",
            "flux2-vae.safetensors", "flux/ae.safetensors", "wan_2.1_vae.safetensors"],
    "latent_upscale_models": ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"],
    "loras": ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
              "ltx2.5/ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors",
              "ltx2.5/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors",
              "krea2/cn/depth-control-lora.safetensors"],
    "checkpoints": ["sam3.1_multiplex_fp16.safetensors"],
    "clip_vision": ["clip_vision_h.safetensors"],
}


def files(table):
    def list_files(folder):
        if folder not in table:
            raise KeyError(folder)  # folder_paths raises for unregistered folder types
        return table[folder]
    return list_files


def ids(stage, classes=ALL_CLASSES, table=POD_FILES, open_only=False):
    return [m["id"] for m in R.available_models(stage, classes, files(table), open_only=open_only)]


def test_registry_shape():
    assert set(REG["stages"]) == {"generate_image", "edit_image", "generate_video", "matte", "clean_plate"}
    seen = set()
    for m in REG["models"]:
        assert m["id"] not in seen, m["id"]
        seen.add(m["id"])
        assert m["stages"] and set(m["stages"]) <= set(REG["stages"]), m["id"]
    for m in WIRED:
        assert m["adapter"] in ADAPTERS, m["id"]
        assert m["kind"] in {"local", "custom_node", "partner", "cloud"}
    labels = [R.label_for(m) for m in WIRED]
    assert len(labels) == len(set(labels)), "dropdown labels must be unique (workflows store them)"


def test_catalogue_entries_never_show():
    cat = [m for m in REG["models"] if not m["adapter"]]
    assert len(cat) > 200
    every = set().union(*(ids(s) for s in REG["stages"]))
    assert not every & {m["id"] for m in cat}


def test_stage_filtering_pod_snapshot():
    assert ids("generate_video")[0] == "open.ltx_2_5"  # default video engine
    assert "open.wan_animate_2" not in ids("generate_video")  # distilled int8 weights not on the pod
    assert "api.kling_4_0" in ids("generate_video")
    assert set(ids("generate_image")) >= {"open.krea_2_turbo", "open.z_image_turbo", "open.flux3_klein",
                                          "api.nano_banana_2_1", "api.gpt_image_2_5"}
    assert "open.z_image_turbo" not in ids("edit_image")  # t2i only
    assert set(ids("matte")) >= {"open.sam3", "open.ltx25_ic_alpha_gen", "custom.rmbg_rmbg2", "api.veed_remove_bg"}
    assert "open.remove_background" not in ids("matte")  # background_removal folder not mapped on the pod
    assert set(ids("clean_plate")) >= {"open.ltx25_ic_clean_plate", "api.bria_video_eraser"}
    # stage purity: nothing leaks across stages
    for stage in REG["stages"]:
        for mid in ids(stage):
            assert stage in next(m for m in WIRED if m["id"] == mid)["stages"]


def test_partner_nodes_disabled_hides_all_paid():
    paid_only = ({c for m in WIRED if m["kind"] in R.PAID_KINDS for c in m["classes"]}
                 - {c for m in WIRED if m["kind"] not in R.PAID_KINDS for c in m["classes"]})
    local_only = ALL_CLASSES - paid_only  # what --disable-partner-nodes leaves loaded
    for stage in ("generate_image", "matte"):
        got = R.available_models(stage, local_only, files(POD_FILES), open_only=False)
        assert got and all(m["kind"] not in R.PAID_KINDS for m in got)


def test_open_weights_only_env(monkeypatch):
    monkeypatch.setenv(R.OPEN_ONLY_ENV, "1")
    for stage in REG["stages"]:
        got = R.available_models(stage, ALL_CLASSES, files(POD_FILES))
        assert all(m["kind"] not in R.PAID_KINDS for m in got), stage
    assert ids("generate_video", open_only=True) == ["open.ltx_2_5"]


def test_missing_weight_hides_local_model():
    table = dict(POD_FILES, latent_upscale_models=[])
    assert "open.ltx_2_5" not in ids("generate_video", table=table)
    table = dict(POD_FILES)
    del table["checkpoints"]  # folder type unknown -> treated as empty
    assert "open.sam3" not in ids("matte", table=table)


def test_optional_weight_does_not_hide():
    table = dict(POD_FILES, loras=[])
    assert "open.ltx_2_5" in ids("generate_video", table=table)  # L2R LoRA is optional
    assert "open.krea_2_turbo" in ids("generate_image", table=table)  # depth LoRA is optional


def test_missing_class_hides_model():
    assert "api.kling_4_0" not in ids("generate_video", classes=ALL_CLASSES - {"Kling4ReferenceToVideoNode"})
    assert "custom.rmbg_rmbg2" not in ids("matte", classes=ALL_CLASSES - {"RMBG"})


def test_badges_and_labels():
    by = {m["id"]: m for m in WIRED}
    assert R.label_for(by["api.kling_4_0"]) == "Kling 4.0 · Kling [API]"
    assert R.label_for(by["open.ltx_2_5"]) == "LTX-2.5 22B distilled · local [<$10M]"
    assert R.badges_for(by["open.flux3_klein"]) == ["<$5M"]
    assert R.badges_for(by["open.krea_2_turbo"]) == ["<$1M"]
    assert R.badges_for(by["open.z_image_turbo"]) == []
    assert R.badges_for(by["custom.rmbg_rmbg2"]) == ["NC", "DL"]
    assert R.badges_for(by["cloud.z_image_turbo"]) == ["API"]
    cat = {m["id"]: m for m in REG["models"]}
    assert R.badges_for(cat["open.minimax_h3_local"]) == ["<$20M", "GEO"]
    assert "NC" in R.badges_for(cat["open.qwen_image_2_1"])


def test_find_model_by_label_or_id():
    m = next(m for m in WIRED if m["id"] == "api.veo_3_1")
    assert R.find_model(R.label_for(m))["id"] == "api.veo_3_1"
    assert R.find_model("api.veo_3_1")["id"] == "api.veo_3_1"
    assert R.find_model("nope") is None


def test_stage_options_and_widgets():
    opts = R.stage_options("generate_video", ALL_CLASSES, files(POD_FILES), open_only=False)
    labels = [o[0] for o in opts]
    assert labels[0].startswith("LTX-2.5 22B distilled")
    ltx_widgets = opts[0][1]
    assert ltx_widgets == [{"kind": "combo", "id": "mode", "options": ["auto", "image/text → video", "layout → render"],
                            "default": "auto"}]
    kling = next(o for o in opts if o[2]["id"] == "api.kling_4_0")
    assert [w["id"] for w in kling[1]] == ["resolution"]  # duration comes from frames/fps, not a widget
    krea_gen = next(o for o in R.stage_options("generate_image", ALL_CLASSES, files(POD_FILES), False)
                    if o[2]["id"] == "open.krea_2_turbo")
    krea_edit = next(o for o in R.stage_options("edit_image", ALL_CLASSES, files(POD_FILES), False)
                     if o[2]["id"] == "open.krea_2_turbo")
    assert krea_gen[1] == [] and krea_edit[1][0]["id"] == "denoise"


def test_no_model_placeholder():
    assert R.stage_options("matte", set(), files({}), open_only=False) == [(R.NONE_KEY, [], None)]


@pytest.mark.parametrize("m", WIRED, ids=lambda m: m["id"])
def test_param_defaults_valid(m):
    for spec in (m.get("params") or {}).values():
        if "options" in spec and "default" in spec:
            assert spec["default"] in spec["options"]
        if "min" in spec and "default" in spec:
            assert spec["min"] <= spec["default"] <= spec["max"]


def test_optional_feature_needs_its_node_pack():
    m = next(m for m in WIRED if m["id"] == "open.ltx_2_5")
    w = R.resolve_weights(m, files(POD_FILES), ALL_CLASSES - {"LTXAddVideoICLoRAGuide"})
    assert w["unet"] and w["l2r_lora"] is None  # L2R off, plain i2v/t2v still runs
    assert R.resolve_weights(m, files(POD_FILES), ALL_CLASSES)["l2r_lora"]
    no_pack = ALL_CLASSES - {"LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide"}
    assert "open.ltx_2_5" in ids("generate_video", classes=no_pack)
    assert "open.ltx25_ic_alpha_gen" not in ids("matte", classes=no_pack)


def test_no_higgsfield_anywhere():
    """Soundstage is the open alternative to Higgsfield: never route to its API."""
    for m in REG["models"]:
        assert "higgsfield" not in json.dumps(m).lower(), m["id"]
    assert not [k for k in ADAPTERS if "higgsfield" in k.lower()]
