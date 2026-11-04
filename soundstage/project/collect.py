"""Collect project: copy everything a Soundstage project references into one organised folder (and a .zip).

Film-post style, like Avid Consolidate or Resolve Media Management. The folder, under
ComfyUI/output/soundstage_projects/<Project>/ :

    project.json            script, Director's Book, scenes, shots, cast, locations, per-shot settings, takes
                            (which one is chosen) and the workflow, plus a relink table (original file -> copy)
    script/                 the screenplay (full text) and the lined script / ScriptSync data
    cast/<character>/       cast sheets, reference images, voice samples
    locations/<set>/        location refs, set GLB if any
    scenes/<S01>/shots/<S01_010>/
        clay/ frames/ refs/ takes/draft/ takes/final/ mattes/ depth/ camera/ sound/ layerpack/
    cut/                    timeline JSON + EDL / XML / FCPXML / OTIO (made by the App's exporters)
    README.txt              what each folder holds
    MISSING.txt             files the project names but that are not on this machine (only when there are some)

Files are copied, never moved, and named <shot>_<kind>_<take>.<ext>. Only ComfyUI's output / input / temp folders
(and the user folder, for Character Voices) are read; only output/soundstage_projects/ is written.

Pure planning (plan_collect) is separate from the copying (write_collect) so both are tested without ComfyUI.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

FORMAT = "soundstage-collected-project"
VERSION = 1
ROOT_NAME = "soundstage_projects"

SHOT_FOLDERS = ("clay", "frames", "refs", "takes/draft", "takes/final", "mattes", "depth", "camera", "sound", "layerpack")

# Render kinds (node.properties.ss_renders) and other per-shot keys -> folder inside the shot.
KIND_FOLDER = {
    "previz": "clay", "clay": "clay",
    "look": "frames", "frame": "frames", "chosen": "frames", "candidates": "frames", "frames": "frames",
    "draft": "takes/draft",
    "final": "takes/final", "final_sound": "takes/final", "final_audio": "takes/final",
    "matte": "mattes", "mattes": "mattes", "cutout": "mattes",
    "depth": "depth", "camera": "camera", "sound": "sound", "audio": "sound", "voice": "sound", "dialogue": "sound",
}

_REF_STR = re.compile(r"^(?P<path>[^\[\]]+?\.[A-Za-z0-9]{2,5})\s*\[(?P<type>output|input|temp)\]$")
_EXT_OK = re.compile(r"\.[A-Za-z0-9]{2,5}$")


# ------------------------------------------------------------------------------------------------ names & paths

def clean_name(s: str, limit: int = 80) -> str:
    """A safe single folder / file name: no slashes, no '..', no leading dot, no Windows-reserved characters."""
    t = " ".join(seg for seg in re.split(r"[\\/]+", str(s or "")) if seg.strip(" .") != "")
    t = re.sub(r'[:*?"<>|\x00-\x1f]+', " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"^\.+", "", t)
    t = re.sub(r"\.{2,}", ".", t)
    t = t.rstrip(". ").strip()
    if re.fullmatch(r"(?i)con|prn|aux|nul|com\d|lpt\d", t):
        t += "_"
    return t[:limit].strip()


def slug(s: str, limit: int = 40) -> str:
    """'Old Man (Jake)' -> 'Old_Man_Jake'. For file names inside the collected folder."""
    t = re.sub(r"[^A-Za-z0-9._-]+", "_", str(s or "")).strip("._")
    return (t[:limit].strip("._") or "x")


def inside(base: Path, rel: str) -> Path | None:
    """base/rel when it stays inside base (no '..', no absolute paths, no symlink escape), else None."""
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None
    rel = rel.replace("\\", "/")
    if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or any(p == ".." for p in rel.split("/")):
        return None
    b = Path(base).resolve()
    p = (b / rel).resolve()
    try:
        p.relative_to(b)
    except ValueError:
        return None
    return p


# ------------------------------------------------------------------------------------------------ file references

def parse_ref(v) -> dict | None:
    """A ComfyUI file reference in any of the shapes the App stores -> {filename, subfolder, type}, or None.

    'soundstage/draft_00007_.mp4 [output]', {'filename','subfolder','type'}, or a /view?filename=&subfolder=&type= URL.
    """
    if isinstance(v, dict):
        fn = v.get("filename")
        if isinstance(fn, str) and fn and _EXT_OK.search(fn):
            t = v.get("type") or "output"
            if t in ("output", "input", "temp"):
                return {"filename": os.path.basename(fn), "subfolder": str(v.get("subfolder") or "").strip("/"), "type": t}
        return None
    if not isinstance(v, str) or len(v) > 2000:
        return None
    s = v.strip()
    m = _REF_STR.match(s)
    if m:
        p = m.group("path").strip().replace("\\", "/")
        sub, _, fn = p.rpartition("/")
        return {"filename": fn, "subfolder": sub.strip("/"), "type": m.group("type")}
    if "/view?" in s or s.startswith("view?"):
        q = parse_qs(urlparse(s).query)
        fn = (q.get("filename") or [""])[0]
        if fn and _EXT_OK.search(fn):
            t = (q.get("type") or ["output"])[0]
            if t in ("output", "input", "temp"):
                return {"filename": os.path.basename(fn), "subfolder": (q.get("subfolder") or [""])[0].strip("/"), "type": t}
    return None


def ref_key(r: dict) -> str:
    return f"{r['type']}:{(r['subfolder'] + '/') if r['subfolder'] else ''}{r['filename']}"


def walk_refs(obj, path: tuple = ()):
    """Yield (path, ref) for every file reference anywhere inside obj (dicts / lists / strings)."""
    r = parse_ref(obj)
    if r:
        yield path, r
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk_refs(v, path + (str(k),))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk_refs(v, path + (i,))


def _maybe_json(v):
    if isinstance(v, str) and v[:1] in "{[":
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v if isinstance(v, (dict, list)) else None


# ------------------------------------------------------------------------------------------------ reading the workflow

def _all_nodes(wf: dict):
    for n in wf.get("nodes") or []:
        yield n
    for sg in ((wf.get("definitions") or {}).get("subgraphs") or []):
        for n in sg.get("nodes") or []:
            yield n


def project_state(wf: dict) -> dict:
    """The Soundstage state of a workflow: the stage node's properties (ss_*) and its live stage JSON."""
    props: dict = {}
    stage = None
    for n in _all_nodes(wf or {}):
        p = n.get("properties") or {}
        if any(k.startswith("ss_") for k in p):
            for k, v in p.items():
                if k.startswith("ss_") and k not in props:
                    props[k] = v
        if n.get("type") == "SoundstageStage" and stage is None:
            for v in n.get("widgets_values") or []:
                j = _maybe_json(v)
                if isinstance(j, dict) and ("shots" in j or "objects" in j):
                    stage = j
                    break
    return {"props": props, "stage": stage or {}}


