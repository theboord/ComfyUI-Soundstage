"""V3 motion graphics on the Cut timeline (soundstage/cut/gfx.py, gfx_sfx.py; web/cut/gfx.mjs is the twin):
the spec's easing reference values (share/Commercial/DESIGN_SYSTEM.md §8), op parity with the JavaScript twin
(tests/js/fixtures/gfx_states.json, written by node), the designed sound pack (levels, lengths, onsets,
determinism), and the render: each template drawn over a synthetic cut through render_cut.

Run:  python -m pytest tests/test_cut_gfx.py -q
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import gfx as G  # noqa: E402
from soundstage.cut import gfx_sfx as S  # noqa: E402
from soundstage.cut.mix import SR  # noqa: E402

FIX = os.path.join(ROOT, "tests", "js", "fixtures", "gfx_states.json")
needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


def _close(a, b, tol=0.0015):
    assert len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b)), (a, b)


def test_easing_matches_the_spec_tables():
    E = G.EASE
    _close([E["glide"](i / 12) for i in range(13)], [0, .100, .406, .607, .732, .817, .878, .922, .953, .975, .990, .998, 1])
    _close([E["glide"](i / 14) for i in range(15)], [0, .068, .325, .534, .667, .759, .827, .878, .916, .946, .967, .982, .993, .998, 1])
    _close([E["glide"](i / 16) for i in range(17)], [0, .049, .256, .467, .607, .705, .778, .834, .878, .912, .939, .960, .975, .987, .994, .999, 1])
    _close([E["glide"](i / 18) for i in range(19)],
           [0, .037, .200, .406, .552, .655, .732, .792, .840, .878, .909, .934, .953, .969, .981, .990, .996, .999, 1])
    _close([E["swift"](i / 10) for i in range(11)], [0, .026, .134, .367, .614, .776, .876, .938, .975, .994, 1])
    _close([E["exit"](i / 8) for i in range(9)], [0, .009, .035, .082, .154, .257, .406, .626, 1])
    _close([E["enter"](i / 12) for i in range(13)], [0, .576, .743, .832, .887, .924, .950, .969, .982, .991, .996, .999, 1])
    _close([G.ao(i) for i in range(17)], [0, -.010, -.030, -.040, .233, .610, .793, .899, .965, 1.004, 1.024, 1.030, 1.027, 1.020, 1.010, 1.003, 1.000])
    _close([G.spring_fast(i) for i in range(10)], [0, .277, .668, .910, 1.009, 1.028, 1.020, 1.009, 1.002, 1.000])
    _close([G.spring(i) for i in range(14)], [0, .146, .416, .668, .848, .956, 1.009, 1.027, 1.027, 1.020, 1.013, 1.007, 1.003, 1.000])
    _close([G.expo(1, 2, E["glide"](i / 18)) for i in range(19)],
           [1.000, 1.026, 1.148, 1.325, 1.466, 1.574, 1.661, 1.731, 1.789, 1.838, 1.877, 1.910, 1.937, 1.958, 1.974, 1.986, 1.994, 1.999, 2.000])


def test_ops_and_cues_match_the_javascript_twin():
    fx = json.load(open(FIX))
    gs = G.normalize_graphics(fx["cases"])
    assert gs == fx["graphics"]
    assert {g["template"] for g in gs} == set(G.TEMPLATES)
    n = 0
    for g in gs:
        for f, ops in fx["states"][g["id"]]:
            assert G.state_at(g, f) == ops, (g["id"], f)
            n += 1
        assert G.sfx_cues(g) == fx["cues"][g["id"]], g["id"]
    assert n > 300


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_fixture_is_current():
    """The fixture is what web/cut/gfx.mjs computes today (rewrite: node tests/js/cut_gfx.test.mjs --update)."""
    js = ("import { gfxCases, frames } from '%s'; import * as G from '%s';"
          "const gs = G.normalizeGraphics(gfxCases()); const st = {}; for (const g of gs) st[g.id] = frames(g.frames).map((f) => [f, G.stateAt(g, f)]);"
          "process.stdout.write(JSON.stringify(st));") % (
        "file://" + os.path.join(ROOT, "tests", "js", "fixtures", "gfx_cases.mjs"), "file://" + os.path.join(ROOT, "web", "cut", "gfx.mjs"))
    st = json.loads(subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert st == json.load(open(FIX))["states"]


def test_normalize_clamps_and_defaults():
    g = G.normalize_graphics([{"template": "callout", "frames": 3, "rect": [1900, -5, 400, 2], "color": "red", "accent": "#00ff00",
                               "a": {"shot_id": 7}}, {"template": "split", "a": {"shot_id": "s", "in": 4.6}}, "junk"])
    c = next(x for x in g if x["template"] == "callout")
    assert c["frames"] == 12 and c["rect"] == [1520, 0, 400, 8, 8] and c["color"] == G.PAPER and c["accent"] == "#00FF00"
    sp = next(x for x in g if x["template"] == "split")
    assert sp["a"] == {"shot_id": "s", "in": 5, "rung": "final"} and sp["b"] == {"shot_id": "s", "in": 5, "rung": "clay"}


def test_every_event_has_one_designed_sound_on_the_spec_grid():
    gs = {g["template"] + "_" + g["variant"]: g for g in G.normalize_graphics(json.load(open(FIX))["cases"])}
    k = gs["kinetic_ink"]
    assert [(c["sfx"], c["frame"]) for c in G.sfx_cues(k)] == [("SFX-03", 7), ("SFX-02", 10), ("SFX-02", 22)]
    co = gs["callout_zoom"]
    cues = {c["sfx"]: c for c in G.sfx_cues(co)}
    assert cues["SFX-07"]["frame"] == 10 and cues["SFX-06"]["frame"] == 0 and cues["SFX-05"]["gain_db"] == -24 + 1 - 6
    # a riser that ends on the zoom's sync frame: 10 frames long
    assert abs(len(S.riser()) / SR - 10 / 24) < 1e-3
    lib = {k: {} for k in S.recipes()}
    for g in gs.values():
        for c in G.sfx_cues(g):
            assert S.file_key(c, lib), c
    assert G.sfx_cues({**gs["pip_br"], "sfx": False}) == []


def test_sound_pack_levels_lengths_onsets_and_determinism(tmp_path):
    lib = S.ensure_library(str(tmp_path))
    assert set(lib) == set(S.recipes())
    man = json.load(open(tmp_path / S.SUB / "MANIFEST.json"))
    for key, ent in lib.items():
        fn = tmp_path / S.SUB / ent["filename"]
        x = S.synth(key)
        assert x.shape[1] == 2 and abs(20 * np.log10(np.abs(x).max()) + 1) < 0.05, key
        m = man["files"][ent["filename"]]
        assert m["sha256"] == hashlib.sha256(open(fn, "rb").read()).hexdigest()
    # spec lengths (§13): tick 40-60 ms, thump 300-400, whoosh = 16 f move - 2 f, whoosh out 200-300, ping 200-250,
    # click 15-30, puff 60-90, sonic logo 2.5-3.5 s
    sec = {k: v["seconds"] for k, v in lib.items()}
    assert 0.04 <= sec["SFX-01_tick_1"] <= 0.06 and 0.3 <= sec["SFX-03_thump"] <= 0.4
    assert abs(sec["SFX-04_whoosh_c"] - 14 / 24) < 1e-3 and 0.2 <= sec["SFX-05_whoosh_out_c"] <= 0.3
    assert 0.2 <= sec["SFX-07_ping_c"] <= 0.25 and 0.015 <= sec["SFX-08_click_c"] <= 0.03
    assert 0.06 <= sec["SFX-12_puff_c"] <= 0.09 and 2.5 <= sec["SFX-15_logo_swell"] <= 3.5

    def onsets(x, thr_db=-20, gap_ms=5):
        e = np.abs(x).max(1)
        hot = e > np.abs(x).max() * 10 ** (thr_db / 20)
        idx = np.flatnonzero(hot)
        groups = 1 + int(np.sum(np.diff(idx) > gap_ms / 1000 * SR)) if len(idx) else 0
        return groups, idx
    assert onsets(S.synth("SFX-01_tick_1"))[0] == 1
    n, idx = onsets(S.synth("SFX-08_click_c"))
    assert n == 2   # two transients 8 ms apart
    assert onsets(S.synth("SFX-02_swap"), gap_ms=30)[0] == 2   # outgoing + incoming ticks, 2 f apart
    # pans: left files lean left, right files right, centre balanced
    for p, sign in (("l", 1), ("r", -1)):
        x = S.synth(f"SFX-04_whoosh_{p}")
        assert sign * (np.abs(x[:, 0]).sum() - np.abs(x[:, 1]).sum()) > 0
    # deterministic: the same bytes every time
    assert np.array_equal(S.synth("SFX-09_air_c"), S.synth("SFX-09_air_c"))
    # a second call writes nothing new
    t0 = os.path.getmtime(tmp_path / S.SUB / "SFX-03_thump.wav")
    S.ensure_library(str(tmp_path))
    assert os.path.getmtime(tmp_path / S.SUB / "SFX-03_thump.wav") == t0


# ---------------------------------------------------------------------------------------------- the render

def _clip(path, colour, seconds=4):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={colour}:s=480x270:r=24:d={seconds}",
                    "-pix_fmt", "yuv420p", "-c:v", "libx264", path], check=True)


def _frame(path, f, W=480, H=270):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"select=eq(n\\,{f})", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(int)


@pytest.fixture(scope="module")
def cut(tmp_path_factory):
    d = tmp_path_factory.mktemp("gfx")
    for name, c in (("red", "red"), ("green", "0x00ff00"), ("blue", "blue")):
        _clip(str(d / f"{name}.mp4"), c)
    shots = [{"id": "r", "name": "RED", "frames": 96, "renders": {"final": str(d / "red.mp4"), "clay": str(d / "blue.mp4")}},
             {"id": "g", "name": "GREEN", "frames": 96, "renders": {"final": str(d / "green.mp4")}}]
    return d, shots


@needs_ffmpeg
def test_render_draws_each_template_over_the_cut(cut, tmp_path):
    pytest.importorskip("PIL")
    from soundstage.cut.render import probe, render_cut
    d, shots = cut
    gfx = [
        {"id": "t", "template": "title", "start_frame": 0, "frames": 24, "text": "Go."},                                   # ink card
        {"id": "p", "template": "pip", "start_frame": 24, "frames": 30, "a": {"shot_id": "g", "in": 0}},                   # green window, br
        {"id": "s", "template": "split", "start_frame": 54, "frames": 30, "variant": "hold", "a": {"shot_id": "r", "in": 0}},  # final | clay
        {"id": "c", "template": "callout", "start_frame": 84, "frames": 30, "variant": "ring", "rect": [800, 480, 320, 120, 8]},
        {"id": "e", "template": "endcard", "start_frame": 114, "frames": 30},
    ]
    p = {"name": "gfx test", "fps": 24, "width": 480, "height": 270, "shots": shots,
         "cut": [{"shot_id": "r", "in": 0, "out": 96}, {"shot_id": "r", "in": 0, "out": 48}], "graphics": gfx}
    out = str(tmp_path / "g.mp4")
    r = render_cut(p, {"output": str(d)}, out, {"loudness": None, "gfx_motion_blur": False})
    assert r["graphics"]["graphics"] == 5 and r["frames"] == 144 and probe(out)["width"] == 480
    ink = np.array([14, 13, 16])
    f0 = _frame(out, 12)
    assert np.abs(f0[20, 20] - ink).max() < 12                       # the title's ink ground, not the red plate
    assert f0[120:150, 200:280].max() > 200                          # paper type in the middle
    f1 = _frame(out, 24 + 20)                                        # PiP landed: green in the bottom-right window
    wx, wy = int((1264 + 280) / 4), int((669 + 157) / 4)
    assert f1[wy, wx, 1] > 180 and f1[wy, wx, 0] < 90
    assert f1[40, 40, 0] < 200 and f1[40, 40, 0] > 60                # the plate behind recedes (darker red)
    f2 = _frame(out, 54 + 20)                                        # split held at the centre: final (red) left, clay (blue) right
    assert f2[200, 100, 0] > 180 and f2[200, 380, 2] > 180
    f3 = _frame(out, 84 + 15)                                        # ring only: blue stroke around the control box
    ring = f3[int(462 / 4):int(618 / 4), int(782 / 4):int(1138 / 4)]
    assert ring[..., 1].max() > 60 and f3[135, 240, 1] < 30          # blue-ish stroke (green channel up) over red; inside stays red
    f4 = _frame(out, 114 + 20)                                       # end card: the yellow logo on ink
    logo = f4[int(400 / 4):int(509 / 4), int(640 / 4):int(1280 / 4)]
    assert ((logo[..., 0] > 180) & (logo[..., 1] > 180) & (logo[..., 2] < 140)).sum() > 50
    plain = render_cut({**p, "graphics": []}, {"output": str(d)}, str(tmp_path / "plain.mp4"), {"loudness": None})
    assert plain["graphics"] is None


@needs_ffmpeg
def test_motion_blur_averages_subframes_while_moving(cut, tmp_path):
    from soundstage.cut.render import render_cut
    d, shots = cut
    p = {"name": "mb", "fps": 24, "width": 480, "height": 270, "shots": shots, "cut": [{"shot_id": "r", "in": 0, "out": 40}],
         "graphics": [{"id": "k", "template": "kinetic", "start_frame": 0, "frames": 36, "text": "One two"}]}
    r = render_cut(p, {"output": str(d)}, str(tmp_path / "mb.mp4"), {"loudness": None})
    assert r["graphics"]["subframes"] > 0
    g = G.normalize_graphics(p["graphics"])[0]
    assert len(G.frame_ops(g, 30)) == 1          # the held word renders once
    assert len(G.frame_ops(g, 12)) == 4          # the swap moves: 4 sub-frames
