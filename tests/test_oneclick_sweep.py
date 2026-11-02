"""One-click graph builders and routes, swept at their edges (no ComfyUI, no GPU).

Graphs: every Loop / Reshoot builder over tiny, huge, portrait and scope pictures, every length, quality and sound
setting and the seed range's ends is checked against the pod's /object_info snapshots: every node class exists, every
link points at a real node and a real output slot of the right type, every widget sits inside its min/max, and every
node feeds the saved output (no dangling half-graphs).
Routes: the hand-off routes (Open in ComfyUI, Loop, Reshoot) and the one-click relay answer garbage, missing,
oversized and path-escaping input with a 4xx, never a 500, and a seed outside the sampler's range never reaches the
queue. The MCP loop tool keeps the loop it made when the bridge step can't run.
Run:  python -m pytest tests/test_oneclick_sweep.py -q
"""
import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from test_loop_graphs import _snapshot  # noqa: E402,F401  (autouse: the merged snapshots)
from soundstage.handoff import workflow as WF  # noqa: E402
from soundstage.loop import graphs as LG  # noqa: E402
from soundstage.reshoot import graphs as RG  # noqa: E402

W_LOOP = {r: names[0] for r, (f, names) in LG.LOOP_WEIGHTS.items()}
W_RESHOOT = {r: names[0] for r, (f, names) in RG.RESHOOT_WEIGHTS.items()}
OUTPUTS = {"SaveVideo", "SaveImage", "SoundstageDA3Export"}
SEED_MAX = 2 ** 64 - 1


def _outputs_of(class_type):
    if class_type in TF.OWN:
        return TF.OWN[class_type][1]
    return TF.OI[class_type]["output"]


