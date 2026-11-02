"""tools/fetch_models.py fetches MODELS.md into any folder and never counts a cut-short file as present."""
import importlib.util
import json
import os
import struct
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("fetch_models", os.path.join(ROOT, "tools", "fetch_models.py"))
fm = importlib.util.module_from_spec(spec)
sys.modules["fetch_models"] = fm
spec.loader.exec_module(fm)


def write_safetensors(path, n_bytes=16, cut=0):
    """A tiny valid .safetensors with one tensor of n_bytes; `cut` drops bytes off the end."""
    header = json.dumps({"t": {"dtype": "U8", "shape": [n_bytes], "data_offsets": [0, n_bytes]}}).encode()
    data = struct.pack("<Q", len(header)) + header + b"\0" * n_bytes
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data[:len(data) - cut] if cut else data)
    return path


def test_check_safetensors(tmp_path):
    assert fm.check_safetensors(write_safetensors(tmp_path / "ok.safetensors")) is None
    assert "cut short" in fm.check_safetensors(write_safetensors(tmp_path / "short.safetensors", cut=5))
    (tmp_path / "tiny.safetensors").write_bytes(b"abc")
    assert fm.check_safetensors(tmp_path / "tiny.safetensors") == "shorter than a header"
    (tmp_path / "huge.safetensors").write_bytes(struct.pack("<Q", 10 ** 9) + b"{}")
    assert "past the end" in fm.check_safetensors(tmp_path / "huge.safetensors")
    (tmp_path / "junk.safetensors").write_bytes(struct.pack("<Q", 4) + b"nope")
    assert fm.check_safetensors(tmp_path / "junk.safetensors").startswith("unreadable")


def test_manifest_matches_models_md():
    """Every file the fetcher saves is documented in MODELS.md, so the two cannot drift apart."""
    doc = open(os.path.join(ROOT, "MODELS.md"), encoding="utf-8").read()
    for m in fm.MANIFEST:
        assert m.saved_name in doc, m.saved_name
    assert {m.group for m in fm.MANIFEST} == set(fm.GROUPS)


def test_select_dedupes_shared_files():
    picked = fm.select(["klein", "krea"])
    targets = [(m.subdir, m.saved_name) for m in picked]
    assert len(targets) == len(set(targets))
    assert ("text_encoders", "qwen3vl_4b_fp8_scaled.safetensors") in targets
    assert all(m.group in ("klein", "krea") for m in picked)


def test_check_missing_cut_short_and_folder(tmp_path):
    lora = next(m for m in fm.MANIFEST if m.saved_name == "depth-control-lora.safetensors")
    assert fm.check(lora, tmp_path) == "missing"
    write_safetensors(lora.target(tmp_path), cut=3)
    assert "cut short" in fm.check(lora, tmp_path)
    write_safetensors(lora.target(tmp_path))
    assert fm.check(lora, tmp_path) is None
    whisper = next(m for m in fm.MANIFEST if m.folder)
    assert fm.check(whisper, tmp_path) == "missing"
    write_safetensors(whisper.target(tmp_path) / "model.safetensors")
    assert fm.check(whisper, tmp_path) is None


def test_accepted_other_name_counts_as_present(tmp_path):
    krea = next(m for m in fm.MANIFEST if m.saved_name == "Krea-2-Turbo.safetensors")
    write_safetensors(tmp_path / "diffusion_models/krea2_turbo_fp8_scaled.safetensors")
    assert fm.check(krea, tmp_path) is None
    assert all(name in open(os.path.join(ROOT, "MODELS.md"), encoding="utf-8").read()
               for m in fm.MANIFEST for name in m.also)


def test_fetch_replaces_a_cut_short_copy_and_rejects_a_bad_download(tmp_path):
    lora = next(m for m in fm.MANIFEST if m.saved_name == "depth-control-lora.safetensors")
    write_safetensors(lora.target(tmp_path), cut=3)

    def good(m, models_dir, staging):
        return write_safetensors(staging / "files" / m.path, n_bytes=32)

    def bad(m, models_dir, staging):
        return write_safetensors(staging / "files" / m.path, cut=2)

    with pytest.raises(RuntimeError, match="incomplete"):
        fm.fetch(lora, tmp_path, tmp_path / fm.STAGING, downloader=bad)
    assert "cut short" in fm.check(lora, tmp_path)  # the old copy is left alone until a good one arrives
    assert fm.fetch(lora, tmp_path, tmp_path / fm.STAGING, downloader=good) == "done"
    assert fm.check(lora, tmp_path) is None


