# Video → Stage (`POST /soundstage/video2stage`)

Bring a real clip in, get it back as an editable Soundstage set with the original camera move as keys, then
re-shoot it with your own camera. The idea comes from Magnific's "3D Scenes, source: Video", where the clip is
rebuilt as a layout rather than a scan:
- hero subjects become library objects at real size (a pickup is a 5 m truck, a sedan a 4.5 m car, people 1.7–1.8 m);
- each mover gets a start mark and an end mark;
- the set is built from clay primitives at real dimensions: road with 3.6 m lanes and painted lines, water, sea
  cliff or bank, shrubs, rocks, hills, mountains, guardrail, sidewalk, plaza;
- the source camera becomes a handful of `camera_keys` (frame, position, target, focal_mm). Drag them in Top
  view (`web/stage/camviz.mjs`) or re-key them freely.

In the UI it is **Import an image as… → Video clip → set + camera move**. The clip is uploaded to the root of the
input folder, so **Soundstage · Footage / Recast** lists it as the reference plate. `scene.reference` records it.

## Pipeline (`soundstage/video2stage/`)
Every GPU step is a queued ComfyUI prompt. Nothing calls a model directly.

| Step | Code | Where it runs | Time (road clip, RTX 6000 Ada) |
|---|---|---|---|
| Probe and sample 16 frames (≤ 768 px wide) | `frames.py` (ffprobe / ffmpeg) | CPU | ~11 s |
| Depth for all frames + a frame-0 mesh | `graphs.py`: LoadImage×N → ImageBatch → LoadDA3Model → DA3Inference → **SoundstageDA3Export** (`.npz`) + DA3GeometryToMesh → SaveGLB | queue | ~15 s |
| Straighten depth, track the camera, fit the floor | `track.py`, `pipeline.solve` | CPU (numpy + OpenCV) | ~3 s |
| What is in the shot (first and last frame) | `vlm.py`: CLIPLoader(qwen3.5_4b) → TextGenerate(image) ×2 → PreviewAny | queue | ~40 s (cold), ~15 s warm |
| Layout → scene | `convert.py` (+ agent `build.make_object`, `catalog`, `validate_scene(place=False)`) | CPU | < 0.1 s |

### Camera
- **Multi-view DA3** (Small/Base checkpoints) returns camera poses directly. They are re-based on frame 0.
- **Mono DA3** is the only DA3 checkpoint on the pod (`depth_anything_3_mono_large`), so the route tracks the camera
  itself:
  1. **Straighten the depth.** DA3 mono compresses distance non-linearly (on the road clip, depth ≈ true^0.6).
     On flat ground, true inverse depth grows linearly with the rows below the horizon. Each frame's depth is
     raised to the power that makes its bottom-centre floor obey that, which is `track.linearize`.
  2. **Find the horizon.** It comes from DA3's sky mask (`track.horizon_row`). It gives the camera's tilt, which a
     depth-fitted plane gets too level.
  3. **Chain the poses.** Corners are tracked with pyramidal Lucas-Kanade (forward-backward checked), skipping the
     farthest quarter (soft, aliased detail). They are lifted to 3D with frame *i*'s depth and solved into frame
     *i+1* with `solvePnPRansac(SQPNP)` plus iterative refinement. Frame *i+1*'s depth is then re-scaled to agree
     with the chain. Moving cars and people are RANSAC outliers.
  4. **Correct the drift.** Each frame fits its own floor and measures the camera height. Where that agrees with
     the world up (≤ 15°), the chain's height is pinned to it and the travel since the previous frame is scaled by
     the same factor (`track.repin_heights`).
- **Scale (metres).** Anchored on the camera height the vision model guessed (drone ~15–25 m, handheld 1.6 m). For a
  low camera it uses people's height (1.7 m) instead.
- **Stage frame.** Ground y = 0, Y up, camera 0 looks north (+Z), +X is screen-left, `rotation_deg` 0 faces +Z.
  The scene is re-centred on the hero (the biggest mover).
