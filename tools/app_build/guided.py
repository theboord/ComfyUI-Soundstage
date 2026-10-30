"""Guided App panel: the stage's own step screens (② Frame, ③ Motion, ⑤ Deliver) drive the step gate, the model
pickers, the touch-up switch, Quality and the audio toggle, so the App panel shows just the stage (and Run).
Everything stays reachable in graph mode."""


def apply(g):
    ld = g.w.setdefault("extra", {}).setdefault("linearData", {"inputs": [], "outputs": []})
    ld["inputs"] = [x for x in ld.get("inputs", []) if str(x[0]).endswith(":stage") or x[1] == "stage"]

    # The look still is a real output (saved), so chosen frames survive restarts and come back on the Ladder.
    for n in g.w["nodes"]:
        if n.get("id") == 9058 and n.get("type") == "PreviewImage":
            n["type"] = "SaveImage"
            n["widgets_values"] = ["soundstage/look"]
            n.setdefault("properties", {})["Node name for S&R"] = "SaveImage"
