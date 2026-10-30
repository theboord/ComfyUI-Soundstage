"""What the stage can show, mirrored from web/stage/*.mjs so the agent places things it can render.

Coordinates match the stage: metres, Y up, objects stand on y=0, rotation_deg 0 faces +Z.
The default camera looks down +Z from -Z, so +X is screen-LEFT and -X is screen-RIGHT.
If environments.mjs / library.mjs change, update the numbers here (tests/test_agent.py pins them).
"""
from __future__ import annotations

import math

# ---- library objects (web/stage/library.mjs LIBRARY) ---------------------------------------------
# kind -> label, height, rig, footprint [width X, depth Z] at rotation 0.
LIBRARY = {
    "man": {"label": "Man", "height": 1.8, "rig": "biped", "foot": [0.5, 0.35]},
    "woman": {"label": "Woman", "height": 1.68, "rig": "biped", "foot": [0.45, 0.3]},
    "child": {"label": "Child", "height": 1.2, "rig": "biped", "foot": [0.35, 0.25]},
    "dog": {"label": "Dog", "height": 0.6, "rig": "quadruped", "foot": [0.3, 0.9]},
    "horse": {"label": "Horse", "height": 1.6, "rig": "quadruped", "foot": [0.6, 2.5]},
    "cat": {"label": "Cat", "height": 0.3, "rig": "quadruped", "foot": [0.15, 0.45]},
    "bird": {"label": "Bird", "height": 0.35, "rig": "static", "foot": [0.25, 0.35]},
    "police_car": {"label": "Police car", "height": 1.6, "rig": "vehicle", "foot": [1.9, 4.8]},
    "sports_car": {"label": "Sports car", "height": 1.2, "rig": "vehicle", "foot": [1.9, 4.5]},
    "hatchback": {"label": "Hatchback", "height": 1.5, "rig": "vehicle", "foot": [1.75, 4.2]},
    "flashlight": {"label": "Flashlight", "height": 0.08, "rig": "static", "foot": [0.06, 0.26]},
    "ufo": {"label": "Flying saucer", "height": 3, "rig": "static", "foot": [12.0, 12.0]},
    "car": {"label": "Car", "height": 1.45, "rig": "vehicle", "foot": [1.8, 4.5]},
    "truck": {"label": "Truck", "height": 2.6, "rig": "vehicle", "foot": [2.3, 6.5]},
    "bicycle": {"label": "Bicycle", "height": 1.05, "rig": "vehicle", "foot": [0.5, 1.8]},
    "motorcycle": {"label": "Motorcycle", "height": 1.15, "rig": "vehicle", "foot": [0.6, 1.8]},
    "tree": {"label": "Tree", "height": 6.5, "rig": "static", "foot": [1.2, 1.2]},
    "bush": {"label": "Bush", "height": 1.1, "rig": "static", "foot": [1.3, 1.3]},
    "house": {"label": "House", "height": 6.0, "rig": "static", "foot": [8.0, 7.0]},
    "bench": {"label": "Bench", "height": 0.85, "rig": "static", "foot": [1.8, 0.5]},
    "table": {"label": "Table", "height": 0.75, "rig": "static", "foot": [1.4, 0.8]},
    "chair": {"label": "Chair", "height": 0.9, "rig": "static", "foot": [0.45, 0.45]},
    "lamp": {"label": "Street lamp", "height": 4.2, "rig": "static", "foot": [0.3, 0.6]},
    "rock": {"label": "Rock", "height": 0.8, "rig": "static", "foot": [1.4, 1.1]},
    "cube": {"label": "Cube", "height": 1, "rig": "static", "foot": [1.0, 1.0]},
    "crate": {"label": "Crate", "height": 0.8, "rig": "static", "foot": [0.8, 0.8]},
    "wall": {"label": "Wall", "height": 2.4, "rig": "static", "foot": [6.0, 0.25]},
}
PEOPLE = {"man", "woman", "child"}

# web/stage/humans.mjs MOUNTS: what a rider can sit on, and the pose the stage gives them there.
MOUNTS = {"horse": "ride", "bicycle": "cycle", "motorcycle": "cycle", "car": "sit", "truck": "sit", "chair": "sit",
          "bench": "sit", "table": "sit", "rock": "sit", "cube": "sit"}

