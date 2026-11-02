"""VRAM tiers (soundstage/vram.py): Auto · 48 · 24 · 16 · 12 GB.

Checks the tier rules on real Soundstage graphs (the router's LTX-2.5 and FLUX 3 Klein adapters, Ripple, the
Performance render, the Quality node's LTX settings) and that every rewritten graph still validates against the
pod's /object_info snapshot. No ComfyUI, torch or GPU needed. Nothing here proves a tier fits a real card: only the
48 GB tier has run on hardware.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from soundstage import ltx_settings as L  # noqa: E402
from soundstage import vram as V  # noqa: E402
from soundstage.motion import graphs as MG  # noqa: E402
from soundstage.performance import graphs as PG  # noqa: E402
from soundstage.router import adapters as A  # noqa: E402

import test_router_adapters as TR  # noqa: E402

LTX_INT8 = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
LTX_BF16 = "ltx-2.5-22b-distilled-transformer-bf16.safetensors"
LTX_W4A8 = "ltx-2.5-22b-distilled-transformer-w4a8_convrot.safetensors"
GEMMA_INT8 = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
GEMMA_W4A8 = "gemma4-12b-with-proj-ltx-2.5-w4a8_convrot.safetensors"


def files_with(*names):
    """A list_files(folder) that has `names` installed (in subfolders too)."""
    by = {}
    for n in names:
        folder, f = n.split(":", 1)
        by.setdefault(folder, []).append(f)
    return lambda folder: by.get(folder, [])


def api(g):
    """A FakeGraph as an API prompt that shares the nodes' input dicts (so V.apply edits the FakeGraph too)."""
    return {nid: {"class_type": n.class_type, "inputs": n.inputs} for nid, n in g.nodes.items()}


def ltx_graph(tier=None, control=True):
    m = next(x for x in TR.WIRED if x["id"] == "open.ltx_2_5")
    p = TR.base_p(m, "generate_video", control=TR.link("ctrl"), first=TR.link("img")) if control else \
        TR.base_p(m, "generate_video", first=TR.link("img"))
    p["weights"]["l2r_lora"] = "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"
    p["vram"] = V.rules(tier) if tier else None
    g = TR.FakeGraph()
    A.ADAPTERS[m["adapter"]](g, m, p)
    return g


def of(g, ct):
    return [n for n in g.nodes.values() if n.class_type == ct]


# ---------------------------------------------------------------- the tier itself

@pytest.mark.parametrize("gb,tier", [(None, "12"), (8, "12"), (12, "12"), (13.9, "12"), (16, "16"), (19.9, "16"),
                                     (24, "24"), (39.5, "24"), (48, "48"), (80, "48")])
def test_auto_picks_the_tier_from_the_card(gb, tier):
    assert V.detect(gb) == tier
    assert V.effective("Auto", gb) == tier


def test_tier_names_are_forgiving_and_unknown_is_auto():
    assert [V.normalize(x) for x in ("16", "16 GB", 16, "24gb", "Auto", None, "", "96", "lots")] == \
        ["16", "16", "16", "24", "Auto", "Auto", "Auto", "Auto", "Auto"]
    assert V.effective("16", 48) == "16"   # a chosen tier wins over the card


def test_only_the_48_gb_tier_is_marked_tested():
    assert V.TESTED == ("48",)
    assert [V.rules(t)["tested"] for t in ("48", "24", "16", "12")] == [True, False, False, False]
    for t in ("24", "16", "12"):
        assert "untested" in V.RULES[t]["note"]


def test_the_setting_is_saved_and_the_env_var_wins(tmp_path, monkeypatch):
    monkeypatch.delenv(V.ENV, raising=False)
    f = tmp_path / "s.json"
    assert V.saved_tier(f) == "Auto"
    assert V.save_tier("16 GB", f) == "16" and V.saved_tier(f) == "16"
    monkeypatch.setenv(V.ENV, "24")
    assert V.saved_tier(f) == "24"


# ---------------------------------------------------------------- weights

