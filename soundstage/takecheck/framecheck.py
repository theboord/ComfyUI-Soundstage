"""The first-frame check: does a ④ Frame candidate hold what the stage holds, where the stage holds it?

Ground truth is the stage's own ID pass for frame 1 (one flat colour per actor). The candidate is segmented with
SAM 3.1 (the checkpoint the Blocking Score already uses) once per kind on the stage (person, car, horse...). Then:

  match     each stage actor takes the detection of its kind whose silhouette overlaps its ID silhouette best
            (greedy, one to one); its score is that mask IoU.
  extra     a confident detection that matches no actor and lies mostly outside every stage silhouette is an
            object the stage never had: a ghost car behind the hero car, a bystander. Detections inside a stage
            object (the driver behind the windscreen, a reflection on the car's own paint) are not extras.
  missing   an actor big enough to see whose kind finds nothing on its silhouette.

verdict: "ok" (every actor on its silhouette, nothing extra), "loose" (an actor overlaps its silhouette by less
than ON_MARK) or "flag" (an extra or a missing object, or an actor off its mark). The App puts a badge on each
candidate in ④ Frame and re-rolls flagged ones (web/pipeline/framecheck.mjs).

A re-roll only cures a ghost that one seed made up. A ghost the prompt asks for comes back with every seed: the crate
crash's "sports car close to the camera, half the frame wide" came from a misread ID pass (look/frame_lock.py), so
the check's own ground truth is read the same careful way.

Pure numpy; SoundstageFrameCheck (nodes_takecheck.py) runs SAM and calls stage_silhouettes() and score().
"""
from __future__ import annotations

import numpy as np

VERSION = 3               # 2: SAM asked for up to 8 objects per kind (1 before: a second car went unseen)
                          # 3: solid ID silhouettes; a car painted over crates (a prop SAM never looks for) is extra
SAM_PROMPT = {"man": "person", "woman": "person", "child": "person", "person": "person", "boy": "person", "girl": "person",
              "horse": "horse", "dog": "dog", "cat": "cat", "bird": "bird", "cow": "cow"}
ON_MARK = 0.45           # silhouette IoU at which an actor is on its mark in the frame
OFF_MARK = 0.2           # below this it is somewhere else (or a different size) altogether
EXTRA_SCORE = 0.5        # detector confidence for an object to count as extra
EXTRA_OUTSIDE = 0.6      # ...and this much of it outside every stage silhouette
MIN_ACTOR_AREA = 0.0015  # actors smaller than this fraction of the frame are not judged (SAM can't see them)
MIN_EXTRA_AREA = 0.002   # nor are detections smaller than this


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


def _label(kind_prompt: str) -> str:
    return {"person": "person", "car": "car", "truck": "truck", "horse": "horse"}.get(kind_prompt, kind_prompt)


def prompt_for(kind: str) -> str | None:
    """The SAM 3.1 text prompt that finds an actor of this kind ("person", "horse", "car"), or None."""
    k = (kind or "").lower()
    if k in SAM_PROMPT:
        return SAM_PROMPT[k]
    from .detect import is_road_vehicle
    if is_road_vehicle(k):
        return "truck" if k == "truck" else "car"
    return None


def stage_silhouettes(id_rgb: np.ndarray, scene: dict) -> tuple[dict, dict]:
    """{actor_id: {mask, kind}} for the people, animals and vehicles of frame 1 (a car's occupants inside its
    silhouette), plus "_set": the set pieces SAM itself would find (a parked car, a person or horse standing as set
    dressing), so a detection on one is that set piece, not an extra. Crates, tarps and sand are nothing SAM looks
    for: they are left out, so a car painted over the crate pyramid is a ghost car. And {actor_id: name}."""
    from ..look import frame_lock as FLK
    from ..look import scene as S
    from . import blocking as B
    masks = FLK.id_masks(id_rgb, scene.get("id_colors") or {})
    actors = B.tracked_actors(scene)
    keep = {a.get("id") for a in actors}
    out = {}
    for a in actors:
        k = prompt_for(a.get("kind"))
        if k and a.get("id") in masks:
            out[a["id"]] = {"mask": masks[a["id"]].copy(), "kind": k}
    for a in scene.get("actors") or []:     # seated in a car: part of the car from outside
        host = a.get("mount_id")
        if a.get("id") not in keep and host in out and a.get("id") in masks and not float(a.get("mount_at") or 0) > 0:
            out[host]["mask"] |= masks[a["id"]]
    for a in scene.get("actors") or []:
        if a.get("id") in out or a.get("id") not in masks:
            continue
        if prompt_for(a.get("kind")) or S.classify(a)[1] in ("biped", "quadruped", "vehicle"):
            out.setdefault("_set", {"mask": np.zeros_like(masks[a["id"]]), "kind": "_set"})["mask"] |= masks[a["id"]]
    names = {a.get("id"): a.get("name") or a.get("kind") for a in scene.get("actors") or []}
    return out, names


