"""Camera setups for the stage: coverage from the Director's Advisor, plus single setups on demand
("give me an over-the-shoulder on the woman") composed with the same lens math.
"""
from __future__ import annotations

import json
import math

from ..cine import geometry as G
from . import catalog as C
from . import space as S

PREFERRED_SIDE = (0.0, 0.0, -1.0)  # cameras live on -Z: the open side of the interior and tank sets


def people(scene: dict) -> list[dict]:
    return [a for a in scene.get("actors", []) if a.get("kind") in C.PEOPLE]


def last_frame(scene: dict) -> int:
    return max(1, int((scene.get("shot") or {}).get("frames", 97)) - 1)


def keys_from(cam: dict, end: dict | None, scene: dict) -> list[dict]:
    k0 = {"frame": 0, "position": G.r3(cam["position"]), "target": G.r3(cam["target"]),
          "focal_mm": round(float(cam["focal_mm"]), 1)}
    keys = [k0]
    if end and (G.r3(end["position"]) != k0["position"] or G.r3(end["target"]) != k0["target"]
                or abs(float(end["focal_mm"]) - k0["focal_mm"]) > 0.05):
        keys.append({"frame": last_frame(scene), "position": G.r3(end["position"]), "target": G.r3(end["target"]),
                     "focal_mm": round(float(end["focal_mm"]), 1)})
    return keys


def _setup_for(shot: dict, order: dict) -> str:
    fr, size, subj = shot.get("framing", ""), shot.get("size", ""), str(shot.get("subject", ""))
    letter = "b" if subj.startswith("B") else "a"
    if subj[:1] not in order:  # "env", "group", "all", "both": not a single person's shot
        return "two_shot" if subj == "both" or "two" in fr or "fifty" in fr else "wide"
    if "ots" in fr or "over" in fr or "dirty" in fr:
        return f"ots_{letter}"
    if "insert" in fr or size == "INSERT":
        return "insert"
    if "pov" in fr:
        return "pov"
    if fr in ("two_shot", "fifty_fifty", "two-shot") or subj == "both":
        return "two_shot"
    if fr == "master":
        return "master"
    if fr in ("establishing",) or size in ("EWS", "WS"):
        return "wide"
    if "single" in fr or "close" in fr or size in ("MS", "MCU", "CU", "ECU", "COWBOY", "FS"):
        return f"single_{letter}"
    return "master"


def _rotate_about(p, c, deg):
    v = G.rot_y(G.sub(tuple(p), tuple(c)), deg)
    return list(G.add(tuple(c), v))


