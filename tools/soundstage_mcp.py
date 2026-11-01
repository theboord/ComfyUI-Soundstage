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
]


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
