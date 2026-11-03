"""↻ Regenerate and Fix this object (Video → 3D fail-safes, 2026-11-02).

- stage caching: a regenerate re-runs only what is unlocked; a locked camera solve or performer is never re-run,
  and the depth (no seed) is always reused;
- the routes: POST /regenerate hands pipeline.run its seed, lock -> reuse and the last run's tag; POST /fix_object
  checks its body; every job names the GPU prompt it waits on (for the Activity bar);
- Fix this object's single-object rebuild inputs: the seed pixel, the SAM 3.1 track prompt, the clearest frames, the
  Photo → 3D object prompt, and the swapped-in actor that keeps the solve's place and size.
"""
import asyncio
import json
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from soundstage.video2stage import fixobject as FX  # noqa: E402
from soundstage.video2stage import pipeline, stages  # noqa: E402
from soundstage.video2stage import queue as VQ  # noqa: E402

TAG = "9f42fe9c48"


# ------------------------------------------------------------------------------------------------ stage record
def test_record_bootstraps_from_an_older_runs_files(tmp_path):
    out = tmp_path
    (out / "soundstage_v2s").mkdir()
    (out / "soundstage" / "mocap").mkdir(parents=True)
    np.savez(out / "soundstage_v2s" / f"v2s_{TAG}.npz", depth=np.ones((2, 4, 4)))
    (out / "soundstage" / f"v2s_{TAG}_set_00001_.glb").write_bytes(b"glb")
    (out / "soundstage" / "mocap" / f"v2s_{TAG}_20261103_032040.json").write_text(json.dumps({"frames": 120}))
    (out / "soundstage" / "mocap" / f"v2s_{TAG}_smooth.json").write_text("{}")   # a hand-made copy: not a take
    rec = stages.load(TAG, str(out))
    assert rec["depth"]["glb"]["filename"] == f"v2s_{TAG}_set_00001_.glb"
    assert rec["mocap"] == {"file": f"soundstage/mocap/v2s_{TAG}_20261103_032040.json", "frames": 120}
    assert stages.usable(rec, "depth", str(out)) and stages.usable(rec, "mocap", str(out))
    assert not stages.usable(rec, "camera", str(out)) and not stages.usable(rec, "breakdown", str(out))
    # locks -> stages; only what is on disk; depth whenever it is there
    assert stages.reuse_set({"camera": True, "performer": True, "set": False}, rec, str(out)) == {"depth", "mocap"}
    assert stages.reuse_set({}, rec, str(out)) == {"depth"}
    assert stages.load("0000000000", str(out)) == {}


def test_solve_round_trip(tmp_path):
    poses = [np.hstack([np.eye(3), np.zeros((3, 1))]), np.hstack([np.eye(3), np.ones((3, 1))])]
    K = np.array([[500.0, 0, 320], [0, 500, 240], [0, 0, 1]])
    p = stages.save_solve(TAG, poses, np.ones(2), K, (np.array([0.0, -1, 0]), 1.6, 0.9), ["camera: x"],
                          np.ones((2, 3, 4)), 42, str(tmp_path))
    P, s, K2, g, notes, d = stages.load_solve(p)
    assert np.allclose(P[1], poses[1]) and np.allclose(K2, K) and notes == ["camera: x"] and d.shape == (2, 3, 4)
    assert np.allclose(g[0], [0, -1, 0]) and g[1] == 1.6 and g[2] == pytest.approx(0.9)
    p = stages.save_solve(TAG, poses, np.ones(2), K, None, [], np.ones((2, 3, 4)), 1, str(tmp_path))
    assert stages.load_solve(p)[3] is None


# ------------------------------------------------------------------------------------------------ pipeline caching
REPLY = json.dumps({"setting": "street", "time": "day", "camera": {"height_m": 1.5, "type": "handheld"},
                    "objects": [{"label": "woman dancing", "kind": "person", "bbox": [400, 300, 600, 950]}], "set": []})


