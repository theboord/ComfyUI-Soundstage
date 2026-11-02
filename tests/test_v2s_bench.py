"""Unit tests for the Video -> Stage benchmark scorer (tools/v2s_bench/metrics.py).

The scorer must give a perfect score to a reconstruction that IS the truth, see through a similarity transform
(the pipeline's world frame and scale are arbitrary), and penalise what is missing or misplaced."""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools", "v2s_bench"))
metrics = pytest.importorskip("metrics")
imgio = pytest.importorskip("imgio")


def rot_y(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def rot_z(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])


def cams(n=10, W=64, f_mm=30.0, roll=0.0):
    out = []
    for f in range(n):
        R = rot_y(10 * f / n) @ rot_z(roll)
        out.append({"f": f, "pos": [0.3 * f, 1.6, 8.0 - 0.1 * f], "R": R.tolist(), "fx": f_mm / 36 * W, "fy": f_mm / 36 * W,
                    "cx": W / 2, "cy": 18})
    return out


def sim3(cam_list, s, R, t):
    """The same cameras seen in another world frame: p' = s R p + t."""
    out = []
    for c in cam_list:
        out.append({**c, "pos": (s * (R @ np.asarray(c["pos"])) + t).tolist(), "R": (R @ np.asarray(c["R"])).tolist()})
    return out


def test_align_recovers_a_similarity():
    gt = cams()
    R = rot_y(37.0)
    rc = sim3(gt, 0.5, R, np.array([4.0, 0.0, 2.0]))      # recon = 0.5 R gt + t, so truth = 2 R^T (recon - t)
    G, Rc = metrics.by_frame(gt), metrics.by_frame(rc)
    fr = sorted(G)
    A = metrics.align(G, Rc, fr)
    assert A["mode"] == "path"
    assert A["s"] == pytest.approx(2.0, rel=1e-6)
    for f in fr:
        assert np.allclose(metrics.apply(A, Rc[f]["pos"]), G[f]["pos"], atol=1e-6)
    cm = metrics.camera_metrics({"width": 64}, {"width": 64}, G, Rc, fr, A)
    assert cm["ate_m"] < 1e-6 and cm["rot_err_deg"] < 1e-3 and cm["focal_err_pct"] < 1e-6


def test_a_wrong_tilt_or_height_is_not_aligned_away():
    gt = cams()
    tilted = sim3(gt, 1.0, np.array([[1, 0, 0], [0, math.cos(0.2), -math.sin(0.2)], [0, math.sin(0.2), math.cos(0.2)]]), np.zeros(3))
    G, Rc = metrics.by_frame(gt), metrics.by_frame(tilted)
    A = metrics.align(G, Rc, sorted(G))
    cm = metrics.camera_metrics({"width": 64}, {"width": 64}, G, Rc, sorted(G), A)
    assert cm["rot_err_deg"] == pytest.approx(math.degrees(0.2), abs=0.5)
    raised = [{**c, "pos": [c["pos"][0], c["pos"][1] + 2.0, c["pos"][2]]} for c in gt]
    A = metrics.align(G, metrics.by_frame(raised), sorted(G))
    cm = metrics.camera_metrics({"width": 64}, {"width": 64}, G, metrics.by_frame(raised), sorted(G), A)
    assert cm["ate_m"] > 1.0


def test_roll_error_is_the_true_roll_for_a_level_reconstruction():
    gt = cams(roll=6.0)
    rc = cams(roll=0.0)
    G, Rc = metrics.by_frame(gt), metrics.by_frame(rc)
    fr = sorted(G)
    A = metrics.align(G, Rc, fr)
    cm = metrics.camera_metrics({"width": 64}, {"width": 64}, G, Rc, fr, A)
    assert cm["roll_err_deg"] == pytest.approx(6.0, abs=0.2)


