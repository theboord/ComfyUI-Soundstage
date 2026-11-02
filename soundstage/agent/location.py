"""Any set from a sentence: words -> a composed location the stage can build, at real size, in real colours.

Presets (the 20 sets in web/stage/environments.mjs) are quick starts. This module is the general path: it reads a
description ("a cramped 1950s diner at night", "a 6 by 4 metre prison cell", "a medieval throne room", "the inside of
a city bus", "a snowy mountain pass at dawn") and composes

  * the base: a preset when the words name one (reef, train carriage, runway...), else a room at the size the words
    give or the place implies (the stage's interior set, built at environment.room = [w, d, h]), else open ground;
  * the look: floor, wall and ceiling colours for the place and its era (environment.look; the Color pass shows them);
  * the dressing: real-size pieces (booths, a counter, pews, bunks, consoles, headstones...) placed against the walls,
    in rows or scattered, never overlapping each other, the cast or the set, and kept out of the master camera's view
    of the action. Library objects (tables, chairs, cars, trees, rocks, walls...) are used where they fit; anything
    the library lacks is built from simple boxes and cylinders at its real size and colour, and the notes say so;
  * the light: time of day and weather from the words (or what the place implies: a nightclub is at night) plus
    practicals the place would have (pendant lamps, neon, a campfire, a candle chandelier).

Pure Python, like the rest of the agent. Every location actor carries set_dressing=True, so changing the set later
("make it a 1950s diner at night") replaces the old dressing and keeps everything you placed.

    compose(text, current_env=None)  -> location dict (see _empty())
    dress(loc, scene, ids, master)   -> ([actors], [lights], notes)          used by build.build_scene
    relocate(work, text, emit)       -> notes                                used by ops.resolve ({"op": "location"})
    relocation_text(command, scene)  -> the set description in an edit command, or None
"""
from __future__ import annotations

import copy
import math
import re

from . import catalog as C
from . import plan as P
from . import space as S

FT = 0.3048

# ------------------------------------------------------------------------------------------- vocabulary

# Colours (sRGB hex) for surfaces. Names keep the tables below readable.
PAL = {
    "plaster": "#d9d2c5", "white": "#ecebe6", "cream": "#e8dfc8", "grey": "#9a9a98", "concrete": "#8f8d88",
    "dark_concrete": "#5e5d5a", "asphalt": "#4f5054", "brick": "#8a4b38", "stone": "#8c8579", "dark_stone": "#55514b",
    "oak": "#8a6440", "walnut": "#5b3d27", "pine": "#b08a5a", "mahogany": "#5a2a1e", "black": "#1f1f22",
    "chrome": "#c9ccd0", "steel": "#6d747b", "red_vinyl": "#a3222b", "teal": "#2f8f8a", "mint": "#a8dcc4",
    "checker": "#d8d8d4", "linoleum": "#b9b39f", "terrazzo": "#c8c2b5", "carpet_red": "#6e1f25", "carpet_blue": "#2e3b57",
    "carpet_grey": "#585a5e", "green_felt": "#2f5d3a", "chalkboard": "#2b3a30", "hospital": "#cfd8d4",
    "tile_white": "#e6e8e6", "tile_green": "#7fa69a", "gold": "#b8933a", "velvet": "#5a1830", "neon_pink": "#ff3fa4",
    "neon_blue": "#3fb4ff", "grass": "#4d6b34", "dry_grass": "#9b8d55", "dirt": "#7b5b3c", "mud": "#5a4632",
    "sand": "#c9a576", "red_soil": "#9a4b2c", "snow": "#e9edf1", "ice": "#cfe3ea", "rock": "#6f6a62", "moss": "#3f5a31",
    "leaf": "#2d4a2a", "hay": "#c9a94e", "canvas": "#a89a76", "olive": "#5b6040", "navy": "#26324a", "rust": "#8a4a2a",
    "lab_white": "#f0f2f2", "console": "#2c3138", "screen": "#3d6f8f", "hull": "#7d858c", "wood_floor": "#7a5a3d",
    "parquet": "#8f6a43", "marble": "#dcd8d0", "dark_wood": "#4a3424", "bars": "#3b3d40", "fabric_blue": "#27344d",
    "seat_grey": "#4b4f55", "yellow": "#d8b23a", "orange": "#c8662a",
}


def _c(name: str) -> str:
    return PAL.get(name, name if str(name).startswith("#") else PAL["grey"])


# A piece of dressing: name, size [w, h, d] in metres, colour, where it goes, how many (at most), library kind (or
# None: built from primitives), parts (optional: [(shape, [x, y, z] centre, [w, h, d], colour)] for a recognisable
# stand-in instead of a single box).
#   where: back | left | right | sides (alternating side walls) | walls (back then sides) | corner | centre |
#          rows (rows facing the back wall) | aisle_rows (two banks either side of an aisle, facing the back wall) |
#          scatter (around the action, outdoors) | far (well behind the action) | street (along both kerbs)
def piece(name, size, color, where, count=1, kind=None, parts=None, light=None):
    return {"name": name, "size": [float(v) for v in size], "color": _c(color), "where": where, "count": int(count),
            "kind": kind, "parts": parts, "light": light}


def _booth(color="red_vinyl", table="chrome"):
    # A diner booth facing a table: bench seat, tall back, table top on a post. 1.6 x 1.1 x 1.9 m.
    return [("box", [0, 0.22, -0.6], [1.5, 0.45, 0.55], color), ("box", [0, 0.65, -0.86], [1.5, 0.85, 0.12], color),
            ("box", [0, 0.22, 0.6], [1.5, 0.45, 0.55], color), ("box", [0, 0.65, 0.86], [1.5, 0.85, 0.12], color),
            ("box", [0, 0.74, 0], [1.2, 0.04, 0.7], table), ("cylinder", [0, 0.36, 0], [0.08, 0.72, 0.08], "steel")]


def _counter(top="chrome", body="red_vinyl"):
    return [("box", [0, 0.5, 0], [1.0, 1.0, 1.0], body), ("box", [0, 1.04, 0], [1.0, 0.06, 1.0], top)]


PARTS = {
    "booth": _booth(),
    "counter": _counter(),
    "bar counter": _counter("walnut", "dark_wood"),
    "jukebox": [("box", [0, 0.6, 0], [1, 1.2 / 1.6, 1], "#7a2a20"), ("cylinder", [0, 1.35 / 1.6, 0], [1, 0.5 / 1.6, 1], "#d8b23a")],
    "bed": [("box", [0, 0.2, 0], [1, 0.4 / 0.6, 1], "dark_wood"), ("box", [0, 0.48, 0], [0.95, 0.2 / 0.6, 0.95], "white"),
            ("box", [0, 0.7, 0.45], [1, 1.0 / 0.6, 0.06], "dark_wood")],
    "bunk bed": [("box", [0, 0.35, 0], [1, 0.12, 1], "steel"), ("box", [0, 1.45, 0], [1, 0.12, 1], "steel"),
                 ("cylinder", [-0.45, 0.9, -0.45], [0.05, 1, 0.05], "steel"), ("cylinder", [0.45, 0.9, 0.45], [0.05, 1, 0.05], "steel")],
    "pew": [("box", [0, 0.23, 0], [1, 0.45 / 1.0, 0.8], "walnut"), ("box", [0, 0.5, -0.4], [1, 1.0, 0.12], "walnut")],
    "throne": [("box", [0, 0.25, 0], [1, 0.5 / 1.8, 1], "gold"), ("box", [0, 0.9, -0.4], [1, 1.0, 0.2], "velvet")],
    "pillar": [("cylinder", [0, 0.5, 0], [1, 1, 1], "stone")],
    "column": [("cylinder", [0, 0.5, 0], [1, 1, 1], "marble")],
    "pole": [("cylinder", [0, 0.5, 0], [1, 1, 1], "chrome")],
    "console": [("box", [0, 0.4, 0], [1, 0.8 / 1.1, 1], "console"), ("box", [0, 0.95, -0.1], [1, 0.3 / 1.1, 0.6], "screen")],
    "headstone": [("box", [0, 0.5, 0], [1, 1, 1], "stone")],
    "tent": [("cone", [0, 0.5, 0], [1, 1, 1], "canvas")],
    "campfire": [("cylinder", [0, 0.1, 0], [1, 0.2 / 0.4, 1], "dark_stone"), ("cone", [0, 0.6, 0], [0.6, 0.6, 0.6], "orange")],
    "pine tree": [("cylinder", [0, 0.15, 0], [0.08, 0.3, 0.08], "walnut"), ("cone", [0, 0.6, 0], [1, 0.75, 1], "leaf")],
    "hay bale": [("box", [0, 0.5, 0], [1, 1, 1], "hay")],
    "cell bars": [("box", [0, 0.5, 0], [1, 1, 1], "bars")],
    "chandelier": [("cylinder", [0, 0.5, 0], [1, 0.3, 1], "gold")],
}


