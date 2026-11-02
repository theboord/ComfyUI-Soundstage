"""Video → 3D set scan (soundstage/video2stage/backdrop.py): fusion, ghost culling, structure pieces, reveals, writers.

A synthetic room (floor, ceiling, three walls; stage metres) is rendered to exact depth + colour from a few cameras,
fed through the shared context, and the scan is checked against the true planes."""
from __future__ import annotations

import json
import math
import os
import struct

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from soundstage.video2stage import backdrop as B  # noqa: E402

W, H = 160, 96
K = np.array([[110.0, 0, W / 2], [0, 110.0, H / 2], [0, 0, 1]])
# planes: (normal n, offset d) with n.x + d = 0, and a base colour
PLANES = [((0, 1, 0), 0.0, (150, 110, 70)),     # floor y = 0
          ((0, -1, 0), 2.6, (235, 235, 230)),   # ceiling y = 2.6
          ((0, 0, -1), 6.0, (200, 205, 215)),   # back wall z = 6
          ((1, 0, 0), 3.0, (180, 200, 180)),    # left wall x = -3
          ((-1, 0, 0), 3.0, (210, 190, 170))]   # right wall x = 3


def pose(cx, cy, cz, yaw_deg=0.0):
    """World-from-camera 4x4 (OpenCV camera: x right, y down, z forward) looking along +Z turned yaw about +Y."""
    a = math.radians(yaw_deg)
    fwd = np.array([math.sin(a), 0.0, math.cos(a)])
    right = np.cross(fwd, [0.0, 1.0, 0.0])   # stage is right-handed, y up: screen-right is fwd x up
    down = np.array([0.0, -1.0, 0.0])
    P = np.eye(4)
    P[:3, 0], P[:3, 1], P[:3, 2] = right, down, fwd
    P[:3, 3] = [cx, cy, cz]
    return P


def render(P):
    u, v = np.meshgrid(np.arange(W) + 0.0, np.arange(H) + 0.0)
    dc = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
    dw = dc @ P[:3, :3].T
    C = P[:3, 3]
    best = np.full((H, W), np.inf)
    col = np.zeros((H, W, 3))
    for n, d, c in PLANES:
        n = np.array(n, float)
        den = dw @ n
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -(C @ n + d) / den
        ok = (t > 1e-3) & (t < best)
        best[ok] = t[ok]
        with np.errstate(invalid="ignore"):
            X = C + dw * np.where(np.isfinite(t), t, 0)[..., None]
        chk = ((np.floor(X[..., 0] * 2) + np.floor(X[..., 1] * 2) + np.floor(X[..., 2] * 2)) % 2)[..., None] * 25
        col[ok] = (np.array(c) - chk)[ok]
    return best.astype(np.float32), np.clip(col, 0, 255).astype(np.uint8)


def make_ctx(tmp_path, cams, masks=None, edit=None):
    ctx = {"samples": [], "depth": {}, "poses": {}, "K": {}, "all_frames": [], "masks": masks or {}, "tag": "t",
           "out": {"dir": str(tmp_path / "out"), "subfolder": "soundstage_v2s/t"}}
    for f, P in enumerate(cams):
        d, c = render(P)
        if edit:
            d = edit(f, d)
        fp = str(tmp_path / f"f_{f:02d}.png")
        cv2.imwrite(fp, c[..., ::-1])
        ctx["samples"].append(f)
        ctx["depth"][f] = d
        ctx["poses"][f] = P
        ctx["K"][f] = K
        ctx["all_frames"].append(fp)
    return ctx


CAMS = [pose(0, 1.5, 0.5, 0), pose(-1.0, 1.5, 0.8, 18), pose(1.0, 1.5, 0.8, -18), pose(0.3, 1.6, 1.4, 5)]


def plane_dist(p):
    return np.min(np.stack([np.abs(p @ np.array(n, float) + d) for n, d, _ in PLANES]), 0)


# ---------------------------------------------------------------------------------------------------- masks
def test_rle_roundtrip_and_compressed():
    rng = np.random.default_rng(1)
    m = rng.random((23, 31)) > 0.7
    m[:, :3] = True                     # first run non-zero
    r = B.rle_encode(m)
    assert r["size"] == [23, 31]
    assert np.array_equal(B.rle_decode(r), m)

    def to_string(cnts):   # pycocotools rleToString
        s = []
        for i, x in enumerate(cnts):
            if i > 2:
                x -= cnts[i - 2]
            more = True
            while more:
                c = x & 0x1F
                x >>= 5
                more = (x != -1) if (c & 0x10) else (x != 0)
                if more:
                    c |= 0x20
                s.append(chr(c + 48))
        return "".join(s)
    rc = {"size": r["size"], "counts": to_string(r["counts"])}
    assert np.array_equal(B.rle_decode(rc), m)
    assert B.rle_decode(None) is None
    assert np.array_equal(B.rle_decode(m.astype(np.uint8)), m)