SYNONYMS = {
    "person": "man", "guy": "man", "cowboy": "man", "driver": "man", "rider": "man", "male": "man", "boy": "child", "girl": "child", "kid": "child", "female": "woman",
    "crow": "bird", "raven": "bird", "eagle": "bird", "hawk": "bird", "owl": "bird", "pigeon": "bird", "seagull": "bird", "gull": "bird",
    "parrot": "bird", "chicken": "bird", "duck": "bird",
    "torch": "flashlight", "saucer": "ufo", "spaceship": "ufo", "flying saucer": "ufo",
    "lady": "woman", "puppy": "dog", "pony": "horse", "kitten": "cat", "sedan": "car", "suv": "car", "taxi": "car",
    "cab": "car", "van": "truck", "lorry": "truck", "bike": "bicycle", "cyclist": "bicycle", "motorbike": "motorcycle",
    "scooter": "motorcycle", "vespa": "motorcycle", "shrub": "bush", "hedge": "bush", "plant": "bush",
    "home": "house", "cabin": "house", "hut": "house", "seat": "chair", "stool": "chair", "desk": "table",
    "lamppost": "lamp", "streetlight": "lamp", "street lamp": "lamp", "streetlamp": "lamp", "boulder": "rock",
    "stone": "rock", "box": "crate", "barrel": "crate", "fence": "wall", "block": "cube", "palm": "tree", "oak": "tree", "pine": "tree",
    "coffee table": "table", "dining table": "table",
}


def resolve_kind(text: str) -> str | None:
    """Same rule as library.mjs resolveKind: whole phrase, then each word, then singulars."""
    t = str(text or "").lower().strip()
    if not t:
        return None
    words = "".join(c if c.isalpha() or c == " " else " " for c in t).split()
    for c in [t, *words, *[w[:-1] if w.endswith("s") else w for w in words]]:
        if c in LIBRARY:
            return c
        if c in SYNONYMS:
            return SYNONYMS[c]
    return None


# Rough real-world sizes [w, h, d] for things the library lacks, used for the placeholder box until the
# object designer returns a real recipe (and for collision while placing).
DESIGN_SIZES = {
    "couch": [2.1, 0.85, 0.9], "sofa": [2.1, 0.85, 0.9], "armchair": [0.9, 0.95, 0.9], "tv": [1.2, 0.75, 0.3],
    "television": [1.2, 0.75, 0.3], "booth": [1.6, 1.2, 0.7], "counter": [4.0, 1.05, 0.7], "jukebox": [0.9, 1.6, 0.7],
    "stool": [0.4, 0.75, 0.4], "bar": [4.0, 1.1, 0.7], "bookshelf": [1.2, 2.0, 0.4], "filing cabinet": [0.5, 1.3, 0.6],
    "desk lamp": [0.25, 0.5, 0.25], "water tower": [3.0, 6.0, 3.0], "chimney": [0.9, 1.6, 0.9], "ac unit": [1.2, 1.0, 1.0],
    "air conditioner": [1.2, 1.0, 1.0], "skylight": [1.5, 0.6, 1.5], "ledge": [6.0, 1.0, 0.4], "parapet": [6.0, 1.0, 0.3],
    "wagon": [1.8, 2.2, 4.0], "hitching post": [2.5, 1.0, 0.2], "water trough": [2.0, 0.6, 0.6], "saloon": [8.0, 6.0, 6.0],
    "piano": [1.5, 1.0, 2.0], "bed": [1.6, 0.6, 2.1], "door": [1.0, 2.1, 0.1], "window": [1.5, 1.4, 0.1],
    "oxygen tank": [0.3, 0.7, 0.3], "ladder": [0.5, 3.0, 0.2], "rope": [0.1, 0.1, 3.0], "anchor": [1.0, 1.4, 0.4],
    "fire hydrant": [0.4, 0.8, 0.4], "dumpster": [2.0, 1.4, 1.2], "phone booth": [1.0, 2.3, 1.0], "mailbox": [0.5, 1.1, 0.5],
    "diner": [12.0, 4.5, 8.0], "building": [10.0, 6.0, 8.0], "shop": [8.0, 4.5, 6.0], "storefront": [8.0, 4.5, 2.0],
    "gas station": [10.0, 4.5, 6.0], "barn": [10.0, 7.0, 8.0], "church": [10.0, 9.0, 14.0], "motel": [16.0, 4.0, 8.0],
    "coat rack": [0.5, 1.8, 0.5], "floor lamp": [0.45, 1.6, 0.45], "fireplace": [1.6, 1.2, 0.5], "rug": [2.5, 0.02, 1.8], "plant pot": [0.5, 0.9, 0.5],
}


