"""Model downloader: catalog validation, install-script parity, target paths, states, tiers, token storage."""
import json
import os
import re
import stat

import pytest

from modeldl_fake import ROOT, TOKEN, stub_folder_paths, mini_catalog  # noqa: F401
from soundstage import modeldl as M

CAT = json.loads((ROOT / "web" / "models" / "catalog.json").read_text())


def test_shipped_catalog_validates():
    assert M.validate(CAT) == []
    assert len({i["id"] for i in CAT["items"]}) == len(CAT["items"])


def test_every_install_script_get_line_is_in_the_catalog():
    """tools/install_runpod.sh is read as text (never edited): each `get` there has a matching catalog item."""
    src = (ROOT / "tools" / "install_runpod.sh").read_text()
    gets = re.findall(r"^\s*(?:\[.*\]\s*\|\|\s*)?get\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*$", src, re.M)
    assert len(gets) >= 10
    for repo, path, sub, name in gets:
        folder, _, subdir = sub.partition("/")
        name = name or path.split("/")[-1]
        hit = [i for i in CAT["items"] if i["repo"] == repo and i["path"] == path]
        assert hit, f"no catalog item for {repo} {path}"
        it = hit[0]
        assert (it["folder"], it["subdir"], it["saved_name"]) == (folder, subdir, name)


def test_models_md_names_every_saved_file():
    md = (ROOT / "MODELS.md").read_text()
    for it in CAT["items"]:
        assert it["saved_name"] in md, it["id"]


@pytest.mark.parametrize("patch,needle", [
    ({"id": "Bad ID"}, "bad id"),
    ({"path": "../etc/passwd"}, "path"),
    ({"path": "/abs/x.safetensors"}, "path"),
    ({"path": "a\\b.safetensors"}, "path"),
    ({"folder": "custom_nodes"}, "folder"),
    ({"subdir": "../x"}, "subdir"),
    ({"saved_name": "a/b.safetensors"}, "saved_name"),
    ({"saved_name": "run.py"}, "saved_name"),
    ({"sha256": "abc"}, "sha256"),
    ({"licences": ["nope"]}, "licences"),
    ({"group": "nope"}, "group"),
    ({"repo": "noslash"}, "repo"),
])
def test_validate_rejects(patch, needle):
    cat = json.loads(json.dumps(CAT))
    cat["items"][0].update(patch)
    errs = M.validate(cat)
    assert errs and any(needle in e for e in errs), errs


def test_validate_rejects_unknown_set_and_tier_set():
    cat = json.loads(json.dumps(CAT))
    cat["sets"]["x"] = ["no-such-id"]
    cat["tiers"][0]["sets"].append("no-such-set")
    errs = M.validate(cat)
    assert any("set x" in e for e in errs) and any("tier" in e for e in errs)


def test_target_and_traversal(tmp_path, monkeypatch):
    models = stub_folder_paths(monkeypatch, tmp_path)
    it = dict(CAT["items"][0])
    assert M.target(it) == (models / "diffusion_models" / it["saved_name"]).resolve()
    lora = next(i for i in CAT["items"] if i["id"] == "ltx25-layout-lora")
    assert M.target(lora).parent == (models / "loras" / "ltx2.5").resolve()
    for bad in ({"subdir": "../x"}, {"subdir": "/etc"}, {"saved_name": "../x.safetensors"}, {"folder": "custom_nodes"}):
        with pytest.raises(ValueError):
            M.target({**it, **bad})
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, models / "loras" / "evil")
    with pytest.raises(ValueError):
        M.target({**lora, "subdir": "evil"})
    # a model file the user symlinked in from a shared volume is allowed: only the write path is checked
    (outside / "f.safetensors").write_bytes(b"x")
    os.symlink(outside / "f.safetensors", models / "vae" / "f.safetensors")
    linked = {**it, "folder": "vae", "saved_name": "f.safetensors", "size": None}
    assert M.target(linked) == (models / "vae").resolve() / "f.safetensors"
    st = M.item_state(linked)
    assert st == {"state": "installed", "have_bytes": 1}       # size-checked through the link


def test_symlinked_model_counts_as_installed_and_part_symlink_is_not_trusted(tmp_path, monkeypatch):
    models = stub_folder_paths(monkeypatch, tmp_path)
    it = next(i for i in CAT["items"] if i["id"] == "flux2-vae")
    shared = tmp_path / "shared"
    shared.mkdir()
    real = shared / "flux2-vae.safetensors"
    with open(real, "wb") as f:
        f.truncate(it["size"])
    os.symlink(real, models / "vae" / "flux2-vae.safetensors")
    assert M.item_state(it)["state"] == "installed"
    # a dangling link is not a file: missing, so it can be fetched (the download replaces the link)
    os.unlink(models / "vae" / "flux2-vae.safetensors")
    os.symlink(shared / "gone.safetensors", models / "vae" / "flux2-vae.safetensors")
    assert M.item_state(it)["state"] == "missing"
    # a .part symlinked out of the folder is not reported as progress
    os.unlink(models / "vae" / "flux2-vae.safetensors")
    (shared / "p").write_bytes(b"abc")
    os.symlink(shared / "p", models / "vae" / "flux2-vae.safetensors.part")
    assert M.item_state(it) == {"state": "missing", "have_bytes": 0}


