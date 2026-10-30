"""Quality part: "Motion freedom" and "Quality: Draft | Final HQ" for the LTX-2.5 Layout-to-Render engine.

  stage clay frames ─┐                         ┌─> out_guide          -> L2R stage-1 guide (9002.guide_image)
  Look motion prompt ├─> SoundstageQuality ────┤                         + stage-2 guide (9034.image_1)
  stage scene JSON  ─┘   (motion_freedom,      ├─> guide_strength_1   -> 9002 inner 5012 IC-LoRA guide strength
                          quality)             ├─> guide_strength_2   -> 9034 inner 9039 IC-LoRA guide strength
                                               ├─> sigmas_1 / 2       -> 5516 inner 4984 / 9034 inner 9028 ManualSigmas
                                               ├─> out_motion_prompt  -> the positive prompt (5014)
                                               └─> lora_strength      -> 5004 "lora strength" (IC-LoRA model strength)

Defaults (0, Draft) emit exactly today's values and pass the guide tensor and prompt through untouched, so every
rung renders bit-for-bit what it rendered before. The knob mapping lives in soundstage/quality.py.

The four inner widgets are promoted to subgraph inputs (a helper here, since graph.py edits only the top level).
"""
import json
import uuid

from graph import Graph

TITLE = "Quality · motion freedom"
L2R_STAGE1 = 9002      # Preprocess subgraph instance: guide_image, inner 5012 = clay IC-LoRA guide
SAMPLER_1 = 5516       # Sampler - Distilled subgraph instance: inner 4984 ManualSigmas
STAGE2 = 9034          # Upscale and re-sampler subgraph instance: image_1 = clay guide, inner 9039 guide, 9028 sigmas
PROMPT_PARAMS = 5014   # Input Parameters subgraph instance: the positive prompt text input
STAGE = 9045
LOOK = 9079
LOAD_MODELS = 5004     # Load Models subgraph instance: "lora strength" -> inner LTXICLoRALoaderModelOnly


def _subgraph(g: Graph, instance_id: int) -> dict:
    t = g.nodes[instance_id]["type"]
    return next(s for s in g.w["definitions"]["subgraphs"] if s["id"] == t)


def _max_link_id(g: Graph) -> int:
    ids = [l[0] for l in g.w["links"]]
    for s in g.w["definitions"]["subgraphs"]:
        ids += [l["id"] if isinstance(l, dict) else l[0] for l in s.get("links", [])]
    return max(ids + [0])


def promote(g: Graph, instance_id: int, inner_id: int, widget: str, typ: str, value, name: str | None = None) -> str:
    """Expose an inner node's widget as an input of the subgraph (and of its instance). Returns the input name."""
    sg = _subgraph(g, instance_id)
    name = name or widget
    if any(i["name"] == name for i in sg["inputs"]):
        return name
    inner = next(n for n in sg["nodes"] if n["id"] == inner_id)
    lid = _max_link_id(g) + 1
    slot = len(sg["inputs"])
    sg["inputs"].append({"id": str(uuid.uuid4()), "name": name, "type": typ, "linkIds": [lid], "localized_name": name,
                         "label": name.replace("_", " ")})
    idx = next((i for i, x in enumerate(inner["inputs"]) if x["name"] == widget), None)
    if idx is None:
        inner["inputs"].append({"localized_name": widget, "name": widget, "type": typ, "widget": {"name": widget}, "link": lid})
        idx = len(inner["inputs"]) - 1
    else:
        inner["inputs"][idx]["link"] = lid
    sg["links"].append({"id": lid, "origin_id": -10, "origin_slot": slot, "target_id": inner_id, "target_slot": idx, "type": typ})
    if "state" in sg:
        sg["state"]["lastLinkId"] = max(sg["state"].get("lastLinkId", 0), lid)
    inst = g.nodes[instance_id]
    inst["inputs"].append({"label": name.replace("_", " "), "localized_name": name, "name": name, "type": typ,
                           "widget": {"name": name}, "link": None})
    inst.setdefault("widgets_values", []).append(value)
    if isinstance(inst.get("widgets_values_named"), dict):
        inst["widgets_values_named"][name] = value
    return name


def apply(g: Graph) -> None:
    if any(n.get("title") == TITLE for n in g.nodes.values()):
        return
    guide_src = g.source_of(L2R_STAGE1, "guide_image")
    prompt_slot = next(i for i, x in enumerate(g.nodes[PROMPT_PARAMS]["inputs"]) if g.source_of(PROMPT_PARAMS, i) == (LOOK, 2))
    x, y = g.nodes[L2R_STAGE1]["pos"]
    q = g.add_node("SoundstageQuality", (x - 420, y - 360),
                   inputs=[("motion_freedom", "FLOAT", "motion_freedom"), ("quality", "COMBO", "quality"), ("guide", "IMAGE"),
                           ("motion_prompt", "STRING"), ("scene_json", "STRING")],
                   outputs=[("out_guide", "IMAGE"), ("guide_strength_1", "FLOAT"), ("guide_strength_2", "FLOAT"),
                            ("sigmas_1", "STRING"), ("sigmas_2", "STRING"), ("out_motion_prompt", "STRING"),
                            ("lora_strength", "FLOAT")],
                   widgets=[0.0, "Draft"], title=TITLE, size=(340, 200))
    g.link(guide_src[0], guide_src[1], q, "guide", "IMAGE")
    g.link(LOOK, 2, q, "motion_prompt", "STRING")
    g.link(STAGE, 6, q, "scene_json", "STRING")

    # The clay guide, stage 1 and stage 2 (the stage-2 look still on 9034.image stays as it is).
    g.link(q, "out_guide", L2R_STAGE1, "guide_image", "IMAGE")
    if g.source_of(STAGE2, "image_1") == guide_src:
        g.link(q, "out_guide", STAGE2, "image_1", "IMAGE")
    # Guide strengths and sigma schedules, promoted out of the subgraphs.
    g.link(q, "guide_strength_1", L2R_STAGE1, promote(g, L2R_STAGE1, 5012, "strength", "FLOAT", 1.0, "guide_strength"), "FLOAT")
    g.link(q, "guide_strength_2", STAGE2, promote(g, STAGE2, 9039, "strength", "FLOAT", 1.0, "guide_strength"), "FLOAT")
    sig1 = next(n for n in _subgraph(g, SAMPLER_1)["nodes"] if n["type"] == "ManualSigmas")["id"]
    sig2 = next(n for n in _subgraph(g, STAGE2)["nodes"] if n["type"] == "ManualSigmas")["id"]
    g.link(q, "sigmas_1", SAMPLER_1, promote(g, SAMPLER_1, sig1, "sigmas", "STRING", "", "sigmas"), "STRING")
    g.link(q, "sigmas_2", STAGE2, promote(g, STAGE2, sig2, "sigmas", "STRING", "", "sigmas"), "STRING")
    # The motion prompt.
    g.link(q, "out_motion_prompt", PROMPT_PARAMS, prompt_slot, "STRING")
    # IC-LoRA model strength: already a widget input on the Load Models subgraph instance.
    g.link(q, "lora_strength", LOAD_MODELS, "lora strength", "FLOAT")

    g.expose(q, "motion_freedom", after=f"{9059}:step")
    g.expose(q, "quality", after=f"{q}:motion_freedom")


if __name__ == "__main__":  # quick check: python tools/app_build/quality.py
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    gg = Graph.load(root / "example_workflows/Soundstage_App.json")
    apply(gg)
    print(json.dumps({k: v for k, v in gg.nodes[max(gg.nodes)].items() if k in ("id", "type", "title")}), file=sys.stderr)
