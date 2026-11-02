"""Synthetic Video -> Stage benchmark clips with an exact 3D answer (Blender 5.x, headless).

  Blender --background --factory-startup --python tools/v2s_bench/blender_synth.py -- <scene> <out_dir>
          [--frames N] [--res 1280x720] [--samples 24] [--engine eevee|cycles] [--only-gt] [--every K]

<scene>: interior  cluttered living room, two people (one walks in and sits down, one gestures, reaches up to a shelf,
                   walks over and picks a box up off the coffee table); handheld camera with roll.
         street    street corner (poles, signs, bins, benches, parked cars, trees, kerbs, building fronts); a car drives
                   up and turns right; a pedestrian walks and talks on a phone, one sits on a bench; dolly + pan.
         drone     drone-height push over a four-lane road with traffic both ways, a cyclist (rider), pedestrians,
                   street furniture.

Writes into <out_dir>:
  color/0000.png ...   the clip's frames (EEVEE or Cycles), and source.mp4 if ffmpeg is on PATH
  id/0000.png ...      ID pass (Workbench, flat object colours, no anti-aliasing; truth.json id_palette maps colours)
  truth.json           schema v2s-bench/1: per-frame camera (stage axes), every object (OBB, yaw, colour, class),
                       every person's COCO-18 joints per frame. Stage axes: metres, Y up, ground y = 0; Blender
                       (x, y, z) -> stage (x, z, -y); things built facing Blender -Y face stage +Z (rotation_deg 0).

People are rigged mannequins with the clay figure's proportions (web/stage/humans.mjs: hips 0.9 s, knees 0.455 s,
ankle 0.42 s below the knee, shoulders 1.47 s, head centre 1.67 s; s = height / 1.8), driven by IK on planned
footsteps (planted feet do not slide), so joints and foot contacts are exact.
"""
import json
import math
import os
import random
import subprocess
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SCENE = argv[0] if argv else "interior"
OUT = os.path.abspath(argv[1] if len(argv) > 1 else os.path.join(os.getcwd(), f"synth_{SCENE}"))


def _opt(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


RES = [int(v) for v in _opt("--res", "1280x720").split("x")]
SAMPLES = int(_opt("--samples", "24"))
ENGINE = _opt("--engine", "eevee")
ONLY_GT = "--only-gt" in argv
EVERY = int(_opt("--every", "1"))
FPS = 24
NFRAMES = int(_opt("--frames", {"interior": 145, "street": 121, "drone": 121}.get(SCENE, 121)))
os.makedirs(OUT, exist_ok=True)
rng = random.Random(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
SC = bpy.context.scene
SC.render.fps = FPS
SC.frame_start, SC.frame_end = 0, NFRAMES - 1
SC.unit_settings.system = "METRIC"
SC.render.resolution_x, SC.render.resolution_y = RES
SC.render.resolution_percentage = 100

M_STAGE = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))   # Blender -> stage


def to_stage(v):
    v = M_STAGE @ Vector(v)
    return [round(v.x, 4), round(v.y, 4), round(v.z, 4)]


# ------------------------------------------------------------------------------------------------ materials
def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


MATS = {}


def mat(name, base, kind="plain", base2=None, scale=6.0, rough=0.6, metal=0.0, bump=0.15, emit=0.0):
    """A Principled material whose colour varies with a procedural texture in object space (detail to track)."""
    key = (name, base, kind, base2, scale, rough, metal, bump, emit)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    c1 = [_srgb_to_lin(v) for v in hexrgb(base)] + [1]
    c2 = [_srgb_to_lin(v) for v in hexrgb(base2 or base)] + [1]
    if base2 is None:
        c2 = [max(0.0, v * 0.72) for v in c1[:3]] + [1]
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    m["albedo"] = base
    if kind == "plain":
        bsdf.inputs["Base Color"].default_value = c1
    else:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale, scale)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        if kind == "brick":
            mp.inputs["Rotation"].default_value = (math.pi / 2, 0, 0)   # facades face local -Y: bricks run in X and Z
            tx = nt.nodes.new("ShaderNodeTexBrick")
            tx.inputs["Color1"].default_value = c1
            tx.inputs["Color2"].default_value = c2
            tx.inputs["Mortar"].default_value = (0.62, 0.6, 0.56, 1)
            tx.inputs["Scale"].default_value = 1.0
            tx.inputs["Mortar Size"].default_value = 0.015
            tx.inputs["Brick Width"].default_value = 0.5
            tx.inputs["Row Height"].default_value = 0.25
            nt.links.new(mp.outputs["Vector"], tx.inputs["Vector"])
            nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
            fac = tx.outputs["Fac"]
        elif kind == "tiles":
            tx = nt.nodes.new("ShaderNodeTexBrick")
            tx.inputs["Color1"].default_value = c1
            tx.inputs["Color2"].default_value = c2
            tx.inputs["Mortar"].default_value = [v * 0.6 for v in c1[:3]] + [1]
            tx.inputs["Scale"].default_value = 1.0
            tx.inputs["Mortar Size"].default_value = 0.02
            tx.inputs["Brick Width"].default_value = 0.6
            tx.inputs["Row Height"].default_value = 0.6
            tx.offset = 0.0
            nt.links.new(mp.outputs["Vector"], tx.inputs["Vector"])
            nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
            fac = tx.outputs["Fac"]
        else:
            if kind == "wood":
                tx = nt.nodes.new("ShaderNodeTexWave")
                tx.inputs["Scale"].default_value = 2.0
                tx.inputs["Distortion"].default_value = 6.0
                tx.inputs["Detail"].default_value = 3.0
            elif kind in ("leaf", "speckle"):
                tx = nt.nodes.new("ShaderNodeTexVoronoi")
                tx.inputs["Scale"].default_value = 3.0
            elif kind == "checker":
                tx = nt.nodes.new("ShaderNodeTexChecker")
                tx.inputs["Scale"].default_value = 1.0
                tx.inputs["Color1"].default_value = c1
                tx.inputs["Color2"].default_value = c2
            else:   # noise: fabric, plaster, asphalt, paint, grass, skin
                tx = nt.nodes.new("ShaderNodeTexNoise")
                tx.inputs["Scale"].default_value = 3.0
                tx.inputs["Detail"].default_value = 6.0
            nt.links.new(mp.outputs["Vector"], tx.inputs["Vector"])
            fac = tx.outputs["Fac"] if "Fac" in tx.outputs else tx.outputs["Distance"]
            if kind == "checker":
                nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
            else:
                ramp = nt.nodes.new("ShaderNodeValToRGB")
                ramp.color_ramp.elements[0].color = c2
                ramp.color_ramp.elements[1].color = c1
                ramp.color_ramp.elements[0].position = 0.25
                ramp.color_ramp.elements[1].position = 0.75
                nt.links.new(fac, ramp.inputs["Fac"])
                nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        if bump > 0:
            bp = nt.nodes.new("ShaderNodeBump")
            bp.inputs["Strength"].default_value = bump
            nt.links.new(fac, bp.inputs["Height"])
            nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    if emit > 0:
        bsdf.inputs["Emission Color"].default_value = c1
        bsdf.inputs["Emission Strength"].default_value = emit
    MATS[key] = m
    return m


# ------------------------------------------------------------------------------------------------ geometry
def _mesh_obj(name, bm, material, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    o = bpy.data.objects.new(name, me)
    SC.collection.objects.link(o)
    if material is not None:
        me.materials.append(material)
    if parent is not None:
        o.parent = parent
    return o


def box(name, size, loc, material, parent=None, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    o = _mesh_obj(name, bm, material, parent)
    o.location = loc
    o.rotation_euler = rot
    return o


def cyl(name, r, h, loc, material, parent=None, rot=(0, 0, 0), segs=20, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=h)
    o = _mesh_obj(name, bm, material, parent)
    o.location = loc
    o.rotation_euler = rot
    return o


def sphere(name, radii, loc, material, parent=None, segs=16, rings=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(radii), verts=bm.verts)
    o = _mesh_obj(name, bm, material, parent)
    o.location = loc
    return o


def torus(name, R, r, loc, material, parent=None, rot=(0, 0, 0)):
    bm = bmesh.new()
    segs, rings = 28, 10
    verts = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        row = []
        for j in range(rings):
            b = 2 * math.pi * j / rings
            row.append(bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))))
        verts.append(row)
    for i in range(segs):
        for j in range(rings):
            bm.faces.new((verts[i][j], verts[(i + 1) % segs][j], verts[(i + 1) % segs][(j + 1) % rings], verts[i][(j + 1) % rings]))
    o = _mesh_obj(name, bm, material, parent)
    o.location = loc
    o.rotation_euler = rot
    return o


