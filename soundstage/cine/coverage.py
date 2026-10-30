"""Coverage Doctor: continuity checks over a shot list, measured from the 3D cameras.

- 180 degrees: every camera on one side of the axis of action (A->B, or a lone actor's eyeline).
  Overheads count as neutrals; with three players, C's singles are judged on C's own axis.
  A crossing is legal when the shot before is on the axis (a neutral), or when a camera move
  carries the frame across the line on screen.
- Screen direction: each character keeps facing the same screen side across shots.
- 30 degrees: consecutive shots of the same subject change angle by >= 30 degrees, or size by a
  step, or lens by >= 1.4x; otherwise the cut reads as a jump (allowed when the shot says so).
- Geography: in a scene with two or more people, a wide/master comes before the first close-up.
- LTX: frame counts are 8k+1; a moving shot under 49 frames may truncate its move.
"""
from __future__ import annotations

import math

from .geometry import SIZE_ORDER, add, flat, length, side_of_line, sub

ON_AXIS_M = 0.3
WIDE = {"EWS", "WS", "FS"}
TIGHT = {"CU", "ECU"}


def _cast(shot_list: dict) -> dict:
    return {c["id"]: c for c in shot_list.get("cast", [])}


def _axis(shot_list: dict):
    cast = shot_list.get("cast", [])
    if not cast:
        return None
    a = tuple(cast[0]["position"])
    b = tuple(cast[1]["position"]) if len(cast) > 1 else add(a, tuple(cast[0].get("facing", (1, 0, 0))))
    return a, b


def _side(p, axis) -> str:
    d = side_of_line(tuple(p), *axis)
    return "on_axis" if abs(d) < ON_AXIS_M else ("A" if d > 0 else "B")


def _subject_point(shot: dict, cast: dict):
    sub_id = shot.get("subject", "A")
    key = sub_id[0] if sub_id in ("A_hands", "B_hands") else sub_id
    if key in cast:
        return tuple(cast[key]["position"])
    return tuple(shot["camera3d"]["target"])


def _facing_of(shot: dict, cid: str) -> str | None:
    for b in shot.get("blocking", {}).get("subjects", []):
        if b.get("id") == cid and b.get("visible"):
            f = b.get("facing", "")
            if f in ("facing screen-right", "facing screen-left"):
                return f.split("-")[-1]
    return None


