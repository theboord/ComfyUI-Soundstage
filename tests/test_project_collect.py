"""Collect project (soundstage/project): folder layout, MISSING.txt, path safety, relink on re-open. docs/projects.md"""
import json
import sys
import types
import zipfile

import pytest

from soundstage.project import collect as C


def _fixture_workflow():
    stage = {"shots": [{"id": "sh_a", "name": "Wide", "scene_id": "sc_1"}, {"id": "sh_b", "name": "Close", "scene_id": "sc_1"}],
             "objects": [{"kind": "set", "model": "soundstage/sets/diner.glb [output]"}]}
    props = {
        "ss_script": {"v": 1, "live_scene": "sc_1", "script": {"title": "Diner", "scenes": [
            {"id": "sc_1", "number": "1", "heading": "INT. DINER - NIGHT"}, {"id": "sc_2", "number": "2", "heading": "EXT. ROAD"}]},
            "scene_stages": {"sc_2": {"shots": [{"id": "sh_c", "name": "Car", "scene_id": "sc_2"}]}},
            "scene_cuts": {}},
        "ss_renders": {
            "sh_a": {"previz": {"filename": "clay_00001_.png", "subfolder": "soundstage", "type": "output"},
                     "draft": {"filename": "draft_00007_.mp4", "subfolder": "soundstage", "type": "output"},
                     "final_sound": {"filename": "final_00002_.mp4", "subfolder": "soundstage", "type": "output"}},
            "sh_c": {"draft": {"filename": "draft_00009_.mp4", "subfolder": "soundstage", "type": "output"}},
        },
        "ss_chosen": {"sh_a": {"filename": "look_00003_.png", "subfolder": "soundstage", "type": "output"}},
        "ss_ltx": {"sh_a": {"mode": "draft", "steps": 8}},
        "ss_cast": {"items": {
            "character:Old Man": {"ref": "soundstage/cast/Old_Man_00001_.png [output]", "url": "/view?filename=Old_Man_00001_.png&subfolder=soundstage/cast&type=output", "voice": "Jake"},
            "location:Diner": {"ref": "diner_ref.png [input]"},
        }},
        "ss_cut": {"cut": [{"shot_id": "sh_a"}]},
    }
    return {"nodes": [{"id": 1, "type": "SoundstageStage", "properties": props, "widgets_values": [json.dumps(stage)]},
                      {"id": 2, "type": "SaveVideo", "properties": {}, "widgets_values": ["soundstage/draft"]}],
            "links": [], "extra": {}}


def _roots(tmp_path):
    out, inp, tmp = tmp_path / "output", tmp_path / "input", tmp_path / "temp"
    (out / "soundstage" / "cast").mkdir(parents=True)
    inp.mkdir()
    tmp.mkdir()
    for f in ("clay_00001_.png", "draft_00007_.mp4", "final_00002_.mp4", "look_00003_.png", "charsheet_old_man_00001_.png"):
        (out / "soundstage" / f).write_bytes(b"x" + f.encode())
    (out / "soundstage" / "cast" / "Old_Man_00001_.png").write_bytes(b"face")
    (inp / "diner_ref.png").write_bytes(b"diner")
    lp = out / "soundstage_layerpacks" / "Wide_20261101_120000"
    (lp / "layers" / "10_A").mkdir(parents=True)
    (lp / "manifest.json").write_text("{}")
    (out / "soundstage_layerpacks" / "Wide_20261102_120000").mkdir()
    (out / "soundstage_layerpacks" / "Wide_20261102_120000" / "manifest.json").write_text('{"newest": 1}')
    return {"output": str(out), "input": str(inp), "temp": str(tmp)}


def _collect(tmp_path, extras=None):
    roots = _roots(tmp_path)
    out = tmp_path / "output"
    packs = [d.name for d in (out / "soundstage_layerpacks").iterdir()]
    sheets = [f.name for f in (out / "soundstage").iterdir() if f.name.startswith("charsheet_")]
    ud = tmp_path / "user"
    (ud / "soundstage" / "voices" / "Jake").mkdir(parents=True)
    (ud / "soundstage" / "voices" / "Jake" / "sample.wav").write_bytes(b"RIFF")
    plan = C.plan_collect(_fixture_workflow(), "My Film", extras=extras or {}, layerpacks=packs, cast_sheets=sheets,
                          voices={"Jake": ["sample.wav"]})
    res = C.write_collect(plan, roots, out / C.ROOT_NAME, user_dir=ud)
    return res, out / C.ROOT_NAME / "My Film"


