"""Video → Stage, end to end: frames (ffmpeg) -> DA3 depth (queue) -> camera track (CPU) -> breakdown (VLM, queue)
-> scene (convert.assemble). Every GPU step is a queued ComfyUI prompt."""
from __future__ import annotations

import asyncio
import hashlib
import math
import os
import time

import numpy as np

from . import convert, frames, graphs, performer, queue, track, vlm


def _input_dir() -> str:
    import folder_paths
    return folder_paths.get_input_directory()


def video_path(name: str) -> str:
    import folder_paths
    path = folder_paths.get_annotated_filepath(name)
    if not path or not os.path.isfile(path):
        raise ValueError(f"video '{name}' is not in the input folder (upload it first)")
    return path


def _geometry_models() -> list[str]:
    try:
        import folder_paths
        return list(folder_paths.get_filename_list("geometry_estimation") or [])
    except Exception:  # noqa: BLE001
        return []


def _detection_models() -> list[str]:
    try:
        import folder_paths
        return list(folder_paths.get_filename_list("detection") or [])
    except Exception:  # noqa: BLE001
        return []


def _gray(path: str, size):
    import cv2
    g = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if g.shape[::-1] != tuple(size):
        g = cv2.resize(g, tuple(size), interpolation=cv2.INTER_AREA)
    return g


def solve(npz: dict, frame_files: list[str], seed: int = 0):
    """Depth packet + frames -> (poses, scales, K, ground, notes). Pure CPU; used by the route and the tests."""
    depth = npz["depth"].astype(np.float32)
    n, h, w = depth.shape
    K = np.asarray(npz["intrinsics"][0], np.float64)
    sky = npz.get("sky")
    sky = None if sky is None else sky.astype(np.float32)
    notes = []
    if sky is not None and npz.get("extrinsics") is None:
        # DA3 mono compresses distance non-linearly; straighten each frame on its own floor before tracking.
        hz = [track.horizon_row(s) for s in sky]
        ps = []
        for i in range(n):
            v_h = hz[i] if hz[i] is not None else next((hz[j] for j in sorted(range(n), key=lambda j: abs(j - i))
                                                         if hz[j] is not None), None)
            depth[i], p = track.linearize(depth[i], v_h, K, track.valid_mask(depth[i], sky[i]))
            ps.append(p)
        if any(abs(p - 1) > 0.05 for p in ps):
            notes.append(f"depth: straightened on the floor (power {min(ps):.2f}-{max(ps):.2f})")
        npz = dict(npz, depth=depth)
    if npz.get("extrinsics") is not None:
        poses = track.rebase_extrinsics(np.asarray(npz["extrinsics"], np.float64))
        scales = np.ones(n)
        notes.append("camera: DA3 multi-view poses")
    else:
        grays = [_gray(f, (w, h)) for f in frame_files]
        poses, scales, tn = track.track_mono(grays, list(depth), K, None if sky is None else list(sky), seed=seed)
        notes += tn
        notes.append("camera: tracked from mono depth (PnP chain)")
    mask0 = track.valid_mask(depth[0], None if sky is None else sky[0])
    ground = track.fit_ground(depth[0], K, mask0, seed=seed)
    v_h = None if sky is None else track.horizon_row(sky[0])
    if v_h is not None:   # the horizon gives the camera's tilt more truly than mono depth does
        ground = track.ground_from_horizon(v_h, K, ground[1] if ground else 1.0)
        notes.append(f"ground: camera tilt from the horizon (row {v_h:.0f}, {math.degrees(math.atan2(K[1, 2] - v_h, K[1, 1])):.1f} deg down)")
    if ground is None:
        notes.append("ground: no floor plane found in the first frame; assumed a level camera")
    return poses, scales, K, ground, notes, depth


