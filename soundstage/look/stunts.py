"""Movie car stunts in words (Milestone 13): the Python side of web/stage/stunts.mjs.

A stunt car carries its own heading on its keys (`heading_deg`, unwrapped) or drives in reverse (`drive: "reverse"` on
the car or a key). The stage samples those headings; here the same headings tell the image and video models which
end of the car leads in each beat: reversing rear end first, the spin, then nose first. The beat words go in the
positive prompt (at CFG 1.0 a negative prompt does nothing), and never say "drift", "CGI", "video game" or "VFX":
those words pull the picture toward a game render.

Conventions as on the stage: +Z forward at heading 0, heading = atan2(x, z), radians here.
"""
from __future__ import annotations

import math
from typing import Callable

PosAt = Callable[[dict, int, int], tuple]


def heading_keys(a: dict) -> list[tuple[int, float]]:
    """[(frame, heading_deg)] in frame order, values as stored (unwrapped: 0 -> 360 is a full spin)."""
    out = []
    for k in a.get("keys") or []:
        h = k.get("heading_deg")
        if isinstance(h, (int, float)) and math.isfinite(h):
            out.append((int(k.get("frame", 0)), float(h)))
    return sorted(out)


def drive_at(a: dict, frame: int) -> str:
    d = a.get("drive") or "forward"
    for k in sorted(a.get("keys") or [], key=lambda k: int(k.get("frame", 0))):
        if int(k.get("frame", 0)) > frame:
            break
        if k.get("drive"):
            d = k["drive"]
    return d


def is_stunt(a: dict) -> bool:
    keys = a.get("keys") or []
    return bool(heading_keys(a)) or a.get("drive") == "reverse" or any(k.get("drive") == "reverse" for k in keys)


def unwrap_deg(prev: float, deg: float) -> float:
    """The heading closest to `prev` that points the same way as `deg`."""
    return deg + 360.0 * round((prev - deg) / 360.0)


def keyed_yaw(a: dict, frame: float) -> float | None:
    """Heading (radians) from the heading keys at `frame` (linear between keys; the stage's spline agrees at keys)."""
    hk = heading_keys(a)
    if not hk:
        return None
    if frame <= hk[0][0]:
        return math.radians(hk[0][1])
    for (f0, h0), (f1, h1) in zip(hk, hk[1:]):
        if frame <= f1:
            u = (frame - f0) / max(1e-6, f1 - f0)
            return math.radians(h0 + (h1 - h0) * u)
    return math.radians(hk[-1][1])


def _travel(a: dict, frame: int, last: int, pos_at: PosAt, span: int = 2) -> tuple[float, float, float]:
    """(vx, vz, speed in m per frame) around a frame."""
    p0, p1 = pos_at(a, max(0, frame - span), last), pos_at(a, min(last, frame + span), last)
    n = min(last, frame + span) - max(0, frame - span) or 1
    vx, vz = (p1[0] - p0[0]) / n, (p1[2] - p0[2]) / n
    return vx, vz, math.hypot(vx, vz)


def stunt_yaw(a: dict, frame: int, last: int, pos_at: PosAt) -> float | None:
    """The stunt car's nose heading at a frame (heading keys, else reversing = travel + 180°), or None if it isn't one."""
    y = keyed_yaw(a, frame)
    if y is not None:
        return y
    if drive_at(a, frame) != "reverse":
        return None
    for f in list(range(frame, -1, -1)) + list(range(frame + 1, last + 1)):
        vx, vz, sp = _travel(a, f, last, pos_at, 1)
        if sp > 0.004:
            return math.atan2(vx, vz) + math.pi
    return None


def reversing_at(a: dict, frame: int, last: int, pos_at: PosAt) -> bool:
    """Tail first at this frame: the nose points against the way it travels."""
    y = stunt_yaw(a, frame, last, pos_at)
    if y is None:
        return False
    for f in [frame] + list(range(frame + 1, min(last, frame + 12) + 1)):
        vx, vz, sp = _travel(a, f, last, pos_at)
        if sp > 0.01:
            return math.sin(y) * vx / sp + math.cos(y) * vz / sp < -0.5
    return False


