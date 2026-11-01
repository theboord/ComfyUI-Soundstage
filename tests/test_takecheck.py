"""Milestone 16: takes that check themselves. Every detector on synthetic clips made with ffmpeg, the car-direction
check on a synthetic street, the blocking score on synthetic box/matte pairs, readiness, timing, and the recipe's
round trip through an MP4's metadata."""
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.takecheck import blocking as B  # noqa: E402
from soundstage.takecheck import check as C  # noqa: E402
from soundstage.takecheck import detect as D  # noqa: E402
from soundstage.takecheck import readiness as RD  # noqa: E402
from soundstage.takecheck import recipe as R  # noqa: E402
from soundstage.takecheck import store  # noqa: E402
from soundstage.takecheck import timing as T  # noqa: E402
from soundstage.takecheck.video import probe, read_frames  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not installed")
try:
    import cv2  # noqa: F401
    HAS_CV2 = True
except Exception:  # noqa: BLE001
    HAS_CV2 = False
needs_cv2 = pytest.mark.skipif(not HAS_CV2, reason="OpenCV not installed")

W, H, FPS = 320, 176, 24


def _scene_frame(i: int, rng=None) -> np.ndarray:
    """A textured picture that pans one pixel per frame (so every frame differs) with a moving disc."""
    yy, xx = np.mgrid[0:H, 0:W]
    base = (127 + 60 * np.sin((xx + 2 * i) / 9.0) * np.cos(yy / 7.0) + 40 * np.sin((xx + yy + 3 * i) / 23.0)).astype(np.float32)
    cx, cy = 40 + 2 * i, 90
    base[(xx - cx) ** 2 + (yy - cy) ** 2 < 15 ** 2] = 230
    img = np.stack([base, base * 0.9, base * 0.8], -1)
    return np.clip(img, 0, 255).astype(np.uint8)


def _write(path: Path, frames: list[np.ndarray], meta: dict | None = None) -> Path:
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p"]
    for k, v in (meta or {}).items():
        cmd += ["-metadata", f"{k}={v}"]
    cmd += ["-movflags", "use_metadata_tags", str(path)]
    subprocess.run(cmd, input=b"".join(f.tobytes() for f in frames), check=True)
    return path


def _clip(tmp_path, name, frames, meta=None):
    return _write(tmp_path / f"{name}.mp4", frames, meta)


def _labels(res):
    return [(e["kind"], e["start"], e["end"]) for e in res["issues"]]


# ------------------------------------------------------------------------------------------------ detectors

@needs_ffmpeg
def test_clean_moving_clip_is_clean(tmp_path):
    res = C.check_take(str(_clip(tmp_path, "clean", [_scene_frame(i) for i in range(48)])), faces=False)
    assert res["verdict"] == "clean", res["issues"]
    assert res["chips"] == [{"tone": "ok", "text": "✓ clean"}]


@needs_ffmpeg
def test_black_frames_are_found(tmp_path):
    frames = [_scene_frame(i) for i in range(48)]
    for i in range(20, 26):
        frames[i] = np.zeros_like(frames[i])
    res = C.check_take(str(_clip(tmp_path, "black", frames)), faces=False)
    blk = [e for e in res["issues"] if e["kind"] == "black"]
    assert len(blk) == 1 and abs(blk[0]["start"] - 20 / FPS) < 0.05 and blk[0]["frames"] == 6
    assert res["verdict"] == "bad" and res["chips"][0]["text"].startswith("⚠ black")


@needs_ffmpeg
def test_frozen_stretch_is_found(tmp_path):
    frames = [_scene_frame(i) for i in range(72)]
    for i in range(30, 45):               # 15 identical frames: a 0.6 s freeze
        frames[i] = frames[29]
    res = C.check_take(str(_clip(tmp_path, "frozen", frames)), faces=False)
    fr = [e for e in res["issues"] if e["kind"] == "freeze"]
    assert len(fr) == 1, res["issues"]
    assert abs(fr[0]["start"] - 29 / FPS) < 0.1 and abs(fr[0]["end"] - 45 / FPS) < 0.1
    assert fr[0]["label"].startswith("freeze 1.2–1.9")


