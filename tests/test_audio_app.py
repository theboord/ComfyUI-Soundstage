"""The App's audio part (tools/app_build/audio.py) and the shot mixer. No ComfyUI needed."""
import importlib
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools", "app_build"))

from soundstage.audio import clip as C  # noqa: E402

BASE = os.path.join(ROOT, "example_workflows", "Soundstage_App.json")


def _built():
    from graph import Graph
    g = Graph.load(BASE)
    importlib.import_module("audio").apply(g)
    return g


def _ids(g, typ):
    return [n["id"] for n in g.nodes.values() if n["type"] == typ]


def test_app_audio_part_wiring():
    base = json.load(open(BASE))
    g = _built()
    # base App untouched: every base node keeps its widgets and inputs links
    for n in base["nodes"]:
        m = g.nodes[n["id"]]
        assert m.get("widgets_values") == n.get("widgets_values"), n["id"]
        assert [i.get("link") for i in m["inputs"]] == [i.get("link") for i in n["inputs"]], n["id"]
    snd = _ids(g, "SoundstageShotSound")[0]
    assert g.source_of(snd, "frames") == (9045, 5) and g.source_of(snd, "fps") == (9045, 4)
    wv = g.nodes[snd]["widgets_values"]
    assert wv[:6] == ["", "", "", "Chatterbox · local [open · MIT]", "", ""] and wv[7] == "fixed"  # blank, cached
    saves = {g.nodes[i].get("title"): i for i in _ids(g, "SaveVideo")}
    assert {"Rung 4 · Final", "Rung 4 · Final + sound", "Rung 4 · Final · audio-driven"} <= set(saves)
    for t in ("Rung 4 · Final + sound", "Rung 4 · Final · audio-driven"):
        gate = g.source_of(saves[t], "video")[0]
        assert g.nodes[gate]["type"] == "SoundstageGate" and g.nodes[gate]["widgets_values"] == [4]
        assert g.source_of(gate, "step") == (9059, 0)
    mux = g.source_of(g.source_of(saves["Rung 4 · Final + sound"], "video")[0], "value")[0]
    assert g.source_of(mux, "images") == (9066, 0) and g.source_of(mux, "fps") == (9066, 2)
    assert g.source_of(mux, "audio") == (snd, 0)
    when = _ids(g, "SoundstageWhen")[0]
    assert g.nodes[when]["widgets_values"] == [False]  # audio-driven final is off by default
    ld = g.w["extra"]["linearData"]
    keys = [k[1] for k in ld["inputs"]]
    for w in ("line", "character", "voice", "dialogue_engine", "sfx_prompt", "music_mood", "enabled"):
        assert w in keys
    assert str(saves["Rung 4 · Final + sound"]) in ld["outputs"]
    # idempotent
    n = len(g.nodes)
    importlib.import_module("audio").apply(g)
    assert len(g.nodes) == n


def test_mix_clips(tmp_path):
    sr = 48000
    t = np.arange(sr) / sr
    tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[:, None]
    _, a = C.finish(tone, sr, str(tmp_path), "s", clip_id="dx_001", track="DX1", fps=24, start_frame=12, normalize_db=None)
    _, b = C.finish(tone, sr, str(tmp_path), "s", clip_id="fx_001", track="FX1", fps=24, start_frame=0,
                    gain_db=-6.0, normalize_db=None)
    m = C.mix_clips([a, b], str(tmp_path), 48, 24)
    assert m.shape == (96000, 2)
    assert abs(np.abs(m[:24000]).max() - 0.5 * 10 ** (-6 / 20)) < 0.01  # FX alone for the first 0.5 s
    assert np.abs(m).max() <= 0.8913  # limited to -1 dBFS
