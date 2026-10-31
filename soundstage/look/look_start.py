"""Frame 1 in colour, prepared as the start image for the look still (FLUX 3 Klein / Krea 2).

Two things make an image model paint people as plastic dolls when it starts from the stage's colour pass:

1. The clay heads. Blank mannequin faces (no eyes, no mouth) and helmet hair get copied as they are: the model keeps
   the figure and only re-textures it. Softening the heads (and only the heads) leaves the pose, the placement,
   the build and the hair and skin colour, and the model casts a real face in that spot.
2. Too few pixels on a face. The stage renders about 960 x 512; in a wide shot a head is 25-35 px tall and the
   model has no room for a face. When the smallest head is small, frame 1 is upscaled (at most 1.75x, about
   1.5 megapixels) so the still is generated at that size. Close shots stay at the stage size: generating them
   larger lets the model pull the camera back (the windshield shot loses its framing).

Measured on the riders and the windshield shots, docs/decisions.md 2026-10-30 (Milestone 5).
Everything here works on the ID pass the stage already renders, so nothing else in the graph changes.
"""
from __future__ import annotations

import math

try:   # the stage node always has torch; the pure helpers below are also tested without it
    import torch
    import torch.nn.functional as F
except ImportError:  # pragma: no cover
    torch = F = None

from . import scene as S

HEAD_TARGET_PX = 64      # a head at least this tall leaves the model room for a real face
MAX_UPSCALE = 1.75       # 960 x 512 -> 1680 x 896, about 1.5 MP
HEAD_BLUR = 0.04         # blur sigma as a fraction of the tallest person's height in frame
MIN_PERSON_PX = 40       # silhouettes smaller than this (pixels) are left alone


def _srgb(c: torch.Tensor) -> torch.Tensor:
    """The stage's ID colours are set in linear space and written to the PNG as sRGB."""
    return torch.where(c <= 0.0031308, c * 12.92, 1.055 * c.clamp(min=0) ** (1 / 2.4) - 0.055)


def people_ids(scene: dict) -> list[str]:
    """Actors that are people (library bipeds). Custom objects are left as staged."""
    out = []
    for a in scene.get("actors") or []:
        if a.get("kind") == "custom":
            continue
        if S.classify(a)[1] == "biped" and a.get("id"):
            out.append(a["id"])
    return out


def person_masks(id_pass: torch.Tensor, scene: dict) -> dict[str, torch.Tensor]:
    """id -> HxW bool mask for every person in frame. id_pass: HxWx3 in 0..1.
    Nearest-colour classification against the stage palette in both encodings, so antialiased edges and either
    colour space classify the same way."""
    colors = scene.get("id_colors") or {}
    ids = [i for i in colors if colors[i] is not None]
    if not ids:
        return {}
    raw = torch.tensor([colors[i] for i in ids], dtype=torch.float32) / 255.0
    pal = torch.cat([torch.zeros(1, 3), raw, _srgb(raw)], 0)                     # 0 = background
    owner = [-1] + list(range(len(ids))) * 2
    d = ((id_pass[..., None, :].float() - pal[None, None]) ** 2).sum(-1)
    label = d.argmin(-1)
    who = torch.tensor(owner)[label]
    people = set(people_ids(scene))
    out = {}
    for k, i in enumerate(ids):
        if i in people:
            m = who == k
            if int(m.sum()) >= MIN_PERSON_PX:
                out[i] = m
    return out


def _shoulder_row(w: list[int]) -> int:
    """Index of the first row below the head, from the silhouette's row widths (top down): the outline widens past
    the head (hair down to the shoulders), or comes back wide after the neck narrowed it."""
    peak = 0
    for i in range(1, len(w)):
        mx = max(w[:i])
        if w[i - 1] >= mx:
            peak = i - 1
        if i < 4 or i < 0.5 * mx:        # still in the crown: a head is about as tall as it is wide
            continue
        neck = min(w[peak:i])
        before = max(w[:max(1, i - 3)])     # a few rows back: shoulders can widen over two or three rows
        if w[i] > 1.25 * before or (neck < 0.6 * mx and w[i] > 2 * neck and w[i] > 0.8 * mx):
            return i
    return min(len(w), int(1.3 * max(w)) if w else 0)


def head_mask(m: torch.Tensor) -> torch.Tensor:
    """The head of one person's silhouette: from its top down to the shoulders."""
    rows = m.sum(1)
    ys = torch.nonzero(rows).flatten()
    if not len(ys):
        return torch.zeros_like(m)
    top, bot = int(ys[0]), int(ys[-1])
    end = _shoulder_row([int(x) for x in rows[top:bot + 1]])
    h = torch.zeros_like(m)
    h[top:top + end] = m[top:top + end]
    return h


