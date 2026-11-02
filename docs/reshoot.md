# Reshoot from a new angle

✦ One-click › Camera › **Reshoot from a new angle**. Use it on any clip. The same performance, the same moments and the same sound, filmed from a camera moved a little: an orbit, a rise or drop, a dolly or a lens change. The move is relative to the original camera on every frame, so the original move (a pan, a push, handheld) is kept and offset.

## Known limits (read first)

- **Small moves only.** Safe range: orbit ±15°, rise/drop ±8°, dolly ±25% of the subject distance, lens 0.7-1.6x. Past that the new camera sees around things the original never saw, and the render has to invent them. The card clamps the move and says so.
- **Some of the new view is always invented.** An orbit uncovers a strip at one frame edge, and the background behind people and horses. The job reports how much (*"11% of the new view never seen by the original camera"*). On the riders test, a 10° orbit around the riders uncovered 11% of the view, almost all of it a strip at the left edge. Lens changes and small dollies invent the least.
- **A depth guide alone loses the people (measured, rejected).** The first render (riders, 10° orbit, depth guide) kept the blocking and the gallop, but it turned both riders' heads into blown hair masses. It also lost the cowboy hat, ghosted the woman behind a horse, melted the last second, and painted the reveal strip at the left edge as a brown wall. That is a realism-judge FAIL. The guide is now **edges** (Canny on the warped frames: hat brims, faces, reins and set lines), and the frame is pushed tighter until the frame-edge reveal is out of the picture (`plan.auto_frame`, at most 1.25x, and the take says so). The depth guide stays available (`guide: "depth"`). The edge-guided re-render of the same shot keeps the run, the mount and the gallop in step, with faces, hats and reins. It still drifts the woman's wardrobe (her red shirt turns brown and she gains a hat), and the last half second dissolves as the riders leave the frame.
- **Frame 1 is fixed.** The render starts on the warped frame 1. Anything uncovered in it is filled from the background side (a set-extension fill, not a model), so the auto-framing matters most there.
- **Mono depth.** Depth Anything 3 mono gets each frame's depth only up to scale. Every move is a ratio of the subject distance, so scale doesn't matter, but wrong *relative* depth (dust, thin legs, manes) warps wrong. It shows in the guide as ragged edges.
- **Not a camera-control LoRA.** The pod's LTX camera LoRAs are LTX-2 19B. Their 480 target layers all exist in the LTX-2.5 22B transformer with matching shapes, so they *load*. One test render (dolly-in, canoe still, 49 frames) did push in, but the prompt also asked for a push-in, and there was no control render without the LoRA. Whether the LoRA itself does anything on 2.5 is unproven, so Reshoot doesn't use it.
- **Speed.** Depth runs once per take (one GPU job, cached; a second move on the same take skips it). The warp runs on the CPU: about 1 s per frame on an iMac, a few minutes per take on a busy pod. Then one LTX render.

## How it works

1. **Plate.** The take at 24 fps, cut to 8k+1 frames (at most 161), shorter side at most 720 px (ffmpeg).
2. **Depth.** Depth Anything 3 (mono large, the model Video → Stage uses) runs on every frame: `SoundstageClipLoad → DA3Inference → SoundstageDA3Export`.
3. **Re-aim** (`soundstage/reshoot/plan.py`). For each frame, the pivot is the subject distance: the near side (35th percentile) of the depth in the middle of the frame, smoothed over 25 frames. The new camera orbits and tilts around that pivot, dollies along its own axis, and scales the focal length for the lens. Sky, and anything past 40x the subject distance, is treated as being at infinity: it turns with the camera and never slides.
4. **Warp.** Every frame is forward-splatted into the new camera with a z-buffer. Cracks (gaps of 1-2 px where a surface stretches) are closed from the near side. Disoccluded areas are filled from the far side, ring by ring, then from a half-size copy for wide reveals. The warp runs at the guide's size (shorter side 544), and frame 1 again at full size.
5. **Frame.** The reveal at the frame edges is measured over the whole clip. The new camera's lens is pushed just enough (at most 1.25x) to keep it out of the picture, and the clip is warped again.
6. **Render.** The guide is the new view's edges (Canny on the warped frames), or its depth (inverse depth, one scale for the whole clip) with `guide: "depth"`. With the warped frame 1 and the take's own sound (as audio reference tokens), it goes through LTX-2.5 + the union-control IC-LoRA. That is Recast's engine, `footage/graphs.ltx_union_recast`, used as is. The output keeps the original audio.

The job also saves a **warp preview** (`…_warp.mp4`, the warped clip with the invented areas tinted magenta) and the guide, so you can see what the render was given.

## Routes and tools

- `POST /soundstage/reshoot {source, move: {orbit_deg, tilt_deg, dolly, lens}, quality, seed, prompt?, keep_sound?, preview_only?}` returns `{job}`.
- `GET /soundstage/reshoot/job?id=` returns `{state, step, progress, result: {file, words, holes, move, preview, guide, first, notes}}`.
- `GET /soundstage/reshoot/limits` returns the safe range and the presets.
- MCP: `soundstage_reshoot {source, orbit_deg, tilt_deg, dolly, lens, confirm_gpu}`.

Files: `input/soundstage_private/reshoot/` (the plate, guide, first frame and warp preview), `output/soundstage_v2s/rs_<take>.npz` (the depth) and `output/soundstage_private/reshoot/` (the renders).
