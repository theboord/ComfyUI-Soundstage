"""Write a Layer Pack folder. Pure numpy/PIL + ffmpeg; no ComfyUI imports, so it is testable alone.

Folder layout (docs/layerpack.md has the full story):
  <root>/manifest.json, README.txt
  layers/<zz>_<name>/png/<name>.1001.png (RGBA, straight alpha, sRGB)
                     matte/<name>_matte.1001.png (16-bit grey)  and  <name>_4444.mov
  aovs/depth/depth.1001.exr (Z, float32 metres) + depth_vis/depth_vis.1001.png
  camera/camera.json, camera.chan
  dcc/ae/build_comp.jsx, dcc/blender/build_blender_scene.py, dcc/nuke/build_nuke.py,
  dcc/photoshop/<shot>_<frame>.psd, dcc/resolve/<shot>.otio
  multilayer/<shot>.1001.exr (optional), preview/comp_preview.mp4, preview/contact_sheet.png
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import numpy as np
from PIL import Image

from ..footage import sourcespec
from . import camera as cammath
from . import dcc
from .exr import FLOAT, srgb_to_linear, write_exr
from .pack import LayerPack, fit, frame, safe_name
from .psd import write_psd

VERSION = "0.1"
DEFAULTS = dict(prores=True, psd=True, camera=True, ae=True, blender=True, nuke=True, otio=True,
                multilayer_exr=False, comp_preview=True, match_source=True, source=None)


def _scene_source(camera):
    """The source spec a scene carries (Video -> Stage: reference.source; a backdrop plate: backdrop.source)."""
    try:
        c = json.loads(camera) if isinstance(camera, str) else camera
    except (TypeError, ValueError):
        return None
    if not isinstance(c, dict):
        return None
    return (c.get("reference") or {}).get("source") or (c.get("backdrop") or {}).get("source")


def _fill(img: np.ndarray, w: int, h: int, resample=Image.LANCZOS) -> np.ndarray:
    """Scale an HxW(xC) float frame to cover w x h (lanczos by default) and centre-crop the overflow."""
    ih, iw = img.shape[:2]
    if (iw, ih) == (w, h):
        return img
    k = max(w / iw, h / ih)
    sw, sh = max(w, int(round(iw * k))), max(h, int(round(ih * k)))

    def one(ch):
        return np.asarray(Image.fromarray(np.ascontiguousarray(ch, dtype=np.float32)).resize((sw, sh), resample),
                          dtype=np.float32)
    out = one(img) if img.ndim == 2 else np.stack([one(img[..., c]) for c in range(img.shape[2])], axis=-1)
    x0, y0 = (sw - w) // 2, (sh - h) // 2
    return out[y0:y0 + h, x0:x0 + w]


def _fps_arg(fps: float) -> str:
    for nominal in (24, 30, 60, 48, 120):
        if abs(fps - nominal * 1000 / 1001) < 0.01:
            return f"{nominal * 1000}/1001"
    f = Fraction(fps).limit_denominator(1001)
    return f"{f.numerator}/{f.denominator}"


def _timecode(frame: int, fps: float) -> str:
    r = max(1, int(round(fps)))
    s, ff = divmod(frame, r)
    m, ss = divmod(s, 60)
    hh, mm = divmod(m, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def _u8(x: np.ndarray) -> np.ndarray:
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def _blend(comp: np.ndarray, rgba: np.ndarray, mode: str) -> np.ndarray:
    """Composite one straight-alpha layer onto an opaque-or-not comp (display-referred, 0..1)."""
    rgb, a = rgba[..., :3], rgba[..., 3:4]
    base = comp[..., :3]
    if mode == "multiply":
        mixed = base * rgb
    elif mode == "screen":
        mixed = 1 - (1 - base) * (1 - rgb)
    elif mode == "add":
        mixed = np.clip(base + rgb, 0, 1)
    else:
        mixed = rgb
    out = comp.copy()
    out[..., :3] = base * (1 - a) + mixed * a
    out[..., 3:4] = comp[..., 3:4] + a * (1 - comp[..., 3:4])
    return out


def _checker(h: int, w: int, size: int = 16) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // size) + (xx // size)) % 2).astype(np.float32) * 0.15 + 0.35
    return np.repeat(c[..., None], 3, axis=2)


def _ffmpeg(args: list[str]) -> None:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH")
    p = subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip()[-800:])


def _bt709() -> list[str]:
    # RGB -> YUV with the Rec.709 matrix (ffmpeg's default is 601, which shifts colours) and tag it.
    return ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]


class _Status(dict):
    def run(self, key: str, fn, *a, **kw):
        try:
            fn(*a, **kw)
            self[key] = "ok"
        except Exception as e:  # one failed format must never lose the rest of the pack
            self[key] = f"error: {e}"
            traceback.print_exc()


def export_pack(pack: LayerPack, out_dir: str, *, hero_frame: int = -1, timestamp: str | None = None,
                **options) -> dict:
    """Write the pack. Returns {"root", "manifest", "preview" (HxWx3 float32 contact sheet)}."""
    opt = {**DEFAULTS, **options}
    if not pack.layers:
        raise ValueError("The Layer Pack has no layers. Add at least one with Layer Pack: Add Layer.")
    gW, gH = pack.resolution()
    N = pack.length()
    fs = int(pack.frame_start)
    gen_fps = float(pack.fps)
    # Deliver at source spec (docs/source_fidelity.md): the size, rate and timecode of the footage the shot came from.
    spec = None
    if opt["match_source"]:
        spec = opt["source"] or (pack.meta or {}).get("source") or _scene_source(pack.camera)
        if isinstance(spec, str):
            try:
                spec = json.loads(spec) if spec.strip() else None
            except ValueError:
                spec = None
        spec = spec if isinstance(spec, dict) else None
    plan = sourcespec.deliver_plan(spec, gW, gH, gen_fps)
    W, H, fps = plan["width"], plan["height"], float(plan["fps"])
    scaled = (W, H) != (gW, gH)

    def up(a, resample=Image.LANCZOS):
        return _fill(a, W, H, resample) if scaled else a
    shot = safe_name(pack.shot)
    stamp = timestamp or _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    root = os.path.join(out_dir, f"{shot}_{stamp}")
    os.makedirs(root, exist_ok=True)
    hero = (N // 2) if hero_frame < 0 else min(int(hero_frame), N - 1)
    status = _Status()

    # Camera ---------------------------------------------------------------------------------
    cams, cam_info = cammath.parse_camera(pack.camera, N)
    sensor_w = cam_info.get("sensor_width_mm", cammath.SENSOR_W_MM)
    if scaled and gW * plan["scale"] > W + 0.5:   # the fill cropped the sides: a narrower lens view
        sensor_w = round(sensor_w * W / (gW * plan["scale"]), 4)
    cam_frames = cammath.build_frames(cams, W, H, fs, sensor_w) if cams else []

    # Layer folders, bottom (lowest z) first --------------------------------------------------
    order = sorted(range(len(pack.layers)), key=lambda k: (pack.layers[k].z, k))
    layers = [pack.layers[k] for k in order]
    entries = []
    for L in layers:
        nm = safe_name(L.name)
        folder = f"layers/{max(L.z, 0):02d}_{nm}"
        for sub in ("png", "matte"):
            os.makedirs(os.path.join(root, folder, sub), exist_ok=True)
        entries.append({
            "id": nm, "name": L.name, "kind": L.kind, "z": int(L.z), "blend_mode": L.blend_mode,
            "source_id": L.source_id, "folder": folder,
            "png": f"{folder}/png/{nm}.####.png", "png_first": f"{folder}/png/{nm}.{fs:04d}.png",
            "matte": f"{folder}/matte/{nm}_matte.####.png", "mov": None, "coverage": 0.0,
        })

    depth_aov = pack.aov("depth")
    other_aovs = [a for a in pack.aovs if a.kind != "depth"]
    if depth_aov is not None:
        os.makedirs(os.path.join(root, "aovs/depth"), exist_ok=True)
        os.makedirs(os.path.join(root, "aovs/depth_vis"), exist_ok=True)
    for a in other_aovs:
        os.makedirs(os.path.join(root, "aovs", a.kind), exist_ok=True)
    if opt["multilayer_exr"]:
        os.makedirs(os.path.join(root, "multilayer"), exist_ok=True)
    tmp_comp = tempfile.mkdtemp(prefix="ss_comp_") if opt["comp_preview"] else None

    exr_attrs = {"comments": f"Soundstage Layer Pack {shot}", "soundstage/colour": "lin_rec709 premultiplied"}
    checker = _checker(H, W)

    def write_frame(i: int):
        """Everything for one frame. Frames are independent, so they run in a thread pool."""
        fr = fs + i
        comp = np.zeros((H, W, 4), np.float32)
        ml, rgbas, z = {}, [], None
        for L, e in zip(layers, entries):
            rgba = L.rgba(i, gW, gH)
            if scaled:
                rgba = np.clip(up(rgba), 0.0, 1.0)
            Image.fromarray(_u8(rgba), "RGBA").save(os.path.join(root, e["folder"], "png", f"{e['id']}.{fr:04d}.png"),
                                                    compress_level=4)
            Image.fromarray((rgba[..., 3] * 65535 + 0.5).astype(np.uint16)).save(
                os.path.join(root, e["folder"], "matte", f"{e['id']}_matte.{fr:04d}.png"), compress_level=4)
            comp = _blend(comp, rgba, L.blend_mode)
            if i == hero:
                rgbas.append(rgba)
            if opt["multilayer_exr"]:
                lin = srgb_to_linear(rgba[..., :3]) * rgba[..., 3:4]
                for c, ch in enumerate("RGB"):
                    ml[f"{e['id']}.{ch}"] = lin[..., c]
                ml[f"{e['id']}.A"] = rgba[..., 3]
        if depth_aov is not None:
            z = up(depth_aov.depth_m(i, gW, gH), Image.BILINEAR)
            write_exr(os.path.join(root, f"aovs/depth/depth.{fr:04d}.exr"), {"Z": z}, attrs=exr_attrs, fps=fps)
            zmin, zmax = float(z.min()), float(z.max())
            vis = 1.0 - (z - zmin) / max(zmax - zmin, 1e-6)   # near = white
            Image.fromarray((vis * 65535 + 0.5).astype(np.uint16)).save(
                os.path.join(root, f"aovs/depth_vis/depth_vis.{fr:04d}.png"), compress_level=4)
            if opt["multilayer_exr"]:
                ml["depth.Z"] = z
        for a in other_aovs:
            img = np.clip(up(fit(frame(a.images, i), gW, gH)), 0.0, 1.0)
            Image.fromarray(_u8(img[..., :3])).save(os.path.join(root, "aovs", a.kind, f"{a.kind}.{fr:04d}.png"),
                                                     compress_level=4)
        if opt["multilayer_exr"]:
            lin = srgb_to_linear(comp[..., :3])  # comp rgb is already over-composited, so premult = rgb*A
            for c, ch in enumerate("RGB"):
                ml[ch] = lin[..., c] * comp[..., 3]
            ml["A"] = comp[..., 3]
            write_exr(os.path.join(root, f"multilayer/{shot}.{fr:04d}.exr"), ml,
                      pixel_type={"depth.Z": FLOAT}, attrs=exr_attrs, fps=fps)
        if tmp_comp:
            flat = comp[..., :3] * comp[..., 3:4] + checker * (1 - comp[..., 3:4])
            Image.fromarray(_u8(flat)).save(os.path.join(tmp_comp, f"comp.{fr:04d}.png"), compress_level=1)
        if i == hero:
            return rgbas, comp, z
        return None

    workers = max(1, min(8, (os.cpu_count() or 2), N))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(write_frame, range(N)))
    hero_rgba, hero_comp, hero_depth = results[hero]
    status["png"] = "ok"
    status["mattes"] = "ok"
    if depth_aov is not None:
        status["depth_exr"] = "ok"
    if opt["multilayer_exr"]:
        status["multilayer_exr"] = "ok"

    # Card depth per layer: median stage depth under its matte on the hero frame ---------------
    focus = None
    if cam_frames:
        c0 = cam_frames[0]
        focus = float(np.linalg.norm(np.subtract(c0["target"], c0["position"])))
    for k, (e, rgba) in enumerate(zip(entries, hero_rgba)):
        a = rgba[..., 3]
        e["coverage"] = round(float((a > 0.5).mean()), 5)
        if hero_depth is not None:
            sel = hero_depth[a > 0.5]
            d = float(np.median(sel)) if sel.size else float(np.percentile(hero_depth, 90))
            if e["kind"] == "background" or e["coverage"] > 0.9:
                d = float(np.percentile(hero_depth[a > 0.5] if sel.size else hero_depth, 90))
            e["depth_source"] = "depth AOV under matte (hero frame)"
        else:
            base = focus or 5.0
            d = base * 3.0 if e["kind"] == "background" else base
            e["depth_source"] = "camera focus distance (no depth AOV)"
        e["depth_m"] = round(max(d, 0.05), 4)

    # ProRes 4444 per layer (at the source's timecode when matching it, so it conforms over the plate) -----------
    tc_start = plan["timecode"] or _timecode(fs, fps)
    if opt["prores"]:
        def prores():
            for e in entries:
                mov = f"{e['folder']}/{e['id']}_4444.mov"
                _ffmpeg(["-framerate", plan["fps_arg"], "-start_number", str(fs),
                         "-i", os.path.join(root, e["folder"], "png", f"{e['id']}.%04d.png"),
                         "-vf", "scale=out_color_matrix=bt709:out_range=tv",
                         "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                         "-vendor", "apl0", *_bt709(), "-timecode", tc_start,
                         "-metadata", f"comment=Soundstage {shot} layer {e['name']} straight alpha",
                         os.path.join(root, mov)])
                e["mov"] = mov
        status.run("prores4444", prores)

    if tmp_comp:
        os.makedirs(os.path.join(root, "preview"), exist_ok=True)
        status.run("comp_preview", _ffmpeg, [
            "-framerate", plan["fps_arg"], "-start_number", str(fs), "-i", os.path.join(tmp_comp, "comp.%04d.png"),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv",
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", *_bt709(), "-timecode", tc_start,
            os.path.join(root, "preview", "comp_preview.mp4")])
        shutil.rmtree(tmp_comp, ignore_errors=True)

    # Photoshop hero frame -----------------------------------------------------------------------
    psd_rel = f"dcc/photoshop/{shot}_{fs + hero:04d}.psd"
    if opt["psd"]:
        def psd():
            os.makedirs(os.path.join(root, "dcc/photoshop"), exist_ok=True)
            flat = _u8(hero_comp[..., :3] * hero_comp[..., 3:4] + (1 - hero_comp[..., 3:4]))  # over white
            write_psd(os.path.join(root, psd_rel),
                      [{"name": e["name"], "rgba": _u8(r), "blend_mode": e["blend_mode"]}
                       for e, r in zip(entries, hero_rgba)], flat)
        status.run("psd", psd)

    # Camera + app builders ------------------------------------------------------------------------
    ctx = {"shot": shot, "fps": fps, "frame_start": fs, "frames": N, "width": W, "height": H,
           "sensor_w": sensor_w, "notes": pack.notes, "root": os.path.abspath(root),
           "camera": cam_frames, "layers": entries}
    for key, rel, fn, needs_cam in [
        ("camera_json", "camera/camera.json", dcc.write_camera_json, True),
        ("camera_chan", "camera/camera.chan", dcc.write_chan, True),
        ("ae_jsx", "dcc/ae/build_comp.jsx", dcc.write_ae_jsx, False),
        ("blender_py", "dcc/blender/build_blender_scene.py", dcc.write_blender_py, False),
        ("nuke_py", "dcc/nuke/build_nuke.py", dcc.write_nuke_py, False),
        ("otio", f"dcc/resolve/{shot}.otio", dcc.write_otio, False),
    ]:
        group = {"camera_json": "camera", "camera_chan": "camera", "ae_jsx": "ae", "blender_py": "blender",
                 "nuke_py": "nuke", "otio": "otio"}[key]
        if not opt[group]:
            continue
        if needs_cam and not cam_frames:
            status[key] = "skipped: no camera connected"
            continue
        os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
        status.run(key, fn, os.path.join(root, rel), ctx)

    # Manifest ------------------------------------------------------------------------------------
    def exists(rel):
        return rel if os.path.exists(os.path.join(root, rel)) else None

    files = {
        "psd": exists(psd_rel), "camera_json": exists("camera/camera.json"), "camera_chan": exists("camera/camera.chan"),
        "ae_jsx": exists("dcc/ae/build_comp.jsx"), "blender_py": exists("dcc/blender/build_blender_scene.py"),
        "nuke_py": exists("dcc/nuke/build_nuke.py"), "otio": exists(f"dcc/resolve/{shot}.otio"),
        "comp_preview": exists("preview/comp_preview.mp4"), "contact_sheet": "preview/contact_sheet.png",
        "multilayer_exr": f"multilayer/{shot}.####.exr" if opt["multilayer_exr"] else None,
    }
    aovs = {}
    if depth_aov is not None:
        aovs["depth"] = {"exr": "aovs/depth/depth.####.exr", "channel": "Z", "units": "metres" if not
                         depth_aov.encoding.startswith("relative") else "relative",
                         "encoding_in": depth_aov.encoding, "near_m": depth_aov.near, "far_m": depth_aov.far,
                         "vis": "aovs/depth_vis/depth_vis.####.png (16-bit, near = white, per-frame normalised)"}
    for a in other_aovs:
        aovs[a.kind] = {"png": f"aovs/{a.kind}/{a.kind}.####.png", "units": a.units}
    manifest = {
        "layerpack_version": VERSION,
        "generator": {"app": "Soundstage", "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")},
        "shot": {"name": shot, "fps": fps, "fps_rational": plan["fps_arg"], "frame_start": fs, "frame_end": fs + N - 1,
                 "frames": N, "resolution": [W, H], "pixel_aspect": 1.0, "hero_frame": fs + hero, "timecode": tc_start},
        "delivery": {"match_source": bool(opt["match_source"]), "matched": plan["matched"],
                     "source": None if not spec else {k: spec.get(k) for k in (
                         "file", "path", "line", "width", "height", "fps", "fps_rational", "tc_start", "reel", "codec_label",
                         "colour", "bit_depth", "camera_original", "proxy")},
                     "generated": {"resolution": [gW, gH], "fps": gen_fps},
                     "resize": f"{plan['resample']} cover fill" if scaled else None, "notes": plan["notes"]},
        "color": {"png": "sRGB display-referred (as generated)", "mov": "Rec.709, tagged bt709 (ProRes 4444 10-bit)",
                  "exr": "lin_rec709 (inverse sRGB EOTF; not HDR)"},
        "alpha": {"png": "straight", "mov": "straight", "exr": "premultiplied",
                  "matte": "16-bit grey, white = opaque"},
        "camera": {"source": "staged" if cam_frames else None, "file": files["camera_json"],
                   "convention": "Y-up right-handed, metres, camera looks -Z", "sensor_width_mm": sensor_w,
                   "focal_mm_first": cam_frames[0]["focal_mm"] if cam_frames else None},
        "layers": [{k: e[k] for k in ("id", "name", "kind", "z", "blend_mode", "source_id", "depth_m",
                                      "depth_source", "coverage")} | {"files": {
                       "png": e["png"], "matte": e["matte"], "mov": e["mov"]}} for e in entries],
        "aovs": aovs,
        "files": files,
        "notes": pack.notes,
        "exports": dict(status),
        "meta": pack.meta,
    }

    # Contact sheet preview ---------------------------------------------------------------------
    preview = _contact_sheet(hero_comp, hero_rgba, entries, hero_depth)
    os.makedirs(os.path.join(root, "preview"), exist_ok=True)
    Image.fromarray(_u8(preview)).save(os.path.join(root, "preview", "contact_sheet.png"))

    with open(os.path.join(root, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    with open(os.path.join(root, "README.txt"), "w") as f:
        f.write(_readme(manifest))
    return {"root": root, "manifest": manifest, "preview": preview}


def _contact_sheet(comp, rgbas, entries, depth, tile_w: int = 480) -> np.ndarray:
    """Hero comp, then every layer over a checker, then depth; 3 tiles per row."""
    H, W = comp.shape[:2]
    th = max(1, int(round(tile_w * H / W)))

    def tile(img):
        return np.asarray(Image.fromarray(_u8(img)).resize((tile_w, th), Image.BILINEAR), np.float32) / 255

    tiles = [tile(comp[..., :3] * comp[..., 3:4] + _checker(H, W) * (1 - comp[..., 3:4]))]
    for r in rgbas:
        tiles.append(tile(r[..., :3] * r[..., 3:4] + _checker(H, W) * (1 - r[..., 3:4])))
    if depth is not None:
        v = 1.0 - (depth - depth.min()) / max(float(depth.max() - depth.min()), 1e-6)
        tiles.append(tile(np.repeat(v[..., None], 3, axis=2)))
    cols = min(3, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    pad = 6
    sheet = np.full((rows * (th + pad) + pad, cols * (tile_w + pad) + pad, 3), 0.08, np.float32)
    for k, t in enumerate(tiles):
        r, c = divmod(k, cols)
        y, x = pad + r * (th + pad), pad + c * (tile_w + pad)
        sheet[y:y + th, x:x + tile_w] = t
    return sheet


def _readme(m: dict) -> str:
    s = m["shot"]
    d = m.get("delivery") or {}
    src = (d.get("source") or {}).get("line") or ""
    delivery = (f"Delivered at source spec. {src}\n" if d.get("matched") else "") + "".join(f"  - {n}\n" for n in d.get("notes") or [])
    return f"""Soundstage Layer Pack — {s['name']}  ({s['resolution'][0]}x{s['resolution'][1]}, {s['fps']} fps, frames {s['frame_start']}-{s['frame_end']}, TC {s.get('timecode', '')})
{delivery}
Every layer is in layers/<z>_<name>/ : png/ (RGBA, straight alpha), matte/ (16-bit), and a ProRes 4444 .mov.
manifest.json lists every file, the colour/alpha conventions and the camera.

After Effects : File > Scripts > Run Script File... > dcc/ae/build_comp.jsx   (comp + layers + 3D camera)
Blender       : blender --python dcc/blender/build_blender_scene.py         (camera + image cards at depth)
Nuke          : File > Source... (or nuke -t) dcc/nuke/build_nuke.py          (Read/Merge tree, camera, cards)
                Camera only: Camera node > File > Import chan file > camera/camera.chan (rot order ZXY)
Resolve       : File > Import > Timeline > dcc/resolve/{s['name']}.otio   (one track per layer; relink to this folder if moved)
Photoshop     : open dcc/photoshop/*.psd   (hero frame {s['hero_frame']}, one named layer per pack layer)
Avid / Premiere: import the *_4444.mov files (alpha = straight).
"""
