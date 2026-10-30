"""Video → Stage: model-answer parsing, the camera/key conversions (stage: metres, Y up, rotation_deg 0 faces +Z,
north = +Z, +X screen-left of a camera looking +Z) and the mono-depth camera tracker on a synthetic clip."""
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.video2stage import convert, graphs, track, vlm  # noqa: E402
from soundstage.video2stage import pipeline  # noqa: E402

cv2 = pytest.importorskip("cv2")


# ------------------------------------------------------------------------------------------------- parsing
def test_parse_reply_fenced_and_typed():
    text = """```json
{"setting":"coastal highway","time":"Midday","camera":{"height_m":"30","type":"drone"},
 "objects":[{"label":"red pickup truck","kind":"car","color":"#C62222","bbox":[400,500,460,560],
             "facing":"away from camera","moving":"true"},
            {"label":"white sedan","kind":"car","bbox":[0.1,0.2,0.15,0.25],"moving":false},
            {"label":"no box","kind":"car"}],
 "set":[{"type":"highway","side":"centre","lanes":"4"},{"type":"sea","side":"Left","distance":"far"},
        {"type":"sky"},"shrubs"]}
```"""
    r = vlm.parse_reply(text)
    assert r["camera"] == {"height_m": 30.0, "type": "drone"}
    assert [o["kind"] for o in r["objects"]] == ["pickup", "car"]
    red, white = r["objects"]
    assert red["color"] == "#c62222" and red["moving"] is True and red["facing"] == "away"
    assert white["bbox"] == [100.0, 200.0, 150.0, 250.0]          # 0-1 boxes are rescaled to the 0-1000 grid
    assert [(s["type"], s["side"]) for s in r["set"]] == [("road", "centre"), ("ocean", "left"), ("shrubs", "ahead")]
    assert r["set"][0]["lanes"] == 4 and r["set"][1]["distance"] == "far"


def test_parse_reply_truncated_and_bare_list():
    cut = '{"objects":[{"label":"woman in yellow coat","kind":"person","bbox":[400,100,520,900],"moving":true},' \
          '{"label":"man on bench","kind":"person","bbox":[700,300,780,'
    r = vlm.parse_reply(cut)
    assert len(r["objects"]) == 1 and r["objects"][0]["kind"] == "person"
    r = vlm.parse_reply('<think>hmm</think>[{"label":"dog","kind":"dog","bbox":[1,2,30,40]}]')
    assert r["objects"][0]["kind"] == "dog"
    with pytest.raises(ValueError):
        vlm.parse_reply("I cannot see anything.")


def test_merge_reads_matches_by_kind_label_and_place():
    a = {"camera": {"height_m": None}, "set": [], "objects": [
        {"label": "red pickup", "kind": "pickup", "color": "#c62222", "bbox": [450, 500, 500, 540], "facing": "", "moving": True},
        {"label": "white car", "kind": "car", "color": "#f2f2f2", "bbox": [300, 400, 330, 420], "facing": "", "moving": True}]}
    b = {"camera": {"height_m": 2.0}, "set": [{"type": "road"}], "objects": [
        {"label": "white car", "kind": "car", "color": "#eeeeee", "bbox": [100, 450, 200, 520], "facing": "", "moving": True},
        {"label": "red pickup truck", "kind": "pickup", "color": "#cc2020", "bbox": [0, 400, 400, 800], "facing": "", "moving": True},
        {"label": "blue car", "kind": "car", "color": "#2030a0", "bbox": [700, 450, 720, 470], "facing": "", "moving": True}]}
    m = vlm.merge_reads(a, b)
    by = {o["label"]: o for o in m["objects"]}
    assert by["red pickup"]["bbox_end"] == [0, 400, 400, 800]
    assert by["white car"]["bbox_end"] == [100, 450, 200, 520]
    assert by["blue car"]["bbox_start"] is None                 # entered during the shot
    assert m["camera"]["height_m"] == 2.0 and m["set"] == [{"type": "road"}]