def design_size(name: str) -> list[float]:
    t = (name or "").lower()
    for key in sorted(DESIGN_SIZES, key=len, reverse=True):
        if key in t:
            return list(DESIGN_SIZES[key])
    return [1.0, 1.0, 1.0]


def placeholder_recipe(name: str) -> dict:
    """A one-box clay stand-in the stage can draw now (kind "custom"); the designer replaces it later."""
    w, h, d = design_size(name)
    return {"name": name, "rig": "static", "size_m": [w, h, d], "placeholder": True,
            "parts": [{"shape": "box", "pos": [0, h / 2, 0], "size": [w, h, d], "rot": [0, 0, 0]}]}


# ---- sets (web/stage/environments.mjs buildSet) ---------------------------------------------------
# bounds: where objects may stand [xmin, xmax, zmin, zmax]. obstacles: fixed set geometry footprints
# [cx, cz, w, d]. anchors: named spots you can put things "by" (point on the floor + which way is "in").
SETS = {
    "plaza": {
        "label": "Plaza exterior", "interior": False, "bounds": [-15, 15, -20, 9.8],
        "obstacles": [[0, 15, 21, 9], [-3.5, 6, 1.2, 1.2], [3.5, 6, 1.2, 1.2], [-8, 2, 0.3, 0.3]],
        "anchors": {"door": [0, 10.0], "building": [0, 10.0], "planter": [-3.5, 6], "lamp": [-8, 2],
                    "streetlamp": [-8, 2], "centre": [0, 0]},
        "stage": [0, 0],
    },
    "street_night": {
        "label": "City street", "interior": False, "bounds": [-6.2, 6.2, -24, 30],
        "obstacles": [[s * 5.6, z, 0.3, 0.3] for s in (-1, 1) for z in (-22, -11, 0, 11, 22)]
                     + [[s * 11, -25 + i * 11, 9, 10] for s in (-1, 1) for i in range(6)],
        "anchors": {"streetlamp": [[s * 5.6, z] for s in (-1, 1) for z in (-22, -11, 0, 11, 22)],
                    "lamp": [[s * 5.6, z] for s in (-1, 1) for z in (-22, -11, 0, 11, 22)],
                    "sidewalk": [[5.9, 0], [-5.9, 0]], "kerb": [[5.4, 0], [-5.4, 0]], "storefront": [[6.3, 0], [-6.3, 0]],
                    "building": [[6.3, 0], [-6.3, 0]], "centre": [0, 0], "middle of the street": [0, 0]},
        "stage": [0, 0],
    },
    "interior": {
        "label": "Interior room", "interior": True, "bounds": [-3.65, 3.65, -4.6, 4.6],
        "obstacles": [],
        "anchors": {"window": [-1.5, 4.5], "door": [2.5, 4.5], "back wall": [0, 4.5], "left wall": [3.6, 0],
                    "right wall": [-3.6, 0], "corner": [3.3, 4.3], "centre": [0, 0], "middle of the room": [0, 0]},
        "stage": [0, 0.5],
    },
    "studio": {
        "label": "Studio cyc / green screen", "interior": True, "bounds": [-9, 9, -9, 9.5],
        "obstacles": [], "anchors": {"cyc": [0, 9.5], "wall": [0, 9.5], "centre": [0, 0]}, "stage": [0, 2],
    },
    "forest": {
        "label": "Forest", "interior": False, "bounds": [-2.8, 2.8, -20, 13],
        "obstacles": [], "anchors": {"clearing": [0, 0], "trees": [[2.8, 4], [-2.8, 4]], "centre": [0, 0]},
        "stage": [0, 0],
    },
    "desert": {
        "label": "Desert", "interior": False, "bounds": [-20, 20, -20, 20],
        "obstacles": [], "anchors": {"dunes": [0, 20], "centre": [0, 0]}, "stage": [0, 0],
    },
    "beach": {
        "label": "Beach & ocean", "interior": False, "bounds": [-20, 20, -20, 9.5],
        "obstacles": [], "anchors": {"water": [0, 9.5], "ocean": [0, 9.5], "shore": [0, 9.0], "waterline": [0, 9.0],
                                     "centre": [0, 0]},
        "stage": [0, 2],
    },
    "water_tank": {
        "label": "Water tank", "interior": True, "bounds": [-7.4, 7.4, -7.4, 7.4],
        "obstacles": [], "anchors": {"tank wall": [0, 7.3], "wall": [0, 7.3], "centre": [0, 0]}, "stage": [0, 0],
    },
    "empty": {
        "label": "Empty stage", "interior": False, "bounds": [-15, 15, -15, 15],
        "obstacles": [], "anchors": {"centre": [0, 0]}, "stage": [0, 0],
    },
}

