"""Video -> Stage benchmark, one command:

  python3 tools/v2s_bench/bench.py                      # everything that is missing, then the report
  python3 tools/v2s_bench/bench.py all --rerun          # run today's pipeline again on every clip (new baseline)
  python3 tools/v2s_bench/bench.py score report --clips syn_street,st_walk

Steps (each skips what is already done unless --rerun):
  prepare  stage clips: copy the render + its stage scene; synthetic clips: render them in Blender (on the runner)
  run      POST /soundstage/video2stage on each clip (pod.py: upload, wait in the ComfyUI queue, fetch the result)
  masks    SAM 3.1 tracks of the source for clips whose truth is a video-model re-render (sam_masks.py, one queued prompt)
  probe    play truth scenes and reconstructions in the real stage on the runner (harness/drive.mjs: ID + Color passes)
  score    metrics.py on the runner (numpy), with overlay contact sheets
  report   summary.json + BASELINE.md-style table (printed and written to <out>/summary.md)

The runner (default: the Mac mini, maxpost@MacMini17.local) does Blender, headless Chrome and the scoring, so the
iMac stays usable. --runner local runs it all on this machine (needs Blender, Chrome, node and ffmpeg).
Outputs: <out>/clips/<clip>/{source.mp4, truth.json, recon_result.json, metrics.json, sheet.jpg}, <out>/summary.{json,md}.
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

DEFAULT_OUT = os.path.expanduser("~/OpenHiggsfieldContest/share/Video3D_Boost/bench")
DEFAULT_RUNNER = "maxpost@MacMini17.local"
R_CODE = "sstest/v2s_bench"                 # on the runner, relative to its home
R_DATA = "sstest/v2s_bench_out/data"
R_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender"
R_PY = "/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13"   # Blender's Python has numpy
R_PATH = "export PATH=$HOME/sstest/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"


def sh(cmd, check=True, capture=False, timeout=None):
    if isinstance(cmd, str):
        cmd = ["bash", "-lc", cmd]
    r = subprocess.run(cmd, check=False, capture_output=capture, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"command failed ({r.returncode}): {' '.join(cmd)[:300]}\n{(r.stderr or '')[-2000:] if capture else ''}")
    return r


class Runner:
    def __init__(self, host: str | None):
        self.host = None if host in (None, "", "local") else host
        self.home = os.path.expanduser("~") if not self.host else None

    def run(self, script: str, timeout=None, capture=False):
        full = f"{R_PATH}; {script}"
        if self.host:
            return sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.host, full], capture=capture, timeout=timeout)
        return sh(full, capture=capture, timeout=timeout)

    def path(self, rel: str) -> str:
        return rel if self.host else os.path.join(os.path.expanduser("~"), rel)

    def push(self, local: str, rel: str, delete=False, excludes=()):
        dst = f"{self.host}:{rel}" if self.host else os.path.join(os.path.expanduser("~"), rel)
        if not self.host:
            os.makedirs(os.path.dirname(dst.rstrip("/")) or ".", exist_ok=True)
        ex = sum((["--exclude", e] for e in excludes), [])
        self.run(f"mkdir -p {shlex.quote(os.path.dirname(rel.rstrip('/')) or '.')}")
        sh(["rsync", "-a", *(["--delete"] if delete else []), *ex, local, dst])

    def pull(self, rel: str, local: str):
        src = f"{self.host}:{rel}" if self.host else os.path.join(os.path.expanduser("~"), rel)
        os.makedirs(os.path.dirname(local.rstrip("/")) or ".", exist_ok=True)
        sh(["rsync", "-a", src, local], check=False)


def load_manifest():
    with open(os.path.join(HERE, "clips.json")) as f:
        return json.load(f)["clips"]


def embedded_scene(prompt_path: str) -> dict:
    with open(os.path.expanduser(prompt_path)) as f:
        p = json.load(f)
    p = p.get("prompt", p)
    for node in p.values():
        if node.get("class_type") == "SoundstageStage":
            st = json.loads(node["inputs"]["stage"])
            return st.get("scene", st)
    raise ValueError(f"no SoundstageStage node in {prompt_path}")


# ------------------------------------------------------------------------------------------------ steps
def step_prepare(clips, out, runner, rerun):
    synth = []
    for c in clips:
        d = os.path.join(out, "clips", c["id"])
        os.makedirs(d, exist_ok=True)
        if c["kind"] == "stage":
            src = os.path.expanduser(c["source"])
            if rerun or not os.path.exists(os.path.join(d, "source.mp4")):
                sh(["cp", src, os.path.join(d, "source.mp4")])
            if rerun or not os.path.exists(os.path.join(d, "truth_scene.json")):
                scene = embedded_scene(c["scene_from_prompt"]) if c.get("scene_from_prompt") else json.load(open(os.path.expanduser(c["scene"])))
                scene = scene.get("scene", scene) if "actors" not in scene else scene
                json.dump(scene, open(os.path.join(d, "truth_scene.json"), "w"), indent=1)
        elif rerun or not (os.path.exists(os.path.join(d, "source.mp4")) and os.path.exists(os.path.join(d, "truth.json"))):
            synth.append(c)
    if synth:
        runner.push(os.path.join(HERE, "blender_synth.py"), f"{R_CODE}/tools/v2s_bench/blender_synth.py")
        for c in synth:
            rd = f"{R_DATA}/clips/{c['id']}"
            tmp = f"{R_DATA}/_render_{c['id']}"
            print(f"[prepare] rendering {c['id']} in Blender on {runner.host or 'this machine'} ...", flush=True)
            runner.run(f"rm -rf {tmp} && {R_BLENDER} --background --factory-startup --python {R_CODE}/tools/v2s_bench/blender_synth.py "
                       f"-- {c['scene']} {tmp} --samples 32 > {tmp}.log 2>&1; tail -2 {tmp}.log; mkdir -p {rd} && rm -rf {rd}/truth_id && "
                       f"mv {tmp}/id {rd}/truth_id && mv {tmp}/source.mp4 {rd}/ && {R_PY} -c \"import json,sys; d=json.load(open(sys.argv[1])); "
                       f"d['id_dir']='truth_id'; d['clip']=sys.argv[3]; json.dump(d,open(sys.argv[2],'w'),separators=(',',':'))\" "
                       f"{tmp}/truth.json {rd}/truth.json {c['id']} && rm -rf {tmp}", timeout=7200)
            d = os.path.join(out, "clips", c["id"])
            runner.pull(f"{rd}/source.mp4", os.path.join(d, "source.mp4"))
            runner.pull(f"{rd}/truth.json", os.path.join(d, "truth.json"))


def step_run(clips, out, server, rerun):
    import pod
    for c in clips:
        d = os.path.join(out, "clips", c["id"])
        res = os.path.join(d, "recon_result.json")
        if os.path.exists(res) and not rerun:
            continue
        print(f"[run] {c['id']}: upload + POST /soundstage/video2stage ({server})", flush=True)
        video = pod.upload(server, os.path.join(d, "source.mp4"), f"v2sbench_{c['id']}.mp4")
        r = pod.run(server, video, log=lambda m: print(m, flush=True))
        r["_bench"]["takes"] = pod.fetch_takes(server, r, d)
        with open(res, "w") as f:
            json.dump(r, f, indent=1)
        print(f"[run] {c['id']}: done in {r['_bench']['wall_s']} s: {r.get('summary')}", flush=True)


def step_masks(clips, out, server, rerun):
    """SAM 3.1 masks of the source for clips whose truth is a video-model re-render (exact: false)."""
    import imgio
    import sam_masks
    for c in clips:
        if c["kind"] != "stage" or c.get("exact", True) or not c.get("sam_prompts"):
            continue
        d = os.path.join(out, "clips", c["id"])
        if os.path.exists(os.path.join(d, "sam", "sam.json")) and not rerun:
            continue
        if not os.path.exists(os.path.join(d, "source.mp4")):
            continue
        print(f"[masks] {c['id']}: SAM 3.1 tracks of {', '.join(c['sam_prompts'])}", flush=True)
        video = sam_masks_upload(server, d, c["id"])
        if os.path.isdir(os.path.join(d, "sam")):
            sh(["rm", "-rf", os.path.join(d, "sam")])
        sam_masks.run(server, video, c["sam_prompts"], os.path.join(d, "sam"), c["id"], imgio.probe(os.path.join(d, "source.mp4"))[2],
                      log=lambda m: print(m, flush=True))


def sam_masks_upload(server, d, cid):
    import pod
    return pod.upload(server, os.path.join(d, "source.mp4"), f"v2sbench_{cid}.mp4")


def sync_code(runner):
    runner.push(os.path.join(REPO, "web") + "/", f"{R_CODE}/web/", delete=True)
    runner.push(os.path.join(REPO, "tools", "qa") + "/", f"{R_CODE}/tools/qa/")
    runner.push(HERE + "/", f"{R_CODE}/tools/v2s_bench/", excludes=("__pycache__",))


def step_probe(clips, out, runner, every, rerun):
    sync_code(runner)
    jobs = []
    for c in clips:
        d = os.path.join(out, "clips", c["id"])
        rd = f"{R_DATA}/clips/{c['id']}"
        if not os.path.exists(os.path.join(d, "recon_result.json")):
            print(f"[probe] {c['id']}: no reconstruction yet (run first); skipped")
            continue
        files = [os.path.join(d, f) for f in ("source.mp4", "recon_result.json", "truth_scene.json") if os.path.exists(os.path.join(d, f))]
        runner.run(f"mkdir -p {rd} {R_DATA}/jobs")
        for f in files:
            runner.push(f, f"{rd}/{os.path.basename(f)}")
        if os.path.isdir(os.path.join(d, "takes")):
            runner.push(os.path.join(d, "takes") + "/", f"{rd}/takes/")
        spec = []
        if c["kind"] == "stage":
            spec.append(("truth", {"scene": f"clips/{c['id']}/truth_scene.json", "out": f"clips/{c['id']}/truth", "modes": ["id"],
                                   "every": every, "clip": c["id"], "kind": "stage", "exact": bool(c.get("exact", True))}))
        spec.append(("recon", {"scene": f"clips/{c['id']}/recon_result.json", "out": f"clips/{c['id']}/recon", "modes": ["id", "color"],
                               "every": every, "clip": c["id"], "kind": "recon"}))
        for name, job in spec:
            jf = f"jobs/{c['id']}_{name}.json"
            payload = json.dumps(job)
            runner.run(f"rm -rf {R_DATA}/clips/{c['id']}/{name}_id {R_DATA}/clips/{c['id']}/{name}_color; "
                       f"printf '%s' {shlex.quote(payload)} > {R_DATA}/{jf}")
            jobs.append((c["id"], jf))
    if not jobs:
        return
    by_clip = {}
    for cid, jf in jobs:
        by_clip.setdefault(cid, []).append(jf)
    for cid, jfs in by_clip.items():
        print(f"[probe] {cid}: {', '.join(jfs)}", flush=True)
        runner.run(f"cd {R_CODE} && node tools/v2s_bench/harness/drive.mjs --data $HOME/{R_DATA} "
                   f"--takes $HOME/{R_DATA}/clips/{cid}/takes {' '.join(jfs)}", timeout=3600)
        runner.pull(f"{R_DATA}/clips/{cid}/truth.json", os.path.join(out, "clips", cid, "truth.json")) if any("truth" in j for j in jfs) else None
        runner.pull(f"{R_DATA}/clips/{cid}/recon.json", os.path.join(out, "clips", cid, "recon.json"))


def step_score(clips, out, runner, every):
    runner.push(HERE + "/", f"{R_CODE}/tools/v2s_bench/", excludes=("__pycache__",))
    for c in clips:
        rd = f"{R_DATA}/clips/{c['id']}"
        d = os.path.join(out, "clips", c["id"])
        if not os.path.exists(os.path.join(d, "recon_result.json")):
            continue
        if os.path.isdir(os.path.join(d, "sam")):
            runner.run(f"rm -rf {rd}/sam")
            runner.push(os.path.join(d, "sam") + "/", f"{rd}/sam/")
        print(f"[score] {c['id']}", flush=True)
        r = runner.run(f"cd {R_CODE} && {R_PY} tools/v2s_bench/metrics.py $HOME/{rd} --every {every} --sheet", capture=True, timeout=3600)
        print("   " + (r.stdout or "").strip().splitlines()[-1] if r.stdout else "")
        runner.pull(f"{rd}/metrics.json", os.path.join(d, "metrics.json"))
        runner.pull(f"{rd}/sheet.jpg", os.path.join(d, "sheet.jpg"))


def fmt(v, nd=2, pct=False):
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v * 100:.0f}%" if pct else f"{v:.{nd}f}"
    return str(v)


def step_report(clips, out):
    rows = []
    for c in clips:
        p = os.path.join(out, "clips", c["id"], "metrics.json")
        if os.path.exists(p):
            rows.append((c, json.load(open(p))))
    summary = {"when": time.strftime("%Y-%m-%d %H:%M"), "clips": {}}
    lines = ["| clip | MATCH | mIoU | explained | colour | ATE m (path m) | rot ° | focal % | roll ° | scale | things found / placed / in frame | structure found | people | MPJPE / PA mm | 2D px | root m | contact F1 | pipeline s |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for c, m in rows:
        cam, s, T, S, P, I = m["camera"], m["scale"], m["layout"]["things"], m["layout"]["structure"], m["pose"], m["identical"]
        summary["clips"][c["id"]] = {"match": I["match_score"], "miou": I["miou"], "explained": I["explained"], "colour": I["colour_sim"],
                                     "ate_m": cam["ate_m"], "rot_deg": cam["rot_err_deg"], "focal_pct": cam["focal_err_pct"],
                                     "roll_deg": cam["roll_err_deg"], "scale": s["recon_m_per_true_m"], "things_recall": T["recall"],
                                     "things_placed": T["placed_recall"], "structure_recall": S["recall"], "mpjpe_mm": P["mpjpe_mm"],
                                     "pa_mpjpe_mm": P["pa_mpjpe_mm"], "reproj_px": P["reproj_px_at_1024"], "contact_f1": P["contact_f1"]}
        lines.append(f"| {c['id']}{'' if m.get('exact_truth', True) else ' *'} | **{fmt(I['match_score'], 1)}** | {fmt(I['miou'])} | {fmt(I['explained'])} | "
                     f"{fmt(I['colour_sim'])} | {fmt(cam['ate_m'])} ({fmt(cam['path_m'], 1)}) | {fmt(cam['rot_err_deg'], 1)} | {fmt(cam['focal_err_pct'], 0)} | "
                     f"{fmt(cam['roll_err_deg'], 1)} | ×{fmt(s['recon_m_per_true_m'])} | {T['matched']} / {T['placed']} / {T['true_in_frame']} | "
                     f"{S['matched']} / {S['true_in_frame']} | {P['people_matched']} / {P['people_true']} | {fmt(P['mpjpe_mm'], 0)} / {fmt(P['pa_mpjpe_mm'], 0)} | "
                     f"{fmt(P['reproj_px_at_1024'], 0)} | {fmt(P['root_err_m'])} | {fmt(P['contact_f1'])} | {fmt((m['pipeline'] or {}).get('wall_s'), 0)} |")
    if rows:
        ms = [m["identical"]["match_score"] for _, m in rows if m["identical"]["match_score"] is not None]
        summary["mean_match"] = round(sum(ms) / len(ms), 1) if ms else None
        lines.append(f"\nMean MATCH over {len(ms)} clips: **{summary['mean_match']}** / 100.  (* = truth from a video-model re-render of the clay: as exact as its adherence.)")
    for c, m in rows:
        cam, s, T, S, P, I = m["camera"], m["scale"], m["layout"]["things"], m["layout"]["structure"], m["pose"], m["identical"]
        lines.append(f"\n### {c['id']}: MATCH {fmt(I['match_score'], 1)}\n")
        lines.append(f"- Camera: ATE {fmt(cam['ate_m'])} m over a {fmt(cam['path_m'], 1)} m path, rotation {fmt(cam['rot_err_deg'], 1)}° "
                     f"(max {fmt(cam['rot_err_deg_max'], 1)}°), focal {cam['focal_recon_mm']} mm vs {cam['focal_true_mm']} mm "
                     f"({fmt(cam['focal_err_pct'], 0)} %), roll error {fmt(cam['roll_err_deg'], 1)}° (true roll {cam['roll_true_range_deg']}°).")
        lines.append(f"- Scale: the rebuild is ×{fmt(s['recon_m_per_true_m'])} real size (camera {fmt(s['cam_height_recon_m'])} m up vs "
                     f"{fmt(s['cam_height_true_m'])} m).")
        miss = T.get("missing") or []
        lines.append(f"- Things: {T['matched']} of {T['true_in_frame']} found, {T['placed']} placed within tolerance; "
                     f"{T['recon']} rebuilt (precision {fmt(T['precision'], 2)}). Missing: {', '.join(miss[:14]) + (' …' if len(miss) > 14 else '') or 'none'}.")
        if T.get("size_err_pct") is not None:
            lines.append(f"- Found things: size off {fmt(T['size_err_pct'], 0)} % on average, placed {fmt(T['place_err_m'])} m off, "
                         f"heading {fmt(T['orient_err_deg'], 1)}° off, colour ΔE {fmt(T['colour_dE'], 1)}; movers follow their path "
                         f"{fmt(T['mover_path_coverage'], 2, pct=True)} of the time.")
        if S["true_in_frame"]:
            lines.append(f"- Structure: {S['matched']} of {S['true_in_frame']} found (missing: {', '.join((S.get('missing') or [])[:10]) or 'none'}).")
        if P["people_true"]:
            lines.append(f"- People: {P['people_matched']} of {P['people_true']} paired; MPJPE {fmt(P['mpjpe_mm'], 0)} mm, PA-MPJPE "
                         f"{fmt(P['pa_mpjpe_mm'], 0)} mm, 2D {fmt(P['reproj_px_at_1024'], 0)} px, root {fmt(P['root_err_m'])} m, "
                         f"contact F1 {fmt(P['contact_f1'])}.")
        objs = list((I.get("per_object_iou") or {}).items())
        if objs:
            lines.append(f"- Silhouettes from the solved camera: mIoU {fmt(I['miou'])}, explained {fmt(I['explained'], 2, pct=True)} of the "
                         f"object pixels, ghost {fmt(I['ghost'], 2, pct=True)}. Best: {', '.join(f'{k} {v:.2f}' for k, v in objs[:3])}.")
        tm = m.get("truth_masks") or {}
        if tm.get("assigned") is not None:
            extra = tm.get("unassigned") or []
            lines.append(f"- Truth silhouettes: {tm['source']}; " + ", ".join(f"{k} ← {len(v)} track(s)" for k, v in tm["assigned"].items())
                         + (f"; {len(extra)} more {'/'.join(sorted({e['prompt'] for e in extra}))} track(s) in the source that the stage "
                            f"truth does not have (the video model added them; not scored)" if extra else ""))
        notes = [n for n in ((m.get("pipeline") or {}).get("notes") or []) if not n.startswith("depth_anything_3_mono")]
        if notes:
            lines.append(f"- Pipeline notes: {' · '.join(notes[:6])}")
        lines.append(f"- Sheet: `clips/{c['id']}/sheet.jpg`")
    md = "\n".join(lines)
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    with open(os.path.join(out, "summary.md"), "w") as f:
        f.write(md + "\n")
    print(md)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("steps", nargs="*", default=["all"], help="prepare run masks probe score report | all")
    ap.add_argument("--clips", default="", help="comma-separated clip ids (default: all in clips.json)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--runner", default=os.environ.get("V2S_RUNNER", DEFAULT_RUNNER), help="ssh host for Blender/Chrome/scoring, or 'local'")
    ap.add_argument("--server", default=os.environ.get("SS_URL", "http://127.0.0.1:8189"), help="the ComfyUI with Soundstage")
    ap.add_argument("--every", type=int, default=2, help="score every Nth frame (default 2)")
    ap.add_argument("--rerun", action="store_true", help="redo steps that already have results (a new baseline)")
    a = ap.parse_args(argv)
    steps = ["prepare", "run", "masks", "probe", "score", "report"] if "all" in a.steps else a.steps
    clips = load_manifest()
    if a.clips:
        want = set(a.clips.split(","))
        clips = [c for c in clips if c["id"] in want]
    runner = Runner(a.runner)
    os.makedirs(a.out, exist_ok=True)
    if "prepare" in steps:
        step_prepare(clips, a.out, runner, a.rerun)
    if "run" in steps:
        step_run(clips, a.out, a.server, a.rerun)
    if "masks" in steps:
        step_masks(clips, a.out, a.server, a.rerun)
    if "probe" in steps:
        step_probe(clips, a.out, runner, a.every, a.rerun)
    if "score" in steps:
        step_score(clips, a.out, runner, a.every)
    if "report" in steps:
        step_report(clips, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