def _parts_for(name: str, size):
    """Parts in metres for a known piece (the PARTS entries are fractions of the piece's size where noted)."""
    tmpl = PARTS.get(name)
    if not tmpl:
        return None
    w, h, d = size
    out = []
    for shape, pos, sz, col in tmpl:
        # Positions/sizes in PARTS are fractions of the piece's [w, h, d] (y position as a fraction of h).
        out.append({"shape": shape, "pos": [round(pos[0] * w, 3), round(pos[1] * h, 3), round(pos[2] * d, 3)],
                    "size": [round(sz[0] * w, 3), round(sz[1] * h, 3), round(sz[2] * d, 3)], "rot": [0, 0, 0], "color": _c(col)})
    return out


# Locations: (key, trigger words, base, default room [w, d, h] or None, look, pieces, lights, implied time, weather).
#   base: "room" (the interior set at the room size) or a preset set name (open ground uses "empty" with a ground
#   colour). Specific places come before generic ones: the first location whose words appear wins.
L = []


def loc(key, words, base, room, look, pieces, lights=(), time=None, weather=None, label=None, approx=None):
    L.append({"key": key, "words": list(words), "base": base, "room": room, "look": {k: _c(v) for k, v in look.items()},
              "pieces": pieces, "lights": list(lights), "time": time, "weather": weather, "label": label or key.replace("_", " "),
              "approx": approx})


# -- interiors: food & drink
loc("diner", ["diner", "luncheonette", "greasy spoon", "milkshake bar"], "room", (12, 9, 3.2),
    {"floor": "checker", "wall": "cream", "ceiling": "white", "window": "#b9c8d4", "door": "chrome"},
    [piece("booth", (1.6, 1.1, 1.9), "red_vinyl", "left", 4), piece("counter", (5.0, 1.07, 0.7), "chrome", "back"),
     piece("stool", (0.4, 0.75, 0.4), "red_vinyl", "front_of_back", 5), piece("jukebox", (0.9, 1.6, 0.7), "#7a2a20", "corner"),
     piece("pie case", (0.9, 0.6, 0.5), "chrome", "back")],
    lights=["pendant", "pendant", "neon"])
loc("bar", ["bar", "pub", "tavern", "saloon", "speakeasy", "dive bar", "cocktail lounge", "inn"], "room", (10, 8, 3.2),
    {"floor": "walnut", "wall": "#6e4b35", "ceiling": "dark_wood", "door": "walnut"},
    [piece("bar counter", (5.0, 1.1, 0.7), "walnut", "back"), piece("bar stool", (0.4, 0.78, 0.4), "black", "front_of_back", 5),
     piece("back bar shelves", (4.5, 2.2, 0.4), "dark_wood", "back"), piece("table", (0.8, 0.75, 0.8), "walnut", "scatter_in", 3, "table"),
     piece("chair", (0.45, 0.9, 0.45), "walnut", "scatter_in", 4, "chair")],
    lights=["pendant", "practical"], time="night")
loc("restaurant", ["restaurant", "bistro", "trattoria", "dining room", "cafe", "café", "coffee shop"], "room", (12, 10, 3.2),
    {"floor": "parquet", "wall": "cream", "ceiling": "white"},
    [piece("table", (0.9, 0.75, 0.9), "white", "rows_wide", 6, "table"), piece("chair", (0.45, 0.9, 0.45), "walnut", "scatter_in", 6, "chair"),
     piece("counter", (3.5, 1.05, 0.7), "walnut", "back")], lights=["pendant", "pendant"])
loc("kitchen", ["kitchen"], "room", (5, 4, 2.6), {"floor": "tile_white", "wall": "white", "ceiling": "white"},
    [piece("kitchen counter", (3.0, 0.92, 0.62), "white", "back"), piece("fridge", (0.75, 1.8, 0.7), "chrome", "back"),
     piece("stove", (0.76, 0.92, 0.65), "steel", "right"), piece("table", (1.2, 0.75, 0.8), "pine", "centre", 1, "table")],
    lights=["pendant"])
# -- interiors: homes & hotels
loc("bedroom", ["bedroom", "motel room", "hotel room", "dorm room", "bedsit"], "room", (4.5, 4, 2.6),
    {"floor": "carpet_grey", "wall": "plaster", "ceiling": "white"},
    [piece("bed", (1.6, 0.6, 2.1), "white", "back"), piece("nightstand", (0.5, 0.55, 0.4), "oak", "back", 2),
     piece("wardrobe", (1.2, 2.0, 0.6), "oak", "left"), piece("desk", (1.2, 0.75, 0.6), "oak", "right", 1, "table")],
    lights=["practical"])
loc("living_room", ["living room", "lounge", "sitting room", "apartment", "flat", "loft", "den", "parlour", "parlor"], "room",
    (6, 5, 2.7), {"floor": "wood_floor", "wall": "plaster", "ceiling": "white"},
    [piece("sofa", (2.1, 0.85, 0.9), "#5b6b7a", "back"), piece("armchair", (0.9, 0.95, 0.9), "#7a5b4a", "left"),
     piece("coffee table", (1.1, 0.45, 0.6), "oak", "centre_back", 1), piece("bookshelf", (1.2, 2.0, 0.4), "walnut", "right"),
     piece("tv", (1.2, 0.75, 0.3), "black", "right"), piece("rug", (2.5, 0.02, 1.8), "#8a5a4a", "centre_back")],
    lights=["practical"])
loc("hotel_lobby", ["hotel lobby", "lobby", "reception"], "room", (16, 12, 5),
    {"floor": "marble", "wall": "cream", "ceiling": "white"},
    [piece("reception desk", (4.0, 1.1, 0.8), "walnut", "back"), piece("column", (0.7, 5.0, 0.7), "marble", "pillars", 4),
     piece("sofa", (2.1, 0.85, 0.9), "velvet", "scatter_in", 2), piece("plant pot", (0.5, 1.4, 0.5), "leaf", "corner", 2)],
    lights=["chandelier"])
loc("mansion", ["mansion", "manor", "ballroom", "grand hall", "stately home"], "room", (18, 14, 6),
    {"floor": "parquet", "wall": "#c9b48a", "ceiling": "cream"},
    [piece("fireplace", (2.0, 1.4, 0.6), "marble", "back"), piece("column", (0.8, 6.0, 0.8), "marble", "pillars", 4),
     piece("sofa", (2.1, 0.85, 0.9), "velvet", "scatter_in", 2), piece("grand piano", (1.5, 1.0, 2.0), "black", "corner")],
    lights=["chandelier"])
# -- interiors: work & public
loc("office", ["office", "precinct", "newsroom", "cubicle", "study", "detective agency"], "room", (6, 5, 2.8),
    {"floor": "carpet_grey", "wall": "plaster", "ceiling": "white", "door": "oak"},
    [piece("desk", (1.6, 0.75, 0.8), "walnut", "centre_back", 1, "table"), piece("filing cabinet", (0.5, 1.3, 0.6), "steel", "left", 2),
     piece("bookshelf", (1.2, 2.0, 0.4), "walnut", "back"), piece("coat rack", (0.5, 1.8, 0.5), "walnut", "corner")],
    lights=["practical"])
loc("classroom", ["classroom", "school room", "lecture room", "schoolroom"], "room", (9, 8, 3.0),
    {"floor": "linoleum", "wall": "#d8d3b8", "ceiling": "white"},
    [piece("chalkboard", (4.0, 1.2, 0.08), "chalkboard", "back_high"), piece("teacher's desk", (1.4, 0.75, 0.7), "oak", "front_of_back", 1, "table"),
     piece("school desk", (0.7, 0.75, 0.5), "pine", "rows", 12)], lights=["fluorescent"])