def test_moving_mask_unions_people_and_objects_and_grows():
    a = np.zeros((10, 12), bool); a[2:4, 2:4] = True
    b = np.zeros((10, 12), bool); b[7, 9] = True
    ctx = {"masks": {"people": {"p1": {3: B.rle_encode(a)}}, "objects": {"o1": {"3": B.rle_encode(b)}}}}
    m = B.moving_mask(ctx, 3, (10, 12), grow_px=1)
    assert m[2, 2] and m[7, 9] and m[1, 1] and m[8, 10]
    assert not m[0, 11]
    assert not B.moving_mask(ctx, 4, (10, 12)).any()
    # masks at another resolution are resized
    big = B.moving_mask(ctx, 3, (20, 24), grow_px=0)
    assert big[5, 5] and big.sum() > a.sum()


# ---------------------------------------------------------------------------------------------------- geometry
def test_edge_mask_keeps_grazing_floors_and_cuts_steps():
    d, _ = render(CAMS[0])
    e = B.edge_mask(d)
    lower = e[int(H * 0.75):, 5:-5]          # floor, seen at a grazing angle: not an edge
    assert lower.mean() < 0.02
    step = np.full((40, 40), 5.0, np.float32)
    step[:, 20:] = 2.0
    es = B.edge_mask(step)
    assert es[:, 19:21].all() and not es[:, :17].any()


def test_fuse_puts_points_on_the_true_surfaces(tmp_path):
    ctx = make_ctx(tmp_path, CAMS)
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    assert len(F["per_sample"]) == 4
    assert len(F["pos"]) > 2000
    dist = plane_dist(F["pos"])
    assert np.median(dist) < 0.01 and np.percentile(dist, 95) < 0.05
    assert F["support"].max() >= 3            # the same voxel seen from several cameras merges
    # colours come from the plate (floor brown, walls light)
    fl = F["pos"][:, 1] < 0.05
    assert F["rgb"][fl].mean(0)[2] < F["rgb"][~fl].mean(0)[2]


def test_masks_and_sky_are_left_out(tmp_path):
    m = np.zeros((H, W), bool)
    m[30:70, 60:100] = True
    ctx = make_ctx(tmp_path, CAMS[:1], masks={"people": {"p": {0: B.rle_encode(m)}}})
    ctx["sky"] = {0: np.zeros((H, W), np.float32)}
    ctx["sky"][0][:8] = 1.0
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    Pinv = np.linalg.inv(CAMS[0])
    pc = F["pos"] @ Pinv[:3, :3].T + Pinv[:3, 3]
    u = K[0, 0] * pc[:, 0] / pc[:, 2] + K[0, 2]
    v = K[1, 1] * pc[:, 1] / pc[:, 2] + K[1, 2]
    inside = (u > 63.5) & (u < 96.5) & (v > 33.5) & (v < 66.5)
    assert inside.sum() == 0
    assert (v < 7.5).sum() == 0


def test_floating_shards_are_culled(tmp_path):
    def shard(f, d):
        if f == 0:
            d = d.copy()
            d[40:56, 70:90] *= 0.45            # something seen once, floating in front of the back wall
        return d
    ctx = make_ctx(tmp_path, CAMS, edit=shard)
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    keep = B.cull_ghosts(F, np.eye(3), np.zeros(3))
    off = plane_dist(F["pos"]) > 0.3
    assert off.sum() > 20
    assert keep[off].mean() < 0.1               # the shard goes
    assert keep[~off].mean() > 0.85             # the room stays


