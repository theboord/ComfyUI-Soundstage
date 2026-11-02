"""The designed sounds of the V3 graphics (DESIGN_SYSTEM.md §13), synthesised with numpy: deterministic, no samples,
no model, nothing downloaded. Each recipe follows the spec's wording (a 1.5 ms click through a 2.5 kHz band-pass,
a 70 -> 48 Hz sub thump, a pink-noise band-pass sweep 600 Hz -> 3.5 kHz...). Files are 48 kHz 24-bit stereo WAV,
one event per file, peak-normalised to -1 dBFS; the clip gain on A2 sets the mix level (gfx.SFX).

Provenance: this file is the whole source. ensure_library() writes the pack once into
output/soundstage_sfx/gfx/ with a MANIFEST.json (recipe, seed, peak, length, sha256 of each file);
tests/test_cut_gfx.py checks levels, lengths and onset counts, and tools/qa/gfx_sfx_qc.py runs the AudioSet
classifier (Speech / Singing / Animal must stay under 0.3).

GET /soundstage/cut/gfx_sfx -> {library: {key: {filename, subfolder, type, seconds}}, version}
"""
from __future__ import annotations

import hashlib
import json
import math
import os

import numpy as np

from .mix import SR, write_wav24

SUB = "soundstage_sfx/gfx"
VERSION = 1
PANS = {"l": -0.4, "c": 0.0, "r": 0.4}


def _t(n):
    return np.arange(n, dtype=np.float64) / SR


def _bandpass(x, f0, q):
    """A resonant 2-pole band-pass (RBJ biquad, constant peak gain) at a fixed or per-sample f0."""
    f0 = np.broadcast_to(np.asarray(f0, dtype=np.float64), x.shape)
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        w = 2 * math.pi * min(f0[i], SR * 0.45) / SR
        alpha = math.sin(w) / (2 * q)
        a0 = 1 + alpha
        b0, b2 = alpha / a0, -alpha / a0
        a1, a2 = -2 * math.cos(w) / a0, (1 - alpha) / a0
        yi = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, x[i], y1, yi
        y[i] = yi
    return y


def _lowpass1(x, fc):
    a = math.exp(-2 * math.pi * fc / SR)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def _highpass1(x, fc):
    return x - _lowpass1(x, fc)


def _pink(rng, n):
    """Pink-ish noise (Paul Kellet's economy filter)."""
    w = rng.standard_normal(n)
    b0 = b1 = b2 = 0.0
    out = np.empty(n)
    for i in range(n):
        b0 = 0.99765 * b0 + w[i] * 0.0990460
        b1 = 0.96300 * b1 + w[i] * 0.2965164
        b2 = 0.57000 * b2 + w[i] * 1.0526913
        out[i] = b0 + b1 + b2 + w[i] * 0.1848
    return out / (np.std(out) + 1e-9)


def _env_ad(n, attack, decay):
    t = _t(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(0, t - attack) / decay)


def _room(x, pre_ms=12, level_db=-18, decay=0.18, seed=7):
    """A small room: a short noise-shaped tail convolved, `level_db` under the dry sound, after pre_ms."""
    rng = np.random.default_rng(seed)
    n = int(decay * 3 * SR)
    ir = rng.standard_normal(n) * np.exp(-_t(n) / decay)
    ir = _lowpass1(ir, 5000)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    wet = np.convolve(x, ir)[: len(x) + n]
    pre = int(pre_ms / 1000 * SR)
    out = np.zeros(len(x) + n + pre)
    out[: len(x)] += x
    out[pre: pre + len(wet)] += wet * 10 ** (level_db / 20) * (np.max(np.abs(x)) / (np.max(np.abs(wet)) + 1e-9))
    return out


def _detune(f, cents):
    return f * 2 ** (cents / 1200)


# ---------------------------------------------------------------------------------------------- recipes (mono)

