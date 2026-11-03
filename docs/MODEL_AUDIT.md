# Model audit: where Soundstage is tied to one model

Mike's directive (2026-11-02): no model lock-in. Soundstage renders video and sound with LTX-2.5, and stills with FLUX 3 Klein (Krea 2 optional). It uses them because they were the best offline models for the contest, not because the design needs them. The goal: adding a better or newer video, image or audio model takes one registry entry and one adapter, with no other code changes, and every App stage can then use it. This page lists each place where that is not true yet. Evidence is file:line at main `0b89169`. This page changes no code. [ADD_A_MODEL.md](ADD_A_MODEL.md) says how to add a model today.

## In short

- The router (`soundstage/router/`) covers 5 stages: generate_image, edit_image, generate_video, matte and clean_plate. A model added there shows up in that stage's picker, with no other change.
- 19 generation paths build their own graphs and never ask the router. 12 of them run LTX-2.5. They include the App's default final render, Shot from Sound, Recast, Ripple, Pose follow, Performance, Reshoot, Loop, SFX and music.
- Audio has its own engine list (`soundstage/audio/engines.py:49-93`) with a different schema. An audio model cannot be added through `registry.json` today.
- Several routed paths still pick the model by its label, for example `"FLUX 3 Klein · local [<$5M]"`. A new model appears in their dropdowns, but it is never picked by default and loses some features.

### The directive's facts, checked

| Claim | Finding |
|---|---|
| The router routes 5 stages | True. `soundstage/router/build_registry.py:20-26`; one node per stage in `soundstage/nodes_router.py:154-370`. |
| About 39 video models | Not confirmed. `registry.json` has 277 entries, but only 40 have an adapter, across all 5 stages. 15 of those serve generate_video, and 3 of the 15 are open weights. The default (open-weights) build can list at most 3 video models. On the test snapshot it lists 1, LTX-2.5 (`tests/test_router_registry.py:103`). |
| Recast (`soundstage/footage/graphs.py`) is hardwired to LTX-2.5 | Partly. LTX-2.5 union control is the default of 4 hard-coded engines (`soundstage/nodes_footage.py:269-273`). Wan Animate 2 runs through a router adapter, by a fixed id. The two H3 engines bypass the router. |
| The Clay→Final/Motion render is in `nodes_cine.py` | No. `soundstage/nodes_cine.py` builds no graph (0 `g.node` calls). It writes LTX- and H3-style prompt text. The real render path is the App graph, `example_workflows/Soundstage_App_Full.json`, built by `tools/app_build/build.py:15-28`. |
| `soundstage/audio/graphs.py` is hardwired to LTX-2.5 | True for SFX, music, video-to-audio and Shot from Sound. Dialogue and voice change use Chatterbox or ElevenLabs. |
| `soundstage/loop/graphs.py` is hardwired to LTX-2.5 | True. Its weights come from Recast's table (`soundstage/loop/graphs.py:22`). |
| Missing from the list | `soundstage/motion/graphs.py` (Ripple, Pose follow), `soundstage/performance/graphs.py`, `soundstage/reshoot/graphs.py`, `soundstage/agent/pitch.py` (Pitch Mode) and the App's Krea 2 + depth branch. |

## Paths that bypass the router

