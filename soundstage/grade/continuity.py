"""Grade continuity across cuts: two shots of one scene cut together should read as the same light.

`compare(a, b)` gives the differences in stops (exposure, warmth, tint) and OKLab delta E; `check_cut(rows)` flags
each cut inside a scene where one of them is past its threshold, with the sentence the Coach shows:
"1G is 0.4 stops warmer than 1H". Thresholds are about where a colourist would reach for a correction at a cut:
1/3 stop of exposure, 1/4 stop of warmth or tint.

web/coach/rules.mjs `gradeContinuity` is the same check on the same numbers (tests/test_grade.py runs both).
"""
from __future__ import annotations

from .cdl import _fixed

THRESHOLDS = {"exposure_ev": 0.33, "warmth_ev": 0.25, "tint_ev": 0.25}
WORDS = {"exposure_ev": ("brighter", "darker"), "warmth_ev": ("warmer", "cooler"), "tint_ev": ("greener", "more magenta")}


def compare(a: dict, b: dict) -> dict:
    """a minus b, in stops; and OKLab delta E x100 of the mean colour."""
    out = {k: round(float(a[k]) - float(b[k]), 3) for k in THRESHOLDS}
    out["delta_e"] = round(100 * ((a["L_mean"] - b["L_mean"]) ** 2 + (a["a_mean"] - b["a_mean"]) ** 2
                                  + (a["b_mean"] - b["b_mean"]) ** 2) ** 0.5, 2)
    return out


def _stops(v: float) -> str:
    s = _fixed(abs(v), 1)     # rounded like JavaScript's toFixed, so the Coach and this agree on 0.25 -> "0.3"
    return f"{s} stop" + ("" if s == "1.0" else "s")


def phrase(a_name: str, b_name: str, key: str, d: float) -> str:
    more, less = WORDS[key]
    return f"{a_name} is {_stops(d)} {more if d > 0 else less} than {b_name}"


def check_cut(rows: list, thresholds: dict | None = None) -> list:
    """rows: the cut in order, [{id, name, scene?, stats (graded stats when the shot has a grade)}]. One flag per
    cut that crosses a threshold: {a, b, key, text, deltas, worst}. Cuts between scenes are not judged."""
    th = {**THRESHOLDS, **(thresholds or {})}
    flags = []
    for prev, cur in zip(rows, rows[1:]):
        if not prev.get("stats") or not cur.get("stats") or prev.get("id") == cur.get("id"):
            continue
        if (prev.get("scene") or "") != (cur.get("scene") or ""):
            continue
        d = {k: float(cur["stats"][k]) - float(prev["stats"][k]) for k in th}   # judged unrounded, in both languages
        over = [k for k in th if abs(d[k]) >= th[k]]
        if not over:
            continue
        worst = max(over, key=lambda k: abs(d[k]) / th[k])
        text = "; ".join(phrase(cur.get("name") or cur["id"], prev.get("name") or prev["id"], k, d[k])
                         for k in sorted(over, key=lambda k: -abs(d[k]) / th[k]))
        flags.append({"a": cur["id"], "b": prev["id"], "key": worst, "text": text,
                      "deltas": compare(cur["stats"], prev["stats"])})
    return flags
