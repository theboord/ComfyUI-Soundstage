"""LAYOUT (Video -> 3D): inventory parsing, SAM mask packing, measuring boxes, structure planes, movers, assembly.

The geometry tests ray-cast a small hand-made set through known cameras (tests/video2stage_fixtures/synth_layout.py),
so every number has a known answer.
"""
import math
import os
import sys

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests", "video2stage_fixtures"))

from soundstage.video2stage import context as X  # noqa: E402
from soundstage.video2stage import convert, measure, movers, planes, segment, vlm  # noqa: E402

cv2 = pytest.importorskip("cv2")
import synth_layout as S  # noqa: E402


# ---------------------------------------------------------------------------------------------- inventory (vlm)
GROUPED = """```json
{"setting":"modern living room","interior":true,"time":"day","camera":{"height_m":1.5,"type":"handheld"},
 "things":[{"kind":"chairs","count":4,"name":"blue wooden dining chair","material":"wood","color":"#3e5f8a","moving":false,
            "boxes":[[100,500,180,800],[200,500,280,800],[200,500,280,800],[300,-20,380,-5]]},
           {"kind":"sofa","count":1,"name":"<colour + material + noun>","material":"fabric","color":"#6b7f5e","moving":false,
            "boxes":[[600,550,950,850]]},
           {"kind":"person","count":1,"name":"woman in a yellow sweater","material":"fabric","color":"#d8a92f","moving":true,
            "boxes":[[400,200,500,900]]},
           {"kind":"floor","name":"wooden floor","material":"wood","color":"#9a6b43"}],
 "surfaces":[{"kind":"walls","material":"paint","color":"#d9d2c5"}]}
```"""


def test_parse_inventory_expands_boxes_and_drops_loops_and_echoes():
    r = vlm.parse_inventory(GROUPED, frame=12)
    chairs = [it for it in r["items"] if it["kind"] == "chair"]
    # 4 counted, 2 distinct boxes kept (one repeat, one off the grid), the other 2 known by count only
    assert sum(1 for c in chairs if c["bbox"]) == 2
    assert sum(c["count"] for c in chairs) == 4
    assert all(c["frame"] == 12 for c in chairs)
    sofa = next(it for it in r["items"] if it["kind"] == "sofa")
    assert sofa["name"] == "sofa" and r["echoes"] == 1          # the placeholder name was not shipped
    assert {s["kind"] for s in r["surfaces"]} == {"floor", "wall"}
    assert r["interior"] is True and r["camera"]["height_m"] == 1.5


def test_schema_echo_needs_a_retry_and_a_real_read_does_not():
    echo = '{"setting":"<where, 3-8 words>","things":[{"kind":"<one noun>","name":"a few words","boxes":[[1,2,3,4]]}]}'
    assert vlm.needs_retry(vlm.parse_inventory(echo))
    assert not vlm.needs_retry(vlm.parse_inventory(GROUPED))
    assert vlm.needs_retry(None)


def test_merge_inventory_counts_and_one_camera_height():
    a = vlm.parse_inventory(GROUPED, 0)
    b = vlm.parse_inventory(GROUPED.replace('"height_m":1.5', '"height_m":2.5').replace('"count":4', '"count":5'), 40)
    inv = vlm.merge_inventory([a, b])
    assert inv["kinds"]["chair"] == 5
    assert inv["camera"]["height_m"] == pytest.approx(2.0)
    assert inv["interior"] is True
    assert {it["frame"] for it in inv["items"]} == {0, 40}


def test_set_types_and_sizes_cover_furniture_and_boats():
    for t in ("table", "chair", "sofa", "shelf", "rug", "bin", "sign", "plant"):
        assert t in vlm.SET_TYPES
    assert vlm.resolve_kind("", "white speedboat") == "boat"
    assert "boat" in convert.SIZES


