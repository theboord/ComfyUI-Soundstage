import sys
import types
import zipfile


def test_zip_full_and_lite(tmp_path, monkeypatch):
    fp = types.ModuleType("folder_paths")
    fp.get_output_directory = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    from soundstage.layerpack import download as d
    pack = tmp_path / "soundstage_layerpacks" / "SH010_x"
    (pack / "layers/10_A/png").mkdir(parents=True)
    (pack / "layers/10_A/png/A.1001.png").write_bytes(b"p")
    (pack / "layers/10_A/A_4444.mov").write_bytes(b"m")
    (pack / "manifest.json").write_text("{}")
    assert d._pack_dir("../../etc") is None and d._pack_dir("SH010_x") == pack.resolve()
    full = zipfile.ZipFile(d.build_zip(pack)).namelist()
    lite = zipfile.ZipFile(d.build_zip(pack, lite=True)).namelist()
    assert "SH010_x/layers/10_A/png/A.1001.png" in full
    assert "SH010_x/layers/10_A/png/A.1001.png" not in lite and "SH010_x/layers/10_A/A_4444.mov" in lite
    assert d.list_packs()[0]["name"] == "SH010_x"
