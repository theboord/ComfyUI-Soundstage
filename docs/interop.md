# Interop: Blender · Unreal · Maya · Nuke

Bring a whole world in from Blender, Unreal Engine, Maya or Sketchfab and shoot in it. Then send the staged shot back
out to any of the four apps. Code: `web/stage/interop/` (the import, the export, and the builder scripts in `dcc/`).
Tests: `tests/js/interop.test.mjs` and `tests/test_interop_builders.py`. Round-trip tools: `tools/interop/`.

**What was verified where.** Blender 4.3 was run headless in both directions (see [Verified](#verified)). Unreal,
Maya and Nuke are not installed on the development machine, so their builder scripts have **not** been run in those
apps. Their maths (axes, centimetres, rotation orders, film backs, frame rates) is unit-tested outside the apps.

## Bring your world in

In ③ Set, choose **Import world…** and pick the file. For a `.gltf`, pick its `.bin` and textures too; for an
`.obj`, its `.mtl`. The world replaces the built-in set as the location. Your cast, props, lights and cameras stay.

| Format | Typical source | What the file says | What Soundstage does |
|---|---|---|---|
| GLB / glTF | Blender, Unreal (glTF export), Sketchfab | metres, Y up (the glTF spec) | uses it; flags a world whose size says centimetres |
| FBX | Unreal, Maya, Blender | `UpAxis` and `UnitScaleFactor` in GlobalSettings | reads both; Unreal FBX is Z up and cm, Maya FBX Y up and cm |
| OBJ / PLY / STL | anything | nothing | up axis from the floors (the biggest flat area), units from the size of the pieces |
| .spz .splat .ksplat .sog, splat .ply | Gaussian splat tools | nothing | the splat is shown in Color view; set its height by hand |
| .chan, camera.json | Nuke, Maya, a Layer Pack or DCC kit | a camera per frame | becomes a new shot, lens from the vfov |

What happens on import:

- **Units and up axis.** The answer comes from the file when the file has one, and from the geometry when it doesn't.
  The panel shows both answers and the reason for each, for example *Units: cm (the file says cm) · Up: Z (the file
  says)*. **Came from** (Blender / Unreal / Maya / Sketchfab), **Units** and **Up** override the guess.
- **Size readout and fixes.** The panel reads like *This world is 120 m × 80 m, 15 m tall*. When the size looks
  wrong, a one-click fix appears, for example *Fix scale ×0.01* for a centimetre world exported as metres, or
  *Stand it up* for a world lying on its side. **Make it N m tall** scales the world to a height you know.
- **The floor.** The main floor goes on the stage floor (y = 0). This is the lowest level with real area, not a roof
  or a table top. The file's own origin is kept when it lies inside the world, so exports land where they started.
  The stage's own floor plane is hidden (**Hide the stage floor**).
- **Physics.** The world's meshes become static box colliders for live drags and **Simulate & bake**, through
  `physengine.mjs`:
  - A prop-sized mesh (a table or a crate) becomes one box, turned to its own heading.
  - A closed solid that fills its box (a building block, a plain wall), or a round one (a column, a lamp post), is
    one box too.
  - Other big meshes become slabs. Their flat parts are grouped by plane, rasterised and covered with rectangles. A
    wall with a door becomes boxes around the doorway, so people still walk through it. A solid's two faces make
    one slab as thick as the solid.
  - Curved ground becomes height columns.
  - Transparent, foliage and sky meshes don't collide.
  - The 1,500 biggest boxes are kept (at most 400 from one mesh). The panel says how many small ones were left out.
  - In a world with more than 300 boxes, physics only gets the boxes within 25 m of an object's keyed path. They
    are picked again when objects move to another 10 m cell. This keeps drags live in big worlds.
- **Cameras become shots.** Each camera in the file becomes a shot. An animated camera is keyed every frame, and its
  lens comes from its field of view. A lens animation also comes in when the glTF carries it as
  `KHR_animation_pointer`, which Soundstage's own export writes. Camera roll is dropped, because the stage camera has
  none. When units or axes change, the shots are re-keyed so they stay locked to the world.
- **Animation.** Animated objects keep the file's own keys and play on the shot timeline at the shot fps, holding
  their last pose. FBX files with one take per object (Blender's "all actions") play one take per node.
- **Heavy worlds.** Static meshes are merged by material. Big worlds (over 300k triangles) are merged into spatial
  chunks, so the camera still culls what it can't see. Chunks over 60k triangles get a decimated far LOD. Lights in
  the file are switched off, because the stage lights the set.

Limits: three.js's FBX reader doesn't animate lenses, so FBX cameras keep their first-frame lens. Blender 4.3's glTF
exporter didn't write lens animation in our tests, even with its experimental pointer option, so lens moves from
Blender come in fixed. A world's skinned characters play their clip, but they are part of the set, not Soundstage
actors. Colliders are boxes. Splats get no colliders beyond the stage floor.

### Getting worlds out of each app

- **Blender:** File › Export › glTF 2.0 (.glb). Keep +Y Up on, and include Cameras and Animation.
- **Unreal:** select the actors, then File › Export Selected › glTF (.glb) or FBX. An FBX comes in as Z up and cm.
- **Maya:** File › Export All › FBX or OBJ (cm, Y up).
- **Nuke:** WriteGeo (OBJ or FBX) for geometry. Export the camera as a `.chan` (Camera › File › Export chan file)
  and pick it in **Import world…**. It becomes a shot.

## Send it back out

In ⑦ Deliver, choose **Export for Blender · Unreal · Maya · Nuke** › **Download the DCC kit**. You get one zip:

```
soundstage_<shot>/
  scene.glb            the whole stage: set or imported world, props, actors, lights; every move baked to keys
                       (one a frame); the camera "shot_cam" keyed per frame, its lens as KHR_animation_pointer
                       (/cameras/0/perspective/yfov) and in the node's extras; four 2 cm axis probes (ss_probe_*)
  set_frame1001.obj    frame-1001 geometry in world space (+ .mtl colours), for Nuke ReadGeo and Maya
  camera.json          the exact camera per frame, in the Layer Pack's format (cam_to_world, focal, ZXY angles)
  shot_cam.chan        Nuke / Maya .chan: frame tx ty tz rx ry rz vfov
  shot.json            fps, frame range, resolution, sensor, file names, probe positions, geometry bounds
  blender/build_blender.py   unreal/build_unreal.py   maya/build_maya.py   nuke/build_nuke.py
  README.txt
```

The conventions are glTF's throughout: metres, Y up, right-handed. The camera has a 36 mm wide sensor with horizontal
fit. Frame 1001 is Soundstage frame 0, as in the Layer Pack.

| App | Run | What the builder does | Status |
|---|---|---|---|
| **Blender** | `blender --python blender/build_blender.py`, or Scripting › Run | Sets the fps first (the glTF importer keys at the scene fps). Imports scene.glb and moves its keys so Soundstage frame 0 = 1001. Builds `shot_cam` from camera.json (sensor 36 mm, horizontal fit, lens keyed). Sets the frame range and render resolution. Shows `plates/` (Layer Pack frames) as the camera background. Clears Blender's untouched default cube. `--render out.png --frame N` makes a check render headless. | **Verified, Blender 4.3 headless** |
| **Unreal 5.x** | Tools › Execute Python Script… | Imports scene.glb into the open level with Interchange. Measures the importer's axis and unit mapping from the four probes, falling back to UE = (x, z, y) × 100. Spawns a CineCameraActor with a 36 mm filmback. Builds a Level Sequence at the shot fps over 1001–end, with location, rotation (FRotator from the camera's forward and up) and Current Focal Length keyed every frame, plus a camera cut. | Not tested in Unreal |
| **Maya** | Script Editor › Source Script… | Imports scene.glb when a glTF importer plug-in is loaded, else the OBJ. Scales either to the size shot.json records, in your working units. Creates `shot_cam` with rotate order zxy, a 36 mm film back (inches) and focal length keyed. Sets the fps, range and resolution. | Not tested in Maya |
| **Nuke 13+** | Script Editor › Source…, or `nuke -t` | Builds a Camera with rot order ZXY and haperture 36 mm, translate/rotate/focal keyed from camera.json. Adds a ReadGeo of the OBJ (Nuke doesn't read glTF), a Scene and a ScanlineRender at the shot format. | Not tested in Nuke |

What the untested builders rely on, and what the tests check:

- **Unreal.** `rotator_from_xz` inverts UE's `FRotationMatrix` over 200 random rotators. A stage camera looking down
  -Z lands at UE yaw -90° in centimetres. The probe solver recovers any axis permutation, scale and origin. The
  frame rate 23.976 is written as 24000/1001.
- **Maya and Nuke.** The keyed ZXY angles rebuild each frame's `cam_to_world` (R = Ry·Rx·Rz is both Maya's `zxy` and
  Nuke's `ZXY`). Translations are converted to cm. The film backs (36 mm = 1.417 in) and the Maya time units
  (`film`, `23.976fps`, `29.97fps`) are checked.
- **All of them.** The four scripts byte-compile and import without their host app. The JavaScript camera.json writer
  matches the Layer Pack's `camera.py` to 1e-5.

The Unreal step with the most risk is the Interchange call that imports a scene into the level
(`InterchangeManager.import_scene`). If it fails, the script imports the GLB as assets and says so. The Level
Sequence API names differ between 5.0 and 5.4, so the script tries both.

## Verified

Blender 4.3.2 was run headless (`--background --factory-startup`) on this Mac, using fresh files in a scratch folder
and nothing of the user's.

**(a) Blender → Soundstage.** `tools/interop/blender_make_test_world.py` builds a test room:

- a 10 × 8 m floor;
- 3 m walls, with a 1 × 2.1 m door;
- a 0.75 m table;
- a crate that slides 2 m;
- a camera that dollies.

It exports the room as GLB, FBX, OBJ, and a Z-up centimetre OBJ.

- **GLB, FBX, OBJ, and Z-up cm OBJ** all come in at **10 m × 8.0 m, 3.1 m tall**, with the floor at y = 0. The
  units and up axis are read from the file or guessed right: m / Y, cm / Y, m / Y, and cm / Z.
- **Colliders:** 12 boxes (the floor and walls as solids, the table top, legs and crate). In the App, Simulate &
  bake drops a crate onto the table, where it rests at **y = 0.75 m**. A crate thrown at the right wall stops at
  its face (x = 4.78 against the face at 4.80).
- **Camera:** the file's camera becomes the active shot, keyed from z = 12 to z = 6 at 35 mm. Rendering Blender's
  camera and Soundstage's view through the imported shot gives silhouette **IoU 0.994 / 1.000 / 0.9998** (frames 1,
  24, 48), with the outlines within 0.9 px.
- **Animation:** the crate is at x = -3 → -1 over the clip, in GLB and FBX.

**(b) Soundstage → Blender.** The App's demo shot (plaza, two walking actors, a dolly) was exported with **Download
the DCC kit** and built with `blender/build_blender.py` headless, with a Workbench render at frames 1001, 1049 and
1097:

| | IoU | pixels that differ | outline distance |
|---|---|---|---|
| frame 1001 | 0.995 | 0.15% | 0.43 px |
| frame 1049 | 0.998 | 0.09% | 0.31 px |
| frame 1097 | 0.999 | 0.10% | 0.35 px |

The frame size is 960 × 512, and the stage floor is hidden on both sides. The same check with a 35 → 60 mm zoom on
the shot gave IoU 0.995 / 0.998 / 0.999. This shows that the lens keys, the actors' baked walk and the frame offset
all line up. Evidence: `share/Milestone12_Interop/`.

**Heavy worlds.** `tools/interop/blender_make_heavy_world.py` builds a 400 × 400 m town: 4,201 separate objects,
1.85 M triangles and a 67 MB GLB. It was imported in the App in headless Chrome on the Mac's GPU (ANGLE Metal,
Radeon Pro Vega 56, 1420 × 757 viewport):

| | draw calls | frame time (Color, street / aerial) | Clay |
|---|---|---|---|
| merged (default) | 84 (from 4,201 meshes, 6 far LODs) | 2.8 / 2.7 ms | 2.1 / 2.0 ms |
| not merged | 4,196 | 21.5 / 28.8 ms | 21.1 / 28.1 ms |

So the import takes the world from about 35–47 fps to well over 60 fps. The import itself takes 3.5 s: 1.5 s to
prepare and 0.9 s for 1,500 colliders. With the 25 m physics reach, a live physics step there takes 5 ms (14 ms
with all 1,500 boxes), and Simulate & bake takes 1.5 s for 97 frames with three falling crates.

To rerun the checks:

```
Blender --background --factory-startup --python tools/interop/blender_make_test_world.py -- <dir> --static-lens --render 1,24,48 --hide floor
# import <dir>/world.glb in the App (Import world…), render the same frames, then:
python3 tools/interop/compare_frames.py <soundstage_mask.png> <dir>/bl_world_24.png overlay.png
# the other way: Download the DCC kit, unzip it, then
Blender --background --factory-startup --python <kit>/blender/build_blender.py -- --render check.png --frame 1049 --transparent --hide ground
```