def capsule(name, p0, p1, r, material, parent=None):
    """A limb between two points (cylinder + spherical ends), built in world space."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = max(d.length, 1e-4)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=14, radius1=r, radius2=r * 0.92, depth=L)
    for z in (-L / 2, L / 2):
        tmp = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=r * (1 if z < 0 else 0.92))
        bmesh.ops.translate(bm, vec=Vector((0, 0, z)), verts=tmp["verts"])
    o = _mesh_obj(name, bm, material, parent)
    o.location = (p0 + p1) / 2
    o.rotation_euler = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_euler()
    return o


# ------------------------------------------------------------------------------------------------ objects (truth)
OBJECTS = []          # logical objects: {id, label, cls, group, sym, color, root, parts, dynamic, person}
PALETTE = {}


def _palette_color(i):
    """Distinct, bright, non-grey ID colours (golden-ratio hue, three lightness bands)."""
    h = (i * 0.6180339887) % 1.0
    l = [0.5, 0.35, 0.68][(i // 7) % 3]
    s = [1.0, 0.8, 0.95][(i // 3) % 3]
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]


def thing(oid, label, cls, color, loc=(0, 0, 0), yaw=0.0, group="thing", sym="none", dynamic=False):
    """A logical object: an Empty root at its footprint (rotated by yaw about Z, degrees) owning mesh parts."""
    root = bpy.data.objects.new(oid, None)
    SC.collection.objects.link(root)
    root.location = loc
    root.rotation_euler = (0, 0, math.radians(yaw))
    o = {"id": oid, "label": label, "cls": cls, "group": group, "sym": sym, "color": color, "root": root, "parts": [],
         "dynamic": dynamic, "person": None}
    OBJECTS.append(o)
    return o


def part(o, obj):
    obj.parent = o["root"]
    o["parts"].append(obj)
    return obj


# ------------------------------------------------------------------------------------------------ library
def make_car(oid, label, color, loc, yaw, dynamic=False, kind="sedan"):
    o = thing(oid, label, "car", color, loc, yaw, sym="none", dynamic=dynamic)
    paint = mat(f"paint_{color}", color, "paint", scale=2.0, rough=0.28, metal=0.35, bump=0.0)
    glass = mat("glass", "#1b2430", "plain", rough=0.08, metal=0.6)
    tyre = mat("tyre", "#161616", "noise", scale=20, rough=0.9)
    chrome = mat("chrome", "#c8c8cc", "plain", rough=0.2, metal=1.0)
    lamp = mat("headlamp", "#fff6dd", "plain", emit=2.0)
    tail = mat("taillamp", "#c01818", "plain", emit=1.5)
    L, W = (4.6, 1.85) if kind == "sedan" else (4.3, 1.8)
    part(o, box(f"{oid}_body", (W, L, 0.62), (0, 0, 0.62), paint))
    part(o, box(f"{oid}_hood", (W * 0.98, L * 0.3, 0.12), (0, -L * 0.3, 0.98), paint))
    part(o, box(f"{oid}_cabin", (W * 0.86, L * 0.46, 0.5), (0, 0.15, 1.18), glass))
    part(o, box(f"{oid}_roof", (W * 0.84, L * 0.4, 0.06), (0, 0.15, 1.45), paint))
    part(o, box(f"{oid}_trunk", (W * 0.98, L * 0.18, 0.12), (0, L * 0.38, 0.98), paint))
    for sx in (-1, 1):
        for sy, ty in ((-1, 0.36), (1, 0.33)):
            part(o, cyl(f"{oid}_wheel_{sx}_{sy}", 0.34, 0.24, (sx * W * 0.47, sy * L * ty, 0.34), tyre, rot=(0, math.pi / 2, 0)))
            part(o, cyl(f"{oid}_hub_{sx}_{sy}", 0.2, 0.25, (sx * W * 0.475, sy * L * ty, 0.34), chrome, rot=(0, math.pi / 2, 0), segs=10))
        part(o, box(f"{oid}_head_{sx}", (0.36, 0.04, 0.12), (sx * W * 0.32, -L / 2 - 0.01, 0.78), lamp))
        part(o, box(f"{oid}_tail_{sx}", (0.36, 0.04, 0.1), (sx * W * 0.34, L / 2 + 0.01, 0.82), tail))
    part(o, box(f"{oid}_bumper_f", (W, 0.12, 0.18), (0, -L / 2, 0.42), chrome))
    part(o, box(f"{oid}_bumper_r", (W, 0.12, 0.18), (0, L / 2, 0.42), chrome))
    return o


def make_bicycle(oid, color, loc, yaw):
    o = thing(oid, "bicycle", "bicycle", color, loc, yaw, sym="none", dynamic=True)
    fr = mat(f"bike_{color}", color, "paint", scale=3, rough=0.35, metal=0.4, bump=0)
    tyre = mat("tyre", "#161616", "noise", scale=20, rough=0.9)
    for y in (-0.52, 0.52):
        part(o, torus(f"{oid}_wheel_{y}", 0.33, 0.03, (0, y, 0.36), tyre, rot=(0, math.pi / 2, 0)))
    part(o, capsule(f"{oid}_down", (0, -0.4, 0.62), (0, 0.05, 0.36), 0.022, fr))
    part(o, capsule(f"{oid}_top", (0, -0.4, 0.78), (0, 0.15, 0.82), 0.02, fr))
    part(o, capsule(f"{oid}_seat_t", (0, 0.05, 0.36), (0, 0.15, 0.86), 0.02, fr))
    part(o, capsule(f"{oid}_stays", (0, 0.05, 0.36), (0, 0.52, 0.36), 0.015, fr))
    part(o, capsule(f"{oid}_fork", (0, -0.4, 0.82), (0, -0.52, 0.36), 0.018, fr))
    part(o, capsule(f"{oid}_bars", (-0.25, -0.42, 0.98), (0.25, -0.42, 0.98), 0.016, mat("black", "#151515")))
    part(o, capsule(f"{oid}_stem", (0, -0.4, 0.82), (0, -0.42, 0.98), 0.016, fr))
    part(o, box(f"{oid}_saddle", (0.12, 0.26, 0.05), (0, 0.15, 0.9), mat("black", "#151515")))
    o["saddle"] = Vector((0, 0.13, 0.93))
    o["grips"] = (Vector((0.22, -0.42, 0.98)), Vector((-0.22, -0.42, 0.98)))
    o["crank"] = Vector((0, 0.05, 0.36))
    return o


def make_chair(oid, loc, yaw, wood="#7a5232", seat="#3e5f8a", label="dining chair"):
    o = thing(oid, label, "chair", seat, loc, yaw)
    w = mat(f"wood_{wood}", wood, "wood", scale=4, rough=0.55)
    f = mat(f"fabric_{seat}", seat, "noise", scale=30, rough=0.9, bump=0.2)
    for sx in (-1, 1):
        for sy in (-1, 1):
            part(o, box(f"{oid}_leg_{sx}{sy}", (0.04, 0.04, 0.44), (sx * 0.2, sy * 0.2, 0.22), w))
    part(o, box(f"{oid}_seat", (0.46, 0.46, 0.06), (0, 0, 0.47), f))
    part(o, box(f"{oid}_back", (0.44, 0.04, 0.46), (0, 0.21, 0.73), w))   # backrest behind (+Y); faces -Y
    return o


def make_table(oid, label, cls, size, loc, yaw, wood="#8a5a33", top_h=0.05):
    w_, d_, h_ = size
    o = thing(oid, label, cls, wood, loc, yaw, sym="2")
    m = mat(f"wood_{wood}", wood, "wood", scale=3, rough=0.45)
    part(o, box(f"{oid}_top", (w_, d_, top_h), (0, 0, h_ - top_h / 2), m))
    for sx in (-1, 1):
        for sy in (-1, 1):
            part(o, box(f"{oid}_leg_{sx}{sy}", (0.06, 0.06, h_ - top_h), (sx * (w_ / 2 - 0.08), sy * (d_ / 2 - 0.08), (h_ - top_h) / 2), m))
    return o


def make_sofa(oid, loc, yaw, color="#6b7f5e"):
    o = thing(oid, "sofa", "sofa", color, loc, yaw)
    f = mat(f"sofa_{color}", color, "noise", scale=25, rough=0.95, bump=0.25)
    part(o, box(f"{oid}_base", (2.1, 0.9, 0.42), (0, 0, 0.21), f))
    part(o, box(f"{oid}_back", (2.1, 0.22, 0.45), (0, 0.34, 0.64), f))   # back at +Y: faces -Y
    for sx in (-1, 1):
        part(o, box(f"{oid}_arm_{sx}", (0.2, 0.9, 0.62), (sx * 0.95, 0, 0.31), f))
        part(o, box(f"{oid}_cush_{sx}", (0.83, 0.62, 0.14), (sx * 0.43, -0.08, 0.49), f))
    return o


def make_shelf(oid, loc, yaw, wood="#5a3a22"):
    o = thing(oid, "bookshelf", "shelf", wood, loc, yaw)
    m = mat(f"wood_{wood}", wood, "wood", scale=3, rough=0.5)
    part(o, box(f"{oid}_back", (0.9, 0.03, 1.9), (0, 0.16, 0.95), m))
    for sx in (-1, 1):
        part(o, box(f"{oid}_side_{sx}", (0.03, 0.35, 1.9), (sx * 0.435, 0, 0.95), m))
    for i, z in enumerate((0.02, 0.48, 0.94, 1.4, 1.88)):
        part(o, box(f"{oid}_shelf_{i}", (0.87, 0.33, 0.03), (0, 0, z), m))
    cols = ["#9b2c2c", "#2c4f9b", "#d0b14a", "#2f7a4a", "#e8e2d0", "#3b3b3b", "#a0522d"]
    for i, z in enumerate((0.04, 0.5, 0.96, 1.42)):
        x = -0.4
        while x < 0.38:
            bw, bh = rng.uniform(0.025, 0.06), rng.uniform(0.22, 0.38)
            part(o, box(f"{oid}_book_{i}_{x:.2f}", (bw, 0.22, bh), (x + bw / 2, -0.02, z + 0.015 + bh / 2),
                        mat(f"book_{cols[int(x * 97) % len(cols)]}", cols[int((x + i) * 97) % len(cols)], "plain", rough=0.7)))
            x += bw + 0.004
    return o


def make_lamp(oid, loc, label="floor lamp"):
    o = thing(oid, label, "lamp", "#e8dcc0", loc, 0, sym="round")
    part(o, cyl(f"{oid}_base", 0.16, 0.04, (0, 0, 0.02), mat("metal_dark", "#2a2a2a", "plain", rough=0.3, metal=0.9)))
    part(o, cyl(f"{oid}_pole", 0.015, 1.5, (0, 0, 0.77), mat("metal_dark", "#2a2a2a", "plain", rough=0.3, metal=0.9)))
    part(o, cyl(f"{oid}_shade", 0.22, 0.3, (0, 0, 1.6), mat("shade", "#e8dcc0", "noise", scale=40, rough=0.9, emit=0.6), r2=0.15))
    return o


def make_plant(oid, loc, height=1.1, pot="#b0603a"):
    o = thing(oid, "potted plant", "plant", "#4f7d3a", loc, 0, sym="round")
    part(o, cyl(f"{oid}_pot", 0.17, 0.32, (0, 0, 0.16), mat(f"pot_{pot}", pot, "noise", scale=10, rough=0.8), r2=0.21))
    leaf = mat("leaf", "#4f7d3a", "leaf", base2="#2d5223", scale=8, rough=0.7, bump=0.3)
    for i in range(5):
        a = i * 2.4
        r = 0.12 + 0.05 * (i % 2)
        part(o, sphere(f"{oid}_leaf_{i}", (0.2, 0.2, 0.28 * height), (r * math.cos(a), r * math.sin(a), 0.35 + height * (0.3 + 0.12 * i)), leaf))
    return o


def make_tree(oid, loc, height=6.0):
    o = thing(oid, "street tree", "tree", "#3f6b2f", loc, 0, sym="round")
    bark = mat("bark", "#4a3626", "noise", scale=12, rough=0.9, bump=0.5)
    leaf = mat("canopy", "#3f6b2f", "leaf", base2="#24461b", scale=3, rough=0.8, bump=0.4)
    part(o, cyl(f"{oid}_trunk", 0.16, height * 0.55, (0, 0, height * 0.275), bark, r2=0.11))
    for i, (dx, dy, dz, r) in enumerate(((0, 0, 0.72, 1.6), (0.7, 0.3, 0.62, 1.1), (-0.6, -0.4, 0.66, 1.2), (0.1, -0.7, 0.8, 1.0))):
        part(o, sphere(f"{oid}_can_{i}", (r, r, r * 0.85), (dx, dy, height * dz), leaf, segs=12, rings=8))
    return o


def make_pole(oid, loc, yaw, height=6.5):
    o = thing(oid, "street light", "pole", "#4a4d50", loc, yaw, sym="none")
    m = mat("pole", "#4a4d50", "noise", scale=6, rough=0.5, metal=0.7)
    part(o, cyl(f"{oid}_post", 0.08, height, (0, 0, height / 2), m, r2=0.06))
    part(o, box(f"{oid}_arm", (0.08, 1.4, 0.08), (0, -0.7, height - 0.1), m))
    part(o, box(f"{oid}_head", (0.3, 0.55, 0.12), (0, -1.35, height - 0.18), mat("lamphead", "#fff3d6", "plain", emit=1.0)))
    return o


def make_sign(oid, loc, yaw, kind="stop"):
    color = "#b3232a" if kind == "stop" else "#1f6b3a"
    o = thing(oid, "stop sign" if kind == "stop" else "street sign", "sign", color, loc, yaw, sym="none")
    part(o, cyl(f"{oid}_post", 0.035, 2.6, (0, 0, 1.3), mat("galv", "#9aa0a6", "noise", scale=10, rough=0.4, metal=0.8)))
    if kind == "stop":
        part(o, cyl(f"{oid}_plate", 0.38, 0.03, (0, -0.04, 2.35), mat("stopred", "#b3232a", "noise", scale=30, rough=0.4), rot=(math.pi / 2, 0, 0), segs=8))
    else:
        part(o, box(f"{oid}_plate", (0.9, 0.03, 0.25), (0, -0.04, 2.5), mat("signgreen", "#1f6b3a", "noise", scale=30, rough=0.4)))
    return o


def make_bin(oid, loc, color="#2f4f3a"):
    o = thing(oid, "trash bin", "bin", color, loc, 0, sym="round")
    m = mat(f"bin_{color}", color, "noise", scale=15, rough=0.6, metal=0.3)
    part(o, cyl(f"{oid}_body", 0.3, 0.95, (0, 0, 0.475), m, r2=0.33))
    part(o, cyl(f"{oid}_lid", 0.35, 0.06, (0, 0, 0.98), m))
    return o


def make_bench(oid, loc, yaw, wood="#7b5a3a"):
    o = thing(oid, "bench", "bench", wood, loc, yaw, sym="none")
    w = mat(f"wood_{wood}", wood, "wood", scale=4, rough=0.6)
    iron = mat("iron", "#2b2b2b", "noise", scale=10, rough=0.5, metal=0.8)
    for i in range(3):
        part(o, box(f"{oid}_slat_{i}", (1.8, 0.11, 0.04), (0, -0.12 + i * 0.13, 0.45), w))
    for i in range(2):
        part(o, box(f"{oid}_bslat_{i}", (1.8, 0.04, 0.11), (0, 0.22, 0.6 + i * 0.14), w))
    for sx in (-1, 1):
        part(o, box(f"{oid}_leg_{sx}", (0.06, 0.5, 0.45), (sx * 0.8, 0.02, 0.225), iron))
    return o


def make_box(oid, loc, color="#c8743a", size=(0.28, 0.2, 0.16), label="cardboard box"):
    o = thing(oid, label, "box", color, loc, 0, sym="2", dynamic=True)
    part(o, box(f"{oid}_box", size, (0, 0, size[2] / 2), mat(f"card_{color}", color, "noise", scale=20, rough=0.8, bump=0.2)))
    return o


def make_hydrant(oid, loc):
    o = thing(oid, "fire hydrant", "hydrant", "#c22a1f", loc, 0, sym="round")
    m = mat("hydrant", "#c22a1f", "noise", scale=15, rough=0.4, metal=0.3)
    part(o, cyl(f"{oid}_body", 0.12, 0.6, (0, 0, 0.3), m))
    part(o, sphere(f"{oid}_cap", (0.13, 0.13, 0.1), (0, 0, 0.62), m))
    part(o, cyl(f"{oid}_nozzle", 0.05, 0.36, (0, 0, 0.4), m, rot=(0, math.pi / 2, 0)))
    return o


def slab(oid, label, cls, size, loc, material, color, group="structure", yaw=0.0, sym="2"):
    o = thing(oid, label, cls, color, (loc[0], loc[1], 0), yaw, group=group, sym=sym)
    part(o, box(f"{oid}_slab", size, (0, 0, loc[2]), material))
    return o


# ------------------------------------------------------------------------------------------------ people
CLAY = dict(hip=0.9, spine=0.96, chest=1.24, neck=1.48, head=1.585, head_c=1.67, top=1.78, sh_y=1.47, upper=0.295,
            fore=0.257, hand=0.085, hip_x=0.095, thigh=0.445, shin=0.42)


def make_person(oid, label, height=1.8, female=False, top="#2e4f8a", bottom="#2f2f35", skin="#c68a63", hair="#2b211b",
                shoes="#1d1d1f", long_sleeves=True):
    """A rigged mannequin facing -Y at the origin: armature + rigid parts bone-parented; IK legs and arms."""
    s = height / 1.8
    o = thing(oid, label, "person", top, (0, 0, 0), 0, sym="none", dynamic=True)
    arm_data = bpy.data.armatures.new(oid + "_rig")
    arm = bpy.data.objects.new(oid + "_rig", arm_data)
    SC.collection.objects.link(arm)
    arm.parent = o["root"]
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    shx = (0.2 if female else 0.23) * s
    C = {k: v * s for k, v in CLAY.items()}

    def bone(name, h, t, parent=None, roll=0.0):
        b = eb.new(name)
        b.head, b.tail, b.roll = Vector(h), Vector(t), roll
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        return b
    bone("pelvis", (0, 0, C["hip"]), (0, 0, C["spine"]))
    bone("spine", (0, 0, C["spine"]), (0, 0, C["chest"]), "pelvis")
    bone("chest", (0, 0, C["chest"]), (0, 0, C["neck"]), "spine")
    bone("neck", (0, 0, C["neck"]), (0, 0, C["head"]), "chest")
    bone("head", (0, 0, C["head"]), (0, 0, C["top"]), "neck")
    for side, sx in (("l", 1), ("r", -1)):
        x = sx * shx
        bone(f"{side}_upper", (x, 0, C["sh_y"]), (x, 0.012 * s, C["sh_y"] - C["upper"]), "chest")
        bone(f"{side}_fore", (x, 0.012 * s, C["sh_y"] - C["upper"]), (x, 0, C["sh_y"] - C["upper"] - C["fore"]), f"{side}_upper")
        bone(f"{side}_hand", (x, 0, C["sh_y"] - C["upper"] - C["fore"]), (x, 0, C["sh_y"] - C["upper"] - C["fore"] - C["hand"]), f"{side}_fore")
        hx = sx * C["hip_x"]
        knee_z = C["hip"] - C["thigh"]
        bone(f"{side}_thigh", (hx, 0, C["hip"]), (hx, -0.015 * s, knee_z), "pelvis")
        bone(f"{side}_shin", (hx, -0.015 * s, knee_z), (hx, 0, knee_z - C["shin"]), f"{side}_thigh")
        bone(f"{side}_foot", (hx, 0, knee_z - C["shin"]), (hx, -0.2 * s, 0.0), f"{side}_shin")
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.data.display_type = "STICK"

    shirt = mat(f"shirt_{top}", top, "noise", scale=35, rough=0.9, bump=0.15)
    pants = mat(f"pants_{bottom}", bottom, "noise", scale=35, rough=0.9, bump=0.15)
    skinm = mat(f"skin_{skin}", skin, "noise", scale=20, rough=0.6, bump=0.05)
    hairm = mat(f"hair_{hair}", hair, "noise", scale=60, rough=0.7, bump=0.3)
    shoem = mat(f"shoe_{shoes}", shoes, "plain", rough=0.5)
    parts = []

    def attach(obj, bname):
        pb = arm.pose.bones[bname]
        mw = obj.matrix_basis.copy()      # unparented and just built: its basis is its world matrix (matrix_world is stale)
        obj.parent = arm
        obj.parent_type = "BONE"
        obj.parent_bone = bname
        # world = arm @ pose_mat @ T(tail) @ parent_inverse @ basis; at rest pose_mat = bone.matrix_local, so with this
        # parent inverse the basis IS the rest world matrix (the matrix_world setter would read a stale pose_mat).
        tail = arm.matrix_world @ pb.bone.matrix_local @ Matrix.Translation((0, pb.bone.length, 0))
        obj.matrix_parent_inverse = tail.inverted()
        obj.matrix_basis = mw
        parts.append(obj)
    bpy.context.view_layer.update()
    sr = (0.17 if female else 0.2) * s
    wr = (0.13 if female else 0.15) * s
    attach(sphere(f"{oid}_hips", (wr * 1.15, wr * 0.8, 0.12 * s), (0, 0, C["hip"] + 0.02 * s), pants), "pelvis")
    attach(cyl(f"{oid}_torso", sr, C["neck"] - C["spine"], (0, 0, (C["neck"] + C["spine"]) / 2), shirt, r2=None), "chest")
    o_t = parts[-1]
    o_t.scale = (1, 0.62, 1)
    attach(sphere(f"{oid}_yoke", (sr, sr * 0.62, 0.06 * s), (0, 0, C["neck"] - 0.02 * s), shirt), "chest")
    attach(cyl(f"{oid}_neckm", 0.048 * s, 0.11 * s, (0, 0, (C["neck"] + C["head"]) / 2 + 0.01 * s), skinm), "neck")
    attach(sphere(f"{oid}_skull", (0.094 * s, 0.105 * s, 0.113 * s), (0, -0.005 * s, C["head_c"]), skinm), "head")
    attach(sphere(f"{oid}_hair", (0.1 * s, 0.11 * s, 0.09 * s), (0, 0.012 * s, C["head_c"] + 0.035 * s), hairm), "head")
    attach(sphere(f"{oid}_nose", (0.016 * s, 0.02 * s, 0.022 * s), (0, -0.105 * s, C["head_c"] - 0.012 * s), skinm), "head")
    if female:
        attach(capsule(f"{oid}_ponytail", (0, 0.1 * s, C["head_c"] + 0.02 * s), (0, 0.14 * s, C["head_c"] - 0.2 * s), 0.035 * s, hairm), "head")
    for side, sx in (("l", 1), ("r", -1)):
        x = sx * shx
        e = C["sh_y"] - C["upper"]
        wv = e - C["fore"]
        attach(capsule(f"{oid}_{side}_upper", (x, 0, C["sh_y"] - 0.02 * s), (x, 0.012 * s, e), 0.048 * s, shirt), f"{side}_upper")
        attach(capsule(f"{oid}_{side}_fore", (x, 0.012 * s, e), (x, 0, wv + 0.01 * s), 0.04 * s, shirt if long_sleeves else skinm), f"{side}_fore")
        attach(box(f"{oid}_{side}_handm", (0.035 * s, 0.075 * s, 0.1 * s), (x, 0, wv - 0.05 * s), skinm), f"{side}_hand")
        hx = sx * C["hip_x"]
        k = C["hip"] - C["thigh"]
        attach(capsule(f"{oid}_{side}_thigh", (hx, 0, C["hip"] - 0.02 * s), (hx, -0.015 * s, k), 0.068 * s, pants), f"{side}_thigh")
        attach(capsule(f"{oid}_{side}_shin", (hx, -0.015 * s, k), (hx, 0, k - C["shin"] + 0.03 * s), 0.052 * s, pants), f"{side}_shin")
        attach(box(f"{oid}_{side}_shoe", (0.1 * s, 0.27 * s, 0.075 * s), (hx, -0.07 * s, 0.0375 * s), shoem), f"{side}_foot")
    o["parts"] = parts
    o["arm"] = arm
    o["s"] = s
    o["female"] = female
    o["shx"] = shx

    # IK targets (world-space empties, keyed per frame) and poles (children of the root: they turn with the person).
    tg = {}
    for nm in ("l_foot_t", "r_foot_t", "l_hand_t", "r_hand_t"):
        e = bpy.data.objects.new(f"{oid}_{nm}", None)
        SC.collection.objects.link(e)
        e.empty_display_size = 0.05
        tg[nm] = e
    for side, sx in (("l", 1), ("r", -1)):
        kp = bpy.data.objects.new(f"{oid}_{side}_knee_pole", None)
        SC.collection.objects.link(kp)
        kp.parent = o["root"]
        kp.location = (sx * 0.15 * s, -0.8, 0.5 * s)
        ep = bpy.data.objects.new(f"{oid}_{side}_elbow_pole", None)
        SC.collection.objects.link(ep)
        ep.parent = o["root"]
        ep.location = (sx * 0.5 * s, 0.6, 1.1 * s)
        tg[f"{side}_knee_pole"], tg[f"{side}_elbow_pole"] = kp, ep
        for chain, tgt, pole in ((f"{side}_shin", tg[f"{side}_foot_t"], kp), (f"{side}_fore", tg[f"{side}_hand_t"], ep)):
            c = arm.pose.bones[chain].constraints.new("IK")
            c.target, c.pole_target, c.chain_count = tgt, pole, 2
            c.pole_angle = math.radians(-90)
    o["targets"] = tg
    return o


def calibrate_ik(o):
    """Pick each chain's pole angle so the knee / elbow really bends toward its pole (bone roll makes it vary)."""
    arm, tg, s = o["arm"], o["targets"], o["s"]
    root = o["root"]
    for side, sx in (("l", 1), ("r", -1)):
        for chain, tname, pole, mid in ((f"{side}_shin", f"{side}_foot_t", f"{side}_knee_pole", f"{side}_shin"),
                                        (f"{side}_fore", f"{side}_hand_t", f"{side}_elbow_pole", f"{side}_fore")):
            c = arm.pose.bones[chain].constraints["IK"]
            leg = chain.endswith("shin")
            hip = root.matrix_world @ arm.matrix_local @ (arm.pose.bones[f"{side}_thigh" if leg else f"{side}_upper"].bone.head_local)
            tgt = hip + (root.matrix_world.to_3x3() @ Vector((0, -0.05, -0.62 * s if leg else -0.4 * s)))
            tg[tname].location = tgt
            best = None
            for ang in (-90, 0, 90, 180):
                c.pole_angle = math.radians(ang)
                bpy.context.view_layer.update()
                j = arm.matrix_world @ arm.pose.bones[mid].head
                pw = tg[pole].matrix_world.translation
                line = (tgt - hip).normalized()
                off = (j - hip) - line * (j - hip).dot(line)
                pdir = (pw - hip) - line * (pw - hip).dot(line)
                score = off.normalized().dot(pdir.normalized()) if off.length > 1e-5 else -1
                if best is None or score > best[0]:
                    best = (score, ang)
            c.pole_angle = math.radians(best[1])


