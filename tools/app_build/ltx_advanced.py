"""LTX advanced part (Milestone 18): presets Draft · Final · Hollywood and the per-shot "Advanced (LTX)" settings.

The Quality node (tools/app_build/quality.py) gets an `advanced` JSON widget and the shot's fps, and now drives:

  9045 clay ───────────> Quality.guide            (the full-size clay; Quality retimes + resizes it to stage 1)
  Quality.out_guide ──> GetImageSize ──> 9002 width / height / length   (stage-1 latent size = the guide's)
  Quality.fps_out ────> 9002 fps, 5014 frame rate, 9062 draft decode fps
  Quality.fps_final ──> 5518 final decode fps     (x2 with the temporal upscaler)
  Quality.cfg / seed ─> 5516 + 9034 cfg / noise_seed
  Quality.tile_size… ─> 5518 decode tiles
  5004 MODEL ─> Extra LTX LoRA ─> 5516 / 9034 model
  final latent:  two_stage ? 9034 (upscale + refine) : 5516 (stage 1 at full size)
                 temporal_x2 ? LTX-2.5 temporal upscaler x2 : as is            -> 5518 latents
  Rung 4 SaveVideo nodes -> SoundstageSaveVideo (H.264 at the shot's CRF, or a ProRes 422 HQ master + preview)

With advanced empty the Quality combo picks the preset, so an old saved shot renders as before (Draft) and new
shots default to Final (the combo default below).
"""
import uuid

TITLE = "Quality · motion freedom"
STAGE, PREPROCESS, PROMPT_PARAMS, SAMPLER_1, STAGE2 = 9045, 9002, 5014, 5516, 9034
DECODE, DRAFT_DECODE, LOAD_MODELS, SOURCE = 5518, 9062, 5004, 5548
FINAL_SAVES = ("Rung 4 · Final", "Rung 4 · Final + sound", "Rung 4 · Final · audio-driven")
DEFAULT_ADVANCED = '{"preset":"Final"}'
OUTPUTS = [("settings_json", "STRING"), ("two_stage", "BOOLEAN"), ("temporal_x2", "BOOLEAN"), ("cfg", "FLOAT"),
           ("seed", "INT"), ("fps_out", "FLOAT"), ("tile_size", "INT"), ("overlap", "INT"), ("temporal_size", "INT"),
           ("temporal_overlap", "INT"), ("fps_final", "FLOAT")]


def _q(g):
    return next(nid for nid, n in g.nodes.items() if n.get("title") == TITLE)


def _switch(g, pos, title, typ="LATENT"):
    return g.add_node("ComfySwitchNode", pos, inputs=[("on_false", typ), ("on_true", typ), ("switch", "BOOLEAN", "switch")],
                      outputs=[("output", typ)], widgets=[False], title=title, size=(260, 100))


