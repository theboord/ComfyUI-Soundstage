# Footage in + Recast

Bring real footage onto the Soundstage and recast one person in it. Everyone and everything else stays
the real plate, and the original audio is kept.

```
Load clip ─► Soundstage · Footage ─► images, subject_mask, others_mask, audio, fps, frames, footage_json
                                          │
character photo ─────────────────────► Soundstage · Recast ─► composite (video, original audio)
                                          │                 ├► composite_frames
                                          │                 ├► swap      (raw engine output)
                                          │                 ├► layer + layer_mask (RGBA subject → Layer Pack)
                                          │                 └► plate     (untouched frames)
```

Files: `soundstage/nodes_footage.py` (nodes), `soundstage/footage/` (`clip.py` trimming/tracks,
`graphs.py` expansion builders, `matte.py` Stage-2 composite), `tests/test_footage_*.py`,
workflows `example_workflows/Soundstage_Recast_LTX.json` (the nodes) and
`example_workflows/Soundstage_Recast_LTX_UnionControl_Graph.json` (the original union-control graph with the composite added).
`tools/install_runpod.sh` also copies both into `ComfyUI/user/default/workflows/`.

`Soundstage_Recast_LTX_UnionControl_Graph.json` is the original union-control graph with its subgraphs intact. Changes:
- Test media swapped for the generated clip, frame 1 and prompt. The original test footage and
  reference image are not in the copy.
- The unused VideoDepthAnything branch is removed from Reference Video. That node pack is not
  installed on the Soundstage ComfyUI, and its output was not wired.
- New Stage-2 group: GetVideoComponents(swap) → SoundstageRecastComposite (plate = the loaded clip,
  mask = Reference Video's SAM3 `mask` output, `framing = cover`) → CreateVideo (original audio) →
  SaveVideo `soundstage/recast_composite`. The raw swap still saves as `soundstage/recast_swap`.

It still uses comfyui-rmbg's `SAM3Segment` (GPL-3.0 node pack, referenced by the workflow, not
vendored). The Recast node uses core SAM 3.1 nodes instead.

## The Recast App (App mode)