def _scene_code(number, fallback_index: int) -> str:
    s = str(number if number not in (None, "") else fallback_index).strip()
    if s.isdigit():
        return f"S{int(s):02d}"
    return "S" + slug(s, 8).upper()


def scenes_and_shots(state: dict) -> tuple[list[dict], list[dict]]:
    """[{id, number, code, heading}], [{id, name, scene_id, scene, code, index}] in script / shooting order."""
    props = state["props"]
    sscript = props.get("ss_script") or {}
    script = sscript.get("script") or {}
    scenes = []
    for i, sc in enumerate(script.get("scenes") or []):
        if isinstance(sc, dict) and sc.get("id"):
            scenes.append({"id": sc["id"], "number": sc.get("number"), "code": _scene_code(sc.get("number"), i + 1),
                           "heading": sc.get("heading") or sc.get("slug") or ""})
    by_id = {s["id"]: s for s in scenes}
    live_key = sscript.get("live_scene")
    groups: list[tuple[str | None, list]] = []
    for k, st in (sscript.get("scene_stages") or {}).items():
        if k != live_key:
            groups.append((k, (st or {}).get("shots") or []))
    groups.append((live_key, (state.get("stage") or {}).get("shots") or []))
    shots, seen, per_scene = [], set(), {}
    for key, lst in groups:
        for sh in lst:
            if not isinstance(sh, dict) or not sh.get("id") or sh["id"] in seen:
                continue
            seen.add(sh["id"])
            sid = sh.get("scene_id") or (key if key in by_id else None)
            sc = by_id.get(sid)
            code = sc["code"] if sc else "S00"
            n = per_scene[code] = per_scene.get(code, 0) + 1
            shots.append({"id": sh["id"], "name": sh.get("name") or sh["id"], "scene_id": sid, "scene": code,
                          "code": f"{code}_{n * 10:03d}", "index": n - 1})
    # Shots that only appear in renders (deleted from the stage) still get a home.
    for sid in (props.get("ss_renders") or {}):
        if sid not in seen:
            seen.add(sid)
            n = per_scene["S00"] = per_scene.get("S00", 0) + 1
            shots.append({"id": sid, "name": sid, "scene_id": None, "scene": "S00", "code": f"S00_{n * 10:03d}", "index": n - 1})
    return scenes, shots


