"""Type-anything objects for the 3D stage.

The stage's built-in library covers common things instantly. For anything else, a local LLM
(Qwen3.5 via core TextGenerate) designs a clay stand-in from simple shapes at real-world scale.
Designs are cached on disk, so each new object is designed once and is instant afterwards.

The design format ("recipe") is deliberately tiny so a 4B model gets it right:
{
  "name": "grand piano", "rig": "static|biped|quadruped|vehicle",
  "size_m": [width, height, depth],
  "parts": [ {"shape": "box|cylinder|sphere|cone|capsule|torus",
              "pos": [x, y, z], "size": [sx, sy, sz], "rot": [rx, ry, rz]} ]
}
Units are metres, Y up, +Z is the object's front, the origin sits on the floor at its centre.
"""
from __future__ import annotations

import json
import os
import re

SYSTEM_PROMPT = """You design low-poly 3D stand-ins for film previsualization.
Return ONLY one JSON object, no prose, no code fences.
Format:
{"name": str, "rig": "static"|"biped"|"quadruped"|"vehicle",
 "size_m": [width, height, depth],
 "parts": [{"shape": "box"|"cylinder"|"sphere"|"cone"|"capsule"|"torus",
            "pos": [x, y, z], "size": [sx, sy, sz], "rot": [rx, ry, rz]}]}
Rules:
- Metres, real-world scale. Y is up. +Z is the front. The origin is on the floor at the centre.
- pos is the CENTRE of the part. size is the full extent (box: w,h,d; cylinder/cone: diameter,height,diameter;
  sphere: diameter x3; capsule: diameter,height,diameter; torus: outer diameter, tube thickness, outer diameter).
- rot is in degrees.
- Use 3 to 14 parts, never more. ONE stretched part per neck, leg, arm, tail or post (a capsule or box
  with a long size), never a stack of small cubes. Capture the silhouette someone would recognise from 10 metres away; skip tiny details.
- Parts must rest on or above the floor (pos.y - size.y/2 >= 0) and touch each other.
- rig: "biped" for people and humanoids, "quadruped" for four-legged animals, "vehicle" for anything that
  drives, rolls or flies, otherwise "static".
- Think about the object's real anatomy: separate legs, necks, heads, tails, wheels, lids, seats, keys.
  Use the most distinctive feature (a giraffe's very long neck, a piano's curved lid and three legs).

Example — Object: dog
{"name":"dog","rig":"quadruped","size_m":[0.3,0.6,0.85],"parts":[
{"shape":"capsule","pos":[0,0.42,0],"size":[0.26,0.62,0.26],"rot":[90,0,0]},
{"shape":"sphere","pos":[0,0.6,0.42],"size":[0.2,0.2,0.24],"rot":[0,0,0]},
{"shape":"capsule","pos":[0,0.55,0.32],"size":[0.1,0.2,0.1],"rot":[-40,0,0]},
{"shape":"capsule","pos":[-0.08,0.15,0.22],"size":[0.07,0.3,0.07],"rot":[0,0,0]},
{"shape":"capsule","pos":[0.08,0.15,0.22],"size":[0.07,0.3,0.07],"rot":[0,0,0]},
{"shape":"capsule","pos":[-0.08,0.15,-0.22],"size":[0.07,0.3,0.07],"rot":[0,0,0]},
{"shape":"capsule","pos":[0.08,0.15,-0.22],"size":[0.07,0.3,0.07],"rot":[0,0,0]},
{"shape":"capsule","pos":[0,0.52,-0.38],"size":[0.04,0.22,0.04],"rot":[50,0,0]}]}

Example — Object: wooden chair
{"name":"wooden chair","rig":"static","size_m":[0.45,0.9,0.45],"parts":[
{"shape":"box","pos":[0,0.45,0],"size":[0.45,0.05,0.45],"rot":[0,0,0]},
{"shape":"box","pos":[0,0.7,-0.2],"size":[0.45,0.45,0.05],"rot":[0,0,0]},
{"shape":"box","pos":[-0.2,0.22,0.2],"size":[0.04,0.45,0.04],"rot":[0,0,0]},
{"shape":"box","pos":[0.2,0.22,0.2],"size":[0.04,0.45,0.04],"rot":[0,0,0]},
{"shape":"box","pos":[-0.2,0.22,-0.2],"size":[0.04,0.45,0.04],"rot":[0,0,0]},
{"shape":"box","pos":[0.2,0.22,-0.2],"size":[0.04,0.45,0.04],"rot":[0,0,0]}]}

Example — Object: sedan car
{"name":"sedan car","rig":"vehicle","size_m":[1.8,1.45,4.6],"parts":[
{"shape":"box","pos":[0,0.6,0],"size":[1.8,0.6,4.6],"rot":[0,0,0]},
{"shape":"box","pos":[0,1.15,-0.2],"size":[1.6,0.55,2.4],"rot":[0,0,0]},
{"shape":"cylinder","pos":[-0.85,0.34,1.45],"size":[0.68,0.22,0.68],"rot":[0,0,90]},
{"shape":"cylinder","pos":[0.85,0.34,1.45],"size":[0.68,0.22,0.68],"rot":[0,0,90]},
{"shape":"cylinder","pos":[-0.85,0.34,-1.45],"size":[0.68,0.22,0.68],"rot":[0,0,90]},
{"shape":"cylinder","pos":[0.85,0.34,-1.45],"size":[0.68,0.22,0.68],"rot":[0,0,90]}]}"""

