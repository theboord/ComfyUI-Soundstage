# Models

**100% open weights: every model runs locally.** Everything below is a weight file on your own GPU; no paid API is used by default.

The Soundstage App (`example_workflows/Soundstage_App.json`) needs the models below. Folder paths are relative to `ComfyUI/models/`. `tools/install_runpod.sh` downloads them. Some repos are gated: accept the license on Hugging Face first, then `huggingface-cli login`.

**Other builds are fine.** If you already have a model as a different build (bf16, fp8, int8-convrot) or in a subfolder (`loras/ltx2.5/…`), keep it: when a Soundstage workflow loads, each model loader that names a file you don't have is pointed at your build of the same model, and a small notice says so ("Using ltx-2.5-…int8-convrot (you don't have the bf16 file)"). If you have no build of it at all, the notice names the missing file and links here.

Rung 1 (Stage) needs no models at all. Rung 2 (Look still) needs the Krea 2 group. Rungs 3–4 (Draft, Final) need the LTX-2.5 group. Rung 5 (Layers) needs SAM 3.1 and BiRefNet (below) to cut mattes from the final frames; without them it falls back to the stage's own mattes.

## Licences at a glance

Soundstage's own code is MIT. **The model weights are not.** You download each model yourself and accept its licence. This table states what each licence says. It is not legal advice: read the licence before you use outputs commercially.

