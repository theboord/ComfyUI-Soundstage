"""Watercraft words for the prompts (web/stage/boatsim.mjs simulates them; this says what the camera sees).

A boat is not a car: it doesn't drive down a street, it planes, sails, heels, is paddled or rowed, and it leaves a
wake. The video models need those words (and the sea state) or they paint a speedboat sitting still on glass.
"""
from __future__ import annotations

BOAT_KINDS = {"speedboat", "fishing_boat", "dinghy", "yacht", "canoe", "kayak", "rowboat", "raft", "log_raft",
              "boat", "sailboat", "catamaran", "jetski"}
PADDLED = {"canoe", "kayak", "rowboat", "raft", "log_raft"}
SAIL = {"dinghy", "yacht", "sailboat", "catamaran"}

SEA_WORDS = {
    "glassy": "glassy calm water, a mirror surface",
    "calm_lake": "a calm lake, the surface barely rippled",
    "breeze": "a light wind chop on the water",
    "moderate": "a moderate sea, waves about a metre high with scattered whitecaps",
    "swell": "a long rolling ocean swell",
    "rough": "a rough sea, steep waves and whitecaps",
    "whitewater": "fast whitewater rapids, standing waves and foaming holes behind the rocks",
}
SET_SEA = {"lake": "calm_lake", "open_water": "breeze", "beach": "swell", "water_tank": "glassy", "river_rapids": "whitewater"}


def is_boat(kind: str) -> bool:
    return kind in BOAT_KINDS


def sea_words(scene: dict) -> str:
    env = scene.get("environment") or {}
    sid = env.get("sea_state") or SET_SEA.get(env.get("set", ""))
    return SEA_WORDS.get(sid, "")


def boat_verb(kind: str, speed: float, crew: int = 0) -> str:
    """What a moving boat does, by kind and speed (m/s): the motion prompt's verb phrase."""
    if kind in ("speedboat", "boat", "jetski"):
        if speed > 8:
            return "planes across the water, bow raised and the hull skimming, carving a white V-shaped wake and throwing spray"
        if speed > 3:
            return "surges forward, its bow climbing high as it pushes through its own bow wave, a foaming wake behind"
        return "idles forward, a small wake trailing from its stern"
    if kind == "fishing_boat":
        return ("pushes through the water, bow lifting over the waves, a churning white wake behind" if speed > 3
                else "chugs slowly forward, a low wake trailing")
    if kind in SAIL:
        return ("sails forward heeled over, its sail full and taut in the wind, water rushing along the hull" if speed > 1.2
                else "drifts, its sail flapping")
    if kind == "canoe":
        return "glides forward as the paddlers stroke in time, each blade dipping, pulling and lifting out dripping"
    if kind == "kayak":
        return "slices forward, the double-bladed paddle dipping on the left, then the right"
    if kind == "rowboat":
        return "is rowed forward, both oars sweeping back through the water and lifting dripping for the next stroke"
    if kind == "raft":
        return "bucks through the whitewater, the crew digging their paddles in together as spray bursts over the tubes"
    if kind == "log_raft":
        return "is poled slowly along, the long pole pushing off the bottom"
    return "moves across the water"


def ride_noun(noun: str, kind: str, hnoun: str, seat: int | None = None) -> str:
    """'a man paddling a canoe', 'a woman at the wheel of a speedboat'."""
    art = "an" if hnoun[:1] in "aeiou" else "a"
    if seat is None and kind not in ("canoe", "kayak", "raft"):
        return f"{noun} {'sailing in' if kind in SAIL else 'riding in'} {art} {hnoun}"
    if kind in ("canoe", "kayak", "raft"):
        return f"{noun} paddling {art} {hnoun}"
    if kind == "rowboat":
        return f"{noun} rowing {art} {hnoun}" if seat == 0 else f"{noun} sitting in {art} {hnoun}"
    if kind == "log_raft":
        return f"{noun} poling {art} {hnoun}" if seat == 0 else f"{noun} sitting on {art} {hnoun}"
    if kind in SAIL:
        return f"{noun} sailing {art} {hnoun}" if seat == 0 else f"{noun} aboard {art} {hnoun}"
    if seat == 0:
        return f"{noun} at the wheel of {art} {hnoun}"
    return f"{noun} riding in {art} {hnoun}"


def water_lock(scene: dict, boats: list, words) -> dict:
    """Only these boats on the water (the video models add ferries, jet skis and swimmers)."""
    w = words(boats)
    sea = sea_words(scene)
    return {"still": f"{sea + ', ' if sea else ''}the only boats on the water are {w}",
            "motion": (f"The water is empty apart from {w} for the whole shot, from the first frame to the last; "
                       "each boat stays whole, sits in the water at its own waterline and leaves its own wake."),
            "negative": "extra boats, duplicate boats, swimmers, a boat floating above the water, a boat with no wake, boats passing through each other"}
