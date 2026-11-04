"""LTX-2.5 render settings for ⑤ Motion: the Draft · Final · Advanced presets and the "Advanced (LTX)" overrides.

Pure Python (no ComfyUI imports). The single source of truth for the presets is web/motion/ltx_presets.json, which
the App's pop-over (web/motion/ltxadvanced.mjs) reads too, so both sides always agree.

A settings dict (every key optional; missing keys come from the preset):
  preset           "Draft" | "Final" | "Advanced" (Advanced starts from Final's values; every knob is the user's).
                   The retired "Hollywood" loads as Advanced pre-filled with its old values (legacy_presets).
  from             the preset an Advanced shot started from ("Draft" | "Final"), for the App's "Reset to …" button
  resolution       output shorter side in px (1088 = 1080p class; stage 1 renders at half when two_stage)
  two_stage        True: half-res stage 1 -> learned latent x2 upscaler -> distilled refine (same seed). False: one pass
  steps_1/steps_2  sampling steps (stage 1 / stage-2 refine), on the distilled sigma curve
  s2_start         stage-2 start sigma (0.909375 = more re-drawing, 0.85 = Lightricks' LTX-2.5 two-stage default)
  sigmas_1/_2      manual schedules ("1.0, 0.99, ..., 0.0"); override the steps (and the scheduler) when set
  scheduler        "distilled" (Lightricks' tuned knots, the default) | "linear" (even steps, what LTXVScheduler
                   starts from) | "linear_quadratic" (LTX's own paper schedule: linear, then quadratic near 0)
  shift            sigma shift on the schedule, the same curve as ModelSamplingLTXV / LTXVScheduler's shift:
                   s' = shift*s / (1 + (shift-1)*s). 1 = as tuned; above 1 spends more steps at high noise
                   (composition), below 1 more on detail. Stage 2 keeps its start sigma and shifts the steps below it.
  sampler, cfg, seed
  adherence        "Loose" | "Balanced" | "Exact" (default Exact): how tightly the render follows the clay blocking.
                   Sets the four raw knobs below unless they are given explicitly (see adherence_knobs).
  ic_lora          layout-to-render IC-LoRA model strength (None = from Adherence)
  guide_blur       px of Gaussian blur on the clay guide at 960 wide (None = from Adherence; 0 = sharp)
  reference        strength of your chosen frame as the look reference (the frame_idx -1 IC-LoRA guide, both stages;
                   None = from Adherence). 1 lets the frame's composition win over the clay at the start of the shot.
  fps              render frame rate (None = the shot's); the clay is retimed to it
  temporal_x2      LTX-2.5 temporal upscaler on the final latent: twice the frames (48 fps from 24)
  decode           {"tile_size", "overlap", "temporal_size", "temporal_overlap"} for the tiled VAE decode
  codec            "h264" | "h264_10bit" | "prores_hq" (ProRes 422 HQ master + an H.264 preview)
  crf              H.264 quality (lower = better, 0 = lossless)
  extra_lora       {"name": "...", "strength": 0.8} (None = off)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

PRESETS_FILE = Path(__file__).resolve().parents[1] / "web" / "motion" / "ltx_presets.json"
PRESET_NAMES = ("Draft", "Final", "Advanced")
SAMPLERS = ("euler_ancestral", "euler", "res_multistep", "dpmpp_2m", "lcm")
SCHEDULERS = ("distilled", "linear", "linear_quadratic")
MIN_STEPS_1 = 1     # below 8 the distilled curve is thinned (sigmas_1); linear / linear_quadratic take any count
CODECS = ("h264", "h264_10bit", "prores_hq")

# The distilled LTX-2.5 schedule (Lightricks): 4 near-1.0 "composition" steps, then the detail-forming tail.
DISTILLED_1 = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0]
DISTILLED_TAIL = [0.909375, 0.725, 0.421875, 0.0]


def load_presets(path: Path = PRESETS_FILE) -> dict:
    data = json.loads(Path(path).read_text())
    return data["presets"]


def legacy_presets(path: Path = PRESETS_FILE) -> dict:
    """Retired presets ({"Hollywood": {...}}): a shot saved on one resolves to Advanced pre-filled with its values."""
    return {k: v for k, v in json.loads(Path(path).read_text()).get("legacy", {}).items() if isinstance(v, dict)}


def load_adherence(path: Path = PRESETS_FILE) -> dict:
    """{"default": "Exact", "levels": {"Loose": {...}, "Balanced": {...}, "Exact": {...}}}"""
    return json.loads(Path(path).read_text())["adherence"]


ADHERENCE_NAMES = ("Loose", "Balanced", "Exact")


def adherence_knobs(s: dict, table: dict | None = None) -> dict:
    """The raw knobs of a resolved settings dict: its Adherence level's values, each overridden by an explicit
    ic_lora / guide_blur / reference. {"adherence", "motion_freedom", "ic_lora", "guide_blur", "reference"}."""
    table = table or load_adherence()
    name = s.get("adherence") if s.get("adherence") in table["levels"] else table["default"]
    lv = table["levels"][name]
    out = {"adherence": name, "motion_freedom": float(lv["motion_freedom"]), "ic_lora": float(lv["ic_lora"]),
           "guide_blur": int(lv["guide_blur"]), "reference": float(lv["reference"])}
    if s.get("ic_lora") is not None:
        out["ic_lora"] = float(min(2.0, max(0.0, float(s["ic_lora"]))))
    if s.get("guide_blur") is not None:
        out["guide_blur"] = int(min(32, max(0, round(float(s["guide_blur"])))))
    if s.get("reference") is not None:
        out["reference"] = float(min(1.0, max(0.0, float(s["reference"]))))
    return out


def reference_guides(prompt: dict) -> list[str]:
    """The App's look-reference guides in an API prompt: LTXAddVideoICLoRAGuide nodes at frame_idx -1 (your chosen
    frame, outside the clip's time range) as opposed to the clay guide at frame_idx 0."""
    return [k for k, n in (prompt or {}).items() if isinstance(n, dict) and n.get("class_type") == "LTXAddVideoICLoRAGuide"
            and (n.get("inputs") or {}).get("frame_idx") == -1]


