"""Quality controls for the LTX-2.5 Layout-to-Render engine: how literally to follow the clay previz, and how
hard to work. Pure Python; nodes_quality.py wraps it, tools/app_build/quality.py wires it into the App.

Motion freedom (0..1)
  0    the clay guide is followed exactly (today's App, bit-for-bit).
  >0   the clay guide video is softened (a spatial blur), so LTX keeps the composition, the camera path and the
       blocking (low frequencies) but redraws the limbs, gait and secondary motion (high frequencies) instead of
       copying the stiff previz rig. The IC-LoRA guide strength stays 1.0 (below 1 LTX renders the clay itself).

Quality
  draft   today's sampling: distilled 8 + 3 steps, the Look's motion prompt unchanged.
  hq      denser distilled schedules (18 + 12 steps on the same sigma curve: every gap of the draft curve halved
          twice in the detail-forming tail) and a subject-aware physical-motion
          paragraph appended to the motion prompt. The full (non-distilled) LTX-2.5 model would allow CFG/STG
          (Lightricks: CFG 3, STG block 28, rescale 0.7), but only the distilled transformer is installed.
"""
from __future__ import annotations

import math

DRAFT_SIGMAS_1 = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
DRAFT_SIGMAS_2 = "0.909375, 0.725, 0.421875, 0.0"
# Same curve, midpoints added where the distilled schedule takes its big jumps (the detail-forming tail).
HQ_SIGMAS_1 = ("1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.9421875, 0.909375, 0.8632813, 0.8171875, 0.7710938, 0.725, 0.6492188, "
               "0.5734375, 0.4976563, 0.421875, 0.3164063, 0.2109375, 0.1054688, 0.0")
HQ_SIGMAS_2 = ("0.909375, 0.8632813, 0.8171875, 0.7710938, 0.725, 0.6492188, 0.5734375, 0.4976563, 0.421875, 0.3164063, "
               "0.2109375, 0.1054688, 0.0")


def knobs(freedom: float = 0.0, hq: bool = False) -> dict:
    """Live-tested 2026-10-28 on the horse scene: the IC-LoRA guide strength MUST stay 1.0. Below 1 the guide tokens
    are blended into the generation and LTX renders the grey clay itself (f=0.4 at strength 0.8/0.72 came out as clay).
    Freedom therefore softens the guide content (spatial blur: composition and camera stay, limb detail goes) and
    lowers the IC-LoRA model strength a little (the previz animation is followed less literally)."""
    f = min(max(float(freedom), 0.0), 1.0)
    blur = 0 if f < 0.05 else int(round(3 + 13 * f))
    return {
        "guide_strength_1": 1.0,
        "guide_strength_2": 1.0,
        "guide_blur": blur,                              # px at 960x544 (0 = the guide passes through untouched)
        # IC-LoRA model strength: loosens how literally LTX copies the previz animation (0.75 turned the clay
        # rig's stiff run into a natural walk in the horse test, still photoreal, same camera).
        "lora_strength": round(1.0 - 0.35 * f, 3),
        "sigmas_1": HQ_SIGMAS_1 if hq else DRAFT_SIGMAS_1,
        "sigmas_2": HQ_SIGMAS_2 if hq else DRAFT_SIGMAS_2,
        "sampler": "euler_ancestral",
    }


# ---------------------------------------------------------------------------------------------- motion prompt

def _speed(actor: dict, fps: float) -> float:
    keys = actor.get("keys") or []
    if len(keys) < 2:
        return 0.0
    dist = sum(math.dist(a["position"][::2], b["position"][::2]) for a, b in zip(keys, keys[1:]))
    frames = max(1, keys[-1]["frame"] - keys[0]["frame"])
    return dist / (frames / fps)


