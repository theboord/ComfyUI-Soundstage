# Models panel: downloading model files in the App

The Models panel downloads the model files the App needs from Hugging Face, so you don't need a terminal. It downloads the same files as `tools/install_runpod.sh`, plus some the install script has no line for yet:

- the FLUX 3 Klein set: `flux3-klein-int8`, `qwen3vl-4b-int8`, `flux2-vae`;
- the LTX 2.5 temporal upscaler: `ltx25-temporal-x2`;
- SAM 3.1: `sam31`;
- the MiniMax H3 first/last-frame model: `minimax-h3-fl2va-int8`. [MODELS.md](../MODELS.md) says what each file is for.

## Opening it

- From the project menu (the project pill at the top), choose **Models…**.
- When a workflow loads with a model file missing, the notice in the corner shows a **Get these models…** button. The panel opens with those files already ticked.

## What it shows

- **Hugging Face status.** You are either signed in or shown a token field. Use a token with *read* access: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). If ComfyUI was started with `HF_TOKEN`, or you ran `huggingface-cli login`, that token is used and the panel tells you which one. **Use a different token…** lets you paste another: a token saved in the panel always wins over `HF_TOKEN` and the huggingface-cli login, and **Remove token** goes back to them. If Hugging Face refuses the token, the row says "Your Hugging Face token was refused: replace it above" and the token box opens.
- **One card per feature** (First frame, Look still, Motion, Layers, …). Each file row shows its size, a licence chip and a state:
  - **Installed.** A file with the exact name in any folder ComfyUI lists for that type counts, including folders added by `extra_model_paths.yaml`. Downloads go to the first folder.
  - **Using your build: …** You already have another build of that model (fp8 rather than int8, or the LoRA in another folder). The workflow loader uses that build, so you don't need to download it.
  - **Partly downloaded nn%.** The next download picks up where this one stopped.
  - **Missing**
  - A 🔒 marks a gated repo.
- **The footer** shows the total for your selection and how much disk space is free.

## Downloading

1. Tick the files you want and click **Download**.
2. A single confirmation lists every licence your selection uses, with its revenue limit and a link. Tick each one once you've read it. MiniMax H3's licence excludes the USA, the EU, the UK and South Korea, and the panel shows that in red.
3. The panel checks access on Hugging Face, one file at a time (two files of one repo can differ). "Ready", "Sign in" and "Accept the licence" answers are kept for a minute; errors are always checked again. Gated repos may give one of two answers:
   - *Sign in*: paste a token.
   - *Accept the licence*: open the repo page (linked) and accept the licence, then click **Check again**.
4. Files download one at a time. The panel shows the speed and time left, and has a **Cancel** button that stops the current file only (the rest of the queue carries on). A cancelled or dropped download keeps its `.part` file, and the next attempt resumes it. A file that fails (not enough disk, sign-in needed) shows its reason on its row, also when the panel is reopened.
5. When it finishes, **reload the workflow** so the loaders can see the new files. The panel never reloads on its own, so unsaved work is safe.

## Safety

- **Only listed files.** The browser can only ask for files listed in `web/models/catalog.json`, and it does so by id. Paths and URLs come from the catalog, never from the page. Every file stays inside its ComfyUI models folder: `..` and symlinks that point outside the folder are refused.
- **Your token stays on your computer.** It is saved at `user/soundstage/hf/token`: the `hf` folder has permissions 700 and the file 600 (written to a fresh temp file opened exclusively at 600, then renamed). The shared `user/soundstage` folder keeps its own permissions. It is never sent back to the browser, never logged, and only ever sent to huggingface.co. When a download is redirected to the CDN, the token is not sent there. **Remove token** deletes the file.
- **Verified before use.** Each file downloads to `<name>.part` and is checked before it is renamed into place. The sha256 is checked when the catalog or Hugging Face (`X-Linked-Etag`) gives one (`verified: "sha256"`). Without one, the size is checked against `X-Linked-Size`, or the catalog's figure within 1 % or 5 MB, whichever is larger, so the 0.01 GB rounding never fails a good file (`verified: "size"`); if no size is known the file is reported `verified: "unverified_size"`. The download's own `Content-Length` is never trusted as a check, only used to spot a cut-off transfer. Without a sha256 the file must also start like a safetensors file: 8 bytes of little-endian header length, then a JSON object. A file that doesn't match is deleted. A web page (`text/html` or any `text/*`, such as a Wi-Fi sign-in page) is refused before anything is written, and an existing `.part` is left alone. A file at the right name (or a symlink to one, for models kept on a shared volume) counts as Installed. It is shown as **Wrong size: download again** only when an exact size is known and differs: a catalog size whose sha256 is filled, or the size recorded when the App verified its own download. The catalog's rounded GB figure never marks a file wrong; if the file differs from it the chip just says **Installed (size differs from the estimate)**. A resume sends `If-Range` with the ETag (or Last-Modified) noted when the `.part` was started (kept in `<name>.part.meta`). It appends only when the server answers 206 from where the `.part` ends with the same validator. A 200 means the file changed upstream, so it starts over cleanly. A `.part` with neither a note nor a sha256 also starts over. A `.part` that is already complete is checked and finished instead of downloaded again. **Cancel** during the "checking the part" step stops before any download; Cancel with discard also deletes the `.part` of a queued file.
- **Disk check.** A download only starts if there is room for the file plus 2 GB.

## HTTP routes

All routes are under `/soundstage/models/` and return JSON:

| Route | What it does |
|---|---|
| `GET status` | Catalog, per-file state, sign-in status (`token_source`, `token_fallback`: names only) |
| `POST access` | Access check per file (`{ids}`) |
| `POST download` | Queue files (`{ids, confirm: true, accepted_licences}`) |
| `GET progress` | Download progress |
| `POST cancel` | Cancel (`{id? , all?, discard?}`) |
| `POST token` | Save a token |
| `POST token/remove` | Remove the saved token |
| `GET tiers` | Model sets by GPU size, for a future "Get the models for this computer" button |

## Not verified yet

- **Hugging Face responses.** Several details come from the spec and are only exercised against a fake server in the tests:
  - the `X-Linked-Etag` and `X-Linked-Size` headers on a resolve HEAD;
  - whether a gated repo answers 401 or 403;
  - the `X-Error-Code` values.

  Check them once against Hugging Face with a real token.
- **Catalog values.** The catalog has no sha256 values or pinned revisions yet, and its sizes are the GB figures from MODELS.md (no Hugging Face API sizes have been filled in). The two Krea 2 text-encoder and VAE sizes are unknown. Without Hugging Face's `X-Linked-Size`, the check against these figures allows 1 % or 5 MB, whichever is larger, so the 0.01 GB rounding alone can't fail a small file such as `flux2-vae` (0.34 GB) or `ltx25-temporal-x2` (0.26 GB).
- **Install script.** `tools/install_runpod.sh` has no line yet for the six files listed at the top. That is a follow-up for the installer lane.
- **MiniMax H3.** Only the first/last-frame model is listed. Its other files (ref2va, the text encoder and the two VAEs) still need checking against the repo before they can be added.
- **One token per machine.** The token is stored once per machine, not once per ComfyUI user.
