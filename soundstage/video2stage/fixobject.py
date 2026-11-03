"""Fix this object: re-analyse ONE object of a Video → 3D rebuild instead of regenerating the whole world.

    fix   a rebuilt set piece looks wrong: SAM 3.1 tracks that object's region over the source frames (seeded by a
          click on a source frame in the Identical? bar, else by the object projected through the solved camera),
          the clearest frames are picked, and the object is rebuilt ALONE through the Photo → 3D object path
          (TripoSplat -> SplatToMesh, web/assets3d/maker.mjs) from the clearest one. Its placement, turn and size stay
          the solve's; the App swaps it in as a new version (Undo puts the old one back).
    add   something the rebuild missed: the same track from a click, then the object is placed where the bottom of its
          mask meets the floor through the solved camera, sized from the mask.
    Remove (an invented object) needs no server: the App deletes the actor, with Undo.

The frames and the camera come from the rebuild's stage record (stages.py): this never re-runs depth, the camera
solve or the motion capture. Every GPU step is an ordinary queued prompt of our own (queue.run_graph).
Without TripoSplat on the server the shape is kept and only its colour is re-read from the clearest frames (a note
says so).
"""
from __future__ import annotations

import json
import math
import os
import re

import numpy as np

from . import queue, stages

SAM_CKPT = "sam3.1_multiplex_fp16.safetensors"
TRIPO = {"unet": "triposplat_fp16.safetensors", "vae_decoder": "triposplat_vae_decoder_fp16.safetensors",
         "vae_flux2": "flux2-vae-triposplat.safetensors", "dino": "dino_v3_vit_h.safetensors"}
MODES = ("fix", "add")


def check_body(body: dict) -> str | None:
    """The route's input check: an error in plain words, or None."""
    if not isinstance(body, dict) or not body.get("video"):
        return "send {video, tag, mode: fix|add, actor | point}"
    if not re.fullmatch(r"[0-9a-f]{10}", str(body.get("tag") or "")):
        return "tag: the rebuild's tag (result.tag) is needed to find its frames and camera"
    mode = body.get("mode") or "fix"
    if mode not in MODES:
        return f"mode must be one of {', '.join(MODES)}"
    if mode == "fix" and not isinstance(body.get("actor"), dict):
        return "fix needs the actor to rebuild"
    if mode == "add" and not isinstance(body.get("point"), dict):
        return "add needs a click on a source frame: point {x, y} (0-1) and sample"
    return None


# ------------------------------------------------------------------------------------------------ geometry
def project(X, pose, A, b, K):
    """Stage point (metres) -> pixel on a sample, through the solved camera (pose: 3x4 cam0 -> camera)."""
    p0 = np.linalg.solve(np.asarray(A, float), np.asarray(X, float) - np.asarray(b, float))
    P = np.asarray(pose, float)
    c = P[:, :3] @ p0 + P[:, 3]
    if c[2] <= 1e-6:
        return None
    u = K[0, 0] * c[0] / c[2] + K[0, 2]
    v = K[1, 1] * c[1] / c[2] + K[1, 2]
    return float(u), float(v)


def seed_pixel(body: dict, size, cam: dict | None) -> tuple[int, tuple[float, float] | None]:
    """(sample index, pixel) to seed SAM: the click (0-1 of the frame) if there is one, else the actor's middle
    projected into the first sample that sees it."""
    w, h = size
    pt = body.get("point")
    if isinstance(pt, dict) and pt.get("x") is not None:
        i = int(body.get("sample") or 0)
        return i, (float(pt["x"]) * w, float(pt["y"]) * h)
    a = body.get("actor") or {}
    if not cam or not a.get("position"):
        return int(body.get("sample") or 0), None
    X = np.array(a["position"], float) + np.array([0.0, 0.5 * float(a.get("height_m") or 1.0), 0.0])
    order = [int(body.get("sample") or 0)] + list(range(len(cam["poses"])))
    for i in order:
        if 0 <= i < len(cam["poses"]):
            uv = project(X, cam["poses"][i], cam["A"], cam["b"], cam["K"])
            if uv and 0 <= uv[0] < w and 0 <= uv[1] < h:
                return i, uv
    return order[0], None


