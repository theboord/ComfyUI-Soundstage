"""Recast / Footage expansions build valid graphs: every emitted node exists on the pod, every required
input (incl. nested DynamicCombo / Autogrow keys) is set, no unknown inputs, combo values are legal,
link types match. Checked against tests/test_footage_object_info.json, a /object_info snapshot of the
pod's ComfyUI v0.43.0 with ComfyUI-LTXVideo, controlnet_aux, kjnodes, krea2edit and the partner nodes.

Also checks the LTX expansion mirrors the original union-control graph (same nodes, sigmas, samplers) and that
the original audio reaches the sampler conditioning. No ComfyUI, torch or GPU needed.
Run:  cd tests && python -m pytest test_footage_graphs.py -q
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.footage import graphs as GR  # noqa: E402

SNAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_footage_object_info.json")
OI = json.load(open(SNAP)) if os.path.exists(SNAP) else {}

# Our own helper nodes (not in the snapshot): name -> (inputs {name: type}, outputs)
OWN = {
    "SoundstageFootageDecode": ({"file": "COMBO", "video": "VIDEO", "start_frame": "INT", "max_frames": "INT",
                                 "ltx_length": "BOOLEAN"}, ["IMAGE", "AUDIO", "FLOAT", "INT", "STRING"]),
    "SoundstageTrackSelect": ({"track_data": "SAM3_TRACK_DATA", "subject": "INT", "footage_json": "STRING",
                               "subject_prompt": "STRING", "points": "STRING", "match_mask": "MASK"},
                              ["MASK", "MASK", "STRING"]),
    "SoundstageRecastComposite": ({"plate": "IMAGE", "swap": "IMAGE", "subject_mask": "MASK",
                                   "swap_subject_mask": "MASK", "others_mask": "MASK", "grow": "INT", "feather": "INT",
                                   "temporal": "INT", "match_color": "BOOLEAN", "framing": "COMBO"},
                                  ["IMAGE", "IMAGE", "MASK"]),
}
# Akatz Labs' H3CharacterSwap* nodes (GPL pack, not installed on the pod): interface from the pinned upstream
# source (worker_nodes/h3_character_swap, 0670e4f) and Openjutsu's swap.api.json. "*" = not type-checked.
_H3 = {
    "H3CharacterSwapPrepareVideo": ({"video": "VIDEO", "resolution": "*", "duration_seconds": "*"},
                                    ["IMAGE", "AUDIO", "INT", "INT", "INT", "INT", "FLOAT", "STRING", "VIDEO"]),
    "H3CharacterSwapSelectSubject": ({"masks": "MASK", "selection": "*", "index": "*"}, ["MASK", "H3_SUBJECT_SELECTION"]),
    "H3CharacterSwapRecoverMasks": ({"masks": "MASK", "images": "IMAGE", "model": "MODEL", "conditioning": "CONDITIONING",
                                     "selection": "H3_SUBJECT_SELECTION", "source_frames": "INT",
                                     "recover_empty_frames": "*"}, ["MASK", "STRING"]),
    "H3CharacterSwapExpandMask": ({"masks": "MASK", "images": "IMAGE", "source_frames": "INT", "expansion_px": "*"},
                                  ["MASK", "IMAGE"]),
    "H3CharacterSwapModels": ({"model": "MODEL", "clip": "CLIP", "video_vae": "VAE", "audio_vae": "VAE"}, ["*"]),
    "H3CharacterSwapSettings": ({k: "*" for k in ("prompt", "seed", "audio_guide", "steps", "cfg", "sampler_name",
                                                   "scheduler", "activation_memory_gib")}, ["*"]),
    "H3CharacterSwapShot": ({"source_video": "VIDEO", "source": "IMAGE", "source_audio": "AUDIO", "source_frames": "INT",
                             "fps": "FLOAT", "reference": "IMAGE", "anchor": "IMAGE", "body_mask": "MASK",
                             "use_anchor": "*", "use_mask": "*", "shot_id": "*"}, ["H3_RELAY_SHOT"]),
    "H3CharacterSwapWindowPlan": ({"shot": "H3_RELAY_SHOT", "settings": "*", "window_frames": "*",
                                   "history_frames": "*"}, ["*"]),
    "H3CharacterSwapController": ({"models": "*", "shot": "H3_RELAY_SHOT", "plan": "*"}, ["*", "H3_RELAY_SHOT"]),
    "H3CharacterSwapAssemble": ({"state": "*", "shot": "H3_RELAY_SHOT", "filename_prefix": "*"}, ["IMAGE", "AUDIO"]),
}
OWN.update(_H3)
UPSTREAM = {"plate": "IMAGE", "mask": "MASK", "audio": "AUDIO", "char": "IMAGE", "first": "IMAGE", "video": "VIDEO"}


class Node:
    def __init__(self, nid, class_type, inputs):
        self.id, self.class_type, self.inputs = nid, class_type, dict(inputs)

    def out(self, i):
        return [self.id, i]


class Graph:
    def __init__(self):
        self.nodes, self.n = {}, 0

    def node(self, class_type, id=None, **kw):
        self.n += 1
        nid = id or f"x{self.n}"
        self.nodes[nid] = Node(nid, class_type, kw)
        return self.nodes[nid]

    def of(self, cls):
        return [n for n in self.nodes.values() if n.class_type == cls]


def up(name):
    return [f"user_{name}", 0]


def specs(class_type, inputs):
    info = OI[class_type]["input"]
    out = {}

    def walk(section, prefix, required):
        for name, spec in section.items():
            key, typ = prefix + name, spec[0]
            opts = spec[1] if len(spec) > 1 else {}
            if typ == "COMFY_DYNAMICCOMBO_V3":
                out[key] = (["COMBO", {"options": [o["key"] for o in opts["options"]]}], required)
                for o in opts["options"]:
                    if o["key"] == inputs.get(key):
                        walk(o["inputs"].get("required", {}), key + ".", True)
                        walk(o["inputs"].get("optional", {}), key + ".", False)
            elif typ == "COMFY_AUTOGROW_V3":
                t = opts["template"]
                tin = {**t["input"].get("required", {}), **t["input"].get("optional", {})}
                for i, n in enumerate(t.get("names") or []):
                    out[f"{key}.{n}"] = (next(iter(tin.values())), required and i < t.get("min", 0))
            else:
                out[key] = (spec, required)

    walk(info.get("required", {}), "", True)
    walk(info.get("optional", {}), "", False)
    return out


def out_type(g, value):
    nid, slot = value
    if nid.startswith("user_"):
        return UPSTREAM[nid[5:]]
    n = g.nodes[nid]
    if n.class_type in OWN:
        return OWN[n.class_type][1][slot]
    t = OI[n.class_type]["output"][slot]
    return out_type(g, n.inputs["input"]) if t == "COMFY_MATCHTYPE_V3" else t


def check(g):
    probs = []
    for n in g.nodes.values():
        if n.class_type in OWN:
            allowed = OWN[n.class_type][0]
            for k, v in n.inputs.items():
                if k not in allowed:
                    probs.append(f"{n.class_type}: unknown input {k}")
                elif isinstance(v, list) and "*" not in (allowed[k], out_type(g, v)) and out_type(g, v) != allowed[k]:
                    probs.append(f"{n.class_type}.{k}: {out_type(g, v)} != {allowed[k]}")
            continue
        if n.class_type not in OI:
            probs.append(f"{n.class_type}: not on the pod")
            continue
        sp = specs(n.class_type, n.inputs)
        probs += [f"{n.class_type}: missing {k}" for k, (s, req) in sp.items() if req and k not in n.inputs]
        for k, v in n.inputs.items():
            if k not in sp:
                probs.append(f"{n.class_type}: unknown input {k}")
                continue
            typ = sp[k][0][0]
            opts = sp[k][0][1] if len(sp[k][0]) > 1 else {}
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                got, want = out_type(g, v), (typ if isinstance(typ, str) else "COMBO")
                if want == "COMFY_MATCHTYPE_V3":
                    want = opts["template"]["allowed_types"]
                if not ({got} & set(want.split(",")) or "*" in (want, got)):
                    probs.append(f"{n.class_type}.{k}: link {got} != {want}")
                continue
            choices = typ if isinstance(typ, list) else (opts.get("options") if typ == "COMBO" else None)
            if choices is not None and not k.endswith("_name") and v not in choices:
                probs.append(f"{n.class_type}.{k}: {v!r} not allowed")
            elif typ in ("INT", "FLOAT") and (("min" in opts and v < opts["min"]) or ("max" in opts and v > opts["max"])):
                probs.append(f"{n.class_type}.{k}: {v} out of range")
    return probs


W_LTX = {r: names[0] for r, (f, names) in GR.LTX_WEIGHTS.items()}
W_KREA = {r: names[0] for r, (f, names) in GR.KREA_WEIGHTS.items()}
needs_snap = pytest.mark.skipif(not OI, reason="no object_info snapshot")


def ltx_graph(audio=True, draft=False, krea=True):
    g = Graph()
    first = GR.krea_first_frame(g, W_KREA, g.node("ImageFromBatch", image=up("plate"), batch_index=0,
                                                  length=1).out(0), up("char"), "red jacket", 7) if krea else up("first")
    p = {"images": up("plate"), "mask": up("mask"), "audio": up("audio") if audio else None, "first": first,
         "fps": 24.0, "width": 1280, "height": 704, "prompt": "a man walks", "negative": "", "seed": 42,
         "draft": draft}
    return g, GR.ltx_union_recast(g, W_LTX, p)


@needs_snap
@pytest.mark.parametrize("audio,draft,krea", [(True, False, True), (False, False, False), (True, True, False)])
def test_ltx_recast_graph_is_valid(audio, draft, krea):
    g, frames = ltx_graph(audio, draft, krea)
    assert check(g) == []
    assert out_type(g, frames) == "IMAGE"


@needs_snap
def test_ltx_recast_mirrors_original_graph():
    g, _ = ltx_graph()
    sig = sorted(n.inputs["sigmas"] for n in g.of("ManualSigmas"))
    assert sig == sorted([GR.LTX_SIGMAS_STAGE1, GR.LTX_SIGMAS_STAGE2])
    assert sorted(n.inputs["sampler_name"] for n in g.of("KSamplerSelect")) == ["euler", "euler_ancestral"]
    dw = g.of("DWPreprocessor")[0].inputs
    assert (dw["detect_body"], dw["detect_face"], dw["detect_hand"]) == ("enable",) * 3
    assert g.of("LTXICLoRALoaderModelOnly")[0].inputs["lora_name"].endswith("union-control-ref0.5.safetensors")
    assert len(g.of("LTXVImgToVideoInplace")) == 2                      # first frame in both stages
    # original audio -> encoder -> reference tokens -> sampler conditioning + frozen audio latent
    enc = g.of("VAEEncodeAudio")[0]
    assert enc.inputs["audio"] == up("audio")
    ref = g.of("LTXVSetAudioRefTokens")[0]
    assert ref.inputs["audio_latent"] == enc.out(0)
    concat = [n for n in g.of("LTXVConcatAVLatent") if n.inputs["audio_latent"] == ref.out(2)]
    assert concat, "frozen original-audio latent must be what stage 1 samples"
    guiders = g.of("CFGGuider")
    assert any(gd.inputs["positive"] == ref.out(0) for gd in guiders)
    # DWPose is gated by the subject mask (only the recast person drives the IC-LoRA)
    blend = g.of("ImageBlend")[0]
    assert blend.inputs["blend_mode"] == "multiply" and out_type(g, blend.inputs["image1"]) == "IMAGE"


@needs_snap
def test_footage_tracking_graph_is_valid():
    for points in (None, '[{"x": 640, "y": 300}]'):
        g = Graph()
        dec = g.node("SoundstageFootageDecode", file="clip.mp4", start_frame=0, max_frames=97, ltx_length=True)
        tr = GR.sam3_track(g, dec.out(0), "sam3.1_multiplex_fp16.safetensors", "person", 0.5, 4, points)
        g.node("SoundstageTrackSelect", track_data=tr, subject=-1, footage_json=dec.out(4))
        assert check(g) == []
        assert bool(g.of("SAM3_Detect")) == bool(points)


@needs_snap
def test_composite_and_silhouette_graph_is_valid():
    g, frames = ltx_graph()
    sil = GR.subject_silhouette(g, frames, "sam3.1_multiplex_fp16.safetensors", "person", up("mask"))
    sel = g.of("SoundstageTrackSelect")[0]
    assert sel.inputs["match_mask"] == up("mask") and sel.inputs["subject"] == -1
    comp = g.node("SoundstageRecastComposite", plate=up("plate"), swap=frames, subject_mask=up("mask"),
                  swap_subject_mask=sil, grow=12, feather=10, temporal=1, match_color=True)
    g.node("CreateVideo", images=comp.out(0), fps=24.0, audio=up("audio"))
    assert check(g) == []


def test_guide_keeps_plate_framing():
    assert GR.guide_size(1280, 704) == (960, 512)
    assert GR.guide_size(1920, 1080) == (960, 512)
    g, _ = ltx_graph()
    r = [n for n in g.of("ResizeImageMaskNode") if n.inputs["resize_type"] == "scale dimensions"]
    assert r and r[0].inputs["resize_type.crop"] == "disabled"           # stretch, never a centre crop
    assert not [n for n in g.of("ResizeImageMaskNode") if n.inputs["resize_type"] == "scale to multiple"
                and n.inputs["input"] == g.of("ImageBlend")[0].out(0)]


def test_resolve_matches_subfolders():
    files = {"loras": ["ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"],
             "diffusion_models": ["ltx-2.5-22b-distilled-transformer-bf16.safetensors"]}
    w = GR.resolve(GR.LTX_WEIGHTS, lambda f: files.get(f, []))
    assert w["ic_lora"] == "ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"
    assert w["unet"] == "ltx-2.5-22b-distilled-transformer-bf16.safetensors"
    assert set(GR.missing(w)) == {"text_encoder", "vae", "audio_vae", "upscaler"}


def oj_p(**kw):
    p = {"images": up("plate"), "audio": up("audio"), "character": up("char"), "first": up("first"), "fps": 24.0,
         "frames": 97, "prompt": "", "seed": 7, "subject_prompt": "woman in a yellow raincoat"}
    p.update(kw)
    return p


@needs_snap
def test_openjutsu_api_graph_is_valid():
    for first in (up("first"), None):
        g = Graph()
        v = GR.h3_api_reference(g, oj_p(first=first))
        assert check(g) == []
        assert out_type(g, v) == "VIDEO"
        n = g.of("MinimaxHailuo03ReferenceNode")[0].inputs
        assert n["model.reference_images.image_1"] == up("char")
        assert out_type(g, n["model.reference_videos.video_1"]) == "VIDEO"
        assert ("model.reference_images.image_2" in n) == (first is not None)
        assert 4 <= n["model.duration"] <= 15 and "woman in a yellow raincoat" in n["model.prompt"]


@needs_snap
def test_openjutsu_local_mirrors_swap_api():
    g = Graph()
    w = {r: names[0] for r, (f, names) in GR.OPENJUTSU_WEIGHTS.items()}
    frames, audio = GR.openjutsu_local(g, w, oj_p())
    assert check(g) == []
    assert out_type(g, frames) == "IMAGE" and out_type(g, audio) == "AUDIO"
    one = lambda c: g.of(c)[0].inputs
    assert one("H3CharacterSwapPrepareVideo")["resolution"] == "768"
    assert (one("MiniMaxH3SigmaShift")["shift_video"], one("MiniMaxH3SigmaShift")["shift_audio"]) == (12, 3)
    st = one("H3CharacterSwapSettings")
    assert (st["steps"], st["cfg"], st["sampler_name"], st["scheduler"]) == (8, 1.0, "er_sde", "normal")
    assert (one("H3CharacterSwapWindowPlan")["window_frames"], one("H3CharacterSwapWindowPlan")["history_frames"]) \
        == ("124", "18")
    assert one("H3CharacterSwapExpandMask")["expansion_px"] == 64
    assert one("CLIPLoader")["type"] == "minimax"
    assert [n.inputs["lora_name"] for n in g.of("LoraLoaderModelOnly")] == [
        "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", "h3_character_swap_v1.5.safetensors"]
    assert set(GR.OPENJUTSU_CLASSES) <= {n.class_type for n in g.nodes.values()}


def test_no_higgsfield_in_recast():
    src = open(os.path.join(ROOT, "soundstage", "nodes_footage.py")).read() + \
        open(os.path.join(ROOT, "soundstage", "footage", "graphs.py")).read()
    assert "Higgsfield" not in src and "higgsfield" not in src
