"""Video → Stage, end to end: frames (ffmpeg) -> DA3 depth (queue) -> camera track (CPU) -> breakdown (VLM, queue)
-> scene (convert.assemble). Every GPU step is a queued ComfyUI prompt."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import os
import re
import time

import numpy as np

from . import convert, frames, graphs, performer, queue, scanroute, stages, track, vlm, weather


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
    # A clean horizon gives the camera's tilt more truly than mono depth does; a sky edge cut off by trees, a slope or
    # a wall does not, and then the depth-fitted floor decides (track.camera_ground).
    ground, gnote = track.camera_ground(depth[0], None if sky is None else sky[0], K, mask0, seed=seed)
    if gnote:
        notes.append(gnote)
    if ground is None:
        notes.append("ground: no floor plane found in the first frame; assumed a level camera")
    return poses, scales, K, ground, notes, depth


def run_kwargs(body: dict) -> dict:
    """Route body -> run() keyword arguments (the route and tools/v2s_bench/devrun.py share this)."""
    body = dict(body or {})
    kw = {"samples": min(max(int(body.get("samples") or 16), 8), 24), "use_vlm": bool(body.get("vlm", True)),
          "backdrop": bool(body.get("backdrop", True)), "original": str(body.get("original") or ""),
          # opt-in: a face-blurred crop of the person as the Frame still's wardrobe reference (wardrobe.CONSENT)
          "wardrobe_ref": bool(body.get("wardrobe_ref", False)),
          # the set-scan path: None = on when Qwen3-VL is installed (scanroute.choose); false = the old block builder
          "scan": None if body.get("scan") is None else bool(body.get("scan"))}
    return kw


async def run(base_url: str, video: str, *, samples: int = 16, use_vlm: bool = True, backdrop: bool = True,
              progress=None, mocap: bool = True, original: str = "", mpu_known: float | None = None,
              seed: int = 0, reuse: set | None = None, tag: str | None = None, wardrobe_ref: bool = False,
              scan: bool | None = None) -> dict:
    """The whole rebuild. seed 0 = the first, deterministic build; ↻ Regenerate passes a new seed (the camera solve's
    RANSAC, the vision model's sampling, the set dressing) and `reuse` = the stages to take from the last run's record
    (stages.py) instead of running them again."""
    say = progress or (lambda step, frac: None)
    reuse = set(reuse or ())
    ran: dict = {}
    t0 = time.perf_counter()
    timings: dict = {}
    notes: list[str] = []
    path = video_path(video)
    clip = frames.probe(path)
    if clip["duration"] <= 0:
        raise ValueError("the clip has no duration")
    # Source spec (docs/source_fidelity.md): what the clip really is, so Deliver hands it back the same.
    try:
        from ..footage import sourcespec
        source = sourcespec.link_original(sourcespec.probe(path), original)
    except Exception as exc:  # noqa: BLE001 - the rebuild never depends on it
        source = None
        notes.append(f"source spec: could not read it ({exc})")
    # tag: the last run's (Regenerate sends it, so a copied or re-uploaded clip still finds its stages)
    if not (tag and re.fullmatch(r"[0-9a-f]{10}", str(tag))):
        tag = hashlib.sha1(f"{video}:{os.path.getsize(path)}:{os.path.getmtime(path)}".encode()).hexdigest()[:10]
    sub = f"soundstage/v2s_{tag}"
    say("Sampling frames", 0.05)
    times = frames.sample_times(clip["duration"], clip["fps"], samples)
    fdir = os.path.join(_input_dir(), sub)
    kept = [os.path.join(fdir, f"f_{i:02d}.png") for i in range(len(times))]
    if "depth" in reuse and all(os.path.isfile(f) for f in kept):
        files = kept   # the very frames the reused depth measured
    else:
        files = await asyncio.to_thread(frames.extract, path, fdir, times)
    names = [f"{sub}/{os.path.basename(f)}" for f in files]
    timings["frames_ms"] = round((time.perf_counter() - t0) * 1000)

    model, multiview = graphs.pick_model(_geometry_models())
    if not model:
        raise RuntimeError("Depth Anything 3 is not on this server (models/geometry_estimation)")
    if not multiview:
        notes.append(f"{model} is mono-only: the camera is tracked from its depth. A DA3 Small/Base checkpoint "
                     "would give multi-view poses directly")
    rec = stages.load(tag) if reuse else {"tag": tag}
    rec.update(tag=tag, video=video, samples=len(names))
    reuse = {s for s in reuse if stages.usable(rec, s)}
    if "depth" in reuse:
        say("Measuring depth (Depth Anything 3): reused", 0.08)
        npz_path, glb = rec["depth"]["npz"], (rec["depth"].get("glb") if backdrop else None)
    else:
        say("Measuring depth (Depth Anything 3)", 0.08)
        g = graphs.da3_graph(model, names, f"v2s_{tag}", multiview,
                             backdrop_prefix=f"soundstage/v2s_{tag}_set" if backdrop else None)
        out, t = await queue.run_graph(base_url, g, "depth")
        timings["da3_ms"] = t.get("exec_ms", t["total_ms"])
        npz_path = queue.text_of(out, "x1")
        glb = graphs.saved_glb(out) if backdrop else None
        rec["depth"] = {"npz": npz_path, "glb": glb}
    ran["depth"] = "reused" if "depth" in reuse else "ran"
    with np.load(npz_path, allow_pickle=False) as z:
        packet = {k: z[k] for k in z.files}

    breakdown = {"setting": "", "time": "", "camera": {}, "objects": [], "set": []}
    vmodel = vlm.available_model() if use_vlm else None
    if "breakdown" in reuse:
        breakdown, vmodel = rec["breakdown"]["read"], rec["breakdown"].get("model")
        set_seed = int(rec["breakdown"].get("set_seed") or 7)
    else:
        set_seed = 7 if not seed else 7 + int(seed)
    if use_vlm and not vmodel:
        notes.append("no local vision model (qwen3.5_4b): camera move only, no subjects or set pieces")
    if vmodel and "breakdown" not in reuse:
        say("Reading the shot (vision model)", 0.2)
        try:
            vo, vt = await queue.run_graph(base_url, vlm.graph(vmodel, names[0], names[-1], seed=seed), "shot breakdown")
            timings["vlm_ms"] = vt.get("exec_ms", vt["total_ms"])
            first = vlm.parse_reply(queue.text_of(vo, "a3"))
            try:
                last = vlm.parse_reply(queue.text_of(vo, "b3"))
            except ValueError as exc:
                last, _ = None, notes.append(f"last-frame read unusable ({exc}); movers keep their start marks")
            breakdown = vlm.merge_reads(first, last)
            rec["breakdown"] = {"read": breakdown, "model": vmodel, "seed": int(seed), "set_seed": set_seed}
        except Exception as exc:  # noqa: BLE001 - still deliver the camera move
            notes.append(f"vision model failed ({exc}); camera move only")
    ran["breakdown"] = "reused" if "breakdown" in reuse else "ran"
    # The set-scan path (scanroute): the Qwen3-VL inventory reads the wardrobe and the set better than the 4B breakdown.
    inv_model = vlm.inventory_model() if use_vlm else None
    scan_on, scan_note = scanroute.choose(scan, backdrop, inv_model)
    notes.append(scan_note)
    inventory = rec.get("inventory") if "breakdown" in reuse else None
    if scan_on and not inventory:
        say("Listing everything in the frame (Qwen3-VL)", 0.25)
        try:
            g_inv, fr_inv = scanroute.inventory_prompt(inv_model, names)
            io, it = await queue.run_graph(base_url, g_inv, "inventory", timeout_s=1800)
            timings["inventory_ms"] = it.get("exec_ms", it["total_ms"])
            inventory = scanroute.collect_inventory(io, fr_inv)
            rec["inventory"] = inventory
        except Exception as exc:  # noqa: BLE001 - the breakdown alone still builds the set
            notes.append(f"set: the Qwen3-VL inventory failed ({exc}); the set uses the breakdown only")
    if inventory:
        breakdown = vlm.enrich_breakdown(breakdown, inventory)

    # The performer is captured BEFORE the camera is solved: SAM 3D Body's focal (fitted to the person) becomes the
    # shot's one lens, so the camera, the set and the clay all share it (performer.shared_K).
    PEOPLE = ("person", "man", "woman", "boy", "girl", "child", "kid", "people", "dancer", "runner", "athlete", "rider",
              "driver", "player", "boxer", "fighter", "skater", "hiker", "actor", "guy", "lady")
    has_person = not vmodel or any(any(w in (o.get("label") or "").lower().split() for w in PEOPLE)
                                   for o in breakdown.get("objects") or [])
    take = info = None
    if mocap and "mocap" in reuse:
        import json as _json
        import folder_paths
        info = dict(rec["mocap"])
        with open(os.path.join(folder_paths.get_output_directory(), info["file"])) as f:
            take = _json.load(f)
        ran["mocap"] = "reused"
    elif mocap and has_person and performer.available(_detection_models()):
        ran["mocap"] = "ran"
        say("Capturing the performance (SAM 3D Body)", 0.3)
        try:
            mo, mt = await queue.run_graph(base_url, performer.mocap_graph(video, f"v2s_{tag}"), "motion capture")
            timings["mocap_ms"] = mt.get("exec_ms", mt["total_ms"])
            import json as _json
            import folder_paths
            info = _json.loads(queue.text_of(mo, "p6"))
            with open(os.path.join(folder_paths.get_output_directory(), info["file"])) as f:
                take = _json.load(f)
            rec["mocap"] = {"file": info["file"], "frames": int(info.get("frames") or 0)}
        except Exception as exc:  # noqa: BLE001 - the set and camera still stand without the performer
            notes.append(f"performer: motion capture failed ({exc})")
    hd, wd = packet["depth"].shape[1:]
    K_da3 = np.asarray(packet["intrinsics"][0], np.float64).copy()
    if take is not None:
        K_one, kn = performer.shared_K(np.asarray(packet["intrinsics"][0], np.float64), take, (wd, hd))
        if kn:
            notes.append(kn)
        packet["intrinsics"] = np.repeat(K_one[None].astype(np.float32), len(packet["intrinsics"]), axis=0)

    t1 = time.perf_counter()
    if "camera" in reuse:
        say("Tracking the camera: reused", 0.4)
        poses, scales, K, ground, tn, lin = stages.load_solve(rec["camera"]["npz"])
    else:
        say("Tracking the camera", 0.4)
        poses, scales, K, ground, tn, lin = await asyncio.to_thread(solve, packet, files, seed)
        try:
            rec["camera"] = {"npz": stages.save_solve(tag, poses, scales, K, ground, tn, lin, seed), "seed": int(seed)}
        except Exception as exc:  # noqa: BLE001 - the record is a convenience; the rebuild stands without it
            notes.append(f"stages: could not keep the camera solve for Regenerate ({exc})")
    ran["camera"] = "reused" if "camera" in reuse else "ran"
    packet["depth"] = lin
    notes += tn
    timings["track_ms"] = round((time.perf_counter() - t1) * 1000)

    say("Building the set", 0.45)
    h, w = packet["depth"].shape[1:]
    view = lambda f: {"filename": os.path.basename(f), "subfolder": sub, "type": "input"}  # noqa: E731
    reference = {"video": video, "fps": clip["fps"], "frames": clip["frames"], "duration": clip["duration"],
                 "width": clip["width"], "height": clip["height"], "sample_times": times,
                 "samples": [view(f) for f in files], "footage_node": "SoundstageFootage", "source": source}
    notes0 = list(notes)
    # The sky, measured: a grey sky is overcast whatever hour the model guessed (weather.py).
    sky_sample = None
    try:
        idx = sorted({int(round(i * (len(files) - 1) / 5)) for i in range(6)}) if len(files) > 1 else [0]
        skies_all = packet.get("sky")
        sky_sample = weather.sky_sample([weather.load_rgb(files[i]) for i in idx],
                                        None if skies_all is None else [skies_all[i] for i in idx])
    except Exception as exc:  # noqa: BLE001 - the time words still light the set
        notes0.append(f"sky: could not sample the source sky ({exc})")

    def build(mpu=None):
        nn = list(notes0)
        sc = convert.assemble(poses=poses, scales=scales, times=times, K=K, size=(w, h), depths=list(packet["depth"]),
                              ground=ground, breakdown=breakdown, clip=clip, reference=reference, notes=nn,
                              skies=None if packet.get("sky") is None else list(packet["sky"].astype(np.float32)),
                              repin=any(n.startswith("depth: straightened") for n in nn), mpu=mpu, seed=set_seed,
                              sky_sample=sky_sample,
                              backdrop={"url": "/view?filename={}&subfolder={}&type={}".format(
                                  glb["filename"], glb.get("subfolder", ""), glb.get("type", "output"))} if glb else None)
        lens_k = float(K_da3[0, 0] / K[0, 0])
        bd0 = next((a for a in sc["actors"] if a.get("id") == "v2s_backdrop"), None)
        if bd0 and abs(lens_k - 1) > 1e-3:
            # The set mesh was built in DA3's own camera (its focal): re-lens it to the shot's one K (x, y go as 1/f).
            fx = bd0["set_xform"].get("flip_xyz") or [1, -1, -1]
            bd0["set_xform"]["flip_xyz"] = [round(fx[0] * lens_k, 6), round(fx[1] * lens_k, 6), fx[2]]
        if source and sc.get("shots"):
            sc["shots"][0]["source"] = source   # the setup that re-shoots the clip: its plate, for the NLE export
        return sc, nn

    scene, notes = build(mpu_known)
    # The performer: SAM 3D Body copies the person's whole performance onto a clay actor standing in the rebuilt set.
    # Someone the read only sees inside a car is its driver, seated at the wheel (convert.mount_riders): capturing
    # them would stand a clay figure beside the car and lock the camera for a "walking subject" that isn't there.
    cars = {a["id"] for a in scene["actors"] if a.get("kind") in ("car", "truck")}
    folk = [a for a in scene["actors"] if a.get("kind") in ("man", "woman", "child")]
    if take is not None and folk and all(a.get("mount_id") in cars for a in folk):
        take = None
        notes.append(f"people: {', '.join(a.get('name', 'the driver') for a in folk)} sits in the car; no motion capture")
    if take is not None:
        try:
            xf = scene["video2stage"]["xform"]
            cam_poses = poses
            if performer.camera_drifted(scene, breakdown):
                # Mono tracking on a near-static shot drifts when the subject walks at the lens (the camera "rises" and
                # backs off). Lock the camera to its first pose for the shot and for placing the performer.
                keys = scene["shots"][0]["camera_keys"]
                scene["shots"][0]["camera_keys"] = [keys[0]]
                cam_poses = [poses[0]] * len(poses)
                notes0.append("camera: the track drifted on a near-static shot (moving subject); locked to the first frame")
                notes.append(notes0[-1])
            A_, b_ = np.array(xf["A"]), np.array(xf["b"])
            placed = performer.place(take, cam_poses, times, A_, b_, K, (w, h), clip["fps"])
            if placed:
                aid = performer.attach(scene, info["file"], take, placed)
                # Its size: the clay's projection must cover SAM's 2D joints through this camera (same K as SAM's).
                s_fit = performer.fit_scale(take, placed, cam_poses, times, A_, b_, K, (w, h), clip["fps"])
                mpu0 = mpu = scene["video2stage"]["metres_per_unit"]
                for _ in range(4):
                    if abs(s_fit - 1) <= 0.01 or mpu_known:
                        break
                    # SAM 3D Body measured the performer in metres: that is the shot's scale (the camera-height /
                    # people guess put her 1/s too far). Rebuild the set at that scale, place her again, refit.
                    mpu = mpu / s_fit
                    scene, notes = build(mpu)
                    xf = scene["video2stage"]["xform"]
                    A_, b_ = np.array(xf["A"]), np.array(xf["b"])
                    if cam_poses is not poses:
                        scene["shots"][0]["camera_keys"] = scene["shots"][0]["camera_keys"][:1]
                    placed = performer.place(take, cam_poses, times, A_, b_, K, (w, h), clip["fps"]) or placed
                    aid = performer.attach(scene, info["file"], take, placed)
                    s_fit = performer.fit_scale(take, placed, cam_poses, times, A_, b_, K, (w, h), clip["fps"])
                if mpu != mpu0:
                    notes.append(f"scale from the performer (SAM 3D Body): {mpu:.4g} m per unit (the camera-height "
                                 f"guess was {abs(mpu0 / mpu - 1) * 100:.0f}% off)")
                act = next(a for a in scene["actors"] if a["id"] == aid)
                act["height_m"] = round(performer.stature(take) * s_fit, 3)
                fit = performer.overlay_error(take, placed, cam_poses, times, A_, b_, K, (w, h), clip["fps"], s_fit)
                act.setdefault("source", {})["overlay"] = {k: round(v, 3) if isinstance(v, float) else v for k, v in fit.items()}
                if abs(s_fit - 1) > 0.15:
                    notes.append(f"performer: the set's scale and SAM 3D Body's distance disagree by {abs(s_fit - 1) * 100:.0f}%;"
                                 f" the clay is sized to the picture ({act['height_m']:.2f} m)")
                dropped = performer.drop_background_people(scene, aid)
                if dropped:
                    notes.append(f"performer: left out {dropped} small background figure(s) the depth could not place")
                cut = performer.cutout(take, scene["video2stage"]["metres_per_unit"])
                bd = next((a for a in scene["actors"] if a.get("id") == "v2s_backdrop"), None)
                if cut and bd and min(times) < 0.25:   # the set mesh is the first frame's
                    cut["K"] = [round(float(K_da3[0, 0] / w), 5), round(float(K_da3[1, 1] / h), 5),   # the mesh's own
                                round(float(K_da3[0, 2] / w), 5), round(float(K_da3[1, 2] / h), 5)]
                    bd["set_xform"]["cut"] = cut
                notes.append(f"performer: {info['frames']} frames of motion capture on '{aid}', standing on the rebuilt floor")
            else:
                notes.append("performer: captured, but the feet could not be placed in the set (no picture positions)")
        except Exception as exc:  # noqa: BLE001 - the set and camera still stand without the performer
            notes.append(f"performer: motion capture failed ({exc})")
    try:
        finish_scene(scene, take=take, info=info, breakdown=breakdown, depths=list(packet["depth"]), scales=scales,
                     poses=poses, K=K, files=files, skies=None if packet.get("sky") is None else list(packet["sky"]),
                     times=times, clip=clip, scan_on=scan_on, has_relief=bool(glb), wardrobe_ref=wardrobe_ref, tag=tag,
                     sub=sub, notes=notes)
        rec["scene_words"] = (scene.get("video2stage") or {}).get("look_hint") or ""
    except Exception as exc:  # noqa: BLE001 - the scene as built still stands
        notes.append(f"set: finishing the rebuild failed ({exc})")
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000)
    try:
        stages.save(tag, rec)
    except Exception as exc:  # noqa: BLE001
        notes.append(f"stages: could not keep this run's record for Regenerate ({exc})")
    say("Done", 1.0)
    movers = [a for a in scene["actors"] if len(a.get("keys", [])) > 1]
    return {"scene": scene, "notes": notes, "timings": timings, "breakdown": breakdown, "tag": tag, "seed": int(seed),
            "stages": ran,
            "summary": {"objects": len([a for a in scene["actors"] if not a.get("set_piece") and a["kind"] != "glb"]),
                        "set_pieces": len([a for a in scene["actors"] if a.get("set_piece")]),
                        "movers": len(movers),
                        "camera_keys": len((scene.get("shots") or [{}])[0].get("camera_keys") or scene["camera_keys"]),
                        "performer": next((a["name"] for a in scene["actors"] if a.get("mocap")), None),
                        "frames": scene["shot"]["frames"], "depth_model": model, "vision_model": vmodel}}


def finish_scene(scene: dict, *, take, info, breakdown, depths, scales, poses, K, files, skies, times, clip,
                 scan_on: bool, has_relief: bool, wardrobe_ref: bool, tag: str, sub: str, notes: list) -> None:
    """After the set and the performer stand: the set-scan path (or, on the old route, the block triage against the
    frame-0 relief), the performer's build and opt-in wardrobe reference, and the Look text the App pre-fills."""
    from . import scenewords as SW
    from . import wardrobe as W
    v2s = scene.setdefault("video2stage", {})
    fallback = None
    if scan_on and v2s.get("xform") and depths:
        # The scan path edits the set in place (structure planes in, flat dressing out, the relief swapped for the scan,
        # covered blocks dropped). Without a fused scan none of that stands: the set goes back to the old block
        # builder's, exactly as it was, and the record says so.
        before = copy.deepcopy(scene.get("actors") or [])
        before_v2s = {k: copy.deepcopy(v2s[k]) for k in ("backdrop", "sky") if k in v2s}
        try:
            st = scanroute.apply(scene, depths=depths, scales=scales, poses=poses, K=K, files=files, skies=skies,
                                 breakdown=breakdown, times=times, duration=float(clip.get("duration") or 1.0),
                                 notes=notes, tag=f"v2s_{tag}")
        except Exception as exc:  # noqa: BLE001 - the old builder's set still stands
            st, fallback = None, f"the scan path failed ({exc})"
        if st is not None and not st.get("scan"):
            fallback = "the set scan did not build"
        if fallback is None:
            v2s["set_path"] = {"path": "scan", **{k: st[k] for k in ("planes", "scan", "dropped", "worded")}}
        else:
            scene["actors"] = before
            for k in ("backdrop", "sky"):
                v2s.pop(k, None)
            v2s.update(before_v2s)
            notes.append(f"set: {fallback}; fell back to the old block builder's set")
    if not (scan_on and v2s.get("xform") and depths) or fallback is not None:
        v2s["set_path"] = {"path": "blocks", **({"fallback": fallback} if fallback else {})}
        if has_relief and v2s.get("xform") and depths:
            A, b = np.asarray(v2s["xform"]["A"], float), np.asarray(v2s["xform"]["b"], float)
            d0 = np.asarray(depths[0], np.float32) * float(scales[0]) * float(np.linalg.norm(A[0]))
            tri = SW.triage_blocks(scene["actors"], poses[0], A, b, K, d0.shape[::-1], d0)
            v2s["set_path"].update(dropped=tri["dropped"], worded=tri["worded"])
            if tri["dropped"]:
                notes.append(f"set: dropped {len(tri['dropped'])} block(s) the set relief already shows")
    perf = next((a for a in scene.get("actors") or [] if a.get("mocap")), None)
    if perf is not None:
        ap = perf.setdefault("appearance", {})
        if ap.get("wardrobe") == "unknown":
            said = (perf.get("source") or {}).get("label") or "nothing"
            notes.append(f"performer: the vision model named no garment ('{said}'); the clay keeps its default shape "
                         "and colours from the read. Set the wardrobe in the inspector")
        # build: SAM 3D Body's shape when it has one, else the silhouette (the box's pixels at the body's depth)
        mask = None
        cut = performer.cutout(take, 1.0) if take else None
        if cut and depths:
            mask = W.person_mask_from_depth(depths[0], cut["box"])
        girth, src = W.girth_from(take, mask, female=perf.get("kind") == "woman")
        if girth:
            ap["girth"] = round(girth, 3)
            ap["build"] = W.nearest_build(girth)
            notes.append(f"performer: build from {src} (girth x{girth:.2f}, '{ap['build']}')")
        if wardrobe_ref:
            try:
                ref = write_wardrobe_ref(perf, take, files, sub, depths[0].shape[::-1] if depths else None,
                                         times=times, fps=float(clip.get("fps") or 24.0),
                                         duration=float(clip.get("duration") or 1.0))
                if ref:
                    perf["wardrobe_ref"] = ref
                    notes.append("performer: wardrobe reference saved (face blurred) for the Frame still")
            except Exception as exc:  # noqa: BLE001
                notes.append(f"performer: the wardrobe reference could not be made ({exc})")
    v2s["look_hint"] = SW.look_hint(scene)


def ref_frame_pair(take, times, fps: float) -> tuple[int, int | None]:
    """(sample index, take frame) for the wardrobe reference: ONE moment for both the picture and the face box. The
    take may start after the first sample (SAM 3D Body tracks from when the person is found); its frame 0 is then not
    files[0], and blurring frame 0's face on files[0] could miss the real face. The sample nearest the take's first
    frame, and the take frame nearest that sample's time. (0, None) without a take or sample times."""
    if not take or not times:
        return 0, None
    n = int(take.get("frames") or len(take.get("body") or []))
    src = take.get("source_frames") or list(range(n))
    if not src:
        return 0, None
    t_take = np.asarray(src, float) / max(fps, 1e-6)
    i = int(np.argmin(np.abs(np.asarray(times, float) - t_take[0])))
    k = int(np.argmin(np.abs(t_take - float(times[i]))))
    return i, k


def write_wardrobe_ref(actor: dict, take, files, sub: str, size, times=None, fps: float = 24.0,
                       duration: float = 1.0) -> str | None:
    """The face-blurred crop of the performer from one sample frame, saved in the input folder next to the samples.
    The picture, the person's box and the face box all come from the same moment (ref_frame_pair). Returns its
    input-relative name, or None without a box."""
    import cv2

    from . import wardrobe as W
    src = actor.get("source") or {}
    if not (src.get("bbox_start") or src.get("bbox_end")) or not files:
        return None
    i, k = ref_frame_pair(take, times, fps)
    i = min(i, len(files) - 1)
    img = weather.load_rgb(files[i])
    if img is None:
        return None
    H, Wd = img.shape[:2]
    t = (float(times[i]) / max(duration, 1e-6)) if times else 0.0
    bb = scanroute._box_at(src, min(1.0, max(0.0, t)))           # the read's box, at that sample's time
    box = [bb[0] / 1000 * Wd, bb[1] / 1000 * H, bb[2] / 1000 * Wd, bb[3] / 1000 * H]
    face = None
    if k is not None and take.get("focal_px") and take.get("body") and size:
        uv = performer.sam_2d(take, k, size) * np.array([Wd / size[0], H / size[1]])
        ok = np.isfinite(uv).all(axis=1)
        if ok.sum() >= 4:   # the person as SAM saw them at that moment: the box from the joints, grown for the clothes
            jx0, jy0 = uv[ok].min(0)
            jx1, jy1 = uv[ok].max(0)
            gx, gy = 0.2 * (jx1 - jx0), 0.12 * (jy1 - jy0)
            box = [max(0.0, jx0 - gx), max(0.0, jy0 - 1.6 * gy), min(Wd, jx1 + gx), min(H, jy1 + gy)]
        face = W.face_box_from_joints(uv, box)
    crop = W.reference_crop(img, box, face if face is not None else W.face_box_from_joints(None, box))
    name = "wardrobe_ref.png"
    out = os.path.join(os.path.dirname(files[i]), name)
    cv2.imwrite(out, crop[..., ::-1])
    return f"{sub}/{name}"
