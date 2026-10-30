"""Soundstage Cut exporter tests: EDL syntax and timecode math (picture + audio events), Avid locators,
Premiere XML (xmeml), OTIO structure, FCPXML well-formedness, the export folder, the per-shot audio
mixdown, the AAF (needs pyaaf2), and byte-for-byte parity with the browser writers in
web/cut/exporters.mjs (needs node). With opentimelineio + its cmx3600 / fcpx_xml / aaf adapters
installed, the EDL, FCPXML and AAF are also read back through OTIO's own readers.

Run:  cd tests && python -m pytest test_cut.py -q
"""
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import (export_all, fcp_time, fps_info, frames_to_tc, media_for, normalize_project, to_avid_locators, to_xmeml,  # noqa: E402
                            tc_to_frames, to_edl, to_fcpxml, to_otio, write_cut)

with open(os.path.join(ROOT, "web", "cut", "demo_project.json"), encoding="utf-8") as _f:
    DEMO = json.load(_f)

# Awkward on purpose: 23.976, unicode, quotes, multi-line notes, ComfyUI /view URLs, long names.
EDGE = {
    "name": "Ça va? \"Take\" <2>",
    "fps": 23.976,
    "width": 1280,
    "height": 720,
    "shots": [
        {"id": 1, "name": "Scène 1 — master wide", "frames": 100, "scene_name": "S1", "setup": "master",
         "renders": {"draft": "/view?filename=S1%20master_00001.mp4&subfolder=soundstage%2Fdrafts&type=output"},
         "notes": "line one\nline two  & <three>"},
        {"id": 2, "name": "Scène 1 — master wide B", "frames": 50, "scene_name": "S1", "setup": "OTS A",
         "scene_offset": 20, "renders": {"look": "/view?filename=look.png&type=output"}},
        {"id": "c", "frames": 30.6},
    ],
    "cut": [{"shot_id": 1, "in": 0, "out": 40}, {"shot_id": 2, "in": 20, "out": 50, "notes": "cut note"},
            {"shot_id": "c", "in": 2.5, "out": 99}, {"shot_id": "nope", "in": 0, "out": 5}],
}

# EDGE plus overlapping, muted, gained, faded audio and advisor markers.
EDGE_AUDIO = json.loads(json.dumps(EDGE))
EDGE_AUDIO["shots"][0]["markers"] = [{"frame": 10, "text": "Advisor: hold longer", "color": "yellow", "user": "ADVISOR"},
                                     {"frame": 99, "text": "outside the cut"}]
EDGE_AUDIO["audio"] = [
    {"id": "x1", "track": 1, "url": "/view?filename=door%20slam.wav&subfolder=sfx&type=output", "start_frame": 10,
     "out": 30, "gain_db": -3.25, "fade_in": 4, "label": "Door – slam"},
    {"id": "x2", "track": 1, "path": "sfx/rain.wav", "start_frame": 20, "in": 5, "out": 400, "frames": 500, "fade_out": 30},
    {"id": "x3", "track": 3, "path": "/abs/hum.wav", "start_frame": 300, "out": 48, "gain_db": 6},
    {"id": "x4", "track": 2, "url": "x.wav"},
]
EDGE_AUDIO["audio_tracks"] = [{"track": 3, "mute": True}]

TC = r"\d\d:\d\d:\d\d:\d\d"
EVENT_RE = re.compile(rf"^(\d{{3}})  (\S+) +V {{5}}C {{8}}({TC}) ({TC}) ({TC}) ({TC})$")
AUDIO_RE = re.compile(rf"^(\d{{3}})  (\S+) +(A\d?) +C {{8}}({TC}) ({TC}) ({TC}) ({TC})$")


# ---------------------------------------------------------------- timecode

def test_timecode_math():
    assert frames_to_tc(0) == "00:00:00:00"
    assert frames_to_tc(86400) == "01:00:00:00"
    assert frames_to_tc(86400 + 24 * 61 + 5) == "01:01:01:05"
    for n in (0, 1, 23, 24, 1439, 1440, 86399, 86400, 123456):
        assert tc_to_frames(frames_to_tc(n)) == n
    assert fps_info(23.976) == {"base": 24, "num": 24000, "den": 1001}
    assert fcp_time(36, fps_info(24)) == "3/2s"
    assert fcp_time(1, fps_info(23.976)) == "1001/24000s"


# ---------------------------------------------------------------- EDL

