"""Generative transitions for the Cut: a short LTX-2.5 bridge between two clips (docs/cut.md#generative-transitions).

No ComfyUI imports. The browser twin is web/cut/gentransitions.mjs (placement, the panel, the viewer); the HTTP route is
soundstage/cut/gentransitions_routes.py; tests are tests/test_gentransitions.py and tests/js/gentransitions.test.mjs.

How a bridge sits in the cut
  A bridge belongs to one edit (the cut from clip A into clip B). It covers record frames [at - pre, at + post): the
  last `pre` frames of A and the first `post` frames of B, so the cut keeps its length and no sound moves. It is
  rendered from A's frame (A.out - pre), held exactly at bridge frame 0, to B's frame (B.in + post - 1), a guide at the
  last index: both ends of the bridge are the pictures it replaces, so it joins A and B without a jump.
  pre + post is an LTX length (8k + 1 frames, 17..97). The render uses the project's frame rate, one bridge frame per
  record frame.
  The bridge remembers the two frames and the render it was made from. If a trim, a slip or a new render of A or B
  changes either, the bridge is stale: it is drawn hatched and neither played nor rendered until it is rendered again.

The graph
  The Seamless-loop bridge graph (soundstage/loop/graphs.py loop(): LTXVImgToVideoInplace at frame 0, LTXVAddGuide at
  frame_idx -1, 8-step distilled, Final adds the x2 latent upsampler and a 3-step refine), so no new nodes or models.
  It is built once per (size, quality, sound) as a template and filled through named slots, after Seam
  (github.com/jdnichollsc/seam, MIT): template() puts a sentinel in every slot, trace_slots() finds where each one
  landed ([node_id, input] pairs), fill() writes the values back through that map only.
"""
from __future__ import annotations

import copy
import json

from ..footage import graphs as FG
from ..loop import graphs as LG

WEIGHTS = LG.LOOP_WEIGHTS
QUALITY = LG.QUALITY
MIN_FRAMES, MAX_FRAMES = 17, 97
PREFIX = "soundstage_private/gentrans/bridge"

# Written for short bridges between two pictures. The path / camera / sound split follows Seam's presets, and Smoke, Whip pan,
# Zoom through, Ink bleed, Morph and Water bend (and several camera and sound phrases) adapt Seam's preset wording
# (github.com/jdnichollsc/seam, MIT, (c) 2026 jdnichollsc: soundstage/cut/SEAM_LICENSE.txt, THIRD_PARTY_NOTICES.md).
# frames: the default length (8k + 1), end: the strength of the end-picture guide.
STYLES = {
    "smoke": {
        "name": "Smoke", "frames": 33, "end": 1.0,
        "path": "Thick grey smoke rolls in from the edges of the frame and swallows the first picture; it swirls, "
                "thins and clears, and the second picture is there behind it.",
        "camera": "a slow push-in through the smoke", "sound": "a deep rolling whoosh",
        "avoid": "fire, flames, explosion"},
    "water_bend": {
        "name": "Water bend", "frames": 41, "end": 1.0,
        "path": "The first picture ripples and bends as if seen through a sheet of moving water; a clear wave sweeps "
                "across the frame, and as the water settles the second picture comes into focus.",
        "camera": "static camera", "sound": "rushing water and a soft splash",
        "avoid": "people swimming, boats, underwater scene"},
    "whip_pan": {
        "name": "Whip pan", "frames": 17, "end": 1.0,
        "path": "The camera whips sideways away from the first picture in a fast pan smeared with horizontal motion "
                "blur, and lands precisely on the second picture, which snaps into sharp focus.",
        "camera": "a fast horizontal whip pan that settles at the end", "sound": "a sharp swish",
        "avoid": "vertical motion, zoom, spinning"},
    "match_cut": {
        "name": "Match cut", "frames": 17, "end": 1.0,
        "path": "The main shape in the first picture keeps its place and outline in the frame while everything "
                "around it changes; it becomes the matching shape in the second picture, which settles in the same "
                "spot.",
        "camera": "locked camera, the shape stays where it is in the frame", "sound": "a soft tonal swell",
        "avoid": "smoke, fire, flash, camera move, motion blur"},
    "light_leak": {
        "name": "Light leak", "frames": 25, "end": 1.0,
        "path": "A warm orange and red light leak flares across the frame like light spilling onto old film, glowing "
                "brighter until it washes the first picture out, then fading to reveal the second picture.",
        "camera": "static camera", "sound": "a soft rising shimmer",
        "avoid": "explosion, fire, lens flare streaks, white frame"},
    "ink_bleed": {
        "name": "Ink bleed", "frames": 41, "end": 1.0,
        "path": "Dark ink bleeds into the first picture from the edges and blooms through it like ink dropped in "
                "water until it fills the frame, then draws back to reveal the second picture.",
        "camera": "static camera", "sound": "a muffled underwater swirl",
        "avoid": "text, writing, handwriting, black frame"},
    "zoom_through": {
        "name": "Zoom through", "frames": 25, "end": 1.0,
        "path": "The camera rushes forward into the first picture with streaking motion blur, flies through it and "
                "comes out inside the second picture, slowing to a stop.",
        "camera": "a fast dolly-in that slows down at the end", "sound": "a rushing wind whoosh",
        "avoid": "spinning, tunnel of light, sideways pan"},
    "morph": {
        "name": "Morph", "frames": 49, "end": 1.0,
        "path": "The first picture flows like soft liquid: shapes, colours and light reshape continuously, every "
                "contour moving smoothly until it settles into the second picture.",
        "camera": "static camera with a gentle slow push-in", "sound": "a soft airy shimmer",
        "avoid": "smoke, ink, flash, hard edges tearing"},
}
ORDER = ["smoke", "water_bend", "whip_pan", "match_cut", "light_leak", "ink_bleed", "zoom_through", "morph"]

