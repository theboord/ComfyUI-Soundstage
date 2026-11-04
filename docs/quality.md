# Quality: presets, Advanced (LTX), motion freedom

## Presets: Draft · Final · Advanced (Milestone 18, reworked 2026-11-04)

⑤ Motion's **Quality** buttons pick how the shot renders. The choice is saved **per shot** (Stage node property `ss_ltx`).
New shots start on **Final**. Before Milestone 18 the buttons started on Draft and were not restored when a shot was
reopened, so nearly every "final" was really rendered at Draft sampling (every final from 2026-10-30/31 carries
`quality: "Draft"` in its metadata).

| Preset | Output (from the 960×512 clay) | Stage 1 → stage 2 | Steps | Codec | Time, 121 frames, RTX 6000 Ada |
|---|---|---|---|---|---|
| Draft | 1984×1088 | 992×544 → latent x2 → refine | 8 + 3 | H.264 CRF 18 | about 6–7 min |
| **Final** (default) | 1984×1088 | 992×544 → latent x2 → refine | 12 + 6 | H.264 CRF 14 | about 8–9 min |
| **Advanced** | yours | yours | yours | yours | shown under the buttons |

**Advanced** is the third button: it starts from Final's numbers and every knob is the user's. Editing a quality knob
(resolution, two-stage, steps, stage-2 start, sigmas, sampler, scheduler, shift, CFG, frame rate, temporal x2, decode
tiles, codec, CRF) on a Draft or Final shot turns it into Advanced with the rest of that preset carried over, so the
picture only changes by what was edited; **Reset to Draft / Final** goes back. The seed (the take), Adherence and its
raw knobs (the blocking) and the LoRA stack (add-ons) are their own controls and never move a shot off its preset.

The retired **Hollywood** preset (1408p: stage 1 at 1312×704 → latent x2 → refine at 2624×1408, 12 + 6 steps, CRF 12,
about 15–17 min) was the best recipe measured on this GPU (share/Milestone18_Hollywood/REPORT.txt): the larger stage-1
canvas gives LTX more latent pixels for the car, the face and the background, so it keeps the subject coherent through
fast motion. Its numbers live on in `ltx_presets.json` under `legacy`: a shot saved on it loads as Advanced with those
values (both `ltx_settings.resolve` and `resolveSettings` map it; the Quality node's combo keeps the value for saved
workflows), and the **Hero final** preset recipe sets the same (`LtxStore.setHero`).

**Advanced (LTX)** (the pop-over the Advanced button opens; also the button beside Quality) holds: output resolution,
two-stage on/off, frame rate (the clay is retimed) and the frame count it gives, temporal x2 (LTX-2.5 temporal
upscaler, twice the frames), steps for each stage (stage 1 down to 1: below 8 the distilled curve's nine knots are
thinned evenly, untested on the GPU, meant for rough drafts), the **scheduler** (`distilled`, Lightricks' tuned
knots, what Draft and Final use bit for bit; `linear`, even steps, what LTXVScheduler starts from; `linear_quadratic`,
LTX's paper schedule: tiny steps near 1.0, quadratic growth toward 0), the sigma **shift** (the same curve as
ModelSamplingLTXV / LTXVScheduler's shift, s' = shift·s / (1 + (shift−1)·s); 1 = as tuned, above 1 keeps more steps at
high noise for composition and motion, below 1 spends them on detail; stage 2 keeps its start sigma and shifts the
steps below it), the stage-2 start sigma (0.909 or Lightricks' 0.85), manual sigma schedules (they override steps,
scheduler and shift), sampler, CFG, seed (the same seed drives both stages), the layout IC-LoRA strength (empty =
from Adherence), the LoRA stack, the VAE decode tiles, and the codec (H.264 at a CRF, or a **ProRes 422 HQ** master
`.mov` beside an H.264 preview). The graph samples on `ManualSigmas` strings from the Quality node, so shift and the
scheduler are applied to those strings in `ltx_settings.schedules` rather than through a scheduler node; the
tooltips say so. STG and CFG rescale are not offered: they need the non-distilled LTX-2.5 dev transformer, which is
not installed (MODELS.md lists it for approval).

How it is wired: the App writes the shot's `{preset, ...overrides}` into the Quality node's `advanced` widget.
`soundstage/ltx_settings.py` resolves it (presets from `web/motion/ltx_presets.json`, the same file the pop-over
reads), and the Quality node outputs the stage-1-sized guide (its size sets the latent), the sigma schedules, CFG,
seed, frame rates, decode tiles and a `settings_json` that the two switches (one pass / two-stage, temporal x2), the
Extra LTX LoRA node and **Soundstage · Save Final** read. Built by `tools/app_build/ltx_advanced.py`.

**LoRA stack.** ⑤ Motion › Advanced (LTX) has **＋ Add LoRA** rows (a LoRA, a strength from -2 to 2, ✕), saved with the shot in
`ss_ltx` as `loras` and applied in order on the LTX model by the *Extra LTX LoRAs* node (9101). Every LoRA in the folder is
listed, LTX ones first, the rest marked as possibly not working with LTX; a file whose own header says it is for another
model stops the render with a sentence before any row is applied. A shot saved with the old single `extra_lora` opens as
a one-row stack. The Layout IC-LoRA (Adherence) is loaded separately and is not in the stack. ④ Frame has the same stack
for the image model (`loras` on the frame node; the old single add-on is a one-row stack), plus sampler, scheduler and
sigma shift beside steps and CFG.