def test_static_camera_scale_comes_from_height():
    gt = [{**c, "pos": [0, 1.6, 0]} for c in cams()]
    rc = [{**c, "pos": [0, 0.8, 0]} for c in cams()]
    A = metrics.align(metrics.by_frame(gt), metrics.by_frame(rc), list(range(10)))
    assert A["mode"] == "height" and A["s"] == pytest.approx(2.0)


def test_procrustes_removes_similarity_and_angles_wrap():
    X = np.random.default_rng(1).normal(size=(14, 3))
    Y = 1.7 * X @ rot_y(50).T + np.array([1, 2, 3])
    assert np.allclose(metrics.procrustes(X, Y), Y, atol=1e-9)
    assert metrics.ang_diff(359.0, 1.0) == pytest.approx(2.0)
    assert metrics.ang_diff(10.0, 190.0, 180.0) == pytest.approx(0.0)


def test_decode_ids_and_srgb_twin():
    pal = {"a": [74, 0, 0], "b": [0, 74, 0]}
    enc = metrics.srgb_encoded(pal)
    assert enc["a"][0] == pytest.approx(147, abs=1)
    img = np.zeros((4, 4, 4), np.uint8)
    img[..., 3] = 255
    img[:2, :, :3] = enc["a"]
    img[2:, :2, :3] = enc["b"]
    lab = metrics.decode_ids(img, metrics.pick_palette([img], pal), 20)
    assert (lab[:2] == 0).all() and (lab[2:, :2] == 1).all() and (lab[2:, 2:] == -1).all()


def test_contacts_detects_a_planted_foot():
    J = []
    for f in range(12):
        j = [None] * 18
        j[10] = [0.0, 0.08, 0.0]                      # right foot planted
        j[13] = [0.1 * f, 0.08 + 0.2 * (f % 2), 0.0]   # left foot swinging
        J.append(j)
    c, _ = metrics.contacts(J, 1 / 24)
    assert c[:, 0].all() and not c[:, 1].all()


def _person_frames(n, x0=0.0):
    out = []
    for f in range(n):
        x = x0 + 0.05 * f
        J = [[x, 1.6, 0], [x, 1.45, 0], [x - 0.2, 1.45, 0], [x - 0.25, 1.15, 0], [x - 0.25, 0.9, 0], [x + 0.2, 1.45, 0],
             [x + 0.25, 1.15, 0], [x + 0.25, 0.9, 0], [x - 0.1, 0.9, 0], [x - 0.1, 0.48, 0], [x - 0.1, 0.07, 0],
             [x + 0.1, 0.9, 0], [x + 0.1, 0.48, 0], [x + 0.1, 0.07, 0], None, None, None, None]
        out.append({"f": f, "J": J})
    return out