def test_scenes_and_shots_get_film_codes():
    scenes, shots = C.scenes_and_shots(C.project_state(_fixture_workflow()))
    assert [s["code"] for s in scenes] == ["S01", "S02"]
    codes = {s["id"]: s["code"] for s in shots}
    assert codes == {"sh_c": "S02_010", "sh_a": "S01_010", "sh_b": "S01_020"}


def test_collect_folder_layout(tmp_path):
    res, d = _collect(tmp_path, extras={"cut_files": {"My_Film.edl": "TITLE: x\n", "../evil.txt": "no"}})
    shot = d / "scenes" / "S01" / "shots" / "S01_010"
    for sub in C.SHOT_FOLDERS:
        assert (shot / sub).is_dir(), sub
    assert (shot / "clay" / "S01_010_previz_01.png").read_bytes() == b"xclay_00001_.png"
    assert (shot / "takes" / "draft" / "S01_010_draft_01.mp4").is_file()
    assert (shot / "takes" / "final" / "S01_010_final_sound_01.mp4").is_file()
    assert (shot / "frames" / "S01_010_frames_01.png").is_file()
    assert (d / "scenes" / "S02" / "shots" / "S02_010").is_dir()
    # newest layer pack of the shot named "Wide"
    assert json.loads((shot / "layerpack" / "Wide_20261102_120000" / "manifest.json").read_text()) == {"newest": 1}
    cast = d / "cast" / "Old_Man"
    assert (cast / "Old_Man_ref_01.png").read_bytes() == b"face"
    assert (cast / "Old_Man_castsheet_01.png").is_file()
    assert (cast / "voice" / "sample.wav").is_file()
    assert (d / "locations" / "Diner" / "Diner_location_01.png").read_bytes() == b"diner"
    assert (d / "cut" / "timeline.json").is_file() and (d / "cut" / "My_Film.edl").is_file()
    assert not (d.parent / "evil.txt").exists() and (d / "cut" / "evil.txt").is_file()   # basename only
    assert (d / "script" / "script.json").is_file() and (d / "README.txt").is_file()
    p = json.loads((d / "project.json").read_text())
    assert p["format"] == C.FORMAT and p["name"] == "My Film"
    a = next(s for s in p["shots"] if s["id"] == "sh_a")
    assert a["settings"] == {"mode": "draft", "steps": 8}
    chosen = [t for t in a["takes"] if t["chosen"]]
    assert len(chosen) == 1 and chosen[0]["file"].endswith("S01_010_frames_01.png")
    # originals untouched (copy, never move)
    assert (tmp_path / "output" / "soundstage" / "draft_00007_.mp4").is_file()


def test_missing_files_are_listed_not_fatal(tmp_path):
    res, d = _collect(tmp_path)
    miss = (d / "MISSING.txt").read_text()
    assert "draft_00009_.mp4" in miss and "S02_010_draft_01.mp4" in miss   # sh_c's draft is not on disk
    assert "diner.glb" in miss
    assert res["copied"] > 0 and len(res["missing"]) == 2


def test_recollect_replaces_folder(tmp_path):
    res, d = _collect(tmp_path)
    (d / "stale.txt").write_text("old")
    plan = C.plan_collect(_fixture_workflow(), "My Film")
    C.write_collect(plan, _roots_existing(tmp_path), tmp_path / "output" / C.ROOT_NAME)
    assert not (d / "stale.txt").exists() and (d / "project.json").is_file()


def _roots_existing(tmp_path):
    return {"output": str(tmp_path / "output"), "input": str(tmp_path / "input"), "temp": str(tmp_path / "temp")}