def links(prompt):
    for nid, n in prompt.items():
        for k, v in n["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                yield nid, k, v


def validate(prompt, unused_ok=()):
    """Problems with an API prompt: dangling links first (TF.check would raise on them), then TF.check (classes,
    input names, link types, widget ranges), then nodes that never reach an output (ComfyUI skips those, so they are
    only allowed for the classes in unused_ok: a silent render's unused sound decoder, say)."""
    probs = []
    for nid, k, (src, slot) in links(prompt):
        if src not in prompt:
            probs.append(f"{nid}.{k}: links to node {src!r}, which isn't in the prompt")
            continue
        cls = prompt[src]["class_type"]
        if cls in TF.OI or cls in TF.OWN:
            if not isinstance(slot, int) or not 0 <= slot < len(_outputs_of(cls)):
                probs.append(f"{nid}.{k}: {cls} has no output slot {slot}")
    if probs:
        return probs
    g = TF.Graph()
    for nid, n in prompt.items():
        g.nodes[nid] = TF.Node(nid, n["class_type"], n["inputs"])
    probs += TF.check(g)
    # every node feeds an output: walk back from the outputs
    seen, todo = set(), [nid for nid, n in prompt.items() if n["class_type"] in OUTPUTS]
    if not todo:
        probs.append("no output node")
    while todo:
        nid = todo.pop()
        if nid in seen:
            continue
        seen.add(nid)
        todo += [v[0] for _, _, v in links({nid: prompt[nid]})]
    probs += [f"{nid} ({prompt[nid]['class_type']}): feeds nothing that is saved" for nid in prompt
              if nid not in seen and prompt[nid]["class_type"] not in unused_ok]
    return probs


def of(prompt, cls):
    return [n for n in prompt.values() if n["class_type"] == cls]


def test_the_validator_catches_what_it_says():
    p = LG.build(W_LOOP, source="a.png [input]", width=1600, height=900)
    assert validate(p) == []
    bad = json.loads(json.dumps(p))
    bad["save"]["inputs"]["video"] = ["nope", 0]
    assert "isn't in the prompt" in validate(bad)[0]
    bad = json.loads(json.dumps(p))
    bad["save"]["inputs"]["video"][1] = 3
    assert "no output slot 3" in validate(bad)[0]
    bad = json.loads(json.dumps(p))
    bad["orphan"] = {"class_type": "VAELoader", "inputs": {"vae_name": "x.safetensors"}}
    assert any("feeds nothing" in x for x in validate(bad))
    bad = json.loads(json.dumps(p))
    of(bad, "RandomNoise")[0]["inputs"]["noise_seed"] = -1
    assert any("out of range" in x for x in validate(bad))


# ---------------------------------------------------------------- Loop: every builder, every edge

SIZES = [(1, 1), (16, 9000), (9000, 16), (1712, 912), (720, 1280), (4000, 1000), (1023, 577)]


@pytest.mark.parametrize("w,h", SIZES)
@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("bridge", [False, True])
def test_loop_graph_valid_for_any_picture(w, h, quality, bridge):
    p = LG.build(W_LOOP, source="a.png [input]", end_source="b.png [input]" if bridge else "", width=w, height=h,
                 seconds=4, quality=quality, bridge=bridge)
    assert validate(p) == []
    lat = of(p, "EmptyLTXVLatentVideo")[0]["inputs"]
    assert lat["width"] % 32 == 0 and lat["height"] % 32 == 0, lat      # LTX's latent grid
    assert max(lat["width"], lat["height"]) <= LG.MAX_LONG
    for r in of(p, "ResizeImageMaskNode"):                               # both guides at the latent's size (x2 in Final)
        assert (r["inputs"]["resize_type.width"], r["inputs"]["resize_type.height"]) in \
            {(lat["width"], lat["height"]), (2 * lat["width"], 2 * lat["height"])}


@pytest.mark.parametrize("seconds", [0, 0.1, 0.7, 2, 3.3, 8, 10])
@pytest.mark.parametrize("sound", [True, False])
def test_loop_graph_valid_for_any_length(seconds, sound):
    p = LG.build(W_LOOP, source="a.png [input]", width=1920, height=1080, seconds=seconds, sound=sound)
    assert validate(p, unused_ok=() if sound else ("LTXVAudioVAEDecode",)) == []
    n = of(p, "EmptyLTXVLatentVideo")[0]["inputs"]["length"]
    assert (n - 1) % 8 == 0 and n >= 17
    assert of(p, "LTXVEmptyLatentAudio")[0]["inputs"]["frames_number"] == n   # sound as long as the pictures


@pytest.mark.parametrize("seed", [0, 1, SEED_MAX])
def test_loop_graph_seed_range_ends(seed):
    p = LG.build(W_LOOP, source="a.png [input]", width=1600, height=900, seed=seed, quality="Final")
    assert validate(p) == []
    assert {n["inputs"]["noise_seed"] for n in of(p, "RandomNoise")} == {seed}


def test_loop_end_strength_range():
    for s in (0.0, 1.0, 10.0):
        assert validate(LG.build(W_LOOP, source="a.png [input]", width=800, height=800, end_strength=s)) == []


# ---------------------------------------------------------------- Reshoot: every builder, every edge

# plate_size caps the short side only; footage.graphs.guide_size has no long-side cap, so a strip past ~15:1 is out
@pytest.mark.parametrize("w,h", [(64, 64), (1312, 720), (720, 1280), (4096, 1716), (720, 2160), (1984, 720)])
@pytest.mark.parametrize("quality", ["Draft", "Final"])
@pytest.mark.parametrize("keep_sound", [True, False])
def test_reshoot_render_valid_for_any_plate(w, h, quality, keep_sound):
    p = RG.render_prompt(W_RESHOOT, plate="rs/p.mp4 [input]", guide="rs/g.mp4 [input]", first="rs/f.png [input]",
                         width=w, height=h, prompt=RG.reshoot_prompt("orbits 10 degrees to the right"), seed=SEED_MAX,
                         quality=quality, keep_sound=keep_sound)
    assert validate(p, unused_ok=() if keep_sound else ("SoundstageClipLoad",)) == []
    assert ("audio" in p[p["save"]["inputs"]["video"][0]]["inputs"]) == keep_sound


def test_reshoot_depth_and_lora_test_graphs_valid():
    assert validate(RG.depth_prompt("rs/p.mp4 [input]", "da3_mono.safetensors", "rs_x")) == []
    lora = {**W_RESHOOT, "unet": W_RESHOOT["unet"]}
    for w, h, n in ((768, 448, 49), (448, 768, 17), (1024, 576, 97)):
        p = RG.camera_lora_test_prompt(lora, "cam.safetensors", first="f.png [input]", width=w, height=h, frames=n)
        assert validate(p) == []


# ---------------------------------------------------------------- refs: path traversal is refused, never a crash

def test_resolve_refuses_escapes_and_bad_bytes(tmp_path):
    out = tmp_path / "output"
    (out / "s").mkdir(parents=True)
    (out / "s" / "a.mp4").write_bytes(b"x")
    (tmp_path / "secret.mp4").write_bytes(b"x")
    dirs = {"input": str(tmp_path / "input"), "output": str(out), "temp": str(tmp_path / "temp")}
    assert WF.resolve("s/a.mp4 [output]", dirs)
    for ref in ["s/a\x00.mp4 [output]", "\x00", "s/../../secret.mp4 [output]", "s\\..\\..\\secret.mp4 [output]",
                f"{tmp_path}/secret.mp4 [output]", "/../secret.mp4 [output]", "s/ [output]", "[output]", "   ",
                "s/a.mp4 [input]", "s/a.mp4 [bogus]"]:
        assert WF.resolve(ref, dirs) is None, repr(ref)


def test_resolve_without_that_folder_never_falls_back_to_the_working_directory(tmp_path, monkeypatch):
    # realpath("") is the working directory: a folder type ComfyUI didn't give must not resolve against it
    (tmp_path / "here.mp4").write_bytes(b"x")
    monkeypatch.chdir(tmp_path)
    assert WF.resolve("here.mp4 [temp]", {"input": "", "output": "", "temp": None}) is None
    assert WF.resolve("here.mp4 [output]", {"input": "", "output": "", "temp": ""}) is None


# ---------------------------------------------------------------- the hand-off routes over HTTP

def _png(path, w=1600, h=900):
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (w, h), (90, 120, 150)).save(path)
    return path


