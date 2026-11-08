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


# ---------------------------------------------------------------- gaps (black + silence, frame-accurate at NTSC rates)

from fractions import Fraction  # noqa: E402


def test_rational_fps():
    assert A.rational_fps(23.976) == Fraction(24000, 1001)
    assert A.rational_fps(29.97) == Fraction(30000, 1001)
    assert A.rational_fps(59.94) == Fraction(60000, 1001)
    assert A.rational_fps(24) == 24 and A.rational_fps("30000/1001") == Fraction(30000, 1001)
    assert A.rate_str(A.rational_fps(23.976)) == "24000/1001" and A.rate_str(A.rational_fps(25)) == "25"


@pytest.mark.parametrize("fps", [24, 23.976, 29.97])
def test_timeline_with_gaps(fps):
    items = A.plan([{"shot_id": "a", "path": None, "in": 0, "out": 48}, {"gap": True, "frames": 13},
                    {"shot_id": "b", "path": None, "in": 10, "out": 41}, {"gap": True, "frames": 0},
                    {"gap": True, "frames": 7}], fps)
    assert [it["kind"] for it in items] == ["slate", "gap", "slate", "gap"]   # the zero-length gap is dropped
    tl = A.timeline(items, fps)
    rate = A.rational_fps(fps)
    assert tl[-1]["end_frame"] == 48 + 13 + 31 + 7                            # total = clips + gaps
    assert tl[2]["start_frame"] == 61                                          # the clip after the gap starts after it
    assert tl[2]["start_sample"] == round(Fraction(61) * 48000 / rate)         # its audio offset, in whole samples
    assert sum(t["samples"] for t in tl) == tl[-1]["end_sample"] == round(Fraction(99) * 48000 / rate)  # no drift
    assert all(tl[i]["end_sample"] == tl[i + 1]["start_sample"] for i in range(len(tl) - 1))


def _clip_at(path, frames, rate, color, audio):
    d = f"{float(Fraction(frames) / rate):.6f}"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=320x176:r={A.rate_str(rate)}:d={d}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={d}", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


