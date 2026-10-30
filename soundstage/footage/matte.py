"""Stage-2 composite for Recast: put only the swapped subject back over the original plate.

Pure torch, no ComfyUI imports, so it is unit-testable on a laptop. Tensors follow ComfyUI's layout:
IMAGE = [N, H, W, C] float 0..1, MASK = [N, H, W] float 0..1 (1 = subject).

The matte is the union of the subject's silhouette in the ORIGINAL plate and (optionally) its new
silhouette in the swap, so a bigger costume or longer hair is not clipped and the old actor never
peeks out from behind the new one. It is dilated, steadied over time, feathered, and other people's
masks are cut back out so everyone else stays the real plate.
"""
import torch
import torch.nn.functional as F


def _nchw(mask):
    return mask.float().unsqueeze(1)


def resize_mask(mask, h, w):
    if mask.shape[-2:] == (h, w):
        return mask.float()
    return F.interpolate(_nchw(mask), size=(h, w), mode="bilinear", align_corners=False)[:, 0].clamp(0, 1)


def resize_images(images, h, w):
    if images.shape[1:3] == (h, w):
        return images
    x = images.movedim(-1, 1)
    x = F.interpolate(x, size=(h, w), mode="bicubic", align_corners=False, antialias=True)
    return x.movedim(1, -1).clamp(0, 1)


def place_cover(swap, h, w):
    """Inverse of a centre 'cover' crop: the swap shows the largest centred box of the plate with the
    swap's aspect. Returns (swap resized into that box on an [N, h, w, 3] canvas, box mask [h, w])."""
    sh, sw = swap.shape[1], swap.shape[2]
    a = sw / sh
    if abs(w / h - a) < 1e-3:
        return resize_images(swap, h, w), torch.ones(h, w, device=swap.device)
    if w / h > a:
        bh, bw = h, max(1, int(round(h * a)))
    else:
        bh, bw = max(1, int(round(w / a))), w
    y0, x0 = (h - bh) // 2, (w - bw) // 2
    canvas = torch.zeros(swap.shape[0], h, w, swap.shape[3], device=swap.device, dtype=swap.dtype)
    canvas[:, y0:y0 + bh, x0:x0 + bw] = resize_images(swap, bh, bw)
    box = torch.zeros(h, w, device=swap.device)
    box[y0:y0 + bh, x0:x0 + bw] = 1
    return canvas, box


def fit_frames(t, n):
    """Trim, or hold the last frame, so the batch has exactly n frames."""
    if t.shape[0] == n:
        return t
    if t.shape[0] > n:
        return t[:n]
    pad = t[-1:].expand(n - t.shape[0], *t.shape[1:])
    return torch.cat([t, pad], 0)


def dilate(mask, px):
    """Grow (px > 0) or shrink (px < 0) a mask by px pixels with a square max-pool."""
    px = int(round(px))
    if px == 0:
        return mask
    x = _nchw(mask)
    k = 2 * abs(px) + 1
    if px > 0:
        x = F.max_pool2d(x, k, stride=1, padding=abs(px))
    else:
        x = -F.max_pool2d(-x, k, stride=1, padding=abs(px))
    return x[:, 0]


def _gauss_1d(sigma, device):
    r = max(1, int(round(sigma * 3)))
    t = torch.arange(-r, r + 1, device=device, dtype=torch.float32)
    k = torch.exp(-0.5 * (t / sigma) ** 2)
    return k / k.sum(), r


def blur(mask, px):
    """Gaussian feather; px is the visible soft-edge width (sigma = px / 2)."""
    if px <= 0:
        return mask
    k, r = _gauss_1d(px / 2.0, mask.device)
    x = _nchw(mask)
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1))
    x = F.conv2d(F.pad(x, (0, 0, r, r), mode="replicate"), k.view(1, 1, -1, 1))
    return x[:, 0].clamp(0, 1)


