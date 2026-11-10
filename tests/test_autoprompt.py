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


def test_face_words_go_for_someone_seen_from_behind():
    facts = A.stage_facts(LOOK, _scene())
    away = [p for p in facts["people"] if p["facing"] == "away"]
    assert away, "the default scene's people are seen from behind"
    t, notes = A.clean_looks("thirties, dark hair in a ponytail, serious expression, soft features", away[0], [])
    assert t == "thirties, dark hair in a ponytail" and len(notes) == 2
    t, _ = A.clean_looks("thirties, serious expression", {**away[0], "facing": "toward"}, [])
    assert "expression" in t


# ---- v2: Auto keeps the stage's facts, in four variants (2026-11-09) -------------------------------------------------
# The live test on the demo chase (scene 2, "Tracking, front 3/4"): the v1 Auto prompt lost "in a city street", the
# deserted street, both cars' paint and body words, and said "empty ground in the foreground"; Krea 2 painted an open
# lot with grass and a grey classic car.

def _at(f, p):
    return {"frame": f, "position": p}


def _chase():
    """web/tryit/scenes.mjs policeChase(), on its "Tracking, front 3/4" shot (the camera rides along with the sports car)."""
    lamp = lambda x, z, i: {"id": f"sodium_{i}", "type": "practical", "name": f"Street lamp {i + 1}", "position": [x, 4.3, z],  # noqa: E731
                            "target": [x, 0, z], "kelvin": 2100, "intensity": 2.2, "softness": 1, "angle": 180}
    track = {"id": "tracking", "name": "Tracking, front 3/4", "setup": "single_a", "camera_follow": "sports_car",
             "camera_keys": [{"frame": 0, "position": [2.8, 1.05, 4.6], "target": [0, 0.7, 0], "focal_mm": 30}]}
    return {
        "version": 2, "shot_id": "tracking", "active_shot": "tracking", "shot": {"frames": 121, "fps": 24},
        "environment": {"set": "street_night", "weather": "none", "density": 0.5, "water_level": 2.5},
        "lighting": {"mode": "time", "hour": 21.5, "day_of_year": 300, "latitude": 34.05, "north_deg": 0, "overcast": False,
                     "preset": "night", "lights": [lamp(-5.4, -22, 0), lamp(5.4, -11, 1), lamp(-5.4, 0, 2), lamp(5.4, 11, 3),
                                                   lamp(-5.4, 22, 4)]},
        "sun": {"azimuth_deg": 250, "elevation_deg": -18},
        "actors": [
            {"id": "getaway", "name": "Getaway driver", "kind": "man", "height_m": 1.8, "keys": [_at(0, [1.6, 0, -24])],
             "mount_id": "sports_car", "seat": 0, "pose": "sit", "position": [1.6, 0, -24]},
            {"id": "cop", "name": "Officer", "kind": "woman", "height_m": 1.72, "keys": [_at(0, [1.6, 0, -36])],
             "mount_id": "police_car", "seat": 0, "pose": "sit", "position": [1.6, 0, -36]},
            {"id": "sports_car", "name": "Sports car", "kind": "sports_car", "height_m": 1.2, "appearance": {"color": "#c23b2a"},
             "keys": [_at(0, [1.6, 0, -24]), _at(40, [-1.4, 0, -5]), _at(80, [1.6, 0, 15]), _at(120, [0, 0, 35])],
             "position": [1.6, 0, -24]},
            {"id": "police_car", "name": "Police car", "kind": "police_car", "height_m": 1.6,
             "keys": [_at(0, [1.6, 0, -36]), _at(40, [1.0, 0, -16]), _at(80, [-1.0, 0, 4]), _at(120, [0.8, 0, 24])],
             "position": [1.6, 0, -36]}],
        "props": [], "shots": [track], "camera_keys": track["camera_keys"],
    }


