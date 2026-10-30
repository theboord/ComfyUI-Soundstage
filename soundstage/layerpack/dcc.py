"""Camera files and app builders: camera.json, Nuke .chan, After Effects .jsx, Blender .py,
Nuke .py and an OTIO timeline.

Every writer takes the same `ctx` dict that export.py builds:
  shot, fps, frame_start, frames (count), width, height, sensor_w, notes, root (abs pack dir),
  camera: [per-frame dicts from camera.build_frames] (may be empty),
  layers: [{name, kind, z, blend_mode, png (rel pattern with ####), png_first (rel),
            matte (rel pattern), mov (rel or None), depth_m}] sorted bottom (lowest z) first.

Cards: each layer is also placed as a card at its depth_m in front of the FIRST frame's camera,
sized depth * W / fx so it exactly fills frame 1. The cards stay put in the world while the camera
moves, which gives true 2.5D parallax in AE, Blender and Nuke.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np

AE_PX_PER_M = 100.0  # After Effects works in pixels; 1 m of stage = 100 px of AE space


def _json(obj) -> str:
    return json.dumps(obj, indent=1)


def _card_pose(ctx: dict, depth_m: float) -> tuple[list[float], float]:
    """World position of a frame-filling card at depth_m in front of the frame-1 camera, and its width (m)."""
    f0 = ctx["camera"][0]
    m = np.asarray(f0["cam_to_world"])
    pos = m[:3, 3] - m[:3, 2] * depth_m          # camera looks down local -Z
    return [float(v) for v in pos], depth_m * ctx["width"] / f0["fx_px"]


# ---------------------------------------------------------------- camera.json / .chan

def write_camera_json(path: str, ctx: dict) -> None:
    with open(path, "w") as f:
        f.write(_json({
            "convention": "world Y-up right-handed, metres; camera looks down its local -Z, +Y up; "
                          "cam_to_world is row-major 4x4",
            "sensor_width_mm": ctx["sensor_w"],
            "resolution": [ctx["width"], ctx["height"]],
            "fps": ctx["fps"],
            "frame_start": ctx["frame_start"],
            "frame_end": ctx["frame_start"] + ctx["frames"] - 1,
            "nuke_rot_order": "ZXY",
            "after_effects_zoom_px": "fx_px (comp width = image width)",
            "blender_lens_mm": "focal_mm with sensor_fit HORIZONTAL, sensor_width 36",
            "frames": ctx["camera"],
        }))


def write_chan(path: str, ctx: dict) -> None:
    """Nuke/Maya .chan: frame tx ty tz rx ry rz vfov. Import into a Camera with rot_order ZXY."""
    with open(path, "w") as f:
        for c in ctx["camera"]:
            tx, ty, tz = c["position"]
            rx, ry, rz = c["rotate_zxy_deg"]
            f.write(f"{c['frame']}\t{tx:.6f}\t{ty:.6f}\t{tz:.6f}\t{rx:.6f}\t{ry:.6f}\t{rz:.6f}\t{c['vfov_deg']:.6f}\n")


# ---------------------------------------------------------------- After Effects

_AE_JSX = r"""// Soundstage Layer Pack -> After Effects comp with every layer and the staged 3D camera.
// After Effects: File > Scripts > Run Script File... and pick this file (keep it inside the pack).
(function () {
var PACK = __PACK__;
var root = new File($.fileName).parent.parent.parent; // <pack>/dcc/ae/build_comp.jsx -> <pack>
app.beginUndoGroup("Soundstage Layer Pack " + PACK.shot);
var fps = PACK.fps, W = PACK.width, H = PACK.height;
var folder = app.project.items.addFolder("Soundstage " + PACK.shot);
var comp = app.project.items.addComp(PACK.shot, W, H, 1, PACK.frames / fps, fps);
comp.parentFolder = folder;
try { comp.displayStartFrame = PACK.frame_start; } catch (e) {}
var modes = { multiply: BlendingMode.MULTIPLY, screen: BlendingMode.SCREEN, add: BlendingMode.ADD };
var missing = [];
for (var i = 0; i < PACK.layers.length; i++) {           // bottom first; layers.add puts each on top
  var Lp = PACK.layers[i];
  var f = new File(root.fsName + "/" + Lp.png_first);
  if (!f.exists) { missing.push(Lp.png_first); continue; }
  var io = new ImportOptions(f);
  io.sequence = PACK.frames > 1;
  var item = app.project.importFile(io);
  item.parentFolder = folder;
  item.name = Lp.name;
  if (io.sequence) item.mainSource.conformFrameRate = fps;
  try { item.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (e) {}
  var L = comp.layers.add(item);
  L.name = Lp.name;
  L.startTime = 0;
  if (modes[Lp.blend_mode]) L.blendingMode = modes[Lp.blend_mode];
  if (PACK.cards) {
    var c = PACK.cards[i];
    L.threeDLayer = true;
    L.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;   // card always faces the camera
    L.property("ADBE Transform Group").property("ADBE Position").setValue(c.position);
    L.property("ADBE Transform Group").property("ADBE Scale").setValue([c.scale, c.scale, 100]);
  }
}
if (PACK.camera) {
  var cam = comp.layers.addCamera("shot_cam", [W / 2, H / 2]);
  cam.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;   // two-node camera: position + POI
  var T = cam.property("ADBE Transform Group");
  T.property("ADBE Position").setValuesAtTimes(PACK.camera.times, PACK.camera.position);
  T.property("ADBE Anchor Point").setValuesAtTimes(PACK.camera.times, PACK.camera.poi);
  cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValuesAtTimes(PACK.camera.times, PACK.camera.zoom);
  try { cam.property("ADBE Camera Options Group").property("ADBE Camera Depth of Field").setValue(0); } catch (e) {}
}
if (PACK.notes) comp.markerProperty.setValueAtTime(0, new MarkerValue(PACK.notes));
comp.openInViewer();
app.endUndoGroup();
if (missing.length) alert("Soundstage: missing files (is this script still inside the pack?)\n" + missing.join("\n"));
})();
"""


def write_ae_jsx(path: str, ctx: dict) -> None:
    W, H, s = ctx["width"], ctx["height"], AE_PX_PER_M

    def ae(p):  # Y-up metres -> AE pixels (Y down, +Z into the screen)
        return [round(W / 2 + s * p[0], 4), round(H / 2 - s * p[1], 4), round(-s * p[2], 4)]

    pack = {"shot": ctx["shot"], "fps": ctx["fps"], "width": W, "height": H, "frames": ctx["frames"],
            "frame_start": ctx["frame_start"], "notes": ctx.get("notes", ""),
            "layers": [{"name": l["name"], "png_first": l["png_first"], "blend_mode": l["blend_mode"]}
                       for l in ctx["layers"]], "camera": None, "cards": None}
    if ctx["camera"]:
        cams = ctx["camera"]
        pack["camera"] = {
            "times": [round(i / ctx["fps"], 6) for i in range(len(cams))],
            "position": [ae(c["position"]) for c in cams],
            "poi": [ae(c["target"]) for c in cams],
            "zoom": [round(c["fx_px"], 4) for c in cams],
        }
        cards = []
        for l in ctx["layers"]:
            pos, _ = _card_pose(ctx, l["depth_m"])
            cards.append({"position": ae(pos), "scale": round(s * l["depth_m"] / cams[0]["fx_px"] * 100, 4)})
        pack["cards"] = cards
    with open(path, "w") as f:
        f.write(_AE_JSX.replace("__PACK__", json.dumps(pack)))


# ---------------------------------------------------------------- Blender

_BLENDER_PY = r'''"""Soundstage Layer Pack -> Blender scene: the staged camera (keyframed) and one image-sequence
card per layer at its depth, so you can relight, re-camera or add 3D elements.
Run:  blender --python build_blender_scene.py   (or open it in the Scripting tab and press Run).
"""
import json
import math
import os

import bpy
from mathutils import Matrix

PACK = json.loads(r"""__PACK__""")


def pack_root():
    here = globals().get("__file__") or ""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(here)))) if here else ""
    if root and os.path.exists(os.path.join(root, "manifest.json")):
        return root
    return PACK["root"]  # where it was exported


ROOT = pack_root()
Y_UP_TO_Z_UP = Matrix.Rotation(math.radians(90.0), 4, "X")

scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = PACK["width"], PACK["height"]
scene.render.resolution_percentage = 100
fps = PACK["fps"]
scene.render.fps = int(math.ceil(fps))
scene.render.fps_base = scene.render.fps / fps
scene.frame_start = PACK["frame_start"]
scene.frame_end = PACK["frame_start"] + PACK["frames"] - 1
scene.frame_current = scene.frame_start

coll = bpy.data.collections.new("Soundstage_" + PACK["shot"])
scene.collection.children.link(coll)

cam_obj = None
if PACK["camera"]:
    cam_data = bpy.data.cameras.new("shot_cam")
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = PACK["sensor_w"]
    cam_data.clip_end = 1000.0
    cam_obj = bpy.data.objects.new("shot_cam", cam_data)
    coll.objects.link(cam_obj)
    scene.camera = cam_obj
    prev = None
    for c in PACK["camera"]:
        cam_obj.matrix_world = Y_UP_TO_Z_UP @ Matrix(c["cam_to_world"])
        if prev is not None:
            cam_obj.rotation_euler = cam_obj.matrix_world.to_euler("XYZ", prev)
        prev = cam_obj.rotation_euler.copy()
        cam_obj.keyframe_insert("location", frame=c["frame"])
        cam_obj.keyframe_insert("rotation_euler", frame=c["frame"])
        cam_data.lens = c["focal_mm"]
        cam_data.keyframe_insert("lens", frame=c["frame"])


def card_material(layer):
    mat = bpy.data.materials.new("mat_" + layer["name"])
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    emit = nt.nodes.new("ShaderNodeEmission")
    tex = nt.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(os.path.join(ROOT, layer["png_first"]), check_existing=True)
    img.alpha_mode = "STRAIGHT"
    if PACK["frames"] > 1:
        img.source = "SEQUENCE"
        tex.image_user.frame_duration = PACK["frames"]
        tex.image_user.frame_start = PACK["frame_start"]
        tex.image_user.frame_offset = PACK["frame_start"] - 1   # files are numbered from frame_start
        tex.image_user.use_auto_refresh = True
    tex.image = img
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(mat, attr, val)
        except (AttributeError, TypeError):
            pass
    return mat


for layer in PACK["layers"]:
    if not os.path.exists(os.path.join(ROOT, layer["png_first"])):
        print("Soundstage: missing", layer["png_first"])
        continue
    w, h = layer["card_size"]
    mesh = bpy.data.meshes.new("card_" + layer["name"])
    mesh.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
    mesh.uv_layers.new(name="UVMap")
    for loop, uv in zip(mesh.uv_layers[0].data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = uv
    mesh.materials.append(card_material(layer))
    obj = bpy.data.objects.new(layer["name"], mesh)
    coll.objects.link(obj)
    if layer.get("card_matrix"):
        obj.matrix_world = Y_UP_TO_Z_UP @ Matrix(layer["card_matrix"])
    obj["soundstage_z"] = layer["z"]
    obj["soundstage_depth_m"] = layer["depth_m"]

print("Soundstage: built", PACK["shot"], "from", ROOT)
'''


def write_blender_py(path: str, ctx: dict) -> None:
    W, H = ctx["width"], ctx["height"]
    layers = []
    for l in ctx["layers"]:
        entry = {"name": l["name"], "png_first": l["png_first"], "z": l["z"], "depth_m": l["depth_m"]}
        if ctx["camera"]:
            pos, card_w = _card_pose(ctx, l["depth_m"])
            m = np.array(ctx["camera"][0]["cam_to_world"], dtype=np.float64)
            m[:3, 3] = pos
            entry["card_matrix"] = [[round(float(v), 9) for v in row] for row in m]
            entry["card_size"] = [card_w, card_w * H / W]
        else:  # no camera: stack cards along -Y at their depth, 1 m wide per metre of depth
            entry["card_size"] = [l["depth_m"] * 36.0 / 35.0, l["depth_m"] * 36.0 / 35.0 * H / W]
        layers.append(entry)
    pack = {"shot": ctx["shot"], "fps": ctx["fps"], "frame_start": ctx["frame_start"], "frames": ctx["frames"],
            "width": W, "height": H, "sensor_w": ctx["sensor_w"], "root": ctx["root"],
            "camera": [{"frame": c["frame"], "focal_mm": c["focal_mm"], "cam_to_world": c["cam_to_world"]}
                       for c in ctx["camera"]],
            "layers": layers}
    with open(path, "w") as f:
        f.write(_BLENDER_PY.replace("__PACK__", json.dumps(pack)))


# ---------------------------------------------------------------- Nuke (Python builder)

_NUKE_PY = r'''"""Soundstage Layer Pack -> Nuke script.
Run in Nuke's Script Editor (File > Source... or paste), or:  nuke -t build_nuke.py
Builds: Read (straight PNG) -> Premult per layer, merged over each other bottom-up (2D comp),
plus a Camera keyed from the stage and one Card per layer at its depth -> ScanlineRender (2.5D).
"""
import json
import os

import nuke

PACK = json.loads(r"""__PACK__""")
here = globals().get("__file__") or ""
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(here)))) if here else PACK["root"]
if not os.path.exists(os.path.join(ROOT, "manifest.json")):
    ROOT = PACK["root"]

first, last = PACK["frame_start"], PACK["frame_start"] + PACK["frames"] - 1
root = nuke.root()
fmt_name = "soundstage_%dx%d" % (PACK["width"], PACK["height"])
nuke.addFormat("%d %d 1 %s" % (PACK["width"], PACK["height"], fmt_name))
root["format"].setValue(fmt_name)
root["fps"].setValue(PACK["fps"])
root["first_frame"].setValue(first)
root["last_frame"].setValue(last)


def node(cls, **knobs):
    for name in ([cls] if isinstance(cls, str) else cls):
        maker = getattr(nuke.nodes, name, None)
        if maker:
            return maker(**knobs)
    raise RuntimeError("No node class among %s" % (cls,))


comp, reads = None, []
for i, L in enumerate(PACK["layers"]):          # bottom first
    path = os.path.join(ROOT, L["png"]).replace("\\", "/")
    r = node("Read", file=path, first=first, last=last, origfirst=first, origlast=last, name="Read_" + L["name"])
    r["origset"].setValue(True)
    r.setXYpos(i * 150, 0)
    p = node("Premult", name="Premult_" + L["name"])
    p.setInput(0, r)
    p.setXYpos(i * 150, 100)
    reads.append(p)
    if comp is None:
        comp = p
        continue
    op = {"multiply": "multiply", "screen": "screen", "add": "plus"}.get(L["blend_mode"], "over")
    m = node("Merge2", operation=op, name="Merge_" + L["name"])
    m.setInput(0, comp)   # B = everything below
    m.setInput(1, p)      # A = this layer
    m.setXYpos(0, 200 + i * 60)
    comp = m

if PACK["camera"]:
    cam = node(["Camera2", "Camera3", "Camera"], name="shot_cam")
    cam.setXYpos(-200, 300)
    cam["haperture"].setValue(PACK["sensor_w"])
    cam["vaperture"].setValue(PACK["sensor_w"] * PACK["height"] / PACK["width"])
    for k in ("translate", "rotate", "focal"):
        cam[k].setAnimated()
    for c in PACK["camera"]:
        for idx in range(3):
            cam["translate"].setValueAt(c["position"][idx], c["frame"], idx)
            cam["rotate"].setValueAt(c["rotate_zxy_deg"][idx], c["frame"], idx)
        cam["focal"].setValueAt(c["focal_mm"], c["frame"])
    scene = node(["Scene"], name="Soundstage_cards")
    for i, (L, p) in enumerate(zip(PACK["layers"], reads)):
        card = node(["Card2", "Card"], name="Card_" + L["name"])
        card.setInput(0, p)
        card["translate"].setValue(L["card_translate"])
        card["rotate"].setValue(PACK["camera"][0]["rotate_zxy_deg"])
        card["uniform_scale"].setValue(L["card_width"])
        card.setXYpos(i * 150, 400)
        scene.setInput(i, card)
    scene.setXYpos(0, 500)
    sr = node(["ScanlineRender"], name="Render_2p5D")
    sr.setInput(1, scene)
    sr.setInput(2, cam)
    sr.setXYpos(0, 600)

if comp is not None:
    v = node("Viewer")
    v.setInput(0, comp)
print("Soundstage: built %s from %s" % (PACK["shot"], ROOT))
'''


def write_nuke_py(path: str, ctx: dict) -> None:
    layers = []
    for l in ctx["layers"]:
        e = {"name": l["name"], "png": l["png"], "blend_mode": l["blend_mode"]}
        if ctx["camera"]:
            pos, w = _card_pose(ctx, l["depth_m"])
            e["card_translate"], e["card_width"] = pos, w   # Nuke cards are 1 unit wide
        layers.append(e)
    pack = {"shot": ctx["shot"], "fps": ctx["fps"], "frame_start": ctx["frame_start"], "frames": ctx["frames"],
            "width": ctx["width"], "height": ctx["height"], "sensor_w": ctx["sensor_w"], "root": ctx["root"],
            "camera": [{"frame": c["frame"], "position": c["position"], "rotate_zxy_deg": c["rotate_zxy_deg"],
                        "focal_mm": c["focal_mm"]} for c in ctx["camera"]],
            "layers": layers}
    with open(path, "w") as f:
        f.write(_NUKE_PY.replace("__PACK__", json.dumps(pack)))


# ---------------------------------------------------------------- OTIO (Resolve, Premiere, Avid via adapters)

def _rt(v, rate):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": float(rate), "value": float(v)}


def _tr(start, dur, rate):
    return {"OTIO_SCHEMA": "TimeRange.1", "duration": _rt(dur, rate), "start_time": _rt(start, rate)}


def write_otio(path: str, ctx: dict) -> None:
    """One video track per layer, bottom track = lowest z. Written as plain JSON (no library needed)."""
    rate, start, n = float(ctx["fps"]), ctx["frame_start"], ctx["frames"]
    tracks = []
    for l in ctx["layers"]:
        if l.get("mov"):
            ref = {"OTIO_SCHEMA": "ExternalReference.1", "metadata": {"soundstage": {"relative_path": l["mov"]}},
                   "name": l["name"], "available_range": _tr(start, n, rate), "available_image_bounds": None,
                   "target_url": os.path.join(ctx["root"], l["mov"])}
        else:
            folder, fname = os.path.split(l["png"])
            prefix = fname.split("####")[0]
            ref = {"OTIO_SCHEMA": "ImageSequenceReference.1", "metadata": {"soundstage": {"relative_path": l["png"]}},
                   "name": l["name"], "available_range": _tr(start, n, rate), "available_image_bounds": None,
                   "target_url_base": os.path.join(ctx["root"], folder) + "/", "name_prefix": prefix,
                   "name_suffix": ".png", "start_frame": start, "frame_step": 1, "rate": rate,
                   "frame_zero_padding": 4, "missing_frame_policy": "error"}
        clip = {"OTIO_SCHEMA": "Clip.2",
                "metadata": {"soundstage": {"z": l["z"], "kind": l["kind"], "blend_mode": l["blend_mode"],
                                            "depth_m": l["depth_m"], "alpha": "straight",
                                            "matte": l["matte"]}},
                "name": l["name"], "source_range": _tr(start, n, rate), "effects": [], "markers": [],
                "enabled": True, "color": None,
                "media_references": {"DEFAULT_MEDIA": ref}, "active_media_reference_key": "DEFAULT_MEDIA"}
        tracks.append({"OTIO_SCHEMA": "Track.1", "metadata": {}, "name": l["name"], "source_range": None,
                       "effects": [], "markers": [], "enabled": True, "color": None,
                       "children": [clip], "kind": "Video"})
    markers = []
    if ctx.get("notes"):
        markers.append({"OTIO_SCHEMA": "Marker.2", "metadata": {}, "name": "Soundstage note", "color": "RED",
                        "marked_range": _tr(0, 1, rate), "comment": ctx["notes"]})
    timeline = {"OTIO_SCHEMA": "Timeline.1", "metadata": {"soundstage": {"shot": ctx["shot"]}},
                "name": ctx["shot"], "global_start_time": _rt(round(3600 * rate), rate),
                "tracks": {"OTIO_SCHEMA": "Stack.1", "metadata": {}, "name": "tracks", "source_range": None,
                           "effects": [], "markers": markers, "enabled": True, "color": None, "children": tracks}}
    with open(path, "w") as f:
        f.write(_json(timeline))
