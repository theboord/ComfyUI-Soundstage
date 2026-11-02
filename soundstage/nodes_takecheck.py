"""Soundstage · Blocking Score: the actor half of “Follows your blocking %” (Milestone 16).

Runs SAM 3.1 (the checkpoint the Layer Pack already uses; nothing is downloaded) over ~32 frames of a finished
take, matches each track to the stage actor whose projected volume it overlaps best, and stores per-actor IoU over
time next to the take's CPU checks (soundstage/takecheck/routes.py merges it into the Ladder's score). It runs in
the ComfyUI queue so it never competes with a render for the GPU.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
import torch

from comfy_api.latest import IO

from .takecheck import blocking as B
from .takecheck import store
from .takecheck.framecheck import SAM_PROMPT, prompt_for, stage_silhouettes  # noqa: F401  (pure, tested without torch)
from .takecheck.recipe import from_tags
from .takecheck.video import probe, read_frames


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


# ---- ④ Frame: the first-frame check -------------------------------------------------------------------------------

def _stage_of_png(path: str) -> dict | None:
    """The 3D Stage node's input (scene + pass files) from a still's own PNG metadata (ComfyUI writes the prompt)."""
    from PIL import Image
    try:
        info = Image.open(path).info
        prompt = json.loads(info.get("prompt") or "{}")
    except (OSError, ValueError):
        return None
    for n in prompt.values():
        if isinstance(n, dict) and n.get("class_type") == "SoundstageStage":
            v = (n.get("inputs") or {}).get("stage")
            data = json.loads(v) if isinstance(v, str) and v.strip() else v
            if isinstance(data, dict) and isinstance(data.get("scene"), dict):
                return data
    return None


def _first_tile(ref: str, grid: dict | None) -> np.ndarray:
    from PIL import Image
    import folder_paths
    img = np.asarray(Image.open(folder_paths.get_annotated_filepath(ref)).convert("RGB"))
    if grid:
        tw, th = grid["tile"]
        img = img[:th, :tw]
    return img


MAX_PER_KIND = 8


def detect(image: torch.Tensor, prompts: list[str], ckpt: str) -> list[dict]:
    """SAM 3.1 detections per prompt on one image (1xHxWx3): [{mask, kind, score}]."""
    import nodes
    from comfy_extras import nodes_sam3 as S3
    model, clip = nodes.CheckpointLoaderSimple().load_checkpoint(ckpt)[:2]
    out = []
    for p in prompts:
        # "car:8": SAM 3's text encoder keeps ONE detection per prompt unless the prompt asks for more (sam3_clip.py)
        cond = nodes.CLIPTextEncode().encode(clip, f"{p}:{MAX_PER_KIND}")[0]
        res = S3.SAM3_Detect.execute(model=model, image=image, conditioning=cond, threshold=0.35 if p == "person" else 0.4,
                                     refine_iterations=2, individual_masks=True)
        args = getattr(res, "result", None) or getattr(res, "args", None) or res
        masks, boxes = args[0], args[1]
        boxes = boxes[0] if boxes and isinstance(boxes[0], list) else boxes
        for i in range(int(masks.shape[0])):
            out.append({"mask": masks[i].cpu().numpy() > 0.5, "kind": p,
                        "score": float(boxes[i].get("score", 1.0)) if i < len(boxes) else 1.0})
    return out


def check_frame(path: str) -> dict:
    from PIL import Image
    from .takecheck import framecheck as FC
    data = _stage_of_png(path)
    for _ in range(3):        # a frame checked the moment it lands can read without its metadata: look again
        if data:
            break
        time.sleep(1.5)
        data = _stage_of_png(path)
    if not data:
        return {"verdict": "unknown", "why": "this frame carries no stage (made outside ④ Frame)"}
    passes, scene = data.get("passes") or {}, data["scene"]
    if not passes.get("id"):
        return {"verdict": "unknown", "why": "the stage sent no ID pass"}
    id_rgb = _first_tile(passes["id"], passes.get("grid"))
    H, W = id_rgb.shape[:2]
    stage, names = stage_silhouettes(id_rgb, scene)
    prompts = sorted({s["kind"] for s in stage.values() if s["kind"] != "_set"})
    if not prompts:
        return {"verdict": "unknown", "why": "no person, animal or vehicle on the stage"}
    still = Image.open(path).convert("RGB").resize((W, H), Image.BILINEAR)
    img = torch.from_numpy(np.asarray(still).astype(np.float32) / 255.0)[None]
    dets = detect(img, prompts, _ckpt())
    res = FC.score(stage, dets, names)
    res["size"] = [W, H]
    res["detections"] = len(dets)
    return res


class SoundstageFrameCheck(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageFrameCheck",
            display_name="Soundstage · First Frame Check",
            category="Soundstage/Review",
            description="Does a ④ Frame candidate hold what the stage holds? SAM 3.1 finds the people, animals and "
                        "vehicles in the frame and compares them with the stage's ID pass for frame 1: object count, "
                        "silhouette IoU per actor, extra (ghost) objects. Reads the stage from the frame's own PNG "
                        "metadata. The App queues it for every candidate (~3 s of GPU).",
            inputs=[IO.String.Input("image", default="", tooltip="A frame in the output folder: 'soundstage/look_00001_.png [output]'.")],
            outputs=[IO.String.Output(display_name="check_json")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, image="") -> IO.NodeOutput:
        import folder_paths
        path = folder_paths.get_annotated_filepath(image.strip()) if image.strip() else ""
        if not path or not os.path.isfile(path):
            raise ValueError(f"No such frame: {image}")
        res = store.load(path, "framecheck")
        if not res or res.get("v") != _fc_version():
            res = check_frame(path)
            res["v"] = _fc_version()
            if res.get("verdict") != "unknown":     # an unreadable frame is checked again next time
                store.save(path, "framecheck", res)
        text = json.dumps(res)
        return IO.NodeOutput(text, ui={"text": [text]})


def _fc_version() -> int:
    from .takecheck.framecheck import VERSION
    return VERSION


NODES = [SoundstageBlockingScore, SoundstageFrameCheck]
