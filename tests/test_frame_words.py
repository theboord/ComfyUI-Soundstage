"""Frame-1 and motion words that keep two cars apart and props blank (soundstage/look/identity.py), and the Klein
img2img start on the reference's own canvas (soundstage/router/adapters.py)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.look import identity as I  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402


def _crash(look_start=True, police_paint=None, one_car=False):
    """The crate crash in miniature: a red sports car and a police car down the street, a pyramid of crates."""
    actors = [{"id": "sports_car", "kind": "sports_car", "position": [1.6, 0, -24], "rotation_deg": 0, "height_m": 1.2,
               "appearance": {"color": "#c23b2a"}}]
    if not one_car:
        actors.append({"id": "police_car", "kind": "police_car", "position": [1.6, 0, -36], "rotation_deg": 0, "height_m": 1.6,
                       **({"appearance": {"color": police_paint}} if police_paint else {})})
    for k, (x, y) in enumerate([(-0.96, 0), (-0.15, 0), (0.68, 0), (1.49, 0), (-0.56, 0.8), (0.26, 0.8)]):
        actors.append({"id": f"crate_{k}", "kind": "crate", "position": [x, y, 6.2], "height_m": 0.8})
    scene = {"environment": {"set": "street_night"}, "shot": {"frames": 121, "fps": 24},
             "camera": {"position": [-4.5, 6, 18], "target": [1.2, 0.8, -28], "focal_mm": 28}, "actors": actors}
    if not look_start:
        scene["look_start"] = False
    return scene


def test_plain_words_keep_counts_and_articles():
    assert I.plain_word("a crate", "crate") == "a plain unmarked wooden crate"
    assert I.plain_word("several crates", "crate") == "several plain unmarked wooden crates"
    assert I.plain_word("a pair of crates", "crate") == "a pair of plain unmarked wooden crates"
    assert I.plain_word("a pair of boxes", "box") == "a pair of plain unmarked boxes"
    assert I.plain_word("a lamp post", "post") == "a lamp post"          # not a prop that gets lettered


def test_still_says_the_crates_are_plain_and_which_car_is_which():
    still = compile_look({}, _crash())["still_prompt"]
    assert "plain unmarked wooden crates" in still
    assert "the sports car painted crimson" in still
    assert "the police car black and white with a light bar on its roof" in still


def test_motion_anchors_each_cars_look_for_the_whole_shot():
    motion = compile_look({}, _crash())["motion_prompt"]
    assert ("The sports car is crimson and the police car is black and white with a light bar on its roof; "
            "each car keeps its own paint and lights from the first frame to the last.") in motion
    # a painted police car keeps its light bar; one car on its own needs no anchoring
    assert "the police car is midnight navy with a light bar on its roof" in compile_look({}, _crash(police_paint="#2b4a8c"))["motion_prompt"]
    lone = compile_look({}, _crash(one_car=True))
    assert "each car keeps" not in lone["motion_prompt"] and "painted crimson" not in lone["still_prompt"]


def test_frames_picked_before_milestone_5_compile_as_they_were():
    old = compile_look({}, _crash(look_start=False))
    assert "unmarked" not in old["still_prompt"] and "painted" not in old["still_prompt"]
    assert "each car keeps" not in old["motion_prompt"]


# ---- the Klein img2img start sits on the reference's canvas ---------------------------------------------------------

def test_klein_lock_start_is_encoded_on_the_reference_canvas():
    """ReferenceMultiLatent counts a megapixel as 1024 x 1024 px, so at the router's 1.51 "megapixels" a 1680x896
    frame's reference lands on 1723x919 (VAE-cropped to 1712x912), the canvas a from-noise frame is painted on. The
    stage-lock start must land there too: on the snapped 1680x896 canvas Klein painted dark rounded borders and the
    porthole vignette of M27's frame 1 (share/GhostCar_DetailLoss)."""
    from soundstage.router import adapters as A
    from tests.test_router_adapters import FakeGraph, base_p, link, WIRED
    m = next(x for x in WIRED if x["id"] == "open.flux3_klein")
    p = base_p(m, "edit_image", image=link("img"), control=link("ctrl"))
    p.update({"width": 1680, "height": 896})
    p["params"] = {**p["params"], "stage_denoise": 0.9}
    g = FakeGraph()
    A.ADAPTERS["flux3_klein"](g, m, p)
    ref = next(n for n in g.nodes.values() if n.class_type == "ReferenceMultiLatent")
    mp = ref.inputs["resolution.megapixels"]
    assert mp == 1.51 and A.ref_canvas(1680, 896, mp) == (1723, 919)
    rs = [n for n in g.nodes.values() if n.class_type == "ResizeImageMaskNode"]
    assert [(n.inputs["resize_type.width"], n.inputs["resize_type.height"]) for n in rs] == [(1723, 919)]
    # the from-noise path (frames picked before the lock) is untouched: no start image, the reference's own latent
    p["params"]["stage_denoise"] = 1.0
    g = FakeGraph()
    A.ADAPTERS["flux3_klein"](g, m, p)
    assert not any(n.class_type in ("ResizeImageMaskNode", "VAEEncode") for n in g.nodes.values())


