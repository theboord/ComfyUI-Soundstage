# Soundstage model router

One picker node per stage. Each dropdown lists only the models valid for that stage that are actually runnable on this install: partner nodes must be loaded (not `--disable-partner-nodes`), local models need their weight files. Set `SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1` to hide every paid option.

Badges in the label: **API** = paid partner/cloud node (your Comfy credits), **NC** = non-commercial licence, **<$1M / <$5M / <$10M / <$20M** = free only below that annual revenue, **GEO** = territory restricted, **DL** = the node pack downloads its weights on first run.

The selected model is expanded into its real backend nodes at run time (node expansion), so partner nodes keep their sign-in/credit context and local models run their official template graph.

Regenerate this file and `soundstage/router/registry.json` with `python -m soundstage.router.build_registry --research ../research`.

## Generate image (text / refs → still) — `SoundstageGenerateImage`

| Dropdown label | Kind | Licence | Notes |
|---|---|---|---|
| Krea 2 Turbo · local [<$1M] | local | Krea 2 Community License: commercial only if company revenue <$1M; moderation required | 8 steps cfg 1. control_image = stage depth steers the layout (Krea2 depth-control LoRA). Edit stage = the proven Soundstage look-still: img2img from the clay frame @0.85 + depth. Depth control needs the comfyui-krea2-controlnet pack. |
| Z-Image Turbo · local | local | Apache 2.0 | Fastest commercial-safe previz model. 8 steps res_multistep. |
| FLUX 3 Klein · local [<$5M] | local | FLUX Kommunity License: free non-commercial; commercial use of outputs OK if you+affiliates <$5M annual revenue | Edit = ReferenceMultiLatent (image + refs, 1 MP). Distilled template settings. |
| Nano Banana 2.1 · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Nano Banana 2 (Gemini 3.1 Flash Image) · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| GPT Image 2.5 · OpenAI [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| GPT Image 2 · OpenAI [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| FLUX 3 Image · BFL [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedream 5.0 Pro · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedream 5.0 Flash · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Krea 2 Medium Turbo (API) · Krea [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Krea 2 Large (API) · Krea [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Z-Image Turbo (Comfy Cloud) · Comfy Cloud [API] | cloud | Open-weights model run on Comfy Cloud GPUs, billed per GPU-second through the partner proxy |  |

## Edit image (edit, keyframe from control) — `SoundstageEditImage`

| Dropdown label | Kind | Licence | Notes |
|---|---|---|---|
| Krea 2 Turbo · local [<$1M] | local | Krea 2 Community License: commercial only if company revenue <$1M; moderation required | 8 steps cfg 1. control_image = stage depth steers the layout (Krea2 depth-control LoRA). Edit stage = the proven Soundstage look-still: img2img from the clay frame @0.85 + depth. Depth control needs the comfyui-krea2-controlnet pack. |
| FLUX 3 Klein · local [<$5M] | local | FLUX Kommunity License: free non-commercial; commercial use of outputs OK if you+affiliates <$5M annual revenue | Edit = ReferenceMultiLatent (image + refs, 1 MP). Distilled template settings. |
| Nano Banana 2.1 · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Nano Banana 2 (Gemini 3.1 Flash Image) · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| GPT Image 2.5 · OpenAI [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| GPT Image 2 · OpenAI [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| FLUX 3 Image · BFL [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedream 5.0 Pro · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedream 5.0 Flash · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |

## Generate video (image / control → shot) — `SoundstageGenerateVideo`

| Dropdown label | Kind | Licence | Notes |
|---|---|---|---|
| LTX-2.5 22B distilled · local [<$10M] | local | LTX-2.x Community License: free incl. commercial for entities <$10M annual revenue; paid above | Core engine (LTX bonus). auto = Layout-To-Render IC-LoRA when control_video (stage clay) is connected (needs the ComfyUI-LTXVideo pack + L2R LoRA), else the official two-stage i2v/t2v template with audio. first_frame = look still. |
| Wan Animate 2 distilled · local | local | Apache 2.0 | Motion transfer: ref_1 = character, control_video = driving pose/performance. 81-frame window. |
| Kling 4.0 · Kling [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) | first/last frame → I2V; refs → Reference-to-Video; prompt only → T2V. |
| Veo 3.1 · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Veo 3.1 Fast · Google [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedance 2.5 · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedance 2.5 Draft · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Seedance 2.0 · ByteDance [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| MiniMax H3 · MiniMax [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| MiniMax H3 Max · MiniMax [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Runway Gen-4 Turbo · Runway [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) | Needs first_frame. |
| Luma Ray 3.2 · Luma [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| LTX-2.5 Pro (API) · Lightricks [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| LTX-2.5 Fast (API) · Lightricks [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |

## Matte (background removal / alpha) — `SoundstageMatte`

| Dropdown label | Kind | Licence | Notes |
|---|---|---|---|
| SAM 3.1 (text-prompted) · local | local | SAM License (Meta) | prompt = what to keep ("person", "the red car"). Hard-edged; pair with a soft matte for hair. |
| BiRefNet (core RemoveBackground) · local | local | BiRefNet MIT |  |
| RMBG-2.0 (ComfyUI-RMBG) · local [NC DL] | custom_node | CC BY-NC 4.0 (Bria) — NON-COMMERCIAL; commercial via Bria API |  |
| BEN2 (ComfyUI-RMBG) · local [DL] | custom_node | MIT (BEN2 weights) |  |
| BiRefNet HR matting (ComfyUI-RMBG) · local [DL] | custom_node | MIT |  |
| LTX-2.5 Alpha-Gen (soft video matte) · local [<$10M] | local | LTX-2.x Community License: free incl. commercial for entities <$10M annual revenue; paid above | Soft alpha for hair/smoke/glass. Picks 'the foreground' itself (no prompt). ≤121 frames, 8n+1. Single-stage distilled IC-LoRA at 544p. Needs ComfyUI-LTXVideo. |
| VEED Remove Video Background · VEED [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Bria Transparent Video · Bria [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |

## Clean plate (remove subjects) — `SoundstageCleanPlate`

| Dropdown label | Kind | Licence | Notes |
|---|---|---|---|
| LTX-2.5 Clean-Plate IC-LoRA · local [<$10M] | local | LTX-2.x Community License: free incl. commercial for entities <$10M annual revenue; paid above | Removes ALL people/moving subjects (no per-object choice). prompt = the empty scene. Fails when the subject fills most of the frame. Single-stage at 544p. Needs ComfyUI-LTXVideo. Not yet run on the pod. |
| Bria Video Eraser · Bria [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) | Uses the mask input when connected. |
| Kling 4.0 Edit (remove by prompt) · Kling [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |
| Runway Aleph 2 (remove by prompt) · Runway [API] | partner | Provider ToS via Comfy partner proxy (paid Comfy credits) |  |

## Catalogue — known models not wired yet

From research/10 and research/12. These never appear in a dropdown until an adapter is written.

### Generate image (text / refs → still) (53)

- FLUX 1.1 [pro] Ultra — Flux 1.1 [pro] Ultra Image · BFL (partner) [API]
- FLUX.2 [pro] / [max] — Flux.2 Image · BFL (partner) [API]
- Bria FIBO 2.0 Image Generate · Bria (partner) [API]
- Nano Banana (gemini-2.5-flash-image) — Nano Banana (Google Gemini Image) · Google (partner) [API]
- Nano Banana Pro (gemini-3-pro-image-preview) / Nano Banana 2 — Nano Banana Pro (Google Gemini Image) · Google (partner) [API]
- Grok Imagine Image 2.0 / quality / pro — Grok Image · xAI (partner) [API]
- Grok Imagine Video 1.5 / 1.5 lite — Grok Video · xAI (partner) [API]
- HY Image 3.5 preview — Tencent HY Image: Text to Image · Tencent (partner) [API]
- Ideogram 3.0 — Ideogram V3 · Ideogram (partner) [API]
- Ideogram 4.0 (API) — Ideogram V4 · Ideogram (partner) [API]
- Ideogram & Pruna P-Image · Ideogram/Pruna (partner) [API]
- Ideogram 4.5 Text to Image · Ideogram (partner) [API]
- Kling 3.0 Omni Image / Image O1 — Kling 3.0 Omni Image · Kling (partner) [API]
- Kling 3.0 Image · Kling (partner) [API]
- Krea 3 Image · Krea (partner) [API]
- Luma Photon (legacy T2I) — Luma Text to Image · Luma (partner) [API]
- Luma UNI-1 / UNI-1 max — Luma UNI-1 Image · Luma (partner) [API]
- Muse Image 1.0 — Meta Muse Image Text to Image · Meta (partner) [API]
- MAI-Image-2.6 — OpenRouter Image · OpenRouter (Microsoft) (partner) [API]
- PixVerse V6 / V6 Max — PixVerse V6 Text to Video · PixVerse (partner) [API]
- Pruna P-Video-2 Text to Video · Pruna (partner) [API]
- Pruna P-Video-2 Image to Video · Pruna (partner) [API]
- Qwen-Image 3.0 / 3.0 Pro (API) — Qwen Image 3 Text to Image · Alibaba (partner) [API]
- Wan 2.5 T2I preview — Wan Text to Image · Alibaba (partner) [API]
- Recraft V3 Text to Image · Recraft (partner) [API]
- Recraft V4 / V4.1 — Recraft V4 Text to Image · Recraft (partner) [API]
- Gen-4 Image — Runway Text to Image · Runway (partner) [API]
- Flux 2 on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- Mage-Flow on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- Mage-Flow Turbo on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- MiniMax H3 (fl2va / ref2va, int8) · MiniMax (local) [<$20M GEO]
- FastH3 OmniRef 8-step (FastVideo distill of H3) · FastVideo (local)
- MiniMax H3 as text-to-image (single frame) · MiniMax (local)
- Wan 2.2 5B TI2V · Alibaba Wan-AI (local)
- Kandinsky 5.0 Lite T2V/I2V (+T2I) · Kandinsky Lab (local)
- Causal-Forcing autoregressive I2V (Wan 2.1) · community (local)
- FLUX.2 Klein 4B (base/distilled) · Black Forest Labs (local) [NC]
- FLUX.2 [dev] 32B · Black Forest Labs (local) [NC]
- FLUX.1 dev / Kontext dev / Krea dev / Fill / schnell · Black Forest Labs (local) [NC]
- Qwen-Image 2.1 (int8, T2I + Edit + Turbo + BG removal) · Alibaba Qwen (local) [NC]
- Qwen-Image 2512 T2I (+ControlNet, 2-step LoRA, 360 LoRA) · Alibaba Qwen (local)
- Ideogram 4 (fp8/int8) · Ideogram (local) [NC]
- HiDream-O1 Image (+dev) · HiDream.ai (local)
- HiDream I1 / E1.1 · HiDream.ai (local)
- Mage-Flow (+Turbo, Edit) · Mage (local)
- MOSS-Image (T2I, layout bboxes, edit, color/depth control) · OpenMOSS (local)
- Ming-Image 0.1 Design (T2I + edit) · inclusionAI (Ant) (local)
- Microsoft Lens 3.8B (+Turbo) · Microsoft (local)
- Boogu-Image 0.1 (edit + turbo t2i) · Boogu (local)
- ERNIE-Image (+Turbo) · Baidu (local)
- LongCat-Image / Image-Edit · Meituan (local)
- Chroma / Chroma1-Radiance · lodestones (local)
- Stable Diffusion 3.5 Large/Medium (+ControlNets) · Stability AI (local) [<$1M]

### Edit image (edit, keyframe from control) (64)

- FLUX.1 Kontext [pro] — Flux.1 Kontext [pro] Image · BFL (partner) [API]
- FLUX.1 Kontext [max] — Flux.1 Kontext [max] Image · BFL (partner) [API]
- FLUX.1 Expand — Flux.1 Expand Image · BFL (partner) [API]
- FLUX.1 Fill — Flux.1 Fill Image · BFL (partner) [API]
- FLUX Erase — Flux Erase Image · BFL (partner) [API]
- FLUX Virtual Try-On — Flux Virtual Try-On · BFL (partner) [API]
- FLUX.2 [pro] / [max] — Flux.2 Image · BFL (partner) [API]
- Bria FIBO 2.0 Edit — Bria FIBO 2.0 Image Edit · Bria (partner) [API]
- Bria Generative Fill · Bria (partner) [API]
- Bria Eraser · Bria (partner) [API]
- Bria Expand Image · Bria (partner) [API]
- Bria Erase by Text · Bria (partner) [API]
- Bria Add Object · Bria (partner) [API]
- Bria Replace Object · Bria (partner) [API]
- Bria Relight · Bria (partner) [API]
- Bria Reseason · Bria (partner) [API]
- Bria Replace Background — Bria Replace Image Background · Bria (partner) [API]
- Bria Product Holding · Bria (partner) [API]
- Bria Virtual Try-On · Bria (partner) [API]
- Nano Banana (gemini-2.5-flash-image) — Nano Banana (Google Gemini Image) · Google (partner) [API]
- Nano Banana Pro (gemini-3-pro-image-preview) / Nano Banana 2 — Nano Banana Pro (Google Gemini Image) · Google (partner) [API]
- Grok Imagine Image Edit — Grok Image Edit · xAI (partner) [API]
- HY Image 3.5 preview Edit — Tencent HY Image: Edit · Tencent (partner) [API]
- Ideogram 3.0 — Ideogram V3 · Ideogram (partner) [API]
- Ideogram 4.5 Edit · Ideogram (partner) [API]
- Ideogram 4.5 Precise Edit · Ideogram (partner) [API]
- Kling 3.0 Omni Image / Image O1 — Kling 3.0 Omni Image · Kling (partner) [API]
- Kling Virtual Try-On · Kling (partner) [API]
- Krea 3 Image · Krea (partner) [API]
- Luma Photon Modify — Luma Image to Image · Luma (partner) [API]
- Luma UNI-1 Edit — Luma UNI-1 Image Edit · Luma (partner) [API]
- Ray 3.2 Reframe — Luma Ray 3.2 Video Reframe · Luma (partner) [API]
- Magnific Style Transfer — Magnific Image Style Transfer · Magnific (partner) [API]
- Magnific Relight — Magnific Image Relight · Magnific (partner) [API]
- Muse Image 1.0 Edit — Meta Muse Image Edit · Meta (partner) [API]
- MAI-Image-2.6 — OpenRouter Image · OpenRouter (Microsoft) (partner) [API]
- Qwen-Image 3.0 Edit (API) — Qwen Image 3 Edit · Alibaba (partner) [API]
- Wan 2.5 I2I preview — Wan Image to Image · Alibaba (partner) [API]
- Recraft V3 I2I — Recraft V3 Image to Image · Recraft (partner) [API]
- Recraft Inpainting — Recraft Image Inpainting · Recraft (partner) [API]
- Recraft Replace Background · Recraft (partner) [API]
- Beeble SwitchX Image Edit · Beeble (partner) [API]
- Bernini-R (Wan 2.2 based, t2v/v2v/r2v/ads2v + image edit) · Bernini authors (local)
- Capybara v0.1 (HunyuanVideo 1.5 based) video edit / I2V · community (local)
- FLUX.2 Klein 4B (base/distilled) · Black Forest Labs (local) [NC]
- FLUX.2 [dev] 32B · Black Forest Labs (local) [NC]
- FLUX.1 dev / Kontext dev / Krea dev / Fill / schnell · Black Forest Labs (local) [NC]
- Qwen-Image 2.1 (int8, T2I + Edit + Turbo + BG removal) · Alibaba Qwen (local) [NC]
- Qwen-Image-Edit 2511 (+Lightning 4-step) · Alibaba Qwen (local)
- Qwen-Image-Edit 2511 + Multiple-Angles LoRA + CameraAngle widget (Reshoot still) · Alibaba Qwen + fal LoRA (local)
- HiDream-O1 Image (+dev) · HiDream.ai (local)
- HiDream I1 / E1.1 · HiDream.ai (local)
- Mage-Flow (+Turbo, Edit) · Mage (local)
- MOSS-Image (T2I, layout bboxes, edit, color/depth control) · OpenMOSS (local)
- Ming-Image 0.1 Design (T2I + edit) · inclusionAI (Ant) (local)
- Boogu-Image 0.1 (edit + turbo t2i) · Boogu (local)
- JoyAI Image Edit · JD (local)
- Bria FIBO 2.0 (dev/turbo edit) · Bria (local) [NC]
- FireRed Image Edit 1.1 · FireRed (Xiaohongshu) (local)
- LongCat-Image / Image-Edit · Meituan (local)
- OmniGen2 · VectorSpaceLab (local)
- NVIDIA ChronoEdit 14B (Wan 2.1 based, physics-aware edit) · NVIDIA (local)
- Depth Anything 3 (depth/geometry -> mesh/pointcloud) · ByteDance (local)
- MoGe 2/3 geometry (depth, normals, FoV, panorama) · Microsoft (local)

### Generate video (image / control → shot) (110)

- FLUX 3 Video — Flux 3 Text to Video · BFL (partner) [API]
- FLUX 3 Video — Flux 3 Image to Video · BFL (partner) [API]
- FLUX 3 Video — Flux 3 Video Continuation · BFL (partner) [API]
- FLUX 3 Max Video — FLUX 3 Max Text to Video · BFL (partner) [API]
- FLUX 3 Max Video — FLUX 3 Max Image to Video · BFL (partner) [API]
- FLUX Video Edit — Flux Video Edit · BFL (partner) [API]
- Bria Video Replace BG — Bria Video Replace Background · Bria (partner) [API]
- Seedance 1.0/1.5 pro — ByteDance Text to Video · ByteDance (partner) [API]
- Seedance 1.0/1.5 pro — ByteDance Image to Video · ByteDance (partner) [API]
- Seedance 1.0/1.5 pro — ByteDance First-Last-Frame to Video · ByteDance (partner) [API]
- Seedance 2.5 / 2.0 Reference — ByteDance Seedance 2.5 Reference to Video · ByteDance (partner) [API]
- Gemini Omni Flash 1.1 / Omni Flash — Google Gemini Omni (Video) · Google (partner) [API]
- Grok Imagine Video 1.5 / 1.5 lite — Grok Video · xAI (partner) [API]
- Grok Imagine Video Edit — Grok Video Edit · xAI (partner) [API]
- Grok Reference-to-Video · xAI (partner) [API]
- Grok Video Extend · xAI (partner) [API]
- HeyGen Video 1.0 Reference to Video · HeyGen (partner) [API]
- HeyGen Video 1.0 Image to Video · HeyGen (partner) [API]
- Kling 2.x (legacy T2V) — Kling Text to Video · Kling (partner) [API]
- Kling 3.0 Omni / O1 — Kling 3.0 Omni Text to Video · Kling (partner) [API]
- Kling 3.0 Omni / O1 — Kling 3.0 Omni First-Last-Frame to Video · Kling (partner) [API]
- Kling 3.0 Omni / O1 — Kling 3.0 Omni Image to Video · Kling (partner) [API]
- Kling 3.0 Omni / O1 — Kling 3.0 Omni Video to Video · Kling (partner) [API]
- Kling 3.0 Omni / O1 Edit — Kling 3.0 Omni Edit Video · Kling (partner) [API]
- Kling 2.5 Turbo — Kling Image(First Frame) to Video · Kling (partner) [API]
- Kling (start/end) — Kling Start-End Frame to Video · Kling (partner) [API]
- Kling 2.6 Text to Video with Audio · Kling (partner) [API]
- Kling 2.6 Image(First Frame) to Video with Audio · Kling (partner) [API]
- Kling Motion Control (v3 / v2.6) — Kling Motion Control · Kling (partner) [API]
- Kling 3.0 Video · Kling (partner) [API]
- Kling 3.0 First-Last-Frame to Video · Kling (partner) [API]
- LTX-2.5 Audio-to-Video (API) — LTX 2.5 Audio To Video · Lightricks (partner) [API]
- Luma Ray 3.2 Keyframes to Video · Luma (partner) [API]
- Luma Ray 3.2 Video Edit · Luma (partner) [API]
- Luma Ray 3.2 Extend Video · Luma (partner) [API]
- T2V-01 / T2V-01-Director — MiniMax Text to Video · MiniMax (partner) [API]
- I2V-01 / Director / live — MiniMax Image to Video · MiniMax (partner) [API]
- MiniMax Hailuo 02 Video · MiniMax (partner) [API]
- MiniMax H3 / Max Reference (API) — MiniMax H3 Reference to Video · MiniMax (partner) [API]
- PixVerse (legacy v4.x/v5) — PixVerse Text to Video · PixVerse (partner) [API]
- PixVerse (legacy) — PixVerse Image to Video · PixVerse (partner) [API]
- PixVerse Transition (legacy) — PixVerse Transition Video · PixVerse (partner) [API]
- PixVerse V6 / V6 Max — PixVerse V6 Text to Video · PixVerse (partner) [API]
- PixVerse V6 / V6 Max — PixVerse V6 Image to Video · PixVerse (partner) [API]
- PixVerse V6 First-Last-Frame to Video · PixVerse (partner) [API]
- PixVerse V6 Extend Video · PixVerse (partner) [API]
- PixVerse V6 Fusion (Reference to Video) · PixVerse (partner) [API]
- Pruna P-Video-2 Text to Video · Pruna (partner) [API]
- Pruna P-Video-2 Image to Video · Pruna (partner) [API]
- Wan 2.5 / 2.6 T2V — Wan Text to Video · Alibaba (partner) [API]
- Wan 2.5 / 2.6 I2V — Wan Image to Video · Alibaba (partner) [API]
- Wan 2.6 R2V — Wan Reference to Video · Alibaba (partner) [API]
- Wan 2.7 T2V — Wan 2.7 Text to Video · Alibaba (partner) [API]
- Wan 2.7 I2V — Wan 2.7 Image to Video · Alibaba (partner) [API]
- Wan 2.7 Continuation — Wan 2.7 Video Continuation · Alibaba (partner) [API]
- Wan 2.7 Video Edit · Alibaba (partner) [API]
- Wan 2.7 R2V — Wan 2.7 Reference to Video · Alibaba (partner) [API]
- Wan 3.0 (API) — Wan 3.0 Reference to Video · Alibaba (partner) [API]
- Wan 3.0 (API) — Wan 3.0 Image to Video · Alibaba (partner) [API]
- HappyHorse 1.1 T2V — HappyHorse Text to Video · Alibaba (partner) [API]
- HappyHorse 1.1 I2V — HappyHorse Image to Video · Alibaba (partner) [API]
- HappyHorse 1.0 Video Edit — HappyHorse Video Edit · Alibaba (partner) [API]
- HappyHorse 1.1 R2V — HappyHorse Reference to Video · Alibaba (partner) [API]
- Vidu Q1 — Vidu Text To Video Generation · Vidu (partner) [API]
- Vidu Q1 — Vidu Image To Video Generation · Vidu (partner) [API]
- Vidu Q1 Reference — Vidu Reference To Video Generation · Vidu (partner) [API]
- Vidu Q1 — Vidu Start End To Video Generation · Vidu (partner) [API]
- Vidu Q2 — Vidu2 Text-to-Video Generation · Vidu (partner) [API]
- Vidu Q2 pro-fast / pro / turbo — Vidu2 Image-to-Video Generation · Vidu (partner) [API]
- Vidu Q2 Reference — Vidu2 Reference-to-Video Generation · Vidu (partner) [API]
- Vidu Q2 — Vidu2 Start/End Frame-to-Video Generation · Vidu (partner) [API]
- Vidu Q2 pro Extend — Vidu Video Extension · Vidu (partner) [API]
- Vidu Q2 Multi-Frame — Vidu Multi-Frame Video Generation · Vidu (partner) [API]
- Vidu Q3 pro — Vidu Q3 Text-to-Video Generation · Vidu (partner) [API]
- Vidu Q3 pro — Vidu Q3 Image-to-Video Generation · Vidu (partner) [API]
- Vidu Q3 pro — Vidu Q3 Start/End Frame-to-Video Generation · Vidu (partner) [API]
- Vidu Q4 Preview — Vidu Q4 Image-to-Video Generation · Vidu (partner) [API]
- Vidu Q4 Preview Reference — Vidu Q4 Reference-to-Video Generation · Vidu (partner) [API]
- Beeble SwitchX Video Edit · Beeble (partner) [API]
- MiniMax H3 on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- MiniMax H3 FLF on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- MiniMax H3 I2V on Comfy Cloud [BETA] · Comfy Cloud (cloud) [API]
- LTX-2.3 22B dev / distilled · Lightricks (local) [<$10M]
- LTX-2.3 IC-LoRA Union Control (depth/pose/canny) · Lightricks (local)
- LTX-2.3 IC-LoRA Ingredients (reference-to-video) · Lightricks (local)
- LTX-2.3 edit LoRAs (remove object / watermark / subtitles, outpaint, restore archival) · Lightricks + community (local)
- MiniMax H3 (fl2va / ref2va, int8) · MiniMax (local) [<$20M GEO]
- MiniMax H3 Fun ControlNet Union (pose) · MiniMax / community (local)
- FastH3 OmniRef 8-step (FastVideo distill of H3) · FastVideo (local)
- Wan 2.2 14B T2V / I2V / FLF2V (+lightx2v 4-step) · Alibaba Wan-AI (local)
- Wan 2.2 5B TI2V · Alibaba Wan-AI (local)
- Wan 2.2 Fun Camera / Wan 2.1 Fun Camera · Alibaba PAI (local)
- Wan 2.2 Fun Control / Inpaint · Alibaba PAI (local)
- Wan 2.1 VACE 14B / 1.3B · Alibaba Wan-AI (local)
- Wan 2.2 Animate 14B · Alibaba Wan-AI (local)
- SCAIL-2 (Wan 2.1 14B) character replacement · SCAIL authors / Comfy-Org repack (local)
- WanMove / Wan ATI trajectory control · Alibaba / community (local)
- HuMo (Wan-based human video) · ByteDance / community (local)
- WanDancer (music-driven dance) · community (local)
- Bernini-R (Wan 2.2 based, t2v/v2v/r2v/ads2v + image edit) · Bernini authors (local)
- HunyuanVideo 1.5 720p T2V/I2V + 1080p SR · Tencent (local) [GEO]
- Capybara v0.1 (HunyuanVideo 1.5 based) video edit / I2V · community (local)
- Kandinsky 5.0 Lite T2V/I2V (+T2I) · Kandinsky Lab (local)
- NVIDIA Cosmos Predict2 / 2.5 · NVIDIA (local)
- Genmo Mochi 1 · Genmo (local)
- Causal-Forcing autoregressive I2V (Wan 2.1) · community (local)
- VOID video object removal · Netflix/INSAIT VOID authors (local)
- SAM 3D Body (3D pose from video -> animation file) · Meta (local)
- ComfyUI-WanVideoWrapper (Kijai) — Wan family superset · Kijai (custom node) (custom_node)
- ComfyUI-LTXVideo (Lightricks official pack) · Lightricks (custom node) (custom_node)

### Matte (background removal / alpha) (34)

- Bria Guided Remove BG — Bria Guided Remove Background · Bria (partner) [API]
- Bria RMBG 2.0 — Bria Remove Image Background · Bria (partner) [API]
- Bria Remove Video BG — Bria Remove Video Background · Bria (partner) [API]
- Bria Video Green Screen · Bria (partner) [API]
- ByteDance Seedream 5.0 Layer Separation · ByteDance (partner) [API]
- Recraft Remove Background · Recraft (partner) [API]
- Beeble SwitchX Video Edit · Beeble (partner) [API]
- Beeble SwitchX Image Edit · Beeble (partner) [API]
- Qwen-Image 2.1 (int8, T2I + Edit + Turbo + BG removal) · Alibaba Qwen (local) [NC]
- Qwen-Image-Layered (layer decomposition) · Alibaba Qwen (local)
- Create Layered Image / Add Layer / Layers From Bounding Boxes (core) · Comfy (local)
- lucida (BiRefNet_HR fine-tune: glass, glow, camouflage) · egeorcun (repack Comfy-Org/BiRefNet) (local)
- Qwen-Image 2.1 RGBA (transparent gen + subject extraction) · Alibaba Qwen (local) [NC]
- Wan 2.1 Alpha T2V 14B (generates RGBA video FX elements) · WeChatCV (htdong) (local)
- InSPyReNet (transparent-background) via ComfyUI-RMBG · plemeri (custom_node)
- Bria VRMBG-3.0 (temporal video matting, local) via ComfyUI-RMBG · BRIA AI (custom_node) [NC]
- FeyNoBg ultra-fine matting (Swin-L 263M) via ComfyUI-RMBG · 1038lab (custom_node)
- Finegrain Box Segmenter (bbox-prompted matting) via ComfyUI-RMBG · Finegrain (custom_node)
- SDMatte (interactive point/box matting, SD prior) via ComfyUI-RMBG · LongfeiHuang (custom_node)
- MatAnyone 2 (first-frame-mask video matting) · NTU S-Lab (pq-yang); node dreamrec (custom_node) [NC]
- VideoMaMa (mask track -> alpha via SVD prior) · Adobe/KAIST (cvlab-kaist); node okdalto (custom_node) [NC]
- Robust Video Matting (RVM) · PeterL1n; node Fannovel16 (custom_node)
- CorridorKey (neural green/blue-screen keyer) · Corridor Digital (custom_node) [NC]
- OmnimatteZero (training-free omnimatte on LTX-Video 0.9) · dvirsamuel; node tpc2233 (custom_node)
- LayerDiffuse (SDXL/SD1.5 transparent image gen) · lllyasviel; node huchenlei (custom_node)
- GVM Generative Video Matting (SVD prior, automatic) — wrap · aim-uofa (SIGGRAPH'25) (python_only) [NC]
- VideoMaMa++ (Wan2.1-1.3B LoRA, 1-step, seam-free long video matting) · Adobe/KAIST (NeurIPS'26) (python_only)
- Generative Omnimatte (Casper effect-removal; public reimpl.) — wrap · gen-omnimatte (Google DeepMind paper) (python_only)
- TransPixeler / TransPixar (RGBA T2V on CogVideoX; Wan branch) · wileewang (CVPR'25) (python_only)
- Bria Video Background Removal (fal) · Bria via fal (external_api)
- BEN2 video background removal (fal) · fal (external_api)
- Pixelcut Video Background Removal (fal) · Pixelcut via fal (external_api)
- BiRefNet v2 video (fal) · fal (external_api)
- Magnific/Freepik video & image background removal (API) · Freepik/Magnific (external_api)

### Clean plate (remove subjects) (11)

- Bria Erase Foreground · Bria (partner) [API]
- VOID video object removal · Netflix/INSAIT VOID authors (local)
- LTX-2.3 IC-LoRA Clean-Plate · Lightricks (local) [<$10M]
- LTX In/Outpaint IC-LoRA (mask-driven video inpaint) · Lightricks (local) [<$10M]
- MiniMax-Remover (Wan2.1-1.3B, 6-step) · zibojia; node kijai (custom_node) [NC]
- DiffuEraser (SD1.5 + ProPainter prior) · lixiaowen-xw; node smthemex (custom_node)
- ProPainter (flow propagation, non-generative) · sczhou; node daniabib (custom_node) [NC]
- OmnimatteZero (training-free omnimatte on LTX-Video 0.9) · dvirsamuel; node tpc2233 (custom_node)
- ROSE (remove objects WITH side effects: shadow/reflection/light) — wrap · Kunbyte-AI (NeurIPS'25) (python_only)
- EffectErase (effect-aware removal + insertion) — wrap · FudanCVL (CVPR'26 Highlight) (python_only) [NC]
- E2FGVI (flow-guided video inpainting) · MCG-NKU (python_only) [NC]
