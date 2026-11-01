"""Timed material beats for the LTX motion prompt (Milestone 21).

The stage bake logs every hit (scene.physics.events: frame, t, impulse, speed, a, b, mat_a, mat_b; see
web/stage/impacts.mjs). The clay can't crumple or splinter, but LTX paints the deformation when it is named at the
moment it happens, so each big moment becomes one present-tense beat with material verbs:

  "At 2.4 s the sports car slams into the wooden crates: planks crack and splinter, boards spring loose, a burst of
   dust and wood chips; the camera jolts."

Material words stay in the positive prompt. Scenes without events compile exactly as before.
"""
from __future__ import annotations

from . import scene as S

# What each material does when it is hit (deformation the rigid clay can't show), and what it throws off.
MATERIAL_VERBS = {
    "cardboard": ("crumple and dent, seams split and flaps tear", "a puff of dust and torn scraps"),
    "wood": ("splinter, planks crack and spring loose", "a burst of dust and wood chips"),
    "metal": ("dents and scrapes with a shower of sparks", "sparks"),
    "stone": ("chips and cracks", "a cloud of grit and stone dust"),
    "concrete": ("cracks and chips", "a cloud of grey dust"),
    "glass": ("shatters into shards", "glittering shards across the ground"),
    "plastic": ("bend and crack", "plastic fragments"),
    "rubber": ("squash and bounce", ""),
}
NOUNS = {"cardboard": "cardboard boxes", "wood": "wooden crates", "metal": "metal drums", "stone": "rocks",
         "glass": "glass", "plastic": "plastic crates", "concrete": "concrete blocks", "rubber": "rubber balls"}
KIND_MATERIAL = {"crate": "wood", "chair": "wood", "table": "wood", "bench": "wood", "desk": "wood", "rock": "stone",
                 "wall": "concrete", "cube": "cardboard", "box": "cardboard", "pyramid": "cardboard", "cylinder": "metal",
                 "tv": "glass", "sphere": "rubber", "cone": "plastic", "car": "metal", "truck": "metal",
                 "police_car": "metal", "sports_car": "metal", "hatchback": "metal", "motorcycle": "metal"}
VEHICLES = {"car", "truck", "police_car", "sports_car", "hatchback", "motorcycle", "bicycle", "train"}
WEIGHT = "Heavy, weighty impacts with real-world physics and natural motion blur."
SLOW_MO = "Slow motion, shot on a high-speed camera: the debris hangs in the air."
BEAT_GAP_S = 0.45      # beats are at least this far apart
MIN_IMPULSE = 90.0     # a beat needs a hit at least this hard (a 25 kg crate dropped ~0.5 m)
MAX_BEATS = 3


def material_of(a: dict | None) -> str:
    if not a:
        return "wood"
    m = (a.get("physics") or {}).get("material")
    return m if m in MATERIAL_VERBS else KIND_MATERIAL.get(a.get("kind") or "", "wood")


def _the(a: dict) -> str:
    noun = S.classify(a)[0]
    for art in ("a ", "an "):
        if noun.startswith(art):
            return "the " + noun[len(art):]
    return noun if noun.startswith("the ") else "the " + noun


def _ground(scene: dict) -> str:
    env = (scene.get("environment") or {}).get("set") or ""
    if scene.get("interior") or env in ("studio", "apartment", "office", "warehouse"):
        return "the floor"
    if "street" in env or "road" in env or "highway" in env or "parking" in env:
        return "the asphalt"
    return "the ground"


def shake_on(scene: dict) -> bool:
    shot = next((s for s in scene.get("shots") or [] if s.get("id") == scene.get("active_shot")), None) or {}
    return (shot.get("impact_shake") or (scene.get("physics") or {}).get("shake") or "off") not in ("off", None, "")


def overcrank(scene: dict) -> float:
    try:
        return float((scene.get("physics") or {}).get("overcrank") or 1)
    except (TypeError, ValueError):
        return 1.0


def _beats(events: list[dict]) -> list[tuple[list[dict], dict]]:
    """The big moments: the hardest hits at least BEAT_GAP_S apart (strongest first), each with the hits around it."""
    chosen: list[dict] = []
    for e in sorted(events, key=lambda x: -float(x.get("impulse") or 0)):
        if float(e.get("impulse") or 0) < MIN_IMPULSE or len(chosen) >= MAX_BEATS:
            break
        if all(abs(float(e.get("t") or 0) - float(c.get("t") or 0)) > BEAT_GAP_S for c in chosen):
            chosen.append(e)
    out = []
    for c in sorted(chosen, key=lambda x: float(x.get("t") or 0)):
        tc = float(c.get("t") or 0)
        near = [e for e in events if abs(float(e.get("t") or 0) - tc) <= 0.2]
        out.append((near, c))
    return out


def impact_beats(scene: dict | None) -> str:
    """The timed beat sentences for a scene's baked hits ("" when there are none worth a beat)."""
    if not isinstance(scene, dict):
        return ""
    phys = scene.get("physics") or {}
    events = [e for e in phys.get("events") or [] if isinstance(e, dict)]
    slow = SLOW_MO if overcrank(scene) >= 1.5 else ""
    if not events:
        return slow
    actors = {a.get("id"): a for a in scene.get("actors") or [] if isinstance(a, dict)}
    ground = _ground(scene)
    beats = _beats(events)
    if not beats:
        return slow
    jolt = shake_on(scene)
    told_props: set[str] = set()
    out = []
    for i, (cl, big) in enumerate(beats):
        ids = {x for e in cl for x in (e.get("a"), e.get("b"))}
        movers = [actors[x] for x in (big.get("a"), big.get("b")) if x in actors and actors[x].get("kind") in VEHICLES]
        props = [actors[x] for x in ids if x in actors and actors[x].get("kind") not in VEHICLES
                 and (actors[x].get("physics") or {}).get("mode") == "dynamic"]
        mats = [material_of(p) for p in props] or ["wood"]
        mat = max(set(mats), key=lambda m: (mats.count(m), m))
        verbs, burst = MATERIAL_VERBS.get(mat, MATERIAL_VERBS["wood"])
        noun = NOUNS.get(mat, "crates")
        if len(props) == 1:
            noun = _the(props[0])[4:]
        again = noun in told_props
        told_props.add(noun)
        t = float(big.get("t") or 0)
        when = f"At {t:.1f} s"
        hits_ground = any("__ground" in (e.get("a"), e.get("b")) for e in cl)
        if movers:
            car = _the(movers[0])
            verb = "slams into" if i == 0 or not again else "plows through"
            what = f"{'what is left of ' if again else ''}the {noun}"
            if again:   # told once already: shorter, so the beats don't read as a list
                s = f"{when} {car} {verb} {what}, scattering them, another burst of dust"
            else:
                s = f"{when} {car} {verb} {what}: the {noun.split()[-1]} {verbs}" + (f", {burst}" if burst else "")
        elif hits_ground:
            s = f"{when} the {noun} crash down onto {ground} and {verbs.split(',')[0]}, dust rolling across {ground}"
        else:
            s = f"{when} the {noun} smash into each other and {verbs.split(',')[0]}, {burst}" if burst else f"{when} the {noun} smash into each other"
        if jolt and float(big.get("impulse") or 0) >= 150:
            s += "; the camera jolts with the impact"
        out.append(s.rstrip(",") + ".")
    tail = [WEIGHT]
    if overcrank(scene) >= 1.5:
        tail.append(SLOW_MO)
    return " ".join(out + tail)
