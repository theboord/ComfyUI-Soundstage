"""Milestone 12: the DCC kit's builder scripts (web/stage/interop/dcc/*.py).

They run inside Blender / Unreal / Maya / Nuke, so here they are byte-compiled and imported without those apps (each
script only runs its main() when its host module imports), and their maths is checked: axes, centimetres, Unreal
rotators, Maya / Nuke ZXY rotations, film backs, frame rates. The JS camera maths (units.mjs) is checked against the
Layer Pack's camera.py, so every builder reads the same camera.json either side writes.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import py_compile
import random
import shutil
import subprocess

import numpy as np
import pytest

from soundstage.layerpack import camera as lpcam

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DCC = os.path.join(ROOT, "web", "stage", "interop", "dcc")
BUILDERS = ["build_blender.py", "build_unreal.py", "build_maya.py", "build_nuke.py"]


def load(name):
    spec = importlib.util.spec_from_file_location(name[:-3], os.path.join(DCC, name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def frames(n=4, seed=3):
    rnd = random.Random(seed)
    cams = []
    for i in range(n):
        p = [rnd.uniform(-10, 10), rnd.uniform(0.3, 6), rnd.uniform(-10, 10)]
        t = [p[0] + rnd.uniform(-5, 5), p[1] + rnd.uniform(-2, 1), p[2] + rnd.uniform(-5, 5)]
        cams.append({"position": p, "target": t, "focal_mm": rnd.uniform(18, 85), "roll_deg": rnd.uniform(-10, 10) if i % 2 else 0.0})
    return lpcam.build_frames(cams, 1920, 1038, 1001)


@pytest.mark.parametrize("name", BUILDERS)
def test_builders_compile_and_import_without_their_app(name, tmp_path):
    py_compile.compile(os.path.join(DCC, name), cfile=str(tmp_path / (name + "c")), doraise=True)
    mod = load(name)
    assert mod.__doc__ and ("NOT TESTED" in mod.__doc__ or "verified headless" in mod.__doc__)


def test_blender_axes_and_fps():
    b = load("build_blender.py")
    # Soundstage (x, y, z) -> Blender (x, -z, y): a camera looking down stage -Z looks down Blender +Y.
    assert b.to_blender_point([1, 2, 3]) == [1, -3, 2]
    m = lpcam.look_at([0, 1.6, 10], [0, 1.6, 0]).tolist()
    bm = np.array(b.blender_matrix(m))
    np.testing.assert_allclose(bm[:3, 3], [0, -10, 1.6], atol=1e-12)
    np.testing.assert_allclose(-bm[:3, 2], [0, 1, 0], atol=1e-12)     # view axis
    np.testing.assert_allclose(bm[:3, 1], [0, 0, 1], atol=1e-12)      # camera up = Blender +Z
    assert np.isclose(np.linalg.det(bm[:3, :3]), 1.0)
    assert b.fps_settings(24) == (24, 1.0)
    w, base = b.fps_settings(23.976)
    assert w == 24 and abs(w / base - 23.976) < 1e-9
    o = b.parse_args(["blender", "--", "--render", "x.png", "--frame", "1010", "--hide", "ground,ss_probe", "--transparent", "--empty"])
    assert o["render"] == "x.png" and o["frame"] == 1010 and o["hide"] == ["ground", "ss_probe"] and o["transparent"] and o["empty"]
    assert b.is_default_scene(["Light", "Cube", "Camera"], "") and not b.is_default_scene(["Light", "Cube", "Camera"], "/x.blend")
    assert not b.is_default_scene(["Cube", "Camera", "Light", "Suzanne"], "")


def test_unreal_rotators_round_trip():
    u = load("build_unreal.py")
    rnd = random.Random(7)
    for _ in range(200):
        roll, pitch, yaw = rnd.uniform(-179, 179), rnd.uniform(-89, 89), rnd.uniform(-179, 179)
        X, _, Z = u.rotation_matrix(roll, pitch, yaw)
        r2, p2, y2 = u.rotator_from_xz(X, Z)
        assert abs(p2 - pitch) < 1e-7 and abs(((y2 - yaw + 180) % 360) - 180) < 1e-7 and abs(((r2 - roll + 180) % 360) - 180) < 1e-7


def test_unreal_camera_conversion_default_axes():
    u = load("build_unreal.py")
    # A stage camera 10 m back on +Z at eye height, looking down -Z (toward the origin).
    fr = lpcam.build_frames([{"position": [2, 1.6, 10], "target": [2, 1.6, 0], "focal_mm": 35}], 1920, 1080, 1001)
    k = u.camera_keys(fr)[0]
    np.testing.assert_allclose(k["location"], [200, 1000, 160], atol=1e-9)        # cm, (x, z, y)
    roll, pitch, yaw = k["rotation"]
    assert abs(roll) < 1e-9 and abs(pitch) < 1e-9 and abs(yaw + 90) < 1e-9       # looking down UE -Y
    # looking down from above: pitch -90 + a bit
    fr = lpcam.build_frames([{"position": [0, 10, 0.01], "target": [0, 0, 0], "focal_mm": 35}], 100, 50, 1)
    assert u.camera_keys(fr)[0]["rotation"][1] < -85
    assert det(u.DEFAULT_AXES) < 0          # the glTF -> UE mapping flips handedness, as it must


def det(m):
    return np.linalg.det(np.array(m, dtype=float))


def test_unreal_probe_solver_recovers_any_importer_mapping():
    u = load("build_unreal.py")
    probes = {"ss_probe_o": [0, 0, 0], "ss_probe_x": [1, 0, 0], "ss_probe_y": [0, 1, 0], "ss_probe_z": [0, 0, 1]}
    for axes in [u.DEFAULT_AXES, ((1, 0, 0), (0, 0, -1), (0, 1, 0)), ((0, 0, 1), (1, 0, 0), (0, 1, 0))]:
        origin = [120.0, -40.0, 5.0]
        seen = {k: u.to_ue_point(v, axes, 100.0, origin) for k, v in probes.items()}
        seen = {k: [c + 0.001 for c in v] for k, v in seen.items()}   # a little noise
        a, s, o = u.solve_mapping(seen, probes)
        assert a == tuple(tuple(float(x) for x in r) for r in axes)
        assert abs(s - 100.0) < 0.01
        np.testing.assert_allclose(o, origin, atol=0.01)


def test_unreal_frame_rates():
    u = load("build_unreal.py")
    assert u.frame_rate(24) == (24, 1)
    assert u.frame_rate(23.976) == (24000, 1001)
    assert u.frame_rate(29.97) == (30000, 1001)
    assert u.frame_rate(25) == (25, 1)


def test_maya_units_time_and_film_back():
    m = load("build_maya.py")
    assert m.unit_scale("cm") == 100.0 and m.unit_scale("m") == 1.0 and abs(m.unit_scale("in") - 39.3700787) < 1e-6
    assert m.maya_time_unit(24) == "film" and m.maya_time_unit(25) == "pal" and m.maya_time_unit(30) == "ntsc"
    assert m.maya_time_unit(23.976) == "23.976fps" and m.maya_time_unit(29.97) == "29.97fps" and m.maya_time_unit(12) == "12fps"
    h, v = m.film_back_inches(36.0, 1920, 1038)
    assert abs(h - 36 / 25.4) < 1e-12 and abs(v - 36 * 1038 / 1920 / 25.4) < 1e-12
    assert m.ROTATE_ORDER_ZXY == 2


def test_maya_and_nuke_zxy_rotations_rebuild_the_camera():
    """Maya's rotateOrder zxy and Nuke's rot_order ZXY both mean R = Ry Rx Rz: the keyed angles must rebuild cam_to_world."""
    m, n = load("build_maya.py"), load("build_nuke.py")
    fr = frames(6)
    for k, (frame, t, r, focal), c in zip(m.camera_keys(fr, 100.0), n.camera_keys(fr), fr):
        R = lpcam.rot_zxy(*k["rotate"])
        np.testing.assert_allclose(R, np.array(c["cam_to_world"])[:3, :3], atol=1e-5)
        np.testing.assert_allclose(k["translate"], [v * 100 for v in c["position"]], atol=1e-9)   # cm
        assert frame == c["frame"] and r == list(c["rotate_zxy_deg"]) and focal == c["focal_mm"] and t == list(c["position"])
    assert n.apertures(36.0, 1920, 1080) == (36.0, 20.25)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_js_camera_frames_match_layerpack_camera_py():
    """units.mjs cameraFrames (what the App writes into the kit) == camera.py build_frames (what the Layer Pack writes)."""
    rnd = random.Random(11)
    cams = []
    for i in range(8):
        p = [rnd.uniform(-20, 20), rnd.uniform(0.2, 9), rnd.uniform(-20, 20)]
        cams.append({"position": p, "target": [p[0] + rnd.uniform(-8, 8), rnd.uniform(0, 3), p[2] + rnd.uniform(-8, 8)],
                     "focal_mm": rnd.uniform(14, 135), "roll_deg": rnd.uniform(-20, 20) if i % 3 == 0 else 0.0})
    script = ("import('" + os.path.join(ROOT, "web", "stage", "interop", "units.mjs").replace("\\", "/") + "').then((U) => {"
              "const t = JSON.parse(process.argv[1]); console.log(JSON.stringify(U.cameraFrames(t, 2048, 858, 1001))); });")
    out = subprocess.run(["node", "-e", script, json.dumps(cams)], capture_output=True, text=True, check=True).stdout
    js = json.loads(out)
    py = lpcam.build_frames(cams, 2048, 858, 1001)
    assert len(js) == len(py)
    for a, b in zip(js, py):
        for key in ("frame", "focal_mm", "fx_px", "hfov_deg", "vfov_deg"):
            assert abs(a[key] - b[key]) < 1e-5, key
        np.testing.assert_allclose(a["rotate_zxy_deg"], b["rotate_zxy_deg"], atol=1e-5)
        np.testing.assert_allclose(a["cam_to_world"], b["cam_to_world"], atol=1e-8)
        np.testing.assert_allclose(a["position"], b["position"], atol=1e-6)