@pytest.fixture
def comfy(tmp_path, monkeypatch):
    """A fake folder_paths over tmp input/output/temp with the Loop and Reshoot weights installed."""
    dirs = {k: tmp_path / k for k in ("input", "output", "temp")}
    for d in dirs.values():
        d.mkdir()
    (tmp_path / "secret.png").write_bytes(b"x")
    files = {}
    for spec in (LG.LOOP_WEIGHTS, RG.RESHOOT_WEIGHTS):
        for folder, names in spec.values():
            files.setdefault(folder, []).append(names[0])
    fake = type(sys)("folder_paths")
    fake.get_input_directory = lambda: str(dirs["input"])
    fake.get_output_directory = lambda: str(dirs["output"])
    fake.get_temp_directory = lambda: str(dirs["temp"])
    fake.get_filename_list = lambda folder: list(files.get(folder, []))
    monkeypatch.setitem(sys.modules, "folder_paths", fake)
    _png(dirs["input"] / "still.png")
    return dirs


def _serve(register, calls):
    """Run calls(session, base) against an app with the routes register(table) mounts."""
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")

    async def main():
        table = web.RouteTableDef()
        register(table)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with aiohttp.ClientSession() as s:
                return await calls(s, base)
        finally:
            await runner.cleanup()

    return asyncio.run(main())


async def _status(s, method, url, **kw):
    async with s.request(method, url, **kw) as r:
        try:
            j = await r.json(content_type=None)
        except Exception:  # noqa: BLE001
            j = None
        return r.status, j