@pytest.fixture
def fake_server(tmp_path, monkeypatch):
    """pipeline.run with everything heavy faked: counts what it queues and solves."""
    inp, out = tmp_path / "input", tmp_path / "output"
    inp.mkdir(); out.mkdir()
    (inp / "clip.mp4").write_bytes(b"x" * 10)
    fp = types.SimpleNamespace(get_input_directory=lambda: str(inp), get_output_directory=lambda: str(out),
                               get_annotated_filepath=lambda n: str(inp / n),
                               get_filename_list=lambda k: ["depth_anything_3_mono_large.safetensors"])
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    seen = {"queued": [], "solve_seeds": [], "vlm_seeds": []}
    monkeypatch.setattr(pipeline.frames, "probe", lambda p: {"duration": 5.0, "fps": 24.0, "frames": 120, "width": 1280, "height": 720})

    def extract(path, d, times):
        os.makedirs(d, exist_ok=True)
        fs = [os.path.join(d, f"f_{i:02d}.png") for i in range(len(times))]
        for f in fs:
            Path(f).write_bytes(b"png")
        return fs
    monkeypatch.setattr(pipeline.frames, "extract", extract)
    monkeypatch.setattr(pipeline.vlm, "available_model", lambda: "qwen")
    monkeypatch.setattr(pipeline.performer, "available", lambda names: True)
    real_graph = pipeline.vlm.graph
    monkeypatch.setattr(pipeline.vlm, "graph", lambda m, a, b, seed=0: (seen["vlm_seeds"].append(seed), real_graph(m, a, b, seed))[1])

    async def run_graph(base, g, what, timeout_s=900.0, on_wait=None):
        seen["queued"].append(what)
        if what == "depth":
            d = out / "soundstage_v2s"
            d.mkdir(exist_ok=True)
            p = d / f"v2s_{g['x1']['inputs']['name'].split('_', 1)[1]}.npz"
            K = np.array([[537.6, 0, 383.5], [0, 537.6, 215.5], [0, 0, 1]], np.float32)
            np.savez(p, depth=np.ones((16, 8, 8), np.float32), intrinsics=np.repeat(K[None], 16, 0))
            return {"x1": {"text": [str(p)]}}, {"total_ms": 1}
        if what == "shot breakdown":
            return {"a3": {"text": [REPLY]}, "b3": {"text": [REPLY]}}, {"total_ms": 1}
        if what == "motion capture":
            (out / "soundstage" / "mocap").mkdir(parents=True, exist_ok=True)
            f = f"soundstage/mocap/v2s_x_{len(seen['queued'])}.json"
            (out / f).write_text(json.dumps({"frames": 2, "focal_px": 1468.6, "image_size": [720, 1280]}))
            return {"p6": {"text": [json.dumps({"file": f, "frames": 2})]}}, {"total_ms": 1}
        raise AssertionError(what)
    monkeypatch.setattr(pipeline.queue, "run_graph", run_graph)

    def solve(packet, files, seed=0):
        seen["solve_seeds"].append(seed)
        seen["K"] = np.asarray(packet["intrinsics"][0], float)
        poses = [np.hstack([np.eye(3), np.zeros((3, 1))])] * len(files)
        return poses, np.ones(len(files)), seen["K"], (np.array([0.0, -1, 0]), 1.0, 1.0), [], packet["depth"]
    monkeypatch.setattr(pipeline, "solve", solve)

    def assemble(**kw):
        seen["set_seed"] = kw.get("seed")
        return {"actors": [], "shots": [{"camera_keys": [{"position": [0, 1, 0]}]}], "camera_keys": [],
                "shot": {"frames": 120}, "video2stage": {"metres_per_unit": 1.0, "xform": {"A": np.eye(3).tolist(), "b": [0, 1, 0]}}}
    monkeypatch.setattr(pipeline.convert, "assemble", assemble)
    return seen, out


