"""Soundstage DCC kit -> Unreal Engine 5.x level + Level Sequence.

NOT TESTED IN UNREAL. Written against the UE 5 editor Python API (unreal module); the maths (axes, centimetres,
rotators, frame rates) is unit-tested outside the engine. If a call differs in your engine version, the script says
which step failed and carries on with the rest.

What it does, in the level that is open:
  1. imports scene.glb with Interchange "import into level" (the set, props and actors, with their baked keys);
  2. measures how the importer mapped Soundstage axes into Unreal from the four ss_probe_* markers (Soundstage is
     metres, Y up, right-handed; Unreal is centimetres, Z up, left-handed), falling back to the glTF convention
     UE = (x, z, y) * 100;
  3. spawns a CineCameraActor "shot_cam" with a 36 mm filmback;
  4. builds a Level Sequence at the shot's fps over its frame range with the camera's location, rotation and focal
     length keyed every frame, plus a camera cut.
Run: Tools > Execute Python Script... > build_unreal.py  (Python Editor Script plugin on), or in the Output Log:
     py "<kit>/unreal/build_unreal.py"
"""
import json
import math
import os
import sys

try:
    import unreal
except ImportError:  # imported outside Unreal (tests)
    unreal = None

CM_PER_M = 100.0
# Rows: UE vector = DEFAULT_AXES @ Soundstage vector (metres -> then * 100). glTF / Soundstage (x, y, z) -> UE (x, z, y).
DEFAULT_AXES = ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 1.0, 0.0))


def mat_vec(m, v):
    return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]


def det3(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def snap_axes(m):
    """Round a measured 3x3 to the nearest signed permutation (importers only swap and flip axes)."""
    out = [[0.0] * 3 for _ in range(3)]
    for c in range(3):
        col = [m[r][c] for r in range(3)]
        r = max(range(3), key=lambda i: abs(col[i]))
        out[r][c] = 1.0 if col[r] > 0 else -1.0
    return tuple(tuple(r) for r in out)


def solve_mapping(probe_ue, probes):
    """From probe locations in Unreal (cm) and in Soundstage (m): (axes 3x3, cm per m, origin cm).
    probe_ue / probes: {"ss_probe_o": (x, y, z), "ss_probe_x": ..., "ss_probe_y": ..., "ss_probe_z": ...}."""
    o = probe_ue["ss_probe_o"]
    cols, lens = [], []
    for name in ("ss_probe_x", "ss_probe_y", "ss_probe_z"):
        d_stage = [probes[name][i] - probes["ss_probe_o"][i] for i in range(3)]
        n = math.sqrt(sum(v * v for v in d_stage)) or 1.0
        e = [(probe_ue[name][i] - o[i]) / n for i in range(3)]
        lens.append(math.sqrt(sum(v * v for v in e)))
        cols.append(e)
    scale = sum(lens) / 3.0
    m = [[cols[c][r] / (scale or 1.0) for c in range(3)] for r in range(3)]
    axes = snap_axes(m)
    origin = [o[i] - scale * mat_vec(axes, probes["ss_probe_o"])[i] for i in range(3)]
    return axes, scale, origin


def to_ue_point(p, axes=DEFAULT_AXES, scale=CM_PER_M, origin=(0.0, 0.0, 0.0)):
    v = mat_vec(axes, p)
    return [v[i] * scale + origin[i] for i in range(3)]


def rotator_from_xz(fwd, up):
    """UE FRotator (roll, pitch, yaw) in degrees whose X axis is fwd and Z axis is (up, made orthogonal).
    Uses FRotationMatrix: X = (cp*cy, cp*sy, sp), Y = (sr*sp*cy - cr*sy, sr*sp*sy + cr*cy, -sr*cp),
    Z = (-(cr*sp*cy + sr*sy), cy*sr - cr*sp*sy, cr*cp)."""
    def norm(a):
        n = math.sqrt(sum(v * v for v in a)) or 1.0
        return [v / n for v in a]

    def cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    X = norm(fwd)
    Y = norm(cross(up, X))
    Z = cross(X, Y)
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, X[2]))))
    yaw = math.degrees(math.atan2(X[1], X[0]))
    roll = math.degrees(math.atan2(-Y[2], Z[2]))
    return roll, pitch, yaw


