# Headless Blender: build a small room from Kenney Furniture Kit GLBs (CC0), with a dollying camera, a sliding chair,
# a point light and a sun. Saves <out>/kenney_room.blend.
#   Blender -b --factory-startup --python bl_kenney_room.py -- <kenney GLTF format dir> <out.blend>
import bpy, math, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
src, out_blend = argv[0], os.path.abspath(argv[1])
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 24
sc.frame_start, sc.frame_end = 1, 48
S = 2.0   # Kenney's furniture kit is modelled at about half a metre per unit; scale to real size


def put(name, loc, rot_z=0.0, label=None):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(src, name + ".glb"))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(label or name, None)
    sc.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    root.location = loc
    root.rotation_euler = (0, 0, rot_z)
    root.scale = (S, S, S)
    return root

# Floor 4 x 4 tiles, back and left walls.
for i in range(4):
    for j in range(4):
        put("floorFull", (i * S, j * S, 0), label=f"floor_{i}{j}")
for i in range(4):
    put("wall", (i * S, 4 * S, 0), label=f"wall_back_{i}")
    put("wallWindow" if i == 2 else "wall", (0, i * S, 0), math.pi / 2, label=f"wall_left_{i}")
put("bedDouble", (2.0, 5.6, 0), label="bed")
put("desk", (5.5, 6.6, 0), label="desk")
chair = put("chairDesk", (5.8, 5.2, 0), math.pi, label="chair")
put("lampRoundFloor", (1.0, 7.2, 0), label="lamp")
put("bookcaseOpen", (0.6, 3.0, 0), -math.pi / 2, label="bookcase")
put("rugRectangle", (3.0, 4.0, 0), label="rug")

# The chair slides 1 m to the left over the clip.
chair.keyframe_insert("location", frame=1)
chair.location.x -= 1.0
chair.keyframe_insert("location", frame=48)

# Lights: a warm point light and a sun.
pl = bpy.data.lights.new("practical", "POINT"); pl.energy = 200; pl.color = (1.0, 0.85, 0.7)
po = bpy.data.objects.new("practical", pl); po.location = (1.2, 7.0, 2.2); sc.collection.objects.link(po)
sl = bpy.data.lights.new("sun", "SUN"); sl.energy = 3
so = bpy.data.objects.new("sun", sl); so.rotation_euler = (math.radians(50), 0, math.radians(30)); sc.collection.objects.link(so)

# Camera: 35 mm on a 36 mm sensor, horizontal fit, dollying in.
cd = bpy.data.cameras.new("ShotCam"); cd.lens = 35; cd.sensor_width = 36; cd.sensor_fit = "HORIZONTAL"
cam = bpy.data.objects.new("ShotCam", cd); sc.collection.objects.link(cam); sc.camera = cam
cam.location = (6.5, -2.5, 1.6); cam.rotation_euler = (math.radians(84), 0, math.radians(28))
cam.keyframe_insert("location", frame=1); cam.keyframe_insert("rotation_euler", frame=1)
cam.location = (5.4, 0.2, 1.5); cam.rotation_euler = (math.radians(86), 0, math.radians(35))
cam.keyframe_insert("location", frame=48); cam.keyframe_insert("rotation_euler", frame=48)
for o in (chair, cam):
    for fc in o.animation_data.action.fcurves:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"
bpy.ops.wm.save_as_mainfile(filepath=out_blend)
print("SAVED", out_blend, len(sc.objects), "objects")
