"""Shot Project: versioned shot folders. Publish, numbering, approval, resolve, safety, and a real take's recipe."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import shotproject as SP  # noqa: E402


def _file(tmp_path, name="take.mp4", data=b"clip"):
    p = tmp_path / "src" / name
    p.parent.mkdir(exist_ok=True)
    p.write_bytes(data)
    return str(p)


def test_slug_is_a_safe_name():
    assert SP.slug("../../etc/passwd") == "etc_passwd"
    assert SP.slug("SEQ 010!") == "SEQ_010"
    assert SP.slug("") == "x" and SP.slug(None, "SHOT") == "SHOT"
    assert "/" not in SP.slug("a/b\\c")


def test_publish_numbers_versions_and_keeps_files(tmp_path):
    root = str(tmp_path / "proj")
    a = SP.publish(root, "SEQ010", "SH010", "final", [(_file(tmp_path, data=b"one"), "video")], {"recipe": {"a": 1}}, note="first")
    b = SP.publish(root, "SEQ010", "SH010", "final", [(_file(tmp_path, data=b"two"), "video")], None, note="second")
    assert (a["name"], b["name"]) == ("v001", "v002")
    assert Path(a["dir"], "recipe.json").is_file() and not Path(b["dir"], "recipe.json").exists()
    assert Path(a["dir"], a["primary"]).read_bytes() == b"one"
    assert a["files"][0]["bytes"] == 3 and len(a["files"][0]["sha256"]) == 64
    idx = json.loads((Path(root) / "SEQ010" / "SH010" / "final" / "versions.json").read_text())
    assert idx["latest"] == 2 and idx["approved"] is None and [v["note"] for v in idx["versions"]] == ["first", "second"]


def test_resolve_latest_approved_and_numbered(tmp_path):
    root = str(tmp_path / "p")
    for d in (b"1", b"2", b"3"):
        SP.publish(root, "S", "H", "final", [(_file(tmp_path, data=d), "video")])
    assert SP.resolve(root, "S", "H", "final")["number"] == 3
    with pytest.raises(LookupError, match="no approved"):
        SP.resolve(root, "S", "H", "final", "approved")   # never silently the latest
    SP.approve(root, "S", "H", "final", "v2")
    r = SP.resolve(root, "S", "H", "final", "approved")
    assert r["number"] == 2 and Path(r["primary_path"]).read_bytes() == b"2"
    assert SP.resolve(root, "S", "H", "final", "v1")["number"] == 1 and SP.resolve(root, "S", "H", "final", 3)["number"] == 3
    with pytest.raises(ValueError):
        SP.approve(root, "S", "H", "final", "v9")
    with pytest.raises(LookupError):
        SP.resolve(root, "S", "H", "final", "v9")


def test_approve_on_publish(tmp_path):
    root = str(tmp_path / "p")
    SP.publish(root, "S", "H", "final", [(_file(tmp_path), "video")])
    SP.publish(root, "S", "H", "final", [(_file(tmp_path), "video")], approve_it=True)
    assert SP.approved_number(root, "S", "H", "final") == 2


def test_a_half_written_version_is_ignored_and_not_reused(tmp_path):
    root = str(tmp_path / "p")
    SP.publish(root, "S", "H", "final", [(_file(tmp_path), "video")])
    crash = Path(SP.task_dir(root, "S", "H", "final")) / "v002"
    (crash / "media").mkdir(parents=True)      # no version.json: a crash mid-copy
    assert [v["number"] for v in SP.versions(root, "S", "H", "final")] == [1]
    assert SP.publish(root, "S", "H", "final", [(_file(tmp_path), "video")])["number"] == 3


def test_failed_publish_leaves_no_folder(tmp_path):
    root = str(tmp_path / "p")
    with pytest.raises(FileNotFoundError):
        SP.publish(root, "S", "H", "final", [(str(tmp_path / "missing.mp4"), "video")])
    with pytest.raises(ValueError):
        SP.publish(root, "S", "H", "final", [])
    assert SP.versions(root, "S", "H", "final") == []
    assert not any(p.name.startswith("v0") for p in Path(SP.task_dir(root, "S", "H", "final")).glob("*")) if Path(SP.task_dir(root, "S", "H", "final")).exists() else True


def test_paths_cannot_escape_the_project(tmp_path):
    root = tmp_path / "p"
    v = SP.publish(str(root), "../../x", "../y", "../../z", [(_file(tmp_path), "video")])
    assert Path(v["dir"]).resolve().is_relative_to(root.resolve())


def test_folder_publish_keeps_a_layer_pack_whole(tmp_path):
    pack = tmp_path / "pack"
    (pack / "layers").mkdir(parents=True)
    (pack / "manifest.json").write_text("{}")
    (pack / "layers" / "a.png").write_bytes(b"png")
    v = SP.publish(str(tmp_path / "p"), "S", "H", "comp", [(_file(tmp_path), "video"), (str(pack), "layerpack")])
    assert v["primary"].endswith("take.mp4")
    got = sorted(f["path"] for f in v["files"] if f["role"] == "layerpack")
    assert got == ["media/pack/layers/a.png", "media/pack/manifest.json"]


def test_duplicate_file_names_both_kept(tmp_path):
    a = _file(tmp_path, "x.png", b"a")
    b = tmp_path / "other" / "x.png"
    b.parent.mkdir()
    b.write_bytes(b"b")
    v = SP.publish(str(tmp_path / "p"), "S", "H", "frame", [(a, "frame"), (str(b), "extra")])
    assert sorted(f["path"] for f in v["files"]) == ["media/x.png", "media/x_1.png"]


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_a_take_with_a_soundstage_tag_publishes_its_recipe(tmp_path):
    rec = {"v": 1, "app": "Soundstage", "scene": {"camera": {"x": 1}}, "shot": {"id": "s1"}}
    mp4 = tmp_path / "t.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x64:d=0.2:r=8",
                    "-metadata", "soundstage=" + json.dumps(rec), "-metadata", 'prompt={"1": {"class_type": "X"}}',
                    "-movflags", "use_metadata_tags", "-pix_fmt", "yuv420p", str(mp4)], check=True)
    extras = SP.collect_take_extras(str(mp4))
    assert extras["recipe"]["scene"] == rec["scene"] and extras["graph"] == {"1": {"class_type": "X"}}
    v = SP.publish(str(tmp_path / "p"), "S", "H", "final", [(str(mp4), "video")], extras)
    assert sorted(v["extras"]) == ["graph", "recipe"]
    assert json.loads(Path(v["dir"], "recipe.json").read_text())["scene"] == rec["scene"]


def test_collect_extras_on_a_non_video_returns_nothing_not_an_error(tmp_path):
    assert SP.collect_take_extras(_file(tmp_path, "notes.txt", b"hello")) == {}
