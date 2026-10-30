"""HTTP routes for the Director's Advisor (the app's Advisor tab). register() is idempotent.

GET  /soundstage/advisor/vocab -> {genre|movement|technique|intent|coverage: [{id, label}]}
POST /soundstage/advisor       {scene, beat?, genre?, movement?, technique?, intent?, coverage?, characters?,
                                max_shots?, stage_scene?}
                               -> {shots: [{id, name, setup, summary, why, kb_refs, camera_keys, prompts, ...}],
                                   recipe, picks, coverage, notes, backend, ms}

Picks take a KB id, a picker label, "auto" or "none". camera_keys are stage keys
[{frame, position, target, focal_mm}] in stage metres (Y-up), framed for stage_scene.shot.aspect and placed
on the actors in stage_scene, so the UI can hand them straight to stage.setCameraKeys().
The rules backend answers in milliseconds with no model or GPU.
"""
from __future__ import annotations

import time

from .advisor import advise
from .kb import PICKER_TYPES, get_kb

_REGISTERED = False

# stage.addShot() setup ids (web/stage/stage.mjs) for each advisor framing
SETUP = {"establishing": "master", "master": "master", "group": "wide", "three_shot": "wide",
         "two_shot": "two_shot", "fifty_fifty": "two_shot", "insert": "insert", "pov": "pov"}
SIZE_WORDS = {"EWS": "Extreme wide", "WS": "Wide", "FS": "Full", "COWBOY": "Cowboy", "MS": "Medium",
              "MCU": "Medium close-up", "CU": "Close-up", "ECU": "Extreme close-up", "INSERT": "Insert"}


def vocab() -> dict:
    kb = get_kb()
    out = {}
    for picker, types in PICKER_TYPES.items():
        entries = sorted(kb.of_types(*types), key=lambda e: e["name"].lower())
        out[picker] = [{"id": e["id"], "label": e["name"], "summary": e["summary"][:220]} for e in entries]
    return out


def _setup(shot: dict) -> str:
    if shot["framing"] in SETUP:
        return SETUP[shot["framing"]]
    sub = shot["subject"]
    side = "a" if sub.startswith("A") else "b" if sub.startswith("B") else None
    if shot["framing"] == "ots" and side:
        return f"ots_{side}"
    if shot["subject"] in ("A_hands", "B_hands", "prop"):
        return "insert"
    return f"single_{side}" if side else "single"


def _who(shot: dict, cast: dict) -> str:
    sub = shot["subject"]
    if sub in cast:
        return sub
    return {"both": "A+B", "all": "group", "env": "set", "A_hands": "A hands", "B_hands": "B hands",
            "prop": "prop"}.get(sub, sub)


def stage_shots(shot_list: dict, stage_scene: dict | None) -> list[dict]:
    """Advisor shots -> what the app needs: names, one-line summary, why, and stage camera keys."""
    frames = int(((stage_scene or {}).get("shot") or {}).get("frames") or 97)
    last = max(1, frames - 1)
    cast = {c["id"]: c for c in shot_list.get("cast", [])}
    out = []
    for s in shot_list["shots"]:
        c = s["camera3d"]
        start = {"frame": 0, "position": c["position"], "target": c["target"], "focal_mm": c["focal_mm"]}
        end = {"frame": last, **{k: c["end"][k] for k in ("position", "target", "focal_mm")}}
        moved = any(start[k] != end[k] for k in ("position", "target", "focal_mm"))
        size = SIZE_WORDS[s["size"]]
        who = _who(s, cast)
        out.append({
            "id": s["shot_id"],
            "name": f"{s['shot_id']} · {size} {who}".strip(),
            "setup": _setup(s),
            "summary": (f"{size} {s['framing'].replace('_', ' ')} · {s['lens']['focal_mm_ff']:.0f}mm · "
                        f"{s['angle']['vertical']}/{s['angle']['height']} · {s['movement']['id'].replace('_', ' ')}"
                        f" · {s['duration']['seconds']:g}s"),
            "purpose": s["purpose"],
            "why": s["rationale"]["why"],
            "kb_refs": s["rationale"]["kb_refs"],
            "alternatives": s["rationale"].get("alternatives", []),
            "size": s["size"], "framing": s["framing"], "subject": s["subject"],
            "lens_mm": s["lens"]["focal_mm_ff"], "movement": s["movement"]["id"],
            "seconds": s["duration"]["seconds"], "frames": s["duration"]["frames"],
            "camera_keys": [start, end] if moved else [start],
            "prompts": s["prompts"],
            "notes": s.get("notes", []),
        })
    return out


def run(body: dict) -> dict:
    t0 = time.perf_counter()
    stage_scene = body.get("stage_scene") if isinstance(body.get("stage_scene"), dict) else None
    picks = {k: str(body.get(k) or "auto") for k in ("genre", "movement", "technique", "intent", "coverage")}
    scene = str(body.get("scene") or "").strip()
    if not scene:
        raise ValueError("describe the scene first")
    fps = float(((stage_scene or {}).get("shot") or {}).get("fps") or 24)
    max_shots = max(0, min(20, int(body.get("max_shots") or 0)))
    sl = advise(scene, str(body.get("beat") or ""), picks, str(body.get("characters") or ""), max_shots, fps,
                stage_scene)
    cc = sl["coverage_check"]
    return {
        "scene_id": sl["scene_id"],
        "backend": sl["backend"],
        "recipe": sl["recipe"],
        "picks": sl["picks"],
        "intents": sl["intents"],
        "cast": sl["cast"],
        "style": {k: sl["style"].get(k) for k in ("aspect_ratio", "lighting", "color")},
        "coverage": {"verdict": cc["verdict"], "warnings": cc["warnings"]},
        "notes": sl["notes"],
        "shots": stage_shots(sl, stage_scene),
        "ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def register(routes=None) -> bool:
    """Mount the routes on ComfyUI's PromptServer (or on an aiohttp RouteTableDef passed in, for tests)."""
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    @routes.get("/soundstage/advisor/vocab")
    async def advisor_vocab(request):
        return web.json_response(vocab())

    @routes.post("/soundstage/advisor")
    async def advisor(request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        try:
            return web.json_response(run(body if isinstance(body, dict) else {}))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:  # noqa: BLE001 - report, never take the server down
            return web.json_response({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    if routes is not None:
        _REGISTERED = True
    return True