def test_main_dry_run_and_verify(tmp_path, capsys):
    write_safetensors(tmp_path / "loras/krea2/cn/depth-control-lora.safetensors")
    assert fm.main([str(tmp_path), "--groups", "krea", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "have loras/krea2/cn/depth-control-lora.safetensors" in out
    assert "need vae/qwen_image_vae.safetensors (missing)" in out
    assert not (tmp_path / fm.STAGING).exists()
    assert fm.main([str(tmp_path), "--groups", "krea", "--verify"]) == 1


def test_main_keeps_going_past_a_gated_repo(tmp_path, capsys, monkeypatch):
    def gated(m, models_dir, staging):
        raise RuntimeError("403 Client Error. Access to model is restricted and requires approval.")
    monkeypatch.setattr(fm, "download", gated)
    monkeypatch.setattr(fm, "fetch", lambda m, d, s, downloader=gated: downloader(m, d, s))
    assert fm.main([str(tmp_path), "--groups", "krea"]) == 1
    out = capsys.readouterr().out
    assert out.count("FAIL") == 4
    assert "accept the licence at https://huggingface.co/Comfy-Org/Krea-2" in out


@pytest.mark.skipif(sys.platform != "darwin", reason="AppleDouble files are a macOS thing")
def test_remove_appledouble(tmp_path):
    write_safetensors(tmp_path / "vae/a.safetensors")
    (tmp_path / "vae/._a.safetensors").write_bytes(b"\0" * 4)
    assert fm.remove_appledouble(tmp_path) == 1
    assert (tmp_path / "vae/a.safetensors").exists() and not (tmp_path / "vae/._a.safetensors").exists()


def test_extra_paths_snippet(tmp_path):
    text = fm.extra_paths_snippet(tmp_path)
    assert f"base_path: {tmp_path}" in text
    for folder in ("diffusion_models:", "text_encoders:", "loras:", "whisper:"):
        assert folder in text


@pytest.mark.parametrize("header", [[], 5, {"t": 1}, {"t": {"dtype": "U8"}}, {"t": {"data_offsets": [0]}}])
def test_check_safetensors_odd_headers_report_instead_of_crash(tmp_path, header):
    raw = json.dumps(header).encode()
    (tmp_path / "x.safetensors").write_bytes(struct.pack("<Q", len(raw)) + raw)
    assert fm.check_safetensors(tmp_path / "x.safetensors") == "header is not a valid safetensors header"


def test_check_safetensors_metadata_only_is_complete(tmp_path):
    raw = json.dumps({"__metadata__": {"format": "pt"}}).encode()
    (tmp_path / "x.safetensors").write_bytes(struct.pack("<Q", len(raw)) + raw)
    assert fm.check_safetensors(tmp_path / "x.safetensors") is None


def test_gated_hint_ignores_numbers_that_merely_contain_403():
    assert fm.gated_hint(OSError("write failed at offset 14030"), "a/b") is None
    assert "gated" in fm.gated_hint(RuntimeError("HTTP 403 Forbidden"), "a/b")
    assert "not logged in" in fm.gated_hint(RuntimeError("401 Client Error"), "a/b")


def test_fetch_replaces_a_directory_squatting_on_the_target(tmp_path):
    lora = next(m for m in fm.MANIFEST if m.saved_name == "depth-control-lora.safetensors")
    (lora.target(tmp_path) / "junk").mkdir(parents=True)
    good = lambda m, d, s: write_safetensors(s / "files" / m.path)
    assert fm.fetch(lora, tmp_path, tmp_path / fm.STAGING, downloader=good) == "done"
    assert fm.check(lora, tmp_path) is None


def test_complete_other_name_beats_cut_short_saved_name(tmp_path):
    krea = next(m for m in fm.MANIFEST if m.saved_name == "Krea-2-Turbo.safetensors")
    write_safetensors(tmp_path / "diffusion_models/Krea-2-Turbo.safetensors", cut=4)
    write_safetensors(tmp_path / "diffusion_models/krea2_turbo_fp8_scaled.safetensors")
    assert fm.check(krea, tmp_path) is None


def test_refuses_a_folder_on_an_unmounted_drive(tmp_path, capsys):
    assert fm.main([str(tmp_path / "not-mounted" / "models"), "--dry-run"]) == 2
    assert "mounted" in capsys.readouterr().err
    assert not (tmp_path / "not-mounted").exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="AppleDouble files are a macOS thing")
def test_appledouble_needs_its_twin(tmp_path):
    (tmp_path / "._orphan").write_bytes(b"x")
    assert fm.remove_appledouble(tmp_path) == 0 and (tmp_path / "._orphan").exists()
