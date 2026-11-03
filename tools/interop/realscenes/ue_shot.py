# Full editor (offscreen): open the kit level and its camera sequence, step to frames 1001 / 1061 / 1121 and render
# shot_cam's view with a SceneCapture2D into a render target, saved as PNG. Quits the editor when done.
import unreal, os
out = os.environ["SS_UE_SHOTS"]
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
les.load_level("/Game/SS_Interop/L_KitTest")
seq_path = [p for p in unreal.EditorAssetLibrary.list_assets("/Game/Soundstage/", recursive=True) if "/SEQ_" in p][0].split(".")[0]
seq = unreal.load_asset(seq_path)
unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(seq)
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
cam = [a for a in eas.get_all_level_actors() if a.get_actor_label() == "shot_cam"][0]
world = unreal.EditorLevelLibrary.get_editor_world()
rt = unreal.RenderingLibrary.create_render_target2d(world, 960, 512, unreal.TextureRenderTargetFormat.RTF_RGBA8)
cap = eas.spawn_actor_from_class(unreal.SceneCapture2D, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
cc = cap.get_editor_property("capture_component2d")
cc.set_editor_property("texture_target", rt)
cc.set_editor_property("capture_source", unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
cc.set_editor_property("capture_every_frame", False)
frames = [1001, 1061, 1121]
state = {"i": 0, "wait": 30}
log = open(os.path.join(out, "ue_shots.txt"), "w")
def tick(dt):
    if state["wait"] > 0:
        state["wait"] -= 1; return
    i = state["i"]
    if i >= len(frames) * 2:
        log.close(); unreal.unregister_slate_post_tick_callback(h); unreal.SystemLibrary.quit_editor(); return
    f = frames[i // 2]
    if i % 2 == 0:
        unreal.LevelSequenceEditorBlueprintLibrary.set_current_time(f)
        state["wait"] = 30
    else:
        cine = cam.get_cine_camera_component()
        hfov = cine.get_editor_property("field_of_view")
        cap.set_actor_location_and_rotation(cam.get_actor_location(), cam.get_actor_rotation(), False, False)
        cc.set_editor_property("fov_angle", hfov)
        cc.capture_scene()
        unreal.RenderingLibrary.export_render_target(world, rt, out, "ue_%d.png" % f)
        log.write("%d %s %s fov %.3f\n" % (f, cam.get_actor_location(), cam.get_actor_rotation(), hfov)); log.flush()
        state["wait"] = 30
    state["i"] += 1
h = unreal.register_slate_post_tick_callback(tick)
