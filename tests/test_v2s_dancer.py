"""Video → 3D fixes from a street-dance test clip (a woman in a short plaid shirt, overcast sky, concrete slab and slope,
trees). No GPU: recorded-style vision replies (tests/video2stage_fixtures/dancer_*.txt, invented, generic) and synthetic
frames, depth and masks.

1 wardrobe read -> garments the clay understands, never a dress the model did not say, "outfit" alone is unknown
2 the sky decides overcast vs clear, apart from the time of day; the rebuild's sky is within ΔE 10 of the source
3 Reshoot of a stock clip gets scene words from its Video → 3D read
4 set blocks in front of the scan carry their kind word; the ones the scan shows are dropped (no invented pillars)
5 a cut-off sky edge does not tilt the camera; the far tree lands > 20 m away, the near rocks < 8 m
6 the opt-in wardrobe reference: a crop of the person with the face blurred
7 the App route takes the set-scan path when Qwen3-VL is installed, the old block builder otherwise
8 the clay's hip width follows the person's silhouette (within 15 %)
Run:  python -m pytest tests/test_v2s_dancer.py -q
"""
import asyncio
import json
import os
import re
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import convert, performer, pipeline, scanroute, scenewords, track, vlm  # noqa: E402
from soundstage.video2stage import wardrobe as W  # noqa: E402
from soundstage.video2stage import weather as WX  # noqa: E402
from test_v2s_regenerate import fake_server  # noqa: E402,F401 - the faked pipeline.run

FIX = os.path.join(HERE, "video2stage_fixtures")


def _fix(name):
    with open(os.path.join(FIX, name)) as f:
        return f.read()


# ------------------------------------------------------------------------------------------------ 1 wardrobe
def test_plaid_shirt_reads_as_shirt_and_jeans_never_a_dress():
    ap = W.appearance("woman in yellow plaid outfit", "short-sleeve plaid shirt, light jeans", "#e0b030")
    assert ap["top"] == "shirt" and ap["bottom"] == "jeans" and ap["sleeves"] == "short"
    assert ap["top_pattern"] == "plaid" and ap["top_color"] == W.COLORS["yellow"] and "wardrobe" not in ap
    assert "dress" not in json.dumps(ap)
    assert W.words(ap) == "a short-sleeve yellow plaid shirt and light jeans"
    # "dress" only when the model says so
    assert W.parse("a long blue dress")["top"] == "dress"
    assert W.parse("shirt worn long, to mid-thigh").get("top") == "shirt"


def test_outfit_alone_is_unknown_not_the_default_top_and_jeans():
    ap = W.appearance("woman in yellow plaid outfit", "", None)
    assert ap.get("wardrobe") == "unknown" and "top" not in ap and "bottom" not in ap
    assert ap["top_color"] == W.COLORS["yellow"] and ap["top_pattern"] == "plaid"
    kind, ap2 = performer.appearance_from_label("woman in yellow plaid outfit")
    assert kind == "woman" and ap2["wardrobe"] == "unknown"


def test_garment_vocabulary():
    cases = {"white crop top and denim shorts": ("tank", "shorts"), "grey hoodie, black joggers": ("hoodie", "trousers"),
             "red flannel shirt and a pleated skirt": ("shirt", "skirt"), "black tank top, light-wash jeans": ("tank", "jeans"),
             "navy blazer over a white tee, chinos": ("jacket", "trousers"), "denim jacket and jeans": ("jacket", "jeans")}
    for text, (top, bottom) in cases.items():
        ap = W.parse(text)
        assert (ap.get("top"), ap.get("bottom")) == (top, bottom), text
    assert W.parse("white crop top")["length"] == "cropped"
    assert W.parse("red flannel shirt")["top_pattern"] == "plaid"
    assert W.parse("denim jacket and jeans")["top_color"] == W.COLORS["denim"]


def test_both_vision_prompts_ask_for_wardrobe_and_echoes_are_filtered():
    assert '"wardrobe"' in vlm.SYSTEM and "wardrobe" in vlm.INVENTORY_SYSTEM
    first = vlm.parse_reply(_fix("dancer_first.txt"))
    assert first["setting"] == ""                                   # "a few words" is the schema, not an answer
    assert first["objects"][0]["wardrobe"] == ""                    # the echoed placeholder is dropped
    last = vlm.parse_reply(_fix("dancer_last.txt"))
    bd = vlm.merge_reads(first, last)
    assert bd["objects"][0]["wardrobe"] == "short-sleeve yellow plaid shirt, light jeans"   # the fuller read wins
    inv = vlm.merge_inventory([vlm.parse_inventory(_fix("dancer_inventory.txt"), 0)])
    woman = next(it for it in inv["items"] if it["kind"] == "woman")
    assert woman["wardrobe"].startswith("short-sleeve yellow plaid shirt")           # parse_inventory keeps it
    lb = vlm.legacy_breakdown(inv)
    assert lb["objects"][0]["wardrobe"] == woman["wardrobe"]


def test_a_reply_that_only_copies_the_prompt_example_is_rejected_and_marked_unknown():
    # The examples must not be this clip's outfit (a plaid shirt and jeans): a copied example would pass as a read.
    ex = vlm.WARDROBE_EXAMPLE
    for word in ("plaid", "shirt", "jeans", "skirt", "dress"):
        assert word not in ex
    assert "shirt, jeans, skirt" not in vlm.SYSTEM and "plaid shirt, light jeans" not in vlm.INVENTORY_SYSTEM
    assert ex in vlm.SYSTEM and ex in vlm.INVENTORY_SYSTEM and ex in vlm.ECHOES
    # the 4B breakdown: a person whose wardrobe is the example, word for word or without its article
    for copied in (ex, "orange cable-knit sweater, brown corduroy trousers", "Orange cable-knit sweater"):
        reply = json.dumps({"setting": "street", "time": "day", "camera": {"height_m": 1.5, "type": "handheld"},
                            "objects": [{"label": "woman dancing", "kind": "person", "color": "#e0b030",
                                         "bbox": [430, 180, 570, 900], "wardrobe": copied}], "set": []})
        o = vlm.parse_reply(reply)["objects"][0]
        assert o["wardrobe"] == "", copied
        ap = W.appearance(o["label"], o["wardrobe"], o.get("color"))
        assert ap.get("wardrobe") == "unknown" and "top" not in ap and "bottom" not in ap
        assert "sweater" not in json.dumps(ap) and "trousers" not in json.dumps(ap)
    # the 8B inventory: the same copy on a person is dropped, and the person is marked wardrobe unknown downstream
    inv_reply = json.dumps({"setting": "street", "interior": False, "time": "day",
                            "camera": {"height_m": 1.5, "type": "handheld"},
                            "things": [{"kind": "woman", "count": 1, "name": "woman dancing", "material": "fabric",
                                        "color": "#e0b030", "moving": True, "wardrobe": ex,
                                        "boxes": [[430, 180, 570, 900]]}], "surfaces": []})
    inv = vlm.merge_inventory([vlm.parse_inventory(inv_reply, 0)])
    woman = next(it for it in inv["items"] if it["kind"] == "woman")
    assert not woman.get("wardrobe")
    o = vlm.legacy_breakdown(inv)["objects"][0]
    assert W.appearance(o["label"], o.get("wardrobe"), o.get("color")).get("wardrobe") == "unknown"
    # a real read of the clip's outfit still passes the filter
    assert vlm.wardrobe_of({"wardrobe": "short-sleeve yellow plaid shirt, light jeans"}).startswith("short-sleeve")


