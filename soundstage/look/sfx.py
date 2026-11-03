"""Timed practical-effects beats for the LTX motion prompt (SFX rigs, web/stage/sfx.mjs).

The stage bake writes scene.physics.sfx: the fires of every rig ({id, kind, frame, t, by}), what caught fire, what each
blast did ({id, by, how}: flips, rolls, rolls over, rocks up, rocks, thrown, knocked down, falls, breaks) and the
wounds. The clay guide shows the fireball, the smoke and the stage blood; LTX paints them as filmed when the prompt names
them at the moment they happen, so each cue becomes one present-tense beat:

  "At 1.5 s a fireball erupts beside the red car: a rolling orange fireball and a shockwave that throws debris outward;
   the car is thrown up and rolls onto its roof, the crate is thrown, the man is knocked off his feet; then a column of
   thick black smoke rises, and a bright orange flash lights the set."

The rigs themselves (kind sfx_*) are crew equipment: they are never described as things in the shot
(without_rigs drops them before the rest of the compile). Gore stays at film level (stage blood, a squib, a stunt
knife): what the audience sees, no real-world weapon or device detail. Scenes without rigs compile exactly as before.
"""
from __future__ import annotations

from . import scene as S
from .impacts import shake_on

PREFIX = "sfx_"
MAX_BEATS = 6
POINTS = {"chest": "chest", "belly": "stomach", "shoulder_l": "left shoulder", "shoulder_r": "right shoulder", "back": "back",
          "arm_l": "left arm", "arm_r": "right arm", "leg_l": "left thigh", "leg_r": "right thigh"}
SMOKE = {"grey": "grey", "white": "white", "black": "black", "red": "red", "orange": "orange", "yellow": "yellow", "green": "green",
         "blue": "blue", "purple": "purple"}
SQUIB = {
    "wall": "a bullet hit bursts on the wall in a puff of dust and chips",
    "ground": "a bullet hit kicks up a spurt of dirt from the ground",
    "glass": "a bullet hit cracks the glass and sprays glittering shards",
    "car": "a bullet hit sparks off the car's bodywork",
    "water": "a bullet hit throws up a spout of water",
}
SQUIBS = {
    "wall": "bullet hits stitch across the wall, bursting in puffs of dust and chips",
    "ground": "bullet hits stitch across the ground, kicking up spurts of dirt",
    "glass": "bullet hits crack the glass, spraying glittering shards",
    "car": "bullet hits spark off the car's bodywork",
    "water": "bullet hits throw up spouts of water",
}
BLAST_HOW = {"flips": "is thrown up and lands on its roof", "rolls": "is lifted and rolls onto its side",
             "rolls over": "is lifted and rolls right over", "rocks up": "rocks up onto two wheels and slams back down",
             "rocks": "rocks hard on its suspension", "thrown": "is thrown through the air", "knocked down": "is knocked off their feet",
             "falls": "is knocked down", "breaks": "bursts apart"}
NUMBERS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}


def is_rig(a: dict | None) -> bool:
    return isinstance(a, dict) and str(a.get("kind") or "").startswith(PREFIX)


def without_rigs(scene: dict) -> dict:
    """The scene without its SFX rig markers (crew equipment, never in the shot); the rest is untouched."""
    if not isinstance(scene, dict) or not any(is_rig(a) for a in scene.get("actors") or []):
        return scene
    out = dict(scene)
    out["actors"] = [a for a in scene.get("actors") or [] if not is_rig(a)]
    out["sfx_rigs"] = [a for a in scene.get("actors") or [] if is_rig(a)]
    return out


def _rigs(scene: dict) -> dict:
    rigs = list(scene.get("sfx_rigs") or []) + [a for a in scene.get("actors") or [] if is_rig(a)]
    return {a.get("id"): a for a in rigs if isinstance(a, dict)}


def _the(a: dict) -> str:
    noun = S.classify(a)[0]
    for art in ("a ", "an "):
        if noun.startswith(art):
            return "the " + noun[len(art):]
    return noun if noun.startswith("the ") else "the " + noun


def _poss(a: dict | None) -> str:
    k = (a or {}).get("kind")
    return "his" if k == "man" else "her" if k == "woman" else "their"


def _subj(a: dict | None) -> str:
    k = (a or {}).get("kind")
    return "he" if k == "man" else "she" if k == "woman" else "they"


