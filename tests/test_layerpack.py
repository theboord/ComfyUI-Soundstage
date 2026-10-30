"""Layer Pack exporter tests: build a tiny synthetic pack (2 layers x 5 frames + depth + a moving
stage camera), export it, and check every file is written and parses.

Run:  python -m pytest tests/test_layerpack.py -q
Optional readers (used when importable, skipped otherwise): OpenEXR, psd_tools, opentimelineio,
ffprobe, node (syntax-checks the AE script) and Blender (runs the Blender builder headless).
"""
import ast
import json
import math
import os
import re
import shutil
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.layerpack import AOV, Layer, LayerPack, export_pack  # noqa: E402
from soundstage.layerpack import camera as cammath  # noqa: E402
from soundstage.layerpack.exr import write_exr  # noqa: E402

W, H, N = 96, 48, 5
NEAR, FAR = 1.0, 40.0
SCENE = {
    "version": 2,
    "shot": {"frames": N, "fps": 24},
    "camera": {"position": [-7.0, 1.7, -14.0], "target": [0, 1.3, -4.0], "focal_mm": 35},
    "camera_end": {"position": [-3.0, 1.7, -2.0], "target": [0, 1.3, 11.5], "focal_mm": 50},
    "actors": [{"id": "actor_a", "name": "John Doe"}],
}
BLENDER = shutil.which("blender") or ("/Applications/Blender.app/Contents/MacOS/Blender"
                                      if os.path.exists("/Applications/Blender.app/Contents/MacOS/Blender") else None)


def _square(i):
    m = np.zeros((H, W), np.float32)
    x = 10 + i * 8
    m[12:36, x:x + 20] = 1.0
    return m


def synthetic_pack(camera=SCENE):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    bg = np.stack([np.stack([xx / W, yy / H, np.full_like(xx, 0.5)], -1)] * N)           # [N,H,W,3]
    fg = np.zeros((N, H, W, 3), np.float32)
    fg[..., 0] = 0.9
    masks = np.stack([_square(i) for i in range(N)])                                        # [N,H,W]
    depth_m = np.where(masks > 0.5, 6.0, 25.0).astype(np.float32)
    depth_img = (1.0 - (depth_m - NEAR) / (FAR - NEAR))[..., None].repeat(3, -1)             # stage encoding
    pack = LayerPack(shot="SH010", fps=24.0, frame_start=1001, camera=json.dumps(camera), notes="Push in on John")
    pack = pack.add_layer(Layer(name="BG plate", images=bg, z=0, kind="background", source_id="stage"))
    pack = pack.add_layer(Layer(name="John Doe", images=fg, mask=masks, z=10, kind="character",
                                source_id="actor_a"))
    return pack.add_aov(AOV(kind="depth", images=depth_img, units="metres", near=NEAR, far=FAR,
                            encoding="stage (near=white, linear near..far)"))


@pytest.fixture(scope="module")
def exported(tmp_path_factory):
    out = tmp_path_factory.mktemp("packs")
    res = export_pack(synthetic_pack(), str(out), timestamp="test", multilayer_exr=True)
    return res["root"], res["manifest"], res


def p(root, rel):
    return os.path.join(root, rel)


# ------------------------------------------------------------------ pack model

def test_pack_is_immutable_and_dedupes_names():
    a = LayerPack()
    b = a.add_layer(Layer(name="x", images=np.zeros((1, 4, 4, 3))))
    c = b.add_layer(Layer(name="x", images=np.zeros((1, 4, 4, 3))))
    assert a.layers == () and len(b.layers) == 1
    assert [l.name for l in c.layers] == ["x", "x_2"]


# ------------------------------------------------------------------ manifest + PNGs

