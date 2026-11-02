# Hardware: VRAM tiers

**Tested:** one card, an NVIDIA RTX 6000 Ada with 48 GB (the 48 GB tier). **Untested:** the 24, 16 and 12 GB tiers. They change the render graphs so that, on paper, they fit those cards; no render has been made on a 24, 16 or 12 GB card yet. Below 12 GB is not supported.

The stage (③ Set), the Look tab, the Edit tab (the Cut) and the exports run in the browser on any machine and need no GPU model.

## The switch

**Settings › Soundstage › Hardware › VRAM tier**: Auto · 48 GB · 24 GB · 16 GB · 12 GB. Auto reads the GPU's total memory (40 GB and up → 48, 20 and up → 24, 14 and up → 16, else 12; no CUDA GPU → 12). Changing it saves the tier on the ComfyUI server (`user/soundstage_vram.json`) and opens the **GPU setup check**. On a shared server, `SOUNDSTAGE_VRAM_TIER=16` (for example) in ComfyUI's environment wins over the App.

The server applies the tier to every graph it runs: the App's own prompt (an on-prompt hook) and every graph the Soundstage nodes build at run time (the model routers, Ripple, Pose follow, Recast, Performance, Generative Fill). The 48 GB tier changes nothing: graphs run exactly as before.

## What each tier changes

| | 48 GB (tested) | 24 GB (untested) | 16 GB (untested) | 12 GB (untested) |
|---|---|---|---|---|
| Weights | as named | bf16 → int8 / fp8 builds, when installed | the w4a8 / fp8 builds, when installed | as 16 GB |
| Text encoders | GPU | CPU | CPU | CPU |
| ⑤ Motion stage 1 (shorter side) | as the preset (Hollywood 704p) | at most 544p | at most 352p | one pass, no stage 1 |
| ⑤ Motion output | Draft/Final 1088p, Hollywood 1408p | up to 1088p (Hollywood = 1088p) | up to 704p | 512p |
| x2 refine | on | on | on, with small decode tiles | **off** for every preset |
| VAE decode tiles (spatial / temporal) | 512 / 128 | 384 / 64 | 256 / 32 | 256 / 32 |
| Models unloaded after each prompt | no | yes | yes | yes |
| Suggested ComfyUI flags | none | `--reserve-vram 1` | `--reserve-vram 0.4 --disable-pinned-memory` | `--reserve-vram 0.4 --disable-pinned-memory --lowvram` |

Ripple's single pass is capped to 704p (16 GB) and 512p (12 GB). The Performance render's stage 1 follows the same caps, and on 12 GB it runs one pass. Pose follow and Recast get the weights, CPU encoder and decode-tile rules but keep their size (not capped yet).

**Hollywood below 24 GB.** On 16 GB the x2 refine stays on but every preset is capped at 704p and the decode runs in small tiles, so Hollywood renders the same size as Final. On 12 GB the refine is off: Hollywood, Final and Draft all render one pass at 512p. ⑤ Motion's summary line says so ("1408p capped to 704p on 16 GB…"), and its time estimate says it was measured on the 48 GB card: on a smaller card that offloads to system RAM it is slower by an amount nobody has measured.

**Weights are never downloaded.** A tier only switches a loader to a smaller build of the same model when that file is already in your `ComfyUI/models/` folder. The setup check lists the build that would help, with its exact filename and repo, for you to fetch yourself:

| Model | Smaller build | Folder | Source | Size |
|---|---|---|---|---|
| LTX-2.5 22B distilled | `ltx-2.5-22b-distilled-transformer-w4a8_convrot.safetensors` | `diffusion_models/` | Winnougan/ltx-2.5-w4a8-convrot-int4-convrot-Winnougan-Blessing (community repack, LTX-2 Community License) | 12.5 GB (int8: 21.5 GB) |
| Gemma 4 12B (LTX-2.5 encoder) | `gemma4-12b-with-proj-ltx-2.5-w4a8_convrot.safetensors` | `text_encoders/` | same repo | not stated |
| Krea 2 Turbo | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | Comfy-Org/Krea-2 | 13.1 GB |
| Z-Image Turbo | `z_image_turbo_int8_convrot.safetensors` | `diffusion_models/` | Comfy-Org | not stated |
| UMT5-XXL (Wan) | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | Comfy-Org | not stated |

