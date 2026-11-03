"""Edit from the timeline (Directive 9, docs/cut.md): a cut clip pinned to a take plays that file everywhere on the server
side too. normalize_project keeps uid / take / versions like web/cut/timeline.mjs; layout applies clip_shot; media_for,
the server render's shot_media, the EDL reels, FCPXML assets, RELINK lines and AAF masters are one per file; and the
browser writers (web/cut/exporters.mjs) print the same bytes for a pinned cut (needs node).

Run:  python -m pytest tests/test_cut_editlink.py -q
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import export_all, layout, media_for, normalize_project, reel_names, to_edl, to_fcpxml, to_relink_list  # noqa: E402
from soundstage.cut.export import best_rung, media_key, normalize_take, view_key  # noqa: E402


def V(name, t=None):
    return f"/api/view?filename={name}&subfolder=soundstage&type=output" + (f"&t={t}" if t else "")


A1, A2, LOOK = V("a_v1.mp4"), V("a_v2.mp4"), V("a_look.png", 5)


def shots(a_renders=None):
    return [
        {"id": "a", "name": "Sc 3 · Wide", "frames": 97, "setup": "wide", "scene_name": "SC3",
         "renders": a_renders or {"draft": V("a_v2.mp4", 77), "look": LOOK}},
        {"id": "b", "name": "Sc 3 · Close", "frames": 97, "setup": "close", "scene_name": "SC3", "renders": {"draft": V("b.mp4")}},
        {"id": "f", "name": "Sc 5 · Plate", "frames": 97, "setup": "plate", "renders": {"look": V("f.png")},
         "source": {"path": "/footage/A001C003.mov", "reel": "A001", "fps": 24, "width": 3840, "height": 2160, "frames": 200}},
    ]


# v1 pinned on clip 0, v2 (the shot's latest) on clip 2 of shot a; a clay pin; a dissolve and a tail fade.
PINNED = {"name": "Pinned", "fps": 24, "shots": shots(), "fade_out": {"type": "dip_black", "frames": 12}, "cut": [
    {"shot_id": "a", "in": 0, "out": 40, "uid": "c1", "take": {"url": A1, "rung": "draft", "version": 1, "at": "13:40"},
     "versions": [{"url": V("a_v0.mp4"), "rung": "draft", "version": 0}]},
    {"shot_id": "b", "in": 0, "out": 30, "trans": {"type": "dissolve", "frames": 6}},
    {"shot_id": "a", "in": 40, "out": 80},
    {"shot_id": "a", "in": 80, "out": 90, "take": {"url": "", "rung": "clay"}},
    {"shot_id": "f", "in": 0, "out": 20, "take": {"url": V("f_ripple.mp4"), "rung": "draft", "kind": "ripple", "version": 1}},
]}


def test_normalize_keeps_uid_take_versions_like_the_browser():
    p = normalize_project({"shots": shots(), "cut": [
        {"shot_id": "a", "in": 0, "out": 40, "uid": "c1",
         "take": {"url": A1, "rung": "final", "version": "1", "at": "13:40", "kind": "app", "junk": 1, "recipe": {"seed": 7, "deep": {"x": 1}}},
         "versions": [{"url": V("a_v0.mp4"), "rung": "draft", "version": 0}, {"url": "", "rung": "final"}, {"rung": "nope", "url": "x"}]},
        {"shot_id": "a", "in": 40, "out": 50, "uid": "c1", "take": {"url": "", "rung": "final"}},
        {"shot_id": "b", "in": 0, "out": 10, "uid": "bad uid!", "take": {"rung": "clay"}},
        {"shot_id": "b", "in": 0, "out": 10, "versions": [{"url": V(f"b{i}.mp4"), "rung": "draft", "version": i + 1} for i in range(15)]},
    ]})
    assert p["cut"][0] == {"shot_id": "a", "in": 0, "out": 40, "uid": "c1",
                           "take": {"url": A1, "rung": "final", "version": 1, "at": "13:40", "kind": "app", "recipe": {"seed": 7}},
                           "versions": [{"url": V("a_v0.mp4"), "rung": "draft", "version": 0}]}
    assert p["cut"][1] == {"shot_id": "a", "in": 40, "out": 50}
    assert p["cut"][2] == {"shot_id": "b", "in": 0, "out": 10, "take": {"url": "", "rung": "clay", "version": 0}}
    assert len(p["cut"][3]["versions"]) == 12 and p["cut"][3]["versions"][0]["version"] == 4
    plain = normalize_project({"shots": shots(), "cut": [{"shot_id": "a", "in": 0, "out": 40, "notes": "n"}]})["cut"]
    assert plain == [{"shot_id": "a", "in": 0, "out": 40, "notes": "n"}]
    assert normalize_take({"rung": "final"}) is None and normalize_take({"rung": "x", "url": "y"}) is None
    assert normalize_take({"rung": "draft", "url": "u", "version": float("inf")})["version"] == 0


def test_layout_plays_the_pin_and_media_for_follows():
    rows = layout(normalize_project(PINNED))
    assert rows[0]["shot"]["renders"] == {"draft": A1, "look": LOOK}
    assert rows[2]["shot"]["renders"]["draft"] == V("a_v2.mp4", 77)
    assert best_rung(rows[3]["shot"]) == "clay" and rows[3]["shot"]["renders"] == {}
    assert "source" not in rows[4]["shot"], "a generated take is not the camera original"
    m = media_for(rows[0]["shot"], "/out")
    assert m["path"] == "/out/soundstage/a_v1.mp4" and m["rung"] == "draft"
    assert media_for(rows[4]["shot"])["path"] == "soundstage/f_ripple.mp4"
    assert media_key(rows[0]) == f"a|{view_key(A1)}" and media_key(rows[2]) == "a" and media_key(rows[3]) == "a|clay"
    assert view_key(V("x.mp4", 9)) == "output:soundstage/x.mp4"


def test_server_render_picks_the_pinned_file(tmp_path):
    from soundstage.cut.render import shot_media
    out = tmp_path / "output" / "soundstage"
    out.mkdir(parents=True)
    for n in ("a_v1.mp4", "a_v2.mp4"):
        (out / n).write_bytes(b"\0" * 16)
    rows = layout(normalize_project({"shots": shots({"final": V("a_v2.mp4", 3)}), "cut": [
        {"shot_id": "a", "in": 0, "out": 10, "take": {"url": A1, "rung": "final", "version": 1}}, {"shot_id": "a", "in": 10, "out": 20}]}))
    roots = {"output": str(tmp_path / "output")}
    assert pathlib.Path(shot_media(rows[0]["shot"], roots)[1]).name == "a_v1.mp4"
    assert pathlib.Path(shot_media(rows[1]["shot"], roots)[1]).name == "a_v2.mp4"


def test_reels_assets_and_relink_lines_per_file():
    p = normalize_project(PINNED)
    reels = reel_names(p)
    k1 = f"a|{view_key(A1)}"
    assert k1 in reels and "a|clay" in reels and reels["a"] != reels[k1]
    assert reels[k1].endswith("V1") and reels["a|clay"].endswith("CLAY"), "the version stays at the end of a short reel"
    edl = to_edl(p)
    assert "SOURCE FILE: soundstage/a_v1.mp4" in edl and "SOURCE FILE: soundstage/a_v2.mp4" in edl
    fcp = to_fcpxml(p)
    assert fcp.count('name="Sc 3 · Wide"') >= 2 and 'src="soundstage/a_v1.mp4"' in fcp and 'src="soundstage/a_v2.mp4"' in fcp
    relink = to_relink_list(p)
    assert "soundstage/a_v1.mp4" in relink and "soundstage/a_v2.mp4" in relink
    # no pins: one reel per shot, and uids / versions alone change no export
    plain = {"fps": 24, "shots": shots(), "cut": [{"shot_id": "a", "in": 0, "out": 40}, {"shot_id": "a", "in": 40, "out": 80}]}
    assert list(reel_names(normalize_project(plain))) == ["a", "b", "f"]
    tagged = json.loads(json.dumps(plain))
    tagged["cut"][0].update(uid="c1", versions=[{"url": A1, "rung": "draft", "version": 1}])
    assert export_all(tagged) == export_all(plain)


def test_aaf_has_one_master_per_file(tmp_path):
    pytest.importorskip("aaf2")
    import aaf2
    from soundstage.cut.aaf import write_aaf
    path = write_aaf(str(tmp_path / "pinned.aaf"), PINNED, "/out")
    with aaf2.open(path, "r") as f:
        names = sorted(m.name for m in f.content.mobs if type(m).__name__ == "MasterMob")
    assert "Sc 3 · Wide v1" in names and "Sc 3 · Wide" in names and "Sc 3 · Wide clay" in names, names


JS = """
import { exportAll } from "%s";
import { normalizeProject } from "%s";
const [project, opts] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify({ files: exportAll(project, opts), cut: normalizeProject(project).cut }));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
@pytest.mark.parametrize("opts", [{}, {"media_root": "/workspace/ComfyUI/output", "reel_width": 32}], ids=["browser", "server"])
def test_pinned_cut_parity_with_browser_writers(opts):
    """The same bytes from web/cut/exporters.mjs (a file:// URL that also works on Windows)."""
    web = pathlib.Path(ROOT, "web", "cut")
    js_opts = {"mediaRoot": opts.get("media_root", ""), "reelWidth": opts.get("reel_width", 8)}
    res = subprocess.run(["node", "--input-type=module", "-e", JS % ((web / "exporters.mjs").as_uri(), (web / "timeline.mjs").as_uri()),
                          json.dumps([PINNED, js_opts])], capture_output=True, text=True, encoding="utf-8", check=True)
    js = json.loads(res.stdout)
    assert js["cut"] == normalize_project(PINNED)["cut"]
    py = export_all(PINNED, **opts)
    assert list(js["files"]) == list(py)
    for name in py:
        assert js["files"][name] == py[name], name