def test_manifest(exported):
    root, m, _ = exported
    with open(p(root, "manifest.json")) as f:
        disk = json.load(f)
    assert disk["shot"]["frame_start"] == 1001 and disk["shot"]["frame_end"] == 1001 + N - 1
    assert disk["shot"]["resolution"] == [W, H] and disk["shot"]["fps"] == 24.0
    assert disk["alpha"]["png"] == "straight" and disk["alpha"]["exr"] == "premultiplied"
    assert [l["name"] for l in disk["layers"]] == ["BG plate", "John Doe"]          # bottom first
    assert [l["z"] for l in disk["layers"]] == [0, 10]
    assert disk["camera"]["source"] == "staged"
    bad = {k: v for k, v in disk["exports"].items() if v != "ok"}
    if not shutil.which("ffmpeg"):
        bad.pop("prores4444", None), bad.pop("comp_preview", None)
    assert not bad, bad
    for rel in disk["files"].values():
        if rel and "####" not in rel:
            assert os.path.exists(p(root, rel)), rel
    assert os.path.exists(p(root, "README.txt"))


def test_png_sequences_straight_alpha_and_mattes(exported):
    root, m, _ = exported
    john = next(l for l in m["layers"] if l["name"] == "John Doe")
    bg = next(l for l in m["layers"] if l["name"] == "BG plate")
    for i in range(N):
        fr = 1001 + i
        im = np.asarray(Image.open(p(root, john["files"]["png"].replace("####", f"{fr:04d}"))))
        assert im.shape == (H, W, 4)
        expect = _square(i)
        assert (im[..., 3] == np.where(expect > 0.5, 255, 0)).all()
        assert im[20, 10 + i * 8 + 5, 0] == round(0.9 * 255)                  # straight, not premultiplied
        mt = Image.open(p(root, john["files"]["matte"].replace("####", f"{fr:04d}")))
        assert mt.mode.startswith("I")                                         # 16-bit grey
        assert np.asarray(mt).max() == 65535
        b = np.asarray(Image.open(p(root, bg["files"]["png"].replace("####", f"{fr:04d}"))))
        assert (b[..., 3] == 255).all()
    assert len(os.listdir(os.path.dirname(p(root, john["files"]["png"])))) == N


def test_card_depth_from_depth_aov(exported):
    _, m, _ = exported
    john = next(l for l in m["layers"] if l["name"] == "John Doe")
    bg = next(l for l in m["layers"] if l["name"] == "BG plate")
    assert abs(john["depth_m"] - 6.0) < 0.1 and abs(bg["depth_m"] - 25.0) < 0.1


# ------------------------------------------------------------------ ProRes

@pytest.mark.skipif(not shutil.which("ffprobe"), reason="ffprobe not installed")
def test_prores_4444_with_alpha(exported):
    root, m, _ = exported
    for layer in m["layers"]:
        mov = p(root, layer["files"]["mov"])
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=codec_name,profile,pix_fmt,width,height,nb_read_frames:stream_tags=timecode",
                              "-of", "json", mov], capture_output=True, text=True, check=True).stdout
        s = json.loads(out)["streams"][0]
        assert s["codec_name"] == "prores" and "4444" in s["profile"]
        assert s["pix_fmt"].startswith("yuva444p")
        assert (s["width"], s["height"]) == (W, H) and int(s["nb_read_frames"]) == N
        assert s["tags"]["timecode"] == "00:00:41:17"                          # frame 1001 at 24 fps


# ------------------------------------------------------------------ PSD

def test_psd_hero_frame(exported):
    root, m, _ = exported
    path = p(root, m["files"]["psd"])
    with open(path, "rb") as f:
        assert f.read(4) == b"8BPS"
    psd_tools = pytest.importorskip("psd_tools")
    psd = psd_tools.PSDImage.open(path)
    assert psd.size == (W, H)
    assert [l.name for l in psd] == ["BG plate", "John Doe"]
    john = np.asarray(psd[1].topil())
    hero = m["shot"]["hero_frame"] - 1001
    assert (john[..., 3] == np.where(_square(hero) > 0.5, 255, 0)).all()


# ------------------------------------------------------------------ EXR

def test_depth_exr_metres(exported):
    root, m, _ = exported
    OpenEXR = pytest.importorskip("OpenEXR")
    for i in range(N):
        f = OpenEXR.File(p(root, f"aovs/depth/depth.{1001 + i:04d}.exr"))
        z = f.channels()["Z"].pixels
        assert z.dtype == np.float32 and z.shape == (H, W)
        assert np.allclose(z, np.where(_square(i) > 0.5, 6.0, 25.0), atol=0.1)


