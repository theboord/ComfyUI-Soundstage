"""Milestone 19: the editing timeline's transitions, fades, keys, titles and subtitles through the Python twin
(byte parity with web/cut/exporters.mjs), the mixdown with volume keys and the auto-duck, and the full render
(soundstage/cut/render.py): transitions, a fade from black, music ducked under a line, two SFX, loudness to target,
a 9:16 social cut and ProRes. Needs node for parity and ffmpeg + Pillow for the render.

Run:  cd tests && python -m pytest test_cut_m19.py -q
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import wave
import xml.etree.ElementTree as ET

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import export_all, normalize_project  # noqa: E402
from soundstage.cut.export import merged_level_keys, to_srt, trans_spans  # noqa: E402
from soundstage.cut.mix import clip_signal  # noqa: E402

with open(os.path.join(ROOT, "web", "cut", "demo_project.json"), encoding="utf-8") as _f:
    DEMO = json.load(_f)


def m19(fps=24):
    p = copy.deepcopy(DEMO)
    p["fps"] = fps
    p["cut"][0]["trans"] = {"type": "dip_black", "frames": 24}
    p["cut"][1]["trans"] = {"type": "dissolve", "frames": 12}
    p["cut"][2]["trans"] = {"type": "dip_white", "frames": 9}
    p["cut"][3]["trans"] = {"type": "wipe", "frames": 40}
    p["cut"][5]["trans"] = {"type": "dissolve", "frames": 30}   # no handles: dropped
    p["cut"][4]["opacity"] = [[0, 1], [6, 0.35], [11, 1.0]]
    p["fade_out"] = {"type": "dip_black", "frames": 20}
    p["audio"][0]["keys"] = [[0, 0], [30, -6.5], [60, 0]]
    p["audio"][0]["duck"] = [[10, 0], [16, -12], [40, -12], [52, 0]]
    p["titles"] = [{"text": "DINER NIGHT", "start_frame": 0, "frames": 48}, {"text": "Mara & \"Ezra\"", "start_frame": 100, "frames": 40, "style": "lower"}]
    p["subtitles"] = [{"start_frame": 30, "end_frame": 70, "text": "Drove all night to find you, and you're eating pie. And more words to wrap", "speaker": "EZRA"},
                      {"start_frame": 80, "end_frame": 100, "text": "I'm not <eating> it."}]
    return p


JS = """
import { exportAll } from "%s";
const [project, opts] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(exportAll(project, opts)));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
@pytest.mark.parametrize("fps", [24, 23.976])
@pytest.mark.parametrize("opts", [{}, {"media_root": "/workspace/ComfyUI/output", "reel_width": 32}], ids=["browser", "server"])
def test_parity_with_browser_writers(fps, opts):
    project = m19(fps)
    mod = "file://" + os.path.join(ROOT, "web", "cut", "exporters.mjs")
    js_opts = {"mediaRoot": opts.get("media_root", ""), "reelWidth": opts.get("reel_width", 8)}
    res = subprocess.run(["node", "--input-type=module", "-e", JS % mod, json.dumps([project, js_opts])],
                         capture_output=True, text=True, check=True)
    js = json.loads(res.stdout)
    py = export_all(project, **opts)
    assert list(js) == list(py)
    assert any(k.endswith(".srt") for k in py) and any(k.endswith(".vtt") for k in py)
    for name in py:
        assert js[name] == py[name], name


def test_spans_and_exports_parse():
    p = normalize_project(m19())
    spans, tail = trans_spans(p)
    assert [(s["pre"], s["post"]) if s else None for s in spans] == [(0, 24), (6, 6), (4, 5), (10, 15), None, None, None]
    assert tail["pre"] == 20
    files = export_all(m19())
    ET.fromstring(files["Diner_Night_v1.fcpxml"].split("\n", 2)[2])
    root = ET.fromstring(files["Diner_Night_v1_premiere.xml"].split("\n", 2)[2])
    v1 = root.find("sequence/media/video/track")
    kinds = [c.tag for c in v1]
    assert kinds[0] == "transitionitem" and kinds[-1] == "transitionitem" and kinds.count("transitionitem") == 5
    assert len(root.findall("sequence/media/video/track")) == 2   # V1 + V2 titles
    otio = json.loads(files["Diner_Night_v1.otio"])
    assert sum(c["OTIO_SCHEMA"] == "Transition.1" for c in otio["tracks"]["children"][0]["children"]) == 5
    assert to_srt(m19()).startswith("1\n00:00:01,250 --> 00:00:02,917\n")