def beats(a: dict, frames: int, fps: float, pos_at: PosAt) -> list[dict]:
    """The stunt's beats in order: [{"beat": reverse|spin|forward|stop, "start", "end", "turn_deg", "dir": (x, z)}].

    Per frame: spinning while the nose turns faster than 90°/s at speed (or slides more than 45° off its travel),
    else reversing (nose against the travel), forward, or stopped. Runs shorter than 4 frames join their neighbour."""
    last = max(1, frames - 1)
    tags, yaws = [], []
    for f in range(last + 1):
        y = stunt_yaw(a, f, last, pos_at)
        yaws.append(y)
        vx, vz, sp = _travel(a, f, last, pos_at)
        mps = sp * fps
        if y is None:
            tags.append("forward" if mps > 0.5 else "stop")
            continue
        y0, y1 = stunt_yaw(a, max(0, f - 2), last, pos_at), stunt_yaw(a, min(last, f + 2), last, pos_at)
        rate = abs(y1 - y0) / max(1, min(last, f + 2) - max(0, f - 2)) * fps
        c = (math.sin(y) * vx + math.cos(y) * vz) / sp if sp > 1e-6 else 0.0
        if mps > 1.0 and (math.degrees(rate) > 45 or abs(c) < 0.85):
            tags.append("spin")
        elif mps < 0.5:
            tags.append("stop")
        else:
            tags.append("reverse" if c < 0 else "forward")
    runs: list[list] = []
    for f, t in enumerate(tags):
        if runs and runs[-1][0] == t:
            runs[-1][2] = f
        else:
            runs.append([t, f, f])
    # A slow backwards roll straight after a spin is the slide running out (a handbrake 180 still carries a little
    # of its old way), not a reverse: it rocks to a stop.
    for i in range(1, len(runs)):
        if runs[i][0] == "reverse" and runs[i - 1][0] == "spin":
            p0, p1 = pos_at(a, runs[i][1], last), pos_at(a, runs[i][2], last)
            if math.hypot(p1[0] - p0[0], p1[2] - p0[2]) / max(1, runs[i][2] - runs[i][1]) * fps < 3.0:
                runs[i][0] = "stop"
    merged_runs: list[list] = []
    for r in runs:
        if merged_runs and merged_runs[-1][0] == r[0]:
            merged_runs[-1][2] = r[2]
        else:
            merged_runs.append(r)
    runs = merged_runs
    changed = True
    while changed and len(runs) > 1:          # fold blips (a 2-frame "forward" between two spin frames) into a neighbour
        changed = False
        for i, (t, s, e) in enumerate(runs):
            if e - s + 1 < 4:
                j = i - 1 if i > 0 else i + 1
                runs[j][1], runs[j][2] = min(runs[j][1], s), max(runs[j][2], e)
                del runs[i]
                merged = []
                for r in runs:
                    if merged and merged[-1][0] == r[0]:
                        merged[-1][2] = r[2]
                    else:
                        merged.append(r)
                runs = merged
                changed = True
                break
    out = []
    for t, s, e in runs:
        turn = 0.0
        if yaws[s] is not None and yaws[e] is not None:
            turn = math.degrees(abs(yaws[e] - yaws[s]))
        p0, p1 = pos_at(a, s, last), pos_at(a, e, last)
        out.append({"beat": t, "start": s, "end": e, "turn_deg": turn, "dir": (p1[0] - p0[0], p1[2] - p0[2]),
                    "speed": math.hypot(p1[0] - p0[0], p1[2] - p0[2]) / max(1, e - s) * fps})
    return out


def _smoke(a: dict) -> float:
    vals = [float((k.get("fx") or {}).get("tire_smoke") or 0) for k in a.get("keys") or []]
    return max(vals) if vals else -1.0


def _way(d: tuple, fwd: tuple, right: tuple) -> str:
    n = math.hypot(*d)
    if n < 1e-6:
        return ""
    x, z = d[0] / n, d[1] / n
    al = x * fwd[0] + z * fwd[2]
    if al > 0.6:
        return "away from the camera"
    if al < -0.6:
        return "toward the camera"
    return f"across frame toward screen-{'right' if x * right[0] + z * right[2] > 0 else 'left'}"