def tick(variant=1, f0=2500.0):
    """SFX-01: a 1.5 ms click through a resonant band-pass (Q 6) with a quieter 4 kHz partial, 25 ms decay."""
    rng = np.random.default_rng(100 + variant)
    n = int(0.05 * SR)
    cents = {1: 0, 2: -40, 3: 40}.get(variant, 0)
    click = np.zeros(n)
    k = int(0.0015 * SR)
    click[:k] = rng.standard_normal(k) * np.hanning(k)
    body = _bandpass(click, _detune(f0, cents), 6) + 0.35 * _bandpass(click, _detune(4000, cents), 6)
    return body * np.exp(-_t(n) / 0.025)


def swap():
    """SFX-02: the outgoing tick at 2.8 kHz, the incoming at 3.2 kHz, 2 frames (83 ms) apart."""
    a, b = tick(1, 2800), tick(2, 3200)
    gap = int(2 / 24 * SR)
    out = np.zeros(gap + len(b))
    out[: len(a)] += a
    out[gap: gap + len(b)] += b
    return out


def thump():
    """SFX-03: a sine falling 70 -> 48 Hz over 120 ms, decaying over 280 ms, with a 6 ms noise transient
    high-passed at 1 kHz."""
    rng = np.random.default_rng(3)
    n = int(0.38 * SR)
    t = _t(n)
    f = 48 + 22 * np.exp(-t / 0.04)
    ph = 2 * math.pi * np.cumsum(f) / SR
    body = np.sin(ph) * _env_ad(n, 0.004, 0.28 / 2.5)
    k = int(0.006 * SR)
    tr = np.zeros(n)
    tr[:k] = _highpass1(rng.standard_normal(k), 1000) * np.hanning(k)
    return body + 0.22 * tr


def whoosh(semitones=0, seconds=14 / 24, reverse=False, seed=4):
    """SFX-04: pink noise through a band-pass sweeping 600 Hz -> 3.5 kHz (Q 1.2); the envelope peaks at f1-f3 and
    decays to the sync frame. reverse=True is SFX-05 (3 kHz -> 800 Hz, a rising envelope, 250 ms)."""
    rng = np.random.default_rng(seed + (semitones + 12) * 3 + (50 if reverse else 0))
    n = int(seconds * SR)
    u = np.linspace(0, 1, n)
    k = 2 ** (semitones / 12)
    if reverse:
        f = (3000 * (800 / 3000) ** u) * k
        env = np.sin(np.pi * 0.5 * u) ** 2 * (1 - np.clip((u - 0.92) / 0.08, 0, 1))
    else:
        f = (600 * (3500 / 600) ** np.sqrt(u)) * k
        peak = 2 / 24 / seconds
        env = np.where(u < peak, (u / peak) ** 1.5, np.exp(-(u - peak) / 0.28))
        env *= 1 - np.clip((u - 0.9) / 0.1, 0, 1)
    return _bandpass(_pink(rng, n), f, 1.2) * env


def riser(seconds=10 / 24):
    """SFX-06: 70 % a sine gliding exponentially 400 -> 1200 Hz, 30 % soft noise; it ends on the zoom's sync frame."""
    rng = np.random.default_rng(6)
    n = int(seconds * SR)
    u = np.linspace(0, 1, n)
    f = 400 * 3 ** u
    tone = np.sin(2 * math.pi * np.cumsum(f) / SR)
    noise = _bandpass(rng.standard_normal(n), f * 1.5, 1.5)
    noise /= np.max(np.abs(noise)) + 1e-9
    env = u ** 1.6 * (1 - np.clip((u - 0.96) / 0.04, 0, 1))
    return (0.7 * tone + 0.3 * noise) * env


