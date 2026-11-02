"""The realism judge (soundstage/takecheck/realism.py): parsing the VLM's replies, crops, the calibrated aggregation,
chips, the Hollywood test, the queue graph, and a whole judge_video run against a fake ComfyUI queue that replays the
pod's real replies for Mike's rejected J-turn (fail) and the train take (pass)."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.takecheck import realism as RJ  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not installed")


def ob(frame, kind, defects, height=0.5, realism=5.0, visible=None):
    return {"frame": frame, "kind": kind, "label": kind, "height": height, "visible": visible,
            "defects": [{"part": p, "problem": q, "severity": s} for p, q, s in defects], "realism": realism}


def test_sample_indices_spread_and_bounded():
    assert RJ.sample_indices(121, 6) == [10, 30, 50, 70, 90, 110]
    assert RJ.sample_indices(3, 6) == [0, 1, 2]
    assert RJ.sample_indices(0) == []
    assert RJ.sample_indices(1, 6) == [0]


def test_parse_locate_scales_sorts_and_reads_visibility():
    txt = 'Sure: {"subjects":[{"label":"car in front","kind":"vehicle","bbox":[471,442,500,489]},' \
          '{"label":"red sports car","kind":"vehicle","bbox":[371,362,733,638]},' \
          '{"label":"man","kind":"person","bbox":[0.1,0.1,0.5,0.9],"visible":["Face","fins"]}]}'
    subs = RJ.parse_locate(txt)
    assert [s["label"] for s in subs] == ["man", "red sports car", "car in front"]   # largest first
    assert subs[1]["bbox"] == pytest.approx([0.371, 0.362, 0.733, 0.638])
    assert subs[0]["visible"] == ["face"] and subs[1]["visible"] is None
    assert RJ.parse_locate("no json here") == []
    assert RJ.parse_locate('{"subjects":[{"label":"x","bbox":[5,5,5,5]}]}') == []          # degenerate box


def test_pick_subjects_drops_background_scenery_and_parts_of_subjects():
    diver = {"label": "scuba diver", "kind": "person", "bbox": [0.3, 0.2, 0.7, 0.55]}
    tank = {"label": "scuba tank", "kind": "vehicle", "bbox": [0.5, 0.22, 0.6, 0.3]}       # inside the diver
    reef = {"label": "coral reef", "kind": "other", "bbox": [0.0, 0.5, 1.0, 1.0]}
    far = {"label": "car ahead", "kind": "vehicle", "bbox": [0.54, 0.45, 0.58, 0.5]}        # 0.2 % of the frame
    picked = RJ.pick_subjects(RJ.parse_locate(json.dumps({"subjects": [
        {**s, "bbox": [v * 1000 for v in s["bbox"]]} for s in (reef, diver, tank, far)]})))
    assert [s["label"] for s in picked] == ["scuba diver"]


def test_crop_box_grows_and_clamps():
    assert RJ.crop_box([0.0, 0.5, 0.5, 1.0], 1000, 500) == (0, 220, 560, 500)


def test_parse_judge_is_forgiving():
    v = RJ.parse_judge('```json\n{"subject":"car","defects":[{"part":"exhaust","problem":"melted","severity":"Major"},'
                       '{"part":"mirror","problem":"soft","severity":"minor"}, "loose text"],"realism":"4"}\n```')
    assert [d["severity"] for d in v["defects"]] == ["major", "minor", "major"]
    assert v["realism"] == 4.0
    assert RJ.parse_judge("I can't")["unreadable"]


def test_category_maps_vehicle_and_anatomy_words():
    assert RJ.category("vehicle", "rear lights", "not a matched pair") == "lamps"
    assert RJ.category("vehicle", "rear bumper", "exhaust tips merged into the diffuser") == "parts"
    assert RJ.category("vehicle", "exhaust tips", "melted") == "rear_parts"
    assert RJ.category("vehicle", "wheels", "not round") == "wheels"
    assert RJ.category("person", "arms", "right arm has only two fingers") == "hands"    # fingers win
    assert RJ.category("person", "legs", "left foot fused to the fin") == "feet"
    assert RJ.category("person", "left arm", "merges with the body") == "limbs"
    assert RJ.category("person", "rear lights", "odd") == "other"                         # no car words on a person


def test_aggregate_repeated_major_fails_one_offs_pass():
    car = [ob(f, "vehicle", [("tail lights", "left and right not a matched pair", "major"),
                             ("exhaust", "melted into the diffuser", "major")]) for f in (10, 30, 50, 70)]
    car += [ob(f, "vehicle", []) for f in (90, 110)]
    r = RJ.aggregate(car, 6)
    assert r["verdict"] == "fail"
    labels = [d["label"] for d in r["defects"]]
    assert "rear lights incoherent, f10–70" in labels and "exhaust / diffuser melted, f10–70" in labels
    assert r["score"] <= 4
    one_off = [ob(10, "vehicle", [("grille", "flat", "major")])] + [ob(f, "vehicle", []) for f in (30, 50, 70, 90, 110)]
    r = RJ.aggregate(one_off, 6)
    assert r["verdict"] == "pass" and r["defects"] == [] and r["minor"][0]["label"].endswith("(minor)")


def test_aggregate_fine_anatomy_needs_visibility_and_size():
    # hands the locate pass couldn't see: invented by the judge, ignored (the train take: no hands in frame)
    hands = [ob(f, "person", [("left hand", "fused fingers", "major")], height=0.76, visible=["face"]) for f in (24, 40, 56)]
    hands += [ob(f, "person", [], height=0.76, visible=["face"]) for f in (8, 72, 88)]
    assert RJ.aggregate(hands, 6)["verdict"] == "pass"
    # small on screen (the diver): fingers and face are below what a viewer sees -> minor
    small = [ob(f, "person", [("hands", "fused fingers", "major"), ("face", "smeared", "major")], height=0.33,
                visible=["face", "hands"]) for f in (8, 24, 40, 56, 72, 88)]
    assert RJ.aggregate(small, 6)["verdict"] == "pass"
    # big and visible: counts
    big = [ob(f, "person", [("hands", "six fingers", "major")], height=0.8, visible=["hands"]) for f in (8, 24, 40, 56)]
    r = RJ.aggregate(big, 6)
    assert r["verdict"] == "fail" and r["defects"][0]["label"] == "hands malformed, f8–56"


def test_aggregate_single_frame_subject_never_convicts_a_video_but_a_still_can():
    vid = [ob(88, "other", [("diver's right arm", "merges with the body", "major")])] + \
          [ob(f, "person", [], height=0.3) for f in (8, 24, 40, 56, 72, 88)]
    assert RJ.aggregate(vid, 6)["verdict"] == "pass"
    still = [ob(0, "vehicle", [("exhaust", "melted into the diffuser", "major")])]
    r = RJ.aggregate(still, 1)
    assert r["verdict"] == "fail" and r["defects"][0]["label"] == "exhaust / diffuser melted"


def test_aggregate_nothing_judged_is_unavailable_not_a_pass():
    r = RJ.aggregate([], 6)
    assert r["verdict"] == "unavailable" and r["score"] is None


def test_chip_texts():
    fail = RJ.aggregate([ob(f, "vehicle", [("rear lights", "mismatched pair", "major")]) for f in (24, 40, 56)], 3)
    fail.update(model="qwen3vl_8b_fp8_scaled.safetensors")
    c = RJ.chip(fail)
    assert c["tone"] == "bad" and c["text"] == "✗ AI slop: rear lights incoherent, f24–56"
    ok = RJ.aggregate([ob(f, "person", []) for f in (8, 24)], 2)
    assert RJ.chip(ok)["tone"] == "ok" and RJ.chip(ok)["text"].startswith("✓ real")
    assert RJ.chip({"verdict": "unavailable", "error": "no model"})["tone"] == "info"
    assert RJ.chip(None) is None


def test_is_hollywood():
    assert RJ.is_hollywood({"height": 1408}, None)
    assert RJ.is_hollywood({"height": 544}, {"quality": {"quality": "Hollywood"}})
    assert not RJ.is_hollywood({"height": 704}, {"quality": {"quality": "Final"}})
    assert not RJ.is_hollywood(None, None)


def test_graph_shares_one_model_and_one_system_per_kind():
    g, outs = RJ.graph("m.safetensors", [("a.jpg", RJ.judge_system("vehicle"), "p"), ("b.jpg", RJ.judge_system("vehicle"), "p"),
                                         ("c.jpg", RJ.judge_system("person"), "q")])
    assert outs == ["p0", "p1", "p2"]
    assert sum(1 for v in g.values() if v["class_type"] == "CLIPLoader") == 1
    assert sum(1 for v in g.values() if v["class_type"] == "PrimitiveStringMultiline") == 2
    assert g["t2"]["inputs"]["sampling_mode"] == "off" and g["t2"]["inputs"]["image"] == ["l2", 0]
    # no cross-priming: the person checklist never mentions car parts, the car one never mentions fingers
    assert "exhaust" not in RJ.judge_system("person") and "finger" not in RJ.judge_system("vehicle")


def test_pick_model_prefers_qwen3vl_8b():
    assert RJ.pick_model(["qwen3.5_4b_bf16.safetensors", "qwen3vl_8b_fp8_scaled.safetensors"]) == "qwen3vl_8b_fp8_scaled.safetensors"
    assert RJ.pick_model(["qwen3.5_4b_bf16.safetensors"]) == "qwen3.5_4b_bf16.safetensors"
    assert RJ.pick_model(["flux.safetensors"]) is None


class FakeQueue:
    """Replays VLM replies: locate -> one car per frame; judge -> the pod's real replies (cycled)."""

    def __init__(self, judge_replies, kind="vehicle", visible=None, models=("qwen3vl_8b_fp8_scaled.safetensors",)):
        self.replies, self.kind, self.visible, self.models = judge_replies, kind, visible, list(models)
        self.uploads, self.runs = [], 0

    def text_encoders(self):
        return self.models

    def upload(self, name, data):
        self.uploads.append((name, len(data)))
        return f"soundstage_realism/{name}"

    def run(self, graph, outs):
        self.runs += 1
        system = next(v["inputs"]["value"] for v in graph.values() if v["class_type"] == "PrimitiveStringMultiline")
        if system == RJ.LOCATE_SYSTEM:
            sub = {"label": "red sports car" if self.kind == "vehicle" else "man", "kind": self.kind, "bbox": [300, 300, 800, 950]}
            if self.visible is not None:
                sub["visible"] = self.visible
            return [json.dumps({"subjects": [sub]}) for _ in outs]
        return [self.replies[i % len(self.replies)] for i in range(len(outs))]