def test_wardrobe_reaches_the_actor_and_the_look_text():
    bd = vlm.merge_reads(vlm.parse_reply(_fix("dancer_first.txt")), vlm.parse_reply(_fix("dancer_last.txt")))
    K = np.array([[500.0, 0, 320], [0, 500.0, 240], [0, 0, 1]])
    A, b = np.diag([-1.0, -1.0, 1.0]), np.array([0.0, 1.6, 0.0])
    pose = np.hstack([np.eye(3), np.zeros((3, 1))])
    objs = convert.place_objects(bd["objects"], (pose, pose), A, b, K, (640, 480), 120)
    a = objs[0]
    assert a["kind"] == "woman" and a["appearance"]["top"] == "shirt" and a["appearance"]["bottom"] == "jeans"
    a["mocap"] = {"file": "x"}
    scene = {"actors": [a], "video2stage": {"weather": {"sky": "overcast"}}}
    hint = scenewords.look_hint(scene)
    assert "shirt" in hint and "jeans" in hint and "dress" not in hint and "overcast" in hint.lower()
    # the inventory's wardrobe fills a breakdown that has none
    inv = vlm.merge_inventory([vlm.parse_inventory(_fix("dancer_inventory.txt"), 0)])
    bare = vlm.parse_reply(_fix("dancer_first.txt"))
    bare["objects"][0]["bbox_start"] = bare["objects"][0]["bbox"]
    assert "plaid shirt" in vlm.enrich_breakdown(bare, inv)["objects"][0]["wardrobe"]


