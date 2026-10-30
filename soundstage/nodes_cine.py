"""Soundstage Director's Advisor nodes: shot planning from the cinematic knowledge base.

SoundstageAdvisor        scene + picks -> shot list JSON (size/angle/lens/height/move/blocking/light,
                         rationale + KB citations, camera3d in stage coordinates, prompts).
SoundstageAdvisorBrief   system + user prompt for core TextGenerate (e.g. qwen3.5_4b_bf16); wire its
                         generated_text into the Advisor's llm_draft input.
SoundstageShotPrompt     one shot of a shot list -> LTX paragraph, frame-1 still prompt + negative,
                         H3 block, frame count and the stage camera JSON.
SoundstageCoverageDoctor 180 / 30 degree, screen-direction, geography and LTX-timing checks.

The rules backend is the default and needs no model, network or GPU.
"""
from __future__ import annotations

import json

from comfy_api.latest import IO

from .cine.advisor import advise, plan, stage_cameras, summary_text, to_json
from .cine.coverage import check_coverage, report_text
from .cine.kb import get_kb
from .cine.llm import advise_llm, build_brief
from .cine.prompts import compile_shot

KB = get_kb()
BACKENDS = ["rules", "ollama", "llm_draft"]


def _choices(picker: str) -> list[str]:
    return ["auto", "none"] + KB.picker_labels(picker)


def _picks(genre, movement, technique, intent, coverage) -> dict:
    return {"genre": genre, "movement": movement, "technique": technique, "intent": intent, "coverage": coverage}


def _stage(stage_scene: str | None) -> dict | None:
    if not stage_scene or not stage_scene.strip():
        return None
    try:
        data = json.loads(stage_scene)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _load_shot_list(text: str) -> dict:
    data = json.loads(text)
    if not isinstance(data, dict) or not data.get("shots"):
        raise ValueError("expected a Soundstage shot list JSON with a 'shots' array")
    return data


def _pick_inputs() -> list:
    return [
        IO.Combo.Input("genre", options=_choices("genre"), default="auto",
                       tooltip="Genre / subgenre. auto = matched from the scene text."),
        IO.Combo.Input("movement", options=_choices("movement"), default="auto",
                       tooltip="Film movement or national cinema, blended in as style (lens band, handheld, look)."),
        IO.Combo.Input("technique", options=_choices("technique"), default="auto",
                       tooltip="Director / DP technique, named by what it does. A picked technique usually supplies the shot recipe."),
        IO.Combo.Input("intent", options=_choices("intent"), default="auto",
                       tooltip="The emotion the beat should produce (tension, intimacy, isolation...)."),
        IO.Combo.Input("coverage", options=_choices("coverage"), default="auto",
                       tooltip="Coverage pattern (dialogue triangle, table scene, walk-and-talk...)."),
    ]


class SoundstageAdvisor(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageAdvisor",
            display_name="Soundstage · Director's Advisor",
            category="Soundstage",
            search_aliases=["shot list", "director", "advisor", "coverage", "cinematography"],
            description="Plans the coverage for a scene from a cinematic knowledge base: every shot gets size, angle, "
                        "lens, height, move, blocking and light, the reason it works with KB citations, a 3D camera "
                        "in stage coordinates and compiled prompts. Rules backend works offline.",
            is_output_node=True,
            inputs=[
                IO.String.Input("scene", multiline=True, default="Two gunfighters face off in a dusty street at noon. "
                                "Neither will back down.", tooltip="What happens, where, when."),
                IO.String.Input("beat", default="", tooltip="Optional intent or curve, e.g. 'tension rising to the draw'."),
                *_pick_inputs(),
                IO.String.Input("characters", multiline=True, default="", optional=True,
                                tooltip="Optional, one per line: 'Cole: weathered gunfighter in a duster'. "
                                        "Order = A, B, C. Empty = guessed from the scene."),
                IO.Int.Input("max_shots", default=0, min=0, max=20, tooltip="0 = the recipe's natural length."),
                IO.Float.Input("fps", default=24.0, min=8.0, max=60.0, step=1.0),
                IO.Int.Input("preview_shot", default=1, min=1, max=20,
                             tooltip="Which shot feeds the prompt / camera / frames outputs."),
                IO.Combo.Input("backend", options=BACKENDS, default="rules",
                               tooltip="rules = offline KB recipes (default, always works). ollama = local LLM via "
                                       "Ollama HTTP. llm_draft = parse the llm_draft input (from core TextGenerate). "
                                       "Any LLM failure falls back to rules."),
                IO.String.Input("ollama_model", default="qwen3:4b", optional=True),
                IO.String.Input("ollama_url", default="http://127.0.0.1:11434", optional=True),
                IO.String.Input("stage_scene", force_input=True, optional=True,
                                tooltip="Scene JSON from Soundstage Stage: actor positions/heights are used for the cameras."),
                IO.String.Input("llm_draft", force_input=True, optional=True,
                                tooltip="generated_text from a TextGenerate fed by Soundstage · Advisor Brief."),
            ],
            outputs=[
                IO.String.Output("out_shot_list_json", display_name="shot_list_json"),
                IO.String.Output("out_summary", display_name="summary"),
                IO.String.Output("out_camera3d_json", display_name="camera3d_json"),
                IO.String.Output("out_ltx_prompt", display_name="ltx_prompt"),
                IO.String.Output("out_still_prompt", display_name="still_prompt"),
                IO.String.Output("out_still_negative", display_name="still_negative"),
                IO.Int.Output("out_frames", display_name="frames"),
            ],
        )

    @classmethod
    def execute(cls, scene, beat, genre, movement, technique, intent, coverage, max_shots, fps, preview_shot,
                backend, characters="", ollama_model="qwen3:4b", ollama_url="http://127.0.0.1:11434",
                stage_scene=None, llm_draft=None) -> IO.NodeOutput:
        picks = _picks(genre, movement, technique, intent, coverage)
        stage = _stage(stage_scene)
        if backend == "rules" or (backend == "llm_draft" and not (llm_draft or "").strip()):
            shot_list = advise(scene, beat, picks, characters or "", max_shots, fps, stage)
        else:
            shot_list = advise_llm(scene, beat, picks, characters or "", max_shots, fps, stage, backend=backend,
                                   llm_draft=llm_draft or "", model=ollama_model, url=ollama_url)
        shot = shot_list["shots"][min(preview_shot, len(shot_list["shots"])) - 1]
        summary = summary_text(shot_list)
        return IO.NodeOutput(to_json(shot_list), summary, json.dumps(stage_cameras(shot)), shot["prompts"]["ltx"],
                             shot["prompts"]["still"], shot["prompts"]["still_negative"], shot["duration"]["frames"],
                             ui={"text": [summary]})


