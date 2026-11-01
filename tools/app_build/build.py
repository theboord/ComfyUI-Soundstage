#!/usr/bin/env python3
"""Assemble the full Soundstage App from the base ladder plus each department's part.

    python tools/app_build/build.py            # -> example_workflows/Soundstage_App_Full.json
Each module in PARTS exposes apply(g: Graph). Missing modules are skipped with a note.
"""
import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from graph import Graph  # noqa: E402

PARTS = ["models", "touchup", "audio", "layers", "quality", "outputs", "guided", "ltx_advanced"]  # order matters: model pickers, touch-up after the still picker, audio on the final, per-actor layers, quality knobs on the L2R engine, output tidy-up


def main(src=ROOT / "example_workflows/Soundstage_App.json", dst=ROOT / "example_workflows/Soundstage_App_Full.json"):
    g = Graph.load(src)
    for name in PARTS:
        try:
            mod = importlib.import_module(name)
        except ModuleNotFoundError:
            print(f"skip {name} (not written yet)")
            continue
        mod.apply(g)
        print(f"applied {name}")
    g.save(dst)
    print(f"wrote {dst} ({len(g.nodes)} nodes)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