def _clip(path: Path, n=24, w=320, h=176):
    frames = b"".join((np.full((h, w, 3), (i * 7) % 255, np.uint8)).tobytes() for i in range(n))
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", "24", "-i", "-",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)], input=frames, check=True)
    return path


# Real replies of qwen3vl_8b_fp8_scaled on the pod (share/Realism_Judge/calibration/), trimmed.
JTURN = ['{"subject":"red sports car","defects":[{"part":"rear lights","problem":"the left and right tail light clusters are not a matched pair","severity":"major"},'
         '{"part":"exhaust tips","problem":"exhaust tips and diffuser appear melted and merged into the bumper","severity":"major"}],"realism":4}']
TRAIN = ['{"subject":"man","defects":[{"part":"left hand","problem":"fused fingers, not five separate digits","severity":"major"}],"realism":7}',
         '{"subject":"man","defects":[{"part":"face","problem":"nose appears slightly misaligned","severity":"minor"}],"realism":8}']


@needs_ffmpeg
def test_judge_video_end_to_end_fail_and_pass(tmp_path):
    clip = _clip(tmp_path / "take.mp4")
    q = FakeQueue(JTURN)
    r = RJ.judge_video(str(clip), "http://x", samples=4, queue=q, keep=str(tmp_path / "keep"))
    assert r["verdict"] == "fail" and r["frames"] == [3, 9, 15, 21] and q.runs == 2
    assert r["chip"]["text"].startswith("✗ AI slop: rear lights incoherent")
    assert len(q.uploads) == 8                                   # 4 frames + 4 crops
    assert (tmp_path / "keep" / "verdict.json").exists() and (tmp_path / "keep" / "crop_f003_0_vehicle.jpg").exists()
    r = RJ.judge_video(str(clip), "http://x", samples=4, queue=FakeQueue(TRAIN, kind="person", visible=["face"]))
    assert r["verdict"] == "pass", r


