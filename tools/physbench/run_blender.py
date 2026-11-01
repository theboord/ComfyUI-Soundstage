"""Run the physics benchmark scenes through Blender's rigid-body world (Bullet) and write per-frame poses.

Headless:
  Blender --background --factory-startup --python run_blender.py -- \
      --scenes scenes.json --out out/bl_default.json [--substeps 10] [--iterations 10] [--damping default|matched]
      [--label bl_default] [--scene s1_drop,...]

Blender is z-up; the scenes are y-up (Soundstage / three.js). Positions map (x, y, z) -> (x, -z, y) and back.
Materials: scenes.json holds the EFFECTIVE pair values. Bullet multiplies friction and restitution of the two bodies,
so each body gets friction sqrt(mu) (pair = sqrt(mu_a * mu_b), the same geometric mean Soundstage uses), the floor
sqrt(0.8); the floor, static and kinematic bodies get restitution 1.0 so a dynamic body's restitution is its contact
restitution against them. Dynamic-dynamic contacts still get e_a * e_b (0.04 for two 0.2 crates; Soundstage: 0.2).
Damping "matched" converts Soundstage's per-second drag (v *= 1 - 0.02 h, w *= 1 - 0.6 h) to Bullet's
(v *= (1 - d)^h): linear 1 - e^-0.02, angular 1 - e^-0.6. "default" keeps Blender's 0.04 / 0.1.
"""
import bpy, json, math, sys, time, os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = {}
for i, a in enumerate(argv):
    if a.startswith("--"):
        args[a[2:]] = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else "1"
here = os.path.dirname(os.path.abspath(__file__))
scenes = json.load(open(args.get("scenes", os.path.join(here, "scenes.json"))))
SUB = int(args.get("substeps", 10))
ITER = int(args.get("iterations", 10))
DAMP = args.get("damping", "default")
label = args.get("label", f"bl_sub{SUB}_it{ITER}_{DAMP}")
only = set(args["scene"].split(",")) if "scene" in args else None
out_path = args.get("out", os.path.join(here, "out", label + ".json"))

bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"


def to_bl(p):
    return (p[0], -p[2], p[1])


def from_bl(p):
    return [p[0], p[2], -p[1]]


def q_to_bl(q):   # scene [x, y, z, w] -> Blender (w, x, y, z)
    return (q[3], q[0], -q[2], q[1])


def q_from_bl(q):  # Blender (w, x, y, z) -> scene [x, y, z, w]
    return [q[1], q[3], -q[2], q[0]]


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)
    sc = bpy.context.scene
    if sc.rigidbody_world:
        bpy.ops.rigidbody.world_remove()


def make_box(name, size, pos, quat):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.location = to_bl(pos)
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = q_to_bl(quat)
    return o


def build(sc):
    clear()
    s = bpy.context.scene
    s.render.fps = scenes["fps"]
    s.render.fps_base = 1.0
    s.frame_start, s.frame_end = 1, sc["frames"]
    s.gravity = (0, 0, -sc["gravity"])
    bpy.ops.rigidbody.world_add()
    w = s.rigidbody_world
    w.substeps_per_frame = SUB
    w.solver_iterations = ITER
    w.point_cache.frame_start, w.point_cache.frame_end = 1, sc["frames"]
    w.time_scale = 1.0
    # Ground: a thick passive slab whose top face is y = 0.
    g = make_box("__ground", (200, 2, 200), (0, -1, 0), (0, 0, 0, 1))
    bpy.ops.rigidbody.object_add(type="PASSIVE")
    g.rigid_body.collision_shape = "BOX"
    g.rigid_body.friction = math.sqrt(sc["ground"]["friction"])
    g.rigid_body.restitution = 1.0
    objs = {}
    for b in sc["bodies"]:
        o = make_box(b["id"], b["size"], b["pos"], b["quat"])
        typ = "PASSIVE" if b["type"] in ("static", "kinematic") else "ACTIVE"
        bpy.ops.rigidbody.object_add(type=typ)
        rb = o.rigid_body
        rb.collision_shape = "BOX"
        rb.mass = b["mass"]
        rb.friction = math.sqrt(b["friction"])
        rb.restitution = b["restitution"] if b["type"] == "dynamic" else 1.0
        if DAMP == "matched":
            rb.linear_damping = 1 - math.exp(-0.02)
            rb.angular_damping = 1 - math.exp(-0.6)
        keys = b.get("keys")
        if keys:
            last = len(keys) - 1 if b["type"] == "dynamic" else sc["frames"] - 1
            rb.kinematic = True
            for f in range(last + 1):
                o.location = to_bl(keys[min(f, len(keys) - 1)])
                o.keyframe_insert("location", frame=f + 1)
            o.keyframe_insert("rigid_body.kinematic", frame=1)
            if b["type"] == "dynamic":   # released at frame `release` (scene frame) = Blender frame release + 1
                o.keyframe_insert("rigid_body.kinematic", frame=last + 1)
                rb.kinematic = False
                o.keyframe_insert("rigid_body.kinematic", frame=last + 2)
        objs[b["id"]] = o
    return objs


out = {"engine": "blender-bullet", "label": label, "blender": bpy.app.version_string,
       "settings": {"substeps": SUB, "iterations": ITER, "damping": DAMP}, "fps": scenes["fps"], "scenes": {}}
for sc in scenes["scenes"]:
    if only and sc["name"] not in only:
        continue
    objs = build(sc)
    s = bpy.context.scene
    tracks = {k: [] for k in objs}
    t0 = time.perf_counter()
    for f in range(1, sc["frames"] + 1):
        s.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        for k, o in objs.items():
            m = o.evaluated_get(dg).matrix_world
            p = from_bl(m.to_translation())
            q = q_from_bl(m.to_quaternion())
            tracks[k].append([round(v, 6) for v in p + q])
    ms = (time.perf_counter() - t0) * 1000
    out["scenes"][sc["name"]] = {"frames": sc["frames"], "ms": round(ms, 1), "tracks": tracks}
    print(f"{label} {sc['name']}: {sc['frames']} frames, {ms:.0f} ms", flush=True)

os.makedirs(os.path.dirname(out_path), exist_ok=True)
json.dump(out, open(out_path, "w"))
print("wrote", out_path, flush=True)
