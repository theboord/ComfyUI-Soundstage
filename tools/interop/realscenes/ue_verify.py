# Second, fresh UnrealEditor-Cmd run: load the saved level and Level Sequence, read the camera keys back and
# compare them with the kit's camera.json (Soundstage metres, Y up) through UE = (x, z, y) * 100.
import os, json, math, unreal
kit = os.environ["SOUNDSTAGE_KIT"]; out = os.environ["SS_UE_REPORT"]
cj = json.load(open(os.path.join(kit, "camera.json"))); shot = json.load(open(os.path.join(kit, "shot.json")))
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
loaded = les.load_level("/Game/SS_Interop/L_KitTest")
acts = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
cams = [a for a in acts if a.get_actor_label() == "shot_cam" and a.get_class().get_name() == "CineCameraActor"]
rep = {"level_loaded": bool(loaded), "actors": len(acts), "shot_cam_actors": len(cams)}
seqs = [p for p in unreal.EditorAssetLibrary.list_assets("/Game/Soundstage/", recursive=True) if "/SEQ_" in p]
seq = unreal.load_asset(seqs[0].split(".")[0]) if seqs else None
rep["sequence"] = seqs[0] if seqs else None
if seq:
    dr = seq.get_display_rate(); rep["display_rate"] = [dr.numerator, dr.denominator]
    rep["playback"] = [seq.get_playback_start(), seq.get_playback_end()]
    binds = seq.get_bindings(); rep["bindings"] = [str(b.get_display_name()) for b in binds]
    tracks = {}
    for b in binds:
        for t in b.get_tracks():
            for s in t.get_sections():
                chans = s.get_all_channels() if hasattr(s, "get_all_channels") else s.get_channels()
                tracks.setdefault(str(b.get_display_name()) + "/" + t.get_class().get_name(), [len(c.get_keys()) for c in chans])
    rep["tracks"] = tracks
    try:
        rep["camera_cut_tracks"] = len([t for t in seq.get_tracks() if "CameraCut" in t.get_class().get_name()])
    except Exception as e:
        rep["camera_cut_tracks"] = str(e)
    # Sample the transform keys and compare
    tb = [b for b in binds if str(b.get_display_name()) == "shot_cam"][0]
    tt = [t for t in tb.get_tracks() if "Transform" in t.get_class().get_name()][0]
    ch = tt.get_sections()[0].get_all_channels()
    vals = [[k.get_value() for k in c.get_keys()] for c in ch]
    frs = [k.get_time().frame_number.value for k in ch[0].get_keys()]
    worst_p, worst_d, samples = 0, 0, []
    byf = {f["frame"]: f for f in cj["frames"]}
    for i, fr in enumerate(frs):
        f = byf.get(fr)
        if not f: continue
        ue = [vals[0][i], vals[1][i], vals[2][i]]
        ss = [ue[0] / 100, ue[2] / 100, ue[1] / 100]
        worst_p = max(worst_p, max(abs(ss[j] - f["position"][j]) for j in range(3)))
        rot = unreal.Rotator(roll=vals[3][i], pitch=vals[4][i], yaw=vals[5][i])
        fv = rot.get_forward_vector()
        fss = [fv.x, fv.z, fv.y]
        t = [f["target"][j] - f["position"][j] for j in range(3)]; n = math.sqrt(sum(x * x for x in t)); t = [x / n for x in t]
        d = math.degrees(math.acos(max(-1, min(1, sum(fss[j] * t[j] for j in range(3))))))
        worst_d = max(worst_d, d)
        if i in (0, len(frs) // 2, len(frs) - 1): samples.append({"frame": fr, "ue_cm": [round(x, 2) for x in ue], "ss_m": f["position"], "fwd_err_deg": round(d, 4)})
    rep.update({"keys": len(frs), "max_pos_err_m": worst_p, "max_forward_err_deg": worst_d, "samples": samples})
if cams:
    comp = cams[0].get_cine_camera_component(); fb = comp.get_editor_property("filmback")
    rep["filmback_mm"] = [fb.get_editor_property("sensor_width"), fb.get_editor_property("sensor_height")]
    rep["focal_mm"] = comp.get_editor_property("current_focal_length")
other = [p for p in unreal.EditorAssetLibrary.list_assets("/Game/Soundstage/", recursive=True) if "LevelSequences/" in p]
if other:
    s2 = unreal.load_asset(other[0].split(".")[0])
    rep["interchange_sequence"] = {"path": other[0], "bindings": len(s2.get_bindings()), "playback": [s2.get_playback_start(), s2.get_playback_end()],
                                   "display_rate": [s2.get_display_rate().numerator, s2.get_display_rate().denominator]}
if seq:
    subs = []
    for t in seq.get_tracks():
        if "SubTrack" in t.get_class().get_name():
            for sec in t.get_sections():
                sq = sec.get_sequence()
                subs.append({"sequence": sq.get_path_name() if sq else None, "range": [sec.get_start_frame(), sec.get_end_frame()]})
    rep["subsequences"] = subs
json.dump(rep, open(out, "w"), indent=1, default=str)
unreal.log("SSREPORT verify done")
