"""Footage helpers: trim a decoded clip to an LTX-friendly length, cut the matching audio, pick the
subject among SAM3 tracks and describe everything in a footage JSON. Pure python/torch."""
import json

import torch


def ltx_length(n):
    """Largest 8k+1 <= n (LTX latents are 8 frames per step plus the first). Min 9."""
    if n < 9:
        return n
    return (n - 1) // 8 * 8 + 1


def trim_plan(total, start, max_frames, snap):
    """(start, count) of the frames to keep."""
    start = max(0, min(int(start), max(0, total - 1)))
    count = total - start
    if max_frames > 0:
        count = min(count, int(max_frames))
    if snap:
        count = ltx_length(count)
    return start, max(1, count)


def trim_audio(audio, fps, start, count):
    """Slice a ComfyUI AUDIO dict {'waveform': [B, C, S], 'sample_rate'} to the kept frames."""
    if not audio or audio.get("waveform") is None:
        return None
    sr = int(audio["sample_rate"])
    a = int(round(start / fps * sr))
    b = int(round((start + count) / fps * sr))
    wav = audio["waveform"][..., a:b]
    need = b - a
    if wav.shape[-1] < need:  # audio shorter than the picture: pad with silence so durations match
        wav = torch.nn.functional.pad(wav, (0, need - wav.shape[-1]))
    return {"waveform": wav.contiguous(), "sample_rate": sr}


def parse_points(text):
    """Click points as JSON [{"x":..,"y":..}] or [[x, y], ...]; '' -> None. Returns SAM3_Detect's format."""
    text = (text or "").strip()
    if not text:
        return None
    pts = json.loads(text)
    out = []
    for p in pts:
        if isinstance(p, dict):
            out.append({"x": int(round(float(p["x"]))), "y": int(round(float(p["y"])))})
        else:
            out.append({"x": int(round(float(p[0]))), "y": int(round(float(p[1])))})
    return json.dumps(out) if out else None


def _bbox(m):
    ys, xs = torch.nonzero(m > 0.5, as_tuple=True)
    if ys.numel() == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def select_subject(objs, subject=-1, match=None):
    """objs: per-object masks [N, K, H, W] (K may be 0). subject = track index, or -1 = the largest
    (most screen area over the clip), or, when `match` [N, H', W'] is given, the track that overlaps it
    most (used to find the recast character in the swap: overlap with where the original subject was).
    Returns (subject_mask [N,H,W], others_mask [N,H,W], index, stats)."""
    n, k, h, w = objs.shape
    zero = torch.zeros(n, h, w, dtype=torch.float32, device=objs.device)
    if k == 0:
        return zero, zero, -1, []
    area = (objs > 0.5).float().mean(dim=(2, 3))  # [N, K]
    stats = []
    for i in range(k):
        present = (area[:, i] > 0).nonzero()
        first = int(present[0]) if present.numel() else -1
        stats.append({
            "index": i,
            "coverage": round(float(area[:, i].mean()), 5),
            "frames_visible": int((area[:, i] > 0).sum()),
            "first_frame": first,
            "bbox_first": _bbox(objs[first, i]) if first >= 0 else None,
        })
    if match is not None and (subject < 0 or subject >= k):
        m = match.float()
        if m.shape[-2:] != (h, w):
            m = torch.nn.functional.interpolate(m.unsqueeze(1), size=(h, w), mode="bilinear",
                                                align_corners=False)[:, 0]
        n2 = min(n, m.shape[0])
        hit = ((objs[:n2] > 0.5).float() * (m[:n2] > 0.5).float().unsqueeze(1)).sum(dim=(0, 2, 3))  # [K]
        subject = int(hit.argmax())
    elif subject < 0 or subject >= k:
        subject = int(area.mean(dim=0).argmax())
    sub = objs[:, subject].float()
    rest = [j for j in range(k) if j != subject]
    oth = objs[:, rest].float().amax(dim=1) if rest else zero
    return sub, oth, subject, stats


def footage_json(source, fps, start, count, width, height, has_audio, prompt=None, points=None, subject=None,
                 tracks=None):
    d = {
        "kind": "soundstage.footage",
        "version": 1,
        "source": source,
        "fps": round(float(fps), 6),
        "start_frame": int(start),
        "frames": int(count),
        "seconds": round(count / max(fps, 1e-6), 4),
        "width": int(width),
        "height": int(height),
        "has_audio": bool(has_audio),
    }
    if prompt is not None:
        d["subject_prompt"] = prompt
    if points:
        d["points"] = json.loads(points)
    if subject is not None:
        d["subject_index"] = int(subject)
    if tracks is not None:
        d["tracks"] = tracks
    return json.dumps(d)


def merge_json(base, **extra):
    d = json.loads(base) if base else {}
    d.update({k: v for k, v in extra.items() if v is not None})
    return json.dumps(d)

