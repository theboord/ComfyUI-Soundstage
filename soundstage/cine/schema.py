"""JSON Schemas for the cinematic KB and the advisor's shot list, plus a tiny validator.

The KB entry schema follows research/08 §7.4 (draft 2020-12) with three additions the advisor
needs: `keywords` (retrieval), `subject` / `horizontal` on shot templates (so a recipe can be
placed in 3D without guessing who a shot is on), and `prompt_fragments.still` (style words for
the look still). Shot movements are a closed vocabulary so the prompt compilers can map each one
to the verb its target model documents.

The validator implements only the keywords these schemas use, so the pack has no dependency on
the `jsonschema` package (tests cross-check against it when it is installed).
"""
from __future__ import annotations

import re

SIZES = ["EWS", "WS", "FS", "COWBOY", "MS", "MCU", "CU", "ECU", "INSERT"]
FRAMINGS = ["single", "dirty_single", "two_shot", "fifty_fifty", "three_shot", "group", "ots", "pov",
            "insert", "establishing", "reaction", "master"]
ANGLES = ["overhead", "high", "eye", "low", "worms_eye", "dutch"]
HEIGHTS = ["ground", "knee", "hip", "seated", "chest", "eye", "high", "aerial"]
HORIZONTALS = ["front", "three_quarter_front", "profile", "three_quarter_back", "back"]
SUBJECTS = ["A", "B", "C", "both", "all", "env", "A_hands", "B_hands", "prop"]
MOVEMENTS = ["static", "dolly_in", "dolly_out", "pan_left", "pan_right", "tilt_up", "tilt_down",
             "truck_left", "truck_right", "track_follow", "track_lead", "arc_left", "arc_right",
             "crane_up", "crane_down", "handheld", "steadicam_follow", "zoom_in", "snap_zoom",
             "whip_pan", "dolly_zoom", "rack_focus"]
SPEEDS = ["slow", "regular", "fast"]
LENS_LOOKS = ["spherical", "anamorphic", "fisheye", "macro", "tilt_shift", "split_diopter"]
DOFS = ["shallow", "medium", "deep"]
ENTRY_TYPES = ["genre", "subgenre", "movement", "national_cinema", "director_technique", "dp_technique",
               "emotion_recipe", "coverage_pattern", "lighting_style", "color_look", "lens_look"]
INTENTS = ["tension", "suspense", "intimacy", "isolation", "power_imbalance", "dread", "comedy", "romance",
           "chaos", "awe", "grief", "triumph", "paranoia", "nostalgia", "disorientation", "menace", "joy",
           "melancholy", "realism", "spectacle", "energy"]

_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}

