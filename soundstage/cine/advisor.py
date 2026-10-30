"""Director's Advisor: scene + picks -> shot list with 3D cameras, prompts and the WHY.

Pipeline (research/08 §7.2, rules-first):
  plan()     retrieve KB entries for the picks and the scene text, pick the recipe that fits the
             cast, resolve the style layer (genre + movement + technique) and lay out the cast.
  realize()  turn shot templates (from the recipe, or from an LLM draft) into concrete shots:
             lens -> distance, height -> pitch, the move -> an end camera, blocking measured by
             projecting the cast through the camera, 8k+1 frame counts, rationale with KB refs,
             and per-model prompts. Everything here is deterministic.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from . import grammar
from .coverage import check_coverage
from .geometry import (HORIZONTAL_DEG, STAGE_ASPECT, use_aspect, UP, add, camera_height, cross, distance_for_height,
                       distance_for_width, dot, flat, focal_for, frame_center_y, frame_height, legal_frames,
                       length, look, move_end, mul, norm, place, project, r3, rot_y, side_of_line, sub, vfov_deg)
from .kb import KnowledgeBase, get_kb, label
from .prompts import compile_shot
from .scene import detect_intents, guess_cast, parse_characters_field, parse_location

AUTO, NONE = "auto", "none"
DEFAULT_SECONDS = {"EWS": 5, "WS": 4, "FS": 3.5, "COWBOY": 3, "MS": 3.5, "MCU": 3, "CU": 2.5, "ECU": 1.5, "INSERT": 1.5}
PICK_WEIGHT = {"technique": 3.0, "genre": 2.4, "coverage": 2.2, "intent": 2.0, "movement": 1.5}
STOP = set("a an the and or of to in on at with his her their its is are as for from by he she they them it this "
           "that into while over under one two three".split())


# --------------------------------------------------------------------------------------------
# planning


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOP and len(w) > 2}


def resolve_picks(kb: KnowledgeBase, scene_text: str, picks: dict, intents: list[str]) -> dict:
    """picks: {picker: 'auto' | 'none' | label/id}. Returns {picker: entry | None} plus provenance."""
    out, how = {}, {}
    for picker in ("technique", "genre", "movement", "coverage", "intent"):
        value = (picks.get(picker) or AUTO).strip()
        if value.lower() == NONE:
            out[picker], how[picker] = None, "none"
            continue
        if value.lower() != AUTO:
            entry = kb.get(value)
            out[picker], how[picker] = entry, "picked" if entry else f"unknown '{value}'"
            continue
        if picker == "intent":
            # among the emotions the scene names, the one whose own keywords fit the scene best
            cands = [kb.by_id[f"emotion.{i}"] for i in intents if f"emotion.{i}" in kb.by_id]
            entry = max(cands, key=lambda e: (kb.score(e, scene_text), -cands.index(e)), default=None)
        else:
            # a technique or movement reshapes the whole scene, so auto-picking one needs two keyword hits
            entry = kb.best(picker, scene_text, intents, min_score=2.0 if picker in ("technique", "movement") else 1.0)
            if picker == "genre" and not entry and out.get("technique"):
                parent = kb.by_id.get(out["technique"].get("parent") or "")
                if parent and parent["type"] in ("genre", "subgenre"):
                    entry = parent
        out[picker], how[picker] = entry, "auto" if entry else "auto: no match"
    return {"entries": out, "how": how}


def build_cast(scene_text: str, characters: str, stage_scene: dict | None, loc: dict, intents: list[str],
               standoff: bool) -> list[dict]:
    people = parse_characters_field(characters) or guess_cast(scene_text)
    actors = (stage_scene or {}).get("actors") or []
    ids = ["A", "B", "C", "D"]
    cast = []
    # the scene text decides how many principals there are when it says so ("a detective alone"); the stage
    # decides where they stand. An unspecific scene ("the protagonist" fallback) uses every stage actor.
    explicit = bool(characters.strip()) or people[0]["description"] != "the protagonist"
    if actors and explicit:
        actors = actors[:max(1, len(people))]
    if actors:
        for i, a in enumerate(actors[:4]):
            desc = people[i]["description"] if i < len(people) else a.get("name") or a.get("kind", "a figure")
            cast.append({"id": ids[i], "description": desc, "stage_id": a.get("id"),
                         "position": [float(v) for v in ((a.get("keys") or [{}])[0].get("position") or a.get("position") or [0, 0, 0])],
                         "height_m": float(a.get("height_m", 1.75))})
    else:
        n = min(len(people), 3)
        spacing = 1.15 if loc["seated"] else 14.0 if standoff else 1.0 if {"intimacy", "romance"} & set(intents) else 2.2
        layout = {1: [(0.0, 0.0)], 2: [(-spacing / 2, 0.0), (spacing / 2, 0.0)],
                  3: [(-spacing / 2, 0.0), (spacing / 2, 0.0), (0.0, spacing * 0.75)]}[n]
        for i in range(n):
            d = people[i]["description"]
            h = 1.68 if re.search(r"\b(woman|girl|she|her)\b", d) else 1.80 if re.search(r"\b(man|cowboy|gunfighter)\b", d) else 1.75
            cast.append({"id": ids[i], "description": d, "position": [layout[i][0], 0.0, layout[i][1]], "height_m": h})
    moving = "energy" in intents
    if moving and not actors and len(cast) > 1:
        # a chase / getaway: the cast travels in file along +X (screen-left from the side-A cameras)
        for i, c in enumerate(cast):
            c["position"] = [1.6 * (len(cast) - 1 - i) - 0.8 * (len(cast) - 1), 0.0, 0.0]
    # facing: A and B face each other, everyone else faces the group's centre; movers face the way they travel
    centre = mul(tuple(map(sum, zip(*[c["position"] for c in cast]))), 1 / len(cast))
    travel = flat(sub(cast[0]["position"], cast[-1]["position"])) if len(cast) > 1 else (1.0, 0.0, 0.0)
    for i, c in enumerate(cast):
        if moving:
            f = travel if length(travel) > 0 else (1.0, 0.0, 0.0)
        elif len(cast) == 1:
            f = (1.0, 0.0, 0.0)
        elif i < 2:
            f = flat(sub(cast[1 - i]["position"], c["position"]))
        else:
            f = flat(sub(centre, c["position"]))
        c["facing"] = r3(f)
        c["posture"] = "seated" if loc["seated"] else "standing"
        c["top_m"] = round(c["height_m"] * (0.72 if loc["seated"] else 1.0), 3)
        c["eye_m"] = round(c["top_m"] - 0.11, 3)
    return cast


def _comic(entry: dict) -> bool:
    return entry["intent_tags"][:1] == ["comedy"]


def choose_recipe(kb: KnowledgeBase, resolved: dict, scene_text: str, intents: list[str], n_cast: int):
    """Best recipe among the picked entries; if none fits the cast, search the whole KB. A comedy recipe is
    only eligible when the scene (or a pick) actually signals comedy: shared words like 'a man' are not a cue."""
    words = _words(scene_text)
    comedy_ok = "comedy" in intents or any(e and _comic(e) for e in resolved["entries"].values())
    best = None
    for picker, entry in resolved["entries"].items():
        if not entry or (_comic(entry) and not comedy_ok):
            continue
        w = PICK_WEIGHT[picker] + (2.0 if resolved["how"][picker] == "picked" else 0.0)
        for recipe in entry["recipes"]:
            cast = recipe.get("cast", n_cast)
            if cast > n_cast:
                continue
            s = (w + (1.2 if cast == n_cast else 0.0) + 0.8 * len(words & _words(recipe.get("beat", "")))
                 + 0.3 * kb.score(entry, scene_text, intents))
            if best is None or s > best[0]:
                best = (s, entry, recipe)
    if best is None:  # nothing picked fits the cast: search the whole KB
        for entry in kb.entries:
            if _comic(entry) and not comedy_ok:
                continue
            for recipe in entry["recipes"]:
                if recipe.get("cast", n_cast) != n_cast:
                    continue
                s = (kb.score(entry, scene_text, intents) + 0.35 * len(words & _words(recipe.get("beat", "")))
                     + (3.0 if intents and intents[0] in entry["intent_tags"][:1] else 0.0))
                if best is None or s > best[0]:
                    best = (s, entry, recipe)
    if best is None:
        raise ValueError("the knowledge base has no recipe for this cast size")
    return best[1], best[2]


def _similar(a: str, b: str) -> bool:
    wa, wb = _words(a), _words(b)
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) > 0.3


def style_layer(resolved: dict, source: dict) -> dict:
    order = [resolved["entries"].get(k) for k in ("technique", "genre", "movement")]
    entries = [e for e in order if e]
    if source not in entries:
        entries.insert(0, source)
    ltx, still = [], []
    for e in entries:
        frag = e["prompt_fragments"]
        # two picks from one family (a technique and its genre) say the same thing twice; keep one
        if any(_similar(frag["ltx"], x) for x in ltx):
            continue
        ltx.append(frag["ltx"])
        still.append(frag["still"])
    # the genre/movement owns the frame shape; a technique or emotion recipe only borrows it
    by_rank = sorted(entries, key=lambda e: {"genre": 0, "subgenre": 0, "movement": 1, "national_cinema": 1}.get(e["type"], 2))
    aspect = next((e["signature"]["aspect_ratio"][0] for e in by_rank if e["signature"].get("aspect_ratio")), "1.85:1")
    sound = next((e["signature"]["sound"] for e in entries if e["signature"].get("sound")), [])
    light = []
    for e in entries:
        lw = e["signature"].get("lighting", {})
        light += [k.replace("_", " ") for k, _ in sorted(lw.items(), key=lambda kv: -kv[1])[:2]]
        if light:
            break
    color = next((e["signature"]["color"][:2] for e in entries if e["signature"].get("color")), [])
    return {
        "ids": [e["id"] for e in entries],
        "ltx": " ".join(ltx[:2]),
        "still": ", ".join(still[:2]),
        "h3": next((e["prompt_fragments"]["h3"] for e in entries if e["prompt_fragments"].get("h3")), "Live-action, cinematic"),
        "aspect_ratio": aspect.split(" ")[0] if aspect and aspect != "any" else "1.85:1",
        "sound": [s for s in sound if "score" not in s.lower()][:2],
        "lighting": ", ".join(light),
        "color": ", ".join(color),
    }


def plan(scene_text: str, beat: str = "", picks: dict | None = None, characters: str = "",
         stage_scene: dict | None = None, kb: KnowledgeBase | None = None) -> dict:
    kb = kb or get_kb()
    picks = dict(picks or {})
    text = f"{scene_text}. {beat}".strip(". ")
    intents = detect_intents(text)
    resolved = resolve_picks(kb, text, picks, intents)
    if resolved["entries"]["intent"]:
        primary = resolved["entries"]["intent"]["intent_tags"][0]
        intents = [primary] + [i for i in intents if i != primary]
    loc = parse_location(text)
    tech = resolved["entries"]["technique"]
    standoff = bool(tech and tech["id"] in ("technique.spaghetti_standoff", "technique.three_way_standoff"))
    cast = build_cast(scene_text, characters, stage_scene, loc, intents, standoff)
    source, recipe = choose_recipe(kb, resolved, text, intents, len(cast))
    style = style_layer(resolved, source)
    return {"kb": kb, "text": text, "scene_text": scene_text, "beat": beat, "intents": intents, "resolved": resolved,
            "location": loc, "cast": cast, "source": source, "recipe": recipe, "style": style}


# --------------------------------------------------------------------------------------------
# realizing shots


def _cast_by(cast: list[dict], cid: str) -> dict:
    for c in cast:
        if c["id"] == cid:
            return c
    return cast[0]


def _remap_subject(subject: str, n: int) -> str:
    if n == 1 and subject in ("B", "C", "both", "all", "B_hands"):
        return {"B_hands": "A_hands"}.get(subject, "A")
    if n == 2 and subject == "C":
        return "B"
    if n == 2 and subject == "all":
        return "both"
    return subject


def _side_normal(cast: list[dict]):
    if len(cast) >= 2:
        axis = flat(sub(cast[1]["position"], cast[0]["position"]))
    else:
        axis = tuple(cast[0]["facing"])
    return cross(UP, axis), axis


def _toward_side(facing, n, deg):
    """Rotate a facing vector by `deg` toward the side-A normal (stays on side A of the line)."""
    m = flat(sub(n, mul(facing, dot(n, facing))))
    if length(m) < 1e-6:
        m = flat(n)
    r = math.radians(deg)
    return flat(add(mul(facing, math.cos(r)), mul(m, math.sin(r))))


def _screen_words(sx: float) -> str:
    if sx < -0.72:
        return "at the left edge of frame"
    if sx < -0.22:
        return "on the left third of frame"
    if sx <= 0.22:
        return "in the centre of frame"
    if sx <= 0.72:
        return "on the right third of frame"
    return "at the right edge of frame"


def measure_blocking(shot: dict, cast: list[dict], cam: dict) -> list[dict]:
    pos, tgt, fmm = cam["position"], cam["target"], cam["focal_mm"]
    fwd = norm(sub(tgt, pos))
    right = norm(cross(fwd, UP))
    subject = shot["subject"]
    out = []
    for c in cast:
        tight = shot["size"] in ("MCU", "CU", "ECU") and c["id"] == subject
        head = (c["position"][0], c["eye_m"] if tight else c["top_m"] * 0.6, c["position"][2])
        p = project(head, pos, tgt, fmm)
        visible = p is not None and abs(p[0]) <= 1.05 and -1.6 <= p[1] <= 1.15
        if subject in ("A_hands", "B_hands", "prop") or (subject in ("A", "B", "C") and shot["framing"] in ("single", "reaction")
                                                         and c["id"] != subject and shot["size"] in ("CU", "ECU", "MCU")):
            visible = visible and False
        if subject in ("A", "B", "C") and c["id"] == subject:
            visible = True
        dist = length(sub(head, pos))
        where = _screen_words(p[0]) if p else "behind the camera"
        if visible and dist > 4 * max(1.0, length(sub(tgt, pos))) and subject not in ("env",):
            where = "small in the background, " + where
        f = tuple(c["facing"])
        if dot(f, mul(fwd, -1)) > 0.7:
            facing = "facing the camera"
        elif dot(f, fwd) > 0.7:
            facing = ("seen from behind the shoulder in the foreground, looking toward the background"
                      if shot["framing"] == "dirty_single" and c["id"] == subject else "with their back to the camera")
        else:
            facing = "facing screen-right" if dot(f, right) > 0 else "facing screen-left"
        out.append({"id": c["id"], "description": c["description"], "visible": bool(visible),
                    "frame_position": where, "facing": facing,
                    "screen_xy": [round(p[0], 2), round(p[1], 2)] if p else None})
    return out


def _compose_dirty(S_face, O_point, n, top_size_h, focal):
    """Face in the foreground on one third, the opponent small and sharp on the other: a small search
    over how far behind the shoulder the camera sits and where it aims."""
    best = None
    away = flat(sub(S_face, O_point))
    d = distance_for_height(top_size_h, focal)
    for rot in range(10, 64, 3):
        pos = place(S_face, _toward_side(away, n, rot), d, S_face[1])
        base = sub(S_face, pos)
        for delta in range(-34, 35, 2):
            tgt = add(pos, rot_y(base, delta))
            ps, po = project(S_face, pos, tgt, focal), project(O_point, pos, tgt, focal)
            if not ps or not po:
                continue
            # mirror-free: which third the face lands on is decided by the side of the line we shoot from
            err = (abs(ps[0]) - 0.42) ** 2 + 1.5 * (po[0] + math.copysign(0.38, ps[0])) ** 2 + 0.2 * ps[1] ** 2 + 0.002 * rot
            if best is None or err < best[0]:
                best = (err, pos, tgt)
    return best[1], best[2]


def place_camera(t: dict, cast: list[dict], interior: bool = False, moving: bool = False) -> tuple[dict, list[str]]:
    """Concrete start camera for a shot template. Returns (camera dict, notes)."""
    notes = []
    n_side, axis = _side_normal(cast)
    size, subject, framing = t["size"], t["subject"], t.get("framing", "single")
    focal = float(t.get("lens_mm_ff", 50))
    hor = t.get("horizontal", "three_quarter_front")
    vert = t.get("angle", "eye")
    hcls = t.get("height", "eye")
    centre = mul(tuple(map(sum, zip(*[c["position"] for c in cast]))), 1 / len(cast))
    top_max = max(c["top_m"] for c in cast)
    width = 0.0

    if subject in ("A", "B", "C"):
        S = _cast_by(cast, subject)
        f_s = tuple(S["facing"])
        H = frame_height(size, S["top_m"])
        target = (S["position"][0], frame_center_y(size, S["top_m"]), S["position"][2])
        eye = S["eye_m"]
        direction = _toward_side(f_s, n_side, HORIZONTAL_DEG.get(hor, 38))
    elif subject in ("A_hands", "B_hands"):
        S = _cast_by(cast, subject[0])
        f_s = tuple(S["facing"])
        hand_y = 0.78 if S["posture"] == "seated" else S["height_m"] * 0.53
        target = add((S["position"][0], hand_y, S["position"][2]), mul(f_s, 0.18))
        H, eye = frame_height("INSERT", S["top_m"]), S["eye_m"]
        direction = _toward_side(f_s, n_side, HORIZONTAL_DEG.get(hor, 38))
    elif subject == "prop":
        target = (centre[0], 0.8, centre[2])
        H, eye, f_s = 0.4, cast[0]["eye_m"], axis
        direction = _toward_side(axis, n_side, 90)
    else:  # both / all / env
        group = cast[:2] if subject == "both" else cast
        xs = [c["position"] for c in group]
        span = max((length(sub(a, b)) for a in xs for b in xs), default=0.0)
        mid = mul(tuple(map(sum, zip(*xs))), 1 / len(xs))
        H = frame_height(size if size != "INSERT" else "MS", top_max)
        width = span * (1.25 if subject != "env" else 1.6) + (1.0 if subject != "env" else 4.0)
        target = (mid[0], frame_center_y(size, top_max) if size not in ("WS", "EWS") else min(1.2, top_max * 0.6), mid[2])
        eye, f_s = max(c["eye_m"] for c in group), axis
        if moving:
            # a group on the move is framed from its direction of travel: profile = alongside,
            # three-quarter back = chasing them, back = watching them go
            f_s = tuple(cast[0]["facing"])
            direction = _toward_side(f_s, n_side, HORIZONTAL_DEG.get(hor, 90))
        elif subject == "both":
            direction = _toward_side(axis, n_side, HORIZONTAL_DEG.get(hor, 90))
        elif len(cast) == 1:
            direction = _toward_side(axis, n_side, HORIZONTAL_DEG.get(hor, 38))
        else:
            # a group is faced from side A: 'front' looks straight across the line, wider angles swing toward A
            off = {"front": 0, "profile": 0, "three_quarter_front": 35}.get(hor, 50)
            r = math.radians(off)
            direction = flat(add(mul(flat(n_side), math.cos(r)), mul(mul(axis, -1.0), math.sin(r))))

    if interior and size in ("EWS", "WS") and subject in ("env", "all", "both", "A", "B", "C"):
        H = min(H, 5.0 if size == "EWS" else 3.4)   # a room, not a landscape
        width = min(width, 9.0) if width else width
    dist = distance_for_height(H, focal)
    if width:
        dist = max(dist, distance_for_width(width, focal))

    if framing == "ots" and subject in ("A", "B", "C") and len(cast) > 1:
        S = _cast_by(cast, subject)
        O = _cast_by(cast, "B" if subject == "A" else "A")
        f_o = tuple(O["facing"])
        m = _toward_side(f_o, n_side, 90)
        shoulder = add((O["position"][0], O["top_m"] - 0.25, O["position"][2]), add(mul(f_o, -0.35), mul(m, 0.32)))
        face = (S["position"][0], target[1], S["position"][2])
        direction = flat(sub(shoulder, face))
        d_min = length(sub((shoulder[0], face[1], shoulder[2]), face)) + 0.45
        if dist < d_min:
            new_f = max(18.0, min(200.0, focal_for(H, d_min)))
            notes.append(f"lens moved from {focal:.0f}mm to {new_f:.0f}mm so the camera can sit behind the shoulder")
            focal, dist = new_f, d_min
        cam_y = min(camera_height(hcls, eye, target[1], size, dist), O["top_m"] - 0.05)
        pos = place(target, direction, dist, cam_y)
    elif framing == "dirty_single" and subject in ("A", "B", "C") and len(cast) > 1:
        S = _cast_by(cast, subject)
        face = (S["position"][0], S["eye_m"], S["position"][2])
        line = (tuple(cast[0]["position"]), tuple(cast[1]["position"]))
        solved = None
        for O in sorted((c for c in cast if c["id"] != subject), key=lambda c: c["id"] != ("B" if subject == "A" else "A")):
            opp = (O["position"][0], O["top_m"] * 0.6, O["position"][2])
            cand = _compose_dirty(face, opp, n_side, H, focal)
            if side_of_line(cand[0], *line) > -0.3:   # never solve the frame from across the line
                solved = cand
                break
        if solved:
            pos, target = solved
        else:  # e.g. the third player upstage, facing the cameras: a clean front single instead
            notes.append("no dirty single from this side of the line; framed as a clean single")
            cam_y = camera_height(hcls, eye, target[1], size, dist)
            pos = place(target, direction, dist, cam_y)
        dist = length(sub(target, pos))
    elif framing == "pov" and subject in ("A", "B", "C"):
        S = _cast_by(cast, subject)
        O = next((c for c in cast if c["id"] != subject), None)
        eye_pt = add((S["position"][0], S["eye_m"], S["position"][2]), mul(tuple(S["facing"]), 0.15))
        pos = eye_pt
        target = (O["position"][0], O["top_m"] * 0.7, O["position"][2]) if O else add(eye_pt, mul(tuple(S["facing"]), 5.0))
        dist = length(sub(target, pos))
    else:
        cam_y = camera_height(hcls, eye, target[1], size, dist)
        if interior:
            cam_y = min(cam_y, 3.0)               # under the ceiling
        if vert == "low" and cam_y > target[1] - 0.12:
            cam_y = max(0.2, target[1] - 0.35)
        elif vert == "worms_eye":
            cam_y = 0.15
        elif vert == "high" and cam_y < target[1] + 0.45:
            cam_y = target[1] + max(0.6, dist * 0.25)
        elif vert == "eye" and hcls == "eye":
            cam_y = eye if subject in ("A", "B", "C") else cam_y
        if vert == "overhead":
            pos = add(target, add(mul(direction, dist * 0.2), (0.0, dist * 0.98, 0.0)))
        else:
            pos = place(target, direction, dist, cam_y)

    return {"position": pos, "target": target, "focal_mm": round(focal, 1), "distance_m": dist, "facing": f_s}, notes


def shot_rationale(i: int, n: int, t: dict, shot: dict, plan_: dict, extra_why: str = "") -> dict:
    src, recipe = plan_["source"], plan_["recipe"]
    parts = []
    purpose = t.get("purpose", "").strip()
    if extra_why:
        parts.append(extra_why.strip())
    else:
        parts.append(grammar.FRAMING.get(shot["framing"], grammar.SIZE[shot["size"]]))
        mv = shot["movement"]["id"]
        if mv != "static":
            parts.append(grammar.MOVE[mv])
        elif shot["angle"]["vertical"] in grammar.ANGLE:
            parts.append(grammar.ANGLE[shot["angle"]["vertical"]])
        elif shot["angle"]["height"] in grammar.HEIGHT:
            parts.append(grammar.HEIGHT[shot["angle"]["height"]])
        else:
            parts.append(grammar.lens_band(shot["lens"]["focal_mm_ff"]))
    # recipe-level why on the opener, KB rules where they apply
    if i == 0:
        parts.append(recipe["why"])
    refs = [src["id"]]
    pw = _words(purpose + " " + t.get("note", ""))
    for rule in src.get("rules", []):
        when = rule["when"].lower()
        hit = (i == 0 and any(k in when for k in ("begin", "establish", "start", "open", "enter"))) or \
              (i == n - 1 and any(k in when for k in ("draw", "payoff", "end", "release", "climax", "punch"))) or \
              len(pw & _words(rule["then"])) >= 3
        if hit:
            parts.append(f"Rule: {rule['then']}, because {rule['why']}.")
            break
    emo = plan_["resolved"]["entries"].get("intent")
    if emo and emo["id"] != src["id"]:
        refs.append(emo["id"])
        sig = emo["signature"].get("shot_size", {})
        top = max(sig, key=sig.get) if sig else None
        if i == n // 2 or shot["size"] == top:
            parts.append(f"For {emo['name'].lower()}: {_first_sentences(emo['summary'], 2)}")
    for k in ("genre", "movement", "technique", "coverage"):
        e = plan_["resolved"]["entries"].get(k)
        if e and e["id"] not in refs:
            refs.append(e["id"])
    alts = []
    avoid = src.get("avoid", [])
    if avoid:
        a = avoid[i % len(avoid)]
        alts.append(f"Avoid {a['what']}: {a['why']}.")
    if shot["size"] in ("WS", "EWS", "FS"):
        alts.append("Hold it longer than feels comfortable if the scene needs more weight; wides earn their duration.")
    elif shot["movement"]["id"] == "static" and shot["size"] in ("MCU", "CU"):
        alts.append("For more pressure, make it a slow push-in that lands one size tighter.")
    elif shot["movement"]["id"] != "static":
        alts.append("If the move fights the performance, lock it off and let the actor move instead.")
    return {"why": " ".join(p.rstrip(".") + "." for p in parts if p), "kb_refs": refs, "alternatives": alts}


def realize(plan_: dict, templates: list[dict], fps: float = 24.0, whys: list[str] | None = None,
            style_overrides: bool = True) -> list[dict]:
    cast, style = plan_["cast"], plan_["style"]
    resolved = plan_["resolved"]["entries"]
    lens_ranges = [e["signature"]["lens_mm_ff"] for k, e in resolved.items()
                   if e and k in ("genre", "movement") and e["id"] != plan_["source"]["id"] and e["signature"].get("lens_mm_ff")]
    lo = max((r[0] for r in lens_ranges), default=None)
    hi = min((r[1] for r in lens_ranges), default=None)
    handheld_style = next((e for k, e in resolved.items() if e and k in ("movement", "genre")
                           and e["id"] != plan_["source"]["id"]
                           and e["signature"].get("movement", {}).get("handheld", 0) >= 0.3), None)
    shots, t_cursor = [], 0.0
    context = {"cast": cast, "location": plan_["location"], "style": style, "aspect_ratio": style["aspect_ratio"]}
    for i, raw in enumerate(templates):
        t = dict(raw)
        t["subject"] = _remap_subject(t.get("subject", "A"), len(cast))
        t.setdefault("framing", "single")
        notes = []
        if style_overrides and lo is not None and hi is not None and lo <= hi and t.get("lens_mm_ff"):
            mm = t["lens_mm_ff"]
            clamped = min(hi, max(lo, mm))
            if clamped != mm and t["size"] not in ("EWS", "INSERT"):
                notes.append(f"lens pulled from {mm:.0f}mm to {clamped:.0f}mm to stay inside the {lo:.0f}-{hi:.0f}mm band of the style picks")
                t["lens_mm_ff"] = clamped
        if style_overrides and handheld_style and t.get("movement", "static") == "static" and t["size"] not in ("EWS", "INSERT"):
            t["movement"] = "handheld"
            notes.append(f"locked-off frame turned handheld for {handheld_style['name']}")
        cam, geo_notes = place_camera(t, cast, interior=plan_["location"]["int_ext"] == "INT",
                                      moving="energy" in plan_["intents"])
        notes += geo_notes
        mv, speed = t.get("movement", "static"), t.get("speed", "slow" if t.get("movement", "static") != "static" else "regular")
        if "energy" in plan_["intents"] and mv.split("_")[0] in ("truck", "pan"):
            # move with the action: lateral moves follow the subject's direction of travel on screen
            right = norm(cross(norm(sub(cam["target"], cam["position"])), UP))
            way = "right" if dot(tuple(cam["facing"]), right) > 0 else "left"
            mv = f"{mv.split('_')[0]}_{way}"
        end_p, end_t, end_f = move_end(mv, speed, cam["position"], cam["target"], cam["focal_mm"], cam["facing"])
        yaw, pitch = look(cam["position"], cam["target"])
        seconds = float(t.get("duration_s") or DEFAULT_SECONDS[t["size"]])
        frames = legal_frames(seconds, fps)
        side = side_of_line(cam["position"], cast[0]["position"], cast[1]["position"] if len(cast) > 1
                            else add(tuple(cast[0]["position"]), tuple(cast[0]["facing"])))
        shot = {
            "shot_id": f"{i + 1}",
            "purpose": t.get("purpose", ""),
            "subject": t["subject"],
            "size": t["size"],
            "framing": t["framing"],
            "angle": {"vertical": t.get("angle", "eye"), "horizontal": "ots" if t["framing"] == "ots" else t.get("horizontal", "three_quarter_front"),
                      "height": t.get("height", "eye"), "height_m": round(cam["position"][1], 2),
                      "dutch_deg": 12 if t.get("angle") == "dutch" else 0},
            "lens": {"focal_mm_ff": cam["focal_mm"], "look": t.get("lens_look", "spherical"),
                     "dof": t.get("dof", "shallow" if cam["focal_mm"] >= 75 else "medium"),
                     "vfov_deg": round(vfov_deg(cam["focal_mm"]), 2)},
            "movement": {"id": mv, "speed": speed, "rig": _rig(mv)},
            "lighting": t.get("lighting") or _join(style["lighting"], style["color"]),
            "composition": t.get("composition", ""),
            "duration": {"seconds": round(seconds, 2), "fps": fps, "frames": frames, "start_s": round(t_cursor, 3)},
            "camera3d": {"position": r3(cam["position"]), "target": r3(cam["target"]), "focal_mm": cam["focal_mm"],
                         "end": {"position": r3(end_p), "target": r3(end_t), "focal_mm": round(end_f, 1)},
                         "vfov_deg": round(vfov_deg(cam["focal_mm"]), 2), "yaw_deg": round(yaw, 1),
                         "pitch_deg": round(pitch, 1), "distance_m": round(length(sub(cam["target"], cam["position"])), 2)},
            "notes": notes,
        }
        shot["blocking"] = {"subjects": measure_blocking(shot, cast, shot["camera3d"]),
                            "side_of_line": "on_axis" if abs(side) < 0.3 else "A" if side > 0 else "B"}
        shot["rationale"] = shot_rationale(i, len(templates), t, shot, plan_, (whys or [None] * len(templates))[i] or "")
        if notes:
            shot["rationale"]["why"] += " Adjusted: " + "; ".join(notes) + "."
        shot["prompts"] = compile_shot(shot, context, i + 1, t_cursor)
        t_cursor += seconds
        shots.append(shot)
    return shots


def _first_sentences(text: str, n: int) -> str:
    return " ".join(re.split(r"(?<=[.!?])\s+", text.strip())[:n])


def _rig(mv: str) -> str:
    return {"static": "sticks", "handheld": "handheld", "steadicam_follow": "Steadicam", "track_follow": "Steadicam",
            "track_lead": "dolly", "crane_up": "jib", "crane_down": "jib", "zoom_in": "sticks + zoom",
            "snap_zoom": "sticks + zoom", "whip_pan": "fluid head", "pan_left": "fluid head", "pan_right": "fluid head",
            "tilt_up": "fluid head", "tilt_down": "fluid head", "rack_focus": "sticks"}.get(mv, "dolly")


def _join(*parts):
    return ", ".join(p for p in parts if p)


def trim_templates(shots: list[dict], max_shots: int) -> list[dict]:
    if not max_shots or max_shots >= len(shots):
        return list(shots)
    if max_shots == 1:
        return [shots[0]]
    keep = [round(i * (len(shots) - 1) / (max_shots - 1)) for i in range(max_shots)]
    return [shots[k] for k in sorted(set(keep))]


def assemble(plan_: dict, shots: list[dict], backend: str, notes: list[str]) -> dict:
    cast = plan_["cast"]
    shot_list = {
        "scene_id": "scn_" + hashlib.sha1(plan_["text"].encode()).hexdigest()[:8],
        "scene_text": plan_["scene_text"],
        "beat": plan_["beat"],
        "backend": backend,
        "picks": {k: (label(e) if e else None) for k, e in plan_["resolved"]["entries"].items()},
        "pick_mode": plan_["resolved"]["how"],
        "recipe": {"name": plan_["recipe"]["name"], "from": plan_["source"]["id"], "why": plan_["recipe"]["why"]},
        "intents": plan_["intents"],
        "location": plan_["location"],
        "style": plan_["style"],
        "cast": [{k: c[k] for k in ("id", "description", "position", "height_m", "facing", "posture")} for c in cast],
        "axis_of_action": {"from": cast[0]["id"], "to": cast[1]["id"] if len(cast) > 1 else f"{cast[0]['id']}_eyeline",
                           "side": "A"},
        "shots": shots,
        "notes": notes,
    }
    shot_list["coverage_check"] = check_coverage(shot_list)
    return shot_list


def advise(scene_text: str, beat: str = "", picks: dict | None = None, characters: str = "",
           max_shots: int = 0, fps: float = 24.0, stage_scene: dict | None = None,
           kb: KnowledgeBase | None = None, style_overrides: bool = True) -> dict:
    """Rules-only advisor. Always works offline; deterministic for the same inputs."""
    p = plan(scene_text, beat, picks, characters, stage_scene, kb)
    templates = trim_templates(p["recipe"]["shots"], max_shots)
    with use_aspect(((stage_scene or {}).get("shot") or {}).get("aspect")):
        shots = realize(p, templates, fps, style_overrides=style_overrides)
    notes = [f"Recipe '{p['recipe']['name']}' from {p['source']['name']} ({p['source']['id']})."]
    for k, how in p["resolved"]["how"].items():
        if how.startswith("unknown"):
            notes.append(f"{k}: {how}, ignored")
    return assemble(p, shots, "rules", notes)


def stage_cameras(shot: dict) -> dict:
    """The stage scene's camera blocks for one shot ({camera, camera_end} as in DEFAULT_SCENE)."""
    c = shot["camera3d"]
    return {"camera": {"position": c["position"], "target": c["target"], "focal_mm": c["focal_mm"]},
            "camera_end": dict(c["end"])}


def summary_text(shot_list: dict) -> str:
    lines = [f"{shot_list['recipe']['name']}  ·  from {shot_list['recipe']['from']}  ·  backend: {shot_list['backend']}",
             "Picks: " + ", ".join(f"{k}={v or '-'}" for k, v in shot_list["picks"].items()), ""]
    for s in shot_list["shots"]:
        lines.append(f"{s['shot_id']:>2}. {s['size']:<6} {s['framing']:<12} {s['lens']['focal_mm_ff']:>5.0f}mm "
                     f"{s['angle']['vertical']}/{s['angle']['height']:<7} {s['movement']['id']:<12} "
                     f"{s['duration']['seconds']:>4.1f}s ({s['duration']['frames']}f)  {s['purpose']}")
        lines.append(f"    WHY: {s['rationale']['why']}")
        lines.append(f"    refs: {', '.join(s['rationale']['kb_refs'])}")
    cc = shot_list.get("coverage_check", {})
    lines.append("")
    lines.append(f"Coverage: {cc.get('verdict', '?')}")
    for w in cc.get("warnings", []):
        lines.append(f"  ! {w}")
    return "\n".join(lines)


def to_json(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)
