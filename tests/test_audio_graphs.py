"""Every audio subgraph is valid against the pod's ComfyUI v0.43 /object_info (tests/test_audio_object_info.json):
nodes exist, required inputs (incl. DynamicCombo/Autogrow nested ones) are set, no unknown inputs, combo values
valid, numbers in range, and link types match. Soundstage's own audio nodes are checked by input name only.
No ComfyUI needed.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.audio import graphs as G  # noqa: E402

OBJECT_INFO = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_audio_object_info.json")))
W = {"unet": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
     "text_encoder": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
     "vae": "ltx-2.5-video-vae-bf16.safetensors", "audio_vae": "ltx-2.5-audio-vae-bf16.safetensors",
     "upscaler": "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
     "l2r_lora": "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"}
# Our own nodes: inputs -> output types
OWN = {"SoundstageLatentNoiseMask": ({"latent", "value"}, ["LATENT"]),
       "SoundstageAudioFit": ({"audio", "path", "shot_id", "frames", "fps", "offset_s"}, ["AUDIO"]),
       "SoundstageVoice": ({"name", "consent", "voice_owner", "reference", "character", "notes"},
                           ["SOUNDSTAGE_VOICE", "AUDIO", "STRING"]),
       "SoundstageChatterboxVC": ({"audio", "voice_name", "seed"}, ["AUDIO"]),
       "SoundstageAudioClip": ({"audio", "label", "shot_id", "track", "start_frame", "fps", "gain_db", "trim_silence",
                                "normalize_db", "max_seconds", "prefix", "meta_json"},
                               ["AUDIO", "STRING", "FLOAT", "INT"])}
UPSTREAM = {"frames": "IMAGE", "ctrl": "IMAGE", "first": "IMAGE", "audio": "AUDIO"}
FILE_COMBOS = {"unet_name", "clip_name", "vae_name", "model_name", "lora_name"}


class FakeNode:
    def __init__(self, id, class_type, inputs):
        self.id, self.class_type, self.inputs = id, class_type, dict(inputs)

    def out(self, i):
        return [self.id, i]


class FakeGraph:
    def __init__(self):
        self.nodes, self.n = {}, 0

    def node(self, class_type, id=None, **kwargs):
        self.n += 1
        nid = id or f"x{self.n}"
        self.nodes[nid] = FakeNode(nid, class_type, kwargs)
        return self.nodes[nid]


def link(name):
    return [f"user_{name}", 0]


def specs(class_type, inputs):
    info = OBJECT_INFO[class_type]["input"]
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
                tspec = next(iter({**t["input"].get("required", {}), **t["input"].get("optional", {})}.values()))
                for i in range(t.get("max", 10)):
                    out[f"{key}.{t['prefix']}{i}"] = (tspec, required and i < t.get("min", 0))
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
    t = OBJECT_INFO[n.class_type]["output"][slot]
    return "IMAGE" if t == "COMFY_MATCHTYPE_V3" else t  # ResizeImageMaskNode passes its input type through


def validate(g):
    for n in g.nodes.values():
        if n.class_type in OWN:
            unknown = set(n.inputs) - OWN[n.class_type][0]
            assert not unknown, (n.class_type, unknown)
            for v in n.inputs.values():
                if isinstance(v, list):
                    out_type(g, v)
            continue
        assert n.class_type in OBJECT_INFO, n.class_type
        sp = specs(n.class_type, n.inputs)
        assert not set(n.inputs) - set(sp), (n.class_type, set(n.inputs) - set(sp))
        for key, (spec, req) in sp.items():
            if req:
                assert key in n.inputs, (n.class_type, "missing", key)
            if key not in n.inputs:
                continue
            v, typ = n.inputs[key], spec[0]
            opts = spec[1] if len(spec) > 1 else {}
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                t = out_type(g, v)
                allowed = typ.split(",") if isinstance(typ, str) else ["COMBO"]
                if typ == "COMFY_MATCHTYPE_V3":
                    allowed = opts["template"]["allowed_types"].split(",")
                assert t in allowed or typ == "*", (n.class_type, key, t, typ)
            elif isinstance(typ, list) or typ == "COMBO":
                choices = typ if isinstance(typ, list) else opts.get("options", [])
                if key.split(".")[-1] not in FILE_COMBOS:
                    assert v in choices, (n.class_type, key, v)
            elif typ in ("INT", "FLOAT"):
                assert opts.get("min", -1e30) <= v <= opts.get("max", 1e30), (n.class_type, key, v)
            elif typ == "BOOLEAN":
                assert isinstance(v, bool)
            elif typ == "STRING":
                assert isinstance(v, str)
    return g


def classes(g):
    return [n.class_type for n in g.nodes.values()]


def test_ltx_text_to_audio():
    g = FakeGraph()
    a = G.ltx_text_to_audio(g, W, "door slams. No animals, no voices, no music.", 2.0, 7)
    validate(g)
    assert out_type(g, a) == "AUDIO"
    assert "LTXVAudioOnlyModel" in classes(g)
    n = next(x for x in g.nodes.values() if x.class_type == "LTXVEmptyLatentAudio")
    assert n.inputs["frames_number"] >= 51 and (n.inputs["frames_number"] - 1) % 8 == 0


def test_ltx_video_to_audio():
    g = FakeGraph()
    a = G.ltx_video_to_audio(g, W, link("frames"), 97, 24.0, "footsteps on stone", 1, 960, 512)
    validate(g)
    assert out_type(g, a) == "AUDIO"
    mask = next(x for x in g.nodes.values() if x.class_type == "SoundstageLatentNoiseMask")
    assert mask.inputs["value"] == 0.0  # picture frozen, sound generated
    assert next(x for x in g.nodes.values() if x.class_type == "ImageFromBatch").inputs["length"] == 97


@pytest.mark.parametrize("control", [True, False])
@pytest.mark.parametrize("quality", ["final", "draft"])
@pytest.mark.parametrize("ref", [False, True])
@pytest.mark.parametrize("soundtrack", ["supplied", "ltx"])
def test_audio_driven_shot(control, quality, ref, soundtrack):
    g = FakeGraph()
    outs = G.audio_driven_shot(g, W, {
        "prompt": "two people walk to a glass door", "seed": 42, "width": 1920, "height": 1088, "frames": 97,
        "fps": 24.0, "control": link("ctrl") if control else None, "first": link("first"), "audio": link("audio"),
        "audio_mask": 0.3, "quality": quality, "soundtrack": soundtrack, "ref_tokens": ref})
    validate(g)
    assert out_type(g, outs["video"]) == "VIDEO" and out_type(g, outs["images"]) == "IMAGE"
    cls = classes(g)
    assert ("LTXICLoRALoaderModelOnly" in cls) == control
    assert cls.count("SamplerCustomAdvanced") == (2 if quality == "final" else 1)
    assert ("LTXVSetAudioRefTokens" in cls) == ref
    cv = next(x for x in g.nodes.values() if x.class_type == "CreateVideo")
    src = g.nodes[cv.inputs["audio"][0]].class_type
    assert src == ("SoundstageAudioFit" if soundtrack == "supplied" else "LTXVAudioVAEDecode")
    # every AV concat carries the masked audio latent
    for c in (x for x in g.nodes.values() if x.class_type == "LTXVConcatAVLatent"):
        assert g.nodes[c.inputs["audio_latent"][0]].class_type == "SoundstageLatentNoiseMask"


def test_l2r_needs_lora():
    w = dict(W, l2r_lora=None)
    with pytest.raises(ValueError):
        G.audio_driven_shot(FakeGraph(), w, {"prompt": "", "seed": 0, "width": 960, "height": 512, "frames": 97,
                                             "fps": 24, "control": link("ctrl"), "audio": link("audio")})


def _voice_link(g):
    return g.node("SoundstageVoice", name="PIP", consent=False, voice_owner="").out(1)


@pytest.mark.parametrize("model", ["eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_multilingual_v2"])
@pytest.mark.parametrize("clone", [False, True])
def test_elevenlabs_tts(model, clone):
    g = FakeGraph()
    a = G.elevenlabs_tts(g, "You owe me.", 3, {"model": model, "preset_voice": "River (neutral, american)",
                                              "stability": 0.4, "speed": 1.3, "language": "en"},
                         clone_audio=_voice_link(g) if clone else None)
    validate(g)
    assert out_type(g, a) == "AUDIO"
    assert ("ElevenLabsInstantVoiceClone" in classes(g)) == clone


@pytest.mark.parametrize("clone", [False, True])
def test_elevenlabs_sts(clone):
    g = FakeGraph()
    a = G.elevenlabs_sts(g, link("audio"), 9, {"model": "eleven_english_sts_v2", "similarity": 0.8,
                                               "remove_noise": True}, clone_audio=_voice_link(g) if clone else None)
    validate(g)
    assert out_type(g, a) == "AUDIO"


def test_elevenlabs_sfx():
    g = FakeGraph()
    a = G.elevenlabs_sfx(g, "door slam", 2.0, {})
    validate(g)
    assert out_type(g, a) == "AUDIO"


def test_frame_rules():
    assert G.ltx_frames(97) == 97 and G.ltx_frames(100) == 97 and G.ltx_frames(3) == 9
    assert G.ltx_frames_cover(51) == 57 and G.ltx_frames_cover(57) == 57
