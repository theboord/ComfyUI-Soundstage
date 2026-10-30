# Touch-up (between rung 2 and rungs 3–4)

When the look still renders, it can be fixed in **VNCCS UniCanvas** (vnccs-utils, MIT; installed on the pod at `custom_nodes/vnccs-utils`). Examples: remove an extra figure, repaint a sign, extend the frame. With **Use touched-up still** on, the motion rungs use the fixed image.

## Graph (`tools/app_build/touchup.py`, in `build.py` PARTS after `models`)

```
look still source ───────────────────────────┐ on_false
VNCCS_UniCanvas -> SplitImageWithAlpha ──────┤ on_true   ComfySwitchNode "Use touched-up still" (lazy, default off)
                                             └─> Gate rung 2 -> "Rung 2 · Look still", L2R look_still (9002),
                                                 stage-2 look still (9034), Video model (any).first_frame
```

- **The look still source** is the models part's "Still model · use picker" switch when that part has run, and VAEDecode 9057 otherwise.
- **Off:** the switch passes the still through and UniCanvas is never evaluated, so every rung computes what it did before.
- **On:** the canvas image replaces the still everywhere downstream.
- **Alpha:** UniCanvas outputs **RGBA**. `SplitImageWithAlpha` drops the alpha so the VAE / L2R see 3 channels.
- **App panel:** the switch is exposed, followed by the canvas editor (`unicanvas_ui`, the DOM widget). The `unicanvas_state` widget is hidden by vnccs.
- **Tests:** `tests/test_touchup_app.py`.

## Seeding the canvas (`web/touchup/touchup.mjs`)

UniCanvas has no image input. Its `unicanvas_state` widget holds a compact layer list (`storage: "server_cache"`, `state_id`, layers with `crop` and `cached: true`, no pixels). The pixels live in the vnccs state cache:
- written by `POST /vnccs/unicanvas_state_upload {state_id, state}`;
- read back at run time by `_load_unicanvas_state` in `nodes/unicanvas.py`.

`seedUniCanvas(app, api, imageRef)` works in six steps:
1. Fetches the rung-2 image from `/view`.
2. Re-encodes it as a PNG data URL.
3. Builds a state:
   - origin −256/−256, so there is room to outpaint;
   - bbox = the still's exact size, so the output size is unchanged;
   - one mask layer plus one raster layer, "Look still".
4. Applies it to the live widget with `applySerializedState`.
5. Uploads the full state to the cache.
6. Writes the compact state into the widget.

**Other exports:**
- `watchRung2(api, app, cb)`: follows the `executed` event of the "Rung 2 · …" node.
- `lastRung2Image(app)`
- `setTouchupEnabled(app, on)`, `isTouchupEnabled(app)`
- `expandUniCanvas(app)`: full-window editor, for the ~260 px App panel; ✕ Done or Esc puts it back.
- `revealUniCanvas(app)`: expands it in App mode and centres on the node in graph view.
- `createTouchupButton({app, api, className, onStatus})`: a ready-made button.
  - Hidden until a rung-2 still exists.
  - With the toggle off: seeds the canvas from the latest rung-2 still, turns the toggle on and opens the editor.
  - With the toggle already on: rung 2 already shows the canvas output, so it just opens the editor ("Edit touch-up"), so the user's layers aren't flattened.

### Mounting it (integrator, `web/soundstage.js`)

```js
import { createTouchupButton } from "./touchup/touchup.mjs";
// next to the Ladder controls (e.g. in the ladder bar), after `status` exists:
const touchBtn = createTouchupButton({ app, api, onStatus: (t) => { status.textContent = t; } });
ladderBar.appendChild(touchBtn);
// in node.onRemoved: touchBtn.dispose();
```

## Verified on :8189 (2026-10-28)

- **Graph view:** the built App loads, 68 nodes. `seedUniCanvas` with `output/soundstage/look_d85_00001_.png` (960×512) put a "Look still" raster layer in the canvas. The widget state is 1.5 KB and the vnccs cache holds the 1.3 MB PNG.
- **Python render:** the compact state, queued as UniCanvas → SplitImageWithAlpha → PreviewImage, produced RGB 960×512, **pixel-identical** to the source (max diff 0).
- **App mode** (after opening in graph view once): the toggle and the canvas editor appear in the panel. `revealUniCanvas` pops the editor out full-window with the seeded still, its layers and the 960×512 bbox.
- **Not run:** the full ladder with the toggle on. Other sessions' Recast jobs held the GPU, so I didn't queue Krea or LTX.

## Limits

- **GENERATE (inpaint/outpaint) in UniCanvas needs one of its model presets.** On the pod, SDXL, Anima, Flux Klein 9B, Z-image and QIE 2511 all report not installed. Paint, erase, shapes, transform, import and layers work without a model. Downloading a preset needs Mike's OK.
- **Output size can change.** If the user moves or resizes the bbox (outpaint), the touched-up still changes size. The L2R takes it as `look_still` like any other still, but keep the 960×512 aspect to match the stage passes.
- **The seeded pixels live in the vnccs server cache** (the vnccs temp dir), plus a localStorage backup. After a pod restart they may be gone; re-seed with the button.