**Commercial use** means: **Yes** (permissive licence), **Under $X revenue** (free only while your company's annual revenue is below that line; above it you need a paid licence from the vendor), or **Non-commercial** (no commercial use at all without a separate licence).

**Checked** = read on the vendor's own licence file on 2026-11-03. **Not re-checked** = the vendor's licence page could not be opened from the audit machine (Hugging Face, bfl.ai and krea.ai were blocked there); the wording is what this repo already said. Check those yourself before you rely on them.

### Things to know first

1. **The default image model has a revenue cap.** FLUX 3 Klein (④ Frame, ② Cast sheets, Paint Studio fill) is under the FLUX Kommunity License: commercial use of outputs only below $5M annual revenue (not re-checked). Nothing non-commercial is on the default path.
2. **Krea 2 has the lowest cap: $1M.** Krea 2 Turbo is optional in the App, but `tools/install_runpod.sh` downloads it and Recast uses it for frame 1. The licence also requires content filtering. One secondary source reports a 50-seat cap as well; that could not be confirmed against the licence text.
3. **Depth Anything 3 depends on the checkpoint.** DA3-BASE, DA3-SMALL, DA3MONO-LARGE and DA3METRIC-LARGE are Apache-2.0. DA3-LARGE, DA3-GIANT and DA3NESTED are **CC BY-NC 4.0 (non-commercial)**. Video → Stage prefers the Apache ones, but if only a non-commercial DA3 file is installed it will use that one (`soundstage/video2stage/graphs.py`, `pick_model`).
4. **RMBG-2.0 is non-commercial.** Photo → 3D cut-outs use it only when BiRefNet (MIT) is missing.
5. **MiniMax H3 may not be used in the USA, EU, UK or South Korea** under its community licence. It is optional and off by default.
6. **The model router** lists any installed model, including several non-commercial ones (see the last table). Each router entry shows its licence badge.

### Models the App uses

| Model | What Soundstage uses it for | Licence | Commercial use | Required? | Licence checked |
|---|---|---|---|---|---|
| FLUX 3 Klein | ④ Frame first frame, ② Cast & Locations sheets, Paint Studio Generative Fill | FLUX Kommunity License ([Black Forest Labs](https://huggingface.co/black-forest-labs)) | Under $5M revenue (outputs) | Default image model | Not re-checked |
| Qwen3-VL 4B (text encoder) | Text encoder for FLUX 3 Klein and Krea 2 | [Apache-2.0](https://github.com/QwenLM/Qwen3-VL/blob/main/LICENSE) | Yes | With Klein or Krea 2 | Checked |
| FLUX.2 VAE | VAE for FLUX 3 Klein; TripoSplat | Apache-2.0 ([Black Forest Labs](https://huggingface.co/black-forest-labs)) | Yes | With Klein | Not re-checked |
| Krea 2 Turbo | Look still (alternative), Recast frame 1 | Krea 2 Community License v1, 22 June 2026 ([krea/Krea-2-Turbo](https://huggingface.co/krea/Krea-2-Turbo)) | Under $1M company-wide revenue (affiliates included); content filtering required; possible 50-seat cap (unconfirmed) | Optional (installed by the install script) | Not re-checked |
| Qwen-Image VAE | VAE for Krea 2 | Apache-2.0 ([Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2)) | Yes | With Krea 2 | Not re-checked |
| Krea 2 depth-control LoRA | Steers Krea 2 with the stage depth | No licence stated in this repo ([Patil/Krea-2-depth-controlnet](https://huggingface.co/Patil/Krea-2-depth-controlnet)); as a Krea 2 derivative, assume Krea 2 terms apply too | Unknown: check the repo | Optional | Not re-checked |
| LTX-2.5 22B distilled, video and audio VAEs, latent upscalers, Layout-to-Render IC-LoRA | ③ Motion Draft and Final, Layers alpha / clean plate | [LTX-2.x Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) (11 Aug 2026) | Under $10M revenue (entities at or above $10M need a paid Commercial Use Agreement, except non-commercial use) | Required for Draft and Final | Checked |
| Gemma 4 12B (LTX-2.5 text encoder repackage) | Encodes the motion prompt locally | Google's Gemma terms for the base model + LTX-2.x Community License for the repackaged file | Under $10M revenue (LTX terms) | Required for Draft and Final | Gemma terms not re-checked |
| LTX-2.3 IC-LoRA Union Control | Recast (default engine), Performance | [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2) | Under $10M revenue | Optional | Checked |
| SAM 3.1 | Rung 5 Layers mattes, Footage / Recast person tracking | [SAM License](https://github.com/facebookresearch/sam3/blob/main/LICENSE) (Meta, 19 Nov 2025) | Yes; no ITAR, military, weapons or sanctioned end uses; ship the licence with any redistribution | Optional (Layers falls back to stage mattes) | Checked |
| BiRefNet | Layers mattes, Photo → 3D cut-outs | [MIT](https://github.com/ZhengPeng7/BiRefNet) | Yes | Optional | Not re-checked |
| Qwen3.5 4B | Object designer, scene agent, Director | Apache-2.0 ([Comfy-Org/Qwen3.5](https://huggingface.co/Comfy-Org/Qwen3.5)) | Yes | Optional | Not re-checked |
| Whisper base | Director voice offline, dialogue QC | [MIT](https://github.com/openai/whisper/blob/main/LICENSE) | Yes | Optional | Checked |
| Chatterbox | TTS, voice clone, voice change | [MIT](https://github.com/resemble-ai/chatterbox/blob/master/LICENSE) (Resemble AI); output carries the Perth watermark | Yes | Optional | Checked |
| DWPose (+ YOLOX detector) | Actor pose for Recast and Performance | [Apache-2.0](https://github.com/IDEA-Research/DWPose/blob/onnx/LICENSE) | Yes | Optional | Checked |
| Depth Anything 3 | Video → Stage depth, Photo → 3D set | Per checkpoint, see the [DA3 model table](https://github.com/ByteDance-Seed/Depth-Anything-3#-model-cards): BASE, SMALL, MONO-LARGE, METRIC-LARGE Apache-2.0; LARGE, GIANT, NESTED CC BY-NC 4.0 | Yes for the Apache files; **Non-commercial** for the others | Optional | Checked |
| SAM 3D Body | Mocap: 3D body pose from video | [SAM License](https://github.com/facebookresearch/sam-3d-body/blob/main/LICENSE) (Meta) | Yes, same restrictions as SAM 3.1 | Optional | Checked |
| TripoSplat | Photo → 3D object (splat) | [MIT](https://github.com/VAST-AI-Research/TripoSplat/blob/main/LICENSE) | Yes | Optional | Checked |
| DINOv3 ViT-H | Image encoder for TripoSplat | DINOv3 License (Meta) | Yes, with Meta's acceptable-use and redistribution terms | With TripoSplat | Not re-checked |
| RMBG-2.0 | Photo → 3D cut-out fallback when BiRefNet is missing | CC BY-NC 4.0 ([briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0)) | **Non-commercial** (BRIA sells a commercial licence) | Optional fallback | Not re-checked |
| MiniMax H3 (fl2va, ref2va, 32B text encoder, VAEs) | ③ Motion second engine; Recast "local H3" | MiniMax H3 Community License ([MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)) | Not in USA, EU, UK, South Korea; elsewhere under $20M revenue, and commercial products must show "MiniMax H3" | Optional, off by default | Not re-checked |
| Wan 2.2 Animate 2 | Recast engine option | Apache-2.0 | Yes | Optional | Not re-checked |

FILM (frame interpolation) was looked for and is not used anywhere in Soundstage's code. Partner API models (ElevenLabs, Kling, Veo…) are not weights and are covered by each vendor's API terms; they are hidden by default.

### Router-only models that are non-commercial or unverified

The model router (`soundstage/router/registry.json`, docs/router.md) can drive about 70 open-weights models if you install them; Soundstage downloads none of them. Most are Apache-2.0 or MIT. These are not:

| Model | Licence as recorded in the registry |
|---|---|
| FLUX.2 [dev] 32B; FLUX.2 Klein 9B; FLUX.1 dev / Kontext / Krea dev / Fill | FLUX non-commercial licence (FLUX.1 schnell and FLUX.2 Klein 4B are Apache-2.0) |
| Qwen-Image 2.1 and 2.1 RGBA | Qwen Research License: **non-commercial** |
| Ideogram 4 | **Non-commercial** |
| Bria FIBO 2.0 | CC BY-NC 4.0: **non-commercial** |
| Depth Anything 3 LARGE / GIANT / NESTED | CC BY-NC 4.0: **non-commercial** |
| Stable Diffusion 3.5 | Stability AI Community License: under $1M revenue |
| HunyuanVideo 1.5 | Tencent Hunyuan Community License: excludes EU, UK, South Korea; over 100M MAU needs a licence |
| Capybara, LongCat-Image, NVIDIA ChronoEdit, Microsoft Lens | Not verified: check the model card |

None of these registry entries were re-checked for this table.

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