@pytest.mark.parametrize("fps", [23.976, 29.97])
def test_assemble_with_gap_ntsc(tmp_path, fps):
    rate = A.rational_fps(fps)
    a = _clip_at(tmp_path / "a.mp4", 48, rate, "red", True)
    b = _clip_at(tmp_path / "b.mp4", 48, rate, "blue", True)
    clips = [{"shot_id": "s1", "path": a, "in": 0, "out": 36}, {"gap": True, "frames": 24},
             {"shot_id": "s2", "path": b, "in": 0, "out": 36}]
    out = tmp_path / "cut.mp4"
    res = A.assemble(clips, str(out), fps=fps)
    assert res["frames"] == 96 and res["gaps"] == 1 and res["missing"] == []
    n = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_frames", "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True).stdout.strip())
    assert n == 96
    # the silence sits exactly where the gap is: after 36 frames, for 24 frames (audio after the gap is in sync)
    log = subprocess.run(["ffmpeg", "-v", "info", "-i", str(out), "-af", "silencedetect=n=-50dB:d=0.2", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    import re
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    assert len(starts) == 1 and len(ends) == 1
    assert abs(starts[0] - float(36 / rate)) < 0.03
    assert abs(ends[0] - float(60 / rate)) < 0.03


def test_only_gaps_rejected(tmp_path):
    with pytest.raises(ValueError):
        A.assemble([{"gap": True, "frames": 10}], str(tmp_path / "x.mp4"))


# ---------------------------------------------------------------- caps, timeout, bad rates (final round; invented data)

def test_unbounded_gap_refused_before_ffmpeg(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(A.subprocess, "run", lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError("ffmpeg ran")))
    with pytest.raises(ValueError, match="longer than 10 minutes"):
        A.plan([{"shot_id": "a", "path": None, "in": 0, "out": 24}, {"gap": True, "in": 0, "out": 1e12}], 24)
    with pytest.raises(ValueError, match="longer than 10 minutes"):
        A.assemble([{"shot_id": "a", "path": None, "in": 0, "out": 24}, {"gap": True, "frames": 1e12}], str(tmp_path / "x.mp4"), fps=24)
    assert calls == [] and not (tmp_path / "x.mp4").exists()
    # the cap is exactly 10 minutes at the cut's exact rate
    assert A.max_gap_frames(A.rational_fps(24)) == 14400
    assert A.max_gap_frames(A.rational_fps(23.976)) == 14385
    assert A.plan([{"gap": True, "frames": 14385}], 23.976)[0]["frames"] == 14385
    with pytest.raises(ValueError):
        A.plan([{"gap": True, "frames": 14386}], 23.976)


def test_total_output_capped():
    # a clip's out of 1e12 is a slate of 1e12 frames otherwise
    with pytest.raises(ValueError, match="hours"):
        A.plan([{"shot_id": "a", "path": None, "in": 0, "out": 1e12}], 24)
    many = [{"gap": True, "frames": 14400} for _ in range(25)] + [{"shot_id": "a", "path": None, "in": 0, "out": 24}]
    with pytest.raises(ValueError, match="4-hour limit"):
        A.plan(many, 24)   # 25 x 10 min of gaps: each under the cap, together over 4 hours
    with pytest.raises(ValueError, match="isn't a number"):
        A.plan([{"shot_id": "a", "path": None, "in": 0, "out": float("inf")}], 24)


def test_gap_with_null_or_negative_frames_refused():
    for g in ({"gap": True, "frames": None}, {"gap": True}, {"gap": True, "in": 5}, {"gap": True, "frames": "abc"},
              {"gap": True, "frames": float("nan")}):
        with pytest.raises(ValueError, match="gap 1 in the cut has"):
            A.plan([g, {"shot_id": "a", "path": None, "in": 0, "out": 24}], 24)
    with pytest.raises(ValueError, match="negative length"):
        A.plan([{"gap": True, "frames": -12}], 24)
    with pytest.raises(ValueError, match="negative length"):
        A.plan([{"gap": True, "in": 30, "out": 10}], 24)
    # out - in when frames is absent; a zero-length gap is still no gap
    assert A.plan([{"gap": True, "in": 10, "out": 22}], 24)[0]["frames"] == 12
    assert A.plan([{"gap": True, "frames": 0}], 24) == []


@pytest.mark.parametrize("bad", [0, -24, "24/0", "0/1", "-24/1", "abc", "abc/1", float("nan"), float("inf"), True, 5000])
def test_bad_fps_is_a_clean_error(bad):
    with pytest.raises(ValueError, match="isn't a usable rate"):
        A.rational_fps(bad)
    with pytest.raises(ValueError, match="isn't a usable rate"):
        A.plan([{"shot_id": "a", "path": None, "in": 0, "out": 24}], bad)
    assert A.rational_fps(None) == 24


def test_ffmpeg_timeout_stops_and_cleans_up(tmp_path):
    out = tmp_path / "slow.mp4"
    with pytest.raises(RuntimeError, match="took longer than"):
        A.assemble([{"shot_id": "a", "name": "Wide", "path": None, "in": 0, "out": 2400}], str(out), fps=24,
                   width=1920, height=1080, timeout=0.05)
    assert not out.exists()
    assert A.ffmpeg_timeout(0) == A.TIMEOUT_FLOOR_S and A.ffmpeg_timeout(1e9) == A.TIMEOUT_CEILING_S


def test_assemble_passes_a_timeout(tmp_path, monkeypatch):
    seen = {}
    real = A.subprocess.run

    def spy(cmd, *a, **k):
        if "-filter_complex" in cmd:
            seen["timeout"] = k.get("timeout")
        return real(cmd, *a, **k)
    monkeypatch.setattr(A.subprocess, "run", spy)
    A.assemble([{"shot_id": "a", "path": None, "in": 0, "out": 12}], str(tmp_path / "t.mp4"), fps=24, width=64, height=36)
    assert seen["timeout"] == A.ffmpeg_timeout(0.5)


def test_route_refuses_bad_fps_and_bad_gaps(tmp_path, monkeypatch):
    import asyncio
    import types
    aiohttp = pytest.importorskip("aiohttp")
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    fp = types.ModuleType("folder_paths")
    for k in ("get_output_directory", "get_input_directory", "get_temp_directory"):
        setattr(fp, k, lambda: str(tmp_path))
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    ran = []
    real = A.subprocess.run
    monkeypatch.setattr(A.subprocess, "run", lambda cmd, *a, **k: ran.append(cmd) if "-filter_complex" in cmd else real(cmd, *a, **k))
    routes = web.RouteTableDef()
    A.register(routes)
    app = web.Application()
    app.add_routes(routes)
    shot = {"shot_id": "a", "in": 0, "out": 24, "file": None}

    async def go():
        async with TestClient(TestServer(app)) as c:
            out = []
            for body in ({"fps": 0, "clips": [shot]}, {"fps": "24/0", "clips": [shot]}, {"fps": -24, "clips": [shot]},
                         {"fps": 24, "clips": [shot, {"gap": True, "frames": None}]},
                         {"fps": 24, "clips": [shot, {"gap": True}]},
                         {"fps": 24, "clips": [shot, {"gap": True, "frames": -3}]},
                         {"fps": 24, "clips": [shot, {"gap": True, "in": 0, "out": 1e12}]}):
                r = await c.post("/soundstage/cut/render_video", json=body)
                out.append((r.status, (await r.json()).get("error", "")))
            return out
    res = asyncio.run(go())
    assert all(s == 400 for s, _ in res)
    assert all("isn't a usable rate" in e for _, e in res[:3])
    assert "no length" in res[3][1] and "no length" in res[4][1] and "negative" in res[5][1]
    assert "longer than 10 minutes" in res[6][1]
    assert not any("Fraction" in e or "division" in e for _, e in res)
    assert ran == []