def coverage(scene: dict, text: str, n_shots: int = 4, intent: dict | None = None) -> tuple[list[dict], list[str]]:
    """Run the Director's Advisor on the scene's people and turn its shot list into stage shots, then apply the
    camera intent from the text (height: eye|low|high|overhead, move: static|track)."""
    intent = {"height": "eye", "move": "static", **(intent or {})}
    from ..cine.advisor import advise

    notes: list[str] = []
    cast = people(scene)
    set_name = scene["environment"]["set"]
    if not cast:  # a set with no people: one wide on the stage centre
        sx, sz = C.SETS[set_name]["stage"]
        cam = {"position": [sx, 1.7, sz - 8], "target": [sx, 1.0, sz], "focal_mm": 28}
        cam, _ = S.clamp_camera(cam, set_name)
        return [{"id": "shot_1", "name": "Wide", "setup": "wide", "camera_keys": keys_from(cam, None, scene)}], notes
    # People who stay put are the scene's A/B; anyone passing through comes after them.
    cast = sorted(cast, key=lambda a: len(a.get("keys") or []) > 1)
    # The advisor puts side-A cameras on the left of the A->B line; order A/B so that side is -Z.
    order = cast[:4]
    if len(order) >= 2:
        a, b = order[0]["position"], order[1]["position"]
        n = G.cross(G.UP, G.flat(G.sub(tuple(b), tuple(a))))
        if G.dot(n, PREFERRED_SIDE) < 0:
            order[0], order[1] = order[1], order[0]
    stage_scene = {"actors": [{"id": a["id"], "name": a.get("name"), "kind": a["kind"], "position": a["position"],
                               "height_m": a.get("height_m", C.LIBRARY[a["kind"]]["height"])} for a in order]}
    try:
        sl = advise(text or "a scene", stage_scene=stage_scene, max_shots=max(1, min(4, n_shots)))
    except Exception as e:  # noqa: BLE001 - the advisor must never take the build down
        notes.append(f"advisor failed ({e}); using a simple wide")
        return coverage({**scene, "actors": []}, text, 1)[0], notes
    by_letter = {chr(65 + i): a for i, a in enumerate(order)}
    rot = 0.0
    if len(order) == 1:
        # A lone actor: the advisor assumes they face +X. Turn its cameras to wherever ours faces.
        f = order[0].get("rotation_deg", 0)
        face = (math.sin(math.radians(f)), 0.0, math.cos(math.radians(f)))
        rot = math.degrees(math.atan2(-face[2], face[0]))
    centre = order[0]["position"]
    shots = []
    for s in sl["shots"][:4]:
        c3 = s["camera3d"]
        cam = {"position": c3["position"], "target": c3["target"], "focal_mm": c3["focal_mm"]}
        end = dict(c3.get("end") or cam)
        if rot:
            for c in (cam, end):
                c["position"] = _rotate_about(c["position"], centre, rot)
                c["target"] = _rotate_about(c["target"], centre, rot)
        cam, ch1 = S.clamp_camera(cam, set_name)
        end, ch2 = S.clamp_camera(end, set_name)
        if ch1 or ch2:
            notes.append(f"shot {s['shot_id']}: camera pulled inside the {C.SETS[set_name]['label'].lower()}")
        setup = _setup_for(s, by_letter)
        subj = str(s.get("subject", ""))
        who = by_letter.get(subj[:1])
        cam, end = shape(setup, cam, end, who, scene, intent)
        label = C.SETUPS.get(setup, "Setup")
        name = f"{label} ({s.get('size')})" if not who or setup in ("wide", "master", "two_shot") else \
            f"{label.rsplit(' ', 1)[0] if setup.endswith(('_a', '_b')) else label} on {who.get('name')} ({s.get('size')})"
        shots.append({"id": f"shot_{len(shots) + 1}", "name": name, "setup": setup, "subject_id": (who or {}).get("id"),
                      "camera_keys": keys_from(cam, end, scene),
                      "why": (s.get("rationale") or {}).get("why", "")[:300],
                      "lens_mm": c3["focal_mm"], "movement": (s.get("movement") or {}).get("id", "static")})
    # Trimmed recipes can repeat a setup (first and last shot both the master): keep one of each camera,
    # treating two wides from about the same place as the same setup.
    def same(a, b):
        ka, kb = a["camera_keys"][0], b["camera_keys"][0]
        wide = {"wide", "master", "two_shot"}
        return (json.dumps(a["camera_keys"]) == json.dumps(b["camera_keys"]) or
                (a["setup"] in wide and b["setup"] in wide and math.dist(ka["target"], kb["target"]) < 1.5
                 and math.dist(ka["position"], kb["position"]) < 6))
    uniq = []
    for sh in shots:
        if not any(same(sh, u) for u in uniq):
            uniq.append(sh)
    # Merged duplicates can leave fewer setups than asked for: fill with angles on the cast.
    fills = [("single", c) for c in order[:2]] + [("insert", order[0])]
    for kind_, c in fills:
        if len(uniq) >= max(1, min(4, n_shots)):
            break
        if any(u.get("subject_id") == c["id"] and u["setup"].startswith(kind_[:6]) for u in uniq):
            continue
        cam = compose(kind_, c, None, scene)
        cam, end = shape("single_a" if kind_ == "single" else "insert", cam, dict(cam), c, scene, intent)
        uniq.append({"name": f"{'Single' if kind_ == 'single' else 'Insert'} on {c.get('name')}",
                     "setup": "single_a" if kind_ == "single" and c is order[0] else ("single_b" if kind_ == "single" else "insert"),
                     "subject_id": c["id"], "camera_keys": keys_from(cam, end, scene), "why": "", "lens_mm": cam["focal_mm"],
                     "movement": "static" if len(keys_from(cam, end, scene)) == 1 else "track"})
    # Someone who moves through the scene gets a shot that travels with them.
    covered = {sh.get("subject_id") for sh in uniq}
    for m in [a for a in cast if a["id"] not in covered and (len(a.get("keys") or []) > 1 or a.get("mount_id"))][:1]:
        host = next((h for h in scene["actors"] if h["id"] == m.get("mount_id")), None)
        if len(m.get("keys") or []) < 2 and not (host and len(host.get("keys") or []) > 1):
            continue
        f = 50.0 if m.get("mount_id") else 65.0
        cam = compose("single", m, None, scene, f)
        if m.get("mount_id"):  # frame the rider up on the mount
            lift = (host or {}).get("height_m", 1.6) * 0.75 if host and host["kind"] == "horse" else 0.3
            cam = dict(cam, target=[cam["target"][0], round(cam["target"][1] + lift, 3), cam["target"][2]],
                       position=[cam["position"][0], round(cam["position"][1] + lift * 0.6, 3), cam["position"][2]])
        cam, end = shape("single_a", cam, dict(cam), m, scene, intent)
        sh = {"name": f"Tracking single on {m.get('name')}", "setup": "single_a", "subject_id": m["id"],
              "camera_keys": keys_from(cam, end, scene), "why": "The character crossing the scene gets a shot that "
              "travels with them, so the move reads from their side.", "lens_mm": f, "movement": "track"}
        if len(uniq) >= 4:
            uniq[-1] = sh
        else:
            uniq.append(sh)
    shots = [dict(sh, id=f"shot_{i + 1}") for i, sh in enumerate(uniq)]
    verdict = (sl.get("coverage_check") or {}).get("verdict")
    if verdict:
        notes.append(f"advisor recipe '{sl['recipe']['name']}', coverage check: {verdict}")
    return shots, notes