def test_path_safety(tmp_path):
    base = tmp_path / "b"
    base.mkdir()
    assert C.inside(base, "a/b.png") == (base / "a/b.png").resolve()
    for bad in ("../x", "a/../../x", "/etc/passwd", "C:/x", "", "a/\x00b"):
        assert C.inside(base, bad) is None, bad
    assert C.clean_name("../../etc") == "etc" and C.clean_name("a/b\\c") == "a b c" and C.clean_name("..") == ""
    assert C.clean_name("CON") == "CON_"
    # a reference that climbs out of output/ is reported missing, never read
    wf = {"nodes": [{"type": "SoundstageStage", "properties": {"ss_renders": {"sh": {"draft": {
        "filename": "passwd.mp4", "subfolder": "../../../etc", "type": "output"}}}}, "widgets_values": []}]}
    (tmp_path / "out").mkdir()
    res = C.write_collect(C.plan_collect(wf, "Evil/../../x"), {"output": str(tmp_path / "out")}, tmp_path / "out" / C.ROOT_NAME)
    assert res["copied"] == 0 and res["missing"]
    assert (tmp_path / "out" / C.ROOT_NAME / res["name"]).is_dir() and "/" not in res["name"]


def test_zip_extract_refuses_traversal(tmp_path):
    z = tmp_path / "bad.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("P/project.json", "{}")
        f.writestr("P/../../escape.txt", "x")
    with pytest.raises(ValueError):
        C.safe_extract(z, tmp_path / "dest")
    assert not (tmp_path / "escape.txt").exists()
    two = tmp_path / "two.zip"
    with zipfile.ZipFile(two, "w") as f:
        f.writestr("A/project.json", "{}")
        f.writestr("B/x.txt", "x")
    with pytest.raises(ValueError):
        C.safe_extract(two, tmp_path / "dest")


def test_zip_round_trip_and_relink(tmp_path):
    res, d = _collect(tmp_path)
    z = C.build_zip(d)
    names = zipfile.ZipFile(z).namelist()
    assert "My Film/project.json" in names and "My Film/scenes/S01/shots/S01_010/takes/draft/S01_010_draft_01.mp4" in names
    other = tmp_path / "other_machine" / C.ROOT_NAME
    other.mkdir(parents=True)
    assert C.safe_extract(z, other) == "My Film"
    project = json.loads((other / "My Film" / "project.json").read_text())
    wf = C.relinked_workflow(project, "My Film")
    props = wf["nodes"][0]["properties"]
    d0 = props["ss_renders"]["sh_a"]["draft"]
    assert d0 == {"filename": "S01_010_draft_01.mp4", "subfolder": "soundstage_projects/My Film/scenes/S01/shots/S01_010/takes/draft", "type": "output"}
    assert props["ss_cast"]["items"]["character:Old Man"]["ref"] == "soundstage_projects/My Film/cast/Old_Man/Old_Man_ref_01.png [output]"
    assert "soundstage_projects" in props["ss_cast"]["items"]["character:Old Man"]["url"]
    # a missing file keeps its old reference
    assert props["ss_renders"]["sh_c"]["draft"]["filename"] == "draft_00009_.mp4"
    # the relinked file is really there
    assert (tmp_path / "other_machine" / d0["subfolder"] / d0["filename"]).is_file()


def test_routes_helpers(tmp_path, monkeypatch):
    fp = types.ModuleType("folder_paths")
    fp.get_output_directory = lambda: str(tmp_path / "output")
    fp.get_directory_by_type = lambda t: str(tmp_path / t)
    fp.get_user_directory = lambda: str(tmp_path / "user")
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    from soundstage.project import routes as R
    _roots(tmp_path)
    res = R.collect_project("My Film", _fixture_workflow())
    assert res["name"] == "My Film" and R.list_collected()[0]["name"] == "My Film"
    assert R.project_dir("../output") is None and R.project_dir("My Film") is not None
    got = R.open_collected("My Film")
    assert got["workflow"]["nodes"][0]["properties"]["ss_renders"]["sh_a"]["draft"]["subfolder"].startswith("soundstage_projects/My Film/")
    with pytest.raises(FileNotFoundError):
        R.open_collected("../../etc")
    assert R.TEMPLATE.is_file()
