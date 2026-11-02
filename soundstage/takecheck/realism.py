"""The realism judge: a "VFX supervisor" pass that asks the pod's vision LLM whether a take's main subjects could be
real things, photographed. Built after Mike's note on a Hollywood J-turn: "It doesn't even look like a real car...
this is AI slop." The CPU checks (detect.py) catch black, frozen and smeared frames; they cannot see that a car's
tail lights don't match, that its exhaust melts into the diffuser, or that a hand has fused fingers. This does.

    res = judge_video("output/soundstage/final_00028_.mp4", "http://127.0.0.1:8188")
    res["verdict"]  -> "pass" | "fail" | "unavailable"
    res["score"]    -> 0-10 (10 = could be a photograph)
    res["defects"]  -> [{"label": "rear lights incoherent, f24–64", "kind": "vehicle", "category": "lamps", ...}]

How it works (all through the ComfyUI queue, so it waits its turn behind renders and shares their model cache):
  1. sample SAMPLES frames across the take (ffmpeg, full resolution);
  2. locate: the VLM names the main subjects (vehicles, people, animals) with a box on each frame;
  3. judge: each subject is cropped from the full-res frame and judged with a kind-specific checklist
     (a car: matched lamp pairs, no extra lamps, crisp exhaust / diffuser / grille, round wheels in their arches,
     one coherent design; a person: one coherent face, five separate fingers, the right limbs);
  4. aggregate (pure Python, calibrated): a defect only counts when the judge reports it as major on the same part
     category in at least half the frames the subject is in (one-off complaints are the model's noise, a real
     construction error repeats), and fine anatomy (fingers, toes, face) only counts when the person is big enough
     on screen for it to be seen.

Calibration (share/Realism_Judge/REPORT.txt): the J-turn takes Mike rejected fail, the underwater and train takes pass.
Small VLMs follow the prompt's priming: a checklist that mentions exhaust pipes makes them find exhaust pipes on a
diver. So every subject kind has its own checklist, and the aggregation, not the model, decides pass or fail.

No ComfyUI imports at module level: tests run the pure parts (parsing, crops, aggregation, chips) on their own.
"""
from __future__ import annotations

import io
import json
import math
import re
import subprocess
import time
import urllib.request
import uuid

import numpy as np

from .video import _exe, probe

VERSION = 2
SAMPLES = 6
MODELS = ["qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors", "qwen3.5_4b_bf16.safetensors"]
SUBFOLDER = "soundstage_realism"
LOCATE_WIDTH = 1344        # the locate pass sees a downscaled frame; the judge sees full-res crops
CROP_MAX = 1024            # longest side of a judged crop
MIN_AREA = 0.015           # subjects smaller than 1.5 % of the frame are background (distant traffic, crowds)
MAX_SUBJECTS = 2           # judged per frame
FINE_MIN_HEIGHT = 0.45     # a person must fill this much of the frame height before fingers / face are judged
PASS_SCORE = 6.0
KINDS = ("vehicle", "person", "animal", "other")

LOCATE_SYSTEM = (
    "You find the main subjects of one film frame. Reply with JSON only:\n"
    '{"subjects":[{"label":"short description","kind":"vehicle|person|animal|other","bbox":[x0,y0,x1,y1],'
    '"visible":["face","hands","feet"]}]}\n'
    "bbox is on a 0-1000 grid over the whole image. List at most 3 subjects, the largest and most important first: "
    "vehicles, people (whole body, or the face and hands when that is all that shows), animals. "
    "Skip background traffic, crowds and scenery. For a person, \"visible\" lists which of face, hands and feet "
    "can be clearly seen in this frame (not hidden by clothes, gloves, fins, a mask, the frame edge or other things); "
    "an empty list when none can."
)
LOCATE_PROMPT = "Find the main subjects."

