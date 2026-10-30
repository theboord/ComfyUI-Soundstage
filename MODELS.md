# Models

The Soundstage App (`example_workflows/Soundstage_App.json`) needs the models below. Folder paths are relative to `ComfyUI/models/`. `tools/install_runpod.sh` downloads them. Some repos are gated: accept the license on Hugging Face first, then `huggingface-cli login`.

Rung 1 (Stage) needs no models at all. Rung 2 (Look still) needs the Krea 2 group. Rungs 3–4 (Draft, Final) need the LTX-2.5 group. Rung 5 (Layers) needs SAM 3.1 and BiRefNet (below) to cut mattes from the final frames; without them it falls back to the stage's own mattes.

## Look still: Krea 2 Turbo, depth-steered

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