def test_structure_labels_floor_walls_ceiling_interior(tmp_path):
    ctx = make_ctx(tmp_path, CAMS)
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    lab, interior, planes, fy = B.label_structure(F["pos"], F["normal"], F["centres"])
    assert interior
    assert abs(fy) < 0.03
    fl = lab == 1
    assert fl.sum() > 200 and np.abs(F["pos"][fl, 1]).max() < 0.15
    assert (lab == 2).sum() > 100
    walls = [p for p in planes]
    assert len(walls) >= 2
    back = [p for p in walls if abs(abs(p["normal"][2]) - 1) < 0.05]
    assert back and abs(abs(back[0]["d"]) - 6.0) < 0.1
    names = B.piece_names(lab, interior)
    assert names[1] == "Set scan floor" and names[0] == "Set scan (from clip)"
    assert any(n.startswith("Set scan wall") for n in names.values())
    assert B.piece_names(lab, False)[1] == "Set scan ground"


def test_mesh_fills_reveals_without_duplicating(tmp_path):
    ctx = make_ctx(tmp_path, [CAMS[0], pose(0, 1.5, 0.5, 40)])   # the second view turns to reveal the right wall
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    keep = B.cull_ghosts(F, np.eye(3), np.zeros(3))
    V, C, Fc, _ = B.mesh_from_samples(F, np.eye(3), np.zeros(3), F["keys"][keep])
    assert len(Fc) > 500 and Fc.max() < len(V)
    assert np.median(plane_dist(V)) < 0.02
    right = V[:, 0] > 2.9
    assert right.sum() > 50                     # revealed after sample 0
    one, _, f1, _ = B.mesh_from_samples({**F, "per_sample": F["per_sample"][:1]}, np.eye(3), np.zeros(3), F["keys"][keep])
    assert len(Fc) < 1.9 * len(f1)              # the overlap is not triangulated twice


def test_mesh_respects_the_triangle_budget(tmp_path):
    ctx = make_ctx(tmp_path, CAMS)
    F = B.fuse(ctx, np.eye(3), np.zeros(3))
    _, _, Fc, _ = B.mesh_from_samples(F, np.eye(3), np.zeros(3), F["keys"], max_tris=1500)
    assert 0 < len(Fc) <= 1500


# ---------------------------------------------------------------------------------------------------- writers
def _read_glb(path):
    b = open(path, "rb").read()
    magic, ver, total = struct.unpack("<III", b[:12])
    assert magic == 0x46546C67 and ver == 2 and total == len(b)
    jl, jt = struct.unpack("<II", b[12:20])
    assert jt == 0x4E4F534A
    gl = json.loads(b[20:20 + jl])
    bl, bt = struct.unpack("<II", b[20 + jl:28 + jl])
    assert bt == 0x004E4942 and bl == gl["buffers"][0]["byteLength"]
    return gl, b[28 + jl:28 + jl + bl]


def test_glb_and_splat_ply_are_valid(tmp_path):
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], float)
    Fc = np.array([[0, 1, 2], [1, 3, 2]])
    C = np.array([[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]], np.uint8)
    p = str(tmp_path / "m.glb")
    B.write_glb(p, V, C, Fc)
    gl, binary = _read_glb(p)
    acc = gl["accessors"]
    assert acc[0]["count"] == 4 and acc[0]["max"] == [1, 1, 0] and acc[2]["count"] == 6
    pos = np.frombuffer(binary, np.float32, 12, gl["bufferViews"][0]["byteOffset"]).reshape(4, 3)
    assert np.allclose(pos, V)
    idx = np.frombuffer(binary, np.uint32, 6, gl["bufferViews"][2]["byteOffset"])
    assert idx.tolist() == [0, 1, 2, 1, 3, 2]
    B.write_glb(str(tmp_path / "e.glb"), np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), int))
    _read_glb(str(tmp_path / "e.glb"))
    s = str(tmp_path / "s.ply")
    B.write_splat_ply(s, V, C, np.array([1.0, 0.5, 0.0, -1.0]), np.full(4, 0.02), np.tile([0, 1.0, 0], (4, 1)))
    raw = open(s, "rb").read()
    head, body = raw.split(b"end_header\n")
    assert b"element vertex 4" in head and b"property float f_dc_0" in head and b"property float rot_3" in head
    a = np.frombuffer(body, np.float32).reshape(4, 17)
    rgb = (a[:, 6:9] * B.SPLAT_C0 + 0.5) * 255
    assert np.allclose(rgb, C, atol=0.6)
    op = 1 / (1 + np.exp(-a[:, 9]))
    assert op[0] > op[1] > op[2] >= op[3]
    assert np.allclose(np.exp(a[:, 10]), 0.02, rtol=1e-4)
    q = a[:, 13:17]
    assert np.allclose(np.linalg.norm(q, axis=1), 1, atol=1e-5)


