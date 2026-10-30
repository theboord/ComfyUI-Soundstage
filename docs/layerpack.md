# Layer Pack

The Layer Pack turns a finished Soundstage shot into files that go straight into post. You get one layer per character, prop or plate, with mattes, depth, and the **exact camera the shot was staged with**. Builders are included for After Effects, Blender, Nuke, Resolve and Photoshop.

## Nodes

All four are in the **Soundstage** category. The pack moves between them as a `SOUNDSTAGE_LAYERPACK` socket.

| Node | What it does |
|---|---|
| **Layer Pack: Start** | Sets the shot name, fps and first frame (default **1001**). Connect the stage's `scene_json` to `camera_json` so the pack carries the camera. `notes` becomes a marker in AE and the OTIO timeline. |
| **Layer Pack: Add Layer** | Adds one layer: its `images` (a frame batch, or a single image that is held), an optional `mask` (1 = opaque; turn on `invert_mask` for LoadImage-style masks), plus `z` (0 = back, higher = on top), `kind`, `blend_mode` and `source_id` (stage actor id or SAM 3 object index). A mask at a different size is resized to fit. |
| **Layer Pack: Add AOV** | Adds a whole-frame pass. **Depth**: the default encoding is the stage's (near = white, linear from 1 to 40 m), so it is written as true metres. Normals, albedo and beauty are written as PNG sequences. |
| **Layer Pack: Export** | Writes the folder. Outputs the folder path and a contact-sheet preview. You can switch off ProRes, PSD, the app builders, OTIO and the multi-layer EXR. `hero_frame` picks the PSD frame (-1 = middle). |

The masks come from upstream: SAM 3 tracks seeded by the stage's actor boxes, the stage's own ID pass, or any matte node. The exporter packages what it is given and does not segment anything itself.

### Add All Actors: mattes from the final frames (default)

The stage's ID pass is the clay's silhouette, and LTX moves hair, limbs, dust and edges, so clay mattes never sat cleanly on the generated pixels. `matte_source` now defaults to **final frames (SAM 3.1 + BiRefNet edges)**:

1. **SAM 3.1 video tracking on the final frames.** There is one pass per kind on stage: "person", "horse", "dog", "car" and so on. A combined multi-prompt conditioning only tracked the first kind that matched.
2. **Each actor takes the track that overlaps its clay silhouette best.** Assignment is greedy, one-to-one, by IoU over the shot. The clay says *who*, SAM says *where*.
3. **The soft edge comes from ComfyUI core's Remove Background (BiRefNet, MIT).** Inside the track, eroded 3 px, the matte is solid. Around it, BiRefNet's alpha within a grown region gives hair and dust edges.
4. **Frames where SAM loses an actor fall back to the clay.** An actor with no track gets BiRefNet's alpha inside its grown clay silhouette, minus every tracked actor (so a rider never takes its horse). Props SAM can't name keep the clay matte.
5. **The background is the inverse of all layers.**

The node's text output says which source each layer used (for example `SAM 3.1 track 0 (IoU 0.63)`). Cost on the RTX 6000 Ada for 97 frames at 1984×1088: about 21 s per SAM pass, plus about 30 s of BiRefNet. If anything fails, the pack falls back to the clay mattes and says so. Choose **stage ID pass** for the old, fast behaviour. Code: `soundstage/layerpack/final_mattes.py`; tests: `tests/test_final_mattes.py` (torch, run on the pod).

A typical graph:

```
3D Stage ──scene_json──► Layer Pack: Start ─► Add Layer "BG plate" (z 0, kind background, no mask)
                                             ─► Add Layer "Man" (z 10, SAM3 mask for actor_a)
                                             ─► Add Layer "Woman" (z 20, SAM3 mask for actor_b)
3D Stage ──depth───────────────────────────► Add AOV depth ─► Export
```

## Folder layout

The pack is written to `ComfyUI/output/soundstage_layerpacks/<shot>_<YYYYMMDD_HHMMSS>/`:

