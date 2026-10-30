"""Rung 5: one Layer Pack layer per stage actor, automatically.

The base App cuts exactly three layers (background matte + "object 1" + "object 2", nodes 9067-9073),
so any extra actor (e.g. riders on horses) got no layer. This replaces those three matte/AddLayer
chains with one SoundstageLayerPackAddAll:
    Start (9070) -> Add All Actors -> depth AOV (9075) -> Gate rung 5 (9076) -> Export (9077)
"""

OLD_CHAINS = [9067, 9068, 9069, 9071, 9072, 9073]  # Matte bg/1/2 + AddLayer bg/1/2


def apply(g):
    if any(n["type"] == "SoundstageLayerPackAddAll" for n in g.nodes.values()):
        return
    pos = list(g.nodes[9071]["pos"]) if 9071 in g.nodes else [480, 3846]
    for nid in OLD_CHAINS:
        if nid in g.nodes:
            g.remove_node(nid)
    nid = g.add_node(
        "SoundstageLayerPackAddAll", pos,
        inputs=[("pack", "SOUNDSTAGE_LAYERPACK"), ("images", "IMAGE"), ("id_pass", "IMAGE"),
                ("scene_json", "STRING"), ("depth", "IMAGE"), ("grow", "INT", "grow"), ("feather", "INT", "feather")],
        outputs=[("pack", "SOUNDSTAGE_LAYERPACK"), ("layers", "STRING")],
        widgets=[6, 4], title="Layers: every actor", size=(320, 200))
    g.link(9070, "pack", nid, "pack")
    g.link(9066, 0, nid, "images", "IMAGE")        # final frames
    g.link(9045, 7, nid, "id_pass", "IMAGE")       # stage ID pass
    g.link(9045, 6, nid, "scene_json", "STRING")
    g.link(9045, 1, nid, "depth", "IMAGE")         # stage depth (orders the layers far -> near)
    g.link(nid, "pack", 9075, "pack")