def _near(scene: dict, rig: dict, actors: dict) -> str:
    """What the rig sits next to, for the beat ("beside the red car"), or ''."""
    p = rig.get("position") or [0, 0, 0]
    best, bd = None, 4.0
    for a in actors.values():
        if is_rig(a) or not isinstance(a.get("position"), list):
            continue
        q = a["position"]
        d = ((q[0] - p[0]) ** 2 + (q[2] - p[2]) ** 2) ** 0.5
        if d < bd:
            best, bd = a, d
    return f" beside {_the(best)}" if best else ""


def _s(x: dict, k: str, default=None):
    v = (x.get("sfx") or {}).get(k)
    return default if v is None else v


def _wear(who: dict | None) -> str:
    k = (who or {}).get("kind")
    return "shirt" if k in ("man", "woman", "child") else "clothes"


def _reaction(point: str, power: float, fall, who: dict | None) -> str:
    """The stunt performer's reaction, by where the hit lands (sfx.mjs hitReaction, in words)."""
    sub, pos = _subj(who), _poss(who)
    part = POINTS.get(point, "chest")
    base = point.split("_")[0]
    goes = fall is True or (fall is None and power >= 0.7 and (power >= 0.9 or base not in ("chest", "belly", "back")))
    if fall is False:
        goes = False
    if base == "chest":
        return f"{sub} jolts back, clutches {pos} chest" + (" and falls backwards to the ground" if goes else " and staggers")
    if base == "belly":
        return f"{sub} doubles over, clutching {pos} stomach" + (" and drops forward" if goes else "")
    if base == "back":
        return f"{sub} is thrown forward, arching" + (" and falls face down" if goes else "")
    if base == "shoulder":
        return f"{sub} spins with the hit, grabbing {pos} {part}" + (" and goes down" if goes else "")
    if base == "arm":
        return f"{sub} flinches, grabbing {pos} {part}"
    if base == "leg":
        return f"{pos} {part} buckles" + (f" and {sub} drops to one knee" if goes else "")
    return f"{sub} jolts with the hit"