def test_regenerate_reruns_only_the_unlocked_stages(fake_server):
    seen, out = fake_server
    first = asyncio.run(pipeline.run("http://x", "clip.mp4"))
    assert seen["queued"] == ["depth", "shot breakdown", "motion capture"] and seen["solve_seeds"] == [0]
    assert first["stages"] == {"depth": "ran", "breakdown": "ran", "mocap": "ran", "camera": "ran"}
    # the solve used ONE lens: SAM 3D Body's focal on the proxy grid (8 px wide here), not DA3's
    assert seen["K"][0, 0] == pytest.approx(1468.6 * 8 / 1280, rel=1e-4)
    tag = first["tag"]
    rec = json.loads((out / "soundstage_v2s" / f"v2s_{tag}_stages.json").read_text())
    assert set(rec) >= {"depth", "breakdown", "mocap", "camera"} and rec["breakdown"]["read"]["objects"]

    # camera + performer locked: neither re-runs; depth is reused; the vision read samples with the new seed
    seen["queued"].clear(); seen["solve_seeds"].clear()
    r = asyncio.run(pipeline.run("http://x", "clip.mp4", seed=77, reuse={"depth", "camera", "mocap"}, tag=tag))
    assert seen["queued"] == ["shot breakdown"] and seen["solve_seeds"] == []
    assert seen["vlm_seeds"][-1] == 77 and seen["set_seed"] == 7 + 77
    assert r["stages"] == {"depth": "reused", "breakdown": "ran", "mocap": "reused", "camera": "reused"} and r["seed"] == 77

    # only the set locked: the read and its dressing seed stay; camera and performer re-run with the new seed
    seen["queued"].clear()
    r = asyncio.run(pipeline.run("http://x", "clip.mp4", seed=5, reuse={"depth", "breakdown"}, tag=tag))
    assert seen["queued"] == ["motion capture"] and seen["solve_seeds"] == [5] and seen["set_seed"] == 7 + 77
    assert r["stages"]["breakdown"] == "reused" and r["stages"]["camera"] == "ran"


# ------------------------------------------------------------------------------------------------ routes
def test_regenerate_route_passes_seed_locks_and_tag(monkeypatch):
    pytest.importorskip("aiohttp")
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from soundstage.video2stage import routes as VR
    got = {}

    async def fake_run(_base, video, **kw):
        got.update(kw, video=video)
        job = VQ.JOB.get()
        job["prompt_id"], job["prompt_what"] = "p1", "shot breakdown"   # what queue.run_graph records
        await asyncio.sleep(0.3)
        return {"scene": {}, "notes": [], "stages": {}}

    monkeypatch.setattr(pipeline, "run", fake_run)
    routes = web.RouteTableDef()
    VR.register(routes)
    app = web.Application()
    app.add_routes(routes)

    async def go():
        async with TestClient(TestServer(app)) as c:
            assert (await c.post("/soundstage/video2stage/regenerate", json={})).status == 400
            j = await (await c.post("/soundstage/video2stage/regenerate", json={
                "video": "clip.mp4", "tag": TAG, "seed": 9, "lock": {"camera": True, "performer": False, "set": True}})).json()
            await asyncio.sleep(0.1)
            s = await (await c.get(f"/soundstage/video2stage/job?id={j['job']}")).json()
            assert s["state"] == "running" and s["prompt_id"] == "p1" and s["kind"] == "regenerate"
            await asyncio.sleep(0.4)
            s = await (await c.get(f"/soundstage/video2stage/job?id={j['job']}")).json()
            assert s["state"] == "done" and s["result"]["lock"] == {"camera": True, "performer": False, "set": True}
            bad = await c.post("/soundstage/video2stage/fix_object", json={"video": "clip.mp4", "tag": "nope"})
            assert bad.status == 400 and "tag" in (await bad.json())["error"]
            bad = await c.post("/soundstage/video2stage/fix_object", json={"video": "c.mp4", "tag": TAG, "mode": "add"})
            assert bad.status == 400 and "click" in (await bad.json())["error"]
    asyncio.run(go())
    assert got["seed"] == 9 and got["tag"] == TAG and got["reuse"] == {"depth", "camera", "breakdown"}


def test_regen_kwargs_never_reuses_seed_zero():
    from soundstage.video2stage import routes as VR
    kw = VR.regen_kwargs({"video": "c.mp4"})
    assert kw["seed"] != 0 and kw["reuse"] == {"depth"} and kw["lock_flags"] == {"camera": False, "performer": False, "set": False}


# ------------------------------------------------------------------------------------------------ fix this object
CAM = {"poses": [np.hstack([np.eye(3), np.zeros((3, 1))])] * 3, "K": np.array([[400.0, 0, 200], [0, 400, 120], [0, 0, 1]]),
       "A": np.diag([-1.0, -1.0, 1.0]), "b": np.array([0.0, 1.5, 0.0])}   # a level camera 1.5 m up (track.world_frame)


