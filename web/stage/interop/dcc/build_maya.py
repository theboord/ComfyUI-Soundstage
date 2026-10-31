"""Soundstage DCC kit -> Maya scene: the set and the animated shot camera.

NOT TESTED IN MAYA. Written against maya.cmds; the maths (units, rotate order, film back, time units) is unit-tested
outside Maya.

  * geometry: scene.glb when a glTF importer plug-in is loaded (it brings the baked moves), else the frame-one OBJ;
    either way it is scaled to the size shot.json records, so it lands right whatever your working units are;
  * shot_cam: keyed every frame from camera.json, rotate order zxy, 36 mm horizontal film back, focal length keyed;
  * fps, playback range and render resolution from shot.json.
Soundstage and Maya are both Y up and right-handed, so no axis change: only metres -> your working unit.
Run: Script Editor (Python tab) > File > Source Script... > build_maya.py
"""
import json
import math
import os

try:
    from maya import cmds
except ImportError:  # imported outside Maya (tests)
    cmds = None

UNIT_PER_M = {"mm": 1000.0, "cm": 100.0, "m": 1.0, "km": 0.001, "in": 1.0 / 0.0254, "ft": 1.0 / 0.3048, "yd": 1.0 / 0.9144}
MM_PER_INCH = 25.4
ROTATE_ORDER_ZXY = 2   # Maya rotateOrder enum: xyz 0, yzx 1, zxy 2, xzy 3, yxz 4, zyx 5


def maya_time_unit(fps):
    named = {24: "film", 25: "pal", 30: "ntsc", 48: "show", 50: "palf", 60: "ntscf", 15: "game"}
    for whole, name in ((24, "23.976fps"), (30, "29.97fps"), (48, "47.952fps"), (60, "59.94fps")):
        if abs(fps - whole / 1.001) < 1e-3:
            return name
    r = int(round(fps))
    if abs(fps - r) < 1e-6:
        return named.get(r, "%dfps" % r)
    return "%gfps" % fps


def unit_scale(linear):
    """Working units per metre (Maya's currentUnit -linear: mm, cm, m, km, in, ft, yd)."""
    return UNIT_PER_M.get(linear, 100.0)


def film_back_inches(sensor_mm, width, height):
    """(horizontal, vertical) film aperture in inches for a horizontal-fit sensor."""
    return sensor_mm / MM_PER_INCH, sensor_mm * height / width / MM_PER_INCH


def camera_keys(frames, s=100.0):
    """camera.json frames -> [{frame, translate (working units), rotate (deg, rotate order zxy), focal}].
    Maya's zxy order applies Z, then X, then Y: R = Ry * Rx * Rz, which is what rotate_zxy_deg holds."""
    return [{"frame": c["frame"], "translate": [v * s for v in c["position"]], "rotate": list(c["rotate_zxy_deg"]),
             "focal": c["focal_mm"]} for c in frames]


def find_kit(here=None):
    for cand in [os.environ.get("SOUNDSTAGE_KIT"), os.path.dirname(os.path.dirname(os.path.abspath(here))) if here else None, os.getcwd()]:
        if cand and os.path.exists(os.path.join(cand, "shot.json")):
            return cand
    raise RuntimeError("Soundstage: can't find the kit (shot.json). Set SOUNDSTAGE_KIT to the kit folder.")


def _gltf_translator():
    try:
        for t in cmds.translator(q=True, list=True) or []:
            if "gltf" in t.lower() or "glb" in t.lower():
                return t
    except Exception:  # noqa: BLE001
        pass
    return None


def _import_geometry(kit, shot, s):
    before = set(cmds.ls(assemblies=True) or [])
    tr = _gltf_translator()
    path = None
    if tr and shot.get("scene_glb"):
        path = os.path.join(kit, shot["scene_glb"])
        cmds.file(path, i=True, type=tr, ignoreVersion=True, namespace="soundstage")
    elif shot.get("scene_obj"):
        path = os.path.join(kit, shot["scene_obj"])
        if not cmds.pluginInfo("objExport", q=True, loaded=True):
            cmds.loadPlugin("objExport")
        cmds.file(path, i=True, type="OBJ", ignoreVersion=True, namespace="soundstage", options="mo=1")
    else:
        cmds.warning("Soundstage: no glTF importer and no OBJ in the kit: geometry skipped")
        return None
    new = [n for n in (cmds.ls(assemblies=True) or []) if n not in before and not cmds.listRelatives(n, shapes=True, type="camera")]
    if not new:
        return None
    grp = cmds.group(new, name="soundstage_set", world=True)
    cmds.xform(grp, pivots=(0, 0, 0), worldSpace=True)
    # Scale to the size Soundstage recorded (OBJ numbers are metres; how Maya reads them depends on the version).
    b = shot.get("bounds_m")
    if b:
        bb = cmds.exactWorldBoundingBox(grp)
        got = max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])
        want = max(b["max"][i] - b["min"][i] for i in range(3)) * s
        if got > 0 and abs(got / want - 1) > 0.01:
            k = want / got
            cmds.scale(k, k, k, grp, absolute=True, pivot=(0, 0, 0))
    print("Soundstage: imported", path)
    return grp


def main():
    kit = find_kit(globals().get("__file__"))
    with open(os.path.join(kit, "shot.json")) as f:
        shot = json.load(f)
    with open(os.path.join(kit, shot.get("camera_json", "camera.json"))) as f:
        camj = json.load(f)
    s = unit_scale(cmds.currentUnit(q=True, linear=True))
    rad = cmds.currentUnit(q=True, angle=True) == "rad"
    cmds.currentUnit(time=maya_time_unit(shot["fps"]))
    first, last = shot["frame_start"], shot["frame_end"]
    cmds.playbackOptions(minTime=first, maxTime=last, animationStartTime=first, animationEndTime=last)
    W, H = shot["resolution"]
    cmds.setAttr("defaultResolution.width", W)
    cmds.setAttr("defaultResolution.height", H)
    cmds.setAttr("defaultResolution.deviceAspectRatio", float(W) / H)
    _import_geometry(kit, shot, s)
    cam, shape = cmds.camera(name="shot_cam")
    hfa, vfa = film_back_inches(camj.get("sensor_width_mm", 36.0), W, H)
    cmds.setAttr(shape + ".horizontalFilmAperture", hfa)
    cmds.setAttr(shape + ".verticalFilmAperture", vfa)
    cmds.setAttr(shape + ".filmFit", 1)   # horizontal
    cmds.setAttr(shape + ".nearClipPlane", 0.05 * s)
    cmds.setAttr(shape + ".farClipPlane", 5000.0 * s)
    cmds.setAttr(cam + ".rotateOrder", ROTATE_ORDER_ZXY)
    for k in camera_keys(camj["frames"], s):
        t = k["frame"]
        for ax, v in zip("XYZ", k["translate"]):
            cmds.setKeyframe(cam, attribute="translate" + ax, time=t, value=v)
        for ax, v in zip("XYZ", k["rotate"]):
            cmds.setKeyframe(cam, attribute="rotate" + ax, time=t, value=math.radians(v) if rad else v)
        cmds.setKeyframe(shape, attribute="focalLength", time=t, value=k["focal"])
    cmds.keyTangent(cam, inTangentType="linear", outTangentType="linear")
    cmds.currentTime(first)
    print("Soundstage: built %s (%d frames at %s fps) from %s" % (shot["shot"], last - first + 1, shot["fps"], kit))


if cmds is not None:
    main()
