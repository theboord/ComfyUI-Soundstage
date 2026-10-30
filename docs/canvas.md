# Paint Studio (the Frame step's editor and the Canvas tab)

Paint Studio is a small Photoshop for the first frame, built into the stage widget. Open it from the Frame step's **Paint Studio** card (on the chosen frame) or the Canvas tab. Mask or select an area, describe it, and **Generative Fill** repaints only that area; **Remove** clears it; drag the canvas edge out and **Extend** paints the new area. Pick from variations with a before / after slider, keep one as a layer, then **Use as first frame**. Everything runs on Soundstage's own nodes through ComfyUI's queue; no other custom node pack is needed (the old VNCCS UniCanvas paths are gone).

## Files

| Path | What it is |
|---|---|
| `web/canvas/canvas.mjs` | `CanvasPanel`: the whole studio (tools, layers, history, Generative Fill, variations). Exports `morphAlpha`, `aspectRect` for tests |
| `web/pipeline/pipeline.mjs` | The Frame step's Paint Studio card; `useEditedFrame()` makes a painted picture the shot's chosen frame |
| `soundstage/nodes_fill.py` | `SoundstageFill`, `SoundstageFillCrop`, `SoundstageFillStitch`, `SoundstagePadForFill` |
| `soundstage/fill_math.py` | Crop / pre-fill / feather / colour match / stitch in numpy (no torch) |
| `soundstage/router/fill_graph.py` | The crop -> model -> stitch subgraph and the per-mode prompts |
| `soundstage/nodes_canvas.py`, `web/touchup/touchup.mjs` | The touch-up still the motion steps read (`SoundstageCanvasImage` + "Use touched-up still") |
| `tests/test_fill.py`, `tests/js/paint.test.mjs` | Math, subgraph (checked against the pod's /object_info snapshot), prompts, UI helpers |

## Generative Fill (backend)

`SoundstageFill(image, mask, prompt, mode, model, seed, …)` is a router node on the `edit_image` stage, so its model menu lists every installed edit model (FLUX 3 Klein is the default). It expands into:

1. **SoundstageFillCrop**: the mask is grown (`grow`; Remove +8 px; Extend by `overlap` = 48 px into the picture), then cropped with context (0.6 × the mask's longer side, at least 384 px and room for the seam) and scaled to about `megapixels` (1.0 ≈ 1024², multiples of 16, up to 4× up). Extend pre-fills the empty border from its edges (push-pull pyramid).
2. **The model on the crop.** FLUX 3 Klein / Krea 2: masked-latent inpaint (VAEEncode + SetLatentNoiseMask, denoise 1). Klein also gets the crop as reference image 1 (Fill, Remove, Replace) plus the references, and an edit instruction. Any other edit model (partner APIs) runs its own adapter on the crop.
3. **SoundstageFillStitch**: the crop is resized back and pasted through a feathered alpha (`feather` px), colour-matched (mean / contrast) on a ring of untouched pixels. Pixels outside the feathered mask are bit-identical to the original. Outputs the picture, an RGBA layer of only the generated pixels, and the alpha.

Modes and what Klein is told (tested on the pod, 2026-10-30, on a 976×512 western frame):

| Mode | Klein sees | Prompt | Result |
|---|---|---|---|
| fill | crop + refs | "Add <prompt> in the middle of the picture… Keep everything else exactly the same" (a prompt starting with a verb is used as is) | a barrel added on the street, ~9 s |
| remove | crop | "Remove <prompt or the person or object in the middle>. The background continues…" | the right cowboy gone, clean wall and dust, ~9 s |
| replace | crop + refs | "Put <who> from image 2 into the middle of the picture, exactly as in the reference…" | (needs a reference) |
| extend | refs only | a scene description (the prompt, or the Frame step's description) | 1.9:1 -> 2.39:1 with new buildings, ~7 s |

Without the crop as reference, Remove made a dust cloud; with the pre-filled crop as reference Klein copied the blur; for Extend a crop reference made Klein copy the grey border. Hence the table.

`SoundstagePadForFill(image, aspect | edges, anchor)` is the node-graph way to Extend: a bigger canvas plus the mask of the new area.

## The studio (frontend)

- **Header:** Paint Studio + **Use as first frame** (saves the frame to `input/soundstage/look_still_*.png`, sets `SoundstageCanvasImage` + "Use touched-up still", and calls the pipeline's `useEditedFrame`: the picture becomes this shot's chosen frame, its candidate tile reads "Paint Studio", and Motion animates it. Each shot keeps its own painted still).
- **Left rail** (icon, key, tooltip): Move V, Marquee M, Lasso L, Magic select W (click an object, SAM 3.1 selects it; Shift-click excludes), Brush mask B, Eraser E (mask or layer pixels), Paint P, Crop / Extend C (drag edges / corners past the picture; presets 16:9, 2.39, 1.85, 9:16, 4:3 extend around the picture), Eyedropper I, Hand H, Zoom Z.
- **Top bar:** the tool's options (size, hardness, opacity, eraser target, aspect presets), and with a selection: Grow / Shrink / Feather by px, To mask, To layer, Invert, Deselect. Undo / redo / fit on the right.
- **Generative Fill bar** under the canvas: prompt (Enter = Fill), **Generative Fill**, **Remove**, **Extend** (lights up when the frame has empty canvas), Variations 1 / 2 / 4, the model, references (the Frame step's cast sheets, plus +), and a Fine-tune drawer (seam feather, grow, steps, detail MP, seed). The area is the selection if there is one, else the mask layer.
- **Variations filmstrip:** each seed is its own queued prompt (front of the queue); tiles fill in as they finish. Click to preview on the canvas with a draggable before / after line; **Keep** adds it as a layer (and clears the mask and selection), Discard / Esc throws them away.
- **Right panel:** Layers (show, lock, opacity, rename, add, duplicate, merge, order, delete, import, lift to 3D) and History (every step, click to jump; snapshots).
- **Keys:** B E M L W C V P I H Z, `[` `]` brush size, Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Cmd/Ctrl+D deselect, Cmd/Ctrl+A select all, Space-drag pans, scroll zooms, F fits, Esc. Pointer, wheel and key events are stopped at the studio, so the 3D stage and ComfyUI's graph never see them.
- **Document:** the stage frame size until the chosen frame comes in; then the frame's own size (up to 2048 px), with 35 % room on each side for Extend.

## Persistence

Layer pixels upload to `input/soundstage/canvas/<docId>_<layerId>.png` 1.5 s after an edit; `toJSON()` keeps names, flags, files, the frame size, the Crop / Extend rectangle and the fill settings (node property `soundstage_canvas`).
