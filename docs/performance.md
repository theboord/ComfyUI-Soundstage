# Real performances: body, face and voice

Select a person on the stage. In the Motion capture row, next to **Act it out**, there is a new button,
**Real performance…**. It lets a real actor's performance drive that character: their timing, expressions and lip sync
all come across. The result should look like a person acting, not a puppet.

Files:
- `soundstage/nodes_performance.py` (the nodes);
- `soundstage/performance/asset.py` (the asset, consent, mouth curve and fit math) and `soundstage/performance/graphs.py`
  (the expansions);
- `web/performance/performance.mjs` (the dialog), connected by one hook in `web/soundstage.js`;
- tests: `tests/test_performance.py` and `tests/js/performance.test.mjs`.

## Workflow

1. **Bring in the actor.** You have three options:
   - **● Record** uses your webcam and microphone (3-2-1 countdown, up to 10 s).
   - On a phone, film the actor and use **Import a clip…**. Frame them chest-up for dialogue, or head to toe for action.
   - Tick **Also drive the clay body** to run SAM 3D Body as well, as the existing Motion capture does.
2. **Consent.** Tick the box and name the performer. The capture is refused without both, the same rule as
   [Character voices](audio.md#character-voices-and-consent). The asset stores who performed, the consent statement
   and the date, and a render refuses an asset that has no consent record. Only use your own performance or one you
   have the rights to. Never use a third party's likeness or voice without their agreement.
3. **Read the performance.** DWPose reads the body (18 points), both hands (21 points each) and the face (68 landmarks
   plus the pupils) on every frame. The voice is kept. The dialog then shows:
   - the skeleton and face drawn over the actor, with sound;
   - a mouth-open curve;
   - a summary, for example "4.0 s · face read on 98% of frames · voice kept · 14 mouth openings".
4. **Apply to shot.** The performance is stored on the character, and on the shot along with where the character
   stands in the shot camera. Then use **Draft**, **Final** or **Hollywood**, and the render lands in Takes.
5. **Keep the real footage (Ripple)** is the other path. It hands the clip to ⑤ Motion → Ripple edit as the shot's
   imported clip: edit frame 1 (new wardrobe, a relight, a set) and Ripple keeps everything else from the real take.
   Choose it when the actor *is* the character.

The assets are saved to `output/soundstage_private/performances/<id>/`:
- `asset.json`;
- `pose.mp4`, the skeleton with the voice;
- `overlay.mp4`;
- `voice.wav`;
- `face.json`, the face landmarks and mouth value per frame.

Recorded clips go to `input/soundstage_private/performances/`.

## The render: `SoundstagePerformance`

This node is Mike's tested union-control graph (`LTX-2.5_ICLoRA_UnionControl_SAM3_DWPose_OGaudioSampler-boord.json`,
the same one Recast rebuilds). Here the guide is the actor's performance, and the graph adds the lip-sync fix:

| Part | Setting |
|---|---|
| Model | LTX-2.5 22B distilled int8 + `ltx-2.3-22b-ic-lora-union-control-ref0.5` (strength 1) |
| Guide | the actor's DWPose (body + hands + **face**). `SoundstagePoseFit` scales and moves it so the actor's box sits on the character's box in the shot (same height, centre and top). |
| First frame | the shot's frame (stage layout, camera, the character in costume), `LTXVImgToVideoInplace` in both stages |
| Voice in the sampler | `VAEEncodeAudio` → `LTXVSetAudioRefTokens` (raw latent), plus the same latent with a **0.3 noise mask** (`SoundstageLatentNoiseMask`) as the audio half of the AV latent, in **both** stages |
| Sampling | stage 1: 8-step distilled (euler_ancestral); stage 2: ×2 latent upsampler + 3 steps (euler), CFG 1 |
| Quality | Draft 544p in one pass · Final 544p + ×2 · Hollywood 704p + ×2 |
| Output voice | the actor's own recording, untouched |

Why the mask matters: Mike's OG-audio graph feeds the audio latent frozen (noise mask 0). Measured on 2026-10-28,
frozen audio made mouths flap with no relation to the speech (r = −0.05), while a 0.3 mask gave r = 0.37–0.48 and the
mouth shut when the line ended. The node keeps this as an advanced setting, `audio_mask`.

Also advanced: `layout`, a stage pass video (clay or depth) screened faintly under the skeleton (`layout_mix`). It is
off by default and **untested**. The union LoRA was trained on one control at a time.

### Models on the pod

