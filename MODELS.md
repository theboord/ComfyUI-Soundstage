# Models

**100% open weights: every model runs locally.** Everything below is a weight file on your own GPU; no paid API is used by default.

The Soundstage App (`example_workflows/Soundstage_App.json`) needs the models below. Folder paths are relative to `ComfyUI/models/`. `tools/install_runpod.sh` downloads them. Some repos are gated: accept the license on Hugging Face first, then `huggingface-cli login`.

**Other builds are fine.** If you already have a model as a different build (bf16, fp8, int8-convrot) or in a subfolder (`loras/ltx2.5/…`), keep it: when a Soundstage workflow loads, each model loader that names a file you don't have is pointed at your build of the same model, and a small notice says so ("Using ltx-2.5-…int8-convrot (you don't have the bf16 file)"). If you have no build of it at all, the notice names the missing file and links here.

Rung 1 (Stage) needs no models at all. Rung 2 (Look still) needs the Krea 2 group. Rungs 3–4 (Draft, Final) need the LTX-2.5 group. Rung 5 (Layers) needs SAM 3.1 and BiRefNet (below) to cut mattes from the final frames; without them it falls back to the stage's own mattes.

## First frame, cast sheets and Paint Studio: FLUX 3 Klein (default)

The App's default image model: the ④ Frame first frame (with up to 4 cast references), ② Cast & Locations sheets, and Paint Studio's Generative Fill. Distilled: CFG 1, 20 steps by default.

