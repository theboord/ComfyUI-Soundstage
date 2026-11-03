"""Playback proxies: a small copy of a take with a keyframe every 12 frames, so the App's players seek in milliseconds.

A Final or Hollywood take is one GOP (core save_to sets no keyint and x264's default of 250 is longer than the clip),
so every seek decodes from frame 0: in Chrome ~5 ms per frame of distance (48 ms at frame 5, 290 ms at frame 60,
580 ms at frame 112), and the 2624x1408 CRF-12 file streams at ~12 Mbps. A 960-wide GOP-12 proxy seeks in 3-26 ms
(review/d8_player_map_v1.json). New takes also get a short GOP at the source: short_gop(), from SoundstageSaveVideo.

GET /soundstage/proxy?filename=&subfolder=&type=output|input|temp[&w=960]
    -> 200 the proxy (Range requests; Cache-Control: private, max-age=86400) once it is made
    -> 202 {status: "pending", retry_ms, ahead, url} while it is queued or being made: play the source meanwhile
    -> 422 {status: "error", error, url} when it could not be made (the source keeps playing)
    -> 400 bad parameters or a path outside output/input/temp; 404 no such file
GET /soundstage/proxy/status?<the same>   (or the proxy URL with &probe=1)
    -> {status: ready|pending|error, url, error, retry_ms?, ahead?}; starts the proxy when needed, never sends the file

w is 480, 640, 960 (default), 1280 or 1920 and never upscales. `url` is the proxy's own URL, API-relative (it goes
through api.apiURL), with &v=<cache key>: a file re-rendered under the same name gets a new URL in the browser cache.
One transcode runs at a time (the GPU renders on the same machine); other files wait in the order they were asked
for, and repeated requests share one job. Proxies live in <ComfyUI temp>/soundstage_proxy/<sha1>.mp4, written as
.partial and renamed only when complete, capped at 4 GB (SOUNDSTAGE_PROXY_CACHE_GB), least recently used out first.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import subprocess
import time
from urllib.parse import urlencode

TYPES = ("output", "input", "temp")
VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")
WIDTHS = (480, 640, 960, 1280, 1920)
DEFAULT_W = 960
GOP = 12
THREADS = 4                    # the pod renders on the same machine: leave it the rest of the CPU
ENCODER = "x264 veryfast crf23 g12 bf0 aac128k 1"   # in the cache key: change it whenever build_command changes
CACHE_SUB = "soundstage_proxy"
RETRY_MS = 1000
ERROR_TTL = 300                # seconds a failed proxy answers its error before a new request tries again
TIMEOUT = 900
KEYINT = 24                    # short_gop(): new takes get a keyframe at least every 24 frames
GOP_TIMEOUT = 1800
NO_STORE = {"Cache-Control": "no-store"}
_DRIVE = re.compile(r"^[A-Za-z]:")

_REGISTERED = False


# ---------------------------------------------------------------- pure helpers (no ComfyUI imports; unit-tested)

def _cap_bytes() -> int:
    try:
        gb = float(os.environ.get("SOUNDSTAGE_PROXY_CACHE_GB") or 4)
    except ValueError:
        gb = 4.0
    return int(max(gb, 0.0) * (1 << 30))


def _dirs() -> dict:
    import folder_paths
    return {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(),
            "temp": folder_paths.get_temp_directory()}


def _inside(base: str, path: str) -> bool:
    base, path = os.path.normcase(base), os.path.normcase(path)
    try:
        return os.path.commonpath([base, path]) == base
    except ValueError:  # another drive (Windows)
        return False


def resolve(filename: str, subfolder: str = "", kind: str = "output", dirs: dict | None = None) -> str:
    """A ComfyUI file ref -> the real path of an existing video inside output, input or temp.
    ValueError (400): a type other than those three, a name with a folder or drive in it, '..', an absolute subfolder,
    a link that leads out of the folder, or not a video. FileNotFoundError (404): no such file."""
    name, sub = filename or "", (subfolder or "").replace("\\", "/")
    bad = "\x00:" if os.name == "nt" else "\x00"     # ':' would reach NTFS alternate streams
    if kind not in TYPES:
        raise ValueError("type must be output, input or temp")
    if (not name or name in (".", "..") or "/" in name or "\\" in name or _DRIVE.match(name)
            or any(c in name for c in bad)):
        raise ValueError("filename must be a plain file name")
    parts = [p for p in sub.split("/") if p not in ("", ".")]
    if sub.startswith("/") or _DRIVE.match(sub) or ".." in parts or any(c in sub for c in bad):
        raise ValueError("subfolder must be a folder inside output, input or temp")
    if not name.lower().endswith(VIDEO_EXT):
        raise ValueError("not a video file")
    base = (dirs or _dirs()).get(kind)
    if not base:
        raise FileNotFoundError(f"this server has no {kind} folder")
    base = os.path.realpath(base)
    try:   # strict: every link resolved (Windows also folds ".. " and "..." into ".."), or no such file
        path = os.path.realpath(os.path.join(base, *parts, name), strict=True)
    except OSError:  # missing, or a broken / looping link; the message keeps the server's paths out
        raise FileNotFoundError(f"no such file: {name}") from None
    if not _inside(base, path):
        raise ValueError("outside ComfyUI's output, input and temp folders")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"no such file: {name}")
    return path


def parse_w(value) -> int:
    if value in (None, ""):
        return DEFAULT_W
    try:
        w = int(value)
    except (TypeError, ValueError):
        w = 0
    if w not in WIDTHS:
        raise ValueError(f"w must be one of {', '.join(map(str, WIDTHS))}")
    return w


def target_width(src_w, w: int) -> int:
    """The proxy's width: w, or the source's own when it is narrower (never upscale); always even."""
    tw = min(int(w), int(src_w)) if src_w else int(w)
    return max(2, tw - tw % 2)


def cache_key(path: str, w: int) -> str:
    """sha1 of the source (real path, mtime, size), the width and the encoder settings: a re-render is a new key."""
    st = os.stat(path)
    raw = "|".join([os.path.normcase(path), str(st.st_mtime_ns), str(st.st_size), str(w), ENCODER])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def proxy_url(filename: str, subfolder: str, kind: str, w: int, key: str) -> str:
    return "/soundstage/proxy?" + urlencode({"filename": filename, "subfolder": subfolder, "type": kind, "w": w,
                                             "v": key[:12]})


def build_command(src: str, dst: str, width: int, has_audio: bool, ffmpeg: str = "ffmpeg") -> list[str]:
    """H.264 at `width` (height follows, even), a keyframe every GOP frames and no B-frames, so any frame decodes from
    at most 11 others; AAC 128k when the source has sound; no metadata (a take's moov carries ~180 KB of workflow)."""
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", str(THREADS), "-i", src,
           "-map", "0:v:0", "-vf", f"scale={width}:-2:flags=bicubic",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", str(GOP), "-keyint_min", str(GOP),
           "-sc_threshold", "0", "-bf", "0", "-pix_fmt", "yuv420p", "-profile:v", "high"]
    if has_audio:
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    return cmd + ["-map_metadata", "-1", "-movflags", "+faststart", "-threads", str(THREADS), "-f", "mp4", dst]


