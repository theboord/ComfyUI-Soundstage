"""Read just enough of a GLB or PLY to place it on the stage: vertex/splat count, bounds, and for a depth mesh
made from one photo (Depth Anything 3), the camera that took the photo.

numpy only (ComfyUI always has it). No trimesh/pygltflib.
"""
from __future__ import annotations

import json
import math
import struct

import numpy as np

SENSOR_W_MM = 36.0
_GL_TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_PLY_TYPES = {"char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1", "short": "i2", "ushort": "u2", "int16": "i2",
              "uint16": "u2", "int": "i4", "uint": "u4", "int32": "i4", "uint32": "u4", "float": "f4", "float32": "f4",
              "double": "f8", "float64": "f8"}


def _accessor(gl: dict, binary: bytes, idx: int) -> np.ndarray:
    acc = gl["accessors"][idx]
    bv = gl["bufferViews"][acc["bufferView"]]
    dt = np.dtype(_GL_TYPES[acc["componentType"]])
    n = _NCOMP[acc["type"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * n
    count = acc["count"]
    if stride == dt.itemsize * n:
        return np.frombuffer(binary, dtype=dt, count=count * n, offset=off).reshape(count, n).astype(np.float64)
    raw = np.frombuffer(binary, dtype=np.uint8, count=stride * (count - 1) + dt.itemsize * n, offset=off)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(count, dt.itemsize * n), strides=(stride, 1))
    return np.ascontiguousarray(rows).view(dt).reshape(count, n).astype(np.float64)


def _node_matrices(gl: dict) -> dict[int, np.ndarray]:
    """World matrix per mesh index (first node that uses it)."""
    def local(node):
        if "matrix" in node:
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
        m = np.eye(4)
        if "scale" in node:
            m = np.diag([*node["scale"], 1.0]) @ m
        if "rotation" in node:
            x, y, z, w = node["rotation"]
            r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
            rm = np.eye(4)
            rm[:3, :3] = r
            m = rm @ m
        if "translation" in node:
            t = np.eye(4)
            t[:3, 3] = node["translation"]
            m = t @ m
        return m

    out: dict[int, np.ndarray] = {}
    nodes = gl.get("nodes", [])

    def walk(i, parent):
        m = parent @ local(nodes[i])
        if "mesh" in nodes[i] and nodes[i]["mesh"] not in out:
            out[nodes[i]["mesh"]] = m
        for c in nodes[i].get("children", []):
            walk(c, m)

    scenes = gl.get("scenes") or [{"nodes": list(range(len(nodes)))}]
    for root in scenes[gl.get("scene", 0)].get("nodes", []):
        walk(root, np.eye(4))
    return out


def glb_positions(data: bytes) -> np.ndarray:
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    pos, gl, binary = 12, None, b""
    while pos < len(data):
        clen, ctype = struct.unpack_from("<II", data, pos)
        chunk = data[pos + 8:pos + 8 + clen]
        if ctype == 0x4E4F534A:
            gl = json.loads(chunk)
        elif ctype == 0x004E4942:
            binary = chunk
        pos += 8 + clen
    if gl is None:
        raise ValueError("GLB has no JSON chunk")
    mats = _node_matrices(gl)
    parts = []
    for mi, mesh in enumerate(gl.get("meshes", [])):
        for prim in mesh.get("primitives", []):
            if "POSITION" not in prim.get("attributes", {}):
                continue
            v = _accessor(gl, binary, prim["attributes"]["POSITION"])
            m = mats.get(mi, np.eye(4))
            parts.append(v @ m[:3, :3].T + m[:3, 3])
    return np.concatenate(parts) if parts else np.zeros((0, 3))


def ply_positions(data: bytes) -> np.ndarray:
    end = data.find(b"end_header")
    if not data.startswith(b"ply") or end < 0:
        raise ValueError("not a PLY file")
    header = data[:end].decode("ascii", "replace").splitlines()
    body = data[data.index(b"\n", end) + 1:]
    fmt = next((ln.split()[1] for ln in header if ln.startswith("format")), "ascii")
    count, props, in_vertex = 0, [], False
    for ln in header:
        t = ln.split()
        if t[:1] == ["element"]:
            in_vertex = t[1] == "vertex"
            if in_vertex:
                count = int(t[2])
        elif t[:1] == ["property"] and in_vertex and t[1] != "list":
            props.append((t[2], _PLY_TYPES[t[1]]))
    if fmt == "ascii":
        rows = np.loadtxt(body.decode().splitlines()[:count], ndmin=2)
        names = [p[0] for p in props]
        return rows[:, [names.index("x"), names.index("y"), names.index("z")]]
    endian = "<" if fmt == "binary_little_endian" else ">"
    dt = np.dtype([(n, endian + t) for n, t in props])
    arr = np.frombuffer(body, dtype=dt, count=count)
    return np.stack([arr["x"], arr["y"], arr["z"]], axis=1).astype(np.float64)


def bbox(v: np.ndarray, robust: bool = False) -> dict | None:
    if not len(v):
        return None
    if robust:  # splats carry far-flung floaters: bounds of the bulk, not of every gaussian
        lo, hi = np.percentile(v, 0.5, axis=0), np.percentile(v, 99.5, axis=0)
    else:
        lo, hi = v.min(axis=0), v.max(axis=0)
    r = lambda a: [round(float(x), 4) for x in a]  # noqa: E731
    return {"min": r(lo), "max": r(hi), "size": r(hi - lo), "center": r((lo + hi) / 2)}


def depth_camera(v: np.ndarray, aspect: float | None = None, eye_height_m: float = 1.6) -> dict | None:
    """The camera of a single-photo depth mesh. The mesh sits in that camera's frame (the camera at the origin),
    so the angular spread of the vertices IS the field of view. Works for either forward sign (-Z glTF or +Z
    OpenCV) and either up sign; reports the transform that puts the mesh in stage coordinates (Y up, the camera
    looking +Z, the floor under the camera at y=0 if one is visible)."""
    if len(v) < 100:
        return None
    zf = -1.0 if np.median(v[:, 2]) < 0 else 1.0           # which way is "forward"
    z = v[:, 2] * zf
    ok = z > 1e-6
    if ok.mean() < 0.9:
        return None  # not a camera-space depth mesh
    x, y, z = v[ok, 0], v[ok, 1], z[ok]
    ax, ay = np.arctan2(x, z), np.arctan2(y, z)
    h = math.degrees(float(np.percentile(ax, 99.9) - np.percentile(ax, 0.1)))
    vv = math.degrees(float(np.percentile(ay, 99.9) - np.percentile(ay, 0.1)))
    if aspect:  # the photo's aspect is exact; trust the wider-measured axis and derive the other
        if h / max(vv, 1e-6) < aspect:
            h = math.degrees(2 * math.atan(math.tan(math.radians(vv) / 2) * aspect))
        else:
            vv = math.degrees(2 * math.atan(math.tan(math.radians(h) / 2) / aspect))
    focal = SENSOR_W_MM / (2 * math.tan(math.radians(h) / 2))
    # Up axis sign: in glTF (-Z forward) +Y is up; in OpenCV (+Z forward) +Y is down.
    up = 1.0 if zf < 0 else -1.0
    ys = y * up
    floor = float(np.percentile(ys, 2))                   # lowest surfaces ~ the floor (relative units)
    cam_h = max(-floor, 1e-3)
    scale = eye_height_m / cam_h                           # mono depth is relative: assume an eye-height camera
    depth = float(np.median(z))
    # Stage frame: looking +Z, +X is screen-LEFT, Y up. Source frame: x right on screen.
    flip = [-1.0, up, zf]
    return {
        "fov_deg": {"h": round(h, 2), "v": round(vv, 2)},
        "focal_mm": round(focal, 2), "sensor_w_mm": SENSOR_W_MM,
        "to_stage": {"flip_xyz": flip, "scale": round(scale, 5), "offset": [0.0, round(eye_height_m, 3), 0.0],
                     "note": "stage = flip * v * scale + offset; mono depth is relative, scale assumes the camera "
                             f"stood {eye_height_m} m above the lowest visible surface"},
        "camera": {"position": [0.0, round(eye_height_m, 3), 0.0], "target": [0.0, round(eye_height_m, 3),
                   round(depth * scale, 3)], "focal_mm": round(focal, 2)},
    }


def inspect_bytes(data: bytes, name: str = "", aspect: float | None = None) -> dict:
    low = name.lower()
    if data[:4] == b"glTF" or low.endswith(".glb"):
        v = glb_positions(data)
        out = {"format": "glb", "count": int(len(v)), "bbox": bbox(v)}
        cam = depth_camera(v, aspect)
        if cam:
            out.update(cam)
        return out
    if data[:3] == b"ply" or low.endswith(".ply"):
        v = ply_positions(data)
        return {"format": "ply", "count": int(len(v)), "bbox": bbox(v, robust=True), "bbox_all": bbox(v)}
    return {"format": low.rsplit(".", 1)[-1] if "." in low else "unknown", "size_bytes": len(data)}