# ------------------------------------------------------------------------------------------------ 2 weather
def _frames(sky_rgb, n=3, h=120, w=160, sky_rows=50):
    imgs, masks = [], []
    rng = np.random.default_rng(1)
    for _ in range(n):
        im = np.zeros((h, w, 3), np.uint8)
        im[:sky_rows] = np.clip(np.array(sky_rgb) + rng.normal(0, 3, (sky_rows, w, 3)), 0, 255)
        im[sky_rows:] = [92, 96, 88]                                   # slab, slope and trees
        m = np.zeros((h // 2, w // 2), np.float32)                      # DA3's sky mask, at its own (smaller) size
        m[: sky_rows // 2] = 1
        imgs.append(im)
        masks.append(m)
    return imgs, masks


def test_grey_sky_is_overcast_whatever_the_hour_and_matches_the_rebuild():
    imgs, masks = _frames([184, 188, 192])
    s = WX.sky_sample(imgs, masks)
    assert WX.classify(s) == "overcast"
    preset, wx, notes = WX.preset_for("morning", s, convert.time_preset)
    assert preset == "overcast" and wx == "overcast" and notes          # not the golden 6 deg "morning" sun
    assert convert.time_preset("morning") == "golden_am"                 # what it used to be
    assert WX.delta_e(s["rgb"], WX.stage_sky_rgb("golden_am")) > 10      # the orange sky of the old build
    rec = convert._weather_rec("morning", wx, preset, s)
    assert rec["time"] == "morning" and rec["sky"] == "overcast" and rec["delta_e"] < 10   # kept apart


def test_a_dim_grey_sky_is_overcast_not_unknown_and_morning_stays_soft():
    # RGB (90, 95, 100): lightness ~40, so the old "lightness >= 50" rule called it unknown and morning became midday.
    for rgb in ([90, 95, 100], [70, 72, 76], [120, 124, 128]):
        s = WX.sky_sample(*_frames(rgb))
        assert s["lightness"] < 55 or rgb == [120, 124, 128]
        assert WX.classify(s) == "overcast", rgb
        assert WX.preset_for("morning", s, convert.time_preset)[0] == "overcast", rgb
    # a dim but blue sky is still clear, a dim warm one warm: saturation, not brightness, says grey
    assert WX.classify(WX.sky_sample(*_frames([40, 70, 120]))) == "clear"
    assert WX.classify(WX.sky_sample(*_frames([150, 95, 50]))) == "warm"


def test_a_blown_out_white_sky_is_not_called_overcast():
    # a clipped white sky says nothing about the weather on its own
    s = WX.sky_sample(*_frames([254, 254, 255]))
    assert s["clipped"] > 0.9 and WX.classify(s) == "blown out"
    preset, wx, notes = WX.preset_for("midday", s, convert.time_preset)
    assert preset == "midday" and wx == "blown out" and any("blown out" in n for n in notes)
    assert WX.sky_tint(s, wx, preset) is None                           # nothing measured to carry
    # clipped near the sun, blue in the rest: read from the unclipped fringe -> clear
    imgs, masks = _frames([254, 254, 255])
    for im in imgs:
        im[35:50] = [105, 155, 225]
    s = WX.sky_sample(imgs, masks)
    assert s["clipped"] >= 0.5 and WX.classify(s) == "clear"
    # clipped with a grey fringe -> overcast
    imgs, masks = _frames([254, 254, 255])
    for im in imgs:
        im[35:50] = [170, 174, 178]
    assert WX.classify(WX.sky_sample(imgs, masks)) == "overcast"


def test_the_measured_sky_colour_is_carried_into_the_rebuild_for_a_non_preset_grey():
    from soundstage.agent import build as B
    s = WX.sky_sample(*_frames([120, 124, 128]))                         # a mid grey, far from the preset's (185,190,196)
    preset, wx, _ = WX.preset_for("morning", s, convert.time_preset)
    assert preset == "overcast"
    assert WX.delta_e(s["rgb"], WX.stage_sky_rgb(preset)) > 20          # the fixed preset colour alone is way off
    scene = {"lighting": B.lighting_for({"time": preset})}
    convert._carry_sky(scene, s, wx, preset)
    L = scene["lighting"]
    assert L["sky_color"]["preset"] == "overcast" and L["sky_color"]["hex"] == "#%02x%02x%02x" % tuple(s["rgb"])
    assert WX.delta_e(s["rgb"], WX.painted_sky_rgb(L)) < 10             # what the stage paints matches the source
    rec = convert._weather_rec("morning", wx, preset, s)
    assert rec["tinted"] and rec["delta_e"] < 10 and rec["stage_rgb"] == s["rgb"]
    # changing the preset in the App drops the tint (the stage only paints it for the preset it was measured for)
    assert WX.painted_sky_rgb(dict(L, preset="midday")) == WX.stage_sky_rgb("midday")
    # a sky the read doesn't agree with is not carried (a clear read under Overcast, a blown-out sky)
    assert WX.sky_tint(WX.sky_sample(*_frames([110, 160, 225])), "clear", "overcast") is None


def test_blue_sky_morning_is_not_golden_and_no_sky_keeps_the_words():
    imgs, masks = _frames([110, 160, 225])
    s = WX.sky_sample(imgs, masks)
    assert WX.classify(s) == "clear"
    assert WX.preset_for("morning", s, convert.time_preset)[0] == "midday"
    assert WX.preset_for("night", None, convert.time_preset)[0] == "night"
    warm = WX.sky_sample(*_frames([235, 160, 90]))
    assert WX.preset_for("golden hour", warm, convert.time_preset)[0] == "magic_hour"


def test_stage_sky_colours_match_the_stage():
    with open(os.path.join(ROOT, "web", "stage", "lighting.mjs")) as f:
        js = f.read()
    m = re.search(r"export const SKY_COLORS = \{([^}]*)\}", js)
    assert m, "the stage's sky colour map moved"
    pairs = dict((k.strip('" '), int(v, 16)) for k, v in re.findall(r'"?([a-z /]+)"?:\s*0x([0-9a-f]{6})', m.group(1)))
    assert pairs == WX.STAGE_SKY
    with open(os.path.join(ROOT, "web", "stage", "stage.mjs")) as f:
        assert "skyBackground(this.skyPhase, this.state.lighting)" in f.read()


# ------------------------------------------------------------------------------------------------ 3 reshoot words
def test_reshoot_gets_scene_words_from_the_rebuild_of_a_stock_clip(tmp_path):
    from soundstage import reshoot as R
    from soundstage.video2stage import stages
    bd = vlm.merge_reads(vlm.parse_reply(_fix("dancer_first.txt")), vlm.parse_reply(_fix("dancer_last.txt")))
    stages.save("abcdef0123", {"tag": "abcdef0123", "video": "street_dance.mp4", "breakdown": {"read": bd}},
                str(tmp_path))
    words = R.stock_scene_words("/somewhere/input/street_dance.mp4", str(tmp_path))
    assert "plaid shirt" in words and "jeans" in words and "trees" in words and "dress" not in words
    notes = []
    assert R.scene_text("", "/somewhere/input/street_dance.mp4", notes, str(tmp_path)) == words
    assert notes and "stock" in notes[0]
    assert R.scene_text("my words", "/x/street_dance.mp4", [], str(tmp_path)) == "my words"
    assert R.stock_scene_words("/x/other.mp4", str(tmp_path)) == ""
    # a rebuild that wrote its look hint: that is used as is
    stages.save("abcdef0124", {"video": "b.mp4", "scene_words": "A woman dancing on a concrete slab."}, str(tmp_path))
    assert R.stock_scene_words("b.mp4", str(tmp_path)) == "A woman dancing on a concrete slab."
    assert scenewords.from_read(vlm.merge_inventory([vlm.parse_inventory(_fix("dancer_inventory.txt"), 0)]))


# ------------------------------------------------------------------------------------------------ 4 stray blocks
LEVEL_K = np.array([[500.0, 0, 320], [0, 500.0, 240], [0, 0, 1]])
LEVEL_A, LEVEL_B = np.diag([-1.0, -1.0, 1.0]), np.array([0.0, 1.6, 0.0])   # cam0 -> stage, a level camera 1.6 m up
POSE0 = np.hstack([np.eye(3), np.zeros((3, 1))])


def _block(name, pos, h=1.0, **kw):
    return {"id": name.lower().replace(" ", "_"), "name": name, "kind": "custom", "set_piece": True,
            "position": list(pos), "height_m": h, **kw}


def test_blocks_in_front_of_the_scan_get_kind_words_and_covered_ones_go():
    scan = np.full((480, 640), 20.0, np.float32)                        # the scan: a surface 20 m ahead
    actors = [_block("Rocks (left)", [1.0, 0, 5.0], 0.8),                # in front of the scan: kept, worded
              _block("Tree", [-1.0, 0, 20.0], 6.0, kind="tree"),        # where the scan already shows it: dropped
              _block("Box", [0.5, 0, 9.0], 2.5),                         # an odd tall block: named by its own name
              _block("Building facade", [0, 0, -30.0], 9.0),             # behind the camera: off view, kept, unnamed
              {"id": "v2s_scan_points", "name": "Set scan points", "kind": "glb", "scan": True},
              {"id": "ground", "name": "Ground", "kind": "custom", "set_piece": True, "structure": True,
               "position": [0, 0, 10]}]
    res = scenewords.triage_blocks(actors, POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), scan)
    names = [a["name"] for a in actors]
    assert res["dropped"] == ["Tree"] and "Tree" not in names and "Ground" in names
    assert set(res["worded"]) == {"Rocks (left)", "Box"} and res["off_view"] == ["Building facade"]
    words = {a["name"]: a.get("prompt_word") for a in actors}
    assert words["Rocks (left)"] == "rocks" and words["Box"] == "box"
    hint = scenewords.look_hint({"actors": [{"kind": "woman", "mocap": {}, "source": {"label": "woman dancing"}}] + actors})
    assert "rocks" in hint and "box" in hint and "set scan" not in hint.lower()
    assert "building" not in hint                                      # the camera never sees it: not named (it was)


def test_a_long_strip_whose_centre_is_off_screen_is_still_worded():
    # A 120 m shrub strip 8 m ahead, its centre 40 m off to the side: the old centre test called it off camera and kept
    # it with no word, so LTX saw a long clay block in the depth guide and named it whatever it liked.
    scan = np.full((480, 640), 30.0, np.float32)
    strip = _block("Shrubs (left)", [40.0, 0, 8.0], 1.2, recipe={"size_m": [120, 1.2, 2], "parts": []})
    actors = [strip]
    res = scenewords.triage_blocks(actors, POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), scan)
    assert res["worded"] == ["Shrubs (left)"] and strip["prompt_word"] == "shrubs" and strip["in_view"] is True
    # the old rule, for the record: the centre alone projects off screen
    assert scenewords._project(POSE0, LEVEL_A, LEVEL_B, LEVEL_K, [40.0, 0.6, 8.0])[0] < 0
    # and a long strip the scan shows over most of its in-view length is dropped, not judged by one centre pixel
    far = _block("Trees (left)", [40.0, 0, 30.0], 6.0, recipe={"size_m": [120, 6.0, 2], "parts": []})
    res2 = scenewords.triage_blocks([far], POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), scan)
    assert res2["dropped"] == ["Trees (left)"]


