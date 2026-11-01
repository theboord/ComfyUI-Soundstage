"""The Presets window as a Director tool (Milestone 17).

web/presets/presets.json (plus the film styles in web/look/style_presets.json) is the one catalog. register() adds a
`preset` tool to the Director (soundstage/agent/director.py) so "make it a crane up at golden hour" plans
[preset crane_up, preset golden_hour]; the browser runs each through the Presets window (web/presets/runner.mjs),
one undo step each. Recipes that render ask before they use the GPU, like every other GPU call.

The Director module is patched in place (its TOOLS, ALIASES, the prompt text, rules_calls, validate_call and
plan_line), so it needs no edit of its own; install() / uninstall() are idempotent and tests restore it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
CATALOG = WEB / "presets" / "presets.json"
STYLES = WEB / "look" / "style_presets.json"

TAB_IDS = ["camera", "light", "look", "action", "edit", "recipe", "user"]
CAMERA_MOVES = ["push_in", "pull_out", "orbit", "crane_up", "crane_down", "dolly_zoom", "whip_pan", "follow",
                "drone_reveal", "tracking_side", "car_mount"]
TIME_KEYS = ["dawn", "golden_am", "midday", "overcast", "magic_hour", "blue_hour", "night", "keep"]
GRADE_KEYS = ["warmth", "contrast", "saturation", "grain", "halation", "vignette"]
RECIPE_STEPS = ["video_to_3d", "new_angle", "ripple_mode", "whole_frame", "quality_draft", "quality_hollywood",
                "render_all_draft", "render_final"]
# Native Director tools a preset of each tab stands in for (the preset does that and more, in one undo step).
SUBSUMES = {"camera": {"camera_move", "rig", "reframe"}, "light": {"time", "light", "grade"}, "look": {"grade"},
            "action": {"stunt"}, "edit": set(), "recipe": {"render", "frames"}}
ID_RE = re.compile(r"^[a-z0-9_]+$")


def load_catalog() -> dict:
    base = json.loads(CATALOG.read_text(encoding="utf-8"))
    try:
        styles = json.loads(STYLES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        styles = []
    looks = [{"id": s["id"], "tab": "look", "label": s.get("label", s["id"]), "group": s.get("group", "Style"),
              "summary": s.get("summary", ""), "words": [str(s.get("label", "")).lower().replace(" - ", " ")],
              "apply": {"look": s["id"]}} for s in styles if isinstance(s, dict) and s.get("id")]
    presets = list(base.get("presets", [])) + looks
    return {"version": base.get("version", 1), "tabs": base.get("tabs", []), "presets": presets,
            "by_id": {p["id"]: p for p in presets}}


def validate_catalog(cat: dict) -> list[str]:
    """Every problem with the catalog (empty = good). web/presets/engine.mjs validateCatalog checks the same."""
    errs, seen = [], set()
    tabs = {t.get("id") for t in cat.get("tabs", [])}
    errs += [f"missing tab {t}" for t in TAB_IDS if t not in tabs]
    for p in cat.get("presets", []):
        at = f"preset {p.get('id')}"
        if not ID_RE.match(str(p.get("id", ""))):
            errs.append(f"{at}: bad id")
        if p.get("id") in seen:
            errs.append(f"{at}: duplicate id")
        seen.add(p.get("id"))
        if p.get("tab") not in TAB_IDS:
            errs.append(f"{at}: bad tab")
        a = p.get("apply") or {}
        tab = p.get("tab")
        if tab == "camera" and (a.get("camera") or {}).get("move") not in CAMERA_MOVES:
            errs.append(f"{at}: camera move")
        if tab == "light":
            li = a.get("light") or {}
            if li.get("time") not in TIME_KEYS or not li.get("setup") or not li.get("words"):
                errs.append(f"{at}: light")
            errs += [f"{at}: grade {k}" for k in (li.get("grade") or {}) if k not in GRADE_KEYS]
        if tab == "recipe":
            steps = a.get("recipe") or []
            if not steps or any(s not in RECIPE_STEPS for s in steps):
                errs.append(f"{at}: recipe steps")
            if any(s.startswith("render_") for s in steps) != bool(a.get("gpu")):
                errs.append(f"{at}: gpu flag")
    return errs


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9:]+", " ", str(s).lower()).strip()


def presets_in_text(cat: dict, text: str) -> list[dict]:
    """Presets named in free text, in reading order ("make it a crane up at golden hour" -> crane_up, golden_hour).
    Mirrors presetsInText in web/presets/engine.mjs: a longer name wins where two overlap."""
    t = f" {_norm(text)} "
    hits = []
    for p in cat["presets"]:
        if p.get("tab") == "user":
            continue
        for n in [p.get("label", "")] + list(p.get("words") or []):
            n = _norm(n)
            if len(n) <= 2:
                continue
            i = t.find(f" {n} ")
            if i >= 0:
                hits.append((i, len(n), p))
                break
    hits.sort(key=lambda h: (h[0], -h[1]))
    out = []
    for i, n, p in hits:
        if not any(i < j + m + 1 and j < i + n + 1 for j, m, _ in out):
            out.append((i, n, p))
    return [p for _, _, p in out]


def is_gpu(p: dict) -> bool:
    return bool((p.get("apply") or {}).get("gpu"))


# ------------------------------------------------------------------------------------------- the Director tool

_ORIG: dict = {}
_CAT: dict | None = None


def _cat() -> dict:
    global _CAT
    if _CAT is None:
        _CAT = load_catalog()
    return _CAT


def install(director=None) -> bool:
    """Add the `preset` tool to the Director. Returns False when there's no Director in this build."""
    if director is None:
        try:
            from .agent import director  # noqa: PLC0415
        except Exception:  # noqa: BLE001 - the Director (Milestone 15) isn't in this build
            return False
    D = director
    if "preset" in D.TOOLS:
        return True
    cat = _cat()
    ids = [p["id"] for p in cat["presets"]]
    _ORIG.update({"module": D, "rules_calls": D.rules_calls, "validate_call": D.validate_call, "plan_line": D.plan_line,
                  "system": getattr(D, "DIRECTOR_SYSTEM", None), "aliases": dict(D.ALIASES)})
    D.TOOLS["preset"] = {"kind": "app", "doc": "A one-click preset from the Presets window: camera moves (crane_up, dolly_zoom...), "
                         "lighting (golden_hour, noir_hard_key...), film looks, stunts and physics, edit styles, recipes",
                         "args": {"preset": ("enum", True, ids), "shot": ("shot", False, None)}}
    D.ALIASES.update({"apply_preset": "preset", "presets": "preset", "use_preset": "preset"})

    def validate_call(raw, work, ctx, _v=_ORIG["validate_call"]):
        p = _preset_call(raw)
        if p is None:
            return _v(raw, work, ctx)
        # Resolved here: the Director's enum aliases would turn golden_hour into magic_hour.
        nm, rest = p
        pid = _resolve_id(nm)
        if pid is None:
            raise D.Invalid(f"preset: no preset called '{nm}'")
        pr = cat["by_id"][pid]
        out = {"preset": pid, "label": pr.get("label", pid), "tab": pr.get("tab")}
        shot = rest.get("shot") or rest.get("shot_id")
        if shot not in (None, ""):
            sid = D.resolve_shot(shot, work, ctx)
            if sid is None:
                raise D.Invalid(f"preset: no shot '{shot}'")
            out["shot"] = sid
        return {"tool": "preset", "args": out, "kind": "app", "gpu": is_gpu(pr)}

    def _preset_call(raw):
        """(name, other args) when raw is a preset call in any of the shapes a model writes, else None."""
        if not isinstance(raw, dict):
            return None
        tool = _key(raw.get("tool") or raw.get("name") or raw.get("op") or raw.get("action") or "")
        args = {}
        for k in ("args", "arguments", "parameters"):
            if isinstance(raw.get(k), dict):
                args.update(raw[k])
        args.update({k: v for k, v in raw.items() if k not in ("tool", "op", "action", "args", "arguments", "parameters")})
        if tool in cat["by_id"] and tool not in D.TOOLS and D.ALIASES.get(tool, tool) not in D.TOOLS:
            args.pop("name", None)
            return tool, args       # {"tool": "crane_up"}
        if D.ALIASES.get(tool, tool) != "preset":
            return None
        nm = args.pop("preset", None) or args.pop("id", None) or (args.pop("name", None) if raw.get("tool") else None)
        return (nm or "", args)

    def _key(v):
        return str(v).strip().lower().replace("-", "_").replace(" ", "_")

    def _resolve_id(nm):
        k = _key(nm)
        if k in cat["by_id"]:
            return k
        for p in cat["presets"]:
            if _key(p.get("label", "")) == k or k in (_key(w) for w in p.get("words") or []):
                return p["id"]
        return None

    def plan_line(call, work, ctx, _pl=_ORIG["plan_line"]):
        if call.get("tool") != "preset":
            return _pl(call, work, ctx)
        a = call["args"]
        p = cat["by_id"].get(a.get("preset"), {})
        where = {"camera": "this shot's camera", "light": "the set's lighting", "look": "the look", "action": "the set",
                 "edit": "the cut", "recipe": "the scene"}.get(p.get("tab"), "this shot")
        if a.get("shot"):
            where = D.shot_label(a["shot"], work, ctx) + ("'s camera" if p.get("tab") == "camera" else "")
        gpu = " (asks before it uses the GPU)" if is_gpu(p) else ""
        return f"I'll apply the '{p.get('label', a.get('preset'))}' preset to {where}{gpu}"

    def rules_calls(command, scene, ctx=None, _rc=_ORIG["rules_calls"]):
        calls = list(_rc(command, scene, ctx))
        named = presets_in_text(cat, command)
        if not named:
            return calls
        for p in named:
            drop = SUBSUMES.get(p.get("tab"), set())
            at = next((i for i, c in enumerate(calls) if (c.get("tool") or c.get("name")) in drop), None)
            calls = [c for c in calls if (c.get("tool") or c.get("name")) not in drop]
            call = {"tool": "preset", "preset": p["id"]}
            if at is None:
                calls.append(call)
            else:
                calls.insert(min(at, len(calls)), call)
        return calls

    D.validate_call = validate_call
    D.plan_line = plan_line
    D.rules_calls = rules_calls
    if hasattr(D, "SYSTEM_HEAD"):
        D.DIRECTOR_SYSTEM = D.SYSTEM_HEAD + "\n" + "\n".join(D._tool_line(n, t) for n, t in D.TOOLS.items()) + "\n" + D.SYSTEM_EXAMPLE
    return True


def uninstall() -> None:
    D = _ORIG.get("module")
    if D is None:
        return
    D.TOOLS.pop("preset", None)
    D.ALIASES.clear()
    D.ALIASES.update(_ORIG["aliases"])
    D.rules_calls, D.validate_call, D.plan_line = _ORIG["rules_calls"], _ORIG["validate_call"], _ORIG["plan_line"]
    if _ORIG.get("system") is not None:
        D.DIRECTOR_SYSTEM = _ORIG["system"]
    _ORIG.clear()


def register(routes=None) -> bool:  # noqa: ARG001 - same shape as the other feature modules
    """Called from the package __init__ (idempotent)."""
    return install()