loc("hospital", ["hospital", "hospital room", "ward", "clinic", "emergency room", "operating room", "infirmary"], "room", (6, 5, 2.8),
    {"floor": "hospital", "wall": "#dfe7e3", "ceiling": "white"},
    [piece("hospital bed", (1.0, 0.7, 2.1), "white", "back"), piece("monitor stand", (0.5, 1.6, 0.5), "steel", "back"),
     piece("curtain screen", (2.4, 2.0, 0.08), "#9fc4c0", "left"), piece("chair", (0.45, 0.9, 0.45), "steel", "right", 1, "chair")],
    lights=["fluorescent"])
loc("courtroom", ["courtroom", "court room", "court"], "room", (14, 16, 5),
    {"floor": "walnut", "wall": "#b89c74", "ceiling": "cream"},
    [piece("judge's bench", (3.5, 1.4, 1.0), "walnut", "back"), piece("witness stand", (1.2, 1.1, 1.0), "walnut", "back"),
     piece("counsel table", (2.4, 0.75, 0.9), "walnut", "rows_wide", 2), piece("pew", (3.0, 1.0, 0.6), "walnut", "rows_front", 4)],
    lights=["fluorescent"])
loc("library", ["library", "archive", "bookshop", "bookstore"], "room", (12, 10, 3.6),
    {"floor": "parquet", "wall": "#b8a27c", "ceiling": "cream"},
    [piece("bookshelf", (2.4, 2.4, 0.45), "walnut", "walls", 6), piece("reading table", (2.4, 0.75, 1.0), "walnut", "rows_wide", 2, "table"),
     piece("chair", (0.45, 0.9, 0.45), "walnut", "scatter_in", 4, "chair")], lights=["practical", "practical"])
loc("church", ["church", "chapel", "cathedral", "temple interior"], "room", (14, 28, 9),
    {"floor": "stone", "wall": "#cfc6b4", "ceiling": "#b9b0a0"},
    [piece("altar", (2.5, 1.0, 1.0), "marble", "back"), piece("pew", (3.2, 1.0, 0.8), "walnut", "aisle_rows", 12),
     piece("column", (0.9, 9.0, 0.9), "stone", "pillars", 4)], lights=["candles"])
loc("warehouse", ["warehouse", "factory", "hangar", "depot", "workshop", "garage", "loading dock"], "room", (30, 24, 8),
    {"floor": "concrete", "wall": "#7d7a72", "ceiling": "dark_concrete"},
    [piece("crate", (1.2, 1.2, 1.2), "pine", "stacks", 8, "crate"), piece("pallet rack", (2.8, 4.0, 1.1), "#3f5f8f", "walls", 6),
     piece("forklift", (1.2, 2.1, 2.4), "yellow", "scatter_in")], lights=["fluorescent"])
loc("parking_garage", ["parking garage", "car park", "parking structure", "underground garage"], "room", (30, 24, 2.7),
    {"floor": "dark_concrete", "wall": "concrete", "ceiling": "concrete"},
    [piece("column", (0.6, 2.7, 0.6), "concrete", "pillars", 6), piece("car", (1.8, 1.45, 4.5), "#5a6470", "park_rows", 6, "car")],
    lights=["fluorescent"], time="night")
loc("gym", ["gym", "gymnasium", "boxing gym", "boxing ring", "locker room", "dojo"], "room", (20, 16, 6),
    {"floor": "#b98d5a", "wall": "#c9c2b0", "ceiling": "dark_concrete"},
    [piece("boxing ring", (6.0, 1.3, 6.0), "#2e5a8a", "centre_back"), piece("punching bag", (0.4, 1.6, 0.4), "red_vinyl", "left", 3),
     piece("bench", (1.8, 0.85, 0.5), "steel", "right", 2, "bench")], lights=["fluorescent"])
loc("nightclub", ["nightclub", "night club", "disco", "dance club", "rave", "club"], "room", (16, 14, 4.5),
    {"floor": "black", "wall": "#1c1a24", "ceiling": "black"},
    [piece("dj booth", (2.5, 1.1, 1.0), "black", "back"), piece("bar counter", (5.0, 1.1, 0.7), "black", "left"),
     piece("speaker stack", (0.8, 2.0, 0.6), "black", "back", 2)], lights=["neon", "neon", "spot"], time="night")
loc("lab", ["lab", "laboratory", "research station"], "room", (10, 8, 3.0),
    {"floor": "lab_white", "wall": "lab_white", "ceiling": "white"},
    [piece("lab bench", (2.4, 0.92, 0.8), "lab_white", "rows_wide", 3), piece("fume hood", (1.5, 2.2, 0.8), "steel", "back", 2),
     piece("server rack", (0.6, 2.0, 1.0), "black", "left", 2)], lights=["fluorescent"])
loc("store", ["convenience store", "corner shop", "grocery store", "supermarket", "shop interior", "pharmacy", "laundromat", "store"],
    "room", (12, 10, 3.2), {"floor": "linoleum", "wall": "white", "ceiling": "white"},
    [piece("shelf aisle", (4.0, 1.8, 0.9), "white", "rows_wide", 4), piece("checkout counter", (2.0, 1.0, 0.8), "white", "front_left")],
    lights=["fluorescent"])
loc("jail", ["jail cell", "prison cell", "cell block", "jail", "prison", "holding cell", "dungeon"], "room", (4, 3, 2.6),
    {"floor": "dark_concrete", "wall": "concrete", "ceiling": "concrete"},
    [piece("bunk bed", (0.9, 1.6, 2.0), "steel", "left"), piece("toilet", (0.4, 0.45, 0.65), "steel", "back"),
     piece("cell bars", (3.6, 2.4, 0.08), "bars", "front_bars")], lights=["fluorescent"])
loc("interrogation", ["interrogation room", "interrogation", "interview room"], "room", (4, 4, 2.7),
    {"floor": "dark_concrete", "wall": "#8e928c", "ceiling": "concrete"},
    [piece("one-way mirror", (2.0, 1.2, 0.06), "#3a4246", "back_high"), piece("table", (1.4, 0.75, 0.8), "steel", "centre", 1, "table")],
    lights=["spot"])
loc("elevator", ["elevator", "lift car"], "room", (2.0, 2.0, 2.6), {"floor": "#5a5a5a", "wall": "chrome", "ceiling": "steel"},
    [piece("handrail", (1.8, 0.05, 0.05), "chrome", "back_high")], lights=["fluorescent"])
# -- interiors: period & fantasy
loc("throne_room", ["throne room", "great hall", "castle hall", "castle", "palace", "banquet hall", "keep"], "room", (14, 24, 8),
    {"floor": "stone", "wall": "dark_stone", "ceiling": "dark_wood"},
    [piece("throne", (1.2, 1.8, 1.0), "gold", "back"), piece("banner", (1.2, 3.0, 0.05), "velvet", "sides_high", 4),
     piece("pillar", (1.0, 8.0, 1.0), "stone", "pillars", 6), piece("long table", (6.0, 0.75, 1.2), "dark_wood", "centre_back")],
    lights=["candles", "candles"])
loc("cabin", ["log cabin", "cabin interior", "hut", "farmhouse kitchen", "cottage"], "room", (6, 5, 2.6),
    {"floor": "pine", "wall": "#8a6440", "ceiling": "#6b4a30"},
    [piece("fireplace", (1.6, 1.2, 0.6), "stone", "back"), piece("table", (1.4, 0.75, 0.8), "pine", "centre_back", 1, "table"),
     piece("chair", (0.45, 0.9, 0.45), "pine", "scatter_in", 2, "chair"), piece("bed", (1.4, 0.6, 2.0), "canvas", "left")],
    lights=["fire_glow"])
loc("cave", ["cave", "cavern", "grotto", "mine shaft", "mine"], "room", (14, 16, 5),
    {"floor": "rock", "wall": "dark_stone", "ceiling": "dark_stone"},
    [piece("rock", (1.4, 0.8, 1.1), "rock", "scatter_in", 6, "rock"), piece("stalagmite", (0.6, 1.8, 0.6), "rock", "scatter_in", 4)],
    lights=["fire_glow"], approx="cave walls are flat rock-coloured walls")
# -- interiors: vehicles (the airliner and train carriage are presets; these are rooms at the vehicle's size)
loc("bus", ["inside a bus", "bus interior", "city bus", "school bus", "on a bus", "on the bus", "coach interior", "bus"], "room",
    (2.5, 11, 2.3), {"floor": "#3d3f42", "wall": "#c9ccc6", "ceiling": "#d8d8d2"},
    [piece("bus seat", (0.95, 1.05, 0.55), "fabric_blue", "aisle_rows", 16), piece("pole", (0.05, 2.3, 0.05), "chrome", "aisle_poles", 4)],
    lights=["fluorescent"], approx="the bus is a 2.5 x 11 m room with seat rows; no windows open onto a street")