def ping():
    """SFX-07: C7 (2093 Hz) plus G7 (3136 Hz) at -12 dB; 4 ms attack, 180 ms decay; a small room at -18 dB, 12 ms
    pre-delay."""
    n = int(0.23 * SR)
    t = _t(n)
    x = (np.sin(2 * math.pi * 2093 * t) + 0.25 * np.sin(2 * math.pi * 3136 * t)) * _env_ad(n, 0.004, 0.18 / 3)
    return _room(x, 12, -18, 0.08)[: int(0.25 * SR)]


def click():
    """SFX-08: two 1 ms transients 8 ms apart, band-limited to 2-6 kHz, dry."""
    rng = np.random.default_rng(8)
    n = int(0.025 * SR)
    x = np.zeros(n)
    k = int(0.001 * SR)
    for at, g in ((0, 1.0), (int(0.008 * SR), 0.7)):
        x[at: at + k] += rng.standard_normal(k) * np.hanning(k) * g
    return _bandpass(x, 3500, 0.9)


def air(seconds=14 / 24):
    """SFX-09: white noise through a band-pass moving 1.5 -> 6 -> 2 kHz, peaking at the divider's fastest frame."""
    rng = np.random.default_rng(9)
    n = int(seconds * SR)
    u = np.linspace(0, 1, n)
    peak = 0.3
    f = np.where(u < peak, 1500 * 4 ** (u / peak), 6000 * (2000 / 6000) ** ((u - peak) / (1 - peak)))
    env = np.where(u < peak, (u / peak) ** 1.2, np.exp(-(u - peak) / 0.3)) * (1 - np.clip((u - 0.92) / 0.08, 0, 1))
    return _bandpass(rng.standard_normal(n), f, 1.0) * env


def puff():
    """SFX-12: 60 ms of noise low-passed at 2 kHz, with a tiny 1.2 kHz tone at -12 dB."""
    rng = np.random.default_rng(12)
    n = int(0.075 * SR)
    t = _t(n)
    env = _env_ad(n, 0.006, 0.02)
    x = _lowpass1(_lowpass1(rng.standard_normal(n), 2000), 2000)
    x /= np.max(np.abs(x)) + 1e-9
    return (x + 0.25 * np.sin(2 * math.pi * 1200 * t)) * env


def logo_swell():
    """SFX-15: F major add9 (F, A, C, G) as a warm swell over 600 ms with a 2 s tail; slightly detuned pairs."""
    n = int(3.0 * SR)
    t = _t(n)
    notes = [174.61, 220.00, 261.63, 392.00, 349.23]   # F3 A3 C4 G4 F4
    x = np.zeros(n)
    for i, f in enumerate(notes):
        for c in (-4, 4):
            ff = _detune(f, c)
            x += (np.sin(2 * math.pi * ff * t + i) + 0.18 * np.sin(4 * math.pi * ff * t)) / (1 + 0.15 * i)
    env = np.clip(t / 0.6, 0, 1) ** 2 * np.exp(-np.maximum(0, t - 0.6) / 0.9)
    env *= 1 - np.clip((t - 2.85) / 0.15, 0, 1)
    return _room(_lowpass1(x * env, 3500), 20, -14, 0.5)[:n]


# ---------------------------------------------------------------------------------------------- the pack

def _stereo(x, pan, haas_ms=0.0):
    """Constant-power pan; mono-compatible (no Haas unless asked)."""
    th = (pan + 1) * math.pi / 4
    left, right = x * math.cos(th), x * math.sin(th)
    return np.stack([left, right], axis=1)


def _norm(x, peak_db=-1.0):
    pk = float(np.max(np.abs(x))) or 1.0
    return (x / pk * 10 ** (peak_db / 20)).astype(np.float32)


