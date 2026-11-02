"""The one-click ids the App registers (web/oneclick/{effects,light,angle,expand}.mjs), for the MCP tool's schema and
for clients that ask before an App is open. tests/test_oneclick.py checks this list against the JS sources.
"""
from __future__ import annotations

import json
import os

GROUPS = ("Effects", "Light", "Camera", "Frame", "Loop", "Hand-off")

WORLD = ("nightfall", "flood", "rain", "snow", "fog", "golden_hour")
EFFECTS = WORLD + ("empty", "cutout", "living_photo")
PRACTICAL = ("fx_pop", "fx_inflate", "fx_cake", "fx_squish", "fx_unzip", "fx_gulp")   # experimental practical-FX readings
MOVES = ("orbit_left", "orbit_right", "low_angle", "high_angle", "push_in", "pull_back")
ASPECTS = ("2.39:1", "1.85:1", "16:9", "4:3", "1:1", "9:16")

_HERE = os.path.dirname(os.path.abspath(__file__))
SETUPS_FILE = os.path.join(_HERE, "..", "look", "lighting_setups.json")


def lighting_setups() -> list[dict]:
    with open(SETUPS_FILE, encoding="utf-8") as f:
        return json.load(f).get("setups", [])


def aspect_id(a: str) -> str:
    return "expand_" + a.replace(":", "_").replace(".", "_")


def ids() -> list[str]:
    out = list(EFFECTS) + list(PRACTICAL)
    out += [f"relight_{s['id']}" for s in lighting_setups()]
    out += [f"angle_{m}" for m in MOVES] + [f"exact_{m}" for m in MOVES]
    out += [aspect_id(a) for a in ASPECTS] + ["expand_clip"]
    return out


def describe() -> list[dict]:
    """Plain rows: {id, group} (the App answers the full card: label, hint, cost, whether it applies)."""
    group = {**{i: "Effects" for i in EFFECTS + PRACTICAL}, **{f"relight_{s['id']}": "Light" for s in lighting_setups()}}
    rows = []
    for i in ids():
        g = group.get(i) or ("Camera" if i.startswith(("angle_", "exact_")) else "Frame" if i.startswith("expand_") else "Effects")
        rows.append({"id": i, "group": g})
    return rows
