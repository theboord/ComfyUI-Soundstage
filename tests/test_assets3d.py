"""Photo -> 3D maker: the GLB/PLY inspector (bounds, splat count, depth-mesh camera) and the route guard."""
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.assets3d import inspect as INS  # noqa: E402


def make_glb(positions: np.ndarray, node: dict | None = None) -> bytes:
    pos = positions.astype(np.float32)
    binary = pos.tobytes()
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    gl = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, **(node or {})}],
          "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
          "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
                         "min": pos.min(0).tolist(), "max": pos.max(0).tolist()}],
          "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos) * 12}],
          "buffers": [{"byteLength": len(binary)}]}
    js = json.dumps(gl).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def make_ply(positions: np.ndarray, extra: int = 14) -> bytes:
    n = len(positions)
    props = ["x", "y", "z"] + [f"f_{i}" for i in range(extra)]
    head = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + "".join(
        f"property float {p}\n" for p in props) + "end_header\n"
    rows = np.zeros((n, len(props)), dtype=np.float32)
    rows[:, :3] = positions
    return head.encode() + rows.tobytes()


def depth_mesh(h_fov=60.0, aspect=16 / 9, forward=-1.0, up=1.0, floor_depth_rows=True, n=120):
    """A camera-space depth mesh like DA3GeometryToMesh: one vertex per pixel ray, a floor below the camera
    (at -1 m in its up axis) and a wall 6 m away."""
    tx = math.tan(math.radians(h_fov) / 2)
    ty = tx / aspect
    pts = []
    for i in range(n):
        for j in range(n):
            u, v = (i / (n - 1)) * 2 - 1, (j / (n - 1)) * 2 - 1
            dx, dy = u * tx, v * ty            # ray direction (x right, y up), z forward = 1
            d = 6.0
            if dy < 0:                          # floor hit at y = -1 if closer than the wall
                d = min(d, 1.0 / -dy)
            pts.append((dx * d, dy * d * up, d * forward))
    return np.array(pts)


def test_glb_bbox_and_count():
    v = np.array([[0, 0, 0], [1, 2, 3], [-1, 0.5, 1]], dtype=float)
    out = INS.inspect_bytes(make_glb(v), "a.glb")
    assert out["format"] == "glb" and out["count"] == 3
    assert out["bbox"]["min"] == [-1, 0, 0] and out["bbox"]["max"] == [1, 2, 3]
    assert "fov_deg" not in out  # three points are not a depth mesh


def test_glb_node_transform_applied():
    v = np.array([[0, 0, 0], [1, 1, 1]], dtype=float)
    out = INS.inspect_bytes(make_glb(v, {"translation": [10, 0, 0], "scale": [2, 2, 2]}), "a.glb")
    assert out["bbox"]["min"] == [10, 0, 0] and out["bbox"]["max"] == [12, 2, 2]


def test_ply_splat_bbox_ignores_floaters():
    rng = np.random.default_rng(0)
    pts = rng.normal(0, 0.3, size=(20000, 3))
    pts[:20] = 50.0  # a few far floaters
    out = INS.inspect_bytes(make_ply(pts), "s.ply")
    assert out["format"] == "ply" and out["count"] == 20000
    assert max(abs(x) for x in out["bbox"]["max"]) < 2.0
    assert out["bbox_all"]["max"][0] == 50.0


@pytest.mark.parametrize("forward,up", [(-1.0, 1.0), (1.0, -1.0)])
def test_depth_mesh_camera_recovered(forward, up):
    """glTF (-Z forward, +Y up) and OpenCV (+Z forward, +Y down) camera frames both give the photo's FOV."""
    v = depth_mesh(60.0, 16 / 9, forward, up)
    out = INS.inspect_bytes(make_glb(v), "set.glb", aspect=16 / 9)
    assert abs(out["fov_deg"]["h"] - 60.0) < 1.0
    assert abs(out["fov_deg"]["v"] - 2 * math.degrees(math.atan(math.tan(math.radians(30)) * 9 / 16))) < 1.0
    assert abs(out["focal_mm"] - 36 / (2 * math.tan(math.radians(30)))) < 0.6
    t = out["to_stage"]
    assert t["flip_xyz"][2] == forward and t["flip_xyz"][1] == up
    # The floor sat 1 unit under the camera: scaled so the camera is at eye height (1.6 m).
    assert abs(t["scale"] - 1.6) < 0.1
    st = (np.array(t["flip_xyz"]) * v[0]) * t["scale"] + np.array(t["offset"])
    assert st[2] > 0, "in stage space the set lies in front of the camera (+Z)"
    assert out["camera"]["target"][2] > 0


def test_route_rejects_path_traversal(tmp_path, monkeypatch):
    aiohttp = pytest.importorskip("aiohttp")
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    out_dir = tmp_path / "output"
    (out_dir / "soundstage").mkdir(parents=True)
    (out_dir / "soundstage" / "m.glb").write_bytes(make_glb(depth_mesh()))
    (tmp_path / "secret.glb").write_bytes(b"x")
    fake = type(sys)("folder_paths")
    fake.get_directory_by_type = lambda t: str(out_dir) if t == "output" else None
    monkeypatch.setitem(sys.modules, "folder_paths", fake)
    from soundstage.assets3d import routes as R

    async def run():
        rt = web.RouteTableDef()
        R.register(rt)
        app = web.Application()
        app.add_routes(rt)
        async with TestClient(TestServer(app)) as c:
            ok = await c.get("/soundstage/assets3d/inspect", params={"filename": "m.glb", "subfolder": "soundstage"})
            assert ok.status == 200 and "fov_deg" in await ok.json()
            bad = await c.get("/soundstage/assets3d/inspect", params={"filename": "secret.glb", "subfolder": ".."})
            assert bad.status == 404
            bad2 = await c.get("/soundstage/assets3d/inspect", params={"filename": "m.glb", "type": "nope"})
            assert bad2.status == 400

    import asyncio
    asyncio.run(run())
    assert aiohttp
