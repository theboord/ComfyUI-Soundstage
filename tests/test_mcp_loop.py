"""MCP soundstage_loop (tools/soundstage_mcp.py track_b) against a fake server: the fixer keeps the sealed loop
whenever the repeated last frame was dropped, also when the render already reads Seamless (docs/loop.md: the App
plays and saves the loop without that frame)."""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("soundstage_mcp_t", ROOT / "tools" / "soundstage_mcp.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

RAW = "soundstage_private/loop/loop_00001_.mp4 [output]"
SEALED = "soundstage_private/loop/loop_00001__sealed.mp4 [output]"
OK = {"verdict": "seamless", "seam": 1.2, "badge": "Seamless · 1.2x"}
VIS = {"verdict": "visible", "seam": 8.3, "badge": "Visible seam · 8.3x"}


def _fake(monkeypatch, seam, fix):
    calls = []

    def http(method, path, body=None, timeout=150):
        calls.append((path, dict(body or {})))
        if path == "/soundstage/loop/prompt":
            return {"prompt": {"save": {}}}
        if path == "/prompt":
            return {"prompt_id": "p1"}
        if path == "/soundstage/loop/seam":
            return seam
        if path == "/soundstage/loop/fix":
            return fix[body["how"]](body)
        raise AssertionError(path)

    monkeypatch.setattr(M, "http", http)
    monkeypatch.setattr(M, "_wait_prompt", lambda pid, timeout=3600: {"filename": "loop_00001_.mp4",
                                                                       "subfolder": "soundstage_private/loop", "type": "output"})
    return calls


def test_a_seamless_render_with_a_repeated_last_frame_is_sealed(monkeypatch):
    # re-encoding nudges the number up a hair: the sealed file is kept anyway
    calls = _fake(monkeypatch, {**OK, "dup_last": True},
                  {"seal": lambda b: {"ref": SEALED, "before": OK, "after": {**OK, "seam": 1.3, "badge": "Seamless · 1.3x"}}})
    text, err = M.track_b("soundstage_loop", {"source": "soundstage/look_00001_.png [output]", "confirm_gpu": True})
    assert not err, text
    assert text.splitlines()[0] == f"Loop: {SEALED}"
    assert "seal: Seamless · 1.2x -> Seamless · 1.3x (kept)" in text
    assert not any(b.get("how") in ("trim", "bridge") for _, b in calls)


def test_nothing_to_drop_keeps_the_render_and_trims_it(monkeypatch):
    calls = _fake(monkeypatch, VIS, {
        "seal": lambda b: {"ref": b["ref"], "before": VIS, "after": VIS},
        "trim": lambda b: {"ref": "soundstage_private/loop/t.mp4 [output]", "before": VIS, "after": OK}})
    text, err = M.track_b("soundstage_loop", {"source": "x.png [output]", "fix": False, "confirm_gpu": True})
    assert not err, text
    assert "seal: Visible seam · 8.3x -> Visible seam · 8.3x (no better)" in text
    assert [b["ref"] for _, b in calls if b.get("how") == "trim"] == [RAW]
    assert text.splitlines()[0] == "Loop: soundstage_private/loop/t.mp4 [output]"
