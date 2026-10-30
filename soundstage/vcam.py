"""Virtual camera relay: a phone / tablet / headset streams its pose into Soundstage.

Call `register()` once at import time (from the pack's __init__) to add the routes:

GET  /soundstage/vcam                 -> device page (web/vcam/index.html)
GET  /soundstage/vcam/<name>.mjs      -> its modules (web/vcam/*.mjs, web/movefit/stabilize.mjs)
GET  /soundstage/vcam/ws              -> WebSocket; the device sends {"type": "pose" | "state" | "ping", ...}
POST /soundstage/vcam/pose            -> same messages over plain HTTP (fallback when WebSockets are blocked)
POST /soundstage/vcam/take            -> store a recorded take {name?, device?, mode?, settings?, samples:[...]} -> {id, ...}
GET  /soundstage/vcam/takes           -> [{id, name, created, duration, samples, mode, settings}], newest first
GET  /soundstage/vcam/take?id=...     -> one take (full JSON)
GET  /soundstage/vcam/status          -> {devices: [{device, mode, age_s, recording}]}

Every pose / state / saved take is re-broadcast to all ComfyUI browser tabs with
PromptServer.instance.send_sync("soundstage.vcam", payload) for live preview; see docs/vcam.md.
Takes are JSON files in <ComfyUI user dir>/soundstage/takes/.
"""
import json
import math
import os
import re
import time
import uuid

EVENT = "soundstage.vcam"
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
MODULES = {  # served module name -> file (whitelist; nothing else under web/ is reachable here)
    "device.mjs": os.path.join(WEB_DIR, "vcam", "device.mjs"),
    "stabilize.mjs": os.path.join(WEB_DIR, "movefit", "stabilize.mjs"),
}
MAX_SAMPLES = 200_000          # ~55 min at 60 Hz
BROADCAST_INTERVAL = 1 / 40    # per device; devices send ~30 Hz
SETTING_KEYS = {"strength": (0.0, 1.0), "keepHandheld": (0.0, 1.0), "scale": (0.01, 100.0), "focal_mm": (4.0, 600.0)}
TAKE_ID = re.compile(r"^[0-9]{8}-[0-9]{6}(-[0-9]+)?_[a-z0-9_]{1,60}$")

_devices = {}   # device id -> {"mode", "last", "recording", "last_sent"}


# ---------------------------------------------------------------- pure helpers (no ComfyUI imports; unit-tested)

def _vec(v, n, limit=1e4):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        return None
    try:
        out = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(x) and abs(x) <= limit for x in out):
        return None
    return out


def _quat(v):
    q = _vec(v, 4, 2.0)
    if q is None:
        return None
    n = math.sqrt(sum(x * x for x in q))
    if n < 1e-6:
        return None
    return [x / n for x in q]


def clean_settings(s):
    out = {}
    if not isinstance(s, dict):
        return out
    for k, (lo, hi) in SETTING_KEYS.items():
        try:
            v = float(s[k])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(v):
            out[k] = min(hi, max(lo, v))
    if "horizonLock" in s:
        out["horizonLock"] = bool(s["horizonLock"])
    return out


def clean_sample(s):
    """{t, position, quaternion, focal_mm?} with finite numbers, or None."""
    if not isinstance(s, dict):
        return None
    try:
        t = float(s.get("t"))
    except (TypeError, ValueError):
        return None
    p, q = _vec(s.get("position"), 3), _quat(s.get("quaternion"))
    if not math.isfinite(t) or p is None or q is None:
        return None
    out = {"t": round(t, 5), "position": [round(x, 5) for x in p], "quaternion": [round(x, 6) for x in q]}
    f = s.get("focal_mm")
    if isinstance(f, (int, float)) and math.isfinite(f) and 4 <= f <= 600:
        out["focal_mm"] = float(f)
    return out


def clean_device(d):
    d = re.sub(r"[^A-Za-z0-9_.-]", "", str(d or "")).lstrip(".")[:40]
    return d or "device"


def pose_payload(msg, device):
    """Validate a device message and build the broadcast payload (None = ignore)."""
    if not isinstance(msg, dict):
        return None
    kind = msg.get("type", "pose")
    mode = str(msg.get("mode", ""))[:12]
    base = {"type": kind, "device": device, "mode": mode, "recording": bool(msg.get("recording")),
            "settings": clean_settings(msg.get("settings")), "server_time": time.time()}
    if kind == "pose":
        s = clean_sample(msg)
        if s is None:
            return None
        base.update(s)
        return base
    if kind == "state":
        base["event"] = str(msg.get("event", ""))[:24]  # e.g. "record", "stop", "connected", "recenter"
        return base
    return None


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")[:60] or "take"


def takes_dir(base=None):
    if base is None:
        try:
            import folder_paths
            base = folder_paths.get_user_directory()
        except Exception:
            base = os.path.join(os.path.dirname(__file__), "..", ".cache")
    path = os.path.join(base, "soundstage", "takes")
    os.makedirs(path, exist_ok=True)
    return path