```
manifest.json                       the single source of truth: layers, z, frames, fps, conventions, camera, export status
README.txt                          the short version of this page
layers/<zz>_<name>/                 zz = the layer's z, so folders sort back-to-front
    png/<name>.1001.png …           RGBA, straight alpha, sRGB as generated
    matte/<name>_matte.1001.png …   16-bit grey, white = opaque
    <name>_4444.mov                 ProRes 4444 + alpha (straight), Rec.709, timecode starts at frame 1001
aovs/depth/depth.1001.exr …         channel Z, float32, metres along the camera axis
aovs/depth_vis/depth_vis.1001.png   16-bit preview, near = white (normalised per frame; not metres)
aovs/<normals|albedo|…>/            PNG sequences as given
camera/camera.json                  per-frame position, target, focal_mm, fx_px, FOVs, Nuke ZXY rotation, cam_to_world 4x4
camera/camera.chan                  Nuke/Maya: frame tx ty tz rx ry rz vfov
dcc/ae/build_comp.jsx               After Effects builder
dcc/blender/build_blender_scene.py  Blender builder
dcc/nuke/build_nuke.py              Nuke builder
dcc/resolve/<shot>.otio             OpenTimelineIO timeline, one video track per layer
dcc/photoshop/<shot>_<frame>.psd    hero frame, one named layer per pack layer (with blend modes)
multilayer/<shot>.1001.exr          (optional) RGBA = comp, <layer>.R/G/B/A for each layer, depth.Z
preview/contact_sheet.png           comp, each layer over a checker, depth
preview/comp_preview.mp4            H.264 review of the comp
```

### Conventions

| | |
|---|---|
| Frames | Start at 1001, 4-digit padding (`name.1001.png`). |
| Alpha | PNG and MOV are **straight**. EXR is **premultiplied**. Mattes are 16-bit, white = opaque. |
| Colour | PNG is display-referred sRGB, exactly what the model generated. MOV is converted with the Rec.709 matrix and tagged bt709. EXR is `lin_rec709` (inverse sRGB). That is linear, but **not HDR**: highlights stay clipped. |
| Depth | Metres from the camera along its axis, in EXR channel `Z`. Stage depth is 8-bit, so it has about 0.15 m steps between 1 and 40 m. |
| Camera | World is Y-up, right-handed, in metres. The camera looks down its local −Z with no roll, on a 36 mm wide sensor, so `fx_px = focal_mm · W / 36`. |

### Camera maths (from research/07)