@needs_ffmpeg
def test_judge_video_without_a_model_is_unavailable(tmp_path):
    clip = _clip(tmp_path / "take.mp4")
    r = RJ.judge_video(str(clip), "http://x", queue=FakeQueue(JTURN, models=["flux.safetensors"]))
    assert r["verdict"] == "unavailable" and "qwen3vl_8b" in r["error"]


@needs_ffmpeg
def test_routes_judge_caches_verdicts_and_merges_them_into_the_checks(tmp_path, monkeypatch):
    from soundstage.takecheck import routes, store
    store.set_base(str(tmp_path / "store"))
    clip = _clip(tmp_path / "take.mp4")
    calls = []

    def fake(path, base, *a, **k):
        calls.append(path)
        return {**RJ.aggregate([ob(f, "vehicle", [("tail lights", "mismatched", "major")]) for f in (1, 2)], 2),
                "version": RJ.VERSION, "raw": ["x"], "model": "m"}
    monkeypatch.setattr(RJ, "judge_video", fake)
    r1 = routes.judge(str(clip), "http://x")
    r2 = routes.judge(str(clip), "http://x")
    assert r1["verdict"] == "fail" and "raw" not in r1 and len(calls) == 1 and r2 == r1
    res = routes.run(str(clip))
    assert res["realism"]["verdict"] == "fail" and res["hollywood"] is False
