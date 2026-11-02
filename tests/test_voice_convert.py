"""Voice change of a long take in pieces cut at its pauses (soundstage/audio/vcchunk.py), and the Chatterbox VC step's
contract for the Real performance dialog: same length out, silent clips pass, chunk_s is an input. No ComfyUI, no GPU."""
import ast
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.audio import vcchunk as K  # noqa: E402

SR = 16000


def _take(spans, dur, sr=SR, room_db=-62.0, seed=0):
    """A fake take: tone bursts ("lines") at spans [(t0, t1)] over room tone."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(dur * sr)).astype(np.float32) * 10 ** (room_db / 20)
    t = np.arange(len(x)) / sr
    for a, b in spans:
        m = (t >= a) & (t < b)
        x[m] += 0.3 * np.sin(2 * np.pi * 140 * t[m]).astype(np.float32)
    return x


def test_short_take_is_one_piece():
    x = _take([(1, 3), (4, 6)], 8.0)
    assert K.chunk_bounds(8.0, K.silences(x, SR)) == [(0.0, 8.0)]


def test_pauses_are_found_over_phone_room_tone():
    x = _take([(1, 3), (4, 6)], 8.0)
    q = K.silences(x, SR)
    assert any(abs(a - 3.0) < 0.05 and abs(b - 4.0) < 0.05 for a, b in q), q


def test_long_take_is_cut_in_the_middle_of_pauses_and_tiles_the_take():
    spans = [(1, 4), (6, 12), (14, 19), (21, 27), (29, 35), (38, 44), (47, 52)]
    x = _take(spans, 55.0)
    pieces = K.chunk_bounds(55.0, K.silences(x, SR), 20.0)
    assert pieces[0][0] == 0.0 and pieces[-1][1] == 55.0
    assert all(b0 == a1 for (_, b0), (a1, _) in zip(pieces, pieces[1:])), "no gap, no overlap"
    assert all(b - a <= 20.0 for a, b in pieces), pieces
    for a, _ in pieces[1:]:
        assert not any(s <= a < e for s, e in spans), f"cut at {a} s falls inside a line"


def test_no_pause_long_enough_keeps_the_take_whole():
    x = _take([(0.2, 29.8)], 30.0)
    assert K.chunk_bounds(30.0, K.silences(x, SR), 20.0) == [(0.0, 30.0)]


def test_convert_in_pieces_keeps_every_sample_where_it_was():
    spans = [(1, 4), (6, 12), (14, 19), (21, 27), (29, 35), (38, 44), (47, 52)]
    x = _take(spans, 55.0)
    calls = []

    def identity_at_24k(seg, sr):     # a converter that changes the sample rate, like Chatterbox VC (16 k in, 24 k out)
        calls.append(len(seg) / sr)
        return np.repeat(seg, 3)[::2], sr * 3 // 2

    y, ysr, pieces = K.convert_in_pieces(x, SR, identity_at_24k, chunk_s=20.0)
    assert ysr == 24000 and len(y) == int(55.0 * 24000)
    assert len(calls) == len(pieces) > 1
    back = y[::3][: len(x) // 2]          # 24 k -> 8 k ≈ x[::2]
    ref = x[::2][: len(back)]
    lag = np.argmax(np.correlate(back[:40000], ref[:40000], "full")) - (40000 - 1)
    assert lag == 0, "the converted take is not shifted"


def test_convert_in_pieces_pads_a_short_converter_output():
    x = _take([(1, 3)], 5.0)
    y, ysr, _ = K.convert_in_pieces(x, SR, lambda seg, sr: (seg[: len(seg) - 500], sr))
    assert len(y) == len(x) and ysr == SR


def _cls(name):
    tree = ast.parse(open(os.path.join(ROOT, "soundstage", "nodes_audio.py")).read())
    return next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == name)


def test_chatterbox_vc_step_passes_a_silent_clip_and_takes_chunk_s():
    c = _cls("SoundstageChatterboxVC")
    ex = next(n for n in c.body if isinstance(n, ast.FunctionDef) and n.name == "execute")
    args = [a.arg for a in ex.args.args]
    assert args[:2] == ["cls", "audio"] and "chunk_s" in args and "voice_name" in args and "seed" in args
    src = ast.unparse(ex)
    assert "audio is None" in src, "a clip without sound must pass through (the capture graph links the clip's audio)"
    assert "chunk_s=" in src and "fit_length" in src, "converted in pieces, padded/trimmed to the performance length"


def test_voices_route_lists_names_not_paths():
    src = open(os.path.join(ROOT, "soundstage", "routes.py")).read()
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "saved_voices")
    assert '"/soundstage/voices"' in src
    sent = next(n for n in ast.walk(fn) if isinstance(n, ast.Dict) and any(getattr(k, "value", "") == "name" for k in n.keys))
    assert {k.value for k in sent.keys} == {"name", "character", "duration_s", "owner"}, "no file paths to the browser"


def test_pause_guard_removes_a_mumble_in_a_pause_and_keeps_the_lines():
    spans = [(1, 4), (15, 18)]
    x = _take(spans, 20.0)
    y = x.copy()
    t = np.arange(len(y)) / SR
    m = (t >= 9.0) & (t < 11.5)
    y[m] += 0.02 * np.sin(2 * np.pi * 200 * t[m]).astype(np.float32)   # -37 dBFS where the performer was silent
    g = K.guard_pauses(y, SR, x, SR, K.silences(x, SR))
    lvl = lambda a, b, z: 10 * np.log10(np.mean(z[int(a * SR):int(b * SR)] ** 2) + 1e-12)
    assert lvl(9.2, 11.3, g) < lvl(9.2, 11.3, x) + 6.5, "the mumble is down to the room"
    assert abs(lvl(1.2, 3.8, g) - lvl(1.2, 3.8, y)) < 0.01 and abs(lvl(15.2, 17.8, g) - lvl(15.2, 17.8, y)) < 0.01


def test_pause_guard_keeps_a_breath():
    x = _take([(1, 4), (6, 9)], 10.0)
    t = np.arange(len(x)) / SR
    rng = np.random.default_rng(3)
    br = (t >= 4.9) & (t < 5.35)
    x[br] += (rng.standard_normal(br.sum()) * 10 ** (-48 / 20)).astype(np.float32)   # a breath, 14 dB over the room
    y = x * 0.8
    g = K.guard_pauses(y, SR, x, SR, K.silences(x, SR))
    assert np.allclose(g[br], y[br])
