# ⑤ Motion → Follow: Layout · Pose · Ripple edit

⑤ Motion has a **Follow** switch at the top of its settings panel:

| Follow | What drives LTX-2.5 | Status |
|---|---|---|
| **Layout** (default) | the clay video, through the Layout-to-Render IC-LoRA (unchanged) | shipped |
| **Pose** | an OpenPose skeleton of every clay person (body, hands, face), or DWPose read from the source clip, through the union-control IC-LoRA | **experimental** |
| **Ripple edit** | any clip plus your edited frame 1, through the LTX Ripple IC-LoRA | shipped |

Files: `soundstage/nodes_motion.py` (nodes), `soundstage/motion/graphs.py` (expansions), `soundstage/motion/timing.py`,
`web/motion/ripple.mjs` (Follow switch, Ripple and Pose runners), `web/stage/posepass.mjs` (skeleton drawing),
tests `tests/test_motion_graphs.py`, `tests/js/ripple.test.mjs`, `tests/js/posepass.test.mjs`.

## Ripple edit

LTX Ripple v1.1 ([WepeNerd/LTX-Ripple](https://huggingface.co/WepeNerd/LTX-Ripple), LTX-2.x Community License) is a
"First Frame All Frames" IC-LoRA for LTX-2.5. You edit frame 1 of a clip, and the edit is carried through every frame.
The clip's motion, timing and camera are kept.

1. **Clip**: the shot's final or draft, a clip brought in with **Import video → Edit this clip with Ripple**, the clip
   a scene was rebuilt from (Video → Stage), an earlier Ripple take, or **Upload a clip…**.
2. **✎ Edit first frame** opens frame 1 in Paint Studio over the canvas. Mask an area and use Generative Fill, or use
   **Whole frame** (new) to change the whole picture from a description with FLUX 3 Klein. Whole frame needs no mask
   and keeps the same pose, framing and head size, which Ripple needs. Then **Save to reference**.
3. **Ripple it**: Draft renders at 544 px on the short side, Final at 768 px, 25 steps either way. **Edit strength**
   defaults to 1.35, the LoRA's recommended value. Raise it if the edit doesn't carry through the clip; lower it if
   parts you didn't edit change.
4. The result lands as a take on the shot: Takes bin, approvals, and a Clip | Ripple wipe on the canvas. It keeps the
   clip's own audio.

`SoundstageRipple` rebuilds the reference workflow node for node:
- The guide is the edited frame followed by the source frames, cut to the clip length.
- Model chain: LTX-2.5 distilled int8 → `LoraLoaderModelOnly(LTX25_Ripple_v11, strength)` → CFGGuider cfg 1 → euler,
  BasicScheduler simple 25 steps.
- `LTXAddVideoICLoRAGuide`(frame 0, strength 1, downscale 1) → crop guides → decode.

Differences from the reference workflow:
- Clips are retimed to 24 fps by nearest frame and trimmed to 8k+1 frames.
- Colour match is off by default, because the reference workflow's match to the source undoes a relight. You can
  match to the edited frame or to the source instead.

Imported clips, edited frames and results live in `input/` and `output/soundstage_private/`.

Measured on the pod (RTX 6000 Ada), models warm:

| clip | Draft | Final |
|---|---|---|
| 137 frames, 360×480 source | 95 s | 373 s |
| 121 frames at 992×544 | 273 s (cold) | not measured |

**Prompt tip.** "Describe the change" is optional. Never name an object the source performer isn't holding: "whispering
into his phone" made Ripple paint a phone over the mouth in every frame. Describe the person and the light instead.

What holds and what doesn't:
- **Holds:** identity, wardrobe and relight across the clip, plus head motion and expression beats.
- **Loose:** lips follow the speech rhythm (open and closed beats), but not frame-accurate lip sync.
- **Drifts a little:** hair can drift over 5 s.

## Pose follow (experimental)

`web/stage/posepass.mjs` draws every clay person from the shot camera the way DWPose draws, on black:
- 18 body points, from the rig joints;
- 21 points per hand, from the finger joints;
- 68 face points, from a face template on the clay head;
- the face is hidden when the head turns away, and the far ear and eye drop out in profile.

It works for mocap takes, posing in 3D, walk cycles and seated riders. The frames go up as one sprite sheet.
`SoundstagePoseFollow` runs the Recast union-control graph (`ltx-2.3-22b-ic-lora-union-control-ref0.5` on LTX-2.5,
first frame in place, 8 + 3 steps) with that skeleton video as the guide. For a scene rebuilt from a clip, **Read the
pose from the source clip** runs DWPose on the real footage instead.

Tested on LTX-2.5 with real renders (`share/Milestone6_Ripple_Pose/`):
- **Dancer** (Video → Stage of a street-dance clip, people only): Pose follows the choreography about as well as
  Layout. No extra limbs or people, and the identity holds. Spins blur a little more, and the framing drifts slightly
  at the end. DWPose from the clip gives the liveliest motion, closest to the real dancer, but the clip's framing
  differs from the stage camera, so she renders a little larger.
- **Riders** (horses): **worse than Layout**. Horses aren't in a pose map, so LTX keeps the frame-1 horses standing
  while the riders gallop away on new horses (duplicated horses). The Follow card warns when a shot has horses,
  vehicles or animals.
- **Timings:** Pose draft 63 s, DWPose-from-clip draft 246 s (DWPose runs on CPU on this pod), Layout draft 220 s
  including the pass capture.

The 2.3 union LoRA works acceptably on 2.5 for people-only shots. It stays labelled experimental because it can't
steer anything that isn't a person.