class SoundstageAdvisorBrief(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageAdvisorBrief",
            display_name="Soundstage · Advisor Brief (for TextGenerate)",
            category="Soundstage",
            description="Builds the system and user prompt that let a core TextGenerate model (e.g. qwen3.5_4b_bf16) "
                        "compose the shot list from the retrieved KB entries. Feed its generated_text into the "
                        "Advisor's llm_draft input with backend = llm_draft.",
            inputs=[
                IO.String.Input("scene", multiline=True, default=""),
                IO.String.Input("beat", default=""),
                *_pick_inputs(),
                IO.String.Input("characters", multiline=True, default="", optional=True),
                IO.Int.Input("max_shots", default=0, min=0, max=20),
                IO.String.Input("stage_scene", force_input=True, optional=True),
            ],
            outputs=[IO.String.Output("out_system_prompt", display_name="system_prompt"), IO.String.Output("out_prompt", display_name="prompt")],
        )

    @classmethod
    def execute(cls, scene, beat, genre, movement, technique, intent, coverage, max_shots, characters="",
                stage_scene=None) -> IO.NodeOutput:
        p = plan(scene, beat, _picks(genre, movement, technique, intent, coverage), characters or "", _stage(stage_scene))
        system, user = build_brief(p, max_shots)
        return IO.NodeOutput(system, user)


class SoundstageShotPrompt(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageShotPrompt",
            display_name="Soundstage · Shot to Prompt",
            category="Soundstage",
            description="Compiles one shot of a shot list into an LTX paragraph (documented camera verbs, destination "
                        "frame), a frame-1-only still prompt + negative for the look still, an H3 shot block, the LTX "
                        "frame count and the stage camera JSON. Edits to the shot JSON flow through.",
            inputs=[
                IO.String.Input("shot_list_json", force_input=True),
                IO.Int.Input("shot", default=1, min=1, max=50),
                IO.String.Input("extra_detail", default="", optional=True,
                                tooltip="Appended to both prompts (wardrobe, props, a line of action)."),
            ],
            outputs=[
                IO.String.Output("out_ltx_prompt", display_name="ltx_prompt"),
                IO.String.Output("out_still_prompt", display_name="still_prompt"),
                IO.String.Output("out_still_negative", display_name="still_negative"),
                IO.String.Output("out_h3_prompt", display_name="h3_prompt"),
                IO.Int.Output("out_frames", display_name="frames"),
                IO.String.Output("out_camera3d_json", display_name="camera3d_json"),
                IO.String.Output("out_why", display_name="why"),
            ],
        )

    @classmethod
    def execute(cls, shot_list_json, shot, extra_detail="") -> IO.NodeOutput:
        sl = _load_shot_list(shot_list_json)
        idx = max(1, min(shot, len(sl["shots"]))) - 1
        s = sl["shots"][idx]
        context = {"cast": sl.get("cast", []), "location": sl.get("location", {}), "style": sl.get("style", {}),
                   "aspect_ratio": sl.get("style", {}).get("aspect_ratio", "")}
        prompts = compile_shot(s, context, idx + 1, s.get("duration", {}).get("start_s", 0.0))
        if extra_detail and extra_detail.strip():
            d = extra_detail.strip().rstrip(".")
            prompts["ltx"] += f" {d}."
            prompts["still"] += f", {d}"
        return IO.NodeOutput(prompts["ltx"], prompts["still"], prompts["still_negative"], prompts["h3"],
                             int(s["duration"]["frames"]), json.dumps(stage_cameras(s)), s["rationale"]["why"],
                             ui={"text": [prompts["ltx"]]})


class SoundstageCoverageDoctor(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageCoverageDoctor",
            display_name="Soundstage · Coverage Doctor",
            category="Soundstage",
            description="Script-supervisor checks over a shot list, measured from its 3D cameras: 180-degree line, "
                        "screen direction, 30-degree rule, geography before close-ups, LTX 8k+1 frames and move length.",
            is_output_node=True,
            inputs=[IO.String.Input("shot_list_json", force_input=True)],
            outputs=[IO.String.Output("out_report", display_name="report"), IO.String.Output("out_shot_list_json", display_name="shot_list_json"),
                     IO.Boolean.Output("out_passed", display_name="passed")],
        )

    @classmethod
    def execute(cls, shot_list_json) -> IO.NodeOutput:
        sl = _load_shot_list(shot_list_json)
        result = check_coverage(sl)
        sl["coverage_check"] = result
        report = report_text(result)
        return IO.NodeOutput(report, to_json(sl), result["verdict"] != "fail", ui={"text": [report]})


NODES = [SoundstageAdvisor, SoundstageAdvisorBrief, SoundstageShotPrompt, SoundstageCoverageDoctor]