def apply(g):
    q = _q(g)
    qn = g.nodes[q]
    if any(o["name"] == "settings_json" for o in qn["outputs"]):
        return
    # ---- the Quality node: new inputs/outputs, Final as the default preset
    qn["inputs"].append({"localized_name": "advanced", "name": "advanced", "type": "STRING", "widget": {"name": "advanced"}, "link": None})
    qn["inputs"].append({"localized_name": "fps", "name": "fps", "type": "FLOAT", "link": None})
    wv = qn.setdefault("widgets_values", [0.0, "Final"])
    wv[1] = "Final"
    wv[2:] = [DEFAULT_ADVANCED]
    for name, typ in OUTPUTS:
        qn["outputs"].append({"localized_name": name, "name": name, "type": typ, "links": None})
    qn["size"] = [340, 420]

    # ---- guide: the full-size clay; Quality retimes and resizes it to the stage-1 size
    g.link(STAGE, 0, q, "guide", "IMAGE")
    PROCESS = PREPROCESS
    fps_src = g.source_of(PROCESS, "fps")
    g.link(fps_src[0], fps_src[1], q, "fps", "FLOAT")
    x, y = qn["pos"]
    gis = g.add_node("GetImageSize", (x + 380, y - 120), inputs=[("image", "IMAGE")],
                     outputs=[("width", "INT"), ("height", "INT"), ("batch_size", "INT")], title="Stage-1 size", size=(220, 100))
    g.link(q, "out_guide", gis, "image", "IMAGE")
    g.link(gis, "width", PROCESS, "width", "INT")
    g.link(gis, "height", PROCESS, "height", "INT")
    g.link(gis, "batch_size", PROCESS, "length", "INT")

    # ---- frame rates
    g.link(q, "fps_out", PROCESS, "fps", "FLOAT")
    g.link(q, "fps_out", PROMPT_PARAMS, "value", "FLOAT")
    g.link(q, "fps_out", DRAFT_DECODE, "fps", "FLOAT")
    g.link(q, "fps_final", DECODE, "fps", "FLOAT")

    # ---- sampling: CFG and seed on both stages, decode tiles on both decodes
    for nid in (SAMPLER_1, STAGE2):
        g.link(q, "cfg", nid, "cfg", "FLOAT")
        g.link(q, "seed", nid, "noise_seed", "INT")
    for nid in (DECODE, DRAFT_DECODE):
        for k in ("tile_size", "overlap", "temporal_size", "temporal_overlap"):
            g.link(q, k, nid, k, "INT")

    # ---- extra LoRA between the model loader and both samplers
    mx, my = g.nodes[LOAD_MODELS]["pos"]
    lora = g.add_node("SoundstageLTXLoRA", (mx + 40, my + 420), inputs=[("model", "MODEL"), ("settings_json", "STRING")],
                      outputs=[("model", "MODEL")], widgets=["None", 0.8], title="Extra LTX LoRA (Advanced)", size=(320, 130))
    for dst, slot in g.consumers(LOAD_MODELS, "MODEL"):
        g.link(lora, "model", dst, slot, "MODEL")
    g.link(LOAD_MODELS, "MODEL", lora, "model", "MODEL")
    g.link(q, "settings_json", lora, "settings_json", "STRING")

    # ---- final latent: two-stage or single pass, then the optional temporal x2
    dx, dy = g.nodes[DECODE]["pos"]
    s2 = g.source_of(DECODE, "latents")
    stage_sel = _switch(g, (dx - 640, dy - 260), "Two-stage (upscale + refine) or one pass")
    g.link(s2[0], s2[1], stage_sel, "on_true", "LATENT")
    g.link(SAMPLER_1, 0, stage_sel, "on_false", "LATENT")
    g.link(q, "two_stage", stage_sel, "switch", "BOOLEAN")
    tml = g.add_node("LatentUpscaleModelLoader", (dx - 640, dy - 120), inputs=[("model_name", "COMBO", "model_name")],
                     outputs=[("LATENT_UPSCALE_MODEL", "LATENT_UPSCALE_MODEL")],
                     widgets=["ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors"], title="Temporal upscaler x2", size=(320, 80))
    tup = g.add_node("LTXVLatentUpsampler", (dx - 300, dy - 120),
                     inputs=[("samples", "LATENT"), ("upscale_model", "LATENT_UPSCALE_MODEL"), ("vae", "VAE")],
                     outputs=[("LATENT", "LATENT")], title="Temporal x2 (smoother motion, twice the frames)", size=(280, 80))
    g.link(stage_sel, "output", tup, "samples", "LATENT")
    g.link(tml, 0, tup, "upscale_model", "LATENT_UPSCALE_MODEL")
    g.link(LOAD_MODELS, "VAE", tup, "vae", "VAE")
    t_sel = _switch(g, (dx - 300, dy - 260), "Temporal x2 on/off")
    g.link(stage_sel, "output", t_sel, "on_false", "LATENT")
    g.link(tup, "LATENT", t_sel, "on_true", "LATENT")
    g.link(q, "temporal_x2", t_sel, "switch", "BOOLEAN")
    g.link(t_sel, "output", DECODE, "latents", "LATENT")

    # ---- Rung 4 saves: H.264 at the shot's CRF, or ProRes 422 HQ + preview
    for nid, n in list(g.nodes.items()):
        if n.get("type") == "SaveVideo" and n.get("title") in FINAL_SAVES:
            prefix = (n.get("widgets_values") or ["soundstage/final"])[0]
            vid = g.source_of(nid, "video")
            n["type"] = "SoundstageSaveVideo"
            n["properties"] = {"Node name for S&R": "SoundstageSaveVideo"}
            n["inputs"] = [{"localized_name": "video", "name": "video", "type": "VIDEO", "link": n["inputs"][0].get("link")},
                           {"localized_name": "settings_json", "name": "settings_json", "type": "STRING", "link": None}]
            n["widgets_values"] = [prefix]
            n["outputs"] = [{"localized_name": "video", "name": "video", "type": "VIDEO", "links": None}]
            g.nodes[nid] = n
            if vid is None:
                continue
            g.link(q, "settings_json", nid, "settings_json", "STRING")


if __name__ == "__main__":
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))
    from graph import Graph
    import quality
    root = Path(__file__).resolve().parents[2]
    gg = Graph.load(root / "example_workflows/Soundstage_App.json")
    quality.apply(gg)
    apply(gg)
    print("ok", len(gg.nodes), uuid.uuid4().hex[:4])
