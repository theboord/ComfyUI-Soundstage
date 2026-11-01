"""Run every take check on one MP4 and summarise it for the chips on the Ladder and in Dailies.

    result = check_take("output/soundstage/final_00028_.mp4")
    result["chips"]  -> [{"tone": "ok"|"warn"|"bad", "text": "✓ clean"}] or one chip per problem
"""
from __future__ import annotations

import time

import numpy as np

from . import blocking as B
from . import detect as D
from . import recipe as R
from .video import probe, read_frames

VERSION = 5          # bump when a detector changes, so cached results are recomputed

SEVERITY = {"black": "bad", "freeze": "warn", "stutter": "warn", "jump": "warn", "pop": "warn", "smear": "warn",
            "face": "warn", "vehicle": "bad"}
ORDER = ["vehicle", "black", "freeze", "jump", "smear", "face", "stutter", "pop"]


def chips(issues: list[dict], limit: int = 3) -> list[dict]:
    """The chips a take shows: ✓ clean, or its worst problems (bad first), plus '+N more'."""
    if not issues:
        return [{"tone": "ok", "text": "✓ clean"}]
    srt = sorted(issues, key=lambda e: (SEVERITY.get(e["kind"]) != "bad", ORDER.index(e["kind"]) if e["kind"] in ORDER else 99, e.get("start", 0)))
    out = [{"tone": SEVERITY.get(e["kind"], "warn"), "text": f"⚠ {e['label']}", "kind": e["kind"], "start": e.get("start"),
            "detail": e.get("detail", "")} for e in srt[:limit]]
    if len(srt) > limit:
        out.append({"tone": "warn", "text": f"+{len(srt) - limit} more", "detail": "; ".join(e["label"] for e in srt[limit:])})
    return out


def blocking_summary(actors: dict | None, camera: dict | None, scene: dict | None) -> dict:
    """The Ladder's one blocking score: the camera part (CPU, every take) plus the actor part once the SAM 3.1 pass
    (SoundstageBlockingScore) has run. needs_actors: the stage has actors and they haven't been measured yet."""
    acts = (actors or {}).get("actors") or []
    if scene and acts:
        ids = {a.get("id") for a in B.tracked_actors(scene)}
        acts = [a for a in acts if a.get("id") in ids]
    out = B.combine(acts, camera)
    out["camera"] = camera
    out["actors"] = acts
    has_actors = bool(scene and B.tracked_actors(scene))
    out["needs_actors"] = bool(has_actors and actors is None)
    if actors is not None and not acts:
        out["actors_note"] = actors.get("why") or "no actor could be measured"
    return out


def check_take(path: str, scene: dict | None = None, faces: bool = True, vehicles: bool = True) -> dict:
    t0 = time.time()
    cv = D._cv2()
    if cv is not None:
        try:
            cv.setNumThreads(2)       # inside ComfyUI: never compete with a render for every core
        except Exception:  # noqa: BLE001
            pass
    info = probe(path)
    fps = info["fps"] or 24.0
    rec = R.from_tags(info.get("tags") or {})
    if scene is None and rec:
        scene = rec.get("scene")
    g = read_frames(path, 512, gray=True, info=info)
    n = int(g.shape[0])
    if n == 0:
        raise RuntimeError("the video has no frames")
    # Small frames for the motion signals (2x2 mean of the 512 px decode), the 512 px ones for sharpness.
    hh, ww = g.shape[1] // 2 * 2, g.shape[2] // 2 * 2
    small = g[:, :hh, :ww].reshape(n, hh // 2, 2, ww // 2, 2).mean((2, 4)).astype(np.uint8)
    sig = D.signals(small)
    sharp = D.sharpness(g)
    issues = D.black(sig, fps) + D.freeze(sig, fps, stage=D.stage_moving(scene, n)) + D.jumps(sig, fps) + D.smear(sharp, fps)
    checks = {"black": True, "freeze": True, "jump": True, "smear": True}
    extra = {}
    need_rgb = cv is not None and ((faces) or (vehicles and scene and any(D.is_road_vehicle(a.get("kind")) for a in scene.get("actors") or [])))
    if need_rgb:
        every = 2 if n <= 200 else max(2, n // 100)
        rgb = read_frames(path, 960, gray=False, every=every, info=info)
        idx = [i * every for i in range(rgb.shape[0])]
        if faces:
            f_issues, f_info = D.faces(rgb[::2], fps, every=every * 2)
            issues += f_issues
            checks["face"] = True
            extra["face"] = f_info
        if vehicles and scene:
            v_issues, v_report = D.vehicle_direction(rgb, idx, scene, fps)
            issues += v_issues
            if v_report:
                checks["vehicle"] = True
                extra["vehicles"] = v_report
    camera = None
    if cv is not None and scene:
        try:
            camera = B.camera_part(g, scene, fps)
        except Exception as exc:  # noqa: BLE001 - an odd scene never stops the other checks
            camera = {"agree": None, "steps": 0, "conclusive": False, "why": f"camera check failed: {exc}"}
    issues.sort(key=lambda e: e.get("start", 0))
    verdict = "clean" if not issues else ("bad" if any(SEVERITY.get(e["kind"]) == "bad" for e in issues) else "warn")
    return {"version": VERSION, "verdict": verdict, "issues": issues, "chips": chips(issues), "checks": checks,
            "fps": fps, "frames": n, "duration": round(n / fps, 2), "width": info["width"], "height": info["height"],
            "recipe": {k: rec.get(k) for k in ("rung", "step", "seeds", "quality", "shot", "source") if rec and rec.get(k) is not None} if rec else None,
            "blocking": blocking_summary(None, camera, scene),
            **extra, "signals": {"diff_median": round(float(np.nanmedian(sig["diff"])) if n > 1 else 0.0, 5),
                                 "sharp_p75": round(float(np.percentile(sharp, 75)), 6)},
            "elapsed_s": round(time.time() - t0, 2)}