def test_inventory_graph_reads_six_frames_with_the_8b_model():
    ctx = X.new({"pw": 64, "ph": 36, "frames": 145}, {})
    ctx["all_frames"] = [f"/in/soundstage/v2s_x/s_{i:05d}.png" for i in range(145)]
    ctx["env"] = {"input_dir": "/in"}
    ctx["vlm_model"] = vlm.INVENTORY_MODELS[0]
    g = vlm.inventory_graph(ctx)
    loads = [n["inputs"]["image"] for n in g.values() if n["class_type"] == "LoadImage"]
    assert len(loads) == 6 and loads[0] == "soundstage/v2s_x/s_00000.png" and loads[-1].endswith("s_00144.png")
    assert g["v1"]["inputs"]["clip_name"] == "qwen3vl_8b_fp8_scaled.safetensors"
    assert sum(n["class_type"] == "TextGenerate" for n in g.values()) == 6


# ---------------------------------------------------------------------------------------------- segment (SAM)
def test_concepts_put_inventory_names_first_and_leave_people_and_surfaces_out():
    ctx = X.new({"pw": 64, "ph": 36, "frames": 10}, {"objects": "umbrella"})
    ctx["vlm_inventory"] = vlm.merge_inventory([vlm.parse_inventory(GROUPED)])
    cons = segment.concepts(ctx)
    words = [c["text"] for c in cons]
    assert words[0] == "umbrella"
    assert "chair" in words and "sofa" in words and "furniture" in words
    assert "person" not in words and "floor" not in words and "wall" not in words
    assert next(c for c in cons if c["text"] == "chair")["max_objects"] == 8


def test_windows_cover_every_frame_with_overlap():
    assert segment.windows(30) == [(0, 30)]
    w = segment.windows(145)
    covered = set()
    for s, ln in w:
        covered |= set(range(s, s + ln))
        assert ln <= 40 + 8
    assert covered == set(range(145))
    assert all(w[i][0] + w[i][1] > w[i + 1][0] for i in range(len(w) - 1))   # overlapping