GAITS = {  # kind -> [(min m/s, phrase)]
    "horse": [(5.5, "the {n} gallops with a true four-beat gait, legs reaching and folding, neck and head pumping with "
                    "each stride, mane and tail streaming, hooves throwing up dirt"),
              (2.5, "the {n} trots with a springy two-beat diagonal gait, head bobbing lightly"),
              (0.3, "the {n} walks with a relaxed four-beat gait, head nodding with each step"),
              (0.0, "the {n} stands at rest, shifting weight, ears and tail moving")],
    "dog": [(3.0, "the {n} bounds along, back flexing, ears flapping"), (0.3, "the {n} trots, tail wagging"),
            (0.0, "the {n} sits alert, breathing, ears twitching")],
    "cat": [(2.0, "the {n} sprints low to the ground"), (0.3, "the {n} pads along with a smooth gait"),
            (0.0, "the {n} sits still, tail flicking")],
    "person": [(4.0, "the {n} runs with real weight, pushing off the ground, arms pumping, torso leaning in"),
               (1.8, "the {n} jogs with a natural rhythm"),
               (0.3, "the {n} walks with natural weight transfer from heel to toe, arms swinging in opposition, "
                     "a slight bob in the stride"),
               (0.0, "the {n} stands naturally, breathing, small weight shifts and gestures")],
    "car": [(0.3, "the {n} drives with its body settling on the suspension, wheels turning"), (0.0, "the {n} is parked")],
    "truck": [(0.3, "the {n} rolls heavily, suspension working"), (0.0, "the {n} is parked")],
    "police_car": [(0.3, "the {n} speeds with its light bar flashing, body settling on the suspension, wheels turning"),
                   (0.0, "the {n} is parked, light bar flashing")],
    "sports_car": [(0.3, "the {n} accelerates low and fast, wheels turning"), (0.0, "the {n} is parked")],
    "hatchback": [(0.3, "the {n} drives with its body settling on the suspension, wheels turning"), (0.0, "the {n} is parked")],
    "bicycle": [(0.3, "the {n} rolls with the rider pedalling and balancing"), (0.0, "")],
    "motorcycle": [(0.3, "the {n} leans and accelerates"), (0.0, "")],
}
# Riding a horse depends on the horse's pace: a still rider on a galloping horse is the giveaway of fake footage.
HORSE_RIDES = [
    (5.5, "the {r} rides the {h} hard: up out of the saddle in a forward crouch over the neck, knees and ankles "
          "absorbing every stride, hips pumping with the gallop, hands following the horse's head, elbows working, "
          "shoulders and head rocking, hair and clothes whipping in the wind"),
    (2.5, "the {r} rides the {h} at a trot: rising and sitting in rhythm with the two-beat stride, torso bouncing, "
          "heels down, hands steady on the reins, jacket flapping"),
    (0.3, "the {r} rides the {h} at a walk: hips swaying loosely with each step, shoulders relaxed, a light hold on the reins"),
    (0.0, "the {r} sits the {h}, shifting in the saddle, the horse shifting its weight underneath"),
]
RIDES = {"horse": "the {r} rides the {h}: hips following the saddle, torso rising and falling with the stride, "
                  "reins in hand, balanced and loose",
         "bicycle": "the {r} pedals the {h}, knees pumping, shoulders steady",
         "motorcycle": "the {r} grips the {h}, crouched, leaning into the motion",
         "car": "the {r} is at the wheel of the {h}", "truck": "the {r} drives the {h}",
         "police_car": "the {r} is at the wheel of the {h}", "sports_car": "the {r} is at the wheel of the {h}",
         "hatchback": "the {r} is at the wheel of the {h}"}
PEOPLE = {"man", "woman", "child"}


def motion_prompt(scene: dict, max_len: int = 900) -> str:
    """Physical-motion language for what is actually in the scene (kinds, speeds, who rides what). Identical subjects
    are grouped ("each horse gallops…", "both riders…") so the prompt stays short."""
    actors = scene.get("actors") or []
    fps = float((scene.get("shot") or {}).get("fps", 24))
    by_id = {a.get("id"): a for a in actors}
    groups: dict[tuple, int] = {}          # (kind, phrase template) -> count, in first-seen order
    ride_groups: dict[str, int] = {}       # host kind -> riders
    ride_speed: dict[str, float] = {}      # host kind -> fastest host of that kind
    for a in actors:
        k = a.get("kind")
        h = by_id.get(a.get("mount_id"))
        if h is not None:
            if h.get("kind") in RIDES:
                ride_groups[h["kind"]] = ride_groups.get(h["kind"], 0) + 1
                ride_speed[h["kind"]] = max(ride_speed.get(h["kind"], 0.0), _speed(h, fps))
            continue
        table = GAITS.get("person" if k in PEOPLE else k)
        if not table:
            continue
        v = _speed(a, fps)
        phrase = next((p for lo, p in table if v >= lo), "")
        if phrase:
            key = ("person" if k in PEOPLE else k, phrase)
            groups[key] = groups.get(key, 0) + 1
    parts = []
    for (kind, phrase), n in groups.items():
        noun = {"person": "person"}.get(kind, kind).replace("_", " ")
        subj = noun if n == 1 else f"each {noun}"
        parts.append(phrase.format(n=subj).replace("the each", "each"))
    for host, n in ride_groups.items():
        rider = "rider" if n == 1 else ("both riders" if n == 2 else "every rider")
        tmpl = next((p for lo, p in HORSE_RIDES if ride_speed.get(host, 0) >= lo), RIDES[host]) if host == "horse" else RIDES[host]
        hn = host.replace("_", " ")
        parts.append(tmpl.format(r=rider, h=hn if n == 1 else f"{hn}s").replace(f"the {hn}s", f"their {hn}s").replace("the both", "both").replace("the every", "every")
                     .replace(" rides ", " ride " if n > 1 else " rides ").replace(" pedals ", " pedal " if n > 1 else " pedals ")
                     .replace(" grips ", " grip " if n > 1 else " grips ").replace(" drives ", " drive " if n > 1 else " drives "))
    moving = any(_speed(a, fps) > 0.3 for a in actors if not a.get("mount_id"))
    if moving:
        parts.append("motion has real mass and momentum, with follow-through and secondary motion; no sliding feet, "
                     "no floating, solid contact with the ground")
    if not parts:
        return ""
    text = "Physical motion: " + "; ".join(parts) + "."
    return text if len(text) <= max_len else text[:max_len].rsplit(";", 1)[0] + "."
