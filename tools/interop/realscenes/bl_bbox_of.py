# Re-import an exported file into an empty Blender and print the bbox of every mesh (Y-up metres), top extents.
import bpy, sys, json
from mathutils import Vector
p = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
if p.endswith(".glb"): bpy.ops.import_scene.gltf(filepath=p)
elif p.endswith(".fbx"): bpy.ops.import_scene.fbx(filepath=p)
elif p.endswith(".usdc") or p.endswith(".usda") or p.endswith(".usd") or p.endswith(".usdz"): bpy.ops.wm.usd_import(filepath=p)
elif p.endswith(".abc"): bpy.ops.wm.alembic_import(filepath=p)
dg = bpy.context.evaluated_depsgraph_get()
lo, hi, tops, n, mats = [1e9]*3, [-1e9]*3, [], 0, set()
for o in bpy.context.scene.objects:
    if o.type != "MESH": continue
    n += 1
    for s in o.material_slots:
        if s.material: mats.add(s.material.name)
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    pts = [(q.x, q.z, -q.y) for q in pts]
    for q in pts:
        for i in range(3): lo[i] = min(lo[i], q[i]); hi[i] = max(hi[i], q[i])
    tops.append((max(q[1] for q in pts), min(q[1] for q in pts), o.name))
tops.sort(reverse=True)
print("BBOX", json.dumps({"file": p, "meshes": n, "materials": len(mats), "min": [round(v,3) for v in lo], "max": [round(v,3) for v in hi], "size": [round(hi[i]-lo[i],3) for i in range(3)],
  "cams": len([o for o in bpy.context.scene.objects if o.type == "CAMERA"]), "lights": len([o for o in bpy.context.scene.objects if o.type == "LIGHT"]),
  "highest": [(round(a,2), round(b,2), c) for a,b,c in tops[:4]], "lowest": [(round(b,2), c) for a,b,c in sorted(tops, key=lambda t: t[1])[:3]]}))
