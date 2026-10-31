"""A heavy synthetic world for the import performance check (Milestone 12): thousands of separate objects.

  Blender --background --factory-startup --python tools/interop/blender_make_heavy_world.py -- <out_dir> [blocks]

A 400 m x 400 m town: a subdivided terrain, blocks x blocks bevelled buildings (each its own object and mesh,
6 materials), a lamp post and a bench beside each, and 1500 scattered rocks. Writes heavy_world.glb (Blender:
metres, Z up; the glTF exporter writes Y up).
"""
import math
import os
import random
import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = argv[0] if argv else os.getcwd()
n = int(argv[1]) if len(argv) > 1 else 30
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
rnd = random.Random(5)


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    return m


mats = [material("facade_%d" % i, c) for i, c in enumerate([(0.7, 0.68, 0.62), (0.55, 0.35, 0.28), (0.4, 0.45, 0.5),
                                                             (0.8, 0.8, 0.78), (0.3, 0.3, 0.32), (0.6, 0.55, 0.4)])]
ground = material("ground", (0.35, 0.33, 0.3))


def template(kind):
    bm = bmesh.new()
    if kind == "building":
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.04, segments=4, affect="EDGES")
        bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges if e.calc_length() > 0.5], cuts=6, use_grid_fill=True)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.5))
    elif kind == "lamp":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.1, radius2=0.08, depth=4)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 2))
    elif kind == "bench":
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.05, segments=3, affect="EDGES")
    else:
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    me = bpy.data.meshes.new(kind)
    bm.to_mesh(me)
    bm.free()
    return me


T = {k: template(k) for k in ("building", "lamp", "bench", "rock")}


def obj(name, kind, mat, loc, scale=(1, 1, 1)):
    me = T[kind].copy()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    o.location, o.scale = loc, scale
    scene.collection.objects.link(o)
    return o


me = bpy.data.meshes.new("terrain")
N, S = 220, 400.0
verts, faces = [], []
for j in range(N + 1):
    for i in range(N + 1):
        x, y = -S / 2 + S * i / N, -S / 2 + S * j / N
        r = max(abs(x), abs(y))
        z = 0.02 * (r - 150) ** 1.4 * (1 + 0.3 * math.sin(x * 0.05) * math.cos(y * 0.07)) if r > 150 else 0.0
        verts.append((x, y, z))
for j in range(N):
    for i in range(N):
        a = j * (N + 1) + i
        faces.append((a, a + 1, a + N + 2, a + N + 1))
me.from_pydata(verts, [], faces)
me.materials.append(ground)
scene.collection.objects.link(bpy.data.objects.new("terrain", me))
step = 240.0 / n
for i in range(n):
    for j in range(n):
        x, y = -120 + (i + 0.5) * step, -120 + (j + 0.5) * step
        w, d, h = rnd.uniform(0.4, 0.7) * step, rnd.uniform(0.4, 0.7) * step, rnd.uniform(6, 30)
        obj("bldg_%d_%d" % (i, j), "building", mats[(i * 7 + j) % len(mats)], (x, y, 0), (w, d, h))
        obj("lamp_%d_%d" % (i, j), "lamp", mats[4], (x + w / 2 + 1, y, 0))
        obj("bench_%d_%d" % (i, j), "bench", mats[1], (x - w / 2 - 1, y, 0.25), (1.6, 0.5, 0.5))
for k in range(1500):
    r = rnd.uniform(0.3, 1.2)
    obj("rock_%d" % k, "rock", mats[2], (rnd.uniform(-190, 190), rnd.uniform(-190, 190), 0.1), (r, r, r))
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "heavy_world.glb"), export_format="GLB")
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in scene.objects if o.type == "MESH")
print("objects", len(scene.objects), "triangles", tris, "written", os.path.join(out, "heavy_world.glb"))