def test_mix_applies_keys_and_duck():
    a = normalize_project({"audio": [{"id": "m", "out": 48, "frames": 48, "keys": [[0, 0], [24, -6]], "duck": [[24, 0], [48, -12]]}]})["audio"][0]
    data = np.ones((48000 * 2, 2), np.float32)
    sig = clip_signal(a, data, 24.0)
    at = lambda f: float(sig[int(f / 24 * 48000), 0])  # noqa: E731
    assert at(0) == pytest.approx(1.0, abs=1e-3)
    assert at(12) == pytest.approx(10 ** (-3 / 20), abs=1e-3)
    assert at(36) == pytest.approx(10 ** ((-6 - 6) / 20), abs=1e-3)
    assert merged_level_keys(a) == [[0, 0], [24, -6], [48, -18]]


# ---------------------------------------------------------------- the full render

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed")


def _wav(path, x, sr=48000):
    x = np.asarray(x, np.float32)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def _clip(path, colour, seconds=4, tone=None):
    args = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:r=24:d={seconds}"]
    if tone:
        args += ["-f", "lavfi", "-i", f"sine=frequency={tone}:sample_rate=48000:duration={seconds}", "-shortest", "-c:a", "aac"]
    subprocess.run(args + ["-pix_fmt", "yuv420p", "-c:v", "libx264", path], check=True)


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("m19")
    colours = ["red", "green", "blue", "yellow", "magenta", "cyan"]
    for i, c in enumerate(colours):
        _clip(str(d / f"shot{i}.mp4"), c, tone=330 if i == 2 else None)
    sr = 48000
    t = np.arange(sr * 12) / sr
    rng = np.random.default_rng(1)
    music = 0.25 * np.sin(2 * np.pi * 110 * t) * (0.6 + 0.4 * (np.sin(2 * np.pi * 2 * t) > 0)) + 0.03 * rng.standard_normal(len(t))
    _wav(str(d / "music.wav"), music)
    line = np.zeros(sr * 2)
    line[: int(1.6 * sr)] = 0.5 * np.sin(2 * np.pi * 220 * t[: int(1.6 * sr)]) * np.sin(np.pi * t[: int(1.6 * sr)] / 1.6)
    _wav(str(d / "line.wav"), line)
    hit = np.zeros(sr)
    hit[:4000] = 0.9 * rng.standard_normal(4000) * np.exp(-np.arange(4000) / 800)
    _wav(str(d / "glass.wav"), hit)
    _wav(str(d / "door.wav"), hit[::-1] * 0.7)
    return d


def _project(d):
    shots = [{"id": f"s{i}", "name": f"SHOT_{i}", "frames": 96, "renders": {"final": str(d / f"shot{i}.mp4")}} for i in range(6)]
    cut = [{"shot_id": f"s{i}", "in": 12, "out": 60} for i in range(6)]
    cut[0]["trans"] = {"type": "dip_black", "frames": 24}          # fade up from black
    cut[2]["trans"] = {"type": "dissolve", "frames": 12}
    cut[4]["trans"] = {"type": "dissolve", "frames": 16}
    audio = [
        {"id": "mx", "track": 3, "path": str(d / "music.wav"), "start_frame": 0, "out": 288, "frames": 288, "gain_db": -3, "label": "Score"},
        {"id": "dx", "track": 1, "path": str(d / "line.wav"), "start_frame": 100, "out": 48, "frames": 48,
         "meta": {"kind": "dialogue", "line": "Then why bring this one?", "character": "MARA"}},
        {"id": "fx1", "track": 2, "path": str(d / "glass.wav"), "start_frame": 60, "out": 24, "frames": 24, "label": "Glass"},
        {"id": "fx2", "track": 2, "path": str(d / "door.wav"), "start_frame": 200, "out": 24, "frames": 24, "label": "Door"},
    ]
    return {"name": "M19 test", "fps": 24, "width": 320, "height": 180, "shots": shots, "cut": cut, "audio": audio,
            "fade_out": {"type": "dip_black", "frames": 12},
            "titles": [{"text": "M19", "start_frame": 0, "frames": 24, "style": "center"}],
            "subtitles": [{"start_frame": 100, "end_frame": 148, "text": "Then why bring this one?", "speaker": "MARA"}]}