# The plaza is drawn from the scene's own props (stage.mjs only renders props[] on the plaza).
PLAZA_PROPS = [
    {"id": "building", "kind": "building", "position": [0, 0, 15], "size": [21, 8, 9], "door": [3, 5]},
    {"id": "planter_l", "kind": "box", "position": [-3.5, 0, 6], "size": [1.2, 1.0, 1.2]},
    {"id": "planter_r", "kind": "box", "position": [3.5, 0, 6], "size": [1.2, 1.0, 1.2]},
    {"id": "lamp", "kind": "post", "position": [-8, 0, 2], "size": [0.15, 4, 0.15]},
]

SET_WORDS = [  # first match wins; order matters (specific before generic)
    ("water_tank", ["underwater", "water tank", "tank", "pool", "submerged", "diver", "scuba"]),
    ("beach", ["beach", "ocean", "shore", "seaside", "surf", "coast", "pier"]),
    ("studio", ["studio", "green screen", "greenscreen", "cyc", "product shot", "photo shoot", "soundstage"]),
    ("forest", ["forest", "woods", "jungle", "trees", "woodland", "glade"]),
    ("desert", ["desert", "dunes", "wasteland", "badlands", "sahara"]),
    ("interior", ["office", "diner", "living room", "bedroom", "kitchen", "apartment", "room", "bar", "restaurant",
                  "cafe", "café", "motel", "hallway", "corridor", "precinct", "classroom", "couch", "sofa", "inside",
                  "interior", "int.", "saloon", "booth", "lobby", "loft", "basement", "attic", "hospital"]),
    ("empty", ["rooftop", "roof", "void", "empty stage", "black void", "nowhere"]),
    ("street_night", ["street", "alley", "road", "avenue", "boulevard", "main street", "town", "city", "downtown",
                      "sidewalk", "crosswalk", "western", "intersection"]),
    ("plaza", ["plaza", "square", "courtyard", "piazza", "campus", "park", "outside a building"]),
]

# ---- time of day & weather (web/stage/lighting.mjs) ---------------------------------------------
TIME_PRESETS = {
    "dawn": {"label": "Dawn", "sunElevation": -3, "side": "east"},
    "golden_am": {"label": "Golden hour AM", "sunElevation": 6, "side": "east"},
    "midday": {"label": "Midday", "sunElevation": None, "side": "noon"},
    "overcast": {"label": "Overcast", "sunElevation": None, "side": "noon", "overcast": True},
    "magic_hour": {"label": "Magic hour", "sunElevation": 3, "side": "west"},
    "blue_hour": {"label": "Blue hour", "sunElevation": -4, "side": "west"},
    "night": {"label": "Night (moonlight)", "sunElevation": -18, "side": "west"},
}
TIME_WORDS = [
    ("magic_hour", ["magic hour", "golden hour", "sunset", "dusk", "sundown", "evening"]),
    ("blue_hour", ["blue hour", "twilight", "nightfall"]),
    ("golden_am", ["golden hour am", "early morning", "morning"]),
    ("dawn", ["dawn", "sunrise", "daybreak", "first light"]),
    ("night", ["night", "midnight", "nighttime", "dark", "moonlight", "late at night", "noir", "after hours"]),
    ("overcast", ["overcast", "cloudy", "grey day", "gray day", "gloomy"]),
    ("midday", ["noon", "midday", "high noon", "daytime", "day", "afternoon", "sunny", "bright"]),
]
WEATHER = ["none", "rain", "snow", "fog", "smoke", "dust", "sparks"]
WEATHER_WORDS = [
    ("rain", ["rain", "rainy", "raining", "storm", "downpour", "drizzle", "wet"]),
    ("snow", ["snow", "snowy", "snowing", "blizzard", "winter"]),
    ("fog", ["fog", "foggy", "mist", "misty", "haze", "hazy"]),
    ("smoke", ["smoke", "smoky", "smoking ruins"]),
    ("dust", ["dust", "dusty", "sandstorm", "dirt"]),
    ("sparks", ["sparks", "embers", "on fire", "burning"]),
]

