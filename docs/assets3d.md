# Photo → 3D: making unique things for the stage

Turn a photo into something the stage can load. Everything runs through the ComfyUI queue on core nodes only (plus one fallback node, noted below), and the weights are already on the pod. Results land in ComfyUI's output folder and come back as `/view` URLs.

| Function | Use it for | Pipeline | Output |
|---|---|---|---|
| `photoToSplat(photo, opts)` | a hero object or character as a Gaussian splat (looks photoreal) | [bg removal] → TripoSplat → `SplatToFile3D` | `.ply` splat (`{proxy:true}` adds a clay `.glb`) |
| `photoToMesh(photo, {kind:"object"})` | a solid object you can light and shadow | TripoSplat → `SplatToMesh` (res 256) → `DecimateMesh` (100k faces) | `.glb`, vertex-coloured, no normals (the stage computes them) |
| `photoToMesh(photo, {kind:"set"})` | a location photo as the set, with the camera that took it | Depth Anything 3 mono → `DA3GeometryToMesh` (textured) | `.glb` plus FOV and camera |
| `photoToCutout(photo)` | 2.5D "cards" (a person or tree standing in the set) | bg removal → `JoinImageWithAlpha` | RGBA `.png` |

DA3 sees only the front surface, so it is the right tool for a *place* and the wrong one for an *object*. Objects therefore go through TripoSplat (a full 360° reconstruction) and `SplatToMesh`.

## Wiring it in

- Route (idempotent):
  ```python
  from .soundstage.assets3d import routes as _assets3d_routes
  _assets3d_routes.register()
  ```
- Module: `import * as maker from "./assets3d/maker.mjs"; maker.useApi(api);`

## API (`web/assets3d/maker.mjs`)

Every function takes `photo` as either:
- a `File`/`Blob`, uploaded to `input/soundstage/`; or
- the name of an image already in ComfyUI's input folder.

Common options:
- `api` (defaults to `useApi()`)
- `onStatus(msg)` (progress: "Queued (2 jobs ahead)…", "Working… 14 s")
- `timeoutMs` (default 15 min; on timeout the job is removed from the queue)
- `prefix` (output subfolder/name)

Every result carries `{url, format, file:{filename, subfolder, type}, prompt_id, seconds}`.

```ts
photoToSplat(photo, {gaussians = 131072, removeBg = true, steps = 20, cfg = 3, seed, proxy = false, proxyFaces = 40000, format = "ply"})
  → {url, format: "ply", bbox: {min, max, size, center}, count, seed, background,
     proxy?: {url, format: "glb", bbox}}

photoToMesh(photo, {kind = "object" | "set", resolution = 504, decimation = 1, meshResolution = 256, faces = 100000, seed, steps = 20})
  → {url, format: "glb", kind, bbox,
     // kind "set" only:
     fov_deg: {h, v}, camera: {position, target, focal_mm}, to_stage: {flip_xyz, scale, offset}}

photoToCutout(photo) → {url, format: "png", background}

backgroundRemover() → {kind: "core" | "rmbg" | "none", model, license}
runGraph(graph, opts) → {outputs, seconds, prompt_id}   // the generic queue-and-wait used by all of the above
uploadImage(photo) → "soundstage/<name>"
```

### Result fields

- **`bbox`** is in the file's own units and axes.
  - For splats it is the 0.5–99.5 percentile box, so stray floaters don't inflate it. `bbox_all` from the inspect route is the raw box.
  - TripoSplat objects come out roughly unit-sized and centred. Scale them to a real size on the stage.
- **`to_stage`** (kind "set") maps mesh vertices into stage coordinates: `stage = flip_xyz * v * scale + offset`. In stage coordinates Y is up, the camera looks +Z, and +X is screen-left.
- **`camera`** is the matching stage camera (position, target, focal_mm on the 36 mm sensor).
- **Scale for "set" is a guess.** DA3 mono depth is relative, so `scale` assumes the camera stood 1.6 m above the lowest visible surface (the floor). Adjust one number if the plate was shot higher or lower.

### Splat ↔ mesh

- **Splat → mesh:** `photoToSplat(…, {proxy:true})` runs core `SplatToMesh` → `DecimateMesh` (midpoint, `proxyFaces` = 40k) in the same job. It returns a ~0.9 MB clay GLB of the splat, for Clay, Depth, shadows and collision.
- **Splat file → mesh:** a standalone `splatToMesh(file)` was not built. Core has no loader from a `.ply` file to `SPLAT`, so it isn't trivial.
- **Mesh → splat:** no core node; not built.

## Routes (`soundstage/assets3d/routes.py`)

- `GET /soundstage/assets3d/status` reports:
  - which pipelines can run on this server (nodes plus weights present): `{splat, mesh_object, mesh_set, cutout}`
  - the chosen background remover and its license
  - every model's license
- `GET /soundstage/assets3d/inspect?filename&subfolder&type[&aspect]` returns `{format, count, bbox}` for a GLB or PLY.
  - For a single-photo depth mesh it also returns the camera: `fov_deg`, `focal_mm`, `camera`, `to_stage`.
  - The FOV is measured from the angular spread of the camera-space vertices. Pass the photo's `aspect` to make it exact.
  - The route is path-traversal safe and reads only ComfyUI's output/input/temp folders.

