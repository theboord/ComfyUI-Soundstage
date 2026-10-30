"""Final-frame mattes: SAM track assignment by IoU, clay fallback, soft-alpha edges, background rebuild."""
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from soundstage.layerpack import final_mattes as FM  # noqa: E402


def _box(n, h, w, x0, x1):
    m = torch.zeros(n, h, w)
    m[:, 10:30, x0:x1] = 1
    return m


def test_prompts_for_scene():
    sc = {"actors": [{"kind": "man"}, {"kind": "woman"}, {"kind": "horse"}, {"kind": "crate"}]}
    assert FM.prompts_for(sc) == ["person", "horse"]


def test_assign_and_refine_moves_matte_to_track():
    n, h, w = 4, 40, 80
    clay_a = _box(n, h, w, 10, 20)           # actor A's clay silhouette
    clay_b = _box(n, h, w, 50, 60)
    track_b = _box(n, h, w, 52, 64)          # LTX drew B a little to the right
    track_a = _box(n, h, w, 12, 22)
    track_a[2] = 0                           # SAM loses A on frame 2
    objs = torch.stack([track_b, track_a], 1)  # track order differs from actor order
    scene = {"actors": [{"id": "a", "kind": "man"}, {"id": "b", "kind": "horse"}, {"id": "c", "kind": "crate"}]}
    entries = [{"id": "background", "kind": "background", "mask": torch.ones(n, h, w).half()},
               {"id": "a", "kind": "character", "mask": clay_a.half()},
               {"id": "b", "kind": "character", "mask": clay_b.half()},
               {"id": "c", "kind": "character", "mask": _box(n, h, w, 70, 75).half()}]
    out = {e["id"]: e for e in FM.refine(entries, objs, scene, grow=0, feather=0)}
    assert out["b"]["mask"][0, 20, 62] == 1 and out["b"]["mask"][0, 20, 51] == 0   # follows the track, not the clay
    assert "track 0" in out["b"]["matte"]
    assert "track 1" in out["a"]["matte"] and "clay on 1 frames" in out["a"]["matte"]
    assert out["a"]["mask"][2, 20, 11] == 1                                      # lost frame -> clay
    assert out["c"]["matte"] == "stage ID pass"                                   # a crate keeps the clay
    bg = out["background"]["mask"].float()
    assert bg[0, 20, 62] == 0 and bg[0, 5, 5] == 1


def test_soft_alpha_edges_inside_track_region():
    n, h, w = 1, 40, 80
    track = _box(n, h, w, 30, 50)
    alpha = torch.zeros(n, h, w)
    alpha[:, 8:32, 28:52] = 0.5              # soft halo just outside the hard track
    alpha[:, 0:5, 0:5] = 1.0                 # unrelated foreground far away
    scene = {"actors": [{"id": "a", "kind": "man"}]}
    entries = [{"id": "background", "kind": "background", "mask": torch.ones(n, h, w).half()},
               {"id": "a", "kind": "character", "mask": track.half()}]
    out = {e["id"]: e for e in FM.refine(entries, track[:, None], scene, grow=2, feather=0, alpha=alpha)}
    m = out["a"]["mask"].float()
    assert m[0, 20, 40] == 1                 # solid core
    assert 0.2 < m[0, 9, 29] < 0.8           # soft edge from BiRefNet
    assert m[0, 2, 2] == 0                   # other foreground not pulled in


def test_untracked_actor_gets_soft_edge_without_stealing_its_mount():
    n, h, w = 1, 40, 80
    horse = torch.zeros(n, h, w); horse[:, 20:35, 30:50] = 1
    rider_clay = torch.zeros(n, h, w); rider_clay[:, 8:24, 36:44] = 1
    alpha = torch.zeros(n, h, w); alpha[:, 6:35, 30:50] = 0.9      # BiRefNet: rider + horse are foreground
    scene = {"actors": [{"id": "h", "kind": "horse"}, {"id": "r", "kind": "man", "mount_id": "h"}]}
    entries = [{"id": "background", "kind": "background", "mask": torch.ones(n, h, w).half()},
               {"id": "h", "kind": "character", "mask": horse.half()},
               {"id": "r", "kind": "character", "mask": rider_clay.half()}]
    out = {e["id"]: e for e in FM.refine(entries, horse[:, None], scene, grow=0, feather=0, alpha=alpha)}
    r = out["r"]["mask"].float()
    assert out["r"]["matte"].startswith("BiRefNet")
    assert r[0, 12, 40] > 0.5          # the rider
    assert r[0, 30, 40] == 0           # not the horse under it