_CHECKS = {
    "vehicle": (
        "You are a harsh Hollywood VFX supervisor checking a vehicle in a frame of an AI-generated shot before it goes "
        "to a client. Judge whether it could be a real, manufactured car.\n"
        "Check part by part: are the tail lights / headlights a matched left-right pair with a sensible shape; are "
        "there extra or misplaced lamps; are the exhaust tips, diffuser, grille, bumpers, mirrors and badges crisp "
        "manufactured parts, or melted and merged blobs; are the wheels round with tyres, the right size for their "
        "arches; do the panels add up to one coherent design with plausible proportions.\n"
        "Seen at an angle, the near lamp looks bigger and the far one narrower or partly hidden: perspective is not "
        "a mismatch. A full-width light bar is a real design. Judge the shapes as they would be seen from behind."),
    "person": (
        "You are a harsh Hollywood VFX supervisor checking a person in a frame of an AI-generated shot before it goes "
        "to a client. Judge whether they could be a real human, photographed.\n"
        "Check: is the face one coherent face (eyes, nose, mouth in place, not smeared); are the hands real hands "
        "with five separate fingers, not fused (only judge a hand you can see well enough to count its fingers; if "
        "no hand is visible say nothing about hands); are there the right number of arms and legs, joined in the right "
        "places; do clothes and worn equipment attach to the body the way real ones do."),
    "animal": (
        "You are a harsh Hollywood VFX supervisor checking an animal in a frame of an AI-generated shot before it goes "
        "to a client. Judge whether it could be a real animal, photographed.\n"
        "Check: one head with eyes, ears and mouth in place; the right number of legs, each with a foot or hoof, "
        "joined in the right places; a tail where one belongs; tack, saddles and harness that attach the way real "
        "ones do; no parts merged with a rider, a fence or another animal."),
    "other": (
        "You are a harsh Hollywood VFX supervisor checking the main object in a frame of an AI-generated shot before "
        "it goes to a client. Judge whether it could be a real, made or natural thing.\n"
        "Check: one coherent design; parts that join the way real ones would; nothing melted, merged with its "
        "neighbour, duplicated or impossible."),
}
_COMMON = (
    "Judge ONLY parts you can actually see. A part that is out of frame, behind something, turned away, too small or "
    "too dark to make out is NOT a defect: skip it. Masks, goggles, helmets, hair, hats, gloves, smoke and spray hide "
    "things; that is normal.\n"
    "Do NOT report photographic qualities: blur, motion blur, grain, noise, darkness, rain, smoke, reflections, smooth "
    "skin, clean or new-looking surfaces, missing fine detail, lighting or colour.\n"
    "Only report a defect you can point to; if what is visible is well built, return an empty list. Most frames from "
    "a good take have no major defects.\n"
    "Reply with JSON only:\n"
    '{"subject":"...","defects":[{"part":"which part","problem":"short specific description","severity":"major|minor"}],"realism":0-10}\n'
    '"major" = clearly broken construction a viewer notices at normal viewing size. "minor" = only visible when '
    "hunting for it. realism: 10 = could be a photograph of a real one, 7 = convincing with small flaws, "
    "4 = obviously generated."
)


def judge_system(kind: str) -> str:
    return _CHECKS.get(kind, _CHECKS["other"]) + "\n" + _COMMON


def judge_prompt(kind: str) -> str:
    return f"Inspect this {kind if kind in KINDS[:3] else 'object'} closely and report its construction defects."


# ------------------------------------------------------------------------------------------------ pure parts

def sample_indices(n: int, k: int = SAMPLES) -> list[int]:
    """k frame numbers spread evenly over n frames (centres of k equal slices; never the very first or last frame,
    where the guide's first frame or a fade dominates)."""
    if n <= 0:
        return []
    k = max(1, min(k, n))
    return sorted({min(n - 1, int((i + 0.5) * n / k)) for i in range(k)})


def _json_obj(text: str):
    from ..video2stage.vlm import _json_obj as j   # the shared forgiving JSON reader
    return j(text)


