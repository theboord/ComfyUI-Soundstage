# Video → Stage baseline (2026-11-02)

This is today's `POST /soundstage/video2stage` on `origin/main` (ComfyUI v0.43.0 on the pod), scored by
`python3 tools/v2s_bench/bench.py`. All seven clips ran on the same pipeline version on 2026-11-02 between 06:55 and
07:10 PST.

Each result folder holds the overlay contact sheets:
`~/OpenHiggsfieldContest/share/Video3D_Boost/bench/clips/<clip>/sheet.jpg`. Each row has three tiles: the source,
the rebuild's Color pass from the solved camera, and an overlay. In the overlay the rebuild is tinted over the source,
the true outlines are white, true skeletons are green and rebuilt skeletons are red.

**Headline: mean MATCH 20.8 / 100. No clip reaches 35.** Played from its own camera, the rebuilt stage does not look
like the source.

## Flaws first

### The pipeline (judged like a VFX supervisor)

1. **Most of the frame is never rebuilt.**
   - Across all seven clips, 11 of 77 things in frame are found and **none is placed within tolerance**.
   - Found things sit 2–33 m from where they should be.
   - In `syn_interior` the living room comes back as an outdoor set: a sky and one wall. The rug, sofa, both tables,
     four chairs, the bookshelf, the plants and the box are all missing.
   - `syn_street` finds 0 of 18 things: no street lights, signs, bins, benches, trees, hydrant or parked cars.
2. **The camera tilt is wrong, and a free alignment used to hide it.**
   - Scored with yaw-only alignment (the stage is Y up), rotation error is 5–19°.
   - `syn_drone`: the source looks down at the road from 20 m. The rebuild looks at the horizon with sky in the top
     fifth, a 19° tilt error. Under a free Sim(3) this read as 1.1°.
3. **Moving cameras come back still or wrong.**
   - `syn_street` dollies 7 m and pans. The pipeline notes "the track drifted… locked to the first frame", so the
     rotation error peaks at 43°.
   - `st_chase` is a hood camera travelling about 60 m. The rebuild puts the camera inside a giant white car (see the
     sheet), with an ATE of 18 m.
   - Three of seven clips report "not enough trackable detail; held the camera" on some frame pairs.
4. **The lens is always 25.2 mm,** because DA3 mono uses its default K. It is 50 % off on the 50 mm `st_riders` and
   28 % off on 35 mm clips.
5. **Roll is never recovered.** The stage camera has no roll, so the handheld `syn_interior` loses −4.8° to +3.1° of
   roll.
6. **Scale is ×0.57 to ×3.0.** It comes from a guessed camera height (1.5 m) or people's height. `st_jturn`'s 0.5 m
   low car camera comes back at 1.5 m.
7. **People: one mocap take at most, sometimes on the wrong person.**
   - MPJPE is 284–358 mm on the synthetic people and PA-MPJPE 118–228 mm. A good monocular body model should manage
     about 50–70 mm.
   - Root error is 1.9–26 m, foot contact F1 is 0–0.46, and planted feet slide at 1.5–4.2 m/s.
   - `syn_street` pairs 1 of 3 people and `syn_drone` 2 of 3 (the cyclist is never rebuilt). The other rebuilt people are static clay.
   - In `syn_interior` the single take has the woman's reach-and-pick-up motion, but it is placed on the man.
   - `st_walk`'s walker has no mocap take (`performer: None`). Its 91 mm MPJPE is the stock clay walk cycle, not a
     capture.
8. **Colour is the VLM's hex guess.** Found things are off by ΔE 11–57, and there is no per-object texture or plate
   projection.
9. **Movers follow their true path 0–23 % of the time.** They get two marks (first and last frame) and nothing in
   between. Heading errors run up to 138°.

### The bench (so nobody over-reads it)

1. **The synthetic clips are easier than real footage.**
   - They are clean EEVEE/Cycles CG with procedural textures.
   - They have no motion blur, lens distortion, rolling shutter, grain or compression.
   - The people are faceless mannequins.
   - A pipeline that scores well here still has to be checked on real plates.
2. **The `*` clips are only partly exact.**
   - `st_jturn` and `st_chase` are video-model re-renders. Their 3D truth (camera, boxes, joints) is the stage scene,
     which the video only follows as closely as its adherence.
   - Their silhouettes now come from SAM 3.1 tracks of the source.
   - SAM finds things the stage truth does not have: 1 extra car in `st_jturn`, and 18 extra car/person tracks in
     `st_chase` (parked cars and the police hood). These are listed, not scored. MATCH on those clips is therefore
     generous.
3. **The colour term is a weak discriminator.**
   - It is per-pixel similarity over the whole frame. Dark night frames score 0.63–0.67 against a dark rebuild that
     is plainly wrong.
   - It is weighted only 20 % in MATCH for that reason. mIoU and "explained" carry the score.