def test_smaller_build_only_when_installed_and_never_bigger():
    lf = files_with(f"diffusion_models:{LTX_INT8}")
    assert V.pick(LTX_INT8, "small", lf("diffusion_models")) == LTX_INT8          # w4a8 not installed: keep
    lf = files_with(f"diffusion_models:{LTX_INT8}", f"diffusion_models:sub/{LTX_W4A8}")
    assert V.pick(LTX_INT8, "small", lf("diffusion_models")) == f"sub/{LTX_W4A8}"  # found in a subfolder
    assert V.pick(LTX_INT8, "int8", lf("diffusion_models")) == LTX_INT8           # 24 GB stays on int8
    assert V.pick(LTX_W4A8, "int8", lf("diffusion_models")) == LTX_W4A8           # never swaps to a bigger build
    assert V.pick(LTX_BF16, "int8", lf("diffusion_models")) == LTX_INT8
    assert V.pick(LTX_INT8, "quality", lf("diffusion_models")) == LTX_INT8        # 48 GB: as named
    assert V.pick("someone_elses_model.safetensors", "small", ["x"]) == "someone_elses_model.safetensors"


def test_every_listed_build_is_a_real_filename_not_a_gguf():
    for fam in V.FAMILIES.values():
        for b in fam["builds"]:
            assert b["file"].endswith(".safetensors"), b
            assert b["kind"] in V.SIZE
            assert b["repo"]


def test_missing_smaller_names_the_exact_file_and_repo_without_downloading():
    lf = files_with(f"diffusion_models:{LTX_INT8}", f"text_encoders:{GEMMA_INT8}",
                    "diffusion_models:krea2_turbo_fp8_scaled.safetensors")
    miss = V.missing_smaller("16", lf)
    files = {x["file"] for x in miss}
    assert files == {LTX_W4A8, GEMMA_W4A8}            # Krea fp8 is already the small build
    w4 = next(x for x in miss if x["file"] == LTX_W4A8)
    assert w4["gb"] == 12.5 and "Winnougan" in w4["repo"] and w4["folder"] == "diffusion_models"
    assert V.missing_smaller("48", lf) == []
    assert V.missing_smaller("24", lf) == []          # int8 is the 24 GB build


# ---------------------------------------------------------------- graphs

def test_48_gb_leaves_every_graph_exactly_as_built():
    g = ltx_graph()
    before = json.dumps(api(g), sort_keys=True)
    g48 = ltx_graph("48")
    assert json.dumps(api(g48), sort_keys=True) == before
    assert V.apply(api(g48), V.rules("48"), files_with(f"diffusion_models:{LTX_W4A8}")) == []
    assert json.dumps(api(g48), sort_keys=True) == before


@pytest.mark.skipif(not TR.OBJECT_INFO, reason="no object_info snapshot")
@pytest.mark.parametrize("tier", ["24", "16", "12"])
def test_ltx_layout_to_render_on_each_tier_is_valid_and_smaller(tier):
    r = V.rules(tier)
    g = ltx_graph(tier)
    lf = files_with(f"diffusion_models:{LTX_INT8}", f"diffusion_models:{LTX_W4A8}",
                    f"text_encoders:{GEMMA_INT8}", f"text_encoders:{GEMMA_W4A8}")
    changed = V.apply(api(g), r, lf)
    assert changed
    assert TR.check_graph(g) == []
    assert all(n.inputs["device"] == "cpu" for n in of(g, "CLIPLoader"))
    unet = of(g, "UNETLoader")[0].inputs["unet_name"]
    assert unet == (LTX_INT8 if tier == "24" else LTX_W4A8)
    for n in of(g, "VAEDecodeTiled"):
        for k, cap in r["decode"].items():
            assert n.inputs[k] <= cap
        assert n.inputs["temporal_overlap"] < n.inputs["temporal_size"]
        assert n.inputs["overlap"] < n.inputs["tile_size"]
    # stage 1 (the first empty latent) within the tier's cap; asked for 1920x1088
    lat = of(g, "EmptyLTXVLatentVideo")[0].inputs
    cap = r["stage1_short"] if r["refine"] != "off" else r["one_pass_short"] // 2
    assert min(lat["width"], lat["height"]) <= cap
    assert lat["width"] % 32 == 0 and lat["height"] % 32 == 0


def test_ltx_image_to_video_is_capped_too():
    g = ltx_graph("16", control=False)
    lat = of(g, "EmptyLTXVLatentVideo")[0].inputs
    assert min(lat["width"], lat["height"]) <= 352