KB_ENTRY_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "soundstage/cine_kb/entry.schema.json",
    "title": "Soundstage CineKB entry",
    "type": "object",
    "required": ["id", "type", "name", "summary", "intent_tags", "signature", "recipes", "prompt_fragments",
                 "sources", "confidence", "rights"],
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "pattern": r"^[a-z0-9_]+(\.[a-z0-9_]+)*$"},
        "type": {"enum": ENTRY_TYPES},
        "name": {"type": "string", "minLength": 2},
        "aliases": _STRS,
        "keywords": _STRS,
        "parent": {"type": ["string", "null"]},
        "era": _STR,
        "summary": {"type": "string", "minLength": 40, "maxLength": 900},
        "intent_tags": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/intent"}},
        "signature": {"$ref": "#/$defs/signature"},
        "rules": {"type": "array", "items": {"$ref": "#/$defs/rule"}},
        "recipes": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/recipe"}},
        "avoid": {"type": "array", "items": {
            "type": "object", "required": ["what", "why"], "additionalProperties": False,
            "properties": {"what": _STR, "why": _STR}}},
        "prompt_fragments": {
            "type": "object", "additionalProperties": False, "required": ["ltx", "still"],
            "properties": {"ltx": _STR, "still": _STR, "h3": _STR, "flux3_video": _STR, "flux3_image": _STR}},
        "camera3d_defaults": {"$ref": "#/$defs/camera3d"},
        "reference_works": {"type": "array", "items": {
            "type": "object", "required": ["title", "year"], "additionalProperties": False,
            "properties": {"title": _STR, "year": {"type": "integer"}, "note": _STR}}},
        "sources": {"type": "array", "items": {
            "type": "object", "required": ["url"], "additionalProperties": False,
            "properties": {"url": {"type": "string", "pattern": r"^https?://"}, "supports": _STR}}},
        "confidence": {"enum": ["verified", "craft_consensus", "interpretive"]},
        "rights": {
            "type": "object", "required": ["text_license", "contains_media"], "additionalProperties": False,
            "properties": {"text_license": _STR, "contains_media": {"const": False}}},
    },
    "$defs": {
        "intent": {"enum": INTENTS},
        "weights": {"type": "object", "additionalProperties": {"type": "number", "minimum": 0, "maximum": 1}},
        "range": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
        "signature": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "shot_size": {"$ref": "#/$defs/weights"},
                "framing": {"$ref": "#/$defs/weights"},
                "angle": {"$ref": "#/$defs/weights"},
                "camera_height": {"$ref": "#/$defs/weights"},
                "lens_mm_ff": {"$ref": "#/$defs/range"},
                "lens_look": {"$ref": "#/$defs/weights"},
                "movement": {"$ref": "#/$defs/weights"},
                "rig": {"$ref": "#/$defs/weights"},
                "lighting": {"$ref": "#/$defs/weights"},
                "color": _STRS,
                "composition": {"$ref": "#/$defs/weights"},
                "aspect_ratio": _STRS,
                "asl_seconds": {"$ref": "#/$defs/range"},
                "editing": _STRS,
                "sound": _STRS,
            },
        },
        "rule": {
            "type": "object", "required": ["when", "then", "why"], "additionalProperties": False,
            "properties": {"when": _STR, "then": _STR, "why": _STR, "hard": {"type": "boolean"}}},
        "shot_template": {
            "type": "object", "required": ["purpose", "size", "subject"], "additionalProperties": False,
            "properties": {
                "purpose": _STR,
                "size": {"enum": SIZES},
                "framing": {"enum": FRAMINGS},
                "subject": {"enum": SUBJECTS},
                "angle": {"enum": ANGLES},
                "horizontal": {"enum": HORIZONTALS},
                "height": {"enum": HEIGHTS},
                "lens_mm_ff": {"type": "number", "minimum": 8, "maximum": 600},
                "lens_look": {"enum": LENS_LOOKS},
                "dof": {"enum": DOFS},
                "movement": {"enum": MOVEMENTS},
                "speed": {"enum": SPEEDS},
                "lighting": _STR,
                "composition": _STR,
                "duration_s": {"type": "number", "exclusiveMinimum": 0, "maximum": 120},
                "note": _STR,
            },
        },
        "recipe": {
            "type": "object", "required": ["name", "shots", "why"], "additionalProperties": False,
            "properties": {
                "name": _STR,
                "beat": _STR,
                "cast": {"type": "integer", "minimum": 0, "maximum": 6},
                "shots": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/shot_template"}},
                "why": {"type": "string", "minLength": 20},
            },
        },
        "camera3d": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "mode": {"const": "orbit"},
                "target_height_m": {"type": "number"},
                "yaw_deg": {"type": "number"},
                "pitch_deg": {"type": "number", "minimum": -89, "maximum": 89},
                "distance_m": {"type": "number", "exclusiveMinimum": 0},
                "roll_deg": {"type": "number"},
                "focal_mm_ff": {"type": "number"},
                "vfov_deg": {"type": "number"},
            },
        },
    },
}

_VEC3 = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}
_STAGE_CAM = {"type": "object", "required": ["position", "target", "focal_mm"],
              "properties": {"position": _VEC3, "target": _VEC3, "focal_mm": {"type": "number", "minimum": 8}}}