def _degrees_words(turn: float) -> str:
    if turn > 300:
        n = max(1, round(turn / 360))
        return {1: "a full circle", 2: "two full circles", 3: "three full circles"}.get(n, f"{n} full circles")
    return f"{int(round(turn / 45.0) * 45) or 90} degrees"


def stunt_mark(a: dict, frames: int, fps: float, pos_at: PosAt, fwd: tuple, right: tuple, spray: bool = False) -> tuple[str, str] | None:
    """(verb phrase, way) for the motion prompt's mark sentence, beat by beat, or None for an ordinary car.

    The reverse J-turn: "races backwards toward the camera, rear end first, its red tail lights and white reverse lights
    glowing; the driver lifts and flicks the wheel: the front swings wide and the whole car slides around 180 degrees
    in one long, scrubbing arc, ...; it wobbles straight on its springs, now facing the way it is moving, ... and drives
    forward"."""
    if not is_stunt(a):
        return None
    bs = [b for b in beats(a, frames, fps, pos_at) if b["beat"] != "stop" or b["end"] - b["start"] > 8]
    if not bs:
        return None
    smoke_amt = _smoke(a)
    puff = "white tyre smoke and spray" if spray else "white tyre smoke"
    parts: list[str] = []
    prev = None
    for i, b in enumerate(bs):
        way = _way(b["dir"], fwd, right)
        if b["beat"] == "reverse":
            verb = "races backwards" if b["speed"] > 6 else "reverses"
            parts.append(f"{'then ' if parts else ''}{verb} {way}, rear end first, its red tail lights and white reverse lights glowing, "
                         "the driver twisted round looking back over the seat")
        elif b["beat"] == "spin":
            turn = b["turn_deg"]
            if a.get("stunt") in ("reverse_jturn", "handbrake_180") and 120 < turn < 240:
                turn = 180.0   # the slide's last few degrees run out after the spin beat: it is still a 180
            smoke = smoke_amt != 0
            nxt = bs[i + 1]["beat"] if i + 1 < len(bs) else ""
            donut = turn > 300 or (a.get("stunt") == "donut" and turn > 200)
            which = "rear" if prev == "forward" or donut else "front"
            tail = f", a thick burst of {puff} pouring off the {which} tyres" if smoke else ""
            if donut:
                parts.append(f"spins {_degrees_words(turn)} on the spot, the nose locked inside a tight circle and the tail sliding "
                             f"round, the body leaning out hard on its springs, the tyres screaming{tail}")
            elif prev == "reverse":
                parts.append(f"the driver lifts and flicks the wheel: the front swings wide and the whole car slides around "
                             f"{_degrees_words(turn)} in one long, scrubbing arc, the heavy body rolling onto its outside tyres "
                             f"and rocking on its springs, the tyres screaming{tail}")
            else:
                parts.append(f"the driver yanks the handbrake: the tail steps out and the car slides round {_degrees_words(turn)} "
                             f"in one long arc, the body rolling onto its outside tyres, the tyres screaming{tail}")
            if nxt == "stop":
                parts[-1] += ", rocking to a stop on its springs"
        elif b["beat"] == "forward":
            if prev in ("spin", "stop"):
                parts.append(f"it wobbles straight on its springs, now facing the way it is moving, the rear squats as the driver feeds in the throttle and it "
                             f"drives forward, nose first, {way}" + (", trailing smoke" if smoke_amt != 0 else ""))
            else:
                parts.append(f"{'then ' if parts else ''}{'charges' if b['speed'] > 8 else 'drives'} forward {way}, nose first")
        elif b["beat"] == "stop":
            if prev != "spin":   # a spin that ends in a stop already says so
                parts.append("rocks to a stop on its springs")
        prev = b["beat"]
    if not any(b["beat"] in ("reverse", "spin") for b in bs):
        return None
    return "; ".join(parts), ""
