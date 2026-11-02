"""Generative transitions (soundstage/cut/gentransitions.py, gentransitions_routes.py): the bridge graph is valid against
the pod's /object_info snapshots and uses only nodes the App already queues, the slot map finds every slot and fill()
writes only through it, the styles match the browser twin, and flatten() cuts a ready bridge in without moving the cut.
Run:  python -m pytest tests/test_gentransitions.py -q
"""
import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from soundstage.cut import gentransitions as GT  # noqa: E402
from soundstage.cut import gentransitions_routes as GR  # noqa: E402
from soundstage.loop import graphs as LG  # noqa: E402

SNAPS = ["test_footage_object_info.json", "test_motion_object_info.json", "test_loop_object_info.json"]
W = {r: names[0] for r, (f, names) in GT.WEIGHTS.items()}


@pytest.fixture(autouse=True)
def _snapshot(monkeypatch):
    merged = {}
    for s in SNAPS:
        p = os.path.join(HERE, s)
        if os.path.exists(p):
            merged.update(json.load(open(p)))
    monkeypatch.setattr(TF, "OI", merged)


def as_graph(prompt):
    g = TF.Graph()
    for nid, n in prompt.items():
        g.nodes[nid] = TF.Node(nid, n["class_type"], n["inputs"])
    return g


def bridge(**kw):
    args = dict(image_a="gentrans/a_f40.png [input]", image_b="gentrans/b_f12.png [input]", width=1920, height=1080,
                frames=25, fps=24.0, style="smoke", seed=5)
    args.update(kw)
    return GT.build(W, **args)


# ------------------------------------------------------------------ graph

@pytest.mark.parametrize("style", GT.ORDER)
@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("sound", [True, False])
def test_bridge_prompt_valid(style, quality, sound):
    p = bridge(style=style, quality=quality, sound=sound)
    assert TF.check(as_graph(p)) == []
    assert p["save"]["class_type"] == "SaveVideo"
    assert ("audio" in p[p["save"]["inputs"]["video"][0]]["inputs"]) == sound
    assert "@@slot:" not in json.dumps(p)                     # every sentinel was replaced


def test_only_nodes_the_app_already_uses():
    """No new nodes and no new models: the Seamless-loop bridge graph's node set and its weights."""
    loop = LG.build(W, source="a.png [input]", end_source="b.png [input]", width=1920, height=1080, quality="Final",
                    bridge=True)
    for q in ("Draft", "Final"):
        ours = {n["class_type"] for n in bridge(quality=q).values()}
        assert ours <= {n["class_type"] for n in loop.values()}
    assert GT.WEIGHTS is LG.LOOP_WEIGHTS


def test_first_frame_exact_last_frame_guided():
    p = bridge(frames=33)
    loads = {nid: n["inputs"]["source"] for nid, n in p.items() if n["class_type"] == "SoundstageImageLoad"}
    assert loads == {"a": "gentrans/a_f40.png [input]", "b": "gentrans/b_f12.png [input]"}
    inplace = [n for n in p.values() if n["class_type"] == "LTXVImgToVideoInplace"]
    guide = [n for n in p.values() if n["class_type"] == "LTXVAddGuide"]
    assert len(inplace) == 1 and len(guide) == 1
    assert inplace[0]["inputs"]["strength"] == 1.0
    assert guide[0]["inputs"]["frame_idx"] == -1 and guide[0]["inputs"]["strength"] == GT.STYLES["smoke"]["end"]
    resize_of = lambda link: p[link[0]]["inputs"]["input"][0]  # noqa: E731
    assert resize_of(inplace[0]["inputs"]["image"]) == "a" and resize_of(guide[0]["inputs"]["image"]) == "b"
    assert [n for n in p.values() if n["class_type"] == "EmptyLTXVLatentVideo"][0]["inputs"]["length"] == 33
    assert [n for n in p.values() if n["class_type"] == "LTXVEmptyLatentAudio"][0]["inputs"]["frames_number"] == 33


