"""The two system prompts for the local model (Qwen3.5-4B through core TextGenerate) and the user messages.

Kept small on purpose: a 4B model follows a short enum-heavy schema with one example far better than a long
brief, and every token of output costs time. The model never writes coordinates: it names things, and the
rules place them. Answers are expected well under the max_length budgets below.
"""
from __future__ import annotations

from . import catalog as C
from . import cameras as CAM

MODEL = "qwen3.5_4b_bf16.safetensors"
MAX_LENGTH = {"build": 260, "edit": 200}

BUILD_SYSTEM = """You are a film previs assistant. Read a scene idea and answer with ONLY one JSON object, no prose.
{"set": "plaza"|"street_night"|"interior"|"studio"|"forest"|"desert"|"beach"|"water_tank"|"empty",
 "time": "dawn"|"golden_am"|"midday"|"overcast"|"magic_hour"|"blue_hour"|"night",
 "weather": "none"|"rain"|"snow"|"fog"|"smoke"|"dust"|"sparks",
 "genre": one word,
 "cast": [{"name": short name, "kind": "man"|"woman"|"child"|"dog"|"horse", "rides": optional "horse"|"bicycle"|"motorcycle"|"car", "passes": optional true}],
 "props": [2 to 5 big set-dressing objects that stand on the floor: furniture, vehicles, animals, structures],
 "blocking": "alone"|"face_off"|"across_table"|"side_by_side"|"group"|"chase"|"rescue"|"walk_and_talk",
 "lights": [] or some of "key","fill","rim","practical","spot","neon",
 "shots": 1 to 4}
Rules: street_night is any town or city street, by day too. interior is any room. empty suits rooftops and voids.
cast lists only the people and animals that act in the scene (1 to 4); a rider is ONE cast entry with "rides", not a
separate horse. "passes": true for whoever moves past or across. No hand props or clothing (no guns,
hats, cups, phones). Never write coordinates.
Example
Scene: a nurse comforts a frightened boy in a hospital corridor at night
{"set":"interior","time":"night","weather":"none","genre":"drama","cast":[{"name":"Nurse","kind":"woman"},{"name":"Boy","kind":"child"}],"props":["bench","plant pot","door"],"blocking":"side_by_side","lights":["practical","key"],"shots":3}"""

EDIT_SYSTEM = """You edit a 3D film set. Turn the director's command into edit ops. Answer with ONLY {"ops":[...]}, no prose.
Use names from the scene list, never coordinates. Ops:
{"op":"move","target":NAME,"near":NAME_OR_PLACE}
{"op":"move","target":NAME,"dir":"left"|"right"|"closer"|"back","amount":METRES}
{"op":"add","what":THING_OR_ROLE,"near":NAME_OR_PLACE}
{"op":"remove","target":NAME}
{"op":"rotate","target":NAME,"face":NAME} or {"op":"rotate","target":NAME,"deg":DEGREES}
{"op":"scale","target":NAME,"factor":NUMBER}
{"op":"time","preset":"dawn"|"golden_am"|"midday"|"overcast"|"magic_hour"|"blue_hour"|"night"}
{"op":"weather","weather":"none"|"rain"|"snow"|"fog"|"smoke"|"dust"|"sparks"}
{"op":"set","set":"plaza"|"street_night"|"interior"|"studio"|"forest"|"desert"|"beach"|"water_tank"|"empty"}
{"op":"light","type":"key"|"fill"|"rim"|"practical"|"spot"|"neon","on":NAME}
{"op":"shot","setup":"wide"|"two_shot"|"single"|"ots"|"insert"|"pov","on":NAME,"over":NAME}
{"op":"camera","move":"push_in"|"pull_out"|"higher"|"lower","focal":MM}
{"op":"mount","target":RIDER,"on":HORSE_BIKE_CAR_OR_SEAT} or {"op":"dismount","target":RIDER}
Example
Command: put a dog next to the bench and make it foggy
{"ops":[{"op":"add","what":"dog","near":"bench"},{"op":"weather","weather":"fog"}]}"""


def build_user(text: str, genre: str = "") -> str:
    g = f" ({genre})" if genre and genre.strip() else ""
    return f"Scene{g}: {text.strip()}"


def scene_context(scene: dict) -> str:
    """A few short lines describing the current scene for the edit prompt."""
    env = scene.get("environment", {})
    L = scene.get("lighting", {})
    lines = [f"Set: {env.get('set')}, time: {L.get('preset') or 'manual'}, weather: {env.get('weather', 'none')}"]
    items = []
    for a in scene.get("actors", [])[:16]:
        k = a.get("kind")
        what = (a.get("design") or (a.get("recipe") or {}).get("name")) if k == "custom" else k
        items.append(f"{a.get('name')} ({what})" if str(a.get("name", "")).lower() != str(what).lower() else str(a.get("name")))
    lines.append("On set: " + (", ".join(items) or "nothing"))
    places = [p for p in C.SETS.get(env.get("set"), C.SETS["empty"])["anchors"] if p not in ("centre",)]
    if places:
        lines.append("Places: " + ", ".join(places[:8]))
    shots = scene.get("shots") or []
    if shots:
        lines.append("Shots: " + ", ".join(s.get("name", s.get("id")) + ("*" if s.get("id") == scene.get("active_shot") else "")
                                           for s in shots[:6]))
    return "\n".join(lines)


def edit_user(command: str, scene: dict) -> str:
    return f"{scene_context(scene)}\nCommand: {command.strip()}"


def people_names(scene: dict) -> list[str]:
    return [a.get("name") for a in CAM.people(scene)]
