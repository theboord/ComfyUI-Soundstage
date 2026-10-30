"""Soundstage preview ladder: one Run button that climbs one rung per click.

SoundstageStep holds the current rung (1 Stage, 2 Look still, 3 Motion draft, 4 Final) and
increments itself after every Run, so pressing Run again advances to the next rung.
SoundstageGate sits directly in front of an output node. Below its rung it never asks for its
input (lazy), so nothing upstream of that output runs; at or above its rung it passes the value
through. Because the step only feeds the gates, which sit after all the heavy nodes, ComfyUI's
cache reuses every rung already computed: each Run only does the new work.
"""
from comfy_api.latest import IO
from comfy_execution.graph_utils import ExecutionBlocker

RUNGS = ["1 · Stage", "2 · Look still", "3 · Motion draft", "4 · Final", "5 · Layers"]
MISSING = object()


class SoundstageStep(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageStep",
            display_name="Soundstage · Next Step",
            category="Soundstage",
            search_aliases=["next", "ladder", "step", "preview ladder"],
            description="Which rung of the preview ladder to run: 1 Stage, 2 Look still, 3 Motion draft, 4 Final, 5 Layers. "
                        "Advances by one after each Run, so Run works as a Next button.",
            inputs=[
                IO.Int.Input("step", default=1, min=1, max=len(RUNGS),
                             control_after_generate=IO.ControlAfterGenerate.increment,
                             tooltip=" · ".join(RUNGS)),
            ],
            outputs=[IO.Int.Output(display_name="step")],
        )

    @classmethod
    def execute(cls, step: int) -> IO.NodeOutput:
        step = max(1, min(len(RUNGS), int(step)))
        return IO.NodeOutput(step, ui={"text": [f"Running up to {RUNGS[step - 1]}"]})


class SoundstageGate(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        template = IO.MatchType.Template("gate")
        return IO.Schema(
            node_id="SoundstageGate",
            display_name="Soundstage · Rung Gate",
            category="Soundstage",
            description="Put this right before an output node. Passes the value through once the ladder "
                        "reaches `rung`; below that, the output and everything feeding it is skipped.",
            inputs=[
                IO.Int.Input("step", default=1, min=1, max=len(RUNGS), force_input=True),
                IO.Int.Input("rung", default=2, min=1, max=len(RUNGS), tooltip=" · ".join(RUNGS)),
                IO.MatchType.Input("value", template=template, lazy=True),
            ],
            outputs=[IO.MatchType.Output(template=template, display_name="value")],
        )

    @classmethod
    def check_lazy_status(cls, step, rung, value=MISSING):
        if step >= rung and value is None:
            return ["value"]
        return []

    @classmethod
    def execute(cls, step, rung, value=MISSING) -> IO.NodeOutput:
        if step < rung or value is MISSING or value is None:
            return IO.NodeOutput(ExecutionBlocker(None))
        return IO.NodeOutput(value)


NODES = [SoundstageStep, SoundstageGate]