SHOT_LIST_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "soundstage/cine_kb/shot_list.schema.json",
    "title": "Soundstage advisor shot list",
    "type": "object",
    "required": ["scene_id", "scene_text", "picks", "cast", "axis_of_action", "shots", "coverage_check", "backend"],
    "properties": {
        "scene_id": _STR,
        "scene_text": _STR,
        "backend": {"enum": ["rules", "ollama", "llm_draft"]},
        "picks": {"type": "object"},
        "intents": _STRS,
        "cast": {"type": "array", "items": {
            "type": "object", "required": ["id", "description", "position", "height_m"],
            "properties": {"id": _STR, "description": _STR, "position": _VEC3, "height_m": {"type": "number"}}}},
        "axis_of_action": {"type": "object", "required": ["from", "to", "side"],
                           "properties": {"from": _STR, "to": _STR, "side": {"enum": ["A", "B"]}}},
        "shots": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/shot"}},
        "coverage_check": {"type": "object"},
        "notes": _STRS,
    },
    "$defs": {
        "shot": {
            "type": "object",
            "required": ["shot_id", "purpose", "subject", "size", "framing", "angle", "lens", "movement", "lighting",
                         "blocking", "duration", "rationale", "camera3d", "prompts"],
            "properties": {
                "shot_id": _STR,
                "purpose": _STR,
                "subject": {"enum": SUBJECTS},
                "size": {"enum": SIZES},
                "framing": {"enum": FRAMINGS},
                "angle": {"type": "object", "required": ["vertical", "horizontal", "height"], "properties": {
                    "vertical": {"enum": ANGLES}, "horizontal": {"enum": HORIZONTALS + ["ots"]},
                    "height": {"enum": HEIGHTS}, "height_m": {"type": "number"}, "dutch_deg": {"type": "number"}}},
                "lens": {"type": "object", "required": ["focal_mm_ff", "look", "dof"], "properties": {
                    "focal_mm_ff": {"type": "number", "minimum": 8}, "look": {"enum": LENS_LOOKS},
                    "dof": {"enum": DOFS}, "vfov_deg": {"type": "number"}}},
                "movement": {"type": "object", "required": ["id", "speed"], "properties": {
                    "id": {"enum": MOVEMENTS}, "speed": {"enum": SPEEDS}, "rig": _STR}},
                "lighting": _STR,
                "composition": _STR,
                "blocking": {"type": "object", "required": ["subjects", "side_of_line"], "properties": {
                    "subjects": {"type": "array"}, "side_of_line": {"enum": ["A", "B", "on_axis"]}}},
                "duration": {"type": "object", "required": ["seconds", "fps", "frames"], "properties": {
                    "seconds": {"type": "number"}, "fps": {"type": "number"},
                    "frames": {"type": "integer", "minimum": 9}}},
                "rationale": {"type": "object", "required": ["why", "kb_refs"], "properties": {
                    "why": {"type": "string", "minLength": 20}, "kb_refs": {"type": "array", "minItems": 1, "items": _STR},
                    "alternatives": _STRS}},
                "camera3d": {"type": "object", "required": ["position", "target", "focal_mm", "end"], "properties": {
                    "position": _VEC3, "target": _VEC3, "focal_mm": {"type": "number", "minimum": 8},
                    "end": _STAGE_CAM, "vfov_deg": {"type": "number"}, "yaw_deg": {"type": "number"},
                    "pitch_deg": {"type": "number"}, "distance_m": {"type": "number"}}},
                "prompts": {"type": "object", "required": ["ltx", "still", "still_negative"], "properties": {
                    "ltx": {"type": "string", "minLength": 40}, "still": {"type": "string", "minLength": 40},
                    "still_negative": _STR, "h3": _STR}},
            },
        },
    },
}


# --------------------------------------------------------------------------------------------
# Minimal validator for the keywords used above.

_TYPES = {
    "object": dict, "array": list, "string": str, "boolean": bool, "null": type(None),
    "integer": int, "number": (int, float),
}


def _is_type(value, name: str) -> bool:
    if name in ("integer", "number") and isinstance(value, bool):
        return False
    if name == "integer" and isinstance(value, float):
        return value.is_integer()
    return isinstance(value, _TYPES[name])


def _resolve(root: dict, ref: str) -> dict:
    node = root
    for part in ref.lstrip("#/").split("/"):
        node = node[part]
    return node


def iter_errors(value, schema: dict, root: dict | None = None, path: str = "$"):
    """Yield human-readable error strings ("$.recipes[0].shots[2].size: 'XL' not in [...]")."""
    root = root if root is not None else schema
    if "$ref" in schema:
        yield from iter_errors(value, _resolve(root, schema["$ref"]), root, path)
        return
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_is_type(value, t) for t in types):
            yield f"{path}: expected {'/'.join(types)}, got {type(value).__name__}"
            return
    if "enum" in schema and value not in schema["enum"]:
        yield f"{path}: {value!r} not one of {schema['enum']}"
    if "const" in schema and value != schema["const"]:
        yield f"{path}: must be {schema['const']!r}"
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            yield f"{path}: shorter than {schema['minLength']} chars"
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            yield f"{path}: longer than {schema['maxLength']} chars ({len(value)})"
        if "pattern" in schema and not re.search(schema["pattern"], value):
            yield f"{path}: {value!r} does not match {schema['pattern']}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            yield f"{path}: {value} < minimum {schema['minimum']}"
        if "maximum" in schema and value > schema["maximum"]:
            yield f"{path}: {value} > maximum {schema['maximum']}"
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            yield f"{path}: {value} <= {schema['exclusiveMinimum']}"
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            yield f"{path}: fewer than {schema['minItems']} items"
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            yield f"{path}: more than {schema['maxItems']} items"
        if "items" in schema:
            for i, item in enumerate(value):
                yield from iter_errors(item, schema["items"], root, f"{path}[{i}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                yield f"{path}: missing required '{key}'"
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in props:
                yield from iter_errors(item, props[key], root, f"{path}.{key}")
            elif extra is False:
                yield f"{path}: unexpected key '{key}'"
            elif isinstance(extra, dict):
                yield from iter_errors(item, extra, root, f"{path}.{key}")


def validate(value, schema: dict) -> list[str]:
    return list(iter_errors(value, schema))