# ---- the realism judge sees a dark ring around the picture ----------------------------------------------------------

def test_framing_replies_count_only_a_ring():
    from soundstage.takecheck import realism as RJ
    assert RJ.parse_framing('{"framed": true, "where": "corners"}') == {"framed": True, "ring": True}
    assert RJ.parse_framing('```json\n{"framed": "true", "where": "left, bottom"}\n```')["ring"]
    assert not RJ.parse_framing('{"framed": true, "where": "right"}')["ring"]       # a pillar in the blocking
    assert not RJ.parse_framing('{"framed": false, "where": "none"}')["ring"]
    assert RJ.parse_framing("I can't tell") == {"framed": False, "ring": False}


def test_framing_defect_repeats_like_any_defect_and_convicts_alone():
    from soundstage.takecheck import realism as RJ
    ring, clear = {"ring": True}, {"ring": False}
    assert RJ.framing_defect([ring, clear, clear, clear], [3, 9, 15, 21]) is None      # one frame never convicts a take
    d = RJ.framing_defect([ring, ring, clear, ring], [3, 9, 15, 21])
    assert d["category"] == "framing" and d["frames"] == [3, 9, 21] and d["label"].startswith("dark vignette or porthole")
    assert RJ.framing_defect([ring], [0])["frames"] == [0]                              # a still: its one frame
    passed = {"verdict": "pass", "score": 10.0, "defects": [], "minor": []}
    out = RJ.with_framing(passed, d)
    assert out["verdict"] == "fail" and out["score"] == 7.0 and out["defects"][0] is d
    assert RJ.chip({**out, "model": "m", "frames_judged": 4})["text"].startswith("✗ AI slop: dark vignette or porthole")
    nothing = {"verdict": "unavailable", "score": None, "defects": [], "why": "the judge found no main subject to inspect"}
    assert RJ.with_framing(nothing, d)["verdict"] == "fail"
    assert RJ.with_framing(passed, None) is passed


def test_judge_video_asks_about_framing_in_the_locate_job(tmp_path):
    """One queued job carries both questions; a take whose frames all come back framed fails on that alone."""
    import json
    import shutil
    import subprocess
    import numpy as np
    import pytest
    from soundstage.takecheck import realism as RJ
    ff = shutil.which("ffmpeg")
    if not ff:
        pytest.skip("ffmpeg")
    clip = tmp_path / "take.mp4"
    frames = b"".join(np.full((176, 320, 3), (i * 7) % 255, np.uint8).tobytes() for i in range(24))
    subprocess.run([ff, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "320x176", "-r", "24", "-i", "-",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(clip)], input=frames, check=True)

    class Q:
        runs = 0

        def text_encoders(self):
            return ["qwen3vl_8b_fp8_scaled.safetensors"]

        def upload(self, name, data):
            return f"soundstage_realism/{name}"

        def run(self, graph, outs):
            self.runs += 1
            systems = {k: v["inputs"]["value"] for k, v in graph.items() if v["class_type"] == "PrimitiveStringMultiline"}
            out = []
            for o in outs:
                sid = graph[graph[o]["inputs"]["source"][0]]["inputs"]["system_prompt"][0]
                if systems[sid] == RJ.FRAMING_SYSTEM:
                    out.append('{"framed": true, "where": "corners"}')
                elif systems[sid] == RJ.LOCATE_SYSTEM:
                    out.append(json.dumps({"subjects": [{"label": "red sports car", "kind": "vehicle", "bbox": [300, 300, 800, 950]}]}))
                else:
                    out.append('{"subject":"red sports car","defects":[],"realism":8}')
            return out
    q = Q()
    r = RJ.judge_video(str(clip), "http://x", samples=4, queue=q)
    assert q.runs == 2 and r["verdict"] == "fail" and r["defects"][0]["category"] == "framing"
    assert [f["ring"] for f in r["framing"]] == [True] * 4
