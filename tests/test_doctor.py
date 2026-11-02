"""soundstage/doctor.py: the setup check (CLI `python -m soundstage.doctor`, App: Tools ▾ › Check my setup).

No ComfyUI needed: the probes are fed fake folders, a fake HTTP server and fake ComfyUI modules.
"""
import io
import json
import os
import re
import sys
import types

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

from soundstage import doctor as D  # noqa: E402

MB = 1 << 20


def _write(p, n):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.truncate(n)


@pytest.fixture
def comfy(tmp_path):
    m = tmp_path / "models"
    (tmp_path / "comfyui_version.py").write_text('__version__ = "0.43.0"\n')
    for d in ("ComfyUI-Soundstage", "ComfyUI-LTXVideo", "comfyui-krea2-controlnet"):
        (tmp_path / "custom_nodes" / d).mkdir(parents=True)
    # the full default set, with one file as another build, one in a subfolder, one truncated
    _write(str(m / "diffusion_models" / "flux3-image-klein-int8-convrot.safetensors"), 2 * MB)
    _write(str(m / "text_encoders" / "qwen3vl_4b_fp8_scaled.safetensors"), 2 * MB)
    _write(str(m / "vae" / "flux2-vae.safetensors"), 2 * MB)
    _write(str(m / "diffusion_models" / "ltx-2.5-22b-distilled-transformer-bf16.safetensors"), 2 * MB)
    _write(str(m / "text_encoders" / "gemma4-12b-with-proj-ltx-2.5-fp8-scaled.safetensors"), 2 * MB)  # other build
    _write(str(m / "vae" / "ltx-2.5-video-vae-bf16.safetensors"), 2 * MB)
    _write(str(m / "vae" / "ltx-2.5-audio-vae-bf16.safetensors"), 2 * MB)
    _write(str(m / "latent_upscale_models" / "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"), 2 * MB)
    _write(str(m / "loras" / "ltx2.5" / "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"), 2 * MB)
    return tmp_path


def _feature(rep, fid):
    return next(f for f in rep["features"] if f["id"] == fid)


def test_disk_report_reads_folders_and_accepts_other_builds(comfy):
    rep = D.build_report(D.DiskProbe(str(comfy)))
    assert rep["comfyui_version"] == "0.43.0" and rep["mode"] == "from disk"
    motion = _feature(rep, "motion")
    assert motion["status"] == "ready", motion
    te = next(x for x in motion["files"] if x["folder"] == "text_encoders")
    assert te["status"] == "other_build" and "fp8-scaled" in te["found"]
    lora = next(x for x in motion["files"] if x["folder"] == "loras")
    assert lora["status"] == "ok" and lora["found"].startswith("ltx2.5/")
    assert _feature(rep, "frame")["status"] == "ready"
    assert _feature(rep, "krea")["status"] == "not ready"  # optional: no Krea 2 files here
    packs = {p["id"]: p["status"] for p in rep["packs"]}
    assert packs["ltxvideo"] == packs["krea2cn"] == packs["soundstage"] == "ok"
    assert packs["controlnet_aux"] == "missing" and packs["core"] == "ok"  # by version on disk
    # required steps are only Python packages this test Python may lack, never model files
    assert not [s for s in rep["steps"] if s["required"] and "Download" in s["text"]]


def test_truncated_and_missing_files_are_steps_with_links(comfy):
    _write(str(comfy / "models" / "vae" / "flux2-vae.safetensors"), 10)
    os.remove(comfy / "models" / "vae" / "ltx-2.5-audio-vae-bf16.safetensors")
    rep = D.build_report(D.DiskProbe(str(comfy)))
    vae = next(x for x in _feature(rep, "frame")["files"] if x["folder"] == "vae")
    assert vae["status"] == "incomplete"
    texts = [s["text"] for s in rep["steps"] if s["required"]]
    assert any(t.startswith("Download again (the file is incomplete) flux2-vae") for t in texts)
    step = next(s for s in rep["steps"] if "ltx-2.5-audio-vae-bf16" in s["text"])
    assert step["required"] and step["url"].startswith("https://huggingface.co/Lightricks/")
    assert not rep["ok"]
    txt = D.format_text(rep)
    assert "Not ready yet" in txt and "models/vae/" in txt