# ---- motion
def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


class Path:
    """A polyline on the ground (Blender XY) with arc-length sampling."""

    def __init__(self, pts):
        self.p = [Vector((x, y, 0)) for x, y in pts]
        self.L = [0.0]
        for a, b in zip(self.p, self.p[1:]):
            self.L.append(self.L[-1] + (b - a).length)

    @property
    def length(self):
        return self.L[-1]

    def at(self, s):
        s = max(0.0, min(self.length, s))
        for i in range(len(self.p) - 1):
            if s <= self.L[i + 1] or i == len(self.p) - 2:
                seg = self.L[i + 1] - self.L[i]
                u = 0 if seg < 1e-9 else (s - self.L[i]) / seg
                pos = self.p[i].lerp(self.p[i + 1], u)
                d = (self.p[i + 1] - self.p[i]).normalized()
                return pos, d
        return self.p[-1], (self.p[-1] - self.p[-2]).normalized()


def arc_path(start, heading_deg, segments):
    """Path from 'start' heading 'heading_deg' (0 = +Y... we use Blender yaw where facing -Y is 0) through
    [('s', length) | ('r', radius, angle_deg)] segments, sampled every 0.25 m. Returns a Path.
    Yaw convention: forward = (sin(yaw), -cos(yaw)) so yaw 0 faces -Y, like built objects."""
    x, y = start
    yaw = math.radians(heading_deg)
    pts = [(x, y)]
    for seg in segments:
        if seg[0] == "s":
            n = max(1, int(seg[1] / 0.25))
            for _ in range(n):
                x += math.sin(yaw) * seg[1] / n
                y += -math.cos(yaw) * seg[1] / n
                pts.append((x, y))
        else:
            R, ang = seg[1], math.radians(seg[2])
            n = max(2, int(abs(ang) * R / 0.25))
            for _ in range(n):
                yaw += ang / n
                x += math.sin(yaw) * abs(ang) * R / n
                y += -math.cos(yaw) * abs(ang) * R / n
                pts.append((x, y))
    return Path(pts)