def test_graphs_use_the_queue_nodes():
    g = vlm.graph("qwen3.5_4b_bf16.safetensors", "a.png", "b.png")
    assert {n["class_type"] for n in g.values()} >= {"CLIPLoader", "TextGenerate", "PreviewAny", "LoadImage"}
    d = graphs.da3_graph("depth_anything_3_mono_large.safetensors", ["f0.png", "f1.png", "f2.png"], "x", False,
                         backdrop_prefix="soundstage/x")
    assert d["d2"]["inputs"]["mode"] == "mono" and d["x1"]["class_type"] == "SoundstageDA3Export"
    assert d["d2"]["inputs"]["image"] == ["b2", 0] and d["m2"]["class_type"] == "SaveGLB"
    mv = graphs.da3_graph("depth_anything_3_base.safetensors", ["a", "b"], "x", True)
    assert mv["d2"]["inputs"]["mode"] == "multiview" and "m1" not in mv
    assert graphs.pick_model(["depth_anything_3_mono_large.safetensors"]) == ("depth_anything_3_mono_large.safetensors", False)
    assert graphs.pick_model(["depth_anything_3_mono_large.safetensors", "depth_anything_3_base.safetensors"]) == \
        ("depth_anything_3_base.safetensors", True)


# ------------------------------------------------------------------------------------------------- conventions
def _pose(center_cv, yaw_deg=0.0, pitch_deg=0.0):
    """World-to-camera [R|t] for a camera at center_cv (cam0/OpenCV space) turned by yaw (right) and pitch (down)."""
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])   # cam->world
    Rx = np.array([[1, 0, 0], [0, math.cos(p), math.sin(p)], [0, -math.sin(p), math.cos(p)]])
    Rcw = Ry @ Rx
    R = Rcw.T
    return np.hstack([R, (-R @ np.asarray(center_cv, float)).reshape(3, 1)])


K = np.array([[448.0, 0, 319.5], [0, 448.0, 179.5], [0, 0, 1]])


def test_world_frame_axes():
    ground = (np.array([0.0, -1.0, 0.0]), 1.6)               # level camera 1.6 units above the floor
    A, b = track.world_frame(ground, 1.0)
    assert np.allclose(A @ np.zeros(3) + b, [0, 1.6, 0])     # camera 0 stands 1.6 m up at the origin
    assert np.allclose(A @ [0, 0, 1], [0, 0, 1])             # it looks north (+Z)
    assert np.allclose(A @ [1, 0, 0], [-1, 0, 0])            # screen-right is -X
    assert np.allclose(A @ [0, 1, 0], [0, -1, 0])            # image-down is -Y
    assert np.isclose(np.linalg.det(A), 1.0)
    # A camera pitched 30 degrees down: the floor normal is tilted in camera space; stage forward stays +Z.
    p = math.radians(30)
    n = np.array([0, -math.cos(p), -math.sin(p)])   # world up, seen from a camera pitched down
    A2, b2 = track.world_frame((n, 2.0), 1.0)
    fwd = A2 @ [0, 0, 1]
    assert fwd[0] == pytest.approx(0, abs=1e-9) and fwd[1] < 0 and fwd[2] > 0
    assert math.degrees(math.atan2(-fwd[1], fwd[2])) == pytest.approx(30, abs=1e-6)


def test_camera_keys_and_headings():
    ground = (np.array([0.0, -1.0, 0.0]), 1.5)
    A, b = track.world_frame(ground, 2.0)                    # 1 unit = 2 m -> camera 3 m up
    poses = [_pose([0.5 * i, 0, 0]) for i in range(5)]       # trucking to screen-right
    keys = convert.camera_keys(poses, A, b, [0, 0.5, 1, 1.5, 2], K, 640, 10.0)
    assert [k["frame"] for k in keys] == [0, 12, 24, 36, 48]
    assert keys[0]["position"] == [0, 3.0, 0]
    assert keys[-1]["position"][0] == pytest.approx(-4.0)    # screen-right = -X, metres
    assert keys[-1]["target"] == pytest.approx([-4.0, 3.0, 10.0])
    assert keys[0]["focal_mm"] == pytest.approx(448 * 36 / 640, abs=0.05)
    # A yaw to the right turns the aim toward -X.
    k = convert.camera_keys([_pose([0, 0, 0], yaw_deg=90)], A, b, [0], K, 640, 5.0)[0]
    assert k["target"] == pytest.approx([-5.0, 3.0, 0.0], abs=1e-6)
    assert convert.heading([1, 0, 0]) == 90 and convert.heading([0, 0, -1]) == 180


