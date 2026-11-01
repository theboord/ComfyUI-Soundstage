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

Phone viewfinder (web/vcam/viewfinder.*, docs/vcam.md "Phone viewfinder"): the phone renders the stage itself.
GET  /soundstage/vcam/viewfinder      -> the viewfinder page (its modules load from /extensions/<pack>/)
POST /soundstage/vcam/scene           -> the desktop publishes {scene, sync?}; pushed to every connected device
POST /soundstage/vcam/sync            -> the desktop's playhead / view / take status, pushed to the devices
GET|POST /soundstage/vcam/pair        -> the phone-facing URL a LAN bridge (tools/vcam_bridge.py) registered, for the QR

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
SETTING_KEYS = {"strength": (0.0, 1.0), "keepHandheld": (0.0, 1.0), "scale": (0.01, 100.0), "focal_mm": (4.0, 600.0),
                "startFrame": (0.0, 1e6), "lastFrame": (0.0, 1e6), "fps": (1.0, 240.0)}
LENS_KEYS = {"focal_mm": (4.0, 600.0), "focus_m": (0.05, 1000.0), "t_stop": (0.5, 64.0), "roll": (-math.pi, math.pi)}
MAX_SCENE_BYTES = 24 << 20
PAIR_URL = re.compile(r"^https?://[^\s\"'<>\\]{1,400}$")
PAIR_TTL = 180                 # seconds a bridge's registration stays valid (it re-registers every 30 s)
TAKE_ID = re.compile(r"^[0-9]{8}-[0-9]{6}(-[0-9]+)?_[a-z0-9_]{1,60}$")

_devices = {}   # device id -> {"mode", "last", "recording", "last_sent"}
_sockets = {}   # device id -> its WebSocket (server -> device pushes: scene, sync)
_scene = {}     # the last scene a desktop published: {"rev", "scene", "sync", "at"}
_pair = {}      # {"url", "at"} from the LAN bridge


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
    for k in ("horizonLock", "stabilize"):
        if k in s:
            out[k] = bool(s[k])
    if s.get("space") in ("hand", "set"):
        out["space"] = s["space"]
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
    for k in ("focal_mm", "focus_m", "t_stop"):
        v = _num(s.get(k), *LENS_KEYS[k])
        if v is not None:
            out[k] = round(v, 4)
    return out


def _num(v, lo, hi):
    """A finite number inside [lo, hi], else None (no clamping: out of range = not sent)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        return None
    return float(v)


def clean_flat(d, depth=1):
    """A small JSON object of scalars (and, with depth, one level of nested objects), for event data / sync fields."""
    out = {}
    if not isinstance(d, dict):
        return out
    for k, v in list(d.items())[:24]:
        k = re.sub(r"[^A-Za-z0-9_]", "", str(k))[:24]
        if not k:
            continue
        if isinstance(v, bool) or v is None:
            out[k] = v
        elif isinstance(v, (int, float)):
            if math.isfinite(v) and abs(v) <= 1e9:
                out[k] = v
        elif isinstance(v, str):
            out[k] = v[:200]
        elif isinstance(v, dict) and depth > 0:
            out[k] = clean_flat(v, depth - 1)
    return out


def clean_cam(c):
    """The viewfinder's set-space camera: {position, target, focal_mm, focus_m?, t_stop?, roll?}, or None."""
    if not isinstance(c, dict):
        return None
    p, t = _vec(c.get("position"), 3), _vec(c.get("target"), 3)
    f = _num(c.get("focal_mm"), *LENS_KEYS["focal_mm"])
    if p is None or t is None or f is None:
        return None
    out = {"position": p, "target": t, "focal_mm": f}
    for k in ("focus_m", "t_stop", "roll"):
        v = _num(c.get(k), *LENS_KEYS[k])
        if v is not None:
            out[k] = v
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
    if kind == "vf":       # the phone viewfinder's live camera (already on the set) + where it is in the shot
        cam = clean_cam(msg.get("cam"))
        if cam is None:
            return None
        base.update(cam=cam, mode="viewfinder", frame=_num(msg.get("frame"), 0, 1e6) or 0.0,
                    t=_num(msg.get("t"), -1e9, 1e9) or 0.0, view=str(msg.get("view", ""))[:12])
        return base
    if kind == "vfstate":  # hello, record, stop, keep, discard, bye
        base.update(mode="viewfinder", event=str(msg.get("event", ""))[:24], data=clean_flat(msg.get("data")))
        return base
    return None


