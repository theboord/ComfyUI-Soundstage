"""Editorial exporters for the Soundstage Cut tab. Python twin of web/cut/timeline.mjs + exporters.mjs.

Keep the two in step: tests/test_cut.py renders the same projects through both and diffs the bytes.
No ComfyUI imports.
"""
import json
import math
import re
from urllib.parse import parse_qs, quote

RUNGS = ("clay", "look", "draft", "final")


def _round(v) -> int:
    """JavaScript Math.round (half up), so both sides agree on .5."""
    return int(math.floor(float(v) + 0.5))


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def _js_str(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _num(v):
    """Integral floats as ints, so JSON matches JSON.stringify."""
    return int(v) if isinstance(v, float) and v.is_integer() else v


def _one_line(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


# ---------------------------------------------------------------- model (timeline.mjs)

def _normalize_markers(lst) -> list:
    out = []
    for m in lst if isinstance(lst, list) else []:
        if not m or not (m.get("text") or m.get("comment")):
            continue
        mk = {"frame": max(0, _round(m.get("frame") or 0)), "text": str(m.get("text") or m.get("comment"))}
        if m.get("color"):
            mk["color"] = str(m["color"])
        if m.get("user"):
            mk["user"] = str(m["user"])
        out.append(mk)
    return out


def _base_name(p) -> str:
    return str(p or "").split("?")[0].split("/")[-1] or "audio"


def normalize_audio(lst) -> list:
    seen, out = set(), []
    for i, a in enumerate(lst if isinstance(lst, list) else []):
        aid = _js_str(a["id"]) if a.get("id") is not None else f"a{i + 1}"
        while aid in seen:
            aid += "_"
        seen.add(aid)
        frames = max(1, _round(a["frames"])) if a.get("frames") is not None else None
        in_f = max(0, _round(a.get("in") or 0))
        out_f = _round(a["out"]) if a.get("out") is not None else frames
        if out_f is not None:
            if frames is not None:
                out_f = min(out_f, frames)
            out_f = max(in_f + 1, out_f)
        n = out_f - in_f if out_f is not None else 0
        try:
            gain = float(a.get("gain_db") or 0)
        except (TypeError, ValueError):
            gain = 0.0
        if gain != gain:
            gain = 0.0
        fade_in = _clamp(_round(a.get("fade_in") or 0), 0, n)
        clip = {
            "id": aid,
            "track": max(1, _round(a.get("track") or 1)),
            "url": str(a["url"]) if a.get("url") else "",
            "path": str(a["path"]) if a.get("path") else "",
            "start_frame": max(0, _round(a.get("start_frame") or 0)),
            "in": in_f,
            "out": out_f,
            "gain_db": _num(_round(_clamp(gain, -60, 24) * 10) / 10),
            "fade_in": fade_in,
            "fade_out": _clamp(_round(a.get("fade_out") or 0), 0, n - fade_in),
            "label": str(a["label"]) if a.get("label") else _base_name(a.get("url") or a.get("path")),
            "frames": frames,
        }
        if isinstance(a.get("meta"), dict):
            clip["meta"] = a["meta"]
        out.append(clip)
    return out


_TC_RE = re.compile(r"\d\d:\d\d:\d\d[:;.]\d\d")


def _fnum(v) -> float:
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f != f else f


def normalize_source(src):
    """A shot's source footage (docs/source_fidelity.md), or None. Mirrors timeline.mjs normalizeSource."""
    if not isinstance(src, dict):
        return None
    path = str(src.get("camera_original") or src.get("path") or src.get("file") or "")
    if not path:
        return None
    tc = str(src.get("tc_start") or "")
    return {
        "path": path,
        "proxy": str(src["path"]) if src.get("proxy") and src.get("path") and str(src["path"]) != path else "",
        "reel": str(src.get("reel") or ""),
        "tc_start": tc if _TC_RE.fullmatch(tc) else "",
        "fps": _num(_round(_fnum(src.get("fps")) * 1000) / 1000),
        "width": _round(_fnum(src.get("width"))),
        "height": _round(_fnum(src.get("height"))),
        "frames": _round(_fnum(src.get("frames"))),
        "colour": str(src.get("colour") or ""),
        "primaries": str(src.get("primaries") or ""),
        "transfer": str(src.get("transfer") or ""),
        "matrix": str(src.get("matrix") or ""),
        "use": "original" if src.get("use") == "original" else "plate",
    }


def _match_source(project) -> None:
    """Deliver at source spec: the first source's size, and its exact rate when it is the same speed."""
    if project.get("match_source") is False:
        return
    s = next((x for x in project["shots"] if x.get("source") and x["source"]["width"] and x["source"]["height"]), None)
    if not s:
        return
    src = s["source"]
    project["width"], project["height"] = src["width"], src["height"]
    if src["fps"] and abs(src["fps"] - _fnum(project["fps"])) < 0.05:
        project["fps"] = src["fps"]
    project["delivery"] = {"from": s["name"], "width": src["width"], "height": src["height"], "fps": _num(project["fps"]),
                           "colour": src["colour"]}


def normalize_project(p) -> dict:
    project = dict(p or {})
    project["name"] = project.get("name") or "Soundstage cut"
    project["fps"] = project.get("fps") or 24
    project["width"] = _round(project.get("width") or 1920)
    project["height"] = _round(project.get("height") or 1080)
    shots = []
    for i, s in enumerate(project.get("shots") or []):
        sid = _js_str(s["id"]) if s.get("id") is not None else f"shot{i + 1}"
        src = normalize_source(s.get("source"))
        shots.append({
            "id": sid,
            "name": s.get("name") or sid,
            "frames": max(1, _round(s.get("frames") or 1)),
            "scene_name": s.get("scene_name") or "",
            "setup": s.get("setup") or "",
            "scene_offset": _round(s.get("scene_offset") or 0),
            "renders": dict(s.get("renders") or {}),
            "notes": s.get("notes") or "",
            "markers": _normalize_markers(s.get("markers")),
            **({"source": src} if src else {}),
        })
    project["shots"] = shots
    _match_source(project)
    by_id = {s["id"]: s for s in shots}
    cut = []
    for e in project.get("cut") or []:
        shot = by_id.get(_js_str(e.get("shot_id")))
        if not shot:
            continue
        in_f = _clamp(_round(e["in"] if e.get("in") is not None else 0), 0, shot["frames"] - 1)
        out_f = _clamp(_round(e["out"] if e.get("out") is not None else shot["frames"]), in_f + 1, shot["frames"])
        ev = {"shot_id": shot["id"], "in": in_f, "out": out_f}
        notes = e.get("notes")
        if notes and (not isinstance(notes, list) or len(notes)):
            ev["notes"] = [str(x) for x in notes] if isinstance(notes, list) else str(notes)
        cut.append(ev)
    project["cut"] = cut
    project["audio"] = normalize_audio(project.get("audio"))
    project["audio_tracks"] = [{"track": max(1, _round(t.get("track") or 1)), "name": str(t["name"]) if t.get("name") else "",
                                "mute": bool(t.get("mute")), "solo": bool(t.get("solo"))}
                               for t in (project.get("audio_tracks") or [])]
    return project


def best_rung(shot) -> str:
    r = shot.get("renders") or {}
    for rung in ("final", "draft", "look"):
        if r.get(rung):
            return rung
    return "clay"


def layout(project) -> list:
    by_id = {s["id"]: s for s in project["shots"]}
    rows, rec = [], 0
    for i, e in enumerate(project["cut"]):
        n = e["out"] - e["in"]
        rows.append({"index": i, "event": e, "shot": by_id[e["shot_id"]], "in": e["in"], "out": e["out"], "len": n,
                     "recIn": rec, "recOut": rec + n})
        rec += n
    return rows


def total_frames(project) -> int:
    return sum(e["out"] - e["in"] for e in project["cut"])


def audio_len(a) -> int:
    return 0 if a["out"] is None else a["out"] - a["in"]


def audio_end(project) -> int:
    return max([0] + [a["start_frame"] + audio_len(a) for a in project.get("audio") or []])


def sequence_frames(project) -> int:
    return max(total_frames(project), audio_end(project))


def audible(project, track) -> bool:
    tracks = project.get("audio_tracks") or []
    solos = [t for t in tracks if t["solo"]]
    if solos:
        return any(t["track"] == track for t in solos)
    state = next((t for t in tracks if t["track"] == track), None)
    return not (state and state["mute"])


def audio_lanes(project) -> list:
    lanes = []
    for track in sorted({a["track"] for a in project.get("audio") or []}):
        clips = [a for a in project["audio"] if a["track"] == track and a["out"] is not None]
        clips = [a for _, a in sorted(enumerate(clips), key=lambda x: (x[1]["start_frame"], x[0]))]
        mine = []
        for a in clips:
            lane = next((l for l in mine if l["clips"][-1]["start_frame"] + audio_len(l["clips"][-1]) <= a["start_frame"]), None)
            if lane is None:
                lane = {"track": track, "name": f"A{track}" + (chr(97 + len(mine)) if mine else ""), "clips": []}
                mine.append(lane)
            lane["clips"].append(a)
        lanes += mine
    return lanes


def note_items(row) -> list:
    def lst(v):
        vals = v if isinstance(v, list) else ([v] if v else [])
        return [t for t in (_one_line(x) for x in vals) if t]

    items = [{"text": t, "src": row["in"]} for t in lst(row["shot"].get("notes")) + lst(row["event"].get("notes"))]
    for m in sorted(row["shot"].get("markers") or [], key=lambda m: m["frame"]):
        text = _one_line(m["text"])
        if not text or m["frame"] < row["in"] or m["frame"] >= row["out"]:
            continue
        it = {"text": text, "src": m["frame"]}
        if m.get("color"):
            it["color"] = m["color"]
        if m.get("user"):
            it["user"] = m["user"]
        items.append(it)
    return items


# ---------------------------------------------------------------- time

def fps_info(fps) -> dict:
    try:
        f = float(fps) or 24.0
    except (TypeError, ValueError):
        f = 24.0
    for nominal, base in ((23.976, 24), (29.97, 30), (47.952, 48), (59.94, 60)):
        if abs(f - nominal) < 0.01:
            return {"base": base, "num": base * 1000, "den": 1001}
    base = max(1, _round(f))
    return {"base": base, "num": base, "den": 1}


def frames_to_tc(frames, base=24) -> str:
    n = max(0, _round(frames))
    ff, s = n % base, n // base
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}:{ff:02d}"


def tc_to_frames(tc, base=24) -> int:
    h, m, s, f = (int(x) for x in re.split(r"[:;.]", str(tc)))
    return ((h * 60 + m) * 60 + s) * base + f


def record_start(base) -> int:
    return 3600 * base


def fcp_time(frames, fi) -> str:
    n, d = frames * fi["den"], fi["num"]
    if n == 0:
        return "0s"
    g = math.gcd(abs(n), d)
    return f"{n // g}s" if d // g == 1 else f"{n // g}/{d // g}s"


# ---------------------------------------------------------------- media

_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
_ENCODE_URI_SAFE = ";,/?:@&=+$!*'()#"


def _encode_uri(s) -> str:
    return quote(s, safe=_ENCODE_URI_SAFE)


def parse_view_url(raw):
    """(subfolder, filename, type) of a ComfyUI /view URL, or None."""
    raw = str(raw or "")
    q = raw.find("?")
    if q < 0 or not re.search(r"(^|[?&])filename=", raw[q:]):
        return None
    params = parse_qs(raw[q + 1:], keep_blank_values=True)
    get = lambda k: (params.get(k) or [""])[0]  # noqa: E731
    return get("subfolder"), get("filename"), get("type") or "output"


def resolve_media(raw, media_root="") -> dict:
    raw = str(raw or "")
    rel = raw
    view = parse_view_url(raw)
    if view:
        rel = "/".join(v for v in view[:2] if v)
    path = rel
    if media_root and rel and not _SCHEME.match(rel) and not rel.startswith("/"):
        path = media_root.rstrip("/") + "/" + rel
    url = path
    if path.startswith("/"):
        url = "file://" + _encode_uri(path)
    elif not _SCHEME.match(path):
        url = _encode_uri(path)
    return {"path": path, "url": url}


def media_for(shot, media_root="") -> dict:
    rung = best_rung(shot)
    src = shot.get("source")
    if src and (src["use"] == "original" or rung in ("clay", "look")):
        r = resolve_media(src["path"])   # the camera original, never under media_root
        return {"rung": "source", "kind": "video", "path": r["path"], "url": r["url"], "offline": False, "source": src}
    raw = str(shot["renders"].get("clay") or "") if rung == "clay" else str(shot["renders"][rung])
    offline = not resolve_media(raw)["path"]
    r = resolve_media(f"{shot['name']}.mov" if offline else raw, media_root)
    return {"rung": rung, "kind": "image" if rung == "look" else "video", "path": r["path"], "url": r["url"], "offline": offline}


def relink_note(media) -> str:
    if media["rung"] == "final":
        return ""
    if media["rung"] == "source":
        return "" if media["source"]["use"] == "original" else "SOURCE plate stand-in: relink to the Final render"
    if media["offline"]:
        return "CLAY offline: render the shot, then relink"
    return f"{media['rung'].upper()} stand-in: relink to the Final render"


def audio_media(a, media_root="") -> dict:
    return resolve_media(a["path"] or a["url"], media_root)


def _audio_src_frames(a) -> int:
    return max(a["frames"] or 0, a["out"])


def source_timing(src, project) -> dict:
    """A source clip's own rate, first frame (its start timecode) and cut frame -> source frame."""
    fi = fps_info(project["fps"])
    sfi = fps_info(src["fps"] or project["fps"])
    same = sfi["base"] == fi["base"]

    def mp(f):
        return f if same else _round((f * sfi["num"] * fi["den"]) / (sfi["den"] * fi["num"]))
    return {"sfi": sfi, "same": same, "start": tc_to_frames(src["tc_start"], sfi["base"]) if src["tc_start"] else 0, "map": mp}


def _src_spec_text(src) -> str:
    return (f"{src['width']}x{src['height']} {_js_str(src['fps']) if src['fps'] else '?'} FPS"
            + (" " + src["colour"].upper() if src["colour"] else ""))


def _js_num(v) -> str:
    return _js_str(_num(_fnum(v)))


def source_notes(src, project) -> list:
    out = []
    if src["proxy"]:
        out.append(f"cut from the proxy {src['proxy'].split('/')[-1]}: relink to the camera original {src['path'].split('/')[-1]}")
    if not source_timing(src, project)["same"]:
        out.append(f"source is {_js_num(src['fps'])} fps in a {_js_num(project['fps'])} fps sequence: convert the rate on conform")
    return out


def _reel_base(name, width) -> str:
    return (re.sub(r"[^A-Z0-9_]+", "_", name.upper()).strip("_") or "AX")[:width]


def source_reel(src, width=8) -> str:
    return _reel_base(src["reel"] or re.sub(r"\.[^.]+$", "", src["path"].split("/")[-1]), width)


def reel_names(project, width=8) -> dict:
    used, out = set(), {}

    def add(key, name):
        base = re.sub(r"[^A-Z0-9_]+", "_", name.upper()).strip("_")[:width] or "AX"
        reel, n = base, 1
        while reel in used:
            suf = str(n)
            n += 1
            reel = base[:width - len(suf)] + suf
        used.add(reel)
        out[key] = reel

    for s in project["shots"]:
        add(s["id"], s["name"])
    for a in project.get("audio") or []:
        add("audio:" + a["id"], a["label"])
    return out


_AVID_COLORS = ("Red", "Green", "Blue", "Cyan", "Magenta", "Yellow", "Black", "White")


def avid_color(c) -> str:
    return next((x for x in _AVID_COLORS if x.lower() == str(c or "").lower()), "Red")


def _gain_text(g) -> str:
    return ("+" if g > 0 else "") + f"{g:.1f}"


# ---------------------------------------------------------------- CMX3600

def to_edl(project, reel_width=8, source_start=0, media_root="") -> str:
    project = normalize_project(project)
    fi = fps_info(project["fps"])
    tc = lambda f: frames_to_tc(f, fi["base"])  # noqa: E731
    reels = reel_names(project, reel_width)
    start = record_start(fi["base"])
    title = re.sub(r"[^\x20-\x7e]", "", _one_line(project["name"]))[:70] or "SOUNDSTAGE CUT"
    lines = [f"TITLE: {title}", "FCM: NON-DROP FRAME", ""]

    def event(num, reel, ch, si, so, ri, ro, stc=None):
        stc = stc or (lambda f: tc(source_start + f))
        return (f"{num:03d}  {reel.ljust(reel_width)} {ch:<5} {'C':<4} {'':<3} "
                f"{stc(si)} {stc(so)} {tc(start + ri)} {tc(start + ro)}")

    num = 0
    for row in layout(project):
        num += 1
        m = media_for(row["shot"], media_root)
        src = row["shot"].get("source")
        if m["rung"] == "source":
            st = source_timing(src, project)
            lines.append(event(num, source_reel(src, reel_width), "V", st["start"] + st["map"](row["in"]),
                               st["start"] + st["map"](row["out"]), row["recIn"], row["recOut"],
                               lambda f, b=st["sfi"]["base"]: frames_to_tc(f, b)))
        else:
            lines.append(event(num, reels[row["shot"]["id"]], "V", row["in"], row["out"], row["recIn"], row["recOut"]))
        lines.append(f"* FROM CLIP NAME: {_one_line(row['shot']['name'])}")
        if not m["offline"]:
            lines.append(f"* SOURCE FILE: {m['path']}")
        if m["rung"] == "source":
            lines.append(f"* SOUNDSTAGE: CAMERA ORIGINAL {_src_spec_text(src)}")
            for n in source_notes(src, project):
                lines.append(f"* SOUNDSTAGE: {n}")
        elif src:
            st = source_timing(src, project)
            lines.append(f"* SOUNDSTAGE PLATE: {src['path']} REEL {source_reel(src, 32)} "
                         f"TC {frames_to_tc(st['start'] + st['map'](row['in']), st['sfi']['base'])} {_src_spec_text(src)}")
        if relink_note(m):
            lines.append(f"* SOUNDSTAGE: {relink_note(m)}")
        locs = []  # one LOC per frame: Avid keeps a single locator per frame
        for it in note_items(row):
            same = next((l for l in locs if l["src"] == it["src"]), None)
            if same:
                same["text"] += " | " + it["text"]
            else:
                locs.append(dict(it))
        for it in locs:
            lines.append(f"* LOC: {tc(start + row['recIn'] + it['src'] - row['in'])} "
                         f"{avid_color(it.get('color')).upper():<7} {it['text']}")
        lines.append("")
    for k, lane in enumerate(audio_lanes(project)):
        ch = "A" if k == 0 else f"A{k + 1}"
        for a in lane["clips"]:
            num += 1
            lines.append(event(num, reels["audio:" + a["id"]], ch, a["in"], a["out"], a["start_frame"],
                               a["start_frame"] + audio_len(a)))
            lines.append(f"* FROM CLIP NAME: {_one_line(a['label'])}")
            lines.append(f"* SOURCE FILE: {audio_media(a, media_root)['path']}")
            fx = []
            if lane["name"] != f"A{k + 1}":
                fx.append(f"TRACK {lane['name']}")
            if a["gain_db"]:
                fx.append(f"GAIN {_gain_text(a['gain_db'])} DB")
            if a["fade_in"]:
                fx.append(f"FADE IN {a['fade_in']}")
            if a["fade_out"]:
                fx.append(f"FADE OUT {a['fade_out']}")
            if not audible(project, a["track"]):
                fx.append("MUTED")
            if fx:
                lines.append(f"* SOUNDSTAGE AUDIO: {', '.join(fx)}")
            lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- Avid locators

def _latin1_clean(s) -> str:
    s = _one_line(s)
    s = re.sub("[‘’‚‛′]", "'", s)
    s = re.sub("[“”„‟″]", '"', s)
    s = re.sub("[–—―−]", "-", s)
    return re.sub(r"[^\x00-\xff]", "?", s)


def locator_entries(project, relink=True) -> list:
    """One Avid locator per frame (notes sharing a frame joined with " | "); see exporters.mjs."""
    project = normalize_project(project)
    out = []

    def add(e):
        same = next((x for x in out if x["frame"] == e["frame"]), None)
        if not same:
            out.append(e)
            return
        same["text"] += " | " + e["text"]
        same["length"] = max(same["length"], e["length"])

    for row in layout(project):
        for it in note_items(row):
            add({"frame": row["recIn"] + it["src"] - row["in"], "user": it.get("user") or "NOTE",
                 "color": avid_color(it.get("color")), "text": f"[{row['shot']['name']}] {it['text']}", "length": 1})
        note = relink_note(media_for(row["shot"])) if relink else ""
        if note:
            add({"frame": row["recIn"], "user": "RELINK", "color": "Cyan", "text": f"[{row['shot']['name']}] {note}",
                 "length": row["len"]})
    return sorted(out, key=lambda e: e["frame"])


def to_avid_locators(project, relink=True, **_) -> str:
    project = normalize_project(project)
    fi = fps_info(project["fps"])
    start = record_start(fi["base"])
    lines = ["\t".join([_latin1_clean(e["user"]), frames_to_tc(start + e["frame"], fi["base"]), "V1", e["color"],
                        _latin1_clean(e["text"]), str(e["length"]), "", e["color"]])
             for e in locator_entries(project, relink)]
    return "\n".join(lines) + "\n" if lines else ""


# ---------------------------------------------------------------- OTIO

_OTIO_COLORS = {"RED", "GREEN", "BLUE", "CYAN", "MAGENTA", "YELLOW", "BLACK", "WHITE"}


def _rt(v, rate):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": _num(rate), "value": v}


def _tr(start, dur, rate):
    return {"OTIO_SCHEMA": "TimeRange.1", "duration": _rt(dur, rate), "start_time": _rt(start, rate)}


def to_otio(project, media_root="") -> dict:
    project = normalize_project(project)
    fi = fps_info(project["fps"])
    rate = fi["num"] / fi["den"]
    clips = []
    for row in layout(project):
        shot = row["shot"]
        m = media_for(shot, media_root)
        src = shot.get("source")
        meta = {"shot_id": shot["id"], "scene": shot["scene_name"], "setup": shot["setup"], "rung": m["rung"],
                "relink": relink_note(m)}
        if src:
            meta["source"] = dict(src, notes=source_notes(src, project))
        if m["rung"] == "source":
            st = source_timing(src, project)
            srate = st["sfi"]["num"] / st["sfi"]["den"]
            mp = st["map"]
            n_src = max(src["frames"], mp(shot["frames"]))
            clips.append({
                "OTIO_SCHEMA": "Clip.2",
                "metadata": {"soundstage": meta},
                "name": shot["name"],
                "source_range": _tr(st["start"] + mp(row["in"]), mp(row["out"]) - mp(row["in"]), srate),
                "effects": [],
                "markers": [{"OTIO_SCHEMA": "Marker.2", "metadata": {}, "name": it["text"][:60],
                             "color": str(it["color"]).upper() if str(it.get("color") or "").upper() in _OTIO_COLORS else "RED",
                             "marked_range": _tr(st["start"] + mp(it["src"]), 0, srate), "comment": it["text"]}
                            for it in note_items(row)],
                "enabled": True,
                "color": None,
                "media_references": {"DEFAULT_MEDIA": {
                    "OTIO_SCHEMA": "ExternalReference.1",
                    "metadata": {"soundstage": {"camera_original": True, "reel": source_reel(src, 32)}},
                    "name": src["path"].split("/")[-1], "available_range": _tr(st["start"], n_src, srate),
                    "available_image_bounds": None, "target_url": m["url"]}},
                "active_media_reference_key": "DEFAULT_MEDIA",
            })
            continue
        if m["offline"]:
            ref = {"OTIO_SCHEMA": "MissingReference.1", "metadata": {}, "name": shot["name"],
                   "available_range": _tr(0, shot["frames"], rate), "available_image_bounds": None}
        else:
            ref = {"OTIO_SCHEMA": "ExternalReference.1", "metadata": {}, "name": shot["name"],
                   "available_range": _tr(0, shot["frames"], rate), "available_image_bounds": None,
                   "target_url": m["url"]}
        clips.append({
            "OTIO_SCHEMA": "Clip.2",
            "metadata": {"soundstage": meta},
            "name": shot["name"],
            "source_range": _tr(row["in"], row["len"], rate),
            "effects": [],
            "markers": [{"OTIO_SCHEMA": "Marker.2", "metadata": {}, "name": it["text"][:60],
                         "color": str(it["color"]).upper() if str(it.get("color") or "").upper() in _OTIO_COLORS else "RED",
                         "marked_range": _tr(it["src"], 0, rate), "comment": it["text"]} for it in note_items(row)],
            "enabled": True,
            "color": None,
            "media_references": {"DEFAULT_MEDIA": ref},
            "active_media_reference_key": "DEFAULT_MEDIA",
        })

    def track(name, kind, children):
        return {"OTIO_SCHEMA": "Track.1", "metadata": {}, "name": name, "source_range": None, "effects": [],
                "markers": [], "enabled": True, "color": None, "children": children, "kind": kind}

    def gap(n):
        return {"OTIO_SCHEMA": "Gap.1", "metadata": {}, "name": "", "source_range": _tr(0, n, rate), "effects": [],
                "markers": [], "enabled": True, "color": None}

    audio_tracks = []
    for lane in audio_lanes(project):
        children, pos = [], 0
        for a in lane["clips"]:
            if a["start_frame"] > pos:
                children.append(gap(a["start_frame"] - pos))
            children.append({
                "OTIO_SCHEMA": "Clip.2",
                "metadata": {"soundstage": {"audio_id": a["id"], "track": a["track"], "gain_db": _num(a["gain_db"]),
                                            "fade_in": a["fade_in"], "fade_out": a["fade_out"]}},
                "name": a["label"],
                "source_range": _tr(a["in"], audio_len(a), rate),
                "effects": [],
                "markers": [],
                "enabled": audible(project, a["track"]),
                "color": None,
                "media_references": {"DEFAULT_MEDIA": {
                    "OTIO_SCHEMA": "ExternalReference.1", "metadata": {}, "name": a["label"],
                    "available_range": _tr(0, _audio_src_frames(a), rate), "available_image_bounds": None,
                    "target_url": audio_media(a, media_root)["url"]}},
                "active_media_reference_key": "DEFAULT_MEDIA",
            })
            pos = a["start_frame"] + audio_len(a)
        audio_tracks.append(track(lane["name"], "Audio", children))
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "metadata": {"soundstage": {"fps": _num(project["fps"]), "width": project["width"], "height": project["height"],
                                    **({"delivery": project["delivery"]} if project.get("delivery") else {})}},
        "name": project["name"],
        "global_start_time": _rt(record_start(fi["base"]), rate),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1", "metadata": {}, "name": "tracks", "source_range": None, "effects": [],
            "markers": [], "enabled": True, "color": None,
            "children": [track("V1", "Video", clips)] + audio_tracks,
        },
    }