CHASE_LOOK = {"film_stock": "kodak_250d"}
# what a 4B vision model said about the chase's clay frame, more or less: a lot, grass, a grey car, daylight, rain
CHASE_REPLY = json.dumps({
    "seen": "a red car and a second car on a road at night",
    "people": [],
    "variants": {
        "natural": {"light": "warm sodium lamp glow on the asphalt", "mood": "quiet tension",
                    "texture": "an open lot with grass, a grey classic car, empty ground in the foreground"},
        "cinematic": {"light": "bright daylight sun", "mood": "brooding", "texture": "wet asphalt sheen, rain puddles"},
        "documentary": "plain available light, a woman watching from the sidewalk",
        "contrast": {"light": "hard pools of sodium light", "mood": "tense", "texture": "crisp reflections on the paint"}},
    "changed": ""})
# the v1 Auto prompt from the live test, in short
V1_AUTO = ("photograph shot on an ARRI Alexa 35 with a 30mm Cooke S4 prime lens at T2, an open lot with grass, empty ground "
           "in the foreground, a grey classic car, wide shot, a sports car in the centre of frame, a police car right of frame, "
           "no people in frame, exactly two vehicles, no other cars, night, cool moonlight, warm tungsten practical")


def _chase_auto(target="still", reply=CHASE_REPLY, **kw):
    return A.auto_prompt(CHASE_LOOK, _chase(), target, _png(), [], backend=A.CannedBackend(reply), force=True, **kw)


def test_chase_auto_keeps_every_stage_fact_in_every_variant():
    r = _chase_auto()
    assert r["source"] == "auto", r["problems"]
    assert [v["key"] for v in r["variants"]] == ["natural", "cinematic", "documentary", "contrast"]
    for v in r["variants"]:
        p = v["prompt"]
        for fact in ("in a city street", "a deserted street with empty sidewalks", "crimson", "fastback",
                     "the police car black and white with a light bar on its roof", "light bar", "two vehicles", "night"):
            assert fact in p, (v["key"], fact)
        for wrong in ("open lot", "grass", "grey classic car", "empty ground", "daylight sun", "wet asphalt", "puddles", "woman"):
            assert wrong not in p, (v["key"], wrong)
        # the hero car fills half the frame: sized by its width, close to the camera (carpush, 2026-11-09: "seen whole
        # in the middle distance, the empty road in the foreground" made Krea 2 paint it small down the street)
        assert "close to the camera" in p and "middle distance" not in p, (v["key"], p)
    assert r["prompt"] == r["variants"][0]["prompt"] and r["variant"] == "natural"
    assert "warm sodium lamp glow on the asphalt" in r["prompt"]
    notes = " ".join(r["variants"][0]["notes"])
    assert "open lot" in notes and "vehicles and animals come from the stage" in notes


def test_chase_edit_auto_keeps_the_cars_and_the_street():
    r = _chase_auto("edit")
    assert r["source"] == "auto"
    for v in r["variants"]:
        p = v["prompt"]
        assert p.startswith("Turn image 1")
        for fact in ("deserted street", "crimson", "fastback", "black and white", "light bar", "two vehicles"):
            assert fact in p, (v["key"], fact)


def test_validator_finds_the_lost_facts_and_puts_them_back():
    scene = _chase()
    compiled = A.compiled_prompt(CHASE_LOOK, scene, "still")
    req = A.required_facts(CHASE_LOOK, scene, compiled)
    for fact in ("in a city street", "the sports car painted crimson", "two vehicles in frame"):
        assert fact in req
    assert any("fastback" in x for x in req) and any("light bar" in x for x in req)
    missing, extra = A.validate(V1_AUTO, compiled, req)
    assert "in a city street" in missing and any("crimson" in m for m in missing) and any("fastback" in m for m in missing)
    fixed = A.reinsert(V1_AUTO, missing, "still")
    assert A.validate(fixed, compiled, req) == ([], [])
    # one person named twice is a problem (two appeared when one was named twice)
    _, extra = A.validate(compiled + ", a woman, a woman", compiled, req)
    assert extra and "woman" in extra[0]


