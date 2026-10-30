"""Print the look prompts for the stage's default walk-in scene.

    python3 -m soundstage.look.example                       # "Korean thriller, anamorphic, teal-orange"
    python3 -m soundstage.look.example "noir, 1940s, 35mm film, f/1.4"
    python3 -m soundstage.look.example --json look.json --scene scene.json
"""
from __future__ import annotations

import argparse
import json
import textwrap

from .compile import compile_look
from .default_scene import DEFAULT_SCENE
from .vocab import parse_look_input


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("look", nargs="?", default="Korean thriller, anamorphic, teal-orange")
    ap.add_argument("--json", help="look JSON file instead of typed text")
    ap.add_argument("--scene", help="stage scene JSON file (default: the walk-in scene)")
    a = ap.parse_args(argv)
    look, matched = (json.load(open(a.json)), []) if a.json else parse_look_input(a.look)
    scene = json.load(open(a.scene)) if a.scene else DEFAULT_SCENE
    out = compile_look(look, scene)
    print(f"LOOK  {a.json or a.look}")
    for m in matched:
        print(f"      {m}")
    for k in ("still_prompt", "still_negative", "motion_prompt"):
        print(f"\n{k.upper()}\n" + textwrap.fill(out[k], 110))
    print(f"\nKB refs: {', '.join(out['kb_refs']) or '-'}   notes: {'; '.join(out['notes']) or '-'}")


if __name__ == "__main__":
    main()