# ---------------------------------------------------------------- FCPXML 1.10

def _esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _fcp_colour(src) -> str:
    if src["primaries"] == "bt2020" or src["matrix"].startswith("bt2020"):
        return {"smpte2084": "9-16-9 (Rec. 2020 PQ)", "arib-std-b67": "9-18-9 (Rec. 2020 HLG)"}.get(src["transfer"], "9-1-9 (Rec. 2020)")
    return "1-1-1 (Rec. 709)"


def _fcp_sum(fa, fia, fb, fib) -> str:
    """Rational seconds a + b, a in one timebase and b in another, as FCPXML time."""
    n = fa * fia["den"] * fib["num"] + fb * fib["den"] * fia["num"]
    d = fia["num"] * fib["num"]
    if n == 0:
        return "0s"
    g = math.gcd(abs(n), d)
    return f"{n // g}s" if d // g == 1 else f"{n // g}/{d // g}s"


def to_fcpxml(project, media_root="") -> str:
    project = normalize_project(project)
    fi = fps_info(project["fps"])
    t = lambda f: fcp_time(f, fi)  # noqa: E731
    rows = layout(project)
    total = total_frames(project)
    seq_len = sequence_frames(project)
    next_id = [2]

    def new_id():
        next_id[0] += 1
        return f"r{next_id[0] - 1}"

    assets, formats = {}, []
    for row in rows:
        sid = row["shot"]["id"]
        if sid in assets:
            continue
        media = media_for(row["shot"], media_root)
        src = None
        if media["rung"] == "source":
            sp = row["shot"]["source"]
            st = source_timing(sp, project)
            src = {"st": st, "fid": new_id(), "frames": max(sp["frames"], st["map"](row["shot"]["frames"]))}
            formats.append(f'    <format id="{src["fid"]}" frameDuration="{fcp_time(1, st["sfi"])}" '
                           f'width="{sp["width"] or project["width"]}" height="{sp["height"] or project["height"]}" '
                           f'colorSpace="{_fcp_colour(sp)}"/>')
        assets[sid] = {"id": new_id(), "shot": row["shot"], "media": media, "src": src}
    lanes = audio_lanes(project)
    audio_assets = {}
    for lane in lanes:
        for a in lane["clips"]:
            url = audio_media(a, media_root)["url"]
            if url in audio_assets:
                audio_assets[url]["frames"] = max(audio_assets[url]["frames"], _audio_src_frames(a))
            else:
                audio_assets[url] = {"id": new_id(), "name": a["label"], "frames": _audio_src_frames(a), "url": url}
    w, h = project["width"], project["height"]
    dl = project.get("delivery")
    seq_src = next((x["source"] for x in project["shots"] if x.get("source") and dl and x["name"] == dl["from"]), None)
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.10">', "  <resources>",
           f'    <format id="r1" frameDuration="{t(1)}" width="{w}" height="{h}" '
           f'colorSpace="{_fcp_colour(seq_src) if seq_src else "1-1-1 (Rec. 709)"}"/>', *formats]
    for a in assets.values():
        still = a["media"]["kind"] == "image"
        if a["src"]:
            st = a["src"]["st"]
            out.append(f'    <asset id="{a["id"]}" name="{_esc(a["media"]["path"].split("/")[-1])}" '
                       f'start="{fcp_time(st["start"], st["sfi"])}" duration="{fcp_time(a["src"]["frames"], st["sfi"])}" '
                       f'hasVideo="1" format="{a["src"]["fid"]}" videoSources="1">')
            out.append(f'      <media-rep kind="original-media" src="{_esc(a["media"]["url"])}"/>')
            out.append("    </asset>")
            continue
        out.append(f'    <asset id="{a["id"]}" name="{_esc(a["shot"]["name"])}" start="0s" '
                   f'duration="{"0s" if still else t(a["shot"]["frames"])}" hasVideo="1" format="r1" videoSources="1">')
        out.append(f'      <media-rep kind="original-media" src="{_esc(a["media"]["url"])}"/>')
        out.append("    </asset>")
    for a in audio_assets.values():
        out.append(f'    <asset id="{a["id"]}" name="{_esc(a["name"])}" start="0s" duration="{t(a["frames"])}" '
                   f'hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">')
        out.append(f'      <media-rep kind="original-media" src="{_esc(a["url"])}"/>')
        out.append("    </asset>")
    name = _esc(project["name"])
    out += ["  </resources>", "  <library>", f'    <event name="{name}">', f'      <project name="{name}">']
    start = record_start(fi["base"])
    out.append(f'        <sequence format="r1" duration="{t(seq_len)}" tcStart="{t(start)}" '
               f'tcFormat="NDF" audioLayout="stereo" audioRate="48k">')
    out.append("          <spine>")

    def local_fn(r):
        src = assets[r["shot"]["id"]]["src"]
        if src:
            st = src["st"]
            return lambda d: _fcp_sum(st["start"] + st["map"](r["in"]), st["sfi"], d, fi)
        return lambda d: t(r["in"] + d)

    items = [{"row": r, "recIn": r["recIn"], "recOut": r["recOut"], "local": local_fn(r)} for r in rows]
    if seq_len > total:
        items.append({"gap": True, "recIn": total, "recOut": seq_len, "local": t})
    anchored = [[] for _ in items]
    for k, lane in enumerate(lanes):
        for a in lane["clips"]:
            i = next((j for j, it in enumerate(items) if it["recIn"] <= a["start_frame"] < it["recOut"]), len(items) - 1)
            anchored[i].append((a, k + 1))

    def audio_xml(a, lane_no, it):
        asset = audio_assets[audio_media(a, media_root)["url"]]
        attrs = (f'ref="{asset["id"]}" lane="-{lane_no}" offset="{it["local"](a["start_frame"] - it["recIn"])}" '
                 f'name="{_esc(a["label"])}" start="{t(a["in"])}" duration="{t(audio_len(a))}" audioRole="effects"'
                 + ("" if audible(project, a["track"]) else ' enabled="0"'))
        if not a["gain_db"] and not a["fade_in"] and not a["fade_out"]:
            return [f"              <asset-clip {attrs}/>"]
        x = [f"              <asset-clip {attrs}>"]
        if a["fade_in"] or a["fade_out"]:
            x += [f'                <adjust-volume amount="{a["gain_db"]:.1f}dB">', '                  <param name="amount">']
            if a["fade_in"]:
                x.append(f'                    <fadeIn type="easeIn" duration="{t(a["fade_in"])}"/>')
            if a["fade_out"]:
                x.append(f'                    <fadeOut type="easeIn" duration="{t(a["fade_out"])}"/>')
            x += ["                  </param>", "                </adjust-volume>"]
        else:
            x.append(f'                <adjust-volume amount="{a["gain_db"]:.1f}dB"/>')
        x.append("              </asset-clip>")
        return x

    for i, it in enumerate(items):
        inner = []
        if it.get("gap"):
            for a, k in anchored[i]:
                inner += audio_xml(a, k, it)
            opening = f'<gap name="Gap" offset="{t(start + it["recIn"])}" duration="{t(it["recOut"] - it["recIn"])}"'
            if not inner:
                out.append(f"            {opening}/>")
            else:
                out += [f"            {opening}>", *inner, "            </gap>"]
            continue
        row = it["row"]
        a = assets[row["shot"]["id"]]
        still = a["media"]["kind"] == "image"
        timing = (f'offset="{t(start + row["recIn"])}" name="{_esc(row["shot"]["name"])}" '
                  f'start="{it["local"](0)}" duration="{t(row["len"])}"')
        note = relink_note(a["media"])
        if note:
            inner.append(f"              <note>{_esc(note)}</note>")
        # A still sits in a <clip> holding a <video>: the form every FCPXML reader accepts.
        if still:
            inner.append(f'              <video ref="{a["id"]}" offset="{t(row["in"])}" duration="{t(row["len"])}"/>')
        for au, k in anchored[i]:
            inner += audio_xml(au, k, it)
        for n in note_items(row):
            inner.append(f'              <marker start="{it["local"](n["src"] - row["in"])}" duration="{t(1)}" value="{_esc(n["text"])}"/>')
        opening = (f'<clip {timing} format="r1" tcFormat="NDF"' if still
                   else f'<asset-clip ref="{a["id"]}" {timing} tcFormat="NDF"')
        if not inner:
            out.append(f"            {opening}/>")
            continue
        out += [f"            {opening}>", *inner, f"            </{'clip' if still else 'asset-clip'}>"]
    out += ["          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>", ""]
    return "\n".join(out)


