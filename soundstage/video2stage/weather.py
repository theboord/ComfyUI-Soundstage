"""Video → Stage, the sky: measure overcast vs clear from the source frames' own sky, and keep that apart from the time of
day the vision model guessed.

The street-dance test clip had a flat grey sky; the model said "morning", which mapped to the golden 6° sun preset and
painted the rebuild's sky orange. Now the sky's colour decides the weather (a grey, unsaturated sky is overcast, whatever
the hour), and the time words only pick the sun's height when the sky agrees (a "morning" under a neutral or blue sky is
not golden hour).
"""
from __future__ import annotations

import numpy as np

# The stage's background colour per sky phase (web/stage/lighting.mjs SKY_COLORS) and the phase
# each time preset lands in (web/stage/lighting.mjs skyFor: overcast first, then by sun elevation). Kept in step with
# the JS by tests/test_v2s_dancer.py.
STAGE_SKY = {"night": 0x0b1020, "blue hour": 0x26324d, "dawn/dusk": 0x4a3a44, "magic hour": 0xd9a46a,
             "golden hour": 0xc9b89a, "overcast": 0xb9bec4, "daylight": 0x9cc3e6}
PRESET_PHASE = {"overcast": "overcast", "midday": "daylight", "golden_am": "magic hour", "magic_hour": "magic hour",
                "dawn": "blue hour", "blue_hour": "blue hour", "night": "night"}
WARM = ("golden_am", "magic_hour")
CLIPPED = 248          # every channel at or above this: a clipped (blown-out) sky pixel
EXPOSED = 240          # every channel below this: a sky pixel that still carries its colour