# The loop's negative says "dissolve, zoom, morphing, camera shake": wrong here. LTX's own list plus what breaks a bridge.
NEGATIVE = FG.LTX_NEGATIVE + ", hard cut, jump cut, freeze frame, still image, slideshow, split screen, black frame, text"


def lengths(max_frames: int = MAX_FRAMES) -> list[int]:
    """The bridge lengths LTX can render, 8k + 1 frames, 17 .. min(97, max_frames)."""
    return list(range(MIN_FRAMES, min(MAX_FRAMES, int(max_frames)) + 1, 8))


def snap_length(n: float, max_frames: int = MAX_FRAMES) -> int:
    """The nearest LTX length to n, at most max_frames; 0 when even 17 frames don't fit."""
    ok = lengths(max_frames)
    if not ok:
        return 0
    return min(ok, key=lambda v: (abs(v - n), v))


def prompt_for(style: str, extra: str = "") -> str:
    s = STYLES[style]
    extra = (extra or "").strip()
    extra = f" {extra.rstrip('.')}." if extra else ""
    return ("Use the start picture as the first frame and the end picture as the last frame. "
            f"{s['path']} Camera: {s['camera']}. Sound: {s['sound']}.{extra} One continuous shot from the first "
            "picture to the second, with no hard cut and no plain crossfade.")


def negative_for(style: str) -> str:
    return f"{NEGATIVE}, {STYLES[style]['avoid']}"


# ------------------------------------------------------------------------------------------ slot-mapped graph

# A sentinel per slot: values nothing else in the graph uses, so tracing finds exactly the inputs they went to.
SENTINELS = {
    "image_a": "@@slot:image_a@@", "image_b": "@@slot:image_b@@", "prompt": "@@slot:prompt@@",
    "negative": "@@slot:negative@@", "prefix": "@@slot:prefix@@",
    "seed": 917_000_131, "frames": 9_017, "fps": 917.125, "guide_last": 0.917_013,
}


def template(weights: dict, *, width: int, height: int, quality: str = "Draft", sound: bool = True) -> dict:
    """The bridge graph for one stage-1 size, with SENTINELS in its slots. width/height: the render size (multiples
    of 32, from LG.render_size)."""
    q = QUALITY.get(quality, QUALITY["Draft"])
    S = SENTINELS
    g = LG.Prompt()
    a = g.node("SoundstageImageLoad", id="a", source=S["image_a"]).out(0)
    b = g.node("SoundstageImageLoad", id="b", source=S["image_b"]).out(0)
    frames, audio = LG.loop(g, weights, {"first": a, "last": b, "width": int(width), "height": int(height),
                                         "frames": S["frames"], "fps": S["fps"], "seed": S["seed"],
                                         "prompt": S["prompt"], "negative": S["negative"],
                                         "two_stage": q["two_stage"], "end_strength": S["guide_last"]})
    kw = {"audio": audio} if sound else {}
    video = g.node("CreateVideo", images=frames, fps=S["fps"], **kw).out(0)
    g.node("SaveVideo", id="save", video=video, filename_prefix=S["prefix"], format="mp4", **{"format.codec": "h264"})
    return g.json()


