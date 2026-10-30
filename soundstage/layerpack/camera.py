"""Stage camera maths for the Layer Pack.

World convention (the three.js stage): right-handed, Y up, metres. A camera looks from
`position` at `target` with world +Y as up (no roll), and its lens is `focal_mm` on a
36 mm wide sensor, so fx (pixels) = focal_mm * W / 36 and fy = fx (square pixels).

Accepted camera JSON (whatever the stage or a user hands us):
  * the stage scene JSON: {"shot": {"frames", "fps"}, "camera": {...}, "camera_end": {...}}
    (expanded per frame with the stage's smoothstep ease, exactly like stage.mjs _cameraAt)
  * {"frames": [{"position", "target", "focal_mm"}, ...]}  (a per-frame list)
  * a bare list of those per-frame dicts
  * one {"position", "target", "focal_mm"} (a locked-off camera)
Optional keys anywhere at the top level: "sensor_width_mm", "width"/"height" or "frame": [W, H].
"""
from __future__ import annotations

import json
import math

import numpy as np

SENSOR_W_MM = 36.0
WORLD_UP = np.array([0.0, 1.0, 0.0])


def _smoothstep(t: float) -> float:
    return t * t * (3 - 2 * t)


def _cam(d: dict) -> dict:
    return {
        "position": [float(v) for v in d["position"]],
        "target": [float(v) for v in d["target"]],
        "focal_mm": float(d.get("focal_mm", 35.0)),
        "roll_deg": float(d.get("roll_deg", 0.0)),
    }


def parse_camera(camera, n_frames: int) -> tuple[list[dict], dict]:
    """Return (one camera dict per frame, extra info) for any accepted camera JSON."""
    if camera is None or camera == "":
        return [], {}
    if isinstance(camera, str):
        camera = json.loads(camera)
    info: dict = {}
    if isinstance(camera, dict):
        if "sensor_width_mm" in camera:
            info["sensor_width_mm"] = float(camera["sensor_width_mm"])
        if "frame" in camera:
            info["resolution"] = [int(v) for v in camera["frame"]]
        elif "width" in camera and "height" in camera:
            info["resolution"] = [int(camera["width"]), int(camera["height"])]
        if isinstance(camera.get("scene"), dict):  # whole stage payload
            camera = camera["scene"]
    if isinstance(camera, dict) and isinstance(camera.get("camera_track"), list) and camera["camera_track"]:
        # Multi-keyframe stage: the widget sends the exact per-frame camera.
        frames = [_cam(c) for c in camera["camera_track"]]
    elif isinstance(camera, list):
        frames = [_cam(c) for c in camera]
    elif "frames" in camera and isinstance(camera["frames"], list):
        frames = [_cam(c) for c in camera["frames"]]
    elif "camera" in camera:
        a = _cam(camera["camera"])
        b = _cam(camera.get("camera_end") or camera["camera"])
        # The stage eases over its own shot length; sample that, then fit to the pack length.
        stage_n = int((camera.get("shot") or {}).get("frames") or n_frames or 1)
        n = max(n_frames, 1)
        frames = []
        for i in range(n):
            t = 0.0 if stage_n < 2 else min(max(i / (stage_n - 1), 0.0), 1.0)
            e = _smoothstep(t)
            frames.append({
                "position": [p + (q - p) * e for p, q in zip(a["position"], b["position"])],
                "target": [p + (q - p) * e for p, q in zip(a["target"], b["target"])],
                "focal_mm": a["focal_mm"] + (b["focal_mm"] - a["focal_mm"]) * e,
                "roll_deg": a["roll_deg"] + (b["roll_deg"] - a["roll_deg"]) * e,
            })
    elif "position" in camera:
        frames = [_cam(camera)]
    else:
        raise ValueError("Camera JSON needs camera/camera_end, frames[], or position/target/focal_mm.")
    if not frames:
        return [], info
    # Fit the list to the pack length: hold the last pose, or trim.
    n = max(n_frames, 1)
    if len(frames) < n:
        frames = frames + [frames[-1]] * (n - len(frames))
    return frames[:n], info