def sfx_beats(scene: dict | None) -> str:
    """The timed SFX beat sentences ("" when the scene has no rig that fires)."""
    if not isinstance(scene, dict):
        return ""
    rec = (scene.get("physics") or {}).get("sfx") or {}
    fires = [f for f in rec.get("fires") or [] if isinstance(f, dict)]
    if not fires:
        return ""
    rigs = _rigs(scene)
    actors = {a.get("id"): a for a in scene.get("actors") or [] if isinstance(a, dict) and not is_rig(a)}
    affected = [x for x in rec.get("affected") or [] if isinstance(x, dict)]
    burning = rec.get("burning") or {}
    jolt = shake_on(scene) or (scene.get("physics") or {}).get("sfxShake") is not False
    beats: list[tuple[float, str]] = []
    squib_runs: dict[str, list[dict]] = {}
    for f in sorted(fires, key=lambda x: (float(x.get("t") or 0), str(x.get("id")))):
        rig = rigs.get(f.get("id")) or {}
        kind, t = f.get("kind"), float(f.get("t") or 0)
        when = f"At {t:.1f} s"
        power = float(_s(rig, "power", 1) or 1)
        if kind == "explosion":
            hit = [x for x in affected if x.get("by") == f.get("id") and x.get("id") in actors]
            what = []
            for x in hit[:4]:
                a = actors[x["id"]]
                how = BLAST_HOW.get(x.get("how"), "is thrown")
                if a.get("kind") in ("man", "woman", "child"):
                    how = "is knocked off " + _poss(a) + " feet"
                what.append(f"{_the(a)} {how}")
            big = "a huge" if power >= 2 else "a"
            s = f"{when} {big} fireball erupts{_near(scene, rig, actors)}: a rolling orange fireball and a shockwave that throws debris outward"
            if what:
                s += "; " + ", ".join(what)
            s += "; then a column of thick black smoke rises, and a bright orange flash lights the set"
            if jolt:
                s += ", the camera shaking with the blast"
            beats.append((t, s))
        elif kind == "fire":
            beats.append((t, f"{'From the start' if t < 0.05 else f'From {t:.1f} s'} orange flames lick up{_near(scene, rig, actors)}, crackling, with dark smoke curling up and flickering firelight on everything around"))
        elif kind == "sparks":
            beats.append((t, f"{when} a shower of bright orange sparks pours down, bouncing and skittering across the floor and lighting the set orange"))
        elif kind == "smoke_bomb":
            col = SMOKE.get(_s(rig, "color", "grey"), "grey")
            beats.append((t, f"{when} a smoke canister pours out a thick plume of {col} smoke that billows and drifts across the set"))
        elif kind == "breakaway_glass":
            beats.append((t, f"{when} the pane of glass shatters into a spray of glittering shards that rain down"))
        elif kind == "flare":
            beats.append((t, f"{when} a road flare sputters alight, fizzing with a hot red glow and a trail of pink smoke"))
        elif kind == "squib":
            surf = _s(rig, "surface", "auto")
            if surf == "auto":
                surf = "ground" if float((rig.get("position") or [0, 0, 0])[1] or 0) < 0.25 else "wall"
            squib_runs.setdefault(surf, []).append(f)
        elif kind in ("body_squib", "stab"):
            who = actors.get(_s(rig, "target"))
            if not who:
                continue
            point = _s(rig, "point", "belly" if kind == "stab" else "chest")
            part = POINTS.get(point, "chest")
            blood = _s(rig, "blood", True) is not False
            react = _s(rig, "react", True) is not False
            fall = _s(rig, "fall", None)
            name, pos = _the(who), _poss(who)
            if kind == "body_squib":
                s = f"{when} a squib bursts on {name}'s {part} with a puff of torn {_wear(who)} fabric" + (" and a spray of stage blood" if blood else "")
            else:
                s = (f"{when} a retractable stunt knife strikes {name}'s {part}: a slash opens across {pos} {_wear(who)}"
                     + (" with a thin line of stage blood" if blood else ""))
            if react:
                s += "; " + _reaction(point, power, fall, who)
            beats.append((t, s))
    for surf, run in squib_runs.items():
        t = float(run[0].get("t") or 0)
        if len(run) == 1:
            beats.append((t, f"At {t:.1f} s {SQUIB.get(surf, SQUIB['wall'])}"))
        else:
            n = NUMBERS.get(len(run), "several")
            beats.append((t, f"From {t:.1f} s {n} {SQUIBS.get(surf, SQUIBS['wall'])}"))
    # What caught fire (once, after the beat that lit it).
    lit = [actors[i] for i in sorted(burning, key=lambda i: (burning[i].get("frame") or 0)) if i in actors]
    if lit:
        fps = float((scene.get("shot") or {}).get("fps") or 24)
        t = float(burning[lit[0]["id"]].get("frame") or 0) / fps
        each = [_the(a) for a in lit[:3]]
        names = (f"{NUMBERS.get(len(lit), 'several')} {each[0][4:]}s one after another" if len(set(each)) == 1 and len(lit) > 1
                 else ", ".join(dict.fromkeys(each)))
        beats.append((t + 0.01, f"At {t:.1f} s {names} {'catches' if len(lit) == 1 else 'catch'} fire and {'burns' if len(lit) == 1 else 'burn'} with tall orange flames and black smoke"))
    # Wounds that stay: the stain on the wardrobe for the rest of the shot.
    stains = []
    for w in rec.get("wounds") or []:
        who = actors.get(w.get("target"))
        if who and (_s(rigs.get(w.get("rig")) or {}, "blood", True) is not False):
            stains.append(f"a dark red stage-blood stain spreads across {_the(who)}'s {_wear(who)} at the {POINTS.get(w.get('point'), 'chest')} and stays")
    beats.sort(key=lambda b: b[0])
    out = [b[1] for b in beats[:MAX_BEATS]]
    if stains:
        out.append(stains[0][0].upper() + stains[0][1:] + (" for the rest of the shot" if len(stains) == 1 else ", with more stains where the other hits landed"))
    if not out:
        return ""
    return " ".join(s[0].upper() + s[1:] + "." for s in out) + " Practical film effects, shot in camera."


def sfx_still_words(scene: dict | None) -> str:
    """Frame 1 words: a fire or a smoke bomb going from the first frame ("" otherwise)."""
    if not isinstance(scene, dict):
        return ""
    rec = (scene.get("physics") or {}).get("sfx") or {}
    rigs = _rigs(scene)
    out = []
    for f in rec.get("fires") or []:
        if float(f.get("t") or 0) > 0.05:
            continue
        rig = rigs.get(f.get("id")) or {}
        if f.get("kind") == "fire":
            out.append("orange flames burning with dark smoke rising")
        elif f.get("kind") == "smoke_bomb":
            out.append(f"a thick plume of {SMOKE.get(_s(rig, 'color', 'grey'), 'grey')} smoke")
        elif f.get("kind") == "flare":
            out.append("a burning red road flare")
    return (", ".join(dict.fromkeys(out)).capitalize() + ".") if out else ""
