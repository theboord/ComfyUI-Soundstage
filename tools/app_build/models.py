"""Model pickers in the Soundstage App: any still model at rung 2, any video model at rung 4.

Each rung gets a lazy core ComfySwitchNode: off = the Soundstage path (Krea 2 + depth look still, LTX-2.5
Layout-to-Render final), on = the router node (SoundstageEditImage / SoundstageGenerateVideo)
with its DynamicCombo `model` dropdown. The unused branch is never evaluated. Router seeds are `fixed` so
the ladder's cached rungs stay valid between queues. The still picker is on by default (FLUX 3 Klein is the App's
image model) and already sits in the base Soundstage_App.json; the video picker is off (LTX-2.5 L2R).
"""
from graph import Graph

STILL_DEFAULT = "FLUX 3 Klein · local [<$5M]"
VIDEO_DEFAULT = "LTX-2.5 22B distilled · local [<$10M]"

ROUTER_MEDIA = [("ref_1", "IMAGE"), ("ref_2", "IMAGE"), ("ref_3", "IMAGE")]


def _switch(g: Graph, pos, title, typ) -> int:
    return g.add_node("ComfySwitchNode", pos, inputs=[("on_false", typ), ("on_true", typ), ("switch", "BOOLEAN", "switch")],
                      outputs=[("output", typ)], widgets=[False], title=title, size=(300, 80))


def _reroute_consumers(g: Graph, src: int, slot: int, new_src: int, skip=()) -> None:
    for dst, dslot in g.consumers(src, slot):
        if dst not in skip:
            g.link(new_src, 0, dst, dslot)


def _existing_still_picker(g: Graph) -> int | None:
    """The base App may already carry the still picker (Soundstage_App.json has it, so ④ Frame can run FLUX 3 Klein
    there too): reuse it instead of adding a second one."""
    for n in g.nodes.values():
        if (n.get("title") or "").startswith("Still model · use picker") and g.source_of(n["id"], "on_false") == (9057, 0):
            return n["id"]
    return None


def apply(g: Graph) -> None:
    # ------------------------------------------------ rung 2: look still
    x, y = g.nodes[9057]["pos"]
    sw_still = _existing_still_picker(g)
    if sw_still is None:
        sw_still = _add_still_picker(g, x, y)

    # ------------------------------------------------ rung 4: final video
    sw_video, video = _add_video_picker(g, sw_still)
    still = g.source_of(sw_still, "on_true")[0]

    # ------------------------------------------------ App panel
    g.expose(sw_still, "switch")
    g.expose(still, "model")
    g.expose(sw_video, "switch")
    g.expose(video, "model")


def _add_still_picker(g: Graph, x, y) -> int:
    size = g.add_node("GetImageSize", (x - 520, y + 700), inputs=[("image", "IMAGE")],
                      outputs=[("width", "INT"), ("height", "INT"), ("batch_size", "INT")], size=(200, 70))
    still = g.add_node(
        "SoundstageEditImage", (x - 520, y + 800),
        inputs=[("image", "IMAGE"), ("control_image", "IMAGE"), ("mask", "MASK"), *ROUTER_MEDIA,
                ("prompt", "STRING", "prompt"), ("width", "INT", "width"), ("height", "INT", "height"),
                ("model", "COMFY_DYNAMICCOMBO_V3", "model"), ("seed", "INT", "seed"), ("negative", "STRING", "negative")],
        outputs=[("image", "IMAGE")],
        widgets=["", 0, 0, STILL_DEFAULT, 0, "fixed", ""],
        title="Still model (any)", size=(420, 380))
    g.link(9045, "first_color", size, "image")
    g.link(9045, "first_color", still, "image")
    g.link(9045, "first_depth", still, "control_image")
    g.link(9079, "still_prompt", still, "prompt")
    g.link(9079, "still_negative", still, "negative")
    g.link(size, "width", still, "width")
    g.link(size, "height", still, "height")
    sw_still = _switch(g, (x, y + 420), "Still model · use picker (off = Soundstage Krea 2 + depth)", "IMAGE")
    g.nodes[sw_still]["widgets_values"] = [True]   # FLUX 3 Klein is the App's default image model
    _reroute_consumers(g, 9057, 0, sw_still)  # 9061 gate, 9002 look_still, 9034 stage-2 look still
    g.link(9057, 0, sw_still, "on_false")
    g.link(still, "image", sw_still, "on_true")
    return sw_still


def _add_video_picker(g: Graph, sw_still: int) -> tuple[int, int]:
    x, y = g.nodes[5518]["pos"]
    video = g.add_node(
        "SoundstageGenerateVideo", (x, y + 900),
        inputs=[("first_frame", "IMAGE"), ("last_frame", "IMAGE"), ("control_video", "IMAGE"), *ROUTER_MEDIA,
                ("prompt", "STRING", "prompt"), ("width", "INT", "width"), ("height", "INT", "height"),
                ("frames", "INT", "frames"), ("fps", "FLOAT", "fps"), ("model.mode", "COMBO", "model.mode"),
                ("model", "COMFY_DYNAMICCOMBO_V3", "model"), ("seed", "INT", "seed"), ("negative", "STRING", "negative")],
        outputs=[("video", "VIDEO"), ("frames", "IMAGE")],
        widgets=["", 1920, 1088, 97, 24, VIDEO_DEFAULT, "auto", 0, "fixed", ""],
        title="Video model (any)", size=(420, 440))
    g.link(9079, "motion_prompt", video, "prompt")
    g.link(sw_still, 0, video, "first_frame", "IMAGE")
    g.link(9045, "clay", video, "control_video")
    g.link(9045, "frames", video, "frames")
    g.link(9045, "fps", video, "fps")
    sw_video = _switch(g, (x + 260, y + 700), "Video model · use picker (off = Soundstage LTX-2.5 L2R)", "VIDEO")
    _reroute_consumers(g, 5518, 0, sw_video)  # 9065 gate -> 4852, 9066 layer-pack frames
    g.link(5518, 0, sw_video, "on_false")
    g.link(video, "video", sw_video, "on_true")
    return sw_video, video