def _same(v, s) -> bool:
    return type(v) is type(s) and v == s


def trace_slots(graph: dict, sentinels: dict = SENTINELS) -> dict:
    """{slot: [[node_id, input], ...]} for every input that holds a slot's sentinel (sorted, so maps compare)."""
    out = {k: [] for k in sentinels}
    for nid, node in graph.items():
        for inp, v in node.get("inputs", {}).items():
            for k, s in sentinels.items():
                if _same(v, s):
                    out[k].append([nid, inp])
    return {k: sorted(v) for k, v in out.items()}


def missing_slots(graph: dict, slots: dict) -> list[str]:
    """Slots whose node or input no longer exists in the graph (template drift)."""
    return sorted(k for k, refs in slots.items()
                  if not refs or any(n not in graph or i not in graph[n].get("inputs", {}) for n, i in refs))


def fill(graph: dict, slots: dict, values: dict) -> dict:
    """A copy of graph with values written through slots. Every slot must get a value; an unknown name is an error."""
    unknown = set(values) - set(slots)
    if unknown:
        raise KeyError(f"unknown slots: {sorted(unknown)}")
    left = set(slots) - set(values)
    if left:
        raise ValueError(f"no value for slots: {sorted(left)}")
    g = copy.deepcopy(graph)
    for k, v in values.items():
        for nid, inp in slots[k]:
            g[nid]["inputs"][inp] = v
    return g


_TEMPLATES: dict = {}


def compiled(weights: dict, *, width: int, height: int, quality: str, sound: bool) -> tuple[dict, dict]:
    """(template, slots), cached per weights / size / quality / sound."""
    key = (json.dumps(weights, sort_keys=True), int(width), int(height), quality, bool(sound))
    if key not in _TEMPLATES:
        t = template(weights, width=width, height=height, quality=quality, sound=sound)
        slots = trace_slots(t)
        miss = missing_slots(t, slots)
        if miss:
            raise RuntimeError(f"bridge template lost its slots: {miss}")
        _TEMPLATES[key] = (t, slots)
    return _TEMPLATES[key]


def build(weights: dict, *, image_a: str, image_b: str, width: int, height: int, frames: int, fps: float = 24.0,
          style: str = "smoke", prompt: str = "", seed: int = 7, quality: str = "Draft", sound: bool = True,
          prefix: str = PREFIX) -> dict:
    """The API prompt for one bridge (SaveVideo node id "save"). image_a/image_b: annotated file references of the
    two pictures; width/height: their size (the render keeps the aspect); frames: an LTX length."""
    if style not in STYLES:
        raise ValueError(f"style: one of {', '.join(ORDER)}")
    n = int(frames)
    if n < MIN_FRAMES or n > MAX_FRAMES or (n - 1) % 8:
        raise ValueError(f"frames: 8k + 1 between {MIN_FRAMES} and {MAX_FRAMES} (got {n})")
    quality = quality if quality in QUALITY else "Draft"
    W, H = LG.render_size(width, height, QUALITY[quality]["short"])
    t, slots = compiled(weights, width=W, height=H, quality=quality, sound=sound)
    return fill(t, slots, {"image_a": image_a, "image_b": image_b, "prompt": prompt_for(style, prompt),
                           "negative": negative_for(style), "prefix": prefix, "seed": int(seed), "frames": n,
                           "fps": float(fps), "guide_last": float(STYLES[style]["end"])})


# ------------------------------------------------------------------------------------------ placement (twin of JS)

def best_render(shot: dict) -> str:
    r = shot.get("renders") or {}
    return str(r.get("final") or r.get("draft") or r.get("look") or "")


