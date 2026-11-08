"""The project library behind the start screen: list saved projects with counts and a thumbnail, and duplicate,
rename or trash one. docs/projects.md

Reads ComfyUI's per-user folder (user/<user>/), the same files the project pill writes (web/project/store.mjs):
    workflows/<name>.json                 the project
    projects/<name>/project.json          its manifest
    projects/<name>/autosave/<stamp>.json its autosaves
Delete never deletes: it moves projects/<name>/ and workflows/<name>.json to projects/.trash/<name> <stamp>/.
Project id ("p_" + 8 lowercase hex, in project.json "id" and the workflow's extra.ss_project.id; written by the pill's
Save, web/project/store.mjs): duplicate gives the copy a fresh id, rename / trash / untrash keep it, listing reads it
(None for a project saved before ids existed). Nothing here gives an old project an id: its next Save does.
Thumbnails are /view URLs of files that exist in ComfyUI's output / input / temp folders.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

from . import collect as C

TRASH = ".trash"
PROJECT_ID = re.compile(r"^p_[0-9a-f]{8}$")


def new_project_id() -> str:
    """A fresh project id: "p_" + the first 8 hex digits of a random UUID (same shape as store.mjs newProjectId)."""
    return f"p_{uuid.uuid4().hex[:8]}"


def project_id(man) -> str | None:
    """The id in a manifest dict, or None when it has none or a malformed one."""
    i = man.get("id") if isinstance(man, dict) else None
    return i if isinstance(i, str) and PROJECT_ID.match(i) else None
_STAMP = re.compile(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?\.json$")


def _ms(stamp_file: str) -> int | None:
    m = _STAMP.match(stamp_file)
    if not m:
        return None
    t = time.mktime(tuple(int(m.group(i)) for i in range(1, 7)) + (0, 0, -1))
    return int(t * 1000) + int(m.group(7) or 0)


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def project_paths(user_root: Path, name: str) -> tuple[Path, Path] | None:
    """(projects/<name>/, workflows/<name>.json) for a safe name, else None."""
    n = C.clean_name(name)
    if not n or n != str(name).strip() or n.startswith("."):
        return None
    d = C.inside(Path(user_root) / "projects", n)
    w = C.inside(Path(user_root) / "workflows", f"{n}.json")
    return (d, w) if d and w else None


# ------------------------------------------------------------------------------------------------ thumbnails & counts

IMG = (".png", ".jpg", ".jpeg", ".webp")
VID = (".mp4", ".webm", ".mov")


def _clay_still(ref: dict) -> bool:
    """An old project's clay frame (a clay_* file, or one in a clay/ folder): kept on disk as history, never a poster."""
    sub = str(ref.get("subfolder") or "").replace("\\", "/").lower().split("/")
    return str(ref.get("filename") or "").lower().startswith("clay") or "clay" in sub


def pick_thumb(props: dict, exists) -> dict | None:
    """The card's picture: the latest chosen first frame, else a look frame, else a final / draft render (shown as a
    video poster), else a stage previz (made from the Color look). Never a clay frame (Lifelike-only plan section 1.4:
    old projects' clay stills stay on disk as history, never as a poster); with none of these the App draws its
    neutral card. exists(ref) says whether the file is on disk. Returns {ref, kind} or None."""
    renders = props.get("ss_renders") if isinstance(props.get("ss_renders"), dict) else {}
    tiers = [
        [r for _, r in C.walk_refs(props.get("ss_chosen") or {})],
        [r for sid in renders for p, r in C.walk_refs(renders[sid]) if p and p[0] == "look"],
        [r for sid in renders for p, r in C.walk_refs(renders[sid]) if p and p[0] in ("final_sound", "final_audio", "final")],
        [r for sid in renders for p, r in C.walk_refs(renders[sid]) if p and p[0] == "draft"],
        [r for sid in renders for p, r in C.walk_refs(renders[sid]) if p and p[0] == "previz"],
    ]
    for tier in tiers:
        # ComfyUI's counters make later files sort later: the newest is the last name in the tier.
        for r in sorted(tier, key=lambda r: (r["subfolder"], r["filename"]), reverse=True):
            low = r["filename"].lower()
            if not low.endswith(IMG + VID) or _clay_still(r) or not exists(r):
                continue
            return {"ref": r, "kind": "video" if low.endswith(VID) else "image"}
    return None


def view_url(ref: dict) -> str:
    return "/view?" + urlencode({"filename": ref["filename"], "subfolder": ref["subfolder"], "type": ref["type"]})


def counts(wf: dict) -> dict:
    state = C.project_state(wf or {})
    scenes, shots = C.scenes_and_shots(state)
    renders = state["props"].get("ss_renders") if isinstance(state["props"].get("ss_renders"), dict) else {}
    takes = sum(1 for sid in renders for _ in C.walk_refs(renders[sid]))
    return {"scenes": len(scenes), "shots": len(shots), "takes": takes}


def _exists_in(roots: dict):
    def exists(r):
        base = roots.get(r["type"])
        rel = f"{r['subfolder']}/{r['filename']}" if r["subfolder"] else r["filename"]
        p = C.inside(Path(base), rel) if base else None
        return bool(p and p.is_file())
    return exists


# ------------------------------------------------------------------------------------------------ listing