# ------------------------------------------------------------------------------------------------ SAM 3.1 track
def track_graph(names: list[str], seed: int, pt, text: str, prefix: str, ckpt: str = SAM_CKPT) -> tuple[dict, dict]:
    """One prompt: SAM3_Detect at the seed point on sample `seed`, then SAM3_VideoTrack forward (seed..last) and
    backward (seed..0) over the samples, ONE object each. Returns (graph, {save node: [sample indices in order]})."""
    g: dict = {}

    def node(cls, **inputs):
        nid = f"f{len(g) + 1}"
        g[nid] = {"class_type": cls, "inputs": inputs}
        return nid

    ck = node("CheckpointLoaderSimple", ckpt_name=ckpt)
    cond = node("CLIPTextEncode", text=(text or "object").strip()[:80], clip=[ck, 1])
    loads = {i: node("LoadImage", image=n) for i, n in enumerate(names)}
    det = node("SAM3_Detect", model=[ck, 0], image=[loads[seed], 0], conditioning=[cond, 0], threshold=0.3,
               refine_iterations=2, individual_masks=False,
               positive_coords=json.dumps([{"x": int(round(pt[0])), "y": int(round(pt[1]))}]))
    keys = {}
    for tag, order in (("fw", list(range(seed, len(names)))), ("bw", list(range(seed, -1, -1)))):
        if len(order) < 2 and tag == "bw":
            continue
        prev = None
        for i in order:
            prev = [loads[i], 0] if prev is None else [node("ImageBatch", image1=prev, image2=[loads[i], 0]), 0]
        tr = node("SAM3_VideoTrack", images=prev, model=[ck, 0], initial_mask=[det, 0], conditioning=[cond, 0],
                  detection_threshold=0.5, max_objects=1, detect_interval=1)
        m = node("SAM3_TrackToMask", track_data=[tr, 0], object_indices="0")
        im = node("MaskToImage", mask=[m, 0])
        sid = node("SaveImage", images=[im, 0], filename_prefix=f"{prefix}_{tag}")
        keys[sid] = order
    return g, keys


def masks_from_outputs(outputs: dict, keys: dict, out_dir: str, reader=None) -> dict:
    """The saved mask batches -> {sample index: bool HxW}. The seed frame comes from the forward track."""
    import cv2
    read = reader or (lambda p: cv2.imread(p, cv2.IMREAD_GRAYSCALE))
    out: dict = {}
    for sid, order in keys.items():
        ims = (outputs.get(sid) or {}).get("images") or []
        for i, entry in zip(order, ims):
            if i in out:
                continue
            m = read(os.path.join(out_dir, entry.get("subfolder") or "", entry["filename"]))
            if m is not None:
                out[i] = np.asarray(m) > 127
    return out


def clearest(masks: dict, frames: dict | None = None, k: int = 3) -> list[dict]:
    """Rank the frames that show the object best: big, whole (not cut by the frame edge), the usual shape (area
    near the median: no merge with a neighbour, no half-hidden frame) and sharp inside the mask. Returns
    [{sample, score, area, edge, sharp}] best first, at most k."""
    rows = []
    areas = [int(m.sum()) for m in masks.values() if m.any()]
    if not areas:
        return []
    med = float(np.median(areas))
    for i, m in masks.items():
        a = int(m.sum())
        if a < 30:
            continue
        ys, xs = np.nonzero(m)
        hh, ww = m.shape
        edge = bool(xs.min() <= 1 or ys.min() <= 1 or xs.max() >= ww - 2 or ys.max() >= hh - 2)
        sharp = 1.0
        if frames is not None and i in frames and frames[i] is not None:
            import cv2
            g = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY) if frames[i].ndim == 3 else frames[i]
            lap = cv2.Laplacian(g.astype(np.float32), cv2.CV_32F)
            sharp = float(np.sqrt(max(1e-6, lap[m].var())))
        typical = math.exp(-abs(math.log(a / med)))
        score = math.sqrt(a) * typical * (0.4 if edge else 1.0) * (sharp ** 0.5)
        rows.append({"sample": int(i), "score": round(score, 3), "area": a, "edge": edge, "sharp": round(sharp, 2)})
    rows.sort(key=lambda r: -r["score"])
    return rows[:k]