def rotation_matrix(roll, pitch, yaw):
    """Rows X, Y, Z of FRotationMatrix(FRotator(pitch, yaw, roll)) (the inverse of rotator_from_xz)."""
    sp, cp = math.sin(math.radians(pitch)), math.cos(math.radians(pitch))
    sy, cy = math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
    sr, cr = math.sin(math.radians(roll)), math.cos(math.radians(roll))
    return ([cp * cy, cp * sy, sp],
            [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
            [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp])


def unwrap(prev, a):
    if prev is None:
        return a
    while a - prev > 180:
        a -= 360
    while a - prev < -180:
        a += 360
    return a


def camera_keys(frames, axes=DEFAULT_AXES, scale=CM_PER_M, origin=(0.0, 0.0, 0.0)):
    """camera.json frames -> [{frame, location (cm), rotation (roll, pitch, yaw), focal_mm}] in Unreal space.
    A Soundstage camera looks down its -Z with +Y up; an Unreal camera looks down +X with +Z up."""
    out, prev = [], (None, None, None)
    for c in frames:
        m = c["cam_to_world"]
        pos = [m[0][3], m[1][3], m[2][3]]
        fwd = [-m[0][2], -m[1][2], -m[2][2]]
        up = [m[0][1], m[1][1], m[2][1]]
        r, p, y = rotator_from_xz(mat_vec(axes, fwd), mat_vec(axes, up))
        r, p, y = unwrap(prev[0], r), unwrap(prev[1], p), unwrap(prev[2], y)
        prev = (r, p, y)
        out.append({"frame": c["frame"], "location": to_ue_point(pos, axes, scale, origin), "rotation": [r, p, y],
                    "focal_mm": c["focal_mm"]})
    return out


def frame_rate(fps):
    """(numerator, denominator) for unreal.FrameRate: 23.976 -> (24000, 1001), 24 -> (24, 1)."""
    for whole in (24, 30, 48, 60, 120):
        if abs(fps - whole / 1.001) < 1e-3:
            return whole * 1000, 1001
    if abs(fps - round(fps)) < 1e-6:
        return int(round(fps)), 1
    return int(round(fps * 1000)), 1000


def find_kit(here=None):
    for cand in [os.environ.get("SOUNDSTAGE_KIT"), os.path.dirname(os.path.dirname(os.path.abspath(here))) if here else None, os.getcwd()]:
        if cand and os.path.exists(os.path.join(cand, "shot.json")):
            return cand
    raise RuntimeError("Soundstage: can't find the kit (shot.json). Set SOUNDSTAGE_KIT to the kit folder.")


# ---------------------------------------------------------------- inside Unreal

def _step(name, fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except Exception as e:  # noqa: BLE001 - report and carry on
        unreal.log_warning("Soundstage: %s failed: %s" % (name, e))
        return None


def _actors():
    try:
        return unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
    except Exception:  # noqa: BLE001
        return unreal.EditorLevelLibrary.get_all_level_actors()


def _spawn(cls, loc, rot):
    try:
        return unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_class(cls, loc, rot)
    except Exception:  # noqa: BLE001
        return unreal.EditorLevelLibrary.spawn_actor_from_class(cls, loc, rot)


def import_glb(path, dest):
    mgr = unreal.InterchangeManager.get_interchange_manager_scripted()
    source = unreal.InterchangeManager.create_source_data(path)
    params = unreal.ImportAssetParameters()
    params.is_automated = True
    res = mgr.import_scene(dest, source, params)
    return res


def import_glb_assets(path, dest):
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", path)
    task.set_editor_property("destination_path", dest)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    task.set_editor_property("replace_existing", True)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return task.get_editor_property("imported_object_paths")


def probe_locations():
    found = {}
    for a in _actors():
        label = a.get_actor_label()
        for name in ("ss_probe_o", "ss_probe_x", "ss_probe_y", "ss_probe_z"):
            if name in label and name not in found:
                loc = a.get_actor_location()
                found[name] = ((loc.x, loc.y, loc.z), a)
    return found


def build_sequence(shot, keys, cam_actor, dest):
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    name = "SEQ_" + "".join(ch if ch.isalnum() else "_" for ch in shot["shot"])
    seq = tools.create_asset(name, dest, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    num, den = frame_rate(shot["fps"])
    seq.set_display_rate(unreal.FrameRate(num, den))
    first, last = shot["frame_start"], shot["frame_end"]
    seq.set_playback_start(first)
    seq.set_playback_end(last + 1)
    binding = seq.add_possessable(cam_actor)
    tr = binding.add_track(unreal.MovieScene3DTransformTrack)
    sec = tr.add_section()
    sec.set_range(first, last + 1)
    chans = sec.get_all_channels() if hasattr(sec, "get_all_channels") else sec.get_channels()
    for k in keys:
        t = unreal.FrameNumber(k["frame"])
        for i in range(3):
            chans[i].add_key(t, k["location"][i])
        roll, pitch, yaw = k["rotation"]
        chans[3].add_key(t, roll)
        chans[4].add_key(t, pitch)
        chans[5].add_key(t, yaw)
    comp_binding = seq.add_possessable(cam_actor.get_cine_camera_component())
    ft = comp_binding.add_track(unreal.MovieSceneFloatTrack)
    ft.set_property_name_and_path("Current Focal Length", "CurrentFocalLength")
    fs = ft.add_section()
    fs.set_range(first, last + 1)
    fch = (fs.get_all_channels() if hasattr(fs, "get_all_channels") else fs.get_channels())[0]
    for k in keys:
        fch.add_key(unreal.FrameNumber(k["frame"]), k["focal_mm"])
    try:
        cut = seq.add_track(unreal.MovieSceneCameraCutTrack)
    except Exception:  # noqa: BLE001 - UE 5.0 / 5.1
        cut = seq.add_master_track(unreal.MovieSceneCameraCutTrack)
    cs = cut.add_section()
    cs.set_range(first, last + 1)
    try:
        bid = seq.get_binding_id(binding)
    except Exception:  # noqa: BLE001
        bid = seq.make_binding_id(binding, unreal.MovieSceneObjectBindingSpace.LOCAL)
    cs.set_camera_binding_id(bid)
    unreal.EditorAssetLibrary.save_loaded_asset(seq)
    return seq


def main():
    kit = find_kit(globals().get("__file__"))
    with open(os.path.join(kit, "shot.json")) as f:
        shot = json.load(f)
    with open(os.path.join(kit, shot.get("camera_json", "camera.json"))) as f:
        camj = json.load(f)
    dest = "/Game/Soundstage/" + "".join(ch if ch.isalnum() else "_" for ch in shot["shot"])
    glb = os.path.join(kit, shot["scene_glb"])
    ok = _step("import scene.glb into the level (Interchange)", import_glb, glb, dest)
    if not ok:
        _step("import scene.glb as assets", import_glb_assets, glb, dest)
        unreal.log_warning("Soundstage: the GLB came in as assets only; drag them into the level at the origin.")
    axes, scale, origin = DEFAULT_AXES, CM_PER_M, [0.0, 0.0, 0.0]
    probes = _step("find the axis probes", probe_locations) or {}
    if len(probes) == 4:
        axes, scale, origin = solve_mapping({k: v[0] for k, v in probes.items()}, shot["probes"])
        if det3(axes) > 0:
            unreal.log_warning("Soundstage: the probes say the import kept handedness; check the camera against the set.")
        unreal.log("Soundstage: measured axes %s, %.3f cm per m, origin %s" % (axes, scale, origin))
        for _, (_, actor) in probes.items():
            _step("remove a probe", actor.destroy_actor)
    else:
        unreal.log_warning("Soundstage: axis probes not found; using the glTF convention UE = (x, z, y) * 100")
    keys = camera_keys(camj["frames"], axes, scale, origin)
    k0 = keys[0]
    cam = _spawn(unreal.CineCameraActor, unreal.Vector(*k0["location"]), unreal.Rotator(k0["rotation"][0], k0["rotation"][1], k0["rotation"][2]))
    cam.set_actor_label("shot_cam")
    comp = cam.get_cine_camera_component()
    W, H = shot["resolution"]
    fb = comp.get_editor_property("filmback")
    fb.set_editor_property("sensor_width", shot.get("sensor_width_mm", 36.0))
    fb.set_editor_property("sensor_height", shot.get("sensor_width_mm", 36.0) * H / W)
    comp.set_editor_property("filmback", fb)
    lens = comp.get_editor_property("lens_settings")
    lens.set_editor_property("min_focal_length", min(4.0, min(k["focal_mm"] for k in keys)))
    lens.set_editor_property("max_focal_length", max(1000.0, max(k["focal_mm"] for k in keys)))
    comp.set_editor_property("lens_settings", lens)
    comp.set_editor_property("current_focal_length", k0["focal_mm"])
    _step("turn depth of field off", lambda: comp.get_editor_property("focus_settings").set_editor_property("focus_method", unreal.CameraFocusMethod.DISABLE))
    seq = _step("build the Level Sequence", build_sequence, shot, keys, cam, dest)
    unreal.log("Soundstage: built %s (%d frames at %s fps)%s" % (shot["shot"], len(keys), shot["fps"], " -> " + seq.get_path_name() if seq else ""))


if unreal is not None:
    main()