Terms:
- **8k+1**: a frame count of the form 8k+1 (LTX's frame grid).
- **IC-LoRA**: an LTX in-context control LoRA.
- **A/V latent**: LTX's joint audio and video latent.
- **FG**: `soundstage/footage/graphs.py`. Most LTX paths import its weight table (`LTX_WEIGHTS`, :18-27), sampler and sigmas.

| Stage | File:lines | Hardwired model | What its adapter needs | Covering tests |
|---|---|---|---|---|
| **V1** ⑤ Motion draft (rung 3) | `example_workflows/Soundstage_App_Full.json` nodes 5004, 5014, 9002, 5516, 9062; knobs `soundstage/nodes_quality.py:71-155`, `soundstage/ltx_settings.py:43-216`; UI `web/pipeline/pipeline.mjs:1189-1192` | LTX-2.5 22B distilled, Gemma 4 12B text encoder, LTX-2.5 video VAE, `ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors` | Control video = stage clay (IC guide at frame 0, strength 1). Chosen frame as a reference guide at frame -1, strength set by Adherence. Frames 8k+1 at shot fps. Stage-1 size, multiples of 32. A draft tier distinct from final. A sigma ladder the presets map onto. No audio. | `tests/test_ltx_settings.py` (test_app_quality_node_drives_the_render, adherence tests), `tests/test_quality.py`, `tests/js/ltxadvanced.test.mjs`. Wiring only; nothing renders. |
| **V2** ⑤ Motion final (rung 4), the App default | `Soundstage_App_Full.json` nodes 9034, 5518, 4852, 9101, 9103; switch 9084 off (`tools/app_build/models.py:81-101`); UI `web/pipeline/pipeline.mjs:84, 1259-1315` | As V1, plus `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`, optional temporal x2 upscaler, one extra LoRA slot (`SoundstageLTXLoRA`) | As V1, plus: half-size stage 1, latent x2, 3-step refine that continues the sigmas; guides re-applied at full size; optional temporal x2; one extra LoRA slot; codec settings. Output video without audio, frames 1:1 with the stage passes. | `tests/test_ltx_settings.py` (test_app_final_latent_switches_and_saves, test_builder_reproduces_the_committed_app), `tests/test_router_app.py:24-38` |
| **V3** Shot from Sound (audio-driven final) | `soundstage/nodes_audio.py:799-865`; `soundstage/audio/graphs.py:127-211`; weights `soundstage/audio/engines.py:18-32`; App `tools/app_build/audio.py:66-88` | LTX-2.5 + Layout-to-Render IC-LoRA (image/text-to-video branch when no control) | AUDIO in, encoded to an audio latent with a noise-mask strength (0 frozen, 0.3 lip sync, 1 regenerate). Optional audio reference tokens. Control video or first frame. Frames 8k+1 (rounded down), size multiple of 64. Returns video, frames and audio; soundtrack is the supplied mix or the model's own. | `tests/test_audio_graphs.py:163-183`, `tests/test_audio_app.py:29-61`, `tests/js/ltxvoice.test.mjs` |
| **V4** Recast engine: LTX-2.5 union control (default) | `soundstage/footage/graphs.py:18-27, 58-79, 181-240`; dispatch `soundstage/nodes_footage.py:269-312, 386-397, 433-443` | LTX-2.5 distilled + `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors`, x2 upscaler, DWPose | Plate frames + subject mask, turned into a pose guide (the union LoRA also takes depth or canny). First frame (the Krea recast) at strength 1. Original audio as reference tokens in the A/V latent. Exactly N frames back, index-aligned, at the plate's fps. Guide short side 544, multiple of 64. | `tests/test_footage_graphs.py:180-249`. `tests/test_footage_matte.py` skips without torch. `SoundstageRecast.execute` is untested. |
| **V5** Recast engine: local H3 character swap | `soundstage/footage/graphs.py:243-319`; `soundstage/nodes_footage.py:492-512` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors`, turbo LoRA + `h3_character_swap_v1.5.safetensors`, GPL `H3CharacterSwap*` nodes, SAM 3.1 | Video-to-video swap: source video with audio, character image, anchor image, subject prompt. The pack retimes to 24 fps and works in 124-frame windows. Two fixed LoRA slots. A licence gate (`SOUNDSTAGE_H3_LICENSED=1`). | `tests/test_footage_graphs.py:274-291` (graph shape only; the pack is not installed) |
| **V6** Recast engine: MiniMax H3 API reference-to-video | `soundstage/footage/graphs.py:322-342`; `soundstage/nodes_footage.py:469-490` | Partner node `MinimaxHailuo03ReferenceNode` ("MiniMax H3" or "MiniMax H3 Max") | Reference video + up to 2 images. Duration 4-15 whole seconds. Frames back through `GetVideoComponents`; the original audio is re-muxed. Partner opt-in and Comfy sign-in. The router's `minimax_h3` adapter (`soundstage/router/adapters.py:267-283`) has no reference-video mode. | `tests/test_footage_graphs.py:260-271` |
| **V7** ⑤ Motion › Pose follow | `soundstage/motion/graphs.py:30, 106-116`; `soundstage/nodes_motion.py:239-297` | FG `ltx_union_recast`: LTX-2.5 + union-control IC-LoRA | Pose video (stage skeletons, or DWPose on a clip) + a hard first frame. 8k+1 frames up to 481, fps, guide short side 544, multiple of 64. No audio. Draft or final. | `tests/test_motion_graphs.py:94-121`, `tests/js/posepass.test.mjs` |
| **V8** ⑤ Motion › Ripple edit | `soundstage/motion/graphs.py:23-103`; `soundstage/nodes_motion.py:181-234`; retime `soundstage/motion/timing.py:7-41` | LTX-2.5 + `LTX25_Ripple_v11.safetensors` (plain LoRA, strength 1.35) | First-frame edit propagation: source clip + edited frame 1. Retimed to 24 fps, 8k+1 up to 481. Short side 544 or 768, multiple of 32. LoRA strength 0-3. The clip keeps its own audio. | `tests/test_motion_graphs.py:52-92, 124-152`, `tests/js/ripple.test.mjs` |
| **V9** Real performance render | `soundstage/performance/graphs.py:17-120`; `soundstage/nodes_performance.py:223-291` | LTX-2.5 + union-control IC-LoRA (its own copy of the graph, not `ltx_union_recast`) | Pose guide + first frame + the actor's voice: audio latent at a 0.3 noise mask plus reference tokens, for lip sync. 8k+1 frames. Draft/Final/Hollywood sizes, multiples of 64. Returns frames and the fitted voice. | `tests/test_performance.py:52-117`, `tests/js/performance.test.mjs` |
| **V10** One-click › Camera › Reshoot | `soundstage/reshoot/graphs.py:14, 36-52`; `soundstage/reshoot/__init__.py:255-266`; route `soundstage/handoff/routes.py:222-266` | FG `ltx_union_recast` | Edge or depth guide video + the warped first frame. The plate's audio as reference tokens. 24 fps, 8k+1 between 9 and 161. | `tests/test_reshoot.py:128-149`, `tests/js/reshoot.test.mjs` |
| **V11** One-click › Loop (render and seam bridge) | `soundstage/loop/graphs.py:22-36, 68-158`; route `soundstage/handoff/routes.py:61-86, 127-145` | LTX-2.5 distilled (+ x2 upscaler for Final) | First AND last frame: the same picture for a loop, two pictures for the bridge. 24 fps, 8k+1, at least 17. Short side 544, multiple of 32, long side up to 1024. Generated sound (a silent bridge mutes the joined loop). The router's `ltx25_i2v` (`soundstage/router/adapters.py:597-624`) ignores `last`. | `tests/test_loop_graphs.py:41-101`, `tests/test_loop_fix.py`, `tests/test_mcp_loop.py`, `tests/js/loop.test.mjs` |
| **V12** Pitch Mode motion draft | `soundstage/agent/pitch.py:773-803`; model id at `soundstage/agent/director_routes.py:171` | Registry id `open.ltx_2_5`, used only to find files; the graph is built by hand | Image-to-video draft: 512x288, 49 frames, 24 fps, one fast pass, no audio. | `tests/test_pitch.py:122`, `tests/js/pitch.test.mjs` |
| **I1** ④ Frame "Krea 2 + depth · strict" | `example_workflows/Soundstage_App.json` nodes 9047-9057, switch 9082; UI `web/pipeline/pipeline.mjs:69, 843-858, 923-938` | `Krea-2-Turbo.safetensors` + `krea2/cn/depth-control-lora.safetensors` | img2img from the stage Color pass at a denoise, the depth pass as control, the still prompt. The router's `krea2` adapter already does this (`soundstage/router/adapters.py:424-470`). Opt-in: switch 9082 is on (router) by default. | `tests/test_router_app.py:24-38`, `tests/js/depthlock.test.mjs` |
| **I2** Recast frame-1 identity edit | `soundstage/footage/graphs.py:28-34, 149-176`; `soundstage/nodes_footage.py:417-431` | Krea 2 Turbo + `krea2_identity_edit` LoRA + comfyui-krea2edit nodes | edit_image with the frame + one character ref, returning one image. Two Krea knobs (likeness, hold_blocking) would become params. | `tests/test_footage_graphs.py:180-185` (krea case) |
| **I3** Pitch Mode sketch | `soundstage/agent/pitch.py:740-770`; `soundstage/agent/director_routes.py:171` | Registry id `open.flux3_klein`; `ReferenceMultiLatent` graph built by hand | edit_image of the stage capture: prompt, 1-16 steps, 0.1-0.3 MP. | `tests/test_pitch.py:122`, `tests/js/pitch.test.mjs` |
| **A1** SFX and music (text to audio), including the App's Shot Sound | `soundstage/audio/graphs.py:75-86, 253-256`; `soundstage/nodes_audio.py:401-474`; App pin `soundstage/nodes_audio.py:732, 736` | LTX-2.5 audio-only (engine key `ltx_t2a`). Any other SFX key is built as ElevenLabs SFX; music has no other builder. | Text + seconds + seed → AUDIO at least that long. SFX up to 30 s. Music up to 360 s on the node, but the LTX audio latent caps at about 40 s. The App passes `ltx_t2a` literally. | `tests/test_audio_graphs.py:139-147, 215`, `tests/test_audio_clip.py`, `tests/test_audio_app.py` |
| **A2** Video to audio (foley) | `soundstage/audio/graphs.py:91-106`; `soundstage/nodes_audio.py:417-427` | LTX-2.5 full model, video latent frozen | Frames + frame count + fps → AUDIO. Other engines are refused (`soundstage/nodes_audio.py:426-427`). | `tests/test_audio_graphs.py:149` |
| **A3** Dialogue (text to speech) | `soundstage/nodes_audio.py:333-364`; `soundstage/audio/tts.py`; `soundstage/audio/graphs.py:216-239` | Chatterbox in-process (key `chatterbox`); any other key is built as ElevenLabs TTS | Text + optional consent-gated voice reference + seed → waveform. Needs an in-process adapter kind (no graph). | `tests/test_audio_clip.py`, `tests/test_audio_graphs.py:196` |
| **A4** Voice change | `soundstage/nodes_audio.py:585-670`; `soundstage/audio/graphs.py:242-250`; `web/performance/performance.mjs:16-33` | Chatterbox VC; any other key is ElevenLabs STS. The Performance capture names `SoundstageChatterboxVC` directly. | Audio in → audio out of the same length (only Chatterbox enforces it). | `tests/test_voice_change_seed.py`, `tests/test_voice_convert.py`, `tests/js/performance.test.mjs` |

Notes:
- V4, V7 and V10 share one builder. V9 is a copy of it. Changing `FG.LTX_WEIGHTS["ic_lora"]` changes all four.
- V1 has no picker at all. Drafts stay LTX even when MiniMax H3 is the chosen engine (`web/pipeline/pipeline.mjs:1151`).
- V2's router picker (node 9083) exists, but the router's LTX adapter (`soundstage/router/adapters.py:627-656`) has fixed sigmas and none of the Quality knobs. Switching 9084 on with the same model changes the render.

### Routed, but pinned to one model by name

- Recast's Wan engine calls `R.find_model("open.wan_animate_2")` and `ADAPTERS["wan_animate2"]` directly (`soundstage/nodes_footage.py:449, 464`). It is not a bypass, and it is the pattern a registry-driven engine list could follow.
- App defaults: `STILL_DEFAULT` and `VIDEO_DEFAULT` (`tools/app_build/models.py:11-12`); the same labels in `soundstage/takecheck/readiness.py:26-27`.
- App regexes: `KLEIN` (`web/pipeline/pipeline.mjs:25`), `isKreaTurbo` (:54), `H3_KEY` (:86). Depth lock works only for Klein (`_kleinKey`, :980).
- OneClick: `/^FLUX 3 Klein/` and `/^Krea 2 Turbo/` (`web/oneclick/oneclick.mjs:180-181`), `/^LTX-2\.5/` (:726), `/Clean-Plate/`, `/^SAM 3/` and `/Alpha-Gen/` (`web/oneclick/effects.mjs:72, 94, 104`), and `web/oneclick/angle.mjs:98`, `light.mjs:103`, `expand.mjs:50`. A new model is never picked there.
- Cast reference generation sends the literal `"FLUX 3 Klein · local [<$5M]"` (`web/soundstage.js:3064`). It fails when Klein is missing, even if another image model is installed.
- Paint Studio fill defaults to `/^FLUX 3 Klein/` (`web/canvas/canvas.mjs:1618`). Any edit model can be picked.

### LTX rules that sit before any adapter

- **Frame counts.** 8k+1 is forced in the browser (`web/soundstage.js:1108`), the Advisor (`soundstage/cine/geometry.py:180-183`), the clip loaders (`soundstage/motion/timing.py:7-41`, `soundstage/footage/clip.py:8`), Reshoot (`soundstage/reshoot/__init__.py:37-41`) and OneClick (`web/oneclick/oneclick.mjs:683-688`). The rounding differs: nearest in `soundstage/router/adapters.py:68-70`, down in `soundstage/audio/graphs.py:24-27`, up on ties in `soundstage/loop/graphs.py:68-71`.
- **Sizes.** Stage passes are multiples of 64, commented as an LTX Layout-to-Render requirement (`web/stage/stage.mjs:166-177`).
- **Prompts.** The Look compiler writes LTX-2.x prose (`soundstage/look/compile.py`). The Advisor writes LTX and H3 prompts (`soundstage/cine/prompts.py:186-277`).
- **Quality layer.** Presets, sigmas and Adherence are LTX-distilled settings (`soundstage/ltx_settings.py`, `soundstage/quality.py`, `soundstage/nodes_quality.py:71-155`). An on-prompt hook rewrites `LTXAddVideoICLoRAGuide` strengths in every queued prompt (`soundstage/takecheck/routes.py:79-101`). For any other model it does nothing.
- **Weight lists.** LTX files are listed in 3 tables that already disagree. FG (`soundstage/footage/graphs.py:23`) tries `ltx-2.5-video-vae-conv-bf16.safetensors` first; `soundstage/router/build_registry.py:41` and `soundstage/audio/engines.py:25` do not list it.
- **Provenance.** Take recipes record a model only for router nodes (`soundstage/takecheck/recipe.py:122-148`). Takes from the paths above carry seeds but no model id.

## What is already routed

| Stage | Node | Wired | Open weights (default build) | Paid (opt-in) |
|---|---|---|---|---|
| generate_image | `SoundstageGenerateImage` | 13 | 3: Krea 2 Turbo, Z-Image Turbo, FLUX 3 Klein | 9 partner + 1 cloud |
| edit_image | `SoundstageEditImage` | 9 | 2: Krea 2 Turbo, FLUX 3 Klein | 7 partner |
| generate_video | `SoundstageGenerateVideo` | 15 | 3: LTX-2.5 22B distilled, MiniMax H3 (local), Wan Animate 2 distilled | 12 partner |
| matte | `SoundstageMatte` | 8 | 6: SAM 3.1, BiRefNet (core), LTX-2.5 Alpha-Gen, RMBG-2.0, BEN2, BiRefNet HR | 2 partner |
| clean_plate | `SoundstageCleanPlate` | 4 | 1: LTX-2.5 Clean-Plate IC-LoRA | 3 partner |

- 40 wired entries, 49 stage memberships (all 9 edit_image models also serve generate_image). 13 are open weights (10 local, 3 custom_node). 27 are paid (26 partner, 1 cloud), hidden unless `SOUNDSTAGE_PARTNER_MODELS=1`.
- 30 adapter functions serve them (`soundstage/router/adapters.py:955-969`). One adapter can serve several entries through `variant`.
- 237 more entries are catalogue rows with `adapter: null`. They never appear in a dropdown. 109 of them are video models.
- A model is listed only when its node classes are loaded and its weight files are found (`soundstage/router/registry.py:93-108`). The first available entry of a stage is its default (`soundstage/router/build_registry.py:74`).
- Paint Studio fill (`SoundstageFill`, `soundstage/nodes_fill.py:171-226`) uses the edit_image list.

## Step 2 (not in this PR)

- Move each path in the table behind the router. Each one calls an adapter chosen from the registry, the way Recast's Wan engine already does (`soundstage/nodes_footage.py:446-467`).
- Add capability fields to registry entries, and check them before a model is offered for a path. For example: `needs_audio` (audio in or out), `control` = pose | depth | canny | layout, first/last frame and refs, `max_seconds`, the frame rule (8k+1, 17k+5), fps and size multiple. Today none of this is structured. It lives in adapter code and free-text notes.
- Some paths need contract or stage additions, not only flags:
  - generate_video needs an AUDIO input, a draft/final tier, LoRA slots and a reference strength (V1-V3, V9).
  - Recast, Ripple and H3 reference-to-video need a video-to-video input: source frames and a mask (V4-V6, V8).
  - Audio needs stages (dialogue, voice change, SFX, music) and an adapter kind for in-process engines like Chatterbox (A1-A4).
- LTX-2.5 stays the default everywhere. Registry order already makes it the first video model, and tests pin it (`tests/test_router_registry.py:74, 103`, `tests/test_router_h3.py:45-60`).
- Each stage gets a Model dropdown. Models that lack a capability the stage needs are greyed out, with the reason.
- Tests show outputs unchanged with the default: for each moved path, the graph built through the router with the default model matches today's graph, node for node.
- Registry fields (`default`, `recommended`, capability tags) replace the label strings, so the App and OneClick read the registry instead of matching names.
- One LTX weight table and one 8k+1 helper.

### Utilities that stay unrouted

These read, measure or reason. They do not make the image, video or sound the user keeps, and the App depends on their exact output format. A picker would add nothing.

| Utility | Where | Why it stays direct |
|---|---|---|
| Local LLM (Qwen3.5 4B, or Ollama) | `soundstage/agent/prompts.py:12`, `soundstage/routes.py:14`, `soundstage/cine/llm.py` | Text and JSON for the Director, scene agent, Book and Advisor. The model name is defined twice; keep one. |
| Vision readers (Qwen3-VL) | `soundstage/video2stage/vlm.py:14-16`, `soundstage/floorplan/vlm.py`, `soundstage/takecheck/realism.py` | The prompts assume Qwen-VL's 0-1000 box grid. Three model lists; merge them. |
| Whisper | `soundstage/agent/whisper.py:18`, `soundstage/audio/qc.py` | Transcription for the Director and audio QC. |
| AST audio classifier | `soundstage/audio/qc.py:21-22` | QC checks are written in AudioSet labels. |
| SAM 3.1 tracking | `soundstage/footage/graphs.py:84-111`, `soundstage/layerpack/final_mattes.py:129-144` | Per-person tracks and in-process tensors. The router's matte stage returns one union mask. |
| BiRefNet / RMBG cutouts | `soundstage/layerpack/final_mattes.py:113-127`, `web/assets3d/maker.mjs:30-37` | Edge alpha for the Layer Pack and 3D cutouts. Could reuse the matte adapters later. |
| Depth Anything 3 | `soundstage/video2stage/graphs.py:5-21`, `soundstage/reshoot/graphs.py:21-28` | Measures depth and cameras for Video → Stage and Reshoot. |
| DWPose | `soundstage/footage/graphs.py:124-146`, `soundstage/performance/graphs.py:41-50` | Makes the pose video that video models consume. It feeds `control=pose`; it is not a model choice. |
| SAM 3D Body | `web/stage/mocapcapture.mjs:7`, `soundstage/video2stage/performer.py` | Motion capture onto the clay actors. |
| YuNet face detector | `soundstage/takecheck/detect.py:272-301` | Take checks. |

TripoSplat image-to-3D (`web/assets3d/maker.mjs:30-37`, `soundstage/assets3d/routes.py:16-34`) is generation, but not image, video or audio. It needs a 3D stage before it can be routed.

## Found while auditing (read in code, not fixed)

1. In the App, Shot from Sound takes `first_frame` from the Krea 2 still (node 9057, `tools/app_build/audio.py:81`). Only the "LTX speaks the line" path rewires it to the chosen frame (`web/pipeline/pipeline.mjs:1405-1412`, called only at :1435). With "A saved voice", the audio-driven final may start from the Krea still. Not run.
2. `soundstage/router/registry.py:25, 28` opens `registry.json` without `encoding=`. Under cp1252 the LTX `mode` options load as `image/text â†’ video` and `layout â†’ render` (checked), so an explicit "layout → render" choice would fall back to image-to-video in `ltx25()` (`soundstage/router/adapters.py:588-594`). "auto", the App default, is unaffected.
3. `docs/router.md` has drifted from `build_registry.WIRED`: regenerating it changes 4 rows. No test checks that WIRED, `registry.json` and `docs/router.md` agree.
4. `tools/install_runpod.sh` does not download FLUX 3 Klein, though it is the App's default still model.
5. Video-to-audio passes no source size (`soundstage/nodes_audio.py:421`), so every clip is resized to 960x544 with a centre crop (`soundstage/audio/graphs.py:94-96`).
6. Loop and Reshoot refuse to run in Draft when the x2 upscaler is missing, though Draft never loads it (`soundstage/handoff/routes.py:72-75`, `soundstage/reshoot/__init__.py:255-258`).
