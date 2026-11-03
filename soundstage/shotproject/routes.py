"""HTTP routes for Shot Projects. Registered from the pack's __init__ (register()).

POST /soundstage/project/publish   {file: 'soundstage/final_00001_.mp4 [output]', project, sequence, shot, task, note?, approve?}
GET  /soundstage/project/versions  ?project=&sequence=&shot=&task=   -> the shot task's index (latest, approved, versions)
POST /soundstage/project/approve   {project, sequence, shot, task, version}
"""
from __future__ import annotations

import asyncio

_REGISTERED = False


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    from .. import nodes_project as NP
    from . import approve, versions

    def _key(src):
        return (src.get("project") or "my-film", src.get("sequence") or "SEQ010", src.get("shot") or "SH010",
                src.get("task") or "final")

    @routes.post("/soundstage/project/publish")
    async def publish(request):
        try:
            b = await request.json()
            project, seq, shot, task = _key(b)
            rec = await asyncio.to_thread(NP.publish_take, project, seq, shot, task, b.get("file") or "",
                                          b.get("note") or "", b.get("author") or "", bool(b.get("approve")), b.get("extra") or "")
            return web.json_response({k: rec[k] for k in ("name", "number", "sequence", "shot", "task", "created", "primary", "dir")})
        except Exception as exc:  # noqa: BLE001 - the App shows the message
            return web.json_response({"error": str(exc)}, status=422)

    @routes.get("/soundstage/project/versions")
    async def list_versions(request):
        project, seq, shot, task = _key(request.query)
        root = NP.project_root(project)
        vs = versions(root, seq, shot, task)
        from . import approved_number
        return web.json_response({"latest": vs[-1]["number"] if vs else None,
                                  "approved": approved_number(root, seq, shot, task),
                                  "versions": [{k: v.get(k) for k in ("number", "name", "created", "author", "note", "primary")} for v in vs]})

    @routes.post("/soundstage/project/approve")
    async def approve_version(request):
        try:
            b = await request.json()
            project, seq, shot, task = _key(b)
            return web.json_response(approve(NP.project_root(project), seq, shot, task, b.get("version")))
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"error": str(exc)}, status=422)

    _REGISTERED = True
    return True
