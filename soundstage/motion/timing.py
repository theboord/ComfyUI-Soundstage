"""Frame timing for Ripple / Pose follow: retime a clip to LTX's 24 fps, 8k+1 lengths, sprite-sheet slicing.
Pure python (torch only in slice_sheet), unit-tested in tests/test_motion_graphs.py."""
import json
import math


def ltx_length(n):
    """Largest 8k+1 <= n (min 9 when possible)."""
    n = int(n)
    if n < 9:
        return max(1, n)
    return (n - 1) // 8 * 8 + 1


def retime_indices(total, src_fps, fps, start_frame=0, max_frames=0):
    """Source frame indices for a clip retimed to `fps` (nearest frame, no blending: LTX wants real frames), starting
    at `start_frame`, at most `max_frames` long, trimmed to 8k+1. fps <= 0 keeps the source rate. -> (indices, fps)."""
    total = int(total)
    src_fps = float(src_fps) if src_fps and src_fps > 0 else 24.0
    out_fps = float(fps) if fps and fps > 0 else src_fps
    start = max(0, min(int(start_frame), max(0, total - 1)))
    span_s = (total - start) / src_fps
    count = int(math.floor(span_s * out_fps + 1e-6))
    if max_frames and max_frames > 0:
        count = min(count, int(max_frames))
    count = ltx_length(max(1, count))
    idx = [min(total - 1, start + int(round(i * src_fps / out_fps))) for i in range(count)]
    return idx, out_fps


def sheet_frames(grid):
    try:
        g = json.loads(grid) if isinstance(grid, str) else grid
        return int(g.get("frames") or 0) if g else 0
    except (ValueError, AttributeError, TypeError):
        return 0


def slice_sheet(sheet, grid):
    """1xHxWx3 row-major sprite sheet -> NxthxTWx3 frames (as nodes_stage._load_sequence)."""
    import torch
    if not grid:
        return sheet
    tw, th = (int(v) for v in grid["tile"])
    cols, frames = int(grid["cols"]), int(grid["frames"])
    tiles = [sheet[0, (f // cols) * th:(f // cols + 1) * th, (f % cols) * tw:(f % cols + 1) * tw] for f in range(frames)]
    return torch.stack(tiles)