- **Keys.** The 16 samples are reduced with Ramer-Douglas-Peucker on position and aim (3 % of the path / 3°, at
  most 8 keys). The unreduced path is kept in `scene.video2stage.camera_keys_raw`.
- **Focal length.** `focal_mm` comes from DA3's intrinsics (mono: core DA3's default K, f = 0.7·W ≈ 25 mm on a 36 mm
  gate).

### Subjects
The model's boxes (0–1000 grid) on the first and last frames are matched by kind (any vehicle ↔ any vehicle),
shared words, colour and position. Whichever read sees an object bigger names its kind, so a far "tow truck"
becomes the near "pickup".

Each box's bottom-centre ray hits the floor from that frame's tracked camera, stepped half a footprint along the
view. Movers get `keys = [frame 0, last frame]` and face their travel. Static vehicles face along the road.
People's `facing` is turned into a heading.

A person whose box sits on a horse, bike or bench is mounted on it (`ride` / `cycle` / `sit`). A person inside a car's
box is the driver and is dropped. The model is told to describe people by clothing only: no identities, no faces.

### Set
Set pieces come from the model's `set` list, with `side` as seen from the camera.

The road axis is a line through the traffic when it is spread along the road, otherwise the longest mover's travel,
otherwise the view. The road is snapped so the traffic sits in lane centres. Lanes are 3.6 m and two-way roads get
a double yellow centre line.

Everything is a `custom` recipe of boxes, cones and spheres with a per-part `color` (new: `library.mjs`
`buildFromRecipe` passes `part.color`). Pieces are marked `set_piece: true`. An 800 m `Terrain` slab goes under
outdoor clips, because the stage floor is only 80 m.

The optional backdrop is the first frame's DA3 mesh as a `glb` actor. Its `set_xform` holds flip, scale, offset and,
new, `quat`, so it sits in the same stage frame as the layout. It is approximate: the mesh is built from raw, not
straightened, depth. The first frame is also set as the backdrop plate for comparison in Color view.

## API
```
POST /soundstage/video2stage  {video: "<file in input/>", samples?: 8-24 (16), vlm?: true, backdrop?: true} -> {job}
GET  /soundstage/video2stage/job?id=<job>  -> {state: queued|running|done|error, step, progress, result?, error?}
result = {scene, notes[], timings{}, breakdown{}, summary{objects, set_pieces, movers, camera_keys, frames, depth_model, vision_model}}
```
`scene` is a normal stage scene (`version 2`, `environment.set = "empty"`, `shot.aspect` nearest the clip's) plus:
- `reference`: video, fps, frames, duration, sample frames;
- `video2stage`: metres_per_unit, ground, camera_keys_raw, drift_correction, setting.

## Tests
`tests/test_video2stage.py` (12 tests):
- model-answer parsing: fenced, mis-bracketed (the model closes a list with `}`), truncated, bare list;
- first/last matching;
- stage-axis conventions: world frame, camera keys, headings, ray–floor hits, the backdrop quaternion;
- key simplification;
- riders;
- an end-to-end synthetic clip: a textured floor rendered from a known dolly + pan with scrambled per-frame depth
  scales. The tracker recovers it within 3.5 % of the path and 1°. `assemble` then builds a road, ocean, mountains
  and a moving pickup on the right sides.

The real model answers from the road test are in `tests/video2stage_fixtures/`.

## Limits
- **Mono depth is relative.** Absolute scale is only as good as the camera-height guess. Fast moves between
  16 samples (whip pans) can break the chain; the frame pair is then held and noted.
- **Rough boxes.** The vision model's boxes are approximate, and objects seen only once stay where they were seen.
- **No roll.** The stage camera has no roll, so a rolled shot comes back level.
- **Better poses are one download away.** A DA3 Small/Base checkpoint would switch the camera step to multi-view
  poses with no code change (`graphs.pick_model`). It is not downloaded.