# ---------------------------------------------------------------- FCP7 XML (xmeml v5) for Premiere Pro

def to_xmeml(project, media_root="") -> str:
    project = normalize_project(project)
    fi = fps_info(project["fps"])
    start = record_start(fi["base"])
    W, H = project["width"], project["height"]

    def rate(ind, f=fi):
        return [f"{ind}<rate>", f"{ind}  <timebase>{f['base']}</timebase>",
                f"{ind}  <ntsc>{'TRUE' if f['den'] == 1001 else 'FALSE'}</ntsc>", f"{ind}</rate>"]

    def tc_block(ind, frames, f=fi, reel=""):
        return [f"{ind}<timecode>", *rate(ind + "  ", f), f"{ind}  <string>{frames_to_tc(frames, f['base'])}</string>",
                f"{ind}  <frame>{frames}</frame>", f"{ind}  <displayformat>NDF</displayformat>",
                *([f"{ind}  <reel>", f"{ind}    <name>{_esc(reel)}</name>", f"{ind}  </reel>"] if reel else []), f"{ind}</timecode>"]

    def pathurl(p):
        return "file://localhost" + _encode_uri(p) if p.startswith("/") else _encode_uri(p)

    files, counters = {}, {"file": 0, "clip": 0}

    def file_xml(ind, path, frames, kind, src=None):
        """src: a camera original, described at its own size, rate, timecode and reel."""
        if path in files:
            return [f'{ind}<file id="{files[path]}"/>']
        counters["file"] += 1
        fid = f"file-{counters['file']}"
        files[path] = fid
        f = src["st"]["sfi"] if src else fi
        fw = (src["s"]["width"] or W) if src else W
        fh = (src["s"]["height"] or H) if src else H
        if kind == "audio":
            media = [f"{ind}    <audio>", f"{ind}      <samplecharacteristics>", f"{ind}        <depth>24</depth>",
                     f"{ind}        <samplerate>48000</samplerate>", f"{ind}      </samplecharacteristics>",
                     f"{ind}      <channelcount>2</channelcount>", f"{ind}    </audio>"]
        else:
            media = [f"{ind}    <video>", f"{ind}      <samplecharacteristics>", *rate(f"{ind}        ", f),
                     f"{ind}        <width>{fw}</width>", f"{ind}        <height>{fh}</height>",
                     f"{ind}        <pixelaspectratio>square</pixelaspectratio>", f"{ind}      </samplecharacteristics>",
                     f"{ind}    </video>"]
        return [f'{ind}<file id="{fid}">', f"{ind}  <name>{_esc(path.split('/')[-1])}</name>",
                f"{ind}  <pathurl>{_esc(pathurl(path))}</pathurl>", *rate(ind + "  ", f), f"{ind}  <duration>{frames}</duration>",
                *tc_block(ind + "  ", src["st"]["start"] if src else 0, f, source_reel(src["s"], 32) if src else ""),
                f"{ind}  <media>", *media, f"{ind}  </media>", f"{ind}</file>"]

    def clip_id():
        counters["clip"] += 1
        return f"clipitem-{counters['clip']}"

    seq_len = sequence_frames(project)
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="5">', '  <sequence id="sequence-1">',
           f"    <name>{_esc(project['name'])}</name>", f"    <duration>{seq_len}</duration>", *rate("    "),
           *tc_block("    ", start), "    <media>", "      <video>", "        <format>", "          <samplecharacteristics>",
           *rate("            "), f"            <width>{W}</width>", f"            <height>{H}</height>",
           "            <pixelaspectratio>square</pixelaspectratio>", "          </samplecharacteristics>", "        </format>",
           "        <track>"]
    I = "            "  # noqa: E741
    for row in layout(project):
        m = media_for(row["shot"], media_root)
        sp = row["shot"].get("source")
        if m["rung"] == "source":
            st = source_timing(sp, project)
            n_src = max(sp["frames"], st["map"](row["shot"]["frames"]))
            out += [f'          <clipitem id="{clip_id()}">', f"{I}<name>{_esc(row['shot']['name'])}</name>",
                    f"{I}<enabled>TRUE</enabled>", f"{I}<duration>{n_src}</duration>", *rate(I, st["sfi"]),
                    f"{I}<start>{row['recIn']}</start>", f"{I}<end>{row['recOut']}</end>", f"{I}<in>{st['map'](row['in'])}</in>",
                    f"{I}<out>{st['map'](row['out'])}</out>", *file_xml(I, m["path"], n_src, "video", {"s": sp, "st": st})]
        else:
            out += [f'          <clipitem id="{clip_id()}">', f"{I}<name>{_esc(row['shot']['name'])}</name>",
                    f"{I}<enabled>TRUE</enabled>", f"{I}<duration>{row['shot']['frames']}</duration>", *rate(I),
                    f"{I}<start>{row['recIn']}</start>", f"{I}<end>{row['recOut']}</end>", f"{I}<in>{row['in']}</in>",
                    f"{I}<out>{row['out']}</out>", *file_xml(I, m["path"], row["shot"]["frames"], "video")]
        said = [x for x in [relink_note(m), *(source_notes(sp, project) if sp else []),
                            *([f"plate: {sp['path']} (reel {source_reel(sp, 32)})"] if sp and m["rung"] != "source" else [])] if x]
        if said:
            out += [f"{I}<comments>", *[f"{I}  <mastercomment{k + 1}>{_esc(c)}</mastercomment{k + 1}>" for k, c in enumerate(said[:4])],
                    f"{I}</comments>"]
        for n in note_items(row):
            out += [f"{I}<marker>", f"{I}  <comment>{_esc(n['text'])}</comment>", f"{I}  <name>{_esc(n['text'][:60])}</name>",
                    f"{I}  <in>{n['src']}</in>", f"{I}  <out>-1</out>", f"{I}</marker>"]
        out.append("          </clipitem>")
    out += ["        </track>", "      </video>", "      <audio>", "        <format>", "          <samplecharacteristics>",
            "            <depth>24</depth>", "            <samplerate>48000</samplerate>", "          </samplecharacteristics>",
            "        </format>"]
    for lane in audio_lanes(project):
        out.append("        <track>")
        for a in lane["clips"]:
            p = audio_media(a, media_root)["path"]
            s, e = a["start_frame"], a["start_frame"] + audio_len(a)
            out += [f'          <clipitem id="{clip_id()}">', f"{I}<name>{_esc(a['label'])}</name>",
                    f"{I}<enabled>{'TRUE' if audible(project, a['track']) else 'FALSE'}</enabled>",
                    f"{I}<duration>{_audio_src_frames(a)}</duration>", *rate(I), f"{I}<start>{s}</start>", f"{I}<end>{e}</end>",
                    f"{I}<in>{a['in']}</in>", f"{I}<out>{a['out']}</out>", *file_xml(I, p, _audio_src_frames(a), "audio"),
                    f"{I}<sourcetrack>", f"{I}  <mediatype>audio</mediatype>", f"{I}  <trackindex>1</trackindex>", f"{I}</sourcetrack>"]
            if a["gain_db"]:
                out += [f"{I}<filter>", f"{I}  <effect>", f"{I}    <name>Audio Levels</name>", f"{I}    <effectid>audiolevels</effectid>",
                        f"{I}    <effectcategory>audiolevels</effectcategory>", f"{I}    <effecttype>audiolevels</effecttype>",
                        f"{I}    <mediatype>audio</mediatype>", f"{I}    <parameter>", f"{I}      <parameterid>level</parameterid>",
                        f"{I}      <name>Level</name>", f"{I}      <valuemin>0</valuemin>", f"{I}      <valuemax>3.98109</valuemax>",
                        f"{I}      <value>{10 ** (a['gain_db'] / 20):.6f}</value>", f"{I}    </parameter>", f"{I}  </effect>",
                        f"{I}</filter>"]
            out.append("          </clipitem>")
            for n, at, align in ((a["fade_in"], s, "start"), (a["fade_out"], e - a["fade_out"], "end")):
                if not n:
                    continue
                out += ["          <transitionitem>", f"{I}<start>{at}</start>", f"{I}<end>{at + n}</end>",
                        f"{I}<alignment>{align}</alignment>", *rate(I), f"{I}<effect>", f"{I}  <name>Cross Fade (+3dB)</name>",
                        f"{I}  <effectid>KGAudioTransCrossFade3dB</effectid>", f"{I}  <effecttype>transition</effecttype>",
                        f"{I}  <mediatype>audio</mediatype>", f"{I}</effect>", "          </transitionitem>"]
        out.append("        </track>")
    out += ["      </audio>", "    </media>", "  </sequence>", "</xmeml>", ""]
    return "\n".join(out)


