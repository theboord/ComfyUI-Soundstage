# Headless Blender: export the open scene as GLB / FBX / USD / Alembic, write ground truth, render reference masks.
#   Blender -b <file.blend> --python bl_export.py -- <outdir> [--scene NAME] [--hide REGEX] [--frames 1,24] [--res 1024x576]
import bpy, json, os, re, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
out = os.path.abspath(argv[0]); os.makedirs(out, exist_ok=True)
opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
if opt("--scene"):
    bpy.context.window.scene = bpy.data.scenes[opt("--scene")]
sc = bpy.context.scene
hide = re.compile(opt("--hide")) if opt("--hide") else None
frames = [int(x) for x in opt("--frames", "").split(",") if x]
rx, ry = [int(v) for v in opt("--res", "1024x576").split("x")]

# Make the scene's own render size the stage's (the glTF yfov is written from it).
native = (sc.render.resolution_x, sc.render.resolution_y, sc.render.pixel_aspect_x)
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = rx, ry, 100

dg = bpy.context.evaluated_depsgraph_get()
yup = lambda v: [v[0], v[2], -v[1]]   # Blender Z-up -> glTF Y-up


def bbox_all():
    lo, hi, n, tris, mats = [1e9] * 3, [-1e9] * 3, 0, 0, set()
    for inst in dg.object_instances:
        o = inst.object
        if o.type != "MESH":
            continue
        orig = inst.instance_object if inst.is_instance else o.original
        if orig.hide_render:
            continue
        m = inst.matrix_world
        me = o.data
        n += 1
        tris += sum(len(p.vertices) - 2 for p in me.polygons)
        for s in o.material_slots:
            if s.material: mats.add(s.material.name)
        for c in o.bound_box:
            p = yup(m @ Vector(c))
            for i in range(3):
                lo[i] = min(lo[i], p[i]); hi[i] = max(hi[i], p[i])
    return {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)], "mesh_instances": n, "tris": tris, "materials": sorted(mats)}


cam = sc.camera
truth = {"blend": bpy.data.filepath, "scene": sc.name, "fps": sc.render.fps / sc.render.fps_base, "frame_range": [sc.frame_start, sc.frame_end],
         "native_resolution": native, "export_resolution": [rx, ry], "unit_scale": sc.unit_settings.scale_length,
         "bbox_yup_m": bbox_all(),
         "lights": [{"name": o.name, "type": o.data.type, "energy": o.data.energy, "color": list(o.data.color), "pos_yup": yup(o.matrix_world.translation)}
                    for o in sc.objects if o.type == "LIGHT"],
         "cameras": []}
for o in sc.objects:
    if o.type != "CAMERA":
        continue
    c = {"name": o.name, "lens_mm": o.data.lens, "sensor_w": o.data.sensor_width, "sensor_fit": o.data.sensor_fit, "keys": []}
    for f in (frames or [sc.frame_start]):
        sc.frame_set(f)
        mw = o.matrix_world
        fwd = mw.to_3x3() @ Vector((0, 0, -1))
        c["keys"].append({"frame": f, "pos_yup": yup(mw.translation), "fwd_yup": yup(fwd), "lens_mm": o.data.lens})
    truth["cameras"].append(c)
sc.frame_set(sc.frame_start)
truth["animated_objects"] = sorted(o.name for o in sc.objects if o.animation_data and o.animation_data.action and o.type != "CAMERA")

# ---- exports
res = {}
def run(name, fn):
    try:
        fn(); res[name] = os.path.getsize(os.path.join(out, name))
    except Exception as e:
        res[name] = f"FAILED: {e}"
    print("EXPORT", name, res[name])

run("world.glb", lambda: bpy.ops.export_scene.gltf(filepath=os.path.join(out, "world.glb"), export_format="GLB", export_yup=True, export_cameras=True,
                                                    export_lights=True, export_animations=True, export_apply=True, use_visible=False))
run("world.fbx", lambda: bpy.ops.export_scene.fbx(filepath=os.path.join(out, "world.fbx"), bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, apply_scale_options="FBX_SCALE_ALL",
                                                   object_types={"MESH", "CAMERA", "LIGHT", "EMPTY", "ARMATURE", "OTHER"}, path_mode="COPY", embed_textures=True))
run("world.usdc", lambda: bpy.ops.wm.usd_export(filepath=os.path.join(out, "world.usdc"), export_animation=True, export_materials=True))
run("world.abc", lambda: bpy.ops.wm.alembic_export(filepath=os.path.join(out, "world.abc"), start=sc.frame_start, end=min(sc.frame_end, sc.frame_start + 96)))
truth["exports"] = res

# ---- reference renders through the scene camera (transparent, shell hidden)
if frames and cam:
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "MATERIAL"
    hidden = []
    if hide:
        for o in sc.objects:
            chain, a = [], o
            while a: chain.append(a.name); a = a.parent
            if any(hide.search(n) for n in chain) and not o.hide_render:
                o.hide_render = True; hidden.append(o.name)
    truth["hidden_for_masks"] = hidden
    for f in frames:
        sc.frame_set(f)
        for tr, nm in ((True, f"bl_mask_{f}.png"), (False, f"bl_look_{f}.png")):
            sc.render.film_transparent = tr
            sc.render.image_settings.color_mode = "RGBA" if tr else "RGB"
            sc.render.filepath = os.path.join(out, nm)
            bpy.ops.render.render(write_still=True)
    for n in hidden:
        sc.objects[n].hide_render = False

json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=1)
print("TRUTH", json.dumps({k: truth[k] for k in ("fps", "export_resolution")}), truth["bbox_yup_m"]["size"])