@needs_ffmpeg
def test_freeze_where_the_stage_holds_is_not_flagged():
    sig = {"diff": np.array([np.nan] + [0.02] * 20 + [0.0] * 12 + [0.02] * 10, dtype=np.float32)}
    sig["local"] = sig["diff"]
    assert len(D.freeze(sig, 24.0)) == 1
    held = np.array([True] * 21 + [False] * 12 + [True] * 10)
    assert D.freeze(sig, 24.0, stage=held) == []


@needs_ffmpeg
def test_stutter_repeated_frames_inside_motion(tmp_path):
    frames = []
    for i in range(72):
        j = i - 1 if (24 <= i < 48 and i % 3 == 0) else i       # a repeated frame every third frame for a second
        frames.append(_scene_frame(j))
    res = C.check_take(str(_clip(tmp_path, "stutter", frames)), faces=False)
    st = [e for e in res["issues"] if e["kind"] == "stutter"]
    assert len(st) == 1 and 0.9 < st[0]["start"] < 1.2 and st[0]["frames"] >= 3


@needs_ffmpeg
def test_a_jump_between_frames_is_found(tmp_path):
    frames = [_scene_frame(i) for i in range(48)]
    other = [np.roll(_scene_frame(i + 200), 60, axis=1)[:, ::-1].copy() for i in range(48)]
    frames = frames[:30] + other[30:]                              # a hard jump at frame 30
    res = C.check_take(str(_clip(tmp_path, "jump", frames)), faces=False)
    j = [e for e in res["issues"] if e["kind"] == "jump"]
    assert len(j) == 1 and abs(j[0]["start"] - 30 / FPS) < 0.05


@needs_ffmpeg
def test_heavy_smear_is_found(tmp_path):
    frames = [_scene_frame(i) for i in range(48)]
    for i in range(30, 44):
        f = frames[i].astype(np.float32)
        for _ in range(6):                                          # a strong box blur: the detail melts
            f = (f + np.roll(f, 2, 0) + np.roll(f, -2, 0) + np.roll(f, 2, 1) + np.roll(f, -2, 1)) / 5
        frames[i] = f.astype(np.uint8)
    res = C.check_take(str(_clip(tmp_path, "smear", frames)), faces=False)
    sm = [e for e in res["issues"] if e["kind"] == "smear"]
    assert len(sm) == 1 and abs(sm[0]["start"] - 30 / FPS) < 0.1, res["issues"]


def test_chips_order_bad_first_and_more():
    issues = [{"kind": "smear", "label": "smear 1.0–2.0 s", "start": 1.0}, {"kind": "freeze", "label": "freeze 0.2–0.6 s", "start": 0.2},
              {"kind": "vehicle", "label": "Sports car faces the wrong way", "start": 0.0}, {"kind": "pop", "label": "pop at 3.0 s", "start": 3.0}]
    chips = C.chips(issues)
    assert [c["text"] for c in chips] == ["⚠ Sports car faces the wrong way", "⚠ freeze 0.2–0.6 s", "⚠ smear 1.0–2.0 s", "+1 more"]
    assert chips[0]["tone"] == "bad" and chips[1]["tone"] == "warn"


# ------------------------------------------------------------------------------------------------ cars

STREET = {
    "version": 2, "shot": {"frames": 49, "fps": 24},
    "camera": {"position": [0, 1.5, -10], "target": [0, 1.0, 10], "focal_mm": 35},
    "actors": [{"id": "car", "name": "Sports car", "kind": "sports_car", "height_m": 1.2,
                "keys": [{"frame": 0, "position": [0, 0, 4]}, {"frame": 48, "position": [0, 0, 16]}]}],
}