loc("subway_car", ["subway car", "subway train", "metro car", "tube train", "underground train", "subway", "metro"], "room",
    (2.8, 16, 2.3), {"floor": "#4a4b4d", "wall": "#c4c8c8", "ceiling": "#d9d9d6"},
    [piece("bench seat", (0.5, 0.9, 3.0), "orange", "long_benches", 4), piece("pole", (0.05, 2.3, 0.05), "chrome", "aisle_poles", 5)],
    lights=["fluorescent"], approx="the subway car is a 2.8 x 16 m room with side benches")
loc("spaceship", ["spaceship", "starship", "space station", "bridge of a ship", "starship bridge", "cockpit", "space shuttle"], "room",
    (10, 8, 3.2), {"floor": "#3a3f46", "wall": "hull", "ceiling": "#5a6168"},
    [piece("console", (2.0, 1.1, 0.8), "console", "walls", 4), piece("captain's chair", (0.8, 1.2, 0.8), "black", "centre_back")],
    lights=["neon", "practical"])
loc("ship_cabin", ["ship's cabin", "submarine", "below deck", "galley"], "room", (5, 4, 2.2),
    {"floor": "dark_wood", "wall": "hull", "ceiling": "#5a6168"},
    [piece("bunk bed", (0.9, 1.6, 2.0), "steel", "left"), piece("table", (1.0, 0.75, 0.7), "dark_wood", "right", 1, "table")],
    lights=["practical"])
loc("car_interior", ["inside a car", "car interior", "in the car", "front seat", "back seat", "driving at night", "in a car"],
    "street_night", None, {},
    [piece("car", (1.8, 1.45, 4.5), "#4a5562", "centre", 1, "car")], lights=[],
    approx="a car interior is the car model with the camera inside it (Camera: hood, driver POV, back seat views)")
# -- exteriors (ground colour + pieces on open ground or a preset)
loc("farm", ["farm", "farmyard", "barnyard", "ranch", "barn"], "empty", None, {"floor": "dry_grass"},
    [piece("barn", (10.0, 7.0, 8.0), "#8a2e24", "far"), piece("fence", (6.0, 1.2, 0.2), "pine", "far_line", 3, "wall"),
     piece("hay bale", (1.2, 0.9, 0.9), "hay", "scatter", 4), piece("truck", (2.3, 2.6, 6.5), "#6a3a2a", "scatter", 1, "truck")])
loc("cemetery", ["cemetery", "graveyard", "churchyard", "burial ground"], "empty", None, {"floor": "grass"},
    [piece("headstone", (0.6, 0.9, 0.2), "stone", "grid", 12), piece("tree", (1.2, 6.5, 1.2), "leaf", "far", 2, "tree"),
     piece("iron fence", (6.0, 1.6, 0.1), "black", "far_line", 3, "wall")], weather="fog")
loc("campsite", ["campsite", "camp site", "campground", "campfire", "camping", "bivouac"], "forest", None, {},
    [piece("tent", (2.2, 1.4, 2.4), "canvas", "scatter", 2), piece("campfire", (0.8, 0.4, 0.8), "dark_stone", "centre_front"),
     piece("log", (2.0, 0.4, 0.4), "walnut", "scatter", 2)], lights=["fire_glow"], time="night")
loc("mountain", ["mountain", "mountain pass", "summit", "peak", "glacier", "tundra", "arctic", "antarctic", "snowfield", "ski slope"],
    "desert", None, {"floor": "snow", "dune": "#dfe5ea"},
    [piece("rock", (1.4, 0.8, 1.1), "rock", "scatter", 6, "rock"), piece("pine tree", (2.5, 7.0, 2.5), "leaf", "far", 4)],
    weather="snow", approx="mountains are the desert's dunes, snow-coloured")
loc("mars", ["mars", "martian", "alien planet", "red planet", "moon surface", "lunar", "on the moon", "alien world"], "desert", None,
    {"floor": "red_soil", "dune": "#a4552f"},
    [piece("rock", (1.4, 0.8, 1.1), "#6a3322", "scatter", 8, "rock"), piece("habitat module", (6.0, 3.0, 6.0), "white", "far")],
    approx="another planet is the desert, re-coloured; the sky and gravity stay Earth's")
loc("jungle", ["jungle", "rainforest", "jungle temple", "swamp", "bayou", "marsh"], "forest", None, {},
    [piece("bush", (1.3, 1.1, 1.3), "leaf", "scatter", 6, "bush"), piece("ruined wall", (6.0, 2.4, 0.5), "moss", "far", 2, "wall")],
    weather="fog")
loc("meadow", ["meadow", "field", "prairie", "hillside", "countryside", "pasture", "park"], "empty", None, {"floor": "grass"},
    [piece("tree", (1.2, 6.5, 1.2), "leaf", "far", 3, "tree"), piece("bush", (1.3, 1.1, 1.3), "leaf", "scatter", 3, "bush")])
loc("battlefield", ["battlefield", "trench", "trenches", "war zone", "no man's land", "front line", "bunker"], "empty", None,
    {"floor": "mud"},
    [piece("sandbag wall", (3.0, 1.0, 0.6), "canvas", "far_line", 3), piece("crater", (3.0, 0.2, 3.0), "dark_stone", "scatter", 2),
     piece("barbed wire", (4.0, 0.9, 0.3), "steel", "scatter", 2)], weather="smoke")
loc("gas_station", ["gas station", "petrol station", "service station", "truck stop"], "empty", None, {"floor": "asphalt"},
    [piece("canopy", (10.0, 4.5, 6.0), "white", "far"), piece("fuel pump", (0.8, 1.8, 0.6), "red_vinyl", "far_row", 3),
     piece("car", (1.8, 1.45, 4.5), "#5a6470", "scatter", 1, "car")])
loc("parking_lot", ["parking lot", "car lot", "lot behind"], "empty", None, {"floor": "asphalt"},
    [piece("car", (1.8, 1.45, 4.5), "#5a6470", "park_rows", 5, "car"), piece("lamp", (0.3, 4.2, 0.6), "steel", "far", 2, "lamp")])
loc("rooftop", ["rooftop", "roof top", "on the roof", "roof"], "empty", None, {"floor": "dark_concrete"},
    [piece("parapet", (6.0, 1.0, 0.3), "concrete", "far_line", 3), piece("ac unit", (1.2, 1.0, 1.0), "steel", "scatter", 2),
     piece("water tower", (3.0, 6.0, 3.0), "rust", "far")])
loc("market", ["market", "bazaar", "souk", "street market", "night market", "flea market"], "street_night", None, {},
    [piece("market stall", (2.5, 2.4, 1.8), "canvas", "street", 6)], lights=["practical", "practical"])
loc("alley", ["alley", "alleyway", "back alley", "side street"], "street_night", None, {},
    [piece("dumpster", (2.0, 1.4, 1.2), "#2f5a3a", "street", 2), piece("crate", (0.8, 0.8, 0.8), "pine", "street", 3, "crate"),
     piece("fire escape", (3.0, 4.0, 0.8), "black", "street", 1)], time="night")
loc("dock", ["harbour", "harbor", "port", "pier", "wharf", "docks", "boardwalk", "marina"], "lake", None, {},
    [piece("crate", (1.2, 1.2, 1.2), "pine", "scatter", 3, "crate"), piece("bollard", (0.4, 0.6, 0.4), "black", "scatter", 3)])
loc("ship_deck", ["ship deck", "deck of a ship", "on deck", "pirate ship", "aboard a ship", "boat deck"], "open_water", None, {},
    [piece("mast", (0.5, 12.0, 0.5), "walnut", "centre_back"), piece("barrel", (0.6, 0.9, 0.6), "walnut", "scatter", 4, "crate")],
    approx="the deck is the open-water set with a mast and barrels; there is no hull under them")
loc("city_street", ["main street", "high street", "downtown street", "city street", "street corner", "avenue", "boulevard"],
    "street_night", None, {}, [piece("car", (1.8, 1.45, 4.5), "#5a6470", "street", 2, "car"), piece("fire hydrant", (0.4, 0.8, 0.4), "red_vinyl", "street", 1),
                               piece("phone booth", (1.0, 2.3, 1.0), "red_vinyl", "street", 1)])