async def run(base_url: str, video: str, *, samples: int = 16, use_vlm: bool = True, backdrop: bool = True,
              progress=None, mocap: bool = True) -> dict:
    say = progress or (lambda step, frac: None)
    t0 = time.perf_counter()
    timings: dict = {}
    notes: list[str] = []
    path = video_path(video)
    clip = frames.probe(path)
    if clip["duration"] <= 0:
        raise ValueError("the clip has no duration")
    tag = hashlib.sha1(f"{video}:{os.path.getsize(path)}:{os.path.getmtime(path)}".encode()).hexdigest()[:10]
    sub = f"soundstage/v2s_{tag}"
    say("Sampling frames", 0.05)
    times = frames.sample_times(clip["duration"], clip["fps"], samples)
    files = await asyncio.to_thread(frames.extract, path, os.path.join(_input_dir(), sub), times)
    names = [f"{sub}/{os.path.basename(f)}" for f in files]
    timings["frames_ms"] = round((time.perf_counter() - t0) * 1000)

    model, multiview = graphs.pick_model(_geometry_models())
    if not model:
        raise RuntimeError("Depth Anything 3 is not on this server (models/geometry_estimation)")
    if not multiview:
        notes.append(f"{model} is mono-only: the camera is tracked from its depth. A DA3 Small/Base checkpoint "
                     "would give multi-view poses directly")
    say("Measuring depth (Depth Anything 3)", 0.15)
    g = graphs.da3_graph(model, names, f"v2s_{tag}", multiview,
                         backdrop_prefix=f"soundstage/v2s_{tag}_set" if backdrop else None)
    out, t = await queue.run_graph(base_url, g, "depth")
    timings["da3_ms"] = t.get("exec_ms", t["total_ms"])
    npz_path = queue.text_of(out, "x1")
    with np.load(npz_path, allow_pickle=False) as z:
        packet = {k: z[k] for k in z.files}
    glb = graphs.saved_glb(out) if backdrop else None

    say("Tracking the camera", 0.4)
    t1 = time.perf_counter()
    poses, scales, K, ground, tn, lin = await asyncio.to_thread(solve, packet, files)
    packet["depth"] = lin
    notes += tn
    timings["track_ms"] = round((time.perf_counter() - t1) * 1000)

    breakdown = {"setting": "", "time": "", "camera": {}, "objects": [], "set": []}
    vmodel = vlm.available_model() if use_vlm else None
    if use_vlm and not vmodel:
        notes.append("no local vision model (qwen3.5_4b): camera move only, no subjects or set pieces")
    if vmodel:
        say("Reading the shot (vision model)", 0.55)
        try:
            vo, vt = await queue.run_graph(base_url, vlm.graph(vmodel, names[0], names[-1]), "shot breakdown")
            timings["vlm_ms"] = vt.get("exec_ms", vt["total_ms"])
            first = vlm.parse_reply(queue.text_of(vo, "a3"))
            try:
                last = vlm.parse_reply(queue.text_of(vo, "b3"))
            except ValueError as exc:
                last, _ = None, notes.append(f"last-frame read unusable ({exc}); movers keep their start marks")
            breakdown = vlm.merge_reads(first, last)
        except Exception as exc:  # noqa: BLE001 - still deliver the camera move
            notes.append(f"vision model failed ({exc}); camera move only")

    say("Building the set", 0.85)
    h, w = packet["depth"].shape[1:]
    view = lambda f: {"filename": os.path.basename(f), "subfolder": sub, "type": "input"}  # noqa: E731
    reference = {"video": video, "fps": clip["fps"], "frames": clip["frames"], "duration": clip["duration"],
                 "width": clip["width"], "height": clip["height"], "sample_times": times,
                 "samples": [view(f) for f in files], "footage_node": "SoundstageFootage"}
    scene = convert.assemble(poses=poses, scales=scales, times=times, K=K, size=(w, h), depths=list(packet["depth"]),
                             ground=ground, breakdown=breakdown, clip=clip, reference=reference, notes=notes,
                             skies=None if packet.get("sky") is None else list(packet["sky"].astype(np.float32)),
                             repin=any(n.startswith("depth: straightened") for n in notes),
                             backdrop={"url": "/view?filename={}&subfolder={}&type={}".format(
                                 glb["filename"], glb.get("subfolder", ""), glb.get("type", "output"))} if glb else None)
    # The performer: SAM 3D Body copies the person's whole performance onto a clay actor standing in the rebuilt set.
    PEOPLE = ("person", "man", "woman", "boy", "girl", "child", "kid", "people", "dancer", "runner", "athlete", "rider",
              "driver", "player", "boxer", "fighter", "skater", "hiker", "actor", "guy", "lady")
    has_person = not vmodel or any(any(w in (o.get("label") or "").lower().split() for w in PEOPLE)
                                   for o in breakdown.get("objects") or [])
    if mocap and has_person and performer.available(_detection_models()):
        say("Capturing the performance (SAM 3D Body)", 0.9)
        try:
            mo, mt = await queue.run_graph(base_url, performer.mocap_graph(video, f"v2s_{tag}"), "motion capture")
            timings["mocap_ms"] = mt.get("exec_ms", mt["total_ms"])
            import json as _json
            import folder_paths
            info = _json.loads(queue.text_of(mo, "p6"))
            with open(os.path.join(folder_paths.get_output_directory(), info["file"])) as f:
                take = _json.load(f)
            xf = scene["video2stage"]["xform"]
            cam_poses = poses
            if performer.camera_drifted(scene, breakdown):
                # Mono tracking on a near-static shot drifts when the subject walks at the lens (the camera "rises" and
                # backs off). Lock the camera to its first pose for the shot and for placing the performer.
                keys = scene["shots"][0]["camera_keys"]
                scene["shots"][0]["camera_keys"] = [keys[0]]
                cam_poses = [poses[0]] * len(poses)
                notes.append("camera: the track drifted on a near-static shot (moving subject); locked to the first frame")
            placed = performer.place(take, cam_poses, times, np.array(xf["A"]), np.array(xf["b"]), K, (w, h), clip["fps"])
            if placed:
                aid = performer.attach(scene, info["file"], take, placed)
                dropped = performer.drop_background_people(scene, aid)
                if dropped:
                    notes.append(f"performer: left out {dropped} small background figure(s) the depth could not place")
                cut = performer.cutout(take, scene["video2stage"]["metres_per_unit"])
                bd = next((a for a in scene["actors"] if a.get("id") == "v2s_backdrop"), None)
                if cut and bd and min(times) < 0.25:   # the set mesh is the first frame's
                    cut["K"] = [round(float(K[0, 0] / w), 5), round(float(K[1, 1] / h), 5),
                                round(float(K[0, 2] / w), 5), round(float(K[1, 2] / h), 5)]
                    bd["set_xform"]["cut"] = cut
                notes.append(f"performer: {info['frames']} frames of motion capture on '{aid}', standing on the rebuilt floor")
            else:
                notes.append("performer: captured, but the feet could not be placed in the set (no picture positions)")
        except Exception as exc:  # noqa: BLE001 - the set and camera still stand without the performer
            notes.append(f"performer: motion capture failed ({exc})")
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000)
    say("Done", 1.0)
    movers = [a for a in scene["actors"] if len(a.get("keys", [])) > 1]
    return {"scene": scene, "notes": notes, "timings": timings, "breakdown": breakdown,
            "summary": {"objects": len([a for a in scene["actors"] if not a.get("set_piece") and a["kind"] != "glb"]),
                        "set_pieces": len([a for a in scene["actors"] if a.get("set_piece")]),
                        "movers": len(movers), "camera_keys": len(scene["camera_keys"]),
                        "frames": scene["shot"]["frames"], "depth_model": model, "vision_model": vmodel}}