LIGHT_TYPES = {
    "key": {"label": "Key", "kelvin": 4300, "intensity": 3.2, "height": 2.6, "angle": 40, "softness": 0.6},
    "fill": {"label": "Fill", "kelvin": 5200, "intensity": 1.0, "height": 1.8, "angle": 60, "softness": 0.9},
    "rim": {"label": "Rim / back", "kelvin": 5600, "intensity": 2.6, "height": 2.8, "angle": 30, "softness": 0.4},
    "practical": {"label": "Practical (lamp)", "kelvin": 2700, "intensity": 1.4, "height": 1.4, "angle": 180, "softness": 1.0},
    "spot": {"label": "Spot", "kelvin": 3200, "intensity": 4.0, "height": 4.0, "angle": 18, "softness": 0.2},
    "neon": {"label": "Neon", "kelvin": 12000, "intensity": 1.6, "height": 2.2, "angle": 180, "softness": 1.0},
}

# Shot setups the stage names (stage.mjs addShot labels).
SETUPS = {"master": "Master", "wide": "Wide", "ots_a": "Over-the-shoulder A", "ots_b": "Over-the-shoulder B",
          "single_a": "Single A", "single_b": "Single B", "insert": "Insert", "pov": "POV", "two_shot": "Two-shot"}

D2R = math.pi / 180


def solar_position(hour: float, day_of_year: float = 300, latitude: float = 34.05) -> tuple[float, float]:
    """Port of lighting.mjs solarPosition: (azimuth deg clockwise from north, elevation deg)."""
    decl = -23.44 * math.cos(((360 / 365) * (day_of_year + 10)) * D2R)
    ha = (hour - 12) * 15
    lat, dec, h = latitude * D2R, decl * D2R, ha * D2R
    el = math.asin(math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(h))
    cos_az = (math.sin(dec) - math.sin(el) * math.sin(lat)) / (math.cos(el) * math.cos(lat))
    az = math.acos(max(-1.0, min(1.0, cos_az))) / D2R
    if ha > 0:
        az = 360 - az
    return az, el / D2R


def hour_for_elevation(target_el: float, side: str, day_of_year: float = 300, latitude: float = 34.05) -> float:
    """Port of lighting.mjs hourForElevation."""
    if side == "noon":
        return 12.5
    a, b = (3, 12) if side == "east" else (12, 22)
    best, best_err = (7 if side == "east" else 17.5), 1e9
    h = a
    while h <= b:
        err = abs(solar_position(h, day_of_year, latitude)[1] - target_el)
        if err < best_err:
            best_err, best = err, h
        h += 0.02
    return round(best, 2)


def preset_hour(preset: str, day_of_year: float = 300, latitude: float = 34.05) -> float:
    p = TIME_PRESETS[preset]
    if p["sunElevation"] is None:
        return 12.5
    return hour_for_elevation(p["sunElevation"], p["side"], day_of_year, latitude)


def sun_for(lighting: dict) -> dict:
    az, el = solar_position(lighting.get("hour", 12.5), lighting.get("day_of_year", 300), lighting.get("latitude", 34.05))
    return {"azimuth_deg": round(((az + lighting.get("north_deg", 0)) % 360 + 360) % 360),
            "elevation_deg": round(el * 10) / 10}
