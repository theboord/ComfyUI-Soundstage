# Plate lock and the Fidelity chip

A one-click edit or a Recast re-renders the **whole frame**. Even where nothing was meant to change, the model shifts
the colour, smooths the grain and re-invents texture. Plate lock puts the result back onto the source plate so the
pixels outside the edit stay the plate's. The **Fidelity** chip says how much survived.

## Read this first: what it does not do yet

- **Not run on the GPU pod yet.** Everything here was tested on CPU with synthetic plates: procedural sets with sensor
  noise, and a simulated model that renders at half resolution, soft, grain-free and colour-drifted, plus the edit.
  Nobody has watched a real relight, Empty the scene or Recast through it yet. The thresholds (sensitivity 0.5, about
  20 plate-px safety halo) are PlateLock's defaults and are not tuned on Soundstage footage.
- **Clip takes are h264 MP4.** The bit-identical figure is measured on the composite's frames *before* the encode.
  The MP4 that plays re-encodes every pixel (yuv420p, lossy), so a frame grabbed from the MP4 is *not* bit-identical
  to the source. Still takes are PNG and do hold bit-for-bit. A lossless clip delivery (FFV1 or a PNG sequence) is
  not built.
- **No geometric alignment.** If a model shifts or rescales the picture (Klein can, by a few pixels), every
  high-contrast edge lights up in the difference matte and the model's pixels are taken there. The report shows it
  as a bigger edit area. Body Double's knot-warp `align()` is the fix to port next.
