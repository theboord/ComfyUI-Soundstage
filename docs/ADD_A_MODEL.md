# Add a model

How to add an image, video, matte or clean-plate model to the router in 3 steps: one registry entry, one adapter, then test. The worked example is an existing entry, Z-Image Turbo (`open.z_image_turbo`, adapter `z_image`), cloned as a new model called NEWMODEL. Line numbers are at main `0b89169`.

## What a new model reaches today

It reaches the 5 router stages, and the places that read their dropdowns:

| Stage | Node | Where it shows up |
|---|---|---|
| generate_image | Soundstage · Generate Image (any model) | The node's model dropdown. |
| edit_image | Soundstage · Edit Image / Keyframe (any model) | ④ Frame's image-model select (`web/pipeline/pipeline.mjs:843-857`) and Paint Studio's Generative Fill. |
| generate_video | Soundstage · Generate Shot (any model) | ⑤ Motion's "Video model" select, after the LTX Layout-to-Render entry (`web/pipeline/pipeline.mjs:1259-1267`). Picking it turns switch 9084 on. Only in `Soundstage_App_Full.json` and the scene Apps; the lean `Soundstage_App.json` has no video picker. |
| matte | Soundstage · Matte (any model) | The node's dropdown. |
| clean_plate | Soundstage · Clean Plate (any model) | The node's dropdown. |

It does not reach:
- The App's default final render and its drafts, Shot from Sound, Recast's LTX and H3 engines, Ripple, Pose follow, Performance, Reshoot, Loop and Pitch Mode. These build their own graphs. [MODEL_AUDIT.md](MODEL_AUDIT.md) lists them.
- OneClick and Cast reference generation. They pick models by name, so a new model is never chosen there.
- Audio. Audio engines live in `soundstage/audio/engines.py`, not in `registry.json`.

## Step 1: one registry entry

`soundstage/router/registry.json` is generated. The source of truth is the `WIRED` list in `soundstage/router/build_registry.py:75-287`. Edit `WIRED`, then regenerate `registry.json` and `docs/router.md`.

### The example entry

Z-Image Turbo is `build_registry.py:94-102`:

```python
    local("open.z_image_turbo", "Z-Image Turbo", "Alibaba Tongyi-MAI", ["generate_image"], "z_image",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
           "EmptySD3LatentImage", "ModelSamplingAuraFlow", "KSampler", "VAEDecode"],
          [{"role": "unet", "folder": "diffusion_models",
            "any": ["z_image_turbo_bf16.safetensors", "z_image_turbo_int8_convrot.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders", "any": ["qwen_3_4b.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["ae.safetensors"]}],
          "Apache 2.0", notes="Fastest commercial-safe previz model. 8 steps res_multistep.",
          source_ids=["open.z_image"]),
```

In `registry.json` it becomes:

```json
{"id": "open.z_image_turbo", "name": "Z-Image Turbo", "provider": "Alibaba Tongyi-MAI", "kind": "local",
 "stages": ["generate_image"], "adapter": "z_image", "variant": null,
 "classes": ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
             "EmptySD3LatentImage", "ModelSamplingAuraFlow", "KSampler", "VAEDecode"],
 "weights": [{"role": "unet", "folder": "diffusion_models",
              "any": ["z_image_turbo_bf16.safetensors", "z_image_turbo_int8_convrot.safetensors"]},
             {"role": "text_encoder", "folder": "text_encoders", "any": ["qwen_3_4b.safetensors"]},
             {"role": "vae", "folder": "vae", "any": ["ae.safetensors"]}],
 "optional_weights": [], "auto_download": false, "params": {}, "license": "Apache 2.0",
 "notes": "Fastest commercial-safe previz model. 8 steps res_multistep.", "source_ids": ["open.z_image"]}
```

The fields:

| Field | Meaning |
|---|---|
| `id` | Unique. Prefix `open.` for open weights, `api.` for partner models. |
| `name` | The dropdown label is `name · local [badges]` (`soundstage/router/registry.py:63-66`). Saved workflows store the label, so never rename a shipped `name`. Keep it ASCII. |
| `provider` | Shown in partner labels. |
| `kind` | `local` or `custom_node` show by default. `partner` and `cloud` show only with `SOUNDSTAGE_PARTNER_MODELS=1` and a Comfy sign-in. |
| `stages` | Which router nodes list it: any of `generate_image`, `edit_image`, `generate_video`, `matte`, `clean_plate`. |
| `adapter` | A key in `ADAPTERS` (`soundstage/router/adapters.py:955-969`). `null` means a catalogue row that never shows. |
| `variant` | Passed to the adapter, so one adapter can serve several entries. |
| `classes` | Every node class the adapter emits. A missing class hides the model. A test fails if the adapter emits a class not listed here. |
| `weights` | Required files, `{role, folder, any: [...]}`. The first installed file in `any` wins. The adapter reads it as `p["weights"][role]`. A missing file hides the model. |
| `optional_weights` | Same shape, plus an optional `classes` list. Never hides the model; resolves to `None` when absent. |
| `auto_download` | The node pack downloads its weights itself (adds the DL badge). |
| `params` | User knobs. `{options, default}` becomes a combo, `{min, max, default}` a float. An optional `stages` list scopes a knob. `duration` is never a widget; partner adapters use it to snap seconds. |
| `license` | Free text. The API, NC, GEO, DL and `<$NM` badges are parsed from it (`soundstage/router/registry.py:45-60`). |
| `notes` | Free text, copied into `docs/router.md`. |
| `source_ids` | Catalogue ids this entry replaces. Those catalogue rows are dropped. |