def yaw_of(d):
    """Blender yaw (deg, 0 faces -Y) of a ground direction."""
    return math.degrees(math.atan2(d.x, -d.y))


class Mover:
    """Speed profile along a path: piecewise (t0, t1, v) with ease at changes; returns arc length at time t."""

    def __init__(self, path, segments, s0=0.0):
        self.path, self.seg, self.s0 = path, segments, s0

    def s_at(self, t):
        s = self.s0
        for (a, b, v) in self.seg:
            if t <= a:
                break
            s += v * (min(t, b) - a)
        return s


def key_obj(obj, f, loc=None, rot=None):
    if loc is not None:
        obj.location = loc
        obj.keyframe_insert("location", frame=f)
    if rot is not None:
        obj.rotation_euler = rot
        obj.keyframe_insert("rotation_euler", frame=f)


def key_bone(o, name, f, rx=0.0, ry=0.0, rz=0.0):
    pb = o["arm"].pose.bones[name]
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (rx, ry, rz)
    pb.keyframe_insert("rotation_euler", frame=f)


def world_of(o, local):
    """Person-local point (x right... built frame: +X is the figure's left, -Y forward, Z up) -> world, current root."""
    return o["root"].matrix_world @ Vector(local)


def walk_pose(o, f, path, mover, t, start_phase=0.0, stride=0.68, lateral=None, carry=None, arms=True, base_z=0.0):
    """Footstep-planned walk on a path at time t (s). Keys root, feet, hands, spine. Feet never slide while planted."""
    s = o["s"]
    lateral = (0.1 * s) if lateral is None else lateral
    dist = mover.s_at(t)
    pos, d = path.at(dist)
    yaw = yaw_of(d)
    L2 = 2 * stride
    phase = dist / L2 + start_phase
    feet = {}
    for side, off, sgn in (("l", 0.0, 1), ("r", 0.5, -1)):
        ph = phase - off
        k = math.floor(ph)
        u = ph - k
        plant = lambda kk: (kk + off) * L2 + 0.6 * stride - start_phase * L2   # noqa: E731 - arc length of plant kk
        if u < 0.6:
            sp = plant(k)
            p, dd = path.at(sp)
            z = 0.035 * s
        else:
            w = smooth((u - 0.6) / 0.4)
            sa, sb = plant(k), plant(k + 1)
            p, dd = path.at(sa + (sb - sa) * w)
            z = 0.035 * s + 0.09 * s * math.sin(math.pi * w)
        lv = Vector((-dd.y, dd.x, 0))
        feet[side] = p + lv * (sgn * lateral) + Vector((0, 0, z + base_z))
    bob = 0.018 * s * math.cos(4 * math.pi * phase)
    key_obj(o["root"], f, loc=(pos.x, pos.y, base_z + bob - 0.02 * s), rot=(0, 0, math.radians(yaw)))
    key_obj(o["targets"]["l_foot_t"], f, loc=feet["l"])
    key_obj(o["targets"]["r_foot_t"], f, loc=feet["r"])
    key_bone(o, "spine", f, rx=math.radians(4))
    key_bone(o, "chest", f)
    key_bone(o, "neck", f)
    key_bone(o, "head", f)
    if arms:
        bpy.context.view_layer.update()
        for side, sx, off in (("l", 1, 0.5), ("r", -1, 0.0)):
            if carry and side in carry:
                continue
            sw = math.sin(2 * math.pi * (phase - off))
            loc = Vector((sx * (o["shx"] + 0.03 * s), -0.2 * s * sw, (CLAY["sh_y"] - 0.53) * s + 0.03 * s * abs(sw)))
            key_obj(o["targets"][f"{side}_hand_t"], f, loc=world_of(o, loc))
    return pos, d


def hold_pose(o, f, pos, yaw, pelvis_dz=0.0, spine=0.0, chest=0.0, neck=0.0, head_turn=0.0, feet=None, hands=None,
              pelvis_back=0.0):
    """Stand / sit / crouch: root at pos facing yaw, pelvis lowered by pelvis_dz and moved back; feet & hands targets
    in person-local coordinates (default: feet under hips, arms hanging)."""
    s = o["s"]
    yaw_r = math.radians(yaw)
    fwd = Vector((math.sin(yaw_r), -math.cos(yaw_r), 0))
    root_pos = Vector(pos) - fwd * pelvis_back
    key_obj(o["root"], f, loc=(root_pos.x, root_pos.y, root_pos.z - pelvis_dz), rot=(0, 0, yaw_r))
    bpy.context.view_layer.update()
    R = Matrix.Rotation(yaw_r, 3, "Z")
    if feet is None:
        feet = {"l": (0.11 * s, 0.0, 0.035 * s), "r": (-0.11 * s, 0.0, 0.035 * s)}
    for side in ("l", "r"):
        fx, fy, fz = feet[side]
        w = Vector(pos) + R @ Vector((fx, fy, 0)) + Vector((0, 0, fz))
        key_obj(o["targets"][f"{side}_foot_t"], f, loc=w)
    key_bone(o, "spine", f, rx=math.radians(spine))
    key_bone(o, "chest", f, rx=math.radians(chest))
    key_bone(o, "neck", f, rx=math.radians(neck * 0.5), rz=math.radians(head_turn * 0.4))
    key_bone(o, "head", f, rx=math.radians(neck * 0.5), rz=math.radians(head_turn * 0.6))
    hands = hands or {}
    for side, sx in (("l", 1), ("r", -1)):
        if side in hands and hands[side] is not None:
            h = hands[side]
            if isinstance(h, Vector):     # world point
                key_obj(o["targets"][f"{side}_hand_t"], f, loc=h)
                continue
            loc = Vector(h)
        else:
            loc = Vector((sx * (o["shx"] + 0.04 * s), -0.02 * s, (CLAY["sh_y"] - 0.54) * s - pelvis_dz))
        key_obj(o["targets"][f"{side}_hand_t"], f, loc=root_pos + R @ Vector((loc.x, loc.y, 0)) + Vector((0, 0, loc.z)))  # z above pos


# ------------------------------------------------------------------------------------------------ lights / world
def world_sky(strength=1.0, sun_elev=35.0, sun_rot=120.0, color="#aac4e0"):
    w = bpy.data.worlds.new("sky")
    SC.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    ok = False
    try:
        sky = nt.nodes.new("ShaderNodeTexSky")
        for t in ("MULTIPLE_SCATTERING", "SINGLE_SCATTERING", "NISHITA", "HOSEK_WILKIE"):
            try:
                sky.sky_type = t
                break
            except TypeError:
                continue
        try:
            sky.sun_elevation = math.radians(sun_elev)
            sky.sun_rotation = math.radians(sun_rot)
        except AttributeError:
            pass
        nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = strength * 0.35
        ok = True
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        bg.inputs["Color"].default_value = [_srgb_to_lin(v) for v in hexrgb(color)] + [1]
        bg.inputs["Strength"].default_value = strength
    w.color = (0, 0, 0)


def sun(rot_deg=(50, 0, 140), energy=3.5, color=(1.0, 0.95, 0.88), angle=1.0):
    d = bpy.data.lights.new("sun", "SUN")
    d.energy = energy
    d.color = color
    d.angle = math.radians(angle)
    o = bpy.data.objects.new("sun", d)
    SC.collection.objects.link(o)
    o.rotation_euler = [math.radians(v) for v in rot_deg]
    return o


def area(loc, size, energy, color=(1, 0.96, 0.9)):
    d = bpy.data.lights.new("area", "AREA")
    d.energy, d.size, d.color = energy, size, color
    o = bpy.data.objects.new("area", d)
    SC.collection.objects.link(o)
    o.location = loc
    return o


# ------------------------------------------------------------------------------------------------ camera
CAM = None


def camera(lens):
    global CAM
    cd = bpy.data.cameras.new("ShotCam")
    cd.sensor_fit = "HORIZONTAL"
    cd.sensor_width = 36.0
    cd.lens = lens
    cd.clip_start, cd.clip_end = 0.05, 600
    CAM = bpy.data.objects.new("ShotCam", cd)
    SC.collection.objects.link(CAM)
    SC.camera = CAM
    return CAM


def key_camera(f, pos, target, roll_deg=0.0, lens=None):
    pos, target = Vector(pos), Vector(target)
    d = (target - pos).normalized()
    rot = d.to_track_quat("-Z", "Y")
    if roll_deg:
        rot = rot @ Euler((0, 0, math.radians(roll_deg))).to_quaternion()
    CAM.location = pos
    CAM.rotation_mode = "QUATERNION"
    CAM.rotation_quaternion = rot
    CAM.keyframe_insert("location", frame=f)
    CAM.keyframe_insert("rotation_quaternion", frame=f)
    if lens:
        CAM.data.lens = lens
        CAM.data.keyframe_insert("lens", frame=f)


