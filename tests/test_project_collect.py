"""Collect project (soundstage/project): folder layout, MISSING.txt, path safety, relink on re-open. docs/projects.md"""
import json
import re
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
    # a reference that climbs out of output/ is never read: reported as unsupported (not cut down to output/passwd.mp4)
    wf = {"nodes": [{"type": "SoundstageStage", "properties": {"ss_renders": {"sh": {"draft": {
        "filename": "passwd.mp4", "subfolder": "../../../etc", "type": "output"}}}}, "widgets_values": []}]}
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "passwd.mp4").write_bytes(b"unrelated")
    res = C.write_collect(C.plan_collect(wf, "Evil/../../x"), {"output": str(tmp_path / "out")}, tmp_path / "out" / C.ROOT_NAME)
    assert res["copied"] == 0 and [u["name"] for u in res["unsupported"]] == ["passwd.mp4"]
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


# ---------------------------------------------------------------- the Cut: ss_cut, ss_script, extras.timeline (invented)

def _cut_workflow():
    wf = _fixture_workflow()
    props = wf["nodes"][0]["properties"]
    props["ss_cut"] = {"cut": [
        {"shot_id": "sh_a", "in": 0, "out": 24},
        {"kind": "gap", "in": 24, "out": 36},
        {"shot_id": "sh_b", "in": 0, "out": 30, "audio_detached": True,
         "take": {"url": "/view?filename=pin_00004_.mp4&subfolder=soundstage&type=output", "rung": "final", "version": 2}},
        {"shot_id": "sh_a", "in": 30, "out": 40, "take": {"url": "/view?filename=draft_00007_.mp4&subfolder=soundstage&type=output", "rung": "draft"}},
    ], "audio": [{"id": "m1", "file": "soundstage/music/theme_00001_.wav [output]", "start": 0},
                 {"id": "m2", "file": "/Users/someone/Desktop/temp_score.wav"}],
        "video_tracks": [{"clips": [{"shot_id": "sh_c", "in": 0, "out": 12, "start": 40,
                                     "take": {"url": "/view?filename=draft_00009_.mp4&subfolder=soundstage&type=output", "rung": "draft"}}]}]}
    props["ss_script"]["scene_cuts"] = {"sc_2": {"cut": [{"shot_id": "sh_c", "in": 0, "out": 10,
                                                          "take": {"url": "https://example.com/takes/car.mp4", "rung": "final"}}]}}
    props["ss_script"]["scene_stages"]["sc_2"]["objects"] = [{"kind": "set", "model": "soundstage/sets/road.glb [output]"}]
    return wf


def _cut_roots(tmp_path):
    roots = _roots(tmp_path)
    out = tmp_path / "output" / "soundstage"
    (out / "music").mkdir()
    (out / "music" / "theme_00001_.wav").write_bytes(b"RIFFtheme")
    (out / "pin_00004_.mp4").write_bytes(b"pin")
    (out / "upper_00001_.mp4").write_bytes(b"upper")
    (out / "sets").mkdir()
    (out / "sets" / "road.glb").write_bytes(b"glb")
    (tmp_path / "input" / "vo_take.wav").write_bytes(b"RIFFvo")
    return roots


