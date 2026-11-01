"""Impact sounds on A2 (Milestone 21): one cue per baked hit, picked by material, gain by impulse.

The library is synthesised once (numpy, no model, no download) and cached in the output folder
(output/soundstage/impact_sfx/<material>_<n>.wav, 48 kHz 24-bit stereo). Each cue is layered the way sound designers
build a hit: a low body thump (weight), a short transient crack (the material), then the material's tail (splinters,
crumple, ring, grit). Every file starts on its transient, so a cue placed on a frame lands exactly on the hit
(synchresis: sound and image fuse when they land together).

GET /soundstage/cut/impact_sfx  -> {"library": {material: [{"filename", "subfolder", "type", "seconds"}...]}}
POST /soundstage/cut/impact_sfx {events} -> {library, cues: [{frame, material, gain_db, variant, impulse}]}
"""
from __future__ import annotations

import math
import os

import numpy as np

from .mix import SR, write_wav24

MATERIALS = ["wood", "cardboard", "metal", "stone", "glass", "plastic", "rubber"]
VARIANTS = 3
SUB = "soundstage/impact_sfx"
HARD = {"metal", "stone", "concrete", "ground", "glass"}


def _env(n, tau, attack=0.0015):
    t = np.arange(n) / SR
    a = np.minimum(1.0, t / max(1e-4, attack))
    return a * np.exp(-t / tau)


def _bandnoise(rng, n, lo, hi):
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    y = np.fft.irfft(X, n)
    return y / (np.max(np.abs(y)) + 1e-9)


def _thump(n, f0, f1, tau):
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.03)        # pitch drops fast (a body hitting, not a drum)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * _env(n, tau, 0.002)


def _clicks(rng, n, count, span, lo, hi, tau=0.008, start=0.01):
    out = np.zeros(n)
    for _ in range(count):
        at = int((start + rng.random() ** 1.6 * span) * SR)
        m = int(0.05 * SR)
        if at + m >= n:
            continue
        out[at:at + m] += _bandnoise(rng, m, lo, hi) * _env(m, tau * (0.5 + rng.random())) * (0.3 + 0.7 * rng.random())
    return out


def synth(material: str, variant: int = 0) -> np.ndarray:
    """One impact, [samples, 2] float in -1..1, transient at sample 0."""
    rng = np.random.default_rng(1000 + MATERIALS.index(material) * 17 + variant)
    v = 1 + 0.08 * (variant - 1)
    if material == "wood":
        n = int(0.9 * SR)
        x = 0.9 * _thump(n, 140 * v, 62 * v, 0.11) + 0.75 * _bandnoise(rng, n, 1400, 5200) * _env(n, 0.018)
        x += 0.45 * _bandnoise(rng, n, 300, 1200) * _env(n, 0.06)
        x += 0.55 * _clicks(rng, n, 14, 0.35, 1800, 7000)            # splinters, boards springing loose
    elif material == "cardboard":
        n = int(0.8 * SR)
        x = 0.85 * _thump(n, 120 * v, 70 * v, 0.07) + 0.4 * _bandnoise(rng, n, 400, 2400) * _env(n, 0.03)
        x += 0.5 * _clicks(rng, n, 30, 0.45, 900, 4500, tau=0.012)   # crumple and tear
    elif material == "metal":
        n = int(1.6 * SR)
        t = np.arange(n) / SR
        partials = [(380, 0.9), (1043, 1.1), (1987, 0.7), (3120, 0.45), (4410, 0.35)]
        ring = sum(a * np.sin(2 * np.pi * f * v * t + rng.random() * 6) * _env(n, 0.55 / (1 + i * 0.6)) for i, (f, a) in enumerate(partials))
        x = 0.8 * _thump(n, 110 * v, 55 * v, 0.12) + 0.28 * ring / 3 + 0.7 * _bandnoise(rng, n, 2000, 9000) * _env(n, 0.03)
    elif material in ("stone", "concrete"):
        n = int(0.8 * SR)
        x = 0.95 * _thump(n, 120 * v, 48 * v, 0.1) + 0.6 * _bandnoise(rng, n, 800, 6000) * _env(n, 0.025)
        x += 0.4 * _clicks(rng, n, 22, 0.5, 2500, 9000, tau=0.006)   # grit settling
    elif material == "glass":
        n = int(1.4 * SR)
        x = 0.5 * _thump(n, 160 * v, 90 * v, 0.05) + 0.6 * _bandnoise(rng, n, 3000, 12000) * _env(n, 0.04)
        t = np.arange(n) / SR
        for _ in range(26):                                          # shards tinkling down
            at = rng.random() ** 1.3 * 0.9
            f = 3500 + rng.random() * 6000
            seg = np.where(t >= at, np.sin(2 * np.pi * f * (t - at)) * np.exp(-np.maximum(0, t - at) / 0.035), 0)
            x += 0.18 * (0.4 + rng.random()) * seg
    elif material == "plastic":
        n = int(0.6 * SR)
        x = 0.7 * _thump(n, 200 * v, 110 * v, 0.05) + 0.55 * _bandnoise(rng, n, 1200, 6000) * _env(n, 0.02)
    else:   # rubber
        n = int(0.5 * SR)
        x = 0.9 * _thump(n, 180 * v, 90 * v, 0.06)
    # A short room tail, then stereo with a hair of width (decorrelated right channel).
    tail = _bandnoise(rng, n, 150, 3000) * _env(n, 0.18) * 0.06
    x = x + tail
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.89
    d = int(0.0007 * SR)
    r = np.concatenate([np.zeros(d), x[:-d]]) * 0.92 + x * 0.08
    return np.stack([x, r], axis=1).astype(np.float32)