def norm_kind(kind: str, label: str = "") -> str:
    s = f"{kind} {label}".lower()
    if re.search(r"\b(vehicle|car|truck|van|bus|suv|pickup|coupe|sedan|motorcycle|motorbike|taxi|jeep)\b", s):
        return "vehicle"
    if re.search(r"\b(person|man|woman|men|women|people|driver|rider|diver|boy|girl|child|actor|face|hand)\b", s):
        return "person"
    if re.search(r"\b(animal|horse|dog|cat|bird|cow|deer|pony)\b", s):
        return "animal"
    return "other"


def parse_locate(text: str) -> list[dict]:
    """The locate reply -> [{label, kind, bbox (0-1 floats)}], largest first, never raises on a bad reply."""
    try:
        obj = _json_obj(text)
    except ValueError:
        return []
    items = obj if isinstance(obj, list) else (obj.get("subjects") or obj.get("objects") or []) if isinstance(obj, dict) else []
    out = []
    for s in items:
        if not isinstance(s, dict):
            continue
        b = s.get("bbox") or s.get("box")
        try:
            x0, y0, x1, y1 = (float(v) for v in b[:4])
        except (TypeError, ValueError, IndexError):
            continue
        scale = 1.0 if max(x0, y0, x1, y1) <= 1.0001 else 1000.0
        x0, x1 = sorted((min(max(x0 / scale, 0.0), 1.0), min(max(x1 / scale, 0.0), 1.0)))
        y0, y1 = sorted((min(max(y0 / scale, 0.0), 1.0), min(max(y1 / scale, 0.0), 1.0)))
        if x1 - x0 < 0.01 or y1 - y0 < 0.01:
            continue
        label = str(s.get("label") or s.get("name") or "")[:80]
        vis = s.get("visible")
        vis = sorted({v for v in (str(x).lower().strip() for x in vis) if v in ("face", "hands", "feet")}) \
            if isinstance(vis, list) else None
        out.append({"label": label, "kind": norm_kind(str(s.get("kind") or ""), label), "bbox": [x0, y0, x1, y1],
                    "visible": vis})
    out.sort(key=lambda s: -(s["bbox"][2] - s["bbox"][0]) * (s["bbox"][3] - s["bbox"][1]))
    return out


def crop_box(bbox: list[float], W: int, H: int, margin: float = 0.12) -> tuple[int, int, int, int]:
    """A subject's box (0-1) grown by `margin` of its size on every side -> pixel box inside the frame."""
    x0, y0, x1, y1 = bbox
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    return (int(max(0.0, x0 - mx) * W), int(max(0.0, y0 - my) * H), int(math.ceil(min(1.0, x1 + mx) * W)),
            int(math.ceil(min(1.0, y1 + my) * H)))


SCENERY = re.compile(r"\b(reef|coral|tree|trees|forest|building|buildings|street|road|water|ocean|sea|sky|cloud|"
                     r"clouds|wall|floor|ground|grass|mountain|hill|rock|rocks|city|skyline|smoke|rain|sand|beach)\b")


def _inside(a: list[float], b: list[float]) -> float:
    """How much of box a lies inside box b (0-1)."""
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2] - a[0]) * (a[3] - a[1])
    return w * h / area if area > 0 else 0.0


def pick_subjects(subjects: list[dict], limit: int = MAX_SUBJECTS) -> list[dict]:
    """The subjects worth judging: big enough to be seen, not scenery, not a part of a bigger subject (the scuba
    tank on the diver), at most `limit`, largest first."""
    out = []
    for s in subjects:
        if (s["bbox"][2] - s["bbox"][0]) * (s["bbox"][3] - s["bbox"][1]) < MIN_AREA:
            continue
        if s["kind"] == "other" and SCENERY.search(s["label"].lower()):
            continue
        if any(_inside(s["bbox"], o["bbox"]) > 0.7 for o in out):
            continue
        out.append(s)
    return out[:limit]