### Add NEWMODEL

Add a `local(...)` call to `WIRED` inside its stage's block, after the stage's current default. `WIRED` order is the dropdown order, and the first available entry is the stage's default (`build_registry.py:74`). Here it goes right after Z-Image Turbo:

```python
    local("open.newmodel", "NEWMODEL", "<Provider>", ["generate_image"], "newmodel",
          ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
           "EmptySD3LatentImage", "ModelSamplingAuraFlow", "KSampler", "VAEDecode"],
          [{"role": "unet", "folder": "diffusion_models", "any": ["newmodel_bf16.safetensors"]},
           {"role": "text_encoder", "folder": "text_encoders", "any": ["qwen_3_4b.safetensors"]},
           {"role": "vae", "folder": "vae", "any": ["ae.safetensors"]}],
          "<licence text: the badges are parsed from it>", notes="<steps, sampler, limits>"),
```

A paid API model uses `partner(...)` instead (`build_registry.py:54-59`). It has no weights.

### Regenerate

With the research folder next to the repo:

```bash
PYTHONUTF8=1 python -m soundstage.router.build_registry --research ../research
```

The research files are not in the repo. Without them, run this from the repo root. It keeps the existing catalogue rows and rewrites the wired ones from `WIRED`:

```bash
PYTHONUTF8=1 python -c "import json; from soundstage.router import build_registry as B; p='soundstage/router/registry.json'; r=json.load(open(p,encoding='utf-8')); ws={s for w in B.WIRED for s in w['source_ids']}; r['models']=B.WIRED+[m for m in r['models'] if not m['adapter'] and m['id'] not in ws]; json.dump(r,open(p,'w',encoding='utf-8'),indent=1,ensure_ascii=False); B.write_docs(r,'docs/router.md')"
```

- With `WIRED` unchanged, this reproduces `registry.json` byte for byte.
- It also rewrites 4 rows of `docs/router.md` that have drifted from `WIRED`. Expect that diff.
- `PYTHONUTF8=1` matters on Windows: `write_docs` opens its file without an encoding.

## Step 2: one adapter

An adapter is `adapter(g, m, p)` and returns a dict of output links (`soundstage/router/adapters.py:1-14`):
- `g`: ComfyUI's GraphBuilder. Add nodes with `g.node(class_type, **inputs).out(i)`.
- `m`: the registry entry.
- `p`: the router's parameters, built in `soundstage/nodes_router.py:103-150`: prompt, negative, seed, width, height, frames, fps, first, last, control, refs, image, images, mask, params, weights, variant, lora, steps, cfg.

At run time ComfyUI swaps the router node for the graph the adapter builds (node expansion).

### The example adapter

`z_image` is `adapters.py:492-501`. It rebuilds ComfyUI's Z-Image Turbo template:

```python
def z_image(g, m, p):
    """Template image_z_image_turbo."""
    model, clip, vae = _loaders(g, p["weights"], "lumina2")
    pos, neg = _text(g, clip, p["prompt"])
    model = g.node("ModelSamplingAuraFlow", model=model, shift=3.0).out(0)
    latent = g.node("EmptySD3LatentImage", width=snap(p["width"], 16), height=snap(p["height"], 16),
                    batch_size=1).out(0)
    s = g.node("KSampler", model=model, seed=int(p["seed"]), steps=8, cfg=1.0, sampler_name="res_multistep",
               scheduler="simple", positive=pos, negative=neg, latent_image=latent, denoise=1.0).out(0)
    return {"image": g.node("VAEDecode", samples=s, vae=vae).out(0)}
```

For NEWMODEL, copy it next to `z_image` as `def newmodel(g, m, p):`, then change it to match the new model's own ComfyUI template. Register it in `ADAPTERS` under `# images`:

```python
    "krea2": krea2, "z_image": z_image, "newmodel": newmodel, "flux3_klein": flux3_klein, ...
```

Rules:
- Take files only from `p["weights"][role]`, and knobs only from `p["params"]`.
- Media in `p` (image, images, refs, control, first, last, mask) are raw links. Wire them in as they are.
- If the model cannot take an input it is given, refuse with `need()` or `RouterError` (`adapters.py:20, 77-80`). Do not drop it silently.
- Return the keys the stage expects:

