#!/usr/bin/env python3
"""Physics benchmark scenes, engine-neutral (Soundstage XPBD vs Blender Bullet, later Houdini).

Writes scenes.json next to this file. Every engine runner reads that file, so the scenes are identical everywhere.
Units: metres, kilograms, seconds; y is up; 24 fps. Frame 0 is the start pose.

Body fields:
  id, type: "dynamic" | "static" | "kinematic", size [x, y, z] (full box extents), mass, friction, restitution,
  pos [x, y, z] (box centre at frame 0), quat [x, y, z, w],
  keys: per-frame centre positions for frames 0..release (kinematic: every frame; a "launched" dynamic body
        follows its keys until `release`, then it is let go with the speed the keys gave it).

Materials are the EFFECTIVE pair values (what a contact actually uses). Soundstage combines friction as the geometric
mean and restitution as the max; Bullet (Blender) multiplies both. The runners convert (see each runner).
"""
import json, math, os

FPS = 24
G = 9.81
GROUND = {"friction": 0.8, "restitution": 0.0}   # Soundstage's built-in floor (physics.mjs GROUND)


def box(id, size, pos, mass=25.0, friction=0.6, restitution=0.2, type="dynamic", quat=(0, 0, 0, 1), **kw):
    return {"id": id, "type": type, "size": list(size), "mass": mass, "friction": friction, "restitution": restitution,
            "pos": [round(v, 6) for v in pos], "quat": list(quat), **kw}


def scene_drop():
    frames = 4 * FPS
    return {"name": "s1_drop", "title": "Single box dropped 2 m", "frames": frames, "gravity": G, "ground": GROUND,
            "bodies": [box("crate", (0.8, 0.8, 0.8), (0, 2.0 + 0.4, 0))],
            "camera": {"pos": [4.2, 2.0, 6.2], "target": [0, 1.0, 0], "fov": 40},
            "hit_frame": 0}


def scene_tower():
    hit = 3 * FPS                      # left alone for 3 s
    frames = hit + 5 * FPS
    bodies = [box(f"carton{i:02d}", (0.5, 0.5, 0.5), (0, 0.25 + 0.5 * i, 0), mass=2.0, friction=0.6, restitution=0.2)
              for i in range(20)]
    # The 25 kg crate: at rest 0.05 m short of the tower base... keyed back 2 frames at 4 m/s, released at `hit`,
    # so it reaches the bottom carton moving at 4 m/s.
    v = 4.0
    x_rel = -(0.25 + 0.4 + 0.02)       # crate centre at release: 2 cm gap to the bottom carton
    keys = []
    for f in range(hit + 1):
        t_to = (hit - f) / FPS
        keys.append([round(x_rel - v * min(t_to, 2 / FPS), 6), 0.4, 0.0])
    bodies.append(box("hitter", (0.8, 0.8, 0.8), keys[0], mass=25.0, friction=0.6, restitution=0.2,
                      keys=keys, release=hit))
    return {"name": "s2_tower", "title": "20-box tower, hit at 3 s by a 25 kg crate at 4 m/s", "frames": frames,
            "gravity": G, "ground": GROUND, "bodies": bodies,
            "camera": {"pos": [11.0, 5.5, 16.0], "target": [1.5, 4.0, 0], "fov": 40},
            "hit_frame": hit}


def scene_pyramid():
    frames = 6 * FPS
    s = 0.8
    bodies = []
    n = 0
    for layer, count in enumerate([4, 3, 2, 1]):
        for k in range(count):
            x = (k - (count - 1) / 2) * s
            bodies.append(box(f"crate{n:02d}", (s, s, s), (x, s / 2 + layer * s, 0), mass=25.0, friction=0.6, restitution=0.2))
            n += 1
    # Kinematic car: 1.9 wide, 1.4 tall, 4.5 long, driving +z at 12 m/s; it brakes at 7 m/s^2 from the moment its
    # nose reaches the pyramid's front face, and stops.
    L, v0, dec = 4.5, 12.0, 7.0
    z0 = -8.0
    z_contact = -s / 2 - L / 2        # car centre when the nose touches the front face
    t_c = (z_contact - z0) / v0
    keys = []
    for f in range(frames):
        t = f / FPS
        if t <= t_c:
            z = z0 + v0 * t
        else:
            tb = min(t - t_c, v0 / dec)
            z = z_contact + v0 * tb - 0.5 * dec * tb * tb
        keys.append([0.0, 0.72, round(z, 6)])
    bodies.append(box("car", (1.9, 1.4, 4.5), keys[0], mass=1500.0, friction=0.6, restitution=0.2, type="kinematic", keys=keys))
    return {"name": "s3_pyramid", "title": "10-crate pyramid hit by a braking kinematic car at 12 m/s", "frames": frames,
            "gravity": G, "ground": GROUND, "bodies": bodies,
            "camera": {"pos": [15.0, 7.0, -5.0], "target": [0, 0.8, 5.5], "fov": 40},
            "hit_frame": round(t_c * FPS), "car_contact_time": t_c}


def scene_ramp():
    frames = 5 * FPS
    th = math.radians(30)
    mu = 0.5
    # Ramp rotated -30 deg about z: its top face points (sin, cos, 0); downhill is (cos, -sin, 0).
    q = [0.0, 0.0, math.sin(-th / 2), math.cos(-th / 2)]
    n = [math.sin(th), math.cos(th), 0.0]
    d = [math.cos(th), -math.sin(th), 0.0]
    C = [0.0, 1.9, 0.0]
    ramp = box("ramp", (7.0, 0.2, 2.0), C, mass=1.0, friction=mu, restitution=0.0, type="static", quat=q)
    S = [C[i] + 0.1 * n[i] for i in range(3)]                    # top-face centre
    start = -2.6                                                  # along downhill from the face centre
    B = [S[i] + start * d[i] + 0.25 * n[i] for i in range(3)]
    slider = box("slider", (0.5, 0.5, 0.5), B, mass=2.0, friction=mu, restitution=0.0, quat=q)
    a = G * (math.sin(th) - mu * math.cos(th))
    return {"name": "s4_ramp", "title": "Box sliding down a 30 deg ramp, friction 0.5", "frames": frames, "gravity": G,
            "ground": GROUND, "bodies": [ramp, slider],
            "camera": {"pos": [0.5, 2.6, 9.5], "target": [0.3, 1.4, 0], "fov": 40},
            "hit_frame": 0,
            "analytic": {"theta_deg": 30, "mu": mu, "accel": a, "downhill": d, "normal": n, "start": B,
                         "ramp_len": 3.5 - start - 0.25}}


def build():
    return {"fps": FPS, "version": 1, "scenes": [scene_drop(), scene_tower(), scene_pyramid(), scene_ramp()]}


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenes.json")
    with open(out, "w") as f:
        json.dump(build(), f, indent=1)
    print("wrote", out)