def test_handoff_routes_answer_garbage_with_4xx(comfy):
    from soundstage.handoff import routes as HR

    async def calls(s, base):
        res = {}
        for ref in ["", "%00", "a%00b.mp4", "../secret.png%20[input]", "..%2F..%2Fsecret.png", "still.png%20[nope]",
                    "x" * 5000]:
            res[f"wf {ref[:20]}"] = await _status(s, "GET", f"{base}/soundstage/handoff/workflow?ref={ref}")
        bodies = {"list": "[1, 2]", "string": '"loop"', "not json": "{", "empty": "", "null": "null",
                  "no source": json.dumps({"seconds": 4}),
                  "escape": json.dumps({"source": "../secret.png [input]"}),
                  "nul": json.dumps({"source": "still\u0000.png [input]"}),
                  "bad end": json.dumps({"source": "still.png [input]", "end_source": "../../secret.png [input]"}),
                  "bad seconds": json.dumps({"source": "still.png [input]", "seconds": "four"}),
                  "list seconds": json.dumps({"source": "still.png [input]", "seconds": [4]}),
                  "bad seed": json.dumps({"source": "still.png [input]", "seed": "seven"}),
                  "dict seed": json.dumps({"source": "still.png [input]", "seed": {"a": 1}})}
        for k, b in bodies.items():
            res[f"prompt {k}"] = await _status(s, "POST", f"{base}/soundstage/loop/prompt", data=b,
                                               headers={"Content-Type": "application/json"})
        for k, b in {"list": "[]", "escape": json.dumps({"ref": "../secret.png [input]"}), "none": "{}"}.items():
            res[f"seam {k}"] = await _status(s, "POST", f"{base}/soundstage/loop/seam", data=b)
            res[f"fix {k}"] = await _status(s, "POST", f"{base}/soundstage/loop/fix", data=b)
        res["reshoot list"] = await _status(s, "POST", f"{base}/soundstage/reshoot", data="[1]")
        res["reshoot none"] = await _status(s, "POST", f"{base}/soundstage/reshoot", data="{")
        res["job"] = await _status(s, "GET", f"{base}/soundstage/reshoot/job?id=nope")
        res["job none"] = await _status(s, "GET", f"{base}/soundstage/reshoot/job")
        return res

    res = _serve(HR.register, calls)
    for k, (st, j) in res.items():
        assert 400 <= st < 500, (k, st, j)
        assert isinstance(j, dict) and j.get("error"), (k, j)
    assert "source" in res["prompt escape"][1]["error"]
    assert "end_source" in res["prompt bad end"][1]["error"]


def test_loop_prompt_route_clamps_length_and_wraps_seeds_into_the_samplers_range(comfy):
    """seed -1 (or past 2**64) was queued as is: ComfyUI then refuses the whole prompt. 0 is a seed, not 'no seed'."""
    from soundstage.handoff import routes as HR

    async def calls(s, base):
        out = {}
        for k, b in {"neg": {"seed": -1}, "huge": {"seed": 2 ** 70 + 5}, "zero": {"seed": 0}, "str": {"seed": "12"},
                     "none": {"seed": None}, "long": {"seconds": 1e308}, "short": {"seconds": -5},
                     "nan": {"seconds": "nan"}, "final": {"quality": "Final", "seconds": 10}}.items():
            out[k] = await _status(s, "POST", f"{base}/soundstage/loop/prompt",
                                   json={"source": "still.png [input]", **b})
        return out

    res = _serve(HR.register, calls)
    seeds = {}
    for k, (st, j) in res.items():
        assert st == 200, (k, st, j)
        assert validate(j["prompt"]) == [], k
        seeds[k] = {n["inputs"]["noise_seed"] for n in of(j["prompt"], "RandomNoise")}
    assert seeds["neg"] == {SEED_MAX}
    assert seeds["huge"] == {5}
    assert seeds["zero"] == {0}
    assert seeds["str"] == {12}
    assert seeds["none"] == {7}
    assert res["long"][1]["seconds"] == 10.0 and res["long"][1]["frames"] == LG.ltx_frames(10)
    assert res["short"][1]["seconds"] == 0.7 and res["nan"][1]["seconds"] == 0.7
    assert res["final"][1]["size"] == [2 * x for x in LG.render_size(1600, 900)]


def test_loop_prompt_route_names_the_missing_models(comfy, monkeypatch):
    from soundstage.handoff import routes as HR
    monkeypatch.setattr(HR, "_list", lambda folder: [])
    with pytest.raises(RuntimeError, match="Loop needs these models"):
        HR.loop_prompt({"source": "still.png [input]"})


def test_loop_fix_refuses_an_unknown_how_before_measuring_the_take(comfy, monkeypatch):
    from soundstage.handoff import routes as HR
    from soundstage.loop import seam as S
    (comfy["output"] / "take.mp4").write_bytes(b"x")
    monkeypatch.setattr(S, "measure_file", lambda p: (_ for _ in ()).throw(AssertionError("measured a take for nothing")))
    for how in (None, "dance", "", ["seal"]):
        with pytest.raises(ValueError, match="how: seal, trim, bridge or join"):
            HR.fix({"ref": "take.mp4 [output]", "how": how})


