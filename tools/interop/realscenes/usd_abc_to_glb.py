# Blender headless: import a USD / Alembic file and export it as GLB (the route to Soundstage for Houdini output).
import bpy, sys, os
src, dst = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
if ext.startswith(".usd"): bpy.ops.wm.usd_import(filepath=src)
elif ext == ".abc": bpy.ops.wm.alembic_import(filepath=src)
sc = bpy.context.scene
print("CONVERT objects", len(sc.objects), "meshes", len([o for o in sc.objects if o.type == "MESH"]), "cams", len([o for o in sc.objects if o.type == "CAMERA"]), "frames", sc.frame_start, sc.frame_end)
# USD / Alembic transforms play through a Transform Cache constraint, which the glTF exporter doesn't see: bake them
# to keys first (visual keying, constraint cleared).
cached = [o for o in sc.objects if any(c.type == "TRANSFORM_CACHE" for c in o.constraints)]
if cached:
    bpy.ops.object.select_all(action="DESELECT")
    for o in cached: o.select_set(True)
    bpy.context.view_layer.objects.active = cached[0]
    bpy.ops.nla.bake(frame_start=sc.frame_start, frame_end=sc.frame_end, only_selected=True, visual_keying=True, clear_constraints=True, bake_types={"OBJECT"})
    print("CONVERT baked", len(cached), "transform-cached objects")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_yup=True, export_cameras=True, export_animations=True, export_apply=True, export_bake_animation=True, export_frame_range=True)
print("CONVERT wrote", dst, os.path.getsize(dst))