# ---- camera intent: height, pitch, tracking ----------------------------------------------------------

HEIGHTS = {"eye": 1.5, "low": 0.6, "high": 3.4}
MAX_PITCH = {"eye": 30.0, "low": 30.0, "high": 38.0, "overhead": 90.0}


def movers(scene: dict) -> list[dict]:
    """Objects with a path (a rider moves with its mount, whose keys it mirrors)."""
    return [a for a in scene.get("actors", []) if len(a.get("keys") or []) > 1 and not a.get("mount_id")]


def _delta(a: dict) -> tuple:
    k = a.get("keys") or []
    if len(k) < 2:
        return (0.0, 0.0, 0.0)
    return (k[-1]["position"][0] - k[0]["position"][0], 0.0, k[-1]["position"][2] - k[0]["position"][2])


def _limit_pitch(cam: dict, max_deg: float) -> dict:
    """Push a camera back horizontally until it looks down no steeper than max_deg (no accidental top-downs)."""
    p, t = list(cam["position"]), list(cam["target"])
    dy = p[1] - t[1]
    horiz = math.hypot(p[0] - t[0], p[2] - t[2])
    if dy <= 0 or math.degrees(math.atan2(dy, max(horiz, 1e-6))) <= max_deg:
        return cam
    need = dy / math.tan(math.radians(max_deg))
    d = G.flat((p[0] - t[0], 0.0, p[2] - t[2])) if horiz > 1e-3 else (0.0, 0.0, -1.0)
    newp = [t[0] + d[0] * need, p[1], t[2] + d[2] * need]
    old = math.dist(p, t)
    return dict(cam, position=G.r3(newp), focal_mm=round(float(cam["focal_mm"]) * math.dist(newp, t) / max(old, 1e-6), 1))


