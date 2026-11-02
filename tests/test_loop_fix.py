"""Loop fixes (soundstage/loop/fix.py): the best trim pair, trim / join with ffmpeg on small synthetic clips (frames
and sound stay in step, no dissolve), the fix order. Run:  python -m pytest tests/test_loop_fix.py -q
"""
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from soundstage.loop import fix as F  # noqa: E402
from soundstage.loop import seam as S  # noqa: E402
from test_loop_seam import clip  # noqa: E402

has_ff = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="needs ffmpeg")


def write(frames, path, fps=24, audio=True):
    n, h, w = frames.shape[:3]
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    if audio:
        cmd += ["-f", "lavfi", "-t", f"{n / fps + 0.5:.4f}", "-i", "sine=frequency=220:sample_rate=48000", "-c:a", "aac",
                "-t", f"{n / fps:.4f}"]
    cmd += ["-frames:v", str(n), "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path]
    subprocess.run(cmd, input=frames.astype(np.uint8).tobytes(), check=True)
    return path


def test_best_pair_finds_the_period():
    p = F.best_pair(clip(70, 48))
    assert (p["end"] + 1 - p["start"]) % 48 == 0
    assert p["kept"] >= int(70 * F.MIN_KEEP)
    assert p["cost"] < 1.0


def test_best_pair_skips_the_duplicate_last_frame():
    p = F.best_pair(clip(48, 48, dup=True))
    assert p["end"] <= 47


def test_next_step_order():
    assert F.next_step([]) == "trim"
    assert F.next_step(["trim"]) == "bridge"
    assert F.next_step(["trim", "bridge"]) == "reseed"
    assert F.next_step(list(F.ORDER)) is None


def test_summary_words():
    b = {"badge": "Visible seam · 4.0x (pixel)", "seam": 4.0}
    a = {"badge": "Seamless · 1.1x", "seam": 1.1, "verdict": "seamless"}
    s = F.summary(b, a, "trimmed")
    assert s["fixed"] and s["before_seam"] == 4.0 and s["after_seam"] == 1.1


@has_ff
def test_trim_fixes_a_clip_cut_off_the_period(tmp_path):
    src = write(clip(64, 30), str(tmp_path / "c.mp4"))
    before = S.measure_file(src)
    assert before["verdict"] == "visible"
    from soundstage.takecheck import video as V
    p = F.best_pair(V.read_frames(src, width=160))
    dst = F.trim(src, str(tmp_path / "t.mp4"), p["start"], p["end"], 24.0)
    info = V.probe(dst)
    assert info["frames"] == p["kept"]
    after = S.measure_file(dst)
    assert after["seam"] < before["seam"] and after["verdict"] == "seamless"


@has_ff
def test_join_appends_a_bridge_without_its_end_frames(tmp_path):
    a = clip(48, 24)[:24]
    src = write(a[:15], str(tmp_path / "c.mp4"))
    bridge = write(np.concatenate([a[14:], a[:1]]), str(tmp_path / "b.mp4"))   # clip's last -> ... -> its first
    dst = F.join(src, bridge, str(tmp_path / "j.mp4"), 14, 24.0)
    from soundstage.takecheck import video as V
    assert V.probe(dst)["frames"] == 24
    assert S.measure_file(dst)["verdict"] == "seamless"
    assert F._has_audio(dst)


@has_ff
def test_clean_end_finds_the_snap():
    a = clip(48, 48)
    snapped = np.concatenate([a[:44], a[20:23]])            # the last 3 frames jump to another picture
    assert F.clean_end(snapped) == 43
    assert F.clean_end(a) == 47


@has_ff
def test_frame_png(tmp_path):
    src = write(clip(10, 10), str(tmp_path / "c.mp4"), audio=False)
    out = F.frame_png(src, 3, str(tmp_path / "f3.png"))
    assert os.path.getsize(out) > 100
