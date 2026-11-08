"""Reshoot a take from a new camera position (docs/reshoot.md).

run() is the whole job, called by the route (soundstage/handoff/routes.py) and the MCP tool:
  1. plate    the take at 24 fps, 8k+1 frames, shorter side <= 720 (ffmpeg, CPU)
  2. depth    Depth Anything 3 on every frame (one queued GPU job; cached per take, so a second move is free)
  3. warp     every frame into the new camera (plan.warp, CPU): the guide = the new view's depth video, the first frame
              = the warped frame 1, plus a preview of the warp with what had to be invented
  4. render   LTX-2.5 union-control IC (Recast's engine) with the take's own sound (one queued GPU job)
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

from . import graphs as G
from . import plan as P

SUB = "soundstage_private/reshoot"
MAX_FRAMES = 161
MAX_SHORT = 720


def _ff() -> str:
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("ffmpeg is not installed")
    return ff


def plate_frames(n_src: int, fps_src: float, max_frames: int = MAX_FRAMES) -> int:
    """Frames of the 24 fps plate: the clip's length at 24 fps, cut to 8k+1, at most max_frames."""
    n = int(round(n_src * 24.0 / max(fps_src, 1e-6)))
    n = max(9, min(max_frames, n))
    return (n - 1) // 8 * 8 + 1


def plate_size(w: int, h: int, short: int = MAX_SHORT) -> tuple[int, int]:
    k = min(1.0, short / max(1, min(w, h)))
    return max(64, int(round(w * k / 16)) * 16), max(64, int(round(h * k / 16)) * 16)


def make_plate(src: str, dst: str, frames: int, size: tuple[int, int]) -> str:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    w, h = size
    cmd = [_ff(), "-v", "error", "-y", "-i", src, "-vf", f"fps=24,scale={w}:{h}:flags=lanczos", "-frames:v", str(frames),
           "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-b:a", "192k", "-t", f"{frames / 24.0:.6f}"]
    cmd += [dst]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"could not make the plate: {r.stderr.strip()[-300:]}")
    return dst


