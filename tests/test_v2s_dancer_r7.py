"""Video → 3D street-dance fixes, review round 7 (invented data only, no GPU):

1 a cut-short or reworded wardrobe placeholder is an echo, and never replaces a real read in merge_reads or
  enrich_breakdown
4 her own pixels leave the scan in every probe pose at 4 m (arms down, arms spread, a pointed-toe kick, joints a few
  pixels off): wider at the shoulders, neck, head and feet, and virtual toe points past the ankles
Run:  python -m pytest tests/test_v2s_dancer_r7.py -q
"""
import os
import sys

import numpy as np  # noqa: F401
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from soundstage.video2stage import vlm  # noqa: E402
from test_v2s_dancer_r3 import _person  # noqa: E402

FRAGMENTS = ["every garment with its colour, pattern and length e.g.", "every garment with colour, pattern and length",
             "every garment, colour, pattern, length", "people only", "<...>", "People only.",
             "<people only: every garment with its colour, pattern and length, e.g. an orange cable-knit"]


# ------------------------------------------------------------------------------------------------ 1 placeholder
@pytest.mark.parametrize("frag", FRAGMENTS)
def test_a_cut_short_or_reworded_placeholder_is_an_echo(frag):
    assert vlm.wardrobe_echo(frag)
    assert vlm.wardrobe_of({"wardrobe": frag}) == ""
    assert vlm.parse_reply(_person(frag))["objects"][0]["wardrobe"] == ""


@pytest.mark.parametrize("real", ["red hoodie, blue jeans", "patterned shirt and long jeans", "black dress",
                                  "brown corduroy trousers", "white tee with a few words printed on it, black jeans"])
def test_real_reads_are_not_placeholder_fragments(real):
    assert not vlm.wardrobe_echo(real)


def _obj(wardrobe, bbox=(430, 180, 570, 900)):
    return {"label": "woman dancing", "kind": "person", "color": "#e0b030", "bbox": list(bbox), "facing": "",
            "moving": True, "wardrobe": wardrobe}