def test_clean_add_keeps_only_light_mood_and_texture_true_to_the_stage():
    facts = A.stage_facts(CHASE_LOOK, _chase())
    t, notes = A.clean_add("sodium glow, an open lot with grass, a grey classic car, sunset light, foggy air, "
                           "empty ground in the foreground, gritty asphalt texture, shallow depth of field, masterpiece", facts)
    assert t == "sodium glow, gritty asphalt texture, shallow depth of field"
    assert len(notes) == 6
    # on a daytime plaza the same check keeps the day and drops the night
    day = A.stage_facts(LOOK, _scene())
    t, _ = A.clean_add("soft golden light, moonlit glow, worn stone plaza paving, a grassy field", day)
    assert "golden" in t and "moonlit" not in t and "plaza paving" in t and "field" not in t


def test_variants_from_one_call_cached_and_rewritten():
    be = A.CannedBackend(CHASE_REPLY)
    a = A.auto_prompt(CHASE_LOOK, {**_chase(), "shot_id": "tracking_v"}, "still", _png((4, 5, 6)), [], backend=be)
    assert len(be.calls) == 1 and len(a["variants"]) == 4
    assert len({v["prompt"] for v in a["variants"]}) == 4              # distinct
    labels = [v["label"] for v in a["variants"]]
    assert labels == ["Naturalistic", "Moody cinematic", "Documentary", "High-contrast night"]   # night: its own label
    doc = next(v for v in a["variants"] if v["key"] == "documentary")
    assert doc["words"] == "plain available light" and not doc["builtin"]
    b = A.auto_prompt(CHASE_LOOK, {**_chase(), "shot_id": "tracking_v"}, "still", _png((4, 5, 6)), [], backend=be)
    assert b["cached"] and b["variants"] == a["variants"] and len(be.calls) == 1
    assert be.temperature == 0.0
    A.auto_prompt(CHASE_LOOK, {**_chase(), "shot_id": "tracking_v"}, "still", _png((4, 5, 6)), [], backend=be, force=True)
    assert len(be.calls) == 2 and be.temperature == 0.7                # ↻ Rewrite: another set of words


def test_a_variant_with_no_surviving_words_gets_its_built_in_words():
    reply = json.loads(CHASE_REPLY)
    reply["variants"]["cinematic"] = {"light": "daylight", "texture": "a parking lot"}
    del reply["variants"]["documentary"]
    r = _chase_auto(reply=json.dumps(reply))
    by = {v["key"]: v for v in r["variants"]}
    assert by["cinematic"]["builtin"] and by["cinematic"]["words"] == "moody cinematic atmosphere, deep shadows, rich contrast"
    assert by["documentary"]["builtin"] and "documentary" in by["documentary"]["prompt"]
    assert not by["natural"]["builtin"]


def test_old_one_prompt_reply_still_works_as_the_natural_variant():
    llm = A.parse_reply(GOOD)
    assert llm["variants"] == {"natural": json.loads(GOOD)["setting"]}
    llm = A.parse_reply(json.dumps({"variants": [{"light": "a"}, {"key": "contrast", "mood": "b"}]}))
    assert llm["variants"] == {"natural": "a", "contrast": "b"}


def test_auto_names_each_person_once_and_drops_names_from_the_description():
    r = A.auto_prompt(LOOK, _scene(), "still", _png(), [], backend=A.CannedBackend(GOOD), force=True)
    assert r["source"] == "auto"
    for v in r["variants"]:
        assert "Sam" not in v["prompt"] and "Maya" not in v["prompt"]
        assert v["prompt"].lower().count("woman") <= r["compiled"].lower().count("woman")
        assert "slim build" in v["prompt"] and "short grey hair" in v["prompt"]
