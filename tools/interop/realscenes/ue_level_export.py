# Build a level from CC0 assets (the Kenney Furniture Kit room) in UE 5.7, add a CineCameraActor, export the level
# as glTF (GLTFExporter plugin) and FBX, and write what UE says about it.
import os, json, unreal
src = os.environ["SS_UE_SRC"]; out = os.environ["SS_UE_OUT"]
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
les.new_level("/Game/SS_Interop/L_KenneyRoom")
mgr = unreal.InterchangeManager.get_interchange_manager_scripted()
params = unreal.ImportAssetParameters(); params.is_automated = True
mgr.import_scene("/Game/Kenney", unreal.InterchangeManager.create_source_data(src), params)
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
# Remove what the GLB brought besides geometry (its camera and lights), then add our own UE camera.
for a in eas.get_all_level_actors():
    if a.get_class().get_name() in ("CineCameraActor", "CameraActor"):
        a.destroy_actor()
cam = eas.spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(650.0, -250.0, 160.0), unreal.Rotator(roll=0.0, pitch=-6.0, yaw=-118.0))
cam.set_actor_label("UE_ShotCam")
comp = cam.get_cine_camera_component()
fb = comp.get_editor_property("filmback"); fb.set_editor_property("sensor_width", 36.0); fb.set_editor_property("sensor_height", 20.25); comp.set_editor_property("filmback", fb)
comp.set_editor_property("current_focal_length", 28.0)
les.save_current_level()
world = unreal.EditorLevelLibrary.get_editor_world()
acts = eas.get_all_level_actors()
lo = [1e9] * 3; hi = [-1e9] * 3
for a in acts:
    if a.get_class().get_name() != "StaticMeshActor": continue
    o, e = a.get_actor_bounds(False)
    for i, k in enumerate("xyz"):
        lo[i] = min(lo[i], getattr(o, k) - getattr(e, k)); hi[i] = max(hi[i], getattr(o, k) + getattr(e, k))
rep = {"actors": len(acts), "static_meshes": len([a for a in acts if a.get_class().get_name() == "StaticMeshActor"]), "bounds_cm": [lo, hi],
       "camera": {"loc_cm": [650.0, -250.0, 160.0], "rot": {"pitch": -6.0, "yaw": -118.0, "roll": 0.0}, "focal_mm": 28.0, "sensor": [36.0, 20.25]}}
# glTF
try:
    opts = unreal.GLTFExportOptions()
    for k, v in (("export_cameras", True), ("export_lights", False), ("export_level_sequences", False)):
        try: opts.set_editor_property(k, v)
        except Exception as e: unreal.log_warning("opt %s: %s" % (k, e))
    ok = unreal.GLTFExporter.export_to_gltf(world, os.path.join(out, "ue_level.glb"), opts, set())
    rep["gltf"] = str(ok)
except Exception as e:
    rep["gltf"] = "FAILED: %s" % e
# FBX: export the level (World asset) with the level FBX exporter
try:
    task = unreal.AssetExportTask()
    task.set_editor_property("object", world)
    task.set_editor_property("filename", os.path.join(out, "ue_level.fbx"))
    task.set_editor_property("automated", True); task.set_editor_property("prompt", False); task.set_editor_property("replace_identical", True)
    task.set_editor_property("exporter", unreal.LevelExporterFBX())
    rep["fbx"] = unreal.Exporter.run_asset_export_task(task)
except Exception as e:
    rep["fbx"] = "FAILED: %s" % e
json.dump(rep, open(os.path.join(out, "ue_report.json"), "w"), indent=1, default=str)
unreal.log("SSREPORT level export done")