def test_runs_at_the_project_frame_rate():
    p = bridge(fps=25.0)
    assert [n for n in p.values() if n["class_type"] == "LTXVConditioning"][0]["inputs"]["frame_rate"] == 25.0
    assert [n for n in p.values() if n["class_type"] == "CreateVideo"][0]["inputs"]["fps"] == 25.0


def test_final_guides_both_ends_again():
    p = bridge(quality="Final")
    assert len([n for n in p.values() if n["class_type"] == "LTXVAddGuide"]) == 2
    seeds = {n["inputs"]["noise_seed"] for n in p.values() if n["class_type"] == "RandomNoise"}
    assert seeds == {5}


def test_bad_length_or_style_is_refused():
    for n in (16, 18, 105, 9):
        with pytest.raises(ValueError):
            bridge(frames=n)
    with pytest.raises(ValueError):
        bridge(style="fire")


# ------------------------------------------------------------------ slot mapping

def test_trace_finds_every_slot_and_nothing_else():
    t = GT.template(W, width=992, height=544, quality="Final", sound=True)
    slots = GT.trace_slots(t)
    assert set(slots) == set(GT.SENTINELS)
    assert all(slots[k] for k in slots)
    assert slots["image_a"] == [["a", "source"]] and slots["image_b"] == [["b", "source"]]
    assert slots["prefix"] == [["save", "filename_prefix"]]
    assert len(slots["seed"]) == 2                       # stage 1 and the Final refine
    assert len(slots["guide_last"]) == 2
    assert {t[n]["class_type"] for n, _ in slots["fps"]} == {"LTXVConditioning", "LTXFloatToInt", "CreateVideo"}
    assert {t[n]["class_type"] for n, _ in slots["frames"]} == {"EmptyLTXVLatentVideo", "LTXVEmptyLatentAudio"}
    assert GT.missing_slots(t, slots) == []


def test_fill_writes_only_through_the_map():
    t = GT.template(W, width=992, height=544)
    slots = GT.trace_slots(t)
    vals = {"image_a": "x [input]", "image_b": "y [input]", "prompt": "p", "negative": "n", "prefix": "o", "seed": 3,
            "frames": 17, "fps": 24.0, "guide_last": 0.8}
    g = GT.fill(t, slots, vals)
    assert t["a"]["inputs"]["source"] == GT.SENTINELS["image_a"]      # the template is untouched
    diff = [(nid, k) for nid in t for k in t[nid]["inputs"] if t[nid]["inputs"][k] != g[nid]["inputs"][k]]
    assert sorted(diff) == sorted(tuple(r) for refs in slots.values() for r in refs)
    with pytest.raises(KeyError):
        GT.fill(t, slots, {**vals, "cfg": 3})
    with pytest.raises(ValueError):
        GT.fill(t, slots, {k: v for k, v in vals.items() if k != "seed"})


def test_drift_is_reported():
    t = GT.template(W, width=992, height=544)
    slots = GT.trace_slots(t)
    del t["b"]
    assert GT.missing_slots(t, slots) == ["image_b"]


def test_a_sentinel_float_does_not_match_an_int():
    g = {"1": {"class_type": "X", "inputs": {"a": 9017, "b": 9017.0, "c": True}}}
    assert GT.trace_slots(g, {"frames": 9017, "f": 9017.0, "one": 1}) == {"frames": [["1", "a"]], "f": [["1", "b"]], "one": []}


# ------------------------------------------------------------------ styles and words

def test_eight_styles_in_order_with_ltx_lengths():
    assert GT.ORDER == ["smoke", "water_bend", "whip_pan", "match_cut", "light_leak", "ink_bleed", "zoom_through", "morph"]
    for k in GT.ORDER:
        s = GT.STYLES[k]
        assert (s["frames"] - 1) % 8 == 0 and GT.MIN_FRAMES <= s["frames"] <= GT.MAX_FRAMES
        assert 0 < s["end"] <= 1


