"""Hex swatches -> colour words a diffusion model understands (nearest named colour in CIELAB)."""
from __future__ import annotations

import re

# Cinematic colour names. Several shades per hue so the nearest match is already a good word.
NAMED = {
    "black": "#000000", "charcoal": "#2b2b2b", "graphite": "#4a4a4a", "slate grey": "#6c7a84", "silver grey": "#b9bab2",
    "off-white": "#efece4", "white": "#ffffff", "cream": "#f2e8cf", "bone": "#e3dac9", "beige": "#c9b79c",
    "sand": "#d6c095", "tan": "#b48a5a", "ochre": "#c98d2a", "mustard": "#c9a227", "gold": "#d4a72c",
    "honey amber": "#e0a040", "amber": "#ffb000", "sodium orange": "#f0a030", "tangerine": "#ff8a3d",
    "burnt orange": "#cc5500", "rust": "#b5582a", "terracotta": "#c4673f", "peach": "#f2b880", "salmon": "#f08a72",
    "coral": "#ff6f61", "brick red": "#8b2f1e", "crimson": "#c8102e", "blood red": "#8a0c14", "scarlet": "#ff2400",
    "oxblood": "#4a0a0e", "burgundy": "#6b1530", "wine": "#5a1a2a", "rose": "#e7849b", "blush pink": "#f6d6d6",
    "bubblegum pink": "#ff8fb8", "hot pink": "#ff2bd6", "magenta": "#d63a8a", "fuchsia": "#c02a9a",
    "violet": "#7b2cff", "purple": "#5a1a6b", "plum": "#4a2340", "lilac": "#b38bb8", "lavender": "#dbcdf0",
    "midnight navy": "#0f2142", "navy": "#1d2b3a", "cobalt blue": "#0033a0", "steel blue": "#5c7286",
    "powder blue": "#b0c8de", "sky blue": "#8fc3e8", "ice blue": "#dfe8ef", "electric cyan": "#00e5ff",
    "cyan": "#01cdfe", "deep teal": "#0f3d47", "teal": "#1f6f78", "sea green": "#7fb8b0", "mint": "#c9e4de",
    "jade": "#2f7a5a", "emerald": "#14804a", "forest green": "#14402a", "bottle green": "#0f2a17",
    "olive": "#5f6b3a", "olive drab": "#4b5320", "avocado": "#7d7a3a", "moss": "#5a6b3a", "sage": "#a3b59a",
    "acid lime": "#9be22d", "chartreuse": "#d4ff3a", "pale yellow": "#fff0b0", "butter yellow": "#f6e7c1",
    "lemon yellow": "#ffe600", "chocolate brown": "#4a2c18", "umber": "#5a3d22", "sepia": "#7a5a36",
    "mahogany": "#4a1c10",
}


def _hex_rgb(h: str) -> tuple[int, int, int] | None:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})", (h or "").strip())
    if not m:
        return None
    s = m.group(1)
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def _lab(rgb):
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


_NAMED_LAB = {name: _lab(_hex_rgb(h)) for name, h in NAMED.items()}


def is_hex(h: str) -> bool:
    return _hex_rgb(h) is not None


def color_name(h: str) -> str:
    rgb = _hex_rgb(h)
    if rgb is None:
        return ""
    lab = _lab(rgb)
    return min(_NAMED_LAB, key=lambda n: sum((a - b) ** 2 for a, b in zip(lab, _NAMED_LAB[n])))


def palette_words(swatches: list[str], limit: int = 5) -> list[str]:
    """Distinct colour names for a swatch list, in swatch order."""
    out: list[str] = []
    for h in swatches[:12]:
        n = color_name(h)
        if n and n not in out:
            out.append(n)
    return out[:limit]


def palette_phrase(swatches: list[str]) -> str:
    words = palette_words(swatches)
    if not words:
        return ""
    if len(words) == 1:
        return f"{words[0]} colour palette"
    return "colour palette of " + ", ".join(words[:-1]) + " and " + words[-1]