def test_match_file_follows_the_apps_rules():
    have = [("sub/Krea-2-Turbo.safetensors", 5 * MB), ("krea2_turbo_fp8_scaled.safetensors", 5 * MB)]
    assert D.match_file(["Krea-2-Turbo.safetensors"], have)[:2] == ("ok", "sub/Krea-2-Turbo.safetensors")
    assert D.match_file(["krea2_turbo_int8_convrot.safetensors"], have)[0] == "other_build"
    assert D.match_file(["z_image_turbo_bf16.safetensors"], have)[0] == "missing"
    # the same family words as web/ui/modelmatch.mjs familyKey()
    assert D.family_key("Krea-2-Turbo.safetensors") == D.family_key("krea2_turbo_fp8_scaled.safetensors") == "krea2turbo"
    assert D.family_key("loras/ltx2.5/x-bf16.safetensors") == "x"


def test_vram_verdicts_claim_only_what_was_measured():
    motion = next(f for f in D.FEATURES if f["id"] == "motion")
    setf = next(f for f in D.FEATURES if f["id"] == "set")
    assert D.vram_verdict(setf, 0)[0] == "fits"
    assert D.vram_verdict(motion, 47.5)[0] == "fits"
    assert D.vram_verdict(motion, 24)[0] == "untested"
    assert D.vram_verdict(motion, 16)[0] == "no"
    assert D.vram_verdict(motion, 0)[0] == "no"
    assert D.vram_verdict(motion, None)[0] == "unknown"


def test_every_file_the_doctor_names_is_documented():
    md = open(os.path.join(ROOT, "MODELS.md"), encoding="utf-8").read()
    md += open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()  # SAM 3D Body is in README's model table
    for f in D.FEATURES:
        for spec in f.get("files", []):
            name = spec["any"][0]  # the one the doctor tells people to download
            assert name in md, f"{name} ({f['id']}) is not in MODELS.md or README.md"


def test_every_pack_class_is_a_real_node_name():
    import validate_workflows as V
    info, _ = V.offline_schemas()
    names = set(info)
    for p in D.PACKS:
        for c in p["classes"]:
            assert c in names, f"{p['id']}: {c} is in no /object_info snapshot"


def test_required_packs_match_the_install_guide():
    readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    for p in D.PACKS:
        if p["required"] and p["id"] not in ("core", "soundstage"):
            assert p["url"] in readme, p["url"]


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_server(monkeypatch, classes, files, doctor_route=False, vram=48 * 2**30):
    asked = []

    def urlopen(url, timeout=0):
        url = url.full_url if hasattr(url, "full_url") else url
        path = url.split("8188", 1)[1]
        asked.append(path)
        if path == "/soundstage/doctor":
            if not doctor_route:
                raise D.urllib.error.URLError("404")
            return _Resp(json.dumps({"features": [], "packs": [], "steps": [], "ok": True, "mode": "inside ComfyUI"}).encode())
        if path == "/system_stats":
            return _Resp(json.dumps({"system": {"comfyui_version": "0.43.0"},
                                     "devices": [{"name": "cuda:0 RTX 6000 Ada", "type": "cuda", "vram_total": vram}]}).encode())
        if path == "/models":
            return _Resp(json.dumps(sorted(files)).encode())
        if path.startswith("/models/"):
            return _Resp(json.dumps(files.get(path[8:], [])).encode())
        m = re.fullmatch(r"/object_info/([^/]+)", path)
        if m:
            c = D.urllib.parse.unquote(m.group(1))
            return _Resp(json.dumps({c: {"input": {}}} if c in classes else {}).encode())
        raise AssertionError(f"unexpected request {path}")

    monkeypatch.setattr(D.urllib.request, "urlopen", urlopen)
    return asked


