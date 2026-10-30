"""Small helpers for editing the Soundstage App workflow (UI format) from scripts.

Each department adds its part to the App with a module in tools/app_build/ exposing
`apply(g: Graph) -> None`; tools/app_build/build.py runs them in order on a copy of
example_workflows/Soundstage_App.json. Use these helpers so link ids, output link lists,
widget-to-input conversion and the App panel (extra.linearData) stay consistent.

Key nodes in the base App (ids are stable):
  9045 SoundstageStage   outputs: 0 clay, 1 depth, 2 first_clay, 3 first_depth, 4 fps, 5 frames,
                                  6 scene_json, 7 id_pass, 8 color, 9 first_color
  9079 SoundstageLook    outputs: 0 still_prompt, 1 still_negative, 2 motion_prompt, 3 look_json
  9059 SoundstageStep    output 0 step (feeds every SoundstageGate's `step`)
  9057 VAEDecode         the Krea look still (IMAGE) -> 9061 Gate rung 2 -> 9058 PreviewImage "Rung 2 · Look still"
  9002 L2R stage-1 subgraph (input `look_still` = the look still)
  9062 draft decode      VIDEO -> 9064 Gate rung 3 -> 9063 SaveVideo "Rung 3 · Motion draft"
  5518 final decode      VIDEO -> 9065 Gate rung 4 -> 4852 SaveVideo "Rung 4 · Final"
  9066 GetVideoComponents of the final (0 images, 1 audio, 2 fps)
  9076 Gate rung 5 -> 9077 SoundstageLayerPackExport
Output nodes titled "Rung N · …" feed the Ladder viewer in the stage widget.
Put any new output behind a SoundstageGate so lower rungs never run it.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path


class Graph:
    def __init__(self, data: dict):
        self.w = data
        self.nodes = {n["id"]: n for n in data["nodes"]}
        self.links = {l[0]: l for l in data["links"]}

    # ---------------------------------------------------------------- io
    @classmethod
    def load(cls, path) -> "Graph":
        return cls(json.loads(Path(path).read_text()))

    def save(self, path) -> None:
        self.w["last_node_id"] = max(self.nodes)
        self.w["last_link_id"] = max(self.links) if self.links else 0
        Path(path).write_text(json.dumps(self.w, indent=1))

    @property
    def graph_id(self) -> str:
        return self.w.get("id", "")

    # ---------------------------------------------------------------- nodes
    def add_node(self, type_: str, pos, inputs=(), outputs=(), widgets=(), title=None, size=(320, 160)) -> int:
        """inputs: [(name, type)] socket inputs, or (name, type, widget_name) for a widget that can take a link.
        outputs: [(name, type)]. widgets: widgets_values in schema order."""
        nid = max(self.nodes) + 1
        node = {"id": nid, "type": type_, "pos": list(pos), "size": list(size), "flags": {}, "order": 0, "mode": 0,
                "inputs": [], "outputs": [], "properties": {"Node name for S&R": type_},
                "widgets_values": list(widgets)}
        for spec in inputs:
            name, typ = spec[0], spec[1]
            inp = {"localized_name": name, "name": name, "type": typ, "link": None}
            if len(spec) > 2:
                inp["widget"] = {"name": spec[2]}
            node["inputs"].append(inp)
        for name, typ in outputs:
            node["outputs"].append({"localized_name": name, "name": name, "type": typ, "links": None})
        if title:
            node["title"] = title
        self.w["nodes"].append(node)
        self.nodes[nid] = node
        return nid

    def remove_node(self, nid: int) -> None:
        for l in [l for l in self.links.values() if nid in (l[1], l[3])]:
            self.unlink(l[0])
        self.w["nodes"] = [n for n in self.w["nodes"] if n["id"] != nid]
        self.nodes.pop(nid)

    def _slot(self, nid, slot, kind):
        items = self.nodes[nid][kind]
        if isinstance(slot, int):
            return slot
        for i, it in enumerate(items):
            if it["name"] == slot:
                return i
        raise KeyError(f"node {nid} has no {kind[:-1]} named {slot!r}: {[it['name'] for it in items]}")

    def ensure_input(self, nid: int, name: str, typ: str, widget: bool = True) -> int:
        """Make sure a (widget) input socket exists so it can be linked; returns its slot."""
        for i, it in enumerate(self.nodes[nid]["inputs"]):
            if it["name"] == name:
                return i
        inp = {"localized_name": name, "name": name, "type": typ, "link": None}
        if widget:
            inp["widget"] = {"name": name}
        self.nodes[nid]["inputs"].append(inp)
        return len(self.nodes[nid]["inputs"]) - 1

    # ---------------------------------------------------------------- links
    def link(self, src: int, src_slot, dst: int, dst_slot, typ: str | None = None) -> int:
        s = self._slot(src, src_slot, "outputs")
        d = self._slot(dst, dst_slot, "inputs")
        old = self.nodes[dst]["inputs"][d].get("link")
        if old is not None:
            self.unlink(old)
        lid = (max(self.links) if self.links else 0) + 1
        typ = typ or self.nodes[src]["outputs"][s]["type"]
        l = [lid, src, s, dst, d, typ]
        self.w["links"].append(l)
        self.links[lid] = l
        o = self.nodes[src]["outputs"][s]
        o["links"] = (o.get("links") or []) + [lid]
        self.nodes[dst]["inputs"][d]["link"] = lid
        return lid

    def unlink(self, lid: int) -> None:
        l = self.links.pop(lid)
        self.w["links"].remove(l)
        o = self.nodes[l[1]]["outputs"][l[2]]
        o["links"] = [x for x in (o.get("links") or []) if x != lid] or None
        self.nodes[l[3]]["inputs"][l[4]]["link"] = None

    def source_of(self, dst: int, dst_slot):
        """(src_id, src_slot) feeding an input, or None."""
        lid = self.nodes[dst]["inputs"][self._slot(dst, dst_slot, "inputs")].get("link")
        return (self.links[lid][1], self.links[lid][2]) if lid is not None else None

    def consumers(self, src: int, src_slot) -> list[tuple[int, int]]:
        s = self._slot(src, src_slot, "outputs")
        return [(l[3], l[4]) for l in self.links.values() if l[1] == src and l[2] == s]

    def gate(self, value_src: int, value_slot, rung: int, pos) -> int:
        """Insert a SoundstageGate for `rung` fed by the Step node; returns the gate id (output 0 = value)."""
        typ = self.nodes[value_src]["outputs"][self._slot(value_src, value_slot, "outputs")]["type"]
        gid = self.add_node("SoundstageGate", pos, inputs=[("step", "INT"), ("rung", "INT", "rung"), ("value", "*")],
                            outputs=[("value", typ)], widgets=[rung], title=f"Gate · rung {rung}", size=(220, 80))
        self.link(9059, 0, gid, "step", "INT")
        self.link(value_src, value_slot, gid, "value", typ)
        return gid

    # ---------------------------------------------------------------- App panel
    def expose(self, nid: int, widget: str, after: str | None = None) -> None:
        """Show a node widget in the App panel (optionally right after another exposed widget key)."""
        ld = self.w.setdefault("extra", {}).setdefault("linearData", {"inputs": [], "outputs": []})
        key = [f"{self.graph_id}:{nid}:{widget}", widget]
        if key in ld["inputs"]:
            return
        if after:
            idx = next((i for i, k in enumerate(ld["inputs"]) if k[0].endswith(after)), None)
            if idx is not None:
                ld["inputs"].insert(idx + 1, key)
                return
        ld["inputs"].append(key)

    def show_output(self, nid: int) -> None:
        ld = self.w.setdefault("extra", {}).setdefault("linearData", {"inputs": [], "outputs": []})
        if str(nid) not in ld["outputs"]:
            ld["outputs"].append(str(nid))

    def copy(self) -> "Graph":
        return Graph(copy.deepcopy(self.w))