def parse_judge(text: str) -> dict:
    """The judge reply -> {defects: [{part, problem, severity}], realism: float|None}. A reply that isn't JSON counts
    as no verdict (never as a pass or a fail)."""
    try:
        obj = _json_obj(text)
    except ValueError:
        return {"defects": [], "realism": None, "unreadable": True}
    if isinstance(obj, list):
        obj = {"defects": obj}
    if not isinstance(obj, dict):
        return {"defects": [], "realism": None, "unreadable": True}
    defects = []
    for d in obj.get("defects") or []:
        if isinstance(d, str):
            d = {"part": "", "problem": d, "severity": "major"}
        if not isinstance(d, dict):
            continue
        sev = "minor" if str(d.get("severity") or "").lower().startswith("min") else "major"
        part, prob = str(d.get("part") or "")[:60], str(d.get("problem") or d.get("description") or "")[:200]
        if part or prob:
            defects.append({"part": part, "problem": prob, "severity": sev})
    try:
        realism = float(obj.get("realism"))
        realism = min(max(realism, 0.0), 10.0)
    except (TypeError, ValueError):
        realism = None
    return {"defects": defects, "realism": realism}


# Part categories: the aggregation counts repeats per category, so "tail lights asymmetric" in one frame and "rear
# lamps mismatched" in the next are the same complaint. Order matters (first match wins).
_FINE_CATS = [
    ("hands", r"\b(hand|hands|finger|fingers|thumb|thumbs|knuckle|knuckles|palm|digits?)\b"),
    ("feet", r"\b(foot|feet|toe|toes|ankle|ankles)\b"),
    ("face", r"\b(face|eye|eyes|mouth|nose|teeth|lips|jaw|eyebrow|eyebrows)\b"),
]
_CATS = [
    ("lamps", r"\b(light|lights|lamp|lamps|taillight|taillights|headlight|headlights|led|drl|indicator|reverse light)\b"),
    ("rear_parts", r"\b(exhaust|exhausts|tailpipe|diffuser|muffler)\b"),
    ("wheels", r"\b(wheel|wheels|tyre|tyres|tire|tires|rim|rims|arch|arches|hubcap)\b"),
    ("parts", r"\b(bumper|grille|grill|mirror|mirrors|badge|logo|intake|spoiler|wing|plate|handle|wiper|splitter)\b"),
    ("limbs", r"\b(arm|arms|leg|legs|limb|limbs|knee|knees|elbow|elbows|hoof|hooves|paw|paws|tail)\b"),
    ("head", r"\b(head|heads|neck|ear|ears|mane)\b"),
    ("body", r"\b(body|panel|panels|door|doors|roof|hood|bonnet|boot|trunk|pillar|window|windows|proportion|proportions|design|shape|silhouette|torso)\b"),
    ("gear", r"\b(mask|regulator|tank|harness|saddle|helmet|strap|straps|hose|fin|fins|glove|gloves|suit|jacket|clothes|clothing|bag)\b"),
]
FINE = {"hands", "face", "feet"}  # small parts of a person: judged only when seen (locate pass) and big on screen
SMALL_LIMBS_SHARE = 2 / 3         # a small person's limbs need complaints in 2/3 of their frames, not half
NAMES = {
    "lamps": "lights incoherent", "rear_parts": "exhaust / diffuser melted", "wheels": "wheels or arches wrong",
    "parts": "melted or merged parts", "body": "design doesn't add up", "hands": "hands malformed",
    "face": "face distorted", "feet": "feet malformed", "limbs": "limbs wrong", "head": "head malformed", "gear": "gear fused to body",
    "other": "malformed",
}


def category(kind: str, part: str, problem: str) -> str:
    """The part category of one complaint. On a person or animal, fingers, toes and faces win wherever they are named
    ("right arm has only two fingers" is a hand complaint); otherwise the part's own words first, then the problem's."""
    if kind != "vehicle":
        t = f"{part} {problem}".lower()
        for name, rx in _FINE_CATS:
            if re.search(rx, t):
                return name
    for text in (part, f"{part} {problem}"):
        t = text.lower()
        for name, rx in _CATS:
            if re.search(rx, t):
                if kind == "vehicle" and name in ("limbs", "head", "gear"):
                    continue
                if kind != "vehicle" and name in ("lamps", "rear_parts", "wheels", "parts"):
                    continue
                return name
    return "other"