def test_the_kind_words_reach_the_motion_prompt():
    from soundstage.look.compile import compile_look
    from soundstage.agent import build as B
    lighting = B.lighting_for({"time": "overcast"})
    rocks = _block("Rocks (left)", [1.5, 0, 6.0], 0.8, recipe={"rig": "static", "size_m": [2.0, 0.8, 1.5], "parts": []})
    box = _block("Box", [-1.0, 0, 9.0], 2.5, recipe={"rig": "static", "size_m": [1.0, 2.5, 1.0], "parts": []})
    hidden = _block("Building facade", [0, 0, -30.0], 9.0, recipe={"rig": "static", "size_m": [20, 9, 2], "parts": []})
    scene = {"version": 2, "shot": {"frames": 97, "fps": 24}, "environment": {"set": "empty", "weather": "none"},
             "lighting": lighting, "sun": {"azimuth_deg": 180, "elevation_deg": 40},
             "actors": [{"id": "dancer", "name": "Dancer", "kind": "woman", "position": [0, 0, 4.0],
                         "keys": [{"frame": 0, "position": [0, 0, 4.0]}], "height_m": 1.66, "rotation_deg": 180},
                        rocks, box, hidden],
             "props": [], "shots": [{"id": "shot_1", "name": "Source camera", "camera_keys": [
                 {"frame": 0, "position": [0, 1.6, 0], "target": [0, 1.3, 6], "focal_mm": 28}]}], "active_shot": "shot_1"}
    before = compile_look(None, json.loads(json.dumps(scene)))["motion_prompt"]
    assert "In the set" not in before                                  # no kind words yet: nothing names the blocks
    scan = np.full((480, 640), 40.0, np.float32)
    scenewords.triage_blocks(scene["actors"], POSE0, LEVEL_A, LEVEL_B, LEVEL_K, (640, 480), scan)
    motion = compile_look(None, scene)["motion_prompt"]
    m = re.search(r"In the set: ([^.]*)\.", motion)
    assert m, motion
    assert "rocks" in m.group(1) and "box" in m.group(1) and "of frame" in m.group(1)
    assert "building" not in m.group(1).lower()                       # off view: never named
    assert not re.search(r"\b(pillar|column)s?\b", motion)


# ------------------------------------------------------------------------------------------------ 5 camera tilt
def _cut_sky_shot():
    """A level camera 1.6 m up over flat ground; a slope and tree crowns cut the sky off unevenly; a tree 35 m away,
    rocks 5 m away."""
    h, w = 480, 640
    v = np.arange(h, dtype=np.float64)[:, None] * np.ones((1, w))
    depth = np.where(v > 242, 500 * 1.6 / np.maximum(v - 240, 1e-6), 80.0).astype(np.float32)
    sky = np.zeros((h, w), np.float32)
    for x in range(420):                                                # a slope rising to the left, then tree crowns
        sky[: int(60 + 140 * x / 420), x] = 1
    depth[sky > 0.5] = 1000.0
    foot_tree = int(round(240 + 500 * 1.6 / 35))
    # The tree's depth as mono depth reads far things: compressed (35 m reads ~30 m) and noisy, not the true 35 m. Its
    # place comes from its box foot on the floor plane; the depth only overrules a foot ray that is far off.
    rng = np.random.default_rng(5)
    depth[100:foot_tree, 460:540] = (30.0 + rng.normal(0, 1.5, (foot_tree - 100, 80))).astype(np.float32)
    depth[330:400, 100:200] = (5.4 + rng.normal(0, 0.4, (70, 100))).astype(np.float32)
    return depth, sky, foot_tree


def test_a_cut_off_sky_edge_does_not_tilt_the_camera():
    depth, sky, foot_tree = _cut_sky_shot()
    v_h = track.horizon_row(sky)
    assert np.degrees(np.arctan2(LEVEL_K[1, 2] - v_h, LEVEL_K[1, 1])) > 5     # the old read: several degrees down
    ok, why = track.horizon_trusted(sky)
    assert not ok and why
    ground, note = track.camera_ground(depth, sky, LEVEL_K, track.valid_mask(depth, sky))
    assert "not the horizon" in note
    n = np.asarray(ground[0])
    assert abs(np.degrees(np.arctan2(-n[2], -n[1]))) < 1.5 and ground[1] == pytest.approx(1.6, rel=0.05)
    A, b = track.world_frame(ground, 1.0)
    tree = {"kind": "tree", "_set_bbox": [460 / 0.64, 100 / 0.48, 540 / 0.64, foot_tree / 0.48], "position": [0, 0, 0]}
    rocks = {"kind": "custom", "name": "Rocks (left)", "_set_bbox": [100 / 0.64, 330 / 0.48, 200 / 0.64, 400 / 0.48],
             "position": [0, 0, 0], "recipe": {"parts": [{"pos": [x, 0.3, 0], "size": [2, 1.3, 1.8]} for x in (-50, 0, 50)],
                                              "size_m": [120, 2.2, 9]}}
    convert.place_set_bboxes([tree, rocks], POSE0, A, b, LEVEL_K, (640, 480), depth, 1.0)
    dist = lambda a: float(np.hypot(a["position"][0], a["position"][2]))  # noqa: E731 - the camera stands at x = z = 0
    assert dist(tree) > 20 and dist(rocks) < 8
    assert tree.get("placed_by") != "depth"                             # the floor plane placed it, not the depth
    assert 33 < dist(tree) < 50                                         # the foot ray (true 35 m), beyond mono depth
    assert rocks["position"][0] > 0                                     # on the camera's left (+X is screen-left)
    assert max(abs(p["pos"][0]) for p in rocks["recipe"]["parts"]) < 3  # a pile as wide as its box, not a 120 m strip
    # the old read (tilt to the cut-off sky edge) on the same box puts the tree much nearer: the test can tell them apart
    A_old, b_old = track.world_frame(track.ground_from_horizon(v_h, LEVEL_K, 1.6), 1.0)
    old = {"kind": "tree", "_set_bbox": list(tree["_bbox"]), "position": [0, 0, 0]}
    convert.place_set_bboxes([old], POSE0, A_old, b_old, LEVEL_K, (640, 480), None, 1.0)
    assert dist(old) < 12


