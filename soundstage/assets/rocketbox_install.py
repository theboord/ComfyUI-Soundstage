"""Rocketbox people kit installer: the plan, and the offline per-tier texture downscale (Lifelike-only plan 4.3 / 4.5).

FLAW (L1): nothing here downloads. `plan()` lists what a one-click install WILL fetch (the files at the pinned MIT
commit, each to be checked against a sha256 recorded when Mike approves the download, one exact file at a time, with
an explicit confirmation on NDA pods) and what it builds offline. `downscale()` runs the offline step on files that
are already on disk (the maintainer's hand-copied kit), writing the per-tier textures and a manifest of their sha256,
so the converter is pinned and every re-baked file has a recorded hash (Mike's decision, 2026-11-07).

Measured on the local kit (2026-11-08, tests/js/tier.test.mjs): the "hipoly" meshes are 7,440 (man) and 8,732
(woman) triangles, already under the TP target of 15k, so NO decimation step is planned; the textures are the
budget (one kit ~29 MB at 1024 px, ~8.5 MB at 512, ~3.3 MB at 256). The specular maps are never loaded, so the
install drops them.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

PINNED_COMMIT = "0943055db6ec570bcef9f2c8b41c9e5467c808f9"   # MIT from 2020-11-17 on (web/stage/people/README.md)
REPO = "https://github.com/microsoft/Microsoft-Rocketbox"
AVATARS = {"Male_Adult_01": "m002", "Female_Adult_01": "f001"}
CLIPS = ["m_idle_neutral_01", "m_walk_neutral_01", "m_run_neutral_01", "f_idle_neutral_01", "f_walk_neutral_01", "f_run_neutral_01",
         # the seated idles a timed sit plays on the seat (web/stage/people/sitstand.mjs; avatarcore ROCKETBOX .seated).
         # Optional at run time: a kit without them folds the standing idle onto the seat instead.
         "m_sit_chair_idle_neutral_01", "f_sit_chair_idle_neutral_01"]
MAPS = ["body_color", "body_normal", "head_color", "head_normal", "opacity_color"]   # no *_specular: never loaded
TIER_TEXTURE = {"TP": 256, "T0": 512, "T1": 1024, "Hero": 1024}
CONVERTER = "Pillow LANCZOS, RGBA kept, optimize=True"


def plan() -> dict:
    """What an install fetches and builds. sha256 fields stay None until the download is approved and recorded."""
    fetch = []
    for name, tid in AVATARS.items():
        fetch.append({"path": f"Assets/Avatars/Adults/{name}/Export/{name}.fbx", "to": f"{name}.fbx", "sha256": None})
        for m in MAPS:
            fetch.append({"path": f"Assets/Avatars/Adults/{name}/Textures/{tid}_{m}.tga", "to": f"src/{tid}_{m}.tga", "sha256": None})
    for c in CLIPS:
        fetch.append({"path": f"Assets/Animations/all_animations_max_motextr_static/{c}.max.fbx", "to": f"anim/{c}.max.fbx", "sha256": None})
    build = [{"step": "tga_to_png", "size": 1024, "converter": CONVERTER, "out": "tex/"}]
    for tier, px in TIER_TEXTURE.items():
        if px < 1024:
            build.append({"step": "downscale", "tier": tier, "size": px, "converter": CONVERTER, "out": f"tex_{px}/"})
    return {"repo": REPO, "commit": PINNED_COMMIT, "fetch": fetch, "build": build, "decimate": None,
            "decimate_why": "measured 7,440 / 8,732 triangles: under every tier's target",
            "location": "ComfyUI/user/soundstage/assets/rocketbox/", "downloads_now": False}


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def downscale(src: Path, out_root: Path, sizes=(512, 256)) -> dict:
    """Offline: every used colour / normal / opacity PNG in src (the 1024 px kit textures) to out_root/tex_<px>/,
    and a manifest (input sha256, output sha256, converter) at out_root/tex_manifest.json. Returns the manifest."""
    from PIL import Image   # bundled with ComfyUI

    src, out_root = Path(src), Path(out_root)
    files = sorted(p for p in src.glob("*.png") if not p.stem.endswith("_specular"))
    man = {"converter": CONVERTER, "pillow": Image.__version__ if hasattr(Image, "__version__") else None, "files": []}
    for px in sizes:
        d = out_root / f"tex_{px}"
        d.mkdir(parents=True, exist_ok=True)
        for f in files:
            with Image.open(f) as im:
                mode = "RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB"
                small = im.convert(mode).resize((px, px), Image.LANCZOS)
                o = d / f.name
                small.save(o, optimize=True)
            man["files"].append({"in": f.name, "in_sha256": _sha(f), "size": px, "out": f"tex_{px}/{f.name}", "out_sha256": _sha(o)})
    (out_root / "tex_manifest.json").write_text(json.dumps(man, indent=1))
    return man