def test_multilayer_exr(exported):
    root, m, _ = exported
    OpenEXR = pytest.importorskip("OpenEXR")
    f = OpenEXR.File(p(root, "multilayer/SH010.1001.exr"), separate_channels=True)
    names = set(f.channels())
    assert {"R", "G", "B", "A", "depth.Z", "John_Doe.R", "John_Doe.A", "BG_plate.R"} <= names
    a = f.channels()["John_Doe.A"].pixels.astype(np.float32)
    assert np.allclose(a, _square(0), atol=1e-3)


def test_exr_writer_roundtrip(tmp_path):
    OpenEXR = pytest.importorskip("OpenEXR")
    rng = np.random.default_rng(1)
    r = rng.random((33, 47), dtype=np.float32)
    z = np.zeros((33, 47), np.float32)                     # compressible -> exercises the ZIP path
    write_exr(str(tmp_path / "a.exr"), {"R": r, "Z": z, "x.Z": z + 3.5}, fps=23.976)
    ch = OpenEXR.File(str(tmp_path / "a.exr"), separate_channels=True).channels()
    assert np.allclose(ch["R"].pixels.astype(np.float32), r, atol=1e-3)
    assert (ch["x.Z"].pixels == 3.5).all() and ch["Z"].pixels.dtype == np.float32


# ------------------------------------------------------------------ camera maths + files

def test_camera_parsing_variants():
    frames, _ = cammath.parse_camera(SCENE, N)
    assert len(frames) == N
    assert frames[0]["position"] == SCENE["camera"]["position"]
    assert frames[-1]["position"] == SCENE["camera_end"]["position"]
    assert frames[-1]["focal_mm"] == 50
    lst = [{"position": [0, 1, 5], "target": [0, 1, 0], "focal_mm": 35}] * 3
    assert len(cammath.parse_camera({"frames": lst}, 5)[0]) == 5                  # held on the last pose
    assert len(cammath.parse_camera(lst, 2)[0]) == 2                              # trimmed
    assert len(cammath.parse_camera(lst[0], 4)[0]) == 4                           # locked-off
    assert cammath.parse_camera("", 4)[0] == []
    full = {"scene": SCENE, "passes": {}}                                         # whole stage payload
    assert cammath.parse_camera(full, N)[0][0]["focal_mm"] == 35


def _project(c2w, fx, pt):
    w2c = np.linalg.inv(np.asarray(c2w))
    x, y, z = (w2c @ np.r_[pt, 1.0])[:3]
    return W / 2 + fx * x / -z, H / 2 - fx * y / -z


def test_camera_json_chan_and_maths(exported):
    root, m, _ = exported
    with open(p(root, "camera/camera.json")) as f:
        cam = json.load(f)
    assert len(cam["frames"]) == N and cam["frame_start"] == 1001 and cam["sensor_width_mm"] == 36.0
    for c in cam["frames"]:
        assert math.isclose(c["fx_px"], c["focal_mm"] * W / 36.0, rel_tol=1e-6)
        R = np.asarray(c["cam_to_world"])[:3, :3]
        assert np.allclose(cammath.rot_zxy(*c["rotate_zxy_deg"]), R, atol=1e-5)  # Nuke ZXY round trip
        u, v = _project(c["cam_to_world"], c["fx_px"], np.asarray(c["target"]))
        assert abs(u - W / 2) < 1e-6 and abs(v - H / 2) < 1e-6                    # target at frame centre
        hfov = math.degrees(2 * math.atan(W / (2 * c["fx_px"])))
        assert math.isclose(hfov, c["hfov_deg"], rel_tol=1e-5)
    rows = [l.split("\t") for l in open(p(root, "camera/camera.chan")).read().strip().splitlines()]
    assert len(rows) == N and all(len(r) == 8 for r in rows)
    assert [int(r[0]) for r in rows] == list(range(1001, 1001 + N))
    assert float(rows[0][1]) == SCENE["camera"]["position"][0]


