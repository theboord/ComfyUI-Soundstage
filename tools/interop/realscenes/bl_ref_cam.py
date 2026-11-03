# Render a Blender reference mask of the Kenney room through a given camera (position, forward in Blender Z-up).
import bpy, sys, mathutils
a = sys.argv[sys.argv.index("--") + 1:]
out, pos, fwd, lens = a[0], [float(x) for x in a[1].split(",")], [float(x) for x in a[2].split(",")], float(a[3])
sc = bpy.context.scene
cd = bpy.data.cameras.new("Ref"); cd.lens = lens; cd.sensor_width = 36; cd.sensor_fit = "HORIZONTAL"
cam = bpy.data.objects.new("Ref", cd); sc.collection.objects.link(cam); sc.camera = cam
cam.location = pos
cam.rotation_euler = mathutils.Vector(fwd).to_track_quat("-Z", "Y").to_euler()
if cam.animation_data: cam.animation_data_clear()
sc.render.engine = "BLENDER_WORKBENCH"; sc.render.resolution_x, sc.render.resolution_y = 1024, 576
sc.render.film_transparent = True; sc.render.image_settings.color_mode = "RGBA"; sc.frame_set(1)
sc.render.filepath = out; bpy.ops.render.render(write_still=True)