def shake(t, seed, amp, freqs=(0.37, 0.91, 1.73, 2.9)):
    r = random.Random(seed)
    return sum(amp / (i + 1) * math.sin(2 * math.pi * fq * t + r.uniform(0, 6.28)) for i, fq in enumerate(freqs))


# ------------------------------------------------------------------------------------------------ scenes
def build_interior():
    W, D, H = 6.5, 5.5, 2.7
    floor_m = mat("floor_wood", "#9a6b43", "wood", base2="#7a4f2e", scale=1.4, rough=0.45, bump=0.15)
    wall_m = mat("plaster", "#d9d2c5", "noise", base2="#c7bfb1", scale=2.5, rough=0.9, bump=0.08)
    ceil_m = mat("ceiling", "#ece8e1", "noise", scale=2, rough=0.95, bump=0.03)
    slab("floor", "floor", "floor", (W, D, 0.04), (0, 0, -0.02), floor_m, "#9a6b43")
    slab("ceiling", "ceiling", "ceiling", (W, D, 0.04), (0, 0, H + 0.02), ceil_m, "#ece8e1")
    # Back wall (y = +D/2) with a window opening at x in [-1.8, -0.2], z in [0.9, 2.2].
    wx0, wx1, wz0, wz1 = -1.8, -0.2, 0.9, 2.2
    bw = thing("wall_back", "back wall with window", "wall", "#d9d2c5", (0, D / 2 + 0.05, 0), 0, group="structure", sym="2")
    part(bw, box("wb_l", (wx0 + W / 2, 0.1, H), ((-W / 2 + wx0) / 2, 0, H / 2), wall_m))
    part(bw, box("wb_r", (W / 2 - wx1, 0.1, H), ((wx1 + W / 2) / 2, 0, H / 2), wall_m))
    part(bw, box("wb_b", (wx1 - wx0, 0.1, wz0), ((wx0 + wx1) / 2, 0, wz0 / 2), wall_m))
    part(bw, box("wb_t", (wx1 - wx0, 0.1, H - wz1), ((wx0 + wx1) / 2, 0, (H + wz1) / 2), wall_m))
    win = thing("window", "window", "window", "#e9e6df", ((wx0 + wx1) / 2, D / 2 + 0.02, 0), 0, group="structure", sym="2")
    fr = mat("win_frame", "#e9e6df", "plain", rough=0.5)
    part(win, box("win_sky", (wx1 - wx0, 0.02, wz1 - wz0), (0, 0.06, (wz0 + wz1) / 2), mat("outside", "#bcd3e8", "noise", scale=1.5, emit=1.6)))
    for z in (wz0, wz1, (wz0 + wz1) / 2):
        part(win, box(f"win_h_{z:.2f}", (wx1 - wx0 + 0.1, 0.08, 0.06), (0, 0, z), fr))
    for x in (wx0, wx1, (wx0 + wx1) / 2):
        part(win, box(f"win_v_{x:.2f}", (0.06, 0.08, wz1 - wz0), (x - (wx0 + wx1) / 2, 0, (wz0 + wz1) / 2), fr))
    # Left wall (x = -W/2) with a door at y in [0.05, 0.95].
    dy0, dy1, dh = 0.05, 0.95, 2.05
    lw = thing("wall_left", "left wall with doorway", "wall", "#d9d2c5", (-W / 2 - 0.05, 0, 0), 0, group="structure", sym="2")
    part(lw, box("wl_a", (0.1, dy0 + D / 2, H), (0, (-D / 2 + dy0) / 2, H / 2), wall_m))
    part(lw, box("wl_b", (0.1, D / 2 - dy1, H), (0, (dy1 + D / 2) / 2, H / 2), wall_m))
    part(lw, box("wl_t", (0.1, dy1 - dy0, H - dh), (0, (dy0 + dy1) / 2, (H + dh) / 2), wall_m))
    door = thing("door", "door", "door", "#6e4b2f", (-W / 2 + 0.02, dy0 + 0.02, 0), -70, sym="none")
    part(door, box("door_panel", (0.88, 0.045, 2.02), (0.0, 0.44, 1.01), mat("door_wood", "#6e4b2f", "wood", scale=3)))
    part(door, sphere("door_knob", (0.03, 0.03, 0.03), (0.06, 0.82, 1.0), mat("brass", "#b8913a", "plain", rough=0.25, metal=1.0)))
    thing("wall_right", "right wall", "wall", "#d9d2c5", (W / 2 + 0.05, 0, 0), 0, group="structure", sym="2")
    part(OBJECTS[-1], box("wr", (0.1, D, H), (0, 0, H / 2), wall_m))
    thing("wall_front", "front wall", "wall", "#d9d2c5", (0, -D / 2 - 0.05, 0), 0, group="structure", sym="2")
    part(OBJECTS[-1], box("wf", (W, 0.1, H), (0, 0, H / 2), wall_m))
    pic = thing("picture", "framed picture", "picture", "#2f5f7f", (-W / 2 + 0.03, -1.2, 0), 90, sym="2")
    part(pic, box("pic_frame", (0.9, 0.04, 0.65), (0, 0, 1.55), mat("frame_black", "#1c1c1c", "plain", rough=0.4)))
    part(pic, box("pic_canvas", (0.8, 0.05, 0.55), (0, -0.005, 1.55), mat("canvas", "#2f5f7f", "wave", base2="#d9a441", scale=3, rough=0.8)))
    # Furniture.
    rug = slab("rug", "patterned rug", "rug", (2.4, 1.7, 0.012), (0.9, -0.3, 0.006),
               mat("rug", "#8c2f39", "checker", base2="#d8c9a3", scale=2.5, rough=0.95), "#8c2f39", group="thing", yaw=90)
    make_sofa("sofa", (2.75, -0.3, 0), -90)             # against the right wall, facing -X
    make_table("coffee_table", "coffee table", "table", (1.1, 0.6, 0.42), (1.45, -0.3, 0), 90, wood="#5e3b24")
    make_table("dining_table", "dining table", "table", (1.6, 0.9, 0.75), (-1.2, -0.4, 0), 0, wood="#8a5a33")
    make_chair("chair_1", (-1.65, -1.05, 0), 180)        # south side, facing +Y (toward the table)
    make_chair("chair_2", (-0.75, -1.05, 0), 180)
    make_chair("chair_3", (-1.65, 0.25, 0), 0)            # north side, facing -Y
    make_chair("chair_sit", (-2.3, 1.85, 0), 30, seat="#8a3e3e", label="armless chair")   # by the window: A sits here
    make_shelf("shelf", (1.8, D / 2 - 0.2, 0), 0)
    make_lamp("floor_lamp", (-2.85, 2.35, 0))
    make_plant("plant_tall", (0.6, D / 2 - 0.35, 0), height=1.3)
    make_table("side_table", "side table", "table", (0.5, 0.5, 0.55), (2.95, 1.25, 0), 0, wood="#4a3020")
    make_plant("plant_small", (2.95, 1.25, 0.55), height=0.45, pot="#e0ddd6")
    OBJECTS[-1]["root"].location.z = 0.55
    make_plant("plant_floor", (2.9, -2.2, 0), height=0.9, pot="#3d4f6b")
    cup = make_box("box", (1.3, -0.2, 0.42), color="#c8743a", size=(0.26, 0.2, 0.14), label="cardboard box")
    # Lights: sun through the window, a soft ceiling panel, a cool sky fill.
    world_sky(strength=0.6)
    sun((58, 0, 200), energy=3.0)
    area((0.3, 0.2, H - 0.05), 2.4, 260)
    area((-1.0, D / 2 - 0.3, 1.6), 1.5, 120, color=(0.85, 0.9, 1.0))

    # People.
    A = make_person("person_a", "man in a navy jacket", 1.8, top="#24324f", bottom="#3b3f46", skin="#b07a55")
    B = make_person("person_b", "woman in a yellow sweater", 1.68, female=True, top="#d8a92f", bottom="#2c3e63",
                    skin="#e0ac86", hair="#3a2a20", long_sleeves=True)
    calibrate_ik(A)
    calibrate_ik(B)
    fps = FPS
    # A: in through the door, across to the armless chair, turns, sits.
    pa = Path([(-3.0, 0.5), (-2.55, 0.62), (-2.15, 0.95), (-2.05, 1.35)])
    walk_end = 2.6
    mva = Mover(pa, [(0.0, walk_end, pa.length / walk_end)])
    chair = next(o for o in OBJECTS if o["id"] == "chair_sit")
    chair_yaw = 30.0
    seat_c = chair["root"].location.copy()
    fwd_c = Vector((math.sin(math.radians(chair_yaw)), -math.cos(math.radians(chair_yaw)), 0))
    stand_spot = seat_c + fwd_c * 0.42
    # B: gestures by the shelf, reaches up to it, walks to the coffee table, picks the box up.
    pb_path = Path([(1.55, 2.0), (1.2, 1.2), (0.8, 0.3), (0.72, -0.2)])
    for f in range(NFRAMES):
        t = f / fps
        # ---- A
        if t <= walk_end:
            walk_pose(A, f, pa, mva, t)
        else:
            u_turn = smooth((t - walk_end) / 0.5)
            end_pos, end_d = pa.at(pa.length)
            yaw0 = yaw_of(end_d)
            yaw = yaw0 + ((chair_yaw - yaw0 + 180) % 360 - 180) * u_turn
            pos = end_pos.lerp(stand_spot, u_turn)
            u_sit = smooth((t - walk_end - 0.55) / 1.1)
            s = A["s"]
            dz = (0.9 * s - 0.49) * u_sit                      # pelvis from standing height to the seat
            back = 0.36 * u_sit                                 # and back over the seat
            lean = 28 * math.sin(math.pi * min(1.0, u_sit)) + 6 * u_sit
            feet = {"l": (0.12 * s, -0.12 * u_sit, 0.035 * s), "r": (-0.12 * s, -0.12 * u_sit, 0.035 * s)}
            hands = {"l": (0.24 * s, -0.25 * u_sit, 1.47 * s - 0.55 - dz + 0.15 * u_sit), "r": (-0.24 * s, -0.25 * u_sit, 1.47 * s - 0.55 - dz + 0.15 * u_sit)}
            hold_pose(A, f, pos, yaw, pelvis_dz=dz, spine=lean, neck=-lean * 0.5, feet=feet, hands=hands, pelvis_back=back)
        # ---- B
        s = B["s"]
        if t < 1.3:     # talking: both hands gesturing in front of the chest, head nods
            g = t * 2 * math.pi
            hands = {"l": (0.18 * s + 0.06 * math.sin(g * 1.3), -0.28 * s - 0.05 * math.sin(g * 0.9), 1.12 * s + 0.07 * math.sin(g * 1.7)),
                     "r": (-0.2 * s - 0.05 * math.sin(g * 1.1 + 1), -0.3 * s - 0.06 * math.cos(g), 1.15 * s + 0.08 * math.sin(g * 1.4 + 0.5))}
            hold_pose(B, f, (1.55, 2.0, 0), 0.0, spine=3, neck=6 * math.sin(g * 0.8), head_turn=15 * math.sin(g * 0.5), hands=hands)
        elif t < 2.35:  # turn to the shelf and reach the top shelf with the right hand
            u = smooth((t - 1.3) / 0.35)
            v = smooth((t - 1.55) / 0.45) * (1 - smooth((t - 2.05) / 0.3))
            yaw = 180.0 * u
            shelf_pt = Vector((1.62, 2.42, 1.62))
            hands = {"r": None, "l": None}
            hold_pose(B, f, (1.55, 2.0, 0), yaw, spine=-4 * v, neck=-18 * v, hands=hands)
            if v > 0:
                bpy.context.view_layer.update()
                rest = B["root"].matrix_world @ Vector((-0.22 * s, -0.02, 0.93 * s))
                key_obj(B["targets"]["r_hand_t"], f, loc=rest.lerp(shelf_pt, v))
        elif t < 4.05:  # walk to the coffee table
            mv = Mover(pb_path, [(2.35, 4.05, pb_path.length / 1.7)])
            walk_pose(B, f, pb_path, mv, t)
        else:           # pick the box up off the coffee table
            u = smooth((t - 4.05) / 0.5)
            up = smooth((t - 4.85) / 0.6)
            end_pos, end_d = pb_path.at(pb_path.length)
            yaw0 = yaw_of(end_d)
            yaw = yaw0 + ((90.0 - yaw0 + 180) % 360 - 180) * u     # face +X, toward the table
            bend = u * (1 - up)
            dz = 0.28 * bend
            box_world = cup["root"].location.copy()
            hands_grab = box_world + Vector((0, 0, 0.12))
            hold_pose(B, f, (0.72, -0.2, 0), yaw, pelvis_dz=dz, spine=48 * bend + 5 * up, neck=-20 * bend, hands={"l": None, "r": None},
                      feet={"l": (0.13 * s, 0.05, 0.035 * s), "r": (-0.13 * s, -0.08, 0.035 * s)})
            bpy.context.view_layer.update()
            carry = B["root"].matrix_world @ Vector((0, -0.38 * s, 1.0 * s))
            reach = hands_grab.lerp(carry, up)
            for side, dx in (("l", 0.13), ("r", -0.13)):
                key_obj(B["targets"][f"{side}_hand_t"], f, loc=reach + B["root"].matrix_world.to_3x3() @ Vector((dx, 0, 0)))
            if up > 0:
                key_obj(cup["root"], f, loc=reach - Vector((0, 0, 0.12)), rot=(0, 0, B["root"].rotation_euler.z))
        if f == 0 or t < 4.85:
            key_obj(cup["root"], f, loc=(1.3, -0.2, 0.42), rot=(0, 0, 0))
    # Handheld camera: an arc round the two people with breathing, shake and a drifting roll.
    camera(26.0)
    for f in range(NFRAMES):
        t = f / fps
        u = smooth(t / (NFRAMES / fps))
        ang = math.radians(-95 + 55 * u)
        R = 2.7
        cx, cy = 0.1 + R * math.cos(ang), 0.05 + R * math.sin(ang)
        pos = Vector((cx + shake(t, 1, 0.018), cy + shake(t, 2, 0.018), 1.55 + 0.015 * math.sin(2 * math.pi * 0.25 * t) + shake(t, 3, 0.012)))
        tgt = Vector((-0.7 + 1.3 * u, 1.3 - 0.7 * u, 1.05)) + Vector((shake(t, 4, 0.03), shake(t, 5, 0.03), shake(t, 6, 0.025)))
        roll = 3.5 * math.sin(2 * math.pi * 0.18 * t + 0.4) + shake(t, 7, 0.8)
        key_camera(f, pos, tgt, roll)


