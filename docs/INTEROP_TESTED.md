# Interop, tested with real scenes

What happened when Soundstage's import and export were run against real, freely licensed scenes in Blender 4.3.2 and
Unreal Engine 5.7.4, on the Intel iMac, on 2026-11-02. Houdini and Nuke are not installed, so **those apps were not
run**: only the files they read and write were checked. The scenes and their licences are in the
[table at the end](#test-scenes-and-licences). Screenshots: `share/QA/dcc_interop/`. Scripts: `tools/interop/realscenes/`.

## Flaws first

Found by these tests and **fixed on this branch** (with tests in `tests/js/interop_dcc_fixes.test.mjs` and
`tests/test_interop_builders.py`):

1. **Animated FBX cameras turned wrong between keys.** Blender's FBX exporter simplifies each rotation axis on its
   own, and three.js's FBX reader assumed every axis had the same key times. The Kenney room's dolly scored IoU
   **0.38 and 0.62** at frames 24 and 48 (the frame-1 pose was right). The fix resamples the axes in
   `web/vendor/addons/FBXLoader.mjs` (marked "Soundstage patch"), and now IoU is **0.984 / 0.988**, the same as the GLB.
2. **A file whose timeline starts at frame 1 (Blender and Maya) or 1001 (VFX) came in late.** The shot's frame 0 was
   the file's time 0, so a Blender shot held its first frame for one extra frame. A 1001-start file would have opened
   with 1,000 frames of hold (capped at 1,440). Now the earliest key of the whole file is shot frame 0, and the world
   panel says so. Blender frame N is now shot frame N − 1, as in the DCC kit, where Soundstage frame 0 = 1001.
3. **USD and Alembic loaded as an empty "0 mm × 0 mm" world** with no error, because they fell through to the PLY
   reader. Now they are refused with what to export instead (GLB or FBX, with a camera as `.chan`).
4. **Skinned FBX meshes made the world the wrong size.** The classroom's rigged venetian blinds were measured in bind
   space, so the world read **7.6 m tall** instead of 3.1 m. The size now comes from the posed bones.
5. **Untranslated glTF materials rendered black.** For Cycles node setups it can't translate, Blender's glTF exporter
   writes a material with no PBR block. glTF's defaults then make it a white metal, and with no environment map a
   metal renders black (the whole classroom did). Such materials now come in matte.
6. **The DCC kit's `scene.glb` didn't import into Blender when the shot had dust.** Hoof and tyre dust are sprite
   particles with shader-only attributes (`pSize`, `pRot`, `pTex`, `pLit`), and Blender 4.3's glTF importer stops on
   them. The western demo shot failed. Those particles are now left out of the kit.
7. **Unreal: the set's animation didn't play in the camera sequence.** Interchange puts scene.glb's baked actor and
   car keys in its own Level Sequence, at 30 fps from frame 0. `build_unreal.py` now adds that sequence to
   `SEQ_<shot>` as a subsequence from frame 1001.
8. **An orthographic camera became a shot with a made-up 40° lens** (Khronos `Cameras` sample). Orthographic cameras
   are now left out, and the panel says how many.
9. **Unreal 5.8 skipped the Western kit's `scene.glb` without a word** (only the camera imported; Blender was fine).
   three's GLTFExporter lists `EXT_mesh_gpu_instancing` under `extensionsRequired` for instanced meshes (the
   Western's scatter). The kit now expands each instanced mesh into one plain child node per instance, all sharing
   the one mesh (`expandGPUInstancing` in `exportdcc.mjs`); past 20 000 instances in one mesh the extension stays, but
   only under `extensionsUsed`. The same 5.8 test found the *Back seat* and *Western* kits' `build_unreal.py` without
   the set-animation step (fix 7): every kit ships the same builder file, and those kits came from the hosted try-it
   demo, which still serves the copy from before fix 7. Re-publishing the demo brings it in.

Still open (**not fixed**):

- **No direct USD or Alembic import.** Houdini output has to go through Blender (recipe below) or be exported as
  glTF or FBX from Houdini. That route works: IoU 0.988, the same as a direct GLB.
- **Textures from a Cycles scene don't survive Blender's glTF or FBX export.** The classroom came in with 83 untextured
  materials. That is Blender's exporter, not Soundstage, but the set looks flat.
- **File lights are switched off by design** (the stage lights the set). Every light was counted: 13 in the
  classroom GLB, 10 in its FBX, 5 in the Khronos lamp. None were used.
- **FBX materials are duplicated per mesh**: 166 in Soundstage for the classroom's 78. That costs draw calls in big FBX
  worlds.
- **Unreal's glTF export names the camera after its component** ("CameraComponent_1"), not the actor ("UE_ShotCam").
  The FBX keeps the actor name.
- **Unreal was run headless, and its viewport was not checked by eye.** The offscreen SceneCapture of the kit level
  renders almost black: the Soundstage GLB brings no sky or sun into Unreal, so only the car's emissive tail-lights
  show. They are where the car is in Soundstage at frames 1001 and 1061, so the subsequence animates.
- **Unreal 5.8 was tested after this page was first written** (the rows in the table). The car chase matches 5.7.4
  exactly. The Western failed until fix 9 and has not been re-run in 5.8 since. The detailed numbers above are
  **UE 5.7.4 on the Intel iMac**.
- **The western round trip is lower** (IoU 0.80–0.83 in the full silhouette): the horses sit about 4 px to the side.
  In Soundstage's own id pass the same frames score 0.90–0.97, with outlines within 0.6 px, so the gap is probably
  how this test drew the skinned horses for the mask. It is not explained yet.

## The matrix

IoU compares the two apps' silhouettes through the same camera (`tools/interop/compare_frames.py`): 1.0 means the
same pixels. "Outline" is the mean distance between the two outlines, in pixels.

| App | Direction | Format | Scene | Result |
|---|---|---|---|---|
| Blender 4.3.2 | → Soundstage | GLB | Kenney room (CC0), dolly, sliding chair | **Pass.** 8.1 × 8.1 × 2.6 m, as Blender says (8.14 × 8.10 × 2.58). m / Y up from the file. The camera becomes the shot, 35 mm. IoU **0.982 / 0.984 / 0.988**, outline 0.27–0.31 px. |
| Blender | → Soundstage | FBX | Kenney room | **Pass after fix 1.** Same size, units and IoU as the GLB (before the fix: 0.98 / 0.38 / 0.62). |
| Blender | → Soundstage | GLB | Blender *Classroom* (CC0, 25 fps, 145 frames, 4 lights, rigged blinds) | **Pass after fix 5.** 10 × 11 × 3.1 m. The GLB also carried the file's other two scenes: this was Blender's export option, not Soundstage. The camera, 25 fps and the move came in. IoU 0.940 / 0.931 / 0.917, outline 2.0–3.0 px; the gaps are objects that the name filter hid on one side only. No textures (see Flaws). |
| Blender | → Soundstage | FBX | Classroom | **Pass after fix 4.** 11 × 8.5 × 3.1 m, matching Blender's own re-import. IoU 0.953 / 0.945 / 0.932. |
| Blender | → Soundstage | USD, Alembic | Kenney room, Classroom | **Refused, with a message (fix 3).** Via Blender (`usd_abc_to_glb.py`, which bakes the Transform Cache): IoU 0.982 / 0.984 / 0.988 for both. |
| Blender | Soundstage → | DCC kit (GLB + camera.json) | *Car chase*, street at night | **Pass.** `build_blender.py` headless, Workbench. IoU **0.996 / 0.997 / 0.995**, outline 0.33–0.41 px (frames 1001 / 1049 / 1097). |
| Blender | Soundstage → | DCC kit | *Back seat* (inside a moving car) | **Pass.** IoU **0.9993 / 0.9991 / 0.9992**, outline 0.15–0.46 px. |
| Blender | Soundstage → | DCC kit | *Western* (horses, dust) | **Failed before fix 6** (Blender couldn't import scene.glb). Now it builds: id-pass IoU 0.97 / 0.96 / 0.90, outline 0.5–0.6 px. See Flaws for the full-silhouette gap. |
| Unreal 5.7.4 | Soundstage → | DCC kit + `build_unreal.py` | *Car chase* | **Pass, headless** (`UnrealEditor-Cmd -run=pythonscript`, 40 s). The level and the `SEQ_` sequence save and reload in a fresh run: 320 actors and a CineCameraActor (36 × 19.2 mm filmback, 35 mm). 121 keys at 24 fps over 1001–1122, plus a camera cut. Against camera.json the keys are within **1.6 µm** and **0.000006°**. The axis probes measured UE = (x, z, y) × 100. The set's animation plays after fix 7. Not checked by eye. |
| Unreal 5.7.4 | → Soundstage | glTF (GLTFExporter) | A level built from the Kenney room (CC0) with a UE CineCamera | **Pass.** 8.1 × 8.1 × 2.6 m. The UE camera (650, −250, 160 cm, pitch −6°, yaw −118°, 28 mm) comes in at exactly that place, direction and lens. IoU 0.9997 against a Blender render through the same camera (the room fills most of the frame, so the camera numbers are the stronger evidence). |
| Unreal 5.7.4 | → Soundstage | FBX (LevelExporterFBX) | Same level | **Pass.** cm / Z up read from the file. Same size, camera and IoU. |
| Unreal 5.8 | Soundstage → | DCC kit + `build_unreal.py` | *Car chase* | **Pass.** Matches the 5.7.4 run exactly (same actors, camera keys, camera cut, and the set's animation plays). |
| Unreal 5.8 | Soundstage → | DCC kit + `build_unreal.py` | *Western* | **Failed before fix 9** (only the camera came in: Interchange skipped a scene.glb that requires `EXT_mesh_gpu_instancing`, with no message). Fixed in the code by fix 9; not yet re-run in 5.8. |
| Houdini | → Soundstage | USD, Alembic | — | **App not run.** Soundstage refuses both with a message. Through Blender: the ASWF *OpenChessSet* USD (CC-BY 4.0) comes in at 71 × 71 × 19 cm, 21 materials; the *Teapot* USD (CC0) at 31 × 49 × 23 cm. The USD and Alembic written from the Kenney room match the GLB (IoU 0.988). |
| Nuke | Soundstage → | `shot_cam.chan` | All three kits | **App not run; the file was checked as text** against the .chan layout (one line a frame: frame tx ty tz rx ry rz vfov, degrees, rotation order ZXY, the layout Nuke and Blender's chan add-on use). 8 columns, frames 1001…end, every line. Rebuilding R = Ry·Rx·Rz matches camera.json's cam_to_world to < 1e-7, and the vfov matches the focal length on the 36 mm horizontal sensor. Soundstage writes no `.nk`: `build_nuke.py` builds the script inside Nuke, and that is still untested. |
| Maya | both | — | — | Not run (Maya isn't installed). The same `.chan` and the zxy maths apply. |

Other files read as checks:

- **Poly Haven ArmChair_01** (CC0, glTF + .bin + 1k textures) is 85 × 77 × 107 cm, Poly Haven's own dimensions
  (848 × 766 × 1065 mm). It came in with its texture and normal map.
- **Khronos BoxAnimated** (CC-BY 4.0): 2 animated objects.
- **Khronos LightsPunctualLamp** (CC-BY 4.0): 5 lights counted and switched off.
- **Khronos Cameras** (CC0): fix 8.

## How it was run

- **Soundstage:** the try-it build of this branch (`tools/tryit/build_tryit.py --web web`), served on 127.0.0.1 and
  driven in headless Chrome (Metal) through `tools/qa/lib.mjs`, with CDP ports 9671–9686. Nothing was uploaded: files
  load as blob URLs through `WorldMount.importWorld`, and the kit comes from `exportForDCC`.
  - `ss_import.mjs` imports a file and writes the readout, materials, camera keys, clay and colour frames, and a
    white-on-black silhouette of the world through the imported shot.
  - `ss_kit.mjs` exports a demo scene's DCC kit and renders Soundstage's silhouettes.
- **Blender** (`Blender -b --factory-startup`):
  - `bl_kenney_room.py` builds the Kenney room.
  - `bl_export.py` exports GLB, FBX, USD and Alembic, writes the ground truth and renders the reference masks.
  - `usd_abc_to_glb.py` is the Houdini route.
  - `bl_ref_cam.py` renders a reference through a given camera.
- **Unreal:** `SSInterop.uproject` (blank: Python, Editor Scripting, Sequencer Scripting, GLTFExporter, Interchange).
  - `ue_build.py` runs the kit's builder.
  - `ue_verify.py` reloads the level and sequence and reads the keys back.
  - `ue_level_export.py` builds the CC0 level and exports glTF and FBX.
  - `ue_shot.py` is the offscreen capture.
- **Nuke:** `validate_chan.py <kit>`.

## Test scenes and licences

All files were downloaded to `~/OpenHiggsfieldContest/interop_test/<scene>/`, about 310 MB in all, and treated as
data. None was downloaded to a GPU pod.

| Scene | Used for | Source | Licence |
|---|---|---|---|
| Kenney *Furniture Kit* 2.0 | the Kenney room (Blender), the UE level | https://kenney.nl/assets/furniture-kit | CC0 1.0 (License.txt in the zip) |
| Blender demo *Classroom*, by Christophe Seux | Blender → Soundstage | https://download.blender.org/demo/test/classroom.zip (listed on https://www.blender.org/download/demo-files/) | CC0 |
| Poly Haven *Arm Chair 01*, by Kirill Sannikov | scale and textures | https://polyhaven.com/a/ArmChair_01 | CC0 |
| Khronos glTF sample *Cameras*, by Marco Hutter | perspective and orthographic cameras | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Cameras | CC0 1.0 |
| Khronos glTF sample *BoxAnimated*, © 2017 Cesium | animation | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxAnimated | CC-BY 4.0 |
| Khronos glTF sample *LightsPunctualLamp*, © 2021 DGG | lights | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/LightsPunctualLamp | CC-BY 4.0 |
| ASWF USD WG *OpenChessSet* | USD (Houdini route) | https://github.com/usd-wg/assets/tree/main/full_assets/OpenChessSet | CC-BY 4.0, Academy Software Foundation |
| ASWF USD WG *Teapot* (from Poly Haven's Tea Set) | USD | https://github.com/usd-wg/assets/tree/main/full_assets/Teapot | CC0 |
| Soundstage demo shots (*Car chase*, *Back seat*, *Western*) | Soundstage → Blender / Unreal | this repo, `tools/tryit/scenes/` | the repo's licence |

Rejected after reading the licences:

- **Pixar *Kitchen Set*.** Its EULA allows only personal, non-commercial testing of USD, and no images or
  distribution, so it can't appear on the README. It was deleted.
- **USD WG *McUsd*.** Non-commercial (CC BY-NC-SA). Not downloaded.
- **Epic Marketplace / Fab and UE sample content.** Not used: the licence forbids use outside Unreal.

## Proposed README Interop section

For Mike to approve. The README is unchanged.

> ### Interop: Blender · Unreal · Maya · Nuke
>
> **Import world…** makes a GLB, glTF, FBX or OBJ the set, at its real size, with colliders, and its cameras become
> shots. **Export for Blender · Unreal · Maya · Nuke** sends the shot back out as an animated GLB, camera files and a
> builder script for each app.
>
> **Tested with real scenes** (CC0 and CC-BY: Blender's *Classroom* demo, Kenney, Poly Haven, Khronos, ASWF USD):
>
> - **Blender 4.3**, both ways. Blender → Soundstage, GLB or FBX: the set at Blender's size, the camera and its move as
>   a shot, silhouettes at IoU 0.98+. Soundstage → Blender: IoU 0.995–0.999, outlines within half a pixel.
> - **Unreal Engine 5.7**, both ways, run headless. The DCC kit builds a level and a Level Sequence whose camera is
>   within 2 µm of Soundstage's, with the set's animation inside. A level exported from Unreal as glTF or FBX comes in
>   at its size, with the Unreal camera's exact position and lens.
> - **Houdini:** export glTF or FBX, or bring USD and Alembic through Blender (`tools/interop/realscenes/usd_abc_to_glb.py`).
>   Soundstage doesn't read USD or Alembic directly.
> - **Nuke and Maya:** the kit's `.chan` (frame, translate, rotate ZXY, vfov) checks out line by line against the
>   camera. The Nuke and Maya builder scripts have not been run in those apps.
>
> Details, numbers and the licences: [docs/INTEROP_TESTED.md](docs/INTEROP_TESTED.md).