def has_audio(path: str) -> bool:
    fp = shutil.which("ffprobe")
    if not fp:
        return False
    r = subprocess.run([fp, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=60)
    return bool(r.stdout.strip())


def read_rgb(path: str, w: int, h: int, frames: int) -> np.ndarray:
    r = subprocess.run([_ff(), "-v", "error", "-i", path, "-an", "-vf", f"scale={w}:{h}:flags=area", "-frames:v", str(frames),
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=600)
    if r.returncode != 0 and not r.stdout:
        raise RuntimeError(r.stderr.decode(errors="ignore")[-300:])
    n = len(r.stdout) // (w * h * 3)
    return np.frombuffer(r.stdout[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)


def write_video(frames: np.ndarray, dst: str, fps: float = 24.0, crf: int = 10) -> str:
    """[N,H,W] or [N,H,W,3] uint8 -> H.264 MP4 (near lossless; the guides must not band)."""
    arr = np.asarray(frames, np.uint8)
    if arr.ndim == 3:
        arr = np.repeat(arr[..., None], 3, -1)
    n, h, w, _ = arr.shape
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    p = subprocess.Popen([_ff(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
                          "-i", "-", "-c:v", "libx264", "-crf", str(crf), "-preset", "medium", "-pix_fmt", "yuv420p", dst],
                         stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    _, err = p.communicate(arr.tobytes(), timeout=600)
    if p.returncode != 0:
        raise RuntimeError(err.decode(errors="ignore")[-300:])
    return dst


def write_png(rgb: np.ndarray, dst: str) -> str:
    from PIL import Image
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(np.asarray(rgb, np.uint8)).save(dst)
    return dst


def scale_K(K: np.ndarray, w: int, h: int) -> np.ndarray:
    """DA3's intrinsics at the depth's own size."""
    K = np.asarray(K, np.float64).copy()
    if K[0, 2] > 0 and abs(K[0, 2] * 2 - w) > 2:
        sx, sy = w / (2 * K[0, 2]), h / (2 * K[1, 2])
        K[0] *= sx
        K[1] *= sy
    return K


GUIDE_SHORT = 544          # the union-control guide's own size (footage/graphs.guide_size)


def _nearest(a: np.ndarray, h2: int, w2: int) -> np.ndarray:
    """Nearest-pixel resize (depth must never be averaged across an edge)."""
    h, w = a.shape[:2]
    ys = np.minimum(((np.arange(h2) + 0.5) * h / h2).astype(int), h - 1)
    xs = np.minimum(((np.arange(w2) + 0.5) * w / w2).astype(int), w - 1)
    return a[ys][:, xs]


def warp_clip(rgb: np.ndarray, depth: np.ndarray, K: np.ndarray, move: dict, guide_short: int = GUIDE_SHORT,
              guide_kind: str = "edges") -> dict:
    """Every frame into the new camera, at about the guide's size (it is resized to that anyway); frame 1 again at the
    full size (it is the render's first picture). Returns guide (uint8 [N,h,w]), first (warped frame 1, full size),
    preview (the warp at guide size, invented areas tinted magenta), hole share, pivots."""
    n = min(len(rgb), len(depth))
    piv = P.smooth([P.pivot_depth(depth[i]) for i in range(n)])
    H, W = depth.shape[1:]
    s = min(1.0, guide_short / min(H, W))
    h2, w2 = max(8, int(round(H * s))), max(8, int(round(W * s)))
    sx, sy = w2 / W, h2 / H
    Ks = K.copy()
    Ks[0, 0] *= sx
    Ks[1, 1] *= sy
    Ks[0, 2] = (K[0, 2] + 0.5) * sx - 0.5
    Ks[1, 2] = (K[1, 2] + 0.5) * sy - 0.5
    small = (h2, w2) != (H, W)
    w_rgb, w_dep, holes = [], [], []
    for i in range(n):
        c, z, hole = P.warp(_nearest(rgb[i], h2, w2), _nearest(depth[i], h2, w2), Ks, move, piv[i])
        w_rgb.append(c)
        w_dep.append(z)
        holes.append(hole)
    near, far = P.clip_range(w_dep)
    guide = np.stack([P.edge_image(c) for c in w_rgb]) if guide_kind == "edges" else \
        np.stack([P.depth_image(z, near, far) for z in w_dep])
    preview = np.stack(w_rgb).copy()
    for i, hole in enumerate(holes):
        preview[i][hole] = (0.5 * preview[i][hole] + np.array([128, 0, 128]) * 0.5).astype(np.uint8)
    first = P.warp(rgb[0], depth[0], K, move, piv[0])[0] if small else w_rgb[0]
    return {"guide": guide, "first": first, "preview": preview, "holes": P.hole_share(holes), "hole_maps": holes,
            "pivot": [round(float(x), 4) for x in piv[:: max(1, n // 8)]]}


def recipe_prompt(path: str) -> str:
    """The take's own scene words (its prompt tag's longest positive text), to keep it the same shot."""
    try:
        from ..takecheck import video as V
        tags = V.probe(path).get("tags") or {}
        pr = json.loads(tags.get("prompt") or "{}")
    except Exception:  # noqa: BLE001
        return ""
    texts = [str((n.get("inputs") or {}).get("text") or "") for n in pr.values()
             if isinstance(n, dict) and n.get("class_type") in ("CLIPTextEncode", "SoundstageGenerateVideo")]
    texts = [t for t in texts if t and not any(w in t.lower()[:80] for w in ("blurry", "low quality", "worst", "pc game"))]
    return max(texts, key=len)[:1200] if texts else ""


READ_PREFIX = "rs_read_"     # output/soundstage_v2s/rs_read_<sha16>.json: Reshoot's own inventory read of a stock clip


def _out_dir(out_dir: str | None) -> str | None:
    if out_dir is not None:
        return out_dir
    try:
        import folder_paths
        return folder_paths.get_output_directory()
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return None


def stock_scene_words(path: str, out_dir: str | None = None, sha: str | None = None) -> str:
    """Scene words for a clip with no recipe prompt (a stock clip), from a vision read of THAT clip: its Video → 3D
    rebuild (its look hint, else words from its read) or Reshoot's own inventory read of it (stock_inventory_words).
    A record is matched by the clip's content hash, else its real path, never by the file name alone
    (video2stage.stages.matches); the newest match wins. '' when nothing has read this clip."""
    import glob

    from ..video2stage import scenewords as SW
    from ..video2stage import stages as ST
    out_dir = _out_dir(out_dir)
    if not out_dir:
        return ""
    if sha is None:
        try:
            sha = ST.content_hash(path)
        except OSError:
            sha = None
    best, t_best = "", -1.0
    for f in glob.glob(os.path.join(out_dir, ST.SUBDIR, "v2s_*_stages.json")) + \
            glob.glob(os.path.join(out_dir, ST.SUBDIR, f"{READ_PREFIX}*.json")):
        try:
            with open(f) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if not ST.matches(rec, path, sha):
            continue
        words = str(rec.get("scene_words") or "") or SW.from_read((rec.get("breakdown") or {}).get("read")) or \
            SW.from_read(rec.get("inventory"))
        t = os.path.getmtime(f)
        if words and t > t_best:
            best, t_best = words, t
    return best[:1200]


def scene_text(prompt: str, path: str, notes: list | None = None, out_dir: str | None = None) -> str:
    """The scene words for the render: the user's prompt, else the take's own recipe prompt, else (a stock clip) the
    words a vision read of the same clip gave. '' when there is none yet (scene_words then reads the clip)."""
    if prompt and prompt.strip():
        return prompt
    rp = recipe_prompt(path)
    if rp:
        return rp
    sw = stock_scene_words(path, out_dir)
    if sw and notes is not None:
        notes.append("no recipe prompt in the clip (stock footage): the scene words come from a vision read of it")
    return sw


def inventory_model(list_files) -> str | None:
    from ..video2stage import vlm
    try:
        names = set(list_files("text_encoders") or [])
    except Exception:  # noqa: BLE001
        return None
    return next((m for m in vlm.INVENTORY_MODELS if m in names), None)


async def stock_inventory_words(base_url: str, rgb: np.ndarray, path: str, *, model: str, in_dir: str, sub: str,
                                tag: str, out_dir: str | None = None, run_graph=None, sha: str | None = None,
                                notes: list | None = None) -> str:
    """A stock clip nothing has read yet: the Qwen3-VL inventory (vlm.inventory_prompt, one queued job) over 6 of the
    plate's frames, turned into scene words (scenewords.from_read) and kept in output/soundstage_v2s/rs_read_*.json by
    the clip's content hash, so the next Reshoot of it needs no GPU for this. '' when the read gives nothing."""
    from ..video2stage import queue as Q
    from ..video2stage import scenewords as SW
    from ..video2stage import stages as ST
    from ..video2stage import vlm
    rg = run_graph or Q.run_graph
    fr = vlm.inventory_frames(len(rgb))
    names = []
    for i in fr:
        name = f"{tag}_inv_{i:03d}.png"
        await asyncio.to_thread(write_png, rgb[i], os.path.join(in_dir, name))
        names.append(f"{sub}/{name}")
    out, _ = await rg(base_url, vlm.inventory_prompt(model, names), "inventory", timeout_s=1800)
    reads = []
    for k, f in enumerate(fr):
        try:
            r = vlm.parse_inventory(Q.text_of(out, f"r{k}"), f)
        except (ValueError, KeyError, TypeError):
            continue
        if not vlm.needs_retry(r):
            reads.append(r)
    if not reads:
        return ""
    inv = vlm.merge_inventory(reads)
    words = SW.from_read(inv)[:1200]
    od = _out_dir(out_dir)
    if words and od:
        if sha is None:
            sha = await asyncio.to_thread(ST.content_hash, path)
        p = os.path.join(od, ST.SUBDIR, f"{READ_PREFIX}{sha[:16]}.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            json.dump({"source_sha": sha, "source_path": os.path.realpath(path), "model": model, "inventory": inv,
                       "scene_words": words}, fh)
    return words


async def scene_words(base_url: str, prompt: str, path: str, rgb: np.ndarray, *, notes: list, list_files, in_dir: str,
                      sub: str, tag: str, out_dir: str | None = None, run_graph=None) -> str:
    """scene_text, and for a stock clip that nothing has read: the inventory read now (when Qwen3-VL is installed)."""
    text = await asyncio.to_thread(scene_text, prompt, path, notes, out_dir)
    if text:
        return text
    model = inventory_model(list_files)
    if not model:
        notes.append("no recipe prompt in the clip, no vision read of it and no Qwen3-VL to read it: the render has "
                     "only the camera words")
        return ""
    try:
        words = await stock_inventory_words(base_url, rgb, path, model=model, in_dir=in_dir, sub=sub, tag=tag,
                                            out_dir=out_dir, run_graph=run_graph, notes=notes)
    except Exception as exc:  # noqa: BLE001 - the render still runs on the camera words
        notes.append(f"no recipe prompt in the clip; the vision read of it failed ({exc}): only the camera words")
        return ""
    notes.append(f"no recipe prompt in the clip (stock footage): {model.split('_fp8')[0]} read it for the scene words"
                 if words else "no recipe prompt in the clip and the vision read named nothing: only the camera words")
    return words


def move_tag(move: dict) -> str:
    return hashlib.sha1(json.dumps(move, sort_keys=True).encode()).hexdigest()[:6]


async def run(base_url: str, source: str, move: dict, *, quality: str = "Draft", seed: int = 7, prompt: str = "",
              keep_sound: bool = True, progress=None, list_files=None, render: bool = True, guide: str = "edges",
              frame_edges: bool = True) -> dict:
    """The whole Reshoot. source: an annotated reference ("sub/x.mp4 [output]"). Returns {file?, preview, first,
    guide, move, words, holes, notes, timings}."""
    import folder_paths

    from ..footage import graphs as FG
    from ..video2stage import graphs as VG
    from ..video2stage import queue as Q
    from ..takecheck import video as V

    say = progress or (lambda step, frac: None)
    t0 = time.perf_counter()
    timings: dict = {}
    mv, notes = P.clamp(move)
    if P.is_identity(mv):
        raise ValueError("pick a move first: orbit, tilt, dolly or lens")
    path = folder_paths.get_annotated_filepath(source)
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                           folder_paths.get_temp_directory())]
    real = os.path.realpath(path or "")
    if not path or not any(real.startswith(r + os.sep) for r in roots) or not os.path.isfile(real):
        raise ValueError(f"{source}: not a file in ComfyUI's input, output or temp folders")
    info = V.probe(real)
    tag = hashlib.sha1(f"{source}:{os.path.getsize(real)}:{os.path.getmtime(real)}".encode()).hexdigest()[:10]
    in_dir = os.path.join(folder_paths.get_input_directory(), SUB)
    nf = plate_frames(info["frames"], info["fps"])
    size = plate_size(info["width"], info["height"])
    plate_name = f"{tag}_plate.mp4"
    plate_path = os.path.join(in_dir, plate_name)
    plate_ref = f"{SUB}/{plate_name} [input]"
    say("Making the plate", 0.03)
    if not os.path.isfile(plate_path):
        await asyncio.to_thread(make_plate, real, plate_path, nf, size)

    lf = list_files or (lambda folder: folder_paths.get_filename_list(folder) or [])
    model, _ = VG.pick_model(lf("geometry_estimation"))
    if not model:
        raise RuntimeError("Depth Anything 3 is not on this server (models/geometry_estimation)")
    npz_path = os.path.join(folder_paths.get_output_directory(), "soundstage_v2s", f"rs_{tag}.npz")
    if not os.path.isfile(npz_path):
        say("Measuring the take in 3D (Depth Anything 3)", 0.08)
        out, t = await Q.run_graph(base_url, G.depth_prompt(plate_ref, model, f"rs_{tag}"), "depth", timeout_s=1200)
        timings["depth_ms"] = t.get("exec_ms", t["total_ms"])
        npz_path = Q.text_of(out, "npz") or npz_path
    else:
        notes.append("depth: measured before (cached), no GPU")
    with np.load(npz_path, allow_pickle=False) as z:
        depth = z["depth"].astype(np.float32)
        K0 = np.asarray(z["intrinsics"][0], np.float64)
    n, dh, dw = depth.shape
    say("Moving the camera (warping every frame)", 0.25)
    t1 = time.perf_counter()
    rgb = await asyncio.to_thread(read_rgb, plate_path, dw, dh, n)
    K = scale_K(K0, dw, dh)
    wc = await asyncio.to_thread(warp_clip, rgb, depth, K, mv, GUIDE_SHORT, guide)
    if frame_edges:
        z = P.auto_frame(wc["hole_maps"])
        if z > 1.01:   # push the frame-edge reveals out of the picture (a touch longer lens), then warp again
            mv = dict(mv, lens=round(min(P.LIMITS["lens"][1], mv["lens"] * z), 3))
            notes.append(f"framed {z:.2f}x tighter so the strip the original camera never saw stays out of the picture")
            wc = await asyncio.to_thread(warp_clip, rgb, depth, K, mv, GUIDE_SHORT, guide)
    mt = move_tag({**mv, "guide": guide})
    guide_name, first_name, prev_name = f"{tag}_{mt}_guide.mp4", f"{tag}_{mt}_first.png", f"{tag}_{mt}_warp.mp4"
    await asyncio.to_thread(write_video, wc["guide"], os.path.join(in_dir, guide_name))
    await asyncio.to_thread(write_png, wc["first"], os.path.join(in_dir, first_name))
    await asyncio.to_thread(write_video, wc["preview"], os.path.join(in_dir, prev_name), 24.0, 18)
    timings["warp_ms"] = round((time.perf_counter() - t1) * 1000)
    if wc["holes"] > 0.12:
        notes.append(f"{wc['holes'] * 100:.0f}% of the new view was never seen by the original camera and is invented: "
                     "a smaller move stays more real")
    words = P.describe(mv)
    res = {"move": mv, "guide_kind": guide, "words": words, "holes": round(wc["holes"], 4), "notes": notes, "pivot": wc["pivot"],
           "plate": plate_ref, "guide": f"{SUB}/{guide_name} [input]", "first": f"{SUB}/{first_name} [input]",
           "preview": f"{SUB}/{prev_name} [input]", "frames": int(n), "size": [dw, dh]}
    if not render:
        res["timings"] = timings
        return res
    weights = FG.resolve(G.RESHOOT_WEIGHTS, lf)
    miss = FG.missing(weights)
    if miss:
        raise RuntimeError("Reshoot needs these models: " + ", ".join(f"{G.RESHOOT_WEIGHTS[r][1][0]}" for r in miss))
    if keep_sound and not has_audio(plate_path):
        keep_sound = False
        notes.append("the take has no sound track: rendered silent")
    text = G.reshoot_prompt(f"the camera {words}", await scene_words(
        base_url, prompt, real, rgb, notes=notes, list_files=lf, in_dir=in_dir, sub=SUB, tag=tag))
    say("Rendering the new angle (LTX-2.5 union control)", 0.35)
    graph = G.render_prompt(weights, plate=plate_ref, guide=res["guide"], first=res["first"], width=dw, height=dh,
                            prompt=text, seed=seed, quality=quality, keep_sound=keep_sound)
    out, t = await Q.run_graph(base_url, graph, "reshoot render", timeout_s=3600)
    timings["render_ms"] = t.get("exec_ms", t["total_ms"])
    saved = (out.get("save") or {})
    f = next((v[0] for k, v in saved.items() if isinstance(v, list) and v and isinstance(v[0], dict)), None)
    if not f:
        raise RuntimeError("the render finished without a video")
    res.update(file=f, prompt=text, quality=quality, seed=int(seed))
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000)
    res["timings"] = timings
    say("Done", 1.0)
    return res
