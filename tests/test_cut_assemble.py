"""Cut -> one video: trims, mixed sources, silence fill, slates for unrendered shots."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")

from soundstage.cut import assemble as A  # noqa: E402


def _clip(path, seconds, color, audio):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=320x176:r=24:d={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


def test_assemble_mixed_sources(tmp_path):
    a = _clip(tmp_path / "a.mp4", 4, "red", True)
    b = _clip(tmp_path / "b.mp4", 4, "blue", False)
    img = tmp_path / "still.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=640x352", "-frames:v", "1",
                    str(img)], check=True)
    clips = [{"shot_id": "s1", "path": a, "in": 12, "out": 60},        # 2 s from the middle, with sound
             {"shot_id": "s2", "path": b, "in": 0, "out": 24},         # 1 s, silent source
             {"shot_id": "s3", "path": str(img), "in": 0, "out": 36},  # still for 1.5 s
             {"shot_id": "s4", "name": "Wide", "path": None, "in": 0, "out": 12}]  # not rendered yet
    res = A.assemble(clips, str(tmp_path / "cut.mp4"), fps=24)
    assert res["frames"] == 48 + 24 + 36 + 12
    assert res["missing"] == ["s4"]
    assert (res["width"], res["height"]) == (320, 176)
    info = A.probe(str(tmp_path / "cut.mp4"))
    assert info["has_audio"]
    n = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_frames", "-of", "csv=p=0", str(tmp_path / "cut.mp4")],
                           capture_output=True, text=True, check=True).stdout.strip())
    assert abs(n - 120) <= 1
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(tmp_path / "cut.mp4")], capture_output=True, text=True, check=True).stdout)
    assert abs(dur - 5.0) < 0.1


def test_plan_normalises():
    p = A.plan([{"path": None, "in": 5.4, "out": 3}], 24)
    assert p[0]["in"] == 5 and p[0]["out"] == 6 and p[0]["kind"] == "slate"


def test_empty_cut_rejected(tmp_path):
    with pytest.raises(ValueError):
        A.assemble([], str(tmp_path / "x.mp4"))
