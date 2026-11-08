"""Video → Stage, the sky: measure overcast vs clear from the source frames' own sky, and keep that apart from the time of
day the vision model guessed.

The street-dance test clip had a flat grey sky; the model said "morning", which mapped to the golden 6° sun preset and
painted the rebuild's sky orange. Now the sky's colour decides the weather (a grey, unsaturated sky is overcast, whatever
the hour), and the time words only pick the sun's height when the sky agrees (a "morning" under a neutral or blue sky is
not golden hour).
"""
from __future__ import annotations

import numpy as np

# The stage's background colour per sky phase (web/stage/stage.mjs, the `sky` map in the render loop) and the phase
# each time preset lands in (web/stage/lighting.mjs skyFor: overcast first, then by sun elevation). Kept in step with
# the JS by tests/test_v2s_dancer.py.
STAGE_SKY = {"night": 0x0b1020, "blue hour": 0x26324d, "dawn/dusk": 0x4a3a44, "magic hour": 0xd9a46a,
             "golden hour": 0xc9b89a, "overcast": 0xb9bec4, "daylight": 0x9cc3e6}
PRESET_PHASE = {"overcast": "overcast", "midday": "daylight", "golden_am": "magic hour", "magic_hour": "magic hour",
                "dawn": "blue hour", "blue_hour": "blue hour", "night": "night"}
WARM = ("golden_am", "magic_hour")


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
    return {"rgb": [int(round(v)) for v in rgb], "lab": [round(float(v), 2) for v in lab],
            "chroma": round(float(np.hypot(lab[1], lab[2])), 2), "lightness": round(float(lab[0]), 2), "pixels": int(len(P))}


def classify(sample: dict | None) -> str:
    """'overcast' | 'clear' | 'warm' | 'dark' | 'unknown' from a sky sample."""
    if not sample:
        return "unknown"
    L, a, b = sample["lab"]
    C = sample["chroma"]
    if L < 25:
        return "dark"
    if C < 12 and L >= 50:
        return "overcast"
    if b < -12 and b < -abs(a):
        return "clear"
    if b > 14 or a > 10:
        return "warm"
    return "unknown"


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
    if weather == "unknown" and by_time in WARM and sample is not None:
        notes.append(f"sky: a neutral sky does not read as golden hour; '{time_text}' lit as Midday")
        return "midday", weather, notes
    if weather == "warm" and by_time in ("midday", "overcast"):
        notes.append("sky: a warm low-sun sky; lit as Golden hour")
        return "magic_hour", weather, notes
    return by_time, weather, notes


def stage_sky_rgb(preset: str) -> list[int]:
    """The colour the stage paints behind a set lit with `preset`."""
    return hex_rgb(STAGE_SKY[PRESET_PHASE.get(preset, "daylight")])


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