- **After Effects:** Zoom = `fx_px`. Positions are `[W/2 + 100·X, H/2 − 100·Y, −100·Z]` (1 m = 100 px). It is a two-node camera (Position + Point of Interest), keyed every frame.
- **Blender:** `lens = focal_mm` with `sensor_fit HORIZONTAL` and `sensor_width 36`. Matrix: `Rx(+90°) @ cam_to_world` converts Y-up to Z-up.
- **Nuke:** translate, plus rotate in **ZXY** order (Nuke's default). `haperture` = 36 mm, `vaperture` = 36·H/W, `focal` = focal_mm.
- **Cards:** each layer is placed as a flat card in front of the **frame-1** camera at its depth `d`, with width `d·W/fx`, so at frame 1 it exactly fills the frame. The cards stay fixed in the world while the camera moves, which gives real parallax.
  - `d` is the median of the depth AOV under the layer's matte on the hero frame. For backgrounds it is the 90th percentile.
  - Without depth, `d` is the camera's focus distance (×3 for backgrounds).
  - Each layer's `depth_m` and `depth_source` are recorded in the manifest.

## Opening the pack

Keep the scripts inside the pack: they find the files relative to their own location. If a script is moved, it falls back to the absolute path the pack was exported to.

**After Effects:** File › Scripts › Run Script File… › `dcc/ae/build_comp.jsx`.
- It builds a comp at the shot's size, fps and length, with the timecode display starting at 1001.
- Every layer is imported as a straight-alpha PNG sequence and stacked by z, with blend modes set.
- Each layer is a 3D layer set to *Orient Towards Camera*, placed at its depth.
- The keyframed `shot_cam` (Position, POI and Zoom on every frame) is added, plus the notes as a comp marker.
- To use the plain 2D comp, delete the camera and turn off 3D on the layers.

**Blender:** `blender --python dcc/blender/build_blender_scene.py`, or open it in the Scripting tab and press Run.
- It sets the resolution, fps and frame range 1001–…, and builds the keyframed `shot_cam` (lens and transform).
- It adds one emissive, alpha-blended image-sequence card per layer at its depth, in a `Soundstage_<shot>` collection.
- **Verified:** the test suite renders frame 1001 headless in Cycles and matches the pack's own comp.

**Nuke:** Script Editor › File › Source… (or `nuke -t dcc/nuke/build_nuke.py`).
- It sets the format, fps and frame range.
- It builds Read → Premult per layer, merged bottom-up (B = everything below, A = this layer). Merge operations follow each layer's blend mode.
- It builds a keyframed Camera and a Card per layer at its depth → Scene → ScanlineRender, for a 2.5D re-camera.
- **Camera only:** create a Camera, then File › Import chan file › `camera/camera.chan`, and leave rot order at ZXY.
- With the multi-layer EXR switched on, one Read of `multilayer/<shot>.####.exr` gives every layer as its own channel set, plus `depth.Z`.

**DaVinci Resolve:** File › Import › Timeline › `dcc/resolve/<shot>.otio`. Use the menu, not the scripting API, which leaves clips unlinked.
- You get one video track per layer, with the background on V1.
- Clips point at the ProRes 4444 files by the absolute path at export time, and source timecode starts at frame 1001.
- If the pack has moved (for example, downloaded from the pod), relink the media to the pack folder.
- Set Clip Attributes › Alpha mode to **Straight** on the clips.
- Each clip's metadata carries z, kind, blend mode, depth and the matte path.

**Premiere / Avid:**
- Import the `*_4444.mov` files and set alpha to straight.
- Premiere can also import the `.otio`.
- In Avid, link the MOVs with AMA and set alpha to Keep (straight).

**Photoshop:** open `dcc/photoshop/<shot>_<frame>.psd`.
- It holds one full-canvas layer per pack layer, bottom to top, with names and blend modes (Multiply, Screen, Linear Dodge).
- The file is written by hand, not by a library: psd-tools 1.26 loses layer transparency when writing.

## Dependencies

- **Required:** numpy and Pillow (already in ComfyUI).
- **Needed for ProRes and the review MP4:** `ffmpeg` with `prores_ks`. The pod has it. If ffmpeg is missing, those two exports report an error in `manifest.json › exports` and everything else is still written.
- **No PSD, EXR or OTIO library is needed:** the PSD, EXR and OTIO writers are pure Python. The tests read the output back with the official `psd-tools`, `OpenEXR` and `opentimelineio` when they are installed.

## Tests

```bash
cd tests && python -m pytest test_layerpack.py -q
```

Run the tests from inside `tests/`. The repo root's `__init__.py` makes pytest try to import the whole node pack from the root, which needs ComfyUI.

The tests build a synthetic pack of 2 layers × 5 frames, a depth pass, and a moving stage camera (dolly plus a 35→50 mm zoom). They then check every file:
- **PNG and mattes:** values match, with straight alpha.
- **ProRes:** 4444 with alpha, frame count and timecode, via ffprobe.
- **PSD:** layer names and alpha, via psd-tools.
- **EXR:** depth in metres and the multi-layer channels, via OpenEXR.
- **Camera:** `camera.json` maths (target projects to the frame centre, Nuke ZXY round trip, FOV) and the `.chan` rows.
- **Cards:** a card at its depth fills frame 1.
- **After Effects:** the AE zoom and card scale, and `node --check` syntax of the jsx.
- **Blender:** the headless render of frame 1001 is compared with the comp.
- **OTIO:** opentimelineio reads the timeline.
- **Edge cases:** an export with no camera or depth, and a mask at a different size with invert.

Not exercised in the real apps yet: the AE `.jsx` and the Nuke `.py` have not been run inside After Effects or Nuke, and the `.otio` has not been imported into Resolve.

## Downloading a pack from the App

When step 5 finishes, the stage's tab bar shows **⬇ Layers** (the whole pack as a .zip) and **⬇ Lite**
(the same pack without the per-frame PNG sequences: ProRes 4444 MOVs, EXRs, camera, builders and
previews kept). Both come from `GET /soundstage/layerpack/download?name=<pack>[&lite=1]`;
`GET /soundstage/layerpack/list` lists the packs on the server. Zips are stored uncompressed and
built on request, and the name is checked so only `output/soundstage_layerpacks/*` can be read.
