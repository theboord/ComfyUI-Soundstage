"""Motion gate (soundstage/takecheck/motiongate.py, modified from MotionGuard): synthetic stage skeletons against
synthetic DWPose reads. CPU only, no ComfyUI, no models.

The stage person walks across the frame swinging arms and legs. The "draft" is that motion with DWPose-like jitter,
reframed and shifted in time (must pass), or with a frozen arm, a frozen body, a wrong arm pose, a late body or a
curled finger (must fail or warn where it happened, and name the joint and the time)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.takecheck import motiongate as MG  # noqa: E402
from soundstage.takecheck import routes as RT  # noqa: E402
from soundstage.takecheck import store  # noqa: E402

W, H, FPS, N = 1280, 704, 24.0, 121


def person(i, phase=0.0, freeze_arm=None, wrong_arm=None, freeze_all=False, curl=None):
    """Pixel joints [18,2] and hands [42,2] (right, left) of a walker at frame i."""
    t = i / FPS if not freeze_all else 0.0
    cx = 360 + 220 * t                       # walks right ~9 px / frame
    a = 0.7 * math.sin(2 * math.pi * (t + phase) / 1.0)
    b = 0.6 * math.sin(2 * math.pi * (t + phase) / 1.0 + math.pi)
    body = np.zeros((18, 2))
    neck = np.array([cx, 220.0])
    body[1] = neck
    body[0] = neck + (0, -45)
    body[14], body[15], body[16], body[17] = neck + (-10, -55), neck + (10, -55), neck + (-22, -50), neck + (22, -50)
    body[2], body[5] = neck + (-45, 5), neck + (45, 5)
    body[8], body[11] = neck + (-28, 170), neck + (28, 170)

    def limb(root, ang, l1, l2, bend):
        e = root + l1 * np.array([math.sin(ang), math.cos(ang)])
        w = e + l2 * np.array([math.sin(ang + bend), math.cos(ang + bend)])
        return e, w
    ra = a
    if freeze_arm is not None and freeze_arm[0] <= i <= freeze_arm[1]:
        ra = 0.7 * math.sin(2 * math.pi * (freeze_arm[0] / FPS + phase))
    body[3], body[4] = limb(body[2], ra, 80, 75, 0.3 if not (wrong_arm and wrong_arm[0] <= i <= wrong_arm[1]) else 2.6)
    body[6], body[7] = limb(body[5], b, 80, 75, 0.3)
    body[9], body[10] = limb(body[8], b * 0.8, 95, 95, -0.2)
    body[12], body[13] = limb(body[11], a * 0.8, 95, 95, -0.2)
    hands = np.zeros((42, 2))
    for off, wrist, ang in ((0, body[4], ra), (21, body[7], b)):
        hands[off] = wrist
        d = np.array([math.sin(ang), math.cos(ang)])
        n = np.array([-d[1], d[0]])
        for f in range(5):
            spread = (f - 2) * 0.35
            fd = d * math.cos(spread) + n * math.sin(spread)
            for k in range(1, 5):
                L = 14 + 6 * k
                if curl and off == 0 and f == 1 and k >= 3 and curl[0] <= i <= curl[1]:
                    hands[off + 1 + f * 4 + k - 1] = wrist + fd * 20 - fd * (k - 2) * 12   # index folds back
                else:
                    hands[off + 1 + f * 4 + k - 1] = wrist + fd * L
    return body, hands


def reference(n_stage=N, **kw):
    """The App's payload: 0-1 coordinates of the stage frame (same aspect as the take here)."""
    body, hands = [], []
    for i in range(n_stage):
        b, h = person(i, **kw)
        body.append([[float(x / W), float(y / H)] for x, y in b])
        hands.append([[[float(x / W), float(y / H)] for x, y in h[:21]], [[float(x / W), float(y / H)] for x, y in h[21:]]])
    return {"v": 1, "frames": n_stage, "fps": FPS, "aspect": W / H, "people": [{"id": "a1", "name": "Ana", "body": body, "hands": hands}]}


def dwpose(n=N, shift=0, sigma=1.2, scale=1.0, offset=(0.0, 0.0), normalised=False, drop=False, seed=0, **kw):
    """DWPose POSE_KEYPOINT frames of the same walker, read from a draft (pixel coordinates unless normalised)."""
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n):
        j = min(max(i - shift, 0), n - 1)
        b, h = person(j, **kw)
        b = b * scale + offset + rng.normal(0, sigma, b.shape)
        h = h * scale + offset + rng.normal(0, sigma * 0.5, h.shape)
        sx, sy = (W, H) if normalised else (1.0, 1.0)

        def flat(a, c=0.9):
            return [v for x, y in a for v in (float(x / sx), float(y / sy), c)]
        people = [] if drop else [{"pose_keypoints_2d": flat(b), "hand_right_keypoints_2d": flat(h[:21]),
                                   "hand_left_keypoints_2d": flat(h[21:]), "face_keypoints_2d": []}]
        out.append({"people": people, "canvas_width": W, "canvas_height": H})
    return out


