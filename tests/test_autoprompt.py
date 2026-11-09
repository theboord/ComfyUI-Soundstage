"""④ Frame's Auto prompt (soundstage/look/autoprompt.py) with recorded vision-model replies: no Ollama, no GPU."""
import copy
import io
import json

from PIL import Image

from soundstage.look import autoprompt as A
from soundstage.look.compile import BANNED_WORDS, compile_look
from soundstage.look.default_scene import DEFAULT_SCENE


def _scene(shot="shot_1"):
    s = copy.deepcopy(DEFAULT_SCENE)
    s["shot_id"] = shot
    s["actors"][0]["name"] = "Sam"      # a person's name the image model must never see
    s["actors"][1]["name"] = "Maya"
    return s


def _png(color=(120, 120, 120), size=(320, 180)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


LOOK = {"description": "A quiet plaza at dusk. Sam and Maya wait by the building, then walk away.",
        "film_stock": "kodak_250d"}

GOOD = json.dumps({
    "seen": "two mannequins in a plaza by a building",
    "setting": "a stone plaza with worn paving slabs, a pale plaster building facade with a doorway, two concrete planters, soft dusk light",
    "people": [{"id": "actor_b", "looks": "a woman in her thirties, dark hair tied back, slim build"},
               {"id": "actor_a", "looks": "forties, short grey hair, stocky build, wearing a navy coat"}],
    "changed": "left out the walk away: it happens after frame 1"})


def _ids(facts):
    return [p["id"] for p in facts["people"]]


def test_auto_writes_klein_instruction_with_each_person_once():
    be = A.CannedBackend(GOOD)
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [(_png((200, 0, 0)), "Maya")], backend=be, force=True)
    assert r["source"] == "auto", r
    p = r["prompt"]
    assert p.startswith("Turn image 1, a plain 3D stage render, into a real photograph of the same shot")
    assert "stone plaza" in p and "slim build" in p and "short grey hair" in p
    assert "Exactly two people" in p
    # the LLM's own noun ("a woman in her thirties") went: the people phrase already says "the woman"
    assert p.count("woman") == 1 and "Maya" not in p and "Sam" not in p
    assert "navy coat" not in p          # clothes come from the stage, never the LLM
    assert not A.banned_in(p)
    # the LLM saw the frame and the one cast picture
    assert be.calls[0]["images"] == 2 and "image 2" in be.calls[0]["prompt"]


def test_auto_krea_keeps_camera_block_and_stage_placement():
    r = A.auto_prompt(LOOK, _scene(), "still", _png(), [], backend=A.CannedBackend(GOOD), force=True)
    assert r["source"] == "auto"
    p = r["prompt"]
    assert p.startswith("photograph shot on") and "exactly two people" in p and "stone plaza" in p
    assert "exactly two people in frame" in p


def test_validator_drops_people_placement_later_and_banned_words():
    bad = json.dumps({"seen": "x", "setting": "8k masterpiece, a plaza, a woman stands on the left, then rain begins to "
                                              "fall, the doorway on the left, highly detailed paving",
                      "people": [{"id": "actor_a", "looks": "standing in the foreground, grey beard"},
                                 {"id": "actor_b", "looks": "Maya, red hair"}], "changed": ""})
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [], backend=A.CannedBackend(bad), force=True)
    assert r["source"] == "auto"
    p = r["prompt"]
    for w in ("8k", "masterpiece", "highly detailed", "foreground", "Maya", "begins", "stands on the left"):
        assert w.lower() not in p.lower(), w
    assert "grey beard" in p and "red hair" in p
    assert any("people are said once" in n for n in r["notes"])
    facts = A.stage_facts(LOOK, _scene())
    door = next(x for x in facts["props"] if "doorway" in x["word"] or "facade" in x["word"])
    assert door["side"] != "left" or "doorway on the left" in p