def list_projects(user_root: Path, roots: dict) -> list[dict]:
    """Every saved project, newest first: [{name, id, saved_at (ms), counts, thumb, kind, autosave_newer, autosave_at}].
    id is the manifest's project id, or None for a project saved before ids existed (its next Save writes one)."""
    base = Path(user_root) / "projects"
    out = []
    if not base.is_dir():
        return out
    exists = _exists_in(roots)
    for d in base.iterdir():
        if not d.is_dir() or d.name.startswith(".") or not (d / "project.json").is_file():
            continue
        man = _read_json(d / "project.json") or {}
        paths = project_paths(user_root, d.name)
        wf = _read_json(paths[1]) if paths and paths[1].is_file() else None
        saved = man.get("saved_at") or int((d / "project.json").stat().st_mtime * 1000)
        autos = sorted((f.name for f in (d / "autosave").iterdir() if _STAMP.match(f.name)), reverse=True) if (d / "autosave").is_dir() else []
        auto_at = _ms(autos[0]) if autos else None
        th = pick_thumb(C.project_state(wf)["props"], exists) if wf else None
        out.append({
            "name": d.name, "id": project_id(man), "saved_at": int(saved), "counts": counts(wf) if wf else {"scenes": 0, "shots": 0, "takes": 0},
            "thumb": view_url(th["ref"]) if th else None, "thumb_kind": th["kind"] if th else None,
            "autosaves": len(autos), "autosave_at": auto_at,
            "autosave_newer": bool(auto_at and auto_at > int(saved) + 1000),
            "has_workflow": wf is not None,
        })
    return sorted(out, key=lambda p: (-p["saved_at"], p["name"].lower()))


# ------------------------------------------------------------------------------------------------ duplicate / rename / trash

def _restamp(wf_path: Path, name: str, **extra) -> None:
    wf = _read_json(wf_path)
    if isinstance(wf, dict):
        if not isinstance(wf.get("extra"), dict):
            wf["extra"] = {}
        old = wf["extra"].get("ss_project")
        wf["extra"]["ss_project"] = {**(old if isinstance(old, dict) else {}), "name": name, **extra}
        wf_path.write_text(json.dumps(wf), encoding="utf-8")


def _remanifest(d: Path, name: str, **extra) -> None:
    man = _read_json(d / "project.json") or {}
    man.update({"name": name, "workflow": f"workflows/{name}.json", **extra})
    (d / "project.json").write_text(json.dumps(man), encoding="utf-8")


def duplicate(user_root: Path, name: str, to: str) -> str:
    """Copy a project's workflow and manifest (not its autosaves) to a new name, with a fresh project id in both.
    Returns the new name."""
    src, dst = project_paths(user_root, name), project_paths(user_root, C.clean_name(to))
    if not src or not dst or not src[0].is_dir():
        raise FileNotFoundError("no such project")
    if dst[0].exists() or dst[1].exists():
        raise FileExistsError("a project with that name exists")
    new = dst[0].name
    dst[0].mkdir(parents=True)
    if (src[0] / "project.json").is_file():
        shutil.copy2(src[0] / "project.json", dst[0] / "project.json")
    pid = new_project_id()
    _remanifest(dst[0], new, created=int(time.time() * 1000), saves=0, id=pid)
    if src[1].is_file():
        dst[1].parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src[1], dst[1])
        _restamp(dst[1], new, id=pid)
    return new


def rename(user_root: Path, name: str, to: str) -> str:
    """Move a project (folder, autosaves and workflow) to a new name; its project id stays. Returns the new name."""
    src, dst = project_paths(user_root, name), project_paths(user_root, C.clean_name(to))
    if not src or not dst or not src[0].is_dir():
        raise FileNotFoundError("no such project")
    if dst[0].name == src[0].name:
        return src[0].name
    if dst[0].exists() or dst[1].exists():
        raise FileExistsError("a project with that name exists")
    new = dst[0].name
    src[0].rename(dst[0])
    _remanifest(dst[0], new)
    if src[1].is_file():
        src[1].rename(dst[1])
        _restamp(dst[1], new)
    return new


def trash(user_root: Path, name: str) -> str:
    """Move a project to projects/.trash/<name> <stamp>/ (folder contents + workflow.json). Nothing is deleted.
    Returns the trash folder name."""
    src = project_paths(user_root, name)
    if not src or not (src[0].is_dir() or src[1].is_file()):
        raise FileNotFoundError("no such project")
    tdir = Path(user_root) / "projects" / TRASH
    tdir.mkdir(parents=True, exist_ok=True)
    dest = tdir / f"{src[0].name} {time.strftime('%Y%m%d-%H%M%S')}"
    n = 2
    while dest.exists():
        dest = tdir / f"{src[0].name} {time.strftime('%Y%m%d-%H%M%S')}-{n}"
        n += 1
    if src[0].is_dir():
        src[0].rename(dest)
    else:
        dest.mkdir()
    if src[1].is_file():
        src[1].rename(dest / "workflow.json")
    return dest.name


def list_trash(user_root: Path) -> list[str]:
    t = Path(user_root) / "projects" / TRASH
    return sorted((d.name for d in t.iterdir() if d.is_dir()), reverse=True) if t.is_dir() else []


def untrash(user_root: Path, trash_name: str) -> str:
    """Put a trashed project back (under its old name, or "<name> (restored)" when that is taken)."""
    t = C.inside(Path(user_root) / "projects" / TRASH, os.path.basename(trash_name or ""))
    if not t or not t.is_dir() or t.parent.name != TRASH:
        raise FileNotFoundError("not in the trash")
    base = re.sub(r" \d{8}-\d{6}(-\d+)?$", "", t.name)
    name = base
    while (p := project_paths(user_root, name)) and (p[0].exists() or p[1].exists()):
        name = f"{base} (restored)" if name == base else f"{name}+"
    d, w = project_paths(user_root, name)
    wf = t / "workflow.json"
    if wf.is_file():
        w.parent.mkdir(parents=True, exist_ok=True)
        wf.rename(w)
        _restamp(w, name)
    t.rename(d)
    _remanifest(d, name)
    return name
