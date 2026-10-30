#!/usr/bin/env python3
"""Run a Soundstage shot headless through the Comfy SDK (Comfy API v2).

Export the shot from ComfyUI once (Workflow → Export (API), with the Soundstage App loaded and the
shot blocked), then render it from a script: any rung of the ladder, many looks in one batch, new
seeds. The same code runs against a self-hosted ComfyUI (through comfy-api-proxy), a serverless
deployment or Comfy Cloud; only COMFY_BASE_URL and COMFY_API_KEY change.

    pip install comfy-sdk comfy-api-proxy
    comfy-api-proxy start --comfyui http://127.0.0.1:8189 --port 8190   # v2 API in front of ComfyUI
    export COMFY_BASE_URL=http://127.0.0.1:8190

    # Rung 4 (final) of the exported shot
    python tools/soundstage_sdk.py shot_api.json --rung 4 --out renders/

    # The same blocking in three looks (typed looks or Look-tab JSON files), look stills only
    python tools/soundstage_sdk.py shot_api.json --rung 2 \\
        --look "Korean thriller, anamorphic, teal-orange" --look "70s New Hollywood, Kodak 5247" \\
        --look looks/noir.json --out looks_test/

The stage's clay/depth/colour passes are referenced as ComfyUI temp files, so the export is valid
until that ComfyUI restarts. Re-export after a restart (or after changing the blocking).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

try:
    import httpx
    from comfy_sdk import Comfy
    from comfy_sdk.events import OutputReady, Progress, StatusChange
except ImportError:  # pragma: no cover - guidance for a missing optional dependency
    sys.exit("This runner needs the Comfy SDK:  pip install comfy-sdk")

# Node types whose results are worth saving.
OUTPUT_TYPES = {"SaveVideo", "SaveImage", "PreviewImage", "SoundstageLayerPackExport", "PreviewAny"}


def find_nodes(graph: dict, class_type: str) -> list[str]:
    return [nid for nid, n in graph.items() if n.get("class_type") == class_type]


def load_look(arg: str) -> str:
    """A look is a Look-tab JSON file, inline JSON, or a typed description ("Korean thriller, anamorphic")."""
    p = Path(arg)
    if p.suffix == ".json" and p.exists():
        return p.read_text()
    return arg


def slug(text: str, n: int = 40) -> str:
    try:
        text = json.loads(text).get("description") or json.loads(text).get("genre") or "look"
    except (ValueError, AttributeError):
        pass
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n] or "look"


def prepare(graph: dict, rung: int | None, look: str | None, seed: int | None) -> dict:
    g = json.loads(json.dumps(graph))  # each job gets its own copy
    if rung is not None:
        steps = find_nodes(g, "SoundstageStep")
        if not steps:
            sys.exit("No 'Soundstage · Next Step' node in this workflow; --rung needs the Soundstage App graph.")
        for nid in steps:
            g[nid]["inputs"]["step"] = rung
    if look is not None:
        looks = find_nodes(g, "SoundstageLook")
        if not looks:
            sys.exit("No 'Soundstage · Look' node in this workflow; --look needs it.")
        for nid in looks:
            g[nid]["inputs"]["look"] = look
    if seed is not None:
        for n in g.values():
            for key in ("seed", "noise_seed"):
                if isinstance(n.get("inputs", {}).get(key), int):
                    n["inputs"][key] = seed
    return g


def run_one(client: Comfy, graph: dict, out_dir: Path, label: str, partner_key: str | None) -> list[Path]:
    wf = client.workflows.from_json(graph)
    job = client.submit(wf, api_key=partner_key) if partner_key else client.submit(wf)
    print(f"[{label}] job {job.id} submitted")
    last = -1
    try:
        for ev in job.events():
            if isinstance(ev, StatusChange):
                pos = f" (queue position {ev.queue_position})" if ev.queue_position is not None else ""
                print(f"[{label}] {ev.status}{pos}")
            elif isinstance(ev, Progress):
                pct = int(ev.value * 100)
                if pct >= last + 10:
                    last = pct
                    where = f" · node {ev.current_node}" if ev.current_node else ""
                    print(f"[{label}] {pct}%{where}")
            elif isinstance(ev, OutputReady):
                print(f"[{label}] output ready: {ev.output.name}")
    except (httpx.TransportError, TimeoutError) as e:  # flaky link (tunnel, Wi-Fi): the job keeps running
        print(f"[{label}] live updates dropped ({e.__class__.__name__}); polling until it finishes")
    for attempt in range(30):
        try:
            job.wait()
            break
        except (httpx.TransportError, TimeoutError):
            time.sleep(min(60, 5 * (attempt + 1)))
    job.result()  # raises JobFailed with the server's error

    saved = []
    dest = out_dir / label
    dest.mkdir(parents=True, exist_ok=True)
    for nid, node in graph.items():
        if node.get("class_type") not in OUTPUT_TYPES:
            continue
        title = (node.get("_meta") or {}).get("title", node["class_type"])
        for i, out in enumerate(job.get_outputs(nid)):
            name = f"{slug(title, 30)}_{i:02d}_{out.name}" if out.name else f"{slug(title, 30)}_{i:02d}"
            saved.append(out.to_file(dest / name))
    for p in saved:
        print(f"[{label}] saved {p}")
    return saved


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("workflow", help="API-format export of the Soundstage App with the shot blocked")
    ap.add_argument("--rung", type=int, choices=range(1, 6), metavar="1-5",
                    help="climb the ladder to this rung: 1 stage, 2 look still, 3 motion draft, 4 final, 5 layers")
    ap.add_argument("--look", action="append", help="typed look, inline Look JSON or a .json file; repeat for a batch")
    ap.add_argument("--seed", type=int, help="override every sampler seed")
    ap.add_argument("--out", default="soundstage_renders", help="output folder (default: %(default)s)")
    ap.add_argument("--partner-key", help="Comfy API key for partner (API) model nodes in the graph, if any")
    a = ap.parse_args(argv)

    graph = json.loads(Path(a.workflow).read_text())
    if "nodes" in graph and "links" in graph:
        sys.exit("That is the UI workflow format. In ComfyUI use Workflow → Export (API) and pass that file.")
    client = Comfy(client_info="soundstage")
    out = Path(a.out)
    looks = [load_look(x) for x in a.look] if a.look else [None]
    for i, look in enumerate(looks):
        label = f"{i + 1:02d}_{slug(look)}" if look else "shot"
        run_one(client, prepare(graph, a.rung, look, a.seed), out, label, a.partner_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
