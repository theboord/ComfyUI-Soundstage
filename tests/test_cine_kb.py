"""The cinematic KB validates against its schema and covers what the advisor promises."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.cine.kb import KB_DIR, get_kb, load_entries  # noqa: E402
from soundstage.cine.schema import KB_ENTRY_SCHEMA, SHOT_LIST_SCHEMA, validate  # noqa: E402

ENTRIES, ERRORS = load_entries()


def test_kb_has_no_schema_errors():
    assert ERRORS == []


def test_kb_matches_jsonschema_reference_validator():
    jsonschema = pytest.importorskip("jsonschema")
    validator = jsonschema.Draft202012Validator(KB_ENTRY_SCHEMA)
    for path in sorted(KB_DIR.glob("*.json")):
        for entry in json.loads(path.read_text()):
            errs = [e.message for e in validator.iter_errors(entry)]
            assert errs == [], f"{path.name} {entry.get('id')}: {errs[:3]}"
    jsonschema.Draft202012Validator.check_schema(KB_ENTRY_SCHEMA)
    jsonschema.Draft202012Validator.check_schema(SHOT_LIST_SCHEMA)


def test_validator_catches_bad_entries():
    bad = dict(ENTRIES[0])
    bad["type"] = "opera"
    bad["recipes"] = [{"name": "x", "why": "too short", "shots": [{"purpose": "p", "size": "HUGE", "subject": "A"}]}]
    errs = validate(bad, KB_ENTRY_SCHEMA)
    assert any("type" in e for e in errs)
    assert any("size" in e for e in errs)
    assert any("why" in e for e in errs)


def test_kb_counts_meet_the_thursday_target():
    counts = {}
    for e in ENTRIES:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    assert counts.get("genre", 0) + counts.get("subgenre", 0) >= 8
    assert counts.get("movement", 0) + counts.get("national_cinema", 0) >= 6
    assert counts.get("director_technique", 0) + counts.get("dp_technique", 0) >= 10
    assert counts.get("emotion_recipe", 0) >= 8
    assert counts.get("coverage_pattern", 0) >= 5
    assert len(ENTRIES) >= 40


@pytest.mark.parametrize("eid", [
    "genre.romantic_comedy", "genre.sitcom_multicam", "movement.french_new_wave", "movement.korean_thriller",
    "technique.spaghetti_standoff", "emotion.tension", "emotion.intimacy", "emotion.isolation",
    "coverage.dialogue_triangle",
])
def test_required_entries_exist(eid):
    assert eid in get_kb().by_id


def test_every_recipe_explains_why_and_every_rule_has_a_reason():
    for e in ENTRIES:
        for r in e["recipes"]:
            assert len(r["why"]) >= 40, e["id"]
        for rule in e.get("rules", []):
            assert len(rule["why"]) >= 15, e["id"]


def test_techniques_are_named_by_technique_not_director():
    directors = ["leone", "hitchcock", "kubrick", "anderson", "spielberg", "ozu", "wong", "dardenne", "fincher", "woo"]
    for e in get_kb().of_types("director_technique", "dp_technique"):
        text = (e["name"] + " " + json.dumps(e["prompt_fragments"])).lower()
        assert not any(d in text for d in directors), e["id"]


def test_parents_resolve():
    kb = get_kb()
    for e in ENTRIES:
        if e.get("parent"):
            assert e["parent"] in kb.by_id, f"{e['id']} -> {e['parent']}"


def test_no_media_and_open_text_license():
    for e in ENTRIES:
        assert e["rights"]["contains_media"] is False
        assert e["rights"]["text_license"]
