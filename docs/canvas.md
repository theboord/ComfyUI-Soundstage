# Canvas tab

The Canvas tab is a layered 2D canvas over the current shot frame, built into the stage widget. It replaces the separate VNCCS UniCanvas node (and the tall blank white box the App used to show). You can paint, mask, select, generate (txt2img / img2img / inpaint / outpaint), lift a piece to 3D, and send the result back as the look still.

## Files

| Path | What it is |
|---|---|
| `web/canvas/canvas.mjs` | The `CanvasPanel` class (self-contained; imports `ui/icons.mjs` and `touchup/touchup.mjs`) |
| `web/touchup/touchup.mjs` | Finds the App's "Use touched-up still" switch and canvas-still node; `setTouchupStill`, `setTouchupEnabled`, `lastRung2Image` |
| `soundstage/nodes_canvas.py` | `NODES = [SoundstageCanvasImage]`: loads the canvas still (input/-relative PNG) as IMAGE |
| `tools/app_build/touchup.py` | App part: canvas still → lazy "Use touched-up still" switch (default off). No canvas widget in the App panel. |
| `tests/test_canvas_node.py`, `tests/test_touchup_app.py` | Node and App-wiring tests |

## Workspace

- **Document:** the shot frame (`stage.fw × stage.fh`, 960×512 today), with half a frame of room on every side for outpainting and for moving layers.
- **Layers, bottom to top:**
  1. **Backdrop plate.** Read from `stage.toJSON().backdrop` (a URL or `{url}`), drawn to cover the frame.
  2. **Stage · shot frame.** `stage.renderFrameTo("color" | "clay", stage.frame)`. Locked by default. Click its kind label to switch colour/clay; ↻ re-renders it.
  3. Paint and generated layers.
  4. **Inpaint mask.** Shown as a red overlay.
- **Layers panel:**
  - Show/hide, lock, opacity, rename (double-click), add, duplicate, merge down, move up/down, delete.
  - Lift to 3D: Card / Splat / Mesh. Only shown when `liftTo3D` is passed.
- **View:** wheel zooms at the cursor; Shift+wheel pans; Space-drag, middle-drag or the Hand tool pans; F fits.
- **Undo/redo:** every stroke and op can be undone with Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Ctrl+Y). The history is capped at 40 steps or about 360 MB; strokes store only their dirty rectangle.

## Tools (left rail)

| Tool | Key | What it does |
|---|---|---|
| Brush | B | Size, hardness, opacity, colour. Clipped to the selection if there is one. |
| Eraser | E | Same options as the brush. |
| Mask brush | M | Paints the inpaint mask. |
| Magic mask | W | Click to include, Shift-click or right-click to exclude, then press **Select**. Runs SAM 3.1 locally (see Engines). |
| Rectangle select | R | Shift adds to the selection, Alt subtracts. |
| Lasso select | L | Shift adds to the selection, Alt subtracts. |
| Transform | V | Drag to move; drag a corner to scale (Shift keeps aspect). With a selection, the selected pixels are lifted onto a new layer first. |
| Generation box | G | Drag out the region to generate in; drag inside to move it, drag a corner to resize. Snaps to 8 px, minimum 64. |
| Pan | H | Moves the view. |
| Eyedropper | I | Picks a colour from the composite. |

Esc deselects (or clears magic points). Delete erases the selected pixels. `[` and `]` change brush size.

**Selection actions:** To mask, Cut to layer, Copy to layer, Erase, Invert, Deselect.

## Generate

The mode follows VNCCS's rule, read from the generation box:
- box empty → **txt2img**
- box full, no mask → **img2img** (uses the Denoise slider)
- box full, with a mask → **inpaint**
- box only partly covered → **outpaint**. The mask becomes the transparent area plus a 32 px overlap, ported from VNCCS.

The inference size is about 1024² at the box's aspect ratio, in multiples of 16. The result lands as a new "Gen · …" layer clipped to the box. For inpaint and outpaint it is pasted through a grown, feathered mask.

## Engines

Everything heavy goes through ComfyUI's queue (`POST /prompt` with `front: true`, then `/history` polling and `progress` events), so it never shares the GPU with another running prompt. The Model menu lists only what the pod already has. Nothing is downloaded.

- **Z-Image Turbo · queued** (default):
  - UNETLoader + CLIPLoader (lumina2) + VAELoader `flux/ae`
  - ModelSamplingAuraFlow (shift 3)
  - KSampler (res_multistep, 8 steps, cfg 1)
  - txt2img uses EmptySD3LatentImage.
  - img2img uses VAEEncode at the Denoise slider.
  - inpaint and outpaint use SetLatentNoiseMask over GrowMask(6). Transparent outpaint pixels are pre-filled mid grey.
