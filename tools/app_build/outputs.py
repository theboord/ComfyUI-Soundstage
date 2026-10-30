"""Make every rung's result visible in the App panel, in ladder order, plus where the Layer Pack landed."""


def apply(g):
    # Rung 5: show the Layer Pack folder path next to its preview (PreviewAny shows text in App mode).
    export = 9077
    if not any(n["type"] == "PreviewAny" and n.get("title", "").startswith("Rung 5 · Layer Pack folder")
               for n in g.nodes.values()):
        x, y = g.nodes[export]["pos"]
        pid = g.add_node("PreviewAny", (x + 360, y), inputs=[("source", "*")], outputs=[],
                         title="Rung 5 · Layer Pack folder", size=(300, 120))
        g.link(export, "folder", pid, "source", "STRING")
        g.show_output(pid)

    # Rung 1: the whole previz as a playable video (colour pass, the clay/depth conditioning drives the
    # renders) so blocking, timing and the camera move can be checked and fixed on the stage before any
    # GPU time is spent. CreateVideo + SaveVideo are cheap; they only re-run when the stage changes.
    if not any(n.get("title", "").startswith("Rung 1 · Previz video") for n in g.nodes.values()):
        x, y = g.nodes[9060]["pos"]
        import copy as _copy
        ref_cv, ref_sv = g.nodes[9046], g.nodes[9063]  # the App's own CreateVideo / SaveVideo: same widget layout
        cv = g.add_node("CreateVideo", (x, y + 260), outputs=[("VIDEO", "VIDEO")], widgets=_copy.deepcopy(ref_cv.get("widgets_values", [])),
                        title="Previz → video", size=(260, 100))
        g.nodes[cv]["inputs"] = [{**_copy.deepcopy(i), "link": None} for i in ref_cv["inputs"]]
        g.link(9045, 8, cv, "images", "IMAGE")  # colour pass
        g.link(9045, 4, cv, "fps", "FLOAT")
        wv = _copy.deepcopy(ref_sv.get("widgets_values", []))
        if wv and isinstance(wv[0], str):
            wv[0] = "soundstage/previz"
        sv = g.add_node("SaveVideo", (x + 300, y + 260), outputs=[], widgets=wv, title="Rung 1 · Previz video", size=(320, 260))
        g.nodes[sv]["inputs"] = [{**_copy.deepcopy(i), "link": None} for i in ref_sv["inputs"]]
        g.link(cv, "VIDEO", sv, "video", "VIDEO")
        g.show_output(sv)

    # Ladder order: Stage frame, Look still, Draft, Final (+ any variants), Layers.
    ld = g.w["extra"]["linearData"]

    def rung(nid):
        title = g.nodes.get(int(nid), {}).get("title", "")
        return (int(title.split()[1]) if title.startswith("Rung ") and title.split()[1].isdigit() else 9, title)

    ld["outputs"] = sorted(dict.fromkeys(ld["outputs"]), key=rung)

    # App panel in process order: stage, Next, still model, touch-up, video model, sound.
    def by_title(key):
        nid = int(key[0].split(":")[1])
        node = g.nodes.get(nid, {})
        title = (node.get("title") or node.get("type", "")).lower()
        order = [("soundstagestage", 0), ("next", 1), ("still model · use", 2), ("still model (any)", 3),
                 ("use touched-up", 4), ("touch-up", 5), ("video model · use", 6), ("video model (any)", 7),
                 ("sound", 8), ("audio drives", 9)]
        rank = next((r for k, r in order if title.startswith(k) or (k == "soundstagestage" and node.get("type") == "SoundstageStage")), 50)
        return rank
    ld["inputs"] = sorted(ld["inputs"], key=by_title)  # stable: widgets of one node keep their order