def _where(cat: str, parts: list[str]) -> str:
    """'rear lights incoherent' / 'front lights incoherent' from the parts the judge named."""
    if cat != "lamps":
        return NAMES.get(cat, cat)
    t = " ".join(parts).lower()
    rear = len(re.findall(r"\b(rear|tail|taillights?|back)\b", t))
    front = len(re.findall(r"\b(front|head|headlights?)\b", t))
    side = "rear " if rear and not front else "front " if front and not rear else ""
    return f"{side}lights incoherent"


def frame_span(frames: list[int]) -> str:
    fs = sorted(set(frames))
    if not fs:
        return ""
    return f"f{fs[0]}" if len(fs) == 1 else f"f{fs[0]}–{fs[-1]}"


def aggregate(observations: list[dict], n_frames: int | None = None) -> dict:
    """Per-crop verdicts -> the take's verdict.

    observations: [{"frame": int, "kind": str, "label": str, "height": 0-1 (subject box height / frame height),
                    "defects": [{part, problem, severity}], "realism": float|None}]
    A category is confirmed when the judge called it major in at least half (and at least 2) of the sampled frames
    that show a subject of that kind; fine anatomy only counts on a person at least FINE_MIN_HEIGHT tall."""
    by_kind: dict[str, dict] = {}
    for ob in observations:
        k = ob.get("kind") or "other"
        g = by_kind.setdefault(k, {"frames": set(), "cats": {}, "realism": [], "heights": []})
        g["frames"].add(ob["frame"])
        g["heights"].append(float(ob.get("height") or 0))
        if ob.get("realism") is not None:
            g["realism"].append(float(ob["realism"]))
        for d in ob.get("defects") or []:
            cat = category(k, d.get("part", ""), d.get("problem", ""))
            sev = d.get("severity", "major")
            if cat in FINE and k == "person":
                vis = ob.get("visible")
                if vis is not None and cat not in vis:
                    continue          # the judge complains about hands the locate pass couldn't see: invented
                if (ob.get("height") or 0) < FINE_MIN_HEIGHT:
                    sev = "minor"
            c = g["cats"].setdefault(cat, {"major": set(), "minor": set(), "parts": [], "problems": []})
            c[sev].add(ob["frame"])
            c["parts"].append(d.get("part", ""))
            c["problems"].append(d.get("problem", ""))
    defects, minor, unconfirmed = [], [], 0
    for k, g in by_kind.items():
        present = len(g["frames"])
        # One frame of a take never convicts it (a subject the locate pass saw once is usually a misread); a still
        # image (n_frames 1) is judged on its one frame.
        need = 1 if (n_frames or present) <= 1 else max(2, math.ceil(present / 2))
        small = k in ("person", "animal") and g["heights"] and max(g["heights"]) < FINE_MIN_HEIGHT
        for cat, c in g["cats"].items():
            major = sorted(c["major"])
            need_c = max(need, math.ceil(present * SMALL_LIMBS_SHARE)) if small and cat == "limbs" and present > 1 else need
            entry = {"kind": k, "category": cat, "frames": major or sorted(c["minor"]), "of": present,
                     "examples": [p for p in dict.fromkeys(x for x in c["problems"] if x)][:3]}
            name = _where(cat, c["parts"])
            if len(major) >= need_c:
                entry["label"] = f"{name}, {frame_span(major)}" if present > 1 else name
                entry["severity"] = "major"
                defects.append(entry)
            else:
                unconfirmed += len(major)
                entry["label"] = f"{name} (minor)"
                entry["severity"] = "minor"
                minor.append(entry)
    defects.sort(key=lambda e: (-len(e["frames"]), e["frames"][0] if e["frames"] else 0))
    rs = [r for g in by_kind.values() for r in g["realism"]]
    model_realism = round(sum(rs) / len(rs), 1) if rs else None
    score = 10.0 - 3.0 * len(defects) - min(2.0, 0.5 * unconfirmed)
    score = round(max(0.0, min(10.0, score)), 1)
    judged = bool(observations)
    verdict = "unavailable" if not judged else ("fail" if defects or score < PASS_SCORE else "pass")
    return {"verdict": verdict, "score": score if judged else None, "defects": defects, "minor": minor,
            "model_realism": model_realism, "subjects": {k: len(g["frames"]) for k, g in by_kind.items()},
            "frames_judged": n_frames}