def _street_frames(lamp_rgb, n=49, w=640, h=341):
    """Frames of the synthetic street: the car's projected box with a lamp pair low on its near end."""
    from soundstage.cine import geometry as G
    from soundstage.look import scene as S
    frames = []
    last = 48
    a = STREET["actors"][0]
    for i in range(n):
        img = np.full((h, w, 3), 20, np.uint8)
        v = D._vehicle_view(G, S, a, i, last, STREET, w, h, G.STAGE_ASPECT)
        x0, y0, x1, y1 = [int(t) for t in v["box"]]
        img[y0:y1, x0:x1] = (90, 20, 25)                               # a dark red body
        bw = x1 - x0
        r = max(3, bw // 14)
        cy = int(y0 + 0.55 * (y1 - y0))
        for cx in (int(x0 + 0.2 * bw), int(x1 - 0.2 * bw)):
            yy, xx = np.ogrid[:h, :w]
            img[(xx - cx) ** 2 + (yy - cy) ** 2 <= r * r] = lamp_rgb
        frames.append(img)
    return np.stack(frames)


@needs_cv2
def test_car_showing_its_headlights_while_driving_away_is_flagged():
    rgb = _street_frames((255, 252, 245))                               # white headlights toward the camera
    issues, rep = D.vehicle_direction(rgb, list(range(49)), STREET, 24.0)
    assert rep[0]["expected"] == "tail" and rep[0]["verdict"] == "reversed"
    assert len(issues) == 1 and issues[0]["label"] == "Sports car faces the wrong way"
    assert "reads as driving backwards" in issues[0]["detail"]


@needs_cv2
def test_car_showing_its_tail_lights_while_driving_away_passes():
    rgb = _street_frames((255, 120, 110))                               # lit tail lights: red, burning near white
    issues, rep = D.vehicle_direction(rgb, list(range(49)), STREET, 24.0)
    assert issues == [] and rep[0]["verdict"] == "ok"


@needs_cv2
def test_unlit_car_is_inconclusive_never_a_pass():
    rgb = _street_frames((90, 20, 25))                                   # no lamps at all (daylight, unlit)
    issues, rep = D.vehicle_direction(rgb, list(range(49)), STREET, 24.0)
    assert issues == [] and rep[0]["verdict"] == "inconclusive"


def test_lamp_classes():
    assert D.lamp_class({"hue": 16, "sat": 0.4, "val": 252}) == "red"          # a lit tail light (graded orange-red)
    assert D.lamp_class({"hue": 2, "sat": 0.7, "val": 200}) == ""              # red paint catching a street light
    assert D.lamp_class({"hue": 32, "sat": 0.9, "val": 250}) == "head"         # amber headlight
    assert D.lamp_class({"hue": 210, "sat": 0.05, "val": 252}) == "head"       # blown-out white headlight
    assert D.lamp_class({"hue": 220, "sat": 0.7, "val": 250}) == ""            # a blue light bar


# ------------------------------------------------------------------------------------------------ blocking

def test_actor_on_its_mark_and_off_it():
    stage = {"a": [(10, 10, 50, 90)] * 6, "b": [(100, 10, 140, 90)] * 6}
    tracks = [[(12, 12, 52, 88)] * 6,                                    # a: where the stage put it
              [(160, 10, 200, 90)] * 3 + [(102, 8, 141, 92)] * 3]       # b: off its mark for the first half
    res = {a["id"]: a for a in B.actor_scores(stage, tracks, times=[0, 1, 2, 3, 4, 5])}
    assert res["a"]["on_mark"] == 1.0 and res["a"]["iou"] > 0.8
    assert res["b"]["on_mark"] == 0.5 and res["b"]["drift_at"] == [0, 1, 2]


def test_a_track_sam_lost_and_found_again_still_counts():
    """SAM re-detects a car as a new track after losing it (Blocking_Adherence REPORT): the second fragment stands in
    where the matched track has no box, so a take that sits on its marks isn't scored as drifting."""
    stage = {"car": [(10, 10, 90, 60)] * 6}
    tracks = [[(12, 12, 88, 58)] * 3 + [None] * 3,          # first fragment
              [None] * 3 + [(11, 10, 91, 61)] * 3,          # the same car, picked up again
              [(300, 10, 340, 40)] * 6]                     # another car somewhere else, never the actor's
    res = B.actor_scores(stage, tracks, {"car": "car"}, {"car": "car"}, ["car", "car", "car"], times=list(range(6)))
    assert res[0]["on_mark"] == 1.0 and res[0]["iou"] > 0.85
    # A fragment of a different kind is never borrowed.
    res = B.actor_scores(stage, tracks, {"car": "car"}, {"car": "car"}, ["car", "person", "car"], times=list(range(6)))
    assert res[0]["on_mark"] == 0.5


def test_tracks_match_by_kind():
    stage = {"rider": [(10, 10, 50, 90)] * 4}
    tracks = [[(10, 10, 50, 90)] * 4, [(11, 11, 49, 89)] * 4]
    m = B.match_tracks(stage, tracks, {"rider": "person"}, ["horse", "person"])
    assert m == {"rider": 1}


def test_mask_boxes():
    m = np.zeros((2, 1, 20, 30))
    m[0, 0, 5:10, 3:9] = 1
    assert B.mask_boxes(m) == [[(3.0, 5.0, 9.0, 10.0), None]]


def test_score_combines_and_inconclusive_is_never_a_pass():
    acts = [{"frames": 10, "on_mark": 0.9}, {"frames": 30, "on_mark": 0.5}]
    cam = {"agree": 1.0, "conclusive": True}
    r = B.combine(acts, cam)
    assert r["score"] == round(0.6 * 0.6 + 0.4 * 1.0, 3) and r["basis"] == "actors and camera"
    assert B.combine(None, {"agree": None, "conclusive": False}) == {"score": None, "verdict": "inconclusive", "basis": "nothing measurable"}
    assert B.combine([], {"agree": 0.9, "conclusive": False})["verdict"] == "inconclusive"


def test_camera_steps():
    pan = np.array([0.03, 0.0, 0.0, 0.0])
    assert B.step_agrees(pan, np.array([0.02, 0.001, 0.0, 0.0]))
    assert not B.step_agrees(pan, np.array([-0.02, 0.0, 0.0, 0.0]))          # panned the other way
    push = np.array([0.0, 0.0, 0.06, 0.0])
    assert B.step_agrees(push, np.array([0.002, 0.0, 0.03, 0.0]))
    assert not B.step_agrees(push, np.array([0.0, 0.0, -0.03, 0.0]))         # pulled out instead
    hold = np.zeros(4)
    assert B.step_agrees(hold, np.array([0.002, 0.0, 0.001, 0.0]))
    assert not B.step_agrees(hold, np.array([0.05, 0.0, 0.0, 0.0]))          # moved when the camera held


def test_stage_boxes_follow_the_actor():
    scene = {"shot": {"frames": 25, "fps": 24}, "camera": {"position": [0, 1.6, -8], "target": [0, 1.2, 0], "focal_mm": 35},
             "actors": [{"id": "m", "kind": "man", "keys": [{"frame": 0, "position": [-2, 0, 0]}, {"frame": 24, "position": [2, 0, 0]}]}]}
    sb = B.stage_boxes(scene, 25, 640, 340)
    xs = [(b[0] + b[2]) / 2 for b in sb["m"]]
    # +X is screen-left looking down +Z (the stage's convention): -2 -> +2 walks right to left across the frame.
    assert all(b is not None for b in sb["m"]) and xs[0] > 320 > xs[-1]
    assert 120 < sb["m"][12][3] - sb["m"][12][1] < 340                           # a full figure, not a sliver


# ------------------------------------------------------------------------------------------------ readiness / timing

def test_readiness_names_what_is_missing():
    files = {"diffusion_models": ["flux3-image-klein-int8-convrot.safetensors", "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"],
             "text_encoders": ["qwen3vl_4b_int8_convrot.safetensors", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"],
             "vae": ["flux2-vae.safetensors", "ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors"],
             "latent_upscale_models": ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"],
             "loras": [], "checkpoints": [], "background_removal": ["birefnet.safetensors"]}
    loaded = {c for m in RD.REG.load_registry()["models"] for c in m.get("classes", [])}   # every node class present
    lister = lambda folder: files.get(folder, [])  # noqa: E731
    out = RD.needs({}, loaded, lister, shutil.which)
    assert out["set"]["status"] == "ready" and out["script"]["status"] == "ready"
    assert out["frame"]["status"] == "ready", out["frame"]
    assert out["motion"]["status"] == "needs"
    assert [n["what"] for n in out["motion"]["needs"]] == ["ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"]
    assert out["deliver"]["status"] in ("partial", "needs") and out["deliver"]["needs"][0]["what"] == "sam3.1_multiplex_fp16.safetensors"
    # A node class that didn't load is named too.
    out = RD.needs({}, loaded - {"EmptyFlux2LatentImage"}, lister, shutil.which)
    assert out["frame"]["status"] == "needs" and out["frame"]["needs"][0]["what"] == "node EmptyFlux2LatentImage"
    assert out["cast"]["status"] == "partial"


def test_timing_harvest_and_estimate(tmp_path):
    def item(step, start, end, frames=121, quality="Draft"):
        prompt = {"1": {"class_type": "SoundstageStep", "inputs": {"step": step}},
                  "2": {"class_type": "SoundstageQuality", "inputs": {"quality": quality}},
                  "3": {"class_type": "SoundstageStage", "inputs": {"stage": json.dumps({"scene": {"shot": {"frames": frames}}})}}}
        return {"prompt": [0, "x", prompt, {}, []],
                "status": {"messages": [["execution_start", {"timestamp": start}], ["execution_success", {"timestamp": end}]]}}
    hist = {"a": item(3, 0, 100_000), "b": item(3, 0, 80_000, frames=97), "c": item(3, 0, 2_000),   # c: from the cache
            "d": item(4, 0, 400_000, quality="Final"), "e": item(2, 0, 18_000)}
    samples = T.update(hist, base=str(tmp_path))
    assert sorted(s["id"] for s in samples) == ["a", "b", "d", "e"]
    assert T.update(hist, base=str(tmp_path)) == samples                     # idempotent
    est = T.estimate(samples, "draft", 121)
    assert est["basis"] == "measured" and est["measured"] == 2
    assert abs(est["seconds"] - 121 * (100 / 121 + 80 / 97) / 2) <= 1
    assert T.estimate([], "final", 121) == {"seconds": 360, "measured": 0, "basis": "default"}
    assert T.estimate(samples, "frame", count=4)["seconds"] == 72
    assert T.label(95) == "$0 · about 2 min on your GPU" and T.label(22) == "$0 · about 20 s on your GPU"


# ------------------------------------------------------------------------------------------------ recipe

PROMPT = {
    "9045": {"class_type": "SoundstageStage", "inputs": {"stage": json.dumps({"scene": {"version": 2, "camera": {"position": [0, 1, -5], "target": [0, 1, 0], "focal_mm": 35},
                                                                                         "shot": {"frames": 97, "fps": 24}, "actors": [], "active_shot": "s1",
                                                                                         "shots": [{"id": "s1", "name": "Wide"}]}, "passes": {"clay": "x [temp]"}})}},
    "9059": {"class_type": "SoundstageStep", "inputs": {"step": 4}},
    "9079": {"class_type": "SoundstageLook", "inputs": {"look": json.dumps({"version": 1, "genre": "noir"})}},
    "9091": {"class_type": "SoundstageAudioDrivenShot", "inputs": {"seed": 42, "quality": "final", "prompt": ["9079", 2]}},
    "9096": {"class_type": "SoundstageQuality", "inputs": {"motion_freedom": 0.5, "quality": "Final"}},
    "5516:1": {"class_type": "RandomNoise", "inputs": {"noise_seed": 7}},
}


def test_on_prompt_tags_soundstage_renders_only():
    body = R.on_prompt({"prompt": json.loads(json.dumps(PROMPT)), "extra_data": {"extra_pnginfo": {"workflow": {}}}})
    rec = body["extra_data"]["extra_pnginfo"]["soundstage"]
    assert rec["rung"] == "final" and rec["shot"] == {"id": "s1", "name": "Wide"} and rec["look"]["genre"] == "noir"
    assert rec["seeds"] == {"video": 42, "ltx": 7} and rec["quality"] == {"motion_freedom": 0.5, "quality": "Final"}
    assert "passes" not in json.dumps(rec)                                     # temp files never travel
    other = {"prompt": {"1": {"class_type": "KSampler", "inputs": {}}}}
    assert R.on_prompt(dict(other)) == other
    assert R.on_prompt({"prompt": "garbage"}) == {"prompt": "garbage"}


@needs_ffmpeg
def test_recipe_round_trip_through_the_mp4(tmp_path):
    rec = R.build(PROMPT)
    src = _clip(tmp_path, "take", [_scene_frame(i) for i in range(12)])
    R.embed(str(src), rec)
    back = R.read(str(src))
    assert back["scene"] == rec["scene"] and back["seeds"] == rec["seeds"] and back["source"] == "soundstage tag"
    # A take from before the tag: the recipe is rebuilt from ComfyUI's own prompt tag.
    old = _clip(tmp_path, "old", [_scene_frame(i) for i in range(12)], {"prompt": json.dumps(PROMPT)})
    back = R.read(str(old))
    assert back["scene"]["active_shot"] == "s1" and back["source"] == "rebuilt from the prompt tag"
    plain = _clip(tmp_path, "plain", [_scene_frame(i) for i in range(12)])
    assert R.read(str(plain)) is None


@needs_ffmpeg
def test_store_round_trip(tmp_path):
    store.set_base(str(tmp_path / "tc"))
    src = _clip(tmp_path, "s", [_scene_frame(i) for i in range(6)])
    store.save(str(src), "checks", {"version": 1})
    assert store.load(str(src), "checks") == {"version": 1}
    assert store.load(str(src), "actors") is None


@needs_ffmpeg
def test_frames_reader_every_nth(tmp_path):
    src = _clip(tmp_path, "n", [_scene_frame(i) for i in range(30)])
    info = probe(str(src))
    assert info["frames"] == 30 and abs(info["fps"] - 24) < 0.01
    assert read_frames(str(src), 160, every=3, info=info).shape[0] == 10
    assert read_frames(str(src), 160, gray=False, info=info).shape == (30, 88, 160, 3)


def test_people_seated_in_a_car_are_not_judged_on_their_own():
    scene = {"shot": {"frames": 25, "fps": 24}, "camera": {"position": [0, 1.6, -8], "target": [0, 1.2, 0], "focal_mm": 35},
             "actors": [{"id": "car", "kind": "sports_car", "keys": [{"frame": 0, "position": [0, 0, 0]}, {"frame": 24, "position": [0, 0, 5]}]},
                        {"id": "driver", "kind": "man", "mount_id": "car", "position": [0, 0, 0]},
                        {"id": "walker", "kind": "woman", "position": [2, 0, 0]}]}
    assert [a["id"] for a in B.tracked_actors(scene)] == ["car", "walker"]
