"""Soundstage LOOK node: Cinema-Studio-style look controls -> the prompts for rung 2 (look still) and rung 3+ (LTX).

SoundstageLook   look JSON (filled by the Look tab, or a typed look like "Korean thriller, anamorphic,
                 teal-orange") + optional scene_json from SoundstageStage
                 -> still_prompt (frame 1 only), still_negative, motion_prompt (LTX), look_json.

The stage owns the physical shot (blocking, lens, time of day, weather); the look owns how it is photographed.
Changing only the look leaves SoundstageStage's value untouched, so the ladder re-runs from rung 2.
Pure Python, no model or GPU. Also registers POST /soundstage/look/compile for the panel's live preview.
"""
from __future__ import annotations

import json
import logging

from comfy_api.latest import IO

from .look.compile import compile_look
from .look.vocab import parse_look_input

try:  # inside ComfyUI only: the live-preview route
    from .look import routes as _routes  # noqa: F401
except Exception as e:  # pragma: no cover - no server when imported by tests
    if not isinstance(e, ImportError):
        logging.exception("Soundstage: look preview route not registered")

LOOK_PLACEHOLDER = ("Filled by the Look tab. Or type a look, e.g. 'Korean thriller, anamorphic, teal-orange, "
                    "a detective and a witness at dusk'.")


def _scene(scene_json: str | None) -> dict | None:
    if not scene_json or not str(scene_json).strip():
        return None
    try:
        data = json.loads(scene_json)
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and isinstance(data.get("scene"), dict):  # the raw stage widget value
        data = data["scene"]
    return data if isinstance(data, dict) else None


class SoundstageLook(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLook",
            display_name="Soundstage · Look",
            category="Soundstage",
            search_aliases=["look", "cinema studio", "camera body", "lens", "film stock", "palette", "grade", "genre"],
            description="Cinema-Studio-style look: camera body, lens character, aperture, film stock, colour palette, "
                        "genre/subgenre, national cinema, era, director technique, mood and grade. Compiles a "
                        "frame-1-only still prompt (+ negative) and an LTX motion prompt from the stage scene: who "
                        "is where in frame 1, the camera move from start to end and every actor's marks.",
            is_output_node=True,
            inputs=[
                IO.String.Input("look", default="", multiline=True, socketless=True, placeholder=LOOK_PLACEHOLDER,
                                tooltip="Look JSON from the Look tab, or a typed look description."),
                IO.String.Input("scene_json", force_input=True, optional=True,
                                tooltip="scene_json from Soundstage · 3D Stage. Empty = the default walk-in scene."),
            ],
            outputs=[
                IO.String.Output("out_still_prompt", display_name="still_prompt",
                                 tooltip="Frame 1 only: who is where at the start, head count, lens, look."),
                IO.String.Output("out_still_negative", display_name="still_negative"),
                IO.String.Output("out_motion_prompt", display_name="motion_prompt",
                                 tooltip="LTX paragraph: blocking, marks, the camera move and its end frame, look."),
                IO.String.Output("out_look_json", display_name="look_json",
                                 tooltip="Normalised look + prompts + KB refs + notes."),
            ],
        )

    @classmethod
    def execute(cls, look="", scene_json=None) -> IO.NodeOutput:
        data, typed = parse_look_input(look)
        result = compile_look(data, _scene(scene_json))
        result["notes"] = typed + result["notes"]
        summary = "\n\n".join([f"STILL (frame 1)\n{result['still_prompt']}", f"NEGATIVE\n{result['still_negative']}",
                               f"MOTION (LTX)\n{result['motion_prompt']}"]
                              + ([f"NOTES\n" + "\n".join(result["notes"])] if result["notes"] else []))
        return IO.NodeOutput(result["still_prompt"], result["still_negative"], result["motion_prompt"],
                             json.dumps(result, ensure_ascii=False), ui={"text": [summary]})


NODES = [SoundstageLook]