# ------------------------------------------------------------------------------------------------ planning

def _ext(fn: str) -> str:
    e = os.path.splitext(fn)[1].lower()
    return e if _EXT_OK.search(e or "") else ""


def _folder_for(path: tuple) -> str:
    for p in path:
        if isinstance(p, str):
            f = KIND_FOLDER.get(p.lower())
            if f:
                return f
            for k, f in KIND_FOLDER.items():
                if p.lower().startswith(k + "_"):
                    return f
    return "refs"


def _kind_word(path: tuple, folder: str) -> str:
    for p in path:
        if isinstance(p, str) and (p.lower() in KIND_FOLDER or any(p.lower().startswith(k + "_") for k in KIND_FOLDER)):
            return slug(p.lower(), 20)
    return folder.split("/")[-1]


def plan_collect(workflow: dict, name: str, *, extras: dict | None = None, layerpacks: list[str] | None = None,
                 cast_sheets: list[str] | None = None, voices: dict | None = None) -> dict:
    """What goes where. Pure: no file is touched.

    Returns {name, copies: [{src: ref, dest: rel}], texts: {rel: str}, layerpacks: [{pack, dest}],
             voices: [{src_rel, dest}], project: <project.json>}.
    layerpacks: names of folders in output/soundstage_layerpacks/ (matched to shots by "<shot>_" prefix).
    cast_sheets: file names in output/soundstage/ (charsheet_<who>_00001_.png), matched to characters.
    voices: {voice name: [file names inside user/soundstage/voices/<name>/]}.
    """
    extras = extras or {}
    state = project_state(workflow)
    props = state["props"]
    scenes, shots = scenes_and_shots(state)
    shot_by_id = {s["id"]: s for s in shots}
    copies: list[dict] = []
    used: set[str] = set()
    relink: dict[str, str] = {}

    def add(ref: dict, folder: str, base: str) -> str:
        key = ref_key(ref)
        if key in relink:
            return relink[key]
        ext = _ext(ref["filename"])
        n, dest = 1, None
        while True:
            dest = f"{folder}/{base}_{n:02d}{ext}"
            if dest not in used:
                break
            n += 1
        used.add(dest)
        relink[key] = dest
        copies.append({"src": ref, "dest": dest})
        return dest

    # Shots: every file named under ss_renders / ss_chosen / ss_ltx / ss_shot_cast / ss_approvals for that shot.
    shot_out = {s["id"]: {**s, "takes": [], "settings": (props.get("ss_ltx") or {}).get(s["id"]),
                          "cast": (props.get("ss_shot_cast") or {}).get(s["id"]), "layerpack": None} for s in shots}
    chosen_keys = {ref_key(r) for _, r in walk_refs(props.get("ss_chosen") or {})}
    for prop in ("ss_renders", "ss_chosen", "ss_ltx", "ss_shot_cast", "ss_approvals"):
        for sid, val in (props.get(prop) or {}).items() if isinstance(props.get(prop), dict) else []:
            sh = shot_by_id.get(sid)
            if not sh:
                continue
            for path, ref in walk_refs(val, (prop,) if prop != "ss_renders" else ()):
                folder = _folder_for(path if prop == "ss_renders" else path[1:] or ("refs",))
                if prop == "ss_chosen":
                    folder = "frames" if folder == "refs" else folder
                kind = _kind_word(path, folder) if prop == "ss_renders" else folder.split("/")[-1]
                base = f"{sh['code']}_{kind}"
                dest = add(ref, f"scenes/{sh['scene']}/shots/{sh['code']}/{folder}", base)
                take = {"kind": kind, "file": dest, "source": ref_key(ref), "chosen": ref_key(ref) in chosen_keys}
                if take not in shot_out[sid]["takes"]:
                    shot_out[sid]["takes"].append(take)

    # Layer Packs: the newest output/soundstage_layerpacks/<shot>_<stamp>/ per shot (matched on id, name or code).
    lp_plan = []
    for s in shots:
        cands = sorted(p for p in (layerpacks or []) if any(
            p.startswith(f"{slug(x, 80)}_") or p.startswith(f"{x}_") for x in (s["id"], s["name"], s["code"])))
        if cands:
            dest = f"scenes/{s['scene']}/shots/{s['code']}/layerpack/{cands[-1]}"
            lp_plan.append({"pack": cands[-1], "dest": dest})
            shot_out[s["id"]]["layerpack"] = dest

    # Cast & Locations (ss_cast.items): characters -> cast/<who>/, sets / locations -> locations/<set>/.
    cast_list, loc_list, voice_plan = [], [], []
    items = ((props.get("ss_cast") or {}).get("items") or {}) if isinstance(props.get("ss_cast"), dict) else {}
    for key, it in items.items():
        if not isinstance(it, dict):
            continue
        kind, _, who = str(key).partition(":")
        if not who:
            kind, who = "character", kind
        is_loc = kind.lower() in ("location", "loc", "set", "env", "environment")
        group = "locations" if is_loc else "cast"
        folder = f"{group}/{slug(who, 40)}"
        files = []
        for path, ref in walk_refs({k: v for k, v in it.items() if k != "url"} if it.get("ref") else it):
            files.append(add(ref, folder, f"{slug(who, 40)}_{'ref' if not is_loc else 'location'}"))
        entry = {"key": key, "name": who, "kind": kind, "files": files, "voice": it.get("voice"),
                 "description": it.get("description")}
        if not is_loc:
            sw = slug(who, 40).lower()
            for f in sorted(cast_sheets or []):
                m = re.match(r"^charsheet_(.+?)_\d+_?\.[A-Za-z0-9]+$", f)
                if m and slug(m.group(1), 40).lower() == sw:
                    entry["files"].append(add({"filename": f, "subfolder": "soundstage", "type": "output"}, folder, f"{slug(who, 40)}_castsheet"))
            v = it.get("voice")
            if v and voices and v in voices:
                for vf in voices[v]:
                    dest = f"{folder}/voice/{slug(os.path.basename(vf), 60)}"
                    voice_plan.append({"voice": v, "file": vf, "dest": dest})
                    entry["files"].append(dest)
        (loc_list if is_loc else cast_list).append(entry)

    # Anything else on the node that names a file (stage set GLBs, look refs...) goes to refs/ at the top.
    for prop, val in props.items():
        if prop in ("ss_renders", "ss_chosen", "ss_ltx", "ss_shot_cast", "ss_approvals", "ss_cast", "ss_cut", "ss_script"):
            continue
        for path, ref in walk_refs(val):
            folder = "locations/set" if ref["filename"].lower().endswith((".glb", ".gltf")) else "refs"
            add(ref, folder, slug(os.path.splitext(ref["filename"])[0], 40))
    for path, ref in walk_refs(state.get("stage") or {}):
        if ref["filename"].lower().endswith((".glb", ".gltf", ".fbx", ".obj")):
            add(ref, "locations/set", slug(os.path.splitext(ref["filename"])[0], 40))

    # Script, cut, book: text files.
    texts: dict[str, str] = {}
    sscript = props.get("ss_script") or {}
    full = extras.get("script_full") or sscript.get("script")
    if full:
        texts["script/script.json"] = json.dumps(full, indent=1, ensure_ascii=False)
        src = (full or {}).get("source") or (full or {}).get("text")
        if isinstance(src, str) and src.strip():
            texts["script/screenplay.fountain"] = src
        lined = {sc.get("id"): {k: sc.get(k) for k in ("coverage", "lined", "sync") if sc.get(k) is not None}
                 for sc in (full.get("scenes") or []) if isinstance(sc, dict)}
        lined = {k: v for k, v in lined.items() if v}
        if lined or props.get("ss_approvals"):
            texts["script/lined_script.json"] = json.dumps({"scenes": lined}, indent=1, ensure_ascii=False)
    cut = {"live": props.get("ss_cut"), "scenes": sscript.get("scene_cuts") or {}}
    if cut["live"] or cut["scenes"] or extras.get("timeline"):
        texts["cut/timeline.json"] = json.dumps(extras.get("timeline") or cut, indent=1, ensure_ascii=False)
    for fn, body in (extras.get("cut_files") or {}).items():
        n = clean_name(os.path.basename(str(fn)))
        if n and isinstance(body, str):
            texts[f"cut/{n}"] = body
    if props.get("ss_book"):
        texts["script/directors_book.json"] = json.dumps(props["ss_book"], indent=1, ensure_ascii=False)

    project = {
        "format": FORMAT, "v": VERSION, "name": name, "collected_at": int(time.time()),
        "script": {"title": (full or {}).get("title") if isinstance(full, dict) else None,
                   "file": "script/script.json" if full else None},
        "book": props.get("ss_book"),
        "scenes": scenes,
        "shots": [shot_out[s["id"]] for s in shots],
        "cast": cast_list, "locations": loc_list,
        "cut": {"timeline": "cut/timeline.json" if "cut/timeline.json" in texts else None,
                "exports": sorted(k for k in texts if k.startswith("cut/") and k != "cut/timeline.json")},
        "relink": relink,
        "workflow": workflow,
    }
    return {"name": name, "copies": copies, "texts": texts, "layerpacks": lp_plan, "voices": voice_plan, "project": project}


