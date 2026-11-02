"""Refocus after the render: a focus pull from mark A to mark B at a chosen T-stop on any take, from depth, with no
re-render of the generation (docs/refocus.md).

run() is the whole job, called by the route (soundstage/handoff/routes.py) and, through the one-click relay, the MCP:
  1. depth    the stage's own depth of the shot (sent by the App), or Depth Anything 3 on the take's pixels (one queued
              GPU job on this ComfyUI, cached per take; the model is already on the server, nothing downloads)
  2. focus    marks A (first frame) and B (last frame) tracked through the take, the distance under each read every
              frame and smoothed, the pull eased between them in diopters over the chosen window
  3. render   every frame on the CPU: thin-lens circle of confusion from the focus distance, T-stop and focal length,
              depth-layered disc bokeh in linear light (optics.py, adapted from Hero Frame Rig, MIT), the take's own
              sound copied, the take's recipe kept with a refocus block added
Output: output/soundstage_private/refocus/<take>_rf_<settings>.mp4 (or .png for a still): a new take.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import time

import numpy as np

from . import depth as D
from . import optics as O
from . import plan as P

SUB = "soundstage_private/refocus"
WORK_LONG = 768             # depth and tracking run at this long side (DA3 itself sees 504; edges are snapped at full size)
MAX_PIXELS = 2_500_000_000  # frames x pixels a CPU job takes on (a 1080p take of ~50 s)
STILL_EXT = (".png", ".jpg", ".jpeg", ".webp")
DEFAULT_SUBJECT_M = 2.5
DEFAULT_FOCAL_MM = 35.0
HIGHLIGHT_AMOUNT = 3.0      # "Bright bokeh" (off unless asked): small clipped sources up to 4x before the blur


def _ff(name: str = "ffmpeg") -> str:
    p = shutil.which(name)
    if not p:
        raise RuntimeError(f"{name} is not installed")
    return p


def has_audio(path: str) -> bool:
    fp = shutil.which("ffprobe")
    if not fp:
        return False
    r = subprocess.run([fp, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=60)
    return bool(r.stdout.strip())


def make_plate(src: str, dst: str, size: tuple[int, int], frames: int = 0) -> str:
    """The take at the working size, every frame at its own rate (DA3's input; no retime). The clip loader trims to 8k+1
    frames, so the plate holds its last frame up to the next 8k+1 and nothing of the take is dropped."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    w, h = size
    pad = (-(int(frames) - 1)) % 8 if frames > 0 else 0
    vf = f"scale={w}:{h}:flags=area" + (f",tpad=stop_mode=clone:stop={pad}" if pad else "")
    r = subprocess.run([_ff(), "-v", "error", "-y", "-i", src, "-an", "-vf", vf, "-fps_mode",
                        "passthrough", "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p", dst],
                       capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"could not make the depth plate: {r.stderr.strip()[-300:]}")
    return dst


def read_gray(path: str, w: int, h: int) -> np.ndarray:
    """Every frame as gray uint8 [N,h,w] (tracking, depth steadying)."""
    r = subprocess.run([_ff(), "-v", "error", "-i", path, "-an", "-vf", f"scale={w}:{h}:flags=area", "-fps_mode", "passthrough",
                        "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, timeout=900)
    if r.returncode != 0 and not r.stdout:
        raise RuntimeError(r.stderr.decode(errors="ignore")[-300:])
    n = len(r.stdout) // (w * h)
    return np.frombuffer(r.stdout[: n * w * h], np.uint8).reshape(n, h, w)


def _resize_u8_gray(g: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.clip(O.resize_bilinear(g.astype(np.float32), h, w), 0, 255).astype(np.uint8)


def resolve(source: str) -> str:
    """An annotated reference -> a real path inside ComfyUI's input, output or temp folder (nothing else)."""
    import folder_paths
    path = folder_paths.get_annotated_filepath(source)
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                           folder_paths.get_temp_directory())]
    real = os.path.realpath(path or "")
    if not path or not any(real.startswith(r + os.sep) for r in roots) or not os.path.isfile(real):
        raise ValueError(f"{source}: not a file in ComfyUI's input, output or temp folders")
    return real


def _given(v, key: str):
    """A number the card chose, clamped to its range; "auto", empty, junk or <= 0 -> None (worked out instead)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return P.bounded(x, key, 0) if np.isfinite(x) and x > 0 else None


def settings(body: dict) -> tuple[dict, list[str]]:
    """The card's choices, made safe. -> (settings, notes)."""
    notes: list[str] = []
    a = P.parse_point(body.get("a"), (0.5, 0.5))
    b = P.parse_point(body.get("b"), None)
    s, e, n2 = P.window(body.get("start", 0.25), body.get("land", 0.75))
    notes += n2
    st = {"a": a, "b": b or a, "pull": b is not None and b != a,
          "t_stop": P.bounded(body.get("t_stop"), "t_stop", 2.8),
          "focal_mm": _given(body.get("focal_mm"), "focal_mm"),
          "sensor_mm": P.bounded(body.get("sensor_mm"), "sensor_mm", 36.0) if body.get("sensor_mm") else 36.0,
          "subject_m": _given(body.get("subject_m"), "subject_m"),
          "start": s, "land": e, "highlights": body.get("highlights", False) in (True, "true", "1", 1),
          "depth": body.get("depth") if body.get("depth") in ("stage", "da3") else "auto"}
    return st, notes


def plan_focus(dw: np.ndarray, grays: np.ndarray, st: dict) -> dict:
    """The focus on every frame (diopters) from the two marks, tracked. dw [N,h,w] diopters, grays [N,h,w]."""
    n = len(dw)
    ax, ay = st["a"]
    bx, by = st["b"]
    if n == 1 or not st["pull"]:
        pa = P.track_point(grays, ax, ay, 0) if n > 1 else np.array([[ax, ay]])
        da = P.smooth_series(P.sample_series(dw, pa))
        return {"curve": da, "a_track": pa, "b_track": pa, "d_a": da, "d_b": da}
    pa = P.track_point(grays, ax, ay, 0)
    pb = P.track_point(grays, bx, by, n - 1)
    da = P.smooth_series(P.sample_series(dw, pa))
    db = P.smooth_series(P.sample_series(dw, pb))
    return {"curve": P.focus_curve(da, db, st["start"], st["land"]), "a_track": pa, "b_track": pb, "d_a": da, "d_b": db}


def checks(fp: dict, grays: np.ndarray, st: dict, focal: float, width_px: int) -> list[str]:
    """What the operator should know before trusting the pull. width_px: the frame's width (the sensor's width is
    across it, also for a portrait take)."""
    notes = []
    if st["pull"]:
        da, db = float(fp["d_a"][0]), float(fp["d_b"][-1])
        r = abs(float(O.coc_px(np.array([db]), da, focal_mm=focal, t_stop=st["t_stop"], width_px=width_px,
                               sensor_mm=st["sensor_mm"])[0]))
        if r < 2.0:
            notes.append(f"A and B are at almost the same distance ({_m(da)} and {_m(db)}): at T{st['t_stop']:g} the pull "
                         "barely shows. Open up (a lower T-stop) or pick marks further apart")
        sb = P.sharpness(grays[-1], *st["b"])
        if sb < 0.35:
            notes.append("B is already soft in the picture (the generation blurred it): the pull lands on that blur, "
                         "refocus cannot add detail that is not there")
    sa = P.sharpness(grays[0], *st["a"])
    if sa < 0.35:
        notes.append("A is already soft in the picture: holding focus there cannot sharpen it")
    return notes


def _m(d: float) -> str:
    return "infinity" if d <= 1e-3 else f"{1 / d:.1f} m"


def render_clip(src: str, dst: str, info: dict, dw: np.ndarray, idx: np.ndarray, curve: np.ndarray, focal: np.ndarray,
                st: dict, say=None) -> dict:
    """Decode the take at full size, refocus every frame, encode near-lossless at its own rate, copy its sound."""
    w, h, fps = info["width"], info["height"], info["fps"] or 24.0
    tmp = dst + ".video.mp4"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    dec = subprocess.Popen([_ff(), "-v", "error", "-i", src, "-an", "-fps_mode", "passthrough", "-f", "rawvideo",
                            "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen([_ff(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r",
                            f"{fps:.6f}", "-i", "-", "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt",
                            "yuv420p", "-movflags", "+faststart", tmp], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    size = w * h * 3
    n_total = max(1, int(info.get("frames") or len(curve)))
    hl = HIGHLIGHT_AMOUNT if st["highlights"] else 0.0
    i, r_max, t0 = 0, 0.0, time.perf_counter()
    try:
        while True:
            buf = dec.stdout.read(size)
            if len(buf) < size:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            k = min(i, len(curve) - 1)
            d_full = D.full_size(dw[idx[min(i, len(idx) - 1)]], size=(h, w), native_long=st.get("depth_long", 0))
            stats: dict = {}
            out = O.render_frame(rgb, d_full, float(curve[k]), focal_mm=float(focal[k]), t_stop=st["t_stop"],
                                 sensor_mm=st["sensor_mm"], highlights=hl, stats=stats)
            r_max = max(r_max, stats.get("r_max", 0.0))
            enc.stdin.write(out.tobytes())
            i += 1
            if say:
                say(f"Refocusing frame {i} of {n_total}", 0.3 + 0.65 * min(1.0, i / n_total))
    finally:
        try:
            dec.stdout.close()
        except Exception:  # noqa: BLE001
            pass
        dec.wait(timeout=60)
        try:
            enc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        err = enc.stderr.read().decode(errors="ignore")
        enc.wait(timeout=600)
    if enc.returncode != 0 or not i:
        raise RuntimeError(f"could not write the refocused take: {err[-300:] or 'no frames decoded'}")
    # the take's own sound (untouched, full length) and its tags (ComfyUI's prompt/workflow: the generation it came from)
    base = [_ff(), "-v", "error", "-y", "-i", tmp, "-i", src, "-map", "0:v:0", "-map", "1:a:0?", "-map_metadata", "1", "-c:v", "copy"]
    r = subprocess.run(base + ["-c:a", "copy", "-movflags", "+faststart", dst], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:   # a sound codec MP4 cannot carry as is
        r = subprocess.run(base + ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", dst], capture_output=True, text=True,
                           timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"could not copy the take's sound: {r.stderr.strip()[-300:]}")
    os.remove(tmp)
    return {"frames": i, "r_max_px": round(r_max, 1), "cpu_s": round(time.perf_counter() - t0, 1)}


def render_still(src: str, dst: str, dw: np.ndarray, focus: float, focal: float, st: dict) -> dict:
    from PIL import Image
    rgb = np.asarray(Image.open(src).convert("RGB"))
    t0 = time.perf_counter()
    d_full = D.full_size(dw[0], size=rgb.shape[:2], native_long=st.get("depth_long", 0))
    stats: dict = {}
    out = O.render_frame(rgb, d_full, float(focus), focal_mm=focal, t_stop=st["t_stop"], sensor_mm=st["sensor_mm"],
                         highlights=HIGHLIGHT_AMOUNT if st["highlights"] else 0.0, stats=stats)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(out).save(dst)
    return {"frames": 1, "r_max_px": stats.get("r_max", 0.0), "cpu_s": round(time.perf_counter() - t0, 1)}


def stage_depth(stage: dict, work: tuple[int, int]) -> tuple[np.ndarray, float, np.ndarray | None]:
    """The App's depth16 sheet -> [frames, h, w] diopters at the working size, the shot's fps, per-frame focal mm.
    (Its tile's long side, the size it was rendered at, is stage["tile"].)"""
    from PIL import Image
    ref = str(stage.get("sheet") or "")
    path = resolve(ref)
    tile = stage.get("tile") or [0, 0]
    rgb = np.asarray(Image.open(path).convert("RGB"))
    d = D.decode_sheet(rgb, cols=int(stage.get("cols") or 1), frames=int(stage.get("frames") or 1),
                       tile=(int(tile[0]), int(tile[1])), dmax=float(stage.get("dmax") or D.DMAX))
    focal = stage.get("focal_mm")
    focal = np.asarray(focal, np.float64) if isinstance(focal, list) and focal else (
        np.full(len(d), float(focal)) if isinstance(focal, (int, float)) and focal > 0 else None)
    return D.fit_frames(d, *work), float(stage.get("fps") or 24.0), focal


def shot_lens(body: dict) -> tuple[np.ndarray | None, float]:
    """The open shot's focal length per frame when the App sent it without a depth sheet (Depth Anything 3 with a
    distance given: no stage pass is rendered, but the shot's lens is still the shot's). -> (focal mm per frame, fps)."""
    lens = body.get("lens") if isinstance(body.get("lens"), dict) else {}
    f = lens.get("focal_mm")
    try:
        arr = np.asarray([P.bounded(x, "focal_mm", DEFAULT_FOCAL_MM) for x in f], np.float64) if isinstance(f, list) and f \
            else None
    except TypeError:
        arr = None
    try:
        fps = float(lens.get("fps") or 24.0)
    except (TypeError, ValueError):
        fps = 24.0
    return arr, (fps if np.isfinite(fps) and fps > 0 else 24.0)


def da3_depth(npz_path: str, work: tuple[int, int], n: int, st: dict, body: dict, sdep, grays) -> tuple[np.ndarray, float, str]:
    """Depth Anything 3's export -> [n, h, w] diopters at the working size, scaled so A is a known distance, steadied
    and edge-repaired. CPU work (seconds on a long take): the route runs it off the event loop. -> (diopters, metres
    at A, where that distance came from)."""
    with np.load(npz_path, allow_pickle=False) as z:
        raw = z["depth"].astype(np.float32)
        sky = z["sky"].astype(np.float32) if "sky" in z.files else None
    if raw.shape[1:] != (work[1], work[0]):     # a still at full size, or an older cache
        raw = np.stack([O.resize_bilinear(f, work[1], work[0]) for f in raw])
        sky = None if sky is None else np.stack([O.resize_bilinear(f, work[1], work[0]) for f in sky])
    raw, sky = raw[:n], (None if sky is None else sky[:n])
    if len(raw) < n:                            # pad with the last frame (never expected)
        raw = np.concatenate([raw, np.repeat(raw[-1:], n - len(raw), 0)])
        sky = None if sky is None else np.concatenate([sky, np.repeat(sky[-1:], n - len(sky), 0)])
    inv = D.da3_inverse(raw, sky)
    ax, ay = st["a"]
    subject = st["subject_m"]
    how = "the distance you gave"
    if subject is None and sdep is not None:
        v = P.patch_level(sdep[0], int(round(ax * (work[0] - 1))), int(round(ay * (work[1] - 1))))
        if v > 1e-3:
            subject, how = 1.0 / v, "the stage's distance at A"
    if subject is None and body.get("focus_m"):
        subject, how = P.bounded(body.get("focus_m"), "subject_m", DEFAULT_SUBJECT_M), "the shot's focus distance"
    if subject is None:
        subject, how = DEFAULT_SUBJECT_M, f"a guessed {DEFAULT_SUBJECT_M:g} m (set Distance to A for real optics)"
    dw, _ = D.anchor(inv, ax, ay, subject)
    if n > 1:
        dw = D.smooth_depth(dw, grays)
    dw = np.stack([D.edge_depth(dw[i], grays[i]) for i in range(n)])
    return dw, float(subject), how


def tag_of(st: dict, src_tag: str, depth_src: str) -> str:
    keep = {k: st[k] for k in ("a", "b", "pull", "t_stop", "focal_mm", "sensor_mm", "subject_m", "start", "land", "highlights")}
    return hashlib.sha1(json.dumps({**keep, "src": src_tag, "depth": depth_src}, sort_keys=True).encode()).hexdigest()[:6]


async def run(base_url: str, source: str, body: dict | None = None, *, progress=None, list_files=None) -> dict:
    """The whole Refocus. source: an annotated reference ("sub/x.mp4 [output]"). body: the card's settings
    ({a, b, t_stop, focal_mm, sensor_mm, subject_m, start, land, highlights, depth, stage}). Returns {file, kind, ...}."""
    import folder_paths

    from ..takecheck import recipe as RC
    from ..takecheck import video as V
    from ..video2stage import graphs as VG
    from ..video2stage import queue as Q
    from . import graphs as G

    body = body or {}
    say = progress or (lambda step, frac: None)
    t0 = time.perf_counter()
    timings: dict = {}
    st, notes = settings(body)
    real = resolve(source)
    still = real.lower().endswith(STILL_EXT)
    if still:
        from PIL import Image
        with Image.open(real) as im:
            w, h = im.size
        info = {"width": w, "height": h, "fps": 0.0, "frames": 1}
    else:
        info = await asyncio.to_thread(V.probe, real)
        w, h = info["width"], info["height"]
        if not w or not h:
            raise ValueError(f"{source}: no picture in this file")
        if w * h * max(1, info["frames"]) > MAX_PIXELS:
            raise ValueError("this take is too long to refocus on the CPU in one go (about 50 s of 1080p is the limit)")
    stem = os.path.splitext(os.path.basename(real))[0][:60]
    src_tag = hashlib.sha1(f"{source}:{os.path.getsize(real)}:{os.path.getmtime(real)}".encode()).hexdigest()[:10]
    work = (w, h) if still else D.working_size(w, h, WORK_LONG)
    stage = body.get("stage") if isinstance(body.get("stage"), dict) and body["stage"].get("sheet") else None

    lf = list_files or (lambda folder: folder_paths.get_filename_list(folder) or [])
    model, _ = VG.pick_model(lf("geometry_estimation"))
    want = st["depth"]
    if want == "stage" and not stage:
        raise ValueError("stage depth needs this take's shot open on the stage (or pick Depth Anything 3)")
    if want == "da3" and not model:
        raise RuntimeError("Depth Anything 3 is not on this server (models/geometry_estimation): pick Stage depth")
    use = want if want != "auto" else ("da3" if model else "stage" if stage else "")
    if not use:
        raise RuntimeError("no depth for this take: Depth Anything 3 is not on this server and the shot is not open "
                           "on the stage")

    # 1. depth ---------------------------------------------------------------------------------------------------
    say("Reading the take", 0.03)
    if still:
        from PIL import Image
        g0 = np.asarray(Image.open(real).convert("L"))
        grays = g0[None]
    else:
        grays = await asyncio.to_thread(read_gray, real, *work)
        if not len(grays):
            raise RuntimeError("the take has no frames ffmpeg can read")
    n = len(grays)
    sdep = sfps = sfocal = None
    if stage:
        sdep, sfps, sfocal = await asyncio.to_thread(stage_depth, stage, work)
    if sfocal is None:              # no depth sheet, but the App sent the open shot's lens
        sfocal, lfps = shot_lens(body)
        sfps = sfps or lfps
    if use == "stage":
        idx_s = D.time_map(n, info["fps"] or sfps, len(sdep), sfps) if not still else np.zeros(1, int)
        dw = sdep[idx_s]
        notes.append("depth: the stage's own 3D set (real distances; where the generation drew past the set, such as "
                     "hair, clothes or a sky, the depth is the set's, not the picture's)")
        depth_src = "stage"
        tile = stage.get("tile") or [0, 0]
        st["depth_long"] = min(max(work), max(int(tile[0] or 0), int(tile[1] or 0))) or 0
    else:
        in_dir = os.path.join(folder_paths.get_input_directory(), SUB)
        npz_path = os.path.join(folder_paths.get_output_directory(), "soundstage_v2s", f"rf_{src_tag}.npz")
        if not os.path.isfile(npz_path):
            if still:
                ref = source
            else:
                plate = os.path.join(in_dir, f"{src_tag}_plate.mp4")
                if not os.path.isfile(plate):
                    say("Making the depth plate", 0.05)
                    await asyncio.to_thread(make_plate, real, plate, work, n)
                ref = f"{SUB}/{src_tag}_plate.mp4 [input]"
            say("Measuring depth (Depth Anything 3)", 0.08)
            out, t = await Q.run_graph(base_url, G.depth_prompt(ref, model, f"rf_{src_tag}", still=still), "depth",
                                       timeout_s=1800)
            timings["depth_ms"] = t.get("exec_ms", t["total_ms"])
            npz_path = Q.text_of(out, "npz") or npz_path
        else:
            notes.append("depth: measured before (cached), no GPU")
        say("Steadying the depth", 0.2)
        dw, subject, how = await asyncio.to_thread(da3_depth, npz_path, work, n, st, body, sdep, grays)
        st["depth_long"] = min(max(work), G.DA3_RESOLUTION)    # DA3 measured it at 504 px: its edges are that soft
        notes.append(f"depth: Depth Anything 3 on the picture (relative depth, scaled so A is {subject:.1f} m away, from "
                     f"{how}): the T-stop gives about that much blur, not a measured lens")
        depth_src = "da3"

    # 2. focus ---------------------------------------------------------------------------------------------------
    say("Following the marks", 0.25)
    fp = await asyncio.to_thread(plan_focus, dw, grays, st)
    curve = np.asarray(fp["curve"], np.float64)
    if st["focal_mm"]:
        focal = np.full(n, st["focal_mm"])
        lens_from = "card"
    elif sfocal is not None and len(sfocal):
        focal = sfocal[D.time_map(n, info["fps"] or sfps, len(sfocal), sfps)] if not still else sfocal[:1]
        lens_from = "shot"
    else:
        focal = np.full(n, DEFAULT_FOCAL_MM)
        lens_from = "default"
        notes.append(f"lens: {DEFAULT_FOCAL_MM:g} mm assumed (the take carries no lens): pick the lens for real optics")
    notes += checks(fp, grays, st, float(focal[0]), w)     # the sensor's width is across the frame's width

    # 3. render --------------------------------------------------------------------------------------------------
    tag = tag_of(st, src_tag, depth_src)
    out_dir = os.path.join(folder_paths.get_output_directory(), SUB)
    name = f"{stem}_rf_{tag}{'.png' if still else '.mp4'}"
    dst = os.path.join(out_dir, name)
    say("Refocusing", 0.3)
    if still:
        stats = await asyncio.to_thread(render_still, real, dst, dw, float(curve[0]), float(focal[0]), st)
    else:
        stats = await asyncio.to_thread(render_clip, real, dst, info, dw, np.arange(n), curve, focal, st, say)
    timings["render_ms"] = round(stats["cpu_s"] * 1000)
    block = {"version": 1, "from": source, "depth": depth_src, "t_stop": st["t_stop"], "focal_mm": round(float(focal[0]), 1),
             "lens_from": lens_from, "sensor_mm": st["sensor_mm"], "a": list(st["a"]), "b": list(st["b"]),
             "start": st["start"], "land": st["land"], "highlights": st["highlights"],
             "focus_m": [round(1 / d, 3) if d > 1e-3 else None for d in curve[:: max(1, n // 24)]]}
    if not still:
        try:
            src_recipe = dict(await asyncio.to_thread(RC.read, real) or {})
            src_recipe.pop("source", None)            # how it was read back, not part of the recipe
            if isinstance(src_recipe.get("refocus"), dict):   # a refocus of a refocus: keep the chain
                block["after"] = src_recipe["refocus"]
            await asyncio.to_thread(RC.embed, dst, {**src_recipe, "refocus": block})
        except Exception as exc:  # noqa: BLE001 - the take is fine without it
            notes.append(f"the recipe tag could not be written ({exc})")
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000)
    say("Done", 1.0)
    return {"file": {"filename": name, "subfolder": SUB, "type": "output"}, "kind": "still" if still else "clip",
            "depth": depth_src, "focus": block, "notes": notes, "stats": stats, "timings": timings, "frames": n,
            "a_track": [[round(float(x), 4), round(float(y), 4)] for x, y in fp["a_track"][:: max(1, n // 24)]],
            "b_track": [[round(float(x), 4), round(float(y), 4)] for x, y in fp["b_track"][:: max(1, n // 24)]]}