def _auto_duck(p):
    """The panel's Auto-duck (web/cut/fx.mjs autoDuck): the render gets the duck keys it writes."""
    if not shutil.which("node"):
        pytest.skip("node not installed")
    mod = "file://" + os.path.join(ROOT, "web", "cut", "fx.mjs")
    tl = "file://" + os.path.join(ROOT, "web", "cut", "timeline.mjs")
    js = (f'import {{ autoDuck }} from "{mod}"; import {{ normalizeProject }} from "{tl}";'
          'process.stdout.write(JSON.stringify(autoDuck(normalizeProject(JSON.parse(process.argv[1])))));')
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", js, json.dumps(p)], capture_output=True, text=True, check=True).stdout)


def _frame_mean(path, t, size="320x180"):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 3).mean(0)


@needs_ffmpeg
def test_render_mp4_transitions_duck_loudness(media, tmp_path):
    pytest.importorskip("PIL")
    from soundstage.cut.render import measure, probe, render_cut
    p = _project(media)
    p["audio"] = _auto_duck(p)
    mx = next(a for a in p["audio"] if a["id"] == "mx")
    assert mx["duck"] == [[91, 0], [97, -12], [151, -12], [163, 0]]
    out = str(tmp_path / "cut.mp4")
    r = render_cut(p, {"output": str(media)}, out, {"loudness": "social", "burn_subtitles": True})
    info = probe(out)
    assert (info["width"], info["height"]) == (320, 180) and r["frames"] == 288
    assert abs(info["duration"] - 12.0) < 0.1
    assert r["missing"] == []
    assert [t["edit"] for t in r["transitions"]] == [0, 2, 4, "tail"]
    # fade from black: the first frame is (nearly) black, a second in it's red
    assert _frame_mean(out, 0.0).max() < 25
    assert _frame_mean(out, 1.6)[0] > 150
    # mid-dissolve between green (clip 1) and blue (clip 2): both channels lit
    mid = _frame_mean(out, 96 / 24)
    assert mid[1] > 40 and mid[2] > 40
    # loudness: -14 LUFS integrated within 0.5 LU, true peak under -1 dBTP (+ AAC overshoot margin)
    m = measure(out)
    assert abs(m["lufs"] - -14) < 0.5, m
    assert m["true_peak"] < -0.5, m
    assert r["sync_clips"] == 1                   # shot 2's own sound is in the mix


@needs_ffmpeg
def test_render_social_and_prores(media, tmp_path):
    pytest.importorskip("PIL")
    from soundstage.cut.render import probe, render_cut
    p = _project(media)
    out = str(tmp_path / "social.mp4")
    render_cut(p, {"output": str(media)}, out, {"aspect": "9:16", "loudness": "ebu"})
    info = probe(out)
    assert (info["width"], info["height"]) == (1080, 1920)
    out2 = str(tmp_path / "cut.mov")
    r = render_cut(p, {"output": str(media)}, out2, {"format": "prores", "loudness": "atsc"})
    assert probe(out2)["codec"] == "prores"
    assert abs(r["loudness"]["lufs"] - -24) < 0.5


@needs_ffmpeg
def test_render_with_film_finish(media, tmp_path):
    """Milestone 21: the Film Finish runs inside the cut render (same size, same length)."""
    pytest.importorskip("PIL")
    from soundstage.cut.render import probe, render_cut
    p = _project(media)
    out = str(tmp_path / "fin.mp4")
    r = render_cut(p, {"output": str(media)}, out, {"loudness": "social", "finish": "35mm"})
    plain = render_cut(p, {"output": str(media)}, str(tmp_path / "plain.mp4"), {"loudness": "social"})
    info = probe(out)
    assert (info["width"], info["height"]) == (probe(str(tmp_path / "plain.mp4"))["width"], probe(str(tmp_path / "plain.mp4"))["height"])
    assert r["frames"] == plain["frames"]
