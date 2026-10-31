"""A heavy synthetic world for the import performance check (Milestone 12): thousands of separate objects.

  Blender --background --factory-startup --python tools/interop/blender_make_heavy_world.py -- <out_dir> [blocks]

A 400 m x 400 m town: a subdivided terrain, blocks x blocks buildings (each its own object, 6 materials, bevelled),
a lamp post and a bench beside each, and scattered rocks. Writes heavy_world.glb (Blender units: metres, Z up).
"""
import math
import os
import random
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = argv[0] if argv else os.getcwd()
n = int(argv[1]) if len(argv) > 1 else 30
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
rnd = random.Random(5)
mats = []
for i, c in enumerate([(0.7, 0.68, 0.62), (0.55, 0.35, 0.28), (0.4, 0.45, 0.5), (0.8, 0.8, 0.78), (0.3, 0.3, 0.32), (0.6, 0.55, 0.4)]):
    m = bpy.data.materials.new("facade_%d" % i)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*c, 1)
    mats.append(m)
ground = bpy.data.materials.new("ground")
bpy.ops.mesh.primitive_grid_add(x_subdivisions=220, y_subdivisions=220, size=400)
terrain = bpy.context.active_object
terrain.name = "terrain"
for v in terrain.data.vertices:
    x, y = v.co.x, v.co.y
    if max(abs(x), abs(y)) > 150:
        v.co.z = 0.02 * (max(abs(x), abs(y)) - 150) ** 1.4 * (1 + 0.3 * math.sin(x * 0.05) * math.cos(y * 0.07))
terrain.data.materials.append(ground)
step = 240.0 / n
for i in range(n):
    for j in range(n):
        x, y = -120 + (i + 0.5) * step, -120 + (j + 0.5) * step
        w, d, h = rnd.uniform(0.4, 0.7) * step, rnd.uniform(0.4, 0.7) * step, rnd.uniform(6, 30)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, h / 2))
        b = bpy.context.active_object
        b.name = "bldg_%d_%d" % (i, j)
        b.scale = (w, d, h)
        mod = b.modifiers.new("bevel", "BEVEL")
        mod.width, mod.segments = 0.3, 3
        mod2 = b.modifiers.new("sub", "SUBSURF")
        mod2.levels = 1
        mod2.subdivision_type = "SIMPLE"
        b.data.materials.append(mats[(i * 7 + j) % len(mats)])
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.1, depth=4, location=(x + w / 2 + 1, y, 2))
        bpy.context.active_object.name = "lamp_%d_%d" % (i, j)
        bpy.context.active_object.data.materials.append(mats[4])
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x - w / 2 - 1, y, 0.25))
        bench = bpy.context.active_object
        bench.name = "bench_%d_%d" % (i, j)
        bench.scale = (1.6, 0.5, 0.5)
        bench.data.materials.append(mats[1])
for k in range(1500):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=rnd.uniform(0.3, 1.2), location=(rnd.uniform(-190, 190), rnd.uniform(-190, 190), 0.2))
    bpy.context.active_object.name = "rock_%d" % k
    bpy.context.active_object.data.materials.append(mats[2])
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "heavy_world.glb"), export_format="GLB", export_apply=True)
print("objects", len(bpy.data.objects), "written", os.path.join(out, "heavy_world.glb"))