def test_simplify_keys():
    line = [{"frame": i * 6, "position": [i * 1.0, 2, 0], "target": [i * 1.0, 2, 10], "focal_mm": 35} for i in range(16)]
    assert [k["frame"] for k in convert.simplify_keys(line)] == [0, 90]
    corner = [{"frame": i * 6, "position": [min(i, 8) * 1.0, 2, max(0, i - 8) * 1.0], "target": [0, 2, 30], "focal_mm": 35}
              for i in range(17)]
    assert [k["frame"] for k in convert.simplify_keys(corner)] == [0, 48, 96]


def test_ground_point_hits_the_floor():
    ground = (np.array([0.0, -1.0, 0.0]), 2.0)
    A, b = track.world_frame(ground, 1.0)
    pose = _pose([0, 0, 0], pitch_deg=math.degrees(math.atan(2 / 10)))   # looking at the floor 10 m ahead
    p, _ = convert.ground_point(pose, A, b, K, (319.5, 179.5))
    assert p == pytest.approx([0, 0, 10], abs=1e-6)


def test_backdrop_transform_matches_the_scene_frame():
    p = math.radians(20)
    A, b = track.world_frame((np.array([0, -math.cos(p), -math.sin(p)]), 1.3), 3.0)
    act = convert.backdrop_actor({"url": "/view?filename=x.glb"}, A, b)
    x, y, z, w = act["set_xform"]["quat"]
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    v_cv = np.array([0.4, 0.7, 5.0])
    v_gltf = v_cv * [1, -1, -1]
    three = R @ (np.array(act["set_xform"]["flip_xyz"]) * act["set_xform"]["scale"] * v_gltf) + act["set_xform"]["offset"]
    assert three == pytest.approx(A @ v_cv + b, abs=1e-4)


