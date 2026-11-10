"""Live sampling previews (web/pipeline/livepreview.mjs). ComfyUI sends a preview per step from
latent_preview.prepare_callback, which KSampler, SamplerCustom and SamplerCustomAdvanced call. The Soundstage nodes
that paint (SoundstageEditImage / GenerateImage / GenerateVideo, the cast pass, the Krea 2 depth KSampler 9056) expand
into those core sampler nodes (GraphBuilder + expand), so they preview with no callback of their own. These tests keep
it that way: every local image/video model samples through a core sampler node, and no Soundstage Python samples a
model directly (that would need latent_preview.prepare_callback added by hand, or it would show no preview)."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLERS = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"}
# Local stages with a diffusion sampler in them. generate_video's MiniMax H3 path uses SamplerCustomAdvanced too.
PAINTING = {"generate_image", "edit_image", "generate_video"}


def _registry():
    with open(os.path.join(ROOT, "soundstage", "router", "registry.json")) as f:
        return json.load(f)["models"]


def test_every_local_painting_model_samples_through_a_core_sampler_node():
    missing = []
    for m in _registry():
        # catalog-only entries (no adapter) are listed but never run by the router
        if m.get("kind") != "local" or not m.get("adapter") or not PAINTING & set(m.get("stages") or []):
            continue
        if not SAMPLERS & set(m.get("classes") or []):
            missing.append(m["id"])
    assert not missing, f"no core sampler node (so no live preview): {missing}"


def test_the_frame_and_motion_models_the_app_uses_are_covered():
    ids = {m["id"] for m in _registry() if m.get("kind") == "local" and SAMPLERS & set(m.get("classes") or [])}
    for want in ("open.flux3_klein", "open.krea_2_turbo", "open.minimax_h3_local"):
        assert want in ids, want
    assert any(i.startswith("open.ltx") for i in ids)


DIRECT = re.compile(r"comfy\.sample\.sample\b|common_ksampler\(|comfy\.samplers\.KSampler\(|\.sample_custom\(|"
                    r"sample_custom\(|comfy\.sample\.sample_custom|\bguider\.sample\(")


def test_no_soundstage_python_samples_a_model_directly():
    hits = []
    for dirpath, _, files in os.walk(os.path.join(ROOT, "soundstage")):
        for fn in files:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dirpath, fn)
            with open(p, encoding="utf-8") as f:
                for i, line in enumerate(f, 1):
                    if DIRECT.search(line) and "prepare_callback" not in line:
                        hits.append(f"{os.path.relpath(p, ROOT)}:{i}")
    assert not hits, ("samples outside a core sampler node: add latent_preview.prepare_callback(model, steps) "
                      f"as the sampler's callback so ④/⑤ get live previews: {hits}")


def test_the_router_nodes_expand_into_real_nodes():
    """Expansion is what makes the inner KSampler's previews arrive with display_node_id = the router node (9081)."""
    with open(os.path.join(ROOT, "soundstage", "nodes_router.py"), encoding="utf-8") as f:
        src = f.read()
    for cls in ("SoundstageEditImage", "SoundstageGenerateImage", "SoundstageGenerateVideo"):
        body = src.split(f"class {cls}(", 1)[1].split("\nclass ", 1)[0]
        assert "enable_expand=True" in body and "expand=g.finalize()" in body, cls
