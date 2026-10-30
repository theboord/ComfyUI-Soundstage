"""A small, dependency-free OpenEXR writer (scanline, ZIP compression).

Written by hand so the pack never depends on the OpenEXR wheel being installed on the pod.
Channels are named the Nuke way ("R", "G", "B", "A", "char_01.R", "depth.Z") and written as
half (float16) or float (float32). The tests read every file back with the official OpenEXR
library to prove the format.
"""
from __future__ import annotations

import struct
import zlib

import numpy as np

HALF, FLOAT = 1, 2
_ZIP, _LINES_PER_BLOCK = 3, 16


def _attr(name: str, type_: str, value: bytes) -> bytes:
    return name.encode() + b"\0" + type_.encode() + b"\0" + struct.pack("<i", len(value)) + value


def _box(w: int, h: int) -> bytes:
    return struct.pack("<iiii", 0, 0, w - 1, h - 1)


def _zip(raw: bytes) -> bytes:
    a = np.frombuffer(raw, dtype=np.uint8)
    t = np.concatenate([a[0::2], a[1::2]])           # interleave split, as OpenEXR does
    d = t.copy()
    d[1:] = ((t[1:].astype(np.int16) - t[:-1].astype(np.int16) + 128) & 0xFF).astype(np.uint8)  # predictor
    packed = zlib.compress(d.tobytes(), 6)
    return packed if len(packed) < len(raw) else raw  # same size = stored raw, per the spec


def write_exr(path: str, channels: dict[str, np.ndarray], *, pixel_type: dict[str, int] | None = None,
              attrs: dict[str, str] | None = None, fps: float | None = None) -> None:
    """channels: name -> HxW array. Half unless pixel_type says FLOAT (Z and ids should be FLOAT)."""
    names = sorted(channels)                          # EXR wants channels in sorted order
    h, w = next(iter(channels.values())).shape[:2]
    ptype = {n: (pixel_type or {}).get(n, FLOAT if n.split(".")[-1] == "Z" else HALF) for n in names}
    chlist = b"".join(n.encode() + b"\0" + struct.pack("<iB3xii", ptype[n], 0, 1, 1) for n in names) + b"\0"
    header = b"".join([
        _attr("channels", "chlist", chlist),
        _attr("compression", "compression", bytes([_ZIP])),
        _attr("dataWindow", "box2i", _box(w, h)),
        _attr("displayWindow", "box2i", _box(w, h)),
        _attr("lineOrder", "lineOrder", bytes([0])),
        _attr("pixelAspectRatio", "float", struct.pack("<f", 1.0)),
        _attr("screenWindowCenter", "v2f", struct.pack("<ff", 0.0, 0.0)),
        _attr("screenWindowWidth", "float", struct.pack("<f", 1.0)),
    ])
    if fps:
        num, den = (int(round(fps * 1000)), 1000) if abs(fps - round(fps)) > 1e-6 else (int(round(fps)), 1)
        header += _attr("framesPerSecond", "rational", struct.pack("<iI", num, den))
    for k, v in (attrs or {}).items():
        header += _attr(k, "string", str(v).encode())
    header += b"\0"

    planes = {n: np.ascontiguousarray(channels[n], dtype="<f2" if ptype[n] == HALF else "<f4") for n in names}
    chunks = []
    for y0 in range(0, h, _LINES_PER_BLOCK):
        y1 = min(y0 + _LINES_PER_BLOCK, h)
        raw = b"".join(planes[n][y].tobytes() for y in range(y0, y1) for n in names)
        data = _zip(raw)
        chunks.append(struct.pack("<ii", y0, len(data)) + data)

    magic = struct.pack("<ii", 20000630, 2)
    offset = len(magic) + len(header) + 8 * len(chunks)
    table = []
    for c in chunks:
        table.append(struct.pack("<Q", offset))
        offset += len(c)
    with open(path, "wb") as f:
        f.write(magic + header + b"".join(table) + b"".join(chunks))


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)