- **FLUX.2 Klein 9B · queued** (edit model):
  - UNETLoader + CLIPLoader (flux2, qwen_3_8b) + VAELoader flux2-vae
  - CFGGuider at cfg 1 with ConditioningZeroOut as the negative, so there is no negative prompt.
  - Flux2Scheduler (4 steps) + SamplerCustomAdvanced
  - The box contents go in as a ReferenceLatent; with a mask, SetLatentNoiseMask limits the change to the masked area.
- **Magic mask:** core `SAM3_Detect` with click points on `sam3.1_multiplex_fp16.safetensors`, through the queue.
- **VNCCS direct.** Off by default; pass `allowVnccsDirect: true` to show it. It calls `POST /vnccs/unicanvas/draw` (vnccs-utils, MIT) with Z-Image, Klein or the installed SDXL preset.
  - `/draw` samples outside ComfyUI's queue. On 2026-10-28 a prompt started while it was sampling, and ComfyUI 0.43 aborted with "CUDA illegal memory access".
  - Even when enabled, it refuses to start unless the queue is empty.
  - VNCCS's `/segment` (transformers SAM2) is likewise opt-in, because it would download `facebook/sam2.1-hiera-large` on first use.
- A queued job waits behind whatever is already running. The progress bar says "waiting for the job ahead", then shows the sampler steps.

**Live test on :8189, 2026-10-28, with other sessions' LTX renders in the queue:**
- Magic mask with SAM 3.1: about 9 s of run time.
- A Z-Image inpaint of a 960×512 box: it waited behind two LTX jobs, then ran in seconds. The result landed as a "Gen · inpaint" layer, pasted through a feathered mask.

## Output

- **Use as look still:** saves the composite of the frame (or only the generation box) to `input/soundstage/look_still_<doc>_<hash>.png`. It writes that name into the App's `SoundstageCanvasImage` ("Touch-up · canvas still") and turns **Use touched-up still** on. Rungs 3–4, and the Rung 2 preview, then use it.
- **Import rung-2 still:** brings the last rendered look still in as a layer, to fix it (remove a figure, repaint a sign, extend the frame).
- **Import file…:** adds any image as a layer.
- **Lift to 3D:** calls `liftTo3D(blob, kind, {rect, frame, name})`.
  - `kind` is `"card" | "splat" | "mesh"`.
  - `blob` is a PNG of the selection over the visible layers, or the active layer, trimmed to its pixels.
  - `rect` is in frame pixels; the frame's top-left is 0,0.

## Persistence

- Layer pixels are uploaded with `POST /upload/image` to `input/soundstage/canvas/<docId>_<layerId>.png`, 1.5 s after the last edit.
- `toJSON()` keeps only names, flags, files and revisions, the generation box, and the prompt settings, so workflows stay small.
- The Stage and Backdrop layers are never stored; they are rebuilt from the stage.
- Keep the JSON in node properties, not in the stage scene. Writing it into `scene` would change the stage hash and re-render rung 1 on every brush stroke.

## Integrator: mount snippet (`web/soundstage.js`)

```js
import { CanvasPanel } from "./canvas/canvas.mjs";

// In createStageWidget, next to the other tab views:
const canvasView = document.createElement("div");
canvasView.className = "ss-canvasview"; canvasView.hidden = true;     // shown by a "Canvas" tab button
root.appendChild(canvasView);
const canvasPanel = new CanvasPanel(canvasView, {
  api, app, stage,
  onStatus: (t) => { status.textContent = t; },
  liftTo3D: (blob, kind, info) => maker.lift(blob, kind, info),       // your TripoSplat / DA3 / card maker
});
canvasPanel.load(node.properties?.soundstage_canvas || null);
canvasPanel.onChange = (json) => { node.properties = node.properties || {}; node.properties.soundstage_canvas = json; };
// When the Canvas tab is shown, after stage edits, or when the playhead moves:
canvasPanel.refreshStage();
// In node.onRemoved:
canvasPanel.dispose();
```

- The panel switches itself to a narrow layout below 680 px: the tool rail goes across the top and the panels sit under the viewport. That covers the App side panel; ⤢ Expand gets the full three-column layout.
- It reads the theme's `--ss-*` variables, with fallbacks so it works standalone.
- **Server side:** add `"nodes_canvas"` to the module list in `soundstage/nodes_stage.py`, restart :8189, and rebuild the App with `python3 tools/app_build/build.py`. The App's canvas still is `SoundstageCanvasImage`.
