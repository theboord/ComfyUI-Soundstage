"""Shot Project: a versioned shot folder, so every take has a home that other tools (and ComfyUI workflows) can read.

    <root>/<SEQ>/<SHOT>/<task>/v001/  media/<files>, version.json, [recipe.json, graph.json, workflow.json, takecheck.json]
    <root>/<SEQ>/<SHOT>/<task>/       versions.json (index, rebuilt on every change), approved.json (the approved number)

Pure stdlib (no ComfyUI imports), so it is testable alone. A version only exists once its `version.json` is written
(last), so a crash mid-copy leaves a folder that `versions()` ignores. Version numbers come from `os.mkdir`, which is
atomic: two publishes at once get two numbers.

    publish(root, seq, shot, task, files, extras, note, author)   copy files in, write version.json, return it
    collect_take_extras(video_path)                               recipe / graph / take-check results of a Soundstage take
    versions(root, seq, shot, task)                               every complete version, oldest first
    approve(root, seq, shot, task, version)                       mark one version as the approved one
    resolve(root, seq, shot, task, which)                         "latest" | "approved" | "v3" | 3 -> the version, with paths
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import shutil

VERSION = 1
_BAD = re.compile(r"[^A-Za-z0-9_-]+")
TASKS = ("render", "frame", "draft", "final", "comp", "layout", "audio", "edit")


def slug(text, default: str = "x") -> str:
    """A safe folder name: letters, digits, '_' and '-'; never empty, never a path."""
    s = _BAD.sub("_", str(text or "").strip()).strip("_")
    return s[:48] or default


def task_dir(root: str, seq, shot, task) -> str:
    return os.path.join(root, slug(seq, "SEQ"), slug(shot, "SHOT"), slug(task, "render"))


def _vname(n: int) -> str:
    return f"v{n:03d}"


def _parse(which) -> int | None:
    if isinstance(which, int):
        return which
    m = re.fullmatch(r"v?(\d+)", str(which or "").strip().lower())
    return int(m.group(1)) if m else None


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_json(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def versions(root: str, seq, shot, task) -> list[dict]:
    """Every complete version of a task, oldest first (each is its version.json plus `dir`)."""
    d = task_dir(root, seq, shot, task)
    out = []
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        m = re.fullmatch(r"v(\d{3,})", name)
        if not m:
            continue
        v = _read_json(os.path.join(d, name, "version.json"))
        if isinstance(v, dict):
            v = dict(v)
            v["dir"] = os.path.join(d, name)
            out.append(v)
    out.sort(key=lambda v: v.get("number", 0))
    return out


def approved_number(root: str, seq, shot, task) -> int | None:
    a = _read_json(os.path.join(task_dir(root, seq, shot, task), "approved.json"))
    n = a.get("version") if isinstance(a, dict) else None
    return n if isinstance(n, int) else None


def _reindex(root: str, seq, shot, task) -> dict:
    vs = versions(root, seq, shot, task)
    idx = {"v": VERSION, "sequence": slug(seq, "SEQ"), "shot": slug(shot, "SHOT"), "task": slug(task, "render"),
           "latest": vs[-1]["number"] if vs else None, "approved": approved_number(root, seq, shot, task),
           "versions": [{k: v.get(k) for k in ("number", "name", "created", "author", "note", "primary")} for v in vs]}
    d = task_dir(root, seq, shot, task)
    if os.path.isdir(d):
        _write_json(os.path.join(d, "versions.json"), idx)
    return idx


def collect_take_extras(video_path: str) -> dict:
    """What a Soundstage take carries: its recipe (stage + shot), the ComfyUI graph behind it, and the cached take
    checks. Best effort: a video made elsewhere just returns less."""
    extras: dict = {}
    try:
        from ..takecheck.video import probe
        tags = probe(video_path).get("tags") or {}
    except Exception:  # noqa: BLE001 - no ffprobe, or not a video
        tags = {}
    for tag, name in (("prompt", "graph"), ("workflow", "workflow")):
        raw = tags.get(tag)
        try:
            val = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            val = None
        if isinstance(val, (dict, list)):
            extras[name] = val
    try:
        from ..takecheck import recipe as R
        rec = R.from_tags(tags)
        if rec:
            extras["recipe"] = rec
    except Exception:  # noqa: BLE001
        pass
    try:
        from ..takecheck import store
        res = store.load(video_path, "checks")
        if res:
            extras["takecheck"] = res
    except Exception:  # noqa: BLE001 - no ComfyUI folder_paths (tests / headless)
        pass
    return extras


def _copy_in(src: str, dst_dir: str, role: str) -> list[dict]:
    """Copy a file, or a whole folder (a Layer Pack), into dst_dir; return one record per file."""
    recs = []
    if os.path.isdir(src):
        base = os.path.join(dst_dir, slug(os.path.basename(os.path.normpath(src)), "folder"))
        shutil.copytree(src, base)
        for dp, _dn, fn in os.walk(base):
            for f in sorted(fn):
                p = os.path.join(dp, f)
                recs.append({"role": role, "path": os.path.relpath(p, os.path.dirname(dst_dir)),
                             "bytes": os.path.getsize(p), "sha256": _sha256(p)})
        return recs
    name = os.path.basename(src)
    dst = os.path.join(dst_dir, name)
    n = 1
    while os.path.exists(dst):   # two files with one name: keep both
        stem, ext = os.path.splitext(name)
        dst = os.path.join(dst_dir, f"{stem}_{n}{ext}")
        n += 1
    shutil.copy2(src, dst)
    return [{"role": role, "path": os.path.relpath(dst, os.path.dirname(dst_dir)),
             "bytes": os.path.getsize(dst), "sha256": _sha256(dst)}]


def publish(root: str, seq, shot, task, files, extras: dict | None = None, note: str = "", author: str = "",
            approve_it: bool = False) -> dict:
    """Publish `files` ([(path, role)] or [{"path", "role"}]; a folder is copied whole) as the next version of
    <seq>/<shot>/<task>. `extras` ({name: JSON-able}) is written as <name>.json. Returns the version record."""
    items = []
    for f in files or []:
        p, role = (f.get("path"), f.get("role")) if isinstance(f, dict) else (f[0], f[1] if len(f) > 1 else "media")
        if not p or not os.path.exists(p):
            raise FileNotFoundError(f"Nothing to publish at {p!r}")
        items.append((p, slug(role, "media")))
    if not items:
        raise ValueError("Publish needs at least one file")
    tdir = task_dir(root, seq, shot, task)
    os.makedirs(tdir, exist_ok=True)
    n = max([int(m.group(1)) for m in (re.fullmatch(r"v(\d{3,})", x) for x in os.listdir(tdir)) if m] or [0]) + 1
    while True:
        vdir = os.path.join(tdir, _vname(n))
        try:
            os.mkdir(vdir)
            break
        except FileExistsError:
            n += 1
    try:
        media = os.path.join(vdir, "media")
        os.mkdir(media)
        recs = []
        for p, role in items:
            recs += _copy_in(p, media, role)
        for name, data in (extras or {}).items():
            if data is not None:
                _write_json(os.path.join(vdir, f"{slug(name, 'extra')}.json"), data)
        primary = next((r["path"] for r in recs if r["role"] == "video"), recs[0]["path"])
        rec = {"v": VERSION, "number": n, "name": _vname(n), "sequence": slug(seq, "SEQ"), "shot": slug(shot, "SHOT"),
               "task": slug(task, "render"), "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
               "author": str(author or ""), "note": str(note or ""), "primary": primary, "files": recs,
               "extras": sorted(k for k, v in (extras or {}).items() if v is not None)}
        _write_json(os.path.join(vdir, "version.json"), rec)   # last: the version exists from here on
    except BaseException:
        shutil.rmtree(vdir, ignore_errors=True)
        raise
    if approve_it:
        _write_json(os.path.join(tdir, "approved.json"), {"version": n})
    _reindex(root, seq, shot, task)
    out = dict(rec)
    out["dir"] = vdir
    return out


def approve(root: str, seq, shot, task, version) -> dict:
    n = _parse(version)
    if n is None or not any(v.get("number") == n for v in versions(root, seq, shot, task)):
        raise ValueError(f"No version {version!r} of {slug(seq, 'SEQ')}/{slug(shot, 'SHOT')}/{slug(task, 'render')}")
    _write_json(os.path.join(task_dir(root, seq, shot, task), "approved.json"), {"version": n})
    return _reindex(root, seq, shot, task)


def resolve(root: str, seq, shot, task, which="latest") -> dict:
    """One version, with `primary_path` (absolute). Raises LookupError when there isn't one (an approved request
    with nothing approved yet falls back to nothing: say so rather than silently use the latest)."""
    vs = versions(root, seq, shot, task)
    label = f"{slug(seq, 'SEQ')}/{slug(shot, 'SHOT')}/{slug(task, 'render')}"
    if not vs:
        raise LookupError(f"{label} has no published versions")
    w = str(which or "latest").strip().lower()
    if w == "latest":
        v = vs[-1]
    elif w == "approved":
        a = approved_number(root, seq, shot, task)
        v = next((x for x in vs if x["number"] == a), None)
        if v is None:
            raise LookupError(f"{label} has no approved version yet")
    else:
        n = _parse(w)
        v = next((x for x in vs if x["number"] == n), None)
        if v is None:
            raise LookupError(f"{label} has no version {which!r}")
    out = dict(v)
    out["primary_path"] = os.path.join(v["dir"], v["primary"])
    return out