def build_street():
    asphalt = mat("asphalt", "#3a3b3d", "noise", base2="#2b2c2e", scale=1.5, rough=0.85, bump=0.25)
    walk_m = mat("sidewalk", "#b9b4aa", "tiles", base2="#a8a297", scale=0.9, rough=0.9, bump=0.2)
    kerb_m = mat("kerb", "#9d9a93", "noise", scale=4, rough=0.85, bump=0.2)
    paint = mat("roadpaint", "#e9e7df", "noise", scale=8, rough=0.6)
    yellow = mat("roadyellow", "#d8b84a", "noise", scale=8, rough=0.6)
    # Main road along Y: x in [-5.4, 5.4]; side street to +X: y in [9.4, 16.6].
    road = slab("road", "asphalt road (main street)", "road", (10.8, 90, 0.02), (0, 10, 0.0), asphalt, "#3a3b3d")
    part(road, box("road_side", (40, 7.2, 0.02), (25.4, 3.0, 0.0), asphalt))
    for y in range(-34, 56, 6):
        if 8.5 < y < 17.5:
            continue
        part(road, box(f"lane_{y}", (0.12, 3.0, 0.01), (0, y - 10, 0.012), paint))
    for x in (-5.0, 5.0):
        part(road, box(f"edge_{x}", (0.12, 90, 0.01), (x, 0, 0.012), paint))
    cw = thing("crosswalk", "crosswalk stripes", "marking", "#e9e7df", (6.4, 13.0, 0), 90, group="structure", sym="2")
    for i in range(7):
        part(cw, box(f"cw_{i}", (0.5, 2.6, 0.01), (-2.7 + i * 0.9, 0, 0.013), paint))
    stop = thing("stop_line", "stop line", "marking", "#e9e7df", (2.7, 7.6, 0), 0, group="structure", sym="2")
    part(stop, box("stopl", (5.2, 0.35, 0.01), (0, 0, 0.013), paint))
    # Sidewalks (kerb 0.15 m) and kerbs as their own objects.
    slab("sidewalk_left", "left sidewalk", "sidewalk", (2.5, 90, 0.15), (-6.65, 10, 0.075), walk_m, "#b9b4aa")
    slab("sidewalk_right_a", "right sidewalk (near)", "sidewalk", (2.5, 44.4, 0.15), (6.65, -12.8, 0.075), walk_m, "#b9b4aa")
    slab("sidewalk_right_b", "right sidewalk (far)", "sidewalk", (2.5, 38.4, 0.15), (6.65, 35.8, 0.075), walk_m, "#b9b4aa")
    slab("kerb_left", "left kerb", "kerb", (0.2, 90, 0.16), (-5.5, 10, 0.08), kerb_m, "#9d9a93")
    slab("kerb_right_a", "right kerb (near)", "kerb", (0.2, 44.4, 0.16), (5.5, -12.8, 0.08), kerb_m, "#9d9a93")
    slab("kerb_right_b", "right kerb (far)", "kerb", (0.2, 38.4, 0.16), (5.5, 35.8, 0.08), kerb_m, "#9d9a93")
    slab("sidewalk_side_s", "side-street sidewalk (south)", "sidewalk", (37.5, 2.5, 0.15), (26.65, 8.15, 0.075), walk_m, "#b9b4aa")
    slab("sidewalk_side_n", "side-street sidewalk (north)", "sidewalk", (37.5, 2.5, 0.15), (26.65, 17.85, 0.075), walk_m, "#b9b4aa")
    # Buildings.
    bl = thing("bldg_left", "brick building front (left)", "building", "#a35a43", (-7.9, 10, 0), 90, group="structure", sym="2")
    _facade_into(bl, 90, 11.0, "#a35a43", door_xs=(-6.0, 9.0))
    br1 = thing("bldg_right_a", "stone building front (right, near)", "building", "#c9c3b8", (7.9, -12.8, 0), -90, group="structure", sym="2")
    _facade_into(br1, 44.4, 9.6, "#c9c3b8", door_xs=(4.0,))
    br2 = thing("bldg_right_b", "brick building front (right, far)", "building", "#8e4b3b", (7.9, 35.8, 0), -90, group="structure", sym="2")
    _facade_into(br2, 38.4, 13.0, "#8e4b3b", door_xs=(-8.0,))
    ground = slab("ground", "ground beyond", "ground", (300, 300, 0.02), (0, 0, -0.03), mat("dirt", "#6f6a5e", "noise", scale=0.5, rough=1.0), "#6f6a5e")
    # Street furniture.
    for i, y in enumerate((-14, -2, 22, 34)):
        make_pole(f"pole_r{i}", (7.4, y, 0), -90)
    for i, y in enumerate((-8, 4, 16, 28)):
        make_pole(f"pole_l{i}", (-7.4, y, 0), 90)
    make_sign("stop_sign", (6.0, 7.4, 0.15), 0, "stop")
    make_sign("street_sign", (6.1, 8.2, 0.15), 90, "street")
    make_bin("bin_1", (-7.3, 1.5, 0.15))
    make_bin("bin_2", (7.35, 3.5, 0.15), color="#3b3f45")
    make_bench("bench_1", (7.4, -4.0, 0.15), -90)          # faces -X, the road
    make_bench("bench_2", (-7.5, -11.0, 0.15), 90)
    make_tree("tree_1", (6.9, -9.5, 0.15), 6.5)
    make_tree("tree_2", (-7.0, 7.0, 0.15), 7.0)
    make_tree("tree_3", (-7.0, 20.0, 0.15), 6.0)
    make_tree("tree_4", (6.9, 24.0, 0.15), 6.8)
    make_hydrant("hydrant", (6.1, -1.5, 0.15))
    for o in OBJECTS:
        if o["cls"] in ("pole", "sign", "bin", "bench", "tree", "hydrant"):
            o["root"].location.z = 0.15
    # Parked cars.
    make_car("car_parked_1", "parked silver sedan", "#b7bbbf", (4.3, -6.5, 0), 180)
    make_car("car_parked_2", "parked dark blue sedan", "#1f2f55", (4.3, 0.5, 0), 180)
    make_car("car_parked_3", "parked white hatchback", "#e6e6e2", (-4.3, 13.5, 0), 0, kind="hatch")
    make_car("car_parked_4", "parked black sedan", "#1a1a1c", (16.0, 15.2, 0), 90)
    # The car that turns: northbound in the right lane (x = +1.8), right turn into the side street (eastbound y = 11.2).
    car = make_car("car_turn", "red sedan (turning)", "#a3221e", (1.8, -16, 0), 180, dynamic=True)
    cpath = arc_path((1.8, -16.0), 180, [("s", 21.2), ("r", 6.0, -90), ("s", 20)])
    cmov = Mover(cpath, [(0.0, 1.6, 7.0), (1.6, 3.2, 5.2), (3.2, 6.0, 6.5)])
    for f in range(NFRAMES):
        t = f / FPS
        p, d = cpath.at(cmov.s_at(t))
        key_obj(car["root"], f, loc=(p.x, p.y, 0), rot=(0, 0, math.radians(yaw_of(d))))
    # People: a pedestrian walking toward camera while on the phone; one sitting on the bench; one at the corner gesturing.
    C = make_person("person_c", "man in a grey hoodie", 1.78, top="#6d7176", bottom="#25324a", skin="#8d5a3c")
    Dp = make_person("person_d", "woman in a green coat", 1.66, female=True, top="#3f6b4f", bottom="#2a2a2e", skin="#e7b996", hair="#6b4a2a")
    E = make_person("person_e", "man in a white shirt", 1.82, top="#e8e6e0", bottom="#3a3a3a", skin="#c68a63", long_sleeves=False)
    for P in (C, Dp, E):
        calibrate_ik(P)
    pc = Path([(6.3, 6.5), (6.4, -2.5)])
    mvc = Mover(pc, [(0.0, 6.0, 1.25)])
    bench = next(o for o in OBJECTS if o["id"] == "bench_1")
    for f in range(NFRAMES):
        t = f / FPS
        walk_pose(C, f, pc, mvc, t, carry={"r"}, base_z=0.15)
        bpy.context.view_layer.update()
        phone = C["root"].matrix_world @ Vector((-0.12 * C["s"], -0.06, 1.62 * C["s"]))
        key_obj(C["targets"]["r_hand_t"], f, loc=phone)
        key_bone(C, "head", f, rx=math.radians(8), rz=math.radians(-12))
        s = Dp["s"]
        bpos = bench["root"].location.copy()
        hold_pose(Dp, f, (bpos.x - 0.42, bpos.y + 0.3, 0.15), -90.0, pelvis_dz=0.15 + 0.9 * s - 0.70, spine=6, neck=-4,
                  head_turn=25 * math.sin(2 * math.pi * 0.15 * t), pelvis_back=0.4,
                  feet={"l": (0.12 * s, -0.05, 0.035 * s), "r": (-0.12 * s, -0.05, 0.035 * s)},
                  hands={"l": (0.2 * s, -0.25, 0.64), "r": (-0.2 * s, -0.25, 0.64)})
        s = E["s"]
        g = 2 * math.pi * t
        hold_pose(E, f, (5.0 + 1.6, 8.9, 0.15), -30.0 + 10 * math.sin(0.4 * g), spine=2, neck=4 * math.sin(g * 0.7), head_turn=20 * math.sin(0.3 * g),
                  feet={"l": (0.12 * s, 0.0, 0.035 * s), "r": (-0.12 * s, 0.05, 0.035 * s)},
                  hands={"r": (-0.25 * s + 0.1 * math.sin(g * 0.9), -0.35 * s - 0.08 * math.sin(g * 1.3), 1.25 * s + 0.12 * math.sin(g * 1.1)),
                         "l": (0.24 * s, -0.04, 0.93 * s)})
    world_sky(strength=1.0, sun_elev=28, sun_rot=210)
    sun((62, 0, 215), energy=4.0, color=(1.0, 0.93, 0.82))
    camera(30.0)
    for f in range(NFRAMES):
        t = f / FPS
        u = smooth(t / (NFRAMES / FPS))
        pos = Vector((-6.4, -6.0 + 7.0 * u, 1.35))
        p, _ = cpath.at(cmov.s_at(t))
        aim = Vector((p.x * 0.75 + 1.5, p.y * 0.75 + 3.0, 1.0))
        key_camera(f, pos + Vector((0, 0, 0.004 * math.sin(7 * t))), aim)