Nothing was downloaded. Every file is already on the pod:
- `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot`, Gemma 4 12B int8, the 2.5 video and audio VAEs, and the
  2.5 latent ×2 upscaler;
- `ltx-2.3-22b-ic-lora-union-control-ref0.5` (in `loras/ltxv/ltx2/`);
- DWPose: `dw-ll_ucoco_384_bs5.torchscript.pt` and `yolox_l.onnx`.

**What's missing for Mike:**
- **No union-control IC-LoRA for LTX-2.5 exists on the pod.** The 2.5 IC-LoRAs on the pod are layout-to-render,
  alpha-gen and clean-plate. The 2.3 union LoRA is what Mike's graph uses, and he confirmed it is correct for the 22B
  line.
- If Lightricks publishes a 2.5 union or pose IC-LoRA, add it to `FG.LTX_WEIGHTS["ic_lora"]` ahead of the 2.3 name.
- Optional, for the live face mesh only: mediapipe and insightface are installed in the Soundstage venv, but their
  face-mesh model files were not checked. DWPose's 68 landmarks are what the union LoRA understands, so they are the
  guide.

## 4D Gaussian splats vs SAM 3D + union control

What is installed:
- **ComfyUI-SplatKit** (mickmumpitz) is in the main ComfyUI (`/workspace/runpod-slim`), not in Soundstage's. It includes
  a **4DAnyone** front end (Ant Research): Generate Views → Export Frameset → Train Sequence. It turns a video of one
  person into a sequence of per-frame Gaussian splats.
- On this pod it is **not runnable**:
  - its isolated backend (Python 3.11, torch 2.8, gsplat 1.4) has an installer for **Windows only**, and its docs say
    Linux setup is unsupported;
  - **none** of its models are on the pod: the 4DAnyone checkpoint, the Wan 2.2 VAE, the prompt context, BiRefNet and
    VGG-19, about 19 GB;
  - `gsplat`, `diff_gaussian_rasterization` and `pycolmap` are not installed in either venv.
- The SplatKit panorama branch makes **3DGS training datasets** from a 360° panorama. These are static scenes, not 4D.
- Mike's earlier pipeline only *views* splats (`spark.module`).

How the two approaches compare:

| | Monocular 4DGS (4DAnyone) | SAM 3D Body + DWPose face + union control (this milestone) |
|---|---|---|
| Input | one clip of one person who stays roughly in place | any phone or webcam clip, with the voice |
| Output | a splat sequence of the actor: re-angle and orbit them | a rendered shot of *your character* acting the performance on your set |
| Face and lips | splats of a hallucinated multi-view face; mouth detail is soft and has no audio coupling | 68 face landmarks drive the video model, and the voice drives the lips in the sampler |
| Editing existing footage | can re-angle the person, but the background is lost (person only), and the novel views are invented by a Wan-5B generator, so they are the least "real" part | Ripple keeps the real footage and edits it; Performance moves the take onto any character or set |
| Multi-camera | single-camera views are hallucinated; real multi-camera capture would be needed for trustworthy angles | not needed: the stage camera is free, and LTX renders the new angle from the shot frame |
| Effort here | Linux backend port, ~19 GB download, about 24 GB VRAM per generation, then training per frame range | built on models already on the pod |

**Recommendation: don't build 4DGS now.** It isn't cheap with what is installed: no models, no Linux backend, no
gsplat. It also solves a different problem: viewing the *same* actor from new angles, not making a character act.
For "a real performance, not AI-looking", SAM 3D Body for the body and the stage path, DWPose face plus voice for the
expression and lips, and union control on LTX-2.5 is the right path. Revisit 4DGS if Mike shoots **multi-camera**
(three or more synced phones). Then a real (non-hallucinated) 4D capture of the actor becomes a strong re-angle and
VFX tool.

## Tested

The results are in `share/Milestone25_Performance/`, with the numbers in `RESULTS.md`. The test performance was a
4 s talking head that Soundstage generated (no real person), and the character was a different man.

| | Draft | Hollywood |
|---|---|---|
| mouth-open correlation with the actor (DWPose) | 0.86 | **0.92** |
| lag | 0 frames | 0 frames |
| onsets vs the actor | within ±1 frame | within ±1 frame |

Expressions landed on the same frames: the O-mouth "wow", the brow lift, the smile. Timings on the RTX 6000 Ada were:
capture 4 min, Draft 9 min, Hollywood 14 min.

Not yet tested on GPU:
- fitting the actor onto a clay character elsewhere in the frame (unit-tested only);
- `layout_mix`;
- a long dialogue take from a real actor.