loc("western_town", ["western town", "frontier town", "wild west", "old west", "ghost town", "western street", "dusty western street"],
    "street_night", None, {},
    [piece("hitching post", (2.5, 1.0, 0.2), "walnut", "street", 2), piece("water trough", (2.0, 0.6, 0.6), "walnut", "street", 1),
     piece("wagon", (1.8, 2.2, 4.0), "walnut", "street", 1)], time="midday")
loc("suburb", ["suburb", "suburban street", "front yard", "backyard", "cul-de-sac", "driveway", "neighbourhood", "neighborhood"],
    "empty", None, {"floor": "grass"},
    [piece("house", (8.0, 6.0, 7.0), "cream", "far_row", 2, "house"), piece("tree", (1.2, 6.5, 1.2), "leaf", "scatter", 2, "tree"),
     piece("mailbox", (0.5, 1.1, 0.5), "black", "scatter"), piece("car", (1.8, 1.45, 4.5), "#7a2a2a", "scatter", 1, "car")])
loc("airport_terminal", ["airport terminal", "terminal", "departure lounge", "gate area", "airport"], "room", (24, 16, 5),
    {"floor": "terrazzo", "wall": "#d6d8d8", "ceiling": "white"},
    [piece("bench seat", (3.0, 0.8, 0.6), "seat_grey", "rows_wide", 4), piece("check-in desk", (3.0, 1.1, 0.8), "white", "back", 2)],
    lights=["fluorescent"])

# Eras and styles: colour overrides and a piece or two the period would add (only where the place is a room).
ERAS = [
    ("1920s", ["1920s", "20s", "twenties", "roaring twenties", "prohibition", "art deco", "speakeasy", "gatsby"],
     {"wall": "#3d2b22", "floor": "#2d2522"}, [piece("gramophone", (0.5, 1.0, 0.5), "gold", "corner")], ["chandelier"]),
    ("1950s", ["1950s", "50s", "fifties", "rockabilly", "googie", "atomic age", "1955", "1957", "1959"],
     {"wall": "mint", "floor": "checker"}, [piece("jukebox", (0.9, 1.6, 0.7), "#7a2a20", "corner")], ["neon"]),
    ("1970s", ["1970s", "70s", "seventies", "disco era"], {"wall": "#b5793a", "floor": "#6a4a2a"}, [], []),
    ("1980s", ["1980s", "80s", "eighties", "synthwave", "arcade"], {"wall": "#2a2440", "floor": "#1c1a24"},
     [piece("arcade cabinet", (0.7, 1.8, 0.8), "#2a2440", "back", 2)], ["neon"]),
    ("victorian", ["victorian", "1800s", "19th century", "edwardian", "regency", "dickensian", "steampunk"],
     {"wall": "#5a2f2f", "floor": "parquet"}, [piece("fireplace", (1.6, 1.2, 0.5), "marble", "back")], ["candles"]),
    ("medieval", ["medieval", "middle ages", "viking", "dark ages", "fantasy tavern", "knights"],
     {"wall": "dark_stone", "floor": "stone", "ceiling": "dark_wood"}, [], ["candles"]),
    ("western", ["western", "wild west", "old west", "frontier", "cowboy", "1880s", "saloon"], {"wall": "#8a6440", "floor": "pine"}, [], []),
    ("futuristic", ["futuristic", "sci-fi", "scifi", "science fiction", "cyberpunk", "space age", "in the future", "2077", "2099"],
     {"wall": "#2c3138", "floor": "#1f2328", "ceiling": "#3a4048"}, [], ["neon"]),
    ("modern", ["modern", "contemporary", "minimalist", "minimal"], {"wall": "white", "floor": "#bfb8ad"}, [], []),
    ("abandoned", ["abandoned", "derelict", "ruined", "decrepit", "run-down", "rundown", "dilapidated"],
     {"wall": "#6f6a60", "floor": "#4f4a42"}, [piece("debris", (1.2, 0.3, 1.0), "dark_stone", "scatter_in", 3)], []),
]

SIZE_WORDS = [(0.6, ["tiny", "cramped", "claustrophobic", "poky", "closet-sized"]), (0.8, ["small", "little", "narrow", "cosy", "cozy"]),
              (1.4, ["large", "big", "spacious", "wide", "roomy"]), (2.0, ["huge", "vast", "enormous", "massive", "grand", "cavernous", "giant"])]

# Practical lights a place has, as stage film lights: (type, kelvin, intensity, height, where, label).
PRACTICALS = {
    "pendant": ("practical", 2900, 1.3, None, "ceiling", "Pendant lamp"),
    "fluorescent": ("practical", 4300, 1.6, None, "ceiling", "Fluorescent panel"),
    "chandelier": ("practical", 2700, 1.8, None, "ceiling", "Chandelier"),
    "candles": ("practical", 1900, 0.9, 2.2, "walls", "Candles"),
    "neon": ("neon", 12000, 1.6, 2.4, "back", "Neon sign"),
    "spot": ("spot", 3200, 4.0, None, "ceiling", "Overhead spot"),
    "practical": ("practical", 2700, 1.4, 1.4, "near", "Lamp"),
    "fire_glow": ("practical", 1800, 1.6, 0.6, "fire", "Firelight"),
}

NUMWORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
            "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "a hundred": 100}


def _has(t: str, w: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])", t) is not None


# ------------------------------------------------------------------------------------------- reading the words

_UNIT = r"(?:m|metres?|meters?|ft|foot|feet|'|yd|yards?)"
_DIM = re.compile(rf"(\d+(?:\.\d+)?)\s*({_UNIT})?\s*(?:x|×|by|\*)\s*(\d+(?:\.\d+)?)\s*({_UNIT})?(?:\s*(?:x|×|by|\*)\s*(\d+(?:\.\d+)?)\s*({_UNIT})?)?",
                  re.I)


def _to_m(v: float, unit: str | None) -> float:
    u = (unit or "").lower()
    if u in ("ft", "foot", "feet", "'"):
        return v * FT
    if u.startswith("yd") or u.startswith("yard"):
        return v * 0.9144
    return v


def parse_room(text: str) -> tuple[list[float] | None, float | None]:
    """'a 6 by 4 metre cell', '30x20 ft warehouse', '12 x 8 x 4 m' -> ([w, d], h or None) in metres."""
    t = (text or "").lower()
    for word, n in NUMWORDS.items():
        t = re.sub(rf"\b{word}\b(?=\s*(?:-|\s)?(?:{_UNIT[3:-1]}|by|x)\b)", str(n), t)
    m = _DIM.search(t)
    dims = None
    if m:
        a, ua, b, ub, c, uc = m.groups()
        unit = uc or ub or ua
        w, d = _to_m(float(a), ua or unit), _to_m(float(b), ub or unit)
        if w > 0 and d > 0:
            dims = [round(w, 2), round(d, 2)]
            if c:
                return dims, round(_to_m(float(c), uc or unit), 2)
    h = None
    mh = re.search(rf"(\d+(?:\.\d+)?)\s*({_UNIT})?[\s-]*(?:high|tall)?\s*ceilings?", t) or \
        re.search(rf"ceilings?\D{{0,12}}(\d+(?:\.\d+)?)\s*({_UNIT})?", t)
    if mh:
        h = round(_to_m(float(mh.group(1)), mh.group(2)), 2)
    elif re.search(r"\b(high|vaulted|soaring|double[- ]height|tall) ceilings?\b", t):
        h = -1.6  # a factor, applied to the default height
    elif re.search(r"\blow ceilings?\b", t):
        h = -0.85
    return dims, h


def _era(t: str):
    for name, words, look, pieces, lights in ERAS:
        if any(_has(t, w) for w in words):
            return {"name": name, "look": {k: _c(v) for k, v in look.items()}, "pieces": pieces, "lights": lights}
    return None


def _find_location(t: str):
    """The location whose longest trigger phrase appears in the text (ties: the earlier, more specific entry)."""
    best = None
    for i, spec in enumerate(L):
        for w in spec["words"]:
            if _has(t, w) and (best is None or len(w) > best[1]):
                best = (spec, len(w), w, i)
    if not best:
        return None
    spec = dict(best[0])
    spec["said"] = best[2]
    return spec


def _empty() -> dict:
    return {"set": "empty", "key": "empty", "room": None, "look": {}, "label": "", "era": "", "source": "none",
            "pieces": [], "lights": [], "time": None, "weather": None, "approximations": [], "said": "", "known": False}