def is_hollywood(info: dict | None, recipe: dict | None = None) -> bool:
    """A Hollywood-quality take: the recipe says so, or the picture is Hollywood-sized (1408p and up)."""
    q = ((recipe or {}).get("quality") or {})
    q = q.get("quality") or q.get("preset") if isinstance(q, dict) else q
    if isinstance(q, str) and q.lower().startswith("hollywood"):
        return True
    return int((info or {}).get("height") or 0) >= 1300


def chip(res: dict | None) -> dict | None:
    """The Ladder / Dailies chip of a realism verdict (the JS twin is realismChip in web/takecheck/model.mjs)."""
    if not res:
        return None
    if res.get("error") or res.get("verdict") == "unavailable":
        return {"tone": "info", "text": "Realism: not judged", "title": res.get("error") or res.get("why") or "no vision model"}
    lines = [f"VFX-supervisor score {res.get('score')}/10 ({res.get('model')}, {res.get('frames_judged')} frames)"]
    lines += [f"✗ {d['label']}" + (f": {d['examples'][0]}" if d.get("examples") else "") for d in res.get("defects") or []]
    lines += [f"· {d['label']}" for d in (res.get("minor") or [])[:4]]
    if res.get("verdict") == "pass":
        return {"tone": "ok", "text": f"✓ real {res.get('score')}/10", "title": "\n".join(lines)}
    first = (res.get("defects") or [{}])[0].get("label") or "looks generated"
    return {"tone": "bad", "text": f"✗ AI slop: {first}", "title": "\n".join(lines)}


# ------------------------------------------------------------------------------------------- frames and crops