**Older saved App workflows** keep their old graph: open the Soundstage App template again to get the new wiring.

## Motion freedom and the older tiers

LTX-2.5 Layout-to-Render follows the clay previz through an IC-LoRA guide. At full strength it copies everything, including stiff previz physics: a horse that slides instead of galloping, or a rider glued to the saddle. Two App controls trade layout fidelity for natural motion and quality:

- **Motion freedom** (0–1).
  - At 0 the blocking is followed exactly, as before.
  - Higher values loosen and soften the clay guide. LTX keeps the composition, camera path and blocking (the low spatial frequencies) but redraws gait, limbs and weight (the high ones).
- **Quality: Draft | Final HQ.**
  - Draft is today's sampling.
  - HQ uses denser sampling plus physical-motion language for the cast in the prompt.

## Files

| Path | What it is |
|---|---|
| `soundstage/quality.py` | `knobs(freedom, hq)` → the engine values; `motion_prompt(scene)` → subject-aware physical-motion text |
| `soundstage/nodes_quality.py` | `SoundstageQuality` node. Inputs: freedom, quality, clay guide, Look motion prompt, scene JSON. Outputs: softened guide, guide strengths, sigmas, prompt |
| `tools/app_build/quality.py` | App part: wires the node in and promotes four inner widgets to subgraph inputs |
| `tests/test_quality.py` | 0 + Draft == today's App; monotonic loosening; HQ schedules; prompt; wiring |

**Integrator:** add `"nodes_quality"` to the module list in `SoundstageExtension.get_node_list()`. "quality" is already in `tools/app_build/build.py` PARTS, before "outputs".

## Mapping (`knobs`)

| | f = 0 (today) | f = 0.4 | f = 0.7 | f = 1 |
|---|---|---|---|---|
| IC-LoRA guide strength, stage 1 and stage 2 | 1.0 | 1.0 | 1.0 | 1.0 |
| Gaussian blur on the clay guide (px at 960×544) | 0 (tensor passed through) | 8 | 12 | 16 |
| IC-LoRA model strength (Load Models "lora strength") | 1.0 | 0.86 | 0.76 | 0.65 |

**The guide strength must stay at 1.0.** This was tested live on the horse scene on 2026-10-28:
- With the first mapping (f = 0.4, guide strength 0.8 / 0.72), LTX rendered the grey clay mannequins themselves. Below 1, `LTXAddVideoICLoRAGuide` blends the guide tokens into the generation instead of treating them as a reference.
- A blurred guide at strength 1.0 (5 px) stayed fully photoreal, with the same composition and camera.

- IC-LoRA strength 0.75 (no blur) also stayed photoreal with the same camera, and it changed the *performance*: the riders walked naturally to the horses instead of copying the clay rig's stiff run.

So freedom now softens the guide content and lowers the LoRA strength a little. The blur removes the clay's limb and silhouette detail (what LTX copies too literally) but keeps where things are and where the camera looks.

HQ sampling: the same distilled sigma curve with midpoints inserted where the schedule takes its big jumps. Stage 1 runs 11 steps instead of 8; stage 2 runs 6 instead of 3. The sampler stays euler_ancestral.

## What the pod allows (checked 2026-10-28)

- **Only the distilled int8 transformer** (`ltx-2.5-22b-distilled-transformer-comfy-int8-convrot`) is installed.
  - The distilled model runs at CFG 1, so CFG/STG are not usable levers.
  - Lightricks' full-model quality recipe is CFG 3.0, STG on block 28, rescale 0.7, plus `ltx-2.5-22b-distilled-lora-450` at about 0.5 as a stabilizer (that LoRA is on the pod). It needs the full LTX-2.5 dev transformer, a ~44 GB download not yet approved.
  - HQ should switch to that recipe once the model is on the pod.
- **Upscale:** stage 2 already outputs 1920×1088.
  - SeedVR2 7B weights are on the volume, but the SeedVR2 node pack isn't installed in the live ComfyUI. The FlashVSR folder is empty.
  - A 4K pass needs that node pack plus a restart. It isn't wired yet, because a missing node type stops the whole App from queueing.

## Motion prompt (HQ)

The motion prompt is built from the scene's actors (`kind`, speed from their keys, `mount_id`) and appended to the Look's motion prompt. Identical subjects are grouped. Example, horse scene:

> Physical motion: each horse gallops with a true four-beat gait, legs reaching and folding, neck and head pumping with each stride, mane and tail streaming, hooves throwing up dirt; both riders ride their horses: hips following the saddle, torso rising and falling with the stride, reins in hand, balanced and loose; motion has real mass and momentum, with follow-through and secondary motion; no sliding feet, no floating, solid contact with the ground.

## Test results

See the session report: timings, contact sheets and clip paths for the horse scene at f = 0 / 0.4 / 0.7, Draft vs HQ.