def compose(text: str, current_env: dict | None = None) -> dict:
    """Words -> a location: which set to build on (a preset or a sized room), its look, dressing and light.

    known=False means the words name no place and no era (the caller keeps whatever set it has)."""
    t = " " + re.sub(r"\s+", " ", (text or "").lower()) + " "
    # "outside a diner", "in front of the church": the exterior of a building, not its interior.
    t = P.outside_of_room(t)
    out = _empty()
    out["said"] = (text or "").strip()[:200]
    spec = _find_location(t)
    era = _era(t)
    preset = None
    hit = next((k for k, words in C.SET_WORDS if any(_has(t, w) for w in words)), None)
    # A preset wins when its words are more specific than the location's (a "train carriage", a "reef", a "runway").
    if hit and hit not in ("interior", "street_night", "plaza", "empty", "studio"):
        sw = max((len(w) for k, words in C.SET_WORDS if k == hit for w in words if _has(t, w)), default=0)
        lw = max((len(w) for w in (spec or {}).get("words", []) if _has(t, w)), default=0)
        if not spec or sw >= lw:
            preset, spec = hit, None
    if hit in ("studio",) and not spec:
        preset = "studio"
    dims, ceil = parse_room(t)
    if spec is None and preset is None:
        if dims or re.search(r"\b(room|interior|inside|indoors|int\.)\b", t):
            spec = {"key": "room", "words": [], "base": "room", "room": (6, 5, 2.7), "look": {"floor": _c("wood_floor"),
                    "wall": _c("plaster"), "ceiling": _c("white")}, "pieces": [], "lights": ["practical"], "time": None,
                    "weather": None, "label": "room"}
        elif hit:
            preset = hit
        elif era and current_env:
            # "make it 1920s": restyle the place we're in.
            cur = (current_env.get("location") or {}).get("place") or ""
            spec = next((s for s in L if s["key"] == cur), None)
            if spec is None:
                key = C.set_key(current_env) or "empty"
                preset = C.base_set(key)
                if preset == "interior":
                    preset = None
                    spec = {"key": "room", "words": [], "base": "room", "room": tuple(C.set_room(key) or C.DEFAULT_ROOM),
                            "look": {}, "pieces": [], "lights": [], "time": None, "weather": None, "label": "room"}
    if spec is None and preset is None:
        out["era"] = era["name"] if era else ""
        return out
    out["known"] = True
    approx: list[str] = []
    look = {}
    pieces = []
    lights = []
    if preset:
        out["set"] = out["key"] = preset
        out["label"] = C.SETS[preset]["label"]
        out["source"] = f"preset:{preset}"
        if C.SETS[preset]["interior"] and preset in ("interior",):
            out["room"] = list(C.DEFAULT_ROOM)
    else:
        out["source"] = "composed"
        out["place"] = spec["key"]
        out["label"] = spec.get("said") or spec["label"]
        look = dict(spec["look"])
        pieces = [dict(p) for p in spec["pieces"]]
        lights = list(spec["lights"])
        out["time"], out["weather"] = spec["time"], spec["weather"]
        if spec.get("approx"):
            approx.append(spec["approx"])
        if spec["base"] == "room":
            w, d, h = spec["room"]
            k = next((f for f, words in SIZE_WORDS if any(_has(t, x) for x in words)), 1.0)
            if dims:
                # Width (across the frame) x depth, in the order the words gave; a smaller room gets a lower ceiling.
                area0 = spec["room"][0] * spec["room"][1]
                h = max(min(h, 3.0), h * math.sqrt(dims[0] * dims[1] / area0)) if dims[0] * dims[1] < area0 else h
                w, d = dims
            else:
                w, d = w * k, d * k
                h = h * (1 + (k - 1) * 0.5)
            if ceil is not None:
                h = ceil if ceil > 0 else h * -ceil
            room = C.clamp_room((w, d, h))
            if dims and (room[0], room[1]) != (round(dims[0], 2), round(dims[1], 2)):
                approx.append(f"asked for {dims[0]:g} x {dims[1]:g} m; the stage builds rooms {C.ROOM_LIMITS[0][0]:g}-"
                              f"{C.ROOM_LIMITS[0][1]:g} m wide and up to {C.ROOM_LIMITS[1][1]:g} m deep, so it is {room[0]:g} x {room[1]:g} m")
            out["room"] = list(room)
            out["set"] = "interior"
            out["key"] = C.room_set(room)
        else:
            out["set"] = out["key"] = spec["base"]
    if era:
        out["era"] = era["name"]
        if out["set"] == "interior":
            look.update(era["look"])
            names = {p["name"] for p in pieces}
            pieces += [dict(p) for p in era["pieces"] if p["name"] not in names]
            lights += [x for x in era["lights"] if x not in lights]
        if out["label"] and era["name"] not in out["label"] and not preset:
            out["label"] = f"{era['name']} {out['label']}"
    out["look"] = look
    out["pieces"] = pieces
    out["lights"] = lights
    tm = next((k for k, words in C.TIME_WORDS if any(_has(t, w) for w in words)), None)
    wx = next((k for k, words in C.WEATHER_WORDS if any(_has(t, w) for w in words)), None)
    out["time"] = tm or out["time"]
    out["weather"] = wx or out["weather"]
    out["approximations"] = approx
    return out


# ------------------------------------------------------------------------------------------- placing the dressing

def _actor(p: dict, ids: set, n: int) -> dict:
    """A stage actor for a piece: a library object in the piece's colour, or primitives at its real size."""
    from .build import make_object, slug

    w, h, d = p["size"]
    kind = p.get("kind") if p.get("kind") in C.LIBRARY else None
    if kind:
        o = make_object(kind, ids, kind=kind, label=p["name"].title() + (f" {n}" if n > 1 else ""))
        o["height_m"] = round(h, 2)
        o["appearance"] = {"color": p["color"]}
    else:
        base = slug(p["name"])
        oid, k = base, 2
        while oid in ids:
            oid, k = f"{base}_{k}", k + 1
        ids.add(oid)
        parts = _parts_for(p["name"], [w, h, d]) if p.get("parts") is None else p["parts"]
        approx = not parts
        parts = parts or [{"shape": "box", "pos": [0, round(h / 2, 3), 0], "size": [w, h, d], "rot": [0, 0, 0], "color": p["color"]}]
        recipe = {"name": p["name"], "rig": "static", "size_m": [w, h, d], "parts": parts, "color": p["color"]}
        if approx:
            recipe["placeholder"] = True  # one box: the object designer may refine it (pending_designs)
        o = {"id": oid, "name": p["name"].title() + (f" {n}" if n > 1 else ""), "kind": "custom", "recipe": recipe,
             "design": p["name"], "position": [0, 0, 0], "keys": [], "height_m": round(h, 2), "rotation_deg": 0}
    o["set_dressing"] = True
    return o


def _put(o: dict, pos, rot=None):
    o["position"] = [round(float(pos[0]), 2), 0.0, round(float(pos[2] if len(pos) == 3 else pos[1]), 2)]
    if rot is not None:
        o["rotation_deg"] = round(float(rot), 1)
    o["keys"] = [{"frame": 0, "position": list(o["position"])}]