def _write_clip(d, n=6, W=64, H=36, drop_box=False, shift=0.0):
    """A tiny clip: a box and a walking person, both drawn into ID passes by projecting their boxes."""
    gt_cams = cams(n, W)
    box = {"id": "box", "label": "Crate", "cls": "box", "color": "#aa5522", "dynamic": False, "size": [1, 1, 1],
           "frames": [{"f": -1, "c": [0.5, 0.5, 0.0], "yaw": 0.0, "size": [1, 1, 1]}]}
    man = {"id": "man", "label": "Walker", "cls": "person", "color": "#334455", "dynamic": True, "size": [0.5, 1.8, 0.3],
           "frames": [{"f": f, "c": [-1.0 + 0.05 * f, 0.9, 0.0], "yaw": 90.0, "size": [0.5, 1.8, 0.3]} for f in range(n)]}
    truth = {"schema": "v2s-bench/1", "clip": "tiny", "width": W, "height": H, "fps": 24, "camera": gt_cams,
             "objects": [box, man], "people": [{"id": "p0", "object_id": "man", "frames": _person_frames(n, -1.0)}],
             "id_palette": {"box": [200, 30, 30], "man": [30, 200, 30]}, "id_dir": "truth_id"}
    recon = json.loads(json.dumps(truth))
    recon["id_dir"] = "recon_id"
    if drop_box:
        recon["objects"] = [o for o in recon["objects"] if o["id"] != "box"]
        recon["id_palette"].pop("box")
    if shift:
        for o in recon["objects"]:
            for e in o["frames"]:
                e["c"][0] += shift
    for name, scene in (("truth", truth), ("recon", recon)):
        os.makedirs(os.path.join(d, f"{name}_id"), exist_ok=True)
        for c in scene["camera"]:
            img = np.zeros((H, W, 4), np.uint8)
            img[..., 3] = 255
            for o in scene["objects"]:
                e = o["frames"][0] if o["frames"][0]["f"] < 0 else o["frames"][c["f"]]
                hs = np.asarray(e["size"]) / 2
                corners = [np.asarray(e["c"]) + hs * np.array([sx, sy, sz]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
                pts = [p for p in metrics.project(corners, c, W) if p is not None]
                if not pts:
                    continue
                xs = [int(round(p[0] * W + W / 2)) for p in pts]
                ys = [int(round(p[1] * W + H / 2)) for p in pts]
                img[max(0, min(ys)):max(0, max(ys)), max(0, min(xs)):max(0, max(xs)), :3] = scene["id_palette"][o["id"]]
            imgio.write(os.path.join(d, f"{name}_id", f"{c['f']:04d}.png"), img)
    json.dump(truth, open(os.path.join(d, "truth.json"), "w"))
    json.dump(recon, open(os.path.join(d, "recon.json"), "w"))


def _can_write_png(tmp_path):
    try:
        imgio.write(str(tmp_path / "probe.png"), np.zeros((2, 2, 3), np.uint8))
        return True
    except Exception:  # noqa: BLE001 - no PIL and no ffmpeg on this machine
        return False


def test_truth_scored_against_itself_is_perfect(tmp_path):
    if not _can_write_png(tmp_path):
        pytest.skip("needs PIL or ffmpeg")
    _write_clip(str(tmp_path))
    m = metrics.score(str(tmp_path), every=1)
    assert m["camera"]["ate_m"] < 1e-6
    assert m["scale"]["recon_m_per_true_m"] == pytest.approx(1.0)
    T = m["layout"]["things"]
    assert T["true_in_frame"] == 2 and T["matched"] == 2 and T["placed"] == 2 and T["precision"] == 1.0
    assert T["size_err_pct"] == 0 and T["place_err_m"] == 0 and T["colour_dE"] == 0
    P = m["pose"]
    assert P["people_matched"] == 1 and P["mpjpe_mm"] == 0 and P["pa_mpjpe_mm"] == 0 and P["root_err_m"] == 0
    I = m["identical"]
    assert I["miou"] == pytest.approx(1.0) and I["explained"] == pytest.approx(1.0) and I["ghost"] == 0
    assert I["match_score"] == pytest.approx(80.0)        # no source.mp4, so the colour term is 0 (0.5 + 0.3)


def test_missing_and_misplaced_objects_cost(tmp_path):
    if not _can_write_png(tmp_path):
        pytest.skip("needs PIL or ffmpeg")
    a, b = tmp_path / "missing", tmp_path / "shifted"
    _write_clip(str(a), drop_box=True)
    _write_clip(str(b), shift=3.0)
    ma, mb = metrics.score(str(a), every=1), metrics.score(str(b), every=1)
    assert ma["layout"]["things"]["matched"] == 1 and "Crate" in ma["layout"]["things"]["missing"]
    assert ma["identical"]["miou"] < 0.75
    assert mb["layout"]["things"]["placed"] == 0
    assert mb["identical"]["match_score"] < 60


def test_manifest_lists_synthetic_and_stage_clips():
    man = json.load(open(os.path.join(HERE, "..", "tools", "v2s_bench", "clips.json")))["clips"]
    kinds = {c["kind"] for c in man}
    assert kinds == {"synthetic", "stage"}
    assert len([c for c in man if c["kind"] == "synthetic"]) >= 2 and len([c for c in man if c["kind"] == "stage"]) >= 3
    for c in man:
        assert "private" not in json.dumps(c).lower()
