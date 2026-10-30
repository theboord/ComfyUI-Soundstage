"""Source spec: what an imported clip or plate really is, so Deliver can hand it back the same.

"What goes in also goes out the same." Every clip or plate brought into Soundstage is probed once with ffprobe
(resolution, exact frame rate, timecode, reel, codec, bit depth, chroma, colour tags) and the spec travels with
the scene and the shot. The NLE exports point at the camera original with its own timecode, rate and reel; the
Layer Pack renders at the source size, rate and colour tags. docs/source_fidelity.md has the whole story.

Camera RAW (RED .R3D, Blackmagic .braw, ARRIRAW .ari/.arx, Canon .crm, Nikon .nev) needs the vendor SDKs to
decode, so Soundstage works from a proxy and keeps the link to the camera original.

Pure python + ffprobe; no ComfyUI imports.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from fractions import Fraction

CAMERA_RAW = {".r3d": "RED R3D", ".braw": "Blackmagic RAW", ".ari": "ARRIRAW", ".arx": "ARRIRAW HDE",
              ".crm": "Canon Cinema RAW Light", ".nev": "Nikon N-RAW"}

PRIMARIES = {"bt709": "Rec.709", "bt2020": "Rec.2020", "smpte432": "P3-D65", "smpte431": "DCI-P3",
             "bt470bg": "Rec.601", "smpte170m": "Rec.601", "smpte240m": "SMPTE 240M", "film": "Film"}
TRANSFER = {"bt709": "", "smpte2084": "PQ", "arib-std-b67": "HLG", "iec61966-2-1": "sRGB", "linear": "Linear",
            "bt2020-10": "", "bt2020-12": "", "smpte170m": "", "gamma22": "Gamma 2.2", "gamma28": "Gamma 2.8",
            "smpte428": "DCI X'Y'Z'", "log100": "Log", "log316": "Log"}
MATRIX = {"bt709": "Rec.709", "bt2020nc": "Rec.2020", "bt2020c": "Rec.2020 CL", "bt470bg": "Rec.601",
          "smpte170m": "Rec.601", "gbr": "RGB", "rgb": "RGB", "ycgco": "YCgCo", "ictcp": "ICtCp"}
# Camera log curves are not ffmpeg colour tags; cameras write them into metadata. Order matters (longest first).
LOG_CURVES = [("s-log3", "S-Log3"), ("slog3", "S-Log3"), ("s-log2", "S-Log2"), ("slog2", "S-Log2"),
              ("logc4", "ARRI LogC4"), ("logc3", "ARRI LogC3"), ("log-c", "ARRI LogC"), ("logc", "ARRI LogC"),
              ("log3g10", "RED Log3G10"), ("c-log3", "Canon Log 3"), ("clog3", "Canon Log 3"), ("c-log2", "Canon Log 2"),
              ("clog2", "Canon Log 2"), ("v-log", "V-Log"), ("vlog", "V-Log"), ("f-log2", "F-Log2"), ("f-log", "F-Log"),
              ("flog", "F-Log"), ("n-log", "N-Log"), ("nlog", "N-Log"), ("bmdfilm", "Blackmagic Film"),
              ("blackmagic design film", "Blackmagic Film"), ("hlg", "HLG")]
CODECS = {"h264": "H.264", "hevc": "HEVC", "av1": "AV1", "vp9": "VP9", "vp8": "VP8", "mpeg2video": "MPEG-2",
          "mjpeg": "Motion JPEG", "png": "PNG", "tiff": "TIFF", "exr": "OpenEXR", "dpx": "DPX", "jpeg2000": "JPEG 2000",
          "ffv1": "FFV1", "qtrle": "QuickTime Animation", "rawvideo": "Uncompressed", "v210": "Uncompressed 10-bit",
          "cfhd": "CineForm", "hap": "HAP", "webp": "WebP", "gif": "GIF", "bmp": "BMP"}
IMAGE_CODECS = {"png", "mjpeg", "tiff", "exr", "dpx", "webp", "bmp", "jpeg2000", "gif"}

# Even sizes for 4:2:x video; the common nominal rates and their exact NTSC rationals.
_NTSC = {23.976: "24000/1001", 29.97: "30000/1001", 47.952: "48000/1001", 59.94: "60000/1001", 119.88: "120000/1001"}


def camera_raw(name: str) -> str | None:
    """'RED R3D' for a camera RAW file name Soundstage cannot decode, else None."""
    return CAMERA_RAW.get(os.path.splitext(str(name or ""))[1].lower())


def _rate(s) -> Fraction | None:
    try:
        a, b = str(s).split("/")
        return Fraction(int(a), int(b)) if int(b) and int(a) else None
    except (ValueError, ZeroDivisionError):
        return None


def rational(fps) -> str:
    """Exact rate for a float fps: 23.976 -> '24000/1001', 25 -> '25/1'."""
    f = float(fps or 0)
    for nominal, r in _NTSC.items():
        if abs(f - nominal) < 0.01:
            return r
    fr = Fraction(f).limit_denominator(1001)
    return f"{fr.numerator}/{fr.denominator}"


def fps_label(fps) -> str:
    """'23.976', '24', '29.97'."""
    f = float(fps or 0)
    return f"{f:.3f}".rstrip("0").rstrip(".") if abs(f - round(f)) > 1e-3 else str(int(round(f)))


def _bit_depth(st: dict) -> int:
    b = st.get("bits_per_raw_sample")
    if b and str(b).isdigit() and int(b) > 0:
        return int(b)
    pf = str(st.get("pix_fmt") or "")
    m = re.search(r"p(\d+)(le|be)?$", pf) or re.search(r"(\d+)(le|be)$", pf)
    if m and int(m.group(1)) in (9, 10, 12, 14, 16):
        return int(m.group(1))
    if pf.endswith(("f32le", "f32be", "f16le")) or pf.startswith("grayf32"):
        return 32 if "32" in pf else 16
    return 8


def _chroma(pf: str) -> str:
    pf = str(pf or "")
    if pf.startswith(("gbr", "rgb", "bgr", "argb", "abgr", "rgba", "bgra", "0rgb", "rgb0")):
        return "RGB"
    if pf.startswith(("gray", "ya")):
        return "Mono"
    for key, lab in (("444", "4:4:4"), ("422", "4:2:2"), ("420", "4:2:0"), ("411", "4:1:1"), ("440", "4:4:0")):
        if key in pf:
            return lab
    return ""


def _codec_label(st: dict) -> str:
    name = str(st.get("codec_name") or "")
    prof = str(st.get("profile") or "")
    if prof in ("unknown", "none"):
        prof = ""
    if name == "prores":
        return f"ProRes {prof}".strip() if prof else "ProRes"
    if name == "dnxhd":
        return prof.replace("DNXHR", "DNxHR").replace("DNXHD", "DNxHD") if prof else "DNxHD/HR"
    lab = CODECS.get(name, name.upper() or "unknown")
    return f"{lab} ({prof})" if prof and name in ("h264", "hevc", "av1", "vp9") else lab


def _log_curve(*tag_dicts) -> str:
    text = " ".join(f"{k}={v}" for d in tag_dicts for k, v in (d or {}).items()).lower()
    for key, lab in LOG_CURVES:
        if key in text and key != "hlg":
            return lab
    return ""


def colour_label(spec: dict) -> str:
    """'Rec.709', 'Rec.2020 PQ', 'S-Log3', 'untagged'."""
    if spec.get("log_curve"):
        return spec["log_curve"]
    prim = PRIMARIES.get(spec.get("primaries") or "", "")
    trc = TRANSFER.get(spec.get("transfer") or "", "")
    if not prim:
        prim = MATRIX.get(spec.get("matrix") or "", "")
        if prim == "RGB":
            prim = ""
    lab = " ".join(x for x in (prim, trc) if x)
    return lab or "untagged"


def parse(probe: dict, path: str = "") -> dict:
    """ffprobe -show_streams -show_format JSON -> the source spec. Raises ValueError without a picture stream."""
    streams = probe.get("streams") or []
    fmt = probe.get("format") or {}
    st = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")),
              None) or next((s for s in streams if s.get("codec_type") == "video"), None)
    if not st or not st.get("width"):
        raise ValueError("the file has no picture stream")
    name = os.path.basename(path) if path else ""
    codec = str(st.get("codec_name") or "")
    r, avg = _rate(st.get("r_frame_rate")), _rate(st.get("avg_frame_rate"))
    rate = avg if avg and (not r or abs(float(avg) - float(r)) < 0.01) else (r or avg)
    vfr = bool(r and avg and abs(float(avg) - float(r)) >= 0.01)
    still = codec in IMAGE_CODECS and (int(st.get("nb_frames") or 1) <= 1) and not float(fmt.get("duration") or 0) > 0.1
    fps = float(rate) if rate else 0.0
    dur = float(st.get("duration") or fmt.get("duration") or 0)
    frames = int(st.get("nb_frames") or 0) or (int(round(dur * fps)) if fps else 0)
    tags = {}
    for s in [fmt] + streams:
        for k, v in (s.get("tags") or {}).items():
            tags.setdefault(k.lower(), v)
    tc = tags.get("timecode") or ""
    reel = tags.get("reel_name") or tags.get("reel") or tags.get("com.apple.proapps.reel") or ""
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    pf = str(st.get("pix_fmt") or "")
    spec = {
        "file": name, "path": path, "kind": "image" if still else "video",
        "width": int(st["width"]), "height": int(st["height"]),
        "sar": str(st.get("sample_aspect_ratio") or "1:1") if st.get("sample_aspect_ratio") not in (None, "0:1") else "1:1",
        "fps": round(fps, 3) if not still else 0, "fps_rational": (f"{rate.numerator}/{rate.denominator}" if rate else "")
        if not still else "", "vfr": vfr and not still,
        "frames": 1 if still else frames, "duration": 0 if still else round(dur, 3),
        "tc_start": tc if re.fullmatch(r"\d\d:\d\d:\d\d[:;.]\d\d", tc or "") else "", "drop_frame": ";" in tc,
        "reel": str(reel), "codec": codec, "codec_label": _codec_label(st), "profile": str(st.get("profile") or ""),
        "container": str(fmt.get("format_name") or "").split(",")[0], "pix_fmt": pf, "bit_depth": _bit_depth(st),
        "chroma": _chroma(pf), "alpha": pf.startswith(("yuva", "rgba", "bgra", "argb", "abgr", "ya", "gbrap", "rgba64")),
        "primaries": st.get("color_primaries") or None, "transfer": st.get("color_transfer") or None,
        "matrix": st.get("color_space") or None, "range": {"tv": "limited", "pc": "full"}.get(st.get("color_range") or "", None),
        "log_curve": _log_curve(fmt.get("tags"), st.get("tags")),
        "audio": {"channels": int(audio.get("channels") or 0), "sample_rate": int(audio.get("sample_rate") or 0),
                  "codec": str(audio.get("codec_name") or "")} if audio else None,
        "camera_raw": None, "camera_original": "", "proxy": False,
    }
    spec["colour"] = colour_label(spec)
    spec["line"] = spec_line(spec)
    return spec


def raw_stub(path: str) -> dict:
    """A camera RAW file Soundstage cannot decode: who it is, and that a proxy is needed."""
    name = os.path.basename(path)
    return {"file": name, "path": path, "kind": "video", "camera_raw": camera_raw(name), "camera_original": name,
            "proxy": False, "decodable": False, "reel": reel_from_name(name),
            "line": f"Source: {camera_raw(name)} camera original. Soundstage needs a proxy of it (ProRes, DNxHR or "
                    "H.264); your export relinks to the camera original."}


def reel_from_name(name: str) -> str:
    """Camera-style reel from a clip name: A001_C002_0101XY.R3D -> A001_C002; anything else -> the stem."""
    stem = os.path.splitext(os.path.basename(str(name or "")))[0]
    m = re.match(r"^([A-Z]\d{3})[_]?(C\d{3})", stem, re.I)
    return f"{m.group(1)}_{m.group(2)}".upper() if m else stem


def probe(path: str, timeout: int = 60) -> dict:
    """ffprobe a file into its source spec (RAW camera files return a stub that asks for a proxy)."""
    if camera_raw(path):
        return raw_stub(path)
    exe = shutil.which("ffprobe")
    if not exe:
        raise RuntimeError("ffprobe is not on this server")
    out = subprocess.run([exe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                         capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise ValueError(f"not a readable picture ({out.stderr.strip()[:200]})")
    return parse(json.loads(out.stdout or "{}"), path)


def link_original(spec: dict, original: str) -> dict:
    """Mark spec as a proxy of a camera original (a RAW file name or path): the exports relink to it."""
    if not original:
        return spec
    s = dict(spec)
    s["camera_original"] = str(original)
    s["camera_raw"] = camera_raw(original) or s.get("camera_raw")
    s["proxy"] = True
    if not s.get("reel"):
        s["reel"] = reel_from_name(original)
    s["line"] = spec_line(s)
    return s


def spec_line(spec: dict) -> str:
    """'Source: 3840×2160 · 23.976 · ProRes 4444 · Rec.709 · 10-bit' (+ the proxy sentence for camera RAW)."""
    if spec.get("decodable") is False:
        return spec.get("line") or ""
    bits = [f"{spec.get('width')}×{spec.get('height')}"]
    if spec.get("kind") != "image" and spec.get("fps"):
        bits.append(fps_label(spec["fps"]) + (" VFR" if spec.get("vfr") else ""))
    bits.append(spec.get("codec_label") or spec.get("codec") or "?")
    bits.append(spec.get("colour") or colour_label(spec))
    bits.append(f"{spec.get('bit_depth') or 8}-bit" + (f" {spec['chroma']}" if spec.get("chroma") in ("4:4:4", "4:2:2", "RGB")
                                                      else ""))
    if spec.get("tc_start") and spec["tc_start"] != "00:00:00:00":
        bits.append(f"TC {spec['tc_start']}")
    line = "Source: " + " · ".join(bits)
    if spec.get("proxy"):
        line += (f". Working from a proxy; your export relinks to the camera original "
                 f"({os.path.basename(spec.get('camera_original') or '')}).")
    return line


# ---------------------------------------------------------------- deliver at source spec

MAX_FILL_CROP = 5.0   # % of the picture a fill may crop to reach the source frame; more = keep the generated size

def deliver_plan(spec: dict | None, gen_w: int, gen_h: int, gen_fps: float) -> dict:
    """How generated frames go out matching a source: {width, height, fps, fps_arg, timecode, resample, crop (% cut
    to fill the source frame), scale, notes}. Without a usable spec: the generated size and rate, Rec.709, no notes.
    Colour is matched by tag only when the source is Rec.709 (or untagged): anything else gets an honest note."""
    plan = {"width": int(gen_w), "height": int(gen_h), "fps": float(gen_fps), "fps_arg": rational(gen_fps),
            "timecode": None, "resample": None, "crop": None, "scale": 1.0, "matched": False, "notes": [],
            "colour": "Rec.709"}
    if not spec or not spec.get("width") or spec.get("decodable") is False:
        return plan
    notes = plan["notes"]
    plan["matched"] = True
    W, H = int(spec["width"]), int(spec["height"])
    W, H = W + (W % 2), H + (H % 2)
    if (W, H) != (gen_w, gen_h):
        k = max(W / gen_w, H / gen_h)
        cw, ch = gen_w * k, gen_h * k
        crop_pct = max(cw - W, ch - H) / max(cw, ch) * 100
        if crop_pct > MAX_FILL_CROP:
            notes.append(f"picture: NOT matched. The source frame is {W}x{H} and the generated frame {gen_w}x{gen_h}; "
                         f"filling it would crop {crop_pct:.0f}% of the picture, so it stays {gen_w}x{gen_h}. Scale or "
                         "reposition it in your conform")
        else:
            plan["width"], plan["height"], plan["scale"], plan["resample"] = W, H, k, "lanczos"
            if crop_pct > 0.05:
                plan["crop"] = round(crop_pct, 2)
            verb = "upscaled" if k > 1 else "downscaled"
            notes.append(f"picture: {verb} {gen_w}x{gen_h} -> {W}x{H} (source size) with lanczos, {k:.3g}x"
                         + (f"; centre-cropped {crop_pct:.1f}% of the {'width' if cw - W >= ch - H else 'height'} "
                            "because the model's frame shape differs from the source's" if plan["crop"] else ""))
            if k < 1:
                notes.append("picture: the source is smaller than the generated frames, so matching it downscales")
    sf = float(spec.get("fps") or 0)
    if spec.get("kind") == "image" or not sf:
        pass
    elif abs(sf - gen_fps) < 0.05:
        plan["fps"], plan["fps_arg"] = sf, spec.get("fps_rational") or rational(sf)
        if abs(sf - gen_fps) > 1e-3:
            notes.append(f"rate: {fps_label(gen_fps)} fps frames tagged {fps_label(sf)} fps frame for frame "
                         "(the standard pull-down conform, 0.1% speed change, no frames added or dropped)")
    else:
        notes.append(f"rate: NOT matched. The source is {fps_label(sf)} fps but the frames were generated at "
                     f"{fps_label(gen_fps)} fps; delivered at {fps_label(gen_fps)} fps, not retimed. Re-generate at "
                     f"{fps_label(sf)} fps or convert the rate in your NLE")
    if spec.get("tc_start"):
        plan["timecode"] = spec["tc_start"].replace(";", ":")
    prim, trc, mat = spec.get("primaries"), spec.get("transfer"), spec.get("matrix")
    label = spec.get("colour") or colour_label(spec)
    if spec.get("log_curve") or trc in ("smpte2084", "arib-std-b67", "log100", "log316", "linear"):
        notes.append(f"colour: NOT matched. The source is {label}; generated pictures are SDR Rec.709 and cannot honestly "
                     "be turned into a log/HDR encoding, so they are delivered Rec.709 (tagged bt709). Grade them into "
                     "the source space in your conform")
    elif prim in (None, "", "bt709", "unknown") and mat in (None, "", "bt709", "unknown", "gbr", "rgb"):
        if not prim and not mat:
            notes.append("colour: the source carries no colour tags; delivered tagged Rec.709")
    else:
        # Rec.2020 / P3 / Rec.601 SDR: tagging Rec.709 pixels as another gamut would shift every colour.
        notes.append(f"colour: NOT matched. The source is {label}; generated pictures are Rec.709, delivered tagged "
                     f"Rec.709 rather than mislabelled. Convert Rec.709 -> {label} in your conform (e.g. a Resolve CST)")
    if spec.get("range") == "full":
        notes.append("range: the source is full range; ProRes deliveries are video (limited) range by convention")
    depth = int(spec.get("bit_depth") or 8)
    if depth > 10:
        notes.append(f"depth: the source is {depth}-bit; ProRes 4444 here is 10-bit with 16-bit alpha and the EXRs are "
                     "half float. The generated pixels themselves carry 8 bits of real detail")
    if spec.get("proxy"):
        notes.append(f"camera original: {spec.get('camera_original')} (worked from a proxy; relink to it in your conform)")
    return plan
