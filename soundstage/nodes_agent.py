"""Soundstage Scene agent nodes: the same agent as the stage's Describe / chat boxes, as graph nodes.

SoundstageSceneAgent   scene description (+ optional model answer) -> stage scene JSON
SoundstageSceneEdit    scene JSON + chat command (+ optional model answer) -> edited scene JSON + undoable ops
SoundstageSceneBrief   system + user prompt for core TextGenerate (qwen3.5_4b_bf16); wire its text into llm_text

Without llm_text the rules backend answers alone (no model, no GPU).
"""
from __future__ import annotations

import json

from comfy_api.latest import IO

from .agent import core
from .agent import prompts as PR
from .agent.validate import validate_scene


class SoundstageSceneAgent(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageSceneAgent",
            display_name="Soundstage · Scene Agent (describe)",
            category="Soundstage",
            description="Describe a scene in words; returns a stage scene with set, cast on marks, props, time of day, "
                        "film lights and 1-4 camera setups from the Director's Advisor.",
            inputs=[
                IO.String.Input("description", multiline=True, default="two gunfighters face off at noon on a dusty western street"),
                IO.String.Input("genre", default="", optional=True),
                IO.String.Input("llm_text", multiline=True, default="", optional=True, force_input=True,
                                tooltip="Optional: the TextGenerate answer to the Scene Brief prompts."),
            ],
            outputs=[IO.String.Output("scene_json"), IO.String.Output("out_notes")],
        )

    @classmethod
    def execute(cls, description, genre="", llm_text="") -> IO.NodeOutput:
        res = core.describe(description, genre or "", llm_text or None)
        notes = [f"backend: {res['backend']}"] + res["notes"] + [f"to design: {d['name']}" for d in res["designs"]]
        return IO.NodeOutput(json.dumps(res["scene"]), "\n".join(notes))


class SoundstageSceneEdit(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageSceneEdit",
            display_name="Soundstage · Scene Agent (chat edit)",
            category="Soundstage",
            description="Apply a chat command (\"move the car closer to the streetlamp\") to a stage scene.",
            inputs=[
                IO.String.Input("scene_json", multiline=True, force_input=True),
                IO.String.Input("command", default="make it night with rain"),
                IO.String.Input("llm_text", multiline=True, default="", optional=True, force_input=True),
            ],
            outputs=[IO.String.Output("out_scene_json"), IO.String.Output("ops_json"), IO.String.Output("summary")],
        )

    @classmethod
    def execute(cls, scene_json, command, llm_text="") -> IO.NodeOutput:
        res = core.edit(json.loads(scene_json or "{}"), command, llm_text or None)
        return IO.NodeOutput(json.dumps(res["scene"]), json.dumps({"ops": res["ops"], "inverse": res["inverse"]}),
                             res["summary"])


class SoundstageSceneBrief(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageSceneBrief",
            display_name="Soundstage · Scene Agent brief (for TextGenerate)",
            category="Soundstage",
            inputs=[
                IO.Combo.Input("mode", options=["build", "edit"], default="build"),
                IO.String.Input("text", multiline=True, default=""),
                IO.String.Input("scene_json", multiline=True, default="", optional=True, force_input=True),
            ],
            outputs=[IO.String.Output("system_prompt"), IO.String.Output("prompt"), IO.Int.Output("max_length")],
        )

    @classmethod
    def execute(cls, mode, text, scene_json="") -> IO.NodeOutput:
        if mode == "edit":
            scene = validate_scene(json.loads(scene_json) if scene_json else {})[0]
            return IO.NodeOutput(PR.EDIT_SYSTEM, PR.edit_user(text, scene), PR.MAX_LENGTH["edit"])
        return IO.NodeOutput(PR.BUILD_SYSTEM, PR.build_user(text), PR.MAX_LENGTH["build"])


NODES = [SoundstageSceneAgent, SoundstageSceneEdit, SoundstageSceneBrief]