def test_cards_fill_frame_one(exported):
    """A card at depth d, width d*W/fx, centred on the frame-1 axis must project onto the frame edges."""
    from soundstage.layerpack.dcc import _card_pose
    root, m, _ = exported
    with open(p(root, "camera/camera.json")) as f:
        c0 = json.load(f)["frames"][0]
    ctx = {"camera": [c0], "width": W}
    c2w = np.asarray(c0["cam_to_world"])
    for d in (2.0, 6.0, 25.0):
        pos, width = _card_pose(ctx, d)
        right, up = c2w[:3, 0], c2w[:3, 1]
        corner = np.asarray(pos) + right * width / 2 + up * width * H / W / 2
        u, v = _project(c0["cam_to_world"], c0["fx_px"], corner)
        assert abs(u - W) < 1e-6 and abs(v) < 1e-6


# ------------------------------------------------------------------ app builders

def _embedded_json(text, marker_re):
    return json.loads(re.search(marker_re, text, re.S).group(1))


def test_after_effects_jsx(exported, tmp_path):
    root, m, _ = exported
    text = open(p(root, "dcc/ae/build_comp.jsx")).read()
    pack = _embedded_json(text, r"var PACK = (\{.*?\});\n")
    assert pack["frames"] == N and pack["frame_start"] == 1001 and len(pack["layers"]) == 2
    with open(p(root, "camera/camera.json")) as f:
        cams = json.load(f)["frames"]
    assert pack["camera"]["zoom"] == [round(c["fx_px"], 4) for c in cams]          # AE zoom = fx (px)
    assert len(pack["camera"]["times"]) == N and pack["camera"]["times"][1] == round(1 / 24, 6)
    for lay in pack["layers"]:
        assert os.path.exists(p(root, lay["png_first"]))
    # Card scale: s*d/zoom*100 %
    john = next(l for l in m["layers"] if l["name"] == "John Doe")
    assert math.isclose(pack["cards"][1]["scale"], 100 * john["depth_m"] / cams[0]["fx_px"] * 100, rel_tol=1e-4)
    node = shutil.which("node")
    if node:
        js = tmp_path / "build_comp.js"                     # node refuses the .jsx extension
        js.write_text(text)
        subprocess.run([node, "--check", str(js)], check=True)


def test_blender_and_nuke_scripts_parse(exported):
    root, m, _ = exported
    for rel, marker in (("dcc/blender/build_blender_scene.py", r'PACK = json\.loads\(r"""(.*?)"""\)'),
                        ("dcc/nuke/build_nuke.py", r'PACK = json\.loads\(r"""(.*?)"""\)')):
        text = open(p(root, rel)).read()
        ast.parse(text)
        pack = _embedded_json(text, marker)
        assert pack["frames"] == N and len(pack["layers"]) == 2 and len(pack["camera"]) == N