def test_collect_walks_the_cut(tmp_path):
    roots = _cut_roots(tmp_path)
    timeline = {"cut": [{"shot_id": "sh_b", "in": 0, "out": 30,
                         "take": {"url": "/view?filename=pin_00004_.mp4&subfolder=soundstage&type=output", "rung": "final"}}],
                "video": [{"shot_id": "sh_a", "file": {"filename": "upper_00001_.mp4", "subfolder": "soundstage", "type": "output"}}],
                "audio": [{"id": "vo", "file": "vo_take.wav [input]"}, {"id": "x", "file": "file:///Volumes/Drive/fx_hit.wav"}],
                "archived_cuts": [{"name": "v1", "cut": [{"shot_id": "sh_a", "take": {"url": "C:\\Media\\old_take.mov", "rung": "draft"}}]}]}
    plan = C.plan_collect(_cut_workflow(), "Cut Film", extras={"timeline": timeline})
    dests = {c["dest"] for c in plan["copies"]}
    keys = [C.ref_key(c["src"]) for c in plan["copies"]]
    assert len(keys) == len(set(keys))                                   # dedup: one copy per source file
    # a pinned take goes with its shot, in its rung's folder; one a shot already had keeps its first place
    assert "scenes/S01/shots/S01_020/takes/final/S01_020_final_01.mp4" in dests
    assert sum(1 for k in keys if k.endswith("draft_00007_.mp4")) == 1
    assert "scenes/S01/shots/S01_010/takes/draft/S01_010_draft_01.mp4" in dests
    # upper picture clip (timeline.video) with its shot; independent audio in cut/audio; scene-stage set GLB
    assert any(d.startswith("scenes/S01/shots/S01_010/") and C.ref_key(c["src"]).endswith("upper_00001_.mp4")
               for c in plan["copies"] for d in [c["dest"]])
    assert "cut/audio/theme_00001_01.wav" in dests and "cut/audio/vo_take_01.wav" in dests
    assert "locations/set/road_01.glb" in dests
    b = next(s for s in plan["project"]["shots"] if s["id"] == "sh_b")
    assert any(t["kind"] == "final" and t["file"].endswith("S01_020_final_01.mp4") for t in b["takes"])
    # raw paths / web addresses: reported by file name, never copied
    names = sorted(u["name"] for u in plan["unsupported"])
    assert names == ["car.mp4", "fx_hit.wav", "old_take.mov", "temp_score.wav"]
    where = {u["name"]: u["where"] for u in plan["unsupported"]}
    assert where["temp_score.wav"] == "ss_cut.audio[1].file" and where["car.mp4"].startswith("ss_script.scene_cuts.sc_2")
    assert not any("Users" in str(u) or "Volumes" in str(u) for u in plan["unsupported"])   # names only, no paths

    res = C.write_collect(plan, roots, tmp_path / "output" / C.ROOT_NAME)
    d = tmp_path / "output" / C.ROOT_NAME / "Cut Film"
    assert (d / "cut" / "audio" / "theme_00001_01.wav").read_bytes() == b"RIFFtheme"
    assert (d / "scenes" / "S01" / "shots" / "S01_020" / "takes" / "final" / "S01_020_final_01.mp4").read_bytes() == b"pin"
    assert sorted(u["name"] for u in res["unsupported"]) == names
    miss = (d / "MISSING.txt").read_text()
    assert "temp_score.wav\t(ss_cut.audio[1].file)" in miss and "/Users/someone" not in miss
    assert json.loads((d / "project.json").read_text())["unsupported"] == plan["unsupported"]


def test_collect_cut_refs_stay_in_approved_roots(tmp_path):
    wf = {"nodes": [{"type": "SoundstageStage", "properties": {"ss_cut": {"cut": [{"shot_id": "sh", "take": {
        "url": "/view?filename=passwd.mp4&subfolder=../../../etc&type=output", "rung": "final"}}],
        "audio": [{"file": {"filename": "x.wav", "subfolder": "", "type": "secret"}}]}}, "widgets_values": []}]}
    (tmp_path / "out").mkdir()
    plan = C.plan_collect(wf, "Evil Cut")
    assert all(c["src"]["type"] in ("output", "input", "temp") for c in plan["copies"])
    res = C.write_collect(plan, {"output": str(tmp_path / "out")}, tmp_path / "out" / C.ROOT_NAME)
    assert res["copied"] == 0
    assert [(u["name"], u["where"]) for u in res["unsupported"]] == [("passwd.mp4", "ss_cut.cut[0].take.url")]


def test_collect_without_a_cut_reports_nothing_unsupported(tmp_path):
    res, d = _collect(tmp_path)
    assert res["unsupported"] == []
    assert "raw path" not in (d / "MISSING.txt").read_text()


# ---------------------------------------------------------------- final round: refs that point outside ComfyUI, raw-path report