def _drop(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def transcode(src: str, dst: str, w: int, timeout: float = TIMEOUT) -> dict:
    """Write the proxy of `src` to `dst`: ffmpeg writes `dst`.partial, renamed only when it finished. Blocking."""
    from .cut.assemble import _exe, probe
    try:
        info = probe(src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe could not read the file: {(e.stderr or '').strip()[-300:]}") from None
    if not info.get("width"):
        raise RuntimeError("the file has no video stream")
    width = target_width(info["width"], w)
    part = dst + ".partial"
    t0 = time.perf_counter()
    try:
        r = subprocess.run(build_command(src, part, width, info["has_audio"], _exe("ffmpeg")),
                           capture_output=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {r.stderr.decode('utf-8', 'replace').strip()[-600:]}")
        os.replace(part, dst)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg took longer than {timeout:.0f} s") from None
    finally:
        if os.path.exists(part):
            _drop(part)
    return {"width": width, "seconds": round(time.perf_counter() - t0, 2)}


def short_gop(path: str, crf: int, keyint: int = KEYINT, timeout: float = GOP_TIMEOUT) -> bool:
    """Give an H.264 take a keyframe at least every `keyint` frames, in place. Core save_to has no GOP option, so x264
    keeps its default (one keyframe per 250 frames) and a whole take is one GOP. The picture is re-encoded at the same
    CRF with x264's default preset (medium, as core); sound, metadata (prompt, workflow, the soundstage recipe), colour
    tags and pixel format are copied. On the Hollywood take final_sound_00057_ (2624x1408, CRF 12): PSNR 55.7 dB
    against the original, +11% size, 1.7 s on a 32-thread CPU. Returns False and leaves the file as it was when
    ffmpeg is missing or fails."""
    from .cut.assemble import _exe
    part = path + ".gop.partial"
    try:
        cmd = [_exe("ffmpeg"), "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", path, "-map", "0", "-c", "copy",
               "-c:v", "libx264", "-preset", "medium", "-crf", str(int(crf)), "-g", str(int(keyint)),
               "-map_metadata", "0", "-movflags", "use_metadata_tags+faststart", "-f", "mp4", part]
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode("utf-8", "replace").strip()[-400:])
        os.replace(part, path)
        return True
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        logging.warning("Soundstage: %s keeps its encoder's keyframes (short GOP failed: %s)", path, e)
        return False
    finally:
        if os.path.exists(part):
            _drop(part)


# ---------------------------------------------------------------- the cache and its queue

class Proxies:
    """The proxy folder and its queue: one transcode at a time, one job per key. Tests make their own."""

    def __init__(self, folder: str, cap_bytes: int | None = None, make=None):
        self.folder = folder
        self.cap = _cap_bytes() if cap_bytes is None else int(cap_bytes)
        self.make = make or transcode          # (src, dst, w) -> dict; blocking, so it runs in a worker thread
        self.jobs: dict[str, dict] = {}        # key -> {"state": "pending" | "error", "t", "error"?}
        self.queue: list[str] = []             # pending keys in the order they were asked for; [0] runs first
        self._sem: asyncio.Semaphore | None = None
        self._tasks: set = set()               # the loop keeps only weak references to tasks

    def file(self, key: str) -> str:
        return os.path.join(self.folder, f"{key}.mp4")

    def status(self, key: str) -> dict:
        """{status: ready | pending | error | None (nothing yet)}; starts nothing. Only a complete file is ready."""
        if os.path.isfile(self.file(key)):
            return {"status": "ready"}
        job = self.jobs.get(key)
        if job and job["state"] == "pending":
            ahead = self.queue.index(key) if key in self.queue else 0
            return {"status": "pending", "ahead": ahead, "retry_ms": min(RETRY_MS * (1 + ahead), 10_000)}
        if job and job["state"] == "error" and time.time() - job["t"] < ERROR_TTL:
            return {"status": "error", "error": job["error"]}
        return {"status": None}

    def request(self, src: str, key: str, w: int) -> dict:
        """The status, after queueing a job when the key has neither a proxy nor a job (on the server's loop)."""
        st = self.status(key)
        if st["status"] is None:
            self.jobs[key] = {"state": "pending", "t": time.time()}
            self.queue.append(key)
            task = asyncio.get_running_loop().create_task(self._run(src, key, w))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            st = self.status(key)
        return st

    async def _run(self, src: str, key: str, w: int) -> None:
        if self._sem is None:
            self._sem = asyncio.Semaphore(1)
        try:
            async with self._sem:
                await asyncio.to_thread(self._make, src, key, w)
        except Exception as exc:  # noqa: BLE001 - recorded and answered; the source keeps playing
            msg = str(exc) if isinstance(exc, (RuntimeError, ValueError, OSError)) else f"{type(exc).__name__}: {exc}"
            msg = msg.replace(src, os.path.basename(src)).replace(self.folder + os.sep, "")   # no server paths
            self.jobs[key] = {"state": "error", "t": time.time(), "error": msg[:600] or type(exc).__name__}
            logging.warning("Soundstage: no proxy for %s (w=%s): %s", src, w, msg)
        finally:
            if key in self.queue:
                self.queue.remove(key)
            if self.jobs.get(key, {}).get("state") == "pending":   # made (the file is ready) or cancelled
                self.jobs.pop(key, None)

    def _make(self, src: str, key: str, w: int) -> None:
        os.makedirs(self.folder, exist_ok=True)
        self.make(src, self.file(key), w)
        self.evict(keep=key)

    def touch(self, key: str) -> None:
        """Mark a proxy as just used: its access time moves, its modification time (and so its ETag) stays."""
        try:
            st = os.stat(self.file(key))
            os.utime(self.file(key), ns=(time.time_ns(), st.st_mtime_ns))
        except OSError:
            pass

    def evict(self, keep: str | None = None) -> list[str]:
        """Delete the least recently used proxies until the folder fits the cap; returns the keys removed."""
        files = []
        try:
            for e in os.scandir(self.folder):
                if e.name.endswith(".mp4"):
                    try:
                        st = os.stat(e.path)   # not e.stat(): on Windows that is the directory's cached copy
                    except OSError:
                        continue
                    files.append((max(st.st_atime_ns, st.st_mtime_ns), st.st_size, e.path, e.name[:-4]))
        except OSError:
            return []
        files.sort()
        total, gone = sum(f[1] for f in files), []
        for _, size, path, key in files:
            if total <= self.cap:
                break
            if key == keep:
                continue
            try:
                os.remove(path)
            except OSError:  # being sent right now (Windows keeps it locked): next time
                continue
            total -= size
            gone.append(key)
        return gone

    def clean_partials(self) -> int:
        """Remove the .partial files a stopped server left behind (never served; their jobs are gone)."""
        n = 0
        try:
            for e in os.scandir(self.folder):
                if e.name.endswith(".partial"):
                    _drop(e.path)
                    n += 1
        except OSError:
            pass
        return n


# ---------------------------------------------------------------- routes

def register(routes=None, cache: Proxies | None = None, dirs: dict | None = None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    server_routes = routes is None
    if server_routes:
        from server import PromptServer
        routes = PromptServer.instance.routes
    if cache is None:
        import folder_paths
        cache = Proxies(os.path.join(folder_paths.get_temp_directory(), CACHE_SUB))
    cache.clean_partials()

    def lookup(q):
        """(src, key, w, url), None or None, the 400/404 response."""
        try:
            w = parse_w(q.get("w"))
            kind = q.get("type") or "output"
            src = resolve(q.get("filename", ""), q.get("subfolder", ""), kind, dirs)
            if _inside(os.path.realpath(cache.folder), src):
                raise ValueError("that file is a proxy")
            key = cache_key(src, w)
        except ValueError as e:
            return None, web.json_response({"status": "error", "error": str(e)}, status=400, headers=NO_STORE)
        except OSError as e:  # FileNotFoundError, or the file went between the checks
            msg = str(e) if isinstance(e, FileNotFoundError) else "no such file"
            return None, web.json_response({"status": "error", "error": msg}, status=404, headers=NO_STORE)
        return (src, key, w, proxy_url(q.get("filename", ""), q.get("subfolder", ""), kind, w, key)), None

    def answer(src, key, w, url) -> dict:
        st = cache.request(src, key, w)
        return {**st, "url": url, "error": st.get("error")}

    @routes.get("/soundstage/proxy/status")
    async def proxy_status(request):
        found, err = lookup(request.query)
        if err is not None:
            return err
        return web.json_response(answer(*found), headers=NO_STORE)

    @routes.get("/soundstage/proxy")
    async def proxy(request):
        found, err = lookup(request.query)
        if err is not None:
            return err
        if request.query.get("probe") not in (None, "", "0"):
            return web.json_response(answer(*found), headers=NO_STORE)
        st = answer(*found)
        if st["status"] == "ready":
            cache.touch(found[1])
            return web.FileResponse(cache.file(found[1]), headers={"Content-Type": "video/mp4",
                                                                   "Cache-Control": "private, max-age=86400"})
        return web.json_response(st, status=202 if st["status"] == "pending" else 422, headers=NO_STORE)

    if server_routes:
        _REGISTERED = True
    return True
