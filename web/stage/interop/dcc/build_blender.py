"""Soundstage DCC kit -> Blender (verified headless in Blender 4.3).

Imports scene.glb (the staged set, props and actors with every move baked to keys), builds "shot_cam" from
camera.json (36 mm sensor, horizontal fit, lens keyed per frame), sets fps, frame range and render resolution, and
shows the Layer Pack plates as the camera background when a plates/ folder sits in the kit.

Run:   blender --python <kit>/blender/build_blender.py
       or open it in the Scripting tab and press Run Script.
Options (after "--"):  --kit DIR  --plates DIR  --no-glb  --render OUT.png --frame N --engine WORKBENCH|EEVEE
                       --transparent  --hide name1,name2  --save OUT.blend
Soundstage is metres, Y up, right-handed; Blender is metres, Z up: (x, y, z) -> (x, -z, y), as Blender's glTF
importer does, so the camera and the imported geometry agree.
"""
import json
import math
import os
import sys

try:
    import bpy
    from mathutils import Matrix
except ImportError:  # imported outside Blender (tests): the maths below still works
    bpy = None
    Matrix = None

Y_UP_TO_Z_UP = [[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, -1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def matmul4(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def blender_matrix(cam_to_world):
    """Soundstage camera-to-world (Y up) -> Blender world matrix (Z up). Blender cameras also look down local -Z."""
    return matmul4(Y_UP_TO_Z_UP, cam_to_world)


def to_blender_point(p):
    x, y, z = p
    return [x, -z, y]


def fps_settings(fps):
    """Blender stores fps as an integer and a base: 23.976 -> (24, 1.001)."""
    whole = int(math.ceil(fps - 1e-6))
    return whole, whole / fps


def parse_args(argv):
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    out = {"kit": None, "plates": None, "glb": True, "render": None, "frame": None, "engine": "WORKBENCH",
           "transparent": False, "hide": [], "save": None, "samples": 8}
    i = 0
    while i < len(args):
        a = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else None
        if a == "--kit":
            out["kit"], i = nxt, i + 1
        elif a == "--plates":
            out["plates"], i = nxt, i + 1
        elif a == "--no-glb":
            out["glb"] = False
        elif a == "--render":
            out["render"], i = nxt, i + 1
        elif a == "--frame":
            out["frame"], i = int(nxt), i + 1
        elif a == "--engine":
            out["engine"], i = nxt.upper(), i + 1
        elif a == "--samples":
            out["samples"], i = int(nxt), i + 1
        elif a == "--transparent":
            out["transparent"] = True
        elif a == "--hide":
            out["hide"], i = [n for n in nxt.split(",") if n], i + 1
        elif a == "--save":
            out["save"], i = nxt, i + 1
        i += 1
    return out


def find_kit(explicit=None, here=None):
    """The kit folder: --kit, else the folder above this script (<kit>/blender/build_blender.py), else the cwd."""
    for cand in [explicit, os.path.dirname(os.path.dirname(os.path.abspath(here))) if here else None, os.getcwd()]:
        if cand and os.path.exists(os.path.join(cand, "shot.json")):
            return cand
    raise RuntimeError("Soundstage: can't find the kit (shot.json). Pass --kit <folder>.")


def load_kit(kit):
    with open(os.path.join(kit, "shot.json")) as f:
        shot = json.load(f)
    with open(os.path.join(kit, shot.get("camera_json", "camera.json"))) as f:
        cam = json.load(f)
    return shot, cam


def iter_fcurves(action):
    """F-curves of an action, for Blender 4.3 (action.fcurves) and the layered actions of 4.4+."""
    try:
        for fc in action.fcurves:
            yield fc
        return
    except AttributeError:
        pass
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                for fc in bag.fcurves:
                    yield fc


def shift_actions(actions, offset):
    for act in actions:
        for fc in iter_fcurves(act):
            for k in fc.keyframe_points:
                k.co.x += offset
                k.handle_left.x += offset
                k.handle_right.x += offset
            fc.update()


def main(opts):
    here = globals().get("__file__")
    kit = find_kit(opts["kit"], here)
    shot, camj = load_kit(kit)
    scene = bpy.context.scene
    W, H = shot["resolution"]
    first, last = shot["frame_start"], shot["frame_end"]
    scene.render.fps, scene.render.fps_base = fps_settings(shot["fps"])   # before the import: it keys at scene fps
    coll = bpy.data.collections.new("Soundstage_" + shot["shot"])
    scene.collection.children.link(coll)

    # 1. The stage.
    if opts["glb"] and shot.get("scene_glb") and os.path.exists(os.path.join(kit, shot["scene_glb"])):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(kit, shot["scene_glb"]))
        new = [o for o in bpy.data.objects if o not in before]
        drop = [o for o in new if o.name.split(".")[0] in ("shot_cam", "soundstage_axis_probes") or o.name.startswith("ss_probe_")]
        actions = set()
        for o in new:
            if o in drop:
                continue
            ad = o.animation_data
            if ad and ad.action:
                actions.add(ad.action)
            for tr in (ad.nla_tracks if ad else []):
                for st in tr.strips:
                    if st.action:
                        actions.add(st.action)
        for o in drop:
            bpy.data.objects.remove(o, do_unlink=True)
        # glTF time 0 is Soundstage frame 0 = kit frame_start; the importer puts it at frame 0 (or 1): line it up.
        keys = [k.co.x for a in actions for fc in iter_fcurves(a) for k in fc.keyframe_points]
        if keys:
            shift_actions(actions, first - round(min(keys)))
        print("Soundstage: imported %d objects, %d animated" % (len(new) - len(drop), len(actions)))

    # 2. The camera, exactly as Soundstage framed it.
    cam_data = bpy.data.cameras.new("shot_cam")
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = camj.get("sensor_width_mm", 36.0)
    cam_data.sensor_height = cam_data.sensor_width * H / W
    cam_data.clip_start = 0.05
    cam_data.clip_end = 5000.0
    cam_obj = bpy.data.objects.new("shot_cam", cam_data)
    coll.objects.link(cam_obj)
    scene.camera = cam_obj
    prev = None
    for c in camj["frames"]:
        cam_obj.matrix_world = Matrix(blender_matrix(c["cam_to_world"]))
        if prev is not None:
            cam_obj.rotation_euler = cam_obj.matrix_world.to_euler("XYZ", prev)
        prev = cam_obj.rotation_euler.copy()
        cam_obj.keyframe_insert("location", frame=c["frame"])
        cam_obj.keyframe_insert("rotation_euler", frame=c["frame"])
        cam_data.lens = c["focal_mm"]
        cam_data.keyframe_insert("lens", frame=c["frame"])
    for idb in (cam_obj, cam_data):
        if idb.animation_data and idb.animation_data.action:
            for fc in iter_fcurves(idb.animation_data.action):
                for k in fc.keyframe_points:
                    k.interpolation = "LINEAR"

    # 3. Shot settings.
    scene.render.resolution_x, scene.render.resolution_y = W, H
    scene.render.resolution_percentage = 100
    scene.frame_start, scene.frame_end = first, last
    scene.frame_set(first)

    # 4. Layer Pack plates as the camera background (viewport, camera view).
    plates = opts["plates"] or os.path.join(kit, "plates")
    if os.path.isdir(plates):
        imgs = sorted(f for f in os.listdir(plates) if f.lower().endswith((".png", ".jpg", ".jpeg", ".exr")))
        if imgs:
            img = bpy.data.images.load(os.path.join(plates, imgs[0]), check_existing=True)
            img.source = "SEQUENCE" if len(imgs) > 1 else "FILE"
            bg = cam_data.background_images.new()
            bg.image = img
            num = "".join(ch for ch in os.path.splitext(imgs[0])[0][-4:] if ch.isdigit())
            bg.image_user.frame_start = first
            bg.image_user.frame_duration = len(imgs)
            bg.image_user.frame_offset = (int(num) - 1) if num else 0
            bg.image_user.use_auto_refresh = True
            cam_data.show_background_images = True
            print("Soundstage: plates from", plates)

    # 5. Optional check render / save.
    if opts["hide"]:
        for o in bpy.data.objects:
            if any(o.name == n or o.name.startswith(n + ".") or o.name.startswith(n + "_") for n in opts["hide"]):
                o.hide_render = True
    if opts["render"]:
        f = opts["frame"] if opts["frame"] is not None else first
        scene.frame_set(f)
        eng = opts["engine"]
        if eng.startswith("EEVEE"):
            for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
                try:
                    scene.render.engine = name
                    break
                except TypeError:
                    continue
            try:
                scene.eevee.taa_render_samples = opts["samples"]
            except AttributeError:
                pass
        else:
            scene.render.engine = "BLENDER_WORKBENCH"
            scene.display.shading.light = "STUDIO"
            scene.display.shading.color_type = "MATERIAL"
            scene.display.render_aa = "8"
        scene.render.film_transparent = opts["transparent"]
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA" if opts["transparent"] else "RGB"
        scene.render.filepath = os.path.abspath(opts["render"])
        bpy.ops.render.render(write_still=True)
        print("Soundstage: rendered frame %d to %s" % (f, scene.render.filepath))
    if opts["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opts["save"]))
    print("Soundstage: built %s from %s (%d frames at %s fps)" % (shot["shot"], kit, last - first + 1, shot["fps"]))


if bpy is not None:
    main(parse_args(sys.argv))
