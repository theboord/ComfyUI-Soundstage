"""Project routes: Collect project, Open collected project, and the New-project template.

POST /soundstage/project/collect          {name, workflow, extras?: {script_full, timeline, cut_files}}
                                          -> {folder, name, copied, missing, bytes, zip}
GET  /soundstage/project/collect/zip?name=<Project>   -> application/zip of output/soundstage_projects/<Project>/
GET  /soundstage/project/collected        -> {"projects": [{name, collected_at, size_mb}]} newest first
POST /soundstage/project/open_collected   {name} -> {name, workflow (relinked to the copies), project}
POST /soundstage/project/upload_collected (multipart "file": a collected-project .zip) -> {name}
GET  /soundstage/project/template         -> example_workflows/Soundstage_App.json (the New project template)

The start screen (web/project/home.mjs, soundstage/project/library.py), all in the requesting user's folder:
GET  /soundstage/project/list             -> {"projects": [{name, saved_at, counts, thumb, thumb_kind, autosave_newer...}]}
POST /soundstage/project/duplicate        {name, to} -> {name}
POST /soundstage/project/rename           {name, to} -> {name}
POST /soundstage/project/trash            {name} -> {trash}   (moves to projects/.trash/, never deletes)
GET  /soundstage/project/trash            -> {"trash": [...]}
POST /soundstage/project/untrash          {trash} -> {name}

Only ComfyUI's output / input / temp / user folders are read and only output/soundstage_projects/ is written. Names
are cleaned to one path segment, and every copy / unzip target is checked to stay inside its folder.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from . import collect as C
from . import library as L

_REGISTERED = False
TEMPLATE = Path(__file__).resolve().parents[2] / "example_workflows" / "Soundstage_App.json"


def projects_root() -> Path:
    import folder_paths
    return Path(folder_paths.get_output_directory()) / C.ROOT_NAME


def _roots() -> dict:
    import folder_paths
    out = {"output": folder_paths.get_output_directory()}
    for t in ("input", "temp"):
        try:
            out[t] = folder_paths.get_directory_by_type(t)
        except Exception:  # noqa: BLE001 - older ComfyUI
            out[t] = None
    if not out.get("input") and hasattr(folder_paths, "get_input_directory"):
        out["input"] = folder_paths.get_input_directory()
    return out


def _user_dir() -> Path | None:
    try:
        import folder_paths
        return Path(folder_paths.get_user_directory())
    except Exception:  # noqa: BLE001
        return None


def user_root(request=None) -> Path:
    """The requesting user's userdata folder (user/<user>/), as ComfyUI's /userdata API resolves it."""
    try:
        from server import PromptServer
        um = getattr(PromptServer.instance, "user_manager", None)
        if um is not None and request is not None:
            p = um.get_request_user_filepath(request, None)
            if p:
                return Path(p)
    except Exception:  # noqa: BLE001 - older ComfyUI, or tests
        pass
    import folder_paths
    return Path(folder_paths.get_user_directory()) / "default"


def project_dir(name: str) -> Path | None:
    """output/soundstage_projects/<name>/ when the name is one safe segment and the folder exists."""
    n = C.clean_name(name)
    if not n or n != str(name).strip():
        return None
    p = C.inside(projects_root(), n)
    return p if p is not None and p.is_dir() and p.parent == projects_root().resolve() else None


def _inventory(roots: dict) -> tuple[list[str], list[str], dict]:
    out = Path(roots["output"])
    lp = out / "soundstage_layerpacks"
    packs = [d.name for d in lp.iterdir() if d.is_dir()] if lp.is_dir() else []
    ss = out / "soundstage"
    sheets = [f.name for f in ss.iterdir() if f.is_file() and f.name.startswith("charsheet_")] if ss.is_dir() else []
    voices = {}
    ud = _user_dir()
    vroot = ud / "soundstage" / "voices" if ud else None
    if vroot and vroot.is_dir():
        for d in vroot.iterdir():
            if d.is_dir():
                voices[d.name] = [f.name for f in d.iterdir() if f.is_file()]
    return packs, sheets, voices


def collect_project(name: str, workflow: dict, extras: dict | None = None) -> dict:
    n = C.clean_name(name)
    if not n:
        raise ValueError("give the project a name")
    if not isinstance(workflow, dict):
        raise ValueError("send the workflow")
    roots = _roots()
    packs, sheets, voices = _inventory(roots)
    plan = C.plan_collect(workflow, n, extras=extras or {}, layerpacks=packs, cast_sheets=sheets, voices=voices)
    root = projects_root()
    root.mkdir(parents=True, exist_ok=True)
    return C.write_collect(plan, roots, root, user_dir=_user_dir())


def list_collected() -> list[dict]:
    root = projects_root()
    out = []
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir() and not d.name.startswith(".") and (d / "project.json").is_file():
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                out.append({"name": d.name, "collected_at": (d / "project.json").stat().st_mtime, "size_mb": round(size / 1e6, 1)})
    return sorted(out, key=lambda p: -p["collected_at"])


def open_collected(name: str) -> dict:
    d = project_dir(name)
    if not d:
        raise FileNotFoundError("no such collected project")
    project = json.loads((d / "project.json").read_text(encoding="utf-8"))
    if project.get("format") != C.FORMAT:
        raise ValueError("that folder's project.json is not a collected Soundstage project")
    return {"name": project.get("name") or d.name, "folder": d.name, "workflow": C.relinked_workflow(project, d.name),
            "project": {k: v for k, v in project.items() if k not in ("workflow", "relink")}}


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED:
        return True
    from aiohttp import web
    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.post("/soundstage/project/collect")
    async def _collect(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "send JSON {name, workflow}"}, status=400)
        try:
            res = await asyncio.to_thread(collect_project, body.get("name", ""), body.get("workflow"), body.get("extras"))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        res["zip"] = f"/soundstage/project/collect/zip?name={res['name']}"
        res.pop("folder", None)   # no server paths to the browser
        return web.json_response(res)

    @routes.get("/soundstage/project/collect/zip")
    async def _zip(request):
        d = project_dir(request.query.get("name", ""))
        if not d:
            return web.json_response({"error": "no such collected project"}, status=404)
        z = await asyncio.to_thread(C.build_zip, d)
        resp = web.FileResponse(z, headers={"Content-Disposition": f'attachment; filename="{d.name}.zip"',
                                            "Content-Type": "application/zip"})
        # Remove the temp zip once it has been sent.
        asyncio.get_running_loop().call_later(3600, lambda: os.path.exists(z) and os.remove(z))
        return resp

    @routes.get("/soundstage/project/collected")
    async def _collected(request):
        return web.json_response({"projects": await asyncio.to_thread(list_collected)})

    @routes.post("/soundstage/project/open_collected")
    async def _open(request):
        try:
            body = await request.json()
            return web.json_response(await asyncio.to_thread(open_collected, body.get("name", "")))
        except FileNotFoundError as e:
            return web.json_response({"error": str(e)}, status=404)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)

    @routes.post("/soundstage/project/upload_collected")
    async def _upload(request):
        reader = await request.multipart()
        part = await reader.next()
        if part is None or part.name != "file":
            return web.json_response({"error": "send the .zip as 'file'"}, status=400)
        fd, tmp = tempfile.mkstemp(suffix=".zip")
        try:
            with os.fdopen(fd, "wb") as f:
                while chunk := await part.read_chunk(1 << 20):
                    f.write(chunk)
            root = projects_root()
            root.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix=".upload_", dir=root))
            try:
                name = await asyncio.to_thread(C.safe_extract, Path(tmp), stage)
                dst = root / name
                if dst.exists():
                    dst = root / f"{name} ({time.strftime('%Y%m%d-%H%M%S')})"
                shutil.move(str(stage / name), str(dst))
            finally:
                shutil.rmtree(stage, ignore_errors=True)
            return web.json_response({"name": dst.name})
        except (ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:  # noqa: BLE001 - zipfile.BadZipFile and friends
            return web.json_response({"error": f"could not read the zip: {e}"}, status=400)
        finally:
            os.path.exists(tmp) and os.remove(tmp)

    @routes.get("/soundstage/project/template")
    async def _template(request):
        if not TEMPLATE.is_file():
            return web.json_response({"error": "template missing"}, status=404)
        return web.json_response(json.loads(TEMPLATE.read_text(encoding="utf-8")))

    @routes.get("/soundstage/project/list")
    async def _list(request):
        return web.json_response({"projects": await asyncio.to_thread(L.list_projects, user_root(request), _roots())})

    async def _lib(request, fn, *keys):
        try:
            body = await request.json()
            return web.json_response(await asyncio.to_thread(fn, user_root(request), *[str(body.get(k, "")) for k in keys]))
        except FileNotFoundError as e:
            return web.json_response({"error": str(e)}, status=404)
        except FileExistsError as e:
            return web.json_response({"error": str(e)}, status=409)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)

    @routes.post("/soundstage/project/duplicate")
    async def _dup(request):
        return await _lib(request, lambda u, n, t: {"name": L.duplicate(u, n, t)}, "name", "to")

    @routes.post("/soundstage/project/rename")
    async def _ren(request):
        return await _lib(request, lambda u, n, t: {"name": L.rename(u, n, t)}, "name", "to")

    @routes.post("/soundstage/project/trash")
    async def _trash(request):
        return await _lib(request, lambda u, n: {"trash": L.trash(u, n)}, "name")

    @routes.get("/soundstage/project/trash")
    async def _trash_list(request):
        return web.json_response({"trash": await asyncio.to_thread(L.list_trash, user_root(request))})

    @routes.post("/soundstage/project/untrash")
    async def _untrash(request):
        return await _lib(request, lambda u, n: {"name": L.untrash(u, n)}, "trash")

    _REGISTERED = True
    return True