def test_reshoot_route_wraps_the_seed_and_reports_garbage_as_a_job_error(comfy, monkeypatch):
    from soundstage import reshoot as R
    from soundstage.handoff import routes as HR
    got = []

    async def fake_run(base, source, move, **kw):
        got.append(kw["seed"])
        return {"file": {"filename": "x.mp4"}, "words": "orbits", "holes": 0.1}

    monkeypatch.setattr(R, "run", fake_run)

    async def calls(s, base):
        jobs = {}
        for k, seed in {"neg": -3, "zero": 0, "bad": "x"}.items():
            st, j = await _status(s, "POST", f"{base}/soundstage/reshoot",
                                  json={"source": "t.mp4 [output]", "move": {"orbit_deg": 5}, "seed": seed})
            assert st == 200, (k, j)
            jobs[k] = j["job"]
        done = {}
        t0 = time.time()
        while len(done) < len(jobs) and time.time() - t0 < 10:
            for k, jid in jobs.items():
                st, j = await _status(s, "GET", f"{base}/soundstage/reshoot/job?id={jid}")
                if j.get("state") in ("done", "error"):
                    done[k] = j
            await asyncio.sleep(0.02)
        return done

    done = _serve(HR.register, calls)
    assert done["neg"]["state"] == "done" and done["zero"]["state"] == "done"
    assert sorted(got) == [0, SEED_MAX - 2]
    assert done["bad"]["state"] == "error" and "invalid literal" in done["bad"]["error"]


# ---------------------------------------------------------------- the one-click relay over HTTP

def test_relay_answers_non_object_bodies_and_garbage_timeouts_without_a_500():
    from soundstage.oneclick import routes as OR

    def register(table):
        def send(ev, data, sid=None):
            fut = OR.WAITING.get(data["id"])
            asyncio.get_running_loop().call_later(0.02, lambda: fut.done() or fut.set_result({"ok": True, "kind": data["kind"]}))
        OR._REGISTERED = False
        OR.register(table, send=send)

    async def calls(s, base):
        out = {}
        for k, b in {"list": "[1]", "string": '"run"', "number": "3", "null": "null"}.items():
            out[f"ask {k}"] = await _status(s, "POST", f"{base}/soundstage/oneclick/ask", data=b)
            out[f"result {k}"] = await _status(s, "POST", f"{base}/soundstage/oneclick/result", data=b)
        for t in ("soon", [5], -1, 0, "nan", "inf", "1e400"):
            out[f"timeout {t!r}"] = await _status(s, "POST", f"{base}/soundstage/oneclick/ask",
                                                  json={"kind": "list", "timeout": t})
        out["ask none"] = await _status(s, "POST", f"{base}/soundstage/oneclick/ask", data="")
        return out

    try:
        res = _serve(register, calls)
    finally:
        OR._REGISTERED = False
    for k in ("list", "string", "number", "null"):
        assert res[f"ask {k}"][0] == 400, (k, res[f"ask {k}"])
        assert res[f"result {k}"][0] == 404, (k, res[f"result {k}"])
    for k, (st, j) in res.items():
        if k.startswith("timeout"):
            assert st == 200 and j == {"ok": True, "kind": "list"}, (k, st, j)   # the App's answer, default wait
    assert res["ask none"][0] == 200          # no body at all: list, as before


# ---------------------------------------------------------------- MCP soundstage_loop: a bridge that can't run

def _mcp():
    spec = importlib.util.spec_from_file_location("soundstage_mcp_sweep", pathlib.Path(ROOT) / "tools" / "soundstage_mcp.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.mark.parametrize("bridge,queue", [({"error": "Loop needs these models: ltx-2.5-video-vae-bf16.safetensors"}, None),
                                          ({"prompt": {"bridge": {}}, "clip_end": 95}, {"error": "node errors"})])