def apply_reference(prompt: dict) -> dict:
    """On-prompt: set the look-reference strength of a Soundstage Layout-to-Render prompt from the Quality node's
    settings (Adherence, or an explicit reference). Linked strengths and non-Soundstage prompts are left alone.
    Edits the prompt in place and returns it."""
    q = next((n.get("inputs") or {} for n in (prompt or {}).values()
              if isinstance(n, dict) and n.get("class_type") == "SoundstageQuality"), None)
    if q is None:
        return prompt
    quality, adv = q.get("quality"), q.get("advanced", "")
    if isinstance(quality, list) or isinstance(adv, list):
        return prompt                       # driven by links: nothing literal to read
    ref = adherence_knobs(from_quality(quality or "Final", adv))["reference"]
    for k in reference_guides(prompt):
        inp = prompt[k]["inputs"]
        if not isinstance(inp.get("strength"), list):
            inp["strength"] = ref
    return prompt


def _fmt(xs) -> str:
    return ", ".join(f"{x:.7g}" for x in xs)


def _densify(knots, n_steps):
    """Split each gap of a descending knot list so the whole curve has n_steps steps, more splits where the gaps are
    widest (the detail-forming tail). Every original knot is kept, so the result is the same curve, only denser."""
    gaps = len(knots) - 1
    n = max(gaps, int(n_steps))
    widths = [knots[i] - knots[i + 1] for i in range(gaps)]
    splits = [1] * gaps
    for _ in range(n - gaps):           # give each extra step to the gap whose sub-steps are currently widest
        i = max(range(gaps), key=lambda j: widths[j] / splits[j])
        splits[i] += 1
    out = [knots[0]]
    for i in range(gaps):
        a, b = knots[i], knots[i + 1]
        for k in range(1, splits[i] + 1):
            out.append(a + (b - a) * k / splits[i])
    out[-1] = 0.0
    return out


def _known():
    from . import quality as Q   # the App's long-standing Draft / Final / Final HQ schedules, kept bit-for-bit
    return ({8: Q.DRAFT_SIGMAS_1, 12: Q.FINAL_SIGMAS_1, 18: Q.HQ_SIGMAS_1},
            {3: Q.DRAFT_SIGMAS_2, 6: Q.FINAL_SIGMAS_2, 12: Q.HQ_SIGMAS_2})


def _thin(knots, n_steps):
    """Fewer steps than the curve has gaps: keep both ends and the n-1 knots spread evenly along the list."""
    n = max(1, int(n_steps))
    idx = sorted({round(i * (len(knots) - 1) / n) for i in range(n + 1)})
    return [knots[i] for i in idx]


def sigmas_1(steps: int) -> str:
    """Stage-1 (or single-pass) schedule with `steps` steps on the distilled curve: the four near-1.0 head steps stay
    as Lightricks tuned them, the tail is split by width. 8 / 12 / 18 -> the App's Draft / Final / Final HQ schedules
    exactly. Below 8 the curve's nine knots are thinned (1.0 and 0.0 always kept): untested on the GPU, a draft knob."""
    steps = max(MIN_STEPS_1, int(steps))
    if steps in _known()[0]:
        return _known()[0][steps]
    if steps < 8:
        return _fmt(_thin(DISTILLED_1, steps))
    head = DISTILLED_1[:5]
    tail = _densify(DISTILLED_1[4:], steps - 4)
    return _fmt(head[:-1] + tail)