def test_faithful_draft_passes_through_reframing_and_a_time_shift():
    res = MG.gate(reference(), dwpose(shift=3, scale=1.04, offset=(18, -10)), FPS)
    assert res["verdict"] == "pass", res["summary"]
    p = res["people"][0]
    assert p["pck"] >= 0.9
    assert abs(p["shift_s"]) == pytest.approx(3 / FPS, abs=1e-6)
    assert p["metrics"]["framing"]["scale"] == pytest.approx(1.04, abs=0.02)
    assert not res["failures"] and not res["advisory"]
    assert res["summary"].startswith("Motion follows the stage")


def test_normalised_dwpose_coordinates_read_the_same():
    a = MG.gate(reference(), dwpose(normalised=True), FPS)
    assert a["verdict"] == "pass"
    assert a["size"] == [W, H]


def test_a_non_finite_dwpose_point_counts_as_missing():
    for bad in (float("nan"), None):        # the right wrist's x: not found, never a confident joint at x = 0
        frames = dwpose()
        for i in range(30, 60):
            frames[i]["people"][0]["pose_keypoints_2d"][3 * 4] = bad
        assert MG.gate(reference(), frames, FPS)["verdict"] == "pass", bad


def test_a_frozen_arm_fails_on_that_arm_where_it_froze():
    res = MG.gate(reference(), dwpose(freeze_arm=(40, 84)), FPS)
    assert res["verdict"] == "fail"
    arm = [f for f in res["failures"] if set(f["joints"]) & {3, 4}]
    assert arm, res["failures"]
    assert all(set(f["joints"]) <= {3, 4} for f in res["failures"]), "only the right arm is wrong"
    assert min(f["t0"] for f in arm) >= 40 / FPS - 0.3 and max(f["t1"] for f in arm) <= 85 / FPS + 0.3
    assert {"right wrist"} & {n for f in arm for n in f["names"]}
    assert res["summary"].startswith("Ana's right")


def test_a_frozen_body_is_missing_motion():
    res = MG.gate(reference(), dwpose(freeze_all=True), FPS)
    assert res["verdict"] == "fail"
    assert any(f["type"] == "missing_motion" for f in res["failures"])


def test_a_person_who_stands_still_while_the_stage_walks_fails_not_uncertain():
    frames = dwpose(freeze_all=True)        # the draft's person never leaves the start: far from the stage walker
    res = MG.gate(reference(), frames, FPS)
    assert res["verdict"] == "fail"
    assert res["people"][0]["found"] == 1.0


def test_a_wrong_pose_window_names_the_wrist_and_its_time():
    res = MG.gate(reference(), dwpose(wrong_arm=(50, 70)), FPS)
    assert res["verdict"] == "fail"
    f = [x for x in res["failures"] if x["type"] == "wrong_pose"]
    assert f and all(set(x["joints"]) <= {4} for x in f), f
    assert f[0]["t0"] == pytest.approx(50 / FPS, abs=0.15) and f[0]["t1"] == pytest.approx(71 / FPS, abs=0.15)
    assert f[0]["scope"] == "one joint"


def test_motion_late_by_more_than_the_tolerance_fails_but_inside_it_passes():
    assert MG.gate(reference(), dwpose(shift=5), FPS)["verdict"] == "pass"         # 0.21 s
    late = MG.gate(reference(), dwpose(phase=-0.5), FPS)                            # arms swing half a cycle late
    assert late["verdict"] == "fail"


def test_a_curled_finger_is_advisory_and_does_not_fail_the_take():
    res = MG.gate(reference(), dwpose(curl=(30, 70)), FPS)
    assert res["verdict"] == "pass"
    assert res["advisory"] and res["advisory"][0]["names"] == ["right index fingertip"]
    assert res["advisory"][0]["t0"] == pytest.approx(30 / FPS, abs=0.2)
    assert res["people"][0]["fingers"] == "measured"


def test_nobody_found_or_nobody_on_stage_is_never_a_pass():
    lost = MG.gate(reference(), dwpose(drop=True), FPS)
    assert lost["verdict"] == "uncertain"
    assert "did not find" in lost["people"][0]["uncertain"][0]
    assert lost["summary"].startswith("Motion: can't tell")
    empty = MG.gate({"frames": N, "people": []}, dwpose(), FPS)
    assert empty["verdict"] == "unmeasured"


def test_a_still_stage_person_cannot_be_judged_on_motion():
    still = reference(freeze_all=True)
    res = MG.gate(still, dwpose(freeze_all=True, sigma=3.0), FPS)
    assert res["verdict"] == "uncertain"