def locate(project: dict, gt: dict) -> int:
    """Index k of the cut event the bridge's edit goes into (its A is k - 1), or -1 when the edit is gone.
    An edit is (from shot, to shot, occurrence): the n-th time A is followed by B in the cut."""
    cut = project.get("cut") or []
    n = 0
    for k in range(1, len(cut)):
        if str(cut[k - 1]["shot_id"]) == str(gt.get("from")) and str(cut[k]["shot_id"]) == str(gt.get("to")):
            if n == int(gt.get("occ") or 0):
                return k
            n += 1
    return -1


def max_sides(project: dict, k: int) -> tuple[int, int]:
    """The most frames a bridge on edit k may take from A and from B: under half of each clip (so two bridges on a
    clip's two ends never meet and it keeps a frame of its own)."""
    cut = project["cut"]
    la, lb = cut[k - 1]["out"] - cut[k - 1]["in"], cut[k]["out"] - cut[k]["in"]
    return max(0, (la - 1) // 2), max(0, (lb - 1) // 2)


def span(project: dict, gt: dict) -> dict | None:
    """Where the bridge is now: {k, at, pre, post, frames, a_src, b_src}, or None when its edit is gone."""
    k = locate(project, gt)
    if k < 0:
        return None
    cut = project["cut"]
    at = sum(e["out"] - e["in"] for e in cut[:k])
    pre, post = int(gt["pre"]), int(gt["post"])
    return {"k": k, "at": at, "pre": pre, "post": post, "frames": pre + post,
            "a_src": cut[k - 1]["out"] - pre, "b_src": cut[k]["in"] + post - 1}


def status(project: dict, gt: dict) -> tuple[str, str]:
    """("ready" | "planned" | "stale" | "lost", why). Only "ready" plays and renders."""
    sp = span(project, gt)
    if not sp:
        return "lost", "its cut is gone"
    ma, mb = max_sides(project, sp["k"])
    if sp["pre"] > ma or sp["post"] > mb:
        return "stale", "a clip got too short for it"
    if not (gt.get("url") or gt.get("path")):
        return "planned", "not rendered yet"
    shots = {str(s["id"]): s for s in project.get("shots") or []}
    a, b = gt.get("a") or {}, gt.get("b") or {}
    if int(gt.get("rendered_frames") or 0) != sp["frames"]:
        return "stale", "its length changed"
    if a.get("frame") != sp["a_src"] or b.get("frame") != sp["b_src"]:
        return "stale", "the cut moved under it"
    sa, sb = shots.get(str(gt["from"])), shots.get(str(gt["to"]))
    if not sa or not sb or a.get("media", "") != best_render(sa) or b.get("media", "") != best_render(sb):
        return "stale", "a clip has a new render"
    return "ready", ""


def bridge_shot_id(gt: dict) -> str:
    return f"gt_{gt['id']}"


def flatten(project: dict) -> dict:
    """The project with every ready bridge cut in as a clip of its own: A ends `pre` frames early, the bridge plays,
    B starts `post` frames late; a transition on that edit is dropped (the bridge replaces it). Same length, same
    sound. Everything else, stale and planned bridges included, is left as it is. The render (render.py) and exports
    take this; the browser twin is flatten() in web/cut/gentransitions.mjs."""
    gts = project.get("gen_transitions") or []
    ready = []
    for gt in gts:
        st, _ = status(project, gt)
        if st == "ready":
            ready.append((span(project, gt)["k"], gt))
    if not ready:
        return project
    by_k = dict(ready)
    cut = [dict(e) for e in project["cut"]]
    out, shots = [], list(project.get("shots") or [])
    for k, ev in enumerate(cut):
        gt_in = by_k.get(k)
        gt_out = by_k.get(k + 1)
        e = dict(ev)
        if gt_in:
            e["in"] = e["in"] + int(gt_in["post"])
            e.pop("trans", None)
            n = int(gt_in["pre"]) + int(gt_in["post"])
            sid = bridge_shot_id(gt_in)
            shots.append({"id": sid, "name": f"GT {STYLES.get(gt_in.get('style'), {}).get('name', 'Bridge')}",
                          "frames": n, "scene_name": "", "setup": "Generative transition", "scene_offset": 0,
                          "renders": {"final": gt_in.get("url") or gt_in.get("path")}, "gen_transition": gt_in["id"]})
            out.append({"shot_id": sid, "in": 0, "out": n})
        if gt_out:
            e["out"] = e["out"] - int(gt_out["pre"])
        out.append(e)
    return {**project, "cut": out, "shots": shots}
