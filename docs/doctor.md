# Doctor: check my setup

`soundstage/doctor.py` checks a ComfyUI install for Soundstage and answers in plain words: what works, what is
missing, and exactly what to do (which file, which folder, where to get it). Nothing is downloaded or changed.

## Running it

- **In the App:** **Tools ▾ › Check my setup** (the canvas layout's Tools menu). The dialog has **Check again** and
  **Copy report** (the plain-text report, for a bug report or a Discord question). The classic layout has no
  Tools menu, so the button is not there.
- **From a terminal**, in the `ComfyUI-Soundstage` folder:

```bash
python -m soundstage.doctor                                 # the ComfyUI at 127.0.0.1:8188, else the folders
python -m soundstage.doctor --url http://127.0.0.1:8188
python -m soundstage.doctor --comfy /path/to/ComfyUI        # ComfyUI not running
python -m soundstage.doctor --sizes                         # ask Hugging Face how big each missing file is
python -m soundstage.doctor --json                          # the full report
```

Exit status: 0 when the required node packs, the Python packages and the default models (Frame and Motion) are
there; 1 when something required is missing; 2 when the `--url` given does not answer, or when it found neither a
server nor a ComfyUI folder.

## What it checks

| Part | How |
|---|---|
| Node packs | ComfyUI core (by its newer node classes), Soundstage itself, ComfyUI-LTXVideo and comfyui-krea2-controlnet (required), comfyui_controlnet_aux, ComfyUI-VideoHelperSuite and ComfyUI-RMBG (optional), each by a few of its node classes. |
| Model files, per feature | Frame (FLUX 3 Klein), Motion (LTX-2.5 + the Layout-to-Render IC-LoRA), and the optional Krea 2, Layer Pack mattes, MiniMax H3, Qwen3.5, SAM 3D Body, Whisper and Chatterbox. A file in a subfolder counts, and so does another build of the same model (bf16 instead of int8), by the same rule the App uses when a workflow loads (`web/ui/modelmatch.mjs`). A weight file under 1 MB is reported as an incomplete download. |
| VRAM | Which features fit. Only measured facts are claimed: everything was tested on a 48 GB card; below that is "untested, may need offloading"; Motion on a 16 GB card is "too small" (LTX-2.5 22B and its Gemma encoder are about 35 GB). The stage, Look, Cut and exports need no GPU. |
| Python packages | `soundfile`, `scipy`, `opencv-python-headless` (required, from requirements.txt), what ComfyUI brings (`numpy`, `Pillow`, `av`) and the optional `pyaaf2`, `chatterbox-tts`, `transformers`. |

## Three ways to look

The report says which one it used.

1. **Inside ComfyUI** (`GET /soundstage/doctor`, used by the App's button and by the CLI when the server has the
   route): node classes from ComfyUI's own class list, files from `folder_paths` (so `extra_model_paths.yaml`
   counts), VRAM from `comfy.model_management`, Python packages from ComfyUI's own Python.
2. **Over HTTP** (the server has no `/soundstage/doctor`, so Soundstage did not load there): one class per request
   with `/object_info/<Class>`, never the full `/object_info` (slow on big installs); files with `/models/<folder>`;
   VRAM with `/system_stats`. Python packages can't be seen from outside, so they are marked "not checked".
3. **From disk** (`--comfy`): `models/` (plus `extra_model_paths.yaml` when PyYAML is installed) and
   `custom_nodes/` folder names; ComfyUI core is judged by its version (`comfyui_version.py`); VRAM from
   `nvidia-smi`. Python packages are checked in the Python running the command, so run it with ComfyUI's Python.

## Sizes

File sizes are shown only when known: the Whisper folder (about 290 MB, from MODELS.md), and with `--sizes`, the
size Hugging Face reports for files whose exact repo path is known (the LTX-2.5, Krea 2 and Qwen3.5 files). The
FLUX 3 Klein, SAM 3.1, H3 and SAM 3D Body entries link to the repo page instead, because MODELS.md does not name the
exact file path.

## Keeping it true

`tests/test_doctor.py` checks that every file the doctor tells people to download is named in MODELS.md or the
README, that every node class it looks for exists in a ComfyUI `/object_info` snapshot, that the required packs are
the ones the README's install steps clone, and that the HTTP probe never asks for the full `/object_info`.
`tests/test_packaging.py` checks that it covers every line of requirements.txt.