def test_jitter_noise_raises_the_missing_motion_gate():
    calm = MG.gate(reference(), dwpose(sigma=0.5), FPS)["people"][0]["metrics"]
    noisy = MG.gate(reference(), dwpose(sigma=4.0, seed=3), FPS)["people"][0]["metrics"]
    assert noisy["noise_torso"] > calm["noise_torso"]
    assert noisy["motion_gate_torso"] >= calm["motion_gate_torso"]


def test_take_frames_are_mapped_onto_stage_frames():
    """The stage has 97 frames, the draft 121 (retimed): the reference is resampled, the walker still passes."""
    ref = reference(n_stage=97)
    # The stage walker at stage frame sf is the take walker at take frame sf*120/96: rebuild the stage at that pace.
    body, hands = [], []
    for sf in range(97):
        i = sf * 120 / 96
        b0, h0 = person(int(math.floor(i)))
        b1, h1 = person(min(N - 1, int(math.floor(i)) + 1))
        w = i - math.floor(i)
        b, h = b0 * (1 - w) + b1 * w, h0 * (1 - w) + h1 * w
        body.append([[float(x / W), float(y / H)] for x, y in b])
        hands.append([[[float(x / W), float(y / H)] for x, y in h[:21]], [[float(x / W), float(y / H)] for x, y in h[21:]]])
    ref["people"][0]["body"], ref["people"][0]["hands"] = body, hands
    assert MG.gate(ref, dwpose(), FPS)["verdict"] == "pass"


def test_wider_stage_frame_is_centre_cropped_like_the_blocking_score():
    x, y = MG.to_px(0.5, 0.5, W, H, 2.39)
    assert (x, y) == (W / 2, H / 2)
    x0, _ = MG.to_px(0.0, 0.5, W, H, 2.39)
    assert x0 < 0           # the 2.39 stage edge falls outside a 16:9 take


def test_two_people_are_matched_to_the_right_dwpose_person():
    ref = reference()
    other = json.loads(json.dumps(ref["people"][0]))
    other.update(id="b2", name="Ben")
    for fr in other["body"]:
        for p in fr:
            p[0] += 0.4
    for fr in other["hands"]:
        for hand in fr:
            for p in hand:
                p[0] += 0.4
    ref["people"].append(other)
    frames = dwpose()
    ben = dwpose(freeze_all=True, offset=(0.4 * W, 0))
    for f, g in zip(frames, ben):
        f["people"] = g["people"] + f["people"]           # DWPose lists Ben first
    res = MG.gate(ref, frames, FPS)
    by = {p["name"]: p["verdict"] for p in res["people"]}
    assert by == {"Ana": "pass", "Ben": "fail"}
    assert res["verdict"] == "fail" and res["summary"].startswith("Ben's")


def test_thresholds_are_motionguards_provisional_values():
    t = MG.thresholds()
    assert t["threshold_status"] == "PROVISIONAL_UNCALIBRATED"
    assert (t["pck_normalized_distance"], t["max_abs_lag_seconds"], t["min_motion_energy_ratio"], t["min_evidence_frames"]) == (0.1, 0.25, 0.4, 6)


def test_licence_notice_and_credit_ship_with_the_port():
    tc = ROOT / "soundstage" / "takecheck"
    notice = (tc / "MOTION_GUARD_NOTICE").read_text()
    assert "MotionGuard" in notice and "Apache" in notice and "rtmlib and MMPose" in notice   # verbatim NOTICE carried
    assert "Apache License" in (tc / "MOTION_GUARD_LICENSE").read_text()
    head = (tc / "motiongate.py").read_text()[:600]
    assert "Modified from MotionGuard" in head and "Apache-2.0" in head
    assert "junco3/motion-guard" in (ROOT / "THIRD_PARTY_NOTICES.md").read_text()


def test_routes_merge_the_gate_into_the_take_check(tmp_path, monkeypatch):
    store.set_base(str(tmp_path / "store"))
    take = tmp_path / "draft_00001_.mp4"
    take.write_bytes(b"x")
    monkeypatch.setattr(RT.C, "check_take", lambda p: {"version": RT.C.VERSION, "verdict": "clean", "issues": [], "chips": [], "recipe": None, "blocking": {}})
    assert "motion" not in RT.run(str(take))
    store.save(str(take), "motion", {"version": MG.VERSION, "verdict": "fail", "failures": [{"t0": 1.0}], "people": [{"metrics": {"big": 1}}]})
    res = RT.run(str(take))
    assert res["motion"]["verdict"] == "fail"
    assert "metrics" not in res["motion"]["people"][0]      # the Ladder gets the slim verdict
    store.save(str(take), "motion", {"version": MG.VERSION - 1, "verdict": "fail"})
    assert "motion" not in RT.run(str(take))                # an old gate is checked again, not trusted