# ---------------------------------------------------------------- relink list

def to_relink_list(project, media_root="") -> str:
    project = normalize_project(project)
    lines = [f"Soundstage relink list: {_one_line(project['name'])}",
             "Clips cut from stand-ins. Render the Final, then relink by clip name.", "",
             "\t".join(["CLIP", "RUNG", "MEDIA", "TODO"])]
    seen = set()
    for row in layout(project):
        if row["shot"]["id"] in seen:
            continue
        seen.add(row["shot"]["id"])
        m = media_for(row["shot"], media_root)
        if m["rung"] == "final" or (m["rung"] == "source" and not relink_note(m)):
            continue
        rung = "clay (offline)" if m["offline"] else "camera original" if m["rung"] == "source" else m["rung"]
        lines.append("\t".join([row["shot"]["name"], rung, m["path"], relink_note(m)]))
    if len(lines) == 4:
        lines.append("(none: every clip is on its Final)")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- all at once

def safe_name(s) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(s or "cut")).strip("_") or "cut"


def export_all(project, reel_width=8, source_start=0, media_root="", **_) -> dict:
    base = safe_name(normalize_project(project)["name"])
    return {
        f"{base}.edl": to_edl(project, reel_width=reel_width, source_start=source_start, media_root=media_root),
        f"{base}_avid_locators.txt": to_avid_locators(project),
        f"{base}_premiere.xml": to_xmeml(project, media_root),
        f"{base}.fcpxml": to_fcpxml(project, media_root),
        f"{base}.otio": json.dumps(to_otio(project, media_root), indent=2, ensure_ascii=False) + "\n",
        "RELINK.txt": to_relink_list(project, media_root),
    }