- **Look mode is not bit-identical, by design.** A relight changes the light on every pixel. Plate lock carries that
  change onto the plate's own pixels as a smooth gain, so the texture, grain, faces and text are the plate's, re-lit.
  The chip says "original detail, re-lit", never "identical". A light that switches on in a near-black area can't be
  carried by a gain (it's clamped), so the model's pixels are taken there.
- **The safety halo is generous.** The matte grows about 10 model px (hysteresis 2, grow 4, feather 4) past what
  changed. On a small object that halo can be more of the edit area than the object.
- **Follow-cam is untested on real footage.** The crop maths, paste-back and auto rule are unit-tested. No engine has
  rendered a follow-cam crop yet.
- **The chip shows in the ✦ One-click results panel only.** It is saved on the take (`take.oneclick.fidelity`). The
  Dailies cards and the Ladder don't draw it yet. Recast reports through its new `fidelity` output (a JSON string) and
  the node's text, not a chip: Recast has no App view yet.

## How it works

`soundstage/footage/platelock.py`, pure torch (CPU-testable), adapted from PlateLock (MIT, see
`THIRD_PARTY_NOTICES.md`):

1. **Robust tone fit.** A per-frame, per-channel affine `gen ≈ gain·plate + bias`. It is fitted on a heavily blurred
   1/8 copy, iteratively reweighted so the pixels the edit changed don't bias it. Reduced-major-axis regression keeps
   sensor noise from pulling the gain towards 0. The fit is smoothed over 5 frames. Inverting it removes the model's
   global colour drift, so the drift is not read as an edit.
2. **Difference matte.** Opponent-space (luma + 2 chroma, chroma ×2) distance after a 1.5 px blur. A robust per-frame
   noise floor is taken from the quietest half of the frame, so it holds even when the edit covers a lot of it. The
   matte is a smoothstep between a weak and a strong threshold.
3. **Hysteresis in space and time.** A 3D (x, y, t) geodesic reconstruction keeps a weak change only if it connects,
   in space or in time, to a strong one. Isolated VAE sparkle dies, and the soft edge of a real change survives.
4. **Temporal stabilise.** A 5-frame temporal median, then a zero-phase EMA: `max(raw, min(forward, backward))`.
   A fast mover leaves no trail, and one-frame dropouts are filled.
5. **Refine.** Open 1, close 3, grow 4, feather 4. The soft edge never reaches further than the feather, so a
   gaussian tail doesn't cost bit-identical pixels.
6. **Composite + re-grain** at the plate's own size, 8 frames at a time. Below 1/512 the matte is snapped to 0, and
   there the plate is copied bit-for-bit (`torch.where`, no float round-off). Inside, the generated pixels get only
   the grain they lack: `sqrt(max(0, σ_plate² − σ_gen²))` per channel, measured by a robust high-pass MAD.
7. **Fidelity report**:
   - `bit_identical_pct`: pixels exactly equal to the plate;
   - `edit_area_pct`: matte > 0;
   - `psnr_outside_db`: the composite vs the plate where the matte is 0 (`"inf"` = lossless);
   - `raw_psnr_outside_db`: the model's own output there, for contrast.

### Modes

| mode | for | inside the matte | outside the matte |
|---|---|---|---|
| `local` | Empty the scene, Recast, anything that adds or removes a thing | the model, tone-fitted to the plate, re-grained | the plate, bit-for-bit |
| `look` | the 18 relights, Nightfall, Rain, Snow, Fog, Golden hour, Flood | the model, re-grained (snow on a ledge, a lit window, a puddle) | the plate × a smooth light map (blur(gen)/blur(plate) at ~1/24 frame height, gain 0.02–6) |
| `alpha` | Cutout | n/a | RGB is the plate bit-for-bit; alpha is the model's matte, temporally stabilised |

In `look` mode the difference matte compares the model with the *re-lit plate*, so the light alone is never an edit
(tested: a pure warm key from the right gives an empty matte).

## Where it runs

### ✦ One-click

Each lockable card has a **Plate lock** box, on by default. Calls through MCP that don't send `opts.plate_lock: false`
keep it on.

| card | mode | still | clip |
|---|---|---|---|
| Nightfall, Flood, Rain, Snow, Fog, Golden hour | look | node 3 locks the Klein edit; 9 saves it; 8 keeps the raw edit | the Ripple job also loads the source as Ripple does (24 fps, 161 frames), locks Ripple's frames onto it (node 5) and saves the take with Ripple's audio (7); the raw Ripple clip is kept (2) |
| 18 relights | look | as above (also the experimental depth-locked Krea pass: node 5 locks it, 7 keeps it raw) | as above |
| Empty the scene | local | as above | clean-plate IC-LoRA → node 3 → take (51); raw clean plate kept (53) |
| Cutout | alpha | the matte node → node 5 → RGBA PNG of the plate's own picture | ProRes 4444 from the plate's picture + the steadied matte; preview on black from the same |

Angles, Expand, Living photo and the practical FX are not locked. They change the camera, the frame or the time, so
there is no plate to keep.

The **Fidelity chip** sits on each result in the one-click window:

- `◎ 91.4% identical · lossless` for a local edit. It is green at 50% or more, red below: most of the frame was
  taken from the model.
- `◎ 80% original detail, re-lit` for a look edit.
- `◎ picture 100% original` for a cutout.

Hover for the full report, including what the raw model scored outside the edit. It is stored on the take as
`take.oneclick.fidelity` (with `raw`: the unlocked file).

### Recast

`SoundstageRecast` has two new advanced inputs:

- **`plate_lock`** (default on): the composite fits the engine's colour drift on the background (outside the
  subject) and inverts it on the swap. It also takes what the engine changed within 4% of the frame height of the
  subject (a wider costume, a hat, a prop). This is the difference matte above, cut to a reach around the subject
  (Body Double's cast-matte idea). It re-grains the swap too. Outside the matte the plate stays bit-for-bit either
  way; an invented person far from the subject is not taken (tested).
- **`follow_cam`** (`auto` by default, `on`, `off`): a virtual camera that follows a small performer.
  `SoundstageFollowCrop` plans one rect per frame (Body Double's `plan_crops`): the subject box × 1.45, at the
  plate's aspect, smoothed over ±12 frames, never zoomed more than 4×. It scales each rect up to the plate's size,
  so the engine sees a big performer at the size it already expects. The new-silhouette pass runs on the crop too.
  `SoundstageRecastComposite` scales the swap back into each rect on the untouched plate. A 2% ramp fades the rect's
  inner edges; edges that touch the plate border don't fade. `auto` follows only when the subject's median height is
  under 40% of the frame. Otherwise the frames pass through untouched.

The new last output, **`fidelity`**, is the report JSON. The composite node also prints it.

### Nodes

- **Soundstage · Plate Lock** (`SoundstagePlateLock`): `plate`, `generated`, `mode`, `sensitivity`, `regrain`,
  `grow`, `feather`, optional `alpha`, `region_hint`, `protect` and `seed`. Outputs `composite`, `matte` and
  `fidelity`. It is an output node, so the report shows in the node and in `/history` as `text: [readable, json]`.
- **Soundstage · Follow Crop** (`SoundstageFollowCrop`): `images`, `subject_mask`, optional `others_mask`, `mode`,
  `follow_below`, `margin`, `smooth` and `max_zoom`. Outputs cropped `images`, `subject_mask`, `others_mask` and
  `crop_json`.
- **Soundstage · Recast Composite** has new optional inputs `crop_json`, `tone_fit`, `reach` and `regrain`, and a new
  4th output `fidelity`. The defaults keep the old behaviour.

## Tests

```bash
python -m pytest tests/test_platelock.py tests/test_platelock_nodes.py tests/test_footage_matte.py tests/test_footage_graphs.py -q
node --test tests/js/oneclick.test.mjs
```

- `tests/test_platelock.py`: a local edit is taken and everything else stays bit-identical (and far from the raw
  model's 26 dB). The tone fit recovers a 1.2× / −0.05 drift with about 31% of the frame edited. Hysteresis works in space
  and time. One-pixel sparkle stays out of the matte. A dropout is filled and a fast mover leaves no trail. Re-grain
  adds only the missing grain. In look mode the light alone is no edit, snow on a ledge is taken, and the rest is the
  plate's texture re-lit. Alpha mode keeps the picture and steadies the matte. The report counts are checked.
  Follow-cam crops track smoothly at the plate's aspect, pass big subjects through, and round-trip. Recast pastes a
  follow-cam swap back with the plate bit-identical outside every rect. Reach takes a hat but not an invented
  neighbour.
- `tests/test_platelock_nodes.py`: the three nodes' `execute()` runs on synthetic plates (through a ComfyUI
  stand-in).
- `tests/test_footage_graphs.py`: the follow-cam + plate-lock Recast wiring is valid against the pod's
  `/object_info` snapshot.
- `tests/js/oneclick.test.mjs`: each card queues the plate-lock node in the right mode and saves the locked result
  as the take. Unticking the box gives the old graph. The chip reads the report.

## Credits

- **PlateLock** by the PlateLock contributors (MIT): the tone fit, difference matte, 3D hysteresis, temporal
  stabilise, composite, grain estimate and report. Adapted in `soundstage/footage/platelock.py`; the changes are
  listed in its header.
- **Body Double** by lucataco (Apache-2.0): the follow-cam crop plan, the crop-edge ramp and the cast-matte idea.
  Adapted in `soundstage/footage/followcam.py`, changes marked in its header. Its NOTICE is carried in
  `THIRD_PARTY_NOTICES.md`.
