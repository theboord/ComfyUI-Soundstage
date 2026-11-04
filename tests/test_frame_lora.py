"""④ Frame's single add-on LoRA, server side (soundstage/router/lora_check.py): any LoRA can be picked; one that is gone
or whose own header says it was made for another model family stops the frame with a sentence, not a crash, and the
LoRA is applied to whichever image model paints the frame (FLUX 3 Klein, or Krea 2 Turbo).

No ComfyUI, torch or GPU needed: the safetensors files are headers only.
"""
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.router import lora_check as LC  # noqa: E402
from soundstage.router import adapters as A  # noqa: E402


def _st(tmp_path, name, keys=(), meta=None):
    hdr = {k: {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]} for k in keys}
    if meta:
        hdr["__metadata__"] = meta
    raw = json.dumps(hdr).encode()
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(struct.pack("<Q", len(raw)) + raw + b"\0\0")
    return str(p)


def test_family_from_the_files_own_header(tmp_path):
    sdxl = _st(tmp_path, "a.safetensors", ["lora_unet_input_blocks_4_1_proj_in.lora_down.weight", "lora_te2_text_model.lora_up.weight"])
    sd15 = _st(tmp_path, "b.safetensors", ["lora_unet_down_blocks_0_attentions_0.lora_down.weight", "lora_te_text_model.alpha"])
    ltx = _st(tmp_path, "c.safetensors", ["diffusion_model.transformer_blocks.0.audio_attn1.to_k.lora_A.weight"])
    klein = _st(tmp_path, "d.safetensors", ["diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight"], {"modelspec.architecture": "flux-2-klein-9b/lora"})
    kohya = _st(tmp_path, "e.safetensors", ["x"], {"ss_base_model_version": "sdxl_base_v1-0"})
    plain = _st(tmp_path, "f.safetensors", ["diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight"])
    assert LC.family_of(LC.read_header(sdxl)) == "sdxl"
    assert LC.family_of(LC.read_header(sd15)) == "sd"
    assert LC.family_of(LC.read_header(ltx)) == "ltx"
    assert LC.family_of(LC.read_header(klein)) == "klein"
    assert LC.family_of(LC.read_header(kohya)) == "sdxl"
    assert LC.family_of(LC.read_header(plain)) is None, "transformer keys alone don't say which model: unknown"
    assert LC.read_header(str(tmp_path / "missing.safetensors")) == {}
    (tmp_path / "junk.safetensors").write_bytes(b"not a safetensors file")
    assert LC.read_header(str(tmp_path / "junk.safetensors")) == {}


def test_check_says_why_and_never_raises(tmp_path):
    files = {"sdxl/detail.safetensors": _st(tmp_path, "sdxl/detail.safetensors", ["lora_te2_x.lora_up.weight"]),
             "mara_v3.safetensors": _st(tmp_path, "mara_v3.safetensors", ["diffusion_model.double_blocks.0.x.lora_A.weight"]),
             "klein/noir.safetensors": _st(tmp_path, "klein/noir.safetensors", ["k"], {"modelspec.architecture": "flux-2-klein"})}
    avail = list(files)
    fp = files.get
    assert LC.check(None, "flux3_klein", avail, fp) is None
    assert LC.check("None", "krea2", avail, fp) is None
    assert LC.check("mara_v3.safetensors", "flux3_klein", avail, fp) is None, "unknown family: it runs"
    assert LC.check("klein/noir.safetensors", "flux3_klein", avail, fp) is None
    why = LC.check("sdxl/detail.safetensors", "flux3_klein", avail, fp)
    assert "made for SDXL" in why and "FLUX 3 Klein" in why and "Matches this model" in why
    assert "Krea 2" in LC.check("klein/noir.safetensors", "krea2", avail, fp), "a Klein LoRA on Krea 2 Turbo (Strict lock)"
    gone = LC.check("old.safetensors", "flux3_klein", avail, fp)
    assert "isn't in models/loras any more" in gone
    boom = lambda n: (_ for _ in ()).throw(OSError("disk"))  # noqa: E731
    assert LC.check("mara_v3.safetensors", "flux3_klein", avail, boom) is None, "an unreadable file is unknown, not a crash"


def test_the_router_runs_the_check_before_building_the_graph():
    src = open(os.path.join(ROOT, "soundstage", "nodes_router.py")).read()
    i = src.index("LC.check(row[\"name\"]")
    assert src.index("\"lora\": v.get(\"lora\")") < i < src.index("return m, p, g"), "after p is built, before the graph"
    assert "raise RouterError(why)" in src[i:i + 200]
    assert src.index("p[\"loras\"] = lora_stack(") < i, "every row of the stack is checked"


class G:
    def __init__(self):
        self.nodes = []

    def node(self, cls, **kw):
        n = type("N", (), {})()
        n.cls, n.kw = cls, kw
        n.out = lambda i, _n=len(self.nodes): ["n%d" % _n, i]
        self.nodes.append(n)
        return n


