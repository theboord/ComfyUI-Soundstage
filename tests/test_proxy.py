"""Playback proxies (soundstage/proxy.py): path safety, the width whitelist, the cache key, a real short-GOP transcode of
a synthetic clip, the 202 -> ready flow, one job per key and one transcode at a time, errors answered (never a 500),
and the short GOP SoundstageSaveVideo gives new takes."""
import ast
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage import proxy as P  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed")


def _clip(path, seconds=1, size="320x180", audio=True, extra=()):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=24:duration={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", *extra, str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


def _info(path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True, encoding="utf-8").stdout
    return json.loads(out)


def _keyframes(path) -> tuple[list[int], int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    flags = [line.split(",")[0].strip() for line in out.splitlines() if line.strip()]
    return [i for i, f in enumerate(flags) if f == "1"], len(flags)


def _longest_gop(path) -> int:
    keys, n = _keyframes(path)
    assert keys and keys[0] == 0, "the first frame is a keyframe"
    edges = keys + [n]
    return max(b - a for a, b in zip(edges, edges[1:]))


def _x264(path) -> dict:
    """The settings x264 writes into the stream (its SEI): crf, keyint, ..."""
    m = re.search(rb"options: ([^\x00\x80]+)", Path(path).read_bytes())
    return dict(kv.split("=", 1) for kv in m.group(1).decode("ascii", "replace").split() if "=" in kv)


def _audio_md5(path) -> str:
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-c", "copy", "-f", "md5", "-"],
                          capture_output=True, text=True, check=True).stdout.strip()


def _atoms(path) -> list[str]:
    """Top-level MP4 boxes in file order (faststart puts moov before mdat)."""
    names, data = [], Path(path).read_bytes()
    i = 0
    while i + 8 <= len(data):
        size, kind = int.from_bytes(data[i:i + 4], "big"), data[i + 4:i + 8].decode("latin-1")
        if size == 1:
            size = int.from_bytes(data[i + 8:i + 16], "big")
        names.append(kind)
        if size < 8:
            break
        i += size
    return names


def _folders(tmp_path) -> dict:
    dirs = {k: tmp_path / k for k in P.TYPES}
    for d in dirs.values():
        d.mkdir()
    return {k: str(v) for k, v in dirs.items()}


# ------------------------------------------------------------------------------------------- path safety

def test_resolve_finds_a_take_in_each_folder(tmp_path):
    dirs = _folders(tmp_path)
    for kind in P.TYPES:
        sub = Path(dirs[kind]) / "soundstage" / "takes"
        sub.mkdir(parents=True)
        (sub / "final_00001_.mp4").write_bytes(b"x")
        got = P.resolve("final_00001_.mp4", "soundstage/takes", kind, dirs)
        assert os.path.samefile(got, sub / "final_00001_.mp4")
    assert os.path.samefile(P.resolve("final_00001_.mp4", "soundstage\\takes", "input", dirs),
                            Path(dirs["input"]) / "soundstage" / "takes" / "final_00001_.mp4")


def test_resolve_rejects_traversal_absolute_drives_wrong_type_and_missing(tmp_path):
    dirs = _folders(tmp_path)
    (Path(dirs["output"]) / "take.mp4").write_bytes(b"x")
    (Path(dirs["output"]) / "still.png").write_bytes(b"x")
    (tmp_path / "secret.mp4").write_bytes(b"x")
    bad = [("../secret.mp4", ""), ("..\\secret.mp4", ""), ("secret.mp4", ".."), ("secret.mp4", "a/../.."),
           ("secret.mp4", "..\\.."), (str(tmp_path / "secret.mp4"), ""), ("secret.mp4", str(tmp_path)),
           ("secret.mp4", "/"), ("secret.mp4", "\\\\server\\share"), ("C:secret.mp4", ""), ("take.mp4", "C:/"),
           ("take.mp4", "C:"), ("", ""), (".", ""), ("..", ""), ("still.png", ""), ("take.mp4\x00.png", "")]
    for name, sub in bad:
        with pytest.raises(ValueError):
            P.resolve(name, sub, "output", dirs)
    for kind in ("models", "user", "", None):
        with pytest.raises(ValueError):
            P.resolve("take.mp4", "", kind, dirs)
    with pytest.raises(FileNotFoundError):
        P.resolve("missing.mp4", "", "output", dirs)
    with pytest.raises(FileNotFoundError):          # a folder named like a video is not a file
        (Path(dirs["output"]) / "folder.mp4").mkdir()
        P.resolve("folder.mp4", "", "output", dirs)
    # Windows folds ".. " and "..." into "..": whatever the platform does with them, nothing outside comes back.
    for sub in (".. ", "...", " ..", "..\t", "x/.. /.. ", "x/...", ".../...", "%2e%2e", "..%2f"):
        try:
            got = P.resolve("secret.mp4", sub, "output", dirs)
        except (ValueError, FileNotFoundError) as e:
            assert str(tmp_path) not in str(e), "no server paths in the message"
            continue
        assert P._inside(os.path.realpath(dirs["output"]), got), (sub, got)


def test_resolve_rejects_a_link_that_leads_out_of_the_folder(tmp_path):
    dirs = _folders(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "x.mp4").write_bytes(b"x")
    made = []
    try:
        os.symlink(outside, Path(dirs["output"]) / "dirlink", target_is_directory=True)
        os.symlink(outside / "x.mp4", Path(dirs["output"]) / "filelink.mp4")
        made += [("x.mp4", "dirlink"), ("filelink.mp4", "")]
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":                              # a junction needs no privilege
        import _winapi
        _winapi.CreateJunction(str(outside), str(Path(dirs["output"]) / "junction"))
        made.append(("x.mp4", "junction"))
    if not made:
        pytest.skip("this machine cannot make links")
    for name, sub in made:
        with pytest.raises(ValueError, match="outside"):
            P.resolve(name, sub, "output", dirs)
    inside = Path(dirs["output"]) / "real"
    inside.mkdir()
    (inside / "y.mp4").write_bytes(b"y")
    try:                                             # a link that stays inside is fine
        os.symlink(inside, Path(dirs["output"]) / "inlink", target_is_directory=True)
    except (OSError, NotImplementedError):
        return
    assert os.path.samefile(P.resolve("y.mp4", "inlink", "output", dirs), inside / "y.mp4")


# ------------------------------------------------------------------------------------------- width, key, command

def test_width_whitelist_default_and_never_upscale():
    assert P.parse_w(None) == P.parse_w("") == 960
    assert [P.parse_w(str(w)) for w in P.WIDTHS] == [480, 640, 960, 1280, 1920]
    for bad in ("800", "0", "-960", "960.5", "big", "1e3"):
        with pytest.raises(ValueError):
            P.parse_w(bad)
    assert P.target_width(2624, 960) == 960
    assert P.target_width(1312, 1920) == 1312          # never upscale
    assert P.target_width(641, 960) == 640             # odd source: even
    assert P.target_width(1311, 1920) == 1310
    assert all(P.target_width(s, w) % 2 == 0 for s in (2, 3, 479, 481, 2624) for w in P.WIDTHS)


def test_cache_key_changes_with_mtime_size_width_and_encoder(tmp_path, monkeypatch):
    f = tmp_path / "take.mp4"
    f.write_bytes(b"0" * 100)
    t, t2 = 1_700_000_000_000_000_000, 1_700_000_001_000_000_000   # one second apart (NTFS keeps 100 ns)
    os.utime(f, ns=(t, t))
    k = P.cache_key(str(f), 960)
    assert k == P.cache_key(str(f), 960) and re.fullmatch(r"[0-9a-f]{40}", k)
    assert P.cache_key(str(f), 480) != k
    os.utime(f, ns=(t, t2))
    k2 = P.cache_key(str(f), 960)
    assert k2 != k                                      # re-rendered (new mtime)
    f.write_bytes(b"0" * 101)
    os.utime(f, ns=(t, t2))
    assert P.cache_key(str(f), 960) not in (k, k2)      # same mtime, new size
    monkeypatch.setattr(P, "ENCODER", P.ENCODER + " changed")
    assert P.cache_key(str(f), 960) not in (k, k2)
    g = tmp_path / "other.mp4"
    shutil.copy2(f, g)
    assert P.cache_key(str(g), 960) != P.cache_key(str(f), 960)
    assert "&v=" + P.cache_key(str(f), 960)[:12] in P.proxy_url("take.mp4", "", "output", 960, P.cache_key(str(f), 960))


def test_command_is_short_gop_without_b_frames_and_drops_metadata():
    cmd = P.build_command("in.mp4", "out.mp4.partial", 960, True)
    s = " ".join(cmd)
    for part in ("-vf scale=960:-2:flags=bicubic", "-c:v libx264", "-preset veryfast", "-crf 23", "-g 12",
                 "-keyint_min 12", "-sc_threshold 0", "-bf 0", "-pix_fmt yuv420p", "-profile:v high",
                 "-c:a aac -b:a 128k -ar 48000", "-movflags +faststart", "-map_metadata -1"):
        assert part in s, part
    assert cmd.count("-threads") == 2 and cmd[-1] == "out.mp4.partial" and cmd[-3:-1] == ["-f", "mp4"]
    silent = P.build_command("in.mp4", "o", 480, False)
    assert "-an" in silent and "-c:a" not in silent and "0:a:0" not in silent


def test_evict_drops_least_recently_used_first_and_keeps_the_new_one(tmp_path):
    cache = P.Proxies(str(tmp_path), cap_bytes=250)
    now = time.time_ns()
    for i, key in enumerate(["old", "mid", "new"]):
        (tmp_path / f"{key}.mp4").write_bytes(b"x" * 100)
        os.utime(tmp_path / f"{key}.mp4", ns=(now - (3 - i) * 10**9, now - 3 * 10**9))
    (tmp_path / "half.mp4.partial").write_bytes(b"x" * 1000)        # not a proxy: not counted, not evicted here
    cache.touch("old")                                              # just played: now the most recent
    assert cache.evict(keep="new") == ["mid"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["half.mp4.partial", "new.mp4", "old.mp4"]
    cache.cap = 0
    assert cache.evict(keep="new") == ["old"] and (tmp_path / "new.mp4").exists()


def test_touch_keeps_the_modification_time(tmp_path):
    cache = P.Proxies(str(tmp_path))
    f = tmp_path / "k.mp4"
    f.write_bytes(b"x")
    os.utime(f, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    cache.touch("k")
    st = os.stat(f)
    assert st.st_mtime_ns == 1_600_000_000_000_000_000 and st.st_atime_ns > st.st_mtime_ns


def test_startup_removes_stale_partials(tmp_path):
    (tmp_path / "a.mp4.partial").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"x")
    cache = P.Proxies(str(tmp_path))
    from aiohttp import web
    P.register(web.RouteTableDef(), cache=cache, dirs=_folders(tmp_path))
    assert [p.name for p in tmp_path.iterdir() if p.is_file()] == ["b.mp4"]
    assert P.Proxies(str(tmp_path / "missing")).clean_partials() == 0


def test_cache_cap_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("SOUNDSTAGE_PROXY_CACHE_GB", "0.5")
    assert P.Proxies(str(tmp_path)).cap == 1 << 29
    monkeypatch.setenv("SOUNDSTAGE_PROXY_CACHE_GB", "lots")
    assert P.Proxies(str(tmp_path)).cap == 4 << 30


# ------------------------------------------------------------------------------------------- real transcodes

@needs_ffmpeg
def test_real_proxy_has_gop_12_even_dims_aac_and_faststart(tmp_path):
    src = _clip(tmp_path / "src.mp4", seconds=1, size="642x362", audio=True,
                extra=("-movflags", "use_metadata_tags", "-metadata", "prompt={\"1\": {}}"))
    dst = str(tmp_path / "proxy.mp4")
    res = P.transcode(src, dst, 480)
    assert res["width"] == 480 and not os.path.exists(dst + ".partial")
    info = _info(dst)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert v["codec_name"] == "h264" and v["profile"] == "High" and v["pix_fmt"] == "yuv420p"
    assert v["width"] == 480 and v["height"] % 2 == 0 and abs(v["height"] - 362 * 480 / 642) <= 2
    assert int(v.get("has_b_frames", 0)) == 0
    assert _longest_gop(dst) <= 12
    keys, n = _keyframes(dst)
    assert n == 24 and keys == [0, 12]
    assert a["codec_name"] == "aac" and a["sample_rate"] == "48000"
    assert "prompt" not in (info["format"].get("tags") or {}), "a take's workflow metadata stays out of the proxy"
    atoms = _atoms(dst)
    assert atoms.index("moov") < atoms.index("mdat"), "faststart: plays while it downloads"


@needs_ffmpeg
def test_real_proxy_of_a_silent_small_take_has_no_audio_and_no_upscale(tmp_path):
    src = _clip(tmp_path / "small.mp4", seconds=1, size="320x180", audio=False)
    dst = str(tmp_path / "proxy.mp4")
    assert P.transcode(src, dst, 1920)["width"] == 320
    info = _info(dst)
    assert [s["codec_type"] for s in info["streams"]] == ["video"]
    v = info["streams"][0]
    assert (v["width"], v["height"]) == (320, 180)
    assert _longest_gop(dst) <= 12


@needs_ffmpeg
def test_real_transcode_of_a_broken_file_raises_and_leaves_nothing(tmp_path):
    bad = tmp_path / "broken.mp4"
    bad.write_bytes(b"not a video " * 100)
    with pytest.raises(RuntimeError, match="ffprobe could not read|no video stream|ffmpeg failed"):
        P.transcode(str(bad), str(tmp_path / "p.mp4"), 960)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["broken.mp4"]


# ------------------------------------------------------------------------------------------- routes

class _Fake:
    """A stand-in transcoder: counts calls, can hold every job until released, can fail; writes a .partial first."""

    def __init__(self, hold=False, fail=None):
        self.calls, self.running, self.peak = [], 0, 0
        self.go = threading.Event()
        self.fail = fail
        self._lock = threading.Lock()
        if not hold:
            self.go.set()

    def __call__(self, src, dst, w):
        with self._lock:
            self.calls.append((os.path.basename(src), w))
            self.running += 1
            self.peak = max(self.peak, self.running)
        try:
            Path(dst + ".partial").write_bytes(b"half a proxy")
            self.go.wait(15)
            if self.fail:
                os.remove(dst + ".partial")
                raise RuntimeError(self.fail)
            os.replace(dst + ".partial", dst)
            return {}
        finally:
            with self._lock:
                self.running -= 1


def _serve(tmp_path, make=None):
    """(dirs, cache, run): run(coro_fn) starts an app with the proxy routes and gives coro_fn a test client."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    dirs = _folders(tmp_path)
    cache = P.Proxies(os.path.join(dirs["temp"], P.CACHE_SUB), make=make)

    def run(fn):
        async def go():
            rt = web.RouteTableDef()
            P.register(rt, cache=cache, dirs=dirs)
            app = web.Application()
            app.add_routes(rt)
            async with TestClient(TestServer(app)) as c:
                await fn(c)
        asyncio.run(go())
    return dirs, cache, run


async def _until(c, params, want, timeout=60.0):
    t0 = time.monotonic()
    while True:
        r = await c.get("/soundstage/proxy/status", params=params)
        body = await r.json()
        if body["status"] == want or time.monotonic() - t0 > timeout:
            return body
        await asyncio.sleep(0.05)


@needs_ffmpeg
def test_route_202_then_ready_with_range_and_cache_headers(tmp_path):
    dirs, cache, run = _serve(tmp_path)
    sub = Path(dirs["output"]) / "soundstage"
    sub.mkdir()
    _clip(sub / "final_00001_.mp4", seconds=1, size="640x360", audio=True)
    q = {"filename": "final_00001_.mp4", "subfolder": "soundstage", "type": "output", "w": "480"}

    async def check(c):
        r = await c.get("/soundstage/proxy", params=q)
        assert r.status == 202 and r.headers["Cache-Control"] == "no-store"
        first = await r.json()
        assert first["status"] == "pending" and first["retry_ms"] > 0 and first["ahead"] == 0
        assert first["url"].startswith("/soundstage/proxy?") and "&v=" in first["url"]
        done = await _until(c, q, "ready")
        assert done["status"] == "ready" and done["url"] == first["url"] and done["error"] is None
        r = await c.get(done["url"])
        body = await r.read()
        assert r.status == 200 and r.headers["Content-Type"] == "video/mp4"
        assert r.headers["Cache-Control"] == "private, max-age=86400"
        assert r.headers.get("Accept-Ranges") == "bytes" and body[4:8] == b"ftyp"
        part = await c.get(done["url"], headers={"Range": "bytes=0-99"})
        assert part.status == 206 and len(await part.read()) == 100
        assert part.headers["Content-Range"] == f"bytes 0-99/{len(body)}"
        assert part.headers.get("ETag") == r.headers.get("ETag"), "serving a proxy must not change its ETag"
        probe = await (await c.get("/soundstage/proxy", params={**q, "probe": "1"})).json()
        assert probe["status"] == "ready" and probe["url"] == first["url"]
    run(check)
    made = os.listdir(cache.folder)
    assert len(made) == 1 and made[0].endswith(".mp4"), "one proxy, no .partial left"
    assert _longest_gop(os.path.join(cache.folder, made[0])) <= 12


def test_route_duplicates_share_one_job_and_one_transcode_runs_at_a_time(tmp_path):
    fake = _Fake(hold=True)
    dirs, cache, run = _serve(tmp_path, make=fake)
    for n in ("a.mp4", "b.mp4"):
        (Path(dirs["output"]) / n).write_bytes(b"x")
    qa, qb = {"filename": "a.mp4"}, {"filename": "b.mp4"}

    async def check(c):
        try:
            assert (await c.get("/soundstage/proxy", params=qa)).status == 202
            rs = await asyncio.gather(c.get("/soundstage/proxy", params=qa), c.get("/soundstage/proxy/status", params=qa),
                                      c.get("/soundstage/proxy", params={**qa, "probe": "1"}),
                                      c.get("/soundstage/proxy", params=qb))
            assert [r.status for r in rs] == [202, 200, 200, 202]
            bodies = [await r.json() for r in rs]
            assert all(b["status"] == "pending" for b in bodies)
            assert [b["ahead"] for b in bodies] == [0, 0, 0, 1], "b waits behind a"
            t0 = time.monotonic()
            while not fake.calls and time.monotonic() - t0 < 10:
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.2)
            assert fake.calls == [("a.mp4", 960)], "one job for a; b has not started"
            r = await c.get("/soundstage/proxy", params=qa)
            assert r.status == 202, "the .partial is never served"
            assert any(n.endswith(".partial") for n in os.listdir(cache.folder))
        finally:
            fake.go.set()
        assert (await _until(c, qb, "ready", 15))["status"] == "ready"
        assert (await _until(c, qa, "ready", 15))["status"] == "ready"
        assert (await c.get("/soundstage/proxy", params=qa)).status == 200
    run(check)
    assert fake.calls == [("a.mp4", 960), ("b.mp4", 960)] and fake.peak == 1
    assert cache.jobs == {} and cache.queue == []


def test_route_a_failing_transcode_answers_its_error_not_a_500(tmp_path, monkeypatch):
    fake = _Fake(fail="ffmpeg failed: moov atom not found")
    dirs, cache, run = _serve(tmp_path, make=fake)
    (Path(dirs["output"]) / "a.mp4").write_bytes(b"x")
    q = {"filename": "a.mp4"}

    async def check(c):
        assert (await c.get("/soundstage/proxy", params=q)).status == 202
        st = await _until(c, q, "error", 15)
        assert st["status"] == "error" and "moov atom not found" in st["error"] and st["url"]
        r = await c.get("/soundstage/proxy", params=q)
        assert r.status == 422 and (await r.json())["error"] == st["error"]
        assert len(fake.calls) == 1, "the error is remembered, not retried on every request"
        monkeypatch.setattr(P, "ERROR_TTL", 0)
        fake.fail = None
        assert (await c.get("/soundstage/proxy", params=q)).status == 202, "after the TTL a request tries again"
        assert (await _until(c, q, "ready", 15))["status"] == "ready"
    run(check)
    assert len(fake.calls) == 2 and not [n for n in os.listdir(cache.folder) if n.endswith(".partial")]


@needs_ffmpeg
def test_route_a_real_ffmpeg_failure_is_an_error_too(tmp_path):
    dirs, cache, run = _serve(tmp_path)
    (Path(dirs["output"]) / "broken.mp4").write_bytes(b"not a video " * 100)
    q = {"filename": "broken.mp4"}

    async def check(c):
        r = await c.get("/soundstage/proxy", params=q)
        assert r.status == 202
        st = await _until(c, q, "error", 30)
        assert st["status"] == "error" and st["error"]
        assert str(tmp_path) not in st["error"] and os.path.realpath(tmp_path) not in st["error"], st["error"]
        assert (await c.get("/soundstage/proxy", params=q)).status == 422
    run(check)
    assert not os.path.isdir(cache.folder) or os.listdir(cache.folder) == [], "no proxy and no .partial"


def test_route_rejects_bad_requests_with_400_and_404(tmp_path):
    fake = _Fake()
    dirs, cache, run = _serve(tmp_path, make=fake)
    (Path(dirs["output"]) / "take.mp4").write_bytes(b"x")
    (Path(dirs["output"]) / "still.png").write_bytes(b"x")
    (tmp_path / "secret.mp4").write_bytes(b"x")
    os.makedirs(cache.folder)
    (Path(cache.folder) / ("0" * 40 + ".mp4")).write_bytes(b"x")
    cases = [({"filename": "../secret.mp4"}, 400), ({"filename": "..\\secret.mp4"}, 400),
             ({"filename": "secret.mp4", "subfolder": ".."}, 400), ({"filename": "secret.mp4", "subfolder": "x/../.."}, 400),
             ({"filename": str(tmp_path / "secret.mp4")}, 400), ({"filename": "secret.mp4", "subfolder": str(tmp_path)}, 400),
             ({"filename": "C:secret.mp4"}, 400), ({"filename": "take.mp4", "subfolder": "C:/"}, 400),
             ({"filename": "take.mp4", "type": "models"}, 400), ({"filename": "take.mp4", "w": "800"}, 400),
             ({"filename": "take.mp4", "w": "big"}, 400), ({"filename": "still.png"}, 400), ({}, 400),
             ({"filename": "0" * 40 + ".mp4", "subfolder": P.CACHE_SUB, "type": "temp"}, 400),
             ({"filename": "missing.mp4"}, 404), ({"filename": "take.mp4", "subfolder": "nope"}, 404)]

    async def check(c):
        for params, code in cases:
            for route in ("/soundstage/proxy", "/soundstage/proxy/status"):
                r = await c.get(route, params=params)
                body = await r.json()
                assert r.status == code, (route, params, r.status, body)
                assert body["status"] == "error" and body["error"]
                assert os.path.realpath(tmp_path) not in body["error"], "no server paths in the message"
    run(check)
    assert fake.calls == [], "nothing was transcoded"


def test_proxy_routes_are_registered_with_the_pack():
    src = (ROOT / "soundstage" / "routes.py").read_text(encoding="utf-8")
    assert "from . import proxy as _proxy" in src and "_proxy.register()" in src


# ------------------------------------------------------------------------------------------- short GOP for new takes

def _core_like_take(path, crf=14, seconds=3, extra=()):
    """What SoundstageSaveVideo's core save_to writes: x264 at a CRF with x264's default GOP (one keyframe for a short
    take), BT.709 tags with the sRGB transfer, AAC sound and the workflow/prompt/recipe as mp4 metadata."""
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size=320x176:rate=24:duration={seconds}",
           "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}", "-c:a", "aac", "-shortest",
           "-c:v", "libx264", "-crf", str(crf), "-x264-params", "keyint=250:scenecut=0", "-pix_fmt", "yuv420p",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-color_range", "tv",
           *extra, "-movflags", "use_metadata_tags+faststart",
           "-metadata", 'prompt={"9": {"class_type": "SoundstageSaveVideo"}}',
           "-metadata", 'soundstage={"rung": "final", "shot": {"name": "Wide · 1"}}', str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


@needs_ffmpeg
def test_short_gop_gives_a_keyframe_every_24_frames_and_keeps_crf_sound_metadata(tmp_path):
    take = _core_like_take(tmp_path / "final_00001_.mp4", crf=14)
    keys, n = _keyframes(take)
    assert keys == [0] and n == 72, "precondition: like core save_to, one keyframe for the whole take"
    before, before_x264, before_md5 = _info(take), _x264(take), _audio_md5(take)
    assert before_x264["crf"] == "14.0" and before_x264["keyint"] == "250"

    assert P.short_gop(take, 14) is True
    assert _longest_gop(take) <= 24
    keys, n2 = _keyframes(take)
    assert n2 == n and keys[:3] == [0, 24, 48]
    after = _info(take)
    after_x264 = _x264(take)
    assert after_x264["crf"] == "14.0" and after_x264["keyint"] == "24", "same CRF, short GOP"
    assert _audio_md5(take) == before_md5, "the sound is copied, not re-encoded"
    tags_b, tags_a = before["format"]["tags"], after["format"]["tags"]
    for k in ("prompt", "soundstage"):
        assert tags_a[k] == tags_b[k], k
    vb = next(s for s in before["streams"] if s["codec_type"] == "video")
    va = next(s for s in after["streams"] if s["codec_type"] == "video")
    for k in ("width", "height", "pix_fmt", "profile", "color_range", "color_space", "color_transfer",
              "color_primaries", "r_frame_rate", "nb_frames"):
        assert va.get(k) == vb.get(k), k
    assert abs(float(after["format"]["duration"]) - float(before["format"]["duration"])) < 0.05
    atoms = _atoms(take)
    assert atoms.index("moov") < atoms.index("mdat"), "still faststart"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["final_00001_.mp4"], "no .partial left behind"


@needs_ffmpeg
def test_short_gop_keeps_a_10_bit_take_10_bit(tmp_path):
    try:
        take = _core_like_take(tmp_path / "ten.mp4", crf=12, seconds=2, extra=("-pix_fmt", "yuv420p10le"))
    except subprocess.CalledProcessError:
        pytest.skip("this ffmpeg's x264 has no 10-bit")
    if next(s for s in _info(take)["streams"] if s["codec_type"] == "video")["pix_fmt"] != "yuv420p10le":
        pytest.skip("this ffmpeg's x264 has no 10-bit")
    assert P.short_gop(take, 12) is True
    v = next(s for s in _info(take)["streams"] if s["codec_type"] == "video")
    assert v["pix_fmt"] == "yuv420p10le" and _longest_gop(take) <= 24


@needs_ffmpeg
def test_short_gop_leaves_the_file_as_it_was_when_it_cannot(tmp_path, monkeypatch):
    bad = tmp_path / "broken.mp4"
    bad.write_bytes(b"not a video " * 100)
    assert P.short_gop(str(bad), 14) is False
    assert bad.read_bytes() == b"not a video " * 100
    take = _core_like_take(tmp_path / "t.mp4", seconds=1)
    data = Path(take).read_bytes()
    from soundstage.cut import assemble as A

    def missing(name):
        raise RuntimeError(f"{name} not found on PATH")
    monkeypatch.setattr(A, "_exe", missing)
    assert P.short_gop(take, 14) is False and Path(take).read_bytes() == data
    assert sorted(p.name for p in tmp_path.iterdir()) == ["broken.mp4", "t.mp4"]


def test_save_final_gives_new_takes_a_short_gop_after_saving():
    src = (ROOT / "soundstage" / "nodes_quality.py").read_text(encoding="utf-8")
    cls = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.ClassDef) and n.name == "SoundstageSaveVideo")
    ex = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "execute")
    calls = [n for n in ast.walk(ex) if isinstance(n, ast.Call)]
    save = next(n for n in calls if getattr(n.func, "attr", "") == "save_to")
    gop = next(n for n in calls if getattr(n.func, "id", "") == "short_gop")
    assert gop.lineno > save.lineno, "after core save_to wrote the file"
    assert ast.unparse(gop.args[0]) == ast.unparse(save.args[0]), "the same file"
    assert ast.unparse(gop.args[1]) == "crf" and any(k.arg == "crf" and ast.unparse(k.value) == "crf" for k in save.keywords)