def clean_sync(d):
    """The desktop's playhead and status for the phones: {frame, playing, view, fps, frames, take: {...}, ...}."""
    return clean_flat(d, 1)


def pair_info(now=None):
    now = time.time() if now is None else now
    if _pair.get("url") and now - _pair.get("at", 0) <= PAIR_TTL:
        return {"url": _pair["url"], "age_s": round(now - _pair["at"], 1)}
    return {}


def set_pair(url, now=None):
    if not isinstance(url, str) or not PAIR_URL.match(url):
        return False
    _pair.update(url=url, at=time.time() if now is None else now)
    return True


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
            broadcast(payload, force=payload["type"] not in ("pose", "vf"))

    async def push(payload):
        """Server -> every connected device (the viewfinders follow the desktop's scene and playhead)."""
        for dev, ws in list(_sockets.items()):
            if ws.closed:
                _sockets.pop(dev, None)
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                _sockets.pop(dev, None)

    pack = os.path.basename(os.path.dirname(WEB_DIR))

    @routes.get("/soundstage/vcam/viewfinder")
    async def vcam_viewfinder(request):
        with open(os.path.join(WEB_DIR, "vcam", "viewfinder.html"), encoding="utf-8") as f:
            html = f.read().replace("{{BASE}}", f"/extensions/{pack}")
        return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-cache"})

    @routes.post("/soundstage/vcam/scene")
    async def vcam_scene(request):
        raw = await request.read()
        if len(raw) > MAX_SCENE_BYTES:
            return web.json_response({"error": "scene too large"}, status=413)
        try:
            body = json.loads(raw)
        except ValueError:
            return web.json_response({"error": "bad json"}, status=400)
        scene = body.get("scene") if isinstance(body, dict) else None
        if not isinstance(scene, dict):
            return web.json_response({"error": "no scene"}, status=422)
        _scene.update(rev=_scene.get("rev", 0) + 1, scene=scene, sync=clean_sync(body.get("sync")), at=time.time())
        await push({"type": "scene", "rev": _scene["rev"], "scene": scene, "sync": _scene["sync"]})
        return web.json_response({"ok": True, "rev": _scene["rev"], "devices": len(_sockets)})

    @routes.post("/soundstage/vcam/sync")
    async def vcam_sync(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "bad json"}, status=400)
        sync = clean_sync(body)
        if _scene:
            _scene["sync"] = {**(_scene.get("sync") or {}), **{k: v for k, v in sync.items() if k != "take"}}
        await push({"type": "sync", **sync})
        return web.json_response({"ok": True, "devices": len(_sockets)})

    @routes.get("/soundstage/vcam/pair")
    async def vcam_pair_get(request):
        return web.json_response(pair_info())

    @routes.post("/soundstage/vcam/pair")
    async def vcam_pair_post(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "bad json"}, status=400)
        if not set_pair(body.get("url") if isinstance(body, dict) else None):
            return web.json_response({"error": "bad url"}, status=422)
        return web.json_response({"ok": True})

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
        old = _sockets.get(device)
        _sockets[device] = ws
        if old is not None and old is not ws and not old.closed:
            await old.close()          # the same phone reconnected (a reload): the new socket wins
        if _scene.get("scene") is not None:
            await ws.send_json({"type": "scene", "rev": _scene["rev"], "scene": _scene["scene"], "sync": _scene.get("sync") or {}})
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
            if _sockets.get(device) is ws:
                _sockets.pop(device, None)
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
