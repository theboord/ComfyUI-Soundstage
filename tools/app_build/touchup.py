"""Touch-up step between the look still (rung 2) and motion (rungs 3-4), fed by the stage widget's Canvas tab.

  look still source ──────────────────────────┐ on_false
  SoundstageCanvasImage ("Touch-up · canvas   │
  still", a PNG in input/soundstage/) ────────┤ on_true    "Use touched-up still" (ComfySwitchNode, lazy, off)
                                              └─> every consumer of the look still: Gate rung 2 -> "Rung 2 · Look
                                                  still" preview, L2R look_still (9002), stage-2 look still, the
                                                  video-model first frame.

Off (default): the switch passes the look still through and never evaluates the canvas still, so every rung
computes exactly what it did before. The Canvas tab's "Use as look still" saves the composite to input/soundstage/,
writes its name into the canvas-still node and turns the switch on (web/touchup/touchup.mjs).

No canvas widget in the App panel: painting happens in the stage widget's Canvas tab. Only the switch is exposed.
Chains after the models part (tools/app_build/models.py) when it ran: the still source is then the
"Still model" switch, not VAEDecode 9057.
"""
from graph import Graph

LOOK_STILL = 9057
TITLE_SWITCH = "Use touched-up still"
TITLE_STILL = "Touch-up · canvas still"


def still_source(g: Graph) -> tuple[int, int]:
    """The node/slot that currently provides the look still to the rest of the graph."""
    for n in g.nodes.values():
        if n["type"] == "ComfySwitchNode" and g.source_of(n["id"], "on_false") == (LOOK_STILL, 0):
            return n["id"], 0  # models.py's "Still model · use picker" switch
    return LOOK_STILL, 0


def apply(g: Graph) -> None:
    if any(n.get("title") == TITLE_SWITCH for n in g.nodes.values()):
        return
    src, slot = still_source(g)
    consumers = g.consumers(src, slot)
    x, y = g.nodes[LOOK_STILL]["pos"]

    still = g.add_node("SoundstageCanvasImage", (x + 420, y + 540), inputs=[("image", "STRING", "image")],
                       outputs=[("image", "IMAGE")], widgets=[""], title=TITLE_STILL, size=(320, 80))
    sw = g.add_node("ComfySwitchNode", (x + 420, y + 420),
                    inputs=[("on_false", "IMAGE"), ("on_true", "IMAGE"), ("switch", "BOOLEAN", "switch")],
                    outputs=[("output", "IMAGE")], widgets=[False], title=TITLE_SWITCH, size=(300, 80))
    g.link(still, "image", sw, "on_true", "IMAGE")
    for dst, dslot in consumers:
        g.link(sw, 0, dst, dslot, "IMAGE")
    g.link(src, slot, sw, "on_false", "IMAGE")

    after = next((k[0].rsplit(":", 1)[1] for k in g.w.get("extra", {}).get("linearData", {}).get("inputs", [])
                  if k[0].split(":")[-2:-1] == [str(src)]), None)
    g.expose(sw, "switch", after=f"{src}:{after}" if after else None)