@pytest.mark.parametrize("frag", FRAGMENTS)
def test_an_end_frame_placeholder_never_replaces_a_real_first_frame_read(frag):
    first = {"setting": "street", "time": "day", "camera": {"height_m": 1.5}, "objects": [_obj("red hoodie, blue jeans")],
             "set": []}
    last = {"objects": [_obj(frag, (440, 180, 580, 900))]}       # given raw, as a caller may (not through parse_reply)
    m = vlm.merge_reads(first, last)
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"   # 8f04bf1: the longer placeholder won
    # the other way round: a placeholder first, a real read at the end, the real read is kept
    m = vlm.merge_reads(dict(first, objects=[_obj(frag)]), {"objects": [_obj("red hoodie, blue jeans")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"


def test_a_garment_read_beats_a_longer_read_that_names_no_garment():
    first = {"setting": "", "time": "", "camera": {}, "objects": [_obj("red hoodie")], "set": []}
    m = vlm.merge_reads(first, {"objects": [_obj("a bright colourful outfit for dancing in the street")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie"
    m = vlm.merge_reads(first, {"objects": [_obj("red hoodie, blue jeans")]})
    assert m["objects"][0]["wardrobe"] == "red hoodie, blue jeans"   # the fuller garment read still wins


@pytest.mark.parametrize("frag", FRAGMENTS + [vlm.WARDROBE_EXAMPLE])
def test_an_inventory_placeholder_never_replaces_a_real_breakdown_read(frag):
    bd = {"setting": "street", "time": "day", "camera": {}, "set": [],
          "objects": [dict(_obj("red hoodie, blue jeans"), bbox_start=[430, 180, 570, 900])]}
    inv = {"items": [{"name": "woman", "kind": "person", "bbox": [430, 180, 570, 900], "wardrobe": frag}],
           "surfaces": []}
    assert vlm.enrich_breakdown(bd, inv)["objects"][0]["wardrobe"] == "red hoodie, blue jeans"
    inv["items"][0]["wardrobe"] = "red zip-up hoodie with white drawstrings, light blue jeans"
    assert vlm.enrich_breakdown(bd, inv)["objects"][0]["wardrobe"].startswith("red zip-up")


# ------------------------------------------------------------------------------------------------ 4 probe poses
from soundstage.video2stage import pipeline, scanroute  # noqa: E402
from soundstage.video2stage import wardrobe as W  # noqa: E402

TAKE = {"frames": 1, "source_frames": [0], "focal_px": 500.0, "body": [[0]]}


def _pose(kind, cx=200, bot=380, H=340):
    """COCO-18 joints (pixels) of an invented performer, H px tall, soles at `bot`: arms down, arms spread at
    shoulder level, or a side kick with the toe pointed along the shin."""
    y = lambda f: bot - f * H                                     # noqa: E731
    J = {0: (cx, y(.93)), 1: (cx, y(.82)), 2: (cx - 30, y(.81)), 5: (cx + 30, y(.81)),
         8: (cx - 16, y(.52)), 11: (cx + 16, y(.52)), 9: (cx - 18, y(.28)), 10: (cx - 18, y(.04))}
    if kind == "spread":
        J.update({3: (cx - 85, y(.81)), 4: (cx - 140, y(.81)), 6: (cx + 85, y(.81)), 7: (cx + 140, y(.81))})
    else:
        J.update({3: (cx - 38, y(.64)), 4: (cx - 40, y(.47)), 6: (cx + 38, y(.64)), 7: (cx + 40, y(.47))})
    if kind == "kick":
        J.update({12: (cx + 70, y(.36)), 13: (cx + 135, y(.22))})
    else:
        J.update({12: (cx + 18, y(.28)), 13: (cx + 18, y(.04))})
    return J


def _render(J, kind, H=340, size=400):
    """Her silhouette drawn round the joints: a torso, broad shoulders (deltoids and trapezius), neck, head, limbs,
    hands past the wrists and feet past the ankles (sideways when standing, along the shin when the toe is pointed)."""
    import cv2
    m = np.zeros((size, size), np.uint8)
    P = lambda k: tuple(int(round(v)) for v in J[k])             # noqa: E731
    th = lambda f: max(1, int(round(f * H)))                     # noqa: E731
    cv2.fillConvexPoly(m, np.array([P(2), P(5), P(11), P(8)]), 1)
    for k in (2, 5):
        cv2.circle(m, P(k), th(.05), 1, -1)
    cv2.line(m, P(1), P(2), 1, th(.08))
    cv2.line(m, P(1), P(5), 1, th(.08))
    cv2.line(m, P(0), P(1), 1, th(.07))
    cv2.ellipse(m, (P(0)[0], P(0)[1] - th(.02)), (th(.045), th(.065)), 0, 0, 360, 1, -1)
    for a, b, t in ((2, 3, .045), (3, 4, .035), (5, 6, .045), (6, 7, .035), (8, 9, .07), (9, 10, .05),
                    (11, 12, .07), (12, 13, .05)):
        cv2.line(m, P(a), P(b), 1, th(t))
    for e, wj in ((3, 4), (6, 7)):
        a, b = np.array(J[e], float), np.array(J[wj], float)
        cv2.line(m, P(wj), tuple(int(v) for v in b + 0.45 * (b - a)), 1, th(.03))
    for k, kn in ((10, 9), (13, 12)):
        a, b = np.array(J[kn], float), np.array(J[k], float)
        tip = b + 0.55 * (b - a) if (kind == "kick" and k == 13) else b + np.array([(-1 if k == 10 else 1) * .12 * H,
                                                                                     .03 * H])
        cv2.line(m, P(k), tuple(int(v) for v in tip), 1, th(.035))
    return m.astype(bool)


def _pose_scene(kind, off=0.0, z=4.0, gap=0.5):
    J = _pose(kind)
    her = _render(J, kind)
    d = np.full(her.shape, 40.0, np.float32)
    d[150:, :] = z + gap                                           # a slab behind her from the chest down
    d[her] = z + 0.05 * np.random.default_rng(3).random(int(her.sum()))
    uv = np.full((18, 2), np.nan)
    for k, v in J.items():
        uv[k] = v
    if off:                                                        # the joints a few pixels off
        uv[:14] += np.random.default_rng(7).uniform(-off, off, (14, 2))
    return d, uv, her


@pytest.mark.parametrize("kind, off", [("down", 0), ("spread", 0), ("kick", 0), ("kick", 4), ("spread", 4)],
                         ids=["arms down", "arms spread", "pointed-toe kick", "kick, joints 4 px off",
                              "spread, joints 4 px off"])
def test_every_probe_pose_at_4_m_leaves_the_scan_whole(monkeypatch, kind, off):
    pytest.importorskip("cv2")
    d, uv, her = _pose_scene(kind, off)
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    ok = np.isfinite(uv).all(1)
    (x0, y0), (x1, y1) = uv[ok].min(0) * 2.5, uv[ok].max(0) * 2.5  # the read's box: her joints, no margin
    e = {"kind": "person", "label": "woman dancing", "bbox_start": [x0, y0, x1, y1], "bbox_end": [x0, y0, x1, y1]}
    cut = scanroute.without_people(d, scanroute.people_masks({"objects": [e]}, [d], [0.0], 1.0, take=TAKE), 0)
    slab = d == 4.5
    assert np.isfinite(cut[her]).sum() == 0                        # her shoulders, neck, crown, hands and feet too
    assert np.isnan(cut[slab]).sum() == 0                          # the slab behind her stays in the scan
    assert np.isfinite(cut[~her & ~slab]).all()                    # and so does the far background round her head


def test_the_joint_box_reaches_her_pointed_toe(monkeypatch):
    d, uv, her = _pose_scene("kick")
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    _, jb = scanroute.joint_box(TAKE, 0, (400, 400))
    assert jb[2] >= np.flatnonzero(her.any(0))[-1] + 1             # the toe past the ankle is inside her box


# ------------------------------------------------------------------------------------------------ 2 + 5 the padding
from soundstage.video2stage import backdrop as BD  # noqa: E402
from test_v2s_dancer_r3 import _stage_with_her  # noqa: E402
from test_v2s_dancer_r6 import _her_joints, _read, _scan_path  # noqa: E402


def _bystander(d):
    """A bystander leaning on the 30 m back wall at the left of frame (head, body, legs a little off the wall)."""
    by = np.zeros(d.shape, bool)
    by[126:160, 60:90] = True
    by[160:300, 40:110] = True
    by[300:423, 45:70] = True
    by[300:423, 80:105] = True
    d[by] = 29.6
    return by


def _wall_cut(cut, d0):
    return int(np.isnan(cut[d0 == 30.0]).sum())


def test_a_bystander_on_the_back_wall_does_not_open_his_box(monkeypatch):
    d, _ = _stage_with_her()
    _bystander(d)
    bd = _read([250, 200, 390, 420], [16, 126, 133, 423])
    st, notes = _scan_path(monkeypatch, d, bd, None)
    assert st["dropped"] == ["Wall"], notes                         # 8f04bf1: Wall kept and worded
    assert st["worded"] == ["Crate"], notes
    masks = scanroute.people_masks(bd, [d], [0.0], 1.0)
    cut = scanroute.without_people(d, masks, 0, boxes=scanroute.people_boxes(bd, (640, 480), [0.0], 1.0))
    one = scanroute.without_people(d, masks, 0)                     # no padding at all: his loose mask alone
    assert _wall_cut(cut, d) <= _wall_cut(one, d) + 2000            # 8f04bf1: 103,020 (17,664 for the mask alone)


def test_a_hallucinated_box_over_the_background_does_not_open_while_the_take_tracks_her(monkeypatch):
    pytest.importorskip("cv2")
    d, _ = _stage_with_her()
    uv = _her_joints()
    monkeypatch.setattr(pipeline.performer, "sam_2d", lambda t, k, size: uv)
    bd = _read([250, 200, 390, 420], [430, 40, 560, 300])           # her, and a box over the bare wall
    st, notes = _scan_path(monkeypatch, d, bd, TAKE)
    assert st["dropped"] == ["Wall"] and st["worded"] == ["Crate"], notes
    hers = set()
    boxes = scanroute.people_boxes(bd, (640, 480), [0.0], 1.0, take=TAKE, hers=hers)
    assert hers == {"p0"}
    masks = scanroute.people_masks(bd, [d], [0.0], 1.0, take=TAKE)
    cut = scanroute.without_people(d, masks, 0, boxes=boxes, hers=hers)
    x0, y0 = (int(np.floor(v)) for v in boxes["p1"][:2])
    x1, y1 = (int(np.ceil(v)) for v in boxes["p1"][2:])
    outside = np.ones(d.shape, bool)
    outside[y0:y1, x0:x1] = False
    outside[150:440, 200:440] = False                               # round her
    assert np.isnan(cut[outside]).sum() == 0                        # nothing past the hallucinated box goes