def test_states(tmp_path, monkeypatch):
    models = stub_folder_paths(monkeypatch, tmp_path)
    it = next(i for i in CAT["items"] if i["id"] == "flux2-vae")
    assert M.item_state(it) == {"state": "missing", "have_bytes": 0}
    (models / "vae" / "flux2-vae.safetensors.part").write_bytes(b"abc")
    assert M.item_state(it) == {"state": "partial", "have_bytes": 3}
    full = models / "vae" / "flux2-vae.safetensors"
    full.write_bytes(b"abcd")
    # the catalog size is a rounded estimate: a file far from it is still installed, with a soft note only
    assert M.item_state(it) == {"state": "installed", "have_bytes": 4, "size_note": True}
    with open(full, "wb") as f:                      # sparse: within the rounded catalog size
        f.truncate(it["size"] + 1_000_000)
    assert M.item_state(it) == {"state": "installed", "have_bytes": it["size"] + 1_000_000}
    assert M.item_state({**it, "size": None})["state"] == "installed"   # no size known: existence
    # once a sha256 is filled the size is exact and must match
    assert M.item_state({**it, "sha256": "0" * 64})["state"] == "partial"
    assert M.item_state({**it, "sha256": "0" * 64, "size": it["size"] + 1_000_000})["state"] == "installed"
    files = M.installed_files()
    assert files["vae"] == ["flux2-vae.safetensors"]


def test_tiers():
    assert M.pick_tier(CAT, 48, 64)["id"] == "48gb"
    assert M.pick_tier(CAT, 40, 64)["id"] == "48gb"
    assert M.pick_tier(CAT, 39.9, 128)["id"] == "24gb"
    assert M.pick_tier(CAT, 20, 32)["id"] == "24gb"
    assert M.pick_tier(CAT, 16, 64) is None
    ids = M.ids_for_tier(CAT, "48gb")
    assert len(ids) == len(set(ids)) and "sam31" in ids and "ltx25-layout-lora" in ids
    assert M.ids_for_tier(CAT, "nope") == []


def test_endpoint_lock(monkeypatch):
    monkeypatch.setenv("SOUNDSTAGE_HF_ENDPOINT", "https://evil.example")
    assert M.hf_base() == "https://huggingface.co"
    monkeypatch.setenv("SOUNDSTAGE_HF_ENDPOINT", "http://127.0.0.1:8123")
    assert M.hf_base() == "http://127.0.0.1:8123"
    monkeypatch.setenv("SOUNDSTAGE_HF_ENDPOINT", "http://127.0.0.1.evil.example:80")
    assert M.hf_base() == "https://huggingface.co"


def test_token_file_mode_and_lookup_order(tmp_path, monkeypatch):
    stub_folder_paths(monkeypatch, tmp_path)
    assert M.load_token() == (None, None)
    cli = tmp_path / "home" / ".cache" / "huggingface"
    cli.mkdir(parents=True)
    (cli / "token").write_text("hf_cliTOKEN0000\n")
    assert M.load_token() == ("hf_cliTOKEN0000", "hf_cli")
    monkeypatch.setenv("HF_TOKEN", "hf_envTOKEN0000")
    assert M.load_token() == ("hf_envTOKEN0000", "environment")
    M.save_token(TOKEN)
    p = M.token_path()
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert stat.S_IMODE(p.parent.stat().st_mode) == 0o700
    assert M.load_token() == (TOKEN, "saved")
    assert M.remove_token() and not p.exists()
    assert M.load_token()[1] == "environment"          # env token still there, and status says so
    assert (cli / "token").read_text().strip() == "hf_cliTOKEN0000"   # the CLI file is never touched


def test_token_shape_is_checked(tmp_path, monkeypatch):
    stub_folder_paths(monkeypatch, tmp_path)
    for bad in ("", "short", "has space inside", "line\nbreak-injection-xx", 123):
        with pytest.raises(ValueError):
            M.save_token(bad)


def test_exact_size_from_a_verified_download_is_used_and_must_match_the_row(tmp_path, monkeypatch):
    models = stub_folder_paths(monkeypatch, tmp_path)
    it = next(i for i in CAT["items"] if i["id"] == "flux2-vae")
    full = models / "vae" / "flux2-vae.safetensors"
    full.write_bytes(b"abcd")
    M.record_verified(it, 4, None)
    assert M.verified_size(it) == 4
    assert M.item_state(it) == {"state": "installed", "have_bytes": 4}       # exact match: no note
    full.write_bytes(b"abc")
    assert M.item_state(it) == {"state": "missing", "have_bytes": 0, "wrong_size": True}
    # a record for another file name (catalog changed) is ignored
    assert M.verified_size({**it, "saved_name": "other.safetensors"}) is None
    # an unreadable record is ignored, never fatal
    M.verified_path().write_text("{not json")
    assert M.verified_size(it) is None and M.item_state(it)["state"] == "installed"
