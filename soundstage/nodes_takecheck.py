"""Soundstage · Blocking Score: the actor half of “Follows your blocking %” (Milestone 16).

Runs SAM 3.1 (the checkpoint the Layer Pack already uses; nothing is downloaded) over ~32 frames of a finished
take, matches each track to the stage actor whose projected volume it overlaps best, and stores per-actor IoU over
time next to the take's CPU checks (soundstage/takecheck/routes.py merges it into the Ladder's score). It runs in
the ComfyUI queue so it never competes with a render for the GPU.
"""
from __future__ import annotations

import json
import os

import numpy as np
import torch

from comfy_api.latest import IO

from .takecheck import blocking as B
from .takecheck import store
from .takecheck.recipe import from_tags
from .takecheck.video import probe, read_frames

SAM_PROMPT = {"man": "person", "woman": "person", "child": "person", "person": "person", "boy": "person", "girl": "person",
              "horse": "horse", "dog": "dog", "cat": "cat", "bird": "bird", "cow": "cow"}


def prompt_for(kind: str) -> str | None:
    k = (kind or "").lower()
    if k in SAM_PROMPT:
        return SAM_PROMPT[k]
    from .takecheck.detect import is_road_vehicle
    if is_road_vehicle(k):
        return "truck" if k == "truck" else "car"
    return None


def _ckpt() -> str:
    import folder_paths
    found = [f for f in folder_paths.get_filename_list("checkpoints") if "sam3" in f.lower()]
    found.sort(key=lambda f: ("3.1" not in f, f))
    if not found:
        raise RuntimeError("SAM 3.1 is not installed (checkpoints/sam3.1_multiplex_fp16.safetensors, see MODELS.md)")
    return found[0]


def score_actors(path: str, samples: int = 32, width: int = 640) -> dict:
    from .layerpack import final_mattes as FM
    info = probe(path)
    rec = from_tags(info.get("tags") or {})
    if not rec or not isinstance(rec.get("scene"), dict):
        return {"actors": [], "why": "no stage recipe in this video"}
    scene = rec["scene"]
    n = info["frames"] or 1
    every = max(1, n // samples)
    rgb = read_frames(path, width, gray=False, every=every, info=info)
    idx = [i * every for i in range(rgb.shape[0])]
    m, H, W = rgb.shape[0], rgb.shape[1], rgb.shape[2]
    actors = B.tracked_actors(scene)
    stage = B.stage_boxes(scene, n, W, H, frames_idx=idx)
    kinds = {a.get("id"): prompt_for(a.get("kind")) for a in actors}
    prompts = sorted({k for k in kinds.values() if k})
    if not prompts:
        return {"actors": [], "why": "no person, animal or vehicle on the stage"}
    images = torch.from_numpy(rgb.astype(np.float32) / 255.0)
    tracks, tkinds = [], []
    ckpt = _ckpt()
    for p in prompts:
        objs = FM.track_final(images, [p], ckpt, max_objects=max(4, sum(1 for v in kinds.values() if v == p) + 3), detect_interval=1)
        if objs.shape[1] == 0:
            continue
        for tb in B.mask_boxes(objs.numpy()):
            tracks.append(tb)
            tkinds.append(p)
    names = {a.get("id"): a.get("name") or a.get("kind") for a in actors}
    fps = info["fps"] or 24.0
    res = B.actor_scores(stage, tracks, names, kinds, tkinds, times=[i / fps for i in idx])
    return {"actors": res, "tracks": len(tracks), "prompts": prompts, "samples": m, "model": ckpt}


class SoundstageBlockingScore(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageBlockingScore",
            display_name="Soundstage · Blocking Score",
            category="Soundstage/Review",
            description="How closely a finished take followed the stage: SAM 3.1 tracks each actor in the video and "
                        "compares it with the actor's mark on the stage (per-actor IoU over time). Reads the stage from "
                        "the take's own metadata. The App queues it from the Ladder; ~20 s of GPU.",
            inputs=[
                IO.String.Input("video", default="", tooltip="A take in the output folder: 'soundstage/final_00001_.mp4 [output]'."),
                IO.Int.Input("samples", default=32, min=8, max=121, advanced=True, tooltip="Frames sampled across the take."),
            ],
            outputs=[IO.String.Output(display_name="score_json")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, video="", samples=32) -> IO.NodeOutput:
        import folder_paths
        path = folder_paths.get_annotated_filepath(video.strip()) if video.strip() else ""
        if not path or not os.path.isfile(path):
            raise ValueError(f"No such take: {video}")
        res = score_actors(path, int(samples))
        store.save(path, "actors", res)
        text = json.dumps(res)
        return IO.NodeOutput(text, ui={"text": [text]})


NODES = [SoundstageBlockingScore]