def _facade_into(o, length, height, color, door_xs=()):
    """A building block (6 m deep) whose front faces local -Y, centred on the root; windows on every floor."""
    wallm = mat(f"brick_{color}", color, "brick", base2="#7d4535" if color != "#c9c3b8" else "#b3ab9d", scale=1.6, rough=0.85, bump=0.3)
    glass = mat("win_glass", "#2a3442", "plain", rough=0.06, metal=0.7)
    frame = mat("win_frame", "#e9e6df", "plain", rough=0.5)
    depth = 6.0
    part(o, box(f"{o['id']}_mass", (length, depth, height), (0, depth / 2, height / 2), wallm))
    part(o, box(f"{o['id']}_cornice", (length, 0.4, 0.35), (0, -0.1, height - 0.2), mat("cornice", "#d8d2c6", "noise", scale=4)))
    floors = int(height // 3.2)
    nx = int(length // 3.0)
    for fl in range(floors):
        z = 1.5 + fl * 3.2
        for i in range(nx):
            x = -length / 2 + (i + 0.5) * length / nx
            if fl == 0 and any(abs(x - dx) < 1.6 for dx in door_xs):
                continue
            part(o, box(f"{o['id']}_wf_{fl}_{i}", (1.3, 0.1, 1.7), (x, -0.04, z + 0.45), frame))
            part(o, box(f"{o['id']}_wg_{fl}_{i}", (1.12, 0.12, 1.5), (x, -0.05, z + 0.45), glass))
    for dx in door_xs:
        part(o, box(f"{o['id']}_door_{dx}", (1.4, 0.12, 2.4), (dx, -0.05, 1.2), mat("door_dark", "#3a2a1e", "wood", scale=4)))
        part(o, box(f"{o['id']}_awning_{dx}", (2.2, 1.0, 0.12), (dx, -0.5, 2.8), mat("awning", "#2f5d4f", "noise", scale=10)))


def build_drone():
    asphalt = mat("asphalt", "#3a3b3d", "noise", base2="#2b2c2e", scale=1.2, rough=0.85, bump=0.25)
    walk_m = mat("sidewalk", "#bdb8ae", "tiles", base2="#aaa49a", scale=0.8, rough=0.9, bump=0.2)
    kerb_m = mat("kerb", "#9d9a93", "noise", scale=4, rough=0.85, bump=0.2)
    paint = mat("roadpaint", "#e9e7df", "noise", scale=8, rough=0.6)
    yellow = mat("roadyellow", "#d8b84a", "noise", scale=8, rough=0.6)
    green = mat("bikelane", "#3f7d4f", "noise", scale=3, rough=0.8)
    grass = mat("grass", "#5d7f3e", "noise", base2="#46612d", scale=0.8, rough=1.0, bump=0.3)
    road = slab("road", "four-lane road", "road", (14.4, 160, 0.02), (0, 10, 0.0), asphalt, "#3a3b3d")
    for x in (-3.6, 3.6):
        for y in range(-70, 90, 9):
            part(road, box(f"lane_{x}_{y}", (0.14, 3.0, 0.01), (x, y - 10, 0.012), paint))
    for x in (-0.12, 0.12):
        part(road, box(f"yellow_{x}", (0.1, 160, 0.01), (x, 0, 0.012), yellow))
    for sx in (-1, 1):
        part(road, box(f"edge_{sx}", (0.14, 160, 0.01), (sx * 7.1, 0, 0.012), paint))
    slab("bike_lane_r", "bike lane (right)", "bike_lane", (1.5, 160, 0.02), (7.95, 10, 0.0), green, "#3f7d4f")
    slab("bike_lane_l", "bike lane (left)", "bike_lane", (1.5, 160, 0.02), (-7.95, 10, 0.0), green, "#3f7d4f")
    for sx, nm in ((1, "right"), (-1, "left")):
        slab(f"kerb_{nm}", f"{nm} kerb", "kerb", (0.2, 160, 0.16), (sx * 8.8, 10, 0.08), kerb_m, "#9d9a93")
        slab(f"sidewalk_{nm}", f"{nm} sidewalk", "sidewalk", (3.0, 160, 0.15), (sx * 10.4, 10, 0.075), walk_m, "#bdb8ae")
        slab(f"verge_{nm}", f"{nm} grass verge", "grass", (6.0, 160, 0.1), (sx * 14.9, 10, 0.05), grass, "#5d7f3e")
    zebra = thing("crosswalk", "crosswalk", "marking", "#e9e7df", (0, 22, 0), 0, group="structure", sym="2")
    for i in range(16):
        part(zebra, box(f"z_{i}", (0.55, 3.0, 0.01), (-6.8 + i * 0.9, 0, 0.013), paint))
    slab("ground", "ground beyond", "ground", (400, 400, 0.02), (0, 0, -0.03), mat("dirt", "#6f6a5e", "noise", scale=0.5, rough=1.0), "#6f6a5e")
    # Low buildings set back beyond the verges.
    for i, (y0, h, col) in enumerate(((-30, 7.0, "#b9a48a"), (-8, 9.5, "#a35a43"), (16, 6.5, "#c9c3b8"), (38, 8.0, "#8e4b3b"))):
        b1 = thing(f"bldg_r{i}", f"building (right) {i + 1}", "building", col, (22.9, y0, 0), -90, group="structure", sym="2")
        _facade_into(b1, 18.0, h, col, door_xs=(0.0,))
        b2 = thing(f"bldg_l{i}", f"building (left) {i + 1}", "building", col, (-22.9, y0 + 9, 0), 90, group="structure", sym="2")
        _facade_into(b2, 18.0, h + 1.5, col, door_xs=(2.0,))
    # Street furniture.
    for i, y in enumerate(range(-40, 61, 20)):
        make_pole(f"pole_r{i}", (9.6, y, 0.15), -90, height=7.5)
        make_pole(f"pole_l{i}", (-9.6, y + 10, 0.15), 90, height=7.5)
    for i, y in enumerate((-32, -12, 6, 30, 50)):
        make_tree(f"tree_r{i}", (14.5, y, 0.1), 7.0 + (i % 2))
        make_tree(f"tree_l{i}", (-14.5, y + 6, 0.1), 6.5 + (i % 3) * 0.5)
    make_bin("bin_r", (11.3, -2.0, 0.15))
    make_bin("bin_l", (-11.3, 14.0, 0.15), color="#3b3f45")
    make_bench("bench_r", (11.4, 2.0, 0.15), -90)
    make_sign("sign_r", (9.2, 18.5, 0.15), 0, "street")
    make_sign("stop_l", (-9.2, 24.6, 0.15), 180, "stop")
    for o in OBJECTS:
        if o["cls"] in ("pole", "sign", "bin", "bench"):
            o["root"].location.z = 0.15
        if o["cls"] == "tree":
            o["root"].location.z = 0.1
    # Parked cars on the right verge lot.
    make_car("car_parked_1", "parked white sedan", "#e2e2de", (15.5, 40.0, 0.1), 90)
    make_car("car_parked_2", "parked grey sedan", "#7d8186", (15.5, 43.0, 0.1), 90)
    for o in OBJECTS[-2:]:
        o["root"].location.z = 0.1
    # Traffic.
    traffic = [("car_n1", "silver sedan", "#b7bbbf", 1.8, -60.0, 12.0, 1), ("car_n2", "blue hatchback", "#2c4f8a", 5.4, -48.0, 10.5, 1),
               ("car_n3", "white sedan", "#ececea", 1.8, -30.0, 12.5, 1), ("car_s1", "red sedan", "#a3221e", -1.8, 40.0, 11.0, -1),
               ("car_s2", "black sedan", "#1a1a1c", -5.4, 20.0, 10.0, -1), ("car_s3", "yellow taxi", "#e2b322", -1.8, 70.0, 12.0, -1)]
    movers = []
    for oid, label, col, x, y0, v, dirn in traffic:
        c = make_car(oid, label, col, (x, y0, 0), 180 if dirn > 0 else 0, dynamic=True, kind="hatch" if "hatch" in label else "sedan")
        movers.append((c, x, y0, v, dirn))
    van = thing("van_n", "white box van", "truck", "#e8e8e4", (5.4, -15, 0), 180, dynamic=True)
    vm = mat("vanwhite", "#e8e8e4", "paint", scale=2, rough=0.35, metal=0.2, bump=0)
    part(van, box("van_body", (2.1, 5.6, 2.4), (0, 0.4, 1.55), vm))
    part(van, box("van_cab", (2.0, 1.4, 1.5), (0, -2.9, 1.1), vm))
    part(van, box("van_glass", (1.9, 0.1, 0.7), (0, -3.62, 1.45), mat("glass", "#1b2430", "plain", rough=0.08, metal=0.6)))
    for sx in (-1, 1):
        for y in (-2.7, 1.9):
            part(van, cyl(f"van_w_{sx}_{y}", 0.4, 0.3, (sx * 0.95, y, 0.4), mat("tyre", "#161616", "noise", scale=20, rough=0.9), rot=(0, math.pi / 2, 0)))
    movers.append((van, 5.4, -15.0, 9.0, 1))
    for f in range(NFRAMES):
        t = f / FPS
        for c, x, y0, v, dirn in movers:
            key_obj(c["root"], f, loc=(x, y0 + dirn * v * t, 0), rot=(0, 0, math.radians(180 if dirn > 0 else 0)))
    # The cyclist (rider) in the right bike lane, northbound at 5 m/s, pedalling.
    bike = make_bicycle("bicycle", "#2a6f9e", (7.95, -6.0, 0), 180)
    rider = make_person("rider", "cyclist in an orange jacket", 1.76, top="#d9682b", bottom="#1f1f24", skin="#c68a63")
    calibrate_ik(rider)
    W1 = make_person("walker_1", "woman in a red coat", 1.66, female=True, top="#a8302b", bottom="#22283a", skin="#e0ac86", hair="#2a1d16")
    W2 = make_person("walker_2", "man in a beige jacket", 1.8, top="#b59a6e", bottom="#30343a", skin="#7d5136")
    calibrate_ik(W1)
    calibrate_ik(W2)
    pw1 = Path([(10.0, -14.0), (10.2, 2.0)])
    pw2 = Path([(-10.3, 16.0), (-10.1, 4.0)])
    m1 = Mover(pw1, [(0, 6, 1.35)])
    m2 = Mover(pw2, [(0, 6, 1.2)])
    s = rider["s"]
    for f in range(NFRAMES):
        t = f / FPS
        y = -6.0 + 5.0 * t
        key_obj(bike["root"], f, loc=(7.95, y, 0), rot=(0, 0, math.radians(180)))
        bpy.context.view_layer.update()
        M = bike["root"].matrix_world
        saddle = M @ bike["saddle"]
        crank = M @ bike["crank"]
        ang = t * 2 * math.pi * 1.4
        R3 = M.to_3x3()
        pedal = {"l": crank + R3 @ Vector((0.11, 0.17 * math.sin(ang), 0.17 * math.cos(ang))),
                 "r": crank + R3 @ Vector((-0.11, -0.17 * math.sin(ang), -0.17 * math.cos(ang)))}
        yaw = math.radians(180)
        key_obj(rider["root"], f, loc=(saddle.x, saddle.y + 0.0, saddle.z - 0.9 * s + 0.04), rot=(0, 0, yaw))
        key_obj(rider["targets"]["l_foot_t"], f, loc=pedal["l"] + Vector((0, 0, 0.04)))
        key_obj(rider["targets"]["r_foot_t"], f, loc=pedal["r"] + Vector((0, 0, 0.04)))
        g1, g2 = bike["grips"]
        key_obj(rider["targets"]["l_hand_t"], f, loc=M @ g1)
        key_obj(rider["targets"]["r_hand_t"], f, loc=M @ g2)
        key_bone(rider, "spine", f, rx=math.radians(30))
        key_bone(rider, "chest", f, rx=math.radians(8))
        key_bone(rider, "neck", f, rx=math.radians(-20))
        key_bone(rider, "head", f, rx=math.radians(-10))
        walk_pose(W1, f, pw1, m1, t, base_z=0.15)
        walk_pose(W2, f, pw2, m2, t, base_z=0.15)
    world_sky(strength=1.0, sun_elev=40, sun_rot=150)
    sun((48, 0, 150), energy=4.2, color=(1.0, 0.95, 0.88))
    camera(24.0)
    for f in range(NFRAMES):
        t = f / FPS
        u = smooth(t / (NFRAMES / FPS))
        pos = Vector((-3.0 + 1.0 * u, -42.0 + 18.0 * u, 22.0 - 3.0 * u))
        tgt = Vector((0.5, -12.0 + 18.0 * u, 0.0))
        key_camera(f, pos + Vector((shake(t, 11, 0.05), shake(t, 12, 0.05), shake(t, 13, 0.04))), tgt, roll_deg=1.2 * math.sin(0.6 * t))


# ------------------------------------------------------------------------------------------------ truth
COCO = ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "r_hip", "r_knee", "r_ankle",
        "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear"]


def person_keypoints(o, dg):
    """COCO-18 world points (Blender) from the posed rig: same definitions as web/stage/posepass.mjs personKeypoints."""
    arm, s = o["arm"].evaluated_get(dg), o["s"]
    Mw = arm.matrix_world

    def at(bname, rest_pt):
        pb = arm.pose.bones[bname]
        deform = pb.matrix @ pb.bone.matrix_local.inverted()
        return Mw @ (deform @ Vector(rest_pt))
    hc = CLAY["head_c"] * s
    J = {}
    for side, sx in (("l", 1), ("r", -1)):
        b = arm.pose.bones
        J[f"{side}_shoulder"] = Mw @ b[f"{side}_upper"].head
        J[f"{side}_elbow"] = Mw @ b[f"{side}_fore"].head
        J[f"{side}_wrist"] = Mw @ b[f"{side}_hand"].head
        J[f"{side}_hip"] = Mw @ b[f"{side}_thigh"].head
        J[f"{side}_knee"] = Mw @ b[f"{side}_shin"].head
        J[f"{side}_ankle"] = Mw @ b[f"{side}_foot"].head
        J[f"{side}_eye"] = at("head", (sx * 0.035 * s, -0.09 * s, hc + 0.012 * s))
        J[f"{side}_ear"] = at("head", (sx * 0.093 * s, 0.0, hc))
    J["neck"] = (J["l_shoulder"] + J["r_shoulder"]) / 2
    J["nose"] = at("head", (0, -0.105 * s, hc - 0.012 * s))
    return [to_stage(J[k]) for k in COCO]


def obb_of_points(pts_local):
    xs = [p.x for p in pts_local]
    ys = [p.y for p in pts_local]
    zs = [p.z for p in pts_local]
    lo, hi = Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))
    return (lo + hi) / 2, hi - lo


