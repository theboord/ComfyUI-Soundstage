"""Source fidelity: "what goes in also goes out the same" (docs/source_fidelity.md).

The source spec (ffprobe), the NLE exports pointing at the camera original with its own reel, timecode and rate
(byte-for-byte with web/cut/exporters.mjs), and the Layer Pack delivering at the source size, rate and timecode.
Test media is generated with ffmpeg (testsrc2), never client footage.

Run:  python -m pytest tests/test_source_fidelity.py -q
"""
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import numpy as np
import pytest
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import export_all, to_edl, to_fcpxml, to_otio, to_xmeml  # noqa: E402
from soundstage.cut.export import normalize_project  # noqa: E402
from soundstage.footage import sourcespec as S  # noqa: E402
from soundstage.layerpack import Layer, LayerPack, export_pack  # noqa: E402

FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")

# What ffprobe says about a 3840x2160 23.976 ProRes 4444 Rec.709 clip with a timecode track and a reel.
PRORES_PROBE = {
    "streams": [
        {"codec_type": "video", "codec_name": "prores", "profile": "4444", "width": 3840, "height": 2160,
         "pix_fmt": "yuva444p10le", "bits_per_raw_sample": "10", "color_range": "tv", "color_space": "bt709",
         "color_primaries": "bt709", "color_transfer": "bt709", "r_frame_rate": "24000/1001",
         "avg_frame_rate": "24000/1001", "nb_frames": "240", "duration": "10.010000", "sample_aspect_ratio": "1:1",
         "tags": {"timecode": "01:02:03:04"}},
        {"codec_type": "audio", "codec_name": "pcm_s24le", "channels": 2, "sample_rate": "48000"},
        {"codec_type": "data", "tags": {"reel_name": "A001C003", "timecode": "01:02:03:04"}},
    ],
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.010000", "tags": {}},
}
PQ_PROBE = {
    "streams": [{"codec_type": "video", "codec_name": "hevc", "profile": "Main 10", "width": 1920, "height": 1080,
                 "pix_fmt": "yuv420p10le", "color_space": "bt2020nc", "color_primaries": "bt2020",
                 "color_transfer": "smpte2084", "r_frame_rate": "25/1", "avg_frame_rate": "25/1", "nb_frames": "50"}],
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "2.0"},
}


# ---------------------------------------------------------------- the spec

def test_parse_prores_4444():
    s = S.parse(PRORES_PROBE, "/in/A001C003_plate.mov")
    assert (s["width"], s["height"], s["fps_rational"], s["fps"]) == (3840, 2160, "24000/1001", 23.976)
    assert (s["tc_start"], s["reel"], s["codec_label"], s["bit_depth"], s["chroma"], s["alpha"]) == \
        ("01:02:03:04", "A001C003", "ProRes 4444", 10, "4:4:4", True)
    assert (s["colour"], s["range"], s["frames"], s["audio"]["channels"]) == ("Rec.709", "limited", 240, 2)
    assert s["line"] == "Source: 3840×2160 · 23.976 · ProRes 4444 · Rec.709 · 10-bit 4:4:4 · TC 01:02:03:04"


def test_parse_hdr_and_log():
    s = S.parse(PQ_PROBE, "/in/hdr.mp4")
    assert s["colour"] == "Rec.2020 PQ" and s["codec_label"] == "HEVC (Main 10)" and s["fps_rational"] == "25/1"
    log = json.loads(json.dumps(PRORES_PROBE))
    log["format"]["tags"] = {"com.sony.gamma": "s-log3-cine"}
    assert S.parse(log)["colour"] == "S-Log3"


def test_camera_raw_needs_a_proxy():
    stub = S.probe("/cards/A001_C002_0101XY.R3D")   # never decoded: no SDK, no ffprobe run
    assert stub["camera_raw"] == "RED R3D" and stub["decodable"] is False and stub["reel"] == "A001_C002"
    assert "proxy" in stub["line"] and "relinks to the camera original" in stub["line"]
    prox = S.link_original(S.parse(PRORES_PROBE, "/in/proxy.mov"), "A001_C002_0101XY.R3D")
    assert prox["proxy"] and prox["camera_original"] == "A001_C002_0101XY.R3D" and prox["camera_raw"] == "RED R3D"
    assert prox["line"].endswith("Working from a proxy; your export relinks to the camera original (A001_C002_0101XY.R3D).")
    assert S.camera_raw("clip.braw") == "Blackmagic RAW" and S.camera_raw("x.mov") is None


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not installed")
def test_probe_a_real_file(tmp_path):
    clip = str(tmp_path / "testsrc_4444.mov")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=24000/1001", "-t", "0.25",
                    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-colorspace", "bt709",
                    "-timecode", "01:00:10:00", clip], check=True)
    s = S.probe(clip)
    assert (s["width"], s["height"], s["fps_rational"], s["tc_start"]) == (3840, 2160, "24000/1001", "01:00:10:00")
    assert s["codec_label"].startswith("ProRes 4444") and s["bit_depth"] >= 10 and s["chroma"] == "4:4:4"