@pytest.mark.skipif(not TR.OBJECT_INFO, reason="no object_info snapshot")
def test_klein_frame_text_encoder_goes_to_the_cpu_and_stays_valid():
    m = next(x for x in TR.WIRED if x["id"] == "open.flux3_klein")
    g = TR.FakeGraph()
    A.ADAPTERS[m["adapter"]](g, m, TR.base_p(m, "edit_image", image=TR.link("img")))
    V.apply(api(g), V.rules("16"), files_with())
    assert TR.check_graph(g) == []
    assert of(g, "CLIPLoader")[0].inputs["device"] == "cpu"


def test_linked_inputs_and_unknown_nodes_are_left_alone():
    prompt = {"1": {"class_type": "CLIPLoader", "inputs": {"clip_name": GEMMA_INT8, "type": "ltxv", "device": ["9", 0]}},
              "2": {"class_type": "VAEDecodeTiled", "inputs": {"tile_size": ["8", 0], "overlap": 64,
                                                                 "temporal_size": 128, "temporal_overlap": 32}},
              "3": {"class_type": "KSampler", "inputs": {"steps": 20}}, "junk": 5}
    V.apply(prompt, V.rules("16"), files_with())
    assert prompt["1"]["inputs"]["device"] == ["9", 0]
    assert prompt["2"]["inputs"]["tile_size"] == ["8", 0]
    assert prompt["2"]["inputs"]["temporal_size"] == 32 and prompt["2"]["inputs"]["temporal_overlap"] == 8
    assert prompt["3"]["inputs"] == {"steps": 20}


def test_on_prompt_never_raises(monkeypatch):
    monkeypatch.setenv(V.ENV, "16")
    for body in ({}, {"prompt": None}, {"prompt": {"1": {"class_type": "CLIPLoader", "inputs": None}}}, {"prompt": 3}):
        assert V.on_prompt(body) is body
    body = {"prompt": {"1": {"class_type": "CLIPLoader", "inputs": {"clip_name": "x", "type": "ltxv"}}}}
    V.on_prompt(body)
    assert body["prompt"]["1"]["inputs"]["device"] == "cpu"
    monkeypatch.setenv(V.ENV, "48")
    body = {"prompt": {"1": {"class_type": "CLIPLoader", "inputs": {"clip_name": "x", "type": "ltxv"}}}}
    V.on_prompt(body)
    assert "device" not in body["prompt"]["1"]["inputs"]


# ---------------------------------------------------------------- ⑤ Motion settings (the App's Quality node)

def sizes(preset, tier):
    s = V.cap_settings(L.resolve({"preset": preset}), V.rules(tier))
    return s, L.stage_sizes(1920, 1080, s)


def test_motion_presets_per_tier():
    s, sz = sizes("Hollywood", "48")
    assert sz["output"][1] == 1408 and "vram_note" not in s
    s, sz = sizes("Hollywood", "24")
    assert s["two_stage"] and sz["stage1"][1] <= 544 and sz["output"][1] <= 1088
    assert "capped" in s["vram_note"] and "untested" in s["vram_note"]
    s, sz = sizes("Final", "24")
    assert sz["output"][1] == 1088 and "vram_note" not in s    # Final is already 544 at stage 1
    s, sz = sizes("Hollywood", "16")
    assert s["two_stage"] and sz["stage1"][1] <= 352 and "small decode tiles" in s["vram_note"]
    s, sz = sizes("Hollywood", "12")
    assert not s["two_stage"] and sz["output"][1] <= 512 and "refine off" in s["vram_note"]
    s, sz = sizes("Draft", "12")
    assert not s["two_stage"] and sz["output"][1] <= 512


def test_motion_decode_tiles_follow_the_tier_and_stay_ordered():
    for t in ("24", "16", "12"):
        s = V.cap_settings(L.resolve({"preset": "Final"}), V.rules(t))
        d = s["decode"]
        assert d["tile_size"] <= V.RULES[t]["decode"]["tile_size"]
        assert d["temporal_overlap"] < d["temporal_size"] and d["overlap"] < d["tile_size"]
        assert s["vram_tier"] == t


def test_motion_estimate_drops_with_the_tier():
    est = {t: L.estimate_seconds(sizes("Hollywood", t)[0], 1920, 1080, 121) for t in ("48", "24", "16", "12")}
    assert est["48"] > est["24"] > est["16"]