def test_seed_pixel_from_a_click_or_the_projected_object():
    i, uv = FX.seed_pixel({"point": {"x": 0.25, "y": 0.5}, "sample": 2}, (400, 240), CAM)
    assert i == 2 and uv == (100.0, 120.0)
    # an actor 4 m ahead, 1 m tall: its middle (0.5 m up) is 1 m below the lens -> 100 px below the centre
    i, uv = FX.seed_pixel({"actor": {"position": [0, 0, 4], "height_m": 1.0}}, (400, 240), CAM)
    assert i == 0 and uv[0] == pytest.approx(200) and uv[1] == pytest.approx(120 + 400 * 1.0 / 4)
    assert FX.seed_pixel({"actor": {"position": [0, 0, -4], "height_m": 1.0}}, (400, 240), CAM)[1] is None   # behind


def test_track_prompt_tracks_one_object_both_ways_from_the_seed_frame():
    names = [f"soundstage/v2s_{TAG}/f_{i:02d}.png" for i in range(5)]
    g, keys = FX.track_graph(names, 2, (100.4, 60.6), "green bench", "soundstage/v2s_fix/x")
    det = next(n for n in g.values() if n["class_type"] == "SAM3_Detect")
    assert json.loads(det["inputs"]["positive_coords"]) == [{"x": 100, "y": 61}]
    assert g[det["inputs"]["image"][0]]["inputs"]["image"] == names[2]
    tracks = [n for n in g.values() if n["class_type"] == "SAM3_VideoTrack"]
    assert len(tracks) == 2 and all(t["inputs"]["max_objects"] == 1 and t["inputs"]["initial_mask"] for t in tracks)
    assert sorted(keys.values()) == [[2, 1, 0], [2, 3, 4]]
    texts = [n["inputs"]["text"] for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert texts == ["green bench"]
    # nothing but core nodes and our own saves
    assert {n["class_type"] for n in g.values()} <= {"CheckpointLoaderSimple", "CLIPTextEncode", "LoadImage", "SAM3_Detect",
                                                     "ImageBatch", "SAM3_VideoTrack", "SAM3_TrackToMask", "MaskToImage", "SaveImage"}


def test_masks_and_the_clearest_frames():
    def box(x0, y0, x1, y1, shape=(60, 80)):
        m = np.zeros(shape, bool)
        m[y0:y1, x0:x1] = True
        return m
    outputs = {"fw": {"images": [{"filename": "a"}, {"filename": "b"}]}, "bw": {"images": [{"filename": "c"}, {"filename": "d"}]}}
    keys = {"fw": [1, 2], "bw": [1, 0]}
    store = {"a": box(20, 20, 40, 40), "b": box(0, 10, 30, 40), "c": box(0, 0, 5, 5), "d": box(22, 22, 40, 42)}
    masks = FX.masks_from_outputs(outputs, keys, "/x", reader=lambda p: store[os.path.basename(p)].astype(np.uint8) * 255)
    assert set(masks) == {0, 1, 2} and masks[1].sum() == 400   # the seed frame comes from the forward track
    ranked = FX.clearest(masks)
    assert [r["sample"] for r in ranked][:2] == [1, 0]           # whole and typical first; frame 2 is cut by the edge
    assert ranked[-1]["sample"] == 2 and ranked[-1]["edge"]
    crop = FX.crop_rgba(np.full((60, 80, 3), 200, np.uint8), masks[1])
    assert crop.shape[2] == 4 and crop[..., 3].max() == 255 and crop[..., 3].mean() < 255


def test_object_prompt_is_the_photo_to_3d_object_path_with_the_sam_mask():
    g = FX.object_graph("soundstage/v2s_fix/x_crop.png", 2 ** 40 + 5, "soundstage/v2s_fix/x_obj")
    assert g["mk"]["class_type"] == "InvertMask" and g["t1"]["inputs"]["mask"] == ["mk", 0]
    assert g["t6"]["inputs"]["seed"] < 2 ** 31 and g["s1"]["inputs"]["filename_prefix"] == "soundstage/v2s_fix/x_obj"
    assert [g[k]["class_type"] for k in ("t8", "m1", "m2", "s1")] == ["VAEDecodeTripoSplat", "SplatToMesh", "DecimateMesh", "SaveGLB"]


def test_the_fixed_object_keeps_the_solves_place_and_size_as_a_new_version():
    old = {"id": "bench", "name": "Green bench", "kind": "custom", "recipe": {"parts": []}, "position": [1, 0, 5],
           "keys": [{"frame": 0, "position": [1, 0, 5]}], "rotation_deg": 30, "height_m": 0.8, "set_piece": True,
           "source": {"label": "green bench"}}
    new = FX.fixed_actor(old, glb={"url": "/view?filename=b.glb"}, colour="#336633", frames=[{"sample": 3}, {"sample": 7}], seed=9)
    assert new["id"] == "bench" and new["version"] == 2 and new["kind"] == "glb" and "recipe" not in new
    assert new["position"] == [1, 0, 5] and new["rotation_deg"] == 30 and new["height_m"] == 0.8 and new["set_piece"]
    assert new["source"]["fixed"]["frames"] == [3, 7] and new["source"]["label"] == "green bench"
    assert old["kind"] == "custom"                               # the old version is untouched (Undo)
    kept = FX.fixed_actor(old, glb=None, colour="#336633", frames=[], seed=9)
    assert kept["kind"] == "custom" and kept["appearance"]["color"] == "#336633" and "no TripoSplat" in kept["source"]["fixed"]["how"]


def test_an_added_object_stands_where_its_mask_meets_the_floor():
    m = np.zeros((240, 400), bool)
    m[120 + 100 - 40:120 + 100, 190:210] = True                    # base 100 px below the centre: 6 m out, 1.5 m up
    a = FX.added_actor(m, 0, CAM, "Red bin", {"red_bin"}, glb=None, colour="#aa2222", seed=1)
    assert a["id"] == "red_bin_2" and a["set_piece"] and a["kind"] == "custom"
    assert a["position"][2] == pytest.approx(1.5 * 400 / 100, rel=0.02) and abs(a["position"][0]) < 0.1
    assert a["height_m"] == pytest.approx(40 / 400 * np.hypot(6.0, 1.5), rel=0.05)
    sky = np.zeros((240, 400), bool)
    sky[10:40, 190:210] = True                                     # above the horizon: never meets the floor
    assert FX.added_actor(sky, 0, CAM, "kite", set(), glb=None, colour=None, seed=1) is None


def test_fix_body_check():
    assert FX.check_body({"video": "c.mp4", "tag": TAG, "actor": {"id": "a"}}) is None
    assert "mode" in FX.check_body({"video": "c.mp4", "tag": TAG, "mode": "zap"})
    assert FX.check_body({"video": "c.mp4", "tag": TAG, "mode": "add", "point": {"x": 0.1, "y": 0.2}}) is None


def test_a_timed_out_prompt_is_taken_off_the_queue():
    """A GPU step that waits past its timeout drops its own prompt (it used to stay queued with nobody waiting)."""
    pytest.importorskip("aiohttp")
    from aiohttp import web
    from aiohttp.test_utils import TestServer
    seen = {"deleted": []}
    fake = web.RouteTableDef()

    @fake.post("/prompt")
    async def prompt(request):
        return web.json_response({"prompt_id": "ours"})

    @fake.get("/history/{pid}")
    async def history(request):
        return web.json_response({})

    @fake.post("/queue")
    async def q(request):
        seen["deleted"] += (await request.json()).get("delete", [])
        return web.json_response({})

    @fake.get("/soundstage/queue_summary")
    async def summary(request):
        return web.json_response({"items": [{"prompt_id": "ours", "state": "pending"}]})

    async def go():
        srv = TestServer(web.Application())
        srv.app.add_routes(fake)
        await srv.start_server()
        try:
            with pytest.raises(TimeoutError, match="taken off the queue"):
                await VQ.run_graph(str(srv.make_url("")).rstrip("/"), {"1": {}}, "shot breakdown", timeout_s=1.2)
        finally:
            await srv.close()
    asyncio.run(go())
    assert seen["deleted"] == ["ours"]
