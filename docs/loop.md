# Seamless loop

✦ One-click › **Loop**. Make a loop from a still or from a take's frame 1. A seam meter puts a number on how visible the wrap is. A fixer tries to close the seam and never uses a crossfade.

## Known limits (read first)

- **The end of a loop render lands near the first picture, not exactly on it.** LTX-2.5 distilled has frame 0 fixed exactly (`LTXVImgToVideoInplace`), but the same picture at the last index (`LTXVAddGuide`, frame_idx -1) is only a guide. On the first test (a canoe on a lake, 89 frames) the last latent block snapped toward the picture in one jump, 3 frames from the end: one step 10x the median. The wrap still read as **Visible seam · 8.3x**.
- **Stochastic texture never matches exactly.** Water, smoke, foliage and crowds differ in detail at the wrap, even when the pose comes back. The bridge render on the canoe test brought the paddlers back to their frame-1 pose, but the water texture was different. The join measured **Visible seam · 17x**, so the fixer kept the original. The meter is there so you see this and don't publish a loop that pops.
- Scenes with more structure and less stochastic texture (a street, an interior, a portrait) are where the end guide has the best chance. That is still being measured.
- Sound: LTX makes a sound track. Its wrap is measured (`audio_wrap`: the level jump in dB and the click) but not fixed.

## What runs

| Step | Where | Engine |
|---|---|---|
| Render | GPU, 1 job, about 1 min (Draft) | LTX-2.5 distilled int8: the picture fixed at frame 0, the same picture as a guide at the last index, 8-step distilled. Final adds the x2 latent upsampler and a 3-step refine with both guides again. Sound on. |
| Seal | CPU | If the last frame is a copy of frame 0 (the guide landed), it is dropped. Playing it would show a held frame. |
| Seam meter | CPU, seconds | `soundstage/loop/seam.py` (see below) |
| Trim | CPU, seconds | `fix.best_pair`: the frame pair (start in the first 20%, end in the last 40%, at least 60% kept) where frame `start` looks most like the frame that would follow `end` |
| Bridge | GPU, 1 job | The same graph between two pictures: the last clean frame (before any snap in the tail, `fix.clean_end`) to frame 0, 1 s. `fix.join` appends it, without its first and last frames. Sound follows the pictures. |
| Reseed | GPU, 1 job | Run the card again (a new seed) |

Each step reports the seam **before → after** and is kept only when it is better. With the fixer box ticked, the card uses at most 2 GPU jobs (the render and one bridge).

## The seam meter

Every metric is measured on every in-clip step (frame i → i+1) and on the wrap (last → first). The wrap is judged against the clip's own motion, so a busy clip is allowed a bigger step than a still one.

- **pixel**: the mean absolute grey difference.
- **edges**: 1 − SSIM of the Sobel edge maps, for structure that pops or shifts.
- **motion**: the median magnitude of dense pyramidal Lucas-Kanade flow, in % of the frame width.
- **jerk**: how much the flow field changes from the step into the wrap to the step out of it. This catches a pendulum that snaps back, or a walk that restarts mid-stride.

`ratio = wrap / median(in-clip steps)`, and `seam = the worst of the pixel, edges and jerk ratios`.

- **Seamless**: the seam is at most 1.6x, every metric's wrap is inside the clip's own p95 step, there is no held frame and there is no snap.
- **Visible seam**: anything else. The badge gives the reason: the metric outside the clip's range, a *held frame at the wrap*, or a *jump at frame N* (a step 4x the median in the last 16 frames).

Tests: `tests/test_loop_seam.py` uses synthetic clips. A whole period is seamless, a clip cut off its period is not, a duplicated last frame is dropped, two held frames read as a hitch, and a snap is caught. `tests/test_loop_fix.py` runs ffmpeg end to end: the trim finds the period, and the join appends a bridge with frames and sound in step.

## Routes and tools

- `POST /soundstage/loop/prompt {source, seconds, prompt, seed, quality, sound, end_source?, bridge?}` returns the API prompt (SaveVideo node id `save`) for the App to queue.
- `POST /soundstage/loop/seam {ref}` returns the meter's report.
- `POST /soundstage/loop/fix {ref, how: seal | trim | bridge | join, …}` runs one fix: seal, trim and join return `{ref, before, after, summary}`, and bridge returns the bridge's prompt.
- MCP: `soundstage_loop {source, prompt, seconds, fix, confirm_gpu}`.
- Cards: **Seamless loop** (still or clip), **Seam meter** (any clip, no GPU) and **Fix a loop seam** (any clip).

Results save to `output/soundstage_private/loop/`.