def test_a_clean_horizon_is_still_trusted():
    sky = np.zeros((480, 640), np.float32)
    sky[:200] = 1
    assert track.horizon_trusted(sky)[0]
    depth, _, _ = _cut_sky_shot()
    g, note = track.camera_ground(depth, sky, LEVEL_K, track.valid_mask(depth, sky))
    assert note.startswith("ground: camera tilt from the horizon")


def _flattened_floor(h=480, w=640, row=200, true_tilt=4.6):
    """A camera tilted down `true_tilt` degrees (its horizon at `row`) over flat ground, depth as mono depth reads it:
    compressed with distance (z ** 0.7), which levels a plane fitted to it."""
    th = np.radians(true_tilt)
    v = np.arange(h, dtype=np.float64)[:, None] * np.ones((1, w))
    ang = th + np.arctan2(v - 240, 500.0)                               # each row's ray below the horizon
    z = np.where(ang > 0.003, 1.6 / np.tan(np.maximum(ang, 1e-6)) * np.cos(np.arctan2(v - 240, 500.0)), 400.0)
    return (np.minimum(z, 400.0) ** 0.7).astype(np.float32)


def test_a_clean_partial_horizon_beside_a_building_still_sets_the_tilt():
    # The old guard distrusted any ragged sky edge, so a building on one side sent the tilt to the depth-fitted floor,
    # which mono depth's compression flattens. The low straight stretch of sky edge is a real horizon: keep it.
    h, w, row = 480, 640, 200
    true_tilt = float(np.degrees(np.arctan2(240 - row, 500.0)))
    depth = _flattened_floor(row=row, true_tilt=true_tilt)
    for building in ("roof below the top", "fills the top"):
        sky = np.zeros((h, w), np.float32)
        if building == "roof below the top":
            sky[:row, 300:] = 1                                          # a clean horizon over the right half
            sky[:60, :300] = 1                                           # sky above a building's roof on the left
        else:
            sky[:row, 400:] = 1                                          # the building fills the left 5/8 to the top
        depth[sky > 0.5] = 1000.0
        ok, why = track.horizon_trusted(sky)
        assert ok and "straight horizon" in why, building
        g, note = track.camera_ground(depth, sky, LEVEL_K, track.valid_mask(depth, sky))
        assert note.startswith("ground: camera tilt from the horizon (row 200"), (building, note)
        n = np.asarray(g[0])
        assert abs(np.degrees(np.arctan2(-n[2], -n[1])) - true_tilt) < 0.5, building
    # the depth-fitted floor on this mono depth is the flattened one the horizon guards against
    fitted = track.fit_ground(depth, LEVEL_K, track.valid_mask(depth, sky))
    nf = np.asarray(fitted[0])
    assert abs(np.degrees(np.arctan2(-nf[2], -nf[1])) - true_tilt) > 1.5
    # a slope rising across the sky (no straight low stretch) is still not a horizon
    assert not track.horizon_trusted(_cut_sky_shot()[1])[0]


# ------------------------------------------------------------------------------------------------ 6 wardrobe reference
def test_reference_crop_blurs_the_face_and_keeps_the_clothes():
    rng = np.random.default_rng(3)
    img = rng.integers(0, 255, (400, 300, 3)).astype(np.uint8)          # high detail everywhere
    body = [100, 50, 200, 380]
    face = W.face_box_from_joints(None, body)
    crop = W.reference_crop(img, body, face, pad=0.0)
    assert crop.shape[:2] == (330, 100)
    fy0, fy1 = int(face[1]) - 50 + 4, int(face[3]) - 50 - 4
    fx0, fx1 = int(face[0]) - 100 + 4, int(face[2]) - 100 - 4
    face_px = crop[max(0, fy0):fy1, max(0, fx0):fx1].astype(float)
    shirt = crop[150:250, 20:80].astype(float)
    assert face_px.std() < 0.35 * shirt.std()                           # the face is gone
    np.testing.assert_array_equal(crop[150:250], img[200:300, 100:200])  # the clothes are untouched
    # the face from the take's own joints (nose, neck)
    uv = np.full((18, 2), np.nan)
    uv[0], uv[1] = [150, 80], [150, 110]
    fb = W.face_box_from_joints(uv, body)
    assert fb[0] < 150 < fb[2] and fb[1] < 80 < fb[3]
    assert "face" in W.CONSENT and "right to use" in W.CONSENT