def test_deliver_plan():
    spec = S.parse(PRORES_PROBE, "/in/plate.mov")
    p = S.deliver_plan(spec, 1280, 704, 24.0)
    assert (p["width"], p["height"], p["fps_arg"], p["timecode"], p["resample"]) == (3840, 2160, "24000/1001", "01:02:03:04", "lanczos")
    assert p["crop"] and any("lanczos" in n for n in p["notes"]) and any("frame for frame" in n for n in p["notes"])
    hdr = S.deliver_plan(S.parse(PQ_PROBE), 1280, 704, 24.0)
    assert hdr["fps"] == 24.0 and any("rate: NOT matched" in n for n in hdr["notes"])
    assert any("colour: NOT matched" in n for n in hdr["notes"])
    same = S.deliver_plan(None, 1280, 704, 24.0)
    assert (same["width"], same["height"], same["matched"], same["notes"]) == (1280, 704, False, [])


# ---------------------------------------------------------------- NLE exports

PLATE = {"path": "/workspace/input/A001C003_plate.mov", "file": "A001C003_plate.mov", "reel": "A001C003",
         "tc_start": "01:02:03:04", "fps": 23.976, "fps_rational": "24000/1001", "width": 3840, "height": 2160,
         "frames": 240, "colour": "Rec.709", "primaries": "bt709", "transfer": "bt709", "matrix": "bt709"}
SOURCE = {
    "name": "Source cut", "fps": 24, "width": 1280, "height": 704,
    "shots": [
        {"id": "s1", "name": "Plate stand-in", "frames": 48, "renders": {}, "source": PLATE,
         "markers": [{"frame": 10, "text": "hold here"}]},
        {"id": "s2", "name": "Generated over plate", "frames": 48, "source": PLATE,
         "renders": {"final": "/view?filename=s2.mp4&subfolder=soundstage&type=output"}},
        {"id": "s3", "name": "RED proxy", "frames": 30, "renders": {},
         "source": {"path": "/workspace/input/A002_C007_proxy.mov", "camera_original": "A002_C007_0101AB.R3D", "proxy": True,
                    "tc_start": "14:20:00:00", "fps": 25, "width": 1920, "height": 1080, "frames": 60, "use": "original",
                    "primaries": "bt2020", "matrix": "bt2020nc", "transfer": "smpte2084"}},
        {"id": "s4", "name": "Pure generated", "frames": 24, "renders": {"draft": "/view?filename=s4.mp4&type=output"}},
    ],
    "cut": [{"shot_id": "s1", "in": 4, "out": 40}, {"shot_id": "s2", "in": 0, "out": 48}, {"shot_id": "s3", "in": 0, "out": 24},
            {"shot_id": "s4", "in": 0, "out": 24}],
    "audio": [{"id": "a1", "path": "music.wav", "start_frame": 10, "in": 0, "out": 100, "frames": 200}],
}


def test_delivery_matches_the_source():
    p = normalize_project(SOURCE)
    assert (p["width"], p["height"], p["fps"]) == (3840, 2160, 23.976)
    assert p["delivery"]["from"] == "Plate stand-in"
    off = normalize_project(dict(SOURCE, match_source=False))
    assert (off["width"], off["height"], off["fps"]) == (1280, 704, 24) and "delivery" not in off


def test_edl_points_at_the_camera_original():
    edl = to_edl(SOURCE).splitlines()
    ev = [l for l in edl if l[:3].isdigit()]
    # the plate at its own reel and timecode (01:02:03:04 + 4 frames)
    assert ev[0].split()[1] == "A001C003" and ev[0].split()[4:6] == ["01:02:03:08", "01:02:04:20"]
    # the generated shot keeps its own media, and names its plate
    assert any(l.startswith("* SOUNDSTAGE PLATE: /workspace/input/A001C003_plate.mov REEL A001C003 TC 01:02:03:04") for l in edl)
    # the RED proxy relinks to the R3D, at the R3D's 25 fps timecode, and says the rates differ
    assert ev[2].split()[4:6] == ["14:20:00:00", "14:20:01:00"]
    assert "* SOURCE FILE: A002_C007_0101AB.R3D" in edl
    assert any("relink to the camera original A002_C007_0101AB.R3D" in l for l in edl)
    assert any("source is 25 fps in a 23.976 fps sequence" in l for l in edl)


