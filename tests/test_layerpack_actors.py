"""Add All Actors: one layer per stage actor from the ID pass (riders separate from their mounts).

Run:  cd tests && python -m pytest test_layerpack_actors.py -q
"""
import json
import os
import sys

import pytest

torch = pytest.importorskip("torch")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soundstage.layerpack import LayerPack, Layer, export_pack  # noqa: E402
from soundstage.layerpack.actors import actor_layers  # noqa: E402

N, H, W = 4, 32, 64          # stage size
FN, FH, FW = 6, 64, 128      # final frames: bigger and retimed
SCENE = {
    "actors": [
        {"id": "horse_a", "name": "Horse A", "kind": "horse"},
        {"id": "horse_b", "name": "Horse B", "kind": "horse"},
        {"id": "man", "name": "Man", "kind": "man", "mount_id": "horse_a", "mount_at": 0},
        {"id": "woman", "name": "Woman", "kind": "woman", "mount_id": "horse_b"},
        {"id": "ghost", "name": "Off Screen", "kind": "man"},
    ],
    "id_colors": {"horse_a": [255, 0, 0], "horse_b": [0, 255, 0], "man": [0, 0, 255], "woman": [255, 255, 0],
                  "ghost": [0, 255, 255]},
}


def _id_and_depth():
    idp = torch.zeros(N, H, W, 3)
    dep = torch.zeros(N, H, W, 3)
    idp[:, 16:30, 4:24] = torch.tensor([1.0, 0, 0])    # Horse A, near (depth 0.8)
    dep[:, 16:30, 4:24] = 0.8
    idp[:, 6:16, 8:18] = torch.tensor([0, 0, 1.0])     # Man riding Horse A, just above it
    dep[:, 6:16, 8:18] = 0.8
    idp[:, 18:30, 36:60] = torch.tensor([0, 1.0, 0])   # Horse B, farther (depth 0.4)
    dep[:, 18:30, 36:60] = 0.4
    idp[:, 8:18, 42:52] = torch.tensor([1.0, 1.0, 0])  # Woman riding Horse B
    dep[:, 8:18, 42:52] = 0.4
    idp[:, 9, 8] = torch.tensor([0.1, 0.0, 0.95])      # antialiased edge pixel: still the rider's
    return idp, dep


def test_one_layer_per_actor_riders_separate():
    idp, dep = _id_and_depth()
    frames = torch.rand(FN, FH, FW, 3)
    layers = actor_layers(SCENE, idp, frames, depth=dep, grow=0, feather=0)
    names = [l["name"] for l in layers]
    assert names[0] == "background" and "Off Screen" not in names           # never visible -> skipped
    assert sorted(names[1:]) == ["Horse A", "Horse B", "Man", "Woman"]
    # far -> near, each rider right above its mount
    assert names[1:] == ["Horse B", "Woman", "Horse A", "Man"]
    zs = [l["z"] for l in layers]
    assert zs == sorted(zs) and zs[0] == 0
    by = {l["name"]: l for l in layers}
    for l in layers:
        assert l["mask"].shape == (FN, FH, FW)                             # resized + retimed to the final
    man, horse = by["Man"]["mask"].float(), by["Horse A"]["mask"].float()
    assert man[0, 22, 26] == 1 and horse[0, 22, 26] == 0                    # rider pixels (stage y 11, x 13)
    assert horse[0, 46, 26] == 1 and man[0, 46, 26] == 0                    # horse pixels (stage y 23)
    assert by["Man"]["mount_id"] == "horse_a" and by["Man"]["id"] == "man"
    total = sum(l["mask"].float() for l in layers)                          # partition without grow/feather
    assert torch.allclose(total, torch.ones_like(total))


def test_stage_order_without_depth_and_grow():
    idp, _ = _id_and_depth()
    layers = actor_layers(SCENE, idp, torch.rand(N, H, W, 3), grow=2, feather=1)
    names = [l["name"] for l in layers]
    assert names == ["background", "Horse A", "Man", "Horse B", "Woman"]     # stage order, riders after mounts
    man = layers[2]["mask"].float()
    assert man[0, 5, 12] > 0                                                 # grown 1 px above the rider


def test_no_id_colours_is_a_clear_error():
    with pytest.raises(ValueError, match="no ID colours"):
        actor_layers({"actors": []}, torch.zeros(1, 4, 4, 3), torch.zeros(1, 4, 4, 3))


def test_pack_from_actor_layers_exports_every_layer(tmp_path):
    idp, dep = _id_and_depth()
    frames = torch.rand(N, H, W, 3)
    pack = LayerPack(shot="Horse", camera=json.dumps({"position": [0, 1.6, 8], "target": [0, 1, 0], "focal_mm": 35}))
    for e in actor_layers(SCENE, idp, frames, depth=dep):
        pack = pack.add_layer(Layer(name=e["name"], images=frames, mask=e["mask"], z=e["z"], kind=e["kind"],
                                    source_id=e["id"]))
    res = export_pack(pack, str(tmp_path), timestamp="t", prores=False, comp_preview=False)
    names = [l["name"] for l in res["manifest"]["layers"]]
    assert names == ["background", "Horse B", "Woman", "Horse A", "Man"]
    root = res["root"]
    for rel in ("dcc/ae/build_comp.jsx", "dcc/nuke/build_nuke.py", "dcc/blender/build_blender_scene.py"):
        text = open(os.path.join(root, rel)).read()
        for nm in names:
            assert json.dumps(nm) in text, (rel, nm)
