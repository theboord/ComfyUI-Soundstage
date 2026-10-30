"""Soundstage · Mocap to Stage: a performance captured from video drives a clay actor on the 3D stage.

    Load Video -> Get Video Components -> Load SAM3D Body Model -> Run SAM3D Body Prediction
               -> (Smooth SAM3D Body Pose Data) -> Soundstage · Mocap to Stage

SAM 3D Body (ComfyUI core) gives each frame's 3D body (MHR70 keypoints) and the person's camera-space translation.
This node keeps what the stage rig needs: the 18 OpenPose body points and 21 points per hand, Y-up, in metres, plus
the root path (camera translation), and writes them to output/soundstage/mocap/<name>.json. The stage retargets them
onto the clay figure every frame (web/stage/mocap.mjs): facing, chest, head, arms, hands, fingers, legs, and the hip
path, so a jump leaves the ground and a run covers distance.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
import folder_paths
from comfy_api.latest import IO

MHRPoseData = IO.Custom("MHR_POSE_DATA")


def _openpose_points(pose_data, frames, track):
    """(N,18,3) body and (N,42,3) hands in Y-up metres, using ComfyUI's own MHR70 -> OpenPose mapping."""
    from comfy_extras.sam3d_body.export.glb_openpose import _extract_openpose_keypoints, _extract_openpose_hand_keypoints
    body = _extract_openpose_keypoints(pose_data, frames, track)
    try:
        hands = _extract_openpose_hand_keypoints(pose_data, frames, track)
    except Exception:  # noqa: BLE001 - a body-only capture still drives the figure
        hands = np.zeros((len(frames), 42, 3), dtype=np.float32)
    return body, hands


def mocap_from_pose_data(pose_data, fps=24.0, track=0, duration=0.0):
    """Pure conversion (testable without a GPU): MHR pose data -> the stage's mocap dict.

    duration > 0 overrides fps with frames / duration: a browser webcam recording (WebM) often carries no usable
    frame rate, but the page knows how long it recorded."""
    frames_all = pose_data["frames"]
    if duration and duration > 0 and frames_all:
        fps = len(frames_all) / float(duration)
    idx = [i for i, people in enumerate(frames_all) if len(people) > track]
    if not idx:
        raise ValueError("Mocap: no person was found in the video. Use a clip where one person is clearly visible.")
    body, hands = _openpose_points(pose_data, idx, track)
    cam = np.zeros((len(idx), 3), dtype=np.float32)
    for k, f in enumerate(idx):
        t = frames_all[f][track].get("pred_cam_t")
        if t is not None:
            t = np.asarray(t, dtype=np.float32).reshape(-1)[:3]
            cam[k] = (t[0], -t[1], -t[2])                       # same y/z un-flip as the keypoints
    return {
        "version": 1, "fps": float(fps), "frames": len(idx), "source_frames": idx,
        "body_names": ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist",
                       "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear"],
        "body": np.round(body, 4).tolist(), "hands": np.round(hands, 4).tolist(), "root": np.round(cam, 4).tolist(),
        "image_size": list(pose_data.get("image_size") or []),
    }


class SoundstageMocap(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageMocap",
            display_name="Soundstage · Mocap to Stage",
            category="Soundstage",
            search_aliases=["mocap", "motion capture", "performance capture", "video to pose", "sam3d body to stage"],
            description="Turns SAM 3D Body pose data from a video into a mocap clip the 3D stage plays on a clay actor "
                        "(body, hands, fingers and the path through the shot). Writes output/soundstage/mocap/<name>.json.",
            inputs=[
                MHRPoseData.Input("mhr_pose_data"),
                IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, step=0.001, tooltip="The video's frame rate."),
                IO.Int.Input("track", default=0, min=0, max=16, tooltip="Which person, when several are tracked."),
                IO.String.Input("name", default="take", tooltip="File name for the take."),
                IO.Float.Input("duration", default=0.0, min=0.0, max=600.0, step=0.01, optional=True,
                               tooltip="Seconds the clip lasts. When set, fps = frames / duration (webcam recordings "
                                       "often have no reliable frame rate). 0 = use fps."),
            ],
            outputs=[IO.String.Output("mocap_json", display_name="mocap_json"), IO.String.Output("file", display_name="file")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, mhr_pose_data, fps, track, name, duration=0.0) -> IO.NodeOutput:
        data = mocap_from_pose_data(mhr_pose_data, fps=fps, track=track, duration=duration or 0.0)
        out_dir = os.path.join(folder_paths.get_output_directory(), "soundstage", "mocap")
        os.makedirs(out_dir, exist_ok=True)
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (name or "take"))[:40] or "take"
        fname = f"{safe}_{time.strftime('%Y%m%d_%H%M%S')}.json"
        with open(os.path.join(out_dir, fname), "w") as f:
            json.dump(data, f)
        rel = f"soundstage/mocap/{fname}"
        text = json.dumps({"file": rel, "frames": data["frames"], "fps": data["fps"]})
        return IO.NodeOutput(text, rel, ui={"text": [text]})


NODES = [SoundstageMocap]
