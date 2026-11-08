"""Lifelike-only L2, the words grep test (research plan §3a): nothing the user sees says "clay".

Scope for now: the lanes switched in L2 (tools/clay_words.py SCOPE: web/pipeline, motion, coach, advisor, book, canvas,
stage, ladder, ui, soundstage.js, soundstage/*.py user text, docs/ except history). Pending, reported but not failed:
web/cut + soundstage/cut + docs/cut.md (the rung rename, one commit with the Cut), web/agent, soundstage/agent,
soundstage/memory, docs/assistant, skills (the Ask lane), and the L20 media/demo surfaces (web/tryit, web/script,
web/performance, web/passes, web/oneclick, README). Allowed: lines carrying clay-alias / clay-prompt / clay-pending.
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("clay_words", ROOT / "tools" / "clay_words.py")
cw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cw)


def test_no_user_visible_clay_in_switched_lanes():
    hits = cw.scan()
    assert not hits, "user-visible 'clay' left (rename it, or mark an alias with clay-alias):\n" + "\n".join(
        f"{r}:{n}: {s}" for r, n, s in hits[:40])


def test_pending_lanes_are_listed_not_scanned():
    for lane in ("web/cut/", "soundstage/cut/", "docs/cut.md", "web/agent/", "soundstage/agent/", "soundstage/memory/",
                 "docs/assistant/", "skills/"):
        assert lane in cw.PENDING
    assert "docs/decisions.md" in cw.HISTORY and "CHANGELOG.md" in cw.HISTORY


def test_scanner_catches_prose_and_labels_not_identifiers(tmp_path):
    js = 'const a = "clay"; const b = "stage_clay_1.jpg"; const c = { class: "ss-clclay" };\n' \
         '// a comment about clay\nconst d = "Follow the clay"; const e = { textContent: "Clay" };\n'
    found = [s for _, s in cw._js_strings(js) if cw._is_user_text(s)]
    assert found == ["Follow the clay", "Clay"]
    py = 'def f():\n    """the clay docstring"""\n    return "the clay pass"\nX = "clay"\n'
    found = [s for _, s in cw._py_strings(py) if cw._is_user_text(s)]
    assert found == ['"the clay pass"']


def test_pending_lanes_still_say_clay():
    """The label table (handed to the other lanes) is still needed: their words have not switched yet."""
    pend = [h for h in cw.scan(include_pending=True) if h[0].startswith(cw.PENDING)]
    assert pend, "the pending lanes no longer say clay: fold them into SCOPE and drop them from PENDING"