def part_corners(objs):
    pts = []
    for ob in objs:
        if ob.type != "MESH":
            continue
        mw = ob.matrix_world
        pts += [mw @ Vector(c) for c in ob.bound_box]
    return pts


def write_truth():
    frames = list(range(0, NFRAMES))
    cam_frames, people = [], {o["id"]: [] for o in OBJECTS if o.get("arm")}
    dyn = {o["id"]: [] for o in OBJECTS if o["dynamic"]}
    static = {}
    W, H = RES
    for f in frames:
        SC.frame_set(f)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        mw = CAM.evaluated_get(dg).matrix_world
        R = M_STAGE @ mw.to_3x3()
        fx = CAM.data.lens / CAM.data.sensor_width * W
        cam_frames.append({"f": f, "pos": to_stage(mw.translation), "R": [[round(R[i][j], 6) for j in range(3)] for i in range(3)],
                           "fx": round(fx, 3), "fy": round(fx, 3), "cx": W / 2, "cy": H / 2})
        for o in OBJECTS:
            if o.get("arm"):
                people[o["id"]].append({"f": f, "J": person_keypoints(o, dg)})
            if o["dynamic"] or f == 0:
                rm = o["root"].evaluated_get(dg).matrix_world
                yaw_b = math.atan2(rm[1][0], rm[0][0])    # rotation about Z
                Rz = Matrix.Rotation(yaw_b, 4, "Z")
                frame_m = Matrix.Translation(rm.translation) @ Rz
                inv = frame_m.inverted()
                pts = [inv @ p for p in part_corners([ob.evaluated_get(dg) for ob in o["parts"]])]
                if not pts:
                    continue
                c_loc, size = obb_of_points(pts)
                c_w = frame_m @ c_loc
                ent = {"f": f, "c": to_stage(c_w), "yaw": round(math.degrees(yaw_b), 2),
                       "size": [round(size.x, 3), round(size.z, 3), round(size.y, 3)]}
                if o["dynamic"]:
                    dyn[o["id"]].append(ent)
                if f == 0:
                    static[o["id"]] = ent
    objs = []
    for o in OBJECTS:
        if o["id"] not in static:
            continue
        e = {"id": o["id"], "label": o["label"], "cls": o["cls"], "group": o["group"], "sym": o["sym"], "color": o["color"],
             "dynamic": o["dynamic"], "size": static[o["id"]]["size"], "id_color": PALETTE[o["id"]]}
        e["frames"] = dyn[o["id"]] if o["dynamic"] else [dict(static[o["id"]], f=-1)]
        objs.append(e)
    truth = {"schema": "v2s-bench/1", "clip": f"syn_{SCENE}", "kind": "synthetic", "scene": SCENE, "width": W, "height": H,
             "fps": FPS, "frames": NFRAMES, "axes": "stage: metres, Y up, ground y=0; Blender (x,y,z) -> (x,z,-y)",
             "camera": cam_frames, "objects": objs,
             "people": [{"id": pid, "object_id": pid, "joints": COCO, "frames": fr} for pid, fr in people.items()],
             "id_palette": PALETTE, "id_dir": "id", "color_dir": "color", "exact": True,
             "notes": ["camera R columns are the camera's x (right), y (up), z (back) axes in stage space, like three.js"]}
    with open(os.path.join(OUT, "truth.json"), "w") as fh:
        json.dump(truth, fh, separators=(",", ":"))
    print("truth.json:", len(objs), "objects,", len(people), "people,", len(cam_frames), "camera frames")


# ------------------------------------------------------------------------------------------------ render
def set_engine(name):
    for e in ([name] if isinstance(name, str) else name):
        try:
            SC.render.engine = e
            return e
        except TypeError:
            continue
    raise RuntimeError(f"none of {name} available")


def render_color():
    if ENGINE == "cycles":
        set_engine("CYCLES")
        SC.cycles.samples = SAMPLES
        SC.cycles.use_denoising = True
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            prefs.compute_device_type = "METAL"
            prefs.get_devices()
            for d in prefs.devices:
                d.use = True
            SC.cycles.device = "GPU"
        except Exception as exc:  # noqa: BLE001
            print("cycles GPU unavailable:", exc)
    else:
        set_engine(["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"])
        try:
            SC.eevee.taa_render_samples = SAMPLES
        except AttributeError:
            pass
        for attr, val in (("use_shadows", True), ("use_raytracing", True), ("use_gtao", True)):
            try:
                setattr(SC.eevee, attr, val)
            except AttributeError:
                pass
    SC.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in SC.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    try:
        SC.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    SC.render.film_transparent = False
    SC.render.image_settings.file_format = "PNG"
    SC.render.image_settings.color_mode = "RGB"
    SC.render.image_settings.color_depth = "8"
    os.makedirs(os.path.join(OUT, "color"), exist_ok=True)
    for f in range(0, NFRAMES, EVERY):
        SC.frame_set(f)
        SC.render.filepath = os.path.join(OUT, "color", f"{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        if f % 24 == 0:
            print("color", f, flush=True)


def render_id():
    set_engine("BLENDER_WORKBENCH")
    sh = SC.display.shading
    sh.light = "FLAT"
    sh.color_type = "OBJECT"
    for attr in ("show_shadows", "show_cavity", "show_object_outline", "show_specular_highlight", "show_xray", "use_dof"):
        try:
            setattr(sh, attr, False)
        except AttributeError:
            pass
    SC.display.render_aa = "OFF"
    SC.view_settings.view_transform = "Standard"
    try:
        SC.view_settings.look = "None"
    except TypeError:
        pass
    SC.render.film_transparent = True
    SC.render.image_settings.color_mode = "RGBA"
    for ob in bpy.data.objects:
        ob.hide_render = ob.type == "LIGHT"
    os.makedirs(os.path.join(OUT, "id"), exist_ok=True)
    for f in range(0, NFRAMES, EVERY):
        SC.frame_set(f)
        SC.render.filepath = os.path.join(OUT, "id", f"{f:04d}.png")
        bpy.ops.render.render(write_still=True)


def assign_ids():
    for i, o in enumerate(OBJECTS):
        c = _palette_color(i + 1)
        PALETTE[o["id"]] = c
        lin = [_srgb_to_lin(v / 255) for v in c] + [1.0]
        for ob in o["parts"]:
            ob.color = lin


# ------------------------------------------------------------------------------------------------ main
{"interior": build_interior, "street": build_street, "drone": build_drone}[SCENE]()
assign_ids()
bpy.context.view_layer.update()
write_truth()
if not ONLY_GT:
    render_color()
    render_id()
    if subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0 and EVERY == 1:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(OUT, "color", "%04d.png"),
                        "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(OUT, "source.mp4")])
        print("source.mp4 written")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f"syn_{SCENE}.blend"))
print("DONE", OUT)