## Background removal

- **Default:** core `LoadBackgroundRemovalModel` + `RemoveBackground` with `background_removal/birefnet.safetensors` (MIT), as in the official template.
- **Fallback:** if core doesn't list BiRefNet (it was added to the pod after the server started, so it appears only after a restart), the maker uses the `comfyui-rmbg` node with RMBG-2.0, which is non-commercial.
  - Every result says which one ran (`background`), so a non-commercial cut-out is never silent.
  - The `comfyui-rmbg` node pack itself is GPL-3.0. It is a separate custom node; nothing here copies its code.
- **Last resort:** with neither available, the photo's own alpha channel is used.

## Licenses (checked 2026-10-28 on the model cards)

| Component | File(s) on the pod | License | Commercial use |
|---|---|---|---|
| TripoSplat (VAST-AI) | `diffusion_models/triposplat_fp16`, `vae/triposplat_vae_decoder_fp16` | MIT | yes |
| FLUX.2 VAE (used for TripoSplat conditioning) | `vae/flux2-vae-triposplat` | Apache-2.0 (BFL released the FLUX.2 VAE under Apache-2.0; the FLUX.2 [dev] *model* is non-commercial, but the VAE is not) | yes |
| DINOv3 ViT-H+ (Meta) | `clip_vision/dino_v3_vit_h` | DINOv3 License | allowed, with conditions (see below) |
| Depth Anything 3 Mono-Large (ByteDance) | `geometry_estimation/depth_anything_3_mono_large` | Apache-2.0 | yes |
| BiRefNet | `background_removal/birefnet` | MIT | yes |
| **RMBG-2.0 (BRIA)**, fallback only | `RMBG/RMBG-2.0/model.safetensors` | **CC BY-NC 4.0 / bria-rmbg-2.0** | **NO.** Non-commercial; commercial use needs a BRIA agreement |
| comfyui-rmbg node pack | custom node | GPL-3.0 | node only, not bundled |
| VNCCS-Utils (reference only, nothing copied) | custom node | MIT | — |

DINOv3 License conditions:
- It doesn't bar commercial use, but you must show "Built with DINOv3" in the product or its documentation.
- It bans military/weapons/ITAR uses.
- It must travel with any redistribution of the weights.

> **Flag:** for any commercial deliverable, keep background removal on BiRefNet; check `status().background_removal == "birefnet"` (restart the server once so core lists it). Credit "Built with DINOv3" wherever TripoSplat output ships.

## Timings (RTX PRO 6000 pod, ComfyUI 0.43, warm unless noted)

Measured live on 2026-10-28 with ComfyUI's stock `example.png` (objects) and a synthetic room render (set). No client material was used.

Warm runs use a new seed or new image each time. Re-running identical inputs is a ComfyUI cache hit (about 1–2 s).

| Call | Warm | First run (cold model load) | Output |
|---|---|---|---|
| `photoToSplat` (131k gaussians) | **13.0 s** (twice) | 161 s, with `proxy` | `.ply` 8.9 MB |
| `photoToSplat` + `proxy:true` (`SplatToMesh` 192 → `DecimateMesh` 40k) | **15.3 s** | — | + `.glb` **0.89 MB**, 38.6k faces (was 9.2 MB undecimated) |
| `photoToMesh` `kind:"object"` (262k gaussians, `SplatToMesh` 256 → `DecimateMesh` QEM 100k) | **13.6 s** | 531 s at res 384 (template default, 0.9 M verts / 43 MB) | `.glb` **2.3 MB**, 98k faces (was 9.9 MB undecimated) |
| `photoToMesh` `kind:"set"` (DA3 mono-large, 504 px) | **2.0 s** | 10.0 s | `.glb` ~40 MB at decimation 1 (use `decimation:2` for a quarter) |
| `photoToCutout` (RMBG-2.0 fallback, 1280×720) | **6.6 s** | 8.7 s | RGBA `.png` |

Measured outputs:
- **TripoSplat:** the splat comes back centred in a unit cube, Y up. For the stock figure the bounds were 0.64 × 0.97 × 0.95.
- **DA3 set mesh:** camera space, glTF convention (forward −Z, +Y up). The synthetic room read as 71° × 44° (25 mm full-frame), and `to_stage` rotates it 180° about Y.

### Pod note

An install that shares models from another ComfyUI (for example `/path/to/ComfyUI`) reads its models through `extra_model_paths.yaml`, which has no `background_removal:` line. So core doesn't see `birefnet.safetensors`, and every cut-out falls back to the non-commercial RMBG-2.0. To fix it:
1. Add `background_removal: models/background_removal/` under `runpod_slim`.
2. Restart ComfyUI.

Then `status().background_removal` reads `"birefnet"`.

## Limitations

- TripoSplat is trained on single objects, at its best on stylized ones. A whole scene photo gives a mushy splat; use `kind:"set"` for places.
- DA3 mono depth is relative. Set scale is an eye-height guess, and the mesh has stretched "curtains" at depth jumps (thinned by `discontinuity_threshold`).
- A background removed from a group photo keeps everyone. Crop to one subject first.
- Jobs share the GPU queue with renders. A busy queue means waiting, and `onStatus` reports the position.