@pytest.mark.parametrize("project", [DEMO, EDGE, EDGE_AUDIO], ids=["demo", "edge", "edge_audio"])
def test_edl_syntax(project):
    p = normalize_project(project)
    base = fps_info(p["fps"])["base"]
    lines = to_edl(project).split("\n")
    assert lines[0].startswith("TITLE: ") and lines[1] == "FCM: NON-DROP FRAME"
    assert all(ord(c) < 128 for c in lines[0])
    events = [l for l in lines if EVENT_RE.match(l) and EVENT_RE.match(l).group(0)[14] == "V"]
    assert len(events) == len(p["cut"])
    rec = tc_to_frames("01:00:00:00", base)
    for i, line in enumerate(events):
        m = EVENT_RE.match(line)
        assert m, line
        assert int(m.group(1)) == i + 1
        assert line[14] == "V" and line[20] == "C" and line.index(m.group(3)) == 29
        si, so, ri, ro = (tc_to_frames(m.group(k), base) for k in (3, 4, 5, 6))
        assert ri == rec and so - si == ro - ri
        assert (si, so) == (p["cut"][i]["in"], p["cut"][i]["out"])
        rec = ro
    # every comment line is a single line starting with '*'
    for l in lines[3:]:
        assert l == "" or l.startswith("*") or EVENT_RE.match(l) or AUDIO_RE.match(l), l
    audio = [AUDIO_RE.match(l) for l in lines if AUDIO_RE.match(l)]
    assert len(audio) == sum(1 for a in p["audio"] if a["out"] is not None)
    for m in audio:
        si, so, ri, ro = (tc_to_frames(m.group(k), base) for k in (4, 5, 6, 7))
        assert so - si == ro - ri and ri >= tc_to_frames("01:00:00:00", base)


def test_edl_notes_and_sources():
    edl = to_edl(EDGE, media_root="/workspace/ComfyUI/output")
    assert "* LOC: 01:00:00:00 RED     line one line two & <three>" in edl
    assert "* LOC: 01:00:01:16 RED     cut note" in edl
    assert "* SOURCE FILE: /workspace/ComfyUI/output/soundstage/drafts/S1 master_00001.mp4" in edl
    assert "* FROM CLIP NAME: Scène 1 — master wide B" in edl
    reels = [EVENT_RE.match(l).group(2) for l in edl.split("\n") if EVENT_RE.match(l)]
    assert reels[0] != reels[1] and all(len(r) <= 8 for r in reels)
    wide = to_edl(EDGE, reel_width=32)
    assert "SCÈNE" not in wide and "SC_NE_1_MASTER_WIDE_B" in wide


# ---------------------------------------------------------------- OTIO

def _check_otio_schema(t, project):
    p = normalize_project(project)
    assert t["OTIO_SCHEMA"] == "Timeline.1"
    assert t["tracks"]["OTIO_SCHEMA"] == "Stack.1"
    track, *audio_tracks = t["tracks"]["children"]
    assert track["OTIO_SCHEMA"] == "Track.1" and track["kind"] == "Video"
    for at in audio_tracks:
        assert at["kind"] == "Audio" and all(c["OTIO_SCHEMA"] in ("Clip.2", "Gap.1") for c in at["children"])
    assert len(track["children"]) == len(p["cut"])
    for clip, ev in zip(track["children"], p["cut"]):
        assert clip["OTIO_SCHEMA"] == "Clip.2"
        sr = clip["source_range"]
        assert sr["OTIO_SCHEMA"] == "TimeRange.1"
        assert sr["start_time"]["value"] == ev["in"] and sr["duration"]["value"] == ev["out"] - ev["in"]
        ref = clip["media_references"][clip["active_media_reference_key"]]
        assert ref["OTIO_SCHEMA"] in ("ExternalReference.1", "MissingReference.1")
        for m in clip["markers"]:
            assert m["OTIO_SCHEMA"] == "Marker.2" and m["marked_range"]["OTIO_SCHEMA"] == "TimeRange.1"


@pytest.mark.parametrize("project", [DEMO, EDGE, EDGE_AUDIO], ids=["demo", "edge", "edge_audio"])
def test_otio(project):
    text = export_all(project)[next(k for k in export_all(project) if k.endswith(".otio"))]
    t = json.loads(text)
    _check_otio_schema(t, project)
    try:
        import opentimelineio as otio
    except ImportError:
        return  # the schema check above is the fallback (the pod has no opentimelineio)
    tl = otio.adapters.read_from_string(text, "otio_json")
    p = normalize_project(project)
    rate = fps_info(p["fps"])["num"] / fps_info(p["fps"])["den"]
    assert tl.global_start_time.to_timecode() == "01:00:00:00"
    clips = list(tl.video_tracks()[0].find_clips())
    assert len(clips) == len(p["cut"])
    assert tl.video_tracks()[0].duration().value == pytest.approx(sum(e["out"] - e["in"] for e in p["cut"]))
    assert tl.duration().rate == pytest.approx(rate)
    first = tl.tracks[0].range_of_child_at_index(1)
    assert first.start_time.value == p["cut"][0]["out"] - p["cut"][0]["in"]