def _wants(p: dict, i: int, n: int, key: str, focus, size) -> list[tuple[float, float, float]]:
    """Candidate (x, z, rotation) spots for the i-th of n copies of a piece."""
    x0, x1, z0, z1 = S.set_def(key)["bounds"]
    w, _, d = size
    cx, cz = focus
    W, D = x1 - x0, z1 - z0
    where = p["where"]
    frac = (i + 0.5) / max(n, 1)
    if where in ("back", "back_high", "walls") and (where != "walls" or i % 3 == 0):
        return [(x0 + d * 0 + W * frac if n > 1 else (x0 + x1) / 2 + (W * 0.2 if i else 0), z1 - d / 2, 180)]
    if where in ("left", "sides", "sides_high", "walls") and (where in ("left",) or i % 2 == (0 if where != "walls" else 1)):
        return [(x1 - d / 2, z0 + D * (0.3 + 0.6 * frac) if n > 1 else cz + 1.5, -90)]
    if where in ("right", "sides", "sides_high", "walls"):
        return [(x0 + d / 2, z0 + D * (0.3 + 0.6 * frac) if n > 1 else cz + 1.5, 90)]
    if where == "corner":
        return [(x1 - w / 2, z1 - d / 2, 180), (x0 + w / 2, z1 - d / 2, 180)][i % 2:] + [(x1 - w / 2, z1 - d / 2, 180)]
    if where == "front_of_back":
        return [(x0 + W * (0.25 + 0.5 * frac), z1 - 1.25, 0 if "stool" in p["name"] else 180)]
    if where == "front_left":
        return [(x1 - w / 2 - 0.3, z0 + D * 0.3, -90)]
    if where == "front_bars":
        return [(cx, z0 + d / 2 + 0.05, 0)]
    if where in ("centre", "centre_back", "centre_front"):
        dz = {"centre": 0.0, "centre_back": 2.0, "centre_front": -1.5}[where]
        return [(cx, cz + dz + d / 2, 180 if where != "centre_front" else 0)]
    if where in ("rows", "rows_wide", "rows_front", "aisle_rows", "park_rows", "grid", "stacks"):
        cols = max(1, int((W - 1.0) // (w + (1.0 if where in ("rows_wide", "park_rows") else 0.45))))
        if where == "aisle_rows":
            cols = max(2, cols - cols % 2)
        r, c = divmod(i, cols)
        gap = (W - cols * w) / (cols + 1)
        x = x0 + gap + w / 2 + c * (w + gap)
        if where == "aisle_rows":
            half = cols // 2
            aisle = min(1.2, W * 0.25)
            side = -1 if c < half else 1
            k = c if c < half else c - half
            span = (W - aisle) / 2
            x = (x0 + (k + 0.5) * span / half) if side < 0 else (x0 + span + aisle + (k + 0.5) * span / half)
        pitch = d + (1.4 if where in ("rows_wide", "park_rows") else 0.55)
        start = z1 - 1.6 - d / 2 if where not in ("rows_front",) else z1 - 3.0
        if where in ("grid",):
            start = cz + 4
        return [(x, start - r * pitch, 0 if where != "park_rows" else 0)]
    if where == "pillars":
        rows = max(1, (n + 1) // 2)
        r, side = divmod(i, 2)
        return [((x0 + W * 0.18) if side else (x1 - W * 0.18), z1 - D * (0.15 + 0.7 * (r + 0.5) / rows), 0)]
    if where == "aisle_poles":
        return [(0.0, z1 - D * (i + 0.5) / max(n, 1), 0)]
    if where == "long_benches":
        side, r = i % 2, i // 2
        return [((x1 - w / 2) if side else (x0 + w / 2), z1 - 1.0 - d / 2 - r * (d + 1.0), -90 if side else 90)]
    if where in ("far", "far_line", "far_row"):
        spread = (i - (n - 1) / 2) * (w + (0.0 if where == "far_line" else 2.5))
        return [(cx + spread, min(z1 - d / 2, cz + 10 + d / 2), 180)]
    if where == "street":
        side = 1 if i % 2 == 0 else -1
        return [(side * (x1 - max(w, d) / 2 - 0.1), cz + 3 + 5 * (i // 2) - 6, 0)]
    # scatter / scatter_in: a ring around the action
    ang = (i * 137.5 + 40) % 360
    r = (4.5 if where == "scatter" else min(2.4, max(W, D) / 4)) + 0.7 * (i % 3) + max(w, d) / 2
    return [(cx + r * math.sin(math.radians(ang)), cz + abs(r * math.cos(math.radians(ang))) * (1 if where == "scatter_in" else 1.0), 0)]


def _corridor(focus, cam):
    """A veto for spots in the wedge between the master camera and the action (that view stays clear)."""
    if not cam:
        return None
    cx, cz = focus

    def veto(x, z):
        vx, vz = cx - cam[0], cz - cam[2]
        L2 = vx * vx + vz * vz or 1.0
        u = ((x - cam[0]) * vx + (z - cam[2]) * vz) / L2
        if u < 0 or u > 1.05:
            return False
        px, pz = cam[0] + u * vx, cam[2] + u * vz
        return math.hypot(x - px, z - pz) < 0.9 + 1.6 * u
    return veto


def place(loc: dict, scene: dict, ids: set, master: dict | None = None) -> tuple[list[dict], list[str]]:
    """The location's pieces as actors on free floor, around what is already on set. Returns (actors, notes)."""
    key = loc["key"]
    others = [a for a in scene.get("actors", []) if not a.get("mount_id")]
    people = [a for a in others if a.get("kind") in C.PEOPLE]
    st = S.set_def(key)["stage"]
    focus = (sum(a["position"][0] for a in people) / len(people), sum(a["position"][2] for a in people) / len(people)) if people \
        else (st[0], st[1])
    cam = (master or {}).get("position")
    veto = _corridor(focus, cam)
    out: list[dict] = []
    left_out: list[str] = []
    approx: list[str] = []
    # Walls first, then the big pieces, then the small ones: what the place is made of claims the floor first.
    order = sorted(loc["pieces"], key=lambda p: (p["where"] not in ("back", "back_high", "left", "right", "walls", "sides", "sides_high",
                                                                    "front_bars", "corner", "pillars"), -p["size"][0] * p["size"][2]))
    have = set()
    for a in others:
        for nm in (a.get("design"), a.get("name"), a.get("kind")):
            if nm:
                nm = str(nm).lower().rstrip(" 0123456789")
                have |= {nm, C.SYNONYMS.get(nm, nm)}
    same = {"sofa": "couch", "couch": "sofa", "desk": "table"}
    for p in order:
        if p["count"] == 1 and (p["name"] in have or same.get(p["name"]) in have):
            continue  # the blocking already put one there (the couple's table, the friends' couch)
        placed_n = 0
        for i in range(p["count"]):
            o = _actor(p, ids, i + 1 if p["count"] > 1 else 1)
            ok = False
            for (x, z, rot) in _wants(p, i, p["count"], key, focus, p["size"]):
                o["rotation_deg"] = rot
                wall = p["where"] in ("back", "back_high", "left", "right", "sides", "sides_high", "walls", "corner", "front_bars",
                                      "pillars", "aisle_poles", "long_benches")
                q = S.free_spot(o, [x, z], key, others + out, avoid=None if wall else veto, max_r=3.0 if wall else 8.0)
                if S.is_free(o, q, key, others + out) and (wall or not veto or not veto(q[0], q[2])):
                    _put(o, q)
                    ok = True
                    break
            if not ok:
                ids.discard(o["id"])
                continue
            out.append(o)
            placed_n += 1
            if o["kind"] == "custom" and o["recipe"].get("placeholder") and i == 0:
                w, h, d = p["size"]
                approx.append(f"{p['name']}: a {w:g} x {d:g} m, {h:g} m tall box (no {p['name']} model in the library yet)")
        if placed_n < p["count"] and p["where"] not in ("rows", "rows_wide", "aisle_rows", "park_rows", "grid", "stacks", "scatter",
                                                        "scatter_in", "street"):
            left_out.append(p["name"] if placed_n == 0 else f"{p['count'] - placed_n} x {p['name']}")
        elif placed_n == 0:
            left_out.append(p["name"])
    notes = []
    if approx:
        notes.append("Approximated with simple shapes at real size: " + "; ".join(approx[:6]) + (" ..." if len(approx) > 6 else ""))
    if left_out:
        notes.append("No room for: " + ", ".join(left_out[:6]))
    return out, notes


def practicals(loc: dict, scene: dict, dressing: list[dict], master: dict | None) -> list[dict]:
    """Film lights the place itself has (pendant lamps over the booths, neon on the back wall, a campfire glow)."""
    key = loc["key"]
    x0, x1, z0, z1 = S.set_def(key)["bounds"]
    room = C.set_room(key) or [None, None, 3.2 if S.set_def(key)["interior"] else 6.0]
    ceil = room[2]
    people = [a for a in scene.get("actors", []) if a.get("kind") in C.PEOPLE]
    tgt = people[0]["position"] if people else [S.set_def(key)["stage"][0], 0, S.set_def(key)["stage"][1]]
    subj = [round(tgt[0], 2), 1.3, round(tgt[2], 2)]
    out = []
    used = {}
    for name in loc.get("lights", [])[:4]:
        spec = PRACTICALS.get(name)
        if not spec:
            continue
        typ, kelvin, inten, h, where, label = spec
        n = used[name] = used.get(name, 0) + 1
        if where == "ceiling":
            pos = [round(subj[0] + (n - 1) * 2.2 - 1.1 * (n > 1), 2), round(ceil - 0.3, 2), round(subj[2] + 0.8, 2)]
        elif where == "back":
            pos = [round(max(x0 + 0.5, min(x1 - 0.5, subj[0] + 1.5 * (1 if n % 2 else -1))), 2), h, round(z1 - 0.15, 2)]
        elif where == "walls":
            pos = [round(x1 - 0.2 if n % 2 else x0 + 0.2, 2), h, round(subj[2] + 1.0, 2)]
        elif where == "fire":
            fire = next((a for a in dressing if "fire" in a.get("name", "").lower()), None)
            p = fire["position"] if fire else [subj[0] + 1.2, 0, subj[2] + 1.2]
            pos = [p[0], h, p[2]]
        else:
            lamp = next((a for a in dressing if a.get("kind") in ("table",) or "desk" in a.get("name", "").lower()), None)
            p = lamp["position"] if lamp else [subj[0] - 1.2, 0, subj[2] + 1.0]
            pos = [round(p[0] + 0.4, 2), h, round(p[2], 2)]
        if room[0]:
            pos = [min(max(pos[0], x0 + 0.1), x1 - 0.1), min(pos[1], ceil - 0.1), min(max(pos[2], z0), z1 - 0.1)]
        out.append({"id": f"light_loc_{name}_{n}", "type": typ, "name": f"{label}{f' {n}' if n > 1 else ''}", "position": pos,
                    "target": subj, "kelvin": kelvin, "intensity": inten, "softness": C.LIGHT_TYPES[typ]["softness"],
                    "angle": C.LIGHT_TYPES[typ]["angle"], "from_location": True})
    return out


def env_patch(loc: dict) -> dict:
    """The environment fields a location sets (None clears a field the old set had)."""
    return {"set": loc["set"], "room": loc["room"] if loc["set"] == "interior" and loc.get("room") and
            tuple(loc["room"]) != C.DEFAULT_ROOM else None,
            "look": loc["look"] or None,
            "location": {"label": loc["label"], "place": loc.get("place", ""), "era": loc["era"], "source": loc["source"],
                         "prompt": loc["said"], "approximations": loc["approximations"][:6]}}


def describe_line(loc: dict) -> str:
    if not loc.get("known"):
        return ""
    what = loc["label"] or loc["set"]
    if loc.get("room"):
        w, d, h = loc["room"]
        what += f", {w:g} x {d:g} m, {h:g} m ceiling"
    src = "from the " + C.SETS[loc["set"]]["label"].lower() + " preset" if loc["source"].startswith("preset") else "composed"
    return f"Set: {what} ({src})"


# ------------------------------------------------------------------------------------------- editing a set

_RELOC = [
    r"^(?:please\s+)?(?:make|turn|change|convert|transform|redress|restyle|re-dress|dress|rebuild|redo)\s+(?:it|this|that|the (?:set|scene|room|place|location|stage|preset)|everything|this (?:set|place|room))\s+(?:into|to be|to|as|like)?\s*(?P<x>.+)$",
    r"^(?:please\s+)?(?:set (?:it|the scene|this|the story)|move (?:us|the scene|the set|everything|the action)|take (?:us|the scene)|relocate(?: (?:it|us|the scene))?|switch(?: the set)? to|change the (?:set|location|place) to|go to)\s+(?:in|at|to|on|inside|into)?\s*(?P<x>.+)$",
    r"^(?:build|make|create|give me|i want|we need)\s+(?:the|a|an)?\s*(?:set|location|place|backdrop)\s*(?::|of|as|for|like)?\s*(?P<x>.+)$",
    r"^(?:set|location|place)\s*:\s*(?P<x>.+)$",
    r"^(?:it'?s|we'?re|this is)\s+(?:now\s+)?(?:in|at|inside|on)\s+(?P<x>.+)$",
]


def relocation_text(command: str, scene: dict | None = None) -> str | None:
    """The set description in an edit command ("make it a 1950s diner at night" -> "a 1950s diner at night"),
    or None when the command isn't about the set (or names no place or era we know)."""
    c = re.sub(r"\s+", " ", (command or "").strip().lower()).rstrip(".!")
    for pat in _RELOC:
        m = re.match(pat, c)
        if not m:
            continue
        x = m.group("x").strip()
        loc = compose(x, (scene or {}).get("environment"))
        if loc["known"]:
            return x
    return None


def relocate(work: dict, text: str, emit, apply_lighting) -> list[str]:
    """Change the set of the scene in `work` to what `text` describes, through `emit(op, undo)`: the old set dressing
    and its practicals go, the new set, look, dressing and lights come in, and everything else (the cast, what you
    added, the cameras) stays, moved only if it would now stand in a wall. Returns notes."""
    env = work.get("environment") or {}
    loc = compose(text, env)
    if not loc["known"]:
        return [f"set: I don't know what '{text}' looks like yet; nothing changed"]
    notes = [describe_line(loc)]
    # 1. The old dressing and its lights leave (only what an earlier location brought; your own things stay).
    for a in [x for x in work["actors"] if x.get("set_dressing")]:
        idx = next(i for i, x in enumerate(work["actors"]) if x["id"] == a["id"])
        emit({"op": "remove_object", "id": a["id"]}, {"op": "add_object", "object": copy.deepcopy(a), "index": idx})
    for lt in [x for x in (work.get("lighting") or {}).get("lights", []) if x.get("from_location")]:
        emit({"op": "remove_light", "id": lt["id"]}, {"op": "add_light", "light": copy.deepcopy(lt)})
    # 2. The set itself.
    patch = env_patch(loc)
    if loc["weather"]:
        patch["weather"] = loc["weather"]
    old = work["environment"]
    emit({"op": "set_environment", "set": patch}, {"op": "set_environment", "set": {k: copy.deepcopy(old.get(k)) for k in patch}})
    if loc["time"]:
        apply_lighting(loc["time"])
    key = loc["key"]
    # 3. What you placed stays; anything now inside a wall or outside the room steps to the nearest free floor.
    placed: list[dict] = []
    moved = 0
    for a in list(work["actors"]):
        if a.get("mount_id"):
            continue
        if not S.is_free(a, a["position"], key, placed):
            q = S.free_spot(a, [a["position"][0], a["position"][2]], key, placed, max_r=40)
            dx, dz = q[0] - a["position"][0], q[2] - a["position"][2]
            keys = [{"frame": k["frame"], "position": [round(k["position"][0] + dx, 3), 0.0, round(k["position"][2] + dz, 3)]}
                    for k in a.get("keys") or [{"frame": 0, "position": a["position"]}]]
            p2 = {"keys": keys, "position": list(keys[0]["position"])}
            emit({"op": "move_object", "id": a["id"], "set": p2},
                 {"op": "move_object", "id": a["id"], "set": {k: copy.deepcopy(a.get(k)) for k in p2}})
            moved += 1
        placed.append(next(x for x in work["actors"] if x["id"] == a["id"]))
    for sh in work.get("shots", []):
        keys = [dict(k, **S.clamp_camera(k, key)[0]) for k in sh["camera_keys"]]
        if keys != sh["camera_keys"]:
            emit({"op": "update_shot", "id": sh["id"], "set": {"camera_keys": keys}},
                 {"op": "update_shot", "id": sh["id"], "set": {"camera_keys": copy.deepcopy(sh["camera_keys"])}})
    # 4. The new dressing, around what is there, out of the active camera's view of the action.
    shots = work.get("shots") or []
    sh = next((s for s in shots if s.get("id") == work.get("active_shot")), shots[0] if shots else None)
    master = sh["camera_keys"][0] if sh else work.get("camera")
    ids = {a["id"] for a in work["actors"]}
    dressing, pnotes = place(loc, work, ids, master)
    for o in dressing:
        emit({"op": "add_object", "object": o, "index": len(work["actors"])}, {"op": "remove_object", "id": o["id"]})
    for lt in practicals(loc, work, dressing, master):
        emit({"op": "add_light", "light": lt}, {"op": "remove_light", "id": lt["id"]})
    kept = len([a for a in work["actors"] if not a.get("set_dressing")])
    notes += pnotes + loc["approximations"]
    notes.append(f"Kept {kept} thing{'s' if kept != 1 else ''} you placed" + (f" ({moved} moved off the new walls)" if moved else ""))
    return notes


def indoor(loc: dict) -> bool:
    return bool(S.set_def(loc.get("key", "empty")).get("interior"))