| File | Folder | Source | License |
|---|---|---|---|
| `flux3-image-klein-int8-convrot.safetensors` | `diffusion_models/` | FLUX 3 Klein from [Black Forest Labs](https://huggingface.co/black-forest-labs) (int8 repackage) | FLUX Kommunity License: free non-commercial; commercial use of outputs OK below $5M annual revenue |
| `qwen3vl_4b_int8_convrot.safetensors` (or `qwen3vl_4b_fp8_scaled.safetensors`, shared with Krea 2) | `text_encoders/` | Qwen3-VL 4B text encoder | Apache-2.0 |
| `flux2-vae.safetensors` | `vae/` | [Black Forest Labs](https://huggingface.co/black-forest-labs) FLUX.2 VAE | Apache-2.0 |

## Look still, alternative: Krea 2 Turbo, depth-steered

| File | Folder | Source | License |
|---|---|---|---|
| `Krea-2-Turbo.safetensors` (or Comfy-Org's `krea2_turbo_fp8_scaled.safetensors`) | `diffusion_models/` | [krea/Krea-2-Turbo](https://huggingface.co/krea/Krea-2-Turbo) · [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2) | Krea 2 Community License (commercial use only below $1M company revenue) |
| `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) | Apache-2.0 |
| `qwen_image_vae.safetensors` | `vae/` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors) | Apache-2.0 |
| `krea2/cn/depth-control-lora.safetensors` | `loras/` | [Patil/Krea-2-depth-controlnet](https://huggingface.co/Patil/Krea-2-depth-controlnet) | see the repo |

## Motion: LTX-2.5 Layout-to-Render (IC-LoRA)

| File | Folder | Source | License |
|---|---|---|---|
| `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `diffusion_models/` | [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) | LTX-2 Community License (free, including commercial use, below $10M annual revenue) |
| `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `text_encoders/` | Lightricks/LTX-2.5 | Gemma terms + LTX-2 Community License |
| `ltx-2.5-video-vae-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors` | `vae/` | Lightricks/LTX-2.5 | LTX-2 Community License |
| `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `latent_upscale_models/` | Lightricks/LTX-2.5 | LTX-2 Community License |
| `ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors` | `loras/` | [Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render) | LTX-2 Community License |

Leave the LTX API key field blank (the default): the prompt is then encoded locally with Gemma, free and fully open.

The temporal upscaler (`ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors`, `latent_upscale_models/`, same repo) is used only when **Temporal x2** is on in ⑤ Motion › Advanced (LTX).

### Not installed yet: what would lift the Hollywood preset further (download only with approval)

Measured in share/Milestone18_Hollywood/REPORT.txt. None of these are downloaded by Soundstage; each needs the owner's OK.

| File | Repo · folder | Size | License | Expected gain |
|---|---|---|---|---|
| `ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors` | [Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details) · `loras/ltx2.5/` | 1.31 GB | LTX-2.x Community License (gated) | Lightricks' own detail refiner for 2.5 (their Tiled Fusion upscale workflow uses it): a detail pass on the final, and the way to a 4K Tiled Fusion master. The biggest expected gain for texture and skin. |
| `ltx-2.5-22b-distilled-transformer-bf16.safetensors` | [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) · `diffusion_models/` | 42.0 GB | LTX-2.x Community License | The same distilled model without int8 quantization: finer detail and fewer banding/mush artifacts. On 48 GB it runs with partial offload (slower). |
| `ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors` | Lightricks/LTX-2.5 · `diffusion_models/` | 21.5 GB | LTX-2.x Community License | The non-distilled model: real CFG 2.5–3 with working negative prompts, STG and rescale, used with the `distilled-lora-450` already on the pod as a stabilizer. Better prompt adherence, slower (CFG doubles each step). |

## Motion, optional second engine: MiniMax H3

LTX-2.5 Layout-to-Render stays the default. With these files installed, **MiniMax H3 (local, looser blocking, rich motion)** also appears in ③ Motion's **Video model** list. H3 animates the shot and makes its own sound in the same pass. It follows your clay blocking only loosely, and a final takes about 20+ minutes on a 48 GB card (the first run also spends several minutes encoding the prompt on the CPU). Drafts still preview with LTX. Shots are capped at 362 frames (~15 s).

- **First frame, or first + last frame**: the shot's chosen frame (and its chosen last frame, when it has one) drive the fl2va model.
- **References**: add character or prop sheets to the shot in the H3 panel (up to 7; H3 takes 9 pictures with the first and last frame). They switch the shot to the ref2va model, addressed as `<Picture 2>`, `<Picture 3>`… in the prompt Soundstage writes for you.
- **Clay as motion reference**: turn on **Use the clay as a motion reference** to pass the previz as `<Video 1>` (ref2va; slower, closer blocking).

| File | Folder | Source | License |
|---|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (or `minimax_h3_fl2va_bf16`) | `diffusion_models/` | int8 repackage of [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3); bf16 in [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | MiniMax H3 Community License |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` (only for the clay reference) | `diffusion_models/` | as above | MiniMax H3 Community License |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (or `_bf16`) | `text_encoders/` | as above | MiniMax H3 Community License |
| `minimax_h3_video_vae_fp16.safetensors`, `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | Comfy-Org/MiniMax-H3 | MiniMax H3 Community License |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` (optional, 8 steps instead of 20) | `loras/` (any subfolder) | community turbo LoRA for H3 fl2v | see its model card |

The 32B text encoder is loaded on the CPU so it fits next to the video model on a 48 GB card. **License:** the MiniMax H3 Community License excludes the USA, EU, UK and South Korea, caps commercial use elsewhere at $20M annual revenue, and asks commercial products to show "MiniMax H3". In excluded regions you need MiniMax's commercial license (Comfy resells one). The Router labels it `[<$20M GEO]`.

## Layers: mattes from the final frames

| File | Folder | Source | License |
|---|---|---|---|
| `sam3.1_multiplex_fp16.safetensors` | `checkpoints/` | [Comfy-Org SAM 3.1 repackage](https://huggingface.co/Comfy-Org) of [facebook/sam3](https://huggingface.co/facebook/sam3) | SAM License (Meta) |
| `birefnet.safetensors` | `background_removal/` | ComfyUI core Remove Background ([BiRefNet](https://github.com/ZhengPeng7/BiRefNet)) | MIT |

## Optional

| Feature | File | Source |
|---|---|---|
| Object designer: type any object | `text_encoders/qwen3.5_4b_bf16.safetensors` | [Comfy-Org/Qwen3.5](https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_4b_bf16.safetensors) (Apache-2.0) |
| Scene agent | Uses the same Qwen3.5 file. Without it, the agent builds from its rules instead. | |
| Director: talk to the set (docs/director.md) | Uses the same Qwen3.5 file (or an Ollama model on your computer). Without one it plans from its rules. | |
| Director voice, offline | `whisper/whisper-base/` (the Hugging Face folder: config.json, model.safetensors, tokenizer and preprocessor files, about 290 MB) | [openai/whisper-base](https://huggingface.co/openai/whisper-base) (MIT). Without it, the browser's own speech recognition still works. |
| Audio: TTS, clone, voice change | Chatterbox (MIT), installed by its own node pack. | see `docs/audio.md` |
| Recast (video-to-video swap) | see `docs/recast.md` | |
| Model router | Every open-weights image/video/audio model whose files are installed. Each entry carries its own license badge. | see `docs/router.md` |

Opt-in footnote: Partner API models (ElevenLabs, Kling, Veo, Nano Banana and the like, through ComfyUI partner nodes and your Comfy credits) are hidden by default. To list them anyway, start ComfyUI with `SOUNDSTAGE_PARTNER_MODELS=1`. A saved workflow that still names one loads fine and says so when it runs.

**Hardware.** Tested on an NVIDIA RTX 6000 Ada (48 GB). We recommend 48 GB. 24 GB cards need offloading and are untested. The stage, Look tab, Cut tab and exports run in the browser on any machine.