# ---------------------------------------------------------------- FCPXML

def _secs(s):
    n, _, d = s[:-1].partition("/")
    return int(n) / int(d or 1)


@pytest.mark.parametrize("project", [DEMO, EDGE, EDGE_AUDIO], ids=["demo", "edge", "edge_audio"])
def test_fcpxml_well_formed(project):
    p = normalize_project(project)
    fi = fps_info(p["fps"])
    root = ET.fromstring(to_fcpxml(project, media_root="/out").encode("utf-8"))
    assert root.tag == "fcpxml" and root.get("version") == "1.10"
    ids = {el.get("id") for el in root.find("resources")}
    seq = root.find("library/event/project/sequence")
    assert ids >= {seq.get("format")}
    assert _secs(seq.get("tcStart")) == pytest.approx(3600 * fi["base"] * fi["den"] / fi["num"])
    spine = [el for el in seq.find("spine") if el.tag != "gap"]
    assert len(spine) == len(p["cut"])
    lanes = [el for el in root.iter("asset-clip") if el.get("lane")]
    assert len(lanes) == sum(1 for a in p["audio"] if a["out"] is not None)
    off = _secs(seq.get("tcStart"))
    for el, ev in zip(spine, p["cut"]):
        assert el.tag in ("asset-clip", "clip")
        assert (el.get("ref") if el.tag == "asset-clip" else el.find("video").get("ref")) in ids
        assert _secs(el.get("offset")) == pytest.approx(off)
        assert _secs(el.get("start")) == pytest.approx(ev["in"] * fi["den"] / fi["num"])
        off += _secs(el.get("duration"))
    assert _secs(seq.get("duration")) >= off - _secs(seq.get("tcStart")) - 1e-9
    for asset in root.iter("asset"):
        src = asset.find("media-rep").get("src")
        assert src.startswith(("file:///out/", "file:///abs/")) and " " not in src


# ---------------------------------------------------------------- files

def test_write_cut(tmp_path):
    """Same folder every export (predictable paths for LTX), every format written, AAF when pyaaf2 is there."""
    web = os.path.join(ROOT, "web", "cut")
    res = write_cut(DEMO, str(tmp_path), name="My Cut", media_root=web, roots={"output": web})
    folder = res["folder"]
    assert folder == os.path.join(str(tmp_path), "My_Cut")
    names = sorted(os.listdir(folder))
    expected = ["My_Cut.edl", "My_Cut.fcpxml", "My_Cut.otio", "My_Cut_avid_locators.txt", "My_Cut_premiere.xml",
                "RELINK.txt", "audio", "project.json"]
    try:
        import aaf2  # noqa: F401
        expected.insert(0, "My_Cut.aaf")
        assert res["aaf"] and not res["aaf_error"]
    except ImportError:
        assert "pyaaf2" in res["aaf_error"]
    assert names == sorted(expected)
    assert json.load(open(os.path.join(folder, "project.json")))["name"] == "My Cut"
    open(os.path.join(folder, "My_Cut_avid_locators.txt"), encoding="latin-1").read()  # Latin-1 for Avid
    again = write_cut(DEMO, str(tmp_path), name="My Cut", media_root=web, roots={"output": web})
    assert again["folder"] == folder  # re-export overwrites in place


def test_media_for_view_urls():
    m = media_for(normalize_project(EDGE)["shots"][0], "/root")
    assert m["path"] == "/root/soundstage/drafts/S1 master_00001.mp4"
    assert m["url"] == "file:///root/soundstage/drafts/S1%20master_00001.mp4"


# ---------------------------------------------------------------- parity with web/cut/exporters.mjs

