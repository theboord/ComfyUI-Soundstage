"""QC the V3 graphics sound pack (soundstage/cut/gfx_sfx.py) with the AudioSet classifier
(MIT/ast-finetuned-audioset-10-10-0.4593, local files only: nothing is downloaded).

    python tools/qa/gfx_sfx_qc.py <pack dir> [--json out.json]

A file fails if Speech, Singing or any animal label scores above 0.3 (DESIGN_SYSTEM.md §13). A tonal "Music"
score on a hum or a chord is a known false positive and is reported, not failed. Short files are zero-padded
to the classifier's 1 s minimum. Needs torch + transformers (any venv that has them).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import numpy as np  # noqa: E402

from soundstage.audio import qc  # noqa: E402
from soundstage.cut.mix import SR, decode  # noqa: E402

BAD = ("Speech", "Singing", "Animal", "Dog", "Bark", "Cat", "Bird", "Insect", "Domestic animals", "Livestock", "Child speech",
       "Male speech", "Female speech", "Conversation", "Narration", "Babbling", "Choir", "Vocal music")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack")
    ap.add_argument("--json")
    a = ap.parse_args()
    rows, fails = [], 0
    for fn in sorted(f for f in os.listdir(a.pack) if f.endswith(".wav")):
        x = decode(os.path.join(a.pack, fn))
        if len(x) < SR:
            x = np.pad(x, ((0, SR - len(x)), (0, 0)))
        sc = qc.classify(x, SR) or {}
        top = sorted(sc.items(), key=lambda kv: -kv[1])[:5]
        bad = {k: round(v, 3) for k, v in sc.items() if any(b.lower() == k.lower() or b.lower() in k.lower() for b in BAD) and v > 0.3}
        fails += bool(bad)
        rows.append({"file": fn, "top": [[k, round(v, 3)] for k, v in top], "fail": bad})
        print(f"{'FAIL' if bad else 'ok  '} {fn:32s} " + ", ".join(f"{k} {v:.2f}" for k, v in top) + (f"  <- {bad}" if bad else ""))
    if a.json:
        json.dump({"model": qc.AST_ID, "files": rows, "failed": fails}, open(a.json, "w"), indent=1)
    print(f"{len(rows)} files, {fails} failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