# ------------------------------------------------------------------------------------------------- tracker
def _render(pose, h_cam, tex, size=(640, 360)):
    """Gray frame + depth of a textured floor h_cam below the first camera (OpenCV space, y down)."""
    w, h = size
    u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    rays = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
    R, t = pose[:, :3], pose[:, 3]
    c = -R.T @ t
    d = rays @ R                                                           # R^T ray, row-wise
    s = (h_cam - c[1]) / np.where(d[..., 1] > 1e-6, d[..., 1], np.nan)
    hit = c + d * s[..., None]
    depth = (s * 1.0).astype(np.float32)                                   # rays have z=1 in camera space
    depth[~np.isfinite(depth)] = 0
    mx = ((hit[..., 0] * 40) % tex.shape[1]).astype(np.float32)
    my = ((hit[..., 2] * 40) % tex.shape[0]).astype(np.float32)
    img = cv2.remap(tex, np.nan_to_num(mx), np.nan_to_num(my), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    img[depth <= 0] = 200
    return img, depth


def test_track_mono_recovers_a_dolly_and_pan(tmp_path):
    rng = np.random.default_rng(3)
    tex = cv2.GaussianBlur((rng.random((512, 512)) * 255).astype(np.uint8), (0, 0), 1.5)
    true = [_pose([0.15 * i, 0, 0.6 * i], yaw_deg=2.0 * i, pitch_deg=12) for i in range(8)]
    files, depths = [], []
    for i, P in enumerate(true):
        img, dep = _render(P, 1.5, tex)
        f = tmp_path / f"f_{i:02d}.png"
        cv2.imwrite(str(f), img)
        files.append(str(f))
        # Mono depth is only known up to a per-frame scale: hand the tracker scrambled scales.
        depths.append(dep * (1.0 + 0.3 * math.sin(i)))
    npz = {"depth": np.stack(depths), "intrinsics": np.stack([K] * 8).astype(np.float32)}
    poses, scales, Kx, ground, notes, _ = pipeline.solve(npz, files)
    assert not [n for n in notes if "held the camera" in n]
    got = np.array([track.camera_center(P) for P in poses])
    rel = track.rebase_extrinsics(np.array(true))                         # the truth, seen from camera 0
    want = np.array([track.camera_center(P) for P in rel])
    path = float(np.linalg.norm(want[-1]))
    assert np.linalg.norm(got - want, axis=1).max() < 0.035 * path       # under 3.5 % drift over the move (measured ~2 %)
    for P, Q in zip(poses, rel):
        c = (np.trace(P[:, :3] @ Q[:, :3].T) - 1) / 2
        assert math.degrees(math.acos(min(1.0, c))) < 1.0
    assert ground is not None and ground[1] == pytest.approx(1.5, rel=0.03)

    # ...and the whole conversion: a pickup driving away, a road under it, the move as a few keys.
    breakdown = {"setting": "road", "time": "golden hour", "camera": {"height_m": 1.5, "type": "ground"},
                 "objects": [{"label": "red pickup", "kind": "pickup", "color": "#c62222", "facing": "away",
                              "moving": True, "bbox": [480, 600, 560, 700], "bbox_start": [480, 600, 560, 700],
                              "bbox_end": [470, 480, 520, 540]}],
                 "set": [{"type": "road", "side": "centre", "distance": "near", "lanes": 2, "bbox": None},
                         {"type": "ocean", "side": "left", "distance": "mid", "lanes": 0, "bbox": None},
                         {"type": "mountain", "side": "right", "distance": "far", "lanes": 0, "bbox": None}]}
    notes = []
    scene = convert.assemble(poses=poses, scales=scales, times=[i * 0.5 for i in range(8)], K=Kx, size=(640, 360),
                             depths=list(npz["depth"]), ground=ground, breakdown=breakdown,
                             clip={"duration": 4.0, "fps": 24}, reference={"video": "clip.mp4"}, notes=notes,
                             backdrop={"url": "/view?filename=set.glb"})
    assert scene["shot"] == {"frames": 97, "fps": 24, "aspect": "16:9"} and scene["environment"]["set"] == "empty"
    keys = scene["camera_keys"]
    assert 2 <= len(keys) <= 8 and keys[0]["frame"] == 0 and keys[-1]["frame"] == 84
    assert keys[0]["position"][1] == pytest.approx(1.5, abs=0.05)
    assert keys[-1]["position"][2] - keys[0]["position"][2] == pytest.approx(4.2 * math.cos(math.radians(0)) * 1.0, abs=0.6)
    truck = next(a for a in scene["actors"] if a["kind"] == "truck")
    assert truck["height_m"] == 2.0 and truck["appearance"]["color"] == "#c62222"
    assert len(truck["keys"]) == 2 and truck["keys"][1]["frame"] == 96
    assert truck["keys"][1]["position"][2] > truck["keys"][0]["position"][2]   # driving away = north
    assert abs(truck["rotation_deg"]) < 25
    names = {a["name"] for a in scene["actors"]}
    assert {"Road", "Ocean (left)", "Mountains (right)", "Terrain"} <= names
    ocean = next(a for a in scene["actors"] if a["name"] == "Ocean (left)")
    assert ocean["position"][0] > truck["position"][0]                     # left of the camera = +X
    road = next(a for a in scene["actors"] if a["name"] == "Road")
    assert any(p.get("color") == "#d8c451" for p in road["recipe"]["parts"]) is False   # one-way: no yellow centre
    assert road["recipe"]["size_m"][0] == pytest.approx(2 * 3.6 + 1)
    assert scene["actors"][-1]["kind"] == "glb" and scene["reference"]["video"] == "clip.mp4"
    assert all(k["position"][1] == 0 for a in scene["actors"] for k in a["keys"])


def test_mount_riders_and_drivers():
    acts = [{"id": "bike", "kind": "bicycle", "_bbox": [400, 400, 600, 900]},
            {"id": "rider", "kind": "man", "_bbox": [450, 200, 560, 800]},
            {"id": "car", "kind": "car", "_bbox": [0, 400, 300, 800]},
            {"id": "driver", "kind": "woman", "_bbox": [100, 420, 160, 600]},
            {"id": "walker", "kind": "woman", "_bbox": [800, 200, 900, 950]}]
    convert.mount_riders(acts)
    ids = {a["id"]: a for a in acts}
    assert ids["rider"]["mount_id"] == "bike" and ids["rider"]["pose"] == "cycle"
    assert "driver" not in ids and "mount_id" not in ids["walker"]


def test_time_preset():
    assert convert.time_preset("golden hour") == "magic_hour"
    assert convert.time_preset("night") == "night"
    assert convert.time_preset("afternoon") == "midday"


FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "video2stage_fixtures")


