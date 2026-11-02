# Refocus after the render

✦ One-click › Camera › **Refocus (focus pull)**. Use it on any take or still. Tap **mark A** on the first frame and **mark B** on the last, pick a **T-stop** and when the pull happens. Focus holds on A, pulls to B and settles, with real lens blur from depth. The generation is not re-rendered: the picture is re-blurred, frame by frame, from its depth.

The result lands as a new take of the same kind (a draft stays a draft, a final a final, a still becomes a look). **Before / after** in the results row wipes between the take you started from and the refocused one.

## Known limits (read first)

- **Not checked on the pod or on a real take yet.** Everything below is tested on Windows with synthetic pictures and a synthetic MP4 (`tests/test_refocus.py`), with Depth Anything 3 replaced by a stand-in. No real take has been refocused, the stage's `depth16` pass has not been rendered in a browser, and the realism judge has not seen a result. The card's layout, mark pickers and Before / after were checked in Chromium on a harness page with the real `oneclick.mjs`, not in the live App.
- **Depth Anything 3 depth is relative.** It knows what is nearer, not how far. One real distance sets the scale: the stage's distance at A when the take's shot is open on the stage, else the card's **Distance to A**, else a guessed 2.5 m (the take says so). The T-stop then means "about this much blur", not a measured lens. We also assume DA3 mono depth is right up to scale only (no offset), as Reshoot does. **This is not checked against the model**: it needs one frame of real DA3 output compared with the stage's depth on a shot that has both (a GPU job on the pod). Where it is wrong, the blur away from A is off, more so far from A.
- **The lens is guessed without the stage.** The take carries no focal length. With the take's shot open on the stage, the shot's own lens (every frame) and T-stop are used, with either depth source; otherwise pick **Lens**, or it assumes 35 mm and T2. The sensor is 36 mm across the frame's **width**, as on the stage, so a 9:16 take has a 36 mm sensor across its short side.
- **Stage depth is the clay set, not the picture.** It has real distances, but where the generation drew past the set (hair, clothes, a sky, anything the model added), the depth is the set's, and its silhouettes are the set's. Auto prefers Depth Anything 3 on the picture and uses the stage only for the distance. If the shot was re-blocked after the take was rendered, the stage depth is wrong for it.
- **Edges come from 504 px depth.** DA3 runs at 504 px (the size Reshoot and Video → Stage use; no bigger run without Mike's say on the shared pod). Scaled up, every depth step is made hard again (no in-between distances along a silhouette, which used to be blurred into the background with the subject's colour: a glow). So the edge sits where DA3 put it, about ±1 DA3 pixel (±4 px on 1080p), not snapped to the picture's colour edge (a guided filter did that before; it copied texture into the depth and put 2-4% of pixels on the wrong side in our tests). Hair, fur and thin objects are all-or-nothing: a strand is either sharp with the subject or blurred with the background. Ties go to the nearer surface, so a sliver of background beside a sharp subject stays sharp rather than the subject smearing out.
- **Blur already in the take stays.** If B is soft in the generated picture, the pull lands on that blur. The job measures detail at both marks and warns.
- **Bright bokeh is invented light, off by default.** 8-bit pictures stop at white, so a practical blurred as it is makes a dull grey disc. **Bright bokeh** lifts small clipped sources up to 4x before the blur so they bloom like real lights: only pixels at the clip (sRGB 250-254 and up) that are a small share of the area around them (the blur disc) and about as tall as wide. A white wall, a bright window, white text, thin white lines and an sRGB 240 surface keep their exposure (tested). It is light the camera never recorded, and it is ours: Hero Frame Rig's renderer invents no radiance.
- **No cat-eye, onion rings, anamorphic ovals or breathing.** The disc is round everywhere in the frame.
- **T-stop is used as the f-number.** Depth of field follows the f-number. A cine lens's T-stop is its f-number less its light loss (under 1/3 stop), so the blur reads very slightly deep.
- **It is a CPU job, one at a time.** It uses half the machine's threads (`SOUNDSTAGE_REFOCUS_THREADS` to change it), and a second refocus waits for the first (the pod is shared). Measured on this Windows box (16 of 32 threads) on synthetic 1080p frames, a receding floor with a subject: about 2.3 s per frame at T1.4 and 1.5 s at T2.8, including 0.16 s to scale the depth up. A 5 s take at 24 fps is about 3-5 minutes. Not timed on the pod. The work runs off ComfyUI's event loop (the server stays responsive).
- **Hidden background is not rebuilt.** Where a blurred foreground edge uncovers what was behind it, the colour comes from nearby background (HFR's "behind" gather), not from a model.

## How it works

1. **Depth** (`soundstage/refocus/depth.py`). Every frame as inverse distance in diopters (1/m, 0 = infinity).
   - **Stage:** when the take's shot is open, the App renders a Refocus-only pass, `depth16` (`web/stage/stage.mjs`): 1/z in 16 bits (R high byte, G low byte, full scale 10 diopters = 0.1 m, black = infinity), as one lossless sprite sheet uploaded to `input/soundstage_private/refocus/`. A step is about 0.6 mm at 2 m. The ordinary 8-bit Depth pass (linear 1-40 m) was too coarse (0.15 m steps) and clipped everything nearer than 1 m. The sheet is centre-cropped to the take's aspect and matched by time, not frame number.
   - **Depth Anything 3:** the take at a working size (long side 768), every frame at its own rate → `SoundstageClipLoad → LoadDA3Model → DA3Inference (mono, 504) → SoundstageDA3Export` on this ComfyUI (one GPU job, cached as `output/soundstage_v2s/rf_<take>.npz`; a second refocus of the same take needs no GPU). The model is the one Video → Stage and Reshoot use, already on the pod (`docs/decisions.md`). Steadying: each frame's overall scale is smoothed over 9 frames (no pumping), the sky is set to infinity, then HFR's gated 3-frame filter and colour-guided edge repair.
   - At render time each frame's depth is scaled up to full size (bilinear) and every depth step is made hard again with a toggle filter (`snap_edges`): a pixel on the ramp between two surfaces takes one surface's distance. Only real steps (a 25% jump within a few pixels that does not keep going, unlike a receding floor) are touched, and a surface between two others keeps its own distance.
2. **Focus** (`soundstage/refocus/plan.py`). Both marks are tracked through the take (pyramidal Lucas-Kanade, forward-backward checked; A from the first frame, B back from the last), so an actor who moves stays sharp until the pull leaves them. The distance under each is read every frame (a trimmed mean of a small patch) and smoothed (a 5-frame median, then a 9-frame mean). Focus holds A's distance until **Pull starts**, eases to B's by **Pull lands** with a quintic ease (no overshoot), then holds B. The ease runs in diopters, like a focus ring's travel.
3. **Lens** (`soundstage/refocus/optics.py`). The thin-lens blur radius in pixels, `f² · (1/z − 1/z_focus) / (2 N (1 − f/z_focus)) × width / sensor width`, less a 0.5 px sharpness tolerance, capped at 5% of the frame.
4. **Bokeh.** In linear light. Layers are binned by blur radius (1 px apart up to 10 px, then 10% apart, so a receding floor gets no visible steps), and each layer is blurred at the mean radius of its own pixels to 1/16 px, so during a pull the blur follows focus a little every frame instead of holding and jumping a whole bin (tested: the frame-to-frame change during a pull has no holds or spikes). Each layer is blurred with a round, unit-energy disc with an antialiased rim, using its own colour and coverage. They are stacked far to near over a "behind" plate gathered only from what is farther than focus, so a sharp subject never smears into the background, in-focus pixels go back untouched (bit-identical), and a blurred foreground spreads over what is behind it. Big blurs run at half or quarter size.
5. **Output.** x264 CRF 12 at the take's own frame rate and size, the take's sound and tags copied unchanged, and its Soundstage recipe kept with a `refocus` block added (T-stop, lens, marks, window, depth source, the focus distance through the take). Files: `output/soundstage_private/refocus/<take>_rf_<settings>.mp4` (or `.png`).

## The card

| Field | Choices | Default |
|---|---|---|
| Mark A | tap the first frame (arrow keys nudge 1%, Shift 5%) | a little above centre |
| Mark B (clips) | tap the last frame | a little below centre |
| T-stop | T1.4, 2, 2.8, 4, 5.6, 8, 11, 16 | the shot's lens key at frame 0 (shot open, any depth source), else T2 |
| Pull starts / lands (clips) | the top … halfway / halfway … the end | 25% / 75% |
| Lens | 18-135 mm | the shot's lens per frame, else 35 mm |
| Distance to A | 60 cm … 10 m | the stage's distance at A, else 2.5 m |
| Depth | Auto, the stage's 3D set (no GPU: the Run button says so), Depth Anything 3 | Auto |
| Bright bokeh | on / off (small clipped lights only) | off |

The marks are tapped on the clip's own first and last frames (never the take's thumbnail, which can be a different still). The ask strip fits a short canvas: the two marks side by side, the controls in a grid beside them, every choice's explanation in its tooltip (checked at a 1024 x 560 window: the Run button and the status line stay in the window).