def test_mcp_loop_keeps_the_loop_it_made_when_the_bridge_cant_run(monkeypatch, bridge, queue):
    """The bridge step raised KeyError('prompt') / KeyError('prompt_id'): the tool answered 'Error: ...' and lost the
    sealed loop it had already saved."""
    M = _mcp()
    raw = "soundstage_private/loop/loop_00001_.mp4 [output]"
    sealed = "soundstage_private/loop/loop_00001__sealed.mp4 [output]"
    vis = {"verdict": "visible", "seam": 8.0, "badge": "Visible seam · 8.0x", "dup_last": True}
    seen = []

    def http(method, path, body=None, timeout=150):
        seen.append((path, dict(body or {})))
        if path == "/soundstage/loop/prompt":
            return {"prompt": {"save": {}}}
        if path == "/prompt":
            return {"prompt_id": "p1"} if body["prompt"] != bridge.get("prompt") or queue is None else queue
        if path == "/soundstage/loop/seam":
            return vis
        if body["how"] == "seal":
            return {"ref": sealed, "before": vis, "after": {**vis, "dup_last": False}}
        if body["how"] == "trim":
            return {"ref": "t.mp4 [output]", "before": vis, "after": {**vis, "seam": 9.0}}
        if body["how"] == "bridge":
            return bridge
        raise AssertionError(body)

    monkeypatch.setattr(M, "http", http)
    monkeypatch.setattr(M, "_wait_prompt", lambda pid, timeout=3600: {"filename": "loop_00001_.mp4",
                                                                       "subfolder": "soundstage_private/loop"})
    text, err = M.track_b("soundstage_loop", {"source": "s.png [input]", "confirm_gpu": True})
    assert not err, text
    assert text.splitlines()[0] == f"Loop: {sealed}"
    assert any(x.startswith("- bridge: ") for x in text.splitlines()), text
    assert not any(b.get("how") == "join" for _, b in seen)
    assert raw not in text.splitlines()[0]


# ---------------------------------------------------------------- the App's builders agree with the nodes they feed

def _node_js(code):
    import subprocess
    p = subprocess.run(["node", "--input-type=module", "-e", code, (pathlib.Path(ROOT) / "web").as_uri()],
                       capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        pytest.skip(f"node not available: {p.stderr[:200]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_expand_cards_pad_exactly_like_the_extend_canvas_node():
    """The card says "it's already 16:9" or shows the new area from padFor(); SoundstagePadForFill pads with
    fill_math.pad_amounts. Same numbers, and every aspect the cards send is one the node's combo offers."""
    import re
    from soundstage import fill_math as FM
    sizes = [[1920, 1080], [1080, 1920], [4096, 1716], [1000, 1000], [37, 23], [2048, 858], [1998, 1080], [5, 4000]]
    code = ("const X = await import(process.argv[1] + '/oneclick/expand.mjs');"
            f"const sizes = {json.dumps(sizes)};"
            "console.log(JSON.stringify(X.ASPECTS.map(([k, a]) => [k, a, sizes.map(([w, h]) => X.padFor(w, h, a))])));")
    src = open(os.path.join(ROOT, "soundstage", "nodes_fill.py"), encoding="utf-8").read()
    node_aspects = dict(re.findall(r'"(\d+(?:\.\d+)?:\d+)":\s*([\d./ ]+)[,}]', src.split("ASPECTS = ", 1)[1].split("\n", 1)[0]))
    for key, aspect, pads in _node_js(code):
        assert key in node_aspects, f"the card sends aspect {key!r}; the node offers {sorted(node_aspects)}"
        assert abs(eval(node_aspects[key]) - aspect) < 1e-9, key   # noqa: S307 - a literal like 16 / 9 from our source
        for (w, h), pad in zip(sizes, pads):
            py = FM.pad_amounts(w, h, aspect)
            if pad.get("none"):
                assert sum(py) <= max(1, round(0.01 * max(w, h))), (key, w, h, py)   # "already that aspect": a sliver at most
            else:   # the same pads, but for an exact half-pixel tie (JS rounds .5 up, Python to even): 1 px apart
                js = (pad["left"], pad["top"], pad["right"], pad["bottom"])
                assert js[:2] == py[:2] and sum(abs(a - b) for a, b in zip(js, py)) <= 1, (key, w, h, js, py)


def test_the_apps_file_refs_resolve_to_the_same_file_as_the_server():
    refs = ["soundstage/draft_00012_.mp4 [output]", "x.png [input]", "a/b/c.mp4", "loop/x.mp4 [temp]",
            "soundstage_private/loop/loop_00001__sealed.mp4 [output]", "  sp ace/a b.png [input] "]
    code = ("const L = await import(process.argv[1] + '/oneclick/loop.mjs');"
            f"console.log(JSON.stringify({json.dumps(refs)}.map((r) => {{ const f = L.fileOfRef(r); return [f, L.refOfFile(f)]; }})));")
    for ref, (f, back) in zip(refs, _node_js(code)):
        assert WF.parse_ref(ref) == (f["type"], f["subfolder"], f["filename"]), ref
        assert WF.parse_ref(back) == WF.parse_ref(ref), (ref, back)