# ------------------------------------------------------------------------------------------------ writing

README = """{name}: a collected Soundstage project
{rule}

Made by Soundstage's "Collect project" on {when}. Every file the project uses was COPIED here (the originals were
left where they were) and renamed <shot>_<kind>_<take>.<ext>.

project.json            Everything about the project in one file: script, Director's Book, scenes, shots, cast,
                        locations, per-shot settings (LTX), every take with the chosen one marked, the cut, and the
                        ComfyUI workflow itself. "relink" maps each original file to its copy here.
script/                 The screenplay (script.json; screenplay.fountain when the source text was kept), the lined
                        script / ScriptSync data, and the Director's Book.
cast/<character>/       Reference images, cast sheets and the Character Voice samples of each character.
locations/<set>/        Location references; locations/set/ holds 3D set files (GLB).
scenes/<S01>/shots/<S01_010>/
    clay/               clay previz renders
    frames/             look frames and the chosen frame of the shot
    refs/               anything else the shot names (reference images, inputs)
    takes/draft/        draft videos
    takes/final/        final videos (with sound when there is one)
    mattes/ depth/ camera/ sound/
    layerpack/          the shot's newest Layer Pack (layers, mattes, depth, camera, app builders)
cut/                    timeline.json plus the editor exports (EDL, Premiere XML, FCPXML, OTIO) when the App made them.
MISSING.txt             Files the project names that were not found on the machine it was collected on.

To open this project on another machine: unzip it into ComfyUI/output/soundstage_projects/ and use
Soundstage's project menu › Open collected project. The App relinks every file to the copies in this folder.
"""