def test_falls_back_to_compiled_when_missing_slow_or_garbage():
    compiled = compile_look(LOOK, _scene())["edit_prompt"]
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [], backend=None)
    assert r["source"] == "compiled" and r["prompt"] == compiled

    class Slow(A.Backend):
        name, model = "slow", "x"

        def generate(self, *a):
            raise TimeoutError("waited 150 s")
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [], backend=Slow(), force=True)
    assert r["source"] == "compiled" and "TimeoutError" in r["notes"][0]
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [], backend=A.CannedBackend("I cannot help with that"), force=True)
    assert r["source"] == "compiled"
    empty = json.dumps({"seen": "", "setting": "a man on the left", "people": [], "changed": ""})
    r = A.auto_prompt(LOOK, _scene(), "edit", _png(), [], backend=A.CannedBackend(empty), force=True)
    assert r["source"] == "compiled" and r["problems"]


def test_cache_per_shot_and_frame():
    be = A.CannedBackend(GOOD)
    a = A.auto_prompt(LOOK, _scene("s_cache"), "edit", _png((1, 2, 3)), [], backend=be)
    b = A.auto_prompt(LOOK, _scene("s_cache"), "edit", _png((1, 2, 3)), [], backend=be)
    assert not a["cached"] and b["cached"] and len(be.calls) == 1
    A.auto_prompt(LOOK, _scene("s_cache"), "edit", _png((9, 9, 9)), [], backend=be)    # another frame
    A.auto_prompt(LOOK, _scene("s_cache2"), "edit", _png((1, 2, 3)), [], backend=be)   # another shot
    A.auto_prompt(LOOK, _scene("s_cache"), "still", _png((1, 2, 3)), [], backend=be)   # another target
    assert len(be.calls) == 4


def test_override_manual_auto_and_stale():
    scene = _scene("s1")
    base = compile_look(LOOK, scene)
    manual = {**LOOK, "frame_prompts": {"s1": {"source": "manual", "text": "my own words, 8k", "target": "edit"}}}
    r = compile_look(manual, scene)
    assert r["edit_prompt"] == "my own words, 8k"          # Manual is never changed
    assert r["still_prompt"] == base["still_prompt"]      # only the output the frame model reads
    assert compile_look(manual, _scene("s2"))["edit_prompt"] == base["edit_prompt"]   # another shot
    sig = A.facts_sig(A.stage_facts(LOOK, scene), "still")
    auto = {**LOOK, "frame_prompts": {"s1": {"source": "auto", "text": "auto words", "target": "still", "sig": sig}}}
    assert compile_look(auto, scene)["still_prompt"] == "auto words"
    moved = copy.deepcopy(scene)
    moved["actors"].pop(0)                                # a person left the stage: the auto text is stale
    r = compile_look(auto, moved)
    assert r["still_prompt"] != "auto words" and any("earlier stage" in n for n in r["notes"])
    # the stage node adds the measured layout at queue time: that alone never makes it stale
    with_layout = {**scene, "frame1_layout": {"people": []}}
    assert compile_look(auto, with_layout)["still_prompt"] == "auto words"
    comp = {**LOOK, "frame_prompts": {"s1": {"source": "compiled"}}}
    assert compile_look(comp, scene)["edit_prompt"] == base["edit_prompt"]


def test_check_prompt_flags_manual_problems_without_changing_them():
    facts = A.stage_facts(LOOK, _scene())
    probs = A.check_prompt("Maya stands there, exactly one woman, masterpiece", facts)
    assert any("quality tag" in p for p in probs) and any("name" in p for p in probs) and any("says one" in p for p in probs)


def test_target_for_and_banned_superset():
    assert A.target_for("FLUX 3 Klein · local") == "edit" and A.target_for("FLUX.2 Klein 9B · local") == "edit"
    assert A.target_for("__krea_depth__") == "still"
    assert all(A.banned_in(w) for w in BANNED_WORDS)


def test_brief_lists_facts_and_no_wardrobe_example_leak():
    facts = A.stage_facts(LOOK, _scene())
    up = A.user_prompt(facts, ["Maya"], "edit")
    assert "id actor_a" in up and "id actor_b" in up and "edit model" in up
    assert "walk away" not in up                          # the director's notes reach it frame-1 safe
    assert "Rules." in A.SYSTEM and "8k" in A.SYSTEM


def test_composite_is_one_jpeg():
    out = A.composite(_png(), [_png((255, 0, 0), (100, 200)), _png((0, 255, 0), (100, 200))])
    im = Image.open(io.BytesIO(out))
    assert im.format == "JPEG" and im.width > im.height