`example_workflows/Soundstage_Recast_App.json` (also in the pod's `user/default/workflows/`) is a
ready-to-use app: `extra.linearMode = true` and `extra.linearData` set. Open it in graph view once,
then switch to App mode; a cold load straight into App mode breaks widgets. The panel, top to bottom:

1. **Footage clip** (upload), **Start frame**, **Length** (97 = 4 s at 24 fps)
2. **Who to recast**: describe them (SAM 3 prompt), or a track number (-1 = auto)
3. **New character + action** (one prompt). **Use a character reference image** (toggle) and the
   **Character reference image**. Toggle off → the character is rendered from the prompt with
   Soundstage · Generate Image (Krea 2 Turbo, full-body sheet) through a lazy `ComfySwitchNode`, so
   only the chosen branch runs.
4. **Engine** + **Quality** (final 2x / draft 544p)
5. Run

Outputs, in `output/soundstage/recast_app/`:
- `composite`: the recast shot over the real plate, with the original audio
- `layer`: the swapped subject premultiplied over black. Video codecs here have no alpha; the RGBA
  layer for compositing comes from the Recast node's `layer` output → Layer Pack.
- `matte`: the alpha as a video

Panel labels are widget/input `label`s set in the saved workflow. The file contains no personal names.

## Nodes

| node | what it does |
|---|---|
| **Soundstage · Footage** | Upload a clip (or connect a VIDEO). Trims to `max_frames` and to 8k+1 frames, which is what LTX needs. Cuts the matching audio. SAM 3.1 then tracks every person, seeded by a text prompt (`subject_prompt`) or by click points on frame 1 (`points`, `[{"x":640,"y":360}]` in source pixels; the clicked person becomes the subject). Pick the subject with `subject` (`-1` = the clicked person, else the one with the most screen area). Outputs the subject's MASK batch, a union mask of everyone else, and a footage JSON with fps, length, size, has_audio and per-track stats (coverage, first frame, bbox). Expands into `SoundstageFootageDecode` → `SAM3_Detect` (points only) → `SAM3_VideoTrack` → `SoundstageTrackSelect`. |
| **Soundstage · Recast** | `engine` dropdown (below). Runs the swap, then `SoundstageRecastComposite`. Expands at run time, like the model routers: media inputs are lazy raw links and the backend graph pulls them. |
| Soundstage · Recast Composite | Usable on its own (it is also the Stage-2 composite in the original graph). |
| Footage Decode / Pick Subject from SAM3 Tracks | Internal building blocks, category `Soundstage/Footage/advanced`. |

### Stage-2 composite (the part the original graph never had)

`matte.py`, pure torch:
1. Matte = the subject in the **original** plate ∪ the subject's **new** outline in the swap. The new
   outline comes from a SAM 3 pass on the swap (`new_silhouette`, default on), counted only near the
   old subject. A bigger coat or longer hair is not clipped, and the old actor never shows behind
   the new one.
2. Dilate by `grow` (12 px), average over ±1 frame (stops edge boil), feather by `feather` (10 px).
   The subject core is always fully replaced.
3. Other people (`others_mask`) are cut back out of the matte, so they stay real even where the
   halo would touch them.
4. Optional edge colour match (`match_color`, off by default): shifts the swap's per-frame channel
   means toward the plate by at most ±5%, measured in a ring just outside the matte and smoothed
   over time. It is off by default because LTX re-renders the background, which also drifts a
   little. On the test clip the ring was a bad sample and it tinted the legs green.
5. `plate·(1−α) + swap·α`, at the plate's own size and frame count. The plate is never resampled,
   and pixels outside the matte are bit-exact plate (tested).
   `framing` tells it how the swap maps onto the plate:
   - `stretch`: the swap shows the whole plate. This is what the Recast node's own guide produces.
   - `cover`: the swap is a centred crop of the plate. Use this for the original graph.

**Alignment bug found and fixed.** the original Reference Video snaps the DWPose map with
ResizeImageMask "scale to multiple", which is a *cover* resize (scale, then centre crop). DWPose
returns maps at 512 on the short side, so a 1280×704 clip became a 931×512 map cropped to 896×512.
The swap was therefore a ~4% centre crop of the plate. Stretching it back put the new character
beside the old matte: a ghost arm and a halo. The Recast node now sizes the guide exactly to the
plate's aspect (`graphs.guide_size`, shorter side ~544, multiples of 64, no crop). The union-control graph
workflow keeps the original resize and composites with `framing = cover`.

## Engines and licences

| engine | how | licence / cost | status on the pod |
|---|---|---|---|
| **LTX-2.5 union control (open)**, default | The reference union-control swap graph (LTX-2.5 ICLoRA union control + SAM3 + DWPose, original-audio sampler), rebuilt node for node in `graphs.ltx_union_recast` (see below) | LTX-2.5 weights: LTX-2 Community License (free under $10M annual revenue). Union-control IC-LoRA: same. Krea 2 Turbo (frame 1): Krea 2 Community License. Identity Edit LoRA **v1.1**: Krea 2 Community (<$1M); do NOT switch to V2 (non-commercial). | runs |
| **Wan 2.2 Animate 2 (open)** | router adapter `wan_animate2`, fed the subject-gated DWPose video as its pose video and the character as its reference | Apache-2.0 | **not installed**: `wan_animate_2_distill_int8_convrot.safetensors` is not on the pod. The node says so. (The pod only has the older `wan2.2_animate_14B_bf16`.) |
| **Openjutsu · MiniMax H3 API (partner)** | Openjutsu's model (MiniMax H3 reference-to-video) hosted by MiniMax: `MinimaxHailuo03ReferenceNode`, Video 1 = plate with its audio, Image 1 = character, Image 2 = recast frame 1 (Openjutsu's "anchor"), prompt in Openjutsu's wording; then the Soundstage composite | paid partner node (the user's Comfy credits), needs sign-in, hidden by `SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1`. Covered by MiniMax's API terms, **not** the H3 weights licence, so it is the licence-clean H3 path from the US | wired + graph-tested; **not run yet** (spends credits; waiting for an OK) |
| **Openjutsu · local H3 (license: not for US use)** | Comfy's Openjutsu `workflows/swap.api.json`, node for node (`graphs.openjutsu_local`): H3 ref2va pruned int8 + `h3_character_swap_v1.5` + 8-step 768p turbo LoRA, Akatz Labs' `H3CharacterSwap*` nodes (prepare 768 / SAM 3.1 subject track / recover / expand 64 px / 124-frame windows, 18 history, er_sde 8 steps). Fed our plate + audio, character, Krea frame 1 as anchor, subject prompt; composited with `framing = cover` | **H3 Community License excludes the USA, EU, UK, South Korea** (§I.5), weights *and outputs* (§V.4). Refuses unless `SOUNDSTAGE_H3_LICENSED=1`. **Node pack is GPL-3.0**: Soundstage only emits its node names, it is never vendored; install it separately | wired + graph-tested; **cannot run on the pod yet**: pack + 2 LoRAs missing (below) |

Higgsfield Genjutsu was removed (2026-10-28): nothing in Recast calls Higgsfield's API.

