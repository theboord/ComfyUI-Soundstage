"""Film Finish (Milestone 21): "film" the render in comp so it stops reading as CG.

Real lenses never draw perfectly straight lines, edges fringe, highlights bloom red into the emulsion (halation), the
corners fall off and grain sits over everything, last. One stock-ffmpeg filter graph, applied in order:

  1. lens distortion (a slight barrel: lenscorrection)
  2. chromatic aberration (red pushed out, blue pulled in, toward the edges: per-channel scale + crop)
  3. halation (highlights only -> wide blur -> warm red -> screen over the picture)
  4. vignette
  5. grain (temporal noise, a fresh pattern every frame, seeded)
  6. optional motion blur (a 2-frame shutter mix)

Presets: off · subtle · 35mm · anamorphic. Used by the Cut render (spec.finish) and the SoundstageFilmFinish node.
"""
from __future__ import annotations

import subprocess

import numpy as np

PRESETS = {
    "off": None,
    "subtle": {"k1": -0.012, "k2": -0.003, "ca": 0.0012, "hal": 0.28, "hal_thr": 0.82, "hal_r": 0.012, "vig": 0.35, "grain": 5, "blur": False},
    "35mm": {"k1": -0.022, "k2": -0.006, "ca": 0.0022, "hal": 0.5, "hal_thr": 0.75, "hal_r": 0.016, "vig": 0.55, "grain": 11, "blur": False},
    "anamorphic": {"k1": -0.035, "k2": -0.008, "ca": 0.003, "hal": 0.55, "hal_thr": 0.72, "hal_r": 0.02, "vig": 0.6, "grain": 9,
                   "blur": False, "streak": True},
}
LABELS = {"off": "Off", "subtle": "Subtle", "35mm": "35mm", "anamorphic": "Anamorphic"}


def _even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def finish_graph(inp: str, out: str, preset: str, w: int, h: int, seed: int = 1, motion_blur: bool | None = None,
                 tag: str = "ff") -> list[str]:
    """Filter-graph strings taking [inp] to [out] (a plain copy for 'off'). w, h: the stream's size (kept exactly)."""
    P = PRESETS.get(preset or "off")
    if not P:
        return [f"{inp}null{out}"]
    t = tag
    f: list[str] = []
    # 1. barrel distortion; the black corners it opens are hidden by the vignette and a 1% overscan.
    f.append(f"{inp}format=gbrp,lenscorrection=k1={P['k1']}:k2={P['k2']}:i=bilinear,"
             f"scale={_even(w * 1.012)}:{_even(h * 1.012)}:flags=bicubic,crop={w}:{h},split=3[{t}r][{t}g][{t}b]")
    # 2. chromatic aberration: each channel scaled about the centre (red most), cropped back.
    ca = P["ca"]
    for ch, k, keep in (("r", 2 * ca, "g=0:b=0"), ("g", ca, "r=0:b=0"), ("b", 0.0, "r=0:g=0")):
        sw, sh = _even(w * (1 + k)), _even(h * (1 + k))
        f.append(f"[{t}{ch}]lutrgb={keep},scale={sw}:{sh}:flags=bicubic,crop={w}:{h}[{t}{ch}2]")
    f.append(f"[{t}r2][{t}g2]blend=all_mode=addition[{t}rg]")
    f.append(f"[{t}rg][{t}b2]blend=all_mode=addition,split[{t}c][{t}h]")
    # 3. halation: highlights over a threshold, blurred wide, tinted red-orange, screened back.
    thr = P["hal_thr"]
    sig = max(2.0, P["hal_r"] * w)
    sigv = sig * (0.45 if P.get("streak") else 1.0)
    lut = f"'clip((val-{int(thr * 255)})*{1 / (1 - thr):.3f},0,255)'"
    f.append(f"[{t}h]lutrgb=r={lut}:g={lut}:b={lut},gblur=sigma={sig:.1f}:sigmaV={sigv:.1f},"
             f"colorchannelmixer=rr=1:gg=0.38:bb=0.16[{t}hl]")
    f.append(f"[{t}c][{t}hl]blend=all_mode=screen:all_opacity={P['hal']}[{t}hb]")
    # 4. vignette, 5. grain (temporal, seeded), 6. optional 2-frame shutter mix.
    blur = P["blur"] if motion_blur is None else motion_blur
    chain = [f"vignette=angle={0.25 + 0.5 * P['vig']:.3f}:mode=forward",
             f"format=yuv444p,noise=c0s={P['grain']}:c0f=t+u:c1s={max(1, P['grain'] // 3)}:c1f=t+u:c2s={max(1, P['grain'] // 3)}:c2f=t+u:all_seed={int(seed) % 2147483647}"]
    if blur:
        chain.append("tmix=frames=2:weights='1 1'")
    f.append(f"[{t}hb]" + ",".join(chain) + out)
    return f


def finish_frames(frames: np.ndarray, preset: str, seed: int = 1, motion_blur: bool | None = None, fps: float = 24.0) -> np.ndarray:
    """Apply the finish to an [N, H, W, 3] uint8 array through ffmpeg (raw pipes), same size and count."""
    if not PRESETS.get(preset or "off") and not motion_blur:
        return frames
    from .cut.render import _exe
    n, h, w, _ = frames.shape
    graph = ";".join(finish_graph("[0:v]", "[v]", preset if PRESETS.get(preset) else "subtle", w, h, seed, motion_blur))
    cmd = [_exe("ffmpeg"), "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
           "-filter_complex", graph, "-map", "[v]", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    r = subprocess.run(cmd, input=np.ascontiguousarray(frames, dtype=np.uint8).tobytes(), capture_output=True, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"film finish failed: {r.stderr.decode(errors='replace')[-600:]}")
    out = np.frombuffer(r.stdout, dtype=np.uint8)
    m = out.size // (h * w * 3)
    out = out[: m * h * w * 3].reshape(m, h, w, 3)
    if m < n:   # tmix can drop nothing, but be safe: pad with the last frame
        out = np.concatenate([out, np.repeat(out[-1:], n - m, axis=0)])
    return out[:n]