def check_coverage(shot_list: dict) -> dict:
    shots = shot_list.get("shots", [])
    cast = _cast(shot_list)
    axis = _axis(shot_list)
    crossings, thirty, direction, geography, ltx, per_shot = [], [], [], [], [], []
    if axis is None or not shots:
        return {"verdict": "fail", "warnings": ["no cast or no shots to check"], "line_crossings": [],
                "thirty_degree_warnings": [], "screen_direction": [], "geography": [], "ltx": [], "per_shot": []}

    sides = []
    for s in shots:
        c = s["camera3d"]
        start = _side(c["position"], axis)
        end = _side(c.get("end", c)["position"], axis)
        if s.get("angle", {}).get("vertical") == "overhead":
            start = end = "on_axis"          # straight down is the classic neutral reset
        elif len(cast) >= 3 and s.get("subject") in ("C", "C_hands"):
            start = end = "on_axis"          # a third player's single lives on its own axis, not the A-B line
        sides.append((start, end))
        per_shot.append({"shot_id": s["shot_id"], "side": start, "end_side": end})

    counted = [st for st, _ in sides if st != "on_axis"]
    home = max(set(counted), key=counted.count) if counted else "A"
    prev_end = None
    for i, (s, (start, end)) in enumerate(zip(shots, sides)):
        if start not in ("on_axis", home):
            legal = prev_end in ("on_axis", start) or (i > 0 and sides[i - 1][0] != sides[i - 1][1])
            if not legal:
                crossings.append(
                    f"Shot {s['shot_id']} ({s['size']} on {s['subject']}) sits on side {start} of the "
                    f"{shot_list.get('axis_of_action', {}).get('from', 'A')}-{shot_list.get('axis_of_action', {}).get('to', 'B')} "
                    f"line while the scene is covered from side {home}: eyelines and screen direction flip. Move the "
                    f"camera back across, or cross on purpose with an on-axis neutral, a visible camera move or an actor move.")
        if end != start and end != "on_axis":
            per_shot[i]["note"] = f"camera move crosses the line ({start} -> {end}); later shots may use side {end}"
            home = end if end != "on_axis" else home
        prev_end = end

    # screen direction per character
    for cid in cast:
        last = None
        for s, (start, _) in zip(shots, sides):
            f = _facing_of(s, cid)
            if f is None:
                continue
            if last and f != last[0] and start == last[1]:
                direction.append(f"{cid} faces screen-{last[0]} in shot {last[2]} but screen-{f} in shot {s['shot_id']} "
                                 f"from the same side of the line: the eyeline will not match.")
            last = (f, start, s["shot_id"])

    # 30-degree rule between consecutive shots of the same subject
    for prev, cur in zip(shots, shots[1:]):
        if prev.get("subject") != cur.get("subject"):
            continue
        pt = _subject_point(cur, cast)
        v1 = flat(sub(tuple(prev["camera3d"]["position"]), pt))
        v2 = flat(sub(tuple(cur["camera3d"]["position"]), pt))
        ang = math.degrees(math.acos(max(-1.0, min(1.0, sum(a * b for a, b in zip(v1, v2))))))
        size_step = abs(SIZE_ORDER.index(cur["size"]) - SIZE_ORDER.index(prev["size"]))
        f1, f2 = prev["lens"]["focal_mm_ff"], cur["lens"]["focal_mm_ff"]
        lens_ratio = max(f1, f2) / max(1.0, min(f1, f2))
        deliberate = "jump" in (cur.get("purpose", "") + " " + cur.get("note", "")).lower()
        if ang < 30 and size_step == 0 and lens_ratio < 1.4 and not deliberate:
            thirty.append(f"Shots {prev['shot_id']}->{cur['shot_id']} on {cur['subject']}: only {ang:.0f} degrees apart at the "
                          f"same size ({cur['size']}) - this cuts as a jump. Swing the camera 30+ degrees or change size a step.")

    # establish geography before the first close-up when 2+ people are in the scene
    if len(cast) >= 2:
        for s in shots:
            if s["size"] in WIDE or s.get("framing") in ("master", "establishing", "fifty_fifty", "two_shot"):
                break
            if s["size"] in TIGHT:
                geography.append(f"Shot {s['shot_id']} is a {s['size']} before any wide or two-shot: the audience has not "
                                 f"been shown where the characters are relative to each other.")
                break

    for s in shots:
        fr = int(s.get("duration", {}).get("frames", 0))
        if fr % 8 != 1:
            ltx.append(f"Shot {s['shot_id']}: {fr} frames is not 8k+1; LTX needs 8k+1.")
        if s["movement"]["id"] not in ("static", "handheld", "rack_focus") and fr < 49:
            ltx.append(f"Shot {s['shot_id']}: a {s['movement']['id']} over {fr} frames may truncate (LTX cuts a move short rather "
                       f"than slowing it). Generate 49+ frames and trim in the edit, or lock it off.")

    warnings = crossings + direction + thirty + geography + ltx
    verdict = "fail" if crossings or direction else "warn" if warnings else "pass"
    return {"verdict": verdict, "home_side": home, "line_crossings": crossings, "screen_direction": direction,
            "thirty_degree_warnings": thirty, "geography": geography, "ltx": ltx, "warnings": warnings,
            "per_shot": per_shot}


def report_text(result: dict) -> str:
    lines = [f"Coverage Doctor: {result['verdict'].upper()}"]
    for key, title in (("line_crossings", "180-degree line"), ("screen_direction", "Screen direction"),
                       ("thirty_degree_warnings", "30-degree rule"), ("geography", "Geography"), ("ltx", "LTX timing")):
        items = result.get(key, [])
        lines.append(f"- {title}: {'OK' if not items else ''}")
        lines += [f"    ! {w}" for w in items]
    return "\n".join(lines)
