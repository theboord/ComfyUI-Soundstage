"""Lifelike-only L1: the Rocketbox installer's plan (no downloads) and the offline per-tier texture downscale."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rocketbox_install", ROOT / "soundstage/assets/rocketbox_install.py")
RI = importlib.util.module_from_spec(spec)
spec.loader.exec_module(RI)


def test_plan_fetches_nothing_now_and_pins_the_commit():
    p = RI.plan()
    assert p["downloads_now"] is False
    assert p["commit"] == "0943055db6ec570bcef9f2c8b41c9e5467c808f9"
    assert all(f["sha256"] is None for f in p["fetch"]), "hashes are recorded at approval, not invented"
    assert not any("specular" in f["path"] for f in p["fetch"]), "the specular maps are never loaded"
    assert len([f for f in p["fetch"] if f["to"].endswith(".fbx") and "/" not in f["to"]]) == 2
    assert sorted(b["size"] for b in p["build"]) == [256, 512, 1024]
    assert p["decimate"] is None


def test_downscale_writes_tier_textures_and_a_hashed_manifest(tmp_path):
    Image = pytest.importorskip("PIL.Image")
    src = tmp_path / "tex"
    src.mkdir()
    Image.new("RGBA", (64, 64), (200, 120, 90, 128)).save(src / "x001_opacity_color.png")
    Image.new("RGB", (64, 64), (10, 20, 30)).save(src / "x001_body_color.png")
    Image.new("RGB", (64, 64), (1, 2, 3)).save(src / "x001_body_specular.png")
    man = RI.downscale(src, tmp_path / "out", sizes=(32, 16))
    outs = sorted(f["out"] for f in man["files"])
    assert outs == ["tex_16/x001_body_color.png", "tex_16/x001_opacity_color.png", "tex_32/x001_body_color.png", "tex_32/x001_opacity_color.png"]
    with Image.open(tmp_path / "out/tex_16/x001_opacity_color.png") as im:
        assert im.size == (16, 16) and im.mode == "RGBA", "the opacity map keeps its alpha"
    saved = json.loads((tmp_path / "out/tex_manifest.json").read_text())
    assert all(len(f["out_sha256"]) == 64 and len(f["in_sha256"]) == 64 for f in saved["files"])
    # pinned converter: the same input gives the same bytes
    again = RI.downscale(src, tmp_path / "out2", sizes=(32, 16))
    assert [f["out_sha256"] for f in again["files"]] == [f["out_sha256"] for f in man["files"]]