def test_the_wardrobe_reference_blurs_the_face_of_the_same_frame_when_the_take_starts_late(tmp_path, monkeypatch):
    # The take starts at 1.0 s (SAM 3D Body found the person late); the samples are at 0, 1 and 2 s. The face box comes
    # from the take's first frame, so the picture must be the 1.0 s sample, not files[0] (where the face is elsewhere).
    cv2 = pytest.importorskip("cv2")
    rng = np.random.default_rng(9)
    times = [0.0, 1.0, 2.0]
    files = []
    for i in range(3):
        im = rng.integers(0, 255, (400, 300, 3)).astype(np.uint8)
        f = str(tmp_path / f"f_{i:02d}.png")
        cv2.imwrite(f, im[..., ::-1])
        files.append(f)
    take = {"frames": 25, "source_frames": list(range(24, 49)), "focal_px": 900.0, "body": [[[0, 0, 0]] * 18] * 25}
    assert pipeline.ref_frame_pair(take, times, 24.0) == (1, 0)
    assert pipeline.ref_frame_pair(dict(take, source_frames=list(range(0, 25))), times, 24.0) == (0, 0)
    assert pipeline.ref_frame_pair(dict(take, source_frames=list(range(40, 65))), times, 24.0) == (2, 8)
    asked = []

    def sam_2d(t, k, size):                                              # the joints of take frame k (pixels here)
        asked.append(k)
        uv = np.full((18, 2), np.nan)
        uv[0], uv[1] = [200, 90], [200, 120]                             # nose, neck: the head at (200, 90) at 1.0 s
        uv[8], uv[11], uv[10], uv[13] = [185, 220], [215, 220], [185, 360], [215, 360]   # hips, ankles
        return uv
    monkeypatch.setattr(pipeline.performer, "sam_2d", sam_2d)
    actor = {"source": {"bbox_start": [100, 100, 450, 950], "bbox_end": [500, 100, 850, 950]}}
    name = pipeline.write_wardrobe_ref(actor, take, files, "soundstage/v2s_t", (300, 400), times=times, fps=24.0,
                                       duration=2.0)
    assert name == "soundstage/v2s_t/wardrobe_ref.png" and asked == [0]
    crop = cv2.imread(str(tmp_path / "wardrobe_ref.png"))[..., ::-1]
    src1 = cv2.imread(files[1])[..., ::-1]
    # the crop is cut from the 1.0 s sample (its clothes are that frame's pixels) ...
    jx0, jy0, jx1 = 185 - 0.2 * 30, 90 - 1.6 * 0.12 * 270, 215 + 0.2 * 30
    X0, Y0 = int(max(0, jx0 - 0.08 * (jx1 - jx0))), int(max(0, jy0 - 0.08 * (360 + 0.12 * 270 - jy0)))
    np.testing.assert_array_equal(crop[260 - Y0:300 - Y0, 190 - X0:210 - X0], src1[260:300, 190:210])
    # ... and that frame's face is gone
    face = crop[85 - Y0:100 - Y0, 192 - X0:208 - X0].astype(float)
    assert face.std() < 0.35 * src1[85:100, 192:208].astype(float).std()


def test_the_wardrobe_consent_is_on_screen_not_only_a_tooltip():
    with open(os.path.join(ROOT, "web", "ui", "videoimport.mjs")) as f:
        js = f.read()
    assert 'className: "consent", textContent: WARDROBE_REF_CONSENT' in js and "wrc" in js.split("grid.append(")[-1]
    assert "p.consent" in js


def test_the_cast_pool_offers_the_wardrobe_reference_only_when_made():
    with open(os.path.join(ROOT, "web", "ui", "videoimport.mjs")) as f:
        js = f.read()
    assert "wardrobe_ref: false" in js and "WARDROBE_REF_CONSENT" in js      # opt-in, off by default
    assert pipeline.run_kwargs({})["wardrobe_ref"] is False
    assert pipeline.run_kwargs({"wardrobe_ref": True})["wardrobe_ref"] is True


# ------------------------------------------------------------------------------------------------ 7 the route
def test_the_route_picks_the_scan_path_when_qwen3vl_is_installed():
    assert scanroute.choose(None, True, "qwen3vl_8b_fp8_scaled.safetensors")[0]
    assert scanroute.choose(None, True, "qwen3vl_4b_fp8_scaled.safetensors")[0]
    assert not scanroute.choose(None, True, None)[0]
    assert not scanroute.choose(None, True, "qwen3.5_4b_bf16.safetensors")[0]   # the old 4B can't do the inventory
    assert not scanroute.choose(False, True, "qwen3vl_8b_fp8_scaled.safetensors")[0]
    assert not scanroute.choose(True, False, "qwen3vl_8b_fp8_scaled.safetensors")[0]
    assert "not installed" in scanroute.choose(True, True, None)[1]
    assert pipeline.run_kwargs({})["scan"] is None and pipeline.run_kwargs({"scan": False})["scan"] is False


def test_route_runs_the_inventory_and_the_scan_with_fixtures(fake_server, monkeypatch):
    seen, out = fake_server
    monkeypatch.setattr(pipeline.vlm, "inventory_model", lambda: "qwen3vl_8b_fp8_scaled.safetensors")
    real = pipeline.queue.run_graph

    async def run_graph(base, g, what, timeout_s=900.0, on_wait=None):
        if what == "inventory":
            seen["queued"].append(what)
            n = len([k for k in g if k.startswith("r")])
            return {f"r{i}": {"text": [_fix("dancer_inventory.txt")]} for i in range(n)}, {"total_ms": 1}
        return await real(base, g, what, timeout_s, on_wait)
    monkeypatch.setattr(pipeline.queue, "run_graph", run_graph)
    calls = []
    monkeypatch.setattr(pipeline.scanroute, "apply", lambda scene, **kw: (calls.append(kw), {
        "planes": 1, "scan": True, "dropped": [], "worded": []})[1])
    r = asyncio.run(pipeline.run("http://x", "clip.mp4"))
    assert seen["queued"] == ["depth", "shot breakdown", "inventory", "motion capture"]
    assert len(calls) == 1 and r["scene"]["video2stage"]["set_path"]["path"] == "scan"
    assert any(n.startswith("set: the set-scan path") for n in r["notes"])
    rec = json.loads((out / "soundstage_v2s" / f"v2s_{r['tag']}_stages.json").read_text())
    assert rec["inventory"]["items"]
    # switched off: the old block builder, no inventory
    seen["queued"].clear()
    calls.clear()
    r = asyncio.run(pipeline.run("http://x", "clip.mp4", scan=False))
    assert "inventory" not in seen["queued"] and not calls and r["scene"]["video2stage"]["set_path"]["path"] == "blocks"