def _blur(img: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable Gaussian blur. img: CxHxW."""
    r = max(1, int(math.ceil(sigma * 3)))
    x = torch.arange(-r, r + 1, dtype=torch.float32)
    k = torch.exp(-(x ** 2) / (2 * sigma ** 2))
    k = (k / k.sum()).to(img.dtype)
    c = img.shape[0]
    t = F.pad(img[None], (r, r, 0, 0), mode="replicate")
    t = F.conv2d(t, k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    t = F.pad(t, (0, 0, r, r), mode="replicate")
    t = F.conv2d(t, k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)
    return t[0]


def _feather(mask: torch.Tensor, grow: int, soft: float) -> torch.Tensor:
    m = mask.float()[None, None]
    if grow > 0:
        m = F.max_pool2d(m, 2 * grow + 1, stride=1, padding=grow)
    return _blur(m[0], soft)[0].clamp(0, 1) if soft > 0 else m[0, 0]


def heads_height(masks: dict[str, torch.Tensor]) -> list[int]:
    out = []
    for m in masks.values():
        h = head_mask(m)
        ys = torch.nonzero(h.sum(1)).flatten()
        if len(ys):
            out.append(int(ys[-1] - ys[0] + 1))
    return out


def upscale_factor(head_heights: list[int]) -> float:
    if not head_heights:
        return 1.0
    # The largest head: a head mask cut short by an occluding horse or an arm never asks for a bigger frame.
    return max(1.0, min(MAX_UPSCALE, HEAD_TARGET_PX / max(1, max(head_heights))))


def look_start(color: torch.Tensor, id_pass: torch.Tensor | None, scene: dict) -> tuple[torch.Tensor, dict]:
    """color, id_pass: 1xHxWx3 (frame 1). Returns (start image 1xH'xW'x3, info)."""
    info = {"people": 0, "heads": [], "scale": 1.0, "softened": False}
    if id_pass is None or id_pass.shape[1:3] != color.shape[1:3] or not isinstance(scene, dict):
        return color, info
    try:
        masks = person_masks(id_pass[0, ..., :3], scene)
    except Exception:  # noqa: BLE001 - a malformed palette never breaks the stage node
        return color, info
    info["people"] = len(masks)
    if not masks:
        return color, info
    img = color[0, ..., :3].permute(2, 0, 1).float()                   # CxHxW
    tallest = max(int(torch.nonzero(m.sum(1)).flatten().numel()) for m in masks.values())
    heads = torch.zeros_like(next(iter(masks.values())))
    for m in masks.values():
        heads |= head_mask(m)
    if int(heads.sum()):
        alpha = _feather(heads, 3, 2.0)[None]
        img = img * (1 - alpha) + _blur(img, max(2.0, HEAD_BLUR * tallest)) * alpha
        info["softened"] = True
    info["heads"] = heads_height(masks)
    s = upscale_factor(info["heads"])
    if s > 1.0:
        H, W = img.shape[1:]
        nh, nw = int(round(H * s / 16) * 16), int(round(W * s / 16) * 16)
        img = F.interpolate(img[None], size=(nh, nw), mode="bicubic", align_corners=False, antialias=False)[0]
        info["scale"] = round(nw / W, 3)
    out = img.clamp(0, 1).permute(1, 2, 0)[None].to(color.dtype)
    return out, info


# ---- the layout guide in ride-along car shots ---------------------------------------------------------

BG_BLUR = 16 / 960       # blur sigma for the static set, as a fraction of the frame width (16 px at 960)


def quiet_background_wanted(scene: dict) -> bool:
    """The camera rides a car on an otherwise empty road (Milestone 5: LTX turned the clay's dark building blocks
    sliding past the frame edge into passing cars)."""
    try:
        return S.ride_host(scene) is not None and S.traffic_lock(scene) is not None
    except Exception:  # noqa: BLE001 - a malformed scene keeps the guide as captured
        return False


def quiet_background(clay: torch.Tensor, id_pass: torch.Tensor | None, scene: dict) -> torch.Tensor:
    """clay, id_pass: NxHxWx3. In a ride-along car shot, blur the static set (everything the ID pass leaves black)
    and keep every actor and vehicle sharp. The guide keeps the camera move and the street's light and shade
    sliding past, but no hard-edged blocks for LTX to read as cars. Elsewhere the clay passes through."""
    if id_pass is None or id_pass.shape != clay.shape or not quiet_background_wanted(scene):
        return clay
    n, H, W, _ = clay.shape
    sigma = BG_BLUR * W
    f = 4                                                    # blur at quarter size: same look, ~16x cheaper
    out = []
    for i in range(n):
        img = clay[i].permute(2, 0, 1).float()
        small = F.interpolate(img[None], size=(max(1, H // f), max(1, W // f)), mode="area")[0]
        blurred = F.interpolate(_blur(small, sigma / f)[None], size=(H, W), mode="bilinear", align_corners=False)[0]
        actors = id_pass[i, ..., :3].float().sum(-1) > 0.1
        keep = _feather(actors, 2, 2.0)[None]
        out.append((img * keep + blurred * (1 - keep)).permute(1, 2, 0))
    return torch.stack(out).clamp(0, 1).to(clay.dtype)
