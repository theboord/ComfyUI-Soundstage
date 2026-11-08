"""The start screen's project library (soundstage/project/library.py): listing, sorting, thumbnails and their fallback,
autosave-newer badge, duplicate / rename, trash-not-delete, path safety. docs/projects.md"""
import json
import time

import pytest

from soundstage.project import library as L


def _wf(name, props=None, stage=None):
    return {"nodes": [{"id": 1, "type": "SoundstageStage", "properties": props or {},
                       "widgets_values": [json.dumps(stage or {"shots": []})]}], "links": [], "extra": {"ss_project": {"name": name}}}


def _save(user, name, wf, saved_at):
    d = user / "projects" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(json.dumps({"name": name, "saved_at": saved_at}))
    (user / "workflows").mkdir(exist_ok=True)
    (user / "workflows" / f"{name}.json").write_text(json.dumps(wf))
    return d


@pytest.fixture()
def env(tmp_path):
    user, out = tmp_path / "user", tmp_path / "output"
    (out / "soundstage").mkdir(parents=True)
    user.mkdir()
    for f in ("look_00003_.png", "final_00002_.mp4", "clay_00001_.png"):
        (out / "soundstage" / f).write_bytes(b"x")
    props = {
        "ss_script": {"script": {"scenes": [{"id": "sc_1", "number": "1"}, {"id": "sc_2", "number": "2"}]}, "live_scene": "sc_1"},
        "ss_renders": {"sh_a": {"previz": {"filename": "clay_00001_.png", "subfolder": "soundstage", "type": "output"},
                                "final": {"filename": "final_00002_.mp4", "subfolder": "soundstage", "type": "output"}}},
        "ss_chosen": {"sh_a": {"filename": "gone_00009_.png", "subfolder": "soundstage", "type": "output"}},
    }
    stage = {"shots": [{"id": "sh_a", "scene_id": "sc_1"}, {"id": "sh_b", "scene_id": "sc_1"}]}
    _save(user, "Alpha", _wf("Alpha", props, stage), 1_000_000)
    d = _save(user, "beta", _wf("beta"), 3_000_000)
    (d / "autosave").mkdir()
    (d / "autosave" / "20991231-235959-000.json").write_text("{}")       # newer than its save
    _save(user, "Gamma", _wf("Gamma", {"ss_renders": {"x": {"previz": "soundstage/clay_00001_.png [output]"}}}), 2_000_000)
    (user / "projects" / ".trash").mkdir()
    return user, {"output": str(out), "input": str(tmp_path / "in"), "temp": str(tmp_path / "tmp")}


def test_list_newest_first_with_counts_and_badges(env):
    user, roots = env
    got = L.list_projects(user, roots)
    assert [p["name"] for p in got] == ["beta", "Gamma", "Alpha"]          # .trash is never listed
    a = got[2]
    assert a["counts"] == {"scenes": 2, "shots": 2, "takes": 2}
    assert got[0]["autosave_newer"] is True and a["autosave_newer"] is False and got[0]["autosaves"] == 1


def test_thumbnail_tiers_and_fallback(env):
    user, roots = env
    by = {p["name"]: p for p in L.list_projects(user, roots)}
    # chosen frame is missing on disk -> no look -> the final render, as a video poster
    assert by["Alpha"]["thumb_kind"] == "video" and "final_00002_.mp4" in by["Alpha"]["thumb"]
    assert by["Gamma"]["thumb"] is None   # only an old clay still (clay_00001_.png): never a poster (Lifelike-only §1.4), the neutral card
    assert L.pick_thumb({"ss_renders": {"a": {"clay": "soundstage/frame_00001_.png [output]"}}}, lambda r: True) is None
    assert L.pick_thumb({"ss_renders": {"a": {"previz": "soundstage/clay/S01_010_00001_.jpg [output]"}}}, lambda r: True) is None
    assert L.pick_thumb({"ss_renders": {"a": {"clay": "soundstage/clay_00001_.png [output]", "previz": "soundstage/previz_00001_.mp4 [output]"}}},
                        lambda r: True)["ref"]["filename"] == "previz_00001_.mp4"   # the stage previz (Color) instead
    assert by["beta"]["thumb"] is None                                                          # nothing: the App draws an initial
    props = {"ss_chosen": {"a": "soundstage/look_00003_.png [output]"},
             "ss_renders": {"a": {"final": "soundstage/final_00002_.mp4 [output]"}}}
    assert L.pick_thumb(props, lambda r: True)["ref"]["filename"] == "look_00003_.png"        # chosen first frame wins
    assert L.pick_thumb({"ss_renders": {"a": {"previz": "../../etc/passwd.png [output]"}}}, L._exists_in(roots)) is None


