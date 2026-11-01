"""Render benchmark tracks (any engine's runner JSON) in Blender Workbench, from the scene camera.

  Blender --background --factory-startup --python render_workbench.py -- \
      --run out/bl_default.json --outdir out/frames_wb [--scenes scenes.json]

Frames rendered are SHEET_FRAMES below (the same list the clay renderer and the contact sheets use).
Output: <outdir>/<run label>/<scene>_<frame:04d>.png, 640x360.
"""
import bpy, json, math, os, sys
from mathutils import Vector, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1) if argv[i].startswith("--")}
here = os.path.dirname(os.path.abspath(__file__))
scenes = json.load(open(args.get("scenes", os.path.join(here, "scenes.json"))))
run = json.load(open(args["run"]))
SHEET = json.load(open(os.path.join(here, "sheet_frames.json")))
outdir = os.path.join(args.get("outdir", os.path.join(here, "out", "frames_wb")), run["label"])
os.makedirs(outdir, exist_ok=True)


def to_bl(p):
    return Vector((p[0], -p[2], p[1]))


def q_to_bl(q):
    return Quaternion((q[3], q[0], -q[2], q[1]))


for sc in scenes["scenes"]:
    R = run["scenes"].get(sc["name"])
    if not R:
        continue
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    s = bpy.context.scene
    s.render.engine = "BLENDER_WORKBENCH"
    s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage = 640, 360, 100
    sh = s.display.shading
    sh.light = "STUDIO"
    sh.color_type = "OBJECT"
    sh.show_shadows = True
    sh.show_cavity = True
    sh.show_object_outline = True
    s.display.shadow_focus = 0.3
    s.render.film_transparent = False
    sh.background_type = "VIEWPORT"
    sh.background_color = (0.17, 0.18, 0.21)
    bpy.ops.mesh.primitive_plane_add(size=400)
    bpy.context.active_object.color = (0.5, 0.5, 0.5, 1)
    objs = {}
    for b in sc["bodies"]:
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        o = bpy.context.active_object
        o.scale = (b["size"][0], b["size"][2], b["size"][1])
        o.rotation_mode = "QUATERNION"
        o.color = {"dynamic": (0.78, 0.74, 0.68, 1), "static": (0.45, 0.47, 0.5, 1), "kinematic": (0.35, 0.45, 0.6, 1)}[b["type"]]
        objs[b["id"]] = o
    cam_d = bpy.data.cameras.new("cam")
    cam_d.sensor_fit = "VERTICAL"
    cam_d.angle_y = math.radians(sc["camera"]["fov"])
    cam = bpy.data.objects.new("cam", cam_d)
    s.collection.objects.link(cam)
    cam.location = to_bl(sc["camera"]["pos"])
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (to_bl(sc["camera"]["target"]) - cam.location).to_track_quat("-Z", "Y")
    s.camera = cam
    for f in SHEET[sc["name"]]:
        for k, o in objs.items():
            p = R["tracks"][k][min(f, len(R["tracks"][k]) - 1)]
            o.location = to_bl(p[:3])
            o.rotation_quaternion = q_to_bl(p[3:])
        s.render.filepath = os.path.join(outdir, f"{sc['name']}_{f:04d}.png")
        bpy.ops.render.render(write_still=True)
    print("rendered", sc["name"], run["label"], flush=True)