@pytest.fixture
def scan_server(fake_server, monkeypatch):
    """fake_server with real arrays: a 96 x 128 floor-and-wall depth with its sky, real sample PNGs, a moving camera
    and a block-built scene, so the route runs the REAL scanroute.apply (planes.fit + backdrop.build) on them."""
    cv2 = pytest.importorskip("cv2")
    seen, out = fake_server
    h, w = 96, 128
    K = np.array([[100.0, 0, 64], [0, 100.0, 48], [0, 0, 1]])
    v = np.arange(h, dtype=np.float64)[:, None] * np.ones((1, w))
    depth = np.where(v > 50, 100 * 1.6 / np.maximum(v - 48, 1e-6), 60.0).astype(np.float32)
    sky = (v < 30).astype(np.float32)
    monkeypatch.setattr(pipeline.vlm, "inventory_model", lambda: "qwen3vl_8b_fp8_scaled.safetensors")

    def extract(path, d, times):
        os.makedirs(d, exist_ok=True)
        fs = []
        for i in range(len(times)):
            im = np.full((h, w, 3), 120, np.uint8)
            im[:30] = [190, 192, 196]
            f = os.path.join(d, f"f_{i:02d}.png")
            cv2.imwrite(f, im)
            fs.append(f)
        return fs
    monkeypatch.setattr(pipeline.frames, "extract", extract)
    real = pipeline.queue.run_graph

    async def run_graph(base, g, what, timeout_s=900.0, on_wait=None):
        if what == "depth":
            seen["queued"].append(what)
            d = out / "soundstage_v2s"
            d.mkdir(exist_ok=True)
            p = d / f"v2s_{g['x1']['inputs']['name'].split('_', 1)[1]}.npz"
            n = 16
            np.savez(p, depth=np.repeat(depth[None], n, 0), sky=np.repeat(sky[None], n, 0),
                     intrinsics=np.repeat(K[None].astype(np.float32), n, 0))
            return {"x1": {"text": [str(p)]}}, {"total_ms": 1}
        if what == "inventory":
            seen["queued"].append(what)
            k = len([x for x in g if x.startswith("r")])
            return {f"r{i}": {"text": [_fix("dancer_inventory.txt")]} for i in range(k)}, {"total_ms": 1}
        return await real(base, g, what, timeout_s, on_wait)
    monkeypatch.setattr(pipeline.queue, "run_graph", run_graph)

    def solve(packet, files, seed=0):
        poses = [np.hstack([np.eye(3), np.array([[0.0], [0.0], [-0.05 * i]])]) for i in range(len(files))]
        return poses, np.ones(len(files)), K, (np.array([0.0, -1.0, 0.0]), 1.6, 1.0), [], packet["depth"]
    monkeypatch.setattr(pipeline, "solve", solve)
    A, b = track.world_frame((np.array([0.0, -1.0, 0.0]), 1.6, 1.0), 1.0)

    def assemble(**kw):   # the old block builder's set: a plaza block and a rock pile
        return {"actors": [_block("Plaza", [0, 0, 8], 0.03), _block("Rocks (left)", [1.0, 0, 4.0], 0.8)],
                "shots": [{"camera_keys": [{"position": [0, 1.6, 0]}]}], "camera_keys": [], "shot": {"frames": 120},
                "video2stage": {"metres_per_unit": 1.0, "xform": {"A": A.tolist(), "b": b.tolist()}}}
    monkeypatch.setattr(pipeline.convert, "assemble", assemble)
    return seen, out


def test_route_runs_the_real_scan_path_and_falls_back_to_the_blocks_when_the_scan_fails(scan_server, monkeypatch):
    seen, out = scan_server
    r = asyncio.run(pipeline.run("http://x", "clip.mp4"))
    sp = r["scene"]["video2stage"]["set_path"]
    names = [a.get("name") for a in r["scene"]["actors"]]
    assert sp["path"] == "scan" and sp["scan"] is True and sp["planes"] >= 1, r["notes"]
    assert any(a.get("scan") for a in r["scene"]["actors"]) and "Plaza" not in names   # scan in, flat block out
    assert "inventory" in seen["queued"]
    # the set scan fails inside backdrop.build: the route really falls back to the old builder's set, and says so
    from soundstage.video2stage import backdrop as BD

    def boom(scene, ctx, **kw):
        raise RuntimeError("no splat")
    monkeypatch.setattr(BD, "build", boom)
    r2 = asyncio.run(pipeline.run("http://x", "clip.mp4"))
    sp2 = r2["scene"]["video2stage"]["set_path"]
    names2 = [a.get("name") for a in r2["scene"]["actors"]]
    assert sp2["path"] == "blocks" and "did not build" in sp2["fallback"], sp2
    assert not any(a.get("scan") or a.get("structure") for a in r2["scene"]["actors"])   # no half-applied scan path
    assert "Plaza" in names2 and "Rocks (left)" in names2                 # the old builder's blocks, as they were
    assert any("fell back to the old block builder" in n for n in r2["notes"])
    assert any("the set scan failed (no splat)" in n for n in r2["notes"])
    # a crash anywhere in the scan path falls back the same way
    monkeypatch.setattr(pipeline.scanroute, "apply", lambda scene, **kw: (_ for _ in ()).throw(ValueError("bad planes")))
    r3 = asyncio.run(pipeline.run("http://x", "clip.mp4"))
    sp3 = r3["scene"]["video2stage"]["set_path"]
    assert sp3["path"] == "blocks" and "bad planes" in sp3["fallback"]
    assert [a.get("name") for a in r3["scene"]["actors"]] == names2


def test_scan_apply_fits_the_ground_and_fuses_a_scan(tmp_path):
    cv2 = pytest.importorskip("cv2")
    h, w = 96, 128
    K = np.array([[100.0, 0, 64], [0, 100.0, 48], [0, 0, 1]])
    v = np.arange(h, dtype=np.float64)[:, None] * np.ones((1, w))
    depth = np.where(v > 50, 100 * 1.6 / np.maximum(v - 48, 1e-6), 60.0).astype(np.float32)
    sky = (v < 30).astype(np.float32)
    files = []
    for i in range(3):
        f = str(tmp_path / f"f_{i}.png")
        im = np.full((h, w, 3), 120, np.uint8)
        im[:30] = [190, 192, 196]
        cv2.imwrite(f, im)
        files.append(f)
    poses = [np.hstack([np.eye(3), np.array([[0.0], [0.0], [-0.2 * i]])]) for i in range(3)]
    A, b = track.world_frame((np.array([0.0, -1.0, 0.0]), 1.6, 1.0), 1.0)
    scene = {"actors": [_block("Plaza", [0, 0, 8], 0.03), _block("Rocks (left)", [1.0, 0, 4.0], 0.8)],
             "video2stage": {"xform": {"A": A.tolist(), "b": b.tolist()}}}
    notes = []
    st = scanroute.apply(scene, depths=[depth] * 3, scales=[1.0] * 3, poses=poses, K=K, files=files, skies=[sky] * 3,
                         breakdown={"objects": []}, times=[0.0, 0.5, 1.0], duration=1.0, notes=notes, tag="t",
                         out={"dir": str(tmp_path / "out"), "subfolder": "t"})
    names = [a.get("name") for a in scene["actors"]]
    assert st["planes"] >= 1 and any(a.get("structure") for a in scene["actors"]), notes
    assert "Plaza" not in names                                          # the measured ground replaced it
    assert st["scan"] and any(a.get("scan") for a in scene["actors"]), notes


