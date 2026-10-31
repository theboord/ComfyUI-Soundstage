"""Soundstage DCC kit -> Nuke 13+ script: the shot camera and the set geometry, ready to render or project onto.

NOT TESTED IN NUKE. Written against Nuke's Python API; the maths (ZXY rotations, film back) is unit-tested
outside Nuke and matches the Layer Pack's .chan, which Nuke reads natively.

Builds: Camera "shot_cam" keyed every frame from camera.json (rot order ZXY, haperture 36 mm, focal keyed),
ReadGeo of the frame-one OBJ (Nuke's ReadGeo reads OBJ / FBX / Alembic / USD, not glTF), a Scene, and a
ScanlineRender through the camera at the shot's format. Root fps, range and format from shot.json.
Run: Script Editor > File > Source... > build_nuke.py, or:  nuke -t build_nuke.py   (Nuke units = metres, Y up.)
"""
import json
import os

try:
    import nuke
except ImportError:  # imported outside Nuke (tests)
    nuke = None


def apertures(sensor_mm, width, height):
    """(haperture, vaperture) in mm for a horizontal-fit sensor."""
    return sensor_mm, sensor_mm * height / width


def camera_keys(frames):
    """camera.json frames -> [(frame, translate, rotate ZXY deg, focal)]; Nuke's default rot order is ZXY."""
    return [(c["frame"], list(c["position"]), list(c["rotate_zxy_deg"]), c["focal_mm"]) for c in frames]


def find_kit(here=None):
    for cand in [os.environ.get("SOUNDSTAGE_KIT"), os.path.dirname(os.path.dirname(os.path.abspath(here))) if here else None, os.getcwd()]:
        if cand and os.path.exists(os.path.join(cand, "shot.json")):
            return cand
    raise RuntimeError("Soundstage: can't find the kit (shot.json). Set SOUNDSTAGE_KIT to the kit folder.")


def _node(classes, **knobs):
    for name in classes:
        maker = getattr(nuke.nodes, name, None)
        if maker:
            return maker(**knobs)
    raise RuntimeError("Soundstage: none of %s exists in this Nuke" % (classes,))


def main():
    kit = find_kit(globals().get("__file__"))
    with open(os.path.join(kit, "shot.json")) as f:
        shot = json.load(f)
    with open(os.path.join(kit, shot.get("camera_json", "camera.json"))) as f:
        camj = json.load(f)
    W, H = shot["resolution"]
    first, last = shot["frame_start"], shot["frame_end"]
    root = nuke.root()
    fmt = "soundstage_%dx%d" % (W, H)
    nuke.addFormat("%d %d 1 %s" % (W, H, fmt))
    root["format"].setValue(fmt)
    root["fps"].setValue(shot["fps"])
    root["first_frame"].setValue(first)
    root["last_frame"].setValue(last)
    cam = _node(["Camera4", "Camera3", "Camera2", "Camera"], name="shot_cam")
    cam.setXYpos(0, 0)
    ha, va = apertures(camj.get("sensor_width_mm", 36.0), W, H)
    cam["haperture"].setValue(ha)
    cam["vaperture"].setValue(va)
    try:
        cam["rot_order"].setValue("ZXY")
    except Exception:  # noqa: BLE001
        pass
    for k in ("translate", "rotate", "focal"):
        cam[k].setAnimated()
    for frame, t, r, focal in camera_keys(camj["frames"]):
        for i in range(3):
            cam["translate"].setValueAt(t[i], frame, i)
            cam["rotate"].setValueAt(r[i], frame, i)
        cam["focal"].setValueAt(focal, frame)
    scene = _node(["Scene"], name="Soundstage_scene")
    scene.setXYpos(200, 100)
    if shot.get("scene_obj"):
        geo = _node(["ReadGeo2", "ReadGeo"], file=os.path.join(kit, shot["scene_obj"]).replace("\\", "/"), name="Soundstage_set")
        geo.setXYpos(200, 0)
        scene.setInput(0, geo)
    render = _node(["ScanlineRender"], name="Soundstage_render")
    render.setInput(1, scene)
    render.setInput(2, cam)
    render.setXYpos(200, 200)
    viewer = _node(["Viewer"])
    viewer.setInput(0, render)
    print("Soundstage: built %s (%d frames at %s fps) from %s" % (shot["shot"], last - first + 1, shot["fps"], kit))


if nuke is not None:
    main()
