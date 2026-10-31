"""Build a small test world in Blender and export it the ways other apps hand worlds over (Milestone 12 round trip).

Run headless (fresh factory scene, nothing of yours is opened or saved):
  Blender --background --factory-startup --python tools/interop/blender_make_test_world.py -- <out_dir>

World (Blender: metres, Z up): a 10 m x 8 m floor, four 3 m walls (the front wall has a 1.0 x 2.1 m door centred at
x = 1.5), a 0.75 m table at (2, -1), a 0.6 m crate at (-3, 2) that slides 2 m along +X over frames 1-48, and a camera
that dollies from (0, -12, 1.6) to (0, -6, 1.6) looking +Y while its lens goes 35 -> 50 mm.
Writes world.glb (glTF, Y up, m), world.fbx (Y up), world.obj (Y up, m) and world_zup_cm.obj (Z up, centimetres, as
Unreal / an untouched Maya-cm scene would hand it over), plus truth.json with the facts the importer must recover.
"""
import json
import math
import os
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.getcwd()
os.makedirs(out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 48
scene.unit_settings.system = "METRIC"


def box(name, size, loc, mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        o.data.materials.append(mat)
    return o


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    return m


wall_m, floor_m, wood, crate_m = material("wall", (0.8, 0.78, 0.72)), material("floor", (0.35, 0.3, 0.25)), material("wood", (0.5, 0.32, 0.18)), material("crate", (0.6, 0.45, 0.2))
box("floor", (10, 8, 0.1), (0, 0, -0.05), floor_m)
H, T = 3.0, 0.2
box("wall_back", (10, T, H), (0, 4 - T / 2, H / 2), wall_m)
box("wall_left", (T, 8, H), (-5 + T / 2, 0, H / 2), wall_m)
box("wall_right", (T, 8, H), (5 - T / 2, 0, H / 2), wall_m)
# Front wall (y = -4) with a door 1.0 m wide, 2.1 m tall, centred at x = 1.5.
dx, dw, dh = 1.5, 1.0, 2.1
lw = (dx - dw / 2) - (-5)
rw = 5 - (dx + dw / 2)
box("wall_front_l", (lw, T, H), (-5 + lw / 2, -4 + T / 2, H / 2), wall_m)
box("wall_front_r", (rw, T, H), (5 - rw / 2, -4 + T / 2, H / 2), wall_m)
box("wall_front_top", (dw, T, H - dh), (dx, -4 + T / 2, dh + (H - dh) / 2), wall_m)
# Table: top 1.6 x 0.9 x 0.05 at 0.75 m, four legs.
tx, ty = 2.0, -1.0
box("table_top", (1.6, 0.9, 0.05), (tx, ty, 0.725), wood)
for i, (sx, sy) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
    box(f"table_leg_{i}", (0.06, 0.06, 0.7), (tx + sx * 0.72, ty + sy * 0.38, 0.35), wood)
crate = box("crate", (0.6, 0.6, 0.6), (-3, 2, 0.3), crate_m)
crate.keyframe_insert("location", frame=1)
crate.location.x += 2.0
crate.keyframe_insert("location", frame=48)

cam_data = bpy.data.cameras.new("ShotCam")
cam_data.sensor_fit = "HORIZONTAL"
cam_data.sensor_width = 36
cam = bpy.data.objects.new("ShotCam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.rotation_euler = (math.radians(90), 0, 0)   # Blender camera looks down -Z; X 90 deg -> looks +Y
for f, y, lens in [(1, -12.0, 35.0), (48, -6.0, 50.0)]:
    cam.location = (0, y, 1.6)
    cam.keyframe_insert("location", frame=f)
    cam.keyframe_insert("rotation_euler", frame=f)
    cam_data.lens = lens
    cam_data.keyframe_insert("lens", frame=f)
for fc in list(cam.animation_data.action.fcurves) + list(crate.animation_data.action.fcurves):
    for k in fc.keyframe_points:
        k.interpolation = "LINEAR"
scene.render.resolution_x, scene.render.resolution_y = 1920, 1038

bpy.ops.export_scene.gltf(filepath=os.path.join(out, "world.glb"), export_format="GLB", export_cameras=True, export_pointer_animation=True,
                          export_animations=True, export_yup=True)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, "world.fbx"), bake_anim=True, bake_anim_use_all_actions=True, axis_up="Y", axis_forward="-Z")
bpy.ops.wm.obj_export(filepath=os.path.join(out, "world.obj"), export_animation=False, up_axis="Y", forward_axis="NEGATIVE_Z",
                      export_materials=False)
bpy.ops.wm.obj_export(filepath=os.path.join(out, "world_zup_cm.obj"), export_animation=False, up_axis="Z", forward_axis="Y",
                      global_scale=100.0, export_materials=False)

# Blender (x, y, z) -> Soundstage / glTF (x, z, -y).
truth = {
    "floor_y": 0.0, "wall_height": H, "size_m": [10.0, 3.0, 8.0],
    "door": {"center_x": dx, "width": dw, "height": dh, "wall_z": 4.0},   # front wall y = -4 -> stage z = +4
    "table_top_y": 0.75, "table_xz": [tx, -ty],
    "crate_start": [-3.0, 0.3, -2.0], "crate_end": [-1.0, 0.3, -2.0],
    "camera": {"start": [0, 1.6, 12.0], "end": [0, 1.6, 6.0], "forward": [0, 0, -1], "lens_start": 35.0, "lens_end": 50.0,
               "frames": 48, "fps": 24},
}
with open(os.path.join(out, "truth.json"), "w") as f:
    json.dump(truth, f, indent=1)
print("Soundstage test world written to", out)