# ---------------------------------------------------------------------------------------------------- build
def test_build_adds_named_scan_actors_and_drops_the_old_relief(tmp_path):
    ctx = make_ctx(tmp_path, CAMS)
    ctx["sky"] = None
    scene = {"actors": [{"id": "v2s_backdrop", "name": "Source frame (DA3 depth)", "kind": "glb"},
                        {"id": "sofa_1", "name": "Sofa", "kind": "sofa"}],
             "video2stage": {"xform": {"A": np.eye(3).tolist(), "b": [0, 0, 0]}}}
    r = B.build(scene, ctx)
    ids = [a["id"] for a in scene["actors"]]
    assert "v2s_backdrop" not in ids and "sofa_1" in ids
    names = [a["name"] for a in r["actors"]]
    assert "Set scan points" in names and "Set scan floor" in names
    assert not any("DA3" in n or "custom" in n.lower() for n in names)
    for a in r["actors"]:
        assert a["kind"] == "glb" and a["look_at"] is False and a["scan"] is True and a["set_xform"]["scale"] == 1.0
        fn = a["url"].split("filename=")[1].split("&")[0]
        assert os.path.exists(os.path.join(ctx["out"]["dir"], fn))
        assert "subfolder=soundstage_v2s/t" in a["url"]
    pts = next(a for a in r["actors"] if a["name"] == "Set scan points")
    assert pts["format"] == "ply" and pts["splat_up"] == "y" and pts["proxy_url"]
    st = r["stats"]
    assert st["interior"] and st["ghost_share"] < 0.2 and st["mesh_tris"] > 0
    assert scene["video2stage"]["backdrop"]["pieces"] == names
    # the splat's anchor splats make Spark's centring a no-op: bbox (centres) symmetric in x/z, floor at y = 0
    fn = pts["url"].split("filename=")[1].split("&")[0]
    raw = open(os.path.join(ctx["out"]["dir"], fn), "rb").read().split(b"end_header\n")[1]
    a = np.frombuffer(raw, np.float32).reshape(-1, 17)
    lo, hi = a[:, :3].min(0), a[:, :3].max(0)
    assert abs(lo[0] + hi[0]) < 1e-4 and abs(lo[2] + hi[2]) < 1e-4 and abs(lo[1]) < 1e-6 and hi[1] < 60
    # rebuilding replaces the scan instead of stacking a second one
    B.build(scene, ctx)
    assert sum(1 for x in scene["actors"] if x.get("scan")) == len(r["actors"])


def test_build_maps_world_to_stage_with_the_scene_xform(tmp_path):
    ctx = make_ctx(tmp_path, CAMS[:2])
    ang = math.radians(30)
    A = 2.0 * np.array([[math.cos(ang), 0, math.sin(ang)], [0, 1, 0], [-math.sin(ang), 0, math.cos(ang)]])
    b = np.array([1.0, 0.0, -2.0])
    F = B.fuse(ctx, A, b)
    back = (F["pos"] - b) @ np.linalg.inv(A).T
    assert np.median(plane_dist(back)) < 0.01


def test_too_little_depth_degrades_with_a_note(tmp_path):
    ctx = make_ctx(tmp_path, CAMS[:1], edit=lambda f, d: np.zeros_like(d))
    scene = {"actors": []}
    r = B.build(scene, ctx)
    assert r["actors"] == [] and any("not enough clean depth" in n for n in r["notes"])


def test_sky_colours_from_the_plate(tmp_path):
    ctx = make_ctx(tmp_path, CAMS[:1])
    img = np.zeros((H, W, 3), np.uint8)
    img[:30] = (40, 90, 200)       # top: deep blue (RGB)
    img[30:40] = (180, 200, 230)   # horizon: pale
    cv2.imwrite(ctx["all_frames"][0], img[..., ::-1])
    sky = np.zeros((H, W), np.float32)
    sky[:40] = 1
    ctx["sky"] = {0: sky}
    c = B.sky_colours(ctx)
    assert c["top"] == "#285ac8" and c["horizon"] == "#b4c8e6"


def test_ctx_from_legacy_inverts_camera_from_world():
    P = CAMS[1]
    Pinv = np.linalg.inv(P)
    ctx = B.ctx_from_legacy(depths=[np.ones((4, 4))], poses_cw=[Pinv[:3]], K=[K], sample_frames=[7],
                            frame_files=["x.png"])
    assert np.allclose(ctx["poses"][7], P)
    assert ctx["samples"] == [7] and ctx["all_frames"][7] == "x.png"