def build_take(body):
    """Validate an uploaded take. Returns (take_dict, error)."""
    if not isinstance(body, dict):
        return None, "take must be a JSON object"
    raw = body.get("samples")
    if not isinstance(raw, list) or not raw:
        return None, "take has no samples"
    if len(raw) > MAX_SAMPLES:
        return None, f"take too long (max {MAX_SAMPLES} samples)"
    samples = [s for s in (clean_sample(x) for x in raw) if s is not None]
    if len(samples) < 2:
        return None, "take has fewer than 2 valid samples"
    samples.sort(key=lambda s: s["t"])
    t0 = samples[0]["t"]
    for s in samples:
        s["t"] = round(s["t"] - t0, 5)
    name = str(body.get("name") or "").strip()[:80]
    return {
        "version": 1,
        "name": name or "take",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "device": clean_device(body.get("device")),
        "mode": str(body.get("mode", ""))[:12],
        "settings": clean_settings(body.get("settings")),
        "duration": samples[-1]["t"],
        "samples": samples,
    }, None


def save_take(take, base=None):
    folder = takes_dir(base)
    stem = time.strftime("%Y%m%d-%H%M%S") + "_" + slug(take["name"])
    tid, n = stem, 1
    while os.path.exists(os.path.join(folder, tid + ".json")):
        n += 1
        tid = stem.replace("_", f"-{n}_", 1)
    take = dict(take, id=tid)
    tmp = os.path.join(folder, tid + ".json.tmp")
    with open(tmp, "w") as f:
        json.dump(take, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(folder, tid + ".json"))
    return take


def load_take(tid, base=None):
    if not isinstance(tid, str) or not TAKE_ID.match(tid):
        return None
    path = os.path.join(takes_dir(base), tid + ".json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def take_summary(take):
    return {k: take.get(k) for k in ("id", "name", "created", "duration", "device", "mode", "settings")} | {
        "samples": len(take.get("samples") or [])}


def list_takes(base=None, limit=200):
    folder = takes_dir(base)
    out = []
    for fn in sorted(os.listdir(folder), reverse=True):
        if not fn.endswith(".json") or not TAKE_ID.match(fn[:-5]):
            continue
        try:
            with open(os.path.join(folder, fn)) as f:
                out.append(take_summary(json.load(f)))
        except (OSError, ValueError):
            continue
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- routes

_registered = False


def register():
    """Add the /soundstage/vcam routes to ComfyUI's PromptServer (idempotent)."""
    global _registered
    if _registered:
        return
    _registered = True
    from aiohttp import web, WSMsgType
    from server import PromptServer

    server = PromptServer.instance
    routes = server.routes

    def broadcast(payload, force=False):
        dev = _devices.setdefault(payload["device"], {"last_sent": 0.0})
        dev.update(mode=payload.get("mode"), last=time.time(), recording=payload.get("recording", False))
        now = time.monotonic()
        if not force and payload["type"] == "pose" and now - dev["last_sent"] < BROADCAST_INTERVAL:
            return
        dev["last_sent"] = now
        server.send_sync(EVENT, payload)

    def handle(msg, device):
        payload = pose_payload(msg, device)
        if payload is not None:
            broadcast(payload, force=payload["type"] != "pose")

    @routes.get("/soundstage/vcam")
    async def vcam_page(request):
        resp = web.FileResponse(os.path.join(WEB_DIR, "vcam", "index.html"))
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @routes.get("/soundstage/vcam/ws")
    async def vcam_ws(request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
        await ws.prepare(request)
        device = clean_device(request.query.get("device") or uuid.uuid4().hex[:8])
        await ws.send_json({"type": "hello", "device": device})
        handle({"type": "state", "event": "connected"}, device)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(data, dict) and data.get("type") == "ping":
                    await ws.send_json({"type": "pong", "c": data.get("c")})
                    continue
                handle(data, device)
        finally:
            handle({"type": "state", "event": "disconnected"}, device)
            _devices.pop(device, None)
        return ws

    @routes.post("/soundstage/vcam/pose")
    async def vcam_pose(request):
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"error": "bad json"}, status=400)
        device = clean_device(request.query.get("device") or (data.get("device") if isinstance(data, dict) else None))
        for m in data if isinstance(data, list) else [data]:
            handle(m, device)
        return web.json_response({"ok": True})

    @routes.post("/soundstage/vcam/take")
    async def vcam_take_post(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "bad json"}, status=400)
        take, err = build_take(body)
        if err:
            return web.json_response({"error": err}, status=422)
        take = save_take(take)
        summary = take_summary(take)
        server.send_sync(EVENT, {"type": "take", "device": take["device"], **summary})
        return web.json_response(summary)

    @routes.get("/soundstage/vcam/takes")
    async def vcam_takes(request):
        return web.json_response(list_takes())

    @routes.get("/soundstage/vcam/take")
    async def vcam_take_get(request):
        take = load_take(request.query.get("id", ""))
        if take is None:
            return web.json_response({"error": "no such take"}, status=404)
        return web.json_response(take)

    @routes.get("/soundstage/vcam/status")
    async def vcam_status(request):
        now = time.time()
        return web.json_response({"devices": [
            {"device": d, "mode": v.get("mode"), "age_s": round(now - v.get("last", now), 2), "recording": v.get("recording", False)}
            for d, v in _devices.items()]})

    @routes.get(r"/soundstage/vcam/{name:[a-z_]+\.mjs}")
    async def vcam_module(request):
        path = MODULES.get(request.match_info["name"])
        if not path or not os.path.isfile(path):
            raise web.HTTPNotFound()
        resp = web.FileResponse(path)
        resp.headers["Content-Type"] = "text/javascript; charset=utf-8"
        resp.headers["Cache-Control"] = "no-cache"
        return resp
