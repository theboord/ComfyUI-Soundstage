"""Layered Photoshop file of one hero frame.

Written by hand (8-bit RGB, one raw RGBA pixel layer per pack layer with its name and blend
mode, plus the flattened composite), so it needs nothing but numpy.
Photoshop layers are not time-based, so this is one frame only.
"""
from __future__ import annotations

import struct

import numpy as np

_BLEND_KEYS = {"normal": b"norm", "multiply": b"mul ", "screen": b"scrn", "add": b"lddg"}


def _pascal(name: str) -> bytes:
    b = name.encode("latin-1", "replace")[:255]
    s = bytes([len(b)]) + b
    return s + b"\0" * ((4 - len(s) % 4) % 4)


def _unicode_name(name: str) -> bytes:
    """'luni' tagged block so Photoshop shows non-Latin names correctly."""
    u = name.encode("utf-16-be")
    data = struct.pack(">I", len(name)) + u
    data += b"\0" * ((4 - len(data) % 4) % 4)
    return b"8BIM" + b"luni" + struct.pack(">I", len(data)) + data


def _write_raw(path: str, layers: list[dict], composite: np.ndarray) -> None:
    h, w = composite.shape[:2]
    records, pixel_data = b"", b""
    for L in layers:  # bottom first, which is PSD order
        rgba = L["rgba"]
        chans = [(-1, rgba[..., 3]), (0, rgba[..., 0]), (1, rgba[..., 1]), (2, rgba[..., 2])]
        rec = struct.pack(">iiiiH", 0, 0, h, w, len(chans))
        for cid, _ in chans:
            rec += struct.pack(">hI", cid, 2 + w * h)
        rec += b"8BIM" + _BLEND_KEYS.get(L.get("blend_mode", "normal"), b"norm")
        rec += struct.pack(">BBBB", int(L.get("opacity", 255)), 0, 0, 0)
        extra = struct.pack(">I", 0) + struct.pack(">I", 0) + _pascal(L["name"]) + _unicode_name(L["name"])
        rec += struct.pack(">I", len(extra)) + extra
        records += rec
        for _, c in chans:
            pixel_data += struct.pack(">H", 0) + np.ascontiguousarray(c, dtype=np.uint8).tobytes()
    layer_info = struct.pack(">h", len(layers)) + records + pixel_data
    if len(layer_info) % 2:
        layer_info += b"\0"
    layer_info = struct.pack(">I", len(layer_info)) + layer_info
    lmi = layer_info + struct.pack(">I", 0)  # no global layer mask
    with open(path, "wb") as f:
        f.write(b"8BPS" + struct.pack(">H6xHIIHH", 1, 3, h, w, 8, 3))
        f.write(struct.pack(">I", 0))          # colour mode data
        f.write(struct.pack(">I", 0))          # image resources
        f.write(struct.pack(">I", len(lmi)) + lmi)
        f.write(struct.pack(">H", 0))          # raw composite, planar R, G, B
        for c in range(3):
            f.write(np.ascontiguousarray(composite[..., c], dtype=np.uint8).tobytes())


def write_psd(path: str, layers: list[dict], composite: np.ndarray) -> None:
    """layers: [{name, rgba (HxWx4 uint8 straight), blend_mode, opacity}] bottom first.

    Written by hand on purpose: psd-tools 1.26 create_pixel_layer drops RGBA transparency
    (tested 2026-10-27: transparent pixels came back opaque), and the pod has no PSD library.
    """
    _write_raw(path, layers, composite)