def srgb_to_lab(rgb) -> np.ndarray:
    """sRGB 0-255 (..., 3) -> CIE L*a*b* (D65)."""
    c = np.asarray(rgb, np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def delta_e(a_rgb, b_rgb) -> float:
    """CIE76 colour difference of two sRGB colours (under ~10 reads as a close match)."""
    return float(np.linalg.norm(srgb_to_lab(a_rgb) - srgb_to_lab(b_rgb)))


def hex_rgb(h) -> list[int]:
    if isinstance(h, int):
        return [(h >> 16) & 255, (h >> 8) & 255, h & 255]
    s = str(h).lstrip("#")
    return [int(s[i:i + 2], 16) for i in (0, 2, 4)]


def _resize_mask(m: np.ndarray, hw) -> np.ndarray:
    m = np.asarray(m)
    if m.shape[:2] == tuple(hw):
        return m > 0.5
    ys = np.minimum((np.arange(hw[0]) + 0.5) * m.shape[0] / hw[0], m.shape[0] - 1).astype(int)
    xs = np.minimum((np.arange(hw[1]) + 0.5) * m.shape[1] / hw[1], m.shape[1] - 1).astype(int)
    return m[ys][:, xs] > 0.5


def sky_sample(images, skies=None, top_share: float = 0.12) -> dict | None:
    """Median sky colour over the frames: the sky mask's pixels when there is a mask (DA3's), else the top 12 % of the
    picture. Returns {rgb, lab, chroma, lightness, pixels} or None without any sky."""
    px = []
    for i, img in enumerate(images or []):
        if img is None:
            continue
        img = np.asarray(img)
        h, w = img.shape[:2]
        m = None if skies is None or i >= len(skies) or skies[i] is None else _resize_mask(skies[i], (h, w))
        if m is not None:
            if m.mean() < 0.01:
                continue
            sel = img[m]
        else:
            sel = img[: max(1, int(h * top_share))].reshape(-1, img.shape[-1])
        if len(sel) > 20000:
            sel = sel[:: len(sel) // 20000]
        px.append(sel[:, :3])
    if not px:
        return None
    P = np.concatenate(px)
    rgb = np.median(P, 0)
    lab = srgb_to_lab(rgb)
    out = {"rgb": [int(round(v)) for v in rgb], "lab": [round(float(v), 2) for v in lab],
           "chroma": round(float(np.hypot(lab[1], lab[2])), 2), "lightness": round(float(lab[0]), 2), "pixels": int(len(P))}
    # A blown-out sky: the clipped pixels say nothing about the weather (white is white, clear or grey). What is left
    # unclipped (the sky's fringe near the horizon or the trees) is what the classifier reads instead.
    clipped = P[:, :3].min(1) >= CLIPPED
    out["clipped"] = round(float(clipped.mean()), 3)
    rest = P[P[:, :3].max(1) < EXPOSED][:, :3]   # the sky's fringe that is really exposed (near-white says nothing either)
    if out["clipped"] >= 0.5 and len(rest) >= max(50, 0.03 * len(P)):
        rl = srgb_to_lab(np.median(rest, 0))
        out["rest"] = {"rgb": [int(round(v)) for v in np.median(rest, 0)], "lab": [round(float(v), 2) for v in rl],
                       "chroma": round(float(np.hypot(rl[1], rl[2])), 2), "pixels": int(len(rest))}
    return out


def _classify_lab(L: float, a: float, b: float, C: float) -> str:
    # Saturation, not brightness, says grey: chroma relative to lightness, so a dim grey sky (L 40, C 4) is as grey as
    # a bright one (L 76, C 3). A blue sky keeps a strong -b at any brightness; a warm one +b or +a.
    sat = C / max(L, 1.0)
    if L < 25:
        return "dark"
    if b < -12 and b < -abs(a) and sat >= 0.15:
        return "clear"
    if (b > 14 or a > 10) and sat >= 0.15:
        return "warm"
    if C < 12 and sat < 0.25:
        return "overcast"
    return "unknown"


def classify(sample: dict | None) -> str:
    """'overcast' | 'clear' | 'warm' | 'dark' | 'blown out' | 'unknown' from a sky sample. A sky that is mostly clipped
    white is read from its unclipped fringe; with no fringe it is 'blown out' (not overcast: a clipped clear sky is
    white too)."""
    if not sample:
        return "unknown"
    if sample.get("clipped", 0) >= 0.5:
        r = sample.get("rest")
        if not r:
            return "blown out"
        return _classify_lab(*r["lab"], r["chroma"])
    L, a, b = sample["lab"]
    return _classify_lab(L, a, b, sample["chroma"])


def preset_for(time_text: str, sample: dict | None, time_preset) -> tuple[str, str, list[str]]:
    """(lighting preset, weather word, notes). time_preset: convert.time_preset (the old word map)."""
    notes = []
    by_time = time_preset(time_text or "")
    weather = classify(sample)
    if weather == "overcast":
        if by_time != "overcast":
            notes.append(f"sky: measured overcast (a grey sky, chroma {sample['chroma']:.0f}); lit as Overcast, not "
                         f"'{time_text or 'day'}' sun")
        return "overcast", weather, notes
    if weather == "clear" and by_time in WARM:
        notes.append(f"sky: a clear blue sky, not a golden one; '{time_text}' lit as Midday")
        return "midday", weather, notes
    if weather == "blown out":
        notes.append("sky: blown out (clipped white), the weather can't be read from it; lit from the time words")
    if weather in ("unknown", "blown out") and by_time in WARM and sample is not None:
        notes.append(f"sky: a neutral sky does not read as golden hour; '{time_text}' lit as Midday")
        return "midday", weather, notes
    if weather == "warm" and by_time in ("midday", "overcast"):
        notes.append("sky: a warm low-sun sky; lit as Golden hour")
        return "magic_hour", weather, notes
    return by_time, weather, notes


def stage_sky_rgb(preset: str) -> list[int]:
    """The colour the stage paints behind a set lit with `preset` when no measured sky colour is carried."""
    return hex_rgb(STAGE_SKY[PRESET_PHASE.get(preset, "daylight")])


# A measured sky colour is carried into the rebuild (scene.lighting.sky_color) when the read agrees with the preset's
# sky: an overcast read under the Overcast preset, a clear one under Midday, and so on. The stage paints it instead of
# the preset's fixed colour while the preset is unchanged (web/stage/lighting.mjs skyBackground).
TINT_FOR = {"overcast": ("overcast",), "clear": ("midday",), "warm": WARM, "dark": ("night", "blue_hour", "dawn")}


def sky_tint(sample: dict | None, weather: str, preset: str) -> dict | None:
    """{hex, preset} to carry into scene.lighting.sky_color, or None (no sample, a blown-out or unreadable sky, or a
    preset the read does not agree with)."""
    if not sample or preset not in TINT_FOR.get(weather, ()):
        return None
    r, g, b = (sample.get("rest") or sample)["rgb"] if weather != "blown out" else sample["rgb"]
    return {"hex": "#%02x%02x%02x" % (int(r), int(g), int(b)), "preset": preset}


def painted_sky_rgb(lighting: dict) -> list[int]:
    """What the stage paints behind the set for this lighting (mirrors lighting.mjs skyBackground)."""
    t = (lighting or {}).get("sky_color") or {}
    if t.get("hex") and t.get("preset") and t.get("preset") == (lighting or {}).get("preset"):
        return hex_rgb(t["hex"])
    return stage_sky_rgb((lighting or {}).get("preset") or "midday")


def sample_from_ctx(ctx: dict, k: int = 6) -> dict | None:
    """The sky sample of a pipeline context: its DA3 samples' frames and sky masks (at most k frames)."""
    frames = ctx.get("all_frames") or []
    sky = ctx.get("sky") or {}
    fs = sorted(int(f) for f in (ctx.get("samples") or sky.keys()))
    if len(fs) > k:
        fs = [fs[int(round(i * (len(fs) - 1) / (k - 1)))] for i in range(k)]
    imgs, masks = [], []
    for f in fs:
        path = frames[f] if isinstance(frames, list) and 0 <= f < len(frames) else (frames.get(f) if isinstance(frames, dict) else None)
        if not path:
            continue
        imgs.append(load_rgb(path))
        masks.append(sky.get(f, sky.get(str(f))))
    return sky_sample(imgs, masks)


def load_rgb(path: str):
    try:
        import cv2
        im = cv2.imread(path, cv2.IMREAD_COLOR)
        return None if im is None else im[..., ::-1]
    except Exception:  # noqa: BLE001
        return None