### Openjutsu: what it is, and the two licence questions

[Comfy-Org/comfy-openjutsu](https://github.com/Comfy-Org/comfy-openjutsu) is an MIT Next.js app. It
uploads a clip + character image to a **Comfy Developer Platform deployment** and runs
`workflows/swap.api.json`, which is Akatz Labs' "H3 Character Swap" workflow
([akatz-labs/h3-character-swap-tool](https://github.com/akatz-labs/h3-character-swap-tool) @ `0670e4f`)
with a few changes: LoRA v1.5, a Video Slice trim, LoadImage anchor, CreateVideo/SaveVideo. It is
**local weights on Comfy's GPUs**, not a MiniMax API call. Its optional first-frame step uses GPT
Image 2.5 through Comfy Router; Soundstage uses its own Krea 2 frame 1 instead. Built for ComfyUI
v0.41 on a 96 GB RTX PRO 6000; untested on 48 GB.

- **GPL**: the `h3_character_swap` node pack is GPL-3.0 upstream (it vendors GPL code, `vendor/context_loop`),
  and Openjutsu's `build/h3_character_swap.patch` is GPL too. The app and workflow are MIT. Soundstage
  references the node classes in an expansion and never copies the code, so the pack stays a separately
  installed dependency under its own licence.
- **US licence**: confirmed in the actual licence text (`MiniMaxAI/MiniMax-H3/LICENSE`). §I.3/§I.5 define
  the Applicable Territory as worldwide **excluding the EU, the UK, the Republic of Korea and the USA**;
  §II grants rights "solely within the Applicable Territory"; §V.4 forbids use, reproduction or display
  of the H3 Works **or their Outputs** outside it. Over $20M revenue needs written authorisation (§IV.1).
  Comfy's own `build/model-files.md` says the same, and the same terms cover the character-swap LoRA. So
  running Openjutsu's weights on our pod for a US entrant / LA demo is **not licensed**. Licensed routes:
  (a) **MiniMax's hosted API** via the partner node (the engine above), (b) Openjutsu on **Comfy Cloud /
  Developer Platform**, whose subscriptions include H3 commercial rights per Comfy's docs, or (c) a
  commercial licence bought from Comfy/MiniMax.
- **"Built with MiniMax H3" bonus**: route (a) is the clean way to qualify from the US.

To run Openjutsu locally where licensed, these are missing on the pod (everything else is there: H3
ref2va pruned int8, qwen3vl_32b nvfp4, H3 video/audio VAE, SAM 3.1):
- node pack: `worker_nodes/h3_character_swap` from akatz-labs/h3-character-swap-tool @ `0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b`
  + `build/h3_character_swap.patch` from Comfy-Org/comfy-openjutsu (`git apply -p1`) → `custom_nodes/`
- `loras/h3_character_swap_v1.5.safetensors` (155 MB) from `akatz-ai/MiniMax-H3-Character-Swap-LoRA` @ `d06323b7`
- `loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` (1.96 GB) from
  `lightx2v/Minimax-h3-Turbo` @ `3ec17a32`. The pod has the non-768p `…8step_v1.0_comfyui_bf16`, but Openjutsu pins the 768p one.

### The LTX recast graph (what the expansion builds)

Same nodes, settings and order as the original graph, re-wired for ComfyUI v0.43 and the shared models:

- **Load Models**: `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot` → `LTXICLoRALoaderModelOnly`
  (`ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5`, strength 1; outputs the latent downscale
  factor), `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot` (local encode, `ltxv`), video VAE
  `ltx-2.5-video-vae-conv-bf16`, `ltx-2.5-audio-vae-bf16`, `ltx-2.5-latent-spatial-upscaler-x2`.
- **Reference Video**: shorter side 544 → `DWPreprocessor` (body + face + hands, yolox_l.onnx +
  dw-ll_ucoco_384_bs5) × the subject's SAM 3 mask (`ImageBlend` multiply; the mask is grown 12 px
  first), so only the recast person drives the IC-LoRA → snapped to 32 × downscale factor.
  the original graph used comfyui-rmbg `SAM3Segment` (max 1 segment). The node uses core SAM 3.1 tracks
  instead (per person, stable ids, others kept). The union-control graph workflow keeps `SAM3Segment`.
- **Frame 1**: the character standing in the shot. When `first_frame` is not connected it is made
  with the Soundstage keyframe recipe: Krea 2 Turbo + Identity Edit v1.1, plate frame 0 as the
  scene ref (`hold_blocking`, ref_boost_a 1.0), the character as the subject ref (`likeness`,
  ref_boost 4.0), 8 steps, cfg 1, euler_ancestral/beta, about 1.2 MP. This frame goes into
  `LTXVImgToVideoInplace` (strength 1) in both stages, exactly where the original graph puts its ref image.
- **Preprocess**: `EmptyLTXVLatentVideo` at the guide size → first frame in place →
  `LTXAddVideoICLoRAGuide` (frame_idx 0, strength 1). **Original audio**: `VAEEncodeAudio` →
  `LTXVSetAudioRefTokens`. Its conditioning drives both samplers and its frozen audio latent is what
  stage 1 samples. No audio → empty audio latent.
- **Sampler, distilled (8 steps)**: CFGGuider cfg 1, euler_ancestral, the original manual sigmas
  `1.0 … 0.421875, 0.0` → `LTXVCropGuides`.
- **Upscale and re-sampler (3 steps)** (skipped with quality = draft): x2 latent upsampler → first
  frame in place again → concat the stage-1 audio latent → euler, sigmas `0.85, 0.725, 0.4219, 0.0`.
- **Decode**: `VAEDecodeTiled` 512/64, temporal 128/32. The output videos carry the source's own
  audio track, not a re-decoded one.

## Timings (RTX 6000 Ada 48 GB, pod, ComfyUI v0.43)

Test clip: 1280×704, 97 frames (4.04 s at 24 fps) with an LTX-generated audio track. It was generated
fresh for this test: Krea 2 Turbo still → LTX-2.5 i2v, a woman in a yellow raincoat walking toward
camera, a man reading on a bench behind her. No real people. The character ref is a Krea 2 Turbo
render of a man in his sixties in a red puffer jacket. Inputs on the pod: `input/recast_test_plate.mp4`,
`input/recast_test_charref.png`, `input/recast_test_frame1.png`. Outputs: `output/recast_test/`
(`v2_final_*`, `v2_draft_*`, `v3_final_*`) and `output/soundstage/recast_*` (union-control graph workflow).

| run | wall time | notes |
|---|---|---|
| Recast node, final, cold (fresh server, every model loaded) | **1079 s** (18 min) | first run; had the alignment and green-tint bugs |
| Recast node, final, after a server restart (v2) | **808 s** (13.5 min) | fixed composite; output 1792×1024 swap → 1280×704 composite |
| Recast node, final, new seed, models warm (v3) | **947 s** | Footage tracks cached; the GPU was shared with other sessions' jobs |
| the original graph + Stage-2 composite (union-control graph workflow), frame 1 given | **501 s** (8.4 min) | no Krea step, SAM3Segment instead of tracking, no new-silhouette pass |

Measured pieces (log timestamps, v3):
- Stage 2 (x2 latent upsample + 3 steps): ~23 s. Tiled decode: ~25 s.
- New-silhouette pass, per-frame `SAM3_Detect` on 97 frames at 1792×1024: **274 s**, the biggest single
  cost. It was switched to `SAM3_VideoTrack` with detection every 4th frame. Measured on its own on the
  v3 swap: **49 s** including decode and model load, and the mask matches. This code is synced to the
  pod but loads on the next :8189 restart, so expect about 4 minutes less than the rows above.
- DWPose runs on CPU on this pod (see Known limits). Krea frame 1 is ~10-20 s warm.
- Draft quality (544p, one stage, 960×512 swap) ran fine. Its timing was lost in a server restart; not measured.

App run (Recast App, from the App-mode Run button, reference toggle OFF so the character came from
the prompt): **951 s**, 1280×704 × 97 frames composite with audio. The audio matches the source
(mean −49.9/−50.0 dB, peak −21.1 dB). Watching it every 8th frame showed a real artefact: LTX invented
a seated figure right beside the walking man (frames 0–40). The old new-silhouette rule (any hit
within reach of the subject) pasted it over the plate. Fixed: the swap is tracked per person and only
the track overlapping the original subject is kept (`SoundstageTrackSelect.match_mask`); reach halved.
Verified after the restart: same graph and seed, **826 s** cold (the faster outline pass is live, vs 951 s).
The matte is one clean silhouette and the invented figure is gone from the composite. The audio still
matches the source. Residue: in a few early frames a small faint fragment of the invented figure shows
where it overlaps the 12 px grow band. Possible follow-up: also cut the swap's other tracks out of the
matte, the way `others_mask` protects plate people.

Quality, watched as contact sheets and full-res frames: the subject is replaced across all 97 frames;
the bench man, building and paving are the untouched plate; original audio levels match the source
(mean −49.9 vs −50.0 dB, peak −21.1 dB both). Remaining artefact: a faint soft halo where the swap's
re-rendered background shows inside the 10 px feather (shoulders). Lower `feather`/`grow` if it shows.

## Tests

```
cd tests && python -m pytest test_footage_matte.py test_footage_graphs.py -q
```
- `test_footage_graphs.py` (no torch): every expansion (LTX with and without audio, draft, Krea
  frame 1, tracking with and without points, composite + silhouette) is checked against
  `test_footage_object_info.json`, a /object_info snapshot of the pod. The checks cover node
  existence, required and nested inputs, combo values, ranges and link types. It also asserts the
  graph matches the original (sigmas, samplers, DWPose flags, two in-place first frames, original audio →
  ref tokens → sampler).
- `test_footage_matte.py` (torch): background bit-exact outside the matte, other people kept, subject
  replaced, new silhouette accepted only near the subject, frame/size fitting, dilate/blur/temporal,
  colour match, trimming, audio cut and padding, click-point parsing, subject selection, JSON.
- The pod venv has no pytest. To run there, put a minimal shim next to the tests (the dev used one
  from the scratchpad). Nothing is installed on the pod.

## Hooking Footage into the main Soundstage App (later)

The main App (`Soundstage_App.json`) can get Footage as a third stage source next to the 3D set,
without touching its ladder:
- Add a `SoundstageFootage` node and a `SoundstageRecast` node to the App graph. Expose Footage
  `file / start_frame / max_frames / subject_prompt` and the Recast prompt/engine in `linearData`.
- Gate the outputs by rung with the existing `SoundstageGate` (rung 1: Footage tracks preview via
  `footage_json` + subject_mask; rung 3: Recast quality = draft; rung 4: final). Footage tracking and
  the Krea frame 1 are cached across rungs because their inputs don't change.
- The stage widget then only needs a Source switch (3D set | Footage) that writes the uploaded file
  name into the Footage node. The click-to-pick and tracks UI below are optional polish.
- Recast `layer`/`layer_mask` → `SoundstageLayerPackAddLayer`, same as stage actors.

## For the integrator: a "Footage" source in the stage widget

The stage widget (`web/stage/**`, not touched here) can offer Footage next to the 3D set:

1. **Source switch** in the stage panel: `3D set | Footage`. Footage mode shows the clip's frame 1
   instead of the three.js viewport. Upload with the stock `POST /upload/image` (it accepts video;
   `type=input`) and write the returned name into a `SoundstageFootage.file` widget. The widget's
   own playback can use `/view?filename=…&type=input`.
2. **Click to pick**: clicks on frame 1 become `points` (source-pixel coords, JSON
   `[{"x":..,"y":..}]`); shift-click → `negative_points`. Show a dot per click. For a live outline
   before queueing, queue a 3-node graph from the browser (`LoadImage` frame 1 →
   `CheckpointLoaderSimple sam3.1` → `SAM3_Detect` with `positive_coords` → `PreviewImage` of the
   mask), the same pattern as the object designer's TextGenerate call.
3. **Tracks list**: after a run, `footage_json.tracks[]` gives every person's `bbox_first`,
   `coverage` and `frames_visible`. Draw the boxes on frame 1 and let a click set `subject`.
4. **Recast panel** (or the Look tab): character image drop zone (→ `LoadImage` → `character`),
   prompt, engine dropdown (just mirror `SoundstageRecast.engine`; Openjutsu local stays visible but
   errors with the licence note unless the user has opted in).
5. **Ladder**: the recast fits rungs 3/4. Set quality = draft (544p, one stage) for rung 3 and
   final for rung 4, with `SoundstageGate` before the outputs as in Shot v2. Frame 1 (Krea) is
   cached across both rungs as long as the character, prompt and seed do not change.
6. **Layer Pack**: `layer` (RGBA) + `layer_mask` → `SoundstageLayerPackAddLayer(kind=character)`;
   `plate` → a plate layer at z 0. footage_json has fps for `LayerPackStart`.

Wiring is already in place: `nodes_stage.get_node_list` loads `nodes_footage`.

## Known limits

- One subject per pass. To recast two people, chain two Recasts: composite of pass 1 → plate of pass 2.
- LTX length: 8k+1 frames per pass (97 = 4 s at 24 fps, 121 = 5 s). Longer clips need the
  `use_streaming` tiled guide or chunking. Not built yet.
- DWPose's yolox runs on CPU on this pod: onnxruntime's CUDA provider cannot load
  (`libcublasLt.so.12` missing in the shared cu128 venv). It works, just slower. The torchscript bbox
  detector or fixing the CUDA libs would speed it up. That install is shared, so it was left alone.
- Wan and both Openjutsu engines are wired but not run end to end (see the table).