def crop_rgba(img: np.ndarray, mask: np.ndarray, pad: float = 0.12) -> np.ndarray:
    """The object cut out of its frame (BGRA, square-ish crop around the mask with a margin), for Photo → 3D."""
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * pad))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    h, w = mask.shape
    out = np.zeros((side, side, 4), np.uint8)
    sx0, sy0 = cx - side // 2, cy - side // 2
    ax0, ay0, ax1, ay1 = max(0, sx0), max(0, sy0), min(w, sx0 + side), min(h, sy0 + side)
    out[ay0 - sy0:ay1 - sy0, ax0 - sx0:ax1 - sx0, :3] = img[ay0:ay1, ax0:ax1, :3]
    out[ay0 - sy0:ay1 - sy0, ax0 - sx0:ax1 - sx0, 3] = np.where(mask[ay0:ay1, ax0:ax1], 255, 0)
    return out


def object_graph(image: str, seed: int, prefix: str, faces: int = 60000) -> dict:
    """Photo → 3D object, the same nodes as web/assets3d/maker.mjs photoToMesh(kind "object"), with the SAM mask as
    the alpha (LoadImage's mask is 1 - alpha, so it is inverted back) instead of a background remover."""
    s = int(seed) % (2 ** 31)
    return {
        "in": {"class_type": "LoadImage", "inputs": {"image": image}},
        "mk": {"class_type": "InvertMask", "inputs": {"mask": ["in", 1]}},
        "t1": {"class_type": "TripoSplatPreprocessImage", "inputs": {"image": ["in", 0], "mask": ["mk", 0], "erode_radius": 1, "size": 1024}},
        "t2": {"class_type": "CLIPVisionLoader", "inputs": {"clip_name": TRIPO["dino"]}},
        "t3": {"class_type": "VAELoader", "inputs": {"vae_name": TRIPO["vae_flux2"]}},
        "t4": {"class_type": "TripoSplatConditioning", "inputs": {"clip_vision": ["t2", 0], "vae": ["t3", 0], "image": ["t1", 0]}},
        "t5": {"class_type": "UNETLoader", "inputs": {"unet_name": TRIPO["unet"], "weight_dtype": "default"}},
        "t6": {"class_type": "KSampler", "inputs": {"model": ["t5", 0], "positive": ["t4", 0], "negative": ["t4", 1],
                                                    "latent_image": ["t4", 2], "seed": s, "steps": 20, "cfg": 3,
                                                    "sampler_name": "dpmpp_2m", "scheduler": "simple", "denoise": 1}},
        "t7": {"class_type": "VAELoader", "inputs": {"vae_name": TRIPO["vae_decoder"]}},
        "t8": {"class_type": "VAEDecodeTripoSplat", "inputs": {"samples": ["t6", 0], "vae": ["t7", 0], "num_gaussians": 262144, "seed": s}},
        "m1": {"class_type": "SplatToMesh", "inputs": {"splat": ["t8", 0], "resolution": 256, "kernel": 5, "smooth": 2, "level": 0.6,
                                                       "min_component": 500, "min_opacity": 0.02, "color_sharpen": 2}},
        "m2": {"class_type": "DecimateMesh", "inputs": {"mesh": ["m1", 0], "target_face_count": faces, "placement_mode": "qem",
                                                        "placement_mode.line_quadric_weight": 0,
                                                        "placement_mode.feature_edge_quadric_weight": 0,
                                                        "placement_mode.feature_edge_min_dihedral_deg": 30,
                                                        "placement_mode.clamp_v_to_edge": True}},
        "s1": {"class_type": "SaveGLB", "inputs": {"mesh": ["m2", 0], "filename_prefix": prefix}},
    }


def mean_colour(img: np.ndarray, mask: np.ndarray) -> str:
    b, g, r = (np.median(img[mask][:, c]) for c in range(3))
    return "#{:02x}{:02x}{:02x}".format(int(r), int(g), int(b))