def _even(start: float, steps: int) -> list[float]:
    n = max(1, int(steps))
    return [start * (1 - i / n) for i in range(n)] + [0.0]


def linear_quadratic(steps: int, threshold_noise: float = 0.025, linear_steps: int | None = None) -> list[float]:
    """LTX's own schedule (Lightricks' linear_quadratic_schedule, also in ComfyUI's samplers): the first half of the
    steps are linear in sigma near 1.0, the rest quadratic so the small sigmas get the finer steps. steps + 1 values,
    1.0 down to 0.0."""
    n = max(1, int(steps))
    if n == 1:
        return [1.0, 0.0]
    ls = n // 2 if linear_steps is None else max(1, min(n - 1, int(linear_steps)))
    lin = [i * threshold_noise / ls for i in range(ls)]
    diff = ls - threshold_noise * n
    qs = n - ls
    qc = diff / (ls * qs ** 2)
    lc = threshold_noise / ls - 2 * diff / (qs ** 2)
    const = qc * ls ** 2
    quad = [qc * i * i + lc * i + const for i in range(ls, n)]
    out = [1.0 - x for x in lin + quad + [1.0]]
    out[0], out[-1] = 1.0, 0.0
    return out


def shift_sigmas(sigmas: list[float], shift: float, top: float | None = None) -> list[float]:
    """ModelSamplingLTXV / LTXVScheduler's time shift on a descending schedule: s' = shift*s / (1 + (shift-1)*s).
    `top` (a stage-2 start below 1.0) keeps that start where it is and shifts the steps below it in proportion."""
    shift = float(shift)
    if abs(shift - 1.0) < 1e-9 or not sigmas:
        return list(sigmas)
    top = float(top or sigmas[0] or 1.0)
    out = []
    for s in sigmas:
        u = s / top if top else s
        u = shift * u / (1.0 + (shift - 1.0) * u)
        out.append(u * top)
    out[-1] = 0.0
    return out


def sigmas_2(steps: int, start: float = 0.909375) -> str:
    """Stage-2 refine schedule from `start` to 0 along the distilled tail. 3 steps at 0.909375 -> today's App."""
    start = float(start)
    if abs(start - 0.909375) < 1e-6 and int(steps) in _known()[1]:
        return _known()[1][int(steps)]
    knots = [start] + [k for k in DISTILLED_TAIL if k < start - 1e-6]
    return _fmt(_densify(knots, max(len(knots) - 1, int(steps))))


def resolve(settings: dict | str | None, presets: dict | None = None) -> dict:
    """Preset + overrides -> a complete, clamped settings dict."""
    if isinstance(settings, str):
        try:
            settings = json.loads(settings) if settings.strip() else {}
        except ValueError:
            settings = {}
    s = dict(settings or {})
    presets = presets or load_presets()
    legacy = legacy_presets() if s.get("preset") not in presets else {}
    if s.get("preset") in legacy:        # a shot saved on the retired Hollywood preset: Advanced with its values
        out = dict(presets.get("Advanced") or presets["Final"])
        out.update(legacy[s["preset"]])
        name = "Advanced"
    else:
        name = s.get("preset") if s.get("preset") in presets else "Final"
        out = dict(presets[name])
    out["preset"] = name
    for k, v in s.items():
        if k != "preset" and v is not None and v != "":
            out[k] = v
    out["resolution"] = int(min(2176, max(256, int(out.get("resolution", 1088)))))
    out["two_stage"] = bool(out.get("two_stage", True))
    out["steps_1"] = int(min(60, max(MIN_STEPS_1, int(out.get("steps_1", 8)))))
    out["steps_2"] = int(min(40, max(1, int(out.get("steps_2", 3)))))
    out["s2_start"] = float(min(1.0, max(0.3, float(out.get("s2_start", 0.909375)))))
    out["cfg"] = float(min(10.0, max(1.0, float(out.get("cfg", 1.0)))))
    out["sampler"] = out.get("sampler") if out.get("sampler") in SAMPLERS else "euler_ancestral"
    out["scheduler"] = out.get("scheduler") if out.get("scheduler") in SCHEDULERS else "distilled"
    out["shift"] = float(min(10.0, max(0.1, float(out.get("shift") or 1.0))))
    if name == "Advanced" and out.get("from") not in ("Draft", "Final"):
        out["from"] = "Final"
    out["codec"] = out.get("codec") if out.get("codec") in CODECS else "h264"
    out["crf"] = int(min(51, max(0, int(out.get("crf", 14)))))
    out["temporal_x2"] = bool(out.get("temporal_x2", False))
    if out.get("ic_lora") is not None:
        out["ic_lora"] = float(min(2.0, max(0.0, float(out["ic_lora"]))))
    if out.get("adherence") not in ADHERENCE_NAMES:
        out["adherence"] = load_adherence()["default"]
    if out.get("guide_blur") is not None:
        out["guide_blur"] = int(min(32, max(0, round(float(out["guide_blur"])))))
    if out.get("reference") is not None:
        out["reference"] = float(min(1.0, max(0.0, float(out["reference"]))))
    if out.get("fps") is not None:
        out["fps"] = float(min(60.0, max(8.0, float(out["fps"]))))
    return out


