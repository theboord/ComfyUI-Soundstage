"""Download a finished Layer Pack from the server as one .zip.

GET /soundstage/layerpack/list                  -> {"packs": [{"name", "size_mb", "created"}...]} newest first
GET /soundstage/layerpack/download?name=<pack>  -> application/zip of output/soundstage_layerpacks/<pack>/
        &lite=1                                  -> leave out the per-frame PNG sequences (MOVs, EXRs, camera,
                                                    app builders and previews stay), usually far smaller
Packs are stored uncompressed (PNG, EXR and ProRes are already compressed). Names are checked so
nothing outside the Layer Pack folder can be read.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import time
import zipfile
from pathlib import Path

_REGISTERED = False


def packs_root() -> Path:
    import folder_paths
    return Path(folder_paths.get_output_directory()) / "soundstage_layerpacks"


def _pack_dir(name: str) -> Path | None:
    root = packs_root().resolve()
    p = (root / os.path.basename(name or "")).resolve()
    return p if p.is_dir() and p.parent == root else None


def _skip(rel: Path, lite: bool) -> bool:
    # Lite: drop frame sequences (layers/*/png, layers/*/matte, aovs/*/png-style folders of numbered frames).
    return lite and any(part in ("png", "matte", "depth_png", "frames") for part in rel.parts[:-1])


def build_zip(pack: Path, lite: bool = False) -> Path:
    fd, tmp = tempfile.mkstemp(prefix=f"{pack.name}_", suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        for f in sorted(pack.rglob("*")):
            if f.is_file():
                rel = f.relative_to(pack)
                if not _skip(rel, lite):
                    z.write(f, Path(pack.name) / rel)
    return Path(tmp)


def list_packs() -> list[dict]:
    root = packs_root()
    out = []
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir():
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                out.append({"name": d.name, "size_mb": round(size / 1e6, 1), "created": d.stat().st_mtime})
    return sorted(out, key=lambda p: -p["created"])


def register(routes=None) -> bool:
    global _REGISTERED
    if _REGISTERED:
        return True
    from aiohttp import web
    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.get("/soundstage/layerpack/list")
    async def _list(request):
        return web.json_response({"packs": await asyncio.to_thread(list_packs)})

    @routes.get("/soundstage/layerpack/download")
    async def _download(request):
        pack = _pack_dir(request.query.get("name", ""))
        if not pack:
            return web.json_response({"error": "no such Layer Pack"}, status=404)
        lite = request.query.get("lite") in ("1", "true", "yes")
        t0 = time.time()
        zpath = await asyncio.to_thread(build_zip, pack, lite)
        name = f"{pack.name}{'_lite' if lite else ''}.zip"
        resp = web.FileResponse(zpath, headers={"Content-Disposition": f'attachment; filename="{name}"',
                                                "Content-Type": "application/zip",
                                                "X-Soundstage-Build-Seconds": f"{time.time() - t0:.1f}"})
        # Remove the temp zip once it has been sent.
        asyncio.get_event_loop().call_later(3600, lambda: zpath.unlink(missing_ok=True))
        return resp

    _REGISTERED = True
    return True