def score(stage: dict, detections: list[dict], names: dict | None = None) -> dict:
    """stage: {actor_id: {"mask": HxW bool, "kind": SAM prompt}} (frame 1, from the ID pass).
    detections: [{"mask": HxW bool, "kind": SAM prompt, "score": 0..1}] in the candidate, at the same size.
    -> {"verdict", "score", "actors": [{id, name, kind, iou, status}], "extra": [...], "missing": [...], "why"}"""
    names = names or {}
    H, W = next(iter(stage.values()))["mask"].shape if stage else (1, 1)
    area = float(H * W)
    # kind "_set": set pieces and props, never judged, but an object detected on them is that prop, not an extra
    judged = {aid: s for aid, s in stage.items() if s["kind"] != "_set" and s["mask"].sum() / area >= MIN_ACTOR_AREA}
    pairs = []
    for aid, s in judged.items():
        for k, d in enumerate(detections):
            if d["kind"] == s["kind"]:
                v = iou(s["mask"], d["mask"])
                if v > 0.02:
                    pairs.append((v, aid, k))
    pairs.sort(reverse=True)
    taken, used, best = set(), set(), {}
    for v, aid, k in pairs:
        if aid in taken or k in used:
            continue
        taken.add(aid)
        used.add(k)
        best[aid] = (v, k)
    # An actor whose silhouette nothing overlaps, while an object of its kind stands elsewhere: it is that object,
    # off its mark (moved or resized), not a missing actor plus an extra one.
    for aid, st in sorted(judged.items(), key=lambda kv: -kv[1]["mask"].sum()):
        if aid in taken:
            continue
        free = [k for k, d in enumerate(detections) if k not in used and d["kind"] == st["kind"] and d.get("score", 1.0) >= EXTRA_SCORE]
        if free:
            k = max(free, key=lambda j: detections[j]["mask"].sum())
            taken.add(aid)
            used.add(k)
            best[aid] = (iou(st["mask"], detections[k]["mask"]), k)
    every = np.zeros((H, W), bool)
    for s in stage.values():
        every |= s["mask"]
    actors, missing = [], []
    for aid, s in judged.items():
        v = best.get(aid, (0.0, None))[0]
        st = "on" if v >= ON_MARK else "loose" if v >= OFF_MARK else ("off" if aid in best else "missing")
        row = {"id": aid, "name": names.get(aid) or aid, "kind": s["kind"], "iou": round(v, 3), "status": st}
        actors.append(row)
        if st == "missing":
            missing.append(row)
    extra = []
    for k, d in enumerate(detections):
        if k in used or d.get("score", 1.0) < EXTRA_SCORE:
            continue
        n = d["mask"].sum()
        if n / area < MIN_EXTRA_AREA:
            continue
        outside = float(np.logical_and(d["mask"], ~every).sum() / n)
        # inside a matched detection of the same object (SAM's second mask of one car) is not a new object
        dup = any(d["kind"] == detections[j]["kind"] and np.logical_and(d["mask"], detections[j]["mask"]).sum() / n > 0.6
                  for j in used)
        if outside >= EXTRA_OUTSIDE and not dup:
            ys, xs = np.nonzero(d["mask"])
            extra.append({"kind": d["kind"], "score": round(float(d.get("score", 1.0)), 3), "outside": round(outside, 3),
                          "box": [round(xs.min() / W, 3), round(ys.min() / H, 3), round((xs.max() + 1) / W, 3), round((ys.max() + 1) / H, 3)]})
    mean = float(np.mean([a["iou"] for a in actors])) if actors else None
    off = [a for a in actors if a["status"] in ("off", "missing")]
    loose = [a for a in actors if a["status"] == "loose"]
    if not actors and not extra:
        verdict, why = "unknown", "nothing on the stage is big enough in frame 1 to check"
    elif extra or off:
        verdict = "flag"
        bits = [f"an extra {_label(e['kind'])}" for e in extra]
        bits += [f"{a['name']} {'missing' if a['status'] == 'missing' else 'off its mark'}" for a in off]
        why = "; ".join(bits)
    elif loose:
        verdict, why = "loose", "; ".join(f"{a['name']} {a['iou']:.2f}" for a in loose)
    else:
        verdict, why = "ok", "every object on its clay silhouette"
    counts = {}
    for s in judged.values():
        counts.setdefault(s["kind"], [0, 0])[0] += 1
    for a in actors:
        if a["status"] != "missing":
            counts[a["kind"]][1] += 1
    for e in extra:
        counts.setdefault(e["kind"], [0, 0])[1] += 1
    return {"v": VERSION, "verdict": verdict, "score": None if mean is None else round(mean, 3), "why": why,
            "actors": actors, "extra": extra, "missing": [m["id"] for m in missing],
            "counts": {k: {"stage": c[0], "frame": c[1]} for k, c in counts.items()}}


def badge(res: dict | None) -> dict:
    """The candidate's badge in ④ Frame: {text, tone (good/warn/bad/none), title}."""
    if not res or res.get("error"):
        return {"text": "Check failed", "tone": "none", "title": (res or {}).get("error", "")}
    v = res.get("verdict")
    pct = "" if res.get("score") is None else f" {round(100 * res['score'])}%"
    if v == "ok":
        return {"text": f"✓ Matches clay{pct}", "tone": "good", "title": res.get("why", "")}
    if v == "loose":
        return {"text": f"≈ Loose{pct}", "tone": "warn", "title": res.get("why", "")}
    if v == "flag":
        return {"text": "⚠ " + (res.get("why") or "off the blocking").split(";")[0], "tone": "bad", "title": res.get("why", "")}
    return {"text": "–", "tone": "none", "title": res.get("why", "")}
