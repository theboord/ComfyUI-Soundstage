#!/usr/bin/env python3
"""Soundstage MCP server: drive the open Soundstage App from Claude Desktop, Claude Code or any MCP client.

Standard library only; speaks MCP over stdio and talks HTTP to ComfyUI (SOUNDSTAGE_URL, default http://127.0.0.1:8188).
Every change is proposed first (a dry run that returns a plan_id and the plan in film language); nothing on the set
changes until soundstage_apply(plan_id). GPU renders also need confirm_gpu=true, which a client should only pass after
the user said yes. The App must be open in a browser: it reports its scene to ComfyUI and runs what you apply, in view,
undoable from its Director panel.

    claude mcp add soundstage -- python3 /path/to/ComfyUI-Soundstage/tools/soundstage_mcp.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("SOUNDSTAGE_URL", "http://127.0.0.1:8188").rstrip("/")
PROTOCOL = "2024-11-05"
VERSION = "0.15.0"

CORE = [
    {"name": "soundstage_state", "description": "What's on the Soundstage set now: set, time, weather, cast and objects, shots (numbered as in the shot strip), script scenes. Read this first.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "soundstage_direct", "description": "Describe what you want in plain words (\"put Mara in the sports car at night, rain, camera on the hood\"). Returns a proposed plan and a plan_id; nothing changes until soundstage_apply.",
     "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
    {"name": "soundstage_apply", "description": "Apply a proposed plan in the open App (it shows up on the stage and in the Director panel, undoable). Plans that render on the GPU need confirm_gpu=true: ask the user first.",
     "inputSchema": {"type": "object", "properties": {"plan_id": {"type": "string"}, "confirm_gpu": {"type": "boolean", "default": False}}, "required": ["plan_id"]}},
    {"name": "soundstage_undo", "description": "Undo the last Director change in the open App.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "soundstage_judge_take", "description": "The realism judge (VFX-supervisor pass): a local vision model inspects a rendered take's cars, faces and hands and says whether they could be real. Returns pass/fail, a 0-10 score and specific defects with frames (\"rear lights incoherent, f24-64\"). Check every Hollywood take with it before calling it done. About a minute, queued on the GPU; cached per take.",
     "inputSchema": {"type": "object", "properties": {"filename": {"type": "string", "description": "the take's file name, e.g. final_00028_.mp4"},
                                                       "subfolder": {"type": "string", "default": "soundstage"}, "type": {"type": "string", "default": "output"},
                                                       "force": {"type": "boolean", "default": False}}, "required": ["filename"]}},
    {"name": "soundstage_one_click", "description": "✦ One-click effects on a take or a frame, in the open App: weather and time (nightfall, flood, rain, snow, fog, golden_hour), empty (take people out), cutout (alpha), living_photo, the 18 film lighting setups (relight_<setup>), new angles (angle_* approximate, exact_* from the 3D stage), expand_<aspect>. Without id it lists what applies to that take. With id and no confirm_gpu it proposes (what runs, how long); with confirm_gpu=true (ask the user first) the App runs it and the result lands as a new take, checked by the realism judge.",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "the one-click, e.g. nightfall, relight_rembrandt, exact_orbit_left, expand_2_39_1; omit to list"},
         "shot": {"type": ["integer", "string"], "description": "shot number (1 = first in the strip) or name; default the open shot"},
         "take": {"type": ["integer", "string"], "description": "take number (Tk n); default the circled, else the latest final > draft > frame"},
         "opts": {"type": "object", "description": "card options, e.g. {\"subject\": \"the dog\"} for cutout, {\"lock\": true} for a depth-locked relight"},
         "confirm_gpu": {"type": "boolean", "default": False, "description": "the user agreed to spend GPU time (needed to run)"}}}},
]

# Track B: Seamless loop, Reshoot, the graph inside a take (soundstage/handoff/routes.py; these run on the server, no
# open App needed). A take is named by its file reference, e.g. "soundstage/draft_00012_.mp4 [output]".
CORE += [
    {"name": "soundstage_loop", "description": "Seamless loop from a still or a take's first frame (LTX-2.5, the same picture at the first and last frame). The seam meter then scores the wrap (Seamless / Visible seam with a number) and the fixer trims to the best frame pair, then (fix=true) one bridge render back to frame 1: before and after are reported, never a crossfade. Without confirm_gpu it only proposes; ask the user, then call with confirm_gpu=true. 1-2 GPU jobs, about 1-4 min.",
     "inputSchema": {"type": "object", "properties": {
         "source": {"type": "string", "description": "a still or a take, e.g. \"soundstage/look_00166_.png [output]\""},
         "prompt": {"type": "string", "description": "what moves (\"waves roll onto the sand\"); empty = gentle natural motion"},
         "seconds": {"type": "number", "default": 4}, "fix": {"type": "boolean", "default": True},
         "quality": {"type": "string", "enum": ["Draft", "Final"], "default": "Draft"},
         "confirm_gpu": {"type": "boolean", "default": False}}, "required": ["source"]}},
    {"name": "soundstage_reshoot", "description": "Reshoot a take from a slightly different camera: the take is measured in 3D frame by frame (Depth Anything 3), the camera re-aimed relative to the original on every frame, then rendered with LTX-2.5 union control and the take's own sound. Safe range: orbit +-15 deg, tilt +-8 deg, dolly +-0.25 (of the subject distance), lens 0.7-1.6x; past that the render invents what the camera never saw. 2 GPU jobs (the depth is cached per take). Proposes without confirm_gpu.",
     "inputSchema": {"type": "object", "properties": {
         "source": {"type": "string", "description": "the take, e.g. \"soundstage/final_00063_.mp4 [output]\""},
         "orbit_deg": {"type": "number"}, "tilt_deg": {"type": "number"}, "dolly": {"type": "number"}, "lens": {"type": "number"},
         "quality": {"type": "string", "enum": ["Draft", "Final"], "default": "Draft"},
         "confirm_gpu": {"type": "boolean", "default": False}}, "required": ["source"]}},
    {"name": "soundstage_take_workflow", "description": "The exact ComfyUI graph that made a take or a still (read from the file's own tags, no GPU): the UI workflow when it was queued from a canvas, else the API prompt, plus the Soundstage recipe. save_to writes the JSON to a local file.",
     "inputSchema": {"type": "object", "properties": {"ref": {"type": "string"}, "save_to": {"type": "string"}}, "required": ["ref"]}},
]


def _wait_prompt(pid: str, timeout: float = 3600) -> dict:
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = http("GET", f"/history/{pid}", timeout=30)
        e = h.get(pid) if isinstance(h, dict) else None
        if e:
            if (e.get("status") or {}).get("status_str") == "error":
                msg = next((m[1].get("exception_message") for m in e["status"].get("messages", []) if m[0] == "execution_error"), "")
                raise RuntimeError(msg or "the render failed")
            f = ((e.get("outputs") or {}).get("save") or {})
            f = next((v[0] for v in f.values() if isinstance(v, list) and v and isinstance(v[0], dict)), None)
            if f:
                return f
            if (e.get("status") or {}).get("completed"):
                raise RuntimeError("finished without a video")
        time.sleep(3)
    raise RuntimeError("timed out")


def _ref(f: dict) -> str:
    return f"{f.get('subfolder') + '/' if f.get('subfolder') else ''}{f['filename']} [{f.get('type', 'output')}]"


def track_b(name: str, args: dict) -> tuple[str, bool]:
    """soundstage_loop / soundstage_reshoot / soundstage_take_workflow."""
    try:
        if name == "soundstage_take_workflow":
            import urllib.parse
            r = http("GET", "/soundstage/handoff/workflow?ref=" + urllib.parse.quote(str(args.get("ref") or "")), timeout=60)
            if r.get("error") or not r.get("kind"):
                return f"Error: {r.get('error') or r.get('why')}", True
            out = {k: r[k] for k in ("workflow", "prompt") if r.get(k)}
            text = f"{r['name']}: {r['nodes']} nodes ({'the canvas workflow' if r['kind'] == 'workflow' else 'the API prompt'})"
            if r.get("recipe"):
                text += f"; recipe {json.dumps(r['recipe'])}"
            if args.get("save_to"):
                with open(os.path.expanduser(args["save_to"]), "w") as fh:
                    json.dump(out, fh, indent=1)
                return text + f". Saved to {args['save_to']}.", False
            return text + ".\n" + json.dumps(out)[:20000], False
        if name == "soundstage_loop":
            body = {"source": args.get("source"), "prompt": args.get("prompt") or "", "seconds": args.get("seconds") or 4,
                    "quality": args.get("quality") or "Draft", "seed": 7}
            if not args.get("confirm_gpu"):
                return (f"Proposed (nothing ran yet): a {body['seconds']} s seamless loop of {body['source']} on LTX-2.5, then the seam "
                        f"meter{' and, if the seam shows, a trim then one bridge render' if args.get('fix', True) else ''}. 1-2 GPU jobs, "
                        "about 1-4 min. Ask the user, then call again with confirm_gpu=true."), False
            g = http("POST", "/soundstage/loop/prompt", body, timeout=120)
            if g.get("error"):
                return f"Error: {g['error']}", True
            q = http("POST", "/prompt", {"prompt": g["prompt"], "client_id": "soundstage-mcp"})
            if not q.get("prompt_id"):
                return f"Error: the queue refused it: {q}", True
            ref = _ref(_wait_prompt(q["prompt_id"]))
            lines, best = [], http("POST", "/soundstage/loop/seam", {"ref": ref}, timeout=300)
            for how in ("seal", "trim") + (("bridge",) if args.get("fix", True) else ()):
                # a Seamless render still drops its repeated last frame (the meter measured the wrap without it)
                if best.get("verdict") == "seamless" and not (how == "seal" and best.get("dup_last")):
                    break
                if how == "bridge":
                    b = http("POST", "/soundstage/loop/fix", {"ref": ref, "how": "bridge", "prompt": body["prompt"]}, timeout=300)
                    bq = http("POST", "/prompt", {"prompt": b["prompt"], "client_id": "soundstage-mcp"})
                    bf = _wait_prompt(bq["prompt_id"])
                    r = http("POST", "/soundstage/loop/fix", {"ref": ref, "how": "join", "bridge_ref": _ref(bf), "clip_end": b["clip_end"]}, timeout=300)
                else:
                    r = http("POST", "/soundstage/loop/fix", {"ref": ref, "how": how}, timeout=300)
                if r.get("error"):
                    lines.append(f"{how}: {r['error']}")
                    continue
                a = r["after"]
                if how == "seal":   # kept whenever a frame was dropped (a new file), as web/oneclick/loop.mjs does
                    kept = bool(r.get("ref")) and r["ref"] != ref
                else:
                    kept = a.get("verdict") == "seamless" and best.get("verdict") != "seamless" or float(a.get("seam", 99)) < float(best.get("seam", 99))
                lines.append(f"{how}: {r['before']['badge']} -> {a['badge']}{' (kept)' if kept else ' (no better)'}")
                if kept:
                    ref, best = r["ref"], a
            return f"Loop: {ref}\n{best.get('badge')}\n" + "\n".join(f"- {x}" for x in lines), False
        if name == "soundstage_reshoot":
            move = {k: args[k] for k in ("orbit_deg", "tilt_deg", "dolly", "lens") if args.get(k) is not None}
            if not args.get("confirm_gpu"):
                return (f"Proposed (nothing ran yet): reshoot {args.get('source')} with {move or 'no move'} (clamped to orbit +-15, "
                        "tilt +-8, dolly +-0.25, lens 0.7-1.6). 2 GPU jobs (depth, cached per take; the render), about 3-6 min. "
                        "Ask the user, then call again with confirm_gpu=true."), False
            j = http("POST", "/soundstage/reshoot", {"source": args.get("source"), "move": move, "quality": args.get("quality") or "Draft"})
            if not j.get("job"):
                return f"Error: {j.get('error')}", True
            import time
            while True:
                time.sleep(3)
                s = http("GET", f"/soundstage/reshoot/job?id={j['job']}", timeout=30)
                if s.get("state") == "done":
                    res = s["result"]
                    return (f"Reshot: {_ref(res['file'])}\nThe camera {res['words']}; {round(res['holes'] * 100)}% of the new view "
                            f"was never seen by the original camera.\n" + "\n".join(f"- {n}" for n in res.get("notes") or [])), False
                if s.get("state") == "error" or s.get("error"):
                    return f"Error: {s.get('error')}", True
    except Exception as e:  # noqa: BLE001
        return f"Error: {e}", True
    return f"Unknown tool {name}", True


def http(method: str, path: str, body=None, timeout=150):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return {"error": json.load(e).get("error") or f"HTTP {e.code}", "status": e.code}
        except Exception:  # noqa: BLE001
            return {"error": f"HTTP {e.code}", "status": e.code}
    except (urllib.error.URLError, OSError) as e:
        return {"error": f"can't reach ComfyUI at {URL} ({e}); set SOUNDSTAGE_URL"}


def _schema_for(tool: dict) -> dict:
    props, req = {}, []
    for name, a in tool.get("args", {}).items():
        t = a.get("type")
        if t == "enum":
            p = {"type": "string", "enum": a["enum"]}
        elif t in ("int",):
            p = {"type": "integer", "minimum": a.get("min"), "maximum": a.get("max")}
        elif t == "num":
            p = {"type": "number", "minimum": a.get("min"), "maximum": a.get("max")}
        elif t == "shots":
            p = {"description": 'shot numbers as in the strip, e.g. [1, 2, 3], "1-3" or "all"', "anyOf": [{"type": "array", "items": {"type": ["integer", "string"]}}, {"type": "string"}]}
        elif t == "shot":
            p = {"type": ["integer", "string"], "description": "shot number (1 = first in the strip) or its name"}
        elif t == "scene":
            p = {"type": ["integer", "string"], "description": "script scene number"}
        elif t in ("name", "person", "vehicle", "seat", "names", "place"):
            p = {"type": "string", "description": {"name": "an object on set, by name", "person": "a person on set", "vehicle": "a vehicle on set",
                                                   "seat": "a vehicle, horse or seat on set", "names": "an object or group on set (\"the crates\")",
                                                   "place": "an object or a place on the set (\"storefront\", \"wall\")"}[t]}
        else:
            p = {"type": "string"}
        props[name] = {k: v for k, v in p.items() if v is not None}
        if a.get("required"):
            req.append(name)
    props["dry_run"] = {"type": "boolean", "default": True, "description": "true (default): only propose; false: propose and apply right away"}
    if tool.get("gpu"):
        props["confirm_gpu"] = {"type": "boolean", "default": False, "description": "the user agreed to spend GPU time (needed to apply)"}
    return {"type": "object", "properties": props, **({"required": req} if req else {})}


_TOOLS = None


def tools() -> list[dict]:
    global _TOOLS
    if _TOOLS is None:
        info = http("GET", "/soundstage/director/info", timeout=10)
        typed = []
        for t in info.get("tools", []) if isinstance(info, dict) else []:
            if t["name"] in ("undo",):
                continue
            desc = t["doc"] + (" (renders on the GPU: needs confirm_gpu)" if t.get("gpu") else "") + ". Proposes a plan (dry run) unless dry_run=false."
            typed.append({"name": f"ss_{t['name']}", "description": desc, "inputSchema": _schema_for(t)})
        _TOOLS = CORE + typed if typed else None
        return CORE + typed
    return _TOOLS


def _plan_text(res: dict) -> str:
    if res.get("error"):
        return f"Error: {res['error']}"
    lines = [f"- {p}" for p in res.get("plan", [])]
    lines += [f"- (couldn't) {r['why']}" for r in res.get("rejected", [])]
    out = "\n".join(lines) or "- nothing I can do with that"
    gpu = " This plan renders on the GPU: ask the user, then apply with confirm_gpu=true." if res.get("gpu") else ""
    return f"Proposed (dry run, nothing changed yet). plan_id: {res.get('plan_id')}\n{out}\nApply it with soundstage_apply.{gpu}"


def _apply_text(res: dict) -> str:
    if res.get("error"):
        return f"Error: {res['error']}" + ("\n" + "\n".join(f"- {p}" for p in res.get("plan", [])) if res.get("plan") else "")
    said = res.get("said") or [r.get("said") for r in res.get("results", [])]
    nxt = res.get("next") or []
    return "Applied in the App:\n" + "\n".join(f"- {s}" for s in said if s) + \
        (f"\nNext: {', '.join(n['label'] for n in nxt)}" if nxt else "") + "\n(Undo with soundstage_undo.)"


def judge_text(r: dict) -> str:
    if r.get("verdict") not in ("pass", "fail"):
        return f"Not judged: {r.get('error') or r.get('why') or 'no verdict'}"
    lines = [f"{'PASS' if r['verdict'] == 'pass' else 'FAIL (AI slop)'}: realism {r.get('score')}/10 ({r.get('model')}, frames {r.get('frames')})"]
    lines += [f"- {d['label']}: {'; '.join(d.get('examples') or [])[:200]}" for d in r.get("defects") or []]
    lines += [f"- minor: {d['label']}" for d in (r.get("minor") or [])[:4]]
    return "\n".join(lines)


def one_click(args: dict) -> tuple[str, bool]:
    """List / propose / run a ✦ One-click in the open App (soundstage/oneclick/routes.py relays it)."""
    oc = str(args.get("id") or "").strip()
    base = {"shot": args.get("shot"), "take": args.get("take"), "opts": args.get("opts") or {}}
    if not oc:
        r = http("POST", "/soundstage/oneclick/ask", {"kind": "list", **base}, timeout=60)
        if r.get("error"):
            return f"Error: {r['error']}", True
        rows = [f"- {o['id']} ({o['group']}): {o['label']}{' [' + o['badge'] + ']' if o.get('badge') else ''}"
                + (f" — {o['why']}" if not o.get("ok") else "") for o in r.get("oneclicks", [])]
        return f"One-clicks for {r.get('target', {}).get('label', 'the take')}:\n" + "\n".join(rows), False
    if not args.get("confirm_gpu"):
        r = http("POST", "/soundstage/oneclick/ask", {"kind": "propose", "oneclick": oc, **base}, timeout=60)
        if r.get("error"):
            return f"Error: {r['error']}", True
        return (f"Proposed (nothing ran yet): {r.get('plan')} ({r.get('cost')}).\n"
                + ("It renders on the GPU: ask the user, then call again with confirm_gpu=true." if r.get("gpu") else "Call again with confirm_gpu=true to run it.")), False
    r = http("POST", "/soundstage/oneclick/ask", {"kind": "run", "oneclick": oc, "confirm_gpu": True, **base}, timeout=2500)
    if r.get("error"):
        return f"Error: {r['error']}", True
    rv = r.get("realism") or {}
    judged = (f"realism judge: {'PASS' if rv.get('verdict') == 'pass' else 'FAIL'} {rv.get('score')}/10"
              + (f" ({'; '.join(rv.get('defects') or [])})" if rv.get("defects") else "")) if rv.get("verdict") in ("pass", "fail") else "not judged"
    f = r.get("file") or {}
    return f"Done: {r.get('label')} landed as a new {r.get('kind')} take ({f.get('subfolder', '')}/{f.get('filename', '')}); {judged}." + (f" {r['note']}" if r.get("note") else ""), False


def call_tool(name: str, args: dict) -> tuple[str, bool]:
    args = dict(args or {})
    if name == "soundstage_state":
        r = http("GET", "/soundstage/director/state")
        if r.get("error"):
            return f"Error: {r['error']}", True
        if not r.get("connected"):
            return r.get("hint") or "No Soundstage App is open.", True
        return f"{r['summary']}\n(reported {r.get('age_s')} s ago)", False
    if name == "soundstage_direct":
        r = http("POST", "/soundstage/director/propose", {"command": args.get("command", "")})
        return _plan_text(r), bool(r.get("error"))
    if name == "soundstage_apply":
        r = http("POST", "/soundstage/director/apply", {"plan_id": args.get("plan_id"), "confirm_gpu": bool(args.get("confirm_gpu"))}, timeout=200)
        return _apply_text(r), bool(r.get("error"))
    if name == "soundstage_undo":
        r = http("POST", "/soundstage/director/undo", {})
        return ("Error: " + r["error"]) if r.get("error") else (f"Undid: {r.get('undid')}" if r.get("undid") else "Nothing to undo."), bool(r.get("error"))
    if name == "soundstage_judge_take":
        f = {"filename": args.get("filename", ""), "subfolder": args.get("subfolder", "soundstage"), "type": args.get("type", "output")}
        r = http("POST", "/soundstage/takecheck/realism", {"file": f, "force": bool(args.get("force"))}, timeout=900)
        return judge_text(r), r.get("verdict") not in ("pass", "fail")
    if name == "soundstage_one_click":
        return one_click(args)
    if name in ("soundstage_loop", "soundstage_reshoot", "soundstage_take_workflow"):
        return track_b(name, args)
    if name.startswith("ss_"):
        dry = args.pop("dry_run", True)
        confirm = bool(args.pop("confirm_gpu", False))
        r = http("POST", "/soundstage/director/propose", {"calls": [{"tool": name[3:], **args}]})
        if r.get("error") or dry is not False or not r.get("calls"):
            return _plan_text(r), bool(r.get("error"))
        a = http("POST", "/soundstage/director/apply", {"plan_id": r["plan_id"], "confirm_gpu": confirm}, timeout=200)
        return _apply_text(a), bool(a.get("error"))
    return f"Unknown tool {name}", True


def handle(msg: dict):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                "capabilities": {"tools": {}}, "serverInfo": {"name": "soundstage", "version": VERSION},
                "instructions": "Soundstage is a film set inside ComfyUI. Read soundstage_state, propose with soundstage_direct or the ss_* tools (dry runs), show the user the plan, then soundstage_apply. Ask before anything that renders on the GPU."}}
    if method in ("notifications/initialized", "initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": tools()}}
    if method == "tools/call":
        try:
            text, err = call_tool(params.get("name", ""), params.get("arguments") or {})
        except Exception as e:  # noqa: BLE001
            text, err = f"Error: {e}", True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": err}}
    if mid is None:
        return None
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        out = handle(msg)
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