def test_otio_fcpxml_xmeml_carry_the_source():
    t = to_otio(SOURCE)
    c0, c2 = t["tracks"]["children"][0]["children"][0], t["tracks"]["children"][0]["children"][2]
    assert c0["source_range"]["start_time"]["value"] == 89356 + 4 and abs(c0["source_range"]["start_time"]["rate"] - 23.976) < 0.001
    assert c0["media_references"]["DEFAULT_MEDIA"]["target_url"] == "file:///workspace/input/A001C003_plate.mov"
    assert c2["source_range"]["start_time"]["rate"] == 25 and c2["metadata"]["soundstage"]["source"]["proxy"]
    assert t["metadata"]["soundstage"]["width"] == 3840
    root = ET.fromstring(to_fcpxml(SOURCE).split("\n", 2)[2])
    fmts = {f.get("id"): f for f in root.iter("format")}
    assert fmts["r1"].get("width") == "3840" and any(f.get("colorSpace") == "9-16-9 (Rec. 2020 PQ)" for f in fmts.values())
    assets = {a.get("name"): a for a in root.iter("asset")}
    assert assets["A001C003_plate.mov"].get("start") == "22361339/6000s"   # 01:02:03:04 at 23.976
    x = ET.fromstring(to_xmeml(SOURCE).split("\n", 2)[2])
    reels = [r.text for r in x.iter("name") if r.text in ("A001C003", "A002_C007_0101AB")]
    assert reels == ["A001C003", "A002_C007_0101AB"]


JS = """
import { exportAll } from "%s";
const [project, opts] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(exportAll(project, opts)));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
@pytest.mark.parametrize("opts", [{}, {"media_root": "/workspace/ComfyUI/output", "reel_width": 32}], ids=["browser", "server"])
def test_parity_with_browser_writers(opts):
    js_opts = {"mediaRoot": opts.get("media_root", ""), "reelWidth": opts.get("reel_width", 8)}
    mod = "file://" + os.path.join(ROOT, "web", "cut", "exporters.mjs")
    res = subprocess.run(["node", "--input-type=module", "-e", JS % mod, json.dumps([SOURCE, js_opts])],
                         capture_output=True, text=True, check=True)
    js, py = json.loads(res.stdout), export_all(SOURCE, **opts)
    assert list(js) == list(py)
    for name in py:
        assert js[name] == py[name], name


# ---------------------------------------------------------------- Layer Pack

def _pack(w=64, h=36, n=3, meta=None):
    img = np.zeros((n, h, w, 3), np.float32)
    img[:, :, : w // 2] = [0.8, 0.2, 0.1]
    img[:, :, w // 2:] = [0.1, 0.3, 0.9]
    mask = np.ones((n, h, w), np.float32)
    return LayerPack(shot="SRC010", fps=24.0, meta=meta or {}).add_layer(Layer(name="bg", images=img, mask=mask, z=0,
                                                                                kind="background"))


def test_layer_pack_delivers_at_source_spec(tmp_path):
    spec = dict(S.parse(PRORES_PROBE, "/in/plate.mov"), width=128, height=72)
    res = export_pack(_pack(meta={"source": spec}), str(tmp_path), timestamp="t", psd=False, comp_preview=bool(FFMPEG),
                      prores=bool(FFMPEG), otio=False, ae=False, blender=False, nuke=False, camera=False)
    m = res["manifest"]
    assert m["shot"]["resolution"] == [128, 72] and m["shot"]["fps_rational"] == "24000/1001"
    assert m["shot"]["timecode"] == "01:02:03:04" and m["delivery"]["matched"]
    assert m["delivery"]["generated"]["resolution"] == [64, 36] and m["delivery"]["resize"] == "lanczos cover fill"
    png = Image.open(os.path.join(res["root"], "layers/00_bg/png/bg.1001.png"))
    assert png.size == (128, 72)
    readme = open(os.path.join(res["root"], "README.txt")).read()
    assert "Delivered at source spec" in readme and "frame for frame" in readme
    if FFMPEG:
        mov = os.path.join(res["root"], m["layers"][0]["files"]["mov"])
        j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", mov],
                                      capture_output=True, text=True, check=True).stdout)
        out = S.parse(j, mov)
        assert (out["width"], out["height"], out["fps_rational"], out["tc_start"]) == (128, 72, "24000/1001", "01:02:03:04")


def test_layer_pack_off_or_without_source_is_unchanged(tmp_path):
    kw = dict(timestamp="t", psd=False, comp_preview=False, prores=False, otio=False, ae=False, blender=False, nuke=False,
              camera=False)
    spec = dict(S.parse(PRORES_PROBE, "/in/plate.mov"), width=128, height=72)
    off = export_pack(_pack(meta={"source": spec}), str(tmp_path / "off"), match_source=False, **kw)["manifest"]
    assert off["shot"]["resolution"] == [64, 36] and not off["delivery"]["matched"]
    plain = export_pack(_pack(), str(tmp_path / "plain"), **kw)["manifest"]
    assert plain["shot"]["resolution"] == [64, 36] and plain["shot"]["fps"] == 24.0 and plain["delivery"]["notes"] == []


def test_deliver_plan_never_crops_a_different_frame_shape():
    tall = dict(S.parse(PRORES_PROBE), width=4000, height=6000, kind="image", fps=0)
    p = S.deliver_plan(tall, 1280, 704, 24.0)
    assert (p["width"], p["height"], p["resample"]) == (1280, 704, None)
    assert any(n.startswith("picture: NOT matched") for n in p["notes"])