@pytest.mark.skipif(not BLENDER, reason="Blender not installed")
def test_blender_builder_renders_frame_one(exported, tmp_path):
    """Build the scene in headless Blender, render frame 1001 and compare it with the pack's comp:
    proves the camera conversion, the card size/placement maths and the image-sequence offset."""
    root, m, _ = exported
    check, report, render = tmp_path / "check.py", tmp_path / "report.json", tmp_path / "f1001.png"
    check.write_text(f"""
import bpy, json
s = bpy.context.scene
cards = [o for o in bpy.data.collections['Soundstage_SH010'].objects if o.type == 'MESH']
s.render.engine = 'CYCLES'
s.cycles.samples = 8
s.cycles.device = 'CPU'
s.render.film_transparent = True
s.view_settings.view_transform = 'Standard'
s.render.filepath = {str(render)!r}
s.frame_set(1001)
bpy.ops.render.render(write_still=True)
json.dump({{"frame_start": s.frame_start, "frame_end": s.frame_end, "lens": s.camera.data.lens,
           "loc": list(s.camera.matrix_world.translation), "cards": sorted(o.name for o in cards),
           "res": [s.render.resolution_x, s.render.resolution_y]}}, open({str(report)!r}, "w"))
""")
    subprocess.run([BLENDER, "-b", "--factory-startup", "--python", p(root, "dcc/blender/build_blender_scene.py"),
                    "--python", str(check)], check=True, capture_output=True, timeout=600)
    r = json.loads(report.read_text())
    assert r["frame_start"] == 1001 and r["frame_end"] == 1001 + N - 1 and r["res"] == [W, H]
    assert abs(r["lens"] - 35.0) < 1e-4
    x, y, z = SCENE["camera"]["position"]
    assert np.allclose(r["loc"], [x, -z, y], atol=1e-4)                             # Y-up -> Z-up
    assert r["cards"] == ["BG plate", "John Doe"]
    got = np.asarray(Image.open(render).convert("RGB"), np.float32) / 255
    bg = np.asarray(Image.open(p(root, m["layers"][0]["files"]["png"].replace("####", "1001"))), np.float32)[..., :3] / 255
    sq = _square(0) > 0.5
    expect = np.where(sq[..., None], [0.9, 0, 0], bg)
    inner = np.zeros_like(sq)
    inner[2:-2, 2:-2] = True
    edge = sq ^ np.roll(sq, 2, 1) | sq ^ np.roll(sq, -2, 1) | sq ^ np.roll(sq, 2, 0) | sq ^ np.roll(sq, -2, 0)
    keep = inner & ~edge                                        # ignore pixel-filter blur at edges
    assert np.abs(got - expect)[keep].mean() < 0.04, np.abs(got - expect)[keep].mean()


def test_otio_timeline(exported):
    root, m, _ = exported
    path = p(root, m["files"]["otio"])
    with open(path) as f:
        t = json.load(f)
    tracks = t["tracks"]["children"]
    assert [tr["name"] for tr in tracks] == ["BG plate", "John Doe"]                  # bottom track first
    otio = pytest.importorskip("opentimelineio")
    tl = otio.adapters.read_from_file(path)
    assert len(tl.video_tracks()) == 2
    clip = tl.video_tracks()[1][0]
    assert clip.source_range.start_time.value == 1001 and clip.source_range.duration.value == N
    assert clip.metadata["soundstage"]["z"] == 10
    assert tl.tracks.markers[0].comment == "Push in on John"


def test_preview_and_contact_sheet(exported):
    root, m, res = exported
    sheet = res["preview"]
    assert sheet.ndim == 3 and sheet.shape[2] == 3 and sheet.dtype == np.float32
    assert os.path.exists(p(root, "preview/contact_sheet.png"))


# ------------------------------------------------------------------ degraded inputs

def test_export_without_camera_or_depth(tmp_path):
    pack = synthetic_pack(camera=None)
    pack = LayerPack(shot="NoCam", layers=pack.layers)
    res = export_pack(pack, str(tmp_path), timestamp="t", prores=False, comp_preview=False)
    ex = res["manifest"]["exports"]
    assert ex["camera_json"].startswith("skipped") and ex["psd"] == "ok" and ex["ae_jsx"] == "ok"
    assert res["manifest"]["camera"]["source"] is None
    ast.parse(open(os.path.join(res["root"], "dcc/blender/build_blender_scene.py")).read())


def test_mask_size_mismatch_and_invert(tmp_path):
    img = np.ones((3, 32, 64, 3), np.float32)
    mask = np.ones((3, 16, 32), np.float32)
    mask[:, :, :16] = 0.0                                       # left half transparent (after invert: opaque)
    pack = LayerPack(shot="Inv").add_layer(Layer(name="a", images=img, mask=mask, invert_mask=True))
    res = export_pack(pack, str(tmp_path), timestamp="t", prores=False, comp_preview=False, psd=False)
    im = np.asarray(Image.open(os.path.join(res["root"], "layers/10_a/png/a.1001.png")))
    assert im.shape == (32, 64, 4) and im[16, 2, 3] == 255 and im[16, 60, 3] == 0