def write_collect(plan: dict, roots: dict, dest_root: Path, *, user_dir: Path | None = None) -> dict:
    """Copy and write the plan into dest_root/<name>/. roots = {"output": dir, "input": dir, "temp": dir}.
    Missing files are listed in MISSING.txt (never an error). Returns {folder, copied, missing, bytes}."""
    name = clean_name(plan["name"]) or "Untitled"
    out = Path(dest_root).resolve() / name
    if out.parent != Path(dest_root).resolve():
        raise ValueError("bad project name")
    tmp = out.with_name(f".{name}.collecting")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    missing, copied, nbytes, gone = [], 0, 0, set()
    try:
        for c in plan["copies"]:
            ref = c["src"]
            base = roots.get(ref["type"])
            rel = f"{ref['subfolder']}/{ref['filename']}" if ref["subfolder"] else ref["filename"]
            src = inside(Path(base), rel) if base else None
            dst = inside(tmp, c["dest"])
            if dst is None:
                missing.append(f"{c['dest']}\t(refused: unsafe destination)")
                continue
            if src is None or not src.is_file():
                missing.append(f"{ref_key(ref)}\t-> {c['dest']}")
                gone.add(ref_key(ref))
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied += 1
            nbytes += dst.stat().st_size
        lp_root = Path(roots["output"]) / "soundstage_layerpacks"
        for lp in plan["layerpacks"]:
            src = inside(lp_root, lp["pack"])
            dst = inside(tmp, lp["dest"])
            if src is None or dst is None or not src.is_dir():
                missing.append(f"layer pack {lp['pack']}\t-> {lp['dest']}")
                continue
            shutil.copytree(src, dst, symlinks=False)
            copied += 1
        vroot = Path(user_dir) / "soundstage" / "voices" if user_dir else None
        for v in plan["voices"]:
            src = inside(vroot, f"{v['voice']}/{v['file']}") if vroot else None
            dst = inside(tmp, v["dest"])
            if src is None or dst is None or not src.is_file():
                missing.append(f"voice {v['voice']}/{v['file']}\t-> {v['dest']}")
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied += 1
        for rel, body in plan["texts"].items():
            dst = inside(tmp, rel)
            if dst is None:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(body, encoding="utf-8")
        for s in plan["project"]["shots"]:
            for f in SHOT_FOLDERS:
                (tmp / "scenes" / s["scene"] / "shots" / s["code"] / f).mkdir(parents=True, exist_ok=True)
        for d in ("script", "cast", "locations", "cut"):
            (tmp / d).mkdir(exist_ok=True)
        project = dict(plan["project"])
        project["missing"] = missing
        project["relink"] = {k: v for k, v in (project.get("relink") or {}).items() if k not in gone}
        (tmp / "project.json").write_text(json.dumps(project, indent=1, ensure_ascii=False), encoding="utf-8")
        title = f"{name}"
        (tmp / "README.txt").write_text(README.format(name=title, rule="=" * (len(title) + 35),
                                                      when=time.strftime("%Y-%m-%d %H:%M")), encoding="utf-8")
        if missing:
            (tmp / "MISSING.txt").write_text(
                "These files are named by the project but were not found when it was collected.\n"
                "The rest of the project was collected; re-render these or copy them in by hand.\n\n"
                + "\n".join(missing) + "\n", encoding="utf-8")
        if out.exists():
            old = out.with_name(f".{name}.old")
            if old.exists():
                shutil.rmtree(old)
            out.rename(old)
            tmp.rename(out)
            shutil.rmtree(old, ignore_errors=True)
        else:
            tmp.rename(out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"folder": str(out), "name": name, "copied": copied, "missing": missing, "bytes": nbytes}


