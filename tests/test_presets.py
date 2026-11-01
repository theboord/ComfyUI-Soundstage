"""Milestone 17: the Presets catalog and the Director's `preset` tool (soundstage/presets_agent.py)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from soundstage import presets_agent as P
from soundstage.agent import director as D

ROOT = Path(__file__).resolve().parent.parent
DEMO = json.loads((ROOT / "tests" / "agent_fixtures" / "director_demo.json").read_text())


@pytest.fixture()
def tool():
    """The tool installed for one test, and the Director put back exactly as it was afterwards."""
    tools0, aliases0, system0 = set(D.TOOLS), dict(D.ALIASES), D.DIRECTOR_SYSTEM
    assert P.install() is True
    yield D
    P.uninstall()
    assert set(D.TOOLS) == tools0 and D.ALIASES == aliases0 and D.DIRECTOR_SYSTEM == system0


def test_catalog_is_valid_and_complete():
    cat = P.load_catalog()
    assert P.validate_catalog(cat) == []
    tabs = [t["id"] for t in cat["tabs"]]
    assert tabs == P.TAB_IDS
    by = {t: [p["id"] for p in cat["presets"] if p["tab"] == t] for t in tabs}
    assert len(by["camera"]) >= 10 and len(by["light"]) == 8 and len(by["action"]) == 8
    assert len(by["edit"]) == 4 and len(by["recipe"]) == 4
    styles = json.loads((ROOT / "web" / "look" / "style_presets.json").read_text())
    assert len(by["look"]) == len(styles)
    setups = {s["id"] for s in json.loads((ROOT / "web" / "look" / "lighting_setups.json").read_text())["setups"]}
    for p in cat["presets"]:
        if p["tab"] == "light":
            assert p["apply"]["light"]["setup"] in setups, p["id"]
    gpu = {p["id"] for p in cat["presets"] if P.is_gpu(p)}
    assert gpu == {"draft_all_shots", "hollywood_final"}


def test_validator_catches_mistakes():
    cat = P.load_catalog()
    bad = {"tabs": cat["tabs"][:3], "presets": cat["presets"][:2] + [dict(cat["presets"][0])] + [
        {"id": "x", "tab": "recipe", "label": "x", "apply": {"recipe": ["render_final"]}},
        {"id": "y", "tab": "light", "label": "y", "apply": {"light": {"time": "noon", "setup": "a", "words": "w", "grade": {"glow": 1}}}}]}
    errs = P.validate_catalog(bad)
    assert any("missing tab" in e for e in errs)
    assert any("duplicate" in e for e in errs)
    assert any("gpu flag" in e for e in errs)
    assert any("grade glow" in e for e in errs)


def test_presets_in_text_matches_the_browser():
    cat = P.load_catalog()
    ids = lambda t: [p["id"] for p in P.presets_in_text(cat, t)]  # noqa: E731
    assert ids("make it a crane up at golden hour") == ["crane_up", "golden_hour"]
    assert ids("film noir look with a dolly zoom") == ["film_noir", "dolly_zoom"]
    assert ids("give the car a J-turn") == ["reverse_jturn"]
    assert ids("cut it like a trailer") == ["trailer_cut"]
    assert ids("put mara in the car") == []


def test_crane_up_at_golden_hour(tool):
    plan = D.plan("make it a crane up at golden hour", DEMO, {})
    assert [(c["tool"], c["args"]["preset"]) for c in plan["calls"]] == [("preset", "crane_up"), ("preset", "golden_hour")]
    assert plan["rejected"] == [] and plan["confirm"] is False
    assert plan["plan"][0] == "I'll apply the 'Crane up' preset to this shot's camera"


def test_shot_and_gpu(tool):
    plan = D.plan("make shot 2 a dolly zoom", DEMO, {})
    assert [c["tool"] for c in plan["calls"]] == ["select_shot", "preset"]
    plan = D.plan("hollywood final", DEMO, {})
    assert plan["calls"][0]["gpu"] is True and plan["confirm"] is True
    assert "asks before it uses the GPU" in plan["plan"][0]
    plan = D.plan("draft all shots, go", DEMO, {})
    assert plan["confirm"] is False, "'go' already confirms, like every GPU call"


def test_model_shapes(tool):
    """What a small model writes: the preset as the tool, as `name`, by label; a shot number."""
    r = D.run_calls([{"tool": "crane_up"}, {"tool": "preset", "name": "golden_hour"}, {"tool": "preset", "args": {"preset": "Golden hour", "shot": 2}},
                     {"tool": "apply_preset", "preset": "noir"}, {"tool": "preset", "preset": "nope"}], DEMO, {})
    got = [(c["args"]["preset"], c["args"].get("shot")) for c in r["calls"]]
    assert got == [("crane_up", None), ("golden_hour", None), ("golden_hour", "tracking"), ("noir_hard_key", None)]
    assert len(r["rejected"]) == 1 and "nope" in r["rejected"][0]["why"]
    calls = D.parse_llm('{"calls":[{"tool":"preset","preset":"neon_night"}]}')
    assert D.run_calls(calls, DEMO, {})["calls"][0]["args"]["preset"] == "neon_night"


def test_prompt_and_specs(tool):
    assert '"tool":"preset"' in D.DIRECTOR_SYSTEM and "golden_hour" in D.DIRECTOR_SYSTEM
    spec = next(s for s in D.tool_specs() if s["name"] == "preset")
    assert "crane_up" in spec["args"]["preset"]["enum"] and spec["kind"] == "app"


def test_native_tools_unchanged_without_presets(tool):
    plan = D.plan("put mara in the car", DEMO, {})
    assert [c["tool"] for c in plan["calls"]] == ["mount"]


def test_install_is_idempotent_and_register_works(tool):
    assert P.install() is True
    assert list(D.TOOLS).count("preset") == 1
    assert P.register() is True