# The Quality node's combo (saved workflows keep their value): what each one means as a preset.
LEGACY = {"Draft": {"preset": "Draft"}, "Final": {"preset": "Final"}, "Advanced": {"preset": "Advanced"},
          "Hollywood": {"preset": "Hollywood"},                            # retired: resolve() maps it to Advanced
          "Final HQ": {"preset": "Final", "steps_1": 18, "steps_2": 12}}   # the old tier: Final with 18 + 12 steps


def from_quality(quality: str, advanced: str | dict | None = None, presets: dict | None = None) -> dict:
    """The resolved settings for the Quality node: the App's per-shot Advanced JSON when it names a preset,
    otherwise the quality combo (an older saved shot keeps rendering as it did)."""
    adv = advanced
    if isinstance(adv, str):
        try:
            adv = json.loads(adv) if adv.strip() else {}
        except ValueError:
            adv = {}
    if not isinstance(adv, dict):
        adv = {}
    base = {} if adv.get("preset") in PRESET_NAMES or adv.get("preset") in legacy_presets() else dict(LEGACY.get(quality, LEGACY["Draft"]))
    base.update(adv)
    return resolve(base, presets)


def stage_sizes(width: int, height: int, s: dict) -> dict:
    """Output and stage-1 sizes for a clay guide of width x height. LTX needs multiples of 32 per stage."""
    short_out = s["resolution"]
    k = short_out / max(1, min(width, height))
    snap = lambda v: max(64, int(v) // 32 * 32)  # noqa: E731
    if s["two_stage"]:
        w1, h1 = snap(width * k / 2), snap(height * k / 2)
        return {"stage1": (w1, h1), "output": (w1 * 2, h1 * 2)}
    w1, h1 = snap(width * k), snap(height * k)
    return {"stage1": (w1, h1), "output": (w1, h1)}


def schedules(s: dict) -> tuple[str, str]:
    """The two sigma strings the graph's ManualSigmas nodes get: the scheduler's curve for the step counts, then the
    shift. Manual sigmas override both. Draft / Final (distilled, shift 1) are the App's tuned strings bit for bit."""
    sched = s.get("scheduler") if s.get("scheduler") in SCHEDULERS else "distilled"
    shift = float(s.get("shift") or 1.0)
    start = float(s.get("s2_start", 0.909375))
    if sched == "distilled":
        s1, s2 = sigmas_1(s["steps_1"]), sigmas_2(s["steps_2"], start)
        if abs(shift - 1.0) > 1e-9:
            s1 = _fmt(shift_sigmas([float(x) for x in s1.split(",")], shift))
            s2 = _fmt(shift_sigmas([float(x) for x in s2.split(",")], shift, top=start))
    else:
        curve = linear_quadratic if sched == "linear_quadratic" else (lambda n: _even(1.0, n))
        s1 = _fmt(shift_sigmas(curve(s["steps_1"]), shift))
        s2 = _fmt(shift_sigmas([x * start for x in curve(s["steps_2"])], shift, top=start))
    if s.get("sigmas_1"):
        s1 = s["sigmas_1"]
    if s.get("sigmas_2"):
        s2 = s["sigmas_2"]
    return s1, s2


# Measured on the RTX 6000 Ada (48 GB), int8 distilled LTX-2.5 (share/Milestone18_Hollywood/REPORT.txt):
# seconds per step = a*T + b*T^2 with T = latent tokens in millions (attention makes it super-linear), about 70 s to
# stage the 22B model before each sampler, decode + save about 0.28 s per million output pixels.
CALIB = {"a": 364.0, "b": 15600.0, "init": 70.0, "fixed": 60.0, "decode_per_mpx": 0.28}


def estimate_seconds(s: dict, width: int, height: int, frames: int, calib: dict | None = None) -> float:
    c = calib or CALIB
    sz = stage_sizes(width, height, s)
    lat_f = (frames - 1) // 8 + 1
    g = 2 if s["cfg"] > 1 else 1

    def step(wh):
        t = (wh[0] // 32) * (wh[1] // 32) * lat_f / 1e6
        return (c["a"] * t + c["b"] * t * t) * g

    t = c["fixed"] + c["init"] + s["steps_1"] * step(sz["stage1"])
    if s["two_stage"]:
        t += c["init"] + s["steps_2"] * step(sz["output"])
    t += sz["output"][0] * sz["output"][1] * frames / 1e6 * (2 if s["temporal_x2"] else 1) * c["decode_per_mpx"]
    return round(t)