# ---------------------------------------------------------------- Ripple and Performance

@pytest.mark.parametrize("tier,short", [(None, 768), ("48", 768), ("24", 768), ("16", 704), ("12", 512)])
def test_ripple_final_is_capped_per_tier(tier, short):
    g = TR.FakeGraph()
    MG.ripple(g, {"unet": LTX_INT8, "text_encoder": GEMMA_INT8, "vae": "v", "audio_vae": "a", "ripple_lora": "r"},
              {"images": TR.link("frames"), "edited": TR.link("img"), "frames": 97, "fps": 24.0, "width": 1920,
               "height": 1080, "quality": "Final", "seed": 1, "vram": V.rules(tier) if tier else None})
    lat = of(g, "EmptyLTXVLatentVideo")[0].inputs
    assert min(lat["width"], lat["height"]) <= short
    assert min(lat["width"], lat["height"]) >= short - 32


def test_performance_quality_per_tier():
    assert PG.tier_quality("Hollywood") == PG.QUALITY["Hollywood"]
    assert PG.tier_quality("Hollywood", V.rules("24")) == {"short": 512, "refine": True}
    assert PG.tier_quality("Hollywood", V.rules("16")) == {"short": 320, "refine": True}
    assert PG.tier_quality("Hollywood", V.rules("12")) == {"short": 512, "refine": False}
    assert min(PG.render_size(1920, 1080, "Final", V.rules("16"))) <= 352


# ---------------------------------------------------------------- the setup check

def test_report_says_what_fits_and_tests_only_48():
    lf = files_with(f"diffusion_models:{LTX_INT8}", f"text_encoders:{GEMMA_INT8}")
    rep = V.report("Auto", 16.0, lf, "RTX 4070 Ti SUPER")
    assert rep["tier"] == "16" and rep["tested"] is False and rep["gpu"]["name"] == "RTX 4070 Ti SUPER"
    verdicts = {r["feature"]: r["verdict"] for r in rep["features"]}
    assert all(v != "tested" for v in verdicts.values())
    assert verdicts["MiniMax H3 (second video engine)"] == "no"
    motion = next(r for r in rep["features"] if r["feature"].startswith("⑤ Motion: LTX"))
    assert motion["verdict"] == "offload" and "w4a8 build is not installed" in motion["loads"]
    assert {x["file"] for x in rep["missing_smaller"]} == {LTX_W4A8, GEMMA_W4A8}
    assert "--reserve-vram 0.4" in rep["launch_flags"] and rep["free_between"] is True
    rep48 = V.report("Auto", 48.0, lf, "RTX 6000 Ada")
    assert all(r["verdict"] == "tested" for r in rep48["features"]) and rep48["free_between"] is False
    assert "warning" not in rep48


def test_report_warns_when_the_tier_is_bigger_than_the_card_or_there_is_no_gpu():
    assert "16 GB" in V.report("48", 16.0)["warning"]
    assert "No CUDA GPU" in V.report("Auto", None)["warning"]
    assert "below the smallest tier" in V.report("Auto", 8.0)["warning"]


def test_routes_read_and_save_the_tier(tmp_path, monkeypatch):
    pytest.importorskip("aiohttp")
    import asyncio
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    monkeypatch.delenv(V.ENV, raising=False)
    monkeypatch.setattr(V, "_settings_path", lambda: tmp_path / "v.json")
    monkeypatch.setattr(V, "gpu_total_gb", lambda: 24.0)
    routes = web.RouteTableDef()
    assert V.register(routes)

    async def go():
        appl = web.Application()
        appl.add_routes(routes)
        async with TestClient(TestServer(appl)) as c:
            a = await (await c.get("/soundstage/vram")).json()
            b = await (await c.post("/soundstage/vram", json={"tier": "16"})).json()
            d = await (await c.get("/soundstage/vram")).json()
            monkeypatch.setenv(V.ENV, "12")
            e = await c.post("/soundstage/vram", json={"tier": "24"})
            return a, b, d, e.status

    a, b, d, status = asyncio.run(go())
    assert (a["setting"], a["tier"]) == ("Auto", "24")
    assert (b["setting"], b["tier"]) == ("16", "16") and d["tier"] == "16"
    assert status == 409          # the server's env var wins over the App