JS = """
import { exportAll } from "%s";
const [project, opts] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(exportAll(project, opts)));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
@pytest.mark.parametrize("project", [DEMO, EDGE, EDGE_AUDIO], ids=["demo", "edge", "edge_audio"])
@pytest.mark.parametrize("opts", [{}, {"media_root": "/workspace/ComfyUI/output", "reel_width": 32}], ids=["browser", "server"])
def test_parity_with_browser_writers(project, opts):
    js_opts = {"mediaRoot": opts.get("media_root", ""), "reelWidth": opts.get("reel_width", 8)}
    mod = "file://" + os.path.join(ROOT, "web", "cut", "exporters.mjs")
    res = subprocess.run(["node", "--input-type=module", "-e", JS % mod, json.dumps([project, js_opts])],
                         capture_output=True, text=True, check=True)
    js = json.loads(res.stdout)
    py = export_all(project, **opts)
    assert list(js) == list(py)
    for name in py:
        assert js[name] == py[name], name


# ---------------------------------------------------------------- round trips through OTIO's own readers

def _otio_adapter(name):
    otio = pytest.importorskip("opentimelineio")
    try:
        otio.adapters.from_name(name)
    except Exception:
        pytest.skip(f"OTIO adapter {name} not installed")
    return otio


def _clips(otio, tl, kind=None):
    if isinstance(tl, otio.schema.SerializableCollection):
        tl = next(iter(tl))
    tracks = [t for t in tl.tracks if kind is None or t.kind == kind]
    return [(c.name, c.source_range.start_time.value, c.source_range.duration.value) for t in tracks for c in t.find_clips()]


@pytest.mark.parametrize("adapter,writer", [("cmx_3600", to_edl), ("fcpx_xml", to_fcpxml)], ids=["edl", "fcpxml"])
def test_round_trip_through_otio_readers(adapter, writer):
    """pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter to run."""
    otio = _otio_adapter(adapter)
    kw = {"rate": 24} if adapter == "cmx_3600" else {}
    tl = otio.adapters.read_from_string(writer(DEMO), adapter, **kw)
    p = normalize_project(DEMO)
    names = {s["id"]: s["name"] for s in p["shots"]}
    want = [(names[e["shot_id"]], e["in"], e["out"] - e["in"]) for e in p["cut"]]
    assert _clips(otio, tl, "Video") == want
    labels = {a["label"] for a in normalize_project(DEMO)["audio"]}
    assert {c[0] for c in _clips(otio, tl, "Audio")} <= labels | set(names.values())
    assert len(_clips(otio, tl, "Audio")) >= len(labels)


# ---------------------------------------------------------------- Avid locators, Premiere XML

def test_avid_locators_format():
    txt = to_avid_locators(EDGE_AUDIO)
    rows = [l.split("\t") for l in txt.strip().split("\n")]
    assert all(len(r) == 8 and r[2] == "V1" and r[3] == r[7] and r[6] == "" for r in rows)
    frames = [tc_to_frames(r[1]) for r in rows]
    assert len(set(frames)) == len(frames)  # Avid keeps one locator per frame
    assert any(r[0] == "ADVISOR" and r[3] == "Yellow" and "hold longer" in r[4] for r in rows)
    assert not any("outside the cut" in r[4] for r in rows)
    txt.encode("latin-1")


@pytest.mark.parametrize("project", [DEMO, EDGE, EDGE_AUDIO], ids=["demo", "edge", "edge_audio"])
def test_xmeml_well_formed(project):
    p = normalize_project(project)
    root = ET.fromstring(to_xmeml(project, media_root="/out").encode("utf-8"))
    assert root.tag == "xmeml" and root.get("version") == "5"
    seq = root.find("sequence")
    vclips = seq.findall("media/video/track/clipitem")
    assert len(vclips) == len(p["cut"])
    rec = 0
    for c, e in zip(vclips, p["cut"]):
        assert int(c.findtext("start")) == rec and int(c.findtext("in")) == e["in"] and int(c.findtext("out")) == e["out"]
        rec = int(c.findtext("end"))
    files = {f.get("id"): f for f in root.iter("file") if f.find("pathurl") is not None}
    assert all(f.get("id") in files for f in root.iter("file"))  # every bare <file id/> was defined first
    assert all(f.findtext("pathurl").startswith("file://localhost/out/") for f in files.values()
               if not f.findtext("pathurl").startswith("file://localhost/abs"))
    aclips = seq.findall("media/audio/track/clipitem")
    assert len(aclips) == sum(1 for a in p["audio"] if a["out"] is not None)


# ---------------------------------------------------------------- audio mixdown

def _tone(path, seconds, value, sr=48000):
    import numpy as np
    from soundstage.cut.mix import write_wav24
    if sr != 48000:  # write a plain 16-bit file at another rate to exercise resampling
        import wave
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.full(int(seconds * sr), value * 32767)).astype("<i2").tobytes())
        return
    write_wav24(path, np.full((int(seconds * sr), 2), value, np.float32))


def test_mixdown_per_shot(tmp_path):
    np = pytest.importorskip("numpy")
    from soundstage.cut.mix import decode, shot_segments, write_mixdown
    sfx = tmp_path / "sfx"
    sfx.mkdir()
    _tone(str(sfx / "a.wav"), 2.0, 0.25)            # 48 frames of 0.25
    _tone(str(sfx / "b.wav"), 1.0, 0.5, sr=24000)   # resampled
    project = {
        "name": "Mix Test", "fps": 24,
        "shots": [{"id": "m", "name": "M", "frames": 96, "scene_name": "S1"},
                  {"id": "o", "name": "O", "frames": 96, "scene_name": "S1", "scene_offset": 24},
                  {"id": "x", "name": "X", "frames": 24, "scene_name": "S2"}],
        "cut": [{"shot_id": "m", "in": 0, "out": 48}, {"shot_id": "o", "in": 24, "out": 48}],
        "audio": [{"id": "a", "track": 1, "path": "sfx/a.wav", "start_frame": 0, "out": 48},
                  {"id": "b", "track": 2, "url": "/view?filename=b.wav&subfolder=sfx&type=output", "start_frame": 60,
                   "out": 12, "gain_db": -6.0206},
                  {"id": "z", "track": 3, "path": "sfx/a.wav", "start_frame": 0, "out": 48},
                  {"id": "missing", "track": 4, "path": "sfx/nope.wav", "start_frame": 0, "out": 10}],
        "audio_tracks": [{"track": 3, "mute": True}],
    }
    idx = write_mixdown(project, str(tmp_path / "out"), {"output": str(tmp_path)})
    assert idx["has_audio"] and idx["sample_rate"] == 48000 and idx["bit_depth"] == 24
    assert [p["audio_id"] for p in idx["problems"]] == ["missing"]
    shots = {s["shot_id"]: s for s in idx["shots"]}
    assert set(shots) == {"m", "o", "x"} and shots["x"]["silent"]
    for s in shots.values():
        data = decode(str(tmp_path / "out" / s["file"]))
        assert data.shape == (s["samples"], 2) and s["samples"] == s["frames"] * 2000  # 48000 / 24
    # M: frames 0-48 own (rec 0-48: tone a); 48-72 from O's event via the scene clock (O frame 24-48 =
    # scene 48-72 = rec 48-72: silence then b at rec 60-72)
    m = decode(str(tmp_path / "out" / shots["m"]["file"]))
    assert np.allclose(m[1000:2000 * 47], 0.25, atol=1e-4)
    assert np.allclose(m[2000 * 61:2000 * 71], 0.25, atol=2e-3)  # 0.5 at -6.02 dB
    assert np.allclose(m[2000 * 73:], 0, atol=1e-6)
    assert shot_segments(normalize_project(project), normalize_project(project)["shots"][0]) == [(0, 48, 0, "own"), (48, 72, 48, "scene")]
    # O: its frame 0 is scene 24 = M frame 24 = rec 24
    o = decode(str(tmp_path / "out" / shots["o"]["file"]))
    assert np.allclose(o[1000:2000 * 23], 0.25, atol=1e-4)
    assert shots["o"]["covered"] == [[0, 24, "scene"], [24, 48, "own"]]
    # muted track 3 is not in the mix (else M frame 10 would read 0.5)
    assert abs(m[2000 * 10, 0] - 0.25) < 1e-4
    cut = decode(str(tmp_path / "out" / idx["cut_mix"]["file"]))
    assert len(cut) == 72 * 2000


# ---------------------------------------------------------------- AAF

def test_aaf(tmp_path):
    pytest.importorskip("aaf2")
    from soundstage.cut.aaf import write_aaf
    path = write_aaf(str(tmp_path / "t.aaf"), EDGE_AUDIO, "/out")
    import aaf2
    with aaf2.open(path, "r") as f:
        comp = next(f.content.toplevel())
        kinds = [s.segment.media_kind for s in comp.slots if hasattr(s.segment, "media_kind")]
        assert kinds.count("Picture") == 1 and kinds.count("Sound") == 3  # A1, A1b, A3
    try:
        otio = _otio_adapter("AAF")
    except pytest.skip.Exception:
        return
    tl = otio.adapters.read_from_file(path)
    if isinstance(tl, otio.schema.SerializableCollection):
        tl = next(iter(tl))
    p = normalize_project(EDGE_AUDIO)
    v = tl.video_tracks()[0]
    assert [(c.source_range.start_time.value, c.source_range.duration.value) for c in v.find_clips()] == \
        [(e["in"], e["out"] - e["in"]) for e in p["cut"]]
    assert len(tl.audio_tracks()) == 3
    assert any("hold longer" in m.name for c in v.find_clips() for m in c.markers)
