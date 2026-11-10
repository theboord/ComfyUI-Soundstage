"""tools/fetch_rocketbox.py: the user-run Rocketbox fetch. Offline: the network is a fake, nothing leaves this machine."""
import hashlib
import importlib.util
import re
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "fetch_rocketbox.py"


def load(name="fetch_rocketbox_t"):
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


F = load()


def tga(w, h, n, pixels_bgr, top_down=False, rle=False):
    """A small TGA: pixels_bgr is the stored order (bottom row first unless top_down)."""
    desc = (0x20 if top_down else 0) | (8 if n == 4 else 0)
    head = struct.pack("<BBBHHBHHHHBB", 0, 0, 10 if rle else 2, 0, 0, 0, 0, 0, w, h, n * 8, desc)
    if rle:   # one raw packet per pixel: enough to exercise the decoder
        body = b"".join(b"\x00" + pixels_bgr[i:i + n] for i in range(0, len(pixels_bgr), n))
    else:
        body = pixels_bgr
    return head + body


def png_pixels(png):
    """(w, h, colour type, raw rows without filter bytes) of a PNG written by png_bytes (filter 0)."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    w, h, depth, ctype = struct.unpack(">IIBB", png[16:26])
    i, idat = 8, b""
    while i < len(png):
        ln, = struct.unpack(">I", png[i:i + 4])
        kind = png[i + 4:i + 8]
        if kind == b"IDAT":
            idat += png[i + 8:i + 8 + ln]
        i += 12 + ln
    raw = zlib.decompress(idat)
    n = 4 if ctype == 6 else 3
    stride = w * n + 1
    rows = [raw[y * stride:(y + 1) * stride] for y in range(h)]
    assert all(r[0] == 0 for r in rows)
    return w, h, ctype, b"".join(r[1:] for r in rows)


# ------------------------------------------------------------------------------------------------ the file list
def _stage_spec():
    src = (ROOT / "web/stage/people/avatarcore.mjs").read_text()
    block = re.search(r"export const ROCKETBOX = \{(.*?)\n\};", src, re.S).group(1)
    models = set(re.findall(r'model: "([^"]+)"', block))
    clips = set(re.findall(r'(?:idle|walk|run): "([^"]+)"', block)) | set(re.findall(r'seated: "([^"]+)"', block))
    kinds = re.search(r"export const CLIP_KINDS = \[([^\]]+)\]", src).group(1)
    assert sorted(re.findall(r'"(\w+)"', kinds)) == ["idle", "run", "walk"]
    return models, clips


def test_the_file_list_is_exactly_what_the_stage_loads():
    models, clips = _stage_spec()
    kit = [rel for _, rel, _, _ in F.FILES]
    assert len(kit) == len(set(kit))
    assert {r[:-4] for r in kit if r.endswith(".fbx") and "/" not in r} == models
    assert {r[len("anim/"):-len(".max.fbx")] for r in kit if r.startswith("anim/")} == clips
    # avatars.mjs: <dir><model>.fbx, <dir>anim/<clip>.max.fbx, tex/<tga base name>.png (avatarcore.tgaToPng)
    av = (ROOT / "web/stage/people/avatars.mjs").read_text()
    assert "${ROCKETBOX_DIR}${spec.model}.fbx" in av and "${ROCKETBOX_DIR}anim/${spec.clips[k]}.max.fbx" in av
    assert "${ROCKETBOX_DIR}anim/${spec.seated}.max.fbx" in av and 'new URL("./rocketbox/", import.meta.url)' in av
    # textures: every non-specular map the installer plan names (the specular maps are never loaded)
    spec = importlib.util.spec_from_file_location("ri", ROOT / "soundstage/assets/rocketbox_install.py")
    RI = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(RI)
    want = {f"tex/{tid}_{m}.png" for tid in RI.AVATARS.values() for m in RI.MAPS}
    assert {r for r in kit if r.startswith("tex/")} == want
    assert not any("specular" in s for s, _, _, _ in F.FILES)
    for src, rel, _, _ in F.FILES:
        if rel.startswith("tex/"):
            assert src.endswith(Path(rel).stem + ".tga")
    assert "LICENSE.md" in kit, "the MIT licence sits next to the kit"


def test_every_file_is_pinned_by_size_and_sha256_at_one_commit():
    assert re.fullmatch(r"[0-9a-f]{40}", F.PINNED_COMMIT)
    assert F.BASE_URL == f"https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/{F.PINNED_COMMIT}/"
    for src, rel, size, sha in F.FILES:
        assert size > 0 and re.fullmatch(r"[0-9a-f]{64}", sha), rel
        assert not src.startswith("http") and ".." not in src and ".." not in rel


def test_the_readmes_name_the_script_and_the_same_files():
    people = (ROOT / "web/stage/people/README.md").read_text()
    for doc in (people, (ROOT / "README.md").read_text(), (ROOT / "docs/QUICKSTART.md").read_text()):
        assert "python3 tools/fetch_rocketbox.py" in doc
    assert F.PINNED_COMMIT in people


def test_nothing_in_the_app_or_the_installers_runs_it():
    hits = []
    for base in ("web", "soundstage", "tools"):
        for p in (ROOT / base).rglob("*"):
            if p.is_file() and p.suffix in {".py", ".mjs", ".js", ".sh", ".html", ".json"} and p != SCRIPT:
                if "fetch_rocketbox" in p.read_text(errors="ignore"):
                    hits.append(str(p.relative_to(ROOT)))
    init = (ROOT / "__init__.py").read_text()
    assert not hits and "fetch_rocketbox" not in init, hits


# ------------------------------------------------------------------------------------------------ import + download
def test_importing_it_downloads_and_writes_nothing(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("network touched at import")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.chdir(tmp_path)
    load("fetch_rocketbox_import_check")
    assert list(tmp_path.iterdir()) == []
    src = SCRIPT.read_text()
    top_calls = [ln for ln in src.splitlines() if re.match(r"(main|fetch|download)\(", ln)]
    assert not top_calls and src.rstrip().endswith('if __name__ == "__main__":\n    sys.exit(main())')


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_kit(monkeypatch):
    """Replace FILES with small synthetic files (one texture) and the network with a dict; returns the URL log."""
    tex = tga(4, 2, 3, bytes(range(24)))
    blobs = {"a/Male_Adult_01.fbx": b"FBX-man", "t/m002_body_color.tga": tex, "LICENSE.md": b"MIT License"}
    files = [("a/Male_Adult_01.fbx", "Male_Adult_01.fbx"), ("t/m002_body_color.tga", "tex/m002_body_color.png"), ("LICENSE.md", "LICENSE.md")]
    monkeypatch.setattr(F, "FILES", [(s, r, len(blobs[s]), hashlib.sha256(blobs[s]).hexdigest()) for s, r in files])
    log = []

    def urlopen(req, timeout=None, context=None):
        url = req.full_url
        log.append(url)
        assert url.startswith(F.BASE_URL)
        return FakeResponse(blobs[url[len(F.BASE_URL):]])
    monkeypatch.setattr(F, "_urlopen", urlopen)
    return log


def test_it_fetches_from_the_pinned_commit_and_installs_the_kit(monkeypatch, tmp_path):
    log = fake_kit(monkeypatch)
    lines = []
    assert F.fetch(tmp_path / "kit", out=lines.append) is True
    assert log == [F.BASE_URL + s for s, _, _, _ in F.FILES]
    assert all(F.PINNED_COMMIT in u for u in log)
    assert (tmp_path / "kit/Male_Adult_01.fbx").read_bytes() == b"FBX-man"
    assert (tmp_path / "kit/LICENSE.md").read_bytes() == b"MIT License"
    assert not (tmp_path / "kit/tex/m002_body_color.tga").exists()
    w, h, ctype, px = png_pixels((tmp_path / "kit/tex/m002_body_color.png").read_bytes())
    assert (w, h, ctype) == (4, 2, 2)
    assert lines[-1].startswith("SUCCESS:")
    assert not list((tmp_path / "kit").rglob("*.part"))


def test_files_already_there_are_skipped(monkeypatch, tmp_path):
    log = fake_kit(monkeypatch)
    assert F.fetch(tmp_path / "kit", out=lambda s: None)
    log.clear()
    lines = []
    assert F.fetch(tmp_path / "kit", out=lines.append) is True
    assert log == [], "a second run downloads nothing"
    assert sum("already there, skipped" in s for s in lines) == len(F.FILES)


def test_a_wrong_size_copy_is_fetched_again(monkeypatch, tmp_path):
    log = fake_kit(monkeypatch)
    (tmp_path / "kit").mkdir()
    (tmp_path / "kit/Male_Adult_01.fbx").write_bytes(b"truncated")
    assert F.fetch(tmp_path / "kit", out=lambda s: None)
    assert F.BASE_URL + "a/Male_Adult_01.fbx" in log
    assert (tmp_path / "kit/Male_Adult_01.fbx").read_bytes() == b"FBX-man"


def test_a_bad_download_is_refused_and_reported(monkeypatch, tmp_path):
    fake_kit(monkeypatch)
    src, rel, size, _ = F.FILES[0]
    F.FILES[0] = (src, rel, size, "0" * 64)
    lines = []
    assert F.fetch(tmp_path / "kit", out=lines.append) is False
    assert not (tmp_path / "kit/Male_Adult_01.fbx").exists()
    assert any("sha256 mismatch" in s for s in lines) and lines[-1].startswith("FAILED:")
    assert F.main(["--dest", str(tmp_path / "kit")]) == 1


def test_a_certificate_failure_stops_at_once_with_the_fix(monkeypatch, tmp_path):
    fake_kit(monkeypatch)
    calls = []

    def urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        raise urllib.error.URLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
    monkeypatch.setattr(F, "_urlopen", urlopen)
    lines = []
    assert F.fetch(tmp_path / "kit", out=lines.append) is False
    assert len(calls) == 1 and "Install Certificates.command" in lines[-1] and lines[-1].startswith("FAILED:")


def test_list_downloads_nothing(monkeypatch, capsys):
    monkeypatch.setattr(F, "_urlopen", lambda *a, **k: pytest.fail("network"))
    assert F.main(["--list"]) == 0
    assert capsys.readouterr().out.count(F.BASE_URL) == len(F.FILES)


# ------------------------------------------------------------------------------------------------ TGA -> PNG
def test_tga_bottom_up_bgr_becomes_top_down_rgb_and_halves_by_box_average():
    # 4 x 2, stored bottom row first, BGR: bottom row all (b=0,g=0,r=100), top row (b=0,g=0,r=200) except one red 0
    bottom = bytes([0, 0, 100]) * 4
    top = bytes([0, 0, 200]) * 3 + bytes([0, 0, 0])
    w, h, n, px = F.read_tga(tga(4, 2, 3, bottom + top))
    assert (w, h, n) == (4, 2, 3)
    assert px[:3] == bytes([200, 0, 0]) and px[-3:] == bytes([100, 0, 0]), "top-down, RGB"
    ow, oh, small = F.half(w, h, n, px)
    assert (ow, oh) == (2, 1)
    assert small == bytes([150, 0, 0, 100, 0, 0]), "(200+200+100+100)/4, (200+0+100+100)/4"


def test_rle_and_alpha_are_kept():
    pix = bytes([10, 20, 30, 40]) * 4   # BGRA
    for rle in (False, True):
        w, h, n, px = F.read_tga(tga(2, 2, 4, pix, top_down=True, rle=rle))
        assert n == 4 and px == bytes([30, 20, 10, 40]) * 4
    png = F.tga_to_png(tga(2, 2, 4, pix), max_px=1)
    w, h, ctype, raw = png_pixels(png)
    assert (w, h, ctype) == (1, 1, 6) and raw == bytes([30, 20, 10, 40])


def test_unsupported_tga_is_an_error():
    bad = bytearray(tga(1, 1, 3, b"\x00\x00\x00"))
    bad[2] = 1   # colour-mapped
    with pytest.raises(F.FetchError):
        F.read_tga(bytes(bad))