def temporal_smooth(mask, radius):
    """Centered moving average over 2r+1 frames: kills per-frame matte chatter (SAM boils)."""
    if radius <= 0 or mask.shape[0] < 2:
        return mask
    x = mask.float().permute(1, 2, 0).reshape(1, -1, mask.shape[0])  # [1, H*W, N]
    x = F.pad(x, (radius, radius), mode="replicate")
    x = F.avg_pool1d(x, 2 * radius + 1, stride=1)
    return x.reshape(mask.shape[1], mask.shape[2], -1).permute(2, 0, 1)


def color_match(swap, plate, inside, ring_px, strength=1.0):
    """Shift the swap's per-frame channel means toward the plate, measured in a ring just outside the
    matte (where both should show the same background). Returns the corrected swap."""
    if strength <= 0:
        return swap
    ring = (dilate(inside, ring_px) - inside).clamp(0, 1)
    w = ring.unsqueeze(-1)
    area = w.sum(dim=(1, 2)).clamp_min(1.0)                         # [N, 1]
    mp = (plate * w).sum(dim=(1, 2)) / area
    ms = (swap * w).sum(dim=(1, 2)) / area
    ok = (ring.sum(dim=(1, 2)) > 16).float().unsqueeze(-1)            # skip frames with no ring
    shift = ((mp - ms) * ok * strength).clamp(-0.05, 0.05)
    shift = temporal_smooth(shift.unsqueeze(-1), 2)[..., 0]  # [N, 3] treated as N frames of 3x1
    return (swap + shift[:, None, None, :]).clamp(0, 1)


def build_matte(subject, h, w, n, swap_subject=None, others=None, grow_px=12, feather_px=10, temporal=1):
    """Final soft alpha [n, h, w] for the swap layer."""
    sub = (fit_frames(resize_mask(subject, h, w), n) > 0.5).float()
    union = sub
    if swap_subject is not None:
        # only accept new-silhouette pixels near the old subject (the swap may contain other people too)
        reach = max(grow_px * 2, int(0.03 * min(h, w)))
        near = dilate(sub, reach)
        new = (fit_frames(resize_mask(swap_subject, h, w), n) > 0.5).float() * near
        union = torch.maximum(union, new)
    hard = dilate(union, grow_px)
    hard = temporal_smooth(hard, temporal)
    alpha = blur(hard, feather_px)
    alpha = torch.maximum(alpha, sub)  # the subject core is always fully replaced
    if others is not None:
        oth = (fit_frames(resize_mask(others, h, w), n) > 0.5).float()
        protect = blur(dilate(oth, 2), max(2, feather_px // 2)) * (1 - sub)
        alpha = alpha * (1 - protect)
    return alpha.clamp(0, 1)


def composite(plate, swap, subject, swap_subject=None, others=None, grow_px=12, feather_px=10, temporal=1,
              match_color=False, framing="stretch"):
    """Returns (composite RGB, swap layer RGBA, alpha), all at the plate's size and frame count.
    framing: 'stretch' = the swap covers the whole plate (its aspect may differ slightly);
             'cover' = the swap is a centred crop of the plate (e.g. after ResizeImageMask 'scale to multiple')."""
    plate = plate[..., :3]
    n, h, w = plate.shape[0], plate.shape[1], plate.shape[2]
    swap = swap[..., :3].to(plate.device)
    if framing == "cover":
        sw, box = place_cover(swap, h, w)
        if swap_subject is not None:
            swap_subject, _ = place_cover(swap_subject.to(plate.device).unsqueeze(-1), h, w)
            swap_subject = swap_subject[..., 0]
    else:
        sw, box = resize_images(swap, h, w), None
    sw = fit_frames(sw, n)
    alpha = build_matte(subject.to(plate.device), h, w, n,
                        None if swap_subject is None else swap_subject.to(plate.device),
                        None if others is None else others.to(plate.device), grow_px, feather_px, temporal)
    if box is not None:
        alpha = alpha * box
    if match_color:
        sw = color_match(sw, plate, (alpha > 0.5).float(), max(8, feather_px * 2))
    a = alpha.unsqueeze(-1)
    comp = plate * (1 - a) + sw * a
    layer = torch.cat([sw, a], dim=-1)
    return comp, layer, alpha
