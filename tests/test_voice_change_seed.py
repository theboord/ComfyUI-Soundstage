"""Voice Change honours its seed: the Chatterbox VC step is seeded (Python, NumPy, torch) around the call, and the
seed is one of the step's inputs, so a new seed re-runs it instead of hitting ComfyUI's cache. No ComfyUI needed."""
import ast
import os
import random
import sys
import types

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.audio import tts  # noqa: E402


def _draw():
    return random.random(), float(np.random.rand())


def test_seeded_is_repeatable_and_seed_dependent():
    with tts.seeded(7):
        a = _draw()
    with tts.seeded(7):
        b = _draw()
    with tts.seeded(8):
        c = _draw()
    assert a == b
    assert a != c


def test_seeded_puts_the_rng_back():
    random.seed(123)
    np.random.seed(123)
    expect = _draw()
    random.seed(123)
    np.random.seed(123)
    with tts.seeded(99):
        _draw()
    assert _draw() == expect


def test_seeded_none_is_a_no_op():
    random.seed(5)
    expect = random.random()
    random.seed(5)
    with tts.seeded(None):
        pass
    assert random.random() == expect


def test_seeded_seeds_torch_and_restores_it(monkeypatch):
    calls = []
    fake = types.SimpleNamespace(
        get_rng_state=lambda: "cpu-state",
        set_rng_state=lambda s: calls.append(("set", s)),
        manual_seed=lambda s: calls.append(("seed", s)),
        cuda=types.SimpleNamespace(is_available=lambda: True, get_rng_state_all=lambda: ["gpu-state"],
                                   set_rng_state_all=lambda s: calls.append(("set_cuda", s))))
    monkeypatch.setitem(sys.modules, "torch", fake)
    with tts.seeded(2 ** 64 - 1):
        assert calls == [("seed", (2 ** 64 - 1) % (2 ** 63))]
    assert calls[1:] == [("set", "cpu-state"), ("set_cuda", ["gpu-state"])]


def _src(name):
    return ast.parse(open(os.path.join(ROOT, "soundstage", name)).read())


def _cls(tree, name):
    return next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == name)


def test_voice_change_passes_its_seed_into_the_chatterbox_step():
    tree = _src("nodes_audio.py")
    vc = _cls(tree, "SoundstageVoiceChange")
    calls = [n for n in ast.walk(vc) if isinstance(n, ast.Call) and n.args
             and isinstance(n.args[0], ast.Constant) and n.args[0].value == "SoundstageChatterboxVC"]
    assert len(calls) == 1
    assert "seed" in {k.arg for k in calls[0].keywords}, "the seed must be an input of the step (ComfyUI cache key)"


def test_chatterbox_step_declares_and_uses_the_seed():
    step = _cls(_src("nodes_audio.py"), "SoundstageChatterboxVC")
    inputs = [n for n in ast.walk(step) if isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant)
              and n.args[0].value == "seed"]
    assert inputs, "SoundstageChatterboxVC needs a seed input"
    execute = next(n for n in step.body if isinstance(n, ast.FunctionDef) and n.name == "execute")
    assert "seed" in [a.arg for a in execute.args.args]
    convert = [n for n in ast.walk(execute) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
               and n.func.attr == "convert"]
    assert convert and "seed" in {k.arg for k in convert[0].keywords}
