# Video → Stage benchmark (`tools/v2s_bench`)

This measures how close **Video → Stage** (`POST /soundstage/video2stage`) gets to rebuilding a clip as a 3D stage.
Played from the solved camera, the stage should look almost identical to the source. To check that, every clip here
has a known 3D answer:

- the camera on every frame;
- every object in the frame, with its size, position, heading and colour;
- every person's joints on every frame;
- an ID pass that gives each object its own flat colour.

The bench uses no private media and downloads nothing. It contains no real people: only our own stage renders and
synthetic Blender clips.

Results for the current pipeline are in [BASELINE.md](BASELINE.md). The full outputs, including the contact sheets,
are in `~/OpenHiggsfieldContest/share/Video3D_Boost/bench/`.

## Run it

You only need one command:

```sh
python3 tools/v2s_bench/bench.py                       # does whatever is missing, then prints the table
python3 tools/v2s_bench/bench.py all --rerun           # a new baseline: runs the pipeline again on every clip
python3 tools/v2s_bench/bench.py score report --clips syn_street,st_walk
```

There are six steps. Each one skips work that is already done, unless you pass `--rerun`.

| Step | What it does | Where it runs |
|---|---|---|
| `prepare` | Stage clips: copies the render and its stage scene. Synthetic clips: renders them with `blender_synth.py`. | Runner (Blender 5.x) |
| `run` | Uploads each clip to the input folder and calls `POST /soundstage/video2stage`, then waits. The pipeline's GPU steps are normal queued prompts behind everyone else's. The step then saves the result and the mocap takes. It never cancels or reorders anything. | This machine → the pod |
| `masks` | Only for the `*` clips (truth from a video-model re-render): SAM 3.1 tracks of the source, one queued prompt (`sam_masks.py`). | This machine → the pod |
| `probe` | Plays the truth scene and the reconstruction in the real stage. It writes the camera, boxes, joints, ID pass and Color pass. | Runner (headless Chrome, Metal) |
| `score` | Runs `metrics.py` and makes the overlay contact sheet. | Runner (Blender's Python with numpy) |
| `report` | Writes `summary.json` and `summary.md`, the table in BASELINE.md. | This machine |

The runner defaults to the Mac mini (`maxpost@MacMini17.local`), so the iMac stays usable. To run everything on one
machine, pass `--runner local`. That machine needs Blender, Chrome, node and ffmpeg.

Other options:

- `--server` sets the ComfyUI address (default `http://127.0.0.1:8189`).
- `--every` scores every Nth frame (default 2).
- `--out` sets the output folder.

## The clips (`clips.json`)

| Clip | What | Truth |
|---|---|---|
| `syn_interior` | A cluttered living room: table, 4 chairs, sofa, a shelf of books, a floor lamp, 3 plants, a rug, a door, a window, a picture, coffee and side tables, and a box. A man walks in and sits down. A woman talks with her hands, reaches up to the shelf, walks over and picks the box up. The camera is handheld with roll, 26 mm. | Exact (Blender) |
| `syn_street` | A street corner: building fronts, kerbs, sidewalks, 8 street lights, stop and street signs, bins, benches, trees, a hydrant, 4 parked cars and a crosswalk. A red car drives up and turns right. A man walks along on his phone, a woman sits on a bench, and a man gestures at the corner. The camera does a dolly plus pan, 30 mm. | Exact (Blender) |
| `syn_drone` | A drone push at about 20 m over a four-lane road. Six cars and a box van drive both ways. There are a cyclist (a rider), two pedestrians, parked cars, 12 street lights, 10 trees, 8 buildings, bike lanes and verges. 24 mm. | Exact (Blender) |
| `st_jturn` | A Hollywood re-render: a red sports car J-turns on a wet night street while a free camera swings round it. | The stage scene. It is only as exact as the video model's adherence. |
| `st_chase` | A Hollywood re-render: a police-car hood camera chases the red car (two drivers inside). | The stage scene, same caveat. |
| `st_riders` | A clay render: two people run to two horses, climb on and gallop away. The camera tracks them. | Exact (stage) |
| `st_walk` | A clay render: a man walks across a desert flat. The camera tracks him from the side. | Exact (stage) |

The synthetic people are rigged mannequins with the clay figure's proportions. The proportions come from
`web/stage/humans.mjs`: hips at 0.9 s, knees at 0.455 s, ankle 0.42 s below the knee, shoulders at 1.47 s, head
centre at 1.67 s, where s = height / 1.8. IK drives them on planned footsteps, so a planted foot never slides. Joints
use the COCO-18 order and the same definitions as `web/stage/posepass.mjs` `personKeypoints`. That keeps the truth and
the reconstruction's clay actor comparable joint for joint.

## What each number means

All positions use stage axes: metres, Y up, ground at y = 0. Frame f is time f / 24 s in every file.

Before anything is compared, the reconstruction is aligned to the truth. Both worlds follow the stage contract (Y up,
ground at y = 0, metres), so the alignment only removes what the contract leaves free:

- **Rotation** is a yaw about Y: the yaw-only chordal mean of R_true · R_reconᵀ over all frames. A wrong tilt or roll
  is not aligned away. A free Sim(3) would hide a camera that looks at the sky when it should look down at the road.
- **Scale** is a least-squares fit on the camera centres.
- **Translation** is along the ground only, so a wrong camera height shows up in the ATE.
- **A camera that hardly moves**, or a solved path that is nothing like the true one (a scale outside ×0.05–×20), gets
  its scale from the camera's height over the ground instead (`align_mode: height`).

**Camera**

| Field | Meaning |
|---|---|
| `ate_m` | RMS distance between the aligned and the true camera centres. `ate_pct_of_path` divides it by the length of the true path. |
| `rot_err_deg` | Mean angle between the aligned and the true camera rotation. |
| `focal_err_pct` | Error in focal length divided by image width. |
| `roll_err_deg` | Horizon roll error. The stage camera has no roll today, so this equals the true roll. |

**Scale**

- `recon_m_per_true_m` is the reconstruction's metres per true metre. 1.0 is perfect.
- The scale comes from the camera path, or from camera height (`from`).

**Layout** is scored over every object in the frame: anything that fills at least 0.01 % of the truth's ID pass (about 60 px at 1024 × 576, so a cyclist seen from a 20 m drone counts) in
at least one frame.

- **Things** are vehicles, people, furniture, street furniture, plants and props.
- **Structure** is roads, sidewalks, kerbs, ground, walls, buildings, windows and doors.
- **Found** (`recall`): the object has a class-compatible reconstructed object whose silhouette overlaps it (mean IoU ≥ 0.05 from the solved camera), or that stands within 3 tolerances of it on the ground. The tolerance is max(1 m, half the footprint diagonal). Matching is one to one.
- **Weak pairs**: a leftover object of the same class that sits anywhere. These count in `class_recall` only.
- **Placed** (`placed_recall`): found, and within 1 tolerance on the ground.
- **Precision**: the share of reconstructed objects that were found as something.
- **Size error**: compares the short side, height and long side, each against the truth. It uses the reconstruction's own metres, because it should be real size. World scale is reported separately under scale.
- **Placement error**: 3D distance between box centres after alignment.
- **Orientation error**: heading difference, taking symmetry into account. The period is 360° for cars, people and chairs, 180° for tables and rugs, and none for round things.
- **Colour**: the CIE76 ΔE between the true colour and the reconstruction's colour.
- **Movers**: path coverage is the share of frames where the matched object is within tolerance of the true position. Heading error is measured while the object moves faster than 0.3 m/s.

**Pose** covers each true person, matched as an object (weak pairs are flagged).

| Field | Meaning |
|---|---|
| `mpjpe_mm` | Root-relative per-joint error over 14 joints: nose, neck, shoulders, elbows, wrists, hips, knees and ankles. The root is mid-hip, and the error uses the reconstruction's own metres. |
| `pa_mpjpe_mm` | The same error after a per-frame Procrustes alignment, so it measures pose only. |
| `reproj_px_at_1024` | Each skeleton is projected through its own camera. This is the 2D joint error in pixels at 1024 px wide. |
| `root_err_m` | Mid-hip ground position error after alignment. |
| `contact_f1` | Foot contacts agree. A foot is planted when the ankle is within 6 cm of its lowest point and moving slower than 0.4 m/s. |
| `foot_slide_cm_s` | How fast the reconstructed ankle moves while the true foot is planted. |

**IDENTICAL** is the headline number. The reconstruction is played by the real stage from its own solved camera, and
its ID and Color passes are compared with the source frame by frame. The truth and the source are placed into the
stage frame the way the stage frames a clip: the same horizontal extent, centred vertically. The backdrop depth mesh
and the photo plate are left out, so only the 3D stage is scored.

| Field | Meaning |
|---|---|
| `miou` | Mean silhouette IoU over every true object in the frame. An object that was not found counts as 0. |
| `explained` | The share of true-object pixels covered by the right reconstructed object. |
| `ghost` | The share of reconstructed-object pixels that land where their object is not. |
| `colour_sim` | Mean of 1 − ΔE/50 between the Color pass and the source, over the frame. |
| `match_score` | 100 × (0.5 · mIoU + 0.3 · explained + 0.2 · colour), averaged over frames. |

The stage clips whose truth comes from a video-model re-render are marked `*`. The video model only follows the stage
as closely as its adherence, so their silhouettes come from the source itself: SAM 3.1
(`checkpoints/sam3.1_multiplex_fp16.safetensors`, already on the pod) tracks every instance of each prompt in
`sam_prompts` through the clip in 40-frame windows. Each track goes to the class-compatible true object whose stage
mask it overlaps most (mean IoU ≥ 0.1), and replaces that object's stage pixels. Tracks that overlap nothing in the
stage truth are things the video model added. They are listed under `truth_masks.unassigned`, not scored. The 3D
numbers (camera, layout, pose) still come from the stage scene.

Windows, because on ComfyUI v0.43.0 one `SAM3_VideoTrack` over the 120-frame `st_jturn` returned masks for only its
first 96 frames.

## Files

Each clip folder, `<out>/clips/<clip>/`, holds:

| File | What |
|---|---|
| `source.mp4` | The clip itself. |
| `truth.json` | Schema `v2s-bench/1`. |
| `recon_result.json` | What the route returned. |
| `recon.json` | The reconstruction as probed. |
| `metrics.json` | Every number above, per object and per frame. |
| `sam/` | `*` clips only: the SAM 3.1 tracks (`<prompt>_w<start>_<k>/NNNN.png`) and `sam.json`. |
| `sheet.jpg` | Rows of three tiles: the source, the reconstruction's Color pass, then an overlay. The overlay shows reconstructed objects tinted over the source, the truth's outlines in white, true skeletons in green and reconstructed skeletons in red. |

The ID and Color frames stay on the runner, under `~/sstest/v2s_bench_out/data/`.

`v2s-bench/1` uses these fields:

- `camera`: one entry per frame `[{f, pos, R (camera-to-world; columns are the camera's x right, y up and z back, like three.js), fx, fy, cx, cy}]`.
- `objects`: `[{id, label, cls, group, sym, color, dynamic, size, frames: [{f, c, yaw, size}]}]`. A static object has a single entry with `f = -1`.
- `people`: `[{id, object_id, joints (COCO-18), frames: [{f, J: [[x, y, z] | null] x 18}]}]`.
- `id_palette`: `{object id: [r, g, b]}`.

The stage draws ID colours as linear values that the renderer then encodes to sRGB. The scorer works this out for
itself.

| Code | What |
|---|---|
| `blender_synth.py` | The synthetic scenes, the rigs and the truth writer. |
| `harness/` | The stage probe (`probe.mjs`), its server and the Chrome driver. |
| `metrics.py` | The scorer and the sheets. |
| `imgio.py` | Image I/O through PIL or ffmpeg. |
| `pod.py` | Calls the pipeline. |
| `sam_masks.py` | SAM 3.1 masks of the source for the `*` clips. |
| `bench.py` | The single command that runs everything. |
| `tests/test_v2s_bench.py` | The scorer's unit tests. |