def test_the_lora_reaches_klein_and_krea_2_turbo():
    for adapter in (A.flux3_klein, A.krea2):
        g = G()
        w = {"unet": "u", "text_encoder": "t", "vae": "v", "krea_unet": "u", "krea_text_encoder": "t", "krea_vae": "v"}
        p = {"stage": "generate_image", "prompt": "a", "negative": "", "seed": 1, "width": 512, "height": 512, "refs": [],
             "params": {}, "weights": w, "steps": 0, "cfg": 0.0, "lora": "mara_v3.safetensors", "lora_strength": 0.7,
             "image": None, "control": None}
        adapter(g, {"variant": None}, p)
        lo = [n for n in g.nodes if n.cls == "LoraLoaderModelOnly"]
        assert len(lo) == 1 and lo[0].kw["lora_name"] == "mara_v3.safetensors" and lo[0].kw["strength_model"] == 0.7, adapter.__name__


def test_motion_lora_stack_says_when_it_isnt_an_ltx_lora():
    """⑤ Motion's LoRA stack (SoundstageLTXLoRA, node 9101): a missing file and a LoRA whose header names another model
    both stop with a sentence, before any row is applied (nodes_quality imports torch, so the wiring is read from the source)."""
    src = open(os.path.join(ROOT, "soundstage", "nodes_quality.py")).read()
    body = src[src.index("def execute(cls, model, lora_name"):]
    assert body.index("LoRA not found on this server") < body.index("ltx_lora_problem(r[\"name\"], path)") < body.index("load_torch_file")
    assert body.index("raise ValueError(why)") < body.index("load_torch_file"), "all files are checked before the first is applied"
    assert "for r, path in zip(rows, paths)" in body and "load_lora_for_models(m, None, lora, r[\"strength\"], 0)" in body, "chained in order"
    fn = src[src.index("def ltx_lora_problem"):src.index("class SoundstageLTXLoRA")]
    assert 'got != "ltx"' in fn and "not LTX" in fn


def test_frame_lora_stack_chains_in_order_and_the_old_single_pair_is_one_row():
    """④ Frame: the `loras` JSON builds one LoraLoaderModelOnly per row, in order, on Klein and Krea 2 Turbo; the older
    lora + lora_strength pair is a one-row stack; a stack beats the pair."""
    rows = A.lora_stack('[{"name": "a.safetensors", "strength": 0.5}, {"name": "b.safetensors", "strength": 1.2}, {"name": "None"}]', "old.safetensors", 0.9)
    assert rows == [{"name": "a.safetensors", "strength": 0.5}, {"name": "b.safetensors", "strength": 1.2}]
    assert A.lora_stack("", "old.safetensors", 0.9) == [{"name": "old.safetensors", "strength": 0.9}]
    assert A.lora_stack("not json", None, 1.0) == [] and A.lora_stack("[]", "None", 1.0) == []
    for adapter in (A.flux3_klein, A.krea2):
        g = G()
        w = {"unet": "u", "text_encoder": "t", "vae": "v", "krea_unet": "u", "krea_text_encoder": "t", "krea_vae": "v"}
        p = {"stage": "generate_image", "prompt": "a", "negative": "", "seed": 1, "width": 512, "height": 512, "refs": [],
             "params": {}, "weights": w, "steps": 0, "cfg": 0.0, "lora": None, "lora_strength": 1.0, "loras": rows,
             "image": None, "control": None}
        adapter(g, {"variant": None}, p)
        lo = [n for n in g.nodes if n.cls == "LoraLoaderModelOnly"]
        assert [(n.kw["lora_name"], n.kw["strength_model"]) for n in lo] == [("a.safetensors", 0.5), ("b.safetensors", 1.2)], adapter.__name__
        assert lo[1].kw["model"] == ["n%d" % g.nodes.index(lo[0]), 0], "the second LoRA sits on the first's model"


def test_frame_sampler_scheduler_and_shift_reach_the_graph():
    for adapter, tuned in ((A.flux3_klein, ("er_sde", "simple")), (A.krea2, ("euler_ancestral", "beta"))):
        w = {"unet": "u", "text_encoder": "t", "vae": "v", "krea_unet": "u", "krea_text_encoder": "t", "krea_vae": "v"}
        base = {"stage": "generate_image", "prompt": "a", "negative": "", "seed": 1, "width": 512, "height": 512, "refs": [],
                "params": {}, "weights": w, "steps": 0, "cfg": 0.0, "lora": None, "lora_strength": 1.0, "image": None, "control": None}
        g = G(); adapter(g, {"variant": None}, {**base, "sampler": "auto", "scheduler": "auto", "shift": 0.0})
        k = next(n for n in g.nodes if n.cls == "KSampler")
        assert (k.kw["sampler_name"], k.kw["scheduler"]) == tuned and not [n for n in g.nodes if n.cls == "ModelSamplingAuraFlow"]
        g = G(); adapter(g, {"variant": None}, {**base, "sampler": "euler", "scheduler": "karras", "shift": 2.5})
        k = next(n for n in g.nodes if n.cls == "KSampler")
        sh = [n for n in g.nodes if n.cls == "ModelSamplingAuraFlow"]
        assert (k.kw["sampler_name"], k.kw["scheduler"]) == ("euler", "karras") and sh and sh[0].kw["shift"] == 2.5, adapter.__name__