def ensure_library(out_dir: str) -> dict:
    """Write any missing library files (once) and list them by material."""
    d = os.path.join(out_dir, SUB)
    os.makedirs(d, exist_ok=True)
    lib: dict[str, list[dict]] = {}
    for m in MATERIALS:
        for k in range(VARIANTS):
            fn = f"{m}_{k + 1}.wav"
            p = os.path.join(d, fn)
            if not os.path.isfile(p):
                x = synth(m, k)
                write_wav24(p + ".part", x)
                os.replace(p + ".part", p)
                secs = len(x) / SR
            else:
                secs = round((os.path.getsize(p) - 44) / (SR * 6), 3)
            lib.setdefault(m, []).append({"filename": fn, "subfolder": SUB, "type": "output", "seconds": round(secs, 3)})
    return lib


def sound_material(ev: dict) -> str:
    """Which library a hit plays: metal on anything hard rings as metal; otherwise the softer, louder-breaking side
    (a car into a wooden crate sounds like the crate splintering; a crate landing sounds like the crate)."""
    a, b = ev.get("mat_a") or "wood", ev.get("mat_b") or "wood"
    if "metal" in (a, b) and (a in HARD and b in HARD):
        return "metal"
    for m in ("glass", "cardboard", "wood", "plastic", "rubber", "stone"):
        if m in (a, b):
            return m
    return "metal" if "metal" in (a, b) else "stone"


def gain_for(impulse: float) -> float:
    """dB for a hit: 0 dB at a ~360 N·s car hit, about -18 dB for a 40 N·s knock."""
    return round(max(-24.0, min(2.0, 20 * math.log10(max(1e-3, float(impulse) / 360.0)) * 0.95)), 1)


def cue_list(events: list[dict], *, gap_frames: int = 3, max_cues: int = 16, min_impulse: float = 35.0) -> list[dict]:
    """One cue per hit (hits within gap_frames are one cue, the strongest), the max_cues strongest, in time order:
    [{frame, material, gain_db, variant, impulse}]."""
    evs = sorted((e for e in events or [] if float(e.get("impulse") or 0) >= min_impulse), key=lambda e: -float(e["impulse"]))
    chosen: list[dict] = []
    for e in evs:
        if any(abs(int(e["frame"]) - int(c["frame"])) <= gap_frames for c in chosen):
            continue
        chosen.append(e)
        if len(chosen) >= max_cues:
            break
    out = []
    for i, e in enumerate(sorted(chosen, key=lambda x: int(x["frame"]))):
        out.append({"frame": int(e["frame"]), "material": sound_material(e), "gain_db": gain_for(e["impulse"]),
                    "variant": (int(e["frame"]) * 7 + i) % VARIANTS, "impulse": float(e["impulse"])})
    return out


def add_routes(routes) -> None:
    from aiohttp import web

    @routes.get("/soundstage/cut/impact_sfx")
    async def impact_library(request):
        try:
            import asyncio

            import folder_paths
            lib = await asyncio.to_thread(ensure_library, folder_paths.get_output_directory())
            return web.json_response({"library": lib, "variants": VARIANTS})
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/soundstage/cut/impact_sfx")
    async def impact_cues(request):
        """{events} (scene.physics.events) -> {library, cues: [{frame, material, gain_db, variant, impulse}]}."""
        try:
            import asyncio

            import folder_paths
            body = await request.json()
            lib = await asyncio.to_thread(ensure_library, folder_paths.get_output_directory())
            return web.json_response({"library": lib, "cues": cue_list(body.get("events") or [])})
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"error": str(exc)}, status=400)
