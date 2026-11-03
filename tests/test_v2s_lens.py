"""The Video → 3D performer and camera share ONE lens (regression for share/QA/v2s_motion_fidelity, 2026-11-02).

The bug: the solve used Depth Anything 3's mono focal (896 px at 1280 wide on the street-dance clip) while SAM 3D Body
captured the dancer with 1468 px. Seen through the solved camera, the clay came out ~2/3 her size (torso 127 vs 191 px)
with its shoulders at her chest. Here a synthetic dancer is captured by "SAM" with its own focal; the stage is solved
with DA3's focal and a wrong scale guess, then fixed the way pipeline.run does it: performer.shared_K for the solve,
then performer.fit_scale -> rebuild at mpu / s -> place again. The clay's projected torso must match SAM's 2D joints.
"""
import numpy as np

from soundstage.video2stage import performer as P
from soundstage.video2stage import track as T

W_SRC, H_SRC, F_SAM = 1280, 720, 1468.6     # the street-dance clip and SAM 3D Body's focal there
SIZE = (768, 432)                            # the proxy grid DA3 and the solve work on
K_DA3 = np.array([[537.6, 0, 383.5], [0, 537.6, 215.5], [0, 0, 1]])   # DA3 mono's focal on that grid (25.2 mm)
CAM_H = 1.0                                  # the real camera height (m); the solve's guess is 1.6 m

# A standing dancer in OpenCV camera space: (x, height above the floor), 4 m out, feet on the floor CAM_H below.
JOINTS = {0: (0.0, 1.58), 1: (0.0, 1.45), 2: (-0.18, 1.40), 3: (-0.25, 1.12), 4: (-0.28, 0.86), 5: (0.18, 1.40),
          6: (0.25, 1.12), 7: (0.28, 0.86), 8: (-0.10, 0.92), 9: (-0.11, 0.50), 10: (-0.11, 0.08), 11: (0.10, 0.92),
          12: (0.11, 0.50), 13: (0.11, 0.08), 14: (-0.03, 1.62), 15: (0.03, 1.62), 16: (-0.07, 1.60), 17: (0.07, 1.60)}


def _take(n=12, x0=0.3, z0=4.0):
    cv = np.array([[x0 + x, CAM_H - y, z0] for x, y in (JOINTS[i] for i in range(18))])
    root = np.array([x0, -(CAM_H - 0.9), -z0])                  # SAM's flipped axes: y up, z toward the camera
    body = np.stack([cv[:, 0], -cv[:, 1], -cv[:, 2]], 1) - root
    uv = np.stack([F_SAM * cv[:, 0] / cv[:, 2] + W_SRC / 2, F_SAM * cv[:, 1] / cv[:, 2] + H_SRC / 2], 1)
    px = [uv[10].tolist(), uv[13].tolist(), uv[8].tolist(), uv[11].tolist()]
    return {"frames": n, "fps": 24, "source_frames": list(range(n)), "image_size": [H_SRC, W_SRC], "focal_px": F_SAM,
            "body": [body.tolist()] * n, "root": [root.tolist()] * n, "px": [px] * n}


POSES = [np.hstack([np.eye(3), np.zeros((3, 1))])] * 2
TIMES = [0.0, 1.0]


def _stage(K, mpu):
    ground = T.ground_from_horizon(K[1, 2], K, 1.0)            # a level camera, 1 depth unit above the floor
    return T.world_frame(ground, mpu)


def _overlay(take, K, mpu, scale):
    A, b = _stage(K, mpu)
    placed = P.place(take, POSES, TIMES, A, b, K, SIZE, 24.0)
    return P.overlay_error(take, placed, POSES, TIMES, A, b, K, SIZE, 24.0, scale), placed, A, b


def test_the_old_two_lens_build_reproduces_the_bug():
    take = _take()
    e, *_ = _overlay(take, K_DA3, 1.6, 1.0)
    assert e["frames"] == 12
    assert e["size_ratio"] < 0.75 and e["err_torso"] > 0.3        # small and off the dancer, as the QA overlay showed


def test_shared_lens_uses_sams_focal_on_the_proxy_grid():
    K, note = P.shared_K(K_DA3, _take(), SIZE)
    assert abs(K[0, 0] - F_SAM * SIZE[0] / W_SRC) < 1e-6 and K[1, 1] == K[0, 0]
    assert K[0, 2] == K_DA3[0, 2] and K[1, 2] == K_DA3[1, 2]      # DA3's principal point stays
    assert "SAM 3D Body" in note and "25.2 mm" in note
    bad = dict(_take(), focal_px=40.0)                             # a 1 mm "lens": keep DA3's
    K2, note2 = P.shared_K(K_DA3, bad, SIZE)
    assert np.allclose(K2, K_DA3) and "implausible" in note2
    assert np.allclose(P.shared_K(K_DA3, dict(_take(), focal_px=None), SIZE)[0], K_DA3)


def test_one_lens_and_the_performer_scale_put_the_clay_on_sams_joints():
    take = _take()
    K, _ = P.shared_K(K_DA3, take, SIZE)
    mpu = 1.6                                                      # the camera-height guess: 60% too big
    e1, placed, A, b = _overlay(take, K, mpu, 1.0)
    assert 0.55 < e1["size_ratio"] < 0.7                           # same lens, but the wrong scale still shrinks her
    s = P.fit_scale(take, placed, POSES, TIMES, A, b, K, SIZE, 24.0)
    assert 1.5 < s < 1.8
    for _ in range(4):                                             # pipeline.run: rebuild at the performer's scale
        mpu /= s
        e2, placed, A, b = _overlay(take, K, mpu, 1.0)
        s = P.fit_scale(take, placed, POSES, TIMES, A, b, K, SIZE, 24.0)
        if abs(s - 1) <= 0.01:
            break
    assert abs(s - 1.0) <= 0.01
    b2, s2 = b, s
    e3, *_ = _overlay(take, K, mpu, s2)
    assert abs(e3["torso_clay_px"] / e3["torso_sam_px"] - 1) < 0.03   # the projected torso matches SAM's
    assert e3["err_torso"] < 0.05                                  # every joint on SAM's 2D joint
    assert abs(P.stature(take) * s2 - 1.7) < 0.08                  # and she is her real height
    assert abs(float(b2[1]) - CAM_H) < 0.03                        # the camera ends up its real height up


def test_stature_from_the_take():
    assert abs(P.stature(_take()) - (1.58 - 0.08) / 0.87) < 1e-6