def test_prompt_words():
    p = GT.prompt_for("whip_pan", "a neon street at night")
    assert p.startswith("Use the start picture as the first frame")
    assert "whip" in p and "a neon street at night." in p
    for k in GT.ORDER:
        n = GT.negative_for(k)
        assert "dissolve" not in n and "morphing" not in n      # the loop's negative would fight these styles
        assert "hard cut" in n


def test_styles_match_the_browser_twin():
    src = open(os.path.join(ROOT, "web", "cut", "gentransitions.mjs"), encoding="utf-8").read()
    block = src[src.index("export const STYLES"):src.index("];", src.index("export const STYLES"))]
    js = re.findall(r'\{ id: "(\w+)", name: "([^"]+)", frames: (\d+)', block)
    assert [(i, n, int(f)) for i, n, f in js] == [(k, GT.STYLES[k]["name"], GT.STYLES[k]["frames"]) for k in GT.ORDER]


def test_lengths_and_snap():
    assert GT.lengths()[:3] == [17, 25, 33] and GT.lengths()[-1] == 97
    assert GT.lengths(40) == [17, 25, 33]
    assert GT.snap_length(29) == 25 and GT.snap_length(30) == 33 and GT.snap_length(200) == 97
    assert GT.snap_length(30, 20) == 17 and GT.snap_length(30, 16) == 0


# ------------------------------------------------------------------ placement / flatten (shared fixture with JS)

FIX = json.load(open(os.path.join(HERE, "js", "fixtures", "gentransitions_flatten.json"), encoding="utf-8"))


@pytest.mark.parametrize("case", FIX["cases"], ids=[c["name"] for c in FIX["cases"]])
def test_flatten_matches_the_fixture(case):
    p = case["project"]
    assert [GT.status(p, gt)[0] for gt in p.get("gen_transitions", [])] == case["status"]
    flat = GT.flatten(p)
    assert flat["cut"] == case["cut"]
    assert sum(e["out"] - e["in"] for e in flat["cut"]) == sum(e["out"] - e["in"] for e in p["cut"])   # same length


def test_flattened_project_renders_like_any_cut():
    """The bridge shot survives normalize_project and is the clip's best render."""
    from soundstage.cut import export as E
    from soundstage.cut import render as R
    case = next(c for c in FIX["cases"] if c["name"] == "ready")
    p = E.normalize_project(GT.flatten(case["project"]))
    rows = E.layout(p)
    assert [r["shot"]["id"] for r in rows] == ["a", "gt_g1", "b"]
    roots = {"output": "/nonexistent", "input": "/nonexistent", "temp": "/nonexistent"}
    assert R.shot_media(rows[1]["shot"], roots)[0] == "slate"    # missing file: a slate, not a crash


def test_span_and_sides():
    case = next(c for c in FIX["cases"] if c["name"] == "ready")
    p = case["project"]
    sp = GT.span(p, p["gen_transitions"][0])
    assert sp == {"k": 1, "at": 60, "pre": 12, "post": 13, "frames": 25, "a_src": 48, "b_src": 22}
    assert GT.max_sides(p, 1) == (29, 34)


# ------------------------------------------------------------------ route