def test_collect_never_cuts_an_absolute_ref_down_to_its_basename(tmp_path):
    out = tmp_path / "out"
    (out / "soundstage").mkdir(parents=True)
    (out / "passwd.mp4").write_bytes(b"UNRELATED")            # what HEAD quietly copied into cut/media/
    (out / "clip.mov").write_bytes(b"UNRELATED")
    (out / "soundstage" / "good_00001_.mp4").write_bytes(b"good")
    cut = {"cut": [{"kind": "gap", "in": 0, "out": 12}],
           "audio": [{"file": {"filename": "/etc/passwd.mp4", "type": "output"}},
                     {"file": {"filename": "clip.mov", "subfolder": "C:\\Media", "type": "output"}},
                     {"file": {"filename": "clip.mov", "subfolder": "a\\b", "type": "output"}},
                     {"file": {"filename": "D:/x/clip.mov", "type": "output"}},
                     {"file": "/abs/clip.mov [output]"},
                     {"file": "/view?filename=clip.mov&subfolder=..%2Fsecret&type=output"},
                     {"file": {"filename": "soundstage/good_00001_.mp4", "type": "output"}}]}
    wf = {"nodes": [{"type": "SoundstageStage", "properties": {"ss_cut": cut, "ss_look": {"ref": {
        "filename": "../../outside.png", "type": "input"}}}, "widgets_values": []}]}
    plan = C.plan_collect(wf, "Abs Film")
    srcs = [C.ref_key(c["src"]) for c in plan["copies"]]
    assert srcs == ["output:soundstage/good_00001_.mp4"]       # a relative path in filename folds into subfolder
    raws = [(u["name"], u["where"]) for u in plan["unsupported"]]
    assert ("passwd.mp4", "ss_cut.audio[0].file") in raws
    assert sum(1 for n, _ in raws if n == "clip.mov") == 5      # five different raw paths, five entries
    assert ("outside.png", "ss_look.ref") in raws
    res = C.write_collect(plan, {"output": str(out), "input": str(tmp_path / "in")}, out / C.ROOT_NAME)
    d = out / C.ROOT_NAME / "Abs Film"
    assert res["copied"] == 1 and not (d / "cut" / "media").exists()
    assert not any(p.read_bytes() == b"UNRELATED" for p in d.rglob("*") if p.is_file())
    assert "passwd.mp4\t(ss_cut.audio[0].file)" in (d / "MISSING.txt").read_text()


def test_raw_path_report_dedupes_by_full_path_across_sources(tmp_path):
    live = {"cut": [{"shot_id": "sh_a", "in": 0, "out": 10, "take": {"url": "/A/clip.mov"}},
                    {"shot_id": "sh_a", "in": 0, "out": 10, "take": {"url": "/B/clip.mov"}},
                    {"shot_id": "sh_a", "in": 0, "out": 10, "take": {"url": "/A/clip.mov"}}]}
    wf = _fixture_workflow()
    wf["nodes"][0]["properties"]["ss_cut"] = live
    timeline = json.loads(json.dumps(live))                   # the App's timeline carries the same live cut
    timeline["audio"] = [{"file": "/C/clip.mov"}]
    plan = C.plan_collect(wf, "Dup Film", extras={"timeline": timeline})
    got = [(u["name"], u["where"]) for u in plan["unsupported"]]
    assert got == [("clip.mov", "ss_cut.cut[0].take.url"), ("clip.mov", "ss_cut.cut[1].take.url"),
                   ("clip.mov", "timeline.audio[0].file")]     # /A, /B once each (first 'where' kept), /C from the timeline


def test_missing_txt_where_label_has_no_newlines(tmp_path):
    roots = _roots(tmp_path)
    wf = _fixture_workflow()
    wf["nodes"][0]["properties"]["ss_cut"] = {"tracks": {"evil\nINJECTED LINE\r\x1b[31m": [{"file": "/Users/x/fx\u2028.wav"}]}}
    plan = C.plan_collect(wf, "Ctl Film")
    assert plan["unsupported"] and all(not re.search(r"[\x00-\x1f\x7f\u2028]", u["where"] + u["name"]) for u in plan["unsupported"])
    # a plan made elsewhere is sanitised when MISSING.txt is written, too
    plan["unsupported"].append({"name": "a\nb.wav", "where": "x\ny"})
    C.write_collect(plan, roots, tmp_path / "output" / C.ROOT_NAME)
    lines = (tmp_path / "output" / C.ROOT_NAME / "Ctl Film" / "MISSING.txt").read_text().splitlines()
    assert not any(line.startswith(("INJECTED", "b.wav", "y)")) for line in lines)
    assert "a b.wav\t(x y)" in lines