## Routes and tools

- `POST /soundstage/refocus {source, a: [x, y], b?: [x, y], t_stop, focal_mm?, sensor_mm?, subject_m?, focus_m?, start?, land?, highlights?, depth?: "auto"|"stage"|"da3", stage?: {sheet, cols, frames, tile, fps, focal_mm, dmax}, lens?: {focal_mm: [per frame], fps}}` returns `{job}`. One refocus runs at a time; the next waits ("Waiting for the refocus before it to finish").
- `GET /soundstage/refocus/job?id=` returns `{state, step, progress, result: {file, kind, depth, focus, notes, stats, timings, a_track, b_track}}`.
- MCP: `soundstage_one_click {id: "refocus", opts: {a: "0.3,0.5", b: "0.7,0.5", t_stop: "2", …}, confirm_gpu}` (the App runs it, like every card).

## Credits

The optics are adapted from [Hero Frame Rig](https://github.com/metababe-eth/hero-frame-rig)'s MIT focus pack (`ComfyUI-HeroFrameRig/hfr_core`, commit `946d80a`), ported from torch to numpy and changed as each file's header says. The Bright bokeh lift, the per-layer radius scheme, the depth-step snapping and the tracked marks are ours. Licence: `soundstage/refocus/LICENSE.HeroFrameRig`; see `THIRD_PARTY_NOTICES.md`. Nothing was taken from that repo's Apache-2.0 app code or its Legacy renderer.
