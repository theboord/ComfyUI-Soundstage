# Third-party notices

## Vendored in this repository

| Component | Where | License |
|---|---|---|
| three.js r170, plus the addons GLTFLoader, GLTFExporter, FBXLoader, OBJLoader, MTLLoader, PLYLoader, STLLoader, NURBS, TransformControls, SkeletonUtils, BufferGeometryUtils and fflate | `web/vendor/` | MIT, © 2010–2024 three.js authors (fflate: MIT) |
| Spark (Gaussian splat renderer) | `web/vendor/spark.module.min.mjs` | MIT, see `web/vendor/SPARK_LICENSE.txt` |
| Lucide icons | inlined SVG paths | ISC, see `web/vendor/LUCIDE_LICENSE.txt` |
| Space Grotesk font | `web/vendor/fonts/` | SIL Open Font License 1.1, see `SPACE_GROTESK_OFL.txt` |
| Horse (rigged, Idle/Walk/Gallop) by Quaternius | `web/stage/models/horse.glb` | CC0 1.0 (public domain), via [poly.pizza](https://poly.pizza/m/qvTrSG9pZF) |
| Car, Police Car, Sports Car by Quaternius | `web/stage/models/*.glb` | CC0 1.0 (public domain), via [poly.pizza](https://poly.pizza/u/Quaternius) |
| [three-avbd](https://github.com/sbobyn/three-avbd) 0.3.0 (GPU rigid bodies, Augmented Vertex Block Descent) by Steven Bobyn, which ports Chris Giles's avbd-demo3d | `web/vendor/three-avbd/` (built ES modules, renamed `.mjs`; the WebGPURenderer drawing path left out; modified: speculative contacts for fast and kinematic bodies in `avbd3d/gpu/wgsl-collision.mjs` and `wgsl-solve.mjs`, marked `[Soundstage patch]`) | MIT, see `web/vendor/three-avbd/LICENSE` and its `THIRD_PARTY_NOTICES.md` (avbd-demo3d: MIT, © 2025 Chris Giles) |

## Assets fetched separately (not in the repository)

| Component | Where | License |
|---|---|---|
| Microsoft Rocketbox avatars and animations (`Male_Adult_01`, `Female_Adult_01`, idle / walk / run / talk clips; textures converted to 1024 px PNG) from [microsoft/Microsoft-Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9` | `web/stage/people/rocketbox/` (kept out of git; see `web/stage/people/README.md`) | MIT, Copyright (c) 2020 Microsoft. The full licence text sits next to the files as `LICENSE.md`. Only commits from 2020-11-17 on are MIT; earlier ones are not. |

MIT License, Microsoft Rocketbox:

> Copyright (c) 2020 Microsoft
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Used at runtime, installed separately (not vendored)

| Component | Why | License |
|---|---|---|
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | the host app | GPL-3.0 |
| [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | IC-LoRA loader and guide, Gemma text encode | LTX-2 Community License |
| [comfyui-krea2-controlnet](https://github.com/facok/comfyui-krea2-controlnet) | Krea 2 depth control for the look still | no license file published; installed from its repo |
| [comfy-sdk](https://pypi.org/project/comfy-sdk/), [comfy-api-proxy](https://pypi.org/project/comfy-api-proxy/) | `tools/soundstage_sdk.py` | MIT |
| pyaaf2 (optional) | Avid AAF export | MIT |
| soundfile | audio I/O | BSD-3-Clause |
| Chatterbox (optional) | open TTS, voice clone and voice change | MIT |

Openjutsu's patched node pack is GPL. Soundstage links to it as an optional install and does not include any of its code.

Model weights are not included. Each model has its own license: see `MODELS.md`. MiniMax H3 (the optional second video engine) is by MiniMax, under the MiniMax H3 Community License; the App names it "MiniMax H3" wherever it can be picked. In the Router, every model shows its license badge, and non-commercial models are marked.

## Data

The lighting setups (`soundstage/look/lighting_setups.json`) and genre style presets (`soundstage/look/style_presets.json`) were written for this project from public sources, in our own words. Film titles are named only as viewing references; no stills, frames or copyrighted text are included, and no real person's name or likeness is used in any prompt.

The film-language knowledge base (`soundstage/cine_kb/`) was written for this project. It summarises techniques in its own words and names its references. It contains no copyrighted text or stills.
