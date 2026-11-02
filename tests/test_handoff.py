"""Hand-offs (no ComfyUI, no GPU): Open in ComfyUI reads the graph inside a take (soundstage/handoff/workflow.py), the
phone's clip code and upload rules (soundstage/vcam.py), and the LAN bridge lets the clip upload through and nothing
else new. Run:  python -m pytest tests/test_handoff.py -q
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from soundstage import vcam  # noqa: E402
from soundstage.handoff import workflow as W  # noqa: E402

_spec = importlib.util.spec_from_file_location("vcam_bridge", os.path.join(ROOT, "tools", "vcam_bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

WF = {"last_node_id": 2, "nodes": [{"id": 1, "type": "SoundstageStage"}, {"id": 2, "type": "SaveVideo"}], "links": []}
API = {"1": {"class_type": "SoundstageRipple", "inputs": {"source": "x"}}, "2": {"class_type": "SaveVideo", "inputs": {"video": ["1", 0]}}}
has_ff = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="needs ffmpeg")


def test_parse_ref():
    assert W.parse_ref("soundstage/draft_00012_.mp4 [output]") == ("output", "soundstage", "draft_00012_.mp4")
    assert W.parse_ref("x.png [input]") == ("input", "", "x.png")
    assert W.parse_ref("a/b.mp4") == ("output", "a", "b.mp4")
    assert W.parse_ref("../etc/passwd [input]") is None
    assert W.parse_ref("") is None


def test_resolve_stays_inside_the_folders(tmp_path):
    out = tmp_path / "output"
    (out / "soundstage").mkdir(parents=True)
    (out / "soundstage" / "a.mp4").write_bytes(b"x")
    (tmp_path / "secret.mp4").write_bytes(b"x")
    dirs = {"input": str(tmp_path / "input"), "output": str(out), "temp": str(tmp_path / "temp")}
    assert W.resolve("soundstage/a.mp4 [output]", dirs) == os.path.realpath(out / "soundstage" / "a.mp4")
    assert W.resolve("soundstage/missing.mp4 [output]", dirs) is None
    assert W.resolve("../secret.mp4 [output]", dirs) is None
    # a drive letter (another drive on Windows) is refused, not a crash (the route answered 500)
    other = "Q:" if not str(tmp_path).upper().startswith("Q:") else "R:"
    assert W.resolve(f"{other}/secret.mp4 [output]", dirs) is None
    os.symlink(tmp_path / "secret.mp4", out / "link.mp4")
    assert W.resolve("link.mp4 [output]", dirs) is None


def test_from_tags_prefers_the_canvas_and_keeps_the_api_graph():
    r = W.from_tags({"workflow": json.dumps(WF), "prompt": json.dumps(API),
                     "soundstage": json.dumps({"rung": "draft", "shot": {"name": "Dana"}, "seeds": {"ltx": 7}})}, "draft_1")
    assert r["kind"] == "workflow" and r["nodes"] == 2 and r["prompt"] == API
    assert r["recipe"] == {"rung": "draft", "seeds": {"ltx": 7}, "shot": "Dana"}
    r = W.from_tags({"prompt": json.dumps(API)})
    assert r["kind"] == "api" and r["nodes"] == 2 and "workflow" not in r
    r = W.from_tags({"prompt": "not json", "workflow": json.dumps({"nodes": []})})
    assert r["kind"] is None and "no ComfyUI graph" in r["why"]


def test_png_text_chunks(tmp_path):
    from PIL import Image, PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text("prompt", json.dumps(API))
    info.add_text("workflow", json.dumps(WF))
    p = tmp_path / "look_00001_.png"
    Image.new("RGB", (8, 8)).save(p, pnginfo=info)
    r = W.handoff(str(p))
    assert r["name"] == "look_00001_" and r["kind"] == "workflow" and r["prompt"] == API


@has_ff
def test_mp4_tags(tmp_path):
    p = str(tmp_path / "final_00028_.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.2", "-metadata",
                    f"prompt={json.dumps(API)}", "-metadata", f"workflow={json.dumps(WF)}", "-movflags", "use_metadata_tags",
                    "-pix_fmt", "yuv420p", p], check=True)
    r = W.handoff(p)
    assert r["kind"] == "workflow" and r["prompt"] == API and r["nodes"] == 2


def test_clip_code_mint_and_check():
    code = vcam.mint_clip_code(now=1000)
    assert vcam.check_clip_code(code, now=1001)
    assert not vcam.check_clip_code(code, now=1000 + vcam.CLIP_TTL + 1), "a shoot day's code expires"
    assert not vcam.check_clip_code("x" * 7) and not vcam.check_clip_code(None) and not vcam.check_clip_code("wrong-code-123")


def test_clip_types_dest_and_name():
    assert vcam.clip_ext("video/webm;codecs=vp9,opus") == ".webm"
    assert vcam.clip_ext("video/mp4") == ".mp4" and vcam.clip_ext("video/quicktime") == ".mov"
    assert vcam.clip_ext("text/html") is None and vcam.clip_ext(None) is None
    assert vcam.clip_dest("performance") == "performance" and vcam.clip_dest("../x") == "motion"
    stem = vcam.clip_stem("vf-ab/../c", "My Move!", now=0)
    assert stem.startswith("phone_") and "/" not in stem and stem.endswith("_my_move")


@has_ff
def test_normalize_clip_makes_a_constant_rate_mp4(tmp_path):
    src = str(tmp_path / "in.webm")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=1", "-f", "lavfi", "-i",
                    "sine=d=1", "-c:v", "libvpx", "-c:a", "libopus", "-shortest", src], check=True)
    out = vcam.normalize_clip(src, str(tmp_path / "out.mp4"))
    from soundstage.takecheck import video as V
    info = V.probe(out)
    assert round(info["fps"]) == 30 and info["width"] == 320


def test_bridge_lets_the_clip_upload_through_and_nothing_else_new():
    t = "T" * 24
    hdr = [("Cookie", f"{bridge.COOKIE}={t}")]
    assert bridge.decide("POST", "/soundstage/vcam/clip?code=abcdefgh&dest=motion", hdr, t) == ("pass", None)
    assert bridge.decide("POST", "/soundstage/vcam/clipcode", hdr, t)[0] == "forbid", "only the desktop mints codes"
    assert bridge.decide("POST", "/soundstage/vcam/clip", [], t)[0] == "deny"
    assert bridge.decide("POST", "/soundstage/loop/prompt", hdr, t)[0] == "forbid"
    assert bridge.decide("GET", f"/soundstage/vcam/viewfinder?vk={t}&clip=abcdefgh", [], t) == \
        ("pair", "/soundstage/vcam/viewfinder?clip=abcdefgh"), "the clip code survives pairing"