def recipes():
    """{key: (sfx id, mono maker, pans)}. key = stem[_variant] (+ _pan for panned sounds)."""
    return {
        "SFX-01_tick_1": ("SFX-01", lambda: tick(1), "c"), "SFX-01_tick_2": ("SFX-01", lambda: tick(2), "c"),
        "SFX-01_tick_3": ("SFX-01", lambda: tick(3), "c"),
        "SFX-01_tick_2_l": ("SFX-01", lambda: tick(2), "l"),
        "SFX-02_swap": ("SFX-02", swap, "c"), "SFX-03_thump": ("SFX-03", thump, "c"),
        **{f"SFX-04_whoosh_{p}": ("SFX-04", lambda: whoosh(0), p) for p in PANS},
        **{f"SFX-04_whoosh_up2_{p}": ("SFX-04", lambda: whoosh(2), p) for p in PANS},
        **{f"SFX-04_whoosh_down3_{p}": ("SFX-04", lambda: whoosh(-3), p) for p in PANS},
        **{f"SFX-05_whoosh_out_{p}": ("SFX-05", lambda: whoosh(0, 0.25, True), p) for p in PANS},
        "SFX-06_riser": ("SFX-06", riser, "c"),
        **{f"SFX-07_ping_{p}": ("SFX-07", ping, p) for p in PANS},
        **{f"SFX-08_click_{p}": ("SFX-08", click, p) for p in PANS},
        **{f"SFX-09_air_{p}": ("SFX-09", air, p) for p in PANS},
        **{f"SFX-12_puff_{p}": ("SFX-12", puff, p) for p in PANS},
        "SFX-15_logo_swell": ("SFX-15", logo_swell, "c"),
    }


def synth(key: str) -> np.ndarray:
    sid, make, pan = recipes()[key]
    return _norm(_stereo(make(), PANS[pan]))


def file_key(cue: dict, library: dict) -> str | None:
    """The library key for a cue {sfx, variant, pan}: the panned file, else the centred one, else the plain one."""
    from .gfx import SFX
    stem = f"{cue['sfx']}_{SFX[cue['sfx']][0]}" + (f"_{cue['variant']}" if cue.get("variant") else "")
    for k in (f"{stem}_{cue.get('pan', 'c')}", f"{stem}_c", stem):
        if k in library:
            return k
    return None


def ensure_library(out_dir: str) -> dict:
    """Write any missing pack files (once) plus MANIFEST.json; list them by key."""
    d = os.path.join(out_dir, SUB)
    os.makedirs(d, exist_ok=True)
    man_path = os.path.join(d, "MANIFEST.json")
    try:
        man = json.load(open(man_path))
    except (OSError, ValueError):
        man = {}
    if man.get("version") != VERSION:
        man = {"version": VERSION, "files": {}}
    lib, changed = {}, False
    for key, (sid, make, pan) in recipes().items():
        fn = f"{key}.wav"
        p = os.path.join(d, fn)
        ent = man["files"].get(fn)
        if not os.path.isfile(p) or not ent:
            x = synth(key)
            write_wav24(p + ".part", x)
            os.replace(p + ".part", p)
            ent = {"sfx": sid, "recipe": f"soundstage/cut/gfx_sfx.py recipes()[{key!r}]",
                   "pan": PANS[pan], "seconds": round(len(x) / SR, 4), "peak_dbfs": round(20 * math.log10(float(np.max(np.abs(x))) + 1e-12), 2),
                   "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "licence": "generated by Soundstage (MIT), no samples"}
            man["files"][fn] = ent
            changed = True
        lib[key] = {"filename": fn, "subfolder": SUB, "type": "output", "seconds": ent["seconds"], "sfx": sid}
    if changed:
        with open(man_path + ".part", "w") as fh:
            json.dump(man, fh, indent=1)
        os.replace(man_path + ".part", man_path)
    return lib


def add_routes(routes) -> None:
    from aiohttp import web

    @routes.get("/soundstage/cut/gfx_sfx")
    async def gfx_library(request):
        try:
            import asyncio

            import folder_paths
            lib = await asyncio.to_thread(ensure_library, folder_paths.get_output_directory())
            return web.json_response({"library": lib, "version": VERSION})
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"error": str(exc)}, status=400)
