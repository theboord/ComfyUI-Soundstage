# Models

The Soundstage App (`example_workflows/Soundstage_App.json`) needs the models below. Folder paths are relative to `ComfyUI/models/`. `tools/install_runpod.sh` downloads them. Some repos are gated: accept the license on Hugging Face first, then `huggingface-cli login`.

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

If the LTX API key field is left blank, the prompt is encoded locally with Gemma. That is the default, and it is free.

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
| Audio: TTS, clone, voice change | Chatterbox (MIT), installed by its own node pack. ElevenLabs runs through ComfyUI partner nodes and needs a Comfy API key. | see `docs/audio.md` |
| Recast (video-to-video swap) | see `docs/recast.md` | |
| Model router | 293 image/video/audio models, open and API. Each entry carries its own license badge. | see `docs/router.md` |

**Hardware.** Tested on an NVIDIA RTX 6000 Ada (48 GB). We recommend 48 GB. 24 GB cards need offloading and are untested. The stage, Look tab, Cut tab and exports run in the browser on any machine.