def shape(setup: str, cam: dict, end: dict, who: dict | None, scene: dict, intent: dict) -> tuple[dict, dict]:
    """Apply height intent, sane pitch and tracking to one advisor camera."""
    set_name = scene["environment"]["set"]
    h = intent.get("height", "eye")
    moved = (G.sub(tuple(end["position"]), tuple(cam["position"])), G.sub(tuple(end["target"]), tuple(cam["target"])),
             float(end["focal_mm"]) / max(float(cam["focal_mm"]), 1e-6))
    if setup in ("wide", "master", "two_shot") and h != "overhead":
        other = None
        cast = people(scene)
        if setup == "two_shot" and who is not None:
            rest = [c for c in cast if c["id"] != who["id"]]
            other = rest[0] if rest else None
        cam = compose("two_shot" if other else "wide", who or (cast[0] if cast else None), other, scene,
                      float(cam["focal_mm"]), height=HEIGHTS.get(h, 1.5))
    elif h == "low" and setup.startswith("single"):
        # Low angle on a close shot: half a metre under the eyeline, not on the floor.
        y = max(HEIGHTS["low"], float(cam["target"][1]) - 0.5)
        cam = dict(cam, position=[cam["position"][0], round(y, 3), cam["position"][2]])
    elif h == "high" and not setup.startswith(("ots", "pov", "insert")):
        cam = dict(cam, position=[cam["position"][0], max(cam["position"][1], float(cam["target"][1]) + 1.2), cam["position"][2]])
    cam = _limit_pitch(cam, MAX_PITCH.get(h, 30.0))
    cam, _ = S.clamp_camera(cam, set_name)
    # Keep the advisor's own move (dolly in, crane…) relative to the reshaped start.
    end = {"position": G.r3(G.add(tuple(cam["position"]), moved[0])), "target": G.r3(G.add(tuple(cam["target"]), moved[1])),
           "focal_mm": round(float(cam["focal_mm"]) * moved[2], 1)}
    # Tracking: a moving subject keeps its framing; "tracking" in the text makes the wides follow the mover too.
    mv = movers(scene)
    follow = None
    if who is not None:
        follow = who if len(who.get("keys") or []) > 1 and not who.get("mount_id") else \
            next((a for a in scene["actors"] if a["id"] == who.get("mount_id")), None)
    if follow is None and intent.get("move") == "track" and mv and setup in ("wide", "master", "two_shot"):
        follow = mv[0]
    if follow is not None and len(follow.get("keys") or []) > 1 and setup != "insert":
        d = _delta(follow)
        if setup in ("wide", "master", "two_shot") and who is None or follow is not who:
            # Re-aim the start on the mover so the track keeps it in frame from first to last frame.
            start = follow["keys"][0]["position"]
            off = G.sub(tuple(cam["position"]), tuple(cam["target"]))
            tgt = (start[0], cam["target"][1], start[2])
            cam = dict(cam, target=G.r3(tgt), position=G.r3(G.add(tgt, off)))
        end = {"position": G.r3(G.add(tuple(cam["position"]), d)), "target": G.r3(G.add(tuple(cam["target"]), d)),
               "focal_mm": cam["focal_mm"]}
    elif intent.get("move") == "track" and setup in ("wide", "master") and not mv:
        _, right, _ = G.basis(tuple(cam["position"]), tuple(cam["target"]))
        d = G.mul(G.flat(right), 2.5)
        end = {"position": G.r3(G.add(tuple(cam["position"]), d)), "target": G.r3(G.add(tuple(cam["target"]), d)),
               "focal_mm": cam["focal_mm"]}
    end, _ = S.clamp_camera(end, set_name)
    return cam, end


# ---- single setups for chat edits --------------------------------------------------------------------

def _eye(a: dict) -> float:
    return float(a.get("height_m") or C.LIBRARY.get(a.get("kind"), C.LIBRARY["man"])["height"]) * 0.93


def _top(a: dict) -> float:
    return float(a.get("height_m") or C.LIBRARY.get(a.get("kind"), C.LIBRARY["man"])["height"])


def _facing(a: dict) -> tuple:
    r = math.radians(float(a.get("rotation_deg") or 0))
    return (math.sin(r), 0.0, math.cos(r))


def _frame_points(pts, view, f, top, size, cam_y, margin):
    """Camera on `view` side of the points, far enough (by the lens FOV) that their spread plus a margin fits
    the frame width and the size's height fits the frame height. Horizontal distance, camera at cam_y."""
    cx = sum(p[0] for p in pts) / len(pts)
    cz = sum(p[2] for p in pts) / len(pts)
    view = G.flat(view)
    lateral = G.flat(G.cross(G.UP, view))
    half = max([abs(G.dot(G.sub(p, (cx, 0, cz)), lateral)) for p in pts] + [0.3])
    depth = max([G.dot(G.sub(p, (cx, 0, cz)), view) for p in pts] + [0.0])  # nearest point toward the camera
    span = 2 * half + margin
    dist = max(G.distance_for_width(span, f), G.distance_for_height(G.frame_height(size, top), f)) + depth
    target = (cx, min(G.frame_center_y(size, top), 1.3), cz)
    pos = G.add((cx, 0.0, cz), G.mul(view, dist))
    return (pos[0], cam_y, pos[2]), target


