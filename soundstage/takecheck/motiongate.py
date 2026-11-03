"""Motion gate: does the cheap draft move the way the stage's clay people move, joint by joint?

Modified from MotionGuard (https://github.com/junco3/motion-guard), core/motionguard_core/compare.py, Apache-2.0
(see soundstage/takecheck/MOTION_GUARD_NOTICE and THIRD_PARTY_NOTICES.md). This file was changed from the original:

  * the reference is the stage itself: every clay person's rig joints projected through the shot camera (the
    Pose pass, web/stage/posepass.mjs), not an estimator run on a reference render, so the "ground truth" and the
    reference are the same exact points;
  * the generated poses are DWPose (comfyui_controlnet_aux, which the App already uses) read from the draft;
  * estimator noise is DWPose's own frame-to-frame jitter on this draft (a joint's distance from the midpoint of its
    neighbours, median over the clip), because there is no reference estimate to compare with ground truth;
  * per-joint missing motion compares displacement across a window (as MotionGuard's aggregate check does), not
    summed per-frame speed, so DWPose jitter cannot pass for motion;
  * fingertips are judged where the rig's hand is big enough on screen and DWPose is confident on the whole hand;
    there is no 3D visibility test, so finger findings are advisory and never hold a render on their own;
  * left/right swaps, direction, structure and the separate timing check are not ported.

What it checks, per clay person (OpenPose body joints 2-13: shoulders, elbows, wrists, hips, knees, ankles):
  M1 whole-clip PCK   after ONE clip-wide time shift (searched within +/-0.25 s) and one clip-wide scale + offset,
                      the share of joints within 0.1 torso lengths of the stage, averaged over moving frames.
  M1 per joint        a joint that stays more than 0.1 torso lengths from every stage position within +/-0.25 s
                      for 6+ frames (0.25 s) is a wrong-pose window.
  M5 missing motion   0.25 s windows where the stage moves clearly more than DWPose's noise (3x it) but the draft
                      moves less than 0.4 of that, at the best window within +/-0.25 s; for the body and per joint.
  M9 fingertips       each fingertip's shape relative to the wrist, in palm sizes (0.6), same time tolerance.

Verdict: "fail" (a body failure), "uncertain" (not enough to judge: never a pass), "pass". Thresholds are
MotionGuard's provisional, uncalibrated values (motiongate_thresholds.json).

Pure numpy; the DWPose pass runs in the SoundstageMotionGate node (nodes_takecheck.py).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

VERSION = 1
THRESHOLDS_FILE = Path(__file__).with_name("motiongate_thresholds.json")

BODY = np.arange(2, 14)
JOINT_NAMES = {0: "nose", 1: "neck", 2: "right shoulder", 3: "right elbow", 4: "right wrist", 5: "left shoulder",
               6: "left elbow", 7: "left wrist", 8: "right hip", 9: "right knee", 10: "right ankle", 11: "left hip",
               12: "left knee", 13: "left ankle"}
# Hands: index 0 = wrist, fingertips 4/8/12/16/20. Our hand array is [right 0-20, left 21-41] (the Pose pass order).
FINGER_TIPS = {4: "thumb", 8: "index", 12: "middle", 16: "ring", 20: "little"}
FINGER_DISTANCE = 0.6       # palm sizes (MotionGuard's measured value)
MIN_PALM_PX = 12.0          # MotionGuard: 5 px on its reference renders; a draft's hands are soft, so we ask for more
MATCH_TORSOS = 2.0          # a DWPose person further than this (median joint distance, torso lengths) is someone else
MIN_SCORE_MATCH = 0.3


def thresholds() -> dict:
    return json.loads(THRESHOLDS_FILE.read_text(encoding="utf-8"))


def spans(mask, minimum: int = 1) -> list[list[int]]:
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        if not v and start is not None:
            if i - start >= minimum:
                out.append([start, i - 1])
            start = None
    return out


def similarity(r: np.ndarray, g: np.ndarray) -> tuple[float, np.ndarray]:
    """One clip-wide positive scale + translation g ~ s r + t, robust residual trimming, no rotation (MotionGuard)."""
    keep = np.ones(len(r), dtype=bool)
    if len(r) < 6:
        return 1.0, np.zeros(2)
    scale, translation = 1.0, np.zeros(2)
    for _ in range(3):
        a, b = r[keep], g[keep]
        ac, bc = np.median(a, axis=0), np.median(b, axis=0)
        den = np.sum((a - ac) ** 2)
        if den < 1e-6:
            break
        scale = float(np.sum((a - ac) * (b - bc)) / den)
        if not np.isfinite(scale) or scale <= 1e-6:
            return 1.0, np.zeros(2)
        translation = bc - scale * ac
        res = np.linalg.norm(g - (scale * r + translation), axis=1)
        keep = res <= max(float(np.quantile(res, 0.8)), 1e-6)
    return scale, translation


def shifted(g: np.ndarray, cg: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """generated[i + k] is compared with reference[i]; frames shifted in from outside the clip are unobserved."""
    n = len(g)
    gs, cs = np.zeros_like(g), np.zeros_like(cg)
    lo, hi = max(0, -k), min(n, n - k)
    if hi > lo:
        gs[lo:hi], cs[lo:hi] = g[lo + k:hi + k], cg[lo + k:hi + k]
    return gs, cs


def shift_search(r, g, cg, ref_valid, L, t, fps) -> int:
    """One clip-wide integer shift within the allowed lag; ties keep the smaller shift (MotionGuard)."""
    best = (-2.0, 0)
    m = round(fps * t["max_abs_lag_seconds"])
    for k in sorted(range(-m, m + 1), key=abs):
        gs, cs = shifted(g, cg, k)
        mask = ref_valid & (cs >= t["min_estimator_score"])
        if mask.sum() < 6:
            continue
        scale, tr = similarity(r[mask], gs[mask])
        err = np.linalg.norm((gs - tr) / scale - r, axis=2) / L
        score = -float(np.minimum(err[mask], 1.0).mean())    # capped mean error; PCK saturates on still joints
        if score > best[0] + 1e-9:
            best = (score, k)
    return best[1]


def jitter_noise(a: np.ndarray, ok: np.ndarray, L: np.ndarray) -> float:
    """The estimator's own noise on this clip: how far a joint sits from the midpoint of its two neighbours, in
    torso lengths (median). Smooth motion at 24 fps barely bends in 2 frames, so this is mostly DWPose jitter."""
    if len(a) < 3:
        return 0.0
    both = ok[:-2] & ok[1:-1] & ok[2:]
    d = np.linalg.norm(a[1:-1] - (a[:-2] + a[2:]) / 2, axis=2) / L[1:-1]
    return float(np.median(d[both])) if both.any() else 0.0


def _fmt_t(x: float) -> float:
    return round(float(x), 2)


def compare_person(r: np.ndarray, rv: np.ndarray, g: np.ndarray, cg: np.ndarray, fps: float, t: dict | None = None,
                   rh: np.ndarray | None = None, rhv: np.ndarray | None = None, gh: np.ndarray | None = None,
                   ghs: np.ndarray | None = None) -> dict:
    """One person. r [n,18,2] stage joints in take pixels, rv [n,18] where the stage has them on screen; g/cg the
    DWPose joints and scores (0 where DWPose did not find this person). Hands: rh [n,42,2], rhv [n,42], gh, ghs."""
    t = t or thresholds()
    n = len(r)
    ev = int(t["min_evidence_frames"])
    tol = round(fps * t["max_abs_lag_seconds"])
    floor = t["min_pose_motion_pixels_per_frame_normalized"]
    out = {"verdict": "uncertain", "failures": [], "advisory": [], "uncertain_reasons": [], "metrics": {}}
    r = np.where(rv[..., None], r, 0.0)
    g = np.nan_to_num(g)
    torso = np.linalg.norm(r[:, [2, 5]].mean(1) - r[:, [8, 11]].mean(1), axis=1)
    torso_ok = rv[:, [2, 5, 8, 11]].all(1) & (torso > 1.0)
    if torso_ok.sum() < ev:
        out["uncertain_reasons"].append("the stage person is not on screen long enough")
        return out
    torso[~torso_ok] = np.median(torso[torso_ok])
    L = torso[:, None]
    ref_valid = rv.copy()
    ref_valid[:, [0, 1, 14, 15, 16, 17]] = False
    found = (cg[:, BODY] >= t["min_estimator_score"]).mean(1) >= 0.5
    out["metrics"]["found_fraction"] = round(float(found[torso_ok].mean()), 3)
    if found.sum() < ev:
        out["uncertain_reasons"].append("DWPose did not find this person in the draft")
        return out

    shift = shift_search(r, g, cg, ref_valid, L, t, fps)
    g, cg = shifted(g, cg, shift)
    out["metrics"]["time_shift"] = {"frames": int(shift), "seconds": round(shift / fps, 3)}
    valid = ref_valid & (cg >= t["min_estimator_score"])
    if valid.sum() < 6:
        out["uncertain_reasons"].append("too few confident joints")
        return out
    scale, tr = similarity(r[valid], g[valid])
    aligned = (g - tr) / scale
    out["metrics"]["framing"] = {"scale": round(scale, 3), "offset_px": [round(float(x), 1) for x in tr]}

    noise = jitter_noise(aligned, valid, L)
    gate = max(floor, 3 * noise)
    out["metrics"]["noise_torso"] = round(noise, 4)
    out["metrics"]["motion_gate_torso"] = round(gate, 4)

    def fail(kind, s, e, joints, metric, value, thr, scope, into=None):
        (into if into is not None else out["failures"]).append({
            "type": kind, "frames": [int(s), int(e)], "t0": _fmt_t(s / fps), "t1": _fmt_t((e + 1) / fps),
            "joints": [int(j) for j in joints], "names": [JOINT_NAMES.get(int(j), str(j)) for j in joints],
            "metric": metric, "value": round(float(value), 3) if value is not None else None, "threshold": thr,
            "scope": scope})

    # Moving frames (the stage's own motion): the clip-wide PCK is judged there, as MotionGuard does.
    vr = np.linalg.norm(np.diff(r, axis=0), axis=2) / L[1:]
    active_joint = (vr > floor) & ref_valid[1:] & ref_valid[:-1]
    active = active_joint.any(1)
    reasons = out["uncertain_reasons"]
    if active.sum() < ev:
        reasons.append("the stage person barely moves (nothing to judge the motion on)")

    # ---- M1 whole-clip PCK
    err = np.linalg.norm(aligned - r, axis=2) / L
    vb = valid.sum(1)
    pck = np.divide(((err <= t["pck_normalized_distance"]) & valid).sum(1), vb, out=np.zeros(n), where=vb > 0)
    usable = np.r_[False, active] & (valid[:, BODY].mean(1) >= t["min_active_valid_fraction"])
    mean_pck = float(pck[usable].mean()) if usable.any() else None
    allv = valid[:, BODY].any(1)
    out["metrics"]["pck"] = {"mean": round(mean_pck, 3) if mean_pck is not None else None,
                             "all_frames": round(float(pck[allv].mean()), 3) if allv.any() else None,
                             "threshold": t["min_active_mean_pck"], "frames_used": int(usable.sum())}
    whole_fail = False
    if usable.sum() < ev:
        reasons.append("too few moving frames with the body in view")
    elif mean_pck < t["min_active_mean_pck"]:
        whole_fail = True
        for s, e in spans(usable & (pck < t["min_active_mean_pck"])):
            sl = slice(s, e + 1)
            counts = valid[sl].sum(0)
            miss = ((err[sl] > t["pck_normalized_distance"]) & valid[sl]).sum(0)
            rates = np.divide(miss, counts, out=np.zeros(18), where=counts > 0)
            js = sorted((int(j) for j in BODY if counts[j] >= min(ev, e - s + 1) and rates[j] >= 0.5), key=lambda j: (-rates[j], j))[:2]
            fail("wrong_pose", s, e, js, "pck", float(pck[sl].mean()), t["min_active_mean_pck"], "whole body")

    # ---- M1 per joint, +/-0.25 s tolerance
    local = np.full((n, 18), np.inf)
    for k in range(-tol, tol + 1):
        lo, hi = max(0, -k), min(n, n - k)
        if hi <= lo:
            continue
        d = np.linalg.norm(aligned[lo:hi] - r[lo + k:hi + k], axis=2) / L[lo:hi]
        d[~ref_valid[lo + k:hi + k]] = np.inf
        local[lo:hi] = np.minimum(local[lo:hi], d)
    joint_bad = (local > t["pck_normalized_distance"]) & valid
    joint_bad[:tol] = False
    joint_bad[n - tol:] = False
    if n - 2 * tol < ev:
        reasons.append("the take is too short for the per-joint check")
    elif not whole_fail:
        for j in BODY:
            for s, e in spans(joint_bad[:, j], ev):
                fail("wrong_pose", s, e, [j], "joint_error", float(local[s:e + 1, j].mean()), t["pck_normalized_distance"], "one joint")

    # ---- M5 missing motion, judged against DWPose's noise on this draft
    selected = [int(j) for j in BODY if ref_valid[:, j].mean() >= t["stable_reference_joint_fraction"]]
    sc_ok = cg >= t["min_estimator_score"]

    def best_ratio(s, e, cols, ref_disp):
        """Best generated/stage displacement ratio within +/-0.25 s; None when DWPose saw none of it (missing
        samples never become zero-motion evidence, as in MotionGuard)."""
        best = None
        for k in range(-tol, tol + 1):
            a, b = s + k, e + k
            if a < 0 or b >= n:
                continue
            use = [j for j in cols if sc_ok[a, j] and sc_ok[b, j]]
            if len(use) * 2 < len(cols):
                continue
            dg = np.linalg.norm(aligned[b, use] - aligned[a, use], axis=1) / L[e, 0]
            dr = ref_disp[[cols.index(j) for j in use]]
            best = max(best or 0.0, float(dg.sum() / max(dr.sum(), 1e-9)))
        return best

    windows, low = [], np.zeros(n, bool)
    for s in range(n - ev):
        e = s + ev
        cols = [j for j in selected if valid[s, j] and valid[e, j]]    # seen by the stage AND by DWPose
        if not cols or len(cols) * 2 < len(selected):
            continue
        ref_disp = np.linalg.norm(r[e, cols] - r[s, cols], axis=1) / L[e, 0]
        if ref_disp.mean() <= gate:
            continue
        ratio = best_ratio(s, e, cols, ref_disp)
        if ratio is None:
            continue
        windows.append(ratio)
        if ratio < t["min_motion_energy_ratio"]:
            low[s:e + 1] = True
    out["metrics"]["motion"] = {"windows": len(windows), "min_ratio": round(min(windows), 3) if windows else None,
                                "threshold": t["min_motion_energy_ratio"]}
    if not windows and active.sum() >= ev:
        reasons.append("the stage motion is within DWPose's noise (cannot tell motion from jitter)")
    for s, e in spans(low, ev):
        fail("missing_motion", s, e, selected, "motion_ratio", out["metrics"]["motion"]["min_ratio"], t["min_motion_energy_ratio"], "whole body")
    body_low = low
    for j in BODY:
        bad = np.zeros(n, bool)
        ratios = []
        for s in range(n - ev):
            e = s + ev
            if not valid[s:e + 1, j].all():          # the stage and DWPose both see it the whole window
                continue
            ref_disp = np.array([np.linalg.norm(r[e, j] - r[s, j]) / L[e, 0]])
            if ref_disp[0] <= gate:
                continue
            ratio = best_ratio(s, e, [int(j)], ref_disp)
            if ratio is None:
                continue
            ratios.append(ratio)
            if ratio < t["min_motion_energy_ratio"]:
                bad[s:e + 1] = True
        bad &= ~body_low            # already reported for the whole body
        for s, e in spans(bad, ev):
            fail("missing_motion", s, e, [j], "joint_motion_ratio", min(ratios) if ratios else None, t["min_motion_energy_ratio"], "one joint")

    # ---- M9 fingertips (advisory)
    out["metrics"]["fingers"] = finger_check(rh, rhv, gh, ghs, shift, n, fps, t, ev, tol, fail, out["advisory"])

    out["failures"].sort(key=lambda f: (f["frames"][0], f["type"]))
    out["uncertain_reasons"] = list(dict.fromkeys(reasons))
    out["verdict"] = "fail" if out["failures"] else "uncertain" if out["uncertain_reasons"] else "pass"
    return out


def finger_check(rh, rhv, gh, ghs, shift, n, fps, t, ev, tol, fail, into) -> dict:
    """Per-fingertip shape (wrist-relative, in palm sizes) with the same +/-0.25 s tolerance as the joints."""
    if rh is None or gh is None or ghs is None or rhv is None:
        return {"status": "not_measured", "reason": "no hands in the stage or in the draft"}
    gh, ghs = shifted(np.nan_to_num(gh), ghs, shift)
    judged = {}
    for side, off in (("right", 0), ("left", 21)):
        idx = list(range(off, off + 21))
        bases = [off + 5, off + 9, off + 13, off + 17]

        def shape(h, ok):
            size = np.linalg.norm(h[:, bases] - h[:, [off]], axis=2).mean(1)
            ok = ok & (size >= MIN_PALM_PX)
            return (h[:, idx] - h[:, [off]]) / np.maximum(size, 1)[:, None, None], ok

        sr, okr = shape(np.where(rhv[..., None], rh, 0.0), rhv[:, idx].all(1))
        sg, okg = shape(gh, (ghs[:, idx] >= t["min_estimator_score"]).all(1))
        for tip, name in FINGER_TIPS.items():
            err = np.full(n, np.inf)
            for k in range(-tol, tol + 1):
                lo, hi = max(0, -k), min(n, n - k)
                if hi <= lo:
                    continue
                d = np.linalg.norm(sg[lo:hi, tip] - sr[lo + k:hi + k, tip], axis=1)
                d[~okr[lo + k:hi + k]] = np.inf
                err[lo:hi] = np.minimum(err[lo:hi], d)
            use = okg & okr
            use[:tol] = False
            use[n - tol:] = False
            judged[f"{side} {name}"] = int(use.sum())
            for s, e in spans(use & (err > FINGER_DISTANCE), ev):
                fail("finger", s, e, [], "finger_shape", float(err[s:e + 1][np.isfinite(err[s:e + 1])].mean()) if np.isfinite(err[s:e + 1]).any() else None,
                     FINGER_DISTANCE, "one fingertip", into)
                into[-1]["names"] = [f"{side} {name} fingertip"]
                into[-1]["joints"] = [(112 if side == "right" else 91) + tip]    # COCO-WholeBody ids, as MotionGuard
    status = "measured" if max(judged.values(), default=0) >= ev else "too_small_or_hidden"
    return {"status": status, "judged_frames": judged, "distance_palm_sizes": FINGER_DISTANCE, "min_palm_px": MIN_PALM_PX}


# ------------------------------------------------------------------------------------------------ the take

def _pts(flat, k) -> np.ndarray:
    """OpenPose flat [x, y, c, ...] -> [k, 3] (zeros when missing, short or not finite)."""
    a = np.zeros((k, 3))
    flat = list(flat or [])[: 3 * k]
    if flat:
        v = np.asarray(flat, float).reshape(-1, 3)
        v[~np.isfinite(v).all(1)] = 0.0          # a NaN / None point is "not found", never a joint at x = 0
        a[: len(v)] = v
    return a


def parse_dwpose(frames: list) -> tuple[list[list[dict]], int, int]:
    """DWPose POSE_KEYPOINT (one dict per frame) -> per frame a list of people {body [18,2] px, score [18],
    hands [42,2] px (right, left), hand_score [42]}, and the canvas size. DWPose may write 0-1 coordinates."""
    out = []
    W = H = 0
    for fr in frames or []:
        w, h = float(fr.get("canvas_width") or 0), float(fr.get("canvas_height") or 0)
        W, H = W or int(w), H or int(h)
        people = []
        for p in fr.get("people") or []:
            b = _pts(p.get("pose_keypoints_2d"), 18)
            hr, hl = _pts(p.get("hand_right_keypoints_2d"), 21), _pts(p.get("hand_left_keypoints_2d"), 21)
            allxy = np.concatenate([b[:, :2], hr[:, :2], hl[:, :2]])
            norm = allxy.size and float(np.abs(allxy).max()) <= 1.5
            sx, sy = (w, h) if norm else (1.0, 1.0)
            fix = lambda a: np.stack([a[:, 0] * sx, a[:, 1] * sy], 1)  # noqa: E731
            sc = b[:, 2] * ((b[:, 0] > 0) | (b[:, 1] > 0))
            hs = np.concatenate([hr[:, 2], hl[:, 2]]) * (np.concatenate([hr[:, :2], hl[:, :2]]).any(1))
            people.append({"body": fix(b), "score": sc, "hands": np.concatenate([fix(hr), fix(hl)]), "hand_score": hs})
        out.append(people)
    return out, W, H


def stage_frame(i: int, n_take: int, frames: int) -> int:
    return int(round(i * (frames - 1) / max(1, n_take - 1)))


def to_px(x: float, y: float, W: int, H: int, stage_aspect: float) -> tuple[float, float]:
    """A point in 0-1 coordinates of the stage frame -> take pixels (the take is the stage frame centre-cropped to
    its own aspect, as blocking._to_px)."""
    A = W / H
    qx, qy = 2 * x - 1, 1 - 2 * y
    qx = qx * stage_aspect / A if A < stage_aspect else qx
    qy = qy * A / stage_aspect if A > stage_aspect else qy
    return (qx + 1) / 2 * W, (1 - qy) / 2 * H


def reference_arrays(person: dict, n_take: int, frames: int, W: int, H: int, aspect: float):
    """One stage person of the reference payload -> (r [n,18,2], rv [n,18], rh [n,42,2], rhv [n,42]) in take px."""
    r, rv = np.zeros((n_take, 18, 2)), np.zeros((n_take, 18), bool)
    rh, rhv = np.zeros((n_take, 42, 2)), np.zeros((n_take, 42), bool)
    body, hands = person.get("body") or [], person.get("hands") or []
    for i in range(n_take):
        sf = min(stage_frame(i, n_take, frames), len(body) - 1) if body else -1
        if sf < 0:
            continue
        for j, p in enumerate((body[sf] or [])[:18]):
            if p is not None:
                x, y = to_px(p[0], p[1], W, H, aspect)
                if 0 <= x < W and 0 <= y < H:
                    r[i, j], rv[i, j] = (x, y), True
        hs = hands[sf] if sf < len(hands) else None
        for side, off in ((0, 0), (1, 21)):
            hand = (hs or [None, None])[side] if hs else None
            if not hand:
                continue
            for j, p in enumerate(hand[:21]):
                if p is not None:
                    x, y = to_px(p[0], p[1], W, H, aspect)
                    if 0 <= x < W and 0 <= y < H:
                        rh[i, off + j], rhv[i, off + j] = (x, y), True
    return r, rv, rh, rhv


def match_people(refs: list[tuple], gen: list[list[dict]]) -> list[tuple]:
    """Greedy one-to-one per frame: each stage person takes the DWPose person whose joints sit closest (median, in
    the stage person's torso lengths). -> per stage person (g [n,18,2], cg [n,18], gh [n,42,2], ghs [n,42])."""
    n = len(gen)
    outs = [(np.zeros((n, 18, 2)), np.zeros((n, 18)), np.zeros((n, 42, 2)), np.zeros((n, 42))) for _ in refs]
    for i in range(n):
        cands = []
        for a, (r, rv, _, _) in enumerate(refs):
            if rv[i, BODY].sum() < 4:
                continue
            tor = np.linalg.norm(r[i, [2, 5]].mean(0) - r[i, [8, 11]].mean(0)) if rv[i, [2, 5, 8, 11]].all() else None
            if not tor:
                ys = r[i, rv[i], 1]
                tor = max(1.0, (ys.max() - ys.min()) / 3) if ys.size else 1.0
            for k, p in enumerate(gen[i]):
                both = rv[i] & (p["score"] >= MIN_SCORE_MATCH)
                both[[14, 15, 16, 17]] = False
                if both.sum() < 3:
                    continue
                d = float(np.median(np.linalg.norm(p["body"][both] - r[i, both], axis=1))) / tor
                if d <= MATCH_TORSOS or (len(refs) == 1 and len(gen[i]) == 1):   # one and one: it is them, however far
                    cands.append((d, a, k))
        cands.sort()
        used_a, used_k = set(), set()
        for d, a, k in cands:
            if a in used_a or k in used_k:
                continue
            used_a.add(a)
            used_k.add(k)
            p = gen[i][k]
            outs[a][0][i], outs[a][1][i], outs[a][2][i], outs[a][3][i] = p["body"], p["score"], p["hands"], p["hand_score"]
    return outs


def gate(reference: dict, dwpose: list, fps: float | None = None, t: dict | None = None) -> dict:
    """The motion gate of one take. reference: the App's stage skeletons {v, frames, fps, aspect, people: [{id, name,
    body: [per stage frame: 18 x ([x, y] in 0-1 | null)], hands: [per stage frame: [right21 | null, left21 | null]]}]};
    dwpose: the POSE_KEYPOINT list DWPose read from the take (one dict per take frame)."""
    t = t or thresholds()
    gen, W, H = parse_dwpose(dwpose)
    n = len(gen)
    fps = float(fps or reference.get("take_fps") or reference.get("fps") or 24.0)
    base = {"version": VERSION, "estimator": "DWPose", "threshold_status": t.get("threshold_status"),
            "frames": n, "fps": fps, "size": [W, H], "people": [], "failures": [], "advisory": []}
    people = [p for p in (reference or {}).get("people") or [] if p.get("body")]
    if not people:
        return {**base, "verdict": "unmeasured", "why": "no clay people on this shot (the gate judges people)"}
    if n < 2 * round(fps * t["max_abs_lag_seconds"]) + int(t["min_evidence_frames"]) or not W or not H:
        return {**base, "verdict": "unmeasured", "why": "the take is too short or DWPose read no frames"}
    frames = int(reference.get("frames") or len(people[0]["body"]))
    aspect = float(reference.get("aspect") or 16 / 9)
    refs = [reference_arrays(p, n, frames, W, H, aspect) for p in people]
    gens = match_people(refs, gen)
    verdicts = []
    for p, (r, rv, rh, rhv), (g, cg, gh, ghs) in zip(people, refs, gens):
        res = compare_person(r, rv, g, cg, fps, t, rh, rhv, gh, ghs)
        name = p.get("name") or p.get("id") or "person"
        for f in res["failures"] + res["advisory"]:
            f["who"] = name
        base["people"].append({"id": p.get("id"), "name": name, "verdict": res["verdict"],
                               "pck": res["metrics"].get("pck", {}).get("mean"),
                               "shift_s": (res["metrics"].get("time_shift") or {}).get("seconds"),
                               "noise_torso": res["metrics"].get("noise_torso"),
                               "found": res["metrics"].get("found_fraction"),
                               "fingers": (res["metrics"].get("fingers") or {}).get("status"),
                               "uncertain": res["uncertain_reasons"], "failures": res["failures"], "advisory": res["advisory"],
                               "metrics": res["metrics"]})
        base["failures"] += res["failures"]
        base["advisory"] += res["advisory"]
        verdicts.append(res["verdict"])
    base["failures"].sort(key=lambda f: (f["t0"], f["who"]))
    base["advisory"].sort(key=lambda f: (f["t0"], f["who"]))
    base["verdict"] = "fail" if "fail" in verdicts else "uncertain" if "uncertain" in verdicts else "pass"
    base["summary"] = summary(base)
    return base


def summary(res: dict) -> str:
    """One line for the status bar: what failed, whose joint, when."""
    if res["verdict"] == "pass":
        pcks = [p["pck"] for p in res["people"] if p.get("pck") is not None]
        return f"Motion follows the stage ({round(100 * min(pcks))}% of joints on their marks)." if pcks else "Motion follows the stage."
    if res["verdict"] == "fail":
        f = res["failures"][0]
        what = "doesn't move" if f["type"] == "missing_motion" else "is off its pose"
        part = ", ".join(f["names"][:2]) if f["names"] else "body"
        if f["scope"] == "whole body" and f["type"] == "missing_motion":
            part = "body"
        more = len(res["failures"]) - 1
        return f"{f['who']}'s {part} {what} {f['t0']:.1f}–{f['t1']:.1f} s" + (f" (+{more} more)" if more > 0 else "") + "."
    why = next((u for p in res["people"] for u in p["uncertain"]), res.get("why") or "not enough to judge")
    return f"Motion: can't tell ({why})."
