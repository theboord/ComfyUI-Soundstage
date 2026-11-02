"""LAYOUT: everything in the frame, measured (the entry points the pipeline calls; see context.py for the order).

    inventory_graph(ctx) -> prompt | None      Qwen3-VL 8B reads 6 frames spread over the trim (vlm.py)
    inventory_collect(ctx, outputs)            -> ctx['vlm_inventory']; returns the frames worth one retry
    segment_graph(ctx) -> prompt | None        SAM 3.1 tracks every concept in 40-frame windows (segment.py)
    segment_collect(ctx, outputs)              -> ctx['masks']['objects'], ctx['seg']
    measure(ctx)                               oriented boxes, colour, scale anchors, surfaces (measure.py)
    assemble(ctx) -> scene                     structure planes, movers, library match, inventory (convert.py)

run_gpu(base_url, ctx) does the three queued steps in order (with the one retry) for callers that want it in one
call. Every GPU step is an ordinary queued prompt of our own; nothing else is touched.
"""
from __future__ import annotations

from . import context as X
from . import convert, measure as _measure, segment, vlm


inventory_graph = vlm.inventory_graph          # (ctx, frames=None) -> prompt | None
inventory_collect = vlm.inventory_collect      # (ctx, outputs) -> frames worth one retry


def segment_graph(ctx: dict):
    return segment.graph(ctx)


def segment_collect(ctx: dict, outputs: dict) -> dict:
    return segment.collect(ctx, outputs)


def measure(ctx: dict) -> dict:
    return _measure.measure(ctx)


def assemble(ctx: dict) -> dict:
    return convert.assemble(ctx)


async def run_gpu(base_url: str, ctx: dict, progress=None) -> None:
    """Inventory (+ one retry of unusable frames) then segmentation, through the queue; notes on failure."""
    from . import queue
    say = progress or (lambda step, frac: None)
    g = inventory_graph(ctx)
    if g:
        say("Listing everything in the frame (Qwen3-VL)", None)
        try:
            out, t = await queue.run_graph(base_url, g, "inventory", timeout_s=1800)
            ctx.setdefault("timings", {})["inventory_ms"] = t.get("exec_ms", t["total_ms"])
            retry = inventory_collect(ctx, out)
            if retry:
                g2 = inventory_graph(ctx, retry)
                out2, _ = await queue.run_graph(base_url, g2, "inventory retry", timeout_s=900)
                still = inventory_collect(ctx, out2)
                if still:
                    X.note(ctx, f"layout: the vision model's read of frame(s) {', '.join(map(str, still))} was unusable "
                                "twice; those frames add no names", "warn")
                ctx["vlm_frames"] = sorted({r["frame"] for r in ctx.get("vlm_reads") or []})
        except Exception as exc:  # noqa: BLE001
            X.note(ctx, f"layout: inventory failed ({exc}); things are named by SAM's sweep words", "warn")
    g = segment.graph(ctx)
    if g:
        say("Finding every object (SAM 3.1)", None)
        try:
            out, t = await queue.run_graph(base_url, g, "segmentation", timeout_s=3600)
            ctx.setdefault("timings", {})["segment_ms"] = t.get("exec_ms", t["total_ms"])
            segment.collect(ctx, out)
        except Exception as exc:  # noqa: BLE001
            X.note(ctx, f"layout: segmentation failed ({exc}); no objects rebuilt", "red")