def read_frames_at(path: str, indices: list[int], info: dict | None = None, max_width: int = 2624) -> np.ndarray:
    """The frames `indices` at full resolution (capped at max_width), [N,H,W,3] RGB uint8."""
    info = info or probe(path)
    w0, h0 = info["width"], info["height"]
    width = int(min(max_width, w0)) // 2 * 2
    height = max(2, int(round(h0 * width / w0 / 2)) * 2)
    sel = "+".join(f"eq(n\\,{int(i)})" for i in indices)
    vf = f"select='{sel}',scale={width}:{height}:flags=lanczos"
    for o in (["-fps_mode", "passthrough"], ["-vsync", "0"]):
        out = subprocess.run([_exe("ffmpeg"), "-v", "error", "-i", path, "-an", "-vf", vf, *o, "-f", "rawvideo",
                              "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=300)
        if out.returncode == 0 or out.stdout:
            break
    size = width * height * 3
    n = len(out.stdout) // size
    if n == 0:
        raise RuntimeError(f"ffmpeg could not read frames from {path}: {out.stderr.decode(errors='ignore')[:200]}")
    return np.frombuffer(out.stdout[: n * size], dtype=np.uint8).reshape(n, height, width, 3)


def _jpeg(arr: np.ndarray, max_side: int | None = None) -> bytes:
    from PIL import Image
    im = Image.fromarray(arr)
    if max_side and max(im.size) > max_side:
        s = max_side / max(im.size)
        im = im.resize((max(2, int(im.size[0] * s)), max(2, int(im.size[1] * s))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=94)
    return buf.getvalue()


# ------------------------------------------------------------------------------------------- the ComfyUI queue

class Queue:
    """The tiny slice of ComfyUI's HTTP API the judge needs (works from inside the server and from a laptop)."""

    def __init__(self, base_url: str, timeout_s: float = 2400.0):   # a Hollywood render ahead of it takes ~15 min
        self.base = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def _req(self, path, data=None, headers=None, timeout=60):
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def text_encoders(self) -> list[str]:
        info = self._req("/object_info/CLIPLoader")
        return list(info["CLIPLoader"]["input"]["required"]["clip_name"][0])

    def upload(self, name: str, data: bytes) -> str:
        bnd = uuid.uuid4().hex
        parts = [f'--{bnd}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode(),
                 data, f'\r\n--{bnd}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\n{SUBFOLDER}'.encode(),
                 f'\r\n--{bnd}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{bnd}--\r\n'.encode()]
        j = self._req("/upload/image", b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={bnd}"})
        return f"{j.get('subfolder') or SUBFOLDER}/{j['name']}"

    def run(self, graph: dict, outs: list[str]) -> list[str]:
        body = json.dumps({"prompt": graph, "client_id": f"soundstage-realism-{uuid.uuid4().hex[:8]}"}).encode()
        res = self._req("/prompt", body, {"Content-Type": "application/json"})
        pid = res.get("prompt_id")
        if not pid:
            raise RuntimeError(f"the queue refused the realism job: {res.get('error') or res}")
        t0 = time.time()
        while True:
            time.sleep(1.5)
            h = self._req(f"/history/{pid}")
            if pid in h:
                break
            if time.time() - t0 > self.timeout_s:
                # Never touches the queue: the job stays queued and its verdict is simply not read this time.
                raise TimeoutError(f"the realism judge waited {self.timeout_s:.0f} s behind other GPU jobs (job {pid} still queued)")
        e = h[pid]
        st = e.get("status", {})
        if st.get("status_str") != "success":
            msg = next((m[1].get("exception_message") for m in st.get("messages", []) if m[0] == "execution_error"), "")
            raise RuntimeError(f"the realism judge failed in the queue: {msg or st.get('status_str')}")
        return [(e.get("outputs", {}).get(o, {}).get("text") or [""])[0] for o in outs]


def graph(model: str, items: list[tuple[str, str, str]], max_length: int = 600) -> tuple[dict, list[str]]:
    """One queued prompt: one model load, one TextGenerate per (image, system, prompt). Returns (graph, output ids)."""
    g = {"m": {"class_type": "CLIPLoader", "inputs": {"clip_name": model, "type": "stable_diffusion", "device": "default"}}}
    systems: dict[str, str] = {}
    outs = []
    for i, (img, system, prompt) in enumerate(items):
        if system not in systems:
            sid = f"s{len(systems)}"
            systems[system] = sid
            g[sid] = {"class_type": "PrimitiveStringMultiline", "inputs": {"value": system}}
        g[f"l{i}"] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[f"t{i}"] = {"class_type": "TextGenerate", "inputs": {
            "clip": ["m", 0], "image": [f"l{i}", 0], "prompt": prompt, "max_length": max_length, "sampling_mode": "off",
            "thinking": False, "use_default_template": True, "system_prompt": [systems[system], 0]}}
        g[f"p{i}"] = {"class_type": "PreviewAny", "inputs": {"source": [f"t{i}", 0]}}
        outs.append(f"p{i}")
    return g, outs


def pick_model(available: list[str], wanted: str | None = None) -> str | None:
    if wanted:
        return wanted if wanted in available else None
    return next((m for m in MODELS if m in available), None)


def judge_video(path: str, base_url: str, samples: int = SAMPLES, model: str | None = None, keep: str | None = None,
                queue: Queue | None = None) -> dict:
    """Judge one take. keep: a folder to save the sampled frames and crops in (evidence for reports)."""
    t0 = time.time()
    q = queue or Queue(base_url)
    try:
        mdl = pick_model(q.text_encoders(), model)
    except Exception as exc:  # noqa: BLE001
        return {"version": VERSION, "verdict": "unavailable", "error": f"can't reach ComfyUI ({exc})"}
    if not mdl:
        return {"version": VERSION, "verdict": "unavailable",
                "error": f"no vision model for the realism judge (wants one of {', '.join(MODELS)} in models/text_encoders)"}
    info = probe(path)
    n = info["frames"] or 1
    idx = sample_indices(n, samples)
    frames = read_frames_at(path, idx, info)
    idx = idx[: frames.shape[0]]
    H, W = frames.shape[1], frames.shape[2]
    tag = uuid.uuid4().hex[:8]
    if keep:
        import os
        os.makedirs(keep, exist_ok=True)
    names = []
    for i, f in zip(idx, frames):
        data = _jpeg(f, LOCATE_WIDTH)
        names.append(q.upload(f"rj_{tag}_f{i}.jpg", data))
        if keep:
            open(f"{keep}/frame_f{i:03d}.jpg", "wb").write(_jpeg(f))
    g, outs = graph(mdl, [(nm, LOCATE_SYSTEM, LOCATE_PROMPT) for nm in names], max_length=300)
    located = [parse_locate(t) for t in q.run(g, outs)]
    jobs = []      # (frame index, subject, crop name)
    for i, f, subs in zip(idx, frames, located):
        for k, s in enumerate(pick_subjects(subs)):
            x0, y0, x1, y1 = crop_box(s["bbox"], W, H)
            crop = f[y0:y1, x0:x1]
            data = _jpeg(crop, CROP_MAX)
            jobs.append((i, s, q.upload(f"rj_{tag}_f{i}_{k}_{s['kind']}.jpg", data)))
            if keep:
                open(f"{keep}/crop_f{i:03d}_{k}_{s['kind']}.jpg", "wb").write(data)
    observations, raw = [], []
    if jobs:
        g, outs = graph(mdl, [(nm, judge_system(s["kind"]), judge_prompt(s["kind"])) for _, s, nm in jobs])
        for (i, s, nm), text in zip(jobs, q.run(g, outs)):
            v = parse_judge(text)
            raw.append({"frame": i, "kind": s["kind"], "label": s["label"], "visible": s.get("visible"), "reply": text[:1500]})
            if v.get("unreadable"):
                continue
            observations.append({"frame": i, "kind": s["kind"], "label": s["label"], "height": s["bbox"][3] - s["bbox"][1],
                                 "visible": s.get("visible"), "defects": v["defects"], "realism": v["realism"]})
    res = aggregate(observations, len(idx))
    if not jobs:
        res.update({"verdict": "unavailable", "why": "the judge found no main subject to inspect"})
    res.update({"version": VERSION, "model": mdl, "frames": idx, "fps": info["fps"],
                "hollywood": is_hollywood(info, None), "elapsed_s": round(time.time() - t0, 1), "raw": raw})
    res["chip"] = chip(res)
    if keep:
        res["observations"] = observations
        with open(f"{keep}/verdict.json", "w") as fh:
            json.dump(res, fh, indent=1, ensure_ascii=False)
    return res


def main(argv: list[str] | None = None) -> int:
    """python -m soundstage.takecheck.realism take.mp4 [more.mp4] --url http://127.0.0.1:8188 [--keep DIR]"""
    import argparse
    import os
    ap = argparse.ArgumentParser(description="Judge whether a take's subjects could be real (Soundstage realism judge).")
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--url", default=os.environ.get("SOUNDSTAGE_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--samples", type=int, default=SAMPLES)
    ap.add_argument("--model", default=None)
    ap.add_argument("--keep", default=None, help="save frames, crops and verdict.json under DIR/<video name>/")
    a = ap.parse_args(argv)
    bad = 0
    for v in a.videos:
        stem = os.path.splitext(os.path.basename(v))[0]
        keep = os.path.join(a.keep, f"{os.path.basename(os.path.dirname(os.path.abspath(v)))}__{stem}") if a.keep else None
        r = judge_video(v, a.url, a.samples, a.model, keep)
        c = r.get("chip") or {}
        print(f"{os.path.basename(v)}: {r.get('verdict')} score {r.get('score')} {c.get('text', '')}")
        for d in r.get("defects") or []:
            print(f"   ✗ {d['label']}  ({'; '.join(d.get('examples') or [])[:160]})")
        bad += r.get("verdict") == "fail"
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