def compose(setup: str, subject: dict | None, other: dict | None, scene: dict, focal: float | None = None,
            height: float | None = None) -> dict:
    """One camera {position, target, focal_mm} for a named setup on a subject, in stage coordinates."""
    set_name = scene["environment"]["set"]
    cast = people(scene) or scene.get("actors", [])
    if subject is None:
        subject = cast[0] if cast else {"position": [*C.SETS[set_name]["stage"][:1], 0, C.SETS[set_name]["stage"][1]],
                                        "kind": "man"}
    sp = tuple(subject["position"])
    top = _top(subject)
    toward = G.flat(G.sub(tuple(other["position"]), sp)) if other else _facing(subject)
    # The camera side: the preferred (-Z) side of the subject/other line, so new shots respect the 180 line.
    side = G.cross(G.UP, toward)
    if G.dot(side, PREFERRED_SIDE) < 0:
        side = G.mul(side, -1.0)
    if setup in ("ots_a", "ots_b", "ots") and other:
        op = tuple(other["position"])
        f = focal or 50.0
        target = (sp[0], _eye(subject) - 0.05, sp[2])
        back = G.flat(G.sub(op, sp))                      # from subject through the shoulder
        pos = G.add(op, G.add(G.mul(back, 0.9), G.mul(side, 0.45)))
        pos = (pos[0], _eye(other) + 0.05, pos[2])
    elif setup in ("single_a", "single_b", "single", "close"):
        f = focal or 65.0
        size = "MCU" if f < 80 else "CU"
        target = (sp[0], G.frame_center_y(size, top), sp[2])
        dist = G.distance_for_height(G.frame_height(size, top), f)
        d = G.norm(G.add(toward, G.mul(side, 0.9)))
        pos = G.add(target, G.mul(d, dist))
        pos = (pos[0], _eye(subject), pos[2])
    elif setup == "insert":
        f = focal or 85.0
        target = (sp[0], top * 0.55, sp[2])
        d = G.norm(G.add(toward, G.mul(side, 0.7)))
        pos = G.add(target, G.mul(d, G.distance_for_height(0.32, f)))
        pos = (pos[0], top * 0.7, pos[2])
    elif setup == "pov" and other:
        f = focal or 32.0
        op = tuple(other["position"])
        pos = (op[0], _eye(other), op[2])
        target = (sp[0], _eye(subject) - 0.1, sp[2])
    elif setup == "two_shot" and other:
        f = focal or 40.0
        pts = [sp, tuple(other["position"])]
        pos, target = _frame_points(pts, side, f, top, "COWBOY", height if height is not None else 1.5, margin=1.2)
    else:  # wide / master: everyone on stage, from the coverage side, at eye height unless told otherwise
        f = focal or 28.0
        pts = [tuple(a["position"]) for a in (cast or [subject])]
        still = [a for a in cast if len(a.get("keys") or []) <= 1] or cast
        if len(still) >= 2:  # square on to the line through the two who stay put, on the -Z side
            view = G.cross(G.UP, G.flat(G.sub(tuple(still[1]["position"]), tuple(still[0]["position"]))))
            view = view if G.dot(view, PREFERRED_SIDE) >= 0 else G.mul(view, -1.0)
        elif len(pts) > 1:
            view = PREFERRED_SIDE
        else:
            view = G.norm(G.add(_facing(subject), G.mul(side, 0.6)))
        pos, target = _frame_points(pts, view, f, top, "WS", height if height is not None else 1.5, margin=2.5)
    cam = {"position": G.r3(pos), "target": G.r3(target), "focal_mm": round(f, 1)}
    cam, _ = S.clamp_camera(cam, set_name)
    return cam
