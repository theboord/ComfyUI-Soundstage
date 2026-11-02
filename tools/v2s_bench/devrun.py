"""Dev runner: test a worktree's NEW Video -> Stage Python against the live pod, with no ComfyUI restart.

  python3 tools/v2s_bench/devrun.py --track v2s-solve --clips syn_street,st_walk
  python3 tools/v2s_bench/devrun.py --track v2s-pose --clips syn_interior --body '{"quality": "fast"}' --score
  python3 tools/v2s_bench/devrun.py --track v2s-solve --video my_upload.mp4 --out /tmp/x     # any input-folder clip

What it does (stdlib only on this machine):
1. rsync this worktree's soundstage/ to the pod at /workspace/soundstage/v2s_dev/<track>/soundstage/ (never into
   custom_nodes, so the running App is untouched);
2. makes sure the clip is in the pod's input folder (POST /upload/image, the bench's v2sbench_<clip>.mp4 name);
3. starts a standalone process on the pod: the Soundstage venv's python, cwd = the running 8189 ComfyUI's cwd,
   `soundstage.video2stage.pipeline.run` imported from the dev copy. A small `folder_paths` shim answers the input /
   output folders and model lists (GET /models/<folder>), so nothing of ComfyUI itself is imported. Every GPU step
   is an ordinary prompt POSTed to 127.0.0.1:8189/prompt (core nodes plus the already-registered
   SoundstageDA3Export / SoundstageMocap at their current signatures): it waits its turn behind everyone else's
   work, and it never touches, cancels or reorders anyone else's queue items. It is not an HTTP listener;
4. waits for it (polling a status file; a dropped ssh does not kill the run), then copies
   <out>/<clip>/{recon_result.json, run.log, takes/} back here, in the shape `bench.py ... --recon <out>` reads.

--score then runs `bench.py probe score report --recon <out> --clips ...` on the default runner (the Mac mini).
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

POD = os.environ.get("V2S_POD", "root@216.81.245.80")
POD_PORT = os.environ.get("V2S_POD_PORT", "19835")
POD_KEY = os.path.expanduser(os.environ.get("V2S_POD_KEY", "~/.ssh/id_ed25519"))
DEV_ROOT = "/workspace/soundstage/v2s_dev"
PIDFILE = "/workspace/soundstage/comfy8189.pid"
DEFAULT_OUT = os.path.expanduser("~/OpenHiggsfieldContest/share/Video3D_Boost/devrun")
BENCH_OUT = os.path.expanduser("~/OpenHiggsfieldContest/share/Video3D_Boost/bench")

SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-p", POD_PORT, "-i", POD_KEY]

# The process that runs on the pod. Written next to the dev copy; reads its job from argv.
ENTRY = r'''
import asyncio, json, os, shutil, sys, time, traceback, types, urllib.request
dev, video, out, body, server = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5]
cwd = os.getcwd()
os.makedirs(out, exist_ok=True)
status = os.path.join(out, "status.json")
def say(state, **kw):
    tmp = status + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"state": state, "t": time.time(), **kw}, f)
    os.replace(tmp, status)
say("running", step="starting")
# folder_paths shim: the running server's folders, model lists over GET /models/<folder> (one folder each).
fp = types.ModuleType("folder_paths")
fp.base_path = cwd
fp.get_input_directory = lambda: os.path.join(cwd, "input")
fp.get_output_directory = lambda: os.path.join(cwd, "output")
fp.get_temp_directory = lambda: os.path.join(cwd, "temp")
_cache = {}
def _list(folder):
    if folder not in _cache:
        try:
            with urllib.request.urlopen(f"{server}/models/{folder}", timeout=30) as r:
                _cache[folder] = json.loads(r.read())
        except Exception:
            _cache[folder] = []
    return list(_cache[folder])
fp.get_filename_list = _list
def _annot(name, default_dir=None):
    name = str(name)
    for suf, d in ((" [output]", "output"), (" [input]", "input"), (" [temp]", "temp")):
        if name.endswith(suf):
            return os.path.join(cwd, d, name[: -len(suf)])
    return os.path.join(default_dir or fp.get_input_directory(), name)
fp.get_annotated_filepath = _annot
fp.exists_annotated_filepath = lambda name: os.path.exists(_annot(name))
sys.modules["folder_paths"] = fp
sys.path.insert(0, dev)
try:
    from soundstage.video2stage import pipeline
    steps = []
    def progress(step, frac, **kw):
        steps.append([round(time.time(), 1), step, frac])
        print(f"[{time.strftime('%H:%M:%S')}] {frac:.2f} {step}", flush=True)
        say("running", step=step, progress=frac)
    t0 = time.time()
    kw = dict(body)
    res = asyncio.run(pipeline.run(server, video, progress=progress, **pipeline.run_kwargs(kw)))
    res["_bench"] = {"job": "devrun", "wall_s": round(time.time() - t0, 1), "server": server, "video": video,
                     "when": time.strftime("%Y-%m-%d %H:%M:%S"), "dev": dev, "body": body, "steps": steps}
    with open(os.path.join(out, "recon_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    # mocap takes the scene names, so the probe can play them
    for a in (res.get("scene") or {}).get("actors") or []:
        fn = (a.get("mocap") or {}).get("file")
        if fn:
            src = os.path.join(cwd, "output", fn)
            dst = os.path.join(out, "takes", fn)
            if os.path.exists(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy(src, dst)
    say("done", wall_s=res["_bench"]["wall_s"], summary=res.get("summary"))
except BaseException as exc:
    traceback.print_exc()
    say("error", error=f"{type(exc).__name__}: {exc}")
    sys.exit(1)
'''


def sh(cmd, check=True, capture=True, timeout=None, input_text=None):
    r = subprocess.run(cmd, capture_output=capture, text=True, timeout=timeout, input=input_text)
    if check and r.returncode != 0:
        raise RuntimeError(f"failed ({r.returncode}): {' '.join(cmd)[:300]}\n{(r.stderr or '')[-1500:]}")
    return r


def pod(script: str, timeout=120, check=True):
    return sh(SSH + [POD, script], timeout=timeout, check=check)


def sync(track: str, src_root: str) -> str:
    dev = f"{DEV_ROOT}/{track}"
    pod(f"mkdir -p {dev}/soundstage")
    sh(["rsync", "-rlt", "--delete", "--exclude", "__pycache__", "--exclude", "*.pyc", "-e", " ".join(SSH),
        os.path.join(src_root, "soundstage") + "/", f"{POD}:{dev}/soundstage/"], timeout=600)
    sh(SSH + [POD, f"cat > {dev}/_devrun_entry.py"], input_text=ENTRY, timeout=60)
    return dev


def comfy_cwd() -> str:
    r = pod(f"readlink /proc/$(cat {PIDFILE})/cwd")
    cwd = r.stdout.strip()
    if not cwd:
        raise RuntimeError("the 8189 ComfyUI is not running (no pid / cwd)")
    return cwd


def ensure_video(server: str, cwd: str, clip: str | None, video: str | None) -> str:
    if video:
        return video
    name = f"v2sbench_{clip}.mp4"
    r = pod(f"test -f {shlex.quote(cwd)}/input/{name} && echo yes || echo no")
    if r.stdout.strip() != "yes":
        import pod as podmod
        src = os.path.join(BENCH_OUT, "clips", clip, "source.mp4")
        print(f"  uploading {src} -> input/{name}")
        podmod.upload(server, src, name)
    return name


def start(dev: str, cwd: str, video: str, rout: str, body: dict, server_on_pod: str) -> None:
    args = " ".join(shlex.quote(a) for a in (dev, video, rout, json.dumps(body), server_on_pod))
    pod(f"rm -rf {shlex.quote(rout)} && mkdir -p {shlex.quote(rout)} && cd {shlex.quote(cwd)} && "
        f"{{ OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8 setsid nohup nice -n 5 venv/bin/python {dev}/_devrun_entry.py {args} "
        f"> {shlex.quote(rout)}/run.log 2>&1 < /dev/null & }}; echo started", timeout=60)


def wait(rout: str, timeout_s: float, log=print) -> dict:
    t0, last = time.time(), ""
    while time.time() - t0 < timeout_s:
        time.sleep(5)
        try:
            r = pod(f"cat {shlex.quote(rout)}/status.json 2>/dev/null", check=False, timeout=60)
            s = json.loads(r.stdout or "{}")
        except Exception:  # noqa: BLE001 - a busy link answers late
            continue
        msg = f"{s.get('state')} {s.get('step', '')} {s.get('progress', '')}"
        if msg != last:
            log(f"  [{time.time() - t0:5.0f}s] {msg}")
            last = msg
        if s.get("state") in ("done", "error"):
            return s
    raise TimeoutError(f"devrun not done after {timeout_s:.0f} s ({rout})")


def fetch(rout: str, local: str) -> None:
    os.makedirs(local, exist_ok=True)
    sh(["rsync", "-rlt", "-e", " ".join(SSH), f"{POD}:{rout}/", local + "/"], timeout=600, check=False)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", required=True, help="your track key (v2s-solve, v2s-pose, v2s-layout, v2s-match)")
    ap.add_argument("--clips", default="", help="bench clip ids, comma-separated")
    ap.add_argument("--video", default="", help="or: a file already in the pod's input folder")
    ap.add_argument("--out", default="", help=f"local results folder (default {DEFAULT_OUT}/<track>)")
    ap.add_argument("--src", default=REPO, help="the worktree whose soundstage/ is tested (default: this one)")
    ap.add_argument("--body", default="{}", help="route options as JSON, e.g. '{\"quality\": \"fast\", \"vlm\": false}'")
    ap.add_argument("--server", default=os.environ.get("SS_URL", "http://127.0.0.1:8189"), help="the App as this machine sees it")
    ap.add_argument("--pod-server", default="http://127.0.0.1:8189", help="the App as the pod sees it")
    ap.add_argument("--timeout", type=float, default=5400)
    ap.add_argument("--score", action="store_true", help="then bench.py probe score report --recon <out>")
    ap.add_argument("--no-sync", action="store_true", help="reuse the dev copy already on the pod")
    a = ap.parse_args(argv)
    track = "".join(c if c.isalnum() or c in "-_" else "_" for c in a.track)
    out = os.path.abspath(os.path.expanduser(a.out or os.path.join(DEFAULT_OUT, track)))
    body = json.loads(a.body)
    clips = [c for c in a.clips.split(",") if c] or ([None] if a.video else [])
    if not clips:
        ap.error("give --clips or --video")
    dev = f"{DEV_ROOT}/{track}" if a.no_sync else sync(track, os.path.abspath(a.src))
    cwd = comfy_cwd()
    print(f"dev copy {dev}; ComfyUI cwd {cwd}")
    failed = []
    for clip in clips:
        name = clip or os.path.splitext(os.path.basename(a.video))[0]
        video = ensure_video(a.server, cwd, clip, a.video or None)
        rout = f"{dev}/out/{name}"
        print(f"[devrun] {name}: {video} {json.dumps(body)}", flush=True)
        start(dev, cwd, video, rout, body, a.pod_server)
        s = wait(rout, a.timeout)
        fetch(rout, os.path.join(out, name))
        if s.get("state") != "done":
            failed.append(name)
            print(f"[devrun] {name}: ERROR {s.get('error')}  (log: {os.path.join(out, name, 'run.log')})", flush=True)
        else:
            print(f"[devrun] {name}: done in {s.get('wall_s')} s {s.get('summary')}", flush=True)
    if a.score and clips[0]:
        ok = [c for c in clips if c not in failed]
        if ok:
            sh([sys.executable, os.path.join(HERE, "bench.py"), "probe", "score", "report", "--recon", out,
                "--clips", ",".join(ok)], capture=False, check=False, timeout=7200)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
