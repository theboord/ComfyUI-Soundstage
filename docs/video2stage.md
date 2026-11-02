# Video → 3D set (`POST /soundstage/video2stage`)

A real clip in, a 3D stage out. Played from the solved camera, the stage should look almost identical to the source:
- every person's full-body pose on every frame;
- every object in frame at its real size, place, orientation and colour;
- a photographic set scan of the location behind them.

It is ready to re-shoot with your own camera.

**Status (2026-11-02).** Four tracks are rebuilding this flow at once: SOLVE (camera), POSE (people), LAYOUT
(objects) and MATCH (set scan and canvas UX). This page describes the new flow. Sections marked *(track)* are filled
in as each track lands. Read **Limits** before trusting a result.

## In the App
Every entry point uses the same wording, **Video → 3D set**, and opens the same one-screen chooser:
- the yellow **Import video** button;
- the **Video → 3D set** tool;
- **Import an image as… → Video → 3D set**;
- dropping a clip anywhere on the stage.

### The chooser (no scrolling)
| Control | What it sends |
|---|---|
| **Rebuild as a 3D set** / Capture motion / Edit with Ripple | Rebuild opens the form below. The other two act at once. |
| **Quality**: Fast 16 · Standard 32 · Max 64 | `quality`, `samples`: depth samples over the clip. Each button shows an honest time: from this server's recent runs (`GET /soundstage/video2stage/runs`) when it keeps them, otherwise ≈ from the measured baseline (a 5 s clip took 11–26 min on the shared RTX 6000). |
| **Trim** filmstrip with in and out handles | `trim: [in_s, out_s]` |
| **People**: Everyone / Pick one on frame 1 | `people: "all"` or `{point: [u, v, 0]}` (normalised) |
| **Stage**: Replace the set / Add to it | `mode`. On a cast stage, Replace says how many things go. Undo (and the result card's **Undo: bring the old set back**) restores them. Add keeps every actor and adds the clip's camera as a new shot. |
| **Advanced** (folded): focal mm, sensor width mm, camera height m, objects to find, set scan on/off, vision model on/off | `lens: {focal_mm, sensor_mm, camera_height_m}`, `objects`, `backdrop`, `vlm` |

### Progress card
The card shows the server's own numbers (`/job`):
- the step it is on, out of how many;
- its queue position ("3 jobs ahead in the GPU queue, not ours");
- elapsed time and the server's ETA, taken from its rolling history of step times.

**Cancel** asks the server to remove only this job's own prompts (`POST /soundstage/video2stage/cancel`). After a
server restart, the job reads **interrupted** and offers **Retry**, which reuses the uploaded clip.

### Result card: flaws first
Red notes come first, then amber, each with its fix button:
- **Lock to frame 0** for an unreliable solve;
- **Retry at Max** for too few samples.

The summary follows: people with full-body motion, things at real size, the set scan, and the camera keys. When the
solve finds no move, the card says so in plain words ("one key: the solve found no camera move"). The old "locked off"
wording is gone: a camera move is never dropped silently.

### "Identical?" in the canvas (`web/ui/v2scompare.mjs`)
After a rebuild, a bar sits over the 3D view:
- **Overlay / Wipe / Onion / Off** puts the source clip over the Camera view, locked to the stage frame
  (`time = trim in + frame / 24`).
  - Overlay has an opacity slider.
  - Wipe has a draggable split: source on the left, the rebuild on the right.
  - Onion is a difference blend: whatever lines up goes dark.
  - Keys 1–4 switch modes while the bar has focus. The bar never touches the global shortcuts.
- **Solve chip**, for example `Solve 0.6 px · 92 % · 35→42 mm · roll ±5°`, from `scene.video2stage.solve`.
  Underneath is a per-frame error sparkline: frames over 1.5 px are red, and a click jumps to that frame.
- **Match NN/100** scores every object that has a clip mask.
  - It renders the stage's own ID pass (`stage.renderFrameTo('id', f)`, read-only) at 256 px on up to 24 frames,
    against `scene.video2stage.masks` (COCO RLE).
  - It uses the bench formula: `100 × (0.5 mIoU + 0.3 explained + 0.2 colour)`. Colour is the deltaE similarity of
    the Color pass against the source frame, on 6 frames.
  - The object list shows the worst first, with chips: green ≥ 0.7, amber, red < 0.4. It shows only as many rows as
    fit, then "+N more".
  - Clicking an object selects it, scrubs to its worst frame and opens its fixes.
- **One-click fixes.** Each goes through the scene, so stage Undo reverts it.
  - **Fit to plate**: a local search over position on the ground, yaw and size. It maximises the overlap of the
    object's box silhouette with its mask on 6 frames (2.5 s budget).
  - **Swap**: tries the other library kinds of the same family (sofa ↔ armchair ↔ chair ↔ bench, the car family,
    and so on), each fitted, and keeps the best.
  - **Nudge**: drag in the view to slide the object along the ground under the cursor.
  - **Re-key**: a mover's path re-fitted to where its mask touches the ground on every masked frame, thinned at 5 cm.
  - **Lock camera**: the solve's own fix.

## Pipeline (`soundstage/video2stage/`)
Every GPU step is a queued ComfyUI prompt (our own prompts only). Stages share one plain dict, `ctx`
(`context.py`, SOLVE). Units stay in solve units until `ctx['mpu']` is set.

```
frames → (DA3 ‖ layout.inventory → layout.segment ‖ people.graph) → solve.camera → people.measure + layout.measure
       → solve.metric_scale → layout.assemble → people.attach → backdrop.build → write
```

| ctx key | Meaning | Written by |
|---|---|---|
| `clip` | path, fps, frames, duration, w, h, start, end | SOLVE |
| `all_frames` | every source frame in the trim, PNG ≤ 768 wide | SOLVE |
| `samples`, `depth{i}`, `sky{i}` | depth samples (straightened DA3) and sky masks | SOLVE |
| `K{f}`, `poses{f}` | per-frame intrinsics and **world-from-camera 4×4** (OpenCV camera: x right, y down, z forward) | SOLVE |
| `masks` | `{people: {track: {f: rle}}, objects: {id: {f: rle}}}`, COCO RLE (column-major runs; list or compressed string) | POSE, LAYOUT |
| `scale_anchors`, `mpu` | metric scale | all, SOLVE |
| `surfaces` | seats, tables, saddles for contacts | LAYOUT |

- *(SOLVE)* camera: sampling, LK tracks, lens and gravity, bundle adjustment, keys, metric scale, jobs, cancel, ETA.
- *(POSE)* people: SAM 3.1 person tracks, SAM 3D Body per track, placement, contacts, takes.
- *(LAYOUT)* objects: inventory, segmentation, measured boxes, planes, movers, library match.

### Set scan (`backdrop.py`, MATCH)
CPU only (numpy + OpenCV). It runs after the set is assembled, through `backdrop.build(scene, ctx)`.

1. **Fuse.** Every sample's straightened depth is lifted to the world with its own `K` and pose, then to the stage
   with `scene.video2stage.xform` (`stage = A · world + b`). Left out:
   - people and objects (`ctx.masks`, grown 3 px);
   - sky;
   - depth discontinuities. A break is a second difference of inverse depth above 4 % of it. Planes are linear in
     1/z, so a far floor seen at a grazing angle is not an edge.

   Points are voxel-hashed at a distance-scaled size: 2 cm at 2 m from the nearest camera, about 1 % of range beyond,
   in powers of two, so every sample hashes the same place to the same voxel. Colour is a weighted mean that favours
   frontal views.
2. **Cull ghosts.** A point is dropped when other samples see through it (it floats in front of the surface in all
   four pixels around its projection) more often than they confirm it. It is also dropped when its depth residual is
   more than 3σ off the fused surface (σ is robust, with a floor of 1 %).
3. **Structure.** The floor is the densest level of up-facing points below the camera. Walls and building faces come
   from sequential RANSAC on plumb planes (up to 6). A ceiling is only labelled indoors. The scan is interior when it
   has a ceiling, or walls on several sides and nothing above 6 m. Interiors get no sky, road or terrain.
4. **Mesh.** Each sample is triangulated on a grid, cut at depth breaks. A later sample only adds what earlier
   samples did not cover, so whatever is revealed after frame 0 is filled. The mesh is welded and decimated by voxel
   clustering to ≤ 400k triangles. It is written as GLB with vertex colours (numpy only), split into named pieces:
   - `Set scan floor` (indoors) or `Set scan ground` (outdoors);
   - `Set scan wall N` (indoors) or `Set scan building N` (outdoors);
   - `Set scan ceiling`;
   - `Set scan (from clip)` for the rest.

   When the set already has ground pieces (road, floor, terrain…), the scanned ground stays in the splat only:
   people stand on the set's ground, and two floors would fight in the clay and ID passes.
5. **Splat.** `Set scan points` is a standard 3DGS PLY:
   - band-0 colour;
   - opacity from confidence;
   - flat discs on their surface, sized to the voxel.

   It loads through the stage's splat path (Spark) in Color view. Its clay stand-in is an empty proxy, because the
   mesh pieces already cover clay, depth and ID.

   Spark centres a splat on its bounding box and stands it on its lowest point. Two invisible anchor splats make that
   box symmetric and floor-level, so the scan lands exactly in stage metres. Points more than 0.25 m below the floor
   or above 58 m are left out of the splat (the stage re-fits models taller than 60 m).
6. **Sky.** The median colours of the plate's sky (top band and horizon band) go to `scene.video2stage.sky`.

Every scan actor is `kind: glb`, `scan: true`, `look_at: false`, with an identity `set_xform`, so it is not
selectable or collidable as a prop. The old frame-0 relief ("Source frame (DA3 depth)") is removed. Without a scan,
the first frame is used as a backdrop plate, as before.

## API
```
POST /soundstage/video2stage  {video, original?, quality?|samples?, trim?: [in, out], people?: "all"|{point:[u,v,f]},
                               mode?: "replace"|"add", vlm?, backdrop?, lens?: {focal_mm, sensor_mm, camera_height_m},
                               objects?} -> {job}
GET  /soundstage/video2stage/job?id=  -> {state: queued|running|done|error|interrupted|cancelled, step, step_index,
                                          steps[], queue_position, elapsed_s, eta_s, notes, result?, error?}
POST /soundstage/video2stage/cancel {id} -> removes only this job's own prompt ids
GET  /soundstage/video2stage/runs -> {runs: [{secs, samples, total_s}]} (optional; the chooser estimates without it)
```
`result.scene` is a normal stage scene plus:
- `reference`: the clip and its samples;
- `video2stage`:
  - `xform`, `metres_per_unit`;
  - `solve {rms_px, per_frame_px[], confidence, mode, focal_mm[], roll_deg[], zoom}`;
  - `masks`;
  - `inventory`;
  - `backdrop {stats, sky, pieces}`, `sky`.

Notes can be strings or `{text, level: red|amber|info, fix?: {action: lock_camera|retry_quality, label}}`.

## Tests
- `tests/test_v2s_backdrop.py`: a synthetic room (floor, ceiling, three walls) rendered to exact depth and colour from
  four cameras. It checks:
  - points land on the true planes;
  - masks and sky are left out;
  - a floating shard seen once is culled and the room stays;
  - floor, walls, ceiling and interior are found;
  - a revealed wall is filled and overlaps are not duplicated;
  - the triangle budget holds;
  - the GLB and PLY are valid;
  - the actors are named and placed (anchor splats included);
  - COCO RLE round-trips, list and compressed.
- `tests/js/v2scompare.test.mjs`:
  - RLE decoding;
  - IoU and the MATCH formula;
  - the solve chip and sparkline;
  - projection and ground hits against three.js;
  - Fit to plate recovering a displaced, turned, resized box from three views in < 3 s;
  - key thinning and swap families.
- `tests/js/videoimport.test.mjs`:
  - server step mapping;
  - honest estimates (history first, the measured baseline otherwise);
  - flaws-first ordering with fix actions;
  - one wording.
- `tools/qa/v2s_compare.mjs` (headless, real stage, Mac mini) runs at 1440×900 and 1280×800. It checks:
  - the compare bar, chooser (Advanced open too), progress card and result card need no scrolling;
  - Fit to plate gains ≥ 0.15 IoU in < 3 s and Undo restores the object;
  - no "DA3" or "custom" names;
  - the scan is out of look-at.

## Limits
- **The scan is only as good as the depth and the solve.**
  - Mono DA3 depth disagrees between samples on fast or long moves. On the bench street clips, 30–60 % of fused points
    were culled as inconsistent.
  - A floor that sits off y = 0 means the solved camera height is wrong. The scan notes it ("the clip's own floor sits
    X m above the stage floor").
- **Without masks, people and cars get baked into the scan.** The scan relies on POSE and LAYOUT's masks. Without
  them, only movers are carved out (by free-space culling). Parked cars and seated people stay in the scan.
- **Fit to plate fits a box.** It matches the object's bounding-box silhouette, not its exact mesh, and it ignores
  occlusion. A sofa behind a table fits less well. The stage scales uniformly, so per-axis size is not fitted.
- **The source overlay crops to the stage aspect.** The stage keeps its nearest preset aspect, so the source overlay
  is `object-fit: cover` and a 2.39 clip on a 1.85 stage is cropped at the sides.
- **Match needs masks.** Objects without a clip mask are not scored. The in-canvas Match covers only masked things, so
  it can differ from the bench, whose truth also includes walls and floor.
