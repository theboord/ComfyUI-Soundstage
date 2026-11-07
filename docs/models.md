# Models panel: downloading model files in the App

The Models panel downloads the model files the App needs from Hugging Face, so you don't need a terminal. It downloads the same files as `tools/install_runpod.sh`, plus the FLUX 3 Klein set, the temporal upscaler, SAM 3.1 and the MiniMax H3 first/last-frame model. [MODELS.md](../MODELS.md) says what each file is for.

## Opening it

- From the project menu (the project pill at the top), choose **Models…**.
- When a workflow loads with a model file missing, the notice in the corner shows a **Get these models…** button. The panel opens with those files already ticked.

## What it shows

- **Hugging Face status.** You are either signed in or shown a token field. Use a token with *read* access: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). If ComfyUI was started with `HF_TOKEN`, or you ran `huggingface-cli login`, that token is used and the panel tells you so.
- **One card per feature** (First frame, Look still, Motion, Layers, …). Each file row shows its size, a licence chip and a state:
  - **Installed**
  - **Using your build: …** You already have another build of that model (fp8 rather than int8, or the LoRA in another folder). The workflow loader uses that build, so you don't need to download it.
  - **Partly downloaded nn%.** The next download picks up where this one stopped.
  - **Missing**
  - A 🔒 marks a gated repo.
- **The footer** shows the total for your selection and how much disk space is free.

## Downloading

1. Tick the files you want and click **Download**.
2. A single confirmation lists every licence your selection uses, with its revenue limit and a link. Tick each one once you've read it. MiniMax H3's licence excludes the USA, the EU, the UK and South Korea, and the panel shows that in red.
3. The panel checks access on Hugging Face. Gated repos may give one of two answers:
   - *Sign in*: paste a token.
   - *Accept the licence*: open the repo page (linked) and accept the licence, then click **Check again**.
4. Files download one at a time. The panel shows the speed and time left, and has a **Cancel** button. A cancelled or dropped download keeps its `.part` file, and the next attempt resumes it.
5. When it finishes, **reload the workflow** so the loaders can see the new files. The panel never reloads on its own, so unsaved work is safe.

## Safety

- **Only listed files.** The browser can only ask for files listed in `web/models/catalog.json`, and it does so by id. Paths and URLs come from the catalog, never from the page. Every file stays inside its ComfyUI models folder: `..` and symlinks that point outside the folder are refused.
- **Your token stays on your computer.** It is saved at `user/soundstage/hf_token` with permissions 600. It is never sent back to the browser, never logged, and only ever sent to huggingface.co. When a download is redirected to the CDN, the token is not sent there. **Remove token** deletes the file.
- **Verified before use.** Each file downloads to `<name>.part` and is checked before it is renamed into place. The size and sha256 are checked against Hugging Face's own values (`X-Linked-Size` / `X-Linked-Etag`), or against the catalog once it has pinned values. A file that doesn't match is deleted.
- **Disk check.** A download only starts if there is room for the file plus 2 GB.

## HTTP routes

All routes are under `/soundstage/models/` and return JSON:

| Route | What it does |
|---|---|
| `GET status` | Catalog, per-file state, sign-in status |
| `POST access` | Access check per repo (`{ids}`) |
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
- **Catalog values.** The catalog has no sha256 values or pinned revisions yet, and its sizes are the GB figures from MODELS.md. The two Krea 2 text-encoder and VAE sizes are unknown.
- **MiniMax H3.** Only the first/last-frame model is listed. Its other files (ref2va, the text encoder and the two VAEs) still need checking against the repo before they can be added.
- **One token per machine.** The token is stored once per machine, not once per ComfyUI user.
