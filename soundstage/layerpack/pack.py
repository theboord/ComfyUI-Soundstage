"""The Layer Pack data model: what the nodes pass to each other.

Frames are kept as the tensors/arrays ComfyUI hands us (no copies) and are converted one frame
at a time at export, so a 97-frame 2K pack never needs a second full copy in memory.
Every add returns a NEW pack: ComfyUI caches node outputs, so packs must never be mutated.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

import numpy as np
from PIL import Image

KINDS = ["character", "background", "prop", "fx", "shadow", "holdout", "other"]
BLEND_MODES = ["normal", "multiply", "screen", "add"]
AOV_KINDS = ["depth", "normals", "beauty", "albedo", "custom"]
DEPTH_ENCODINGS = ["stage (near=white, linear near..far)", "metres (raw)", "relative (near=white, unitless)"]


def safe_name(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", str(name).strip()).strip("_")
    return s or "layer"


def n_frames(arr) -> int:
    if arr is None:
        return 0
    a = arr
    return 1 if len(a.shape) == 2 else int(a.shape[0])


def frame(arr, i: int) -> np.ndarray:
    """Frame i (held on the last frame) as float32 numpy. IMAGE -> HxWxC, MASK -> HxW."""
    if len(arr.shape) == 2:  # single mask HxW
        f = arr
    else:
        f = arr[min(i, int(arr.shape[0]) - 1)]
    if hasattr(f, "detach"):  # torch
        f = f.detach().float().cpu().numpy()
    return np.asarray(f, dtype=np.float32)


def fit(img: np.ndarray, w: int, h: int) -> np.ndarray:
    """Resize an HxW or HxWxC float frame to w x h (bilinear) if it is not already that size."""
    if img.shape[0] == h and img.shape[1] == w:
        return img
    if img.ndim == 2:
        return np.asarray(Image.fromarray(np.ascontiguousarray(img, dtype=np.float32)).resize((w, h), Image.BILINEAR), dtype=np.float32)
    return np.stack([fit(img[..., c], w, h) for c in range(img.shape[2])], axis=-1)


@dataclass(frozen=True)
class Layer:
    name: str
    images: object                 # IMAGE batch [N,H,W,3(+1)] 0..1, or one frame (held)
    mask: object = None            # MASK batch [N,H,W] 1 = opaque (after invert), or None = opaque
    z: int = 10
    kind: str = "character"
    blend_mode: str = "normal"
    source_id: str = ""            # stage actor id / SAM3 object index / anything traceable
    invert_mask: bool = False

    def rgba(self, i: int, w: int, h: int) -> np.ndarray:
        """Straight (unpremultiplied) RGBA float frame, HxWx4."""
        rgb = fit(frame(self.images, i), w, h)
        if rgb.shape[2] == 4 and self.mask is None:
            a = rgb[..., 3]
        elif self.mask is None:
            a = np.ones(rgb.shape[:2], np.float32)
        else:
            a = fit(frame(self.mask, i), w, h)
            if self.invert_mask:
                a = 1.0 - a
        return np.concatenate([rgb[..., :3], np.clip(a, 0, 1)[..., None]], axis=-1).clip(0, 1)


@dataclass(frozen=True)
class AOV:
    kind: str
    images: object                 # IMAGE batch
    units: str = ""
    near: float = 1.0
    far: float = 40.0
    encoding: str = ""

    def depth_m(self, i: int, w: int, h: int) -> np.ndarray:
        """Depth in metres along the camera axis (or unitless for relative encodings)."""
        f = fit(frame(self.images, i), w, h)
        v = f[..., 0] if f.ndim == 3 else f
        if self.encoding.startswith("stage"):
            return (self.near + (1.0 - v) * (self.far - self.near)).astype(np.float32)
        if self.encoding.startswith("relative"):
            return (1.0 - v).astype(np.float32)
        return v.astype(np.float32)


@dataclass(frozen=True)
class LayerPack:
    shot: str = "SH010"
    fps: float = 24.0
    frame_start: int = 1001
    camera: object = None          # camera/scene JSON (dict or str), see camera.py
    notes: str = ""
    layers: tuple = ()
    aovs: tuple = ()
    width: int = 0                 # 0 = take it from the first layer
    height: int = 0
    meta: dict = field(default_factory=dict)

    def add_layer(self, layer: Layer) -> "LayerPack":
        names = {l.name for l in self.layers}
        name, k = layer.name, 2
        while name in names:
            name, k = f"{layer.name}_{k}", k + 1
        return replace(self, layers=self.layers + (replace(layer, name=name),))

    def add_aov(self, aov: AOV) -> "LayerPack":
        return replace(self, aovs=tuple(a for a in self.aovs if a.kind != aov.kind) + (aov,))

    def aov(self, kind: str):
        return next((a for a in self.aovs if a.kind == kind), None)

    def resolution(self) -> tuple[int, int]:
        if self.width and self.height:
            return int(self.width), int(self.height)
        src = self.layers[0].images if self.layers else (self.aovs[0].images if self.aovs else None)
        if src is None:
            raise ValueError("The Layer Pack is empty: add at least one layer.")
        s = src.shape
        return int(s[-2]), int(s[-3])

    def length(self) -> int:
        return max([n_frames(l.images) for l in self.layers] + [n_frames(l.mask) for l in self.layers]
                   + [n_frames(a.images) for a in self.aovs] + [1])