def build_zip(folder: Path) -> Path:
    """The collected folder as one .zip (stored, not compressed: video and PNG already are)."""
    folder = Path(folder)
    fd, tmp = tempfile.mkstemp(prefix=f"{folder.name}_", suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        for f in sorted(folder.rglob("*")):
            if f.is_file() and not f.is_symlink():
                z.write(f, Path(folder.name) / f.relative_to(folder))
    return Path(tmp)


def safe_extract(zip_path: Path, dest_root: Path) -> str:
    """Unpack a collected-project zip into dest_root/<top folder>/, refusing any entry that would land outside it.
    Returns the project folder name."""
    dest_root = Path(dest_root).resolve()
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        tops = {n.replace("\\", "/").split("/")[0] for n in names}
        if len(tops) != 1:
            raise ValueError("the zip should hold one project folder")
        top = clean_name(tops.pop())
        if not top or not any(n.replace("\\", "/") == f"{top}/project.json" for n in names):
            raise ValueError("no project.json at the top of the zip")
        for info in z.infolist():
            n = info.filename.replace("\\", "/")
            if n.endswith("/"):
                continue
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"symlink in zip: {n}")
            dst = inside(dest_root, n)
            if dst is None or not n.startswith(f"{top}/"):
                raise ValueError(f"unsafe path in zip: {n}")
        for info in z.infolist():
            n = info.filename.replace("\\", "/")
            if n.endswith("/"):
                continue
            dst = inside(dest_root, n)
            dst.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(dst, "wb") as f:
                shutil.copyfileobj(src, f)
    return top


# ------------------------------------------------------------------------------------------------ re-opening

def relinked_workflow(project: dict, folder_name: str) -> dict:
    """The project's workflow with every file it names pointed at the copies in
    output/soundstage_projects/<folder_name>/ (so it renders the same on another machine)."""
    relink = project.get("relink") or {}
    prefix = f"{ROOT_NAME}/{folder_name}"

    def to_ref(old: dict):
        new = relink.get(ref_key(old))
        if not new:
            return None
        sub, _, fn = f"{prefix}/{new}".rpartition("/")
        return {"filename": fn, "subfolder": sub, "type": "output"}

    def fix(v):
        r = parse_ref(v)
        if r:
            n = to_ref(r)
            if not n:
                return v
            if isinstance(v, dict):
                return {**v, **n}
            if isinstance(v, str) and "/view?" in v or (isinstance(v, str) and v.startswith("view?")):
                u = urlparse(v)
                from urllib.parse import urlencode
                q = {k: vals[0] for k, vals in parse_qs(u.query).items()}
                q.update(n)
                return u._replace(query=urlencode(q)).geturl()
            return f"{n['subfolder']}/{n['filename']} [output]"
        if isinstance(v, dict):
            return {k: fix(x) for k, x in v.items()}
        if isinstance(v, list):
            return [fix(x) for x in v]
        if isinstance(v, str) and v[:1] in "{[" and len(v) < 50_000_000:
            j = _maybe_json(v)
            if j is not None:
                fixed = fix(j)
                if fixed != j:
                    return json.dumps(fixed)
        return v

    return fix(project.get("workflow") or {})