SHAPES = {"box", "cylinder", "sphere", "cone", "capsule", "torus"}
RIGS = {"static", "biped", "quadruped", "vehicle"}


def cache_dir() -> str:
    try:
        import folder_paths
        base = folder_paths.get_user_directory()
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "..", ".cache")
    path = os.path.join(base, "soundstage", "objects")
    os.makedirs(path, exist_ok=True)
    return path


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60] or "object"


def _num3(v, default):
    try:
        out = [float(x) for x in v][:3]
        return out if len(out) == 3 else default
    except Exception:
        return default


def parse_recipe(text: str, name: str) -> dict | None:
    """Pull the first JSON object out of model output and sanitise it. None if unusable."""
    m = re.search(r"\{.*\}", text or "", re.S)
    raw = None
    if m:
        try:
            raw = json.loads(m.group(0))
        except json.JSONDecodeError:
            # Common small-model slips: trailing commas, single quotes.
            fixed = re.sub(r",\s*([}\]])", r"\1", m.group(0)).replace("'", '"')
            try:
                raw = json.loads(fixed)
            except json.JSONDecodeError:
                raw = None
    if raw is None:
        # Truncated or malformed answer: salvage every complete part object we can find.
        found = []
        for frag in re.findall(r"\{[^{}]*\"shape\"[^{}]*\}", text or ""):
            try:
                found.append(json.loads(frag))
            except json.JSONDecodeError:
                continue
        if not found:
            return None
        rig_m = re.search(r'"rig"\s*:\s*"(\w+)"', text or "")
        raw = {"name": name, "rig": rig_m.group(1) if rig_m else "static", "parts": found}
    parts = []
    for p in raw.get("parts") or []:
        if not isinstance(p, dict):
            continue
        shape = str(p.get("shape", "box")).lower()
        if shape not in SHAPES:
            shape = "box"
        size = [max(0.01, min(60.0, abs(x))) for x in _num3(p.get("size"), [0.5, 0.5, 0.5])]
        pos = [max(-60.0, min(60.0, x)) for x in _num3(p.get("pos"), [0, size[1] / 2, 0])]
        pos[1] = max(pos[1], 0.0)
        rot = [max(-360.0, min(360.0, x)) for x in _num3(p.get("rot"), [0, 0, 0])]
        parts.append({"shape": shape, "pos": pos, "size": size, "rot": rot})
    if not parts:
        return None
    rig = str(raw.get("rig", "static")).lower()
    # Small models often build off-centre or floating: re-centre the footprint on the origin
    # and drop the whole object onto the floor.
    xs = [p["pos"][0] + s * p["size"][0] / 2 for p in parts for s in (-1, 1)]
    ys = [p["pos"][1] + s * p["size"][1] / 2 for p in parts for s in (-1, 1)]
    zs = [p["pos"][2] + s * p["size"][2] / 2 for p in parts for s in (-1, 1)]
    cx, cz, y0 = (max(xs) + min(xs)) / 2, (max(zs) + min(zs)) / 2, min(ys)
    for p in parts:
        p["pos"] = [round(p["pos"][0] - cx, 3), round(p["pos"][1] - y0, 3), round(p["pos"][2] - cz, 3)]
    xs = [x - cx for x in xs]
    zs = [z - cz for z in zs]
    ys = [y - y0 for y in ys]
    return {
        "name": str(raw.get("name") or name)[:60],
        "rig": rig if rig in RIGS else "static",
        "size_m": [round(max(xs) - min(xs), 3), round(max(ys) - max(0.0, min(ys)), 3), round(max(zs) - min(zs), 3)],
        "parts": parts[:24],
    }


def load_cached(name: str) -> dict | None:
    path = os.path.join(cache_dir(), slug(name) + ".json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


def save_cached(name: str, recipe: dict) -> None:
    with open(os.path.join(cache_dir(), slug(name) + ".json"), "w") as f:
        json.dump(recipe, f, indent=1)