def test_http_probe_asks_one_class_at_a_time(monkeypatch):
    classes = {c for p in D.PACKS if p["required"] for c in p["classes"]}
    files = {"diffusion_models": ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"], "vae": [],
             "text_encoders": [], "loras": [], "latent_upscale_models": [], "checkpoints": []}
    asked = _fake_server(monkeypatch, classes, files)
    rep = D.build_report(D.HttpProbe("http://127.0.0.1:8188"))
    assert "/object_info" not in asked  # never the full list
    assert all(re.fullmatch(r"/object_info/[^/]+", a) for a in asked if a.startswith("/object_info"))
    assert {p["id"]: p["status"] for p in rep["packs"]}["ltxvideo"] == "ok"
    assert {p["id"]: p["status"] for p in rep["packs"]}["vhs"] == "missing"
    assert rep["gpu"]["vram_gb"] == 48.0 and _feature(rep, "motion")["vram"] == "fits"
    assert all(d["status"] == "unknown" for d in rep["deps"])  # can't see ComfyUI's Python from outside
    assert _feature(rep, "voice")["files"][0]["status"] == "unknown"
    assert "not checked" in D.format_text(rep)


def test_cli_prefers_the_report_from_inside_comfyui(monkeypatch, capsys):
    asked = _fake_server(monkeypatch, set(), {}, doctor_route=True)
    assert D.main(["--url", "http://127.0.0.1:8188", "--json"]) == 0
    assert asked == ["/soundstage/doctor"]
    assert json.loads(capsys.readouterr().out)["mode"] == "inside ComfyUI"


def test_cli_falls_back_to_single_class_queries(monkeypatch, capsys):
    asked = _fake_server(monkeypatch, set(), {}, doctor_route=False)
    assert D.main(["--url", "http://127.0.0.1:8188"]) == 1  # nothing installed
    out = capsys.readouterr().out
    assert "Looked over HTTP" in out and "Install ComfyUI-LTXVideo" in out
    assert asked[0] == "/soundstage/doctor" and "/object_info" not in asked


def test_in_process_probe_uses_comfyuis_own_lists(monkeypatch, tmp_path):
    lora = tmp_path / "loras" / "ltx2.5" / "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"
    _write(str(lora), 3 * MB)
    (tmp_path / "whisper" / "whisper-base").mkdir(parents=True)
    (tmp_path / "whisper" / "whisper-base" / "config.json").write_text("{}")
    fp = types.ModuleType("folder_paths")
    fp.models_dir = str(tmp_path)
    fp.get_filename_list = lambda folder: ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"] if folder == "loras" else []
    fp.get_full_path = lambda folder, name: str(tmp_path / folder / name)
    fp.get_folder_paths = lambda kind: [str(tmp_path / kind)]
    nodes = types.ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = {c: object for p in D.PACKS for c in p["classes"]}
    mm = types.ModuleType("comfy.model_management")
    mm.get_torch_device = lambda: types.SimpleNamespace(type="cuda")
    mm.get_torch_device_name = lambda d: "cuda:0 NVIDIA RTX 6000 Ada"
    mm.get_total_memory = lambda d: 47.5 * 2**30
    comfy_pkg = types.ModuleType("comfy")
    comfy_pkg.model_management = mm
    for k, v in {"folder_paths": fp, "nodes": nodes, "comfy": comfy_pkg, "comfy.model_management": mm}.items():
        monkeypatch.setitem(sys.modules, k, v)
    rep = D.build_report(D.InProcessProbe())
    assert rep["mode"] == "inside ComfyUI"
    assert all(p["status"] == "ok" for p in rep["packs"])
    lora_x = next(x for x in _feature(rep, "motion")["files"] if x["folder"] == "loras")
    assert lora_x["status"] == "ok" and lora_x["bytes"] == 3 * MB
    assert _feature(rep, "voice")["status"] == "ready"
    assert rep["gpu"]["vram_gb"] == 47.5 and _feature(rep, "motion")["vram"] == "fits"


def test_doctor_route_is_registered_with_the_pack():
    init = open(os.path.join(ROOT, "__init__.py"), encoding="utf-8").read()
    assert '"doctor"' in init