def test_trash_moves_never_deletes_and_untrash(env):
    user, roots = env
    t = L.trash(user, "Alpha")
    tdir = user / "projects" / ".trash" / t
    assert (tdir / "project.json").is_file() and (tdir / "workflow.json").is_file()
    assert not (user / "projects" / "Alpha").exists() and not (user / "workflows" / "Alpha.json").exists()
    assert "Alpha" not in [p["name"] for p in L.list_projects(user, roots)]
    assert L.list_trash(user) == [t]
    assert L.untrash(user, t) == "Alpha"
    assert (user / "workflows" / "Alpha.json").is_file() and (user / "projects" / "Alpha" / "project.json").is_file()


def test_duplicate_and_rename(env):
    user, roots = env
    assert L.duplicate(user, "Alpha", "Alpha copy") == "Alpha copy"
    wf = json.loads((user / "workflows" / "Alpha copy.json").read_text())
    assert wf["extra"]["ss_project"]["name"] == "Alpha copy"
    with pytest.raises(FileExistsError):
        L.duplicate(user, "Alpha", "beta")
    assert L.rename(user, "beta", "Beta 2") == "Beta 2"
    assert (user / "projects" / "Beta 2" / "autosave").is_dir() and not (user / "projects" / "beta").exists()
    assert json.loads((user / "projects" / "Beta 2" / "project.json").read_text())["name"] == "Beta 2"
    with pytest.raises(FileNotFoundError):
        L.rename(user, "nope", "x")


def test_path_safety(env, tmp_path):
    user, roots = env
    for bad in ("../../etc", ".trash", "..", "a/b", ""):
        with pytest.raises(FileNotFoundError):
            L.trash(user, bad)
    with pytest.raises(FileNotFoundError):
        L.untrash(user, "../../../workflows")
    # a rename target is cleaned to one segment and stays in projects/
    assert L.rename(user, "Gamma", "../../outside") == "outside"
    assert (user / "projects" / "outside").is_dir() and not (tmp_path / "outside").exists()
    assert L.project_paths(user, "../x") is None


# ------------------------------------------------------------------------------------------------ project id

def _man(user, name):
    return json.loads((user / "projects" / name / "project.json").read_text())


def _wfj(user, name):
    return json.loads((user / "workflows" / f"{name}.json").read_text())


def _give_id(user, name, pid):
    m = _man(user, name)
    m["id"] = pid
    (user / "projects" / name / "project.json").write_text(json.dumps(m))
    w = _wfj(user, name)
    w["extra"]["ss_project"]["id"] = pid
    (user / "workflows" / f"{name}.json").write_text(json.dumps(w))


def test_project_id_listed_old_projects_have_none_and_listing_never_writes_one(env):
    user, roots = env
    _give_id(user, "Alpha", "p_0a1b2c3d")
    before = (user / "projects" / "beta" / "project.json").read_text()
    by = {p["name"]: p for p in L.list_projects(user, roots)}
    assert by["Alpha"]["id"] == "p_0a1b2c3d"
    assert by["beta"]["id"] is None                                   # saved before ids existed
    assert (user / "projects" / "beta" / "project.json").read_text() == before   # never written on load / list
    assert "id" not in _wfj(user, "beta")["extra"]["ss_project"]
    # a malformed id is not an id
    m = _man(user, "Gamma"); m["id"] = "P_NOTHEX!"; (user / "projects" / "Gamma" / "project.json").write_text(json.dumps(m))
    assert {p["name"]: p for p in L.list_projects(user, roots)}["Gamma"]["id"] is None


def test_duplicate_gets_a_fresh_id_rename_and_trash_keep_it(env):
    user, roots = env
    _give_id(user, "Alpha", "p_0a1b2c3d")
    L.duplicate(user, "Alpha", "Alpha copy")
    new = _man(user, "Alpha copy")["id"]
    assert L.PROJECT_ID.match(new) and new != "p_0a1b2c3d"
    assert _wfj(user, "Alpha copy")["extra"]["ss_project"]["id"] == new     # both files carry the copy's id
    assert _man(user, "Alpha")["id"] == "p_0a1b2c3d"                         # the original keeps its own
    # a project saved before ids existed: its duplicate still gets one
    L.duplicate(user, "beta", "beta copy")
    assert L.PROJECT_ID.match(_man(user, "beta copy")["id"])
    # rename keeps it, in both files
    L.rename(user, "Alpha", "Alpha 2")
    assert _man(user, "Alpha 2")["id"] == "p_0a1b2c3d"
    assert _wfj(user, "Alpha 2")["extra"]["ss_project"]["id"] == "p_0a1b2c3d"
    # trash and untrash keep it
    t = L.trash(user, "Alpha 2")
    assert json.loads((user / "projects" / ".trash" / t / "project.json").read_text())["id"] == "p_0a1b2c3d"
    assert L.untrash(user, t) == "Alpha 2"
    assert _man(user, "Alpha 2")["id"] == "p_0a1b2c3d"
    assert _wfj(user, "Alpha 2")["extra"]["ss_project"]["id"] == "p_0a1b2c3d"


def test_new_project_id_shape():
    ids = {L.new_project_id() for _ in range(200)}
    assert len(ids) == 200 and all(L.PROJECT_ID.match(i) for i in ids)