# ------------------------------------------------------------------------------------------------ the new actor
def fixed_actor(old: dict, *, glb: dict | None, colour: str | None, frames: list, seed: int) -> dict:
    """The rebuilt object as the next version of `old`: same id, place, turn and size (the solve's)."""
    a = json.loads(json.dumps(old))
    ver = int(a.get("version") or 1) + 1
    keep = {k: a.get(k) for k in ("position", "keys", "rotation_deg", "height_m", "scale") if a.get(k) is not None}
    if glb:
        for k in ("recipe", "design", "library"):
            a.pop(k, None)
        a.update(kind="glb", format="glb", url=glb["url"], height_m_set=True)
    if colour:
        a["appearance"] = {**(a.get("appearance") or {}), "color": colour}
    a.update(keep, version=ver, set_piece=bool(old.get("set_piece", True)))
    src = dict(a.get("source") or {})
    src["fixed"] = {"version": ver, "frames": [r["sample"] for r in frames], "seed": int(seed),
                    "how": "SAM 3.1 track + Photo → 3D (TripoSplat)" if glb else "SAM 3.1 track; colour re-read (no TripoSplat)"}
    a["source"] = src
    return a


def added_actor(mask: np.ndarray, sample: int, cam: dict, label: str, ids: set, *, glb: dict | None, colour: str | None,
                seed: int) -> dict | None:
    """A missed object from its mask on one sample: where the bottom of the mask meets the floor, and how tall the
    mask is at that distance."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 30:
        return None
    K, A, b = cam["K"], np.asarray(cam["A"], float), np.asarray(cam["b"], float)
    P = np.asarray(cam["poses"][sample], float)
    mpu = float(np.linalg.norm(A[0]))
    Rw = A / mpu
    R, t = P[:, :3], P[:, 3]
    o = A @ (-R.T @ t) + b
    foot = np.array([float(np.median(xs[ys >= np.percentile(ys, 95)])), float(ys.max()), 1.0])
    d = Rw @ (R.T @ (np.linalg.inv(K) @ foot))
    d /= np.linalg.norm(d)
    if d[1] >= -1e-6 or o[1] <= 0:
        return None
    hit = o + d * (-o[1] / d[1])
    dist = float(np.linalg.norm(hit - o))
    hpx = float(ys.max() - ys.min() + 1)
    height = max(0.05, hpx / K[1, 1] * dist)
    base = re.sub(r"[^a-z0-9]+", "_", (label or "object").lower()).strip("_")[:24] or "object"
    aid, n = base, 2
    while aid in ids:
        aid, n = f"{base}_{n}", n + 1
    a = {"id": aid, "name": (label or "Added object")[:40], "position": [round(float(hit[0]), 3), 0.0, round(float(hit[2]), 3)],
         "rotation_deg": 0.0, "height_m": round(height, 3), "set_piece": True, "version": 1}
    a["keys"] = [{"frame": 0, "position": list(a["position"])}]
    if glb:
        a.update(kind="glb", format="glb", url=glb["url"], height_m_set=True)
    else:
        w = max(0.05, (xs.max() - xs.min() + 1) / K[0, 0] * dist)
        a.update(kind="custom", recipe={"name": label or "object", "rig": "static", "size_m": [round(w, 3), round(height, 3), round(w, 3)],
                                        "parts": [{"shape": "box", "pos": [0, height / 2, 0], "size": [w, height, w], "color": colour or "#888888"}],
                                        "set_piece": True, "measured": True})
    if colour:
        a["appearance"] = {"color": colour}
    a["source"] = {"label": label, "added": {"sample": int(sample), "seed": int(seed)}}
    return a


# ------------------------------------------------------------------------------------------------ the job
def _camera(rec: dict, body: dict) -> dict | None:
    xf = body.get("xform") or {}
    if not stages.usable(rec, "camera") or not xf.get("A"):
        return None
    poses, _, K, *_ = stages.load_solve(rec["camera"]["npz"])
    return {"poses": poses, "K": np.asarray(K, float), "A": np.asarray(xf["A"], float), "b": np.asarray(xf["b"], float)}


def _tripo_ready() -> bool:
    try:
        from ..assets3d import routes as R3
        return bool(R3.status().get("mesh_object"))
    except Exception:  # noqa: BLE001 - outside ComfyUI or an older core
        return False


async def run(base_url: str, body: dict, progress=None) -> dict:
    import cv2
    import folder_paths
    say = progress or (lambda step, frac: None)
    err = check_body(body)
    if err:
        raise ValueError(err)
    mode = body.get("mode") or "fix"
    tag = body["tag"]
    seed = int(body.get("seed") or 0) or 1
    notes: list[str] = []
    rec = stages.load(tag)
    sub = f"soundstage/v2s_{tag}"
    fdir = os.path.join(folder_paths.get_input_directory(), sub)
    names = sorted(f for f in os.listdir(fdir) if re.fullmatch(r"f_\d+\.png", f)) if os.path.isdir(fdir) else []
    if not names:
        raise ValueError("the rebuild's source frames are gone from the input folder; rebuild the clip first")
    imgs = {i: cv2.imread(os.path.join(fdir, n)) for i, n in enumerate(names)}
    h, w = imgs[0].shape[:2]
    cam = _camera(rec, body)
    actor = body.get("actor") or {}
    label = str(body.get("label") or (actor.get("source") or {}).get("label") or actor.get("name") or "object")
    i0, pt = seed_pixel(body, (w, h), cam)
    if pt is None:
        raise ValueError("could not find the object on a source frame: click it in the Identical? bar")
    say("Tracking the object over the clip (SAM 3.1)", 0.15)
    prefix = f"soundstage/v2s_fix/{tag}_{re.sub(r'[^a-z0-9_]', '', str(actor.get('id') or 'add'))[:24]}_{seed}"
    g, keys = track_graph([f"{sub}/{n}" for n in names], i0, pt, label, prefix)
    out, _ = await queue.run_graph(base_url, g, "object track", timeout_s=1800)
    masks = masks_from_outputs(out, keys, folder_paths.get_output_directory())
    ranked = clearest(masks, imgs)
    if not ranked:
        raise ValueError(f"SAM 3.1 found nothing at that spot on frame {i0 + 1}; click the object itself")
    best = ranked[0]["sample"]
    notes.append(f"track: '{label}' on {sum(1 for m in masks.values() if m.any())} of {len(names)} source frames; "
                 f"clearest {', '.join(str(r['sample'] + 1) for r in ranked)}")
    colour = mean_colour(imgs[best], masks[best])
    glb = None
    if _tripo_ready():
        say("Rebuilding the object alone (Photo → 3D)", 0.5)
        crop = crop_rgba(imgs[best], masks[best])
        cdir = os.path.join(folder_paths.get_input_directory(), "soundstage", "v2s_fix")
        os.makedirs(cdir, exist_ok=True)
        cname = f"{os.path.basename(prefix)}_crop.png"
        cv2.imwrite(os.path.join(cdir, cname), crop)
        mo, _ = await queue.run_graph(base_url, object_graph(f"soundstage/v2s_fix/{cname}", seed, f"{prefix}_obj"),
                                      "object rebuild", timeout_s=1800)
        files = [f for f in ((mo.get("s1") or {}).get("3d") or (mo.get("s1") or {}).get("glb") or []) if isinstance(f, dict)]
        if not files:   # SaveGLB's ui key differs between core versions: take any saved file
            files = [f for v in (mo.get("s1") or {}).values() if isinstance(v, list) for f in v if isinstance(f, dict) and f.get("filename")]
        if files:
            f = files[0]
            glb = {"url": "/view?filename={}&subfolder={}&type={}".format(f["filename"], f.get("subfolder", ""), f.get("type", "output"))}
        else:
            notes.append("rebuild: Photo → 3D saved no mesh; kept the shape and re-read the colour")
    else:
        notes.append("rebuild: Photo → 3D (TripoSplat) is not on this server; kept the shape and re-read its colour")
    say("Swapping it in", 0.95)
    if mode == "fix":
        new = fixed_actor(actor, glb=glb, colour=colour, frames=ranked, seed=seed)
    else:
        if cam is None:
            raise ValueError("this rebuild kept no camera solve (rebuild it again on this version first)")
        new = added_actor(masks.get(i0, masks[best]), i0 if i0 in masks else best, cam, label,
                          set(body.get("ids") or []), glb=glb, colour=colour, seed=seed)
        if new is None:
            raise ValueError("the object's base does not meet the floor in that frame; click a frame where it stands")
    say("Done", 1.0)
    return {"mode": mode, "actor": new, "frames": ranked, "seed_sample": i0, "notes": notes}