| Stage | Return |
|---|---|
| generate_image, edit_image | `{"image"}` |
| generate_video | `{"video"}`, a VIDEO from `CreateVideo` (see `ltx25_i2v`, `adapters.py:597-624`) |
| matte | `{"images", "mask"}` |
| clean_plate | `{"images"}` |

For a video model, also:
- Snap `p["frames"]` to the model's own frame grid (for example `ltx_frames`, `adapters.py:68-70`).
- Use `p["fps"]`, and read `p["first"]`, `p["last"]`, `p["control"]` and `p["refs"]` when the model takes them.
- Add the entry after LTX-2.5 in `WIRED`. Tests pin LTX-2.5 as the first video model (`tests/test_router_registry.py:74, 103`; `tests/test_router_h3.py:45-50`).

### New node classes

The graph tests check every emitted node against a saved `/object_info` snapshot of 91 classes (`tests/test_router_object_info.json`). A class that is not in it fails with "not in snapshot". To add it, refresh the snapshot from a running ComfyUI that has every node pack installed:

```bash
python tests/test_router_adapters.py --refresh-snapshot <your ComfyUI URL>
```

This rewrites the whole snapshot (`tests/test_router_adapters.py:287-308`). Or add the class's `/object_info` entry to the file by hand.

## Step 3: test, then confirm it shows up

### Run the tests

No ComfyUI, GPU or network is needed, only Python with pytest (`pip install pytest`; it is not in `requirements.txt`). From the repo root:

```bash
PYTHONUTF8=1 PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider tests/test_router_registry.py tests/test_router_adapters.py tests/test_router_h3.py tests/test_router_app.py tests/test_fill.py -q
```

- Before the change: 383 collected, 374 passed, 9 skipped. The skips are adapters refusing an input combination by design.
- The new entry needs no test edits. NEWMODEL adds 5 tests, all passing: `test_param_defaults_valid[open.newmodel]`, `test_every_wired_model_builds_for_some_input[open.newmodel]` and `test_adapter_builds_valid_graph[open.newmodel-generate_image-0..2]`. Result: 388 collected, 379 passed, 9 skipped.
- Run between Step 1 and Step 2, the same command fails 5 tests (`test_registry_shape` and the 4 graph tests above), because the entry names an adapter that does not exist yet. They pass once the adapter is registered.
- Add `-k newmodel` to run only its tests.
- If the model also serves edit_image, it adds 8 more: 3 edit_image graph scenarios, a keep-input-size test and 4 Generative Fill tests. FLUX 3 Klein, which serves both image stages, has 13.

These numbers, and the dropdown output below, were measured on 2026-11-02 by following this page step by step on a scratch copy of `0b89169` (Python 3.14, pytest 9.2). "Check it live" was not run.

### Check the dropdown offline

This lists the generate_image dropdown for the test snapshot of installed files, plus the new weight file:

```bash
PYTHONUTF8=1 python -c "import sys; sys.path[:0]=['.','tests']; from test_router_registry import ALL_CLASSES, POD_FILES, files; from soundstage.router import registry as R; t={**POD_FILES, 'diffusion_models': POD_FILES['diffusion_models']+['newmodel_bf16.safetensors']}; print([o[0] for o in R.stage_options('generate_image', ALL_CLASSES, files(t), open_only=True)])"
```

- Today it prints `['Krea 2 Turbo · local [<$1M]', 'Z-Image Turbo · local', 'FLUX 3 Klein · local [<$5M]']`.
- With NEWMODEL it prints `['Krea 2 Turbo · local [<$1M]', 'Z-Image Turbo · local', 'NEWMODEL · local', 'FLUX 3 Klein · local [<$5M]']`.
- If the model needs a text encoder or VAE that is not in the snapshot, add those files to `t` too.

### Check it live

1. Put the weight files in their folders and restart ComfyUI. `registry.json` is read once per process (`soundstage/router/registry.py:22-30`), and dropdown options are cached for 30 s (`soundstage/nodes_router.py:24`).
2. Open `<your ComfyUI URL>/object_info/SoundstageGenerateImage` and find the label under `input.required.model`. OneClick reads the same data.
3. Add the node "Soundstage · Generate Image (any model)" and pick NEWMODEL from its model dropdown. Queue it.
4. In the App, an edit_image model also appears in ④ Frame's image-model select. A generate_video model appears in ⑤ Motion's "Video model" select.

## Cheaper cases

- **A new file for a model that is already there**: add the filename to that entry's `any` list.
- **Another version of a partner model**: add one `partner(...)` entry that reuses an adapter with a new `variant`. For example `api.veo_3_1_fast` reuses `veo3` (`build_registry.py:204-206`).

## Making it the default

The default is the first available entry in `WIRED` order. Moving a model ahead of the current default is a separate change. It needs the tests that pin LTX-2.5 updated (`tests/test_router_registry.py:74, 103`; `tests/test_router_h3.py:45-60`) and the App defaults that name labels (`tools/app_build/models.py:11-12`, `soundstage/takecheck/readiness.py:26-27`).