The two w4a8 files are the ones Arfolomew/backlot loads on a 16 GB RTX 4070 Ti Super and harlixay7/Kinoloom on an 8 GB card (their reports, not our measurements). **GGUF:** no GGUF build is used. Soundstage's graphs load models with ComfyUI's core loaders, which can't read `.gguf` files (that needs the separate ComfyUI-GGUF node pack), and no GGUF filename for LTX-2.5, its Gemma encoder or FLUX 3 Klein has been checked. FLUX 3 Klein has only its int8 build listed.

## The GPU setup check

It opens when you change the tier, and `GET /soundstage/vram` returns it as JSON (`?tier=16` previews another tier). It says:

- the GPU's name and memory, the tier in force, and whether that tier is tested;
- each feature and whether it **fits (tested)**, **should fit (untested)**, **runs with partial offload to system RAM: slow (untested)** or **does not fit**;
- the ComfyUI launch flags for the tier, and the smaller weight builds you don't have.

| Feature | 48 | 24 | 16 | 12 |
|---|---|---|---|---|
| ③ Set, Look tab, ⑥ Edit (Cut) and exports | fits (tested) | should fit | should fit | should fit |
| ④ Frame: FLUX 3 Klein + Qwen3-VL 4B | fits (tested) | should fit | should fit | offload |
| Look still: Krea 2 Turbo | fits (tested) | should fit | offload | offload |
| ⑤ Motion: LTX-2.5 Draft / Final / Hollywood | fits (tested) | offload | should fit with the w4a8 build (offload without it) | offload |
| Ripple, Pose follow, Recast | fits (tested) | offload | as Motion | offload |
| MiniMax H3 | fits (tested) | does not fit | does not fit | does not fit |
| Layers: SAM 3.1 + BiRefNet | fits (tested) | should fit | should fit | should fit |
| Director / Scene agent (Qwen3.5 4B) | fits (tested) | should fit | should fit | offload |

These verdicts are estimates from the file sizes and the two outside reports above, not measurements.

## Known gaps

- Nothing below 48 GB has been run. The first render on a 24 or 16 GB card may still run out of memory; please open an issue with the setup check's output.
- Text encoders on the CPU: MiniMax H3's 32B encoder already runs there in Soundstage, but the int8 / w4a8 Gemma encoder on the CPU has not been tried, and encoding a long prompt on the CPU takes longer.
- Models are unloaded after each prompt by the open App (it calls ComfyUI's `/free` when a prompt finishes). A prompt queued from a script with no App open is not followed by an unload; start ComfyUI with the suggested flags instead.
- The int8 LTX-2.5 build (21.5 GB) does not fit whole on a 24 GB card with room for a 1088p latent, so 24 GB relies on ComfyUI's partial offload; the 16 GB tier with the w4a8 build is the one with an outside report behind it.
- Image sizes for ④ Frame and the Look still, and the Pose follow / Recast render size, are not capped per tier.

## Credits

The 16 GB numbers (w4a8 LTX-2.5 at 1280×704, `--reserve-vram 0.4 --disable-pinned-memory`) follow [Arfolomew/backlot](https://github.com/Arfolomew/backlot) (MIT). Unloading models between jobs through ComfyUI's `/free` follows [harlixay7/Kinoloom](https://github.com/harlixay7/Kinoloom)'s `tool/gpu_broker.py` (MIT). No code was copied from either; [thePloggy/CreatorOS-Studio](https://github.com/thePloggy/CreatorOS-Studio) (Apache-2.0) was read but nothing from it is used.