def test_route_prepares_a_prompt(tmp_path):
    from PIL import Image
    dirs = {k: str(tmp_path / k) for k in ("input", "output", "temp")}
    for d in dirs.values():
        os.makedirs(d)
    os.makedirs(os.path.join(dirs["output"], "renders"))
    open(os.path.join(dirs["output"], "renders", "a.mp4"), "wb").write(b"not really")
    Image.new("RGB", (1280, 720)).save(os.path.join(dirs["output"], "renders", "b_look.png"))
    calls = []

    def fake_frame(src, i, dst):
        calls.append((os.path.basename(src), i))
        Image.new("RGB", (1280, 720)).save(dst)
        return dst

    lists = {f: [W[r]] for r, (f, _) in GT.WEIGHTS.items()}
    lists["vae"] = [W["vae"], W["audio_vae"]]
    res = GR.prepare({"style": "ink_bleed", "frames": 41, "fps": 24,
                      "a": {"ref": "renders/a.mp4 [output]", "frame": 47}, "b": {"ref": "renders/b_look.png [output]"}},
                     dirs, list_files=lambda f: lists.get(f, []), frame_png=fake_frame)
    assert calls == [("a.mp4", 47)]
    assert res["a"] == "soundstage_private/gentrans/a_f47.png [input]" and res["b"] == "renders/b_look.png [output]"
    assert res["frames"] == 41 and res["seconds"] == round(41 / 24, 3)
    assert TF.check(as_graph(res["prompt"])) == []
    with pytest.raises(ValueError):
        GR.prepare({"style": "smoke", "a": {"ref": "../x.mp4 [output]"}, "b": {"ref": "renders/b_look.png [output]"}},
                   dirs, list_files=lambda f: lists.get(f, []), frame_png=fake_frame)
    with pytest.raises(RuntimeError, match="need these models"):
        GR.prepare({"style": "smoke", "a": {"ref": "renders/b_look.png [output]"}, "b": {"ref": "renders/b_look.png [output]"}},
                   dirs, list_files=lambda f: [], frame_png=fake_frame)


# ------------------------------------------------------------------ the render (ffmpeg, CPU)

def _colour_clip(path, colour, frames):
    import subprocess
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:r=24", "-frames:v",
                    str(frames), "-pix_fmt", "yuv420p", "-c:v", "libx264", path], check=True)


def _mean(path, t):
    import subprocess

    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 3).mean(0)


@pytest.mark.skipif(not __import__("shutil").which("ffmpeg"), reason="ffmpeg not installed")
def test_render_cuts_a_ready_bridge_in_and_skips_a_stale_one(tmp_path):
    pytest.importorskip("PIL")
    from soundstage.cut.render import probe, render_cut
    media = tmp_path / "out"
    (media / "r").mkdir(parents=True)
    _colour_clip(str(media / "r" / "a.mp4"), "red", 96)
    _colour_clip(str(media / "r" / "b.mp4"), "blue", 96)
    _colour_clip(str(media / "r" / "bridge.mp4"), "lime", 25)
    view = lambda f: f"/view?filename={f}&subfolder=r&type=output"  # noqa: E731
    gt = {"id": "g1", "style": "smoke", "from": "a", "to": "b", "occ": 0, "pre": 12, "post": 13, "url": view("bridge.mp4"),
          "rendered_frames": 25, "a": {"frame": 36, "media": view("a.mp4")}, "b": {"frame": 12, "media": view("b.mp4")}}
    p = {"name": "gt", "fps": 24, "width": 320, "height": 180,
         "shots": [{"id": "a", "frames": 96, "renders": {"draft": view("a.mp4")}},
                   {"id": "b", "frames": 96, "renders": {"draft": view("b.mp4")}}],
         "cut": [{"shot_id": "a", "in": 0, "out": 48}, {"shot_id": "b", "in": 0, "out": 48, "trans": {"type": "dissolve", "frames": 12}}],
         "gen_transitions": [gt]}
    out = str(tmp_path / "cut.mp4")
    r = render_cut(p, {"output": str(media)}, out, {"loudness": "social"})
    assert r["frames"] == 96 and abs(probe(out)["duration"] - 4.0) < 0.1          # the cut keeps its length
    red, green, blue = _mean(out, 30 / 24), _mean(out, 48 / 24), _mean(out, 66 / 24)
    assert red[0] > 150 and red[1] < 60
    assert green[1] > 150 and green[0] < 60 and green[2] < 60                      # the bridge plays at the edit
    assert blue[2] > 150 and blue[1] < 60
    p["cut"][0]["out"] = 47                                                          # a trim: the bridge is stale
    out2 = str(tmp_path / "cut2.mp4")
    render_cut(p, {"output": str(media)}, out2, {"loudness": "social"})
    assert _mean(out2, 48 / 24)[1] < 100                                             # not played: the dissolve is back