def look_at(position, target, roll_deg: float = 0.0) -> np.ndarray:
    """Camera-to-world 4x4 (Y up, camera looks down its local -Z, +Y up, +X right)."""
    p = np.asarray(position, dtype=np.float64)
    f = np.asarray(target, dtype=np.float64) - p
    f /= np.linalg.norm(f) or 1.0
    right = np.cross(f, WORLD_UP)
    if np.linalg.norm(right) < 1e-8:  # looking straight up/down
        right = np.array([1.0, 0.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, f)
    if roll_deg:
        r = math.radians(roll_deg)
        right, up = right * math.cos(r) + up * math.sin(r), up * math.cos(r) - right * math.sin(r)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, up, -f, p
    return m


def fx_px(focal_mm: float, width: int, sensor_w: float = SENSOR_W_MM) -> float:
    return focal_mm * width / sensor_w


def fov_deg(focal_mm: float, width: int, height: int, sensor_w: float = SENSOR_W_MM) -> tuple[float, float]:
    fx = fx_px(focal_mm, width, sensor_w)
    return (math.degrees(2 * math.atan(width / (2 * fx))), math.degrees(2 * math.atan(height / (2 * fx))))


def euler_zxy_deg(m: np.ndarray) -> tuple[float, float, float]:
    """Nuke's default rot_order ZXY: R = Ry(ry) @ Rx(rx) @ Rz(rz). Returns (rx, ry, rz) in degrees."""
    r = m[:3, :3]
    rx = math.asin(max(-1.0, min(1.0, -r[1, 2])))
    if abs(math.cos(rx)) > 1e-6:
        ry = math.atan2(r[0, 2], r[2, 2])
        rz = math.atan2(r[1, 0], r[1, 1])
    else:  # gimbal: looking straight up/down
        ry = math.atan2(-r[2, 0], r[0, 0])
        rz = 0.0
    return math.degrees(rx), math.degrees(ry), math.degrees(rz)


def rot_zxy(rx: float, ry: float, rz: float) -> np.ndarray:
    a, b, c = (math.radians(v) for v in (rx, ry, rz))
    Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    Rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def unwrap(prev: float | None, angle: float) -> float:
    """Keep Euler keys continuous (no 179 -> -179 flips)."""
    if prev is None:
        return angle
    while angle - prev > 180:
        angle -= 360
    while angle - prev < -180:
        angle += 360
    return angle


def build_frames(cams: list[dict], width: int, height: int, frame_start: int,
                 sensor_w: float = SENSOR_W_MM) -> list[dict]:
    """Everything every exporter needs, per frame."""
    out, prev = [], (None, None, None)
    for i, c in enumerate(cams):
        m = look_at(c["position"], c["target"], c.get("roll_deg", 0.0))
        rx, ry, rz = euler_zxy_deg(m)
        rx, ry, rz = unwrap(prev[0], rx), unwrap(prev[1], ry), unwrap(prev[2], rz)
        prev = (rx, ry, rz)
        hfov, vfov = fov_deg(c["focal_mm"], width, height, sensor_w)
        out.append({
            "frame": frame_start + i,
            "position": [round(v, 6) for v in c["position"]],
            "target": [round(v, 6) for v in c["target"]],
            "focal_mm": round(c["focal_mm"], 6),
            "fx_px": round(fx_px(c["focal_mm"], width, sensor_w), 6),
            "hfov_deg": round(hfov, 6),
            "vfov_deg": round(vfov, 6),
            "rotate_zxy_deg": [round(rx, 6), round(ry, 6), round(rz, 6)],
            "cam_to_world": [[round(float(v), 9) for v in row] for row in m],
        })
    return out