4. **The scoring frames live on the Mac mini.**
   - The ID and Color passes are in `~/sstest/v2s_bench_out/data/`, and the synthetic truth ID passes are only
     there. `--runner local` needs those copied, or a fresh `prepare`.
   - `probe` always re-renders (a few seconds per clip). The other steps skip finished work.
5. **One SAM 3.1 anomaly, cause not found.**
   - On ComfyUI v0.43.0, a single `SAM3_VideoTrack` over 120 frames of `st_jturn` returned masks for only frames
     0–95. `LoadVideo` gives all 120.
   - The bench tracks in 40-frame windows, which return every frame.
   - The App's own SAM 3.1 paths (Layers, Footage/Recast) may hit the same tail loss on long clips. This is worth a
     check.
6. **Small things count.** Anything over 0.01 % of the frame (about 60 px at 1024 wide) is "in frame", so the
   cyclist seen from the 20 m drone counts. This raises the bar compared with yesterday's 0.1 % draft.

## Results

| clip | MATCH | mIoU | explained | colour | ATE m (path m) | rot ° | focal % | roll ° | scale | things found / placed / in frame | structure found | people | MPJPE / PA mm | 2D px | root m | contact F1 | pipeline s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| syn_interior | **14.8** | 0.02 | 0.14 | 0.48 | 0.34 (2.7) | 13.1 | 3 | 2.3 | ×0.94 | 3 / 0 / 14 | 1 / 6 | 2 / 2 | 284 / 118 | 287 | 1.86 | 0.46 | 108 |
| syn_street | **14.6** | 0.02 | 0.14 | 0.48 | 2.45 (7.0) | 15.2 | 16 | 0.0 | ×1.11 | 0 / 0 / 18 | 5 / 11 | 1 / 3 | 356 / 228 | 256 | 6.90 | 0.00 | 62 |
| syn_drone | **21.8** | 0.05 | 0.36 | 0.41 | 9.05 (18.5) | 19.2 | 5 | 0.7 | ×1.34 | 4 / 0 / 37 | 7 / 19 | 2 / 3 | 358 / 131 | 120 | 26.31 | 0.39 | 73 |
| st_jturn * | **34.1** | 0.26 | 0.28 | 0.63 | 11.76 (44.3) | 10.2 | 3 | 0.0 | ×3.00 | 1 / 0 / 1 | 0 / 0 | 0 / 0 | – / – | – | – | – | 147 |
| st_chase * | **22.3** | 0.06 | 0.20 | 0.67 | 17.94 (59.6) | 5.2 | 28 | 0.0 | ×0.98 | 1 / 0 / 2 | 0 / 0 | 0 / 1 | – / – | – | – | – | 52 |
| st_riders | **12.5** | 0.05 | 0.09 | 0.38 | 9.32 (30.6) | 2.3 | 50 | 0.0 | ×1.50 | 1 / 0 / 4 | 0 / 0 | 2 / 2 | 310 / 200 | 398 | 12.97 | 0.12 | 146 |
| st_walk | **25.3** | 0.13 | 0.31 | 0.46 | 2.15 (4.0) | 5.4 | 28 | 0.0 | ×0.57 | 1 / 0 / 1 | 0 / 0 | 1 / 1 | 91 / 84 | 71 | 1.91 | 0.76 | 81 |

`*` = truth from a video-model re-render, with silhouettes from SAM 3.1 of the source. "people" counts weak pairs:
same class, wrong place.

### How to read the columns

- **MATCH** = 100 × (0.5 mIoU + 0.3 explained + 0.2 colour), per frame and then averaged.
  - **mIoU** is over every true object in frame. A missing object counts as 0.
  - **explained** is the share of true-object pixels covered by the right rebuilt object.
- **Camera** is scored after yaw + scale + ground-plane alignment, so tilt, roll and height errors are not aligned
  away. **ATE** is RMS camera-centre error, and **rot** is the mean rotation error.
- **things / structure**: "found" means a class-compatible rebuild that overlaps the object from the solved camera, or
  stands within three tolerances of it. "placed" means within one tolerance (max(1 m, half the footprint diagonal)).
- **MPJPE** is root-relative, over 14 joints, in the rebuild's own metres. **PA** is after a per-frame Procrustes
  fit. **2D px** is at 1024 px wide.

All fields are defined in [README.md](README.md). Per-object and per-frame numbers are in each clip's `metrics.json`.

## Re-run

```sh
python3 tools/v2s_bench/bench.py                       # whatever is missing, then this table
python3 tools/v2s_bench/bench.py all --rerun           # a new baseline after a pipeline change (queues 7 jobs + 2 SAM prompts)
```

On a quiet GPU the pipeline takes 52–147 s per clip. When the queue is busy it takes much longer: yesterday's
`st_jturn` waited 1591 s. Scoring takes about 1 minute per clip on the mini.
