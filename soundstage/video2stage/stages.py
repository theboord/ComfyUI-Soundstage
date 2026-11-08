"""The stages of one Video → 3D rebuild, kept on disk so ↻ Regenerate re-runs only what is unlocked.

One rebuild of clip tag T (pipeline.run) leaves, in output/soundstage_v2s/:
    v2s_T.npz              Depth Anything 3's packet (SoundstageDA3Export)            stage "depth"
    v2s_T_stages.json      this record: which file holds each stage and with what seed
    v2s_T_solve.npz        the camera solve (poses, scales, K, ground, straightened depth) stage "camera"
and the performer's take in output/soundstage/mocap/ (stage "mocap"), the vision model's read in the record
(stage "breakdown"), the set scan .glb in output/soundstage/.

Regenerate's locks map to stages: camera -> "camera", performer -> "mocap", set -> "breakdown" + its build seed.
Depth is the same every time for the same frames (DA3 has no seed), so a regenerate always reuses it when present.
A rebuild from before this record existed is picked up from the files it left (bootstrap()).
"""
from __future__ import annotations

import glob
import json
import os

import numpy as np

SUBDIR = "soundstage_v2s"
LOCKS = {"camera": "camera", "performer": "mocap", "set": "breakdown"}


def _out() -> str:
    import folder_paths
    return folder_paths.get_output_directory()


def record_path(tag: str, out_dir: str | None = None) -> str:
    return os.path.join(out_dir or _out(), SUBDIR, f"v2s_{tag}_stages.json")


def load(tag: str, out_dir: str | None = None) -> dict:
    """The record for tag (bootstrapped from an older run's files when there is none); {} when nothing is on disk."""
    p = record_path(tag, out_dir)
    try:
        with open(p) as f:
            rec = json.load(f)
        if isinstance(rec, dict):
            return rec
    except (OSError, ValueError):
        pass
    return bootstrap(tag, out_dir)


def content_hash(path: str, chunk: int = 1 << 20, picks: int = 16) -> str:
    """A content hash of a clip that does not read all of it: its size, the first and last MiB and `picks` MiB spread
    between (sha1). The same clip copied or renamed hashes the same; a different clip with the same name does not."""
    import hashlib
    size = os.path.getsize(path)
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        if size <= chunk * (picks + 2):
            h.update(f.read())
        else:
            for k in range(picks + 2):
                f.seek(int(round(k * (size - chunk) / (picks + 1))))
                h.update(f.read(chunk))
    return h.hexdigest()


def matches(rec: dict, path: str, sha: str | None) -> bool:
    """Was this record made from that clip? By content hash, else by the same real path. Never by the name alone: two
    different clips called clip.mp4 are not the same shot (older records without either are not matched)."""
    if not isinstance(rec, dict):
        return False
    if sha and rec.get("source_sha"):
        return rec["source_sha"] == sha
    return bool(rec.get("source_path")) and os.path.realpath(str(rec["source_path"])) == os.path.realpath(str(path))


def save(tag: str, rec: dict, out_dir: str | None = None) -> str:
    p = record_path(tag, out_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, p)
    return p


def bootstrap(tag: str, out_dir: str | None = None) -> dict:
    """An older rebuild's own outputs: its DA3 packet, its newest set scan and its newest take."""
    out = out_dir or _out()
    rec: dict = {"tag": tag}
    npz = os.path.join(out, SUBDIR, f"v2s_{tag}.npz")
    if os.path.isfile(npz):
        glbs = sorted(glob.glob(os.path.join(out, "soundstage", f"v2s_{tag}_set_*.glb")))
        rec["depth"] = {"npz": npz, "glb": ({"filename": os.path.basename(glbs[-1]), "subfolder": "soundstage",
                                             "type": "output"} if glbs else None)}
    takes = sorted(glob.glob(os.path.join(out, "soundstage", "mocap", f"v2s_{tag}_2*.json")))
    if takes:
        rel = os.path.relpath(takes[-1], out).replace(os.sep, "/")
        try:
            with open(takes[-1]) as f:
                n = int(json.load(f).get("frames") or 0)
        except (OSError, ValueError):
            n = 0
        rec["mocap"] = {"file": rel, "frames": n}
    return rec if len(rec) > 1 else {}


def usable(rec: dict, stage: str, out_dir: str | None = None) -> bool:
    """Is that stage in the record with its files still on disk?"""
    s = (rec or {}).get(stage)
    if not s:
        return False
    if stage == "depth":
        return os.path.isfile(s.get("npz") or "")
    if stage == "camera":
        return os.path.isfile(s.get("npz") or "")
    if stage == "mocap":
        return os.path.isfile(os.path.join(out_dir or _out(), s.get("file") or "\0"))
    return stage == "breakdown" and isinstance(s.get("read"), dict)


def reuse_set(lock: dict | None, rec: dict, out_dir: str | None = None) -> set:
    """Regenerate's locks -> the stages to take from the record (depth whenever it is there)."""
    want = {"depth"} | {LOCKS[k] for k, on in (lock or {}).items() if on and k in LOCKS}
    return {s for s in want if usable(rec, s, out_dir)}


def save_solve(tag: str, poses, scales, K, ground, notes, depth, seed: int, out_dir: str | None = None) -> str:
    p = os.path.join(out_dir or _out(), SUBDIR, f"v2s_{tag}_solve.npz")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    g = np.zeros(0) if ground is None else np.concatenate([np.asarray(ground[0], float).ravel(),
                                                            np.asarray(ground[1:], float).ravel()])
    np.savez_compressed(p, poses=np.asarray(poses, float), scales=np.asarray(scales, float), K=np.asarray(K, float),
                        ground=g, depth=np.asarray(depth, np.float32), notes=np.array(json.dumps(list(notes))),
                        seed=np.array(int(seed)))
    return p


def load_solve(path: str):
    """-> (poses, scales, K, ground, notes, depth), as pipeline.solve returns them."""
    with np.load(path, allow_pickle=False) as z:
        g = z["ground"]
        ground = None if g.size == 0 else (g[:3], float(g[3]), *(float(v) for v in g[4:]))
        return (list(z["poses"]), z["scales"], z["K"], ground, json.loads(str(z["notes"])), z["depth"])