def test_segment_graph_one_multi_prompt_track_per_window_and_detections_to_name():
    ctx = X.new({"pw": 64, "ph": 36, "frames": 50, "video": "clip.mp4", "fps": 24.0, "start": 0.0}, {})
    ctx["seg_concepts"] = [{"text": "chair", "max_objects": 8, "source": "vlm"},
                           {"text": "coffee table", "max_objects": 4, "source": "vlm"}]
    ctx["vlm_frames"] = [0, 25, 49]
    ctx["seg_max_objects"] = 16
    g = segment.graph(ctx)
    cls = [n["class_type"] for n in g.values()]
    assert cls.count("SAM3_VideoTrack") == 2                        # 2 windows, ONE track each
    texts = [n["inputs"]["text"] for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert "chair, coffee table" in texts and "person" not in " ".join(texts)
    assert cls.count("SAM3_TrackToMask") == 32                      # 16 objects x 2 windows
    assert cls.count("SAM3_Detect") == 6                            # 2 concepts x 3 inventory frames
    assert sum(1 for k in ctx["seg_keys"].values() if k[0] == "track") == 4   # 2 bit groups x 2 windows
    vals = sorted({round(n["inputs"]["value"] * 255, 3) for n in g.values() if n["class_type"] == "SolidMask"})
    assert vals == [0.5, 1, 2, 4, 8, 16, 32, 64, 128]


def test_collect_unpacks_bits_stitches_windows_and_names_from_detections(tmp_path):
    n, pw, ph = 50, 40, 24
    ctx = X.new({"pw": pw, "ph": ph, "frames": n, "video": "clip.mp4", "fps": 24.0, "start": 0.0}, {})
    ctx["seg_concepts"] = [{"text": "chair", "max_objects": 8, "source": "vlm"},
                           {"text": "bin", "max_objects": 8, "source": "sweep"}]
    ctx["vlm_frames"] = [0, 45]
    ctx["seg_max_objects"] = 8
    segment.graph(ctx)
    outputs = {}

    def chair(f):
        m = np.zeros((ph, pw), np.uint8)
        m[4:12, 4 + f % 3:12 + f % 3] = 1
        return m

    def bin_(f):
        m = np.zeros((ph, pw), np.uint8)
        m[14:20, 20:30] = 1
        return m
    for nid, key in ctx["seg_keys"].items():
        ims = []
        if key[0] == "track":
            _, start, grp = key
            for i in range(min(40, n - start)):
                f = start + i
                k = 0 if start == 0 else 1     # the chair is track 0 in window 0 and track 1 in window 1
                v = (chair(f) << k) | (bin_(f) << 2)
                fn = f"m_{nid}_{i:05d}.png"
                cv2.imwrite(str(tmp_path / fn), v.astype(np.uint8))
                ims.append({"filename": fn, "subfolder": "", "type": "output"})
        else:
            _, ci, f = key
            m = chair(f) if ci == 0 else bin_(f)
            fn = f"d_{nid}.png"
            cv2.imwrite(str(tmp_path / fn), (m * 255).astype(np.uint8))
            ims.append({"filename": fn, "subfolder": "", "type": "output"})
        outputs[nid] = {"images": ims}
    seg = segment.collect(ctx, outputs, out_dir=str(tmp_path))
    assert sorted(o["concept"] for o in seg.values()) == ["bin", "chair"]
    ch = next(o for o in seg.values() if o["concept"] == "chair")
    assert len(ch["frames"]) == n                                   # stitched across the window seam
    assert X.rle_decode(ctx["masks"]["objects"][ch["id"]][45]).sum() > 30


def test_dedupe_keeps_the_specific_name():
    m = np.zeros((20, 20), bool)
    m[4:16, 4:16] = True
    low = segment._low(m)
    st = segment._stats(m)
    seg = {"furniture_0": {"id": "furniture_0", "concept": "furniture", "source": "sweep", "frames": {0: st, 1: st}, "_low": {0: low, 1: low}},
           "sofa_0": {"id": "sofa_0", "concept": "sofa", "source": "vlm", "frames": {0: st, 1: st}, "_low": {0: low, 1: low}}}
    dropped = segment.dedupe(seg)
    assert dropped == ["furniture_0"] and list(seg) == ["sofa_0"]


# ---------------------------------------------------------------------------------------------- geometry
def _room(dynamic_box=False):
    """A 6 x 5 m room, a camera 1.6 m up looking in, a table, two chairs, a shelf, a red box."""
    W, H = 320, 180
    fx = 0.55 * W
    objs = [
        {"id": "floor", "cls": "floor", "color": "#9a6b43", "size": [6, 0.04, 5], "frames": [{"f": -1, "c": [0, -0.02, -1.5], "yaw": 0, "size": [6, 0.04, 5]}]},
        {"id": "back", "cls": "wall", "color": "#d9d2c5", "size": [6, 2.6, 0.1], "frames": [{"f": -1, "c": [0, 1.3, -4.05], "yaw": 0, "size": [6, 2.6, 0.1]}]},
        {"id": "left", "cls": "wall", "color": "#d9d2c5", "size": [5, 2.6, 0.1], "frames": [{"f": -1, "c": [-3.05, 1.3, -1.5], "yaw": 90, "size": [5, 2.6, 0.1]}]},
        {"id": "right", "cls": "wall", "color": "#d9d2c5", "size": [5, 2.6, 0.1], "frames": [{"f": -1, "c": [3.05, 1.3, -1.5], "yaw": 90, "size": [5, 2.6, 0.1]}]},
        {"id": "ceiling", "cls": "ceiling", "color": "#eeeeee", "size": [6, 0.04, 5], "frames": [{"f": -1, "c": [0, 2.62, -1.5], "yaw": 0, "size": [6, 0.04, 5]}]},
        {"id": "table", "cls": "table", "label": "dining table", "color": "#8a5a33", "size": [1.6, 0.75, 0.9], "frames": [{"f": -1, "c": [0.3, 0.375, -2.0], "yaw": 0, "size": [1.6, 0.75, 0.9]}]},
        {"id": "chair_a", "cls": "chair", "label": "blue chair", "color": "#3e5f8a", "size": [0.46, 0.9, 0.46], "frames": [{"f": -1, "c": [0.0, 0.45, -1.2], "yaw": 180, "size": [0.46, 0.9, 0.46]}]},
        {"id": "shelf", "cls": "shelf", "label": "bookshelf", "color": "#5a3a22", "size": [0.9, 1.9, 0.35], "frames": [{"f": -1, "c": [-2.0, 0.95, -3.8], "yaw": 0, "size": [0.9, 1.9, 0.35]}]},
    ]
    n = 25
    cams = []
    for f in range(n):
        x = -0.6 + 1.2 * f / (n - 1)          # a slow dolly, looking a little down
        yaw = math.radians(-8 + 16 * f / (n - 1))
        pitch = math.radians(-12)
        fwd = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
        right = np.cross(fwd, [0, 1, 0])
        right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        cams.append({"f": f, "pos": [x, 1.6, 1.2], "R": np.stack([right, up, -fwd], 1).tolist(), "fx": fx, "fy": fx,
                     "cx": W / 2, "cy": H / 2})
    box_frames = []
    for f in range(n):
        p = [0.6 - (1.2 * f / (n - 1) if dynamic_box else 0), 0.75 + 0.1, -2.0]
        box_frames.append({"f": f, "c": p, "yaw": 0, "size": [0.3, 0.2, 0.25]})
    objs.append({"id": "box", "cls": "box", "label": "red box", "color": "#c8443a", "dynamic": dynamic_box,
                 "size": [0.3, 0.2, 0.25], "frames": box_frames})
    return {"width": W, "height": H, "frames": n, "camera": cams, "objects": objs, "scene": "interior"}


@pytest.fixture(scope="module")
def room_ctx(tmp_path_factory):
    d = tmp_path_factory.mktemp("room")
    ctx = S.build(_room(), str(d), pw=160, sample_every=6)
    measure.measure(ctx)
    return ctx


def test_measure_recovers_size_place_and_colour(room_ctx):
    objs = room_ctx["layout"]["objects"]
    t = objs["table"]
    assert t["dims"][1] == pytest.approx(0.75, abs=0.06)
    assert max(t["dims"][0], t["dims"][2]) == pytest.approx(1.6, rel=0.15)
    assert t["centre"][0] == pytest.approx(0.3, abs=0.15) and t["centre"][2] == pytest.approx(-2.0, abs=0.2)
    s = objs["shelf"]
    assert s["dims"][1] == pytest.approx(1.9, abs=0.12)
    assert s["colour"] == "#5a3a22" or measure._srgb_to_lab(np.array([[int(s["colour"][i:i + 2], 16) / 255 for i in (1, 3, 5)]]))[0][0] < 40
    assert not any(o["moving"] for o in objs.values())
    b = objs["box"]                                                # on the table, not on the floor
    assert not b["grounded"] and b["bottom"] == pytest.approx(0.75, abs=0.06)


def test_chairs_face_their_table(room_ctx):
    c = room_ctx["layout"]["objects"]["chair_a"]
    assert measure.wrap if hasattr(measure, "wrap") else True
    d = ((c["yaw_deg"] - 180 + 180) % 360) - 180
    assert abs(d) < 20                                              # faces -Z, toward the table


def test_scale_anchors_and_surfaces_for_pose(room_ctx):
    srcs = {a["source"] for a in room_ctx["scale_anchors"]}
    assert "layout:table" in srcs
    a = next(a for a in room_ctx["scale_anchors"] if a["source"] == "layout:table")
    assert a["units"] == pytest.approx(0.75, abs=0.06) and a["metres"] == 0.75
    kinds = {s["kind"] for s in room_ctx["surfaces"]}
    assert {"seat", "table"} <= kinds
    seat = next(s for s in room_ctx["surfaces"] if s["id"] == "chair_a")
    assert -seat["plane"][3] == pytest.approx(0.47, abs=0.08) and len(seat["polygon"]) == 4


def test_planes_find_floor_walls_ceiling_and_call_it_an_interior(room_ctx):
    notes = []
    res = planes.fit(room_ctx, notes)
    kinds = [p["kind"] for p in res["planes"]]
    assert "floor" in kinds and "ceiling" in kinds and kinds.count("wall") >= 2
    assert res["interior"]
    back = min((p for p in res["planes"] if p["kind"] == "wall"), key=lambda p: p["centre"][2])
    assert back["centre"][2] == pytest.approx(-4.0, abs=0.2)
    ceil = next(p for p in res["planes"] if p["kind"] == "ceiling")
    assert ceil["centre"][1] == pytest.approx(2.6, abs=0.1)


def test_assemble_builds_named_measured_scene(room_ctx):
    ctx = dict(room_ctx)
    ctx["mpu"] = 1.0
    scene = convert.assemble(ctx)
    names = [a["name"] for a in scene["actors"]]
    assert len(names) == len(set(names))
    assert not any(n.lower() in ("custom", "da3") or "DA3" in n for n in names)
    inv = scene["video2stage"]["inventory"]
    assert {i["matched"] for i in inv} <= {"library", "box", "generated"}
    assert scene["video2stage"]["interior"] and scene["environment"].get("sky") == "none"
    assert not any(a.get("procedural") for a in scene["actors"])   # nothing invented inside a room
    shelf = next(a for a in scene["actors"] if a.get("source", {}).get("mask_ref") == "shelf")
    assert shelf["kind"] == "custom" and shelf["recipe"]["name"] == "shelf"
    assert shelf["source"]["dims_m"][1] == pytest.approx(1.9, abs=0.12)
    assert scene["video2stage"]["unexplained_share"] < 0.1


def test_a_carried_box_moves_and_is_keyed(tmp_path):
    ctx = S.build(_room(dynamic_box=True), str(tmp_path), pw=160, sample_every=4)
    measure.measure(ctx)
    assert ctx["layout"]["objects"]["box"]["moving"]
    ctx["mpu"] = 1.0
    scene = convert.assemble(ctx)
    box = next(a for a in scene["actors"] if a.get("source", {}).get("mask_ref") == "box")
    assert len(box["keys"]) >= 2
    xs = [k["position"][0] for k in box["keys"]]
    assert xs[0] > xs[-1] + 0.6


def test_movers_headings_follow_a_reversing_car():
    t = np.linspace(0, 1, 40)
    ease = (1 - np.cos(np.linspace(0, np.pi, 20))) / 2              # drives up, slows to a stop ...
    fwd = np.stack([np.zeros(20), np.zeros(20), 5 * ease], 1)
    back = np.stack([3 * ease, np.zeros(20), 5 - 2 * ease], 1)        # ... then reverses out
    pos = np.concatenate([fwd, back])
    h = movers.headings(pos, 0.0, vehicle=True)
    assert abs(h[5]) < 5                                            # nose along +Z
    assert abs(((h[30] - h[5]) + 180) % 360 - 180) < 60             # reversing: the nose did not spin round
    keep = movers.simplify(list(range(40)), pos, h)
    assert 2 < len(keep) < 40 and keep[0] == 0 and keep[-1] == 39
    _ = t


def test_person_kind_whole_words():
    assert convert.person_kind("man in a leather jacket") == "man"
    assert convert.person_kind("man in a feather hat, other side") == "man"
    assert convert.person_kind("runner in weather gear") == "man"
    assert convert.person_kind("woman in a yellow sweater") == "woman"
    assert convert.person_kind("young girl") == "child"


def test_colour_words_and_names():
    assert convert.colour_word("#a3221e") == "red"
    assert convert.colour_word("#1a1a1c") == "black"
    assert convert.nice_name({"name": "", "kind": "sedan", "colour": "#1a1a1c"}) == "Black sedan"
    assert convert.nice_name({"name": "custom", "kind": "box", "colour": None}) == "Box"
    actors = [{"name": "Tree"}, {"name": "Tree"}, {"name": "Sofa"}]
    convert.dedupe_names(actors)
    assert [a["name"] for a in actors] == ["Tree 1", "Tree 2", "Sofa"]


def test_library_fit_and_measured_recipe():
    ids = set()
    rec = {"id": "c", "kind": "chair", "name": "blue chair", "colour": "#3e5f8a", "dims": [0.48, 0.88, 0.52],
           "centre": [1, 0.44, 2], "yaw_deg": 90, "grounded": True}
    a, m = convert.object_actor(rec, 1.0, ids)
    assert m == "library" and a["kind"] == "chair" and a["height_m"] == pytest.approx(0.88)
    rec2 = dict(rec, id="d", dims=[1.5, 0.88, 0.5])                  # a bench-wide 'chair': not the library chair
    a2, m2 = convert.object_actor(rec2, 1.0, ids)
    assert m2 == "box" and a2["recipe"]["size_m"] == [1.5, 0.88, 0.5] and a2["recipe"]["name"] == "chair"