# ------------------------------------------------------------------------------------------------ 8 body build
def _silhouette(hip_px, h=400, w=300, arms=True):
    m = np.zeros((h, w), bool)
    cx = w // 2
    top, bot = 20, 380
    hgt = bot - top
    m[top:top + int(0.13 * hgt), cx - 22:cx + 22] = True                 # head
    hip_y0, hip_y1 = bot - int(0.58 * hgt), bot - int(0.45 * hgt)
    m[top + int(0.13 * hgt):hip_y0, cx - 40:cx + 40] = True             # torso
    m[hip_y0:hip_y1, cx - hip_px // 2:cx + hip_px // 2] = True           # hips
    m[bot - int(0.45 * hgt):bot + 1, cx - hip_px // 2:cx - 4] = True     # legs
    m[bot - int(0.45 * hgt):bot + 1, cx + 4:cx + hip_px // 2] = True
    if arms:   # arms hanging beside the hips, a gap away: not part of the hip width
        m[top + int(0.2 * hgt):bot - int(0.40 * hgt), cx - hip_px // 2 - 22:cx - hip_px // 2 - 8] = True
        m[top + int(0.2 * hgt):bot - int(0.40 * hgt), cx + hip_px // 2 + 8:cx + hip_px // 2 + 22] = True
    return m, hgt + 1


@pytest.mark.parametrize("hip_px", [62, 70, 84])
def test_girth_from_the_silhouette_puts_the_clay_hips_within_15_percent(hip_px):
    mask, hgt = _silhouette(hip_px)
    g, src = W.girth_from(None, mask, female=True)
    assert src == "the person's silhouette"
    height_m = 1.66
    mask_hip_m = hip_px / hgt * height_m
    assert abs(W.clay_hip_width(height_m, g, True) - mask_hip_m) <= 0.15 * mask_hip_m
    assert W.nearest_build(g) in W.BUILDS


def test_sam_shape_wins_and_the_clay_formula_matches_the_stage():
    g, src = W.girth_from({"body_shape": {"hip_width_m": 0.36, "height_m": 1.66}}, _silhouette(70)[0])
    assert src == "SAM 3D Body shape" and W.clay_hip_width(1.66, g) == pytest.approx(0.36, rel=1e-6)
    assert W.girth_from(None, None) == (None, "")
    with open(os.path.join(ROOT, "web", "stage", "humans.mjs")) as f:
        js = f.read()
    assert "waistR = (female ? 0.13 : 0.15) * bw * s" in js and "waistR * 1.12" in js and "female ? 1.15 : 1.02" in js
    assert "+ap.girth" in js


def test_person_mask_from_depth():
    d = np.full((200, 160), 30.0, np.float32)
    d[40:190, 60:100] = 4.0                                              # the person, 4 m away
    m = W.person_mask_from_depth(d, [0.25, 0.15, 0.75, 0.98])
    assert m[100, 80] and not m[100, 50] and m.sum() == 150 * 40


# ------------------------------------------------------------------------------------------------ the browser fixture
REPLAY_FIELDS = os.path.join(FIX, "v2s_replay_fields.json")


def replay_fields() -> dict:
    """The fields this change adds to a Video -> 3D result, made by the real code from fixtures (a mid-grey sky, the
    dancer's inventory read, a silhouette): the sky reading and its measured colour, the wardrobe words, the clay's
    girth and the wardrobe reference. The try-it replay's recorded run is older than these fields; the browser check
    overlays this on it (and tests/js/v2s_replay_fields.test.mjs feeds it to the App's own functions)."""
    from soundstage.agent import build as B
    s = WX.sky_sample(*_frames([120, 124, 128]))
    preset, wx, _ = WX.preset_for("morning", s, convert.time_preset)
    scene = {"lighting": B.lighting_for({"time": preset})}
    convert._carry_sky(scene, s, wx, preset)
    inv = vlm.merge_inventory([vlm.parse_inventory(_fix("dancer_inventory.txt"), 0)])
    woman = next(it for it in inv["items"] if it["kind"] == "woman")
    ap = W.appearance(woman["name"], woman["wardrobe"], woman.get("color"))
    g, src = W.girth_from(None, _silhouette(70)[0], female=True)
    ap.update(girth=round(g, 3), build=W.nearest_build(g))
    performer_ = {"id": "driver", "kind": "woman", "mocap": {}, "appearance": ap,
                  "source": {"label": woman["name"], "wardrobe": woman["wardrobe"]},
                  "wardrobe_ref": "soundstage/v2s_fixture/wardrobe_ref.png"}
    hint = scenewords.look_hint({"actors": [performer_], "video2stage": {"weather": {"sky": wx}}})
    return {"about": "Made by tests/test_v2s_dancer.py replay_fields() from fixtures, not a GPU run. Overlay for the "
                     "try-it replay's recorded Video -> 3D result (its 'driver' actor stands in for the performer).",
            "lighting": scene["lighting"],
            "video2stage": {"weather": convert._weather_rec("morning", wx, preset, s), "look_hint": hint},
            "actors": {"driver": {k: performer_[k] for k in ("kind", "appearance", "source", "wardrobe_ref")}},
            "girth_source": src}


def test_the_replay_fixture_is_what_the_code_makes():
    with open(REPLAY_FIELDS) as f:
        assert json.load(f) == json.loads(json.dumps(replay_fields())), \
            "regenerate: python3 -c 'import sys; sys.path[:0]=[\"tests\",\".\"]; import json, test_v2s_dancer as t; " \
            "open(t.REPLAY_FIELDS, \"w\").write(json.dumps(t.replay_fields(), indent=1) + \"\\n\")'"