def _fix(name):
    with open(os.path.join(FIX, name)) as f:
        return f.read()


def test_real_answers_from_the_pod():
    """qwen3.5_4b's actual replies on the two test clips (it closed the set list with '}' both times)."""
    road = vlm.merge_reads(vlm.parse_reply(_fix("road_first.txt")), vlm.parse_reply(_fix("road_last.txt")))
    assert road["camera"]["height_m"] == 15 and road["camera"]["type"] == "drone"
    assert [s["type"] for s in road["set"]] == ["road", "ocean", "hill", "guardrail"]
    assert road["set"][0]["lanes"] == 4 and road["set"][1]["side"] == "left"
    hero = road["objects"][0]
    assert hero["kind"] == "pickup" and hero["bbox_end"] is not None   # far "tow truck" = near "pickup"
    ppl = vlm.merge_reads(vlm.parse_reply(_fix("people_first.txt")), vlm.parse_reply(_fix("people_last.txt")))
    assert [o["kind"] for o in ppl["objects"]] == ["person", "person"]
    assert all(o["bbox_end"] for o in ppl["objects"]) and ppl["objects"][0]["moving"] is True
    assert any(s["type"] == "bench" for s in ppl["set"])


def test_linearize_undoes_power_compression():
    """A level-floor depth map raised to the 0.6 (DA3 mono's look) is straightened back to true proportions."""
    h, w = 360, 640
    v_h = 120.0
    rows = np.arange(h, dtype=float)[:, None].repeat(w, 1)
    true = np.where(rows > v_h, 2.0 * K[1, 1] / np.maximum(rows - v_h, 1e-3), 0.0)
    squashed = np.where(true > 0, true ** 0.6, 0.0)
    out, p = track.linearize(squashed.astype(np.float32), v_h, K, squashed > 0)
    assert p == pytest.approx(1 / 0.6, rel=0.03)
    m = (rows > 200)
    ratio = out[m] / true[m]
    assert ratio.std() / ratio.mean() < 0.02          # proportional to the truth again
    assert track.linearize(squashed, None, K, squashed > 0)[1] == 1.0


def test_horizon_row_from_sky():
    sky = np.zeros((100, 200), np.float32)
    sky[:40] = 1
    sky[:55, 150:] = 1          # open sea on the right: the true horizon is lower there
    sky[:20, :50] = 1           # a hill on the left raises it
    sky[20:40, :50] = 0
    assert track.horizon_row(sky) == pytest.approx(55, abs=1)
    assert track.horizon_row(np.zeros((100, 200), np.float32)) is None


def test_interior_answers_keep_furniture():
    r = vlm.parse_reply(_fix("drevil_first.txt"))
    assert [o["kind"] for o in r["objects"]] == ["person", "person", "person"]
    assert "table" in [s["type"] for s in r["set"]]          # "desk" -> library table
